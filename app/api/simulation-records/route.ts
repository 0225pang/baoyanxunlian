import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

function beijingDayBounds(now = new Date()) {
  const fields = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => fields.find((item) => item.type === type)?.value || '';
  const year = Number(value('year')); const month = Number(value('month')); const day = Number(value('day'));
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  return { start: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 00:00:00`, end: `${nextDate} 00:00:00` };
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const search = new URL(request.url).searchParams;
    const page = Math.max(1, Math.floor(Number(search.get('page')) || 1));
    const pageSize = Math.min(30, Math.max(6, Math.floor(Number(search.get('pageSize')) || 12)));
    const templateName = String(search.get('template') || '').trim();
    const conditions = ["s.status = 'completed'"];
    const params: unknown[] = [];
    if (user.role !== 'admin') { conditions.push('s.user_id = ?'); params.push(user.id); }
    if (templateName) { conditions.push('s.template_name = ?'); params.push(templateName); }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const totalRows = await query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM simulation_sessions s ${where}`, params);
    const total = Number(totalRows[0]?.total || 0);
    const resolvedPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const offset = (resolvedPage - 1) * pageSize;
    const rows = await query<RowDataPacket[]>(`SELECT s.id, s.user_id AS userId, s.template_name AS templateName, s.status, s.total_seconds AS totalSeconds, s.elapsed_seconds AS elapsedSeconds, DATE_FORMAT(s.started_at, '%Y-%m-%dT%H:%i:%s') AS startedAt, DATE_FORMAT(s.completed_at, '%Y-%m-%dT%H:%i:%s') AS completedAt, u.username, u.display_name AS displayName, COUNT(a.id) AS answerCount FROM simulation_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN simulation_answers a ON a.session_id = s.id ${where} GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    const templateRows = await query<RowDataPacket[]>(`SELECT DISTINCT s.template_name AS templateName FROM simulation_sessions s ${user.role === 'admin' ? "WHERE s.status = 'completed'" : "WHERE s.status = 'completed' AND s.user_id = ?"} ORDER BY s.template_name ASC`, user.role === 'admin' ? [] : [user.id]);
    const day = beijingDayBounds();
    const statsRows = await query<RowDataPacket[]>(`SELECT COUNT(*) AS totalSimulations, COALESCE(SUM(s.started_at >= ? AND s.started_at < ?), 0) AS todaySimulations FROM simulation_sessions s WHERE s.status = 'completed'${user.role === 'admin' ? '' : ' AND s.user_id = ?'}`, user.role === 'admin' ? [day.start, day.end] : [day.start, day.end, user.id]);
    const stats = statsRows[0] || {};
    return Response.json({ records: rows, total, page: resolvedPage, pageSize, templates: templateRows.map((item) => String(item.templateName || '')).filter(Boolean), stats: { totalSimulations: Number(stats.totalSimulations || 0), todaySimulations: Number(stats.todaySimulations || 0) } });
  } catch (error) { return apiError(error); }
}
