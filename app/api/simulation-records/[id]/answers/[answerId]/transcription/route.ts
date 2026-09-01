import { apiError, requireUser } from '@/lib/auth';
import { createAudioToken, extractTranscript, extractTranscriptSegments, findString, getAsrConfig } from '@/lib/asr';
import { execute, query } from '@/lib/db';
import { createUserNotification } from '@/lib/notifications';
import { assertApiAccess, logApiUsage } from '@/lib/usage';
import type { RowDataPacket } from 'mysql2/promise';

export const runtime = 'nodejs';

function publicBaseUrl(request: Request, configured: string) {
  if (configured) return configured;
  const url = new URL(request.url);
  return (request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1)) + '://' + (request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || url.host);
}
function json(raw: string): unknown { try { return JSON.parse(raw); } catch { return raw; } }

async function repairInBackground(sessionId: number, answerId: number, userId: number, audioUrl: string) {
  try {
    const config = await getAsrConfig();
    const submitted = await fetch(config.submitUrl, { method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' }, body: JSON.stringify({ model: config.model, input: { file_urls: [audioUrl] }, parameters: { channel_id: [0], timestamp_alignment_enabled: true } }) });
    const submitRaw = await submitted.text(); const submitPayload = json(submitRaw);
    if (!submitted.ok) throw new Error(`百炼 ASR 提交失败 ${submitted.status}: ${submitRaw.slice(0, 500)}`);
    await logApiUsage(userId, 'asr', { requestCount: 1, model: config.model });
    const taskId = findString(submitPayload, 'task_id'); if (!taskId) throw new Error('百炼 ASR 未返回 task_id');
    const deadline = Date.now() + 10 * 60_000; let payload: unknown = submitPayload; let status = findString(payload, 'task_status').toUpperCase();
    while (!['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(status)) {
      if (Date.now() >= deadline) throw new Error('百炼 ASR 任务等待超时');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const task = await fetch(`${config.taskUrl}/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${config.key}` } });
      const raw = await task.text(); payload = json(raw);
      if (!task.ok) throw new Error(`百炼 ASR 查询失败 ${task.status}: ${raw.slice(0, 500)}`);
      status = findString(payload, 'task_status').toUpperCase();
    }
    if (!['SUCCEEDED', 'SUCCESS', 'COMPLETED'].includes(status)) throw new Error(`百炼 ASR 任务失败: ${findString(payload, 'message') || findString(payload, 'code') || status}`);
    const resultUrl = findString(payload, 'transcription_url'); if (!resultUrl) throw new Error('百炼 ASR 未返回 transcription_url');
    const result = await fetch(resultUrl); const raw = await result.text(); if (!result.ok) throw new Error(`百炼 ASR 结果下载失败 ${result.status}: ${raw.slice(0, 500)}`);
    const transcript = extractTranscript(json(raw)); const parts = extractTranscriptSegments(json(raw)); if (!transcript) throw new Error('百炼 ASR 结果中没有文字');
    await execute("UPDATE simulation_answers SET transcript = ?, transcript_segments = ?, transcript_repair_status = 'completed', transcript_repair_error = NULL, transcript_repaired_at = CURRENT_TIMESTAMP WHERE id = ? AND session_id = ?", [transcript, parts.length ? JSON.stringify(parts) : null, answerId, sessionId]);
    await createUserNotification(userId, '模拟录音转写完成', '已使用完整录音补全一题转写，可确认内容后再生成复盘。', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute("UPDATE simulation_answers SET transcript_repair_status = 'failed', transcript_repair_error = ? WHERE id = ? AND session_id = ?", [message.slice(0, 1000), answerId, sessionId]).catch(() => undefined);
    await createUserNotification(userId, '模拟录音转写失败', `录音补全转写失败：${message.slice(0, 300)}`, 'error');
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string; answerId: string }> }) {
  try {
    const user = await requireUser(); const { id: rawSessionId, answerId: rawAnswerId } = await context.params;
    const sessionId = Number(rawSessionId); const answerId = Number(rawAnswerId);
    if (!Number.isInteger(sessionId) || !Number.isInteger(answerId) || sessionId < 1 || answerId < 1) return Response.json({ error: '记录编号无效' }, { status: 400 });
    const rows = await query<RowDataPacket[]>(`SELECT s.user_id AS userId, a.audio_data IS NOT NULL AS hasAudio, a.transcript_repair_count AS repairCount, a.transcript_repair_status AS repairStatus
      FROM simulation_answers a JOIN simulation_sessions s ON s.id = a.session_id WHERE a.id = ? AND a.session_id = ? LIMIT 1`, [answerId, sessionId]);
    const row = rows[0];
    if (!row || (user.role !== 'admin' && Number(row.userId) !== user.id)) return Response.json({ error: '记录不存在或无权访问' }, { status: 404 });
    if (!row.hasAudio) return Response.json({ error: '本题没有录音，无法补全转写' }, { status: 400 });
    if (String(row.repairStatus) === 'processing') return Response.json({ status: 'processing', message: '完整录音转写正在生成，请稍候' });
    if (Number(row.repairCount) >= 1) return Response.json({ error: '本题完整录音转写仅允许触发一次，请使用当前结果或联系管理员。' }, { status: 409 });
    const config = await getAsrConfig();
    if (!config.key || !config.tokenSecret) return Response.json({ error: '管理员尚未完成离线 ASR 配置' }, { status: 503 });
    await assertApiAccess(Number(row.userId), 'asr');
    const base = publicBaseUrl(request, config.publicBaseUrl);
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|app(?::|\/))/i.test(base)) return Response.json({ error: '百炼无法访问本机地址，请配置公网 ASR_PUBLIC_BASE_URL' }, { status: 503 });
    const claimed = await execute("UPDATE simulation_answers SET transcript_repair_count = transcript_repair_count + 1, transcript_repair_status = 'processing', transcript_repair_error = NULL WHERE id = ? AND session_id = ? AND transcript_repair_count = 0", [answerId, sessionId]);
    if (!claimed.affectedRows) return Response.json({ error: '本题完整录音转写已被触发，请勿重复提交。' }, { status: 409 });
    const url = `${base}/api/simulation-records/${sessionId}/audio/${answerId}/public?token=${encodeURIComponent(createAudioToken(answerId, config.tokenSecret))}`;
    void repairInBackground(sessionId, answerId, Number(row.userId), url);
    return Response.json({ status: 'processing', message: '已提交完整录音转写；完成后会替换当前实时文字稿。' }, { status: 202 });
  } catch (error) { return apiError(error); }
}
