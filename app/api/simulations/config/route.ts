import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

async function admin() { const user = await requireUser(); if (user.role !== 'admin') throw new Error('FORBIDDEN'); }
function preview(value: string | null) { const key = String(value || ''); return key ? key.slice(0, 4) + '••••••••' + key.slice(-4) : ''; }

export async function GET() {
  try {
    await admin();
    const templates = await query('SELECT id, name, description, modules, total_seconds AS totalSeconds, module_timeout_mode AS moduleTimeoutMode, dynamic_tts_config AS dynamicTtsConfig, followup_prompt AS followupPrompt, is_active AS isActive FROM simulation_templates WHERE is_active = 1 ORDER BY id ASC');
    const settings = await query<RowDataPacket[]>('SELECT provider, websocket_url AS websocketUrl, workspace_id AS workspaceId, model, api_key AS apiKey FROM realtime_asr_settings WHERE id = 1 LIMIT 1');
    const row = settings[0];
    return Response.json({ templates, realtimeAsr: row ? { provider: row.provider, websocketUrl: row.websocketUrl, workspaceId: row.workspaceId || '', model: row.model, apiKeySet: Boolean(row.apiKey), apiKeyPreview: preview(row.apiKey) } : null });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    await admin();
    const body = await request.json() as { deleteTemplateId?: number; template?: { id?: number; name?: string; description?: string; modules?: unknown; totalSeconds?: number | null; moduleTimeoutMode?: string; dynamicTtsConfig?: unknown; followupPrompt?: string; isActive?: boolean }; realtimeAsr?: { provider?: string; websocketUrl?: string; workspaceId?: string; model?: string; apiKey?: string } };
    if (Number(body.deleteTemplateId) > 0) {
      const result = await execute('UPDATE simulation_templates SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 1', [Number(body.deleteTemplateId)]);
      if (!result.affectedRows) return Response.json({ error: '模拟流程不存在或已删除' }, { status: 404 });
      return GET();
    }
    if (body.template) {
      const item = body.template; const name = String(item.name || '').trim(); const modules = Array.isArray(item.modules) ? item.modules : [];
      const totalSeconds = Math.floor(Number(item.totalSeconds));
      const moduleTimeoutMode = ['immediate_advance', 'auto_advance'].includes(String(item.moduleTimeoutMode)) ? String(item.moduleTimeoutMode) : 'warn';
      const rawTts = item.dynamicTtsConfig && typeof item.dynamicTtsConfig === 'object' ? item.dynamicTtsConfig as Record<string, unknown> : {};
      const provider = ['browser', 'baidu', 'bailian'].includes(String(rawTts.provider)) ? String(rawTts.provider) : 'browser';
      const sourceMode = provider === 'bailian' && rawTts.sourceMode === 'clone' ? 'clone' : 'sambert';
      const voiceId = String(rawTts.voiceId || '').trim().slice(0, 255);
      if (provider === 'bailian' && sourceMode === 'clone' && !voiceId) return Response.json({ error: '使用百炼复刻音色时，请选择已完成复刻的音色。' }, { status: 400 });
      const dynamicTtsConfig = { provider, sourceMode, model: String(rawTts.model || '').trim().slice(0, 150), voiceId, per: Math.max(0, Math.min(50000, Number(rawTts.per) || 1)), rate: Math.max(0.5, Math.min(2, Number(rawTts.rate) || 1)), pitch: Math.max(0.5, Math.min(2, Number(rawTts.pitch) || 1)), volume: Math.max(0, Math.min(100, Number(rawTts.volume) || 50)) };
      if (!name || !modules.length) return Response.json({ error: '模拟名称和至少一个模块不能为空' }, { status: 400 });
      if (!Number.isFinite(totalSeconds) || totalSeconds < 1) return Response.json({ error: '总时长不能为空，且必须是大于 0 的秒数。' }, { status: 400 });
      if (modules.some((module) => module && typeof module === 'object' && ['fixed', 'intro', 'dynamic'].includes(String((module as { kind?: unknown }).kind || '')) && !String((module as { prompt?: unknown }).prompt || '').trim())) return Response.json({ error: '固定题目、开场任务或动态提问提示词不能为空，请补充内容' }, { status: 400 });
      if (Number(item.id) > 0) await execute('UPDATE simulation_templates SET name = ?, description = ?, modules = ?, total_seconds = ?, module_timeout_mode = ?, dynamic_tts_config = ?, followup_prompt = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name, String(item.description || '').trim() || null, JSON.stringify(modules), totalSeconds, moduleTimeoutMode, JSON.stringify(dynamicTtsConfig), String(item.followupPrompt || '').trim() || null, item.isActive === false ? 0 : 1, Number(item.id)]);
      else await execute('INSERT INTO simulation_templates (name, description, modules, total_seconds, module_timeout_mode, dynamic_tts_config, followup_prompt, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [name, String(item.description || '').trim() || null, JSON.stringify(modules), totalSeconds, moduleTimeoutMode, JSON.stringify(dynamicTtsConfig), String(item.followupPrompt || '').trim() || null, item.isActive === false ? 0 : 1]);
    }
    if (body.realtimeAsr) {
      const value = body.realtimeAsr; const provider = String(value.provider || 'bailian').trim(); const websocketUrl = String(value.websocketUrl || '').trim(); const workspaceId = String(value.workspaceId || '').trim().slice(0, 150); const model = String(value.model || '').trim(); const apiKey = String(value.apiKey || '').trim();
      if (!provider || !websocketUrl || !model) return Response.json({ error: '实时转写的平台、WebSocket 地址和模型不能为空' }, { status: 400 });
      if (!['qwen-audio-3.0-asr-flash-streaming', 'paraformer-realtime-v2', 'paraformer-realtime-v1'].includes(model)) return Response.json({ error: '实时转写模型仅支持 Qwen Audio Flash Streaming、Paraformer Realtime v2 或 v1' }, { status: 400 });
      if (model.startsWith('paraformer-realtime-') && !workspaceId) return Response.json({ error: 'Paraformer 实时转写必须填写百炼北京地域业务空间 ID' }, { status: 400 });
      if (apiKey) await execute('UPDATE realtime_asr_settings SET provider = ?, websocket_url = ?, workspace_id = ?, model = ?, api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [provider, websocketUrl, workspaceId || null, model, apiKey]);
      else await execute('UPDATE realtime_asr_settings SET provider = ?, websocket_url = ?, workspace_id = ?, model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [provider, websocketUrl, workspaceId || null, model]);
    }
    return GET();
  } catch (error) { return apiError(error); }
}
