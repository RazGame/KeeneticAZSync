import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const connected=yes=>({ok:true,interfaces:{VPN:{up:true,connected:yes}}});
function fixture(api){
  let now=1000,id=0,visible=true;const timers=new Map(),listeners={},fields=new Map();
  const field=()=>({className:'ss-status ss-vpn',textContent:'',classList:{contains:()=>true},removeAttribute(){}});
  const context=vm.createContext({AUTHENTICATED:true,Date:{now:()=>now},document:{hidden:false,addEventListener:(name,fn)=>listeners[name]=fn},
    $:name=>name==='#tab-sync'?{classList:{contains:()=>visible}}:fields.get(name)||fields.set(name,{}).get(name),api,
    recordTrafficRouterState(){},refreshSpeedTestEntry(){},speedTestBusy:()=>false,
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimeout:n=>timers.delete(n)});
  vm.runInContext(fs.readFileSync(new URL('../web/sync.js',import.meta.url),'utf8')+`
    refreshSyncUi=()=>{};
    globalThis.statusApi={view:syncView,poll:syncStatusPoll,startSyncStatus,stopSyncStatus,followSyncConnection,refreshSyncRouter,invalidateSyncStatus,initSyncUi};
  `,context);
  const row={mapping:{name:'M',router:'R',interface:'VPN'},vpnStatus:field(),switchWrap:{},plan:{mode:'update'},planToken:'preserve',checkbox:{checked:true}};
  const group={router:'R',rows:[row]};row.group=group;
  context.statusApi.view.rows=[row];context.statusApi.view.groups=[group];context.statusApi.initSyncUi();
  async function advance(ms){
    const target=now+ms;let count=0;
    while(true){
      const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next||next[1].at>target)break;
      assert.ok(++count<1000,'timer loop');timers.delete(next[0]);now=next[1].at;await next[1].fn();
    }
    now=target;
  }
  return{context,row,group,timers,listeners,advance,visible:on=>visible=on,...context.statusApi};
}

test('VPN status refreshes after switching, stops fast polling on connection and preserves plans and selections',async()=>{
  let calls=0;const f=fixture(async()=>connected(++calls>1));
  const plan=f.row.plan;f.startSyncStatus();await f.advance(250);
  assert.equal(calls,1);assert.equal(f.row.vpnStatus.textContent,'Включено · нет связи');
  f.followSyncConnection(f.group,'M');await f.advance(1999);assert.equal(calls,1);
  await f.advance(1);assert.equal(f.row.vpnStatus.textContent,'Подключено');assert.equal(f.poll.fast.size,0);
  assert.equal(f.row.plan,plan);assert.equal(f.row.planToken,'preserve');assert.equal(f.row.checkbox.checked,true);
  await f.advance(14999);assert.equal(calls,2);await f.advance(1);assert.equal(calls,3);
});

test('fast connection checks expire after 30 seconds and unavailable routers back off to 60 seconds',async()=>{
  let calls=0,fail=false;const f=fixture(async()=>{calls++;return fail?{ok:false,error:'unavailable'}:connected(false);});
  f.startSyncStatus();await f.advance(250);f.followSyncConnection(f.group,'M');await f.advance(30000);
  assert.equal(f.poll.fast.size,0);const fastCalls=calls;await f.advance(14999);assert.equal(calls,fastCalls);
  fail=true;await f.advance(1);assert.equal(calls,fastCalls+1);assert.equal(f.row.vpnStatus.textContent,'Недоступен');
  await f.advance(29999);assert.equal(calls,fastCalls+1);await f.advance(1);assert.equal(calls,fastCalls+2);
  await f.advance(59999);assert.equal(calls,fastCalls+2);fail=false;await f.advance(1);assert.equal(calls,fastCalls+3);
  await f.advance(15000);assert.equal(calls,fastCalls+4);
});

test('hidden tabs discard in-flight status, stop polling and refresh on return; other sections and logout stay idle',async()=>{
  const pending=deferred();let calls=0;const f=fixture(async()=>++calls===1?await pending.promise:connected(true));
  f.startSyncStatus();const flight=f.advance(250);assert.equal(calls,1);
  f.context.document.hidden=true;f.listeners.visibilitychange();pending.resolve(connected(false));await flight;
  assert.equal(f.row.info,undefined);await f.advance(60000);assert.equal(calls,1);
  f.context.document.hidden=false;f.listeners.visibilitychange();await f.advance(250);assert.equal(calls,2);assert.equal(f.row.info.connected,true);
  f.visible(false);f.stopSyncStatus();await f.advance(60000);assert.equal(calls,2);
  f.visible(true);f.context.AUTHENTICATED=false;f.startSyncStatus();await f.advance(60000);assert.equal(calls,2);
});

test('status requests coalesce per router and a response from before switching cannot overwrite fresh state',async()=>{
  const old=deferred(),fresh=deferred();let calls=0;const f=fixture(async()=>++calls===1?await old.promise:await fresh.promise);
  const first=f.refreshSyncRouter(f.group),duplicate=f.refreshSyncRouter(f.group);assert.equal(calls,1);
  f.invalidateSyncStatus('R');const afterSwitch=f.refreshSyncRouter(f.group);assert.equal(calls,1);
  old.resolve(connected(false));await Promise.all([first,duplicate]);assert.equal(f.row.info,undefined);
  await Promise.resolve();assert.equal(calls,2);fresh.resolve(connected(true));await afterSwitch;
  assert.equal(f.row.info.connected,true);assert.equal(f.poll.reads.size,0);
});

test('automatic status polling uses two workers and skips routers with configuration work',async()=>{
  const gates=[deferred(),deferred(),deferred()];let calls=0;
  const f=fixture(async()=>await gates[calls++].promise);
  f.view.groups.push({router:'R2',rows:[]},{router:'R3',rows:[]},{router:'busy',rows:[]});
  f.view.routers.set('busy',Symbol());f.startSyncStatus();const flight=f.advance(250);assert.equal(calls,2);
  gates[0].resolve(connected(true));await new Promise(r=>setImmediate(r));assert.equal(calls,3);
  gates[1].resolve(connected(true));gates[2].resolve(connected(true));await flight;assert.equal(calls,3);
});
