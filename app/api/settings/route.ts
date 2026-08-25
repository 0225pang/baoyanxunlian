import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';

export async function GET() {
  try {
    const user = await requireUser();
    const rows = await query('SELECT auto_record AS autoRecord FROM user_settings WHERE user_id = ?', [user.id]);
    const row = rows[0] as { autoRecord: number } | undefined;
    return Response.json({ settings: { autoRecord: Boolean(row?.autoRecord) } });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const { autoRecord } = await request.json();
    await execute(`INSERT INTO user_settings (user_id, auto_record) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE auto_record = VALUES(auto_record), updated_at = CURRENT_TIMESTAMP`, [user.id, autoRecord ? 1 : 0]);
    return Response.json({ settings: { autoRecord: Boolean(autoRecord) } });
  } catch (error) { return apiError(error); }
}
