// Клиент openvpn-ui (d3vilh/openvpn-ui): логин формой с XSRF, список сертификатов, скачивание .ovpn.
// В отличие от WG-Easy тут нет JSON API — только HTML, поэтому разбор намеренно минимальный.
import { request, createJar } from './util/http.js';
import { panelLogin } from './panel-login.js';

// Односегментные ссылки вида /certificates/<имя>, которые именами клиентов не являются.
const RESERVED = new Set(['', 'restart', 'renew', 'revoke', 'add', 'edit', 'download']);

const enc = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const namesFromHtml = (html) => [...new Set([...html.matchAll(/href="\/certificates\/([^"/]*)"/g)]
  .map((m) => decodeURIComponent(m[1])).filter((name) => !RESERVED.has(name)))];

export class OpenVpnUi {
  constructor({ url, username, password, insecure = false }) {
    this.url = url.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.jar = createJar();
  }

  async login({ signal } = {}) {
    return panelLogin(this.url, () => this.authenticate({ signal }), { signal });
  }

  async authenticate({ signal } = {}) {
    const page = await request({ url: this.url + '/login', jar: this.jar, insecure: this.insecure, signal, timeout: 20000 });
    if (page.status !== 200) throw new Error(`openvpn-ui /login HTTP ${page.status}`);

    const m = page.text.match(/name="_xsrf"[^>]*value="([^"]*)"/);
    if (!m) throw new Error('openvpn-ui: на странице логина нет поля _xsrf');
    this.xsrf = m[1];

    const body = enc({ login: this.username, password: this.password, _xsrf: m[1] });
    const r = await request({
      url: this.url + '/login', method: 'POST', jar: this.jar, insecure: this.insecure, signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeout: 20000,
    });
    // Успех — редирект на корень. Неверные креды возвращают страницу логина с 200.
    const location = r.headers['location'] || '';
    if (r.status !== 302 && r.status !== 303) throw new Error(`openvpn-ui login HTTP ${r.status} (неверный логин/пароль?)`);
    if (/\/login/.test(location)) throw new Error('openvpn-ui: неверный логин или пароль');
  }

  async clients() {
    const r = await request({ url: this.url + '/certificates', jar: this.jar, insecure: this.insecure, timeout: 20000 });
    if (r.status !== 200) throw new Error(`openvpn-ui /certificates HTTP ${r.status} (сессия истекла?)`);

    return namesFromHtml(r.text);
  }

  async createClient(name) {
    // Имя попадает в EasyRSA и пути файлов панели. Разрешаем безопасное имя CN.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new Error('OpenVPN: имя должно содержать 1–64 латинских буквы, цифры, дефис или подчёркивание');
    }
    const page = await request({ url: this.url + '/certificates', jar: this.jar, insecure: this.insecure, timeout: 20000 });
    if (page.status !== 200) throw new Error(`openvpn-ui /certificates HTTP ${page.status}`);
    if (namesFromHtml(page.text).includes(name)) throw new Error(`клиент «${name}» на панели уже есть`);
    // В 0.9.5.6 форма сертификатов может не повторять скрытое поле логина.
    // Сохраняем token и cookie сессии, при наличии используем свежий token формы.
    const xsrf = page.text.match(/name="_xsrf"[^>]*value="([^"]*)"/)?.[1] || this.xsrf;
    if (!xsrf) throw new Error('openvpn-ui: не найден токен формы');
    const result = await request({
      url: this.url + '/certificates', method: 'POST', jar: this.jar, insecure: this.insecure,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: enc({ Name: name, _xsrf: xsrf }), timeout: 90000,
    });
    if (![200, 302, 303].includes(result.status)) throw new Error(`openvpn-ui: создание сертификата HTTP ${result.status}`);
    // Панель возвращает HTTP 200 и при ошибке EasyRSA. Проверяем результат по списку.
    if (!(await this.clients()).includes(name)) {
      throw new Error('openvpn-ui: панель не подтвердила создание сертификата. Проверьте её журнал и список клиентов перед повтором');
    }
    return { name };
  }

  async configByName(name) {
    const r = await request({
      url: `${this.url}/certificates/${encodeURIComponent(name)}`,
      jar: this.jar, insecure: this.insecure, timeout: 30000,
    });
    if (r.status !== 200) throw new Error(`openvpn-ui: не скачался конфиг "${name}" (HTTP ${r.status})`);

    // Страница логина отдаётся с 200 — отличаем настоящий .ovpn по содержимому.
    if (!/^\s*client\b/m.test(r.text) || !/<ca>/.test(r.text)) {
      const list = await this.clients();
      throw new Error(`openvpn-ui: "${name}" не похож на .ovpn. Есть: ${list.join(', ')}`);
    }
    return r.text;
  }
}
