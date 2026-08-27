import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { chatCompletionsUrl, extractChatContent, getActiveAiConfig, hashEvaluationInput, safeJsonParse, type ActiveAiConfig } from '@/lib/ai';
import { assertApiAccess, logApiUsage, readTokenUsage } from '@/lib/usage';
import type { RowDataPacket } from 'mysql2/promise';

type EvaluationInput = {
  question: { id: number; type: string; typeDescription: string | null; subcategory: string | null; content: string; referenceAnswer: string | null };
  attempts: Array<{ id: number; createdAt: string; answer: string; transcript: string | null; transcriptSegments: unknown }>;
};

async function targetUserId(currentId: number, role: string, value: string | null) {
  const requested = Number(value || currentId);
  if (!Number.isInteger(requested) || requested <= 0 || (role !== 'admin' && requested !== currentId)) throw new Error('FORBIDDEN');
  return requested;
}

function buildUserPrompt(input: EvaluationInput) {
  return `请评估以下食品专业保研面试练习数据。回答中的“时间分片”仅用于分析思考时长、停顿和表达节奏，不要把时间戳本身当成回答内容。请把最近三次回答放在一起比较。

${JSON.stringify(input, null, 2)}`;
}

async function runEvaluation(evaluationId: number, userId: number, questionId: number, input: EvaluationInput, config: ActiveAiConfig, prompt: string) {
  try {
    await execute('INSERT INTO ai_messages (user_id, question_id, evaluation_id, role, content) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', [
      userId, questionId, evaluationId, 'system', config.systemPrompt,
      userId, questionId, evaluationId, 'user', prompt,
    ]);
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, temperature: 0.3, messages: [{ role: 'system', content: config.systemPrompt }, { role: 'user', content: prompt }] }),
    });
    const raw = await response.text();
    const payload = safeJsonParse(raw);
    if (!response.ok) throw new Error('AI 请求失败 ' + response.status + ': ' + raw.slice(0, 500));
    const result = extractChatContent(payload);
    if (!result) throw new Error('AI 返回内容为空');
    await execute('UPDATE ai_evaluations SET status = \'completed\', result = ?, error = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ?', [result, evaluationId]);
    await execute('INSERT INTO ai_messages (user_id, question_id, evaluation_id, role, content) VALUES (?, ?, ?, ?, ?)', [userId, questionId, evaluationId, 'assistant', result]);
    const usage = readTokenUsage(payload);
    await logApiUsage(userId, 'ai', { inputTokens: usage.inputTokens || Math.ceil(prompt.length / 2), outputTokens: usage.outputTokens || Math.ceil(result.length / 2), model: config.model });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute('UPDATE ai_evaluations SET status = \'failed\', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', [message.slice(0, 2000), evaluationId]).catch(() => undefined);
  }
}

async function buildInput(userId: number, questionId: number) {
  const rows = await query<RowDataPacket[]>(`SELECT q.id, q.content, q.subcategory, q.answer AS referenceAnswer,
      t.name AS typeName, t.description AS typeDescription,
      r.id AS recordId, r.answer AS recordAnswer, r.transcript, r.transcript_segments AS transcriptSegments,
      DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt
      FROM questions q
      LEFT JOIN question_types t ON t.id = q.type_id
      LEFT JOIN practice_records r ON r.question_id = q.id AND r.user_id = ?
      WHERE q.id = ?
      ORDER BY r.created_at DESC, r.id DESC`, [userId, questionId]);
  const first = rows[0];
  if (!first) throw new Error('题目不存在');
  const attempts: EvaluationInput['attempts'] = rows.filter((row) => row.recordId != null).slice(0, 3).map((row) => ({
    id: Number(row.recordId),
    createdAt: String(row.createdAt || ''),
    answer: String(row.recordAnswer || ''),
    transcript: row.transcript ? String(row.transcript) : null,
    transcriptSegments: row.transcriptSegments ? (typeof row.transcriptSegments === 'string' ? safeJsonParse(row.transcriptSegments) : row.transcriptSegments) : null,
  }));
  if (!attempts.length) throw new Error('该题目还没有作答记录');
  return {
    question: {
      id: Number(first.id),
      type: String(first.typeName || '未分类'),
      typeDescription: first.typeDescription ? String(first.typeDescription) : null,
      subcategory: first.subcategory ? String(first.subcategory) : null,
      content: String(first.content),
      referenceAnswer: first.referenceAnswer ? String(first.referenceAnswer) : null,
    },
    attempts,
  } satisfies EvaluationInput;
}

