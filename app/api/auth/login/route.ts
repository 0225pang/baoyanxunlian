import { compare } from 'bcryptjs';
import { createSession } from '@/lib/auth';
import { query } from '@/lib/db';

export async function POST(request: Request) {
  const { username, password } = await request.json();
  if (typeof username !== 'string' || typeof password !== 'string') return Response.json({ error: '请输入账号和密码' }, { status: 400 });
  const rows = await query('SELECT id, username, password_hash, display_name AS displayName, role, status FROM users WHERE username = ?', [username.trim()]);
  const user = rows[0] as { id: number; username: string; password_hash: string; displayName: string; role: string; status: string } | undefined;
  if (!user || !(await compare(password, user.password_hash))) return Response.json({ error: '账号或密码错误' }, { status: 401 });
  if (user.status !== 'active') {
    const error = user.status === 'pending' ? '注册申请正在等待管理员审核' : user.status === 'rejected' ? '注册申请未通过，请联系管理员' : '该账号已被删除';
    return Response.json({ error }, { status: 403 });
  }
  await createSession(user.id);
  return Response.json({ user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
}
