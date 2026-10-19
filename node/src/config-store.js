// HTTP representation and optimistic concurrency are separate from YAML persistence.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig, dumpConfig, validateConfig } from './config.js';
import { httpError } from './security.js';

export const PASSWORD_MASK = '••••••••';
const revisionKey = randomBytes(32);
export const configRevision = cfg => createHmac('sha256', revisionKey).update(dumpConfig(cfg)).digest('hex');
export function configSnapshot(file) {
  const config = loadConfig(file);
  return { config, revision: configRevision(config) };
}
export function requireRevision(config, revision) {
  if (!revision) throw httpError(428, 'Обновите конфигурацию перед сохранением');
  const expected = configRevision(config);
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || !timingSafeEqual(Buffer.from(revision), Buffer.from(expected))) throw httpError(409, 'Конфигурация уже изменена в другом окне. Обновите страницу и повторите изменения');
}
export function publicConfig(config) {
  const result = structuredClone(config);
  for (const server of Object.values(result.servers)) for (const conn of Object.values(server.connections)) conn.password = conn.password ? PASSWORD_MASK : '';
  for (const router of Object.values(result.routers)) router.password = router.password ? PASSWORD_MASK : '';
  return result;
}
export function mergePasswords(input, current, renames = {}) {
  let result;
  try { result = validateConfig(structuredClone(input)); }
  catch (error) { throw httpError(400, error.message); }
  const oldName = (kind, name) => Object.entries(renames[kind] || {}).find(([, next]) => next === name)?.[0] || name;
  const restore = (target, source) => {
    if (target.password !== PASSWORD_MASK) return;
    if (!source || !Object.hasOwn(source, 'password')) throw httpError(400, 'Задайте пароль для нового подключения');
    target.password = source.password;
  };
  for (const [name, server] of Object.entries(result.servers)) {
    const old = oldName('servers', name);
    const original = Object.hasOwn(current.servers, old) ? current.servers[old] : null;
    for (const [id, conn] of Object.entries(server.connections)) restore(conn, original && Object.hasOwn(original.connections, id) ? original.connections[id] : null);
  }
  for (const [name, router] of Object.entries(result.routers)) {
    const old = oldName('routers', name);
    restore(router, Object.hasOwn(current.routers, old) ? current.routers[old] : null);
  }
  return result;
}
