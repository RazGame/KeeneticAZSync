// Парсер вывода `show running-config` (массив строк) -> интерфейсы, маршруты, name-server.
import { maskToPrefix } from './util/net.js';

// Вложенность задаётся отступами в содержимом строки:
// `interface WireguardN` (0), `    ip address ...` (4), `    wireguard peer ...` (4),
// `        endpoint/allow-ips ...` (8), `    up`/`    down` (4).
export function parseInterfaces(lines) {
  const ifaces = [];
  let cur = null;
  let curPeer = null;

  for (const s of lines) {
    const im = s.match(/^interface (\S+)/);
    if (im) {
      cur = {
        name: im[1], description: '', address: null, mtu: null,
        ascLine: null, global: false, enabled: null, peer: null, allowIps: new Set(),
      };
      ifaces.push(cur);
      curPeer = null;
      continue;
    }
    if (/^\S/.test(s)) { cur = null; curPeer = null; continue; }
    if (!cur) continue;

    let m;
    if ((m = s.match(/^\s+description (.+)$/))) {
      cur.description = m[1].trim().replace(/^["']|["']$/g, '').trim();
      continue;
    }
    if ((m = s.match(/^\s+ip address (\S+) (\S+)$/))) { cur.address = { ip: m[1], mask: m[2] }; continue; }
    if ((m = s.match(/^\s+ip mtu (\S+)$/))) { cur.mtu = m[1]; continue; }
    if (/^\s+ip global\b/.test(s)) { cur.global = true; continue; }
    if ((m = s.match(/^\s+wireguard asc (.+)$/))) { cur.ascLine = m[1].trim(); continue; }
    if ((m = s.match(/^\s+wireguard peer (\S+)(?: !(.+))?$/))) {
      curPeer = { pubkey: m[1], label: m[2] ? m[2].trim() : '', endpoint: null, keepalive: null };
      cur.peer = curPeer;
      continue;
    }
    if (curPeer) {
      if ((m = s.match(/^\s+endpoint (\S+)$/))) { curPeer.endpoint = m[1]; continue; }
      if ((m = s.match(/^\s+keepalive-interval (\S+)$/))) { curPeer.keepalive = m[1]; continue; }
      if ((m = s.match(/^\s+allow-ips (\S+) (\S+)$/))) {
        // v4: "addr 255.255.255.0" (маска), v6: "addr 32" (длина префикса)
        const prefix = /^\d+$/.test(m[2]) ? Number(m[2]) : maskToPrefix(m[2]);
        cur.allowIps.add(`${m[1]}/${prefix}`);
        continue;
      }
    }
    if (/^\s+up$/.test(s)) { cur.enabled = true; continue; }
    if (/^\s+down$/.test(s)) { cur.enabled = false; continue; }
  }

  return ifaces;
}

// Статические маршруты на интерфейсе.
// { awg: Set<v4 "net/prefix">, awg6: Set<v6 "net/prefix">, dns: Map<"net/prefix",{gw}> }
export function parseRoutes(lines, ifaceName) {
  const awg = new Set();
  const awg6 = new Set();
  const dns = new Map();

  for (const s of lines) {
    if (/^ip route /.test(s)) {
      const t = s.split(/\s+/);
      const ai = t.indexOf('auto');
      if (ai < 1 || t[ai - 1] !== ifaceName) continue;
      const dest = t[2]; // [ip, route, DEST, ...mids, IFACE, auto, !tag]
      const mids = t.slice(3, ai - 1);
      const tagTok = t.slice(ai + 1).find((x) => x.startsWith('!'));
      const tag = tagTok ? tagTok.slice(1) : '';
      if (tag === 'AntiZapretAWG') {
        const mask = mids.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
        awg.add(`${dest}/${mask ? maskToPrefix(mask) : 32}`);
      } else if (tag === 'AntiZapretDNS') {
        dns.set(`${dest}/32`, { gw: mids[0] || '' });
      }
    } else if (/^ipv6 route /.test(s)) {
      const t = s.split(/\s+/);
      const ai = t.indexOf('auto');
      if (ai < 1 || t[ai - 1] !== ifaceName) continue;
      const cidr = t[2]; // [ipv6, route, CIDR, IFACE, auto, !tag]
      const tagTok = t.slice(ai + 1).find((x) => x.startsWith('!'));
      if ((tagTok ? tagTok.slice(1) : '') === 'AntiZapretAWG') awg6.add(cidr);
    }
  }

  return { awg, awg6, dns };
}

// Привязки DNS к интерфейсам: Map<ifaceName, Set<dnsIp>>
export function parseNameServers(lines) {
  const map = new Map();
  for (const s of lines) {
    const m = s.match(/^ip name-server (\S+) "[^"]*" on (\S+)$/);
    if (!m) continue;
    if (!map.has(m[2])) map.set(m[2], new Set());
    map.get(m[2]).add(m[1]);
  }
  return map;
}

// Свободное имя WireguardN.
export function freeWgName(ifaces) {
  const used = new Set(
    ifaces.map((i) => i.name).filter((n) => /^Wireguard\d+$/.test(n)).map((n) => Number(n.slice(9)))
  );
  let i = 0;
  while (used.has(i)) i++;
  return `Wireguard${i}`;
}
