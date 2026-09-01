import { hash } from 'bcryptjs';
import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (user.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(20, Math.max(5, Number(params.get('pageSize') || 10)));
    const offset = (page - 1) * pageSize;
    const users = await query("SELECT id, username, display_name AS displayName, role, status, created_at AS createdAt, DATE_FORMAT(last_login_at, '%Y-%m-%dT%H:%i:%s') AS lastLoginAt, last_seen_at >= DATE_SUB(NOW(), INTERVAL 45 SECOND) AS online FROM users WHERE status <> 'deleted' ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id LIMIT ? OFFSET ?", [pageSize, offset]);
    const countRows = await query("SELECT COUNT(*) AS total FROM users WHERE status <> 'deleted'");
    const onlineRows = await query("SELECT COUNT(*) AS total FROM users WHERE status = 'active' AND last_seen_at >= DATE_SUB(NOW(), INTERVAL 45 SECOND)");
    return Response.json({ users, total: Number((countRows[0] as { total: number }).total), onlineTotal: Number((onlineRows[0] as { total: number }).total), page, pageSize });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const current = await requireUser();
    if (current.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403 });
    const { username, password, displayName, role = 'student' } = await request.json();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username || '') || typeof password !== 'string' || password.length < 8 || !String(displayName || '').trim()) {
      return Response.json({ error: '账号需为 3–30 位字符，密码至少 8 位，并填写姓名' }, { status: 400 });
    }
    if (!['admin', 'student'].includes(role)) return Response.json({ error: '角色无效' }, { status: 400 });
    try {
      const result = await execute("INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, 'active')", [username, await hash(password, 12), displayName.trim(), role]);
      await execute('INSERT INTO user_settings (user_id) VALUES (?)', [result.insertId]);
      return Response.json({ ok: true }, { status: 201 });
    } catch (error) {
      if (String(error).includes('Duplicate entry')) return Response.json({ error: '账号已存在' }, { status: 409 });
      throw error;
    }
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    const current = await requireUser();
    if (current.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403 });
    let { userId, action } = await request.json();
    const requestedAction = action;
    if (action === 'disable' || action === 'enable') action = 'approve';
    if (!Number.isInteger(userId) || !['approve', 'reject'].includes(action)) return Response.json({ error: '审核参数无效' }, { status: 400 });
    if (requestedAction === 'disable' || requestedAction === 'enable') {
      if (userId === current.id) return Response.json({ error: '不能禁用当前登录账号' }, { status: 400 });
      const result = await execute("UPDATE users SET status = ? WHERE id = ? AND role = 'student' AND status IN ('active', 'disabled')", [requestedAction === 'disable' ? 'disabled' : 'active', userId]);
      if (!result.affectedRows) return Response.json({ error: '用户不存在或当前状态不可操作' }, { status: 404 });
      if (requestedAction === 'disable') await execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
      return Response.json({ ok: true });
    }
    const status = action === 'approve' ? 'active' : 'rejected';
    const result = await execute("UPDATE users SET status = ? WHERE id = ? AND role = 'student' AND status = 'pending'", [status, userId]);
    if (!result.affectedRows) return Response.json({ error: '申请不存在或已处理' }, { status: 404 });
    if (status === 'active') await execute('INSERT IGNORE INTO user_settings (user_id) VALUES (?)', [userId]);
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    const current = await requireUser();
    if (current.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403 });
    const { userId, deleteRecords = false } = await request.json();
    if (!Number.isInteger(userId) || userId === current.id) return Response.json({ error: '不能删除当前登录账号' }, { status: 400 });
    const rows = await query('SELECT role FROM users WHERE id = ?', [userId]);
    const target = rows[0] as { role: string } | undefined;
    if (!target) return Response.json({ error: '用户不存在' }, { status: 404 });
    if (target.role === 'admin') return Response.json({ error: '不能删除管理员账号' }, { status: 400 });
    if (deleteRecords) await execute('DELETE FROM users WHERE id = ?', [userId]);
    else await execute("UPDATE users SET status = 'deleted' WHERE id = ?", [userId]);
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
