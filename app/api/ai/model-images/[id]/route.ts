import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { readAiModelImage } from '@/lib/ai-model-images';
import type { RowDataPacket } from 'mysql2/promise';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const id = Number((await context.params).id);
    if (!Number.isSafeInteger(id) || id <= 0) return new Response('Not found', { status: 404 });
    const rows = await query<RowDataPacket[]>('SELECT mime, storage_path AS storagePath FROM ai_model_images WHERE id=? LIMIT 1', [id]);
    const row = rows[0];
    const image = await readAiModelImage(row?.storagePath ? String(row.storagePath) : null);
    if (!row || !image) return new Response('Not found', { status: 404 });
    return new Response(image, { headers: {
      'Content-Type': String(row.mime),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    } });
  } catch (error) { return apiError(error); }
}
