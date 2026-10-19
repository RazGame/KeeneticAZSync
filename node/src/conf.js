// Парсер WireGuard/AmneziaWG .conf -> структура.
import { isIP } from 'node:net';
import { parseCidr } from './util/net.js';

const AWG_KEYS = new Set([
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4',
  'I1', 'I2', 'I3', 'I4', 'I5',
]);

export function parseConf(text) {
  const iface = { dns: [] };
  const awg = {};
  const peer = { allowedIps: [] };
  let section = null;
  let peers = 0, interfaces = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\[Interface\]$/i.test(line)) { if (++interfaces > 1) throw new Error('Ожидается один Interface'); section = 'i'; continue; }
    if (/^\[Peer\]$/i.test(line)) { if (++peers > 1) throw new Error('Ожидается один Peer'); section = 'p'; continue; }

    const m = line.match(/^([A-Za-z0-9]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();

    if (section === 'i') {
      if (/^PrivateKey$/i.test(key)) iface.privateKey = val;
      else if (/^Address$/i.test(key)) iface.address = val.split(',')[0].trim();
      else if (/^MTU$/i.test(key)) iface.mtu = val;
      else if (/^DNS$/i.test(key)) iface.dns = val.split(',').map((s) => s.trim()).filter(Boolean);
      else if (AWG_KEYS.has(key)) awg[key] = val;
    } else if (section === 'p') {
      if (/^PublicKey$/i.test(key)) peer.publicKey = val;
      else if (/^PresharedKey$/i.test(key)) peer.presharedKey = val;
      else if (/^Endpoint$/i.test(key)) peer.endpoint = val;
      else if (/^PersistentKeepalive$/i.test(key)) peer.keepalive = val;
      else if (/^AllowedIPs$/i.test(key)) {
        peer.allowedIps = val.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  const token = (value, label) => { if (value && !/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error(`Некорректный ${label}`); };
  for (const [value, label] of [[iface.privateKey, 'PrivateKey'], [peer.publicKey, 'PublicKey'], [peer.presharedKey, 'PresharedKey']]) token(value, label);
  if (!iface.address || parseCidr(iface.address).v6) throw new Error('Ожидается IPv4 Address');
  if (!peer.publicKey || !peers) throw new Error('В конфигурации отсутствует Peer/PublicKey');
  for (const ip of peer.allowedIps) parseCidr(ip);
  for (const ip of iface.dns) if (!isIP(ip)) throw new Error('Некорректный DNS');
  const number = (value, max, min = 0) => value === undefined || (/^\d+$/.test(value) && Number(value) >= min && Number(value) <= max);
  if (!number(iface.mtu, 65535, 576) || !number(peer.keepalive, 65535)) throw new Error('Некорректные MTU/keepalive');
  if (peer.endpoint) {
    const m = peer.endpoint.match(/^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+):(\d+)$/);
    if (!m || !number(m[2], 65535, 1)) throw new Error('Некорректный Endpoint');
  }
  for (const [key, value] of Object.entries(awg)) {
    if (key.startsWith('I')) { if (/["\\\x00-\x1f;]/.test(value) || value.length > 4096) throw new Error(`Некорректный ${key}`); }
    else if (key.startsWith('H')) { if (!/^\d+(?:-\d+)?$/.test(value) || value.split('-').some(v => Number(v) > 4294967295)) throw new Error(`Некорректный ${key}`); }
    else if (!number(value, 65535)) throw new Error(`Некорректный ${key}`);
  }
  return { iface, awg, peer };
}

// Адрес интерфейса без префикса: "10.1.167.2/32" -> "10.1.167.2"
export function ifaceAddressIp(conf) {
  return conf.iface.address ? conf.iface.address.split('/')[0].trim() : null;
}
