// Native KeeneticOS diagnostics: POST once, then consume GET continuations.
// Confirmed against the router's own Diagnostics UI (tools.iperf3).
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from './util/http.js';
import { Keenetic } from './keenetic.js';
import { httpError, safeMessage } from './security.js';
import { createSpeedHistory } from './speed-history.js';

export const IPERF_TARGETS = Object.freeze({ local: 'az-local.antizapret', world: 'az-world.antizapret' });
const fail = (code, message) => Object.assign(new Error(message), { code });
const LOG_LIMIT = 128 * 1024;

export function parseIperfOutput(text) {
  const patterns = [
    [/server is busy|another test is already running/i, 'SERVER_BUSY', 'Сервер iperf3 занят другим тестом. Повторите позже.'],
    [/unable to resolve|name or service not known|name resolution|unknown host|nodename nor servname/i, 'DNS_ERROR', 'Роутер не смог разрешить имя сервера. Проверьте DNS через VPN.'],
    [/connection refused/i, 'CONNECTION_REFUSED', 'Сервер отклонил соединение на порту 5201. Проверьте, запущен ли iperf3 в AntiZapret.'],
    [/no route to host|network is unreachable|cannot assign requested address/i, 'NO_ROUTE', 'Сервер недоступен через выбранный VPN-интерфейс. Проверьте подключение и маршруты.'],
    [/timed out|timeout/i, 'CONNECTION_TIMEOUT', 'Сервер iperf3 не ответил вовремя. Проверьте VPN и доступность порта 5201.'],
    [/iperf3?:\s*(?:error|interrupt)|unable to connect|terminated|aborted/i, 'IPERF_ERROR', 'iperf3 завершился с ошибкой. Подробности — в журнале теста.'],
  ];
  for (const [pattern, code, message] of patterns) if (pattern.test(text)) throw fail(code, message);
  const summary = {};
  const line = /\[SUM\]\s+(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s+sec\s+(\d+(?:\.\d+)?)\s+([KMGT]?)Bytes\s+(\d+(?:\.\d+)?)\s+([KMGT]?)bits\/sec\s+(?:(\d+)\s+)?(sender|receiver)\b/gi;
  for (const match of text.matchAll(line)) {
    const power = unit => Math.max(0, ['', 'K', 'M', 'G', 'T'].indexOf(unit.toUpperCase()));
    summary[match[8].toLowerCase()] = {
      seconds: Number(match[2]) - Number(match[1]),
      bytes: Number(match[3]) * 1024 ** power(match[4]),
      bitsPerSecond: Number(match[5]) * 1000 ** power(match[6]),
      retransmits: match[7] === undefined ? null : Number(match[7]),
    };
  }
  if (!/iperf Done\./i.test(text) || !summary.sender || !summary.receiver) throw fail('INCOMPLETE_RESULT', 'Роутер не вернул полный итог теста с 10 потоками. Повторите тест; частичные данные доступны в журнале.');
  if (Object.values(summary).some(point => !Number.isFinite(point.seconds) || point.seconds <= 0 || !Number.isFinite(point.bytes) || !Number.isFinite(point.bitsPerSecond) || (point.retransmits !== null && !Number.isFinite(point.retransmits)))) throw fail('INVALID_RESULT', 'Некорректные числовые значения в результате iperf3');
  return summary;
}

export async function runRouterIperf(keen, { mapping, target = 'local', reverse = true, signal, onProgress = () => {}, pollMs = 1000 }) {
  if (!Object.hasOwn(IPERF_TARGETS, target) || typeof reverse !== 'boolean') throw fail('INVALID_OPTIONS', 'Некорректные параметры теста');
  let log = '', started = false, finished = false;
  const call = async (path, method = 'GET', body, cancellable = true) => {
    const response = await request({ url: keen.base + path, method, jar: keen.jar, insecure: keen.insecure,
      timeout: cancellable ? 12000 : 5000, maxBytes: 512 * 1024, retry: false,
      signal: cancellable ? signal : undefined,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 404 && ['GET', 'DELETE'].includes(method) && path === '/rci/tools/iperf3') return null;
    if (response.status === 204 && method === 'DELETE') return {};
    if ([401, 403].includes(response.status)) throw fail('ROUTER_ACCESS_DENIED', 'Роутер отклонил диагностику. Проверьте учётные данные и права пользователя.');
    if (response.status !== 200) throw fail('ROUTER_HTTP', `Диагностика роутера вернула HTTP ${response.status}`);
    let data;
    try { data = JSON.parse(response.text); } catch { throw fail('INVALID_RESPONSE', 'Роутер вернул некорректный ответ диагностики'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('INVALID_RESPONSE', 'Роутер вернул неожиданную структуру диагностики');
    const errors = Keenetic.collectErrors(data);
    if (errors.some(error => /streams/i.test(error))) throw fail('UNSUPPORTED_FIRMWARE', 'Прошивка роутера отклонила параметр streams. Для теста с 10 потоками требуется поддерживающая его версия KeeneticOS/NetcrazeOS.');
    if (errors.length) throw fail('ROUTER_COMMAND_ERROR', 'Роутер не выполнил диагностику: ' + safeMessage(errors.join('; ')));
    return data;
  };
  try {
    await keen.connect({ signal });
    const version = await call('/rci/show/version');
    if (typeof version?.ndw?.components !== 'string') throw fail('CAPABILITY_UNKNOWN', 'Не удалось проверить установленные компоненты роутера. Тест не запущен.');
    if (!version.ndw.components.split(',').map(s => s.trim()).includes('iperf3')) throw fail('IPERF_NOT_INSTALLED', 'На роутере не установлен компонент iPerf3. Установите его в разделе «Обновления и компоненты» роутера. Тест не запущен.');
    const interfaces = await call('/rci/show/interface');
    const clean = value => String(value || '').replace(/^["'\s]+|["'\s]+$/g, '');
    const item = Object.entries(interfaces).find(([id, info]) => clean(info?.description || id) === clean(mapping.interface));
    if (!item || !/^(?:Wireguard|OpenVPN)\d+$/i.test(item[0])) throw fail('INTERFACE_NOT_FOUND', 'VPN-интерфейс подключения не найден на роутере.');
    if (item[1].state !== 'up' || !['yes', true].includes(item[1].connected)) throw fail('VPN_NOT_CONNECTED', 'Выбранное VPN-подключение не активно. Сначала включите его и дождитесь соединения.');
    const existing = await call('/rci/tools/iperf3');
    if (existing && Object.hasOwn(existing, 'continued')) throw fail('ROUTER_BUSY', 'На роутере уже выполняется iperf3. Дождитесь его завершения.');
    signal?.throwIfAborted();
    onProgress({ status: 'running', interfaceName: item[0] });
    started = true;
    let data = await call('/rci/tools/iperf3', 'POST', { host: IPERF_TARGETS[target], port: 5201, tcp: true, ipv4: true,
      streams: 10, time: 10, reverse, 'source-interface': item[0] });
    while (true) {
      if (!data) throw fail('RESULT_LOST', 'Роутер потерял результат теста. Повторите запуск.');
      if (data.message !== undefined) {
        if (!Array.isArray(data.message) || data.message.some(line => typeof line !== 'string')) throw fail('INVALID_RESPONSE', 'Некорректный журнал диагностики роутера');
        log += data.message.join('\n') + '\n';
        if (Buffer.byteLength(log) > LOG_LIMIT) throw fail('OUTPUT_LIMIT', 'Журнал iperf3 превысил допустимый размер. Тест остановлен.');
        onProgress({ log });
      }
      if (!Object.hasOwn(data, 'continued')) { finished = true; break; }
      await delay(pollMs, undefined, { signal });
      data = await call('/rci/tools/iperf3');
    }
    signal?.throwIfAborted();
    return parseIperfOutput(log);
  } catch (error) {
    if (!signal?.aborted && ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'].includes(error.code)) throw fail('ROUTER_CONNECTION_LOST', 'Связь с роутером прервалась или истекло время ожидания. Тест не запускается повторно автоматически; обновите состояние и проверьте журнал.');
    throw error;
  } finally {
    if (started && !finished) {
      try { await call('/rci/tools/iperf3', 'DELETE', undefined, false); }
      catch { onProgress({ stopUnconfirmed: true }); }
    }
  }
}

// Independent routers/servers can run together. Both AZ target aliases share a
// server slot: in a standard deployment they can resolve to the same process.
export function createSpeedTests({ runner = runRouterIperf, timeoutMs = 90000, queueTimeoutMs = 300000, maxRunning = 3, maxPending = 20, historyFile } = {}) {
  const jobs = new Map();
  const history=createSpeedHistory(historyFile);
  for(const item of history.load())jobs.set(item.id,{public:item,settled:true});
  const active = new Set(), routers = new Map(), servers = new Set();
  let closed = false;
  const view = job => {
    if (!job) return null;
    const result = structuredClone(job.public);
    if (result.status === 'queued') {
      result.queuePosition = [...jobs.values()].filter(j => !j.settled && j.public.status === 'queued' && j.serverKey === job.serverKey).indexOf(job) + 1;
      result.waitingFor = servers.has(job.serverKey) ? 'server' : 'capacity';
    }
    return result;
  };
  const list = () => [...jobs.values()].map(view);
  const get = id => {
    if (!id) return view([...jobs.values()].find(j => !j.settled) || [...jobs.values()].at(-1));
    if (!jobs.has(id)) throw httpError(404, 'Тест не найден или его результат уже удалён');
    return view(jobs.get(id));
  };
  const trim = () => {
    const completed = [...jobs.values()].filter(j => j.settled);
    for (const job of completed.slice(0, Math.max(0, completed.length - 20))) jobs.delete(job.public.id);
  };
  const settle = job => {
    clearTimeout(job.timer); clearTimeout(job.queueTimer);
    job.settled = true; job.public.finishedAt = new Date().toISOString();
    if (active.delete(job)) servers.delete(job.serverKey);
    routers.delete(job.public.router);
    try { job.onSettled(); } finally {
      job.keen = null; job.options = null; job.onSettled = null; trim();
      history.save([...jobs.values()].filter(j=>j.settled).map(j=>j.public));drain();
    }
  };
  const execute = job => {
    clearTimeout(job.queueTimer);
    active.add(job); servers.add(job.serverKey);
    job.public.status = 'checking'; job.public.startedAt = new Date().toISOString();
    job.timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, timeoutMs);
    job.done = Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return runner(job.keen, { ...job.options, signal: job.controller.signal,
        onProgress: patch => { Object.assign(job.public, patch); if (job.controller.signal.aborted) job.public.status = 'stopping'; } });
    })
      .then(result => {
        job.controller.signal.throwIfAborted();
        job.public.result = result; job.public.status = 'done';
      })
      .catch(error => {
        const cancelled = job.controller.signal.aborted && !job.timedOut;
        job.public.status = cancelled ? 'cancelled' : 'error';
        job.public.code = job.timedOut ? 'TEST_TIMEOUT' : cancelled ? 'CANCELLED' : error.code || 'TEST_FAILED';
        job.public.error = job.timedOut ? 'Время ожидания теста истекло. Проверьте доступность роутера и сервера iperf3.' : cancelled ? (job.public.stopUnconfirmed ? 'Отмена запрошена, но остановка на роутере не подтверждена.' : 'Тест остановлен.') : safeMessage(error.message);
      })
      .finally(() => settle(job));
  };
  const drain = () => {
    if (closed) return;
    for (const job of jobs.values()) {
      if (active.size >= maxRunning) break;
      if (!job.settled && job.public.status === 'queued' && !servers.has(job.serverKey)) execute(job);
    }
  };
  const start = (keen, options, onSettled = () => {}) => {
    options = { ...options, target: options.target ?? 'local', reverse: options.reverse ?? true };
    if (closed) throw httpError(503, 'Сервер останавливается');
    if (!options.mapping?.router || !options.mapping?.server || !options.mapping?.name || !Object.hasOwn(IPERF_TARGETS, options.target) || typeof options.reverse !== 'boolean') throw httpError(400, 'Некорректные параметры теста');
    if (routers.has(options.mapping.router)) throw httpError(409, 'На этом роутере уже выполняется или ожидает запуска тест скорости');
    if (routers.size >= maxPending) throw httpError(429, 'Очередь тестов заполнена. Дождитесь завершения или отмените ненужные задания.');
    const job = { controller: new AbortController(), keen, options, onSettled, settled: false,
      serverKey: options.serverKey || options.mapping.server, public: {
      id: randomUUID(), mapping: options.mapping.name, router: options.mapping.router, server: options.mapping.server,
      target: IPERF_TARGETS[options.target], reverse: options.reverse, streams: 10, seconds: 10,
      status: 'queued', createdAt: new Date().toISOString(), log: '', result: null,
    } };
    jobs.set(job.public.id, job); routers.set(job.public.router, job);
    job.queueTimer = setTimeout(() => {
      job.public.status = 'error'; job.public.code = 'QUEUE_TIMEOUT';
      job.public.error = 'Истекло время ожидания в очереди. Тест не запускался.'; settle(job);
    }, queueTimeoutMs);
    drain();
    return view(job);
  };
  const cancel = id => {
    const job = jobs.get(id);
    if (!job) throw httpError(404, 'Тест не найден');
    if (!job.settled) {
      job.controller.abort();
      if (job.public.status === 'queued') { job.public.status = 'cancelled'; job.public.code = 'CANCELLED'; settle(job); }
      else job.public.status = 'stopping';
    }
    return view(job);
  };
  return { get, list, start, cancel, busy: router => router === undefined ? routers.size > 0 : routers.has(router),
    close: () => { closed = true; for (const job of jobs.values()) if (!job.settled) cancel(job.public.id); } };
}
