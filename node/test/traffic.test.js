import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { measureTraffic, normalizePanelCounters, readPanelCounters, createTrafficMonitor as createPanelMonitor } from '../src/traffic.js';
import { readVpnCounters, createRouterTrafficMonitor as createTrafficMonitor } from '../src/router-traffic.js';
import { Keenetic } from '../src/keenetic.js';
import { startServer } from '../src/server.js';
import { saveConfig } from '../src/config.js';

const mapping={name:'M',router:'R',server:'S',connection:'wg',interface:'VPN',client:'Client'};
const config=()=>({servers:{S:{connections:{wg:{type:'wg-easy',url:'http://panel',password:'panel-secret'}}}},routers:{R:{endpoint:'http://router',password:'router-secret'}},mappings:[mapping]});
const rows=(timestamp=100,rx=1000,tx=500)=>[{interfaceName:'Wireguard0',description:'VPN',uptime:1000,mappings:[mapping],stats:{timestamp:String(timestamp),rxbytes:rx,txbytes:tx}}];

test('traffic rates use native counter timestamps and 8 bits per byte, including real zero traffic',()=>{
  const first=measureTraffic(rows()[0].stats,null);assert.equal(first.downloadBps,null);
  const next=measureTraffic(rows(105,1251000,625500)[0].stats,first.next);
  assert.equal(next.downloadBps,2e6);assert.equal(next.uploadBps,1e6);assert.equal(next.intervalSeconds,5);
  const idle=measureTraffic(rows(110,1251000,625500)[0].stats,next.next);
  assert.equal(idle.downloadBps,0);assert.equal(idle.uploadBps,0);assert.equal(idle.reset,false);
});

test('counter resets, reboot, clock changes and long gaps start a new baseline without spikes',()=>{
  const previous=measureTraffic(rows()[0].stats,null,{uptime:1000}).next;
  for(const [stats,options]of [[rows(105,5,5)[0].stats,{}],[rows(99,2000,1000)[0].stats,{}],[rows(135,2000,1000)[0].stats,{}],[rows(105,2000,1000)[0].stats,{uptime:5}],[{rxbytes:2000,txbytes:1000},{monotonic:105}]]){
    const value=measureTraffic(stats,previous,options);assert.equal(value.reset,true);assert.equal(value.downloadBps,null);
  }
  const huge='9007199254740995',first=measureTraffic({rxbytes:huge,txbytes:huge,timestamp:'1'},null);
  assert.equal(measureTraffic({rxbytes:'9007199254741000',txbytes:huge,timestamp:'2'},first.next).downloadBps,40);
  assert.throws(()=>measureTraffic({rxbytes:9007199254740992,txbytes:1},null),/счётчик/);
  assert.throws(()=>measureTraffic({rxbytes:-1,txbytes:1},null),/счётчик/);
});

