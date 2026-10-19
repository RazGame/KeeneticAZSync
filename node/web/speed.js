/* Native router diagnostics. Polling only reads a job; it never restarts a test. */
const speedUi = { job: null, pending: false, timer: null, connectionError: '' };
const speedTestBusy = () => speedUi.pending || ['checking','running','stopping'].includes(speedUi.job?.status);

function makeSpeedTestEntry(r) {
  const box = document.createElement('details');
  box.className = 'ss-speed';
  box.innerHTML = `<summary>Тест скорости · iperf3</summary><div class="ss-speed-body"><p class="ss-speed-note">10 потоков TCP, 10 секунд. Тест запускается на роутере через это VPN-подключение и может загрузить канал.</p><div class="ss-speed-fields"><label>Сервер AntiZapret<select class="ss-speed-target"><option value="local">az-local.antizapret</option><option value="world">az-world.antizapret</option></select></label><label>Направление<select class="ss-speed-direction"><option value="download">Сервер → роутер</option><option value="upload">Роутер → сервер</option></select></label></div><div class="ss-speed-actions"><button class="sm ss-speed-start" type="button">Запустить тест</button><button class="sm ss-speed-stop" type="button" hidden>Остановить</button></div><p class="ss-speed-state" role="status" aria-live="polite"></p><div class="ss-speed-result" hidden></div><details class="ss-speed-log" hidden><summary>Журнал iperf3</summary><pre></pre></details></div>`;
  $('.ss-detail-body', r.entry).appendChild(box);
  r.speed = { box, target: $('.ss-speed-target',box), direction: $('.ss-speed-direction',box),
    start: $('.ss-speed-start',box), stop: $('.ss-speed-stop',box), state: $('.ss-speed-state',box),
    result: $('.ss-speed-result',box), log: $('.ss-speed-log',box), output: $('pre',box), job: null };
  r.speed.start.onclick = () => startSpeedTest(r);
  r.speed.stop.onclick = () => stopSpeedTest(r);
  refreshSpeedTestEntry(r);
}

function refreshSpeedTestEntry(r) {
  if (!r.speed) return;
  const s = r.speed, job = s.job, current = job && job.id === speedUi.job?.id;
  const working = current && ['checking','running','stopping'].includes(job.status);
  const connected = r.info?.up && r.info?.connected;
  s.start.disabled = syncView.busy || syncView.loading || speedTestBusy() || !connected;
  s.start.textContent = job ? 'Повторить тест' : 'Запустить тест';
  s.stop.hidden = !working;
  s.stop.disabled = speedUi.pending || job?.status === 'stopping';
  s.target.disabled = s.direction.disabled = working || speedUi.pending;
  s.state.className = 'ss-speed-state';
  if (!job) { s.state.textContent = connected ? 'Перед запуском проверим наличие компонента iPerf3 на роутере.' : 'Для теста нужно активное VPN-подключение. Включите его и обновите состояние.'; return; }
  const labels = { checking:'Подключаемся к роутеру и проверяем наличие iPerf3…', running:'Тест выполняется: 10 потоков, 10 секунд. Ожидаем итог роутера…', stopping:'Останавливаем тест на роутере…', done:'Тест завершён.', cancelled:job.stopUnconfirmed?'Остановка запрошена.':'Тест остановлен.' };
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

function acceptSpeedTestJob(job) {
  const lost = !job && ['checking','running','stopping'].includes(speedUi.job?.status);
  speedUi.job = job; speedUi.connectionError = '';
  for (const r of syncView.rows) {
    if (lost && ['checking','running','stopping'].includes(r.speed.job?.status)) r.speed.job = { ...r.speed.job, status:'error', error:'Сервер AWG Sync перезапущен или результат удалён. Состояние теста утрачено; перед новым запуском проверим диагностику роутера.' };
    if (job?.mapping === r.mapping.name) {
      r.speed.job = job;
      r.speed.target.value = job.target === 'az-world.antizapret' ? 'world' : 'local';
      r.speed.direction.value = job.reverse ? 'download' : 'upload';
      if (['checking','running','stopping'].includes(job.status)) { r.speed.box.open = true; $('.ss-detail',r.entry).open = true; }
    }
  }
  refreshSyncUi();
  clearTimeout(speedUi.timer);
  if (speedTestBusy() && job) speedUi.timer = setTimeout(pollSpeedTest,1000);
}

async function pollSpeedTest() {
  try { const data = await api('/api/speed-test?id='+encodeURIComponent(speedUi.job.id),undefined,15000); acceptSpeedTestJob(data.job); }
  catch(e) {
    if (e.status === 404) { await restoreSpeedTest(); return; }
    speedUi.connectionError = 'Не удалось получить состояние: '+e.message+'. Тест повторно не запускается.';
    refreshSyncUi();
    if (e.status !== 401 && e.message !== 'Требуется авторизация') speedUi.timer = setTimeout(pollSpeedTest,3000);
  }
}

async function restoreSpeedTest() {
  clearTimeout(speedUi.timer);
  try { acceptSpeedTestJob((await api('/api/speed-test',undefined,15000)).job); }
  catch(e) { if (speedUi.job) { speedUi.connectionError=e.message; refreshSyncUi(); } }
}

async function startSpeedTest(r) {
  if (speedTestBusy() || syncView.busy || !r.info?.up || !r.info?.connected) return;
  speedUi.pending=true;refreshSyncUi();
  try {
    const data=await api('/api/speed-test',{name:r.mapping.name,target:r.speed.target.value,reverse:r.speed.direction.value==='download'},15000);
    acceptSpeedTestJob(data.job);
  } catch(e) { toast('Не удалось запустить тест: '+e.message,true); await restoreSpeedTest(); }
  finally { speedUi.pending=false;refreshSyncUi(); }
}

async function stopSpeedTest(r) {
  if (!r.speed.job || speedUi.pending) return;
  speedUi.pending=true;refreshSyncUi();
  try { acceptSpeedTestJob((await api('/api/speed-test-cancel',{id:r.speed.job.id},15000)).job); }
  catch(e) { toast('Не удалось запросить остановку: '+e.message,true); }
  finally { speedUi.pending=false;refreshSyncUi(); }
}
