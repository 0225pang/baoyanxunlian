import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

type ConfigRow = RowDataPacket & {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  systemPrompt: string;
};

function toClient(row: ConfigRow) {
  const key = row.apiKey || '';
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeySet: Boolean(key),
    apiKeyPreview: key ? key.slice(0, 4) + '••••••••' + key.slice(-4) : '',
    systemPrompt: row.systemPrompt,
  };
}

async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
  return user;
}

export async function GET() {
  try {
    await requireAdmin();
    const rows = await query<ConfigRow[]>('SELECT provider, base_url AS baseUrl, model, api_key AS apiKey, system_prompt AS systemPrompt FROM ai_settings WHERE id = 1 LIMIT 1');
    if (!rows[0]) return Response.json({ config: null });
    return Response.json({ config: toClient(rows[0]) });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as Partial<ConfigRow> & { apiKey?: string };
    const provider = String(body.provider || 'bailian').trim().slice(0, 50);
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    const model = String(body.model || '').trim().slice(0, 150);
    const systemPrompt = String(body.systemPrompt || '').trim();
    if (!provider || !baseUrl || !model || !systemPrompt) return Response.json({ error: '平台、接口地址、模型名称和提示词不能为空' }, { status: 400 });
    const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (suppliedKey) {
      await execute(
        'INSERT INTO ai_settings (id, provider, base_url, model, api_key, system_prompt) VALUES (1, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE provider = VALUES(provider), base_url = VALUES(base_url), model = VALUES(model), api_key = VALUES(api_key), system_prompt = VALUES(system_prompt), updated_at = CURRENT_TIMESTAMP',
        [provider, baseUrl, model, suppliedKey, systemPrompt],
      );
    } else {
      await execute(
        'INSERT INTO ai_settings (id, provider, base_url, model, system_prompt) VALUES (1, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE provider = VALUES(provider), base_url = VALUES(base_url), model = VALUES(model), system_prompt = VALUES(system_prompt), updated_at = CURRENT_TIMESTAMP',
        [provider, baseUrl, model, systemPrompt],
      );
    }
    const rows = await query<ConfigRow[]>('SELECT provider, base_url AS baseUrl, model, api_key AS apiKey, system_prompt AS systemPrompt FROM ai_settings WHERE id = 1 LIMIT 1');
    return Response.json({ config: rows[0] ? toClient(rows[0]) : null });
  } catch (error) { return apiError(error); }
}
