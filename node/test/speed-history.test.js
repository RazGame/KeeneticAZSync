import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSpeedHistory } from '../src/speed-history.js';
import { createSpeedTests } from '../src/iperf.js';

const result={sender:{seconds:10,bytes:1000,bitsPerSecond:800,retransmits:0},receiver:{seconds:10,bytes:1000,bitsPerSecond:800,retransmits:null}};
const job=(id='old')=>({id,mapping:'M',router:'R',server:'VPS',target:'az-local.antizapret',reverse:true,status:'done',streams:10,seconds:10,createdAt:'2026-10-23T10:52:07.453Z',startedAt:'2026-10-23T10:52:07.454Z',finishedAt:'2026-10-23T10:52:33.859Z',result,log:'iperf Done.'});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'awg-speed-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return{dir,file:path.join(dir,'speed-tests.json')};}
async function idle(manager){for(let n=0;n<500;n++){if(!manager.busy())return;await delay(5);}throw new Error('History job did not settle');}

test('private iperf history keeps 20 finished measurements with original times and drops credentials and active jobs',t=>{
  const {file}=fixture(t);const history=createSpeedHistory(file);
  history.save([...Array.from({length:25},(_,i)=>({...job(String(i)),password:'never-store',extra:{credential:'never-store'}})),{...job('active'),status:'running'}]);
  const stored=history.load();assert.equal(stored.length,20);assert.equal(stored[0].id,'5');assert.equal(stored.at(-1).id,'24');
  assert.equal(stored[0].startedAt,job().startedAt);assert.deepEqual(stored[0].result,result);
  assert.ok(!fs.readFileSync(file,'utf8').includes('never-store'));
  if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});

test('restarting the speed manager restores completed results without replaying a diagnostic',async t=>{
  const {file}=fixture(t);fs.writeFileSync(file,JSON.stringify([job(),{...job('unfinished'),status:'running'}]));
  let starts=0;
  const manager=createSpeedTests({historyFile:file,runner:async()=>{starts++;return result;}});
  t.after(()=>manager.close());
  assert.equal(manager.busy(),false);assert.equal(starts,0);assert.equal(manager.get('old').startedAt,job().startedAt);
  assert.throws(()=>manager.get('unfinished'),e=>e.status===404);
  const next=manager.start({password:'private-router-password'},{mapping:{name:'M',router:'R',server:'VPS'}});await idle(manager);
  assert.equal(starts,1);
  const restarted=createSpeedTests({historyFile:file,runner:async()=>{starts++;throw new Error('must not restart');}});
  t.after(()=>restarted.close());
  assert.equal(restarted.get(next.id).status,'done');assert.equal(restarted.get('old').startedAt,job().startedAt);assert.equal(starts,1);
  assert.ok(!fs.readFileSync(file,'utf8').includes('private-router-password'));
});

test('corrupt or oversized iperf history cannot prevent startup; failed atomic writes keep the previous file',t=>{
  const {file,dir}=fixture(t);let warnings=0;const history=createSpeedHistory(file,{warn:()=>warnings++});
  assert.deepEqual(history.load(),[]);assert.equal(warnings,0);
  fs.writeFileSync(file,'bad JSON');assert.deepEqual(history.load(),[]);assert.equal(warnings,1);
  fs.writeFileSync(file,'x'.repeat(4*1024*1024+1));assert.deepEqual(history.load(),[]);assert.equal(warnings,2);
  history.save([job()]);const before=fs.readFileSync(file);
  t.mock.method(fs,'renameSync',()=>{throw new Error('disk unavailable');});
  assert.doesNotThrow(()=>history.save([job('new')]));assert.equal(warnings,3);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(dir),['speed-tests.json']);
});
