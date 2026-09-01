import { apiError, requireUser } from '@/lib/auth';
import { execute } from '@/lib/db';

export async function POST() {
  try {
    const user = await requireUser();
    await execute('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
