import http from 'node:http';
import crypto from 'node:crypto';
import next from 'next';
import WebSocket, { WebSocketServer } from 'ws';
import mysql from 'mysql2/promise';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

function pool() { return mysql.createPool({ host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306), database: process.env.MYSQL_DATABASE || 'baoyanxunlian', user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '', connectionLimit: 2 }); }
async function authorized(request) {
  const cookies = String(request.headers.cookie || '').split(';').map((part) => part.trim());
  const token = cookies.find((part) => part.startsWith('yanlu_session='))?.slice('yanlu_session='.length);
  if (!token) return false;
  const db = pool();
  try { let rawToken = token; try { rawToken = decodeURIComponent(token); } catch { return false; } const [rows] = await db.query('SELECT s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.status = \'active\' LIMIT 1', [crypto.createHash('sha256').update(rawToken).digest('hex')]); return rows.length > 0; } finally { await db.end(); }
}
async function config() {
  const db = pool();
  try { const [rows] = await db.query('SELECT websocket_url AS websocketUrl, model, api_key AS apiKey FROM realtime_asr_settings WHERE id = 1 LIMIT 1'); const row = rows[0]; return row || { websocketUrl: process.env.DASHSCOPE_REALTIME_ASR_URL, model: process.env.DASHSCOPE_REALTIME_ASR_MODEL || 'qwen-audio-3.0-asr-flash-streaming', apiKey: process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY }; } finally { await db.end(); }
}
function sendJson(socket, value) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }

wss.on('connection', (browser, request) => {
  let upstream = null; let taskId = crypto.randomUUID(); let started = false;
  const closeAll = () => { if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(); upstream = null; };
  browser.on('close', closeAll); browser.on('error', closeAll);
  browser.on('message', async (data, isBinary) => {
    try {
      if (!started && !isBinary) {
        const message = JSON.parse(data.toString()); if (message.action !== 'start') return;
        const settings = await config(); if (!settings.apiKey || !settings.websocketUrl) throw new Error('实时语音识别尚未配置 API Key 或 WebSocket 地址');
        taskId = String(message.taskId || taskId); upstream = new WebSocket(String(settings.websocketUrl), { headers: { Authorization: `Bearer ${settings.apiKey}` } });
        upstream.on('open', () => { started = true; upstream.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: settings.model || 'qwen-audio-3.0-asr-flash-streaming', parameters: { format: 'pcm', sample_rate: Number(message.sampleRate) || 16000 }, input: {} } })); });
        upstream.on('message', (chunk, binary) => { if (browser.readyState === WebSocket.OPEN) browser.send(chunk, { binary }); });
        upstream.on('error', (error) => sendJson(browser, { type: 'error', message: error.message })); upstream.on('close', () => { if (browser.readyState === WebSocket.OPEN) browser.close(); }); return;
      }
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      if (!isBinary) { const message = JSON.parse(data.toString()); if (message.action === 'finish') upstream.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } })); }
      else upstream.send(data, { binary: true });
    } catch (error) { sendJson(browser, { type: 'error', message: error instanceof Error ? error.message : '实时识别连接失败' }); }
  });
});

await app.prepare();
const server = http.createServer((request, response) => handle(request, response));
server.on('upgrade', async (request, socket, head) => {
  const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/ws/realtime-asr' || !(await authorized(request))) { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
});
server.listen(port, hostname, () => console.log(`> Ready on http://${hostname}:${port}`));
