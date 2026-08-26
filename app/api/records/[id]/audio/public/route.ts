import { query } from '@/lib/db';
import { getAsrConfig, verifyAudioToken } from '@/lib/asr';
import type { RowDataPacket } from 'mysql2/promise';

export const runtime = 'nodejs';

type AudioRow = RowDataPacket & {
  audio_data: Buffer | null;
  audio_mime: string | null;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    const token = new URL(request.url).searchParams.get('token') || '';
    const config = getAsrConfig();

    if (!Number.isInteger(id) || id <= 0 || !verifyAudioToken(token, id, config.tokenSecret)) {
      return new Response('Not found', { status: 404 });
    }

    const rows = await query<AudioRow[]>('SELECT audio_data, audio_mime FROM practice_records WHERE id = ? LIMIT 1', [id]);
    const row = rows[0];
    if (!row?.audio_data) return new Response('Not found', { status: 404 });

    return new Response(row.audio_data as unknown as BodyInit, {
      headers: {
        'Content-Type': row.audio_mime || 'audio/webm',
        'Content-Length': String(row.audio_data.length),
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}