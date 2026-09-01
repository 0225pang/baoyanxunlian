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
  enabled: number;
  logoImageId: number | null;
  logoFilename: string | null;
};
type PromptRow = RowDataPacket & { id: number; name: string; content: string };
type AsrRow = RowDataPacket & {
  provider: string;
  submitUrl: string;
  taskUrl: string;
  model: string;
  apiKey: string | null;
  publicBaseUrl: string | null;
  tokenSecret: string | null;
};

function modelToClient(row: ModelRow) {
  const key = row.apiKey || '';
  return {
    id: Number(row.id),
    name: row.name,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: Boolean(row.enabled),
    logoImageId: row.logoImageId == null ? null : Number(row.logoImageId),
    logoUrl: row.logoImageId == null ? null : `/api/ai/model-images/${Number(row.logoImageId)}`,
    apiKeySet: Boolean(key),
    apiKeyPreview: key ? key.slice(0, 4) + '••••••••' + key.slice(-4) : '',
  };
}

function promptToClient(row: PromptRow) {
  return { id: Number(row.id), name: row.name, content: row.content };
}

function secretPreview(value: string | null) {
  const secret = String(value || '');
  return secret ? secret.slice(0, 4) + '••••••••' + secret.slice(-4) : '';
}

function asrToClient(row: AsrRow) {
  return {
    provider: row.provider,
    submitUrl: row.submitUrl,
    taskUrl: row.taskUrl,
    model: row.model,
    enabled: Boolean(row.enabled),
    publicBaseUrl: row.publicBaseUrl || '',
    apiKeySet: Boolean(row.apiKey),
    apiKeyPreview: secretPreview(row.apiKey),
    tokenSecretSet: Boolean(row.tokenSecret),
    tokenSecretPreview: secretPreview(row.tokenSecret),
  };
}

async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
  return user;
}

