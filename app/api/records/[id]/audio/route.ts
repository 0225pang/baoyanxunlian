import { apiError, requireUser } from '@/lib/auth';
import { AudioBlobReadBusyError, withAudioBlobRead } from '@/lib/audio-blob-queue';
import { query } from '@/lib/db';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const rows = await withAudioBlobRead(() => query('SELECT user_id, audio_data, audio_mime FROM practice_records WHERE id = ?', [Number(id)]));
    const row = rows[0] as { user_id: number; audio_data: Buffer | null; audio_mime: string | null } | undefined;
    if (!row?.audio_data || (row.user_id !== user.id && user.role !== 'admin')) return new Response('Not found', { status: 404 });

    const buffer = row.audio_data;
    const size = buffer.length;
    const commonHeaders = { 'Accept-Ranges': 'bytes', 'Content-Type': row.audio_mime || 'audio/webm', 'Cache-Control': 'private, max-age=3600' };
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
  } catch (error) {
    if (error instanceof AudioBlobReadBusyError) return Response.json({ error: error.message }, { status: 503, headers: { 'Retry-After': '3' } });
    return apiError(error);
  }
}


export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
