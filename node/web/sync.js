/* Единая область действий: все связи или отмеченные. Применяем только проверенные планы. */
const syncView={rows:[],groups:[],routers:new Map(),batches:new Map(),queue:[],running:0,get busy(){return this.batches.size>0;},loading:false,sequence:0,progress:''};
const syncRouterBusy=router=>syncView.routers.has(router)||speedTestBusy(router);
const syncOptions=()=>({withSecrets:optSecrets(),noRestart:optNoRestart()});
const syncOptionsKey=()=>JSON.stringify(syncOptions());
const syncScope=()=>{const selected=syncView.rows.filter(r=>r.checkbox.checked);return selected.length?selected:syncView.rows;};
const syncNeedsApply=r=>r.plan&&!r.plan.error&&r.plan.mode!=='error'&&r.plan.mode!=='noop'&&r.planToken&&r.optionsKey===syncOptionsKey();
const syncStatus=(el,text,kind='')=>{el.className=el.classList.contains('ss-vpn')?'ss-status ss-vpn '+kind:'ss-status ss-config '+kind;el.textContent=text;};
const syncStatusPoll={timer:null,running:false,epoch:0,due:new Map(),fast:new Map(),errors:new Map(),reads:new Map(),versions:new Map()};
const syncStatusVisible=()=>typeof document!=='undefined'&&!document.hidden&&AUTHENTICATED&&$('#tab-sync').classList.contains('show');

function stopSyncStatus(){
  clearTimeout(syncStatusPoll.timer);syncStatusPoll.timer=null;syncStatusPoll.epoch++;
}
function scheduleSyncStatus(){
  clearTimeout(syncStatusPoll.timer);syncStatusPoll.timer=null;
  if(!syncStatusVisible()||syncStatusPoll.running||!syncView.groups.length)return;
  const now=Date.now(),times=syncView.groups.map(g=>syncView.routers.has(g.router)||speedTestBusy(g.router)?now+2000:syncStatusPoll.due.get(g.router)||now);
  syncStatusPoll.timer=setTimeout(pollSyncStatus,Math.max(250,Math.min(...times)-now));
}
function startSyncStatus(){
  stopSyncStatus();
  if(!syncStatusVisible())return;
  for(const group of syncView.groups)syncStatusPoll.due.set(group.router,0);
  scheduleSyncStatus();
}
async function pollSyncStatus(){
  syncStatusPoll.timer=null;
  if(!syncStatusVisible()||syncStatusPoll.running)return;
  syncStatusPoll.running=true;const epoch=syncStatusPoll.epoch;
  const queue=syncView.groups.filter(g=>!syncRouterBusy(g.router)&&(syncStatusPoll.due.get(g.router)||0)<=Date.now());
  try{
    await Promise.all(Array.from({length:Math.min(2,queue.length)},async()=>{
      while(queue.length&&epoch===syncStatusPoll.epoch&&syncStatusVisible()){
        const group=queue.shift();if(!syncRouterBusy(group.router))await refreshSyncRouter(group);
      }
    }));
  }finally{syncStatusPoll.running=false;scheduleSyncStatus();}
}
function invalidateSyncStatus(router){
  syncStatusPoll.versions.set(router,(syncStatusPoll.versions.get(router)||0)+1);
}
function followSyncConnection(group,mapping){
  syncStatusPoll.fast.set(group.router,{mapping,until:Date.now()+30000});
  syncStatusPoll.due.set(group.router,Date.now()+2000);scheduleSyncStatus();
}

