import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { chatCompletionsUrl, extractChatContent, getActiveAiConfig, safeJsonParse } from '@/lib/ai';
import type { RowDataPacket } from 'mysql2/promise';

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
    const existing = await query<RowDataPacket[]>('SELECT id, role, content FROM ai_messages WHERE user_id = ? AND question_id = ? AND role <> \'system\' ORDER BY id ASC', [userId, questionId]);
    if (!existing.length) return Response.json({ error: '请先生成一次评估，再开始对话' }, { status: 400 });
    const history = existing.slice(-30).map((item) => ({ role: String(item.role), content: String(item.content) }));
    await execute('INSERT INTO ai_messages (user_id, question_id, role, content) VALUES (?, ?, ?, ?)', [userId, questionId, 'user', message]);
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, temperature: 0.35, messages: [{ role: 'system', content: config.systemPrompt }, ...history, { role: 'user', content: message }] }),
    });
    const raw = await response.text();
    const payload = safeJsonParse(raw);
    if (!response.ok) return Response.json({ error: 'AI 请求失败 ' + response.status + ': ' + raw.slice(0, 500) }, { status: 502 });
    const reply = extractChatContent(payload);
    if (!reply) return Response.json({ error: 'AI 返回内容为空' }, { status: 502 });
    await execute('INSERT INTO ai_messages (user_id, question_id, role, content) VALUES (?, ?, ?, ?)', [userId, questionId, 'assistant', reply]);
    return Response.json({ message: { role: 'assistant', content: reply } });
  } catch (error) { return apiError(error); }
}
