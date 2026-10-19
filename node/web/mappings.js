/* Маппинги: обзор без сетевых запросов и мастер с явными действиями. */
let mappingWizard = null;
const mwLabel = (server, connection) => connKind(server, connection) === 'openvpn' ? 'OpenVPN' : 'AmneziaWG';
const mwOptions = (values, value) => values.map(v => `<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v)}</option>`).join('');
const mwField = (label, control, hint='') => `<label class="mw-field">${label}${control}${hint?`<span class="mw-hint">${hint}</span>`:''}</label>`;
const mwButton = (text, action, primary=false) => `<button type="button" data-mw="${action}" class="${primary?'primary':''}">${text}</button>`;

function renderMappings() {
  const box = $('#mappingsList');
  box.innerHTML = '';
  const routers = DisplayOrder.names(CONFIG,'routers',CONFIG.mappings.map(m=>m.router));
  const mappings = DisplayOrder.mappings(CONFIG);
  for (const router of routers) {
    const rows = mappings.filter(m=>m.router===router);
    const group = document.createElement('section'); group.className='map-router';
    group.innerHTML=`<header class="map-router-head"><div class="map-router-identity">${accessIcon(true)}<div><div class="map-router-label">Роутер</div><strong class="map-router-name">${esc(router)}</strong><div class="map-router-count">Подключений: ${rows.length}</div></div></div><button class="sm map-add">+ Подключение</button></header><div class="map-connections"></div>`;
    $('.map-add',group).onclick=()=>openMappingWizard(router);
    const list=$('.map-connections',group);
    if(!rows.length)list.innerHTML='<div class="map-empty">Добавьте первое VPN-подключение к этому роутеру.</div>';
    for(const m of rows){
      const row=document.createElement('div');row.className='map-item';
      row.innerHTML=`<div class="map-item-main"><div class="map-item-title"><strong>${esc(m.server)}</strong><span class="map-protocol">${esc(mwLabel(m.server,m.connection))}</span></div><div class="map-path">${esc(m.client)} → ${esc(m.interface)}</div></div><div class="map-item-actions"><span class="map-sync-label" title="Этот флаг управляет отображением связи на вкладке «Синхро». Он не меняет состояние VPN на роутере.">${m.enabled===false?'Синхронизация выключена':'Синхронизация включена'}</span><button class="sm map-edit">Настроить</button></div>`;
      $('.map-edit',row).onclick=()=>openMappingWizard(router,m);
      list.appendChild(row);
    }
    box.appendChild(group);
  }
  if(!routers.length)box.innerHTML='<div class="map-empty">Сначала добавьте сервер и роутер на вкладке «Доступы».</div>';
  $('#mappingAdd').onclick=()=>openMappingWizard(entityNames('routers')[0]);
}
function collectMappings(){return CONFIG.mappings.map(m=>({...m}));}

