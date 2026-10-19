// Клиент WG-Easy v15 API: логин (session + cookie), список клиентов, скачивание .conf.
import { request, createJar } from './util/http.js';
import { panelLogin } from './panel-login.js';

// WG-Easy отдаёт ошибки JSON-ом с полем message — вытаскиваем его, иначе показываем сырой текст.
const apiMessage = (text) => {
  try { return JSON.parse(text).message || text.slice(0, 200); } catch { return text.slice(0, 200); }
};

export class WgEasy {
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
    const body = JSON.stringify({ username: this.username, password: this.password, remember: true });
    const post = (path) => request({
      url: this.url + path, method: 'POST', jar: this.jar, insecure: this.insecure, signal,
      headers: { 'Content-Type': 'application/json' }, body, timeout: 20000,
    });

    // v15: /api/auth/password; на v14 этого пути нет — откатываемся на /api/session.
    let r = await post('/api/auth/password');
    if (r.status === 404) r = await post('/api/session');
    if (r.status !== 200) throw new Error(`WG-Easy login HTTP ${r.status}`);

    let status;
    try { status = JSON.parse(r.text)?.status; } catch { /* v14 отдаёт пустое тело */ }
    if (status === 'TOTP_REQUIRED') throw new Error('WG-Easy: для этого пользователя включён 2FA (TOTP) — API-логин по паролю невозможен');
  }

  // Создаёт клиента. expiresAt обязателен даже как null — иначе 400 Validation Error.
  // Параметры AmneziaWG клиент наследует от интерфейса панели, задавать их не нужно.
  async createClient(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new Error('WG-Easy: имя должно содержать 1–64 латинских буквы, цифры, дефис или подчёркивание');
    }
    const body = JSON.stringify({ name, expiresAt: null });
    const r = await request({
      url: this.url + '/api/client', method: 'POST', jar: this.jar, insecure: this.insecure,
      headers: { 'Content-Type': 'application/json' }, body, timeout: 20000,
    });
    if (r.status !== 200) throw new Error(`WG-Easy создание клиента HTTP ${r.status}: ${apiMessage(r.text)}`);

    // Ответ на создание не фиксирован по форме — берём клиента из свежего списка.
    const created = (await this.clients()).find((c) => c.name === name);
    if (!created) throw new Error(`клиент "${name}" создан, но не появился в списке`);
    return created;
  }

  async clients() {
    const r = await request({ url: this.url + '/api/client', jar: this.jar, insecure: this.insecure, timeout: 20000 });
    if (r.status !== 200) throw new Error(`WG-Easy /api/client HTTP ${r.status}`);
    return JSON.parse(r.text);
  }

  async configById(id) {
    const r = await request({ url: `${this.url}/api/client/${encodeURIComponent(id)}/configuration`, jar: this.jar, insecure: this.insecure, timeout: 20000 });
    if (r.status !== 200) throw new Error(`WG-Easy configuration HTTP ${r.status}`);
    return r.text;
  }

  async configByName(name) {
    const list = await this.clients();
    const cl = list.find((c) => c.name === name);
    if (!cl) {
      throw new Error(`клиент "${name}" не найден. Есть: ${list.map((c) => c.name).join(', ')}`);
    }
    return { client: cl, conf: await this.configById(cl.id) };
  }
}
