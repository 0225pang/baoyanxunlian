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
