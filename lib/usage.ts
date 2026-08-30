import { execute, query } from './db';
import { AI_ACCESS_DISABLED_MESSAGE, AI_QUOTA_EXHAUSTED_MESSAGE } from './ai';
import type { RowDataPacket } from 'mysql2/promise';

export type ApiFeature = 'ai' | 'asr' | 'realtime_asr';

type LimitRow = RowDataPacket & {
  aiEnabled: number;
  asrEnabled: number;
  realtimeAsrEnabled: number;
  aiTokenLimit: number;
  asrRequestLimit: number;
  realtimeSecondsLimit: number;
};

const featureLabel: Record<ApiFeature, string> = {
  ai: 'AI 对话、评估与追问',
  asr: '录音转文字',
  realtime_asr: '实时语音转写',
};

function limitMessage(feature: ApiFeature, reason: 'disabled' | 'quota') {
  if (feature === 'ai') {
    return reason === 'disabled'
      ? `API_DISABLED:${AI_ACCESS_DISABLED_MESSAGE}`
      : `API_LIMIT:${AI_QUOTA_EXHAUSTED_MESSAGE}`;
  }
  return reason === 'disabled'
    ? `API_DISABLED:${featureLabel[feature]}已被管理员关闭`
    : `API_LIMIT:${featureLabel[feature]}本月额度已用完`;
}

export async function assertApiAccess(userId: number, feature: ApiFeature) {
  await execute('INSERT IGNORE INTO user_api_limits (user_id) VALUES (?)', [userId]);
  const rows = await query<LimitRow[]>(`SELECT
    ai_enabled AS aiEnabled, asr_enabled AS asrEnabled, realtime_asr_enabled AS realtimeAsrEnabled,
    ai_token_limit AS aiTokenLimit, asr_request_limit AS asrRequestLimit, realtime_seconds_limit AS realtimeSecondsLimit
    FROM user_api_limits WHERE user_id = ? LIMIT 1`, [userId]);
  const limit = rows[0];
  const enabled = feature === 'ai' ? Boolean(limit?.aiEnabled) : feature === 'asr' ? Boolean(limit?.asrEnabled) : Boolean(limit?.realtimeAsrEnabled);
  if (!enabled) throw new Error(limitMessage(feature, 'disabled'));

  const usageRows = await query<RowDataPacket[]>(`SELECT
    COALESCE(SUM(input_tokens + output_tokens), 0) AS aiTokens,
    COALESCE(SUM(request_count), 0) AS asrRequests,
    COALESCE(SUM(audio_seconds), 0) AS realtimeSeconds
    FROM api_usage_logs
    WHERE user_id = ? AND created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')`, [userId]);
  const usage = usageRows[0] || {};
  const used = feature === 'ai' ? Number(usage.aiTokens || 0) : feature === 'asr' ? Number(usage.asrRequests || 0) : Number(usage.realtimeSeconds || 0);
  const cap = feature === 'ai' ? Number(limit?.aiTokenLimit || 0) : feature === 'asr' ? Number(limit?.asrRequestLimit || 0) : Number(limit?.realtimeSecondsLimit || 0);
  if (cap > 0 && used >= cap) throw new Error(limitMessage(feature, 'quota'));
}

export async function logApiUsage(userId: number, feature: ApiFeature, values: { inputTokens?: number; outputTokens?: number; audioSeconds?: number; requestCount?: number; model?: string | null }) {
  const inputTokens = Math.max(0, Math.floor(Number(values.inputTokens || 0)));
  const outputTokens = Math.max(0, Math.floor(Number(values.outputTokens || 0)));
  const audioSeconds = Math.max(0, Math.round(Number(values.audioSeconds || 0)));
  const requestCount = Math.max(0, Math.floor(Number(values.requestCount == null ? 1 : values.requestCount)));
  await execute(
    'INSERT INTO api_usage_logs (user_id, feature, input_tokens, output_tokens, audio_seconds, request_count, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, feature, inputTokens, outputTokens, audioSeconds, requestCount, values.model ? String(values.model).slice(0, 150) : null],
  );
}

export function readTokenUsage(payload: unknown) {
  if (!payload || typeof payload !== 'object') return { inputTokens: 0, outputTokens: 0 };
  const data = payload as { usage?: Record<string, unknown>; payload?: { usage?: Record<string, unknown> } };
  const usage = data.usage || data.payload?.usage || {};
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = Number(usage[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  };
  return {
    inputTokens: first('input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens'),
    outputTokens: first('output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens'),
  };
}
