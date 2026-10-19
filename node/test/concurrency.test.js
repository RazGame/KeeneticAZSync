import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createSpeedTests } from '../src/iperf.js';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(5); }
  throw new Error('Condition not reached');
}
const mapping = (router, server = 'A') => ({ name: router, router, server, interface: 'VPN' });

test('iperf runs independent servers concurrently and queues both AZ aliases FIFO on one server', async t => {
  const gates = new Map(['R1','R2','R3','R4'].map(id => [id, deferred()])), started = [];
  const manager = createSpeedTests({ runner: async (_, { mapping, onProgress }) => {
    started.push(mapping.router); onProgress({ status: 'running' }); await gates.get(mapping.router).promise; return {};
  } });
  t.after(() => { for (const gate of gates.values()) gate.resolve(); manager.close(); });
  const first = manager.start({}, { mapping: mapping('R1'), target: 'local' });
  const second = manager.start({}, { mapping: mapping('R2'), target: 'world' });
  const independent = manager.start({}, { mapping: mapping('R3', 'B') });
  const fourth = manager.start({}, { mapping: mapping('R4') });
  await until(() => started.length === 2);
  assert.deepEqual(started, ['R1','R3']);
  assert.equal(manager.get(second.id).status, 'queued');
  assert.equal(manager.get(second.id).waitingFor, 'server');
  assert.equal(manager.get(fourth.id).queuePosition, 2);
  assert.equal(manager.busy('R2'), true);
  assert.equal(manager.busy('not-running'), false);
  assert.throws(() => manager.start({}, { mapping: mapping('R1', 'C') }), e => e.status === 409);
  gates.get('R3').resolve(); await until(() => manager.get(independent.id).status === 'done');
  assert.equal(manager.get(second.id).status, 'queued');
  gates.get('R1').resolve(); await until(() => started.includes('R2'));
  assert.equal(manager.get(first.id).status, 'done');
  assert.equal(manager.get(fourth.id).queuePosition, 1);
  gates.get('R2').resolve(); await until(() => started.includes('R4'));
  gates.get('R4').resolve(); await until(() => !manager.busy());
  assert.deepEqual(started, ['R1','R3','R2','R4']);
});

test('iperf respects shared server identity, concurrency and queue capacity without launching queued cancellation', async t => {
  const gate = deferred(), started = [], settled = [];
  const manager = createSpeedTests({ maxRunning: 2, maxPending: 4, runner: async (_, { mapping }) => { started.push(mapping.router); await gate.promise; return {}; } });
  t.after(() => { gate.resolve(); manager.close(); });
  manager.start({}, { mapping: mapping('R1', 'AliasA'), serverKey: 'same-host' });
  const alias = manager.start({}, { mapping: mapping('R2', 'AliasB'), serverKey: 'same-host' }, () => settled.push('R2'));
  manager.start({}, { mapping: mapping('R3', 'B') });
  const capacity = manager.start({}, { mapping: mapping('R4', 'C') });
  await until(() => started.length === 2);
  assert.deepEqual(started, ['R1','R3']);
  assert.equal(manager.get(alias.id).waitingFor, 'server');
  assert.equal(manager.get(capacity.id).waitingFor, 'capacity');
  assert.throws(() => manager.start({}, { mapping: mapping('R5', 'D') }), e => e.status === 429);
  assert.equal(manager.cancel(alias.id).status, 'cancelled');
  assert.equal(manager.busy('R2'), false); assert.deepEqual(settled, ['R2']);
  manager.cancel(alias.id); assert.deepEqual(settled, ['R2']);
  gate.resolve(); await until(() => !manager.busy());
  assert.ok(!started.includes('R2')); assert.ok(started.includes('R4'));
});

