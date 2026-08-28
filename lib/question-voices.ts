import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { query } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

export type TtsSettings = {
  provider: string;
  cloneUrl: string;
  synthesisUrl: string;
  websocketUrl: string;
  apiKey: string;
  publicBaseUrl: string;
  cloneModel: string;
  cloneTargetModel: string;
  defaultModel: string;
};

export type QuestionVoiceRow = RowDataPacket & {
  id: number;
  questionId: number;
  name: string;
  kind: string;
  status: string;
  model: string;
  voiceId: string | null;
  sourcePath: string | null;
  sourceFilename: string | null;
  sourceMime: string | null;
  outputPath: string | null;
  outputMime: string | null;
  parameters: string | null;
  publicToken: string;
  error: string | null;
};

const storageRoot = path.join(process.cwd(), 'data', 'question-voices');
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'audio';

function clean(value: unknown) { return String(value || '').trim().replace(/\/+$/, ''); }

function findString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) { const found = findString(item, keys); if (found) return found; }
    return '';
  }
  const source = value as Record<string, unknown>;
  for (const key of keys) if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim();
  for (const item of Object.values(source)) { const found = findString(item, keys); if (found) return found; }
  return '';
}

export async function getTtsSettings(): Promise<TtsSettings> {
  const rows = await query<RowDataPacket[]>(`SELECT provider, clone_url AS cloneUrl, synthesis_url AS synthesisUrl,
    websocket_url AS websocketUrl, api_key AS apiKey, public_base_url AS publicBaseUrl,
    clone_model AS cloneModel, clone_target_model AS cloneTargetModel, default_model AS defaultModel
    FROM tts_settings WHERE id = 1 LIMIT 1`);
  const row = rows[0] || {};
  return {
    provider: clean(row.provider || 'bailian'),
    cloneUrl: clean(row.cloneUrl), synthesisUrl: clean(row.synthesisUrl), websocketUrl: clean(row.websocketUrl),
    apiKey: String(row.apiKey || '').trim(), publicBaseUrl: clean(row.publicBaseUrl),
    cloneModel: clean(row.cloneModel || 'voice-enrollment'),
    cloneTargetModel: clean(row.cloneTargetModel || 'qwen-audio-3.0-tts-flash'),
    defaultModel: clean(row.defaultModel || 'qwen-audio-3.0-tts-flash'),
  };
}

export function secretPreview(value: string) { return value ? `${value.slice(0, 4)}••••••••${value.slice(-4)}` : ''; }
export function createPublicToken() { return randomBytes(32).toString('hex'); }

export async function storeQuestionVoiceFile(voiceId: number, filename: string, content: Buffer | Uint8Array, role: 'source' | 'output') {
  await mkdir(storageRoot, { recursive: true });
  const extension = path.extname(filename).slice(0, 12) || (role === 'output' ? '.mp3' : '.audio');
  const target = path.join(storageRoot, `${voiceId}-${role}-${Date.now()}-${randomBytes(5).toString('hex')}${extension}`);
  await writeFile(target, content);
  return target;
}

export async function readQuestionVoiceFile(filePath: string | null) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const root = path.resolve(storageRoot) + path.sep;
  if (!resolved.startsWith(root)) return null;
  try { return await readFile(resolved); } catch { return null; }
}

export async function removeQuestionVoiceFile(filePath: string | null) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  const root = path.resolve(storageRoot) + path.sep;
  if (!resolved.startsWith(root)) return;
  await unlink(resolved).catch(() => undefined);
}

export function sourcePublicUrl(settings: TtsSettings, voiceId: number, token: string) {
  if (!settings.publicBaseUrl) throw new Error('请先在题目语音配置中填写“公网访问地址”，例如 http://103.236.89.20:18080。');
  if (!/^https?:\/\//i.test(settings.publicBaseUrl)) throw new Error('公网访问地址必须以 http:// 或 https:// 开头。');
  return `${settings.publicBaseUrl}/api/question-voices/${voiceId}/audio?kind=source&token=${encodeURIComponent(token)}`;
}

async function responseError(response: Response) {
  const text = await response.text().catch(() => '');
  return text.slice(0, 700) || `HTTP ${response.status}`;
}

export async function createClonedVoice(settings: TtsSettings, prefix: string, url: string, targetModel?: string) {
  if (!settings.apiKey) throw new Error('请先配置百炼 API Key。');
  if (!settings.cloneUrl) throw new Error('请先配置声音复刻 API 地址（需包含百炼 Workspace ID）。');
  const response = await fetch(settings.cloneUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings.cloneModel, input: { action: 'create_voice', target_model: targetModel || settings.cloneTargetModel, prefix, url } }),
  });
  if (!response.ok) throw new Error(`声音复刻请求失败：${await responseError(response)}`);
  const payload = await response.json().catch(() => ({}));
  const voiceId = findString(payload, ['voice_id', 'voiceId']);
  if (!voiceId) throw new Error(`百炼未返回 voice_id：${JSON.stringify(payload).slice(0, 500)}`);
  return { voiceId, payload };
}

