import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { createUserNotification } from '@/lib/notifications';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET() {
  try {
    const user = await requireUser();
    const notifications = await query<RowDataPacket[]>(`SELECT id, kind, title, content, is_read AS isRead,
      DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt
      FROM user_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 80`, [user.id]);
    const unreadRows = await query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM user_notifications WHERE user_id = ? AND is_read = 0', [user.id]);
    return Response.json({ notifications: notifications.map((item) => ({ ...item, id: Number(item.id), isRead: Boolean(item.isRead) })), unreadCount: Number(unreadRows[0]?.total || 0) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json() as { kind?: string; title?: string; content?: string };
    const title = String(body.title || '').trim();
    if (!title) return Response.json({ error: '通知标题不能为空' }, { status: 400 });
    const kind = ['success', 'error', 'warning', 'info'].includes(String(body.kind)) ? String(body.kind) : 'info';
    await createUserNotification(user.id, title, String(body.content || '').trim(), kind as 'success' | 'error' | 'warning' | 'info');
    const rows = await query<RowDataPacket[]>(`SELECT id, kind, title, content, is_read AS isRead,
      DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt FROM user_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [user.id]);
    const notification = rows[0];
    return Response.json({ notification: notification ? { ...notification, id: Number(notification.id), isRead: Boolean(notification.isRead) } : null }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(); const body = await request.json() as { id?: number; all?: boolean };
    if (body.all) await execute('UPDATE user_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 0', [user.id]);
    else if (Number.isInteger(Number(body.id)) && Number(body.id) > 0) await execute('UPDATE user_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [Number(body.id), user.id]);
    else return Response.json({ error: '通知参数无效' }, { status: 400 });
    return GET();
  } catch (error) { return apiError(error); }
}
