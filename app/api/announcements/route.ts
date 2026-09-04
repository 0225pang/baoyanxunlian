import { apiError, requireUser } from '@/lib/auth';
import { execute } from '@/lib/db';

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

    // One INSERT…SELECT keeps this publication a single database write even
    // when it needs to reach many active users.
    const result = await execute(
      `INSERT INTO user_notifications (user_id, kind, title, content)
       SELECT id, 'announcement', ?, ? FROM users
       WHERE status = 'active' AND role <> 'admin'`,
      [title, content],
    );
    return Response.json({ delivered: Number(result.affectedRows || 0) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