test('iperf waits for cancellation cleanup before allowing the next client and can expire queued jobs', async t => {
  const cleanup = deferred(), entered = [], stopped = deferred();
  const manager = createSpeedTests({ queueTimeoutMs: 150, runner: async (_, { mapping, signal }) => {
    entered.push(mapping.router);
    if (mapping.router !== 'R1') return {};
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    stopped.resolve(); await cleanup.promise; signal.throwIfAborted();
  } });
  t.after(() => { cleanup.resolve(); manager.close(); });
  const first = manager.start({}, { mapping: mapping('R1') });
  await until(() => entered.length === 1);
  const expired = manager.start({}, { mapping: mapping('R2') });
  manager.cancel(first.id); await stopped.promise;
  assert.equal(manager.get(first.id).status, 'stopping');
  assert.equal(manager.get(expired.id).status, 'queued');
  await until(() => manager.get(expired.id).status === 'error');
  assert.equal(manager.get(expired.id).code, 'QUEUE_TIMEOUT');
  assert.equal(manager.busy('R2'), false); assert.deepEqual(entered, ['R1']);
  const next = manager.start({}, { mapping: mapping('R3') });
  assert.equal(manager.get(next.id).status, 'queued');
  cleanup.resolve(); await until(() => !manager.busy());
  assert.deepEqual(entered, ['R1','R3']);
});

test('iperf history pruning keeps active jobs and shutdown never launches queued work', async t => {
  const gate = deferred(), entered = [];
  const manager = createSpeedTests({ runner: async (_, { mapping }) => { entered.push(mapping.router); if (mapping.router === 'R1') await gate.promise; return {}; } });
  t.after(() => { gate.resolve(); manager.close(); });
  const first = manager.start({ password: 'never-public' }, { mapping: mapping('R1') });
  for (let i = 0; i < 22; i++) {
    const job = manager.start({}, { mapping: mapping('other', 'B') });
    await until(() => manager.get(job.id).status === 'done');
  }
  assert.equal(manager.get(first.id).id, first.id);
  assert.equal(manager.list().length, 21);
  assert.ok(!JSON.stringify(manager.list()).includes('never-public'));
  const queued = manager.start({}, { mapping: mapping('R2') });
  manager.close();
  assert.equal(manager.get(queued.id).status, 'cancelled');
  gate.resolve(); await until(() => !manager.busy());
  assert.ok(!entered.includes('R2'));
  assert.throws(() => manager.start({}, { mapping: mapping('R3') }), e => e.status === 503);
});

function browserSync(check, speedBusy = () => false) {
  const context = vm.createContext({ speedTestBusy: speedBusy, optSecrets: () => false, optNoRestart: () => false });
  vm.runInContext(fs.readFileSync(new URL('../web/sync.js', import.meta.url), 'utf8') + `
    refreshSyncUi=()=>{};refreshSyncRouter=async()=>{};
    globalThis.syncApi={view:syncView,runSyncCheck,runSyncApply,releaseSyncRouters};
  `, context);
  context.recordCheck = check;
  vm.runInContext('checkSyncRow=recordCheck;applySyncRow=recordCheck;', context);
  return context.syncApi;
}
const row = (router, n = 1) => ({ mapping: { router, name: router + '-' + n }, checkbox: { checked: false } });

test('sync executes three routers together, preserves connection order and accepts another batch', async t => {
  const gates = new Map(['R1','R2','R3','R4'].map(id => [id, deferred()])), entered = [], inFlight = new Set();
  let peak = 0;
  const api = browserSync(async r => {
    const router = r.mapping.router;
    assert.equal(inFlight.has(router), false); inFlight.add(router); peak = Math.max(peak, inFlight.size);
    entered.push(r.mapping.name); await gates.get(router).promise; inFlight.delete(router);
  }, router => router === 'iperf-router');
  t.after(() => { for (const gate of gates.values()) gate.resolve(); });
  api.view.rows = ['R1','R2','R3','R4'].flatMap(id => [row(id),row(id,2)]);
  api.view.rows.push(row('iperf-router'));
  api.view.rows.forEach(r => r.checkbox.checked = r.mapping.router !== 'R4');
  const first = api.runSyncCheck();
  await until(() => entered.length === 3);
  api.view.rows.forEach(r => r.checkbox.checked = r.mapping.router === 'R4');
  const second = api.runSyncCheck();
  assert.equal(api.view.batches.size, 2);
  assert.equal(api.view.routers.has('R4'), true);
  assert.equal(api.view.queue.length, 1);
  gates.get('R1').resolve(); await until(() => entered.includes('R4-1'));
  const newOwner = Symbol('new operation'); api.view.routers.set('R1', newOwner);
  for (const gate of gates.values()) gate.resolve();
  await Promise.all([first, second]);
  assert.equal(peak, 3);
  for (const id of ['R1','R2','R3','R4']) assert.ok(entered.indexOf(id+'-1') < entered.indexOf(id+'-2'));
  assert.ok(!entered.includes('iperf-router-1'));
  assert.equal(api.view.routers.get('R1'), newOwner, 'old batch cannot unlock a newer operation');
  assert.equal(api.view.busy, false);
});

