// Read-only, on-demand server telemetry. One shared read per VPN panel, no timers between requests.
import { createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WgEasy } from './wgeasy.js';
import { OpenVpnUi } from './openvpnui.js';
import { request } from './util/http.js';
import { httpError, safeMessage } from './security.js';
import DisplayOrder from '../web/order.cjs';

import { counter, measureTraffic } from './traffic-math.js';
import { createRouterTrafficMonitor } from './router-traffic.js';
export { measureTraffic } from './traffic-math.js';

// Normalize server directions: server TX = router download, server RX = router upload.
// Never return raw API objects: they may contain keys and other clients' addresses.
export function normalizePanelCounters(type, data, now = Date.now()) {
  if (type === 'wg-easy') {
    if (!Array.isArray(data) || data.length > 10000) throw new Error('Некорректный список клиентов WG-Easy');
    return data.map(client => {
      if (!client || typeof client.name !== 'string' || client.id === undefined) throw new Error('Некорректный клиент WG-Easy');
      const handshake = Date.parse(client.latestHandshakeAt);
      return { name: client.name, identity: String(client.id), active: client.enabled !== false && Number.isFinite(handshake) && now - handshake <= 180000 && handshake <= now + 60000,
        lastSeenAt: Number.isFinite(handshake) ? handshake : null,
        stats: { rxbytes: counter(client.transferTx).toString(), txbytes: counter(client.transferRx).toString() } };
    });
  }
  if (type !== 'openvpn-ui') throw new Error('Эта панель не поддерживает мониторинг');
  const clients = data?.data?.ClientList;
  if (!Array.isArray(clients) || clients.length > 10000) throw new Error('Не удалось прочитать текущие сессии OpenVPN');
  const groups = new Map();
  for (const client of clients) {
    if (typeof client?.CommonName !== 'string') throw new Error('Некорректная сессия OpenVPN');
    let group = groups.get(client.CommonName);
    if (!group) { group = { name: client.CommonName, sessions: [], rx: 0n, tx: 0n }; groups.set(client.CommonName, group); }
    group.sessions.push([client.ConnectedSinceT, client.ClientID, client.PeerID].map(v => String(v ?? '')).join(':'));
    group.rx += counter(client.BytesSent); group.tx += counter(client.BytesReceived);
  }
  return [...groups.values()].map(group => ({ name: group.name, identity: group.sessions.sort().join('|'), active: true, lastSeenAt: now,
    sharedSessions: group.sessions.length, stats: { rxbytes: group.rx.toString(), txbytes: group.tx.toString() } }));
}

export async function readPanelCounters(panel, type, { signal, now = Date.now() } = {}) {
  const r = await request({ url: panel.url + (type === 'wg-easy' ? '/api/client' : '/api/v1/session'),
    jar: panel.jar, insecure: panel.insecure, signal, timeout: 10000, maxBytes: 4 * 1024 * 1024 });
  if (r.status !== 200) throw new Error(`Не удалось прочитать трафик панели: HTTP ${r.status}`);
  let data;
  try { data = JSON.parse(r.text); } catch { throw new Error('Некорректный ответ статистики панели'); }
  return normalizePanelCounters(type, data, now);
}

