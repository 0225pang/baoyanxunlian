import { createPool } from 'mysql2/promise';
import { WebSocket, WebSocketServer } from 'ws';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.REALTIME_ASR_PORT || 3001);
const MAX_CLIENTS = Number(process.env.REALTIME_ASR_MAX_CLIENTS || 24);
const MAX_MESSAGE_BYTES = 1024 * 1024;

const database = createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 33060),
  database: process.env.MYSQL_DATABASE || 'baoyanxunlian',
  user: process.env.MYSQL_USER || 'baoyan_app',
  password: process.env.MYSQL_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 4,
  charset: 'utf8mb4',
  timezone: '+08:00',
});

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function verifyAccessToken(token) {
  const secret = process.env.ASR_AUDIO_TOKEN_SECRET || process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY;
  if (!secret || typeof token !== 'string') return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(value.userId) > 0 && Number(value.expiresAt) > Date.now();
  } catch { return false; }
}
function accessTokenUserId(token) {
  if (!verifyAccessToken(token) || typeof token !== 'string') return 0;
  try { return Number(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).userId) || 0; } catch { return 0; }
}

async function realtimeQuota(userId) {
  await database.query('INSERT IGNORE INTO user_api_limits (user_id) VALUES (?)', [userId]);
  const [limits] = await database.query('SELECT realtime_asr_enabled AS enabled, realtime_seconds_limit AS secondsLimit FROM user_api_limits WHERE user_id = ? LIMIT 1', [userId]);
  const limit = limits[0];
  if (!limit?.enabled) throw new Error('实时转写已被管理员关闭');
  const [usageRows] = await database.query(`SELECT COALESCE(SUM(audio_seconds), 0) AS seconds FROM api_usage_logs WHERE user_id = ? AND feature = 'realtime_asr' AND created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')`, [userId]);
  const cap = Number(limit.secondsLimit || 0); const used = Number(usageRows[0]?.seconds || 0);
  if (cap > 0 && used >= cap) throw new Error('实时转写本月额度已用完');
  return cap > 0 ? cap - used : 0;
}
async function getSettings() {
  const [rows] = await database.query(
    'SELECT provider, websocket_url AS websocketUrl, workspace_id AS workspaceId, model, api_key AS apiKey FROM realtime_asr_settings WHERE id = 1 LIMIT 1',
  );
  const setting = rows[0];
  if (!setting?.websocketUrl || !setting?.model || !setting?.apiKey) throw new Error('管理员尚未完成实时语音识别 API 配置');
  if (!/^wss?:\/\//i.test(setting.websocketUrl)) throw new Error('实时语音识别 WebSocket 地址无效');
  return setting;
}

function startPayload(taskId, setting, sampleRate) {
  const isParaformer = /^paraformer-realtime-(?:v1|v2)$/.test(String(setting.model || ''));
  const parameters = { sample_rate: sampleRate, format: 'pcm' };
  if (isParaformer) {
    Object.assign(parameters, { disfluency_removal_enabled: false });
    if (setting.model === 'paraformer-realtime-v2') {
      Object.assign(parameters, {
        punctuation_prediction_enabled: true,
        semantic_punctuation_enabled: false,
        max_sentence_silence: 1300,
      });
    }
  }
  return JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: setting.model,
      parameters,
      input: {},
    },
  });
}

function finishPayload(taskId) {
  return JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } });
}

const server = new WebSocketServer({ port: PORT, path: '/ws/realtime-asr', maxPayload: MAX_MESSAGE_BYTES });