async function native(t){
  const state={queries:[],bad:false};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET')return res.end(JSON.stringify({Wireguard0:{description:'VPN',state:'up',connected:'yes',uptime:1000},Wireguard1:{description:'Manual',state:'up',connected:'yes'},OpenVPN0:{description:'Off',state:'down',connected:'no'}}));
    let text='';for await(const chunk of req)text+=chunk;state.queries.push(JSON.parse(text));
    res.end(JSON.stringify(state.bad?[{status:'error',message:'cannot read stats'}]:[{show:{interface:{stat:rows()[0].stats}}}]));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`,keen=new Keenetic({endpoints:base});keen.base=base;
  return{base,keen,state};
}

test('native telemetry reads only configured connected VPNs, deduplicates aliases and sends show commands only',async t=>{
  const {keen,state}=await native(t);
  const result=await readVpnCounters(keen,[mapping,{...mapping,name:'Alias'},{...mapping,name:'Off',interface:'Off'}]);
  assert.equal(result.length,1);assert.equal(result[0].mappings.length,2);
  assert.deepEqual(state.queries,[[{show:{interface:{name:'Wireguard0',stat:{}}}}]]);
  state.bad=true;await assert.rejects(()=>readVpnCounters(keen,[mapping]),/cannot read stats/);
});

test('traffic shares in-flight reads, rate-limits tabs, reuses login and never exposes credentials',async()=>{
  let clock=100000,reads=0,logins=0,release;const gate=new Promise(r=>release=r);
  const monitor=createTrafficMonitor({now:()=>clock,makeKeenetic:()=>({connect:async()=>{logins++;}}),read:async()=>{reads++;if(reads===1)await gate;return rows(reads===1?100:105,reads===1?1000:1251000,reads===1?500:625500);}});
  const cfg=config(),a=monitor.get(cfg,'R'),b=monitor.get(cfg,'R');await delay(0);assert.equal(reads,1);release();
  const [first,other]=await Promise.all([a,b]);assert.equal(first.connections[0].id,other.connections[0].id);
  assert.equal(first.connections[0].state,'warming');assert.equal((await monitor.get(cfg,'R')).capturedAt,first.capturedAt);assert.equal(reads,1);
  clock+=5000;const next=await monitor.get(cfg,'R');assert.equal(next.connections[0].downloadBps,2e6);assert.equal(next.connections[0].intervalSeconds,5);assert.equal(logins,1);
  assert.ok(!JSON.stringify(next).includes('secret'));monitor.close();
});

test('configuration changes replace the series; failed reads back off and recover with a fresh baseline',async()=>{
  let clock=100000,reads=0,fail=false;
  const monitor=createTrafficMonitor({now:()=>clock,makeKeenetic:()=>({connect:async()=>{}}),read:async()=>{reads++;if(fail)throw new Error('offline');return rows(100+reads*5,1000+reads*100,500+reads*50);}});
  const cfg=config(),first=await monitor.get(cfg,'R');clock+=5000;
  cfg.mappings=[{...mapping,client:'NewClient'}];const changed=await monitor.get(cfg,'R');
  assert.notEqual(changed.connections[0].id,first.connections[0].id);assert.equal(changed.connections[0].state,'warming');
  clock+=5000;fail=true;assert.equal((await monitor.get(cfg,'R')).state,'error');const count=reads;
  clock+=5000;assert.equal((await monitor.get(cfg,'R')).state,'error');assert.equal(reads,count);
  clock+=15000;fail=false;assert.equal((await monitor.get(cfg,'R')).connections[0].state,'warming');monitor.close();
});

test('monitor has an overall deadline and does not connect routers without mappings',async()=>{
  let connected=0;
  const monitor=createTrafficMonitor({timeoutMs:20,makeKeenetic:()=>({connect:({signal})=>{connected++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}})});
  const cfg=config();cfg.mappings=[];assert.equal((await monitor.get(cfg,'R')).state,'excluded');assert.equal(connected,0);
  cfg.mappings=[mapping];const failed=await monitor.get(cfg,'R');assert.equal(failed.state,'error');assert.match(failed.error,/вовремя/);assert.equal(connected,1);
  await assert.rejects(()=>monitor.get(cfg,'unknown'),e=>e.status===404);monitor.close();
});

test('disabled synchronization excludes a router without login and mixed mappings read only enabled connections',async()=>{
  let logins=0,reads=0,selected=[];
  const monitor=createTrafficMonitor({makeKeenetic:()=>({connect:async()=>{logins++;}}),read:async(_,mappings)=>{reads++;selected=mappings.map(m=>m.name);return[{...rows()[0],mappings}];}});
  const cfg=config();cfg.mappings=[{...mapping,enabled:false}];
  const excluded=await monitor.get(cfg,'R');assert.equal(excluded.state,'excluded');assert.equal(excluded.connections.length,0);assert.equal(logins,0);assert.equal(reads,0);
  cfg.mappings.push({...mapping,name:'Enabled',enabled:true});
  const active=await monitor.get(cfg,'R');assert.equal(active.state,'ok');assert.deepEqual(selected,['Enabled']);assert.equal(logins,1);assert.equal(reads,1);
  cfg.mappings[1].enabled=false;assert.equal((await monitor.get(cfg,'R')).state,'excluded');assert.equal(reads,1);
  cfg.mappings[1].enabled=true;assert.equal((await monitor.get(cfg,'R')).connections[0].state,'warming');assert.equal(logins,2);monitor.close();
});

test('traffic HTTP API validates router/origin, caches statistics and preserves configuration bytes',async t=>{
  const n=await native(t);t.mock.method(Keenetic.prototype,'connect',async function(){this.base=n.base;});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'awg-traffic-')),file=path.join(dir,'config.yaml');saveConfig(file,config());const original=fs.readFileSync(file);
  const server=startServer(file,0);await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true});});
  const base=`http://127.0.0.1:${server.address().port}`,headers={};
  if(process.env.BASIC_AUTH_USER&&process.env.BASIC_AUTH_PASS)headers.Authorization='Basic '+Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64');
  assert.equal((await fetch(base+'/api/traffic',{headers})).status,400);
  assert.equal((await fetch(base+'/api/traffic?source=router&router=unknown',{headers})).status,404);
  assert.equal((await fetch(base+'/api/traffic?source=router&router=R',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const [a,b]=await Promise.all([fetch(base+'/api/traffic?source=router&router=R',{headers}),fetch(base+'/api/traffic?source=router&router=R',{headers})]);
  assert.equal(a.status,200);assert.equal((await a.json()).connections[0].state,'warming');assert.equal((await b.json()).connections[0].receivedBytes,'1000');assert.equal(n.state.queries.length,1);
  assert.deepEqual(fs.readFileSync(file),original);assert.equal((await fetch(base+'/traffic.js')).status,200);assert.equal((await fetch(base+'/traffic.css')).status,200);
  const disabled=config();disabled.mappings=[{...mapping,enabled:false}];saveConfig(file,disabled);const disabledBytes=fs.readFileSync(file);
  const excluded=await fetch(base+'/api/traffic?source=router&router=R',{headers});assert.equal((await excluded.json()).state,'excluded');assert.equal(n.state.queries.length,1);assert.deepEqual(fs.readFileSync(file),disabledBytes);
});

test('monitor cards and router selector use only sync-enabled mappings in the shared display order',()=>{
  const cfg={routers:{Disabled:{},Beta:{},Alpha:{},Unmapped:{}},mappings:[{router:'Disabled',enabled:false},{router:'Beta',enabled:false},{router:'Beta',enabled:true},{router:'Alpha'}],displayOrder:{routers:['Alpha','Disabled','Beta','Unmapped']}};
  const context={CONFIG:cfg,DisplayOrder:{names:()=>cfg.displayOrder.routers}};
  vm.runInNewContext(fs.readFileSync(new URL('../web/traffic.js',import.meta.url),'utf8')+'\nglobalThis.h={trafficNames,trafficView};',context);
  assert.deepEqual(Array.from(context.h.trafficNames()),['Alpha','Beta']);
  context.h.trafficView.excluded.add('Beta');assert.deepEqual(Array.from(context.h.trafficNames()),['Alpha']);
});

test('chart history is bounded, omits gaps and produces finite SVG paths with distinct gradients',()=>{
  const context={esc:s=>String(s),Date,Number,Math};vm.runInNewContext(fs.readFileSync(new URL('../web/traffic.js',import.meta.url),'utf8')+'\nglobalThis.helpers={appendTrafficPoint,trafficChart,trafficRate};',context);
  const h=context.helpers;let points=[];for(let i=0;i<300;i++)points=h.appendTrafficPoint(points,{at:i*5000,down:i*1000,up:0});assert.ok(points.length<=121);
  const same=h.appendTrafficPoint(points,points[points.length-1]);assert.equal(same.length,points.length);
  const html=h.trafficChart([{at:1000,down:1000,up:0},{at:6000,down:null,up:null},{at:11000,down:2000,up:500}],12000,120,1);
  assert.match(html,/traffic-1-down/);assert.match(html,/traffic-1-up/);assert.ok(!/NaN|Infinity/.test(html));assert.ok((html.match(/stroke-width="2.3"/g)||[]).length===4);
  assert.equal(h.trafficRate(null),'—');assert.match(h.trafficRate(1e6),/Мбит\/с/);
});

test('leaving the monitor discards in-flight updates and stops future polls',async()=>{
  let finish;const gate=new Promise(r=>finish=r),timers=new Set(),context={CONFIG:config(),DisplayOrder:{names:()=>['R']},document:{hidden:false},$:()=>({classList:{contains:()=>true}}),setTimeout:()=>{const id={};timers.add(id);return id;},clearTimeout:id=>timers.delete(id),api:()=>gate};
  vm.runInNewContext(fs.readFileSync(new URL('../web/traffic.js',import.meta.url),'utf8')+'\nglobalThis.h={trafficView,trafficTick,stopTrafficMonitor,trafficSchedule};',context);
  context.h.trafficView.active=true;context.h.trafficSchedule('R',0);assert.equal(timers.size,1);
  const pending=context.h.trafficTick('R',context.h.trafficView.sequence);context.h.stopTrafficMonitor();finish({router:'R',state:'idle',capturedAt:100,connections:[]});await pending;
  assert.equal(timers.size,0);assert.equal(context.h.trafficView.cards.size,0);assert.equal(context.h.trafficView.inflight.size,0);
});

test('panel directions are reversed to router view; raw keys/addresses never escape normalization',()=>{
  const data=[{id:1,name:'Client',enabled:true,transferRx:'9007199254740995',transferTx:1000,latestHandshakeAt:'2026-10-17T12:00:00Z',privateKey:'never-return',endpoint:'private-address'}];
  const rows=normalizePanelCounters('wg-easy',data,Date.parse('2026-10-17T12:01:00Z'));
  assert.equal(rows[0].stats.rxbytes,'1000');assert.equal(rows[0].stats.txbytes,'9007199254740995');assert.equal(rows[0].active,true);
  assert.ok(!JSON.stringify(rows).includes('never-return'));assert.ok(!JSON.stringify(rows).includes('private-address'));
  assert.equal(normalizePanelCounters('wg-easy',data,Date.parse('2026-10-17T12:04:00Z'))[0].active,false);
  assert.throws(()=>normalizePanelCounters('wg-easy',[{...data[0],transferTx:9007199254740992}]),/счётчик/);
  const ovpn=normalizePanelCounters('openvpn-ui',{data:{ClientList:[{CommonName:'CN',BytesReceived:100,BytesSent:300,ConnectedSinceT:'1',ClientID:'1'},{CommonName:'CN',BytesReceived:50,BytesSent:70,ConnectedSinceT:'2',ClientID:'2'}]}},10000);
  assert.equal(ovpn[0].stats.rxbytes,'370');assert.equal(ovpn[0].stats.txbytes,'150');assert.equal(ovpn[0].sharedSessions,2);
  assert.throws(()=>normalizePanelCounters('openvpn-ui',{status:'error',message:'secret'}),/сессии/);
});

test('server source shares each panel read/login across routers, aliases and browser tabs, without router contacts',async()=>{
  let clock=100000,mono=100,reads=0,logins=0,release;const gate=new Promise(r=>release=r);
  const monitor=createPanelMonitor({now:()=>clock,monotonic:()=>mono,makePanel:()=>({login:async()=>{logins++;}}),read:async()=>{
    reads++;if(reads===1)await gate;
    return[{name:'Client',identity:'1',active:true,lastSeenAt:clock,stats:{rxbytes:reads===1?1000:1251000,txbytes:reads===1?500:625500}}];
  }});
  const cfg=config();cfg.routers.R2={endpoint:'http://never-contact-router'};cfg.mappings.push({...mapping,name:'M2',router:'R2'});
  const a=monitor.get(cfg,'R'),b=monitor.get(cfg,'R2');await delay(0);assert.equal(reads,1);release();
  const [first,other]=await Promise.all([a,b]);assert.equal(first.source,'server');assert.equal(other.connections.length,1);assert.equal(logins,1);
  assert.notEqual(first.connections[0].id,other.connections[0].id);assert.equal(first.connections[0].state,'warming');
  clock+=1000;await monitor.get(cfg,'R');assert.equal(reads,1);
  clock+=9000;mono+=10;const next=await monitor.get(cfg,'R');assert.equal(reads,2);assert.equal(logins,1);
  assert.equal(next.connections[0].downloadBps,1e6);assert.equal(next.connections[0].uploadBps,500000);
  cfg.mappings.push({...mapping,name:'Alias'});const aliases=await monitor.get(cfg,'R');assert.equal(aliases.connections.length,1);assert.equal(aliases.connections[0].mappings.length,2);
  assert.ok(!JSON.stringify(next).includes('secret'));monitor.close();
});

test('server source honors last known active mappings, excludes disabled mappings, and does not query panels for all-off routers',async()=>{
  let reads=0;const monitor=createPanelMonitor({makePanel:()=>({login:async()=>{}}),read:async()=>{reads++;return[{name:'Client',identity:'1',active:false,stats:{rxbytes:1000,txbytes:500}}];}});
  const cfg=config();cfg.mappings.push({...mapping,name:'Off',enabled:false});
  assert.equal((await monitor.get(cfg,'R',{mappingNames:[]})).state,'idle');assert.equal(reads,0);
  assert.equal((await monitor.get(cfg,'R')).state,'idle');assert.equal(reads,1);
  const known=await monitor.get(cfg,'R',{mappingNames:['M','Off','unknown']});assert.equal(known.connections.length,1);assert.deepEqual(known.connections[0].mappings.map(m=>m.name),['M']);
  cfg.mappings=[{...mapping,enabled:false}];assert.equal((await monitor.get(cfg,'R')).state,'excluded');assert.equal(reads,1);
  await assert.rejects(()=>monitor.get(cfg,'R',{source:'other'}),e=>e.status===400);monitor.close();
});

test('panel failures back off, time out, recover and reset session counters without invented spikes',async()=>{
  let clock=100000,mono=100,reads=0,fail=false,session='1';
  const monitor=createPanelMonitor({now:()=>clock,monotonic:()=>mono,makePanel:()=>({login:async()=>{}}),read:async()=>{
    reads++;if(fail)throw new Error('panel offline');return[{name:'Client',identity:session,active:true,stats:{rxbytes:reads*1000,txbytes:reads*500}}];}});
  const cfg=config();const first=await monitor.get(cfg,'R');clock+=10000;mono+=10;session='2';
  assert.equal((await monitor.get(cfg,'R')).connections[0].state,'warming');
  cfg.mappings=[{...mapping,client:'Absent'}];assert.equal((await monitor.get(cfg,'R')).state,'error');cfg.mappings=[mapping];
  clock+=10000;mono+=10;fail=true;assert.equal((await monitor.get(cfg,'R')).state,'error');const count=reads;
  clock+=10000;assert.equal((await monitor.get(cfg,'R')).state,'error');assert.equal(reads,count);
  clock+=10000;mono+=20;fail=false;const recovered=await monitor.get(cfg,'R');assert.equal(recovered.connections[0].state,'warming');assert.equal(recovered.connections[0].id,first.connections[0].id);monitor.close();
  const timeout=createPanelMonitor({timeoutMs:20,makePanel:()=>({login:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))})});
  assert.match((await timeout.get(config(),'R')).error,/вовремя/);timeout.close();
});

