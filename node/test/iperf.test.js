import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Keenetic } from '../src/keenetic.js';
import { createJar } from '../src/util/http.js';
import { runRouterIperf, parseIperfOutput, createSpeedTests } from '../src/iperf.js';
import { startServer } from '../src/server.js';
import { saveConfig } from '../src/config.js';

const mapping = { name:'M', router:'R', server:'VPS', interface:'VPN', connection:'wg', client:'Client' };
const output = [
  '[  5] local 10.1.167.3 port 54430 connected to 10.200.0.4 port 5201',
  '[SUM]   0.00-10.00  sec  47.2 MBytes  39.6 Mbits/sec  188             sender',
  '[SUM]   0.00-10.67  sec  35.8 MBytes  28.1 Mbits/sec                  receiver',
  'iperf Done.',
];
async function until(read, check = value => value, timeout=3000) {
  const end=Date.now()+timeout;
  while (Date.now()<end) { const value=await read(); if(check(value)) return value; await delay(5); }
  throw new Error('Condition not reached');
}
async function router(t, options={}) {
  const state={posts:[],deletes:0,polls:0,running:false};
  const server=http.createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(data===null?'':JSON.stringify(data));};
    if(req.url==='/rci/show/version')return send(200,options.version??{ndw:{components:options.missing?'base,wireguard':'base,iperf3,wireguard'}});
    if(req.url==='/rci/show/interface')return send(200,options.interfaces??{Wireguard0:{description:'VPN',state:options.disconnected?'down':'up',connected:options.disconnected?'no':'yes'}});
    if(req.url!=='/rci/tools/iperf3')return send(404,null);
    if(req.method==='DELETE') {state.deletes++;if(options.stopGate)await options.stopGate;state.running=false;return send(options.stopFails?503:200,{message:[]});}
    if(req.method==='POST') {
      let text='';for await(const data of req)text+=data;
      state.posts.push(JSON.parse(text));
      state.running=true;
      if(options.postReset){req.socket.destroy();return;}
      return send(200,options.commandError?{status:[{status:'error',message:'unknown argument streams'}]}:{message:['starting iperf3 client...'],continued:true});
    }
    state.polls++;
    if(!state.running)return send(options.busy?200:404,options.busy?{continued:true}:null);
    if(options.pollReset){req.socket.destroy();return;}
    if(options.lost)return send(404,null);
    if(options.endless)return send(200,{message:['[SUM] 0.00-1.00 sec 1 MBytes 8 Mbits/sec'],continued:true});
    state.running=false;return send(200,{message:options.lines??output});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const keen=new Keenetic({endpoints:base,username:'user',password:'do-not-return'});
  keen.connect=async({signal}={})=>{signal?.throwIfAborted();keen.base=base;keen.jar=createJar();return base;};
  return {base,keen,state};
}

test('iperf parses real ten-stream summaries, units, retransmissions and endpoint durations',()=>{
  const result=parseIperfOutput(output.join('\n'));
  assert.equal(result.sender.bitsPerSecond,39.6e6);assert.equal(result.receiver.bitsPerSecond,28.1e6);
  assert.equal(result.sender.retransmits,188);assert.equal(result.receiver.retransmits,null);
  assert.equal(result.receiver.seconds,10.67);assert.equal(result.sender.bytes,47.2*1048576);
  assert.equal(parseIperfOutput(output.join('\n').replaceAll('Mbits/sec','Gbits/sec')).sender.bitsPerSecond,39.6e9);
  assert.throws(()=>parseIperfOutput(output.slice(0,-1).join('\n')),e=>e.code==='INCOMPLETE_RESULT');
  assert.throws(()=>parseIperfOutput(output.join('\n').replaceAll('0.00-10.00','0.00-0.00')),e=>e.code==='INVALID_RESULT');
});

test('iperf failures distinguish DNS, unreachable server, refused port, busy server and timeouts',()=>{
  for(const [message,code]of [['unable to resolve host','DNS_ERROR'],['Connection refused','CONNECTION_REFUSED'],['server is busy running a test','SERVER_BUSY'],['No route to host','NO_ROUTE'],['Connection timed out','CONNECTION_TIMEOUT'],['iperf3: error - control socket closed','IPERF_ERROR']])assert.throws(()=>parseIperfOutput(message),e=>e.code===code);
});

test('missing or unverifiable iperf component fails before any diagnostic command',async t=>{
  for(const options of [{missing:true},{version:{title:'4.3'}}]) {
    const {keen,state}=await router(t,options);
    await assert.rejects(()=>runRouterIperf(keen,{mapping}),e=>['IPERF_NOT_INSTALLED','CAPABILITY_UNKNOWN'].includes(e.code));
    assert.equal(state.posts.length,0);assert.equal(state.deletes,0);
  }
});

test('missing, disconnected or unmanaged interface never launches or switches a VPN',async t=>{
  for(const options of [{disconnected:true},{interfaces:{}},{interfaces:{GigabitEthernet0:{description:'VPN',state:'up',connected:'yes'}}}]) {
    const {keen,state}=await router(t,options);
    await assert.rejects(()=>runRouterIperf(keen,{mapping}),e=>['VPN_NOT_CONNECTED','INTERFACE_NOT_FOUND'].includes(e.code));
    assert.equal(state.posts.length,0);assert.equal(state.deletes,0);
  }
});

