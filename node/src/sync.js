// CLI-обёртка: вызывает ядро (core.js) и рендерит результат в консоль.
import { prepare, computePlan, applyPlan } from './core.js';
import { c } from './util/colors.js';
import { safeMessage } from './security.js';

function printList(title, items, color, cap = 12) {
  if (!items || !items.length) return;
  console.log(`    ${color(title)} (${items.length})`);
  for (const x of items.slice(0, cap)) console.log(`      ${color(x)}`);
  if (items.length > cap) console.log(c.gray(`      … ещё ${items.length - cap}`));
}

export async function runMapping(cfg, m, { apply, withSecrets, noRestart }) {
  const title = m.name || `${m.server}/${m.connection}/${m.client} → ${m.router}/${m.interface}`;
  console.log('\n' + c.bold(c.cyan(`▌ ${title}`)));

  const ctx = await prepare(cfg, m);
  const plan = computePlan(ctx, { withSecrets, noRestart });
  const meta = plan.meta;
  if (plan.activation?.disable.length) console.log(c.yellow('    перед включением отключить: ' + plan.activation.disable.map(i => `${i.description} (${i.name})`).join(', ')));

  console.log(c.gray(`    WG-Easy: ${meta.panelUrl} · клиент "${meta.client}" (id ${meta.clientId}) · AllowedIPs ${meta.allowedIps}`));
  console.log(c.gray(`    Роутер: подключён через ${meta.routerBase}`));
  console.log(c.gray(`    KeenOS: ${meta.keenOsVersion} · ASC ${meta.ascFormat}`));

  if (plan.mode === 'error') { console.log('    ' + c.red(`✗ ${plan.error}`)); return { title, error: plan.error }; }

  if (plan.mode === 'create') {
    console.log(c.yellow(`    интерфейс "${meta.interface}" не найден → СОЗДАНИЕ нового ${c.bold(meta.newName)}`));
    console.log(c.gray(`      addr ${meta.addr}/32 · mtu ${meta.mtu} · dns ${meta.dns.join(',') || '—'} · asc ${meta.hasAsc ? 'да' : 'нет'}`));
    console.log(c.gray(`      пир ${meta.peer.slice(0, 16)}… @ ${meta.endpoint} · allow-ips ${meta.allowCount} · routes ${meta.routeCount}`));
    console.log(c.green(`      план: ${plan.total} команд (создание)`));
    if (!apply) { console.log('    ' + c.yellow('dry-run: не создано (запусти с --apply)')); return { title, total: plan.total, applied: false, created: true }; }
    const r = await applyPlan(ctx, plan);
    if (!r.ok) { console.log('    ' + c.red(`✗ ошибки RCI: ${r.errors.length}`)); r.errors.slice(0, 8).forEach((e) => console.log(c.red('      ' + e))); return { title, error: 'rci', applied: false }; }
    console.log('    ' + (r.foundAfter ? c.green('✓ интерфейс создан и сохранён') : c.yellow('применено, но не найден при перепроверке')));
    return { title, total: plan.total, applied: true, created: true };
  }

  console.log(c.gray(`    Интерфейс: ${meta.ifaceName} ("${meta.interface}") · пир ${meta.peerLabel || '—'}`));
  if (plan.pubkeyChanged && !withSecrets) console.log(c.yellow('    ⚠ публичный ключ пира изменился — нужен --with-secrets для пересоздания пира'));

  if (plan.mode === 'noop') { console.log('    ' + c.green('✓ уже синхронизировано — изменений нет')); return { title, total: 0, applied: false }; }

  const ch = plan.changes;
  console.log(c.bold(`    Изменения: ${plan.total}`));
  if (ch.params.length) { console.log(`    ${c.cyan('параметры')} (${ch.params.length})`); ch.params.forEach((p) => console.log(`      ${c.cyan(p)}`)); }
  printList('allow-ips +', ch.allowAdd, c.green);
  printList('allow-ips −', ch.allowDel, c.red);
  printList('route !AntiZapretAWG +', ch.awgAdd, c.green);
  printList('route !AntiZapretAWG −', ch.awgDel, c.red);
  printList('ipv6 route !AntiZapretAWG +', ch.awg6Add, c.green);
  printList('ipv6 route !AntiZapretAWG −', ch.awg6Del, c.red);
  printList('route !AntiZapretDNS +', ch.dnsAdd, c.green);
  printList('route !AntiZapretDNS −', ch.dnsDel, c.red);
  if (plan.restart) console.log('    ' + c.yellow('соединение активно → после применения перезапуск (down → up)'));

  if (!apply) { console.log('    ' + c.yellow(`dry-run: ${plan.commands.length} команд не отправлено (запусти с --apply)`)); return { title, total: plan.total, applied: false }; }

  const r = await applyPlan(ctx, plan);
  if (!r.ok) { console.log('    ' + c.red(`✗ ошибки RCI: ${r.errors.length}`)); r.errors.slice(0, 8).forEach((e) => console.log(c.red('      ' + safeMessage(e)))); return { title, error: 'rci', applied: false }; }
  console.log('    ' + (r.remaining === 0 ? c.green('✓ применено и сохранено · расхождений по подсетям не осталось') : c.yellow(`применено, остаток подсетей: ${r.remaining}`)));
  return { title, total: plan.total, applied: true, remaining: r.remaining };
}
