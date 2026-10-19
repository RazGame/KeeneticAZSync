// Panel authentication writes session records. Some SQLite-backed panels fail
// on overlapping logins, even when configuration reads themselves are safe.
// Serialize only authentication at an origin; router work stays concurrent.
import { httpError } from './security.js';

const origins = new Map();
function drain(key, entry) {
  if (entry.running) return;
  const job = entry.queue.shift();
  if (!job) { origins.delete(key); return; }
  entry.running = true;
  job.signal?.removeEventListener('abort', job.abort);
  Promise.resolve().then(() => { job.signal?.throwIfAborted(); return job.operation(); })
    .then(job.resolve, job.reject)
    .finally(() => { entry.running = false; drain(key, entry); });
}

export function panelLogin(url, operation, { signal } = {}) {
  signal?.throwIfAborted();
  const key = new URL(url).origin;
  let entry = origins.get(key);
  if (!entry) {
    if (origins.size >= 64) throw httpError(429, 'Слишком много одновременных подключений к панелям');
    entry = { running: false, queue: [] }; origins.set(key, entry);
  }
  if (entry.queue.length >= 32) throw httpError(429, 'Очередь входа в панель заполнена. Повторите позже.');
  return new Promise((resolve, reject) => {
    const job = { operation, signal, resolve, reject, abort: () => {
      const index = entry.queue.indexOf(job);
      if (index !== -1) { entry.queue.splice(index, 1); reject(signal.reason); }
    } };
    signal?.addEventListener('abort', job.abort, { once: true });
    entry.queue.push(job); drain(key, entry);
  });
}
