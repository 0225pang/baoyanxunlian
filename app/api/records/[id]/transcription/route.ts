import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import {
  createAudioToken,
  extractTranscript,
  extractTranscriptSegments,
  findString,
  getAsrConfig,
} from '@/lib/asr';
import type { RowDataPacket } from 'mysql2/promise';
import { assertApiAccess, logApiUsage } from '@/lib/usage';
import { createUserNotification } from '@/lib/notifications';

export const runtime = 'nodejs';

type RecordRow = RowDataPacket & {
  user_id: number;
  has_audio: number;
  transcript: string | null;
  transcript_status: string;
};

function publicBaseUrl(request: Request, configured: string) {
  if (configured) return configured;

  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || requestUrl.protocol.replace(':', '');
  const host = forwardedHost || requestUrl.host;
  return protocol + '://' + host;
}

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function transcribeInBackground(id: number, userId: number, audioUrl: string) {
  try {
    const config = await getAsrConfig();
    const submitResponse = await fetch(config.submitUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.key,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model: config.model,
        input: { file_urls: [audioUrl] },
        parameters: { channel_id: [0], timestamp_alignment_enabled: true },
      }),
    });
    const submitRaw = await submitResponse.text();
    const submitPayload = readJson(submitRaw);
    if (!submitResponse.ok) {
      throw new Error('百炼 ASR 提交失败 ' + submitResponse.status + ': ' + submitRaw.slice(0, 500));
    }
    await logApiUsage(userId, 'asr', { requestCount: 1, model: config.model });

    const taskId = findString(submitPayload, 'task_id');
    if (!taskId) throw new Error('百炼 ASR 未返回 task_id');

    const deadline = Date.now() + 10 * 60 * 1000;
    let taskPayload: unknown = submitPayload;
    let taskStatus = findString(taskPayload, 'task_status').toUpperCase();

    while (!['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(taskStatus)) {
      if (Date.now() >= deadline) throw new Error('百炼 ASR 任务等待超时');
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const taskResponse = await fetch(config.taskUrl + '/' + encodeURIComponent(taskId), {
        headers: { Authorization: 'Bearer ' + config.key },
      });
      const taskRaw = await taskResponse.text();
      taskPayload = readJson(taskRaw);
      if (!taskResponse.ok) {
        throw new Error('百炼 ASR 查询失败 ' + taskResponse.status + ': ' + taskRaw.slice(0, 500));
      }
      taskStatus = findString(taskPayload, 'task_status').toUpperCase();
    }

    if (!['SUCCEEDED', 'SUCCESS', 'COMPLETED'].includes(taskStatus)) {
      const detail = findString(taskPayload, 'message') || findString(taskPayload, 'code') || taskStatus;
      throw new Error('百炼 ASR 任务失败: ' + detail);
    }

    const transcriptionUrl = findString(taskPayload, 'transcription_url');
    if (!transcriptionUrl) throw new Error('百炼 ASR 未返回 transcription_url');

    const resultResponse = await fetch(transcriptionUrl);
    const resultRaw = await resultResponse.text();
    if (!resultResponse.ok) {
      throw new Error('百炼 ASR 结果下载失败 ' + resultResponse.status + ': ' + resultRaw.slice(0, 500));
    }
    const resultPayload = readJson(resultRaw);
    const transcript = extractTranscript(resultPayload);
    const transcriptSegments = extractTranscriptSegments(resultPayload);
    if (!transcript) throw new Error('百炼 ASR 结果中没有文字');

    await execute(
      'UPDATE practice_records SET transcript = ?, transcript_segments = ?, transcript_status = \'completed\', transcript_error = NULL, transcribed_at = CURRENT_TIMESTAMP WHERE id = ?',
      [transcript, transcriptSegments.length ? JSON.stringify(transcriptSegments) : null, id],
    );
    await createUserNotification(userId, '文字稿转录完成', `第 ${id} 条作答的文字稿已生成，可前往作答记录查看与复盘。`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute(
      'UPDATE practice_records SET transcript_status = \'failed\', transcript_error = ? WHERE id = ?',
      [message.slice(0, 1000), id],
    ).catch(() => undefined);
    await createUserNotification(userId, '文字稿转录失败', `第 ${id} 条作答转录失败：${message.slice(0, 300)}`, 'error');
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '记录编号无效' }, { status: 400 });

    const rows = await query<RecordRow[]>(
      'SELECT user_id, audio_data IS NOT NULL AS has_audio, transcript, transcript_status FROM practice_records WHERE id = ? LIMIT 1',
      [id],
    );
    const row = rows[0];
    if (!row || (row.user_id !== user.id && user.role !== 'admin')) {
      return Response.json({ error: '记录不存在或无权访问' }, { status: 404 });
    }
    if (!row.has_audio) return Response.json({ error: '这条记录没有录音' }, { status: 400 });

    const config = await getAsrConfig();
    if (!config.key) return Response.json({ error: '尚未配置百炼 DASHSCOPE_API_KEY' }, { status: 503 });
    if (!config.tokenSecret) return Response.json({ error: '尚未配置 ASR_AUDIO_TOKEN_SECRET' }, { status: 503 });
    if (row.transcript_status === 'processing') {
      return Response.json({ status: 'processing', message: '转写正在生成，请稍候' });
    }
    if (row.transcript_status === 'completed' && row.transcript) {
      return Response.json({ status: 'completed', transcript: row.transcript });
    }

    await assertApiAccess(Number(row.user_id), 'asr');

    const baseUrl = publicBaseUrl(request, config.publicBaseUrl);
    if (/^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|app(?::|\/))/i.test(baseUrl)) {
      return Response.json({ error: '百炼无法访问本机地址，请配置公网 ASR_PUBLIC_BASE_URL' }, { status: 503 });
    }

    const token = createAudioToken(id, config.tokenSecret);
    const audioUrl = baseUrl + '/api/records/' + id + '/audio/public?token=' + encodeURIComponent(token);

    await execute(
      'UPDATE practice_records SET transcript_status = \'processing\', transcript_error = NULL, transcript_started_at = CURRENT_TIMESTAMP WHERE id = ?',
      [id],
    );
    void transcribeInBackground(id, Number(row.user_id), audioUrl);
    return Response.json({ status: 'processing', message: '已提交百炼转写任务，请稍候查看' }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
