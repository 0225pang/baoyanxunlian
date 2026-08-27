import { apiError, requireUser } from '@/lib/auth';
import { chatCompletionsUrl, extractChatContent, getActiveAiConfig, safeJsonParse } from '@/lib/ai';
import { execute, query } from '@/lib/db';
import { assertApiAccess, logApiUsage, readTokenUsage } from '@/lib/usage';
import type { RowDataPacket } from 'mysql2/promise';

type ChatPayload = { sessionId?: number; message?: string };

function streamContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const first = (payload as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> }).choices?.[0];
  return typeof first?.delta?.content === 'string' ? first.delta.content : typeof first?.message?.content === 'string' ? first.message.content : '';
}

async function simulationContext(userId: number, templateId: number | null, templateName: string) {
  const sessions = await query<RowDataPacket[]>(`SELECT id, template_name AS templateName, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s') AS startedAt, elapsed_seconds AS elapsedSeconds
    FROM simulation_sessions WHERE user_id = ? AND ${templateId == null ? 'template_name = ?' : 'template_id = ?'} AND status = 'completed'
    ORDER BY started_at DESC, id DESC LIMIT 2`, [userId, templateId == null ? templateName : templateId]);
  const ids = sessions.map((item) => Number(item.id));
  const answers = ids.length ? await query<RowDataPacket[]>(`SELECT session_id AS sessionId, module_index AS moduleIndex, module_title AS moduleTitle, question, answer, transcript,
    transcript_segments AS transcriptSegments, followup_question AS followupQuestion, elapsed_seconds AS elapsedSeconds
    FROM simulation_answers WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY session_id DESC, module_index ASC, id ASC`, ids) : [];
  return sessions.map((session) => ({ sessionId: Number(session.id), startedAt: String(session.startedAt || ''), elapsedSeconds: Number(session.elapsedSeconds || 0), answers: answers.filter((answer) => Number(answer.sessionId) === Number(session.id)).map((answer) => ({
    moduleIndex: Number(answer.moduleIndex), moduleTitle: String(answer.moduleTitle || ''), question: String(answer.question || ''), answer: String(answer.answer || ''), transcript: answer.transcript ? String(answer.transcript) : null,
    transcriptSegments: answer.transcriptSegments ? (typeof answer.transcriptSegments === 'string' ? safeJsonParse(String(answer.transcriptSegments)) : answer.transcriptSegments) : null,
    followupQuestion: answer.followupQuestion ? String(answer.followupQuestion) : null, elapsedSeconds: Number(answer.elapsedSeconds || 0),
  })) }));
}

export async function POST(request: Request) {
  try {
    const current = await requireUser(); const body = await request.json() as ChatPayload;
    const sessionId = Number(body.sessionId); const message = String(body.message || '').trim();
    if (!Number.isInteger(sessionId) || sessionId <= 0 || !message) return Response.json({ error: '模拟场次和消息不能为空' }, { status: 400 });
    const sessions = await query<RowDataPacket[]>('SELECT id, user_id AS userId, template_id AS templateId, template_name AS templateName, status FROM simulation_sessions WHERE id = ? LIMIT 1', [sessionId]);
    const session = sessions[0];
    if (!session || (current.role !== 'admin' && Number(session.userId) !== current.id)) return Response.json({ error: '模拟记录不存在或无权访问' }, { status: 404 });
    const config = await getActiveAiConfig(); if (!config?.apiKey) return Response.json({ error: '请先在管理后台配置 AI 模型 API Key' }, { status: 503 });
    await assertApiAccess(Number(session.userId), 'ai');
    const context = await simulationContext(Number(session.userId), session.templateId == null ? null : Number(session.templateId), String(session.templateName));
    const rows = await query<RowDataPacket[]>('SELECT role, content FROM simulation_messages WHERE session_id = ? AND evaluation_id IS NULL ORDER BY id ASC', [sessionId]);
    const history = rows.slice(-30).map((row) => ({ role: String(row.role), content: String(row.content) }));
    await execute('INSERT INTO simulation_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)', [sessionId, Number(session.userId), 'user', message]);
    const response = await fetch(chatCompletionsUrl(config.baseUrl), { method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ model: config.model, temperature: 0.4, stream: true, messages: [
      { role: 'system', content: '你是小鱼，一名友好、专业的食品专业保研面试讨论伙伴。请直接回答学员当前的问题，进行自然的追问、解释或表达打磨。不要每次都输出完整评估模板，除非学员明确要求。不要虚构训练记录中没有的事实。' },
      { role: 'system', content: '以下是本次及最近一次同学校流程的模拟题目、回答和转写，仅作为讨论上下文：\n' + JSON.stringify(context) }, ...history, { role: 'user', content: message },
    ] }) });
    if (!response.ok) { const raw = await response.text(); return Response.json({ error: 'AI 请求失败 ' + response.status + ': ' + raw.slice(0, 500) }, { status: 502 }); }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({ async start(controller) {
      const send = (payload: Record<string, string>) => controller.enqueue(encoder.encode('data: ' + JSON.stringify(payload) + '\n\n'));
      try { if (!response.body) throw new Error('AI 未返回可读取的数据流'); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let raw = ''; let source = ''; let reply = ''; let inputTokens = 0; let outputTokens = 0;
        const consume = (line: string) => { if (!line.startsWith('data:')) return; const value = line.slice(5).trim(); if (!value || value === '[DONE]') return; raw += value; const payload = safeJsonParse(value); const usage = readTokenUsage(payload); inputTokens = Math.max(inputTokens, usage.inputTokens); outputTokens = Math.max(outputTokens, usage.outputTokens); const content = streamContent(payload); if (content) { reply += content; send({ type: 'delta', content }); } };
        while (true) { const { value, done } = await reader.read(); if (done) break; const text = decoder.decode(value, { stream: true }); source += text; buffer += text; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; lines.forEach(consume); }
        if (buffer) consume(buffer); if (!reply) { const fallback = extractChatContent(safeJsonParse(raw || source)); if (fallback) { reply = fallback; send({ type: 'delta', content: fallback }); } }
        if (!reply) throw new Error('AI 返回内容为空'); await execute('INSERT INTO simulation_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)', [sessionId, Number(session.userId), 'assistant', reply]); await logApiUsage(Number(session.userId), 'ai', { inputTokens: inputTokens || Math.ceil(JSON.stringify(context).length / 2), outputTokens: outputTokens || Math.ceil(reply.length / 2), model: config.model }); send({ type: 'done', content: '' });
      } catch (error) { send({ type: 'error', error: error instanceof Error ? error.message : String(error) }); } finally { controller.close(); }
    } });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
  } catch (error) { return apiError(error); }
}