export function createTrafficMonitor({ now = Date.now, monotonic = () => performance.now() / 1000,
  makePanel = options => options.type === 'openvpn-ui' ? new OpenVpnUi(options) : new WgEasy(options),
  read = readPanelCounters, timeoutMs = 20000 } = {}) {
  const entries = new Map(), key = randomBytes(32);
  const hash = value => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  async function panelSnapshot(options) {
    // Same URL/auth reused across aliases, routers and browser tabs.
    const signature = hash({ type: options.type, url: options.url, username: options.username, password: options.password, insecure: options.insecure === true });
    let entry = entries.get(signature);
    if (!entry) {
      for (const [id, old] of entries) if (!old.inflight && now() - old.touched > 600000) entries.delete(id);
      if (entries.size >= 64) {
        const oldest = [...entries].filter(([, value]) => !value.inflight).sort((a,b) => a[1].touched - b[1].touched)[0];
        if (!oldest) throw httpError(429, 'Слишком много запросов мониторинга');
        entries.delete(oldest[0]);
      }
      entry = { baseline: new Map(), panel: null, touched: now(), nextRead: 0, snapshot: null, inflight: null };
      entries.set(signature, entry);
    }
    entry.touched = now();
    if (entry.inflight) return entry.inflight;
    if (entry.snapshot && now() < entry.nextRead) return entry.snapshot;
    entry.controller = new AbortController();
    const timer = setTimeout(() => entry.controller.abort(), timeoutMs);
    entry.inflight = (async () => {
      try {
        if (!entry.panel) {
          entry.panel = makePanel(options);
          await entry.panel.login({ signal: entry.controller.signal });
        }
        const data = await read(entry.panel, options.type, { signal: entry.controller.signal, now: now() });
        const capturedAt = now(), time = monotonic(), seen = new Set(), clients = new Map();
        for (const item of data) {
          if (clients.has(item.name)) throw new Error('В панели несколько клиентов с одинаковым именем');
          seen.add(item.name);
          const old = entry.baseline.get(item.name);
          const measured = measureTraffic(item.stats, old?.identity === item.identity ? old.next : null, { monotonic: time });
          entry.baseline.set(item.name, { identity: item.identity, next: measured.next });
          clients.set(item.name, { ...item, measured });
        }
        for (const name of entry.baseline.keys()) if (!seen.has(name)) entry.baseline.delete(name);
        return { capturedAt, clients };
      } catch (error) {
        entry.panel = null; entry.baseline.clear();
        return { capturedAt: now(), error: entry.controller.signal.aborted ? 'Панель не ответила вовремя. Мониторинг повторит запрос позже.' : safeMessage(error.message) };
      } finally { clearTimeout(timer); }
    })().then(snapshot => {
      entry.snapshot = snapshot; entry.nextRead = now() + (snapshot.error ? 15000 : 5000);
      return snapshot;
    }).finally(() => { entry.inflight = null; });
    return entry.inflight;
  }
  const routerMonitor = createRouterTrafficMonitor({ now, monotonic, timeoutMs });
  const get = async (cfg, routerName, { mappingNames = null, source = 'server' } = {}) => {
    if (!['server', 'router'].includes(source)) throw httpError(400, 'Неизвестный источник статистики');
    if (source === 'router') return routerMonitor.get(cfg, routerName);
    if (!Object.hasOwn(cfg.routers, routerName)) throw httpError(404, 'Роутер не найден');
    const eligible = DisplayOrder.mappings(cfg).filter(m => m.router === routerName && m.enabled !== false);
    if (!eligible.length) return { router: routerName, state: 'excluded', capturedAt: now(), connections: [], message: 'У роутера нет подключений с включённой синхронизацией.' };
    const mappings = mappingNames === null ? eligible : eligible.filter(m => mappingNames.includes(m.name));
    const groups = new Map();
    for (const m of mappings) {
      const id = JSON.stringify([m.server, m.connection]), options = cfg.servers[m.server]?.connections?.[m.connection];
      if (!groups.has(id)) groups.set(id, { options, mappings: [] });
      groups.get(id).mappings.push(m);
    }
    const connections = [], errors = [], samples = [];
    // Limit fanout even for unusually large configurations.
    const queue = [...groups.values()];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const group = queue.shift();
        if (!group.options) { errors.push('Подключение к панели не найдено'); continue; }
        const snapshot = await panelSnapshot(group.options); samples.push(snapshot.capturedAt);
        if (snapshot.error) { errors.push(`${group.mappings[0].server}: ${snapshot.error}`); continue; }
        const aliases = new Map();
        for (const m of group.mappings) {
          const client = snapshot.clients.get(m.client);
          if (!client) {
            if (group.options.type === 'wg-easy') errors.push(`${m.server}: клиент «${m.client}» не найден`);
            continue; // absent OpenVPN client means no active session, not an API error.
          }
          // Known router state wins over handshake heuristics. Unknown state uses recent exchange.
          if (mappingNames === null && !client.active) continue;
          if (!aliases.has(m.client)) aliases.set(m.client, { client, mappings: [] });
          aliases.get(m.client).mappings.push({ name: m.name, server: m.server, connection: m.connection, client: m.client, interface: m.interface,
            protocol: group.options.type === 'openvpn-ui' ? 'OpenVPN' : 'AmneziaWG' });
        }
        for (const { client, mappings: linked } of aliases.values()) {
          const measured = client.measured;
          connections.push({ id: hash({ source: 'panel-v1', router: routerName, panel: group.options, mappings: linked }),
            interfaceName: linked[0].interface, description: linked[0].client, mappings: linked, sampledAt: snapshot.capturedAt,
            downloadBps: measured.downloadBps, uploadBps: measured.uploadBps, receivedBytes: measured.receivedBytes,
            sentBytes: measured.sentBytes, intervalSeconds: measured.intervalSeconds, lastSeenAt: client.lastSeenAt,
            sharedSessions: client.sharedSessions || 1, state: measured.reset ? 'warming' : 'live' });
        }
      }
    }));
    const rank = new Map(eligible.map((m,i) => [m.name,i]));
    connections.sort((a,b) => rank.get(a.mappings[0].name) - rank.get(b.mappings[0].name));
    return { router: routerName, source: 'server', state: connections.length ? 'ok' : errors.length ? 'error' : 'idle',
      capturedAt: samples.length ? Math.max(...samples) : now(), connections, error: connections.length ? undefined : errors.join('; '),
      message: errors.length && connections.length ? 'Часть панелей недоступна: ' + errors.join('; ') : connections.length ? '' : 'Нет активных VPN-клиентов для выбранных подключений.' };
  };
  return { get, close: () => { routerMonitor.close(); for (const value of entries.values()) value.controller?.abort(); entries.clear(); } };
}
