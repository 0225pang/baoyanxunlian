import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

type ModelRow = RowDataPacket & {
  id: number;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
};
type PromptRow = RowDataPacket & { id: number; name: string; content: string };

function modelToClient(row: ModelRow) {
  const key = row.apiKey || '';
  return {
    id: Number(row.id),
    name: row.name,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeySet: Boolean(key),
    apiKeyPreview: key ? key.slice(0, 4) + '••••••••' + key.slice(-4) : '',
  };
}

function promptToClient(row: PromptRow) {
  return { id: Number(row.id), name: row.name, content: row.content };
}

async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
  return user;
}

async function readState() {
  const settings = await query<RowDataPacket[]>('SELECT active_config_id AS activeConfigId, active_prompt_id AS activePromptId, auto_transcribe AS autoTranscribe FROM ai_settings WHERE id = 1 LIMIT 1');
  const configs = await query<ModelRow[]>('SELECT id, name, provider, base_url AS baseUrl, model, api_key AS apiKey FROM ai_model_configs ORDER BY id ASC');
  const prompts = await query<PromptRow[]>('SELECT id, name, content FROM ai_prompts ORDER BY id ASC');
  const activeConfigId = Number(settings[0]?.activeConfigId || configs[0]?.id || 0);
  const activePromptId = Number(settings[0]?.activePromptId || prompts[0]?.id || 0);
  return {
    configs: configs.map(modelToClient),
    prompts: prompts.map(promptToClient),
    activeConfigId,
    activePromptId,
    autoTranscribe: Boolean(settings[0]?.autoTranscribe),
  };
}

export async function GET() {
  try {
    await requireAdmin();
    return Response.json(await readState());
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as {
      activeConfigId?: number;
      activePromptId?: number;
      autoTranscribe?: boolean;
      config?: { id?: number; name?: string; provider?: string; baseUrl?: string; model?: string; apiKey?: string };
      prompt?: { id?: number; name?: string; content?: string };
      deleteConfigId?: number;
      deletePromptId?: number;
    };

    if (body.deleteConfigId) {
      const active = await query<RowDataPacket[]>('SELECT active_config_id AS id FROM ai_settings WHERE id = 1 LIMIT 1');
      if (Number(active[0]?.id) === Number(body.deleteConfigId)) return Response.json({ error: '不能删除当前正在使用的模型配置' }, { status: 400 });
      await execute('DELETE FROM ai_model_configs WHERE id = ?', [Number(body.deleteConfigId)]);
    }
    if (body.deletePromptId) {
      const active = await query<RowDataPacket[]>('SELECT active_prompt_id AS id FROM ai_settings WHERE id = 1 LIMIT 1');
      if (Number(active[0]?.id) === Number(body.deletePromptId)) return Response.json({ error: '不能删除当前正在使用的提示词' }, { status: 400 });
      await execute('DELETE FROM ai_prompts WHERE id = ?', [Number(body.deletePromptId)]);
    }

    let configId = Number(body.activeConfigId || 0);
    if (body.config) {
      const name = String(body.config.name || '').trim();
      const provider = String(body.config.provider || '').trim().slice(0, 50);
      const baseUrl = String(body.config.baseUrl || '').trim().replace(/\/+$/, '');
      const model = String(body.config.model || '').trim().slice(0, 150);
      const key = String(body.config.apiKey || '').trim();
      if (!name || !provider || !baseUrl || !model) return Response.json({ error: '模型配置的名称、平台、接口地址和模型名称不能为空' }, { status: 400 });
      if (Number(body.config.id) > 0) {
        if (key) {
          await execute('UPDATE ai_model_configs SET name = ?, provider = ?, base_url = ?, model = ?, api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name, provider, baseUrl, model, key, Number(body.config.id)]);
        } else {
          await execute('UPDATE ai_model_configs SET name = ?, provider = ?, base_url = ?, model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name, provider, baseUrl, model, Number(body.config.id)]);
        }
        configId = Number(body.config.id);
      } else {
        const result = await execute('INSERT INTO ai_model_configs (name, provider, base_url, model, api_key) VALUES (?, ?, ?, ?, ?)', [name, provider, baseUrl, model, key || null]);
        configId = Number(result.insertId);
      }
    }

    let promptId = Number(body.activePromptId || 0);
    if (body.prompt) {
      const name = String(body.prompt.name || '').trim();
      const content = String(body.prompt.content || '').trim();
      if (!name || !content) return Response.json({ error: '提示词名称和内容不能为空' }, { status: 400 });
      if (Number(body.prompt.id) > 0) {
        await execute('UPDATE ai_prompts SET name = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name, content, Number(body.prompt.id)]);
        promptId = Number(body.prompt.id);
      } else {
        const result = await execute('INSERT INTO ai_prompts (name, content) VALUES (?, ?)', [name, content]);
        promptId = Number(result.insertId);
      }
    }

    const state = await readState();
    configId = configId || state.activeConfigId;
    promptId = promptId || state.activePromptId;
    const selectedConfig = state.configs.find((item) => item.id === configId);
    const selectedPrompt = state.prompts.find((item) => item.id === promptId);
    if (!selectedConfig || !selectedPrompt) return Response.json({ error: '请选择有效的模型配置和提示词' }, { status: 400 });
    const selectedKeyRows = await query<RowDataPacket[]>('SELECT api_key AS apiKey FROM ai_model_configs WHERE id = ? LIMIT 1', [configId]);
    const selectedApiKey = selectedKeyRows[0]?.apiKey ? String(selectedKeyRows[0].apiKey) : null;
    const currentSettings = await query<RowDataPacket[]>('SELECT auto_transcribe AS autoTranscribe FROM ai_settings WHERE id = 1 LIMIT 1');
    const autoTranscribe = body.autoTranscribe == null ? Boolean(currentSettings[0]?.autoTranscribe) : Boolean(body.autoTranscribe);
    await execute(
      'UPDATE ai_settings SET active_config_id = ?, active_prompt_id = ?, auto_transcribe = ?, provider = ?, base_url = ?, model = ?, api_key = ?, system_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [configId, promptId, autoTranscribe ? 1 : 0, selectedConfig.provider, selectedConfig.baseUrl, selectedConfig.model, selectedApiKey, selectedPrompt.content],
    );
    return Response.json(await readState());
  } catch (error) {
    if (String(error).includes('Duplicate entry')) return Response.json({ error: '名称已经存在，请换一个名称' }, { status: 409 });
    return apiError(error);
  }
}