export async function GET(request: Request) {
  try {
    const current = await requireUser();
    const params = new URL(request.url).searchParams;
    const questionId = Number(params.get('questionId'));
    const userId = await targetUserId(current.id, current.role, params.get('userId'));
    if (!Number.isInteger(questionId) || questionId <= 0) return Response.json({ error: '题目编号无效' }, { status: 400 });
    const evaluations = await query(`SELECT id, status, result, error, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt, DATE_FORMAT(completed_at, '%Y-%m-%dT%H:%i:%s') AS completedAt
      FROM ai_evaluations WHERE user_id = ? AND question_id = ? ORDER BY id DESC`, [userId, questionId]);
    const messages = await query(`SELECT id, role, content, evaluation_id AS evaluationId, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt
      FROM ai_messages WHERE user_id = ? AND question_id = ? AND evaluation_id IS NULL ORDER BY id ASC`, [userId, questionId]);
    return Response.json({ evaluations, messages, userId, questionId });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const current = await requireUser();
    const body = await request.json() as { questionId?: number; userId?: number };
    const questionId = Number(body.questionId);
    const userId = await targetUserId(current.id, current.role, body.userId == null ? null : String(body.userId));
    if (!Number.isInteger(questionId) || questionId <= 0) return Response.json({ error: '题目编号无效' }, { status: 400 });
    const input = await buildInput(userId, questionId);
    const inputHash = hashEvaluationInput({ questionId, userId, attempts: input.attempts.map((attempt) => ({ id: attempt.id, answer: attempt.answer, transcript: attempt.transcript, transcriptSegments: attempt.transcriptSegments })) });
    const existing = await query<RowDataPacket[]>('SELECT id, status, result, error FROM ai_evaluations WHERE user_id = ? AND question_id = ? AND input_hash = ? LIMIT 1', [userId, questionId, inputHash]);
    if (existing[0]) return Response.json({ status: existing[0].status, evaluationId: Number(existing[0].id), result: existing[0].result || null, error: existing[0].error || null, reused: true }, { status: existing[0].status === 'processing' ? 202 : 200 });
    const config = await getActiveAiConfig();
    if (!config?.apiKey) return Response.json({ error: 'AI 尚未配置 API Key，请先到管理后台填写' }, { status: 503 });
    await assertApiAccess(userId, 'ai');
    const previousRows = await query<RowDataPacket[]>('SELECT result FROM ai_evaluations WHERE user_id = ? AND question_id = ? AND status = \'completed\' ORDER BY id DESC LIMIT 1', [userId, questionId]);
    const previousResult = previousRows[0]?.result ? String(previousRows[0].result) : '';
    const prompt = buildUserPrompt(input) + (previousResult ? '\n\n上一轮 AI 评估结果（请结合新回答判断进步或退步）：\n' + previousResult : '');
    const result = await execute('INSERT INTO ai_evaluations (user_id, question_id, input_hash, input_snapshot, status) VALUES (?, ?, ?, ?, \'processing\')', [userId, questionId, inputHash, JSON.stringify(input)]);
    const evaluationId = Number(result.insertId);
    void runEvaluation(evaluationId, userId, questionId, input, config, prompt);
    return Response.json({ status: 'processing', evaluationId, message: '评估已开始，请稍候查看' }, { status: 202 });
  } catch (error) { return apiError(error); }
}