test('server source uses only authenticated read APIs, reuses session cookies and is the HTTP default',async t=>{
  let logins=0,reads=0;const requests=[];
  const panel=http.createServer(async(req,res)=>{
    requests.push([req.method,req.url]);res.setHeader('Content-Type','application/json');
    if(req.method==='POST'&&req.url==='/api/auth/password'){logins++;res.setHeader('Set-Cookie','session=ok; Path=/');return res.end('{}');}
    if(req.url==='/api/client'){
      assert.equal(req.headers.cookie,'session=ok');reads++;
      return res.end(JSON.stringify([{id:1,name:'Client',enabled:true,latestHandshakeAt:new Date().toISOString(),transferRx:500,transferTx:1000,privateKey:'key-not-for-ui'}]));
    }
    res.statusCode=404;res.end('{}');
  });panel.listen(0,'127.0.0.1');await once(panel,'listening');
  const cfg=config();cfg.servers.S.connections.wg.url=`http://127.0.0.1:${panel.address().port}`;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'awg-panel-')),file=path.join(dir,'config.yaml');saveConfig(file,cfg);const original=fs.readFileSync(file);
  const server=startServer(file,0);await once(server,'listening');
  t.after(async()=>{for(const s of[server,panel]){s.closeAllConnections();await new Promise(r=>s.close(r));}fs.rmSync(dir,{recursive:true});});
  const base=`http://127.0.0.1:${server.address().port}`,headers={};
  if(process.env.BASIC_AUTH_USER&&process.env.BASIC_AUTH_PASS)headers.Authorization='Basic '+Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64');
  const response=await fetch(base+'/api/traffic?router=R',{headers}),data=await response.json();assert.equal(response.status,200);assert.equal(data.source,'server');assert.equal(data.connections[0].receivedBytes,'1000');
  assert.ok(!JSON.stringify(data).includes('key-not-for-ui'));await fetch(base+'/api/traffic?router=R',{headers});assert.equal(logins,1);assert.equal(reads,1);
  assert.equal((await fetch(base+'/api/traffic?router=R&source=invalid',{headers})).status,400);
  assert.equal((await(await fetch(base+'/api/traffic?router=R&mapping=',{headers})).json()).state,'idle');assert.equal(reads,1);
  assert.deepEqual(fs.readFileSync(file),original);assert.deepEqual(requests,[['POST','/api/auth/password'],['GET','/api/client']]);
});

