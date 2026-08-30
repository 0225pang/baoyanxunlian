import { createHash } from 'node:crypto';
import { query } from './db';
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
  if (
    /AllocationQuota\.FreeTierOnly|quota|insufficient[_\s-]?(?:balance|credit|fund)|balance.*(?:insufficient|not enough)|额度(?:不足|用尽|已用完)|余额不足|免费额度.*(?:用尽|耗尽)|no\s+(?:remaining\s+)?(?:credit|quota)/i.test(
      message,
    )
  ) {
    return AI_QUOTA_EXHAUSTED_MESSAGE;
  }
  return message;
}

export function aiRequestError(status: number, raw: string) {
  const readable = userFacingAiError(raw);
  return readable === raw
    ? `AI 请求失败 ${status}：${raw.slice(0, 500)}`
    : readable;
}

export async function getActiveAiConfig(): Promise<ActiveAiConfig | null> {
  const rows = await query<RowDataPacket[]>(`SELECT
      COALESCE(c.id, s.active_config_id) AS configId,
      COALESCE(p.id, s.active_prompt_id) AS promptId,
      COALESCE(c.provider, s.provider) AS provider,
      COALESCE(c.base_url, s.base_url) AS baseUrl,
      COALESCE(c.model, s.model) AS model,
      COALESCE(c.api_key, s.api_key) AS apiKey,
      COALESCE(p.content, s.system_prompt) AS systemPrompt,
      s.auto_transcribe AS autoTranscribe
      FROM ai_settings s
      LEFT JOIN ai_model_configs c ON c.id = s.active_config_id
      LEFT JOIN ai_prompts p ON p.id = s.active_prompt_id
      WHERE s.id = 1 LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
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
