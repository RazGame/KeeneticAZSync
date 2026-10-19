import { performance } from 'node:perf_hooks';

export const counter = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  throw new Error('Панель вернула некорректный счётчик трафика');
};

export function measureTraffic(stats, previous, { monotonic = performance.now() / 1000, uptime = null } = {}) {
  const rx = counter(stats.rxbytes), tx = counter(stats.txbytes);
  const nativeClock = typeof stats.timestamp === 'string' && /^\d+(?:\.\d+)?$/.test(stats.timestamp);
  const time = nativeClock ? Number(stats.timestamp) : monotonic;
  if (!Number.isFinite(time) || time < 0) throw new Error('Некорректная отметка времени счётчиков');
  const next = { rx, tx, time, nativeClock, uptime };
  const seconds = previous ? time - previous.time : 0;
  const reset = !previous || previous.nativeClock !== nativeClock || seconds <= 0 || seconds > 30
    || rx < previous.rx || tx < previous.tx || (uptime !== null && previous.uptime !== null && uptime < previous.uptime);
  const downloadBps = reset ? null : Number(rx - previous.rx) * 8 / seconds;
  const uploadBps = reset ? null : Number(tx - previous.tx) * 8 / seconds;
  if ([downloadBps, uploadBps].some(value => value !== null && !Number.isFinite(value))) throw new Error('Некорректная скорость по счётчикам');
  return { next, downloadBps, uploadBps, intervalSeconds: reset ? null : seconds, receivedBytes: rx.toString(), sentBytes: tx.toString(), reset };
}

