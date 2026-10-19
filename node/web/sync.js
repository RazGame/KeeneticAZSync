/* Единая область действий: все связи или отмеченные. Применяем только проверенные планы. */
const syncView={rows:[],groups:[],busy:false,loading:false,sequence:0,progress:''};
const syncOptions=()=>({withSecrets:optSecrets(),noRestart:optNoRestart()});
const syncOptionsKey=()=>JSON.stringify(syncOptions());
const syncScope=()=>{const selected=syncView.rows.filter(r=>r.checkbox.checked);return selected.length?selected:syncView.rows;};
const syncNeedsApply=r=>r.plan&&!r.plan.error&&r.plan.mode!=='error'&&r.plan.mode!=='noop'&&r.planToken&&r.optionsKey===syncOptionsKey();
const syncStatus=(el,text,kind='')=>{el.className=el.classList.contains('ss-vpn')?'ss-status ss-vpn '+kind:'ss-status ss-config '+kind;el.textContent=text;};

function refreshSyncUi(){
  const selected=syncView.rows.filter(r=>r.checkbox.checked),scope=syncScope(),changed=scope.filter(syncNeedsApply);
  const locked=syncView.busy||syncView.loading||speedTestBusy();
  $('#syncScope').textContent=selected.length?`Выбрано подключений: ${selected.length}`:'Все подключения';
  $('#syncClear').hidden=!selected.length;$('#syncClear').disabled=locked;
  $('#syncCheck').textContent=selected.length?`Проверить выбранные (${selected.length})`:'Проверить все';
  $('#syncCheck').disabled=locked||!scope.length;
  $('#syncApply').textContent=changed.length?`Применить изменения (${changed.length})`:'Применить изменения';
  $('#syncApply').disabled=locked||!changed.length;
  $('#syncApply').classList.toggle('primary',changed.length>0);
  $('#syncCheck').classList.toggle('primary',changed.length===0);
  $('#syncReload').disabled=locked;
  $('#swRestart').disabled=$('#swSecrets').disabled=locked;
  const checked=scope.filter(r=>r.checked).length,errors=scope.filter(r=>r.error).length;
  $('#syncSummary').textContent=syncView.progress||(syncView.loading?'Загрузка подключений…':checked?`Проверено: ${checked} из ${scope.length} · с изменениями: ${changed.length}${errors?' · ошибок: '+errors:''}`:'Отметьте нужные подключения или проверьте все. Затем примените найденные изменения.');
  for(const g of syncView.groups){
    const on=g.rows.filter(r=>r.checkbox.checked).length;
    g.checkbox.checked=on>0&&on===g.rows.length;g.checkbox.indeterminate=on>0&&on<g.rows.length;g.checkbox.disabled=locked;
  }
  for(const r of syncView.rows){r.checkbox.disabled=locked;r.switchButton.disabled=locked;refreshSpeedTestEntry(r);}
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
  try{const data=await api(`/api/router-status?router=${encodeURIComponent(group.router)}`);if(sequence!==syncView.sequence)return;updateSyncConnections(group,data.interfaces||{},data.ok?'':data.error||'Роутер недоступен');}
  catch(e){if(sequence===syncView.sequence)updateSyncConnections(group,{},e.message);}
}

async function loadSync(){
  if(syncView.busy||syncView.loading)return;
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
      syncView.groups.push(group);box.appendChild(el);void refreshSyncRouter(group,sequence);
    }
    if(!groups.size)box.innerHTML='<div class="ss-empty">Нет подключений для синхронизации. Добавьте связь на вкладке «Маппинги» и включите для неё синхронизацию.</div>';
    $('#syncmsg').textContent=`Подключений: ${syncView.rows.length} · роутеров: ${groups.size}`;
    await restoreSpeedTest();
  }catch(e){syncView.progress='Не удалось загрузить подключения: '+e.message;}
  finally{syncView.loading=false;refreshSyncUi();}
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

async function runSyncCheck(){
  if(syncView.busy||syncView.loading||speedTestBusy())return;const rows=syncScope().slice(),options=syncOptions();if(!rows.length)return;
  syncView.busy=true;refreshSyncUi();
  try{for(let i=0;i<rows.length;i++){syncView.progress=`Проверяем подключения: ${i+1} из ${rows.length}`;refreshSyncUi();await checkSyncRow(rows[i],options);}}
  finally{syncView.busy=false;syncView.progress='';refreshSyncUi();}
}
async function runSyncApply(){
  if(syncView.busy||syncView.loading||speedTestBusy())return;const rows=syncScope().filter(syncNeedsApply),options=syncOptions();if(!rows.length)return;
  syncView.busy=true;refreshSyncUi();
  try{
    const list=rows.map(r=>`<li>${esc(r.mapping.router)} · ${esc(r.mapping.server)} · ${r.mapping.connType==='openvpn-ui'?'OpenVPN':'AmneziaWG'}<br><span class="muted">${esc(r.mapping.interface)}</span></li>`).join('');
    if(!await showConfirm(`Применить проверенные изменения?<br>Подключений: ${rows.length}<ul class="ss-confirm-list">${list}</ul><span class="muted">Настройки будут записаны и сохранены на роутерах.${options.noRestart?'':' Изменённые активные соединения могут кратковременно перезапуститься.'}</span>`,'Применить изменения'))return;
    for(let i=0;i<rows.length;i++){syncView.progress=`Применяем изменения: ${i+1} из ${rows.length}`;refreshSyncUi();await applySyncRow(rows[i],options);}
    for(const group of new Set(rows.map(r=>r.group)))void refreshSyncRouter(group);
  }finally{syncView.busy=false;syncView.progress='';refreshSyncUi();}
}
async function switchSyncConnection(r){
  if(syncView.busy||speedTestBusy()||!r.info||r.info.up)return;
  syncView.busy=true;refreshSyncUi();
  try{
    if(!await showConfirm(`Использовать ${esc(r.mapping.server)} (${r.mapping.connType==='openvpn-ui'?'OpenVPN':'AmneziaWG'}) на роутере «${esc(r.mapping.router)}»?<br><span class="muted">Выбранный интерфейс включится, остальные VPN-интерфейсы из маппингов этого роутера выключатся. Соединение может кратковременно прерваться.</span>`,'Переключить подключение'))return;
    const data=await api('/api/router-active',{router:r.mapping.router,mapping:r.mapping.name});
    if(!data.ok)throw new Error(data.error||'Не удалось переключить подключение');
    updateSyncConnections(r.group,data.interfaces||{});toast('Подключение переключено');
  }catch(e){toast(e.message,true);}
  finally{syncView.busy=false;refreshSyncUi();}
}

function initSyncUi(){
  $('#syncCheck').onclick=runSyncCheck;$('#syncApply').onclick=runSyncApply;$('#syncReload').onclick=loadSync;
  $('#syncClear').onclick=()=>{syncView.rows.forEach(r=>r.checkbox.checked=false);refreshSyncUi();};
  refreshSyncUi();
}
