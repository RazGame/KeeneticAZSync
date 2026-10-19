import { resolveMapping } from './config.js';

const fields = ['server', 'connection', 'client', 'router', 'interface'];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Изменяем одну связь, сохраняя остальные настройки и дополнительные поля.
export function upsertMapping(cfg, input, previousName = null) {
  const original = previousName == null ? null : cfg.mappings.find((m) => m.name === previousName);
  if (previousName != null && !original) throw new Error('Связь уже удалена. Обновите страницу');
  const mapping = { ...original };
  for (const key of fields) {
    if (typeof input?.[key] !== 'string' || !input[key].trim()) throw new Error(`Не задано поле «${key}»`);
    mapping[key] = input[key].trim();
    if (/[\r\n\0]/.test(mapping[key])) throw new Error(`Недопустимые символы в поле «${key}»`);
  }
  if (/["\\]/.test(mapping.interface)) throw new Error('Название интерфейса не должно содержать кавычки или обратную косую черту');
  resolveMapping(cfg, mapping);
  mapping.enabled = input.enabled !== false;
  if (!original) {
    const base = [mapping.router, mapping.server, mapping.connection].map(slug).filter(Boolean).join('-') || 'mapping';
    mapping.name = base;
    let suffix = 2;
    while (cfg.mappings.some((m) => m.name === mapping.name)) mapping.name = `${base}-${suffix++}`;
  }
  return { ...cfg, mappings: original ? cfg.mappings.map((m) => m === original ? mapping : m) : [...cfg.mappings, mapping] };
}

export function assertInterfaceMode(plan, mode) {
  if (mode === 'new' && plan.mode !== 'create' && plan.mode !== 'error') {
    throw new Error('Интерфейс с таким названием уже существует. Выберите существующий или задайте другое название');
  }
  if (mode === 'existing' && plan.mode === 'create') {
    throw new Error('Выбранный интерфейс больше не найден. Обновите список или явно выберите создание нового');
  }
}
