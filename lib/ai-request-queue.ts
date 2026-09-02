const concurrency = Math.max(1, Math.min(8, Number(process.env.AI_REQUEST_CONCURRENCY) || 5));
const maxWaiting = Math.max(1, Math.min(100, Number(process.env.AI_REQUEST_QUEUE_MAX) || 30));
const waitTimeoutMs = Math.max(10_000, Math.min(600_000, Number(process.env.AI_REQUEST_QUEUE_TIMEOUT_MS) || 300_000));

let active = 0;
const waiting: Array<(release: () => void) => void> = [];

export class AiRequestQueueBusyError extends Error {
  constructor(message = 'AI 请求较多，排队等待超时，请稍后重试。') {
    super(message);
    this.name = 'AiRequestQueueBusyError';
  }
}

function release() {
  const next = waiting.shift();
  if (next) { next(release); return; }
  active = Math.max(0, active - 1);
}

/**
 * Per-app-instance queue for upstream LLM requests. Five concurrent requests
 * keep live questions and discussions responsive while preventing bursts from
 * overwhelming common free API tiers.
 */
export async function acquireAiRequestSlot() {
  if (active < concurrency) { active += 1; return release; }
  if (waiting.length >= maxWaiting) throw new AiRequestQueueBusyError('AI 请求排队人数较多，请稍后再试。');
  return new Promise<() => void>((resolve, reject) => {
    const grant = (unlock: () => void) => { clearTimeout(timer); resolve(unlock); };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(grant);
      if (index >= 0) waiting.splice(index, 1);
      reject(new AiRequestQueueBusyError());
    }, waitTimeoutMs);
    waiting.push(grant);
  });
}

export async function withAiRequestQueue<T>(operation: () => Promise<T>) {
  const unlock = await acquireAiRequestSlot();
  try { return await operation(); } finally { unlock(); }
}

/**
 * Keeps a slot until the complete response body has been consumed. This is
 * important for streaming chat: fetch() resolves at response headers, while
 * the upstream model is still generating tokens.
 */
export async function fetchWithAiRequestQueue(input: RequestInfo | URL, init?: RequestInit) {
  const unlock = await acquireAiRequestSlot();
  let released = false;
  const releaseOnce = () => { if (!released) { released = true; unlock(); } };
  try {
    const response = await fetch(input, init);
    if (!response.body) { releaseOnce(); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) { releaseOnce(); controller.close(); return; }
          controller.enqueue(value);
        } catch (error) { releaseOnce(); controller.error(error); }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { releaseOnce(); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { releaseOnce(); throw error; }
}