test('native diagnostic sends exactly 10 streams/10 seconds through the selected interface and polls without re-posting',async t=>{
  const {keen,state}=await router(t);let log='';
  const result=await runRouterIperf(keen,{mapping,target:'world',reverse:true,pollMs:1,onProgress:patch=>{if(patch.log)log=patch.log;}});
  assert.deepEqual(state.posts,[{host:'az-world.antizapret',port:5201,tcp:true,ipv4:true,streams:10,time:10,reverse:true,'source-interface':'Wireguard0'}]);
  assert.equal(state.deletes,0);assert.equal(result.receiver.bitsPerSecond,28.1e6);assert.match(log,/iperf Done/);
  await assert.rejects(()=>runRouterIperf(keen,{mapping,target:'bad; reboot'}),e=>e.code==='INVALID_OPTIONS');
  assert.equal(state.posts.length,1);
});

test('an already running native diagnostic is not replaced or cancelled',async t=>{
  const {keen,state}=await router(t,{busy:true});
  await assert.rejects(()=>runRouterIperf(keen,{mapping}),e=>e.code==='ROUTER_BUSY');
  assert.equal(state.posts.length,0);assert.equal(state.deletes,0);
});

test('lost POST/GET responses never replay a diagnostic or consume another continuation automatically',async t=>{
  for(const options of [{postReset:true},{pollReset:true},{lost:true}]) {
    const {keen,state}=await router(t,options);
    await assert.rejects(()=>runRouterIperf(keen,{mapping,pollMs:1}),e=>['ROUTER_CONNECTION_LOST','RESULT_LOST'].includes(e.code));
    assert.equal(state.posts.length,1);assert.equal(state.deletes,1);assert.ok(state.polls<=2);
  }
});

test('firmware rejection is visible; completed server errors keep logs without reporting success',async t=>{
  const rejected=await router(t,{commandError:true});
  await assert.rejects(()=>runRouterIperf(rejected.keen,{mapping,pollMs:1}),e=>e.code==='UNSUPPORTED_FIRMWARE');
  assert.equal(rejected.state.deletes,1);
  const busy=await router(t,{lines:['iperf3: error - the server is busy running a test. try again later']});let log='';
  await assert.rejects(()=>runRouterIperf(busy.keen,{mapping,pollMs:1,onProgress:p=>{if(p.log)log=p.log;}}),e=>e.code==='SERVER_BUSY');
  assert.match(log,/server is busy/);assert.equal(busy.state.deletes,0);
});

test('cancel and deadline stop the native diagnostic and release its lock only after cleanup',async t=>{
  let release;const gate=new Promise(r=>release=r);t.after(()=>release());
  const {keen,state}=await router(t,{endless:true,stopGate:gate});
  const manager=createSpeedTests({runner:(k,o)=>runRouterIperf(k,{...o,pollMs:1}),timeoutMs:1000});
  const job=manager.start(keen,{mapping,target:'local',reverse:false});
  await until(()=>state.posts.length);
  manager.cancel(job.id);await until(()=>state.deletes);
  assert.equal(manager.get(job.id).status,'stopping');assert.equal(manager.busy(),true);
  release();await until(()=>manager.get(job.id),j=>j.status==='cancelled');assert.equal(manager.busy(),false);
  const timed=createSpeedTests({runner:(k,o)=>runRouterIperf(k,{...o,pollMs:1}),timeoutMs:150});
  const next=timed.start(keen,{mapping,target:'local',reverse:false});
  const ended=await until(()=>timed.get(next.id),j=>j.status==='error');
  assert.equal(ended.code,'TEST_TIMEOUT');assert.equal(timed.busy(),false);assert.equal(state.deletes,2);
});

test('unconfirmed cleanup is reported instead of falsely confirming cancellation',async t=>{
  const {keen}=await router(t,{endless:true,stopFails:true}),controller=new AbortController();let unconfirmed=false;
  await assert.rejects(()=>runRouterIperf(keen,{mapping,signal:controller.signal,pollMs:1,onProgress:p=>{if(p.log)controller.abort();if(p.stopUnconfirmed)unconfirmed=true;}}));
  assert.equal(unconfirmed,true);
});

test('cancelling router authentication aborts the in-flight request without wake-up retries',async t=>{
  let requests=0;
  const server=http.createServer(()=>{requests++;});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const keen=new Keenetic({endpoints:`http://127.0.0.1:${server.address().port}`,username:'user',password:'secret'}),controller=new AbortController();
  const connecting=keen.connect({signal:controller.signal});await until(()=>requests);controller.abort();
  await assert.rejects(()=>connecting);assert.equal(requests,1);
});