export async function synthesizeVoice(settings: TtsSettings, input: { text: string; model: string; voiceId: string; parameters: Record<string, unknown> }) {
  if (!settings.apiKey) throw new Error('请先配置百炼 API Key。');
  if (input.model.startsWith('qwen-audio') && settings.websocketUrl) {
    return synthesizeQwenWebSocket(settings, input);
  }
  if (!settings.synthesisUrl) throw new Error('请先配置语音合成 HTTP API 地址。Qwen-Audio-TTS 如使用 WebSocket，请先填写兼容的 HTTP 合成地址或在后续接入实时播放。');
  const parameters = { voice: input.voiceId, format: 'mp3', ...input.parameters };
  const response = await fetch(settings.synthesisUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: input.model, input: { text: input.text }, parameters }),
  });
  if (!response.ok) throw new Error(`语音合成请求失败：${await responseError(response)}`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('audio/')) return { audio: Buffer.from(await response.arrayBuffer()), mime: contentType.split(';')[0] };
  const payload = await response.json().catch(() => ({}));
  const audioUrl = findString(payload, ['audio_url', 'audioUrl', 'url']);
  if (!audioUrl) throw new Error(`合成接口未直接返回音频。请确认所填 API 地址支持同步音频或 audio_url 返回：${JSON.stringify(payload).slice(0, 600)}`);
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) throw new Error(`下载百炼生成音频失败：${await responseError(audioResponse)}`);
  return { audio: Buffer.from(await audioResponse.arrayBuffer()), mime: (audioResponse.headers.get('content-type') || 'audio/mpeg').split(';')[0] };
}

async function synthesizeQwenWebSocket(settings: TtsSettings, input: { text: string; model: string; voiceId: string; parameters: Record<string, unknown> }) {
  if (!/^wss?:\/\//i.test(settings.websocketUrl)) throw new Error('Qwen-Audio-TTS 的 WebSocket 地址无效。');
  const taskId = randomBytes(16).toString('hex');
  const parameters = { voice: input.voiceId, format: 'mp3', ...input.parameters };
  return new Promise<{ audio: Buffer; mime: string }>((resolve, reject) => {
    const chunks: Buffer[] = []; let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; try { socket.close(); } catch { /* ignored */ } reject(error); };
    const succeed = () => { if (settled) return; settled = true; try { socket.close(); } catch { /* ignored */ } if (!chunks.length) { reject(new Error('Qwen-Audio-TTS 未返回音频数据，请检查模型、voice ID 与 WebSocket 配置。')); return; } resolve({ audio: Buffer.concat(chunks), mime: 'audio/mpeg' }); };
    const socket = new WebSocket(settings.websocketUrl, { headers: { Authorization: `Bearer ${settings.apiKey}` } });
    const timer = setTimeout(() => fail(new Error('Qwen-Audio-TTS 合成超时，请稍后重试。')), 60000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'tts', function: 'speech_synthesizer', model: input.model, parameters, input: { text: input.text } } }));
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        chunks.push(
          Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer),
        );
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as { header?: { event?: string; error_message?: string }; payload?: { output?: { audio?: string } } };
        const event = message.header?.event || '';
        if (message.header?.error_message || event === 'task-failed') { clearTimeout(timer); fail(new Error(message.header?.error_message || 'Qwen-Audio-TTS 任务失败。')); return; }
        const encoded = message.payload?.output?.audio;
        if (encoded && /^[a-zA-Z0-9+/=]+$/.test(encoded)) chunks.push(Buffer.from(encoded, 'base64'));
        if (event === 'task-finished') { clearTimeout(timer); succeed(); }
      } catch { /* Ignore non-JSON metadata frames. */ }
    });
    socket.on('error', (error) => { clearTimeout(timer); fail(new Error(`Qwen-Audio-TTS WebSocket 连接失败：${error.message}`)); });
    socket.on('close', () => { clearTimeout(timer); if (!settled) succeed(); });
  });
}

export function friendlyFileName(value: string) { return safeName(value); }