async function readState() {
  const settings = await query<RowDataPacket[]>('SELECT active_config_id AS activeConfigId, active_prompt_id AS activePromptId, auto_transcribe AS autoTranscribe FROM ai_settings WHERE id = 1 LIMIT 1');
  const configs = await query<ModelRow[]>(`SELECT c.id, c.name, c.provider, c.base_url AS baseUrl, c.model, c.api_key AS apiKey, c.enabled,
    c.logo_image_id AS logoImageId, i.filename AS logoFilename
    FROM ai_model_configs c LEFT JOIN ai_model_images i ON i.id = c.logo_image_id ORDER BY c.id ASC`);
  const prompts = await query<PromptRow[]>('SELECT id, name, content FROM ai_prompts ORDER BY id ASC');
  const asrRows = await query<AsrRow[]>('SELECT provider, submit_url AS submitUrl, task_url AS taskUrl, model, api_key AS apiKey, public_base_url AS publicBaseUrl, token_secret AS tokenSecret FROM asr_settings WHERE id = 1 LIMIT 1');
  const activeConfigId = Number(settings[0]?.activeConfigId || configs.find((item) => Boolean(item.enabled))?.id || 0);
  const activePromptId = Number(settings[0]?.activePromptId || prompts[0]?.id || 0);
  return {
    configs: configs.map(modelToClient),
    prompts: prompts.map(promptToClient),
    activeConfigId,
    activePromptId,
    autoTranscribe: Boolean(settings[0]?.autoTranscribe),
    asrConfig: asrRows[0] ? asrToClient(asrRows[0]) : null,
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
      config?: { id?: number; name?: string; provider?: string; baseUrl?: string; model?: string; apiKey?: string; enabled?: boolean; logoImageId?: number | null };
      prompt?: { id?: number; name?: string; content?: string };
      asrConfig?: { provider?: string; submitUrl?: string; taskUrl?: string; model?: string; apiKey?: string; publicBaseUrl?: string; tokenSecret?: string };
      deleteConfigId?: number;
      toggleConfigId?: number;
      toggleConfigEnabled?: boolean;
      deletePromptId?: number;
    };

    if (body.deleteConfigId) {
      const active = await query<RowDataPacket[]>('SELECT active_config_id AS id FROM ai_settings WHERE id = 1 LIMIT 1');
      if (Number(active[0]?.id) === Number(body.deleteConfigId)) return Response.json({ error: '不能删除当前正在使用的模型配置' }, { status: 400 });
      await execute('DELETE FROM ai_model_configs WHERE id = ?', [Number(body.deleteConfigId)]);
    }
    if (body.toggleConfigId) {
      const id = Number(body.toggleConfigId);
      if (body.toggleConfigEnabled === false) {
        const available = await query<RowDataPacket[]>('SELECT id FROM ai_model_configs WHERE enabled=1 AND id<>? ORDER BY id ASC LIMIT 1', [id]);
        if (!available.length) return Response.json({ error: '至少要保留一个可用模型配置。' }, { status: 400 });
        await execute('UPDATE ai_model_configs SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?', [id]);
        await execute('UPDATE user_settings SET ai_config_id=NULL WHERE ai_config_id=?', [id]);
        await execute('UPDATE ai_settings SET active_config_id=? WHERE id=1 AND active_config_id=?', [Number(available[0].id), id]);
      } else {
        await execute('UPDATE ai_model_configs SET enabled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?', [id]);
      }
      return Response.json(await readState());
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
      const hasLogoImage = Object.prototype.hasOwnProperty.call(body.config, 'logoImageId');
      const logoImageId = body.config.logoImageId == null ? null : Number(body.config.logoImageId);
      if (hasLogoImage && logoImageId !== null) {
        if (!Number.isSafeInteger(logoImageId) || logoImageId <= 0) return Response.json({ error: '模型图标无效。' }, { status: 400 });
        const imageRows = await query<RowDataPacket[]>('SELECT id FROM ai_model_images WHERE id=? LIMIT 1', [logoImageId]);
        if (!imageRows.length) return Response.json({ error: '所选模型图标不存在，请重新上传或选择。' }, { status: 400 });
      }
      if (!name || !provider || !baseUrl || !model) return Response.json({ error: '模型配置的名称、平台、接口地址和模型名称不能为空' }, { status: 400 });
      if (Number(body.config.id) > 0) {
        if (key) {
          await execute(`UPDATE ai_model_configs SET name=?, provider=?, base_url=?, model=?, api_key=?, enabled=?, logo_image_id=CASE WHEN ? THEN ? ELSE logo_image_id END, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [name, provider, baseUrl, model, key, body.config.enabled === false ? 0 : 1, hasLogoImage ? 1 : 0, logoImageId, Number(body.config.id)]);
        } else {
          await execute(`UPDATE ai_model_configs SET name=?, provider=?, base_url=?, model=?, enabled=?, logo_image_id=CASE WHEN ? THEN ? ELSE logo_image_id END, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [name, provider, baseUrl, model, body.config.enabled === false ? 0 : 1, hasLogoImage ? 1 : 0, logoImageId, Number(body.config.id)]);
        }
        configId = Number(body.config.id);
      } else {
        const result = await execute('INSERT INTO ai_model_configs (name, provider, base_url, model, api_key, enabled, logo_image_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [name, provider, baseUrl, model, key || null, body.config.enabled === false ? 0 : 1, hasLogoImage ? logoImageId : null]);
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

    if (body.asrConfig) {
      const provider = String(body.asrConfig.provider || 'bailian').trim().slice(0, 50);
      const submitUrl = String(body.asrConfig.submitUrl || '').trim().replace(/\/+$/, '');
      const taskUrl = String(body.asrConfig.taskUrl || '').trim().replace(/\/+$/, '');
      const model = String(body.asrConfig.model || '').trim().slice(0, 150);
      const publicBaseUrl = String(body.asrConfig.publicBaseUrl || '').trim().replace(/\/+$/, '');
      const apiKey = String(body.asrConfig.apiKey || '').trim();
      const tokenSecret = String(body.asrConfig.tokenSecret || '').trim();
      if (!provider || !submitUrl || !taskUrl || !model) return Response.json({ error: '转写配置的平台、提交地址、任务地址和模型名称不能为空' }, { status: 400 });
      if (apiKey && tokenSecret) {
        await execute('UPDATE asr_settings SET provider = ?, submit_url = ?, task_url = ?, model = ?, api_key = ?, public_base_url = ?, token_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [provider, submitUrl, taskUrl, model, apiKey, publicBaseUrl || null, tokenSecret]);
      } else if (apiKey) {
        await execute('UPDATE asr_settings SET provider = ?, submit_url = ?, task_url = ?, model = ?, api_key = ?, public_base_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [provider, submitUrl, taskUrl, model, apiKey, publicBaseUrl || null]);
      } else if (tokenSecret) {
        await execute('UPDATE asr_settings SET provider = ?, submit_url = ?, task_url = ?, model = ?, public_base_url = ?, token_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [provider, submitUrl, taskUrl, model, publicBaseUrl || null, tokenSecret]);
      } else {
        await execute('UPDATE asr_settings SET provider = ?, submit_url = ?, task_url = ?, model = ?, public_base_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [provider, submitUrl, taskUrl, model, publicBaseUrl || null]);
      }
    }

    const state = await readState();
    configId = configId || state.activeConfigId;
    promptId = promptId || state.activePromptId;
    const selectedConfig = state.configs.find((item) => item.id === configId && item.enabled);
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
