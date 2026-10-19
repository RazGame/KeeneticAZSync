/* On-demand panel counters; bounded session history, no polling off this tab. */
const trafficView = { active:false, paused:false, refreshing:false, source:'server', startedAt:0, sequence:0, cards:new Map(), timers:new Map(), inflight:new Set(), excluded:new Set(), routerStates:new Map(), fresh:new Set(), history:null, config:null, uid:0 };
const TRAFFIC_HISTORY_KEY='awg_sync_traffic_panel_v1';
function trafficHistory() {
  if(trafficView.history)return trafficView.history;
  const history=new Map();
  try{
    const raw=sessionStorage.getItem(TRAFFIC_HISTORY_KEY);
    if(raw&&raw.length<=1500000){
      const data=JSON.parse(raw);
      if(Array.isArray(data))for(const entry of data.slice(-64)){
        if(!Array.isArray(entry)||typeof entry[0]!=='string'||entry[0].length>100||!Array.isArray(entry[1]))continue;
        const points=entry[1].slice(-240).filter(p=>p&&Number.isFinite(p.at)&&p.at>=Date.now()-600000&&p.at<=Date.now()+60000&&['down','up'].every(k=>p[k]===null||(Number.isFinite(p[k])&&p[k]>=0))&&(!p.duration||(Number.isFinite(p.duration)&&p.duration>0&&p.duration<=30)))
          .map(p=>({at:p.at,down:p.down,up:p.up,duration:p.duration})).sort((a,b)=>a.at-b.at);
        if(points.length)history.set(entry[0],points);
      }
    }
  }catch{}
  return trafficView.history=history;
}
function saveTrafficHistory() {
  const history=trafficHistory();
  for(const card of trafficView.cards.values())if(card.connection)history.set(card.key,card.points);
  for(const [key,points]of history)if(!points.length||points[points.length-1].at<Date.now()-600000)history.delete(key);
  while(history.size>64)history.delete(history.keys().next().value);
  try{sessionStorage.setItem(TRAFFIC_HISTORY_KEY,JSON.stringify([...history]));}catch{}
}
function clearTrafficHistory() {
  trafficView.history=new Map();trafficView.routerStates.clear();
  for(const card of trafficView.cards.values())card.el.remove();
  trafficView.cards.clear();
  try{sessionStorage.removeItem(TRAFFIC_HISTORY_KEY);}catch{}
}
function recordTrafficRouterState(router,interfaces,error='',{checkedAt=Date.now(),restart=true}={}) {
  trafficView.routerStates.set(router,{interfaces:error?null:interfaces,checkedAt,error,
    signature:JSON.stringify((CONFIG.mappings||[]).filter(m=>m.router===router).map(m=>[m.name,m.server,m.connection,m.client,m.interface,m.enabled]))});
  if(restart&&trafficView.active)startTrafficMonitor();
}
function trafficRouterState(router) {
  const state=trafficView.routerStates.get(router);
  const signature=JSON.stringify((CONFIG.mappings||[]).filter(m=>m.router===router).map(m=>[m.name,m.server,m.connection,m.client,m.interface,m.enabled]));
  return state?.signature===signature?state:null;
}
function trafficMappings(router) {
  const state=trafficRouterState(router);
  if(!state?.interfaces)return null;
  const clean=v=>String(v||'').replace(/^["'\s]+|["'\s]+$/g,'');
  return(CONFIG.mappings||[]).filter(m=>m.router===router&&m.enabled!==false&&state.interfaces[clean(m.interface)]?.up).map(m=>m.name);
}
const trafficNames = () => {
  const enabled = new Set((CONFIG?.mappings || []).filter(m=>m.enabled!==false).map(m=>m.router));
  return DisplayOrder.names(CONFIG || {},'routers').filter(name=>enabled.has(name)&&!trafficView.excluded.has(name));
};
const trafficRate = value => {
  if (!Number.isFinite(value) || value < 0) return '—';
  const scale=value>=1e9?[1e9,'Гбит/с']:value>=1e6?[1e6,'Мбит/с']:value>=1e3?[1e3,'Кбит/с']:[1,'бит/с'];
  return (value/scale[0]).toLocaleString('ru-RU',{maximumFractionDigits:1})+' '+scale[1];
};
const trafficTime = at => new Date(at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const trafficVisible = () => trafficView.active && !trafficView.paused && !document.hidden && $('#tab-traffic').classList.contains('show');

function appendTrafficPoint(points, point) {
  if (points.length && point.at<=points[points.length-1].at) return points;
  return [...points.filter(p=>p.at>=point.at-600000),point].slice(-240);
}

function trafficChart(points, end, windowSeconds, uid, width=600) {
  const left=60,right=width-16,top=12,bottom=154,start=end-windowSeconds*1000;
  const valid=points.filter(p=>p.at>=start&&p.at<=end);
  const values=valid.flatMap(p=>[p.down,p.up]).filter(Number.isFinite);
  const peak=Math.max(1000,...values),magnitude=10**Math.floor(Math.log10(peak));
  const max=Math.ceil(peak/magnitude)*magnitude;
  const x=at=>left+(at-start)/(end-start)*(right-left),y=value=>bottom-Math.min(max,Math.max(0,value))/max*(bottom-top);
  const paths=key=>{
    const segments=[];let segment=[];
    for(const point of valid){
      if(!Number.isFinite(point[key])||(segment.length&&point.at-segment[segment.length-1].at>15000)){if(segment.length)segments.push(segment);segment=[];}
      if(Number.isFinite(point[key]))segment.push(point);
    }
    if(segment.length)segments.push(segment);
    return segments.map(s=>{
      const line=s.map((p,i)=>`${i?'L':'M'}${x(p.at).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ');
      return `<path d="${line} L${x(s[s.length-1].at).toFixed(2)},${bottom} L${x(s[0].at).toFixed(2)},${bottom} Z" fill="url(#traffic-${uid}-${key})"/><path d="${line}" fill="none" stroke="${key==='down'?'#0079d8':'#8661cf'}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('');
  };
  const ticks=[0,.5,1].map(r=>`<line x1="${left}" x2="${right}" y1="${y(max*r)}" y2="${y(max*r)}" stroke="#e8edf2" stroke-dasharray="3 4"/><text x="${left-8}" y="${y(max*r)+3}" text-anchor="end" fill="#8795a7" font-size="10">${esc(trafficRate(max*r))}</text>`).join('');
  const times=[0,.5,1].map(r=>`<text x="${left+r*(right-left)}" y="180" text-anchor="${r===0?'start':r===1?'end':'middle'}" fill="#8795a7" font-size="10">${esc(trafficTime(start+r*(end-start)))}</text>`).join('');
  return `<svg viewBox="0 0 ${width} 190" role="img" aria-label="Скорость VPN за последние ${windowSeconds/60} минуты: синяя линия — скачивание, фиолетовая — отдача"><defs>${['down','up'].map(key=>`<linearGradient id="traffic-${uid}-${key}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${key==='down'?'#0079d8':'#8661cf'}" stop-opacity=".18"/><stop offset="100%" stop-color="${key==='down'?'#0079d8':'#8661cf'}" stop-opacity=".01"/></linearGradient>`).join('')}</defs>${ticks}${paths('down')}${paths('up')}${times}<line class="traffic-crosshair" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="#94a3b8" stroke-dasharray="3 3" hidden/></svg><div class="traffic-tooltip" hidden></div>${values.length<2?'<div class="traffic-chart-caption">'+(values.length?'График накапливает данные…':'Ожидаем два замера счётчиков…')+'</div>':''}`;
}

function drawTrafficCard(card) {
  const c=card.connection,windowSeconds=Number($('#trafficWindow').value),end=trafficView.paused&&card.sampledAt?card.sampledAt:Date.now()+(card.offset||0);
  const points=card.points.filter(p=>p.at>=end-windowSeconds*1000),latest=points[points.length-1];
  const live=card.state==='ok'&&c?.state==='live';
  const current=live?latest:null;
  const details=(key)=>{
    const samples=points.filter(p=>Number.isFinite(p[key])),values=samples.map(p=>p[key]);
    const duration=samples.reduce((sum,p)=>sum+(p.duration||1),0);
    return values.length?`Средняя ${trafficRate(samples.reduce((sum,p)=>sum+p[key]*(p.duration||1),0)/duration)} · пик ${trafficRate(Math.max(...values))}`:'Накапливаем историю';
  };
  const mappings=c?.mappings||[];
  const connection=mappings.length===1?`${mappings[0].server} · ${mappings[0].protocol}`:mappings.length?mappings.map(m=>`${m.server} · ${m.protocol}`).join(' / '):'Активное VPN-подключение';
  const label=card.state==='error'?'Нет связи':card.state==='busy'?'Настройка':card.state==='idle'?'Нет сессии':live?(card.source==='router'?'Данные роутера':'Данные панели'):card.state==='loading'?'Загрузка':'Первый замер';
  const message=card.error||card.message||(c?.state==='warming'?'Первый замер после подключения или сброса счётчиков. Скорость появится со следующим обновлением.':'');
  const chartWidth=Math.max(320,Math.min(600,card.el.clientWidth||600));
  const routerState=trafficRouterState(card.router),stateNote=card.source==='router'?'Активный интерфейс проверяется с каждым замером':routerState?.interfaces?'Роутер проверен '+trafficTime(routerState.checkedAt):'Подключение определено по обмену с сервером';
  const shared=c?.sharedSessions>1?' · несколько сессий одного клиента':'';
  card.el.innerHTML=`<header class="traffic-head">${accessIcon(true)}<div class="traffic-identity"><strong>${esc(card.router)}</strong><span class="traffic-connection">${esc(connection)}</span></div><span class="traffic-badge ${card.state==='error'?'error':live?'':'wait'}">${label}</span></header><div class="traffic-body"><div class="traffic-rates"><div class="traffic-metric traffic-download"><span>↓ Скачивание</span><strong>${esc(trafficRate(current?.down))}</strong><small>${esc(details('down'))}</small></div><div class="traffic-metric traffic-upload"><span>↑ Отдача</span><strong>${esc(trafficRate(current?.up))}</strong><small>${esc(details('up'))}</small></div></div>${message?`<p class="traffic-message ${card.state==='error'?'error':''}">${esc(message)}</p>`:''}<div class="traffic-chart">${trafficChart(card.points,end,windowSeconds,card.uid,chartWidth)}</div><div class="traffic-bottom"><span>${esc(c?`${c.description} → ${c.interfaceName}${shared}`:'Только VPN из маппингов')}</span><span>${card.sampledAt?'Замер '+trafficTime(card.sampledAt):'Ожидаем данные'}</span><span>${esc(stateNote)}</span></div></div>`;
  const chart=$('.traffic-chart',card.el),svg=$('svg',chart),tooltip=$('.traffic-tooltip',chart),crosshair=$('.traffic-crosshair',chart);
  svg.onpointermove=event=>{
    const rect=svg.getBoundingClientRect(),relative=(event.clientX-rect.left)/rect.width*chartWidth;
    const at=end-windowSeconds*1000+Math.max(0,Math.min(1,(relative-60)/(chartWidth-16-60)))*windowSeconds*1000;
    const candidates=card.points.filter(p=>p.at>=end-windowSeconds*1000&&Number.isFinite(p.down)&&Number.isFinite(p.up));
    if(!candidates.length)return;
    const point=candidates.reduce((best,p)=>Math.abs(p.at-at)<Math.abs(best.at-at)?p:best);
    tooltip.textContent=`${trafficTime(point.at)}\n↓ ${trafficRate(point.down)}\n↑ ${trafficRate(point.up)}`;tooltip.hidden=false;
    const x=60+(point.at-(end-windowSeconds*1000))/(windowSeconds*1000)*(chartWidth-16-60);crosshair.setAttribute('x1',x);crosshair.setAttribute('x2',x);crosshair.hidden=false;crosshair.removeAttribute('hidden');
  };
  svg.onpointerleave=()=>{tooltip.hidden=true;crosshair.setAttribute('hidden','');};
}

function orderTrafficCards() {
  const names=trafficNames(),rank=new Map(names.map((name,i)=>[name,i])),selected=$('#trafficRouter').value;
  const cards=[...trafficView.cards.values()].sort((a,b)=>(rank.get(a.router)??999)-(rank.get(b.router)??999)||(a.position||0)-(b.position||0));
  for(const card of cards){card.el.hidden=!!selected&&card.router!==selected;$('#trafficCards').appendChild(card.el);}
}

function applyTrafficSnapshot(snapshot,first=false) {
  if(snapshot.source==='router'&&['ok','idle'].includes(snapshot.state)){
    const interfaces=Object.fromEntries((CONFIG.mappings||[]).filter(m=>m.router===snapshot.router).map(m=>[String(m.interface).replace(/^["'\s]+|["'\s]+$/g,''),{up:false}]));
    for(const c of snapshot.connections)for(const m of c.mappings)interfaces[String(m.interface).replace(/^["'\s]+|["'\s]+$/g,'')]={up:true,connected:true};
    recordTrafficRouterState(snapshot.router,interfaces,'',{checkedAt:snapshot.capturedAt,restart:false});
  }
  if(snapshot.state==='excluded'){
    trafficView.excluded.add(snapshot.router);
    startTrafficMonitor();
    return;
  }
  const existing=[...trafficView.cards.values()].filter(c=>c.router===snapshot.router);
  const items=snapshot.state==='ok'?snapshot.connections:[];
  const keepError=['error','busy'].includes(snapshot.state)&&existing.some(c=>c.connection);
  const desired=items.length?items.map((connection,position)=>({key:connection.id,connection,position})):keepError?existing.filter(c=>c.connection).map(c=>({key:c.key,connection:c.connection,position:c.position})):[{key:'router:'+snapshot.router,connection:null,position:0}];
  const keys=new Set(desired.map(item=>item.key));
  for(const old of existing)if(!keys.has(old.key)){old.el.remove();trafficView.cards.delete(old.key);}
  for(const item of desired){
    let card=trafficView.cards.get(item.key);
    if(!card){const el=document.createElement('article');el.className='traffic-card';card={key:item.key,el,uid:++trafficView.uid,router:snapshot.router,points:trafficHistory().get(item.key)||[]};trafficView.cards.set(item.key,card);$('#trafficCards').appendChild(el);}
    Object.assign(card,{source:snapshot.source||trafficView.source,connection:item.connection,position:item.position,state:snapshot.state,error:snapshot.error,message:snapshot.message});
    const sampledAt=snapshot.state==='ok'?(item.connection?.sampledAt||snapshot.capturedAt):snapshot.capturedAt;
    if(!card.sampledAt||sampledAt>card.sampledAt){card.offset=(snapshot.servedAt||sampledAt)-Date.now();card.sampledAt=sampledAt;}
    else if(snapshot.servedAt)card.offset=snapshot.servedAt-Date.now();
    const good=!first&&snapshot.state==='ok'&&item.connection?.state==='live';
    if(first&&item.connection)card.connection={...item.connection,state:'warming'};
    if(item.connection){
      // Resume/reload always introduces a gap, including a cached sample with the same timestamp.
      if(first)card.points=card.points.filter(p=>p.at<sampledAt);
      card.points=appendTrafficPoint(card.points,{at:sampledAt,down:good?item.connection.downloadBps:null,up:good?item.connection.uploadBps:null,duration:good?item.connection.intervalSeconds:null});
    }
    drawTrafficCard(card);
  }
  orderTrafficCards();
  saveTrafficHistory();
}

function trafficSchedule(router,wait=10000) {
  clearTimeout(trafficView.timers.get(router));
  if(!trafficVisible()||!trafficNames().includes(router))return;
  if($('#trafficRouter').value&&$('#trafficRouter').value!==router)return;
  const sequence=trafficView.sequence;
  trafficView.timers.set(router,setTimeout(()=>trafficTick(router,sequence),wait));
}

async function trafficTick(router,sequence) {
  if(!trafficVisible()||sequence!==trafficView.sequence)return;
  if(trafficView.inflight.has(router)||trafficView.inflight.size>=3){trafficSchedule(router,1000);return;}
  trafficView.inflight.add(router);
  try{
    const selected=trafficView.source==='server'?trafficMappings(router):null,query=selected===null?'':selected.length?selected.map(name=>'&mapping='+encodeURIComponent(name)).join(''):'&mapping=';
    const data=await api('/api/traffic?router='+encodeURIComponent(router)+'&source='+trafficView.source+query,undefined,65000);
    if(trafficVisible()&&sequence===trafficView.sequence){
      const first=trafficView.fresh.has(router);
      // A cached counter from before resume cannot establish an observed interval.
      const startedAt=trafficView.startedAt+(data.servedAt||data.capturedAt)-Date.now();
      if(data.connections.every(c=>c.sampledAt>=startedAt-100))trafficView.fresh.delete(router);
      applyTrafficSnapshot(data,first);
    }
  }catch(error){
    const offset=[...trafficView.cards.values()].find(card=>card.router===router)?.offset||0;
    if(trafficVisible()&&sequence===trafficView.sequence)applyTrafficSnapshot({router,state:'error',capturedAt:Date.now()+offset,connections:[],error:error.message});
  }finally{trafficView.inflight.delete(router);if(sequence===trafficView.sequence)trafficSchedule(router);}
}

function stopTrafficMonitor() {
  saveTrafficHistory();
  trafficView.active=false;trafficView.sequence++;
  for(const timer of trafficView.timers.values())clearTimeout(timer);
  trafficView.timers.clear();
}

function startTrafficMonitor() {
  stopTrafficMonitor();trafficView.active=true;trafficView.startedAt=Date.now();
  if(trafficView.config!==CONFIG){trafficView.config=CONFIG;trafficView.excluded.clear();}
  const names=trafficNames(),select=$('#trafficRouter'),selected=names.includes(select.value)?select.value:'';
  trafficView.fresh=new Set(names);
  select.innerHTML='<option value="">Все роутеры</option>'+names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');select.value=selected;
  for(const [key,card]of trafficView.cards)if(!names.includes(card.router)||card.source!==trafficView.source){card.el.remove();trafficView.cards.delete(key);}
  $('#trafficPause').textContent=trafficView.paused?'Продолжить':'Пауза';
  $('#trafficRefresh').disabled=trafficView.paused||trafficView.source==='router'||trafficView.refreshing;
  $('#trafficLive').textContent=trafficView.paused?'На паузе':'Обновление каждые 10 с';$('#trafficLive').classList.toggle('paused',trafficView.paused);
  if(!names.length){$('#trafficCards').innerHTML='<div class="ss-empty">Нет подключений с включённой синхронизацией. Включите её для нужных подключений на вкладке «Маппинги».</div>';return;}
  if(!trafficView.cards.size)$('#trafficCards').textContent='';
  for(const router of names){
    if(![...trafficView.cards.values()].some(c=>c.router===router))applyTrafficSnapshot({router,state:'loading',capturedAt:Date.now(),connections:[]});
    if(!selected||router===selected)trafficSchedule(router,0);
  }
  orderTrafficCards();
}

function initTrafficUi() {
  $('#trafficSource').onchange=()=>{trafficView.source=$('#trafficSource').value;startTrafficMonitor();};
  $('#trafficRouter').onchange=startTrafficMonitor;
  $('#trafficWindow').onchange=()=>{for(const card of trafficView.cards.values())drawTrafficCard(card);};
  $('#trafficPause').onclick=()=>{trafficView.paused=!trafficView.paused;startTrafficMonitor();};
  $('#trafficRefresh').onclick=refreshTrafficConnections;
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopTrafficMonitor();else if($('#tab-traffic').classList.contains('show')&&AUTHENTICATED)startTrafficMonitor();});
}

async function refreshTrafficConnections() {
  const button=$('#trafficRefresh');if(button.disabled||trafficView.refreshing)return;
  trafficView.refreshing=true;
  stopTrafficMonitor();button.disabled=true;
  const selected=$('#trafficRouter').value,queue=trafficNames().filter(name=>!selected||selected===name);
  const sequence=trafficView.sequence;
  try{
    await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
      while(queue.length){
        if(document.hidden||!$('#tab-traffic').classList.contains('show')||sequence!==trafficView.sequence)return;
        const router=queue.shift();
        try{const data=await api('/api/router-status?router='+encodeURIComponent(router),undefined,45000);recordTrafficRouterState(router,data.interfaces||{},data.ok?'':data.error||'Роутер недоступен');}
        catch(error){recordTrafficRouterState(router,{},error.message);}
      }
    }));
  }finally{trafficView.refreshing=false;button.disabled=trafficView.paused||trafficView.source==='router';if(sequence===trafficView.sequence&&AUTHENTICATED&&!document.hidden&&$('#tab-traffic').classList.contains('show'))startTrafficMonitor();}
}
