import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { syncSimulationFixedVoices } from '@/lib/simulation-fixed-voices';
import type { RowDataPacket } from 'mysql2/promise';

export const runtime = 'nodejs';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (user.role !== 'admin') throw new Error('FORBIDDEN');
    const { id: rawId } = await context.params;
    const templateId = Number(rawId);
    if (!Number.isInteger(templateId) || templateId < 1) return Response.json({ error: '模拟流程不存在。' }, { status: 404 });
    const rows = await query<RowDataPacket[]>('SELECT modules, dynamic_tts_config AS dynamicTtsConfig FROM simulation_templates WHERE id = ? AND is_active = 1 LIMIT 1', [templateId]);
    const template = rows[0];
    if (!template) return Response.json({ error: '模拟流程不存在或已删除。' }, { status: 404 });
    const modules = typeof template.modules === 'string' ? JSON.parse(template.modules || '[]') : template.modules;
    const config = typeof template.dynamicTtsConfig === 'string' ? JSON.parse(template.dynamicTtsConfig || '{}') : template.dynamicTtsConfig;
    const result = await syncSimulationFixedVoices(templateId, modules, config);
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
