import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await context.params;
    const rows = await query('SELECT answer FROM questions WHERE id = ? AND status = \'active\' LIMIT 1', [Number(id)]);
    const answer = rows[0] as { answer?: string | null } | undefined;
    return Response.json({ answer: answer?.answer || null });
  } catch (error) { return apiError(error); }
}
