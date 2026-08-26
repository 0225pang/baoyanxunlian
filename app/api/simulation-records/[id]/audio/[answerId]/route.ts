import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(request: Request, context: { params: Promise<{ id: string; answerId: string }> }) {
  try {
    const user = await requireUser(); const params = await context.params; const sessionId = Number(params.id); const answerId = Number(params.answerId);
    const rows = await query<RowDataPacket[]>(`SELECT a.audio_data AS audioData, a.audio_mime AS audioMime, s.user_id AS userId FROM simulation_answers a JOIN simulation_sessions s ON s.id = a.session_id WHERE a.id = ? AND a.session_id = ? LIMIT 1`, [answerId, sessionId]);
    const row = rows[0]; if (!row || (user.role !== 'admin' && Number(row.userId) !== user.id) || !row.audioData) return Response.json({ error: '录音不存在或无权访问' }, { status: 404 });
    return new Response(row.audioData as BodyInit, { headers: { 'Content-Type': String(row.audioMime || 'audio/webm'), 'Content-Length': String((row.audioData as Buffer).length), 'Cache-Control': 'private, max-age=3600' } });
  } catch (error) { return apiError(error); }
}
