import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

type Module = { id: string; title: string; kind: 'intro' | 'question'; typeCode?: string; count?: number; timeSeconds?: number; allowFollowup?: boolean; prompt?: string };

export async function GET() {
  try {
    await requireUser();
    const templates = await query('SELECT id, name, description, modules, total_seconds AS totalSeconds FROM simulation_templates WHERE is_active = 1 ORDER BY id ASC');
    return Response.json({ templates });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(); const body = await request.json() as { templateId?: number };
    const rows = await query<RowDataPacket[]>('SELECT id, name, modules, total_seconds AS totalSeconds FROM simulation_templates WHERE id = ? AND is_active = 1 LIMIT 1', [Number(body.templateId)]);
    const template = rows[0]; if (!template) return Response.json({ error: '模拟模板不存在或未启用' }, { status: 404 });
    const modules = (typeof template.modules === 'string' ? JSON.parse(template.modules) : template.modules) as Module[];
    const steps: Array<Module & { questionId?: number; question?: string; category?: string; subcategory?: string | null }> = [];
    for (const module of modules) {
      const count = Math.max(1, Number(module.count) || 1);
      for (let index = 0; index < count; index += 1) {
        if (module.kind === 'intro') { steps.push({ ...module, id: module.id + '-' + index }); continue; }
        const questions = await query<RowDataPacket[]>(`SELECT q.id, q.content, q.subcategory, t.name AS category FROM questions q JOIN question_types t ON t.id = q.type_id WHERE q.status = 'active' AND t.code = ? ORDER BY RAND() LIMIT 1`, [module.typeCode || 'professional']);
        if (!questions[0]) return Response.json({ error: '题库中没有“' + module.title + '”可抽取的题目，请先补充该题型题目' }, { status: 400 });
        const question = questions[0]; steps.push({ ...module, id: module.id + '-' + index, questionId: Number(question.id), question: String(question.content), category: String(question.category), subcategory: question.subcategory ? String(question.subcategory) : null });
      }
    }
    const result = await execute('INSERT INTO simulation_sessions (user_id, template_id, template_name, total_seconds) VALUES (?, ?, ?, ?)', [user.id, Number(template.id), String(template.name), Number(template.totalSeconds)]);
    return Response.json({ sessionId: Number(result.insertId), template: { id: Number(template.id), name: template.name, totalSeconds: Number(template.totalSeconds) }, steps }, { status: 201 });
  } catch (error) { return apiError(error); }
}
