// Адрес VPN-клиента задаётся отдельно от URL административных панелей.
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export function configDomain(server) {
  if (server.useDomain !== undefined && typeof server.useDomain !== 'boolean') {
    throw new Error('«Использовать доменное имя в конфигурации» должно быть галочкой');
  }
  const value = server.domain ?? '';
  if (typeof value !== 'string') throw new Error('доменное имя должно быть строкой');
  const raw = value.trim().replace(/\.$/, '');
  if (!raw) {
    if (server.useDomain) throw new Error('укажите доменное имя для конфигурации');
    return '';
  }
  // Только DNS-имя: схема, порт, путь и управляющие символы недопустимы.
  if (/[\s/:\\@?#]/u.test(raw)) throw new Error('укажите доменное имя без протокола, порта и пути');
  const domain = domainToASCII(raw).toLowerCase();
  const labels = domain.split('.');
  if (!domain || domain.length > 253 || isIP(domain) || labels.length < 2
      || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('некорректное доменное имя (пример: vpn.example.com)');
  }
  return domain;
}

export function useWireguardDomain(conf, server) {
  if (!server.useDomain) return conf;
  const domain = configDomain(server);
  const endpoint = String(conf.peer.endpoint || '').match(/^(?:\[[^\]]+\]|[^:\s]+):(\d+)$/);
  if (!endpoint) throw new Error('в конфиге WireGuard отсутствует корректный Endpoint с портом');
  return { ...conf, peer: { ...conf.peer, endpoint: `${domain}:${endpoint[1]}` } };
}

export function useOpenvpnDomain(text, server) {
  if (!server.useDomain) return text;
  const domain = configDomain(server);
  let inlineBlock = null;
  let replaced = false;
  const result = text.replace(/[^\r\n]+/g, (line) => {
    // Сертификаты, ключи и прочие inline-данные сохраняем побайтово.
    if (inlineBlock) {
      if (line.trim().toLowerCase() === `</${inlineBlock}>`) inlineBlock = null;
      return line;
    }
    const open = line.trim().match(/^<([a-z0-9_-]+)>/i);
    if (open && open[1].toLowerCase() !== 'connection') {
      if (!line.toLowerCase().includes(`</${open[1].toLowerCase()}>`)) inlineBlock = open[1].toLowerCase();
      return line;
    }
    return line.replace(/^([ \t]*remote[ \t]+)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^ \t]+)(?=[ \t]|$)/, (_, prefix) => {
      replaced = true;
      return prefix + domain;
    });
  });
  if (!replaced) throw new Error('в конфиге OpenVPN отсутствует директива remote');
  return result;
}
