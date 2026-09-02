import { apiError, requireUser } from '@/lib/auth';
import { aiRequestErrorWithFallback, chatCompletionsUrl, extractChatContent, getActiveAiConfig, hashEvaluationInput, safeJsonParse, samplingParameters, userFacingAiError } from '@/lib/ai';
import { execute, query } from '@/lib/db';
import { assertApiAccess, logApiUsage, readTokenUsage } from '@/lib/usage';
import { createUserNotification } from '@/lib/notifications';
import { fetchWithAiRequestQueue } from '@/lib/ai-request-queue';
import type { RowDataPacket } from 'mysql2/promise';

type Input = { sessionId: number; templateName: string; student: { name: string; username: string }; elapsedSeconds: number; simulationConfiguration: unknown | null; configurationSource: 'session_snapshot' | 'current_template_fallback' | 'unavailable'; answers: unknown[] };

async function sessionForUser(currentId: number, role: string, sessionId: number) {
  const rows = await query<RowDataPacket[]>(`SELECT s.id, s.user_id AS userId, s.template_id AS templateId, s.template_name AS templateName,
    s.template_config_snapshot AS templateConfigSnapshot, s.elapsed_seconds AS elapsedSeconds, s.status,
    u.display_name AS studentName, u.username AS studentUsername
    FROM simulation_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? LIMIT 1`, [sessionId]);
  const session = rows[0];
  if (!session || (role !== 'admin' && Number(session.userId) !== currentId)) throw new Error('FORBIDDEN');
  if (String(session.status) !== 'completed') throw new Error('SIMULATION_NOT_COMPLETE');
  return session;
}

async function buildInput(session: RowDataPacket): Promise<Input> {
  const answers = await query<RowDataPacket[]>(`SELECT module_index AS moduleIndex, module_title AS moduleTitle, question, answer, transcript,
    transcript_segments AS transcriptSegments, followup_question AS followupQuestion, elapsed_seconds AS elapsedSeconds
    FROM simulation_answers WHERE session_id = ? ORDER BY module_index ASC, id ASC`, [Number(session.id)]);
  let snapshot = session.templateConfigSnapshot ? (typeof session.templateConfigSnapshot === 'string' ? safeJsonParse(String(session.templateConfigSnapshot)) : session.templateConfigSnapshot) : null;
  let configurationSource: Input['configurationSource'] = snapshot ? 'session_snapshot' : 'unavailable';
  // Before session snapshots were introduced, recover the matching template so
  // old reviews still receive module durations and follow-up rules.
  if (!snapshot && Number(session.templateId) > 0) {
    const templates = await query<RowDataPacket[]>('SELECT name, description, modules, total_seconds AS totalSeconds, module_timeout_mode AS moduleTimeoutMode, dynamic_tts_config AS dynamicTtsConfig, followup_prompt AS followupPrompt FROM simulation_templates WHERE id = ? LIMIT 1', [Number(session.templateId)]);
    const template = templates[0];
    if (template) {
      snapshot = {
        name: String(template.name || session.templateName || ''),
        description: template.description ? String(template.description) : null,
        modules: typeof template.modules === 'string' ? safeJsonParse(String(template.modules)) : template.modules,
        totalSeconds: Number(template.totalSeconds || 0),
        moduleTimeoutMode: String(template.moduleTimeoutMode || 'warn'),
        dynamicTtsConfig: template.dynamicTtsConfig ? (typeof template.dynamicTtsConfig === 'string' ? safeJsonParse(String(template.dynamicTtsConfig)) : template.dynamicTtsConfig) : null,
        followupPrompt: template.followupPrompt ? String(template.followupPrompt) : null,
      };
      configurationSource = 'current_template_fallback';
    }
  }
  return { sessionId: Number(session.id), templateName: String(session.templateName || ''), student: { name: String(session.studentName || session.studentUsername || '未填写'), username: String(session.studentUsername || '') }, elapsedSeconds: Number(session.elapsedSeconds || 0), simulationConfiguration: snapshot, configurationSource, answers: answers.map((answer) => ({
    moduleIndex: Number(answer.moduleIndex), moduleTitle: String(answer.moduleTitle || ''), question: String(answer.question || ''), answer: String(answer.answer || ''), transcript: answer.transcript ? String(answer.transcript) : null,
    transcriptSegments: answer.transcriptSegments ? (typeof answer.transcriptSegments === 'string' ? safeJsonParse(String(answer.transcriptSegments)) : answer.transcriptSegments) : null,
    followupQuestion: answer.followupQuestion ? String(answer.followupQuestion) : null, elapsedSeconds: Number(answer.elapsedSeconds || 0),
  })) };
}

