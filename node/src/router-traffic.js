// Optional router source: read only configured connected VPN interfaces, on demand.
import { createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Keenetic } from './keenetic.js';
import { request } from './util/http.js';
import { httpError, safeMessage } from './security.js';
import { measureTraffic } from './traffic-math.js';
import DisplayOrder from '../web/order.cjs';

export async function readVpnCounters(keen, mappings, { signal } = {}) {
  const call = async (path, body) => {
    const r = await request({ url: keen.base + path, method: body ? 'POST' : 'GET', jar: keen.jar,
      insecure: keen.insecure, signal, timeout: 10000, maxBytes: 2 * 1024 * 1024,
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status !== 200) throw new Error(`Не удалось прочитать трафик роутера: HTTP ${r.status}`);
    let data;
    try { data = JSON.parse(r.text); } catch { throw new Error('Некорректный ответ статистики роутера'); }
    const errors = Keenetic.collectErrors(data);
    if (errors.length) throw new Error('Ошибка статистики роутера: ' + safeMessage(errors.join('; ')));
    return data;
  };
  const interfaces = await call('/rci/show/interface');
  if (!interfaces || typeof interfaces !== 'object' || Array.isArray(interfaces)) throw new Error('Не удалось прочитать список VPN-интерфейсов');
  const clean = value => String(value || '').replace(/^["'\s]+|["'\s]+$/g, '');
  const active = new Map();
  for (const m of mappings) {
    if (m.enabled === false) continue;
    const entry = Object.entries(interfaces).find(([id, info]) => /^(?:Wireguard|OpenVPN)\d+$/i.test(id) && clean(info?.description || id) === clean(m.interface));
    if (!entry || entry[1].state !== 'up' || !['yes', true].includes(entry[1].connected)) continue;
    const [name, info] = entry;
    if (!active.has(name)) active.set(name, { interfaceName: name, description: clean(info.description || name), uptime: Number.isFinite(info.uptime) ? info.uptime : null, mappings: [] });
    active.get(name).mappings.push(m);
  }
  const entries = [...active.values()];
  if (entries.length > 64) throw new Error('Слишком много активных VPN-интерфейсов');
  if (!entries.length) return [];
  const stats = await call('/rci/', entries.map(item => ({ show: { interface: { name: item.interfaceName, stat: {} } } })));
  if (!Array.isArray(stats) || stats.length !== entries.length) throw new Error('Роутер вернул неполную статистику VPN');
  return entries.map((entry, index) => {
    const stat = stats[index]?.show?.interface?.stat;
    if (!stat || typeof stat !== 'object' || Array.isArray(stat)) throw new Error('Нет счётчиков трафика выбранного VPN');
    return { ...entry, stats: stat };
  });
}

export function createRouterTrafficMonitor({ now = Date.now, monotonic = () => performance.now() / 1000,
  makeKeenetic = options => new Keenetic(options), read = readVpnCounters, timeoutMs = 20000 } = {}) {
  const entries = new Map(), key = randomBytes(32);
  const hash = value => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const get = async (cfg, routerName) => {
    if (!Object.hasOwn(cfg.routers, routerName)) throw httpError(404, 'Роутер не найден');
    const router = cfg.routers[routerName];
    const mappings = DisplayOrder.mappings(cfg).filter(m => m.router === routerName && m.enabled !== false).map(m => ({
      name: m.name, server: m.server, connection: m.connection, client: m.client, interface: m.interface,
      protocol: cfg.servers[m.server]?.connections?.[m.connection]?.type === 'openvpn-ui' ? 'OpenVPN' : 'AmneziaWG',
    }));
    const signature = hash({ router, mappings, servers: [...new Set(mappings.map(m => m.server))].map(id => [id, cfg.servers[id]]) });
    let entry = entries.get(routerName);
    if (entry && entry.signature !== signature) { entry.controller?.abort(); entries.delete(routerName); entry = null; }
    if (!entry) {
      for (const [id, old] of entries) if (!old.inflight && now() - old.touched > 600000) entries.delete(id);
      if (entries.size >= 64) {
        const oldest = [...entries].filter(([, value]) => !value.inflight).sort((a,b) => a[1].touched - b[1].touched)[0];
        if (!oldest) throw httpError(429, 'Слишком много запросов мониторинга');
        entries.delete(oldest[0]);
      }
      entry = { signature, baseline: new Map(), keen: null, touched: now(), nextRead: 0, snapshot: null, inflight: null };
      entries.set(routerName, entry);
    }
    entry.touched = now();
    if (entry.inflight) return entry.inflight;
    if (entry.snapshot && now() < entry.nextRead) return structuredClone(entry.snapshot);
    const current = entry;
    current.controller = new AbortController();
    const timer = setTimeout(() => current.controller.abort(), timeoutMs);
    current.inflight = (async () => {
      try {
        if (!mappings.length) {
          current.baseline.clear();
          return { router: routerName, source: 'router', state: 'excluded', capturedAt: now(), connections: [], message: 'У роутера нет подключений с включённой синхронизацией.' };
        }
        if (!current.keen) {
          current.keen = makeKeenetic({ endpoints: router.endpoints || router.endpoint, username: router.username, password: router.password, insecure: router.insecure === true });
          await current.keen.connect({ signal: current.controller.signal });
        }
        const data = await read(current.keen, mappings, { signal: current.controller.signal });
        const capturedAt = now(), seen = new Set();
        const connections = data.map(item => {
          seen.add(item.interfaceName);
          const measured = measureTraffic(item.stats, current.baseline.get(item.interfaceName), { monotonic: monotonic(), uptime: item.uptime });
          current.baseline.set(item.interfaceName, measured.next);
          return { id: hash([signature, item.interfaceName]), interfaceName: item.interfaceName, description: item.description,
            mappings: item.mappings, sampledAt: capturedAt, downloadBps: measured.downloadBps, uploadBps: measured.uploadBps,
            receivedBytes: measured.receivedBytes, sentBytes: measured.sentBytes, intervalSeconds: measured.intervalSeconds, state: measured.reset ? 'warming' : 'live' };
        });
        for (const name of current.baseline.keys()) if (!seen.has(name)) current.baseline.delete(name);
        return { router: routerName, source: 'router', state: connections.length ? 'ok' : 'idle', capturedAt, connections, message: connections.length ? '' : 'Нет подключённого VPN из маппингов этого роутера.' };
      } catch (error) {
        current.keen = null; current.baseline.clear();
        return { router: routerName, source: 'router', state: 'error', capturedAt: now(), connections: [], error: current.controller.signal.aborted ? 'Роутер не ответил вовремя. Мониторинг повторит запрос позже.' : safeMessage(error.message) };
      } finally { clearTimeout(timer); }
    })().then(snapshot => {
      current.snapshot = snapshot; current.nextRead = now() + (snapshot.state === 'error' ? 15000 : 5000);
      return structuredClone(snapshot);
    }).finally(() => { current.inflight = null; });
    return current.inflight;
  };
  return { get, close: () => { for (const value of entries.values()) value.controller?.abort(); entries.clear(); } };
}
