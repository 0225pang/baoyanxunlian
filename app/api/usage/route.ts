import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

type UserRow = RowDataPacket & {
  id: number; username: string; displayName: string;
  aiEnabled: number; asrEnabled: number; realtimeAsrEnabled: number;
  aiTokenLimit: number; asrRequestLimit: number; realtimeSecondsLimit: number;
};

async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
}

export async function GET() {
  try {
    await requireAdmin();
    await execute('INSERT IGNORE INTO user_api_limits (user_id) SELECT id FROM users');
    const users = await query<UserRow[]>(`SELECT u.id, u.username, u.display_name AS displayName,
      l.ai_enabled AS aiEnabled, l.asr_enabled AS asrEnabled, l.realtime_asr_enabled AS realtimeAsrEnabled,
      l.ai_token_limit AS aiTokenLimit, l.asr_request_limit AS asrRequestLimit, l.realtime_seconds_limit AS realtimeSecondsLimit
      FROM users u JOIN user_api_limits l ON l.user_id = u.id
      WHERE u.status != 'deleted' ORDER BY u.role DESC, u.id ASC`);
    const usageRows = await query<RowDataPacket[]>(`SELECT user_id AS userId, feature,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(audio_seconds), 0) AS audioSeconds, COALESCE(SUM(request_count), 0) AS requestCount
      FROM api_usage_logs WHERE created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')
      GROUP BY user_id, feature`);
    const usage = new Map<number, Record<string, { inputTokens: number; outputTokens: number; audioSeconds: number; requestCount: number }>>();
    for (const row of usageRows) {
      const userId = Number(row.userId); const byFeature = usage.get(userId) || {};
      byFeature[String(row.feature)] = { inputTokens: Number(row.inputTokens || 0), outputTokens: Number(row.outputTokens || 0), audioSeconds: Number(row.audioSeconds || 0), requestCount: Number(row.requestCount || 0) };
      usage.set(userId, byFeature);
    }
    const totals = usageRows.reduce((value, row) => ({
      aiTokens: value.aiTokens + Number(row.inputTokens || 0) + Number(row.outputTokens || 0),
      asrRequests: value.asrRequests + (String(row.feature) === 'asr' ? Number(row.requestCount || 0) : 0),
      realtimeSeconds: value.realtimeSeconds + (String(row.feature) === 'realtime_asr' ? Number(row.audioSeconds || 0) : 0),
    }), { aiTokens: 0, asrRequests: 0, realtimeSeconds: 0 });
    return Response.json({ month: new Date().toISOString().slice(0, 7), totals, users: users.map((user) => ({ ...user, usage: usage.get(Number(user.id)) || {} })) });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { userId?: number; aiEnabled?: boolean; asrEnabled?: boolean; realtimeAsrEnabled?: boolean; aiTokenLimit?: number; asrRequestLimit?: number; realtimeSecondsLimit?: number };
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) return Response.json({ error: '用户编号无效' }, { status: 400 });
    const exists = await query<RowDataPacket[]>('SELECT id FROM users WHERE id = ? AND status != ? LIMIT 1', [userId, 'deleted']);
    if (!exists[0]) return Response.json({ error: '用户不存在' }, { status: 404 });
    const safeNumber = (value: unknown) => Math.min(10_000_000_000, Math.max(0, Math.floor(Number(value) || 0)));
    await execute(`INSERT INTO user_api_limits (user_id, ai_enabled, asr_enabled, realtime_asr_enabled, ai_token_limit, asr_request_limit, realtime_seconds_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE ai_enabled = VALUES(ai_enabled), asr_enabled = VALUES(asr_enabled), realtime_asr_enabled = VALUES(realtime_asr_enabled), ai_token_limit = VALUES(ai_token_limit), asr_request_limit = VALUES(asr_request_limit), realtime_seconds_limit = VALUES(realtime_seconds_limit)`, [
      userId, body.aiEnabled === false ? 0 : 1, body.asrEnabled === false ? 0 : 1, body.realtimeAsrEnabled === false ? 0 : 1,
      safeNumber(body.aiTokenLimit), safeNumber(body.asrRequestLimit), safeNumber(body.realtimeSecondsLimit),
    ]);
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}