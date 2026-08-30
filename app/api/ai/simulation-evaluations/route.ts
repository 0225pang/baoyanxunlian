import { apiError, requireUser } from '@/lib/auth';
import { aiRequestError, chatCompletionsUrl, extractChatContent, getActiveAiConfig, hashEvaluationInput, safeJsonParse, samplingParameters, userFacingAiError } from '@/lib/ai';
import { execute, query } from '@/lib/db';
import { assertApiAccess, logApiUsage, readTokenUsage } from '@/lib/usage';
import { createUserNotification } from '@/lib/notifications';
import type { RowDataPacket } from 'mysql2/promise';

type Input = { sessionId: number; templateName: string; elapsedSeconds: number; simulationConfiguration: unknown | null; answers: unknown[] };

async function sessionForUser(currentId: number, role: string, sessionId: number) {
  const rows = await query<RowDataPacket[]>('SELECT id, user_id AS userId, template_name AS templateName, template_config_snapshot AS templateConfigSnapshot, elapsed_seconds AS elapsedSeconds, status FROM simulation_sessions WHERE id = ? LIMIT 1', [sessionId]);
  const session = rows[0];
  if (!session || (role !== 'admin' && Number(session.userId) !== currentId)) throw new Error('FORBIDDEN');
  if (String(session.status) !== 'completed') throw new Error('SIMULATION_NOT_COMPLETE');
  return session;
}

async function buildInput(session: RowDataPacket): Promise<Input> {
  const answers = await query<RowDataPacket[]>(`SELECT module_index AS moduleIndex, module_title AS moduleTitle, question, answer, transcript,
    transcript_segments AS transcriptSegments, followup_question AS followupQuestion, elapsed_seconds AS elapsedSeconds
    FROM simulation_answers WHERE session_id = ? ORDER BY module_index ASC, id ASC`, [Number(session.id)]);
  const snapshot = session.templateConfigSnapshot ? (typeof session.templateConfigSnapshot === 'string' ? safeJsonParse(String(session.templateConfigSnapshot)) : session.templateConfigSnapshot) : null;
  return { sessionId: Number(session.id), templateName: String(session.templateName || ''), elapsedSeconds: Number(session.elapsedSeconds || 0), simulationConfiguration: snapshot, answers: answers.map((answer) => ({
    moduleIndex: Number(answer.moduleIndex), moduleTitle: String(answer.moduleTitle || ''), question: String(answer.question || ''), answer: String(answer.answer || ''), transcript: answer.transcript ? String(answer.transcript) : null,
    transcriptSegments: answer.transcriptSegments ? (typeof answer.transcriptSegments === 'string' ? safeJsonParse(String(answer.transcriptSegments)) : answer.transcriptSegments) : null,
    followupQuestion: answer.followupQuestion ? String(answer.followupQuestion) : null, elapsedSeconds: Number(answer.elapsedSeconds || 0),
  })) };
}

async function runEvaluation(evaluationId: number, session: RowDataPacket, input: Input, systemPrompt: string, config: NonNullable<Awaited<ReturnType<typeof getActiveAiConfig>>>, prompt: string) {
  try {
    await execute('INSERT INTO simulation_messages (session_id, user_id, evaluation_id, role, content) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', [Number(session.id), Number(session.userId), evaluationId, 'system', systemPrompt, Number(session.id), Number(session.userId), evaluationId, 'user', prompt]);
    const response = await fetch(chatCompletionsUrl(config.baseUrl), { method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, ...samplingParameters(config.model, 0.3), messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }) });
    const raw = await response.text(); const payload = safeJsonParse(raw); if (!response.ok) throw new Error(aiRequestError(response.status, raw));
    const result = extractChatContent(payload); if (!result) throw new Error('AI 返回内容为空');
    await execute('UPDATE simulation_evaluations SET status = \'completed\', result = ?, error = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ?', [result, evaluationId]);
    await execute('INSERT INTO simulation_messages (session_id, user_id, evaluation_id, role, content) VALUES (?, ?, ?, ?, ?)', [Number(session.id), Number(session.userId), evaluationId, 'assistant', result]);
    const usage = readTokenUsage(payload); await logApiUsage(Number(session.userId), 'ai', { inputTokens: usage.inputTokens || Math.ceil(prompt.length / 2), outputTokens: usage.outputTokens || Math.ceil(result.length / 2), model: config.model });
    await createUserNotification(Number(session.userId), '真实模拟复盘已生成', `“${String(session.templateName || '真实模拟')}”的 AI 复盘已完成，可进入记录查看。`, 'success');
  } catch (error) { const message = userFacingAiError(error); await execute('UPDATE simulation_evaluations SET status = \'failed\', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', [message.slice(0, 2000), evaluationId]).catch(() => undefined); await createUserNotification(Number(session.userId), '真实模拟复盘生成失败', message.slice(0, 300), 'error'); }
}

