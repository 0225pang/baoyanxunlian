import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET() {
  try {
    const user = await requireUser();
    const where = user.role === 'admin' ? 'WHERE s.status = \'completed\'' : 'WHERE s.status = \'completed\' AND s.user_id = ?';
    const params = user.role === 'admin' ? [] : [user.id];
    const rows = await query<RowDataPacket[]>(`SELECT s.id, s.user_id AS userId, s.template_name AS templateName, s.status, s.total_seconds AS totalSeconds, s.elapsed_seconds AS elapsedSeconds, DATE_FORMAT(s.started_at, '%Y-%m-%dT%H:%i:%s') AS startedAt, DATE_FORMAT(s.completed_at, '%Y-%m-%dT%H:%i:%s') AS completedAt, u.username, u.display_name AS displayName, COUNT(a.id) AS answerCount FROM simulation_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN simulation_answers a ON a.session_id = s.id ${where} GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC`, params);
    return Response.json({ records: rows });
  } catch (error) { return apiError(error); }
}
