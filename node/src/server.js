// Локальный веб-сервер: раздаёт UI и JSON-API поверх ядра (core.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, dumpConfig, parseConfigText } from './config.js';
import { prepare, computePlan, applyPlan, panelKind } from './core.js';
import { encryptAsync, decryptAsync } from './crypto.js';
import { WgEasy } from './wgeasy.js';
import { OpenVpnUi } from './openvpnui.js';
import { Keenetic } from './keenetic.js';
import { parseInterfaces } from './kparse.js';
import { createHash } from 'node:crypto';
import { upsertMapping, assertInterfaceMode } from './mappings.js';
import DisplayOrder from '../web/order.cjs';
import { readJsonBody, createAccessPolicy, checkRequestOrigin, responseHeaders, httpError, safeMessage } from './security.js';
import { configSnapshot, configRevision, publicConfig, mergePasswords, requireRevision, PASSWORD_MASK } from './config-store.js';
import { createSpeedTests } from './iperf.js';
import { createTrafficMonitor } from './traffic.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(DIR, '..', 'web', 'index.html');

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const readBody = readJsonBody;

// Подключение по паре сервер/подключение. Ошибку возвращаем текстом, а не бросаем,
// чтобы отдать 404 вместо 500.
function findConnection(cfg, serverName, connName) {
  const server = Object.hasOwn(cfg.servers, serverName) ? cfg.servers[serverName] : null;
  if (!server) return { error: `сервер "${serverName}" не найден` };
  const value = Object.hasOwn(server.connections, connName) ? server.connections[connName] : null;
  if (!value) return { error: `у сервера "${serverName}" нет подключения "${connName}"` };
  return { value };
}

const connOpts = (c) => ({ url: c.url, username: c.username, password: c.password, insecure: c.insecure === true });

function findMapping(cfg, name) {
  const m = cfg.mappings.find((x) => x.name === name);
  if (!m) throw new Error(`маппинг "${name}" не найден`);
  return m;
}