function refreshSyncUi(){
  const selected=syncView.rows.filter(r=>r.checkbox.checked),scope=syncScope(),available=scope.filter(r=>!syncRouterBusy(r.mapping.router)),changed=available.filter(syncNeedsApply);
  const locked=syncView.loading;
  $('#syncScope').textContent=selected.length?`Выбрано подключений: ${selected.length}`:'Все подключения';
  $('#syncClear').hidden=!selected.length;$('#syncClear').disabled=locked;
  $('#syncCheck').textContent=selected.length?`Проверить выбранные (${available.length})`:available.length<scope.length?`Проверить доступные (${available.length})`:'Проверить все';
  $('#syncCheck').disabled=locked||!available.length;
  $('#syncApply').textContent=changed.length?`Применить изменения (${changed.length})`:'Применить изменения';
  $('#syncApply').disabled=locked||!changed.length;
  $('#syncApply').classList.toggle('primary',changed.length>0);
  $('#syncCheck').classList.toggle('primary',changed.length===0);
  $('#syncReload').disabled=locked||syncView.busy||syncView.routers.size>0;
  $('#swRestart').disabled=$('#swSecrets').disabled=locked||syncView.busy||syncView.routers.size>0;
  const checked=scope.filter(r=>r.checked).length,errors=scope.filter(r=>r.error).length;
  const batches=[...syncView.batches.values()],work=batches.length?`Обработано подключений: ${batches.reduce((n,b)=>n+b.completed,0)} из ${batches.reduce((n,b)=>n+b.total,0)} · роутеров в работе и очереди: ${syncView.routers.size}`:'';
  $('#syncSummary').textContent=work||syncView.progress||(syncView.loading?'Загрузка подключений…':checked?`Проверено: ${checked} из ${scope.length} · с изменениями: ${changed.length}${errors?' · ошибок: '+errors:''}`:'Отметьте нужные подключения или проверьте все. Затем примените найденные изменения.');
  for(const g of syncView.groups){
    const on=g.rows.filter(r=>r.checkbox.checked).length;
    g.checkbox.checked=on>0&&on===g.rows.length;g.checkbox.indeterminate=on>0&&on<g.rows.length;g.checkbox.disabled=syncView.loading||syncRouterBusy(g.router);
  }
  for(const r of syncView.rows){r.checkbox.disabled=syncView.loading||syncRouterBusy(r.mapping.router);r.switchButton.disabled=r.checkbox.disabled;refreshSpeedTestEntry(r);}
}

function invalidateSyncPlans(){
  for(const r of syncView.rows){r.plan=null;r.planToken=null;r.checked=false;r.error=false;r.planBox.textContent='Параметры применения изменились. Проверьте настройки повторно.';syncStatus(r.configStatus,'Не проверено');}
  refreshSyncUi();
}

function makeSyncEntry(mapping){
  const m=mapping,entry=document.createElement('div');entry.className='ss-entry';
  const label=m.connType==='openvpn-ui'?'OpenVPN':'AmneziaWG';
  entry.innerHTML=`<label class="ss-select"><input type="checkbox" aria-label="Выбрать ${esc(m.router)}: ${esc(m.server)} · ${label} · ${esc(m.client)} → ${esc(m.interface)}"></label><details class="ss-detail"><summary><div class="ss-connection"><strong>${esc(m.server)}</strong><span class="ss-protocol">${label}</span><div class="ss-interface">${esc(m.interface)}</div></div><span class="ss-status ss-vpn">Загрузка…</span><span class="ss-status ss-config">Не проверено</span><span class="ss-chevron" aria-hidden="true">›</span></summary><div class="ss-detail-body"><div class="ss-detail-meta">Клиент: <b>${esc(m.client)}</b> → интерфейс: <b>${esc(m.interface)}</b></div><div class="ss-plan">Настройки ещё не проверены. Выберите область проверки вверху страницы.</div><div class="ss-switch" hidden><button type="button" class="sm">Использовать это подключение</button><span class="ss-switch-hint">Остальные VPN-подключения этого роутера будут выключены.</span></div></div></details>`;
  const r={mapping:m,entry,checkbox:$('input',entry),vpnStatus:$('.ss-vpn',entry),configStatus:$('.ss-config',entry),planBox:$('.ss-plan',entry),switchWrap:$('.ss-switch',entry),switchButton:$('.ss-switch button',entry),plan:null,planToken:null,checked:false,error:false,info:null,optionsKey:null};
  r.checkbox.onchange=refreshSyncUi;r.switchButton.onclick=()=>switchSyncConnection(r);
  makeSpeedTestEntry(r);
  return r;
}

