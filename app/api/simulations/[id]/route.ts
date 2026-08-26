import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id: rawId } = await context.params; const sessionId = Number(rawId);
    const form = await request.formData(); const answersRaw = String(form.get('answers') || '[]'); const elapsedSeconds = Math.max(0, Number(form.get('elapsedSeconds')) || 0);
    const sessions = await query<RowDataPacket[]>('SELECT user_id AS userId FROM simulation_sessions WHERE id = ? LIMIT 1', [sessionId]);
    if (!sessions[0] || (Number(sessions[0].userId) !== user.id && user.role !== 'admin')) return Response.json({ error: '模拟场次不存在或无权保存' }, { status: 404 });
    const answers = JSON.parse(answersRaw) as Array<{ moduleIndex: number; moduleTitle: string; questionId?: number; question: string; answer?: string; transcript?: string; transcriptSegments?: unknown; elapsedSeconds?: number; followupQuestion?: string }>;
    for (let index = 0; index < answers.length; index += 1) {
      const answer = answers[index]; const audio = form.get('audio-' + index);
      const audioData = audio instanceof File && audio.size > 0 ? Buffer.from(await audio.arrayBuffer()) : null;
      const audioMime = audio instanceof File && audio.size > 0 ? audio.type || 'audio/webm' : null;
      await execute('INSERT INTO simulation_answers (session_id, module_index, module_title, question_id, question, answer, transcript, transcript_segments, audio_data, audio_mime, elapsed_seconds, followup_question) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [sessionId, Number(answer.moduleIndex), String(answer.moduleTitle), Number(answer.questionId) || null, String(answer.question), String(answer.answer || '').trim() || null, String(answer.transcript || '').trim() || null, answer.transcriptSegments ? JSON.stringify(answer.transcriptSegments) : null, audioData, audioMime, Math.max(0, Number(answer.elapsedSeconds) || 0), String(answer.followupQuestion || '').trim() || null]);
    }
    const audio = form.get('fullAudio'); let audioData: Buffer | null = null; let audioMime: string | null = null;
    if (audio instanceof File && audio.size > 0) { if (audio.size > 100 * 1024 * 1024) return Response.json({ error: '全程录音不能超过 100MB' }, { status: 400 }); audioData = Buffer.from(await audio.arrayBuffer()); audioMime = audio.type || 'audio/webm'; }
    const transcript = String(form.get('transcript') || '').trim() || null;
    await execute('UPDATE simulation_sessions SET status = ?, elapsed_seconds = ?, full_audio_data = ?, full_audio_mime = ?, transcript = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', ['completed', elapsedSeconds, audioData, audioMime, transcript, sessionId]);
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
