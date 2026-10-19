#!/usr/bin/env node
// CLI: awgsync [маппинги...] [--apply] [--all] [--config path]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { runMapping } from '../src/sync.js';
import { c } from '../src/util/colors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { config: process.env.CONFIG_PATH || path.join(ROOT, 'config.yaml'), apply: false, all: false, withSecrets: false, noRestart: false, mappings: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--all') args.all = true;
    else if (a === '--with-secrets') args.withSecrets = true;
    else if (a === '--no-restart') args.noRestart = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args.mappings.push(a);
  }
  return args;
}

function usage() {
  console.log(`
${c.bold('awgsync')} — WG-Easy (AmneziaWG) / OpenVPN UI → Keenetic/Netcraze

Использование:
  awgsync serve [port]          веб-GUI (по умолчанию http://localhost:8787)
  awgsync --all                 dry-run всех маппингов (ничего не пишет)
  awgsync <name> [<name>...]    dry-run выбранных маппингов
  awgsync --all --apply         применить (запись на роутер + save)

Опции:
  --config, -c <path>   путь к конфигу (по умолчанию node/config.yaml или CONFIG_PATH)
  --apply               применить изменения (без флага — только показать diff)
  --all                 все маппинги из конфига
  --with-secrets        пушить private-key / preshared-key и пересоздавать пир при смене ключа
  --no-restart          не перезапускать активное соединение (down→up) после изменений
  --help, -h            эта справка

Если интерфейс (по description) не найден на роутере — он создаётся с нуля из .conf.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  // Auto-copy config.example.yaml if config file does not exist
  if (!fs.existsSync(args.config)) {
    try {
      const examplePath = path.join(ROOT, 'config.example.yaml');
      if (fs.existsSync(examplePath)) {
        console.log(c.cyan(`Конфиг ${args.config} не найден. Копируем шаблон из config.example.yaml...`));
        fs.mkdirSync(path.dirname(args.config), { recursive: true, mode: 0o700 });
        fs.copyFileSync(examplePath, args.config, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(args.config, 0o600);
      }
    } catch (e) {
      console.warn(c.yellow(`Предупреждение: Не удалось автоматически создать конфиг: ${e.message}`));
    }
  }

  // serve | gui [port] — поднять веб-GUI
  if (args.mappings[0] === 'serve' || args.mappings[0] === 'gui') {
    const port = Number(args.mappings[1]) || Number(process.env.PORT) || 8787;
    const { startServer } = await import('../src/server.js');
    startServer(args.config, port, process.env.HOST || '127.0.0.1');
    return;
  }

  const cfg = loadConfig(args.config);

  let selected;
  if (args.all) {
    selected = cfg.mappings.filter(m => m.enabled !== false);
  } else if (args.mappings.length) {
    selected = args.mappings.map((name) => {
      const m = cfg.mappings.find((x) => x.name === name);
      if (!m) throw new Error(`маппинг "${name}" не найден в конфиге`);
      return m;
    });
  } else {
    usage();
    console.log(c.yellow('Укажи маппинги или --all.'));
    return;
  }

  console.log(c.bold(args.apply ? c.magenta('РЕЖИМ ЗАПИСИ (--apply)') : c.cyan('DRY-RUN (изменения не применяются)')));

  const results = [];
  for (const m of selected) {
    try {
      results.push(await runMapping(cfg, m, { apply: args.apply, withSecrets: args.withSecrets, noRestart: args.noRestart }));
    } catch (e) {
      console.log('\n' + c.red(`✗ ${m.name || m.client}: ${e.message}`));
      results.push({ title: m.name || m.client, error: e.message });
    }
  }

  // итог
  console.log('\n' + c.bold('Итог:'));
  for (const r of results) {
    if (r.error) console.log(c.red(`  ✗ ${r.title}: ${r.error}`));
    else if (r.total === 0) console.log(c.green(`  ✓ ${r.title}: без изменений`));
    else if (r.applied) console.log(c.magenta(`  ↑ ${r.title}: применено ${r.total} (осталось ${r.remaining ?? 0})`));
    else console.log(c.yellow(`  • ${r.title}: ${r.total} изменений (dry-run)`));
  }

  const hasErr = results.some((r) => r.error || r.errors);
  process.exit(hasErr ? 1 : 0);
}

main().catch((e) => {
  console.error(c.red('Фатальная ошибка: ' + (e.stack || e.message)));
  process.exit(1);
});
