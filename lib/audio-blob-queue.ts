const concurrency = Math.max(1, Math.min(8, Number(process.env.AUDIO_BLOB_READ_CONCURRENCY) || 2));
const maxWaiting = Math.max(0, Math.min(100, Number(process.env.AUDIO_BLOB_READ_QUEUE_MAX) || 20));
const waitTimeoutMs = Math.max(1_000, Math.min(120_000, Number(process.env.AUDIO_BLOB_READ_QUEUE_TIMEOUT_MS) || 20_000));

let active = 0;
const waiting: Array<(release: () => void) => void> = [];

export class AudioBlobReadBusyError extends Error {
  constructor(message = '录音读取繁忙，请稍后重试') {
    super(message);
    this.name = 'AudioBlobReadBusyError';
  }
}

function release() {
  const next = waiting.shift();
  if (next) {
    next(release);
    return;
  }
  active = Math.max(0, active - 1);
}

async function acquire() {
  if (active < concurrency) {
    active += 1;
    return release;
  }
  if (waiting.length >= maxWaiting) throw new AudioBlobReadBusyError('录音读取队列已满，请稍后重试');
  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiting.indexOf(grant);
      if (index >= 0) waiting.splice(index, 1);
      reject(new AudioBlobReadBusyError('录音读取等待超时，请稍后重试'));
    }, waitTimeoutMs);
    const grant = (unlock: () => void) => {
      clearTimeout(timer);
      resolve(unlock);
    };
    waiting.push(grant);
  });
}

// mysql2 materializes a LONGBLOB before the route can respond. Keep only a
// small number of those reads in flight so simultaneous audio playback cannot
// saturate the remote MySQL volume.
export async function withAudioBlobRead<T>(operation: () => Promise<T>) {
  const unlock = await acquire();
  try {
    return await operation();
  } finally {
    unlock();
  }
}