test('OpenVPN session API reads server counters and rejects login/error pages',async t=>{
  const panel=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{ClientList:[{CommonName:'Client',BytesReceived:50,BytesSent:90,ConnectedSinceT:'100',ClientID:'1'}]}}));});
  panel.listen(0,'127.0.0.1');await once(panel,'listening');t.after(async()=>{panel.closeAllConnections();await new Promise(r=>panel.close(r));});
  const data=await readPanelCounters({url:`http://127.0.0.1:${panel.address().port}`},'openvpn-ui');assert.equal(data[0].stats.rxbytes,'90');assert.equal(data[0].stats.txbytes,'50');assert.equal(data[0].active,true);
});

test('browser restores bounded session history across reload, separates sources and uses cached active router state',()=>{
  const storage=new Map(),context={CONFIG:config(),sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
  const code=fs.readFileSync(new URL('../web/traffic.js',import.meta.url),'utf8')+'\nglobalThis.h={trafficView,trafficHistory,saveTrafficHistory,clearTrafficHistory,recordTrafficRouterState,trafficMappings};';
  vm.runInNewContext(code,context);const now=Date.now();
  context.h.trafficView.cards.set('server-series',{key:'server-series',connection:{},points:[{at:now,down:100,up:50,duration:10}],el:{remove(){}}});
  context.h.trafficView.cards.set('router-series',{key:'router-series',connection:{},points:[{at:now,down:200,up:70,duration:10}],el:{remove(){}}});context.h.saveTrafficHistory();
  const reload={CONFIG:config(),sessionStorage:context.sessionStorage};vm.runInNewContext(code,reload);assert.equal(reload.h.trafficHistory().get('server-series')[0].down,100);assert.equal(reload.h.trafficHistory().get('router-series')[0].down,200);
  reload.h.recordTrafficRouterState('R',{VPN:{up:true,connected:true}});assert.deepEqual(Array.from(reload.h.trafficMappings('R')),['M']);
  reload.CONFIG.mappings[0]={...mapping,interface:'Changed'};assert.equal(reload.h.trafficMappings('R'),null);
  reload.h.clearTrafficHistory();assert.equal(storage.size,0);assert.equal(reload.h.trafficView.source,'server');
});

test('source switching never applies old responses and hidden tabs do not poll either source',async()=>{
  let finish,calls=[];const gate=new Promise(r=>finish=r),timers=new Set();
  const context={CONFIG:config(),DisplayOrder:{names:()=>['R']},document:{hidden:false},$:s=>s==='#trafficRouter'?{value:''}:{classList:{contains:()=>true}},setTimeout:()=>{const id={};timers.add(id);return id;},clearTimeout:id=>timers.delete(id),api:url=>{calls.push(url);return gate;}};
  vm.runInNewContext(fs.readFileSync(new URL('../web/traffic.js',import.meta.url),'utf8')+'\nglobalThis.h={trafficView,trafficTick,stopTrafficMonitor};',context);
  context.h.trafficView.active=true;
  const pending=context.h.trafficTick('R',0);assert.match(calls[0],/source=server/);
  context.h.stopTrafficMonitor();context.h.trafficView.source='router';context.h.trafficView.active=true;
  finish({router:'R',source:'server',state:'ok',capturedAt:Date.now(),connections:[{id:'stale'}]});await pending;assert.equal(context.h.trafficView.cards.size,0);assert.equal(timers.size,0);
  context.document.hidden=true;await context.h.trafficTick('R',context.h.trafficView.sequence);assert.equal(calls.length,1);
});

test('restored charts explicitly break on resume and errors, including cached timestamps',()=>{
  const storage=new Map(),elements=new Map(),now=Date.now();
  const get=s=>{if(!elements.has(s))elements.set(s,{value:s==='#trafficWindow'?'120':'',classList:{contains:()=>true},appendChild(){},setAttribute(){},removeAttribute(){}});return elements.get(s);};
  const context={CONFIG:config(),DisplayOrder:{names:()=>['R']},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},Date,esc:s=>String(s??''),accessIcon:()=>'',document:{createElement:()=>({clientWidth:600,remove(){}})},$:get};
  vm.runInNewContext(fs.readFileSync(new URL('../web/traffic.js',import.meta.url),'utf8')+'\nglobalThis.h={trafficView,applyTrafficSnapshot};',context);
  const connection={id:'series',interfaceName:'VPN',description:'Client',mappings:[{server:'S',protocol:'AmneziaWG'}],state:'live',sampledAt:now,downloadBps:100,uploadBps:50,intervalSeconds:10};
  context.h.applyTrafficSnapshot({router:'R',source:'server',state:'ok',capturedAt:now,connections:[connection]});
  const card=context.h.trafficView.cards.get('series');assert.equal(card.points[0].down,100);
  context.h.applyTrafficSnapshot({router:'R',source:'server',state:'ok',capturedAt:now,connections:[connection]},true);
  assert.equal(card.points.length,1);assert.equal(card.points[0].down,null);assert.equal(card.connection.state,'warming');
  context.h.applyTrafficSnapshot({router:'R',state:'error',capturedAt:now+1000,connections:[],error:'offline'});
  assert.equal(card.points[1].at,now+1000);assert.equal(card.points[1].down,null);
});

