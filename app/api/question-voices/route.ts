import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { createClonedVoice, createPublicToken, friendlyFileName, getTtsSettings, removeQuestionVoiceFile, secretPreview, sourcePublicUrl, storeQuestionVoiceFile, synthesizeVoice } from '@/lib/question-voices';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export const runtime = 'nodejs';

async function requireAdmin() { const user = await requireUser(); if (user.role !== 'admin') throw new Error('FORBIDDEN'); }
function clean(value: unknown, length = 500) { return String(value || '').trim().slice(0, length); }
function validUrl(value: string) { return !value || /^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value); }

async function readState() {
  const settings = await getTtsSettings();
  const questions = await query<RowDataPacket[]>(`SELECT q.id, q.content, t.name AS typeName FROM questions q
    JOIN question_types t ON t.id = q.type_id WHERE q.status = 'active' ORDER BY t.sort_order ASC, q.id DESC LIMIT 2000`);
  const voices = await query<RowDataPacket[]>(`SELECT v.id, v.question_id AS questionId, v.name, v.kind, v.status, v.model,
    v.voice_id AS voiceId, v.source_filename AS sourceFilename, v.source_mime AS sourceMime,
    v.output_mime AS outputMime, v.parameters, v.error, v.public_token AS publicToken,
    DATE_FORMAT(v.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt, q.content AS question
    FROM question_voices v LEFT JOIN questions q ON q.id = v.question_id ORDER BY v.created_at DESC`);
  return {
    settings: { ...settings, apiKey: undefined, apiKeySet: Boolean(settings.apiKey), apiKeyPreview: secretPreview(settings.apiKey) },
    questions: questions.map((item) => ({ id: Number(item.id), content: String(item.content), typeName: String(item.typeName) })),
    voices: voices.map((item) => ({ ...item, id: Number(item.id), questionId: item.questionId === null ? null : Number(item.questionId), parameters: item.parameters ? JSON.parse(String(item.parameters)) : {}, hasSource: Boolean(item.sourceFilename), hasOutput: Boolean(item.outputMime) })),
  };
}

