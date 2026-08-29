import { requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { readSimulationFixedVoiceFile } from '@/lib/simulation-fixed-voices';
import type { RowDataPacket } from 'mysql2/promise';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) return new Response('Not found', { status: 404 });
    const rows = await query<RowDataPacket[]>('SELECT output_path AS outputPath, output_mime AS outputMime FROM simulation_fixed_voices WHERE id = ? AND status = \'ready\' LIMIT 1', [id]);
    const row = rows[0];
    const audio = await readSimulationFixedVoiceFile(row?.outputPath || null);
    if (!audio) return new Response('Not found', { status: 404 });
    return new Response(audio as unknown as BodyInit, { headers: {
      'Content-Type': String(row.outputMime || 'audio/mpeg'),
      'Content-Length': String(audio.length),
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    } });
  } catch { return new Response('Not found', { status: 404 }); }
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
