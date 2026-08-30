import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const sessionId = Number((await context.params).id);
    const rows = await query<RowDataPacket[]>(`SELECT s.full_audio_data AS audioData, s.full_audio_mime AS audioMime, s.user_id AS userId
      FROM simulation_sessions s WHERE s.id = ? LIMIT 1`, [sessionId]);
    const row = rows[0];
    if (!row || (user.role !== 'admin' && Number(row.userId) !== user.id) || !row.audioData) {
      return Response.json({ error: '完整录音不存在或无权访问' }, { status: 404 });
    }
    const buffer = row.audioData as Buffer;
    const size = buffer.length;
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': String(row.audioMime || 'audio/webm'),
      'Cache-Control': 'private, max-age=3600',
    };
    const range = request.headers.get('range');
    if (!range) return new Response(buffer as unknown as BodyInit, { headers: { ...commonHeaders, 'Content-Length': String(size) } });

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) return new Response(null, { status: 416, headers: { ...commonHeaders, 'Content-Range': `bytes */${size}` } });
    let start: number;
    let end: number;
    if (!match[1] && match[2]) {
      start = Math.max(size - Number(match[2]), 0);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) return new Response(null, { status: 416, headers: { ...commonHeaders, 'Content-Range': `bytes */${size}` } });
    const chunk = buffer.subarray(start, end + 1);
    return new Response(chunk as unknown as BodyInit, { status: 206, headers: { ...commonHeaders, 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${start}-${end}/${size}` } });
  } catch (error) { return apiError(error); }
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
