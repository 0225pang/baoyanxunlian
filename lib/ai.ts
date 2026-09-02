import { createHash } from 'node:crypto';
import { execute, query } from './db';
import type { RowDataPacket } from 'mysql2/promise';

export type AiConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
};

export type ActiveAiConfig = AiConfig & { configId: number; promptId: number; autoTranscribe: boolean };

export const AI_QUOTA_EXHAUSTED_MESSAGE = '您的模型额度不足，请联系管理员充值。';
export const AI_ACCESS_DISABLED_MESSAGE = '您暂未开通 AI 对话权限，请联系管理员。';

// Upstream providers use different error shapes for an exhausted balance or a
// free-tier-only account.  Never expose their raw payload to students.
export function userFacingAiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/\bfetch failed\b|ECONN(?:REFUSED|RESET)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network(?:\s+error)?/i.test(message)) {
    return 'AI 服务连接失败，请稍后重试；如持续出现请联系管理员。';
  }
  if (/\bAbortError\b|请求超时|生成超时/i.test(message)) return 'AI 服务响应超时，请稍后重试。';
  if (
    /AllocationQuota\.FreeTierOnly|quota|insufficient[_\s-]?(?:balance|credit|fund)|balance.*(?:insufficient|not enough)|额度(?:不足|用尽|已用完)|余额不足|免费额度.*(?:用尽|耗尽)|no\s+(?:remaining\s+)?(?:credit|quota)/i.test(
      message,
    )
  ) {
    return AI_QUOTA_EXHAUSTED_MESSAGE;
  }
  return message;
}

export function isAiQuotaExhausted(error: unknown) {
  return userFacingAiError(error) === AI_QUOTA_EXHAUSTED_MESSAGE;
}

/** Disable a configuration whose provider reports an exhausted quota.
 * Users who selected it fall back to the administrator default immediately. */
export async function disableAiConfigForQuota(configId: number) {
  if (!Number.isInteger(configId) || configId < 1) return;
  await execute('UPDATE ai_model_configs SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [configId]);
  await execute('UPDATE user_settings SET ai_config_id = NULL WHERE ai_config_id = ?', [configId]);
  const rows = await query<RowDataPacket[]>('SELECT id, provider, base_url AS baseUrl, model, api_key AS apiKey FROM ai_model_configs WHERE enabled = 1 ORDER BY id ASC LIMIT 1');
  const fallback = rows[0];
  if (fallback) {
    await execute('UPDATE ai_settings SET active_config_id = ?, provider = ?, base_url = ?, model = ?, api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1 AND active_config_id = ?', [Number(fallback.id), fallback.provider, fallback.baseUrl, fallback.model, fallback.apiKey || null, configId]);
  }
}

export async function aiRequestErrorWithFallback(config: Pick<ActiveAiConfig, 'configId'>, status: number, raw: string) {
  if (isAiQuotaExhausted(raw)) await disableAiConfigForQuota(config.configId).catch(() => undefined);
  return aiRequestError(status, raw);
}

export function aiRequestError(status: number, raw: string) {
  const readable = userFacingAiError(raw);
  return readable === raw
    ? `AI 请求失败 ${status}：${raw.slice(0, 500)}`
    : readable;
}

export async function getActiveAiConfig(userId?: number): Promise<ActiveAiConfig | null> {
  const rows = await query<RowDataPacket[]>(`SELECT
      COALESCE(user_config.id, default_config.id, fallback_config.id) AS configId,
      us.ai_config_id AS requestedConfigId,
      COALESCE(p.id, s.active_prompt_id) AS promptId,
      COALESCE(user_config.provider, default_config.provider, fallback_config.provider, s.provider) AS provider,
      COALESCE(user_config.base_url, default_config.base_url, fallback_config.base_url, s.base_url) AS baseUrl,
      COALESCE(user_config.model, default_config.model, fallback_config.model, s.model) AS model,
      COALESCE(user_config.api_key, default_config.api_key, fallback_config.api_key, s.api_key) AS apiKey,
      COALESCE(p.content, s.system_prompt) AS systemPrompt,
      s.auto_transcribe AS autoTranscribe
      FROM ai_settings s
      LEFT JOIN user_settings us ON us.user_id = ?
      LEFT JOIN ai_model_configs user_config ON user_config.id = us.ai_config_id AND user_config.enabled = 1
      LEFT JOIN ai_model_configs default_config ON default_config.id = s.active_config_id AND default_config.enabled = 1
      LEFT JOIN ai_model_configs fallback_config ON fallback_config.id = (SELECT id FROM ai_model_configs WHERE enabled = 1 ORDER BY id ASC LIMIT 1)
      LEFT JOIN ai_prompts p ON p.id = s.active_prompt_id
      WHERE s.id = 1 LIMIT 1`, [Number.isInteger(userId) ? userId : 0]);
  const row = rows[0];
  if (!row) return null;
  if (Number.isInteger(userId) && Number(row.requestedConfigId || 0) > 0 && Number(row.requestedConfigId) !== Number(row.configId || 0)) {
    await execute('UPDATE user_settings SET ai_config_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND ai_config_id = ?', [Number(userId || 0), Number(row.requestedConfigId)]).catch(() => undefined);
  }
  return {
    configId: Number(row.configId || 0),
    promptId: Number(row.promptId || 0),
    provider: String(row.provider || ''),
    baseUrl: String(row.baseUrl || ''),
    model: String(row.model || ''),
    apiKey: String(row.apiKey || ''),
    systemPrompt: String(row.systemPrompt || ''),
    autoTranscribe: Boolean(row.autoTranscribe),
  };
}

export function hashEvaluationInput(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function chatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : normalized + '/chat/completions';
}

/** Kimi K3 rejects temperature entirely; compatible models keep the existing defaults. */
export function samplingParameters(model: string, temperature: number) {
  return /^kimi-k3(?:$|[-_:])/i.test(model.trim()) ? {} : { temperature };
}

export function extractChatContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as { message?: { content?: unknown } }).message;
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

export function safeJsonParse(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}