test('job state supports reload, keeps bounded history and never returns credentials',async()=>{
  let release;const gate=new Promise(r=>release=r);
  const manager=createSpeedTests({runner:async(_,{onProgress})=>{onProgress({status:'running'});await gate;return parseIperfOutput(output.join('\n'));}});
  const job=manager.start({password:'secret'},{mapping,target:'local',reverse:false});
  assert.equal(manager.get().id,job.id);assert.throws(()=>manager.start({},{}),e=>e.status===409);
  assert.ok(!JSON.stringify(manager.get()).includes('secret'));release();await until(()=>!manager.busy());
  for(let i=0;i<22;i++){manager.start({},{mapping,target:'local',reverse:false});await until(()=>!manager.busy());}
  assert.throws(()=>manager.get(job.id),e=>e.status===404);assert.equal(manager.get().status,'done');
});

test('API serializes diagnostics with writes, rejects unsafe inputs and preserves config bytes',async t=>{
  const native=await router(t,{endless:true});
  t.mock.method(Keenetic.prototype,'connect',async function({signal}={}){signal?.throwIfAborted();this.base=native.base;this.jar=createJar();return this.base;});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'awg-iperf-api-')),file=path.join(dir,'config.yaml');
  saveConfig(file,{servers:{VPS:{connections:{wg:{url:'http://panel'}}}},routers:{R:{endpoint:native.base,password:'router-secret'}},mappings:[mapping]});
  const before=fs.readFileSync(file),app=startServer(file,0);await once(app,'listening');
  t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));fs.rmSync(dir,{recursive:true});});
  const headers={'Content-Type':'application/json'};
  if(process.env.BASIC_AUTH_USER&&process.env.BASIC_AUTH_PASS)headers.Authorization='Basic '+Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64');
  const api=async(p,body)=>{const r=await fetch(`http://127.0.0.1:${app.address().port}`+p,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});return{status:r.status,...await r.json()};};
  assert.equal((await api('/api/speed-test',{name:'M',target:'http://attacker'})).status,400);
  assert.equal((await api('/api/speed-test',{name:'M',reverse:'false'})).status,400);
  assert.equal((await api('/api/speed-test',{name:'missing'})).status,404);
  const started=await api('/api/speed-test',{name:'M',target:'local'});assert.equal(started.status,202);
  await until(()=>native.state.posts.length);
  assert.equal(native.state.posts[0].reverse,true,'default test downloads from server to router');
  assert.equal((await api('/api/speed-test')).job.id,started.job.id);
  assert.equal((await api('/api/speed-test',{name:'M'})).status,409);
  assert.equal((await api('/api/router-active',{router:'R',mapping:'M'})).status,409);
  assert.equal((await api('/api/apply',{name:'M',planToken:'unused'})).status,409);
  assert.equal((await api('/api/config',{config:{}})).status,409);
  assert.equal((await api('/api/speed-test-cancel',{id:started.job.id})).status,200);
  await until(()=>api('/api/speed-test'),d=>d.job.status==='cancelled');
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(native.state.deletes,1);
  const staticFile=await fetch(`http://127.0.0.1:${app.address().port}/speed.js`);assert.equal(staticFile.status,200);
});

test('browser restores an active job by GET, renders raw output as text and keeps disabled VPNs untestable',async()=>{
  const fields=()=>({disabled:false,hidden:false,textContent:'',className:'',value:'',classList:{toggle(){}}});
  const row={mapping:{name:'M'},info:{up:true,connected:true},entry:{},speed:{box:{},target:fields(),direction:fields(),start:fields(),stop:fields(),state:fields(),result:fields(),log:fields(),output:fields(),job:null}};
  const job={id:'existing',mapping:'M',target:'az-local.antizapret',reverse:false,status:'running',log:'<img src=x onerror=alert(1)>',result:null};
  const requests=[],callbacks=[];
  const context={syncView:{rows:[row],busy:false,loading:false},$:()=>({}),esc:s=>String(s),setTimeout:f=>{callbacks.push(f);return 1;},clearTimeout(){},refreshSyncUi(){},api:async(...args)=>{requests.push(args);return{job};}};
  vm.runInNewContext(fs.readFileSync(new URL('../web/speed.js',import.meta.url),'utf8')+'\nglobalThis.testApi={restoreSpeedTest,pollSpeedTest,refreshSpeedTestEntry,speedTestBusy};',context);
  await context.testApi.restoreSpeedTest();await context.testApi.pollSpeedTest();
  assert.ok(requests.every(args=>args[0].startsWith('/api/speed-test')&&args[1]===undefined));
  context.testApi.refreshSpeedTestEntry(row);assert.equal(row.speed.output.textContent,job.log);assert.equal(row.speed.stop.hidden,false);assert.equal(context.testApi.speedTestBusy(),true);
  row.info={up:false,connected:false};row.speed.job=null;context.testApi.refreshSpeedTestEntry(row);assert.equal(row.speed.start.disabled,true);
  row.speed.job=job;let missing=true;
  context.api=async()=>{if(missing){missing=false;throw Object.assign(new Error('Тест не найден'),{status:404});}return{job:null};};
  await context.testApi.pollSpeedTest();
  assert.equal(context.testApi.speedTestBusy(),false);assert.equal(row.speed.job.status,'error');
});
