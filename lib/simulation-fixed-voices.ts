import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execute, query } from '@/lib/db';
import { synthesizeConfiguredQuestionVoice } from '@/lib/question-voices';
import type { RowDataPacket } from 'mysql2/promise';

type FixedModule = { id?: unknown; kind?: unknown; prompt?: unknown };
type FixedVoiceRow = RowDataPacket & { id: number; status: string; outputPath: string | null };

const storageRoot = path.join(process.cwd(), 'data', 'simulation-fixed-voices');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export type SimulationTtsConfig = {
  provider: 'browser' | 'baidu' | 'bailian';
  sourceMode: 'sambert' | 'clone';
  model: string;
  voiceId: string;
  per: number;
  rate: number;
  pitch: number;
  volume: number;
};

/** The normalized value is also the cache identity, so equivalent saves are free. */
export function normalizeSimulationTtsConfig(value: unknown): SimulationTtsConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const provider = raw.provider === 'baidu' || raw.provider === 'bailian' ? raw.provider : 'browser';
  const sourceMode = provider === 'bailian' && raw.sourceMode === 'clone' ? 'clone' : 'sambert';
  return {
    provider,
    sourceMode,
    model: String(raw.model || '').trim().slice(0, 150),
    voiceId: String(raw.voiceId || '').trim().slice(0, 255),
    per: clamp(raw.per, 0, 50000, 1),
    rate: clamp(raw.rate, 0.5, 2, 1),
    pitch: clamp(raw.pitch, 0.5, 2, 1),
    volume: clamp(raw.volume, 0, 100, 50),
  };
}

export function fixedQuestionContentHash(prompt: unknown) {
  return digest(String(prompt || '').trim());
}

function configHash(config: SimulationTtsConfig) {
  return digest(JSON.stringify(config));
}

function extensionForMime(mime: string) {
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('pcm')) return '.pcm';
  return '.mp3';
}

export async function storeSimulationFixedVoiceFile(voiceId: number, mime: string, content: Buffer) {
  await mkdir(storageRoot, { recursive: true });
  const target = path.join(storageRoot, `${voiceId}-${Date.now()}-${randomBytes(5).toString('hex')}${extensionForMime(mime)}`);
  await writeFile(target, content);
  return target;
}

export async function readSimulationFixedVoiceFile(filePath: string | null) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const root = path.resolve(storageRoot) + path.sep;
  if (!resolved.startsWith(root)) return null;
  try { return await readFile(resolved); } catch { return null; }
}

function fixedTasks(modules: unknown) {
  const values = Array.isArray(modules) ? modules : [];
  return values.flatMap((item) => {
    const module = item && typeof item === 'object' ? item as FixedModule : null;
    const kind = String(module?.kind || '');
    const moduleId = String(module?.id || '').trim().slice(0, 160);
    const prompt = String(module?.prompt || '').trim();
    return (moduleId && prompt && (kind === 'intro' || kind === 'fixed')) ? [{ moduleId, prompt }] : [];
  });
}

export async function syncSimulationFixedVoices(templateId: number, modules: unknown, rawConfig: unknown) {
  const config = normalizeSimulationTtsConfig(rawConfig);
  const tasks = fixedTasks(modules);
  const result = { generated: 0, skipped: 0, failed: 0, browser: config.provider === 'browser' };
  if (config.provider === 'browser') return result;
  const currentConfigHash = configHash(config);

  for (const task of tasks) {
    const contentHash = fixedQuestionContentHash(task.prompt);
    const existing = await query<FixedVoiceRow[]>(`SELECT id, status, output_path AS outputPath
      FROM simulation_fixed_voices WHERE template_id = ? AND module_id = ? AND content_hash = ? AND config_hash = ? LIMIT 1`,
    [templateId, task.moduleId, contentHash, currentConfigHash]);
    const row = existing[0];
    if (row?.status === 'ready' && row.outputPath) { result.skipped += 1; continue; }
    if (row?.status === 'processing') { result.skipped += 1; continue; }

    let voiceId = Number(row?.id || 0);
    if (voiceId) {
      await execute("UPDATE simulation_fixed_voices SET status = 'processing', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [voiceId]);
    } else {
      const inserted = await execute(`INSERT INTO simulation_fixed_voices
        (template_id, module_id, content_hash, config_hash, provider, model, parameters, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`,
      [templateId, task.moduleId, contentHash, currentConfigHash, config.provider, config.model || null, JSON.stringify(config)]);
      voiceId = Number(inserted.insertId);
    }

    try {
      const generated = await synthesizeConfiguredQuestionVoice(config, task.prompt);
      if (!generated) throw new Error('当前配置为浏览器朗读，未生成服务器音频。');
      const outputPath = await storeSimulationFixedVoiceFile(voiceId, generated.mime, generated.audio);
      await execute("UPDATE simulation_fixed_voices SET status = 'ready', output_path = ?, output_mime = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [outputPath, generated.mime, voiceId]);
      result.generated += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 4000) : '固定题音频生成失败';
      await execute("UPDATE simulation_fixed_voices SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [message, voiceId]);
      result.failed += 1;
    }
  }
  return result;
}
