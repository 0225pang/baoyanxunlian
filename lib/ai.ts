import { createHash } from 'node:crypto';

export type AiConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
};

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
