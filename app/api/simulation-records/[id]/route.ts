import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const id = Number((await context.params).id);
    const sessions = await query<RowDataPacket[]>(`SELECT s.id, s.user_id AS userId, s.template_name AS templateName, s.status, s.total_seconds AS totalSeconds, s.elapsed_seconds AS elapsedSeconds, DATE_FORMAT(s.started_at, '%Y-%m-%dT%H:%i:%s') AS startedAt, DATE_FORMAT(s.completed_at, '%Y-%m-%dT%H:%i:%s') AS completedAt, s.full_audio_data IS NOT NULL AS hasFullAudio, s.full_audio_mime AS fullAudioMime, u.username, u.display_name AS displayName FROM simulation_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? LIMIT 1`, [id]);
    const session = sessions[0]; if (!session || (user.role !== 'admin' && Number(session.userId) !== user.id)) return Response.json({ error: '记录不存在或无权访问' }, { status: 404 });
    const answers = await query<RowDataPacket[]>(`SELECT id, module_index AS moduleIndex, module_title AS moduleTitle, question_id AS questionId, question, answer, transcript, transcript_segments AS transcriptSegments, elapsed_seconds AS elapsedSeconds, followup_question AS followupQuestion, audio_data IS NOT NULL AS hasAudio, audio_mime AS audioMime, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt FROM simulation_answers WHERE session_id = ? ORDER BY module_index ASC, id ASC`, [id]);
    return Response.json({ session, answers });
  } catch (error) { return apiError(error); }
}
