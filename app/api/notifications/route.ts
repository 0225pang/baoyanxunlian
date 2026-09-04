import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { createUserNotification } from '@/lib/notifications';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const search = new URL(request.url).searchParams;
    const page = Math.max(1, Math.floor(Number(search.get('page')) || 1));
    const pageSize = Math.min(30, Math.max(6, Math.floor(Number(search.get('pageSize')) || 12)));
    const totalRows = await query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM user_notifications WHERE user_id = ?', [user.id]);
    const total = Number(totalRows[0]?.total || 0);
    const resolvedPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const offset = (resolvedPage - 1) * pageSize;
    const notifications = await query<RowDataPacket[]>(`SELECT n.id, n.kind, n.title, n.content, n.is_read AS isRead,
      n.announcement_id AS announcementId, COALESCE(a.force_popup, 0) AS forcePopup,
      DATE_FORMAT(n.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt
      FROM user_notifications n LEFT JOIN announcements a ON a.id = n.announcement_id
      WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ? OFFSET ?`, [user.id, pageSize, offset]);
    const unreadRows = await query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM user_notifications WHERE user_id = ? AND is_read = 0', [user.id]);
    const pendingRows = await query<RowDataPacket[]>(`SELECT n.id, n.kind, n.title, n.content, n.is_read AS isRead, n.announcement_id AS announcementId, 1 AS forcePopup, DATE_FORMAT(n.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt FROM user_notifications n JOIN announcements a ON a.id = n.announcement_id WHERE n.user_id = ? AND n.kind = 'announcement' AND n.is_read = 0 AND a.force_popup = 1 ORDER BY n.id DESC LIMIT 1`, [user.id]);
    const map = (item: RowDataPacket) => ({ ...item, id: Number(item.id), announcementId: item.announcementId ? Number(item.announcementId) : null, forcePopup: Boolean(item.forcePopup), isRead: Boolean(item.isRead) });
    return Response.json({ notifications: notifications.map(map), pendingAnnouncement: pendingRows[0] ? map(pendingRows[0]) : null, unreadCount: Number(unreadRows[0]?.total || 0), total, page: resolvedPage, pageSize });
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
    const user = await requireUser(); const body = await request.json() as { id?: number; all?: boolean; excludeAnnouncements?: boolean };
    if (body.all) await execute(`UPDATE user_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 0${body.excludeAnnouncements ? " AND kind <> 'announcement'" : ''}`, [user.id]);
    else if (Number.isInteger(Number(body.id)) && Number(body.id) > 0) await execute('UPDATE user_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [Number(body.id), user.id]);
    else return Response.json({ error: '通知参数无效' }, { status: 400 });
    return GET(request);
  } catch (error) { return apiError(error); }
}
