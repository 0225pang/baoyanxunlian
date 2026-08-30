import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { aiRequestError, chatCompletionsUrl, extractChatContent, getActiveAiConfig, safeJsonParse, samplingParameters } from '@/lib/ai';
import { assertApiAccess, logApiUsage, readTokenUsage } from '@/lib/usage';
import { synthesizeConfiguredQuestionVoice } from '@/lib/question-voices';
import type { RowDataPacket } from 'mysql2/promise';

type DynamicModule = { id?: unknown; kind?: unknown; prompt?: unknown; title?: unknown };
type PriorAnswer = { moduleTitle?: unknown; question?: unknown; answer?: unknown; transcript?: unknown };

const DEFAULT_PROMPT = '你是一名食品专业保研面试老师。请根据学员此前完成的自我介绍、科研项目介绍及其他回答，设计一条适合自由交流环节的具体问题。优先追问研究经历、项目细节、方法选择、结果意义或与食品专业的关联；信息不足时，可了解研究兴趣与学术潜力。只输出一条自然的面试问题，不要解释。';

function answerContext(items: PriorAnswer[]) {
  const blocks = items.slice(-8).map((item, index) => {
    const answer = String(item.transcript || item.answer || '').trim().slice(0, 5000);
    return `【前序环节 ${index + 1}】${String(item.moduleTitle || '未命名环节')}\n问题：${String(item.question || '未提供')}\n学员回答：${answer || '未提供有效回答'}`;
  }).filter((item) => !item.endsWith('学员回答：未提供有效回答'));
  return blocks.join('\n\n');
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: rawId } = await context.params; const sessionId = Number(rawId);
    const body = await request.json() as { moduleId?: string; priorAnswers?: PriorAnswer[] };
    const sessions = await query<RowDataPacket[]>('SELECT user_id AS userId, template_id AS templateId FROM simulation_sessions WHERE id = ? LIMIT 1', [sessionId]);
    const session = sessions[0];
    if (!session || (Number(session.userId) !== user.id && user.role !== 'admin')) return Response.json({ error: '模拟场次不存在或无权操作' }, { status: 404 });

    const templates = await query<RowDataPacket[]>('SELECT modules, dynamic_tts_config AS dynamicTtsConfig FROM simulation_templates WHERE id = ? LIMIT 1', [Number(session.templateId)]);
    const rawModules = templates[0]?.modules;
    const modules = (typeof rawModules === 'string' ? JSON.parse(rawModules) : rawModules || []) as DynamicModule[];
    const module = modules.find((item) => String(item.id || '') === String(body.moduleId || '') && item.kind === 'dynamic');
    if (!module) return Response.json({ error: '动态提问模块不存在或配置已变更' }, { status: 404 });

    const contextText = answerContext(Array.isArray(body.priorAnswers) ? body.priorAnswers : []);
    if (!contextText) return Response.json({ error: '请先完成至少一个前序环节，再进入自由交流。' }, { status: 400 });
    const config = await getActiveAiConfig();
    if (!config?.apiKey) return Response.json({ error: '请先在管理后台配置 AI 模型' }, { status: 503 });
    await assertApiAccess(Number(session.userId), 'ai');

    const prompt = String(module.prompt || '').trim() || DEFAULT_PROMPT;
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        ...samplingParameters(config.model, 0.5),
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `当前模块：${String(module.title || '自由交流')}\n\n以下是本场面试已完成环节，请据此生成下一道自由交流问题：\n${contextText}` },
        ],
      }),
    });
    const raw = await response.text();
    if (!response.ok) return Response.json({ error: aiRequestError(response.status, raw) }, { status: 502 });
    const payload = safeJsonParse(raw); const question = extractChatContent(payload);
    if (!question) return Response.json({ error: '未生成有效问题' }, { status: 502 });
    const usage = readTokenUsage(payload);
    await logApiUsage(Number(session.userId), 'ai', {
      inputTokens: usage.inputTokens || Math.ceil((prompt + contextText).length / 2),
      outputTokens: usage.outputTokens || Math.ceil(question.length / 2),
      model: config.model,
    });
    let audio: { base64: string; mime: string } | null = null; let audioError = '';
    try {
      const config = typeof templates[0]?.dynamicTtsConfig === 'string' ? JSON.parse(templates[0].dynamicTtsConfig || '{}') : templates[0]?.dynamicTtsConfig;
      const generated = await synthesizeConfiguredQuestionVoice(config, question);
      if (generated) audio = { base64: generated.audio.toString('base64'), mime: generated.mime };
    } catch (error) { audioError = error instanceof Error ? error.message.slice(0, 300) : '现场题目语音生成失败'; }
    return Response.json({ question, audio, audioError: audioError || undefined });
  } catch (error) { return apiError(error); }
}