test('sync worker failure waits for other routers before releasing its batch', async t => {
  const gate = deferred(); let active = false;
  const api = browserSync(async r => { if (r.mapping.router === 'R1') throw new Error('unexpected worker failure'); active = true; await gate.promise; });
  t.after(() => gate.resolve());
  api.view.rows = [row('R1'),row('R2')];
  const running = api.runSyncCheck();
  const result = assert.rejects(running, /unexpected worker failure/);
  await until(() => active);
  assert.equal(api.view.routers.has('R2'), true);
  assert.equal(api.view.busy, true);
  gate.resolve(); await result;
  assert.equal(api.view.routers.size, 0); assert.equal(api.view.busy, false);
});

test('browser restores multiple iperf jobs and leaves unrelated routers available during a sync batch', async () => {
  const field = () => ({ disabled:false, hidden:false, textContent:'', value:'', classList:{toggle(){}} });
  const rows = ['R1','R2','R3'].map(router => ({ mapping:{name:router,router},info:{up:true,connected:true},entry:{},speed:{box:{},target:field(),direction:field(),start:field(),stop:field(),state:field(),result:field(),log:field(),output:field()} }));
  const jobs = [
    {id:'one',router:'R1',mapping:'R1',status:'running',log:'<script>untrusted</script>'},
    {id:'two',router:'R2',mapping:'R2',status:'queued',queuePosition:1,waitingFor:'server'},
  ];
  const context = vm.createContext({ syncView:{rows,busy:true,loading:false,routers:new Map()}, $:()=>({}), refreshSyncUi(){}, setTimeout:()=>1,clearTimeout(){},api:async()=>({jobs}) });
  vm.runInContext(fs.readFileSync(new URL('../web/speed.js',import.meta.url),'utf8')+'\nglobalThis.speedApi={restoreSpeedTest,refreshSpeedTestEntry,speedTestBusy};',context);
  await context.speedApi.restoreSpeedTest();
  rows.forEach(context.speedApi.refreshSpeedTestEntry);
  assert.equal(rows[0].speed.output.textContent, jobs[0].log);
  assert.equal(rows[1].speed.stop.hidden, false); assert.match(rows[1].speed.state.textContent, /очереди/);
  assert.equal(rows[2].speed.start.disabled, false);
  assert.equal(context.speedApi.speedTestBusy('R3'), false);
  context.syncView.routers.set('R3',Symbol());
  context.speedApi.refreshSpeedTestEntry(rows[2]); assert.equal(rows[2].speed.start.disabled,true);
});

test('an older polling response cannot erase a newly started iperf job', async () => {
  const snapshot=deferred(),job={id:'new',mapping:'R1',router:'R1',status:'checking'};
  const row={mapping:{name:'R1',router:'R1'},info:{up:true,connected:true},entry:{},speed:{box:{},target:{value:'local'},direction:{value:'download'}}};
  const context=vm.createContext({syncView:{rows:[row],routers:new Map(),loading:false},$:()=>({}),refreshSyncUi(){},setTimeout:()=>1,clearTimeout(){},toast(){},
    api:async(_,body)=>body?{job}:await snapshot.promise});
  vm.runInContext(fs.readFileSync(new URL('../web/speed.js',import.meta.url),'utf8')+'\nglobalThis.speedApi={pollSpeedTest,startSpeedTest,speedTestBusy};',context);
  const reading=context.speedApi.pollSpeedTest();
  await context.speedApi.startSpeedTest(row);
  snapshot.resolve({jobs:[]});await reading;
  assert.equal(context.speedApi.speedTestBusy('R1'),true);
  assert.equal(row.speed.job.id,'new');assert.equal(row.speed.job.status,'checking');
});
