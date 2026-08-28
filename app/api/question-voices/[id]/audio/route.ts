import { requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { readQuestionVoiceFile } from '@/lib/question-voices';
import type { RowDataPacket } from 'mysql2/promise';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await context.params; const id = Number(rawId); const url = new URL(request.url); const kind = url.searchParams.get('kind') === 'source' ? 'source' : 'output'; const token = url.searchParams.get('token') || '';
    if (!Number.isInteger(id) || id < 1) return new Response('Not found', { status: 404 });
    const rows = await query<RowDataPacket[]>(`SELECT public_token AS publicToken, source_path AS sourcePath, source_mime AS sourceMime,
      output_path AS outputPath, output_mime AS outputMime FROM question_voices WHERE id=? LIMIT 1`, [id]); const row = rows[0]; if (!row) return new Response('Not found', { status: 404 });
    if (token !== String(row.publicToken || '')) { const user = await requireUser(); if (user.role !== 'admin') return new Response('Forbidden', { status: 403 }); }
    const buffer = await readQuestionVoiceFile(kind === 'source' ? row.sourcePath : row.outputPath); if (!buffer) return new Response('Not found', { status: 404 });
    return new Response(buffer as unknown as BodyInit, { headers: { 'Content-Type': kind === 'source' ? String(row.sourceMime || 'audio/wav') : String(row.outputMime || 'audio/mpeg'), 'Content-Length': String(buffer.length), 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) { const response = await GET(request, context); return new Response(null, { status: response.status, headers: response.headers }); }
