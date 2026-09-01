import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const aiModelImageRoot = path.join(process.cwd(), 'data', 'ai-model-images');

const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const extensions: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export function validateAiModelImage(file: File) {
  if (!allowedMimeTypes.has(file.type)) throw new Error('仅支持 PNG、JPG、WebP 或 SVG 格式的模型图标。');
  if (file.size <= 0) throw new Error('请选择有效的图标文件。');
  if (file.size > 2 * 1024 * 1024) throw new Error('模型图标不能超过 2MB。');
}

export async function storeAiModelImage(filename: string, mime: string, data: Buffer) {
  await mkdir(aiModelImageRoot, { recursive: true });
  const extension = extensions[mime] || path.extname(filename).slice(0, 12) || '.img';
  const safeBase = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'model-logo';
  const target = path.join(aiModelImageRoot, `${Date.now()}-${randomBytes(6).toString('hex')}-${safeBase}${extension}`);
  await writeFile(target, data);
  return target;
}

export async function readAiModelImage(filePath: string | null) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const root = path.resolve(aiModelImageRoot) + path.sep;
  if (!resolved.startsWith(root)) return null;
  try { return await readFile(resolved); } catch { return null; }
}

export async function removeAiModelImage(filePath: string | null) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  const root = path.resolve(aiModelImageRoot) + path.sep;
  if (resolved.startsWith(root)) await unlink(resolved).catch(() => undefined);
}
