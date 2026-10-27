// Из распарсенного .conf строим желаемое состояние роутера для AntiZapret-интерфейса.
import { parseCidr } from './util/net.js';
import { ifaceAddressIp } from './conf.js';
import Awg from '../web/awg.cjs';

export const DNS_IP = '77.88.8.8';
export const DNS_KEY = '77.88.8.8/32';
export const REQUIRED_AWG = '14.16.0.0/14'; // паритет с REQUIRED_ROUTE_LINE конвертера

// Подсети: allow-ips у пира (v4+v6) + ip route (v4) + ipv6 route (v6) + DNS-маршрут.
export function buildDesired(conf) {
  const all = conf.peer.allowedIps.map((s) => s.trim()).filter(Boolean);
  const v4 = all.filter((x) => x.includes('.') && !x.includes(':')).map(parseCidr);
  const v6 = all.filter((x) => x.includes(':')).map(parseCidr);

  const allowIps = new Set([...v4.map((c) => c.key), ...v6.map((c) => c.key)]);
  allowIps.add(DNS_KEY); // конвертер инъектит 77.88.8.8/32 в AllowedIPs

  const awgRoutes = new Set(v4.map((c) => c.key).filter((k) => k !== DNS_KEY));
  awgRoutes.add(REQUIRED_AWG);
  const awgRoutes6 = new Set(v6.map((c) => c.key));

  const addrIp = ifaceAddressIp(conf);
  const dnsRoutes = new Map([[DNS_KEY, { gw: addrIp }]]);

  return { allowIps, awgRoutes, awgRoutes6, dnsRoutes, addrIp };
}

// Строка параметров AmneziaWG asc (без префикса `interface X wireguard asc`).
// Формат KeenOS 4.2+: Jc Jmin Jmax S1 S2 H1 H2 H3 H4.
// KeenOS 5.1+ дополнительно принимает S3 S4 I1 I2 I3 I4 I5 (только если они реально заданы).
export function buildAscLine(awg, extended = false, modern = false, resetModern = false) {
  return Awg.build(awg, { extended, modern, resetModern });
}

// Параметры интерфейса/пира из .conf.
export function desiredInterface(conf, extendedAsc = false, modernAsc = false, resetModern = false) {
  return {
    address: { ip: ifaceAddressIp(conf), mask: '255.255.255.255' },
    mtu: conf.iface.mtu || null,
    dns: (conf.iface.dns || []).filter((x) => x.includes('.') && !x.includes(':')),
    ascLine: buildAscLine(conf.awg, extendedAsc, modernAsc, resetModern),
    privateKey: conf.iface.privateKey || null,
    peer: {
      pubkey: conf.peer.publicKey,
      endpoint: conf.peer.endpoint || null,
      keepalive: conf.peer.keepalive || '25',
      psk: conf.peer.presharedKey || null,
    },
  };
}
