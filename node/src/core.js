// Ядро: подключение, вычисление плана (структурно) и применение.
// Используется и CLI (sync.js), и веб-сервером (server.js).
import { WgEasy } from './wgeasy.js';
import { OpenVpnUi } from './openvpnui.js';
import { Keenetic } from './keenetic.js';
import { ovpnDiff, ovpnMeta, normalizeOvpn, freeOvpnName, validateOvpn } from './ovpn.js';
import { parseConf } from './conf.js';
import { parseInterfaces, parseRoutes, parseNameServers, freeWgName } from './kparse.js';
import { buildDesired, desiredInterface } from './transform.js';
import { resolveMapping } from './config.js';
import { parseCidr, allowToken } from './util/net.js';
import { useWireguardDomain, useOpenvpnDomain } from './endpoint.js';
import Awg from '../web/awg.cjs';

const diffSets = (current, desired) => ({
  add: [...desired].filter((x) => !current.has(x)),
  del: [...current].filter((x) => !desired.has(x)),
});
export const maskCmd = (cmd) => cmd.replace(/((?:private-key|preshared-key|header-protection-key) )\S+/g, '$1***')
  .replace(/[A-Za-z0-9+/]{43}=/g, '***');
const supportsExtendedAsc = (version) => {
  const m = String(version || '').match(/\b(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 5 || (major === 5 && minor >= 1);
};

const routeAddCmd = (name, key) => {
  const { ip, prefix, mask } = parseCidr(key);
  return prefix === 32 ? `ip route ${ip} ${name} auto !AntiZapretAWG` : `ip route ${ip} ${mask} ${name} auto !AntiZapretAWG`;
};
const routeDelCmd = (name, key) => {
  const { ip, prefix, mask } = parseCidr(key);
  return prefix === 32 ? `no ip route ${ip} ${name}` : `no ip route ${ip} ${mask} ${name}`;
};
const allowAddCmd = (name, pub, key) => `interface ${name} wireguard peer ${pub} allow-ips ${allowToken(key)}`;
const allowDelCmd = (name, pub, key) => `interface ${name} wireguard peer ${pub} no allow-ips ${allowToken(key)}`;
const route6AddCmd = (name, key) => `ipv6 route ${key} ${name} auto !AntiZapretAWG`;
const route6DelCmd = (name, key) => `no ipv6 route ${key} ${name}`;

function peerCreateCmds(name, want, allowIpsSet, label) {
  const pub = want.peer.pubkey;
  const head = `interface ${name} wireguard peer ${pub}`;
  const cmds = [label ? `${head} !${label}` : head];
  if (want.peer.endpoint) cmds.push(`${head} endpoint ${want.peer.endpoint}`);
  if (want.peer.keepalive) cmds.push(`${head} keepalive-interval ${want.peer.keepalive}`);
  if (want.peer.psk) cmds.push(`${head} preshared-key ${want.peer.psk}`);
  for (const key of allowIpsSet) cmds.push(`${head} allow-ips ${allowToken(key)}`);
  cmds.push(`${head} connect`);
  return cmds;
}

function interfaceCreateCmds(name, description, want, desired, label) {
  const cmds = [`interface ${name}`, `interface ${name} description ${description}`];
  if (want.privateKey) cmds.push(`interface ${name} wireguard private-key ${want.privateKey}`);
  cmds.push(`interface ${name} security-level public`);
  if (want.address.ip) cmds.push(`interface ${name} ip address ${want.address.ip} 255.255.255.255`);
  if (want.mtu) cmds.push(`interface ${name} ip mtu ${want.mtu}`);
  cmds.push(`interface ${name} ip tcp adjust-mss pmtu`);
  if (want.ascLine) cmds.push(`interface ${name} wireguard asc ${want.ascLine}`);
  cmds.push(...peerCreateCmds(name, want, desired.allowIps, label));
  for (const d of want.dns) cmds.push(`ip name-server ${d} "" on ${name}`);
  for (const key of desired.awgRoutes) cmds.push(routeAddCmd(name, key));
  for (const key of desired.awgRoutes6) cmds.push(route6AddCmd(name, key));
  for (const [key, info] of desired.dnsRoutes) cmds.push(`ip route ${key.split('/')[0]} ${info.gw} ${name} auto !AntiZapretDNS`);
  cmds.push(`interface ${name} up`);
  return cmds;
}

function paramDiff(iface, want, nsMap, withSecrets) {
  const out = [];
  const name = iface.name;
  const pub = iface.peer.pubkey;
  if (want.address.ip && (!iface.address || iface.address.ip !== want.address.ip))
    out.push({ label: `ip address → ${want.address.ip}`, cmd: `interface ${name} ip address ${want.address.ip} 255.255.255.255` });
  if (want.mtu && String(iface.mtu) !== String(want.mtu))
    out.push({ label: `ip mtu → ${want.mtu}`, cmd: `interface ${name} ip mtu ${want.mtu}` });
  if (want.ascLine && !Awg.equal(iface.ascLine, want.ascLine))
    out.push({ label: `wireguard asc (obfuscation)`, cmd: `interface ${name} wireguard asc ${want.ascLine}` });
  if (want.peer.endpoint && iface.peer.endpoint !== want.peer.endpoint)
    out.push({ label: `endpoint → ${want.peer.endpoint}`, cmd: `interface ${name} wireguard peer ${pub} endpoint ${want.peer.endpoint}` });
  if (want.peer.keepalive && String(iface.peer.keepalive) !== String(want.peer.keepalive))
    out.push({ label: `keepalive → ${want.peer.keepalive}`, cmd: `interface ${name} wireguard peer ${pub} keepalive-interval ${want.peer.keepalive}` });
  const curDns = nsMap.get(name) || new Set();
  for (const d of want.dns) if (!curDns.has(d)) out.push({ label: `+ name-server ${d}`, cmd: `ip name-server ${d} "" on ${name}` });
  for (const d of curDns) if (!want.dns.includes(d)) out.push({ label: `− name-server ${d}`, cmd: `no ip name-server ${d} "" on ${name}` });
  if (withSecrets) {
    if (want.privateKey) out.push({ label: `private-key (форс)`, cmd: `interface ${name} wireguard private-key ${want.privateKey}` });
    if (want.peer.psk) out.push({ label: `preshared-key (форс)`, cmd: `interface ${name} wireguard peer ${pub} preshared-key ${want.peer.psk}` });
  }
  return out;
}

// Тип подключения: WG-Easy (по умолчанию) или openvpn-ui.
export const panelKind = (conn) => (conn?.type === 'openvpn-ui' ? 'openvpn' : 'wireguard');

const keenFor = (router) => new Keenetic({
  endpoints: router.endpoints || router.endpoint,
  username: router.username, password: router.password, insecure: router.insecure === true,
});

async function prepareStep(label, operation) {
  try { return await operation(); }
  catch (cause) {
    const message = ['ECONNRESET', 'EPIPE'].includes(cause.code)
      ? 'соединение разорвано. Повторите проверку; заново создавать клиента не нужно'
      : cause.message;
    throw new Error(`${label}: ${message}`, { cause });
  }
}

// Подключается к openvpn-ui и роутеру: качает .ovpn и читает OpenVPN-интерфейсы.
async function prepareOvpn(conn, router, m, server, managedDescriptions) {
  const ui = new OpenVpnUi({ url: conn.url, username: conn.username, password: conn.password, insecure: conn.insecure === true });
  await prepareStep(`Вход в панель «${m.server}»`, () => ui.login());
  const ovpnText = useOpenvpnDomain(await prepareStep(`Загрузка OpenVPN-конфигурации клиента «${m.client}»`, () => ui.configByName(m.client)), server);
  validateOvpn(ovpnText, true);

  const keen = keenFor(router);
  const base = await prepareStep(`Подключение к роутеру «${m.router}»`, () => keen.connect());
  const ovpnIfaces = await prepareStep(`Чтение OpenVPN-интерфейсов роутера «${m.router}»`, () => keen.openvpnInterfaces());
  const managedStates = managedDescriptions.length > 1
    ? await prepareStep(`Чтение состояний VPN роутера «${m.router}»`, () => keen.interfaceStates()) : {};
  return { kind: 'openvpn', panel: conn, router, keen, base, ovpnText, ovpnIfaces, mapping: m, managedDescriptions, managedStates };
}

// Подключается к WG-Easy и роутеру, тянет .conf и running-config.
export async function prepare(cfg, m) {
  const { server, conn, router } = resolveMapping(cfg, m);
  const managedDescriptions = [...new Set([...cfg.mappings.filter(x => x.router === m.router).map(x => x.interface), m.interface])];
  if (panelKind(conn) === 'openvpn') return prepareOvpn(conn, router, m, server, managedDescriptions);

  const panel = conn;
  const wg = new WgEasy({ url: panel.url, username: panel.username, password: panel.password, insecure: panel.insecure === true });
  await prepareStep(`Вход в панель «${m.server}»`, () => wg.login());
  const { client, conf: confText } = await prepareStep(`Загрузка конфигурации клиента «${m.client}» с панели «${m.server}»`, () => wg.configByName(m.client));
  const conf = useWireguardDomain(parseConf(confText), server);
  const keen = new Keenetic({ endpoints: router.endpoints || router.endpoint, username: router.username, password: router.password, insecure: router.insecure === true });
  const base = await prepareStep(`Подключение к роутеру «${m.router}»`, () => keen.connect());
  const lines = await prepareStep(`Чтение настроек роутера «${m.router}»`, () => keen.runningConfig());
  const keenOsVersion = await keen.keenOsVersion();
  const iface = parseInterfaces(lines).find(i => i.description === m.interface || (!i.description && i.name === m.interface));
  const currentModern = iface?.ascLine ? Awg.tokens(iface.ascLine).length === 31 : false;
  const modernAsc = Awg.hasModern(conf.awg) || currentModern
    ? await prepareStep(`Проверка поддержки AmneziaWG 3.1 на «${m.router}»`, () => keen.supportsModernAsc(iface?.name)) : false;
  return { kind: 'wireguard', panel, router, keen, base, client, conf, lines, mapping: m, keenOsVersion, modernAsc, extendedAsc: supportsExtendedAsc(keenOsVersion), managedDescriptions };
}

// Команды создания OpenVPN-интерфейса. Сам .ovpn заливается отдельно (RCI-деревом),
// поэтому здесь только обвязка.
function ovpnCreateCmds(name, description) {
  return [
    `interface ${name}`,
    `interface ${name} description ${description}`,
    `interface ${name} security-level public`,
    `interface ${name} ip tcp adjust-mss pmtu`,
    `interface ${name} openvpn accept-routes`,
  ];
}

// План для OpenVPN: сравнение текста .ovpn. Маршруты приходят пушем с сервера
// (на интерфейсе accept-routes), поэтому ничего вычислять не нужно.
function computeOvpnPlan(ctx, { noRestart = false } = {}) {
  const { ovpnText, ovpnIfaces, mapping, base, panel } = ctx;
  const info = ovpnMeta(ovpnText);
  const meta = {
    kind: 'openvpn', panelUrl: panel.url, client: mapping.client, routerBase: base,
    interface: mapping.interface, remote: info.remote, proto: info.proto,
    cipher: info.cipher, lines: info.lines, blocks: info.blocks,
  };

  const iface = ovpnIfaces.find((i) => i.description === mapping.interface) || ovpnIfaces.find((i) => !i.description && i.name === mapping.interface);
  if (!iface) {
    const name = freeOvpnName(ovpnIfaces);
    return {
      mode: 'create',
      meta: { ...meta, newName: name },
      changes: null,
      commands: ovpnCreateCmds(name, mapping.interface),
      ovpn: { ifaceName: name, text: normalizeOvpn(ovpnText), create: true },
      restart: false, total: 1,
    };
  }

  const diff = ovpnDiff(iface.config, ovpnText);
  const needRestart = iface.connected && !noRestart && !diff.identical;
  return {
    mode: diff.identical ? 'noop' : 'update',
    meta: { ...meta, ifaceName: iface.name, enabled: iface.enabled, connected: iface.connected, acceptRoutes: iface.acceptRoutes },
    changes: { ovpnAdd: diff.added, ovpnDel: diff.removed, ovpnBlocks: diff.blocksChanged },
    commands: [],
    ovpn: diff.identical ? null : { ifaceName: iface.name, text: normalizeOvpn(ovpnText), create: false },
    restart: needRestart, total: diff.total,
  };
}

// Применение плана OpenVPN: обвязка команд + заливка конфига RCI-деревом.
async function applyOvpnPlan(ctx, plan) {
  const { keen } = ctx;
  if (!plan.ovpn && !plan.activation?.enable && !plan.activation?.disable.length) return { ok: true, applied: 0, remaining: 0, noop: true };
  const { ifaceName = plan.meta.ifaceName, text, create = false } = plan.ovpn || {};

  if (create) {
    const res = await keen.rci(plan.commands);
    const errors = Keenetic.collectErrors(res);
    if (errors.length) return { ok: false, errors };
  }

  if (plan.ovpn) await keen.writeOpenvpnConfig(ifaceName, text);

  const tail = [];
  if (create || plan.activation?.enable) tail.push(`interface ${ifaceName} up`);
  else if (plan.restart) tail.push(`interface ${ifaceName} down`, `interface ${ifaceName} up`);
  tail.push('system configuration save');
  const res2 = await keen.rci(tail);
  const errors2 = Keenetic.collectErrors(res2);
  if (errors2.length) return { ok: false, errors: errors2 };

  // Перечитываем и убеждаемся, что на роутере лежит именно то, что мы отправили
  // (сравнение структурное — роутер переставляет пустые строки). Сама запись уже
  // подтверждена роутером, поэтому сбой перечитывания не делает применение неудачным.
  const applied = (create ? plan.commands.length : 0) + (plan.ovpn ? 1 : 0) + tail.length;
  try {
    const after = (await keen.openvpnInterfaces()).find((i) => i.name === ifaceName);
    return {
      ok: true, applied, created: create, foundAfter: !!after,
      remaining: after && (!plan.ovpn || ovpnDiff(after.config, text).total === 0) ? 0 : 1,
    };
  } catch {
    return { ok: true, applied, created: create, foundAfter: null, remaining: 0, verified: false };
  }
}

// Считает структурный план изменений (ничего не пишет).
function computeBasePlan(ctx, opts = {}) {
  if (ctx.kind === 'openvpn') return computeOvpnPlan(ctx, opts);
  const { withSecrets = false, noRestart = false } = opts;
  const { conf, lines, mapping, client, base, panel, keenOsVersion, extendedAsc, modernAsc = false } = ctx;
  const ifaces = parseInterfaces(lines);
  const iface = ifaces.find((i) => i.description === mapping.interface) || ifaces.find((i) => !i.description && i.name === mapping.interface);
  const desired = buildDesired(conf);
  const currentModern = iface?.ascLine ? Awg.tokens(iface.ascLine).length === 31 : false;
  const want = desiredInterface(conf, extendedAsc, modernAsc, currentModern);
  const meta = {
    kind: 'wireguard',
    panelUrl: panel.url, client: client.name, clientId: client.id,
    allowedIps: conf.peer.allowedIps.length, routerBase: base,
    interface: mapping.interface,
    keenOsVersion: keenOsVersion || 'unknown', ascFormat: Awg.hasModern(conf.awg) || currentModern ? '3.1' : extendedAsc ? 'extended' : 'short',
  };

  if (!iface) {
    const name = freeWgName(ifaces);
    if (!want.privateKey) return { mode: 'error', meta, error: 'в .conf нет PrivateKey — создать интерфейс нельзя', total: 0, commands: [] };
    const label = mapping.peerLabel || mapping.server;
    const commands = interfaceCreateCmds(name, mapping.interface, want, desired, label);
    return {
      mode: 'create', meta: { ...meta, newName: name, addr: want.address.ip, mtu: want.mtu, dns: want.dns, hasAsc: !!want.ascLine, endpoint: want.peer.endpoint, peer: want.peer.pubkey, peerLabel: label, allowCount: desired.allowIps.size, routeCount: desired.awgRoutes.size + desired.awgRoutes6.size + 1 },
      changes: null, commands, restart: false, total: commands.length,
    };
  }
  if (!iface.peer) return { mode: 'error', meta, error: `у интерфейса ${iface.name} нет пира`, total: 0, commands: [] };

  const routes = parseRoutes(lines, iface.name);
  const nsMap = parseNameServers(lines);
  const pubkeyChanged = want.peer.pubkey && iface.peer.pubkey !== want.peer.pubkey;
  if (pubkeyChanged && !withSecrets) return {
    mode: 'error', meta: { ...meta, ifaceName: iface.name }, total: 0, commands: [], pubkeyChanged: true,
    error: 'Изменился публичный ключ пира. Включите обновление секретных ключей и проверьте план повторно',
  };
  const peerReplacement = pubkeyChanged ? [
    `interface ${iface.name} no wireguard peer ${iface.peer.pubkey}`,
    ...peerCreateCmds(iface.name, want, desired.allowIps, mapping.peerLabel || mapping.server),
  ] : [];
  const allow = diffSets(iface.allowIps, desired.allowIps);
  const awg = diffSets(routes.awg, desired.awgRoutes);
  const awg6 = diffSets(routes.awg6, desired.awgRoutes6);
  const params = paramDiff(iface, want, nsMap, withSecrets);

  const dnsAdd = [], dnsDel = [];
  for (const [key, wi] of desired.dnsRoutes) {
    const ip = key.split('/')[0]; const cur = routes.dns.get(key);
    if (!cur) dnsAdd.push(`ip route ${ip} ${wi.gw} ${iface.name} auto !AntiZapretDNS`);
    else if (cur.gw !== wi.gw) { dnsDel.push(`no ip route ${ip} ${cur.gw} ${iface.name}`); dnsAdd.push(`ip route ${ip} ${wi.gw} ${iface.name} auto !AntiZapretDNS`); }
  }
  for (const [key, cur] of routes.dns) if (!desired.dnsRoutes.has(key)) dnsDel.push(`no ip route ${key.split('/')[0]} ${cur.gw} ${iface.name}`);

  const total = allow.add.length + allow.del.length + awg.add.length + awg.del.length
    + awg6.add.length + awg6.del.length + params.length + dnsAdd.length + dnsDel.length + peerReplacement.length;
  const needRestart = iface.enabled === true && !noRestart && total > 0;

  const adds = [
    ...params.map((p) => p.cmd),
    ...allow.add.map((k) => allowAddCmd(iface.name, iface.peer.pubkey, k)),
    ...awg.add.map((k) => routeAddCmd(iface.name, k)),
    ...awg6.add.map((k) => route6AddCmd(iface.name, k)),
    ...dnsAdd,
  ];
  const dels = [
    ...allow.del.map((k) => allowDelCmd(iface.name, iface.peer.pubkey, k)),
    ...awg.del.map((k) => routeDelCmd(iface.name, k)),
    ...awg6.del.map((k) => route6DelCmd(iface.name, k)),
    ...dnsDel,
  ];
  const restart = needRestart ? [`interface ${iface.name} down`, `interface ${iface.name} up`] : [];

  return {
    mode: total === 0 ? 'noop' : 'update',
    meta: { ...meta, ifaceName: iface.name, peerLabel: iface.peer.label || '', enabled: iface.enabled, pubkeyChanged },
    changes: {
      params: params.map((p) => p.label),
      allowAdd: allow.add, allowDel: allow.del,
      awgAdd: awg.add, awgDel: awg.del,
      awg6Add: awg6.add, awg6Del: awg6.del,
      dnsAdd, dnsDel,
    },
    commands: [...adds, ...dels, ...peerReplacement, ...restart],
    restart: needRestart, pubkeyChanged, total,
  };
}

// Включение VPN — отдельное намерение; обычное обновление выключенного
// интерфейса не должно переключать трафик. Создание всегда включает новый VPN.
export function computePlan(ctx, opts = {}) {
  const plan = computeBasePlan(ctx, opts);
  if (plan.mode === 'error' || !(opts.activate || plan.mode === 'create' || plan.restart)) return plan;
  const target = plan.meta.newName || plan.meta.ifaceName;
  const managed = new Set(ctx.managedDescriptions || [ctx.mapping.interface]);
  const states = ctx.kind === 'openvpn'
    ? Object.values(ctx.managedStates || {}).map(i => ({ ...i, enabled: i.up }))
    : parseInterfaces(ctx.lines);
  const disable = states.filter(i => i.name !== target && /^(Wireguard|OpenVPN)\d+$/i.test(i.name) && i.enabled === true && managed.has(i.description || i.name))
    .map(i => ({ name: i.name, description: i.description || i.name }));
  const enable = plan.mode === 'create' || (opts.activate === true && plan.meta.enabled !== true);
  const activation = { target, wasEnabled: plan.meta.enabled === true, enable, disable };
  const appendUp = ctx.kind !== 'openvpn' && enable && !plan.commands.includes(`interface ${target} up`);
  if (appendUp) plan.commands.push(`interface ${target} up`);
  plan.activation = activation;
  plan.meta.activation = activation;
  plan.total += disable.length + (appendUp || (ctx.kind === 'openvpn' && enable && plan.mode !== 'create') ? 1 : 0);
  if (plan.mode === 'noop' && (disable.length || enable)) plan.mode = 'update';
  return plan;
}

// Применяет план: отправляет команды + save, перепроверяет подсети.
export async function applyPlan(ctx, plan) {
  if (!plan.activation) return applyPreparedPlan(ctx, plan);
  const { keen } = ctx, a = plan.activation;
  let started = false;
  try {
    if (a.disable.length) {
      const off = await keen.rci(a.disable.map(i => `interface ${i.name} down`));
      const errors = Keenetic.collectErrors(off);
      if (errors.length) throw new Error(errors.join('; '));
    }
    started = true;
    const result = await applyPreparedPlan(ctx, plan);
    if (!result.ok) throw new Error((result.errors || ['Не удалось применить настройки']).join('; '));
    return { ...result, applied: (result.applied || 0) + a.disable.length };
  } catch (e) {
    const errors = [e.message];
    // Не повторяем неудачную запись. Освобождаем адрес нового VPN и возвращаем
    // ранее включённые управляемые интерфейсы отдельной попыткой восстановления.
    const restore = started ? [`interface ${a.target} down`] : [];
    restore.push(...a.disable.map(i => `interface ${i.name} up`));
    if (started && a.wasEnabled && !a.disable.length) restore.push(`interface ${a.target} up`);
    if (restore.length) {
      try {
        const result = await keen.rci([...restore, 'system configuration save']);
        const failures = Keenetic.collectErrors(result);
        if (failures.length) throw new Error(failures.join('; '));
        errors.push('Выполнено восстановление включения VPN; проверьте состояние соединений');
      } catch (restoreError) { errors.push('Не удалось восстановить прежнее подключение: ' + restoreError.message); }
    }
    return { ok: false, errors };
  }
}

async function applyPreparedPlan(ctx, plan) {
  if (ctx.kind === 'openvpn') return applyOvpnPlan(ctx, plan);
  const { keen, conf, mapping } = ctx;
  if (!plan.commands.length && !plan.activation?.disable.length) return { ok: true, applied: 0, remaining: 0 };
  const res = await keen.rci([...plan.commands, 'system configuration save']);
  const errors = Keenetic.collectErrors(res);
  if (errors.length) return { ok: false, errors };

  let lines2;
  try { lines2 = await keen.runningConfig(); }
  catch {
    if (Awg.hasModern(conf.awg)) return { ok: false, applied: plan.commands.length, remaining: null, verified: false, foundAfter: null,
      errors: ['Настройки отправлены, но не удалось проверить ASC 3.1 чтением с роутера. Выполните проверку повторно'] };
    return { ok: true, applied: plan.commands.length, remaining: 0, verified: false, foundAfter: null };
  }
  const if2 = parseInterfaces(lines2).find((i) => i.description === mapping.interface || (!i.description && i.name === mapping.interface));
  let remaining = 0;
  let ascVerified = true;
  if (if2 && if2.peer) {
    const desired = buildDesired(conf);
    const r2 = parseRoutes(lines2, if2.name);
    remaining =
      diffSets(if2.allowIps, desired.allowIps).add.length + diffSets(if2.allowIps, desired.allowIps).del.length +
      diffSets(r2.awg, desired.awgRoutes).add.length + diffSets(r2.awg, desired.awgRoutes).del.length +
      diffSets(r2.awg6, desired.awgRoutes6).add.length + diffSets(r2.awg6, desired.awgRoutes6).del.length;
    const wantAsc = desiredInterface(conf, ctx.extendedAsc, ctx.modernAsc, Awg.tokens(if2.ascLine).length === 31).ascLine;
    if (wantAsc && !Awg.equal(if2.ascLine, wantAsc)) { ascVerified = false; remaining++; }
  }
  if (!if2 && Object.keys(conf.awg || {}).length) { ascVerified = false; remaining++; }
  return { ok: ascVerified, applied: plan.commands.length, remaining, created: plan.mode === 'create', foundAfter: !!if2,
    ...(!ascVerified ? { errors: ['Роутер не подтвердил параметры ASC после записи. Проверьте план изменений повторно'] } : {}) };
}