function updateSyncConnections(group,interfaces,error=''){
  recordTrafficRouterState(group.router,interfaces,error);
  for(const r of group.rows){
    const desc=String(r.mapping.interface).replace(/^["'\s]+|["'\s]+$/g,'');
    r.info=error?null:interfaces[desc];r.switchWrap.hidden=true;
    if(error){syncStatus(r.vpnStatus,'Недоступен','error');r.vpnStatus.title=error;refreshSpeedTestEntry(r);continue;}
    r.vpnStatus.removeAttribute('title');
    if(!r.info){syncStatus(r.vpnStatus,'Не создан','warn');refreshSpeedTestEntry(r);continue;}
    if(r.info.connected)syncStatus(r.vpnStatus,'Подключено','ok');
    else if(r.info.up)syncStatus(r.vpnStatus,'Включено · нет связи','warn');
    else{syncStatus(r.vpnStatus,'Выключено');r.switchWrap.hidden=false;}
    refreshSpeedTestEntry(r);
  }
}
async function refreshSyncRouter(group,sequence=syncView.sequence){
  const router=group.router,epoch=syncStatusPoll.epoch,version=syncStatusPoll.versions.get(router)||0;
  let read=syncStatusPoll.reads.get(router);
  if(read&&(read.epoch!==epoch||read.version!==version)){
    await read.promise;
    if(sequence===syncView.sequence&&epoch===syncStatusPoll.epoch&&version===(syncStatusPoll.versions.get(router)||0)&&syncStatusVisible())return refreshSyncRouter(group,sequence);
    return;
  }
  if(!read){
    read={epoch,version};
    read.promise=api(`/api/router-status?router=${encodeURIComponent(router)}`,undefined,45000)
      .catch(e=>({ok:false,error:e.message}))
      .finally(()=>{if(syncStatusPoll.reads.get(router)===read)syncStatusPoll.reads.delete(router);});
    syncStatusPoll.reads.set(router,read);
  }
  const data=await read.promise;
  if(sequence!==syncView.sequence||epoch!==syncStatusPoll.epoch||version!==(syncStatusPoll.versions.get(router)||0)||!syncStatusVisible())return;
  updateSyncConnections(group,data.interfaces||{},data.ok?'':data.error||'Роутер недоступен');
  const now=Date.now(),fast=syncStatusPoll.fast.get(router),target=fast&&group.rows.find(r=>r.mapping.name===fast.mapping);
  if(fast&&(now>=fast.until||target?.info?.connected))syncStatusPoll.fast.delete(router);
  const failures=data.ok?0:(syncStatusPoll.errors.get(router)||0)+1;syncStatusPoll.errors.set(router,failures);
  syncStatusPoll.due.set(router,now+(failures?Math.min(60000,15000*2**Math.min(failures,2)):syncStatusPoll.fast.has(router)?2000:15000));
  scheduleSyncStatus();
}

async function loadSync(){
  if(syncView.busy||syncView.routers.size||syncView.loading)return;
  stopSyncStatus();syncStatusPoll.due.clear();syncStatusPoll.fast.clear();syncStatusPoll.errors.clear();
  const sequence=++syncView.sequence;
  syncView.loading=true;syncView.progress='';refreshSyncUi();
  try{
    const{mappings,servers}=await api('/api/mappings');
    if(sequence!==syncView.sequence)return;
    const selected=new Set(syncView.rows.filter(r=>r.checkbox.checked).map(r=>r.mapping.name));
    const groups=new Map();
    for(const m of mappings){if(m.enabled===false)continue;m.connType=servers?.[m.server]?.connections?.[m.connection]?.type||'';if(!groups.has(m.router))groups.set(m.router,[]);groups.get(m.router).push(m);}
    syncView.rows=[];syncView.groups=[];const box=$('#cards');box.innerHTML='';
    for(const[router,items]of groups){
      const el=document.createElement('section');el.className='ss-router';
      el.innerHTML=`<header class="ss-router-head"><label class="ss-select"><input type="checkbox" aria-label="Выбрать все подключения роутера ${esc(router)}"></label><div class="ss-router-identity">${accessIcon(true)}<div><strong class="ss-router-name">${esc(router)}</strong><span class="ss-router-count">Подключений: ${items.length}</span></div></div></header><div class="ss-list"><div class="ss-columns" aria-hidden="true"><span></span><span>Подключение</span><span>VPN на роутере</span><span>Настройки</span><span></span></div></div>`;
      const group={el,router,rows:[],checkbox:$('header input',el)};
      for(const m of items){const r=makeSyncEntry(m);r.group=group;r.checkbox.checked=selected.has(m.name);group.rows.push(r);syncView.rows.push(r);$('.ss-list',el).appendChild(r.entry);}
      group.checkbox.onchange=()=>{group.rows.forEach(r=>r.checkbox.checked=group.checkbox.checked);refreshSyncUi();};
      syncView.groups.push(group);box.appendChild(el);
    }
    if(!groups.size)box.innerHTML='<div class="ss-empty">Нет подключений для синхронизации. Добавьте связь на вкладке «Маппинги» и включите для неё синхронизацию.</div>';
    $('#syncmsg').textContent=`Подключений: ${syncView.rows.length} · роутеров: ${groups.size}`;
    await restoreSpeedTest();
  }catch(e){syncView.progress='Не удалось загрузить подключения: '+e.message;}
  finally{syncView.loading=false;refreshSyncUi();startSyncStatus();}
}

async function checkSyncRow(r,options){
  r.plan=null;r.planToken=null;r.error=false;r.checked=false;syncStatus(r.configStatus,'Проверяю…');r.planBox.textContent='Проверяем конфигурацию панели и роутера…';
  try{
    const data=await api('/api/plan',{name:r.mapping.name,...options},180000);
    r.checked=true;r.plan=data.plan;r.planToken=data.planToken;r.optionsKey=JSON.stringify(options);
    renderPlan(r.planBox,r.plan,options.withSecrets);
    if(r.plan.error||r.plan.mode==='error'){r.error=true;syncStatus(r.configStatus,'Ошибка проверки','error');}
    else if(r.plan.mode==='noop')syncStatus(r.configStatus,'Совпадает','ok');
    else if(r.plan.mode==='create')syncStatus(r.configStatus,'Будет создан интерфейс','change');
    else syncStatus(r.configStatus,`Изменений: ${r.plan.total}`,'change');
  }catch(e){r.checked=true;r.error=true;r.planBox.textContent=e.message;syncStatus(r.configStatus,'Ошибка проверки','error');}
}

async function applySyncRow(r,options){
  const token=r.planToken;syncStatus(r.configStatus,'Применяю…');
  try{
    const data=await api('/api/apply',{name:r.mapping.name,planToken:token,...options},180000),result=data.result;
    if(!result?.ok)throw new Error((result?.errors||[data.plan?.error||'Не удалось применить настройки']).join('; '));
    r.plan=null;r.planToken=null;r.error=false;r.checked=true;
    if(result.remaining>0||result.foundAfter===false||result.verified===false){r.error=true;syncStatus(r.configStatus,'Нужна повторная проверка','warn');r.planBox.textContent='Команды отправлены, но итоговая проверка не подтвердила все настройки. Проверьте подключение ещё раз.';}
    else{syncStatus(r.configStatus,'Совпадает','ok');r.planBox.textContent=result.noop?'Изменения не требуются.':'Настройки применены и проверены.';}
  }catch(e){r.plan=null;r.planToken=null;r.error=true;r.checked=true;r.planBox.textContent=e.message;syncStatus(r.configStatus,'Ошибка применения','error');}
}

// Reserve each participating router, then process up to three router groups.
// Connections of one router keep their order and never write concurrently.
function releaseSyncRouters(rows,owner){
  for(const row of rows)if(syncView.routers.get(row.mapping.router)===owner)syncView.routers.delete(row.mapping.router);
}
function drainSyncQueue(){
  while(syncView.running<3&&syncView.queue.length){
    const task=syncView.queue.shift();syncView.running++;
    void Promise.resolve().then(task.run).then(task.resolve,task.reject).finally(()=>{syncView.running--;drainSyncQueue();});
  }
}
async function runSyncRows(rows,options,apply,owner){
  const groups=new Map();
  for(const row of rows){const router=row.mapping.router;if(!groups.has(router))groups.set(router,[]);groups.get(router).push(row);}
  const tasks=[...groups.values()].map(groupRows=>new Promise((resolve,reject)=>{
    syncView.queue.push({resolve,reject,run:async()=>{
      try{
        for(const row of groupRows){await(apply?applySyncRow(row,options):checkSyncRow(row,options));syncView.batches.get(owner).completed++;refreshSyncUi();}
        if(apply){invalidateSyncStatus(groupRows[0].mapping.router);await refreshSyncRouter(groupRows[0].group);const pending=groupRows[0].group.rows.find(r=>r.info?.up&&!r.info.connected);if(pending)followSyncConnection(pending.group,pending.mapping.name);}
      }finally{releaseSyncRouters(groupRows,owner);refreshSyncUi();}
    }});
  }));
  drainSyncQueue();
  const results=await Promise.allSettled(tasks);
  const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
}
async function runSyncCheck(){
  if(syncView.loading)return;const rows=syncScope().filter(r=>!syncRouterBusy(r.mapping.router)),options=syncOptions();if(!rows.length)return;
  const owner=Symbol();for(const row of rows)syncView.routers.set(row.mapping.router,owner);
  syncView.batches.set(owner,{completed:0,total:rows.length});refreshSyncUi();
  try{await runSyncRows(rows,options,false,owner);}
  finally{releaseSyncRouters(rows,owner);syncView.batches.delete(owner);syncView.progress='';refreshSyncUi();}
}
async function runSyncApply(){
  if(syncView.loading)return;const rows=syncScope().filter(r=>!syncRouterBusy(r.mapping.router)&&syncNeedsApply(r)),options=syncOptions();if(!rows.length)return;
  const owner=Symbol();for(const row of rows)syncView.routers.set(row.mapping.router,owner);
  syncView.batches.set(owner,{completed:0,total:rows.length});refreshSyncUi();
  try{
    const list=rows.map(r=>`<li>${esc(r.mapping.router)} · ${esc(r.mapping.server)} · ${r.mapping.connType==='openvpn-ui'?'OpenVPN':'AmneziaWG'}<br><span class="muted">${esc(r.mapping.interface)}</span></li>`).join('');
    if(!await showConfirm(`Применить проверенные изменения?<br>Подключений: ${rows.length}<ul class="ss-confirm-list">${list}</ul><span class="muted">Настройки будут записаны и сохранены на роутерах.${options.noRestart?'':' Изменённые активные соединения могут кратковременно перезапуститься.'}</span>`,'Применить изменения'))return;
    await runSyncRows(rows,options,true,owner);
  }finally{releaseSyncRouters(rows,owner);syncView.batches.delete(owner);syncView.progress='';refreshSyncUi();}
}
async function switchSyncConnection(r){
  if(syncView.loading||syncRouterBusy(r.mapping.router)||!r.info||r.info.up)return;
  const owner=Symbol();syncView.routers.set(r.mapping.router,owner);refreshSyncUi();
  invalidateSyncStatus(r.mapping.router);
  try{
    if(!await showConfirm(`Использовать ${esc(r.mapping.server)} (${r.mapping.connType==='openvpn-ui'?'OpenVPN':'AmneziaWG'}) на роутере «${esc(r.mapping.router)}»?<br><span class="muted">Выбранный интерфейс включится, остальные VPN-интерфейсы из маппингов этого роутера выключатся. Соединение может кратковременно прерваться.</span>`,'Переключить подключение'))return;
    const data=await api('/api/router-active',{router:r.mapping.router,mapping:r.mapping.name});
    if(!data.ok)throw new Error(data.error||'Не удалось переключить подключение');
    updateSyncConnections(r.group,data.interfaces||{});followSyncConnection(r.group,r.mapping.name);toast('Подключение переключено');
  }catch(e){toast(e.message,true);}
  finally{releaseSyncRouters([r],owner);refreshSyncUi();}
}

function initSyncUi(){
  $('#syncCheck').onclick=runSyncCheck;$('#syncApply').onclick=runSyncApply;$('#syncReload').onclick=loadSync;
  $('#syncClear').onclick=()=>{syncView.rows.forEach(r=>r.checkbox.checked=false);refreshSyncUi();};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopSyncStatus();else startSyncStatus();});
  refreshSyncUi();
}
