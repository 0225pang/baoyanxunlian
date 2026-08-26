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
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, temperature: 0.35, messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'system', content: '以下是本轮对话的训练背景，请据此回答，但不要复述整段背景：\n' + JSON.stringify(trainingContext) },
        ...history, { role: 'user', content: message },
      ] }),
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
