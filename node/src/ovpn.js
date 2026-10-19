// Разбор и сравнение .ovpn. Содержимое inline-блоков (<key>, <cert>, …) наружу
// не отдаём никогда — только факт «изменился»: там лежит приватный ключ клиента.
const BLOCK_RE = /<([a-z0-9-]+)>([\s\S]*?)<\/\1>/gi;
export function validateOvpn(text, checkHooks = false) {
  const stack = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line)) continue;
    const opaque = stack.some(name => name !== 'connection');
    if (checkHooks && !opaque) {
      const directive = line.trim().split(/\s+/)[0].replace(/^--/, '').toLowerCase();
      if (['up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'plugin', 'tls-verify', 'auth-user-pass-verify', 'client-connect', 'client-disconnect', 'learn-address', 'config', 'management', 'cd', 'chroot'].includes(directive)
          || (directive === 'script-security' && !/^\s*(?:--)?script-security\s+[01]\s*(?:[#;].*)?$/.test(line))) throw new Error('OpenVPN-конфигурация содержит недопустимый скрипт или внешний файл');
    }
    for (const tag of line.matchAll(/<(\/?)([a-z0-9-]+)>/gi)) {
      const name = tag[2].toLowerCase();
      if (!tag[1]) stack.push(name);
      else if (stack.pop() !== name) throw new Error('Повреждены inline-блоки OpenVPN');
    }
  }
  if (stack.length) throw new Error('Не закрыт inline-блок OpenVPN');
}

// Роутер хранит конфиг без завершающего перевода строки, панель отдаёт с ним —
// без нормализации любой конфиг вечно выглядел бы изменившимся.
export const normalizeOvpn = (text) => String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');

export function splitOvpn(text) {
  validateOvpn(text);
  const blocks = new Map();
  const rest = normalizeOvpn(text).replace(BLOCK_RE, (_, name, body) => {
    blocks.set(name.toLowerCase(), body.trim());
    return '';
  });
  const directives = rest.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { directives, blocks };
}

// Человекочитаемая сводка различий: что за директивы приехали/уехали и какие
// блоки поменялись. Тела блоков не раскрываем.
export function ovpnDiff(currentText, desiredText) {
  const cur = splitOvpn(currentText);
  const des = splitOvpn(desiredText);

  const curSet = new Set(cur.directives);
  const desSet = new Set(des.directives);
  const added = des.directives.filter((l) => !curSet.has(l));
  const removed = cur.directives.filter((l) => !desSet.has(l));

  const blocksChanged = [];
  for (const name of new Set([...cur.blocks.keys(), ...des.blocks.keys()])) {
    const a = cur.blocks.get(name);
    const b = des.blocks.get(name);
    if (a === b) continue;
    if (a === undefined) blocksChanged.push(`+ <${name}>`);
    else if (b === undefined) blocksChanged.push(`− <${name}>`);
    else blocksChanged.push(`<${name}> изменился`);
  }

  // Сравнение именно структурное: роутер при сохранении переставляет пустые строки
  // (например, добавляет пустую строку перед <ca>), и побайтовое сравнение
  // считало бы конфиг изменившимся при каждой проверке.
  const total = added.length + removed.length + blocksChanged.length;
  return { added, removed, blocksChanged, identical: total === 0, total };
}

// Первое свободное имя OpenVPNn — по аналогии с freeWgName для WireGuard.
export function freeOvpnName(ifaces) {
  const used = new Set(
    ifaces.map((i) => i.name).filter((n) => /^OpenVPN\d+$/.test(n)).map((n) => Number(n.slice(7)))
  );
  let i = 0;
  while (used.has(i)) i++;
  return `OpenVPN${i}`;
}

// Кратко о конфиге — для карточки плана.
export function ovpnMeta(text) {
  const { directives, blocks } = splitOvpn(text);
  const find = (p) => directives.find((l) => l.startsWith(p)) || '';
  return {
    remote: find('remote ').replace(/^remote\s+/, '') || null,
    proto: find('proto ').replace(/^proto\s+/, '') || null,
    cipher: find('cipher ').replace(/^cipher\s+/, '') || null,
    blocks: [...blocks.keys()],
    lines: directives.length,
  };
}
