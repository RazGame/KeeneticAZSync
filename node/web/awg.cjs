/* Shared AmneziaWG configuration rules for the converter and router sync. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Awg = factory();
})(globalThis, function () {
  const baseKeys = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'H1', 'H2', 'H3', 'H4'];
  const signatures = ['I1', 'I2', 'I3', 'I4', 'I5'];
  const ranges = ['ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts'];
  const flags = ['RandomTrailers', 'DisableCookies'];
  const modern = ['HeaderProtectionKey', ...ranges, ...flags];
  const keys = [...baseKeys, 'S3', 'S4', ...signatures, ...modern];
  const keyMap = new Map(keys.map(k => [k.toLowerCase(), k]));
  const own = (object, key) => Object.hasOwn(object, key);
  const invalid = key => { throw new Error(`Некорректный параметр AmneziaWG: ${key}`); };
  const pair = (value, max, key) => {
    if (!/^\d+(?:-\d+)?$/.test(value)) invalid(key);
    const parts = String(value).split('-').map(Number);
    const result = [parts[0], parts[1] ?? parts[0]];
    if (result.some(v => !Number.isSafeInteger(v) || v > max) || result[0] > result[1]) invalid(key);
    return result;
  };
  const flag = (value, key) => {
    if (/^(on|true|1)$/i.test(value)) return '1';
    if (/^(off|false|0)$/i.test(value)) return '0';
    invalid(key);
  };
  const headerKey = value => {
    if (value === '' || value === '0' || value === 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') return '';
    if (!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(value)) invalid('HeaderProtectionKey');
    return value;
  };
  function validate(input) {
    const result = {};
    for (const [rawKey, rawValue] of Object.entries(input || {})) {
      const key = keyMap.get(rawKey.toLowerCase());
      if (!key) continue;
      const value = String(rawValue).trim();
      if (own(result, key) && result[key] !== value) invalid(key);
      if (key === 'HeaderProtectionKey') result[key] = headerKey(value);
      else if (signatures.includes(key)) {
        if (/["\\\x00-\x1f;]/.test(value) || value.length > 4096) invalid(key);
        result[key] = value;
      } else if (flags.includes(key)) result[key] = flag(value, key);
      else {
        const [lo, hi] = pair(value, key.startsWith('H') ? 4294967295 : 65535, key);
        if (!key.startsWith('H') && !ranges.includes(key) && lo !== hi) invalid(key);
        result[key] = lo === hi ? String(lo) : `${lo}-${hi}`;
      }
    }
    if (result.HeaderProtectionKey && ['S1', 'S2', 'S3', 'S4'].some(k => Number(result[k] || 0) < 12)) {
      throw new Error('HeaderProtectionKey требует S1, S2, S3 и S4 не меньше 12; проверьте конфигурацию сервера');
    }
    const headers = ['H1', 'H2', 'H3', 'H4'].map((k, i) => pair(result[k] ?? String(i + 1), 4294967295, k));
    if (headers.some((a, i) => headers.some((b, j) => i < j && a[0] <= b[1] && b[0] <= a[1]))) {
      throw new Error('Диапазоны H1–H4 AmneziaWG не должны пересекаться');
    }
    return result;
  }
  function parseFields(text) {
    const values = {};
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const heading = line.match(/^\[([^\]]+)\]$/);
      if (heading) { section = heading[1].toLowerCase(); continue; }
      if (section !== 'interface' || !line || line.startsWith('#')) continue;
      const item = line.match(/^([A-Za-z0-9]+)\s*=\s*(.*)$/);
      const key = item && keyMap.get(item[1].toLowerCase());
      if (!key) continue;
      if (own(values, key)) invalid(key);
      values[key] = item[2];
    }
    return validate(values);
  }
  const hasModern = awg => modern.some(k => own(awg || {}, k));
  function build(input, { extended = false, modern: allowModern = false, resetModern = false } = {}) {
    const awg = validate(input);
    if (!Object.keys(awg).length && !resetModern) return null;
    const useModern = hasModern(awg) || resetModern;
    if (useModern && !allowModern) throw new Error('Этой конфигурации AmneziaWG 3.1 нужна NetcrazeOS/KeeneticOS с поддержкой ASC 3.1 (5.2 Alpha 11 или новее)');
    const tokens = baseKeys.map((k, i) => awg[k] ?? (i >= 5 ? String(i - 4) : '0'));
    if (useModern || (extended && ['S3', 'S4', ...signatures].some(k => own(awg, k)))) {
      tokens.push(awg.S3 || '0', awg.S4 || '0', ...signatures.map(k => JSON.stringify(awg[k] || '')));
    }
    if (useModern) {
      tokens.push(JSON.stringify(awg.HeaderProtectionKey || ''));
      for (const key of ranges) tokens.push(...pair(awg[key] || '0', 65535, key).map(String));
      tokens.push(...flags.map(k => awg[k] || '0'));
    }
    const line = tokens.join(' ');
    if (line.length > 8000) throw new Error('Параметры AmneziaWG слишком длинные для команды роутера');
    return line;
  }
  function tokens(line) {
    if (!line) return [];
    const result = []; let tail = String(line).trim();
    while (tail) {
      const match = tail.match(/^(?:"([^"\\]*)"|([^\s"\\]+))(?:\s+|$)/);
      if (!match) throw new Error('Не удалось прочитать параметры ASC роутера');
      result.push(match[1] ?? match[2]); tail = tail.slice(match[0].length);
    }
    if (![9, 16, 31].includes(result.length)) throw new Error('Неизвестный формат ASC роутера; применение остановлено');
    return result;
  }
  function normalized(line) {
    const values = tokens(line);
    if (!values.length) return [];
    while (values.length < 16) values.push(values.length < 11 ? '0' : '');
    while (values.length < 31) values.push(values.length === 16 ? '' : '0');
    values[16] = headerKey(values[16]);
    for (let i = 0; i < values.length; i++) {
      if (i >= 11 && i <= 16) continue;
      const [lo, hi] = pair(values[i], i >= 5 && i <= 8 ? 4294967295 : 65535, 'ASC');
      values[i] = lo === hi ? String(lo) : `${lo}-${hi}`;
    }
    return values;
  }
  const equal = (a, b) => JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
  return { validate, parseFields, hasModern, build, tokens, equal };
});
