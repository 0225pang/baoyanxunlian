import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from './db';
import type { RowDataPacket } from 'mysql2/promise';

export type AsrConfig = {
  key: string;
  model: string;
  submitUrl: string;
  taskUrl: string;
  publicBaseUrl: string;
  tokenSecret: string;
};

function cleanSecret(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/^(?:Bearer\s+|(?:siliconflow|dashscope)_api\s*=\s*|api[_-]?key\s*=\s*)/i, '').trim();
}

function environmentConfig(): AsrConfig {
  // Keep the old variable as a migration fallback, but all new deployments
  // should use DASHSCOPE_API_KEY.
  const rawKey = process.env.DASHSCOPE_API_KEY
    || process.env.BAILIAN_API_KEY
    || process.env.SILICONFLOW_API_KEY
    || '';
  const key = cleanSecret(rawKey);
  const submitUrl = (process.env.DASHSCOPE_ASR_URL
    || 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription').trim();
  let defaultTaskUrl = 'https://dashscope.aliyuncs.com/api/v1/tasks';
  try {
    defaultTaskUrl = new URL(submitUrl).origin + '/api/v1/tasks';
  } catch {
    // The submit request will report a useful URL error if a custom URL is invalid.
  }

  return {
    key,
    model: (process.env.DASHSCOPE_ASR_MODEL || 'paraformer-v1').trim(),
    submitUrl,
    taskUrl: (process.env.DASHSCOPE_TASK_URL || defaultTaskUrl).trim().replace(/\/+$/, ''),
    publicBaseUrl: (process.env.ASR_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
    tokenSecret: cleanSecret(process.env.ASR_AUDIO_TOKEN_SECRET || key),
  };
}

export async function getAsrConfig(): Promise<AsrConfig> {
  const fallback = environmentConfig();
  const rows = await query<RowDataPacket[]>(`SELECT provider, submit_url AS submitUrl, task_url AS taskUrl, model,
      api_key AS apiKey, public_base_url AS publicBaseUrl, token_secret AS tokenSecret
      FROM asr_settings WHERE id = 1 LIMIT 1`);
  const row = rows[0];
  if (!row) return fallback;
  return {
    key: cleanSecret(String(row.apiKey || fallback.key)),
    model: String(row.model || fallback.model).trim(),
    submitUrl: String(row.submitUrl || fallback.submitUrl).trim(),
    taskUrl: String(row.taskUrl || fallback.taskUrl).trim().replace(/\/+$/, ''),
    publicBaseUrl: String(row.publicBaseUrl || fallback.publicBaseUrl).trim().replace(/\/+$/, ''),
    tokenSecret: cleanSecret(String(row.tokenSecret || fallback.tokenSecret)),
  };
}

export function createAudioToken(recordId: number, secret: string, ttlSeconds = 3600) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = String(recordId) + '.' + String(expires);
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}

export function verifyAudioToken(token: string, recordId: number, secret: string) {
  const parts = token.split('.');
  if (parts.length !== 3 || !secret) return false;
  const [id, expiresText, signature] = parts;
  const expires = Number(expiresText);
  if (Number(id) !== recordId || !Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  const payload = id + '.' + expiresText;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export type TranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export function extractTranscriptSegments(value: unknown): TranscriptSegment[] {
  const collected: TranscriptSegment[] = [];

  function visit(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const object = node as Record<string, unknown>;
    const sentences = object.sentences;
    if (Array.isArray(sentences)) {
      for (const sentence of sentences) {
        if (!sentence || typeof sentence !== 'object') continue;
        const item = sentence as Record<string, unknown>;
        const startMs = Number(item.begin_time);
        const endMs = Number(item.end_time);
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs && text) {
          collected.push({ startMs, endMs, text });
        }
      }
    }

    for (const key of ['transcripts', 'output', 'result', 'data', 'choices']) {
      visit(object[key]);
    }
  }

  visit(value);
  const seen = new Set<string>();
  return collected
    .filter((segment) => {
      const key = segment.startMs + ':' + segment.endMs + ':' + segment.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startMs - b.startMs);
}
export function extractTranscript(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(extractTranscript).filter(Boolean).join('\n').trim();
  if (typeof value !== 'object') return '';

  const object = value as Record<string, unknown>;
  for (const key of ['text', 'transcript']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  for (const key of ['sentences', 'transcripts', 'segments', 'results', 'output', 'result', 'data', 'choices', 'content']) {
    const nested = extractTranscript(object[key]);
    if (nested) return nested;
  }
  return '';
}

export function findString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, key);
      if (found) return found;
    }
    return '';
  }

  const object = value as Record<string, unknown>;
  if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  for (const nested of Object.values(object)) {
    const found = findString(nested, key);
    if (found) return found;
  }
  return '';
}
