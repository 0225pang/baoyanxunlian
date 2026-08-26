import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const sessionId = Number((await context.params).id);
    const rows = await query<RowDataPacket[]>(`SELECT s.full_audio_data AS audioData, s.full_audio_mime AS audioMime, s.user_id AS userId
      FROM simulation_sessions s WHERE s.id = ? LIMIT 1`, [sessionId]);
    const row = rows[0];
    if (!row || (user.role !== 'admin' && Number(row.userId) !== user.id) || !row.audioData) {
      return Response.json({ error: '完整录音不存在或无权访问' }, { status: 404 });
    }
    return new Response(row.audioData as BodyInit, {
      headers: {
        'Content-Type': String(row.audioMime || 'audio/webm'),
        'Content-Length': String((row.audioData as Buffer).length),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) { return apiError(error); }
}
