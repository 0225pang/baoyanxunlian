import { apiError, requireUser } from '@/lib/auth';
import { chatCompletionsUrl, extractChatContent, getActiveAiConfig, safeJsonParse } from '@/lib/ai';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

type ChatPayload = { sessionId?: number; message?: string };

function streamContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const first = (payload as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> }).choices?.[0];
  const delta = first?.delta?.content;
  if (typeof delta === 'string') return delta;
  const message = first?.message?.content;
  return typeof message === 'string' ? message : '';
}

export async function POST(request: Request) {
  try {
    const current = await requireUser();
    const body = await request.json() as ChatPayload;
    const sessionId = Number(body.sessionId);
    const message = String(body.message || '').trim();
    if (!Number.isInteger(sessionId) || sessionId <= 0 || !message) {
      return Response.json({ error: '模拟场次和消息不能为空' }, { status: 400 });
    }

    const sessionRows = await query<RowDataPacket[]>(`SELECT id, user_id AS userId, template_id AS templateId, template_name AS templateName
      FROM simulation_sessions WHERE id = ? LIMIT 1`, [sessionId]);
    const session = sessionRows[0];
    if (!session || (current.role !== 'admin' && Number(session.userId) !== current.id)) {
      return Response.json({ error: '模拟记录不存在或无权访问' }, { status: 404 });
    }

    const config = await getActiveAiConfig();
    if (!config?.apiKey) return Response.json({ error: '请先在管理后台配置 AI 模型 API Key' }, { status: 503 });

    // Keep the context small and deterministic: the selected session plus the
    // immediately preceding session for the same student and school flow.
    const recentSessions = await query<RowDataPacket[]>(`SELECT id, template_name AS templateName,
        DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s') AS startedAt,
        status, elapsed_seconds AS elapsedSeconds
      FROM simulation_sessions
      WHERE user_id = ? AND ${session.templateId == null ? 'template_name = ?' : 'template_id = ?'}
      ORDER BY started_at DESC, id DESC LIMIT 2`, [Number(session.userId), session.templateId == null ? String(session.templateName) : Number(session.templateId)]);
    const sessionIds = recentSessions.map((item) => Number(item.id));
    const answers = sessionIds.length ? await query<RowDataPacket[]>(`SELECT session_id AS sessionId, module_index AS moduleIndex,
        module_title AS moduleTitle, question, answer, transcript, transcript_segments AS transcriptSegments,
        followup_question AS followupQuestion, elapsed_seconds AS elapsedSeconds
      FROM simulation_answers WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
      ORDER BY session_id DESC, module_index ASC, id ASC`, sessionIds) : [];
    const answerBySession = new Map<number, RowDataPacket[]>();
    for (const answer of answers) {
      const id = Number(answer.sessionId);
      const list = answerBySession.get(id) || [];
      list.push(answer);
      answerBySession.set(id, list);
    }
    const context = recentSessions.map((item) => ({
      sessionId: Number(item.id),
      startedAt: String(item.startedAt || ''),
      status: String(item.status || ''),
      elapsedSeconds: Number(item.elapsedSeconds || 0),
      answers: (answerBySession.get(Number(item.id)) || []).map((answer) => ({
        moduleIndex: Number(answer.moduleIndex),
        moduleTitle: String(answer.moduleTitle || ''),
        question: String(answer.question || ''),
        answer: String(answer.answer || ''),
        transcript: answer.transcript ? String(answer.transcript) : null,
        transcriptSegments: answer.transcriptSegments ? (typeof answer.transcriptSegments === 'string' ? safeJsonParse(String(answer.transcriptSegments)) : answer.transcriptSegments) : null,
        followupQuestion: answer.followupQuestion ? String(answer.followupQuestion) : null,
        elapsedSeconds: Number(answer.elapsedSeconds || 0),
      })),
    }));
    const prompt = `你正在帮助学员复盘食品专业保研面试的真实场景模拟。请结合问题、模块、回答和文字稿，直接回答学员当前的问题；需要时指出具体改进方法，并引用回答中的事实。不要臆造没有提供的内容。以下是最近两次同一学校流程的模拟记录（最新在前）：\n\n${JSON.stringify(context, null, 2)}\n\n学员当前消息：${message}`;
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: config.model, temperature: 0.35, stream: true, messages: [
        { role: 'system', content: config.systemPrompt || '你是一名专业、友善的保研面试教练。' },
        { role: 'user', content: prompt },
      ] }),
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
          let buffer = ''; let source = ''; let raw = ''; let reply = '';
          const consumeLine = (line: string) => {
            if (!line.startsWith('data:')) return;
            const value = line.slice(5).trim();
            if (!value || value === '[DONE]') return;
            raw += value;
            const content = streamContent(safeJsonParse(value));
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
          // A few compatible gateways ignore stream=true and return one JSON body.
          if (!reply) {
            const fallback = extractChatContent(safeJsonParse(raw || source));
            if (fallback) { reply = fallback; send({ type: 'delta', content: fallback }); }
          }
          if (!reply) throw new Error('AI 返回内容为空');
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
