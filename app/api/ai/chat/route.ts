import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { chatCompletionsUrl, extractChatContent, getActiveAiConfig, safeJsonParse, samplingParameters } from '@/lib/ai';
import { assertApiAccess, logApiUsage, readTokenUsage } from '@/lib/usage';
import type { RowDataPacket } from 'mysql2/promise';

function streamContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const first = (payload as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> }).choices?.[0];
  const delta = first?.delta?.content;
  if (typeof delta === 'string') return delta;
  const message = first?.message?.content;
  return typeof message === 'string' ? message : '';
}

async function targetUserId(currentId: number, role: string, value: unknown) {
  const requested = Number(value == null ? currentId : value);
  if (!Number.isInteger(requested) || requested <= 0 || (role !== 'admin' && requested !== currentId)) throw new Error('FORBIDDEN');
  return requested;
}

export async function POST(request: Request) {
  try {
    const current = await requireUser();
    const body = await request.json() as { questionId?: number; userId?: number; message?: string };
    const questionId = Number(body.questionId);
    const userId = await targetUserId(current.id, current.role, body.userId);
    const message = String(body.message || '').trim();
    if (!Number.isInteger(questionId) || questionId <= 0 || !message) return Response.json({ error: '问题和消息不能为空' }, { status: 400 });
    const config = await getActiveAiConfig();
    if (!config?.apiKey) return Response.json({ error: 'AI 尚未配置 API Key，请联系管理员' }, { status: 503 });
    await assertApiAccess(userId, 'ai');
    const existing = await query<RowDataPacket[]>('SELECT id, role, content FROM ai_messages WHERE user_id = ? AND question_id = ? AND evaluation_id IS NULL ORDER BY id ASC', [userId, questionId]);
    const history = existing.slice(-30).map((item) => ({ role: String(item.role), content: String(item.content) }));
    const contextRows = await query<RowDataPacket[]>(`SELECT q.content, q.answer AS referenceAnswer, q.subcategory,
      t.name AS typeName, t.description AS typeDescription,
      r.answer AS recordAnswer, r.transcript, r.transcript_segments AS transcriptSegments,
      DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt
      FROM questions q
      LEFT JOIN question_types t ON t.id = q.type_id
      LEFT JOIN practice_records r ON r.question_id = q.id AND r.user_id = ?
      WHERE q.id = ? ORDER BY r.created_at DESC, r.id DESC`, [userId, questionId]);
    if (!contextRows.length) return Response.json({ error: '题目不存在' }, { status: 404 });
    const first = contextRows[0];
    const trainingContext = {
      questionType: String(first.typeName || '未分类'),
      typeDescription: first.typeDescription ? String(first.typeDescription) : null,
      subcategory: first.subcategory ? String(first.subcategory) : null,
      question: String(first.content),
      referenceAnswer: first.referenceAnswer ? String(first.referenceAnswer) : null,
      recentAttempts: contextRows.filter((row) => row.createdAt).slice(0, 3).map((row) => ({
        createdAt: String(row.createdAt), answer: String(row.recordAnswer || ''),
        transcript: row.transcript ? String(row.transcript) : null,
        transcriptSegments: row.transcriptSegments ? String(row.transcriptSegments) : null,
      })),
    };
    await execute('INSERT INTO ai_messages (user_id, question_id, role, content) VALUES (?, ?, ?, ?)', [userId, questionId, 'user', message]);
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: config.model, ...samplingParameters(config.model, 0.35), messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'system', content: '以下是本轮对话的训练背景，请据此回答，但不要复述整段背景：\n' + JSON.stringify(trainingContext) },
        ...history, { role: 'user', content: message },
      ], stream: true }),
    });
    if (!response.ok) {
      const raw = await response.text();
      return Response.json({ error: 'AI 请求失败 ' + response.status + ': ' + raw.slice(0, 500) }, { status: 502 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: Record<string, string>) => controller.enqueue(encoder.encode('data: ' + JSON.stringify(payload) + '\n\n'));
        try {
          if (!response.body) throw new Error('AI 未返回可读取的数据流');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = ''; let raw = ''; let source = ''; let reply = ''; let inputTokens = 0; let outputTokens = 0;
          const consumeLine = (line: string) => {
            if (!line.startsWith('data:')) return;
            const value = line.slice(5).trim();
            if (!value || value === '[DONE]') return;
            raw += value;
            const payload = safeJsonParse(value); const usage = readTokenUsage(payload); inputTokens = Math.max(inputTokens, usage.inputTokens); outputTokens = Math.max(outputTokens, usage.outputTokens);
            const content = streamContent(payload);
            if (content) { reply += content; send({ type: 'delta', content }); }
          };
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            source += text; buffer += text;
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
            lines.forEach(consumeLine);
          }
          if (buffer) consumeLine(buffer);
          // Some compatible platforms ignore stream=true and return one JSON body.
          if (!reply && (raw || source)) {
            const fallback = extractChatContent(safeJsonParse(raw || source));
            if (fallback) { reply = fallback; send({ type: 'delta', content: fallback }); }
          }
          if (!reply) throw new Error('AI 返回内容为空');
          await execute('INSERT INTO ai_messages (user_id, question_id, role, content) VALUES (?, ?, ?, ?)', [userId, questionId, 'assistant', reply]);
          await logApiUsage(userId, 'ai', { inputTokens: inputTokens || Math.ceil(JSON.stringify(trainingContext).length / 2), outputTokens: outputTokens || Math.ceil(reply.length / 2), model: config.model });
          send({ type: 'done', content: '' });
        } catch (error) {
          send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
  } catch (error) { return apiError(error); }
}
