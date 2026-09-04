import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (user.role !== 'admin') throw new Error('FORBIDDEN');
    const id = Number(new URL(request.url).searchParams.get('id'));
    if (Number.isInteger(id) && id > 0) {
      const recipients = await query<RowDataPacket[]>(
        `SELECT n.user_id AS userId, u.username, u.display_name AS displayName,
                n.is_read AS isRead, DATE_FORMAT(n.read_at, '%Y-%m-%dT%H:%i:%s') AS readAt
           FROM user_notifications n
           LEFT JOIN users u ON u.id = n.user_id
          WHERE n.announcement_id = ?
          ORDER BY n.is_read ASC, u.display_name ASC, n.id ASC`,
        [id],
      );
      return Response.json({ recipients: recipients.map((item) => ({ ...item, userId: Number(item.userId), isRead: Boolean(item.isRead) })) });
    }
    const announcements = await query<RowDataPacket[]>(
      `SELECT a.id, a.title, a.content, DATE_FORMAT(a.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt,
              COUNT(n.id) AS recipientCount,
              COALESCE(SUM(n.is_read = 1), 0) AS readCount
         FROM announcements a
         LEFT JOIN user_notifications n ON n.announcement_id = a.id
        GROUP BY a.id
        ORDER BY a.id DESC
        LIMIT 50`,
    );
    return Response.json({ announcements: announcements.map((item) => ({ ...item, id: Number(item.id), recipientCount: Number(item.recipientCount || 0), readCount: Number(item.readCount || 0), unreadCount: Math.max(0, Number(item.recipientCount || 0) - Number(item.readCount || 0)) })) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (user.role !== 'admin') throw new Error('FORBIDDEN');
    const body = await request.json() as { title?: string; content?: string };
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    if (!title) return Response.json({ error: '公告标题不能为空' }, { status: 400 });
    if (!content) return Response.json({ error: '公告内容不能为空' }, { status: 400 });
    if (title.length > 180 || content.length > 5000) {
      return Response.json({ error: '公告标题或内容过长' }, { status: 400 });
    }

    const announcement = await execute(
      'INSERT INTO announcements (title, content, created_by) VALUES (?, ?, ?)',
      [title, content, user.id],
    );
    // One INSERT…SELECT keeps recipient delivery a single database write even
    // when it needs to reach many active users.
    const result = await execute(
      `INSERT INTO user_notifications (user_id, announcement_id, kind, title, content)
       SELECT id, ?, 'announcement', ?, ? FROM users
       WHERE status = 'active' AND role <> 'admin'`,
      [announcement.insertId, title, content],
    );
    return Response.json({ id: Number(announcement.insertId), delivered: Number(result.affectedRows || 0) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
