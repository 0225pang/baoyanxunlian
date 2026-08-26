import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';

export async function GET() {
  try {
    const user = await requireUser();
    const rows = await query('SELECT auto_record AS autoRecord, avoid_repeated AS avoidRepeated, read_question AS readQuestion FROM user_settings WHERE user_id = ?', [user.id]);
    const row = rows[0] as { autoRecord: number; avoidRepeated: number; readQuestion: number } | undefined;
    return Response.json({
      settings: {
        autoRecord: Boolean(row?.autoRecord),
        avoidRepeated: Boolean(row?.avoidRepeated),
        readQuestion: Boolean(row?.readQuestion),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json() as { autoRecord?: boolean; avoidRepeated?: boolean; readQuestion?: boolean };
    const autoRecord = Boolean(body.autoRecord);
    const avoidRepeated = Boolean(body.avoidRepeated);
    const readQuestion = Boolean(body.readQuestion);

    await execute(
      'INSERT INTO user_settings (user_id, auto_record, avoid_repeated, read_question) VALUES (?, ?, ?, ?)' +
      ' ON DUPLICATE KEY UPDATE auto_record = VALUES(auto_record), avoid_repeated = VALUES(avoid_repeated), read_question = VALUES(read_question), updated_at = CURRENT_TIMESTAMP',
      [user.id, autoRecord ? 1 : 0, avoidRepeated ? 1 : 0, readQuestion ? 1 : 0],
    );
    return Response.json({ settings: { autoRecord, avoidRepeated, readQuestion } });
  } catch (error) {
    return apiError(error);
  }
}