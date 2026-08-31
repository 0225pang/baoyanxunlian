import { apiError, requireUser } from '@/lib/auth';
import { AudioBlobReadBusyError, withAudioBlobRead } from '@/lib/audio-blob-queue';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(request: Request, context: { params: Promise<{ id: string; answerId: string }> }) {
  try {
    const user = await requireUser(); const params = await context.params; const sessionId = Number(params.id); const answerId = Number(params.answerId); const kind = new URL(request.url).searchParams.get('kind') === 'question' ? 'question' : 'answer';
    // Never select both BLOB columns. A review page can contain many answers,
    // and selecting the unused question audio roughly doubles database reads.
    const dataColumn = kind === 'question' ? 'question_audio_data' : 'audio_data';
    const mimeColumn = kind === 'question' ? 'question_audio_mime' : 'audio_mime';
    const rows = await withAudioBlobRead(() => query<RowDataPacket[]>(`SELECT a.${dataColumn} AS audioData, a.${mimeColumn} AS audioMime, s.user_id AS userId FROM simulation_answers a JOIN simulation_sessions s ON s.id=a.session_id WHERE a.id=? AND a.session_id=? LIMIT 1`, [answerId, sessionId]));
    const row = rows[0]; const audioData = row?.audioData; const audioMime = row?.audioMime;
    if (!row || (user.role !== 'admin' && Number(row.userId) !== user.id) || !audioData) return Response.json({ error: '音频不存在或无权访问' }, { status: 404 });
    const buffer = audioData as Buffer;
    const size = buffer.length;
    const commonHeaders = { 'Accept-Ranges': 'bytes', 'Content-Type': String(audioMime || 'audio/mpeg'), 'Cache-Control': 'private, max-age=3600' };
    const range = request.headers.get('range');
    if (!range) return new Response(buffer as unknown as BodyInit, { headers: { ...commonHeaders, 'Content-Length': String(size) } });
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) return new Response(null, { status: 416, headers: { ...commonHeaders, 'Content-Range': `bytes */${size}` } });
    let start: number;
    let end: number;
    if (!match[1] && match[2]) { start = Math.max(size - Number(match[2]), 0); end = size - 1; }
    else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) return new Response(null, { status: 416, headers: { ...commonHeaders, 'Content-Range': `bytes */${size}` } });
    const chunk = buffer.subarray(start, end + 1);
    return new Response(chunk as unknown as BodyInit, { status: 206, headers: { ...commonHeaders, 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${start}-${end}/${size}` } });
  } catch (error) {
    if (error instanceof AudioBlobReadBusyError) return Response.json({ error: error.message }, { status: 503, headers: { 'Retry-After': '3' } });
    return apiError(error);
  }
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string; answerId: string }> }) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
