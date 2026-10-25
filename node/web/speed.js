/* Native router diagnostics. Polling only reads a job; it never restarts a test. */
const speedUi = { jobs: new Map(), pending: new Set(), timer: null, polling: false, revision: 0, connectionError: '' };
const speedJobActive = job => ['queued','checking','running','stopping'].includes(job?.status);
const speedTestBusy = router => (router === undefined ? speedUi.pending.size > 0 : speedUi.pending.has(router)) || [...speedUi.jobs.values()].some(job => speedJobActive(job) && (router === undefined || job.router === router));
const speedTestDateFormat = new Intl.DateTimeFormat('ru-RU', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', timeZoneName:'short' });
function speedTestTime(job) {
  const format = value => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? speedTestDateFormat.format(date) : '';
  };
  const started = format(job.startedAt), created = format(job.createdAt), finished = format(job.finishedAt);
  const start = started ? `Запущен: ${started}` : created ? `${job.status === 'queued' ? 'В очереди с' : 'Задание создано:'} ${created}` : 'Время запуска неизвестно';
  return start + (finished ? ` · ${job.status === 'cancelled' ? 'Отменён' : 'Завершён'}: ${finished}` : '');
}

function makeSpeedTestEntry(r) {
  const box = document.createElement('details');
  box.className = 'ss-speed';
  box.innerHTML = `<summary>Тест скорости · iperf3</summary><div class="ss-speed-body"><p class="ss-speed-note">10 потоков TCP, 10 секунд. Тест запускается на роутере через это VPN-подключение и может загрузить канал.</p><div class="ss-speed-fields"><label>Сервер AntiZapret<select class="ss-speed-target"><option value="local">az-local.antizapret</option><option value="world">az-world.antizapret</option></select></label><label>Направление<select class="ss-speed-direction"><option value="download">Сервер → роутер</option><option value="upload">Роутер → сервер</option></select></label></div><div class="ss-speed-actions"><button class="sm ss-speed-start" type="button">Запустить тест</button><button class="sm ss-speed-stop" type="button" hidden>Остановить</button></div><p class="ss-speed-state" role="status" aria-live="polite"></p><p class="ss-speed-time ss-speed-note" hidden></p><div class="ss-speed-result" hidden></div><details class="ss-speed-log" hidden><summary>Журнал iperf3</summary><pre></pre></details></div>`;
  $('.ss-detail-body', r.entry).appendChild(box);
  r.speed = { box, target: $('.ss-speed-target',box), direction: $('.ss-speed-direction',box),
    start: $('.ss-speed-start',box), stop: $('.ss-speed-stop',box), state: $('.ss-speed-state',box),
    time: $('.ss-speed-time',box), result: $('.ss-speed-result',box), log: $('.ss-speed-log',box), output: $('pre',box), job: null };
  r.speed.start.onclick = () => startSpeedTest(r);
  r.speed.stop.onclick = () => stopSpeedTest(r);
  refreshSpeedTestEntry(r);
}

function refreshSpeedTestEntry(r) {
  if (!r.speed) return;
  const s = r.speed, job = s.job, current = job && speedUi.jobs.has(job.id);
  const working = current && speedJobActive(job), pending = speedUi.pending.has(r.mapping.router);
  const connected = r.info?.up && r.info?.connected;
  s.start.disabled = syncView.loading || syncView.routers?.has(r.mapping.router) || speedTestBusy(r.mapping.router) || !connected;
  s.start.textContent = job ? 'Повторить тест' : 'Запустить тест';
  s.stop.hidden = !working;
  s.stop.textContent = job?.status === 'queued' ? 'Убрать из очереди' : 'Остановить';
  s.stop.disabled = pending || job?.status === 'stopping';
  s.target.disabled = s.direction.disabled = working || pending;
  s.state.className = 'ss-speed-state';
  if (s.time) { s.time.hidden = !job; s.time.textContent = job ? speedTestTime(job) : ''; }
  if (!job) { s.state.textContent = connected ? 'Перед запуском проверим наличие компонента iPerf3 на роутере.' : 'Для теста нужно активное VPN-подключение. Включите его и обновите состояние.'; return; }
  const queued = job.waitingFor === 'server' ? `Сервер занят другим тестом. Место в очереди: ${job.queuePosition || 1}. Запустим автоматически.` : 'Ожидаем свободное место для теста. Запустим автоматически.';
  const labels = { queued, checking:'Подключаемся к роутеру и проверяем наличие iPerf3…', running:'Тест выполняется: 10 потоков, 10 секунд. Ожидаем итог роутера…', stopping:'Останавливаем тест на роутере…', done:'Тест завершён.', cancelled:job.stopUnconfirmed?'Остановка запрошена.':'Тест остановлен.' };
  s.state.textContent = labels[job.status] || job.error || 'Ошибка теста';
  if (current && speedUi.connectionError) s.state.textContent += ' ' + speedUi.connectionError;
  if (job.stopUnconfirmed) s.state.textContent += ' Остановка на роутере не подтверждена. Проверьте его диагностику перед повтором.';
  s.state.classList.toggle('error', job.status === 'error' || !!job.stopUnconfirmed);
  s.state.classList.toggle('ok', job.status === 'done');
  s.result.hidden = !job.result;
  if (job.result) {
    const speed = point => (point.bitsPerSecond / 1e6).toLocaleString('ru-RU',{maximumFractionDigits:1}) + ' Мбит/с';
    const volume = point => (point.bytes / 1048576).toLocaleString('ru-RU',{maximumFractionDigits:1}) + ' МиБ';
    const {sender,receiver} = job.result;
    s.result.innerHTML = `<div><span>${job.reverse?'Отправлено сервером':'Отправлено роутером'}</span><strong>${esc(speed(sender))}</strong><small>${esc(volume(sender))}${sender.retransmits===null?'':` · повторов TCP: ${sender.retransmits}`}</small></div><div><span>${job.reverse?'Получено роутером':'Получено сервером'}</span><strong>${esc(speed(receiver))}</strong><small>${esc(volume(receiver))}</small></div>`;
  }
  s.log.hidden = !job.log;
  s.output.textContent = job.log || '';
}

