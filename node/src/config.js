// Загрузка/валидация/сохранение YAML-конфига (серверы с подключениями, роутеры, маппинги).
import fs from 'node:fs';
import yaml from 'js-yaml';
import { configDomain } from './endpoint.js';
import DisplayOrder from '../web/order.cjs';
import nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { httpUrl } from './security.js';

export const CONFIG_LIMIT = 2 * 1024 * 1024;
function validateTree(value, active = new Set(), depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 50000 || depth > 40) throw new Error('Слишком сложная конфигурация');
  if (!value || typeof value !== 'object') return;
  if (active.has(value)) throw new Error('Циклическая конфигурация запрещена');
  active.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Недопустимый ключ конфигурации');
    validateTree(child, active, depth + 1, budget);
  }
  active.delete(value);
}
const commandText = (value, label) => {
  if (typeof value !== 'string' || value.length > 255 || /[\x00-\x1f\x7f;"\\]/.test(value)) throw new Error(`Недопустимое значение «${label}»`);
};
const record = value => value && typeof value === 'object' && !Array.isArray(value);

const CONN_ID = { 'openvpn-ui': 'ovpn', 'wg-easy': 'wg' };

const hostFromUrl = (url) => {
  try { return new URL(url).hostname; } catch { return ''; }
};

// Старый формат: panels[id] = {type,url,...}, mapping.panel = id.
// Новый: servers[id] = {host, connections:{connId:{type,url,...}}}, mapping.server + mapping.connection.
// Читаем оба, наружу отдаём всегда новый — конфиг пользователя переписывается только при сохранении.
export function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (cfg.servers || !cfg.panels) return cfg;

  const servers = {};
  const connOf = {};
  for (const [id, p] of Object.entries(cfg.panels)) {
    const conn = CONN_ID[p?.type] || 'wg';
    connOf[id] = conn;
    servers[id] = {
      host: hostFromUrl(p?.url),
      connections: {
        [conn]: {
          type: p?.type || 'wg-easy',
          url: p?.url || '', username: p?.username || '', password: p?.password || '',
          insecure: p?.insecure !== false,
        },
      },
    };
  }

  const mappings = (cfg.mappings || []).map((m) => {
    if (m.server) return m;
    const { panel, ...rest } = m;
    return { ...rest, server: panel, connection: connOf[panel] || 'wg' };
  });

  const { panels, ...restCfg } = cfg;
  return { ...restCfg, servers, mappings };
}

export function validateConfig(cfg) {
  validateTree(cfg);
  if (!cfg || typeof cfg !== 'object') throw new Error('config должен быть объектом');
  const c = migrateConfig(cfg);

  for (const k of ['servers', 'routers', 'mappings']) {
    if (!c[k]) throw new Error(`в конфиге нет секции "${k}"`);
  }
  if (!record(c.servers)) throw new Error('"servers" должен быть объектом');
  if (!record(c.routers)) throw new Error('"routers" должен быть объектом');
  if (!Array.isArray(c.mappings)) throw new Error('"mappings" должен быть списком');
  if (c.displayOrder !== undefined) {
    if (!c.displayOrder || typeof c.displayOrder !== 'object' || Array.isArray(c.displayOrder)) throw new Error('displayOrder должен быть объектом');
    for (const kind of ['servers', 'routers']) {
      const list = c.displayOrder[kind];
      if (list !== undefined && (!Array.isArray(list) || list.some(id => typeof id !== 'string'))) throw new Error(`displayOrder.${kind} должен быть списком названий`);
    }
    c.displayOrder = { ...c.displayOrder, ...DisplayOrder.order(c) };
  }

  for (const [id, s] of Object.entries(c.servers)) {
    commandText(id, 'сервер');
    if (!record(s) || !record(s.connections) || !Object.keys(s.connections).length) {
      throw new Error(`у сервера "${id}" нет ни одного подключения`);
    }
    try { configDomain(s); }
    catch (e) { throw new Error(`сервер «${id}»: ${e.message}`); }
    for (const conn of Object.values(s.connections)) {
      if (!record(conn)) throw new Error('Подключение должно быть объектом');
      for (const field of ['username', 'password', 'url']) if (conn[field] !== undefined && typeof conn[field] !== 'string') throw new Error(`Поле ${field} должно быть строкой`);
      if (conn.insecure !== undefined && typeof conn.insecure !== 'boolean') throw new Error('insecure должен быть логическим значением');
      if (conn.type !== undefined && !['wg-easy', 'openvpn-ui'].includes(conn.type)) throw new Error('Неизвестный тип панели');
      if (conn.url) httpUrl(conn.url);
    }
  }
  for (const [id, router] of Object.entries(c.routers)) {
    commandText(id, 'роутер');
    if (!record(router)) throw new Error('Роутер должен быть объектом');
    for (const field of ['username', 'password', 'endpoint']) if (router[field] !== undefined && typeof router[field] !== 'string') throw new Error(`Поле ${field} должно быть строкой`);
    if (router.endpoints !== undefined && (!Array.isArray(router.endpoints) || router.endpoints.some(e => typeof e !== 'string'))) throw new Error('endpoints должен быть списком URL');
    for (const endpoint of (Array.isArray(router?.endpoints) ? router.endpoints : [router?.endpoint]).filter(Boolean)) httpUrl(endpoint);
  }
  for (const m of c.mappings) {
    if (!record(m)) throw new Error('Связь должна быть объектом');
    if (m.interface) m.interface = String(m.interface).replace(/^["'\s]+|["'\s]+$/g, '');
    for (const f of ['name', 'server', 'connection', 'client', 'router', 'interface']) {
      if (!m[f]) throw new Error(`маппинг без поля "${f}"`);
      commandText(m[f], f);
    }
    if (m.peerLabel !== undefined) commandText(m.peerLabel, 'peerLabel');
  }

  // Имя маппинга — идентификатор: по нему ищут план и применение, поэтому дубликат
  // делает второй маппинг недостижимым. Не роняем конфиг, а разводим имена.
  const seen = new Set();
  c.mappings = c.mappings.map((m) => {
    if (!seen.has(m.name)) { seen.add(m.name); return m; }
    let i = 2;
    while (seen.has(`${m.name}-${i}`)) i++;
    const name = `${m.name}-${i}`;
    seen.add(name);
    return { ...m, name };
  });
  return c;
}

export function loadConfig(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    throw new Error(`не найден конфиг: ${path} (скопируй config.example.yaml в config.yaml)`);
  }
  return parseConfigText(raw);
}

export function saveConfig(path, cfg) {
  const text = dumpConfig(cfg);
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, path);
    if (process.platform !== 'win32') {
      let dir;
      try { dir = fs.openSync(nodePath.dirname(path), 'r'); fs.fsyncSync(dir); }
      catch {} finally { if (dir !== undefined) fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

export function dumpConfig(cfg) {
  const text = yaml.dump(validateConfig(cfg), { lineWidth: 120, quotingType: '"' });
  if (Buffer.byteLength(text) > CONFIG_LIMIT) throw new Error('Слишком большая конфигурация');
  return text;
}

export function parseConfigText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > CONFIG_LIMIT) throw new Error('Слишком большая конфигурация');
  let parsed;
  try { parsed = yaml.load(text) || {}; }
  catch (error) { throw new Error(`Некорректный YAML${error.mark ? ` (строка ${error.mark.line + 1})` : ''}`); }
  return validateConfig(parsed);
}

// Разрешает маппинг в конкретные объекты server/connection/router.
export function resolveMapping(cfg, m) {
  const server = Object.hasOwn(cfg.servers, m.server) ? cfg.servers[m.server] : null;
  if (!server) throw new Error(`сервер "${m.server}" не описан в config.servers`);
  const conn = Object.hasOwn(server.connections, m.connection) ? server.connections[m.connection] : null;
  if (!conn) {
    throw new Error(`у сервера "${m.server}" нет подключения "${m.connection}" (есть: ${Object.keys(server.connections).join(', ')})`);
  }
  const router = Object.hasOwn(cfg.routers, m.router) ? cfg.routers[m.router] : null;
  if (!router) throw new Error(`роутер "${m.router}" не описан в config.routers`);
  return { server, conn, router };
}
