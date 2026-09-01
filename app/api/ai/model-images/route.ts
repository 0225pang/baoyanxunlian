import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { storeAiModelImage, validateAiModelImage } from '@/lib/ai-model-images';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
}

export async function GET() {
  try {
    await requireAdmin();
    const rows = await query<RowDataPacket[]>('SELECT id, filename FROM ai_model_images ORDER BY created_at DESC, id DESC');
    return Response.json({ images: rows.map((row) => ({ id: Number(row.id), filename: String(row.filename), url: `/api/ai/model-images/${Number(row.id)}` })) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const form = await request.formData();
    const image = form.get('image');
    if (!(image instanceof File)) return Response.json({ error: '请上传模型图标文件。' }, { status: 400 });
    validateAiModelImage(image);
    const filename = image.name.slice(0, 255) || 'model-logo';
    const mime = image.type;
    const storagePath = await storeAiModelImage(filename, mime, Buffer.from(await image.arrayBuffer()));
    try {
      const result = await execute('INSERT INTO ai_model_images (filename, mime, storage_path) VALUES (?, ?, ?)', [filename, mime, storagePath]) as ResultSetHeader;
      const id = Number(result.insertId);
      return Response.json({ image: { id, filename, url: `/api/ai/model-images/${id}` } }, { status: 201 });
    } catch (error) {
      // The file is harmless but must not be left orphaned if persistence fails.
      const { removeAiModelImage } = await import('@/lib/ai-model-images');
      await removeAiModelImage(storagePath);
      throw error;
    }
  } catch (error) { return apiError(error); }
}
