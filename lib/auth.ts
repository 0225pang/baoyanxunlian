import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'node:crypto';
import { execute, query } from './db';
import type { RowDataPacket } from 'mysql2/promise';

export type CurrentUser = { id: number; username: string; displayName: string; role: 'admin' | 'student' };
const COOKIE_NAME = 'yanlu_session';

function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }

export async function currentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  const rows = await query<RowDataPacket[]>(`SELECT u.id, u.username, u.display_name AS displayName, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > NOW()`, [digest(token)]);
  return (rows[0] as unknown as CurrentUser) || null;
}

export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new Error('UNAUTHORIZED');
  return user;
}

export async function createSession(userId: number) {
  const token = randomBytes(32).toString('base64url');
  await execute('DELETE FROM sessions WHERE expires_at <= NOW()');
  await execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))', [digest(token), userId]);
  const secure = process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production';
  (await cookies()).set(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 7 });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) await execute('DELETE FROM sessions WHERE token_hash = ?', [digest(token)]);
  jar.delete(COOKIE_NAME);
}

export function apiError(error: unknown) {
  if (error instanceof Error && error.message === 'UNAUTHORIZED') return Response.json({ error: '请先登录' }, { status: 401 });
  if (error instanceof Error && error.message === 'FORBIDDEN') return Response.json({ error: '无权访问' }, { status: 403 });
  if (error instanceof Error && error.message.startsWith('API_DISABLED:')) return Response.json({ error: error.message.slice('API_DISABLED:'.length) }, { status: 403 });
  if (error instanceof Error && error.message.startsWith('API_LIMIT:')) return Response.json({ error: error.message.slice('API_LIMIT:'.length) }, { status: 429 });
  console.error(error);
  return Response.json({ error: '服务器处理失败' }, { status: 500 });
}