function openMappingWizard(router, mapping=null){
  if(DIRTY_TAB){toast('Сначала сохраните или отмените изменения на вкладке «Доступы»',true);return;}
  if(!Object.keys(CONFIG.routers).length||!Object.keys(CONFIG.servers).length){toast('Добавьте сервер и роутер на вкладке «Доступы»',true);return;}
  const server=mapping?.server||entityNames('servers')[0];
  const connection=mapping?.connection||Object.keys(CONFIG.servers[server]?.connections||{})[0]||'';
  mappingWizard={step:0,phase:'form',busy:false,error:'',previousName:mapping?.name||null,
    form:{router,server,connection,client:mapping?.client||'',interface:mapping?.interface||'',enabled:mapping?.enabled!==false,activate:!mapping},
    clientMode:'existing',interfaceMode:mapping?'existing':'new',withSecrets:mapping?optSecrets():true,clients:null,interfaces:null,clientError:'',interfaceError:'',createdClient:'',saved:false,plan:null,planToken:null};
  $('#mappingOverview').hidden=true;$('#mappingEditor').hidden=false;
  renderMappingWizard();$('.content-scroll').scrollTop=0;
}
function closeMappingWizard(){
  mappingWizard=null;$('#mappingEditor').hidden=true;$('#mappingOverview').hidden=false;renderMappings();
}
function mwSuggestedClient(s){
  const clean=v=>String(v).replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'');
  const base=[clean(s.form.router).slice(0,28)||'Router',mwLabel(s.form.server,s.form.connection)==='OpenVPN'?'OVPN':'AWG',clean(s.form.server).slice(0,16)].join('_').slice(0,58);
  let result=base,n=2;while(s.clients?.includes(result))result=base+'_'+n++;return result;
}
function mwSuggestedInterface(s){
  const base='Antizapret'+(connKind(s.form.server,s.form.connection)==='openvpn'?'OVPN_':'AWG_')+s.form.server.replace(/[^a-zA-Z0-9_-]+/g,'_');
  const used=[...(s.interfaces||[]),...CONFIG.mappings.filter(m=>m.router===s.form.router).map(m=>m.interface)];
  let result=base,n=2;while(used.includes(result))result=base+'_'+n++;return result;
}
async function mwLoadList(s,kind){
  const client=kind==='clients',errorKey=client?'clientError':'interfaceError';
  s.busy=true;s[errorKey]='';renderMappingWizard();
  try{
    const f=s.form;
    const url=client?`/api/panel-clients?server=${encodeURIComponent(f.server)}&connection=${encodeURIComponent(f.connection)}`:`/api/router-interfaces?router=${encodeURIComponent(f.router)}&kind=${connKind(f.server,f.connection)}`;
    const data=await api(url);
    if(mappingWizard!==s)return;
    s[kind]=data[kind]||[];
    if(client){if(s.clientMode==='new'){if(!f.client)f.client=mwSuggestedClient(s);}else if(!f.client)f.client=s.clients[0]||'';}
    else if(s.interfaceMode==='new'){if(!f.interface)f.interface=mwSuggestedInterface(s);}else if(!f.interface)f.interface=s.interfaces[0]||'';
  }catch(e){if(mappingWizard===s)s[errorKey]=e.message;}
  finally{if(mappingWizard===s){s.busy=false;renderMappingWizard();}}
}
function mwModes(s,kind){const client=kind==='client',mode=s[client?'clientMode':'interfaceMode'];return `<div class="mw-modes" role="group" aria-label="${client?'Клиент панели':'Интерфейс роутера'}">${['existing','new'].map(v=>`<button type="button" data-mode-kind="${kind}" data-mode="${v}" aria-pressed="${mode===v}">${v==='existing'?(client?'Выбрать клиента':'Использовать существующий'):(client?'Создать клиента':'Создать новый')}</button>`).join('')}</div>`;}
function mwFormBody(s){
  const f=s.form;
  if(s.step===0)return `<h3>Куда подключаем VPN</h3><p>Выберите роутер и панель, из которой нужно взять конфигурацию.</p><div class="mw-fields">${mwField('Роутер',`<select data-field="router">${mwOptions(entityNames('routers'),f.router)}</select>`)}${mwField('Сервер',`<select data-field="server">${mwOptions(entityNames('servers'),f.server)}</select>`)}${mwField('Тип подключения',`<select data-field="connection">${connOptsFor(f.server,f.connection)}</select>`)}</div>`;
  if(s.step===1||s.step===2){
    const client=s.step===1,kind=client?'client':'interface',list=client?s.clients:s.interfaces,mode=s[client?'clientMode':'interfaceMode'],value=f[kind],loadError=s[client?'clientError':'interfaceError'];
    const missing=mode==='existing'&&value&&list&&!list.includes(value);
    return `<h3>${client?'Клиент в панели '+esc(f.server):'Подключение на роутере'}</h3><p>${client?esc(mwLabel(f.server,f.connection))+' · конфигурация для '+esc(f.router):'Выберите готовый VPN-интерфейс или создайте новый.'}</p>${mwModes(s,kind)}${s.busy?'<p role="status">Загрузка списка…</p>':''}${loadError?`<div class="mw-error" role="alert">${esc(loadError)} ${mwButton('Повторить загрузку','reload')}</div>`:''}<div class="mw-fields">${mwField(mode==='new'?(client?'Имя нового клиента':'Название подключения на роутере'):(client?'Клиент панели':'Интерфейс роутера'),mode==='new'?`<input data-field="${kind}" value="${esc(value)}" ${client?'maxlength="64"':''}>`:`<select data-field="${kind}"><option value="">${missing?'Сохранённое значение не найдено':(list?.length?'Выберите из списка':'Список пуст')}</option>${mwOptions(list||[],value)}</select>`,mode==='new'?(client?'Уникальное имя в выбранной панели.':'Системный номер интерфейса подберётся автоматически.'):'')}${missing?`<span class="mw-hint">Не найдено: ${esc(value)}. Выберите другое значение или создание нового.</span>`:''}</div>${mode==='new'?`<div class="mw-note">${client?(connKind(f.server,f.connection)==='openvpn'?'Будет выпущен клиентский сертификат OpenVPN.':'Будет создан клиент AmneziaWG.')+' Создание произойдёт после проверки выбранных параметров.':'Новый интерфейс появится только после применения плана. Сначала вы увидите изменения.'}</div>`:''}`;
  }
  const server=CONFIG.servers[f.server];
  return `<h3>Проверьте выбранные параметры</h3><p>Панель → клиент → интерфейс роутера.</p><dl class="mw-review">${[['Роутер',f.router],['Панель',f.server+' · '+mwLabel(f.server,f.connection)],['Клиент',(s.clientMode==='new'?'Создать: ':'')+f.client],['Интерфейс',(s.interfaceMode==='new'?'Создать: ':'')+f.interface],['Адрес VPN',server?.useDomain?server.domain:(server?.host||'Из конфигурации панели')]].map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><label class="mw-check"><input data-field="enabled" type="checkbox" ${f.enabled?'checked':''}>Синхронизация включена</label><div class="mw-hint">Связь будет доступна на вкладке «Синхро». Этот флаг не включает и не выключает VPN на роутере.</div><label class="mw-check"><input data-field="activate" type="checkbox" ${s.interfaceMode==='new'||f.activate?'checked':''} ${s.interfaceMode==='new'?'disabled':''}>Использовать это подключение после применения</label><div class="mw-hint">Перед включением выбранного VPN остальные управляемые VPN-подключения этого роутера будут выключены.</div>${s.withSecrets&&connKind(f.server,f.connection)==='wireguard'?'<div class="mw-note">При применении будут записаны ключи выбранного клиента. Существующий интерфейс начнёт использовать его конфигурацию.</div>':''}${s.createdClient?`<div class="mw-note">Клиент ${esc(s.createdClient)} уже создан в панели.</div>`:''}`;
}
function renderMappingWizard(){
  const s=mappingWizard;if(!s)return;const f=s.form,box=$('#mappingEditor');
  let body,actions;
  if(s.phase==='complete'){
    body=`<h3>Настройки применены</h3><p>${esc(f.server)} · ${esc(mwLabel(f.server,f.connection))} → ${esc(f.router)}</p><div class="mw-note">${esc(f.client)} → ${esc(f.interface)}</div>`;
    actions=mwButton('К подключениям','close',true);
  }else if(s.phase==='plan'){
    body=`<h3>${s.plan?(s.plan.mode==='create'?'Будет создан интерфейс':s.plan.mode==='noop'?'Изменения не требуются':'Будет обновлён интерфейс'):'Проверка настроек'}</h3><p>Связь сохранена.${s.createdClient?' Клиент '+esc(s.createdClient)+' создан в панели.':''}</p><div class="mw-plan" id="mwPlan"></div>${s.busy?'<p role="status">Получаем настройки панели и роутера…</p>':''}${s.plan?.mode==='create'?'<div class="mw-note">Применение создаст и включит новый интерфейс на роутере.</div>':''}`;
    actions=`<div class="mw-footer-group">${mwButton('Применить позже','close')}${s.error?mwButton('Изменить параметры','edit-plan'):''}</div><div class="mw-footer-group">${mwButton('Проверить ещё раз','plan')}${s.plan&&s.plan.mode!=='error'?(s.plan.mode==='noop'?'':mwButton(s.plan.mode==='create'?'Создать интерфейс на роутере':'Применить изменения','apply',true)):''}</div>`;
  }else{
    body=mwFormBody(s);
    actions=`<div class="mw-footer-group">${mwButton(s.step?'Назад':'Отмена',s.step?'prev':'close')}${s.previousName&&s.step===0?'<button type="button" class="danger" data-mw="delete">Удалить связь</button>':''}</div>${mwButton(s.step===3?(s.clientMode==='new'?'Создать клиента и проверить':'Сохранить и проверить'):'Далее','next',true)}`;
  }
  box.innerHTML=`<button type="button" class="mw-back sm" data-mw="close">← К подключениям</button><div class="mw-heading"><div><h2>${s.previousName?'Настройка подключения':'Новое подключение'}</h2><span class="muted">${esc(f.router)}</span></div></div><section class="mw-box"><ol class="mw-steps">${['Источник','Клиент','Интерфейс','Проверка'].map((name,i)=>`<li class="mw-step ${i===s.step?'current':''}" ${i===s.step?'aria-current="step"':''}><span>${i<s.step?'✓':i+1}</span>${name}</li>`).join('')}</ol><div class="mw-body" aria-live="polite">${body}${s.error?`<div class="mw-error" role="alert">${esc(s.error)}</div>`:''}</div><footer class="mw-footer">${actions}</footer></section>`;
  if(s.plan&&$('#mwPlan'))renderPlan($('#mwPlan'),s.plan,s.withSecrets);
  if(s.busy)$$('button,input,select',box).forEach(el=>el.disabled=true);
  box.oninput=e=>{if(e.target.dataset.field)f[e.target.dataset.field]=e.target.type==='checkbox'?e.target.checked:e.target.value;};
  box.onchange=e=>{
    const key=e.target.dataset.field;if(!key)return;
    f[key]=e.target.type==='checkbox'?e.target.checked:e.target.value;
    if(['client','interface','router','server','connection'].includes(key))s.withSecrets=true;
    if(['router','server','connection'].includes(key)){
      if(key==='server')f.connection=Object.keys(CONFIG.servers[f.server]?.connections||{})[0]||'';
      f.client='';f.interface='';s.clients=null;s.interfaces=null;s.clientMode='existing';s.interfaceMode='new';renderMappingWizard();
    }
  };
  box.onclick=async e=>{
    const btn=e.target.closest('button');if(!btn||s.busy)return;
    if(btn.dataset.modeKind){const client=btn.dataset.modeKind==='client';s.withSecrets=true;s[client?'clientMode':'interfaceMode']=btn.dataset.mode;f[client?'client':'interface']=btn.dataset.mode==='new'?(client?mwSuggestedClient(s):mwSuggestedInterface(s)):((client?s.clients:s.interfaces)?.includes(f[client?'client':'interface'])?f[client?'client':'interface']:((client?s.clients:s.interfaces)?.[0]||''));s.error='';renderMappingWizard();return;}
    if(btn.dataset.mw)await mappingWizardAction(s,btn.dataset.mw);
  };
}
async function mappingWizardAction(s,action){
  if(mappingWizard!==s||s.busy)return;s.error='';
  try{
    if(action==='close'){closeMappingWizard();return;}
    if(action==='delete'){
      if(!await showConfirm('Удалить эту связь?<br><span class="muted">Клиент в панели и интерфейс на роутере сохранятся.</span>','Удалить связь'))return;
      s.busy=true;renderMappingWizard();const data=await api('/api/mapping-remove',{name:s.previousName});CONFIG=data.config;closeMappingWizard();toast('Связь удалена');return;
    }
    if(action==='prev'){s.step--;renderMappingWizard();return;}
    if(action==='reload'){await mwLoadList(s,s.step===1?'clients':'interfaces');return;}
    if(action==='plan'){await mwCheckPlan(s);return;}
    if(action==='edit-plan'){s.phase='form';s.step=2;await mwLoadList(s,'interfaces');return;}
    if(action==='apply'){
      s.busy=true;renderMappingWizard();
      const data=await api('/api/apply',{name:s.previousName,interfaceMode:s.interfaceMode,planToken:s.planToken,withSecrets:s.withSecrets,noRestart:optNoRestart(),activate:s.form.activate||s.interfaceMode==='new'},180000);
      if(!data.result?.ok)throw new Error((data.result?.errors||[data.plan?.error||'Не удалось применить настройки']).join('; '));
      if(data.result.remaining>0||data.result.foundAfter===false||data.result.verified===false)throw new Error('Команды отправлены, но итоговая проверка не подтвердила все настройки. Проверьте план ещё раз');
      s.phase='complete';s.busy=false;renderMappingWizard();return;
    }
    if(action!=='next')return;
    const f=s.form;
    if(s.step===0){if(!CONFIG.routers[f.router]||!CONFIG.servers[f.server]?.connections[f.connection])throw new Error('Выберите доступные роутер, сервер и подключение');s.step=1;await mwLoadList(s,'clients');return;}
    if(s.step===1){
      f.client=f.client.trim();if(!s.clients||s.clientError)throw new Error('Сначала загрузите список клиентов');
      if(s.clientMode==='existing'&&!s.clients.includes(f.client))throw new Error('Выберите существующего клиента');
      if(s.clientMode==='new'&&(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(f.client)||s.clients.includes(f.client)))throw new Error('Введите уникальное имя: 1–64 латинских буквы, цифры, дефис или подчёркивание');
      s.step=2;await mwLoadList(s,'interfaces');return;
    }
    if(s.step===2){
      f.interface=f.interface.trim();if(!s.interfaces||s.interfaceError)throw new Error('Сначала загрузите список интерфейсов');
      if(!f.interface||/[\r\n\0"\\]/.test(f.interface))throw new Error('Укажите название подключения без кавычек и управляющих символов');
      if(s.interfaceMode==='existing'&&!s.interfaces.includes(f.interface))throw new Error('Выберите существующий интерфейс');
      if(s.interfaceMode==='new'&&s.interfaces.includes(f.interface))throw new Error('Такой интерфейс уже есть. Выберите существующий или задайте другое название');
      s.step=3;renderMappingWizard();return;
    }
    if(DIRTY_TAB)throw new Error('Сначала сохраните или отмените изменения на вкладке «Доступы»');
    s.busy=true;renderMappingWizard();
    if(s.clientMode==='new'){
      await api('/api/panel-client-create',{server:f.server,connection:f.connection,name:f.client},120000);
      s.createdClient=f.client;s.clientMode='existing';s.clients.push(f.client);
    }
    const data=await api('/api/mapping-save',{mapping:f,previousName:s.previousName});
    CONFIG=data.config;s.previousName=data.mapping.name;s.saved=true;s.busy=false;s.phase='plan';
    renderMappings();await mwCheckPlan(s);
  }catch(e){s.error=e.message;s.busy=false;if(action==='apply'){if(s.plan?.mode==='create'){s.interfaceMode='existing';s.form.activate=true;}s.plan=null;s.planToken=null;}renderMappingWizard();}
}
async function mwCheckPlan(s){
  s.busy=true;s.error='';s.plan=null;s.planToken=null;renderMappingWizard();
  try{
    const data=await api('/api/plan',{name:s.previousName,interfaceMode:s.interfaceMode,withSecrets:s.withSecrets,noRestart:optNoRestart(),activate:s.form.activate||s.interfaceMode==='new'},180000);
    s.plan=data.plan;s.planToken=data.planToken;if(s.plan.error)throw new Error(s.plan.error);
  }catch(e){s.error=e.message;}
  finally{s.busy=false;if(mappingWizard===s)renderMappingWizard();}
}