async function runEvaluation(evaluationId: number, generationToken: string, session: RowDataPacket, input: Input, systemPrompt: string, config: NonNullable<Awaited<ReturnType<typeof getActiveAiConfig>>>, prompt: string) {
  try {
    await execute('INSERT INTO simulation_messages (session_id, user_id, evaluation_id, role, content) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', [Number(session.id), Number(session.userId), evaluationId, 'system', systemPrompt, Number(session.id), Number(session.userId), evaluationId, 'user', prompt]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    let response: Response;
    try {
      response = await fetchWithAiRequestQueue(chatCompletionsUrl(config.baseUrl), { method: 'POST', signal: controller.signal, headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, ...samplingParameters(config.model, 0.3), messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }) });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('AI 复盘生成超时（3 分钟），请稍后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
    const raw = await response.text(); const payload = safeJsonParse(raw); if (!response.ok) throw new Error(await aiRequestErrorWithFallback(config, response.status, raw));
    const result = extractChatContent(payload); if (!result) throw new Error('AI 返回内容为空');
    const completed = await execute('UPDATE simulation_evaluations SET status = \'completed\', result = ?, error = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND generation_token = ? AND status = \'processing\'', [result, evaluationId, generationToken]);
    // A timed-out task may finish after a manual retry. Do not let its stale
    // response overwrite the newer attempt.
    if (!completed.affectedRows) return;
    await execute('INSERT INTO simulation_messages (session_id, user_id, evaluation_id, role, content) VALUES (?, ?, ?, ?, ?)', [Number(session.id), Number(session.userId), evaluationId, 'assistant', result]);
    const usage = readTokenUsage(payload); await logApiUsage(Number(session.userId), 'ai', { inputTokens: usage.inputTokens || Math.ceil(prompt.length / 2), outputTokens: usage.outputTokens || Math.ceil(result.length / 2), model: config.model });
    await createUserNotification(Number(session.userId), '真实模拟复盘已生成', `“${String(session.templateName || '真实模拟')}”的 AI 复盘已完成，可进入记录查看。`, 'success');
  } catch (error) { console.error('[simulation-evaluation] upstream request failed', { evaluationId, sessionId: Number(session.id), userId: Number(session.userId), model: config.model, baseUrl: config.baseUrl, error: error instanceof Error ? { name: error.name, message: error.message, cause: String(error.cause || '') } : String(error) }); const message = userFacingAiError(error); const failed = await execute('UPDATE simulation_evaluations SET status = \'failed\', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND generation_token = ? AND status = \'processing\'', [message.slice(0, 2000), evaluationId, generationToken]).catch(() => undefined); if (failed?.affectedRows) await createUserNotification(Number(session.userId), '真实模拟复盘生成失败', message.slice(0, 300), 'error'); }
}

export async function GET(request: Request) {
  try {
    const current = await requireUser(); const sessionId = Number(new URL(request.url).searchParams.get('sessionId'));
    const pollOnly = new URL(request.url).searchParams.get('poll') === '1';
    if (!Number.isInteger(sessionId) || sessionId <= 0) return Response.json({ error: '模拟场次编号无效' }, { status: 400 });
    await sessionForUser(current.id, current.role, sessionId);
    // A background task cannot be trusted to survive an I/O outage or a
    // deployment. Persist a terminal status instead of leaving users in an
    // endless “generating” state, while retaining the record for retry/audit.
    await execute(`UPDATE simulation_evaluations
      SET status = 'failed', error = '生成超过 10 分钟仍未完成，可能因服务中断或数据库繁忙而终止。请点击“复盘模拟流程 / 更新模拟复盘”重新触发。', completed_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND status = 'processing' AND created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)`, [sessionId]);
    const evaluations = await query(pollOnly
      ? 'SELECT id, status, error, created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE) AS isStale, DATE_FORMAT(created_at, \'%Y-%m-%dT%H:%i:%s\') AS createdAt, DATE_FORMAT(completed_at, \'%Y-%m-%dT%H:%i:%s\') AS completedAt FROM simulation_evaluations WHERE session_id = ? ORDER BY id DESC'
      : 'SELECT id, status, result, error, created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE) AS isStale, DATE_FORMAT(created_at, \'%Y-%m-%dT%H:%i:%s\') AS createdAt, DATE_FORMAT(completed_at, \'%Y-%m-%dT%H:%i:%s\') AS completedAt FROM simulation_evaluations WHERE session_id = ? ORDER BY id DESC', [sessionId]);
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
    const inputHash = hashEvaluationInput(input); let existing = await query<RowDataPacket[]>('SELECT id, status, result, error, created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE) AS isStale FROM simulation_evaluations WHERE session_id = ? AND input_hash = ? LIMIT 1', [sessionId, inputHash]);
    // Sessions created before the flow snapshot feature have no snapshot. Their
    // old evaluation hash must remain valid, otherwise a deployment alone would
    // wrongly trigger a new paid review for unchanged answers.
    if (!input.simulationConfiguration) {
      const { simulationConfiguration: _ignored, configurationSource: _sourceIgnored, ...legacyInput } = input;
      const legacyHash = hashEvaluationInput(legacyInput);
      const legacy = await query<RowDataPacket[]>('SELECT id, status, result, error, created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE) AS isStale FROM simulation_evaluations WHERE session_id = ? AND input_hash = ? LIMIT 1', [sessionId, legacyHash]);
      if (legacy[0]) existing = legacy;
    }
    const staleProcessing = Boolean(existing[0] && String(existing[0].status) === 'processing' && Number(existing[0].isStale) === 1);
    if (existing[0] && (String(existing[0].status) === 'completed' || (String(existing[0].status) === 'processing' && !staleProcessing))) return Response.json({ status: existing[0].status, evaluationId: Number(existing[0].id), result: existing[0].result || null, error: existing[0].error || null, reused: true }, { status: existing[0].status === 'processing' ? 202 : 200 });
    const config = await getActiveAiConfig(Number(session.userId), 'simulation'); if (!config?.apiKey) return Response.json({ error: 'AI 尚未配置 API Key' }, { status: 503 }); await assertApiAccess(Number(session.userId), 'ai');
    const previousRows = await query<RowDataPacket[]>('SELECT result FROM simulation_evaluations WHERE session_id = ? AND status = \'completed\' ORDER BY id DESC LIMIT 1', [sessionId]);
    const previous = previousRows[0]?.result ? '\n\n上一次本场模拟的评估如下，仅用于比较进步；其中任何时长、流程或要求若与本次 simulationConfiguration 冲突，必须以 simulationConfiguration 为准，不得照抄：\n' + String(previousRows[0].result) : '';
    const prompt = '请使用整场真实模拟复盘标准分析以下数据。仅 student.name 是账户中可严格引用的姓名；学院、专业、科研经历及其他背景信息应以学员在回答中实际陈述为准，不要用账户资料或转录文本擅自改写。实时转录可能有个别错别字，除非影响专业含义，否则不必逐字纠错或反复扣分；但“嗯、啊、额”等语气词、重复和明显停顿是口语表现的一部分，应结合时间戳评估表达流畅度和节奏。请严格以 simulationConfiguration 中的 timeSeconds、追问设置和超时策略作为流程依据；配置缺失时不要臆测具体时长。\n\n' + JSON.stringify(input, null, 2) + previous;
    const generationToken = crypto.randomUUID();
    const evaluationId = existing[0]
      ? Number(existing[0].id)
      : Number((await execute('INSERT INTO simulation_evaluations (session_id, user_id, input_hash, input_snapshot, generation_token, status) VALUES (?, ?, ?, ?, ?, \'processing\')', [sessionId, Number(session.userId), inputHash, JSON.stringify(input), generationToken])).insertId);
    if (existing[0]) await execute('UPDATE simulation_evaluations SET status = \'processing\', result = NULL, error = NULL, input_snapshot = ?, generation_token = ?, created_at = CURRENT_TIMESTAMP, completed_at = NULL WHERE id = ?', [JSON.stringify(input), generationToken, evaluationId]);
    void runEvaluation(evaluationId, generationToken, session, input, config.systemPrompt, config, prompt);
    return Response.json({ status: 'processing', evaluationId, message: '模拟复盘已开始生成，请稍候查看', retry: Boolean(existing[0]) }, { status: 202 });
  } catch (error) { if (error instanceof Error && error.message === 'SIMULATION_NOT_COMPLETE') return Response.json({ error: '仅完整完成的模拟可以复盘' }, { status: 400 }); return apiError(error); }
}