export async function GET() { try { await requireAdmin(); return Response.json(await readState()); } catch (error) { return apiError(error); } }

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { settings?: Record<string, unknown> };
    if (!body.settings) return Response.json(await readState());
    const current = await getTtsSettings(); const value = body.settings;
    const provider = clean(value.provider || current.provider, 50) || 'bailian';
    const cloneUrl = clean(value.cloneUrl, 500); const synthesisUrl = clean(value.synthesisUrl, 500); const websocketUrl = clean(value.websocketUrl, 500); const publicBaseUrl = clean(value.publicBaseUrl, 500).replace(/\/+$/, '');
    const cloneModel = clean(value.cloneModel || current.cloneModel, 150) || 'voice-enrollment';
    const cloneTargetModel = clean(value.cloneTargetModel || current.cloneTargetModel, 150) || 'qwen-audio-3.0-tts-flash';
    const defaultModel = clean(value.defaultModel || current.defaultModel, 150) || 'qwen-audio-3.0-tts-flash';
    const apiKey = clean(value.apiKey, 1000);
    if (![cloneUrl, synthesisUrl, websocketUrl, publicBaseUrl].every(validUrl)) return Response.json({ error: 'API 地址必须以 http(s):// 或 ws(s):// 开头。' }, { status: 400 });
    if (apiKey) await execute('UPDATE tts_settings SET provider=?, clone_url=?, synthesis_url=?, websocket_url=?, api_key=?, public_base_url=?, clone_model=?, clone_target_model=?, default_model=?, updated_at=CURRENT_TIMESTAMP WHERE id=1', [provider, cloneUrl || null, synthesisUrl || null, websocketUrl || null, apiKey, publicBaseUrl || null, cloneModel, cloneTargetModel, defaultModel]);
    else await execute('UPDATE tts_settings SET provider=?, clone_url=?, synthesis_url=?, websocket_url=?, public_base_url=?, clone_model=?, clone_target_model=?, default_model=?, updated_at=CURRENT_TIMESTAMP WHERE id=1', [provider, cloneUrl || null, synthesisUrl || null, websocketUrl || null, publicBaseUrl || null, cloneModel, cloneTargetModel, defaultModel]);
    return Response.json(await readState());
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      if (String(form.get('action')) !== 'clone') return Response.json({ error: '不支持的上传操作。' }, { status: 400 });
      const name = clean(form.get('name'), 160) || '复刻音色';
      const prefix = clean(form.get('prefix'), 80) || 'fishvoice'; const model = clean(form.get('targetModel'), 150);
      const file = form.get('audio');
      if (!(file instanceof File) || !file.size) return Response.json({ error: '请上传有效的声音样本。' }, { status: 400 });
      if (file.size > 25 * 1024 * 1024) return Response.json({ error: '声音样本不能超过 25MB。' }, { status: 400 });
      const settings = await getTtsSettings(); const token = createPublicToken();
      const result = await execute('INSERT INTO question_voices (question_id,name,kind,status,model,source_filename,source_mime,public_token) VALUES (?,?,?,?,?,?,?,?)', [null, name, 'custom', 'processing', model || settings.cloneTargetModel, friendlyFileName(file.name), file.type || 'audio/wav', token]) as ResultSetHeader;
      const id = Number(result.insertId); const sourcePath = await storeQuestionVoiceFile(id, file.name, Buffer.from(await file.arrayBuffer()), 'source');
      await execute('UPDATE question_voices SET source_path=? WHERE id=?', [sourcePath, id]);
      try {
        const publicUrl = sourcePublicUrl(settings, id, token);
        const cloned = await createClonedVoice(settings, `${prefix}${id}`, publicUrl, model || settings.cloneTargetModel);
        await execute('UPDATE question_voices SET status=?, voice_id=?, error=NULL WHERE id=?', ['ready', cloned.voiceId, id]);
        return Response.json({ id, voiceId: cloned.voiceId, publicUrl, state: await readState() }, { status: 201 });
      } catch (error) {
        await execute('UPDATE question_voices SET status=?, error=? WHERE id=?', ['failed', error instanceof Error ? error.message.slice(0, 3000) : '声音复刻失败', id]);
        throw error;
      }
    }
    const body = await request.json() as { action?: string; id?: number; questionId?: number; name?: string; model?: string; voiceId?: string; parameters?: Record<string, unknown> };
    if (body.action === 'retry-clone') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return Response.json({ error: '复刻音色记录无效。' }, { status: 400 });
      const rows = await query<RowDataPacket[]>('SELECT id, kind, source_path AS sourcePath, public_token AS publicToken, model FROM question_voices WHERE id=? LIMIT 1', [id]);
      const voice = rows[0];
      if (!voice || String(voice.kind) !== 'custom' || !voice.sourcePath) return Response.json({ error: '找不到可重试的声音样本。' }, { status: 404 });
      const settings = await getTtsSettings();
      await execute('UPDATE question_voices SET status=?, error=NULL WHERE id=?', ['processing', id]);
      try {
        const cloned = await createClonedVoice(settings, `fishvoice${id}`, sourcePublicUrl(settings, id, String(voice.publicToken)), String(voice.model || settings.cloneTargetModel));
        await execute('UPDATE question_voices SET status=?, voice_id=?, error=NULL WHERE id=?', ['ready', cloned.voiceId, id]);
        return Response.json({ id, voiceId: cloned.voiceId, state: await readState() });
      } catch (error) {
        await execute('UPDATE question_voices SET status=?, error=? WHERE id=?', ['failed', error instanceof Error ? error.message.slice(0, 3000) : '声音复刻失败', id]);
        throw error;
      }
    }
    if (body.action !== 'synthesize') return Response.json({ error: '不支持的语音操作。' }, { status: 400 });
    const questionId = Number(body.questionId); const voiceId = clean(body.voiceId, 255); const name = clean(body.name, 160) || '生成语音';
    if (!Number.isInteger(questionId) || questionId < 1 || !voiceId) return Response.json({ error: '请选择题目并填写要使用的 voice ID。' }, { status: 400 });
    const rows = await query<RowDataPacket[]>('SELECT content FROM questions WHERE id=? LIMIT 1', [questionId]); const question = rows[0];
    if (!question) return Response.json({ error: '所选题目不存在。' }, { status: 404 });
    const settings = await getTtsSettings(); const model = clean(body.model || settings.defaultModel, 150); const parameters = body.parameters && typeof body.parameters === 'object' ? body.parameters : {};
    const result = await execute('INSERT INTO question_voices (question_id,name,kind,status,model,voice_id,parameters,public_token) VALUES (?,?,?,?,?,?,?,?)', [questionId, name, 'generated', 'processing', model, voiceId, JSON.stringify(parameters), createPublicToken()]) as ResultSetHeader;
    const id = Number(result.insertId);
    try {
      const audio = await synthesizeVoice(settings, { text: String(question.content), model, voiceId, parameters });
      const outputPath = await storeQuestionVoiceFile(id, 'speech.mp3', audio.audio, 'output');
      await execute('UPDATE question_voices SET status=?, output_path=?, output_mime=?, error=NULL WHERE id=?', ['ready', outputPath, audio.mime, id]);
      return Response.json({ id, state: await readState() }, { status: 201 });
    } catch (error) {
      await execute('UPDATE question_voices SET status=?, error=? WHERE id=?', ['failed', error instanceof Error ? error.message.slice(0, 3000) : '语音生成失败', id]);
      throw error;
    }
  } catch (error) {
    console.error('Question voice operation failed:', error);
    // This is an administrator-only configuration tool. Surface the provider
    // response so invalid workspace URLs and public sample URLs are diagnosable.
    if (error instanceof Error && error.message !== 'UNAUTHORIZED' && error.message !== 'FORBIDDEN') {
      return Response.json({ error: error.message.slice(0, 3000) }, { status: 500 });
    }
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin(); const id = Number(new URL(request.url).searchParams.get('id')); if (!Number.isInteger(id) || id < 1) return Response.json({ error: '语音记录无效。' }, { status: 400 });
    const rows = await query<RowDataPacket[]>('SELECT source_path AS sourcePath, output_path AS outputPath FROM question_voices WHERE id=? LIMIT 1', [id]); const row = rows[0];
    if (!row) return Response.json({ error: '语音记录不存在。' }, { status: 404 });
    await removeQuestionVoiceFile(row.sourcePath ? String(row.sourcePath) : null); await removeQuestionVoiceFile(row.outputPath ? String(row.outputPath) : null);
    await execute('DELETE FROM question_voices WHERE id=?', [id]); return Response.json(await readState());
  } catch (error) { return apiError(error); }
}
