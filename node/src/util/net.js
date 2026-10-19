// IPv4 CIDR / mask helpers.
import { isIP } from 'node:net';

export function cidrToMask(prefix) {
  const p = Number(prefix);
  if (!Number.isInteger(p) || p < 0 || p > 32) throw new Error('Некорректный IPv4-префикс');
  const octets = [];
  let bits = p;
  for (let i = 0; i < 4; i++) {
    const active = Math.min(Math.max(bits, 0), 8);
    octets.push(active === 0 ? 0 : (0xff << (8 - active)) & 0xff);
    bits -= 8;
  }
  return octets.join('.');
}

export function maskToPrefix(mask) {
  if (isIP(mask) !== 4) throw new Error('Некорректная маска IPv4');
  const bits = mask.split('.').map(o => Number(o).toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) throw new Error('Маска IPv4 должна быть непрерывной');
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

export function isIpv4(s) {
  return isIP(s) === 4;
}

export function isV6(s) {
  return isIP(s) === 6;
}

// "10.1.167.0/24" | "10.1.167.0" | "2001:db8::/32" -> { ip, prefix, mask, key, v6 }
export function parseCidr(s) {
  const str = s.trim();
  const i = str.lastIndexOf('/');
  const ip = i < 0 ? str : str.slice(0, i);
  if (!isIP(ip) || ip.includes('%') || (i >= 0 && !/^\d+$/.test(str.slice(i + 1)))) throw new Error('Некорректный IP/CIDR');
  const prefix = i < 0 ? (isV6(ip) ? 128 : 32) : Number(str.slice(i + 1));
  const v6 = isV6(ip);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (v6 ? 128 : 32)) throw new Error('Некорректный CIDR-префикс');
  return { ip, prefix, v6, mask: v6 ? null : cidrToMask(prefix), key: `${ip}/${prefix}` };
}

// Токен для команды allow-ips: v4 = "addr mask", v6 = "addr prefixlen" (обе space-формы).
export function allowToken(key) {
  const { ip, prefix, mask, v6 } = parseCidr(key);
  return v6 ? `${ip} ${prefix}` : `${ip} ${mask}`;
}