export async function GET(request: Request) {
  try {
    const current = await requireUser(); const sessionId = Number(new URL(request.url).searchParams.get('sessionId'));
    const pollOnly = new URL(request.url).searchParams.get('poll') === '1';
    if (!Number.isInteger(sessionId) || sessionId <= 0) return Response.json({ error: '模拟场次编号无效' }, { status: 400 });
    await sessionForUser(current.id, current.role, sessionId);
    const evaluations = await query(pollOnly
      ? 'SELECT id, status, error, DATE_FORMAT(created_at, \'%Y-%m-%dT%H:%i:%s\') AS createdAt, DATE_FORMAT(completed_at, \'%Y-%m-%dT%H:%i:%s\') AS completedAt FROM simulation_evaluations WHERE session_id = ? ORDER BY id DESC'
      : 'SELECT id, status, result, error, DATE_FORMAT(created_at, \'%Y-%m-%dT%H:%i:%s\') AS createdAt, DATE_FORMAT(completed_at, \'%Y-%m-%dT%H:%i:%s\') AS completedAt FROM simulation_evaluations WHERE session_id = ? ORDER BY id DESC', [sessionId]);
    if (pollOnly) return Response.json({ evaluations, poll: true });
    const messages = await query('SELECT id, role, content, DATE_FORMAT(created_at, \'%Y-%m-%dT%H:%i:%s\') AS createdAt FROM simulation_messages WHERE session_id = ? AND evaluation_id IS NULL ORDER BY id ASC', [sessionId]);
    return Response.json({ evaluations, messages });
  } catch (error) { if (error instanceof Error && error.message === 'SIMULATION_NOT_COMPLETE') return Response.json({ error: '仅完整完成的模拟可以复盘' }, { status: 400 }); return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const current = await requireUser(); const body = await request.json() as { sessionId?: number }; const sessionId = Number(body.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) return Response.json({ error: '模拟场次编号无效' }, { status: 400 });
    const session = await sessionForUser(current.id, current.role, sessionId); const input = await buildInput(session); if (!input.answers.length) return Response.json({ error: '本场模拟没有可评估的回答' }, { status: 400 });
    const inputHash = hashEvaluationInput(input); let existing = await query<RowDataPacket[]>('SELECT id, status, result, error FROM simulation_evaluations WHERE session_id = ? AND input_hash = ? LIMIT 1', [sessionId, inputHash]);
    // Sessions created before the flow snapshot feature have no snapshot. Their
    // old evaluation hash must remain valid, otherwise a deployment alone would
    // wrongly trigger a new paid review for unchanged answers.
    if (!input.simulationConfiguration) {
      const { simulationConfiguration: _ignored, ...legacyInput } = input;
      const legacyHash = hashEvaluationInput(legacyInput);
      const legacy = await query<RowDataPacket[]>('SELECT id, status, result, error FROM simulation_evaluations WHERE session_id = ? AND input_hash = ? LIMIT 1', [sessionId, legacyHash]);
      if (legacy[0]) existing = legacy;
    }
    if (existing[0] && ['processing', 'completed'].includes(String(existing[0].status))) return Response.json({ status: existing[0].status, evaluationId: Number(existing[0].id), result: existing[0].result || null, error: existing[0].error || null, reused: true }, { status: existing[0].status === 'processing' ? 202 : 200 });
    const config = await getActiveAiConfig(); if (!config?.apiKey) return Response.json({ error: 'AI 尚未配置 API Key' }, { status: 503 }); await assertApiAccess(Number(session.userId), 'ai');
    const previousRows = await query<RowDataPacket[]>('SELECT result FROM simulation_evaluations WHERE session_id = ? AND status = \'completed\' ORDER BY id DESC LIMIT 1', [sessionId]);
    const previous = previousRows[0]?.result ? '\n\n上一次本场模拟的评估如下，请结合当前数据指出进步或仍需改进之处：\n' + String(previousRows[0].result) : '';
    const prompt = '请使用既定的食品专业保研面试评估标准，复盘以下完整真实模拟。请重点评价总体结构、专业准确性、表达节奏、每个模块表现、追问应对以及下一步训练建议。若提供了带时间戳的转写切片，请分析思考时长与停顿。请用清晰的 Markdown 输出。\n\n' + JSON.stringify(input, null, 2) + previous;
    const evaluationId = existing[0]
      ? Number(existing[0].id)
      : Number((await execute('INSERT INTO simulation_evaluations (session_id, user_id, input_hash, input_snapshot, status) VALUES (?, ?, ?, ?, \'processing\')', [sessionId, Number(session.userId), inputHash, JSON.stringify(input)])).insertId);
    if (existing[0]) await execute('UPDATE simulation_evaluations SET status = \'processing\', result = NULL, error = NULL, input_snapshot = ?, completed_at = NULL WHERE id = ?', [JSON.stringify(input), evaluationId]);
    void runEvaluation(evaluationId, session, input, config.systemPrompt, config, prompt);
    return Response.json({ status: 'processing', evaluationId, message: '模拟复盘已开始生成，请稍候查看', retry: Boolean(existing[0]) }, { status: 202 });
  } catch (error) { if (error instanceof Error && error.message === 'SIMULATION_NOT_COMPLETE') return Response.json({ error: '仅完整完成的模拟可以复盘' }, { status: 400 }); return apiError(error); }
}
