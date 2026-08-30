import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(request: Request, context: { params: Promise<{ id: string; answerId: string }> }) {
  try {
    const user = await requireUser(); const params = await context.params; const sessionId = Number(params.id); const answerId = Number(params.answerId); const kind = new URL(request.url).searchParams.get('kind') === 'question' ? 'question' : 'answer';
    // Never select both BLOB columns. A review page can contain many answers,
    // and selecting the unused question audio roughly doubles database reads.
    const dataColumn = kind === 'question' ? 'question_audio_data' : 'audio_data';
    const mimeColumn = kind === 'question' ? 'question_audio_mime' : 'audio_mime';
    const rows = await query<RowDataPacket[]>(`SELECT a.${dataColumn} AS audioData, a.${mimeColumn} AS audioMime, s.user_id AS userId FROM simulation_answers a JOIN simulation_sessions s ON s.id=a.session_id WHERE a.id=? AND a.session_id=? LIMIT 1`, [answerId, sessionId]);
    const row = rows[0]; const audioData = row?.audioData; const audioMime = row?.audioMime;
    if (!row || (user.role !== 'admin' && Number(row.userId) !== user.id) || !audioData) return Response.json({ error: '音频不存在或无权访问' }, { status: 404 });
    return new Response(audioData as BodyInit, { headers: { 'Content-Type': String(audioMime || 'audio/mpeg'), 'Content-Length': String((audioData as Buffer).length), 'Cache-Control': 'private, max-age=3600' } });
  } catch (error) { return apiError(error); }
}