function acceptSpeedTestJobs(jobs, complete = true) {
  if (complete) speedUi.jobs.clear();
  for (const job of jobs) if (job) speedUi.jobs.set(job.id, job);
  speedUi.revision++; speedUi.connectionError = '';
  for (const r of syncView.rows) {
    if (complete && speedJobActive(r.speed.job) && !speedUi.jobs.has(r.speed.job.id)) r.speed.job = { ...r.speed.job, status:'error', error:'Сервер AWG Sync перезапущен или результат удалён. Состояние теста утрачено; перед новым запуском проверим диагностику роутера.' };
    const job = [...speedUi.jobs.values()].filter(j => j.mapping === r.mapping.name).at(-1);
    if (job) {
      r.speed.job = job;
      r.speed.target.value = job.target === 'az-world.antizapret' ? 'world' : 'local';
      r.speed.direction.value = job.reverse ? 'download' : 'upload';
      if (speedJobActive(job)) { r.speed.box.open = true; $('.ss-detail',r.entry).open = true; }
    }
  }
  refreshSyncUi();
  scheduleSpeedPoll();
}

function scheduleSpeedPoll(ms = 1000, force = false) {
  clearTimeout(speedUi.timer);
  if (force || speedTestBusy()) speedUi.timer = setTimeout(pollSpeedTest, ms);
}

async function pollSpeedTest() {
  if (speedUi.polling) { scheduleSpeedPoll(1000, true); return; }
  speedUi.polling = true;
  const revision = speedUi.revision;
  try {
    const data = await api('/api/speed-test',undefined,15000);
    if (revision !== speedUi.revision || speedUi.pending.size) { scheduleSpeedPoll(1000, true); return; }
    acceptSpeedTestJobs(data.jobs || (data.job ? [data.job] : []));
  }
  catch(e) {
    speedUi.connectionError = 'Не удалось получить состояние: '+e.message+'. Тест повторно не запускается.';
    refreshSyncUi();
    if (e.status === 401 || e.message === 'Требуется авторизация') { clearTimeout(speedUi.timer); return; }
    scheduleSpeedPoll(3000); return;
  } finally {
    speedUi.polling = false;
  }
  scheduleSpeedPoll();
}

async function restoreSpeedTest() {
  clearTimeout(speedUi.timer);
  await pollSpeedTest();
}

async function startSpeedTest(r) {
  const router = r.mapping.router;
  if (speedTestBusy(router) || syncView.loading || syncView.routers?.has(router) || !r.info?.up || !r.info?.connected) return;
  speedUi.pending.add(router); speedUi.revision++; refreshSyncUi();
  try {
    const data=await api('/api/speed-test',{name:r.mapping.name,target:r.speed.target.value,reverse:r.speed.direction.value==='download'},15000);
    acceptSpeedTestJobs([data.job], false);
  } catch(e) { toast('Не удалось запустить тест: '+e.message,true); await restoreSpeedTest(); }
  finally { speedUi.pending.delete(router); speedUi.revision++; refreshSyncUi(); scheduleSpeedPoll(0, true); }
}

async function stopSpeedTest(r) {
  const router = r.mapping.router;
  if (!r.speed.job || speedUi.pending.has(router)) return;
  speedUi.pending.add(router); speedUi.revision++; refreshSyncUi();
  try { acceptSpeedTestJobs([(await api('/api/speed-test-cancel',{id:r.speed.job.id},15000)).job], false); }
  catch(e) { toast('Не удалось запросить остановку: '+e.message,true); }
  finally { speedUi.pending.delete(router); speedUi.revision++; refreshSyncUi(); scheduleSpeedPoll(0, true); }
}
