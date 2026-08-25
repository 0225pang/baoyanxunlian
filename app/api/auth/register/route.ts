import { hash } from 'bcryptjs';
import { execute } from '@/lib/db';

export async function POST(request: Request) {
  const { username, password, displayName } = await request.json();
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username || '') || typeof password !== 'string' || password.length < 8 || !String(displayName || '').trim()) {
    return Response.json({ error: '账号需为 3–30 位字母、数字、下划线或连字符，密码至少 8 位，并填写姓名' }, { status: 400 });
  }
  try {
    await execute("INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, 'student', 'pending')", [username, await hash(password, 12), displayName.trim()]);
    return Response.json({ message: '注册申请已提交，请等待管理员审核' }, { status: 201 });
  } catch (error) {
    if (String(error).includes('UNIQUE')) return Response.json({ error: '该账号已被使用' }, { status: 409 });
    console.error(error);
    return Response.json({ error: '注册失败，请稍后重试' }, { status: 500 });
  }
}
