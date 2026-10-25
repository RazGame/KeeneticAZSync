// Completed measurements only: restoring history must never resume a diagnostic.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const LIMIT=4*1024*1024;
const terminal=new Set(['done','error','cancelled']);
function measurement(value){
  if(!value||typeof value!=='object')return null;
  const {seconds,bytes,bitsPerSecond,retransmits}=value;
  if(![seconds,bytes,bitsPerSecond].every(Number.isFinite)||seconds<=0||bytes<0||bitsPerSecond<0)return null;
  if(retransmits!==null&&(!Number.isFinite(retransmits)||retransmits<0))return null;
  return{seconds,bytes,bitsPerSecond,retransmits};
}
function record(value){
  if(!value||typeof value!=='object'||!terminal.has(value.status))return null;
  if(!['id','mapping','router','server'].every(k=>typeof value[k]==='string'&&value[k].length>0&&value[k].length<=1024))return null;
  if(typeof value.reverse!=='boolean'||!['az-local.antizapret','az-world.antizapret'].includes(value.target))return null;
  if(typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))return null;
  const output={};
  for(const k of ['id','mapping','router','server','status','target','reverse'])output[k]=value[k];
  output.streams=10;output.seconds=10;output.createdAt=value.createdAt;
  for(const k of ['startedAt','finishedAt'])if(typeof value[k]==='string'&&Number.isFinite(Date.parse(value[k])))output[k]=value[k];
  for(const k of ['code','error'])if(typeof value[k]==='string')output[k]=value[k].slice(0,2048);
  output.log=typeof value.log==='string'?value.log.slice(0,128*1024):'';
  output.stopUnconfirmed=value.stopUnconfirmed===true;
  const sender=measurement(value.result?.sender),receiver=measurement(value.result?.receiver);
  output.result=sender&&receiver?{sender,receiver}:null;
  if(output.status==='done'&&!output.result)return null;
  return output;
}

export function createSpeedHistory(file,{warn=()=>console.warn('Не удалось прочитать или сохранить историю iperf3')}={}){
  const clean=items=>items.map(record).filter(Boolean).slice(-20);
  const load=()=>{
    if(!file)return[];
    try{
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT)throw new Error('Invalid history file');
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!Array.isArray(value)||value.length>100)throw new Error('Invalid history records');
      return clean(value);
    }catch(error){if(error.code!=='ENOENT')warn();return[];}
  };
  const save=items=>{
    if(!file)return;
    const temporary=file+'.'+randomUUID()+'.tmp';let fd;
    try{
      const text=JSON.stringify(clean(items));if(Buffer.byteLength(text)>LIMIT)throw new Error('History limit exceeded');
      fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temporary,file);
    }catch{warn();}
    finally{
      if(fd!==undefined)try{fs.closeSync(fd);}catch{warn();}
      try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')warn();}
    }
  };
  return{load,save};
}
