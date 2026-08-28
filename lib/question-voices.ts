import { randomBytes, randomUUID } from 'node:crypto';
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
  sambertWebsocketUrl: string;
  sambertApiKey: string;
  baiduApiKey: string;
  baiduSecretKey: string;
  baiduTtsUrl: string;
  apiKey: string;
  publicBaseUrl: string;
  cloneModel: string;
  cloneTargetModel: string;
  defaultModel: string;
};

export type QuestionVoiceRow = RowDataPacket & {
  id: number; questionId: number; name: string; kind: string; status: string;
  model: string; voiceId: string | null; sourcePath: string | null;
  sourceFilename: string | null; sourceMime: string | null; outputPath: string | null;
  outputMime: string | null; parameters: string | null; publicToken: string; error: string | null;
};

const storageRoot = path.join(process.cwd(), 'data', 'question-voices');
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'audio';
const clean = (value: unknown) => String(value || '').trim().replace(/\/+$/, '');

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
    websocket_url AS websocketUrl, sambert_websocket_url AS sambertWebsocketUrl,
    sambert_api_key AS sambertApiKey, baidu_api_key AS baiduApiKey,
    baidu_secret_key AS baiduSecretKey, baidu_tts_url AS baiduTtsUrl,
    api_key AS apiKey, public_base_url AS publicBaseUrl,
    clone_model AS cloneModel, clone_target_model AS cloneTargetModel, default_model AS defaultModel
    FROM tts_settings WHERE id = 1 LIMIT 1`);
  const row = rows[0] || {};
  const qwenWorkspaceUrl = clean(row.websocketUrl);
  const configuredSambertUrl = clean(row.sambertWebsocketUrl);
  // Old deployments saved the generic endpoint. Sambert's documented SDK
  // endpoint is the regional Workspace endpoint, so migrate it in memory.
  const sambertWebsocketUrl = /^wss:\/\/dashscope\.aliyuncs\.com\/api-ws\/v1\/inference\/?$/i.test(configuredSambertUrl) && qwenWorkspaceUrl
    ? qwenWorkspaceUrl
    : (configuredSambertUrl || qwenWorkspaceUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  return {
    provider: clean(row.provider || 'bailian'),
    cloneUrl: clean(row.cloneUrl), synthesisUrl: clean(row.synthesisUrl), websocketUrl: qwenWorkspaceUrl,
    sambertWebsocketUrl, sambertApiKey: String(row.sambertApiKey || '').trim(),
    baiduApiKey: String(row.baiduApiKey || '').trim(),
    baiduSecretKey: String(row.baiduSecretKey || '').trim(),
    baiduTtsUrl: clean(row.baiduTtsUrl || 'https://tsn.baidu.com/text2audio'),
    apiKey: String(row.apiKey || '').trim(), publicBaseUrl: clean(row.publicBaseUrl),
    cloneModel: clean(row.cloneModel || 'voice-enrollment'),
    cloneTargetModel: clean(row.cloneTargetModel || 'qwen-audio-3.0-tts-flash'),
    defaultModel: clean(row.defaultModel || 'qwen-audio-3.0-tts-flash'),
  };
}

export const secretPreview = (value: string) => value ? `${value.slice(0, 4)}••••••••${value.slice(-4)}` : '';
export const createPublicToken = () => randomBytes(32).toString('hex');

export async function storeQuestionVoiceFile(voiceId: number, filename: string, content: Buffer | Uint8Array, role: 'source' | 'output') {
  await mkdir(storageRoot, { recursive: true });
  const extension = path.extname(filename).slice(0, 12) || (role === 'output' ? '.mp3' : '.audio');
  const target = path.join(storageRoot, `${voiceId}-${role}-${Date.now()}-${randomBytes(5).toString('hex')}${extension}`);
  await writeFile(target, content);
  return target;
}

export async function readQuestionVoiceFile(filePath: string | null) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath); const root = path.resolve(storageRoot) + path.sep;
  if (!resolved.startsWith(root)) return null;
  try { return await readFile(resolved); } catch { return null; }
}

export async function removeQuestionVoiceFile(filePath: string | null) {
  if (!filePath) return;
  const resolved = path.resolve(filePath); const root = path.resolve(storageRoot) + path.sep;
  if (resolved.startsWith(root)) await unlink(resolved).catch(() => undefined);
}

export function sourcePublicUrl(settings: TtsSettings, voiceId: number, token: string) {
  if (!settings.publicBaseUrl) throw new Error('请先填写声音样本的公网访问地址。');
  if (!/^https?:\/\//i.test(settings.publicBaseUrl)) throw new Error('公网访问地址必须以 http:// 或 https:// 开头。');
  return `${settings.publicBaseUrl}/api/question-voices/${voiceId}/audio?kind=source&token=${encodeURIComponent(token)}`;
}

async function responseError(response: Response) {
  const text = await response.text().catch(() => '');
  return text.slice(0, 700) || `HTTP ${response.status}`;
}

export async function createClonedVoice(settings: TtsSettings, prefix: string, url: string, targetModel?: string) {
  if (!settings.apiKey) throw new Error('请先配置百炼 API Key。');
  if (!settings.cloneUrl) throw new Error('请先配置声音复刻 API 地址。');
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

type SynthesisInput = { provider?: 'bailian' | 'baidu'; text: string; model: string; voiceId: string; parameters: Record<string, unknown> };

let baiduTokenCache: { token: string; expiresAt: number; apiKey: string } | null = null;

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

async function getBaiduAccessToken(settings: TtsSettings) {
  if (!settings.baiduApiKey || !settings.baiduSecretKey) throw new Error('请先配置百度语音 API Key 与 Secret Key。');
  if (baiduTokenCache && baiduTokenCache.apiKey === settings.baiduApiKey && baiduTokenCache.expiresAt > Date.now()) return baiduTokenCache.token;
  const response = await fetch('https://aip.baidubce.com/oauth/2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: settings.baiduApiKey, client_secret: settings.baiduSecretKey }).toString(),
  });
  const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !payload.access_token) throw new Error(`百度 Access Token 获取失败：${payload.error_description || payload.error || `HTTP ${response.status}`}`);
  baiduTokenCache = { token: payload.access_token, apiKey: settings.baiduApiKey, expiresAt: Date.now() + Math.max(60, (Number(payload.expires_in) || 0) - 60) * 1000 };
  return payload.access_token;
}

async function synthesizeBaiduVoice(settings: TtsSettings, input: SynthesisInput) {
  const token = await getBaiduAccessToken(settings);
  const format = String(input.parameters.format || 'mp3').toLowerCase();
  const aue = format === 'wav' ? '6' : format === 'pcm' ? '4' : '3';
  const form = new URLSearchParams({
    tex: input.text, tok: token, cuid: 'baoyanxunlian-question-voice', ctp: '1', lan: 'zh', per: '1', aue,
    spd: String(Math.round(clampNumber(input.parameters.spd, 0, 15, 5))),
    pit: String(Math.round(clampNumber(input.parameters.pit, 0, 15, 5))),
    vol: String(Math.round(clampNumber(input.parameters.volume, 0, 9, 5))),
  });
  const emotion = String(input.parameters.emotion || '').trim();
  if (emotion && emotion !== 'neutral') form.set('text_ctrl', JSON.stringify({ emo: emotion }));
  const response = await fetch(settings.baiduTtsUrl || 'https://tsn.baidu.com/text2audio', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' }, body: form.toString(),
  });
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!response.ok || (!contentType.startsWith('audio/') && !contentType.includes('octet-stream'))) {
    throw new Error(`百度语音合成失败：${await responseError(response)}`);
  }
  const mime = aue === '6' ? 'audio/wav' : aue === '4' ? 'audio/pcm' : 'audio/mpeg';
  return { audio: Buffer.from(await response.arrayBuffer()), mime };
}

export async function synthesizeVoice(settings: TtsSettings, input: SynthesisInput) {
  if (input.provider === 'baidu') return synthesizeBaiduVoice(settings, input);
  if (input.model.startsWith('sambert-')) return synthesizeSambertWebSocket(settings, input);
  if (!settings.apiKey) throw new Error('请先配置百炼 API Key。');
  if (settings.websocketUrl) return synthesizeQwenWebSocket(input, settings.websocketUrl, settings.apiKey);
  if (!settings.synthesisUrl) throw new Error('请先配置 Qwen 语音合成 WebSocket 地址。');
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
  if (!audioUrl) throw new Error(`合成接口未返回音频：${JSON.stringify(payload).slice(0, 600)}`);
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) throw new Error(`下载生成音频失败：${await responseError(audioResponse)}`);
  return { audio: Buffer.from(await audioResponse.arrayBuffer()), mime: (audioResponse.headers.get('content-type') || 'audio/mpeg').split(';')[0] };
}

/** Sambert protocol: one non-duplex run-task with text in payload.input. */
async function synthesizeSambertWebSocket(settings: TtsSettings, input: SynthesisInput) {
  const apiKey = settings.sambertApiKey || settings.apiKey;
  if (!apiKey) throw new Error('请先配置 Sambert API Key。');
  if (!/^wss?:\/\//i.test(settings.sambertWebsocketUrl)) throw new Error('Sambert Workspace WebSocket 地址无效。');
  const format = String(input.parameters.format || 'wav').toLowerCase();
  const normalizedFormat = format === 'pcm' ? 'pcm' : format === 'mp3' ? 'mp3' : 'wav';
  const mime = normalizedFormat === 'mp3' ? 'audio/mpeg' : normalizedFormat === 'pcm' ? 'audio/pcm' : 'audio/wav';
  const taskId = randomUUID();
  const parameters = {
    text_type: 'PlainText', format: normalizedFormat,
    sample_rate: Number(input.parameters.sample_rate) || 16000,
    volume: Number(input.parameters.volume) || 50,
    rate: Number(input.parameters.speech_rate) || 1,
    pitch: Number(input.parameters.pitch_rate) || 1,
    word_timestamp_enabled: Boolean(input.parameters.enable_word_timestamp),
    phoneme_timestamp_enabled: Boolean(input.parameters.enable_phoneme_timestamp),
  };
  console.info(`[Sambert WebSocket] model=${input.model} endpoint=${settings.sambertWebsocketUrl}`);
  return new Promise<{ audio: Buffer; mime: string }>((resolve, reject) => {
    const chunks: Buffer[] = []; let settled = false; let taskFinished = false;
    const socket = new WebSocket(settings.sambertWebsocketUrl, { headers: { Authorization: `bearer ${apiKey}` } });
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket.close(); } catch { /* ignored */ }
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket.close(); } catch { /* ignored */ }
      if (!chunks.length) { reject(new Error('Sambert 任务已完成，但未收到音频数据。')); return; }
      resolve({ audio: Buffer.concat(chunks), mime });
    };
    const timer = setTimeout(() => fail(new Error(`Sambert WebSocket 合成超时：模型 ${input.model}，端点 ${settings.sambertWebsocketUrl}`)), 90000);
    socket.on('open', () => {
      socket.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'out' },
        payload: {
          task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: input.model,
          parameters, input: { text: input.text },
        },
      }));
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        chunks.push(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as { header?: { event?: string; error_code?: string; error_message?: string }; payload?: { output?: { audio?: string } } };
        const event = message.header?.event || '';
        if (event === 'task-failed' || message.header?.error_message) {
          fail(new Error(`Sambert 任务失败${message.header?.error_code ? `（${message.header.error_code}）` : ''}：${message.header?.error_message || '未知错误'}`));
          return;
        }
        const encoded = message.payload?.output?.audio;
        if (encoded && /^[a-zA-Z0-9+/=]+$/.test(encoded)) chunks.push(Buffer.from(encoded, 'base64'));
        if (event === 'task-finished') { taskFinished = true; succeed(); }
      } catch { /* Ignore non-JSON frames. */ }
    });
    socket.on('error', (error) => fail(new Error(`Sambert WebSocket 连接失败：${error.message}`)));
    socket.on('unexpected-response', (_request, response) => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => fail(new Error(`Sambert WebSocket 握手被拒绝（HTTP ${response.statusCode || 400}）：${body.slice(0, 800)}`)));
    });
    socket.on('close', () => {
      if (!settled && !taskFinished) fail(new Error('Sambert WebSocket 在任务完成前关闭。'));
    });
  });
}

async function synthesizeQwenWebSocket(input: SynthesisInput, websocketUrl: string, apiKey: string) {
  if (!/^wss?:\/\//i.test(websocketUrl)) throw new Error('Qwen-Audio-TTS 的 WebSocket 地址无效。');
  const taskId = randomBytes(16).toString('hex');
  const parameters = { format: 'mp3', ...input.parameters, voice: input.voiceId } as Record<string, unknown>;
  return new Promise<{ audio: Buffer; mime: string }>((resolve, reject) => {
    const chunks: Buffer[] = []; let settled = false;
    const socket = new WebSocket(websocketUrl, { headers: { Authorization: `bearer ${apiKey}` } });
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch { /* ignored */ } reject(error); };
    const succeed = () => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch { /* ignored */ } if (!chunks.length) { reject(new Error('Qwen-Audio-TTS 未返回音频数据。')); return; } resolve({ audio: Buffer.concat(chunks), mime: 'audio/mpeg' }); };
    const timer = setTimeout(() => fail(new Error('Qwen-Audio-TTS 合成超时，请稍后重试。')), 60000);
    socket.on('open', () => socket.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'tts', function: 'speech_synthesizer', model: input.model, parameters, input: {} } })));
    socket.on('message', (data, isBinary) => {
      if (isBinary) { chunks.push(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)); return; }
      try {
        const message = JSON.parse(data.toString()) as { header?: { event?: string; error_message?: string }; payload?: { output?: { audio?: string } } };
        const event = message.header?.event || '';
        if (message.header?.error_message || event === 'task-failed') { fail(new Error(message.header?.error_message || 'Qwen-Audio-TTS 任务失败。')); return; }
        if (event === 'task-started') {
          socket.send(JSON.stringify({ header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' }, payload: { input: { text: input.text } } }));
          socket.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
          return;
        }
        const encoded = message.payload?.output?.audio;
        if (encoded && /^[a-zA-Z0-9+/=]+$/.test(encoded)) chunks.push(Buffer.from(encoded, 'base64'));
        if (event === 'task-finished') succeed();
      } catch { /* Ignore non-JSON frames. */ }
    });
    socket.on('error', (error) => fail(new Error(`Qwen-Audio-TTS WebSocket 连接失败：${error.message}`)));
    socket.on('unexpected-response', (_request, response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => fail(new Error(`Qwen-Audio-TTS WebSocket 握手被拒绝（HTTP ${response.statusCode || 400}）：${body.slice(0, 800)}`)));
    });
    socket.on('close', () => { if (!settled) succeed(); });
  });
}

export const friendlyFileName = (value: string) => safeName(value);
