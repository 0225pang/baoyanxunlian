import { AudioBlobReadBusyError, withAudioBlobRead } from '@/lib/audio-blob-queue';
import { getAsrConfig, verifyAudioToken } from '@/lib/asr';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string; answerId: string }> }) {
  try {
    const { id: rawSessionId, answerId: rawAnswerId } = await context.params;
    const sessionId = Number(rawSessionId); const answerId = Number(rawAnswerId);
    const token = new URL(request.url).searchParams.get('token') || '';
    const config = await getAsrConfig();
    if (!Number.isInteger(sessionId) || !Number.isInteger(answerId) || sessionId < 1 || answerId < 1 || !verifyAudioToken(token, answerId, config.tokenSecret)) return new Response('Not found', { status: 404 });
    const rows = await withAudioBlobRead(() => query<RowDataPacket[]>('SELECT audio_data AS audioData, audio_mime AS audioMime FROM simulation_answers WHERE id = ? AND session_id = ? LIMIT 1', [answerId, sessionId]));
    const row = rows[0]; const audio = row?.audioData as Buffer | undefined;
    if (!audio) return new Response('Not found', { status: 404 });
    return new Response(audio as unknown as BodyInit, { headers: { 'Content-Type': String(row.audioMime || 'audio/webm'), 'Content-Length': String(audio.length), 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (error) {
    if (error instanceof AudioBlobReadBusyError) return new Response(error.message, { status: 503, headers: { 'Retry-After': '3' } });
    return new Response('Not found', { status: 404 });
  }
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string; answerId: string }> }) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
