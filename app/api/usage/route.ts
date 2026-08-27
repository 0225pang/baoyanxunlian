import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

type UserRow = RowDataPacket & {
  id: number; username: string; displayName: string;
  aiEnabled: number; asrEnabled: number; realtimeAsrEnabled: number;
  aiTokenLimit: number; asrRequestLimit: number; realtimeSecondsLimit: number;
};
type UsageRow = RowDataPacket & {
  userId: number; feature: string; inputTokens: number; outputTokens: number; audioSeconds: number; requestCount: number;
};

async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
}

function toNumber(value: unknown) { return Number(value || 0); }
function periodWhere(period: string) {
  if (period === '24h') return { condition: 'created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)', period: '24h' as const };
  if (period === 'all') return { condition: '1 = 1', period: 'all' as const };
  return { condition: 'created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 6 DAY)', period: '7d' as const };
}
function qualifiedPeriodWhere(period: string, tableAlias: string) {
  return periodWhere(period).condition.replaceAll('created_at', `${tableAlias}.created_at`);
}
function usageMap(rows: UsageRow[]) {
  const map = new Map<number, Record<string, { inputTokens: number; outputTokens: number; audioSeconds: number; requestCount: number }>>();
  for (const row of rows) {
    const current = map.get(toNumber(row.userId)) || {};
    current[String(row.feature)] = {
      inputTokens: toNumber(row.inputTokens), outputTokens: toNumber(row.outputTokens),
      audioSeconds: toNumber(row.audioSeconds), requestCount: toNumber(row.requestCount),
    };
    map.set(toNumber(row.userId), current);
  }
  return map;
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    await execute('INSERT IGNORE INTO user_api_limits (user_id) SELECT id FROM users');
    const search = new URL(request.url).searchParams;
    const requestedUserId = search.get('userId') || 'all';
    const selectedUserId = requestedUserId === 'all' ? null : Number(requestedUserId);
    if (selectedUserId !== null && (!Number.isInteger(selectedUserId) || selectedUserId <= 0)) return Response.json({ error: '用户筛选无效' }, { status: 400 });
    const range = periodWhere(search.get('period') || '7d');
    const users = await query<UserRow[]>(`SELECT u.id, u.username, u.display_name AS displayName,
      l.ai_enabled AS aiEnabled, l.asr_enabled AS asrEnabled, l.realtime_asr_enabled AS realtimeAsrEnabled,
      l.ai_token_limit AS aiTokenLimit, l.asr_request_limit AS asrRequestLimit, l.realtime_seconds_limit AS realtimeSecondsLimit
      FROM users u JOIN user_api_limits l ON l.user_id = u.id
      WHERE u.status != 'deleted' ORDER BY u.role DESC, u.id ASC`);
    if (selectedUserId !== null && !users.some((user) => toNumber(user.id) === selectedUserId)) return Response.json({ error: '用户不存在' }, { status: 404 });

    const filter = selectedUserId === null ? '' : ' AND l.user_id = ?';
    const filterParams = selectedUserId === null ? [] : [selectedUserId];
    const logPeriodWhere = qualifiedPeriodWhere(range.period, 'l');
    const scopedRows = await query<UsageRow[]>(`SELECT user_id AS userId, feature,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(audio_seconds), 0) AS audioSeconds, COALESCE(SUM(request_count), 0) AS requestCount
      FROM api_usage_logs l WHERE ${logPeriodWhere}${filter} GROUP BY l.user_id, l.feature`, filterParams);
    const scopedUsage = usageMap(scopedRows);
    const totals = scopedRows.reduce((value, row) => ({
      aiTokens: value.aiTokens + (String(row.feature) === 'ai' ? toNumber(row.inputTokens) + toNumber(row.outputTokens) : 0),
      asrRequests: value.asrRequests + (String(row.feature) === 'asr' ? toNumber(row.requestCount) : 0),
      realtimeSeconds: value.realtimeSeconds + (String(row.feature) === 'realtime_asr' ? toNumber(row.audioSeconds) : 0),
    }), { aiTokens: 0, asrRequests: 0, realtimeSeconds: 0 });

    const bucket = range.period === '24h' ? "DATE_FORMAT(l.created_at, '%m-%d %H:00')" : range.period === 'all' ? "DATE_FORMAT(l.created_at, '%Y-%m')" : "DATE_FORMAT(l.created_at, '%Y-%m-%d')";
    const dailyRows = await query<RowDataPacket[]>(`SELECT ${bucket} AS bucket, feature,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(request_count), 0) AS requests,
      COALESCE(SUM(audio_seconds), 0) AS seconds FROM api_usage_logs
      WHERE ${logPeriodWhere}${filter} GROUP BY bucket, l.feature ORDER BY bucket ASC`, filterParams);
    const dailyByBucket = new Map<string, Record<string, { tokens: number; requests: number; seconds: number }>>();
    for (const row of dailyRows) {
      const bucketKey = String(row.bucket); const entry = dailyByBucket.get(bucketKey) || {};
      entry[String(row.feature)] = { tokens: toNumber(row.tokens), requests: toNumber(row.requests), seconds: toNumber(row.seconds) };
      dailyByBucket.set(bucketKey, entry);
    }
    const labels = range.period === 'all'
      ? [...dailyByBucket.keys()]
      : Array.from({ length: range.period === '24h' ? 24 : 7 }, (_value, index) => {
        const date = new Date();
        if (range.period === '24h') { date.setHours(date.getHours() - (23 - index), 0, 0, 0); return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`; }
        date.setDate(date.getDate() - (6 - index)); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      });
    const daily = labels.map((label) => {
      const item = dailyByBucket.get(label) || {};
      return { label: range.period === '7d' ? label.slice(5).replace('-', '/') : label, aiTokens: toNumber(item.ai?.tokens), asrRequests: toNumber(item.asr?.requests), realtimeSeconds: toNumber(item.realtime_asr?.seconds) };
    });

    const modelRows = await query<RowDataPacket[]>(`SELECT COALESCE(NULLIF(model, ''), '未标注模型') AS model,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(request_count), 0) AS requests
      FROM api_usage_logs l WHERE l.feature = 'ai' AND ${logPeriodWhere}${filter}
      GROUP BY model ORDER BY tokens DESC LIMIT 12`, filterParams);
    const modelSeries = modelRows.map((row) => ({ model: String(row.model), tokens: toNumber(row.tokens), requests: toNumber(row.requests) }));

    const leaderboardRows = await query<RowDataPacket[]>(`SELECT u.id AS userId, u.username, u.display_name AS displayName,
      COALESCE(SUM(CASE WHEN l.feature = 'ai' THEN l.input_tokens + l.output_tokens ELSE 0 END), 0) AS aiTokens,
      COALESCE(SUM(CASE WHEN l.feature = 'asr' THEN l.request_count ELSE 0 END), 0) AS asrRequests,
      COALESCE(SUM(CASE WHEN l.feature = 'realtime_asr' THEN l.audio_seconds ELSE 0 END), 0) AS realtimeSeconds,
      COALESCE(SUM(l.request_count), 0) AS totalRequests
      FROM users u LEFT JOIN api_usage_logs l ON l.user_id = u.id AND ${logPeriodWhere}
      WHERE u.status != 'deleted' GROUP BY u.id, u.username, u.display_name
      ORDER BY aiTokens DESC, totalRequests DESC, u.id ASC LIMIT 20`);
    const leaderboard = leaderboardRows.map((row, index) => ({ rank: index + 1, userId: toNumber(row.userId), username: String(row.username), displayName: String(row.displayName), aiTokens: toNumber(row.aiTokens), asrRequests: toNumber(row.asrRequests), realtimeSeconds: toNumber(row.realtimeSeconds), totalRequests: toNumber(row.totalRequests) }));

    const monthlyRows = selectedUserId === null ? [] : await query<UsageRow[]>(`SELECT user_id AS userId, feature,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(audio_seconds), 0) AS audioSeconds, COALESCE(SUM(request_count), 0) AS requestCount
      FROM api_usage_logs l WHERE l.user_id = ? AND l.created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') GROUP BY l.user_id, l.feature`, [selectedUserId]);
    const selected = selectedUserId === null ? null : users.find((item) => toNumber(item.id) === selectedUserId) || null;
    const monthlyUsage = usageMap(monthlyRows).get(selectedUserId || 0) || {};
    return Response.json({
      scope: { userId: selectedUserId === null ? 'all' : selectedUserId, period: range.period }, totals, daily, modelSeries, leaderboard,
      users: users.map((user) => ({ id: toNumber(user.id), username: user.username, displayName: user.displayName })),
      selectedUser: selected ? { ...selected, id: toNumber(selected.id), aiEnabled: Boolean(selected.aiEnabled), asrEnabled: Boolean(selected.asrEnabled), realtimeAsrEnabled: Boolean(selected.realtimeAsrEnabled), usage: monthlyUsage } : null,
      selectedScopeUsage: selectedUserId === null ? null : scopedUsage.get(selectedUserId) || {},
    });
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
