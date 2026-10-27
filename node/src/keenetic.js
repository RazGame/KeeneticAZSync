// Клиент Keenetic/Netcraze RCI: auth (LAN + cloud с ретраями), parse-команды, чтение конфига.
import crypto from 'node:crypto';
import { request, createJar } from './util/http.js';
import { setTimeout as delay } from 'node:timers/promises';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class Keenetic {
  constructor({ endpoints, username, password, insecure = false }) {
    this.endpoints = (Array.isArray(endpoints) ? endpoints : [endpoints]).map((e) => e.replace(/\/$/, ''));
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.base = null;
    this.jar = null;
  }

  async _authOn(base, signal) {
    const jar = createJar();
    let realm, challenge;
    // Облако (KeenDNS) может отдать 503/пусто на первый запрос — будит туннель. Ретраим.
    // Короткий per-attempt timeout: мёртвый endpoint фейлится быстро, а не висит.
    for (let i = 0; i < 4; i++) {
      signal?.throwIfAborted();
      const r = await request({ url: base + '/auth', jar, insecure: this.insecure, timeout: 8000, signal }).catch(error => {
        if (signal?.aborted) throw error;
        return null;
      });
      if (r) {
        realm = r.headers['x-ndm-realm'];
        challenge = r.headers['x-ndm-challenge'];
      }
      if (realm && challenge) break;
      await delay(1500, undefined, { signal });
    }
    if (!realm || !challenge) throw new Error('нет challenge (роутер недоступен/туннель спит)');

    const token = sha256(challenge + md5(`${this.username}:${realm}:${this.password}`));
    const body = JSON.stringify({ login: this.username, password: token });
    const ar = await request({
      url: base + '/auth', method: 'POST', jar, insecure: this.insecure,
      headers: { 'Content-Type': 'application/json' }, body, timeout: 12000, signal,
    });
    if (ar.status !== 200) throw new Error(`auth HTTP ${ar.status}`);
    return { jar, realm };
  }

  async connect({ signal } = {}) {
    const errs = [];
    for (const base of this.endpoints) {
      try {
        signal?.throwIfAborted();
        const { jar } = await this._authOn(base, signal);
        this.base = base;
        this.jar = jar;
        return base;
      } catch (e) {
        if (signal?.aborted) throw e;
        errs.push(`${base} — ${e.message}`);
      }
    }
    throw new Error('не удалось авторизоваться ни на одном endpoint:\n      ' + errs.join('\n      '));
  }

  // commands: массив строк CLI. Возвращает распарсенный ответ RCI.
  async rci(commands) {
    if (!Array.isArray(commands) || commands.some(c => typeof c !== 'string' || c.length > 8192 || /[\r\n\0;]/.test(c))) throw new Error('Недопустимая команда RCI');
    const body = JSON.stringify(commands.map((parse) => ({ parse })));
    const r = await request({
      url: this.base + '/rci/', method: 'POST', jar: this.jar, insecure: this.insecure,
      headers: { 'Content-Type': 'application/json' }, body, timeout: 40000,
    });
    if (r.status !== 200) throw new Error(`RCI HTTP ${r.status}`);
    let data;
    try { data = JSON.parse(r.text); } catch { throw new Error('RCI вернул не-JSON'); }
    if (!data || typeof data !== 'object') throw new Error('RCI: неожиданная структура ответа');
    return data;
  }

  // Собирает ошибки из ответа RCI (status: "error").
  static collectErrors(data) {
    const errs = [];
    const walk = (value, depth = 0) => {
      if (depth > 40) throw new Error('Слишком сложный ответ RCI');
      if (!value || typeof value !== 'object') return;
      if (value.status === 'error') errs.push(value.message || 'Ошибка записи RCI');
      else if (typeof value.error === 'string' && value.error) errs.push(value.error);
      for (const item of Object.values(value)) walk(item, depth + 1);
    };
    walk(data);
    return [...new Set(errs)];
  }

  async runningConfig() {
    const r = await request({ url: this.base + '/rci/show/running-config', jar: this.jar, insecure: this.insecure, timeout: 30000 });
    if (r.status !== 200) throw new Error(`running-config HTTP ${r.status}`);
    let data;
    try { data = JSON.parse(r.text); } catch { throw new Error('running-config: не-JSON'); }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.message) ? data.message : null;
    if (!arr) throw new Error('running-config: неожиданная структура');
    return arr.map((x) => (typeof x === 'string' ? x : x?.message ?? ''));
  }

  // GET с ретраями: после записи конфига роутер (особенно через облачный туннель)
  // может разорвать соединение — одиночный ECONNRESET это не повод падать.
  async _getJson(path, { tries = 3, timeout = 25000 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await request({ url: this.base + path, jar: this.jar, insecure: this.insecure, timeout });
        if (r.status !== 200) throw new Error(`${path} HTTP ${r.status}`);
        return JSON.parse(r.text);
      } catch (e) {
        last = e;
        if (i < tries - 1) await new Promise((res) => setTimeout(res, 1500));
      }
    }
    throw new Error(`${path}: ${last?.message || 'не прочитался'}`);
  }

  // OpenVPN-интерфейсы вместе с их .ovpn. Тело конфига в running-config не попадает,
  // поэтому дерево каждого интерфейса читаем отдельно.
  async openvpnInterfaces() {
    const all = await this._getJson('/rci/show/interface', { timeout: 30000 });

    const out = [];
    for (const [id, v] of Object.entries(all)) {
      if (!v || v.type !== 'OpenVPN') continue;
      let t;
      if (!/^OpenVPN\d+$/i.test(id)) throw new Error('Некорректное имя OpenVPN-интерфейса');
      t = await this._getJson('/rci/interface/' + id);
      out.push({
        name: id,
        description: t.description || '',
        config: t?.openvpn?.config?.config || '',
        acceptRoutes: t?.openvpn?.['accept-routes'] === true,
        enabled: v.state === 'up',
        connected: v.connected === 'yes',
      });
    }
    return out;
  }

  // Записывает .ovpn в интерфейс: POST дерева, которое отдаёт GET /rci/interface/<name>.
  async writeOpenvpnConfig(name, text) {
    if (!/^OpenVPN\d+$/i.test(name)) throw new Error('Некорректное имя OpenVPN-интерфейса');
    const body = JSON.stringify({ openvpn: { config: { config: text, final: true } } });
    const r = await request({
      url: `${this.base}/rci/interface/${name}`, method: 'POST', jar: this.jar, insecure: this.insecure,
      headers: { 'Content-Type': 'application/json' }, body, timeout: 60000,
    });
    if (r.status !== 200) throw new Error(`запись openvpn-config HTTP ${r.status}`);

    let data;
    try { data = JSON.parse(r.text); } catch { throw new Error('запись openvpn-config: не-JSON'); }
    const errs = [];
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        if (x.status === 'error') errs.push(x.message || 'ошибка записи');
        Object.values(x).forEach(walk);
      }
    };
    walk(data);
    if (errs.length) throw new Error(errs.join('; '));
    return true;
  }

  // Имя, модель и прошивка роутера. Серийник наружу отдаём только хвостом — целиком не светим.
  async identity() {
    const get = async (path) => {
      try {
        const r = await request({ url: this.base + path, jar: this.jar, insecure: this.insecure, timeout: 20000 });
        return r.status === 200 ? JSON.parse(r.text) : null;
      } catch {
        return null;
      }
    };
    const sys = await get('/rci/system');
    const ver = await get('/rci/show/version');
    const ident = await get('/rci/show/identification');
    const serial = ident?.serial || '';

    return {
      // hostname — сетевое имя, часто дефолтное («Keenetic»), поэтому не единственный источник.
      hostname: sys?.hostname || '',
      description: sys?.description || ver?.description || '',
      vendor: ver?.vendor || '',
      device: ver?.device || '',
      model: ver?.model || '',
      hwid: ver?.hw_id || ident?.hwid || '',
      firmware: ver?.title || ver?.release || '',
      serialTail: serial.slice(-4),
    };
  }

  async keenOsVersion() {
    for (const path of ['/rci/show/version', '/rci/show/system', '/rci/show/firmware']) {
      try {
        const r = await request({ url: this.base + path, jar: this.jar, insecure: this.insecure, timeout: 20000 });
        const v = findVersion(r.text);
        if (v) return v;
      } catch {}
    }
    return null;
  }

  // RCI help parses a command without executing it. Firmware labels alone do
  // not distinguish early 5.2 builds that lack the AWG 3.x arguments.
  async supportsModernAsc(name = 'Wireguard0') {
    if (!/^Wireguard\d+$/.test(name)) throw new Error('Некорректное имя WireGuard-интерфейса');
    const r = await request({
      url: this.base + '/rci/', method: 'POST', jar: this.jar, insecure: this.insecure,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ help: `interface ${name} wireguard asc ` }), timeout: 20000,
    });
    if (r.status !== 200) throw new Error('Не удалось проверить поддержку ASC 3.1 на роутере');
    let data;
    try { data = JSON.parse(r.text); } catch { throw new Error('Не удалось прочитать справку ASC роутера'); }
    const hint = data?.help?.hint;
    if (typeof hint !== 'string' || !hint.includes('{jc}')) throw new Error('Роутер не подтвердил доступность команды ASC');
    return ['header-protection-key', 'content-padding-addition-start', 'rekey-after-time-start', 'random-trailers', 'disable-cookies'].every(k => hint.includes(`{${k}}`));
  }

  // Состояния интерфейсов (по description): up/down, connected (yes/no), link.
  async interfaceStates() {
    let data;
    try {
      const r = await request({ url: this.base + '/rci/show/interface', jar: this.jar, insecure: this.insecure, timeout: 20000 });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      data = JSON.parse(r.text);
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new Error('неверный ответ роутера');
    } catch (e) {
      throw new Error('Не удалось получить состояние интерфейсов: ' + e.message);
    }
    const result = {};
    if (data && typeof data === 'object') {
      for (const [name, info] of Object.entries(data)) {
        if (info && typeof info === 'object') {
          const desc = String(info.description || name).replace(/^["'\s]+|["'\s]+$/g, '');
          result[desc] = {
            name,
            description: desc,
            state: info.state || '',
            up: info.state === 'up',
            connected: info.connected === 'yes' || info.connected === true,
            link: info.link || '',
          };
        }
      }
    }
    return result;
  }

  // Активирует один интерфейс (up) и отключает остальные (down), сохраняя конфиг.
  async switchActiveInterface(enableDescription, allDescriptions = []) {
    const states = await this.interfaceStates();
    const cleanEnable = String(enableDescription).replace(/^["'\s]+|["'\s]+$/g, '');
    const cleanAll = allDescriptions.map((d) => String(d).replace(/^["'\s]+|["'\s]+$/g, ''));
    const target = states[cleanEnable];
    if (!target) throw new Error('Выбранный VPN-интерфейс не найден на роутере. Обновите состояние подключений');
    if (!/^(Wireguard|OpenVPN)\d+$/i.test(target.name)) throw new Error('Переключать можно только VPN-интерфейсы');

    const cmds = [];
    for (const d of cleanAll) {
      const item = states[d];
      if (item && /^(Wireguard|OpenVPN)\d+$/i.test(item.name)) {
        if (d !== cleanEnable && item.up) cmds.push(`interface ${item.name} down`);
      }
    }

    if (target && !target.up && !cmds.includes(`interface ${target.name} up`)) {
      cmds.push(`interface ${target.name} up`);
    }

    if (cmds.length) {
      const down = cmds.filter(c => c.endsWith(' down'));
      const up = cmds.filter(c => c.endsWith(' up'));
      const send = async commands => {
        const result = await this.rci(commands);
        const errors = Keenetic.collectErrors(result);
        if (errors.length) throw new Error(errors.join('; '));
      };
      try {
        // Отдельный запрос: не посылать up, пока роутер не подтвердил down.
        if (down.length) await send(down);
        await send([...up, 'system configuration save']);
      } catch (e) {
        const restore = [...(!target.up ? [`interface ${target.name} down`] : []), ...down.map(c => c.replace(/ down$/, ' up')), 'system configuration save'];
        try { await send(restore); }
        catch (restoreError) { throw new Error(e.message + '; не удалось восстановить прежнее подключение: ' + restoreError.message); }
        throw new Error(e.message + '; выполнено восстановление прежнего включения VPN');
      }
    }
    return { ok: true, active: cleanEnable, switched: cmds.length > 0 };
  }
}

function findVersion(text) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object') {
      // В KeenOS поле title содержит актуальную версию прошивки (например, "5.1.5").
      // Поле release часто содержит внутренний номер сборки/ядра (например, "5.01.C.5.0-0").
      if (data.title) {
        const v = findVersionInString(data.title);
        if (v) return v;
      }
    }
    const walk = (x) => {
      if (typeof x === 'string') return findVersionInString(x);
      if (Array.isArray(x)) {
        for (const v of x) {
          const r = walk(v);
          if (r) return r;
        }
      } else if (x && typeof x === 'object') {
        for (const v of Object.values(x)) {
          const r = walk(v);
          if (r) return r;
        }
      }
      return null;
    };
    return walk(data);
  } catch {
    return findVersionInString(text);
  }
}

function findVersionInString(value) {
  const m = String(value).match(/\b(\d+\.\d+(?:\.\d+)?(?:\s+(?:Alpha|Beta|Delta|Preview|Release|RC)\s*\d+)?)\b/i);
  return m ? m[1].trim() : null;
}
