import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { chatCompletionsUrl, extractChatContent, getActiveAiConfig, safeJsonParse } from '@/lib/ai';
import type { RowDataPacket } from 'mysql2/promise';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id: rawId } = await context.params; const sessionId = Number(rawId);
    const body = await request.json() as { question?: string; answer?: string; moduleTitle?: string };
    const sessions = await query<RowDataPacket[]>('SELECT user_id AS userId, template_id AS templateId FROM simulation_sessions WHERE id = ? LIMIT 1', [sessionId]);
    if (!sessions[0] || (Number(sessions[0].userId) !== user.id && user.role !== 'admin')) return Response.json({ error: '模拟场次不存在或无权访问' }, { status: 404 });
    const config = await getActiveAiConfig(); if (!config?.apiKey) return Response.json({ error: '请先在管理后台配置 AI 模型' }, { status: 503 });
    const templates = await query<RowDataPacket[]>('SELECT followup_prompt AS followupPrompt FROM simulation_templates WHERE id = ? LIMIT 1', [Number(sessions[0].templateId)]);
    const prompt = String(templates[0]?.followupPrompt || '你是一名食品专业保研面试老师。请根据题目和回答提出一个自然的追问。只输出追问问题。');
    const response = await fetch(chatCompletionsUrl(config.baseUrl), { method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, temperature: 0.45, messages: [{ role: 'system', content: prompt }, { role: 'user', content: '环节：' + String(body.moduleTitle || '') + '\n题目：' + String(body.question || '') + '\n学员回答：' + String(body.answer || '') }] }) });
    const raw = await response.text(); if (!response.ok) return Response.json({ error: '追问生成失败：' + raw.slice(0, 400) }, { status: 502 });
    const followup = extractChatContent(safeJsonParse(raw)); if (!followup) return Response.json({ error: '未生成追问' }, { status: 502 });
    return Response.json({ followup });
  } catch (error) { return apiError(error); }
}