export function startServer(configPath, port = 8787, host = '127.0.0.1') {
  const access = createAccessPolicy(host);
  const routerWrites = new Set();
  const panelWrites = new Set();
  const speedTests = createSpeedTests({historyFile:path.join(path.dirname(configPath),'speed-tests.json')});
  const trafficMonitor = createTrafficMonitor();
  const configurationIdle = () => {
    if (routerWrites.size || panelWrites.size) throw httpError(409, 'Дождитесь завершения операции с устройством перед изменением конфигурации');
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;

      responseHeaders(res);
      if (p.startsWith('/api/')) {
        checkRequestOrigin(req);
        if (req.method === 'GET' && p === '/api/session') {
          sendJson(res, 200, { authenticated: access.authenticate(req, true, false), authRequired: access.required }); return;
        }
        if (req.method === 'POST' && p === '/api/logout') {
          await readBody(req, 4096); access.logout(req, res); sendJson(res, 200, { ok: true }); return;
        }
        if (req.method === 'POST' && p === '/api/login') {
          await readBody(req, 4096);
          if (!access.authenticate(req, false)) { sendJson(res, 401, { error: 'Неверный логин или пароль' }); return; }
          access.issueSession(req, res); sendJson(res, 200, { ok: true }); return;
        }
        if (!access.authenticate(req)) { sendJson(res, 401, { error: 'Требуется авторизация' }); return; }
      }

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(INDEX, 'utf8').replace(/\r\n?/g, '\n');
        responseHeaders(res, html);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && ['/mappings.js', '/mappings.css', '/sync.js', '/sync.css', '/speed.js', '/traffic.js', '/traffic.css', '/design.css', '/order.js'].includes(p)) {
        res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(path.join(DIR, '..', 'web', p === '/order.js' ? 'order.cjs' : p.slice(1)))); return;
      }

      // Список маппингов (без кредов) — для вкладки синхронизации.
      if (req.method === 'GET' && p === '/api/mappings') {
        const cfg = loadConfig(configPath);
        sendJson(res, 200, {
          mappings: DisplayOrder.mappings(cfg).map((m) => ({ name: m.name, server: m.server, connection: m.connection, client: m.client, router: m.router, interface: m.interface, enabled: m.enabled })),
          displayOrder: DisplayOrder.order(cfg),
          // Типы подключений нужны вкладке синхронизации для подписи строк.
          servers: Object.fromEntries(Object.entries(cfg.servers).map(([id, s]) => [
            id, { host: s.host || '', connections: Object.fromEntries(Object.entries(s.connections).map(([cid, c]) => [cid, { type: c.type }])) },
          ])),
        });
        return;
      }

      // Редактор получает конфиг с масками паролей и версией для защиты от перезаписи.
      if (req.method === 'GET' && p === '/api/config') {
        const snapshot = configSnapshot(configPath);
        sendJson(res, 200, { config: publicConfig(snapshot.config), revision: snapshot.revision });
        return;
      }

      // Сохранить весь конфиг.
      if (req.method === 'POST' && p === '/api/config') {
        const body = await readBody(req);
        configurationIdle();
        const current = loadConfig(configPath);
        requireRevision(current, body.revision);
        const updated = mergePasswords(body.config, current, body.renames);
        saveConfig(configPath, updated);
        sendJson(res, 200, { ok: true, config: publicConfig(updated), revision: configRevision(updated) });
        return;
      }

      // Мастер сохраняет одну связь, не перезаписывая доступы из старой вкладки.
      if (req.method === 'POST' && p === '/api/mapping-save') {
        const body = await readBody(req);
        configurationIdle();
        const cfg = loadConfig(configPath);
        let updated;
        try { updated = upsertMapping(cfg, body.mapping, body.previousName ?? null); }
        catch (error) { throw httpError(400, error.message); }
        saveConfig(configPath, updated);
        const mapping = body.previousName == null ? updated.mappings.at(-1) : updated.mappings.find((m) => m.name === body.previousName);
        sendJson(res, 200, { mapping, config: publicConfig(updated), revision: configRevision(updated) }); return;
      }

      if (req.method === 'POST' && p === '/api/mapping-remove') {
        const body = await readBody(req);
        configurationIdle();
        const cfg = loadConfig(configPath);
        findMapping(cfg, body.name);
        cfg.mappings = cfg.mappings.filter((m) => m.name !== body.name);
        saveConfig(configPath, cfg);
        sendJson(res, 200, { config: publicConfig(cfg), revision: configRevision(cfg) }); return;
      }

      // Экспорт конфига файлом (YAML, с кредами).
      if (req.method === 'GET' && p === '/api/export') {
        const text = dumpConfig(loadConfig(configPath));
        res.writeHead(200, {
          'Content-Type': 'application/x-yaml; charset=utf-8',
          'Content-Disposition': 'attachment; filename="keenetic-az-sync.config.yaml"',
        });
        res.end(text);
        return;
      }

      // Импорт конфига из текста (YAML или JSON).
      if (req.method === 'POST' && p === '/api/import') {
        const body = await readBody(req);
        configurationIdle();
        requireRevision(loadConfig(configPath), body.revision);
        let cfg;
        try { cfg = parseConfigText(body.text || ''); } catch (error) { throw httpError(400, error.message); }
        saveConfig(configPath, cfg);
        sendJson(res, 200, { ok: true, mappings: cfg.mappings.length });
        return;
      }

      // Зашифрованный экспорт: вернуть зашифрованный текст (скачивается на клиенте).
      if (req.method === 'POST' && p === '/api/export-enc') {
        const body = await readBody(req);
        const text = dumpConfig(loadConfig(configPath));
        sendJson(res, 200, { data: await encryptAsync(text, body.passphrase) });
        return;
      }

      // Зашифрованный импорт: расшифровать -> разобрать -> сохранить.
      if (req.method === 'POST' && p === '/api/import-enc') {
        const body = await readBody(req);
        configurationIdle();
        const current = loadConfig(configPath);
        requireRevision(current, body.revision);
        let cfg;
        try { cfg = parseConfigText(await decryptAsync(body.text || '', body.passphrase)); }
        catch (error) { throw error.status ? error : httpError(400, error.message); }
        configurationIdle();
        requireRevision(loadConfig(configPath), body.revision);
        saveConfig(configPath, cfg);
        sendJson(res, 200, { ok: true, mappings: cfg.mappings.length });
        return;
      }

      // План / применение.
      if (req.method === 'POST' && (p === '/api/plan' || p === '/api/apply')) {
        const body = await readBody(req);
        const cfg = loadConfig(configPath);
        const m = findMapping(cfg, body.name);
        const sourceRevision = configRevision(cfg);
        const opts = { withSecrets: !!body.withSecrets, noRestart: !!body.noRestart, activate: body.activate === true };
        const writing = p === '/api/apply';
        if (routerWrites.has(m.router)) { sendJson(res, 409, { error: 'На этом роутере уже выполняется проверка, применение, переключение VPN или тест скорости. Дождитесь завершения' }); return; }
        if (writing && !body.planToken) throw httpError(428, 'Сначала проверьте план изменений');
        routerWrites.add(m.router);
        try {
          const ctx = await prepare(cfg, m);
          const plan = computePlan(ctx, opts);
          assertInterfaceMode(plan, body.interfaceMode);
          const planToken = createHash('sha256').update(JSON.stringify({ sourceRevision, mapping: m, commands: plan.commands, ovpn: plan.ovpn, activation: plan.activation, mode: plan.mode })).digest('hex');
          if (writing) requireRevision(loadConfig(configPath), sourceRevision);
          if (p === '/api/apply' && body.planToken !== planToken) {
            sendJson(res, 409, { error: 'Настройки изменились после проверки. Проверьте план ещё раз перед применением' }); return;
          }
          const safePlan = {
            mode: plan.mode, total: plan.total, restart: plan.restart,
            pubkeyChanged: plan.pubkeyChanged, error: plan.error ? safeMessage(plan.error) : null,
            meta: plan.meta, changes: plan.changes || null,
          };

          if (p === '/api/plan') { sendJson(res, 200, { plan: safePlan, planToken }); return; }
          if (plan.mode === 'error') { sendJson(res, 200, { plan: safePlan, result: { ok: false, errors: [plan.error] } }); return; }
          if (plan.mode === 'noop') { sendJson(res, 200, { plan: safePlan, result: { ok: true, applied: 0, remaining: 0, noop: true } }); return; }
          const result = await applyPlan(ctx, plan);
          if(result.errors)result.errors=result.errors.map(safeMessage);
          sendJson(res, 200, { plan: safePlan, result });
          return;
        } finally { routerWrites.delete(m.router); }
      }

      if (req.method === 'GET' && p === '/api/traffic') {
        const router = url.searchParams.get('router');
        if (!router) throw httpError(400, 'Не указан роутер');
        const cfg = loadConfig(configPath);
        if (!Object.hasOwn(cfg.routers, router)) throw httpError(404, 'Роутер не найден');
        const mappingNames = url.searchParams.has('mapping') ? url.searchParams.getAll('mapping') : null;
        const source = url.searchParams.get('source') || 'server';
        if (source === 'router' && routerWrites.has(router) && !speedTests.busy(router)) {
          sendJson(res, 200, { router, source, state: 'busy', capturedAt: Date.now(), connections: [], message: 'На роутере применяются настройки. Мониторинг продолжится после завершения.' }); return;
        }
        const snapshot = await trafficMonitor.get(cfg, router, { mappingNames, source });
        sendJson(res, 200, { ...snapshot, servedAt: Date.now() }); return;
      }
      if (req.method === 'GET' && p === '/api/speed-test') {
        sendJson(res, 200, { job: speedTests.get(url.searchParams.get('id')), jobs: speedTests.list() }); return;
      }
      if (req.method === 'POST' && p === '/api/speed-test-cancel') {
        const body = await readBody(req, 4096);
        if (typeof body.id !== 'string') throw httpError(400, 'Не задан идентификатор теста');
        sendJson(res, 200, { job: speedTests.cancel(body.id), jobs: speedTests.list() }); return;
      }
      if (req.method === 'POST' && p === '/api/speed-test') {
        const body = await readBody(req, 4096);
        if (typeof body.name !== 'string' || !['local', 'world'].includes(body.target ?? 'local') || (body.reverse !== undefined && typeof body.reverse !== 'boolean')) throw httpError(400, 'Некорректные параметры теста');
        const cfg = loadConfig(configPath), mapping = cfg.mappings.find(m => m.name === body.name);
        if (!mapping) throw httpError(404, 'Подключение не найдено');
        if (mapping.enabled === false) throw httpError(400, 'Для этого подключения выключена синхронизация');
        if (routerWrites.has(mapping.router)) throw httpError(409, 'На этом роутере уже выполняется операция. Дождитесь завершения.');
        const router = Object.hasOwn(cfg.routers, mapping.router) ? cfg.routers[mapping.router] : null;
        if (!router) throw httpError(404, 'Роутер не найден');
        const keen = new Keenetic({ endpoints: router.endpoints || router.endpoint, username: router.username, password: router.password, insecure: router.insecure === true });
        routerWrites.add(mapping.router);
        try {
          const vpnServer = cfg.servers[mapping.server];
          const connection = vpnServer?.connections?.[mapping.connection];
          const serverKey = String(vpnServer?.host || (connection?.url ? new URL(connection.url).hostname : mapping.server)).trim().toLowerCase().replace(/\.$/, '');
          const job = speedTests.start(keen, { mapping, serverKey, target: body.target ?? 'local', reverse: body.reverse ?? true }, () => routerWrites.delete(mapping.router));
          sendJson(res, 202, { job, jobs: speedTests.list() });
        } catch (error) { routerWrites.delete(mapping.router); throw error; }
        return;
      }

      // Статус интерфейсов роутера (какое соединение активно).
      if (req.method === 'GET' && p === '/api/router-status') {
        const routerName = url.searchParams.get('router');
        if (!routerName) { sendJson(res, 400, { error: 'нужен параметр router' }); return; }
        const cfg = loadConfig(configPath);
        const router = Object.hasOwn(cfg.routers, routerName) ? cfg.routers[routerName] : null;
        if (!router) { sendJson(res, 404, { error: `роутер "${routerName}" не найден` }); return; }

        try {
          const keen = new Keenetic({
            endpoints: router.endpoints || router.endpoint,
            username: router.username, password: router.password,
            insecure: router.insecure === true,
          });
          await keen.connect();
          const states = await keen.interfaceStates();
          sendJson(res, 200, { ok: true, interfaces: states });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: safeMessage(e.message), interfaces: {} });
        }
        return;
      }

      // Переключение активного соединения роутера (включает выбранное, выключает остальные).
      if (req.method === 'POST' && p === '/api/router-active') {
        const body = await readBody(req);
        const { router: routerName, mapping: mappingName } = body;
        if (!routerName || !mappingName) {
          sendJson(res, 400, { error: 'нужны параметры router и mapping' });
          return;
        }
        const cfg = loadConfig(configPath);
        const router = Object.hasOwn(cfg.routers, routerName) ? cfg.routers[routerName] : null;
        if (!router) { sendJson(res, 404, { error: `роутер "${routerName}" не найден` }); return; }
        const targetMapping = findMapping(cfg, mappingName);
        if (targetMapping.router !== routerName) { sendJson(res, 400, { error: 'Связь относится к другому роутеру' }); return; }
        const allMappings = (cfg.mappings || []).filter((m) => m.router === routerName);
        const allDescs = allMappings.map((m) => m.interface);

        if (routerWrites.has(routerName)) { sendJson(res, 409, { error: 'На этом роутере уже выполняется применение или переключение VPN. Дождитесь завершения' }); return; }
        routerWrites.add(routerName);
        try {
          const keen = new Keenetic({
            endpoints: router.endpoints || router.endpoint,
            username: router.username, password: router.password,
            insecure: router.insecure === true,
          });
          await keen.connect();
          await keen.switchActiveInterface(targetMapping.interface, allDescs);
          const states = await keen.interfaceStates();
          sendJson(res, 200, { ok: true, active: targetMapping.interface, interfaces: states });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: safeMessage(e.message) });
        } finally { routerWrites.delete(routerName); }
        return;
      }

      // Список клиентов конкретного подключения сервера.
      if (req.method === 'GET' && p === '/api/panel-clients') {
        const serverName = url.searchParams.get('server');
        const connName = url.searchParams.get('connection');
        if (!serverName || !connName) { sendJson(res, 400, { error: 'нужны параметры server и connection' }); return; }

        const cfg = loadConfig(configPath);
        const conn = findConnection(cfg, serverName, connName);
        if (conn.error) { sendJson(res, 404, { error: conn.error }); return; }

        if (panelKind(conn.value) === 'openvpn') {
          const ui = new OpenVpnUi(connOpts(conn.value));
          await ui.login();
          sendJson(res, 200, { clients: await ui.clients() });
          return;
        }

        const wg = new WgEasy(connOpts(conn.value));
        await wg.login();
        const list = await wg.clients();
        sendJson(res, 200, { clients: list.map((c) => c.name) });
        return;
      }

      // Список WireGuard интерфейсов роутера.
      if (req.method === 'GET' && p === '/api/router-interfaces') {
        const routerName = url.searchParams.get('router');
        if (!routerName) { sendJson(res, 400, { error: 'отсутствует параметр router' }); return; }
        const cfg = loadConfig(configPath);
        const router = Object.hasOwn(cfg.routers, routerName) ? cfg.routers[routerName] : null;
        if (!router) { sendJson(res, 404, { error: `роутер "${routerName}" не найден` }); return; }

        const keen = new Keenetic({ endpoints: router.endpoints || router.endpoint, username: router.username, password: router.password, insecure: router.insecure === true });
        await keen.connect();

        // Для openvpn-маппингов список берём из OpenVPN-интерфейсов, а не из running-config.
        if (url.searchParams.get('kind') === 'openvpn') {
          const ovpn = await keen.openvpnInterfaces();
          sendJson(res, 200, { interfaces: ovpn.map((i) => i.description || i.name).filter(Boolean) });
          return;
        }

        const lines = await keen.runningConfig();
        const ifaces = parseInterfaces(lines);
        const interfaces = ifaces
          .filter((i) => i.name.startsWith('Wireguard') || i.name.startsWith('wireguard'))
          .map((i) => i.description || i.name)
          .filter(Boolean);
        sendJson(res, 200, { interfaces });
        return;
      }

      // Создание клиента в панели. Отдельное явное действие: apply никогда
      // ничего не создаёт на панели сам.
      if (req.method === 'POST' && p === '/api/panel-client-create') {
        const body = await readBody(req);
        if (typeof body.name !== 'string') throw httpError(400, 'Не задано имя клиента');
        const name = body.name.trim();
        if (!body.server || !body.connection) { sendJson(res, 400, { error: 'нужны параметры server и connection' }); return; }
        if (!name) { sendJson(res, 400, { error: 'не задано имя клиента' }); return; }

        const cfg = loadConfig(configPath);
        const conn = findConnection(cfg, body.server, body.connection);
        if (conn.error) { sendJson(res, 404, { error: conn.error }); return; }
        const panelKey = JSON.stringify([body.server, body.connection]);
        if (panelWrites.has(panelKey)) throw httpError(409, 'На этой панели уже создаётся клиент. Дождитесь завершения');
        panelWrites.add(panelKey);
        try {
            if (panelKind(conn.value) === 'openvpn') {
              const ui = new OpenVpnUi(connOpts(conn.value));
              await ui.login();
              sendJson(res, 200, { client: await ui.createClient(name) });
              return;
            }

            const wg = new WgEasy(connOpts(conn.value));
            await wg.login();
            if ((await wg.clients()).some((c) => c.name === name)) {
              sendJson(res, 409, { error: `клиент "${name}" на панели уже есть` });
              return;
            }

            const created = await wg.createClient(name);
            sendJson(res, 200, { client: { id: created.id, name: created.name, address: created.ipv4Address || '' } });
            return;
        } finally { panelWrites.delete(panelKey); }
      }

      // Идентификация роутера (имя/модель/прошивка). Принимает либо имя из конфига,
      // либо креды прямо из формы — чтобы работало и для ещё не сохранённого роутера.
      if (req.method === 'POST' && p === '/api/router-identity') {
        const body = await readBody(req);
        let conn;
        if (body.router) {
          const cfg = loadConfig(configPath);
          const router = Object.hasOwn(cfg.routers, body.router) ? cfg.routers[body.router] : null;
          if (!router) { sendJson(res, 404, { error: `роутер "${body.router}" не найден` }); return; }
          conn = { endpoints: router.endpoints || router.endpoint, username: router.username, password: router.password, insecure: router.insecure === true };
        } else {
          const endpoints = (Array.isArray(body.endpoints) ? body.endpoints : [body.endpoints]).filter(Boolean);
          if (!endpoints.length) { sendJson(res, 400, { error: 'не заданы endpoints' }); return; }
          let password = body.password;
          if (password === PASSWORD_MASK) {
            const cfg = loadConfig(configPath);
            const router = Object.hasOwn(cfg.routers, body.previousRouter) ? cfg.routers[body.previousRouter] : null;
            if (!router) throw httpError(400, 'Введите пароль нового роутера');
            password = router.password;
          }
          conn = { endpoints, username: body.username, password, insecure: body.insecure === true };
        }

        const keen = new Keenetic(conn);
        await keen.connect();
        sendJson(res, 200, { identity: await keen.identity() });
        return;
      }

      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (!res.headersSent && !res.destroyed) sendJson(res, e.status || 500, { error: safeMessage(e.message) });
    }
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.on('close', () => { speedTests.close(); trafficMonitor.close(); });
  server.listen(port, host, () => {
    console.log(`Keenetic AZ Sync GUI:  http://localhost:${port}`);
    console.log(`с телефона/LAN: http://<IP-этого-ПК>:${port}`);
    console.log('Ctrl+C — остановить.');
  });
  return server;
}