test('resume does not count a cached pre-resume sample as a new baseline',async()=>{
  const now=Date.now(),context={CONFIG:config(),DisplayOrder:{names:()=>['R']},document:{hidden:false},$:s=>s==='#trafficRouter'?{value:''}:{classList:{contains:()=>true}},setTimeout:()=>1,clearTimeout(){},api:async()=>({router:'R',state:'ok',capturedAt:now-5000,servedAt:now,connections:[{sampledAt:now-5000}]})};
  vm.runInNewContext(fs.readFileSync(new URL('../web/traffic.js',import.meta.url),'utf8')+'\nglobalThis.h={trafficView,trafficTick};applyTrafficSnapshot=()=>{};',context);
  context.h.trafficView.active=true;context.h.trafficView.startedAt=now;context.h.trafficView.fresh.add('R');
  await context.h.trafficTick('R',0);assert.equal(context.h.trafficView.fresh.has('R'),true);
  context.api=async()=>({router:'R',state:'ok',capturedAt:now+1000,servedAt:now+2000,connections:[{sampledAt:now+1000}]});
  await context.h.trafficTick('R',0);assert.equal(context.h.trafficView.fresh.has('R'),true);
  // Simulate the next response after wall-clock time has advanced too.
  context.h.trafficView.startedAt=now-10000;await context.h.trafficTick('R',0);assert.equal(context.h.trafficView.fresh.has('R'),false);
});