server.on('connection', (client) => {
  if (server.clients.size > MAX_CLIENTS) {
    send(client, { type: 'error', error: '实时转写连接数已达上限，请稍后再试' });
    client.close(1013, 'too many clients');
    return;
  }

  let upstream = null;
  let taskId = '';
  let started = false;
  let finishing = false;
  let upstreamTaskStarted = false;
  let usageUserId = 0; let usageStartedAt = 0; let usageModel = ''; let usageLogged = false; let quotaTimer = null;
  const pendingAudio = [];
  const recordUsage = () => {
    if (usageLogged || !usageUserId || !usageStartedAt || !upstreamTaskStarted) return;
    usageLogged = true; if (quotaTimer) clearTimeout(quotaTimer);
    const audioSeconds = Math.max(1, Math.ceil((Date.now() - usageStartedAt) / 1000));
    void database.query('INSERT INTO api_usage_logs (user_id, feature, audio_seconds, request_count, model) VALUES (?, ?, ?, ?, ?)', [usageUserId, 'realtime_asr', audioSeconds, 1, usageModel || null]).catch((error) => console.error('Realtime ASR usage log failed:', error));
  };
  const closeUpstream = (force = false) => {
    if (!upstream) return;
    if (upstream.readyState === WebSocket.OPEN && !finishing && taskId) {
      finishing = true;
      try { upstream.send(finishPayload(taskId)); } catch { /* closing */ }
      if (!force) {
        const value = upstream;
        setTimeout(() => { if (upstream === value && value.readyState === WebSocket.OPEN) { try { value.close(); } catch { /* closing */ } } }, 5000);
        return;
      }
    }
    if (!force) return;
    const value = upstream;
    upstream = null;
    if (value.readyState === WebSocket.CONNECTING || value.readyState === WebSocket.OPEN) {
      try { value.close(); } catch { /* closing */ }
    }
  };

  client.on('message', async (raw, isBinary) => {
    if (isBinary) {
      if (!started || !upstream || upstream.readyState !== WebSocket.OPEN || !upstreamTaskStarted) {
        if (pendingAudio.length < 40) pendingAudio.push(Buffer.from(raw));
      } else upstream.send(raw, { binary: true });
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString()); } catch { send(client, { type: 'error', error: '实时转写请求格式无效' }); return; }
    if (message.action === 'finish') { closeUpstream(); return; }
    if (message.action !== 'start' || started) return;
    const userId = accessTokenUserId(message.token);
    if (!userId) { send(client, { type: 'error', error: '实时转写授权已失效，请重新开始本段录音' }); client.close(1008, 'unauthorized'); return; }
    let remainingSeconds = 0;
    try { remainingSeconds = await realtimeQuota(userId); } catch (error) { send(client, { type: 'error', error: error instanceof Error ? error.message : '实时转写不可用' }); client.close(1008, 'quota'); return; }

    usageUserId = userId; started = true;
    let sampleRate = Number(message.sampleRate) || 16000;
    taskId = String(message.taskId || randomUUID());
    try {
      const setting = await getSettings(); usageModel = setting.model;
      if (setting.model === 'paraformer-realtime-v1') sampleRate = 16000;
      if (remainingSeconds > 0) quotaTimer = setTimeout(() => { send(client, { type: 'error', error: '实时转写本段已达到本月剩余额度，录音将停止' }); recordUsage(); closeUpstream(true); try { client.close(1008, 'quota reached'); } catch { /* closed */ } }, remainingSeconds * 1000);
      const headers = { Authorization: `Bearer ${setting.apiKey}` };
      if (setting.workspaceId) headers['X-DashScope-WorkSpace'] = String(setting.workspaceId);
      upstream = new WebSocket(setting.websocketUrl, { headers, maxPayload: MAX_MESSAGE_BYTES });
      upstream.on('open', () => {
        if (!upstream) return;
        upstream.send(startPayload(taskId, setting, sampleRate));
      });
      let upstreamFailure = '';
      upstream.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString());
          const header = payload?.header || {};
          if (header.event === 'task-started') {
            upstreamTaskStarted = true; usageStartedAt = Date.now();
            for (const audio of pendingAudio.splice(0)) upstream?.send(audio, { binary: true });
            send(client, { type: 'ready' });
            return;
          }
          if (header.event === 'task-failed' || header.error_code || header.error_message) {
            upstreamFailure = String(header.error_message || payload?.payload?.output?.message || payload?.message || '百炼拒绝了实时转写任务');
            send(client, { type: 'error', error: upstreamFailure, data: payload });
            return;
          }
          send(client, { type: 'result', data: payload });
        } catch { send(client, { type: 'result', data: { raw: data.toString() } }); }
      });
      upstream.on('error', (error) => {
        upstreamFailure = `实时 ASR 上游连接失败：${error.message}`;
        send(client, { type: 'error', error: upstreamFailure });
      });
      upstream.on('close', (code, reason) => {
        const closeReason = reason.toString() || upstreamFailure || `百炼连接关闭（${code}）`;
        console.warn(`Realtime ASR upstream closed: code=${code} reason=${closeReason}`);
        send(client, { type: 'closed', code, reason: closeReason, failed: Boolean(upstreamFailure) });
        upstream = null;
      });
    } catch (error) {
      send(client, { type: 'error', error: error instanceof Error ? error.message : '实时转写启动失败' });
      client.close(1011, 'configuration error');
    }
  });
  client.on('close', () => { recordUsage(); closeUpstream(true); });
  client.on('error', () => { recordUsage(); closeUpstream(true); });
});

server.on('listening', () => console.log(`Realtime ASR proxy listening on :${PORT}`));
server.on('error', (error) => { console.error('Realtime ASR proxy failed:', error); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { server.close(); await database.end(); process.exit(0); });
