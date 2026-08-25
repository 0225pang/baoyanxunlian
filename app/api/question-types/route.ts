import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';

export async function GET() {
  try {
    await requireUser();
    const types = await query(`SELECT id, code, name, description, settings, sort_order AS sortOrder
      FROM question_types WHERE is_active = 1 ORDER BY sort_order, id`);
    return Response.json({ types });
  } catch (error) {
    return apiError(error);
  }
}
