/* CONVERTER — обработка целиком в браузере. */
(function(){
  function downloadText(text,name,type){const b=new Blob([text],{type:type||'text/plain'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(u);}
  const REQ_ALLOWED='77.88.8.8/32', REQ_ROUTE='route add 14.16.0.0 mask 255.252.0.0 0.0.0.0 :: rem AntiZapretAWG', REQ_DNS='77.88.8.8';
  let routesText='',routesName='routes.bat',confText='',confName='config.patched.conf',fileVersion=0;
  const el=id=>document.getElementById(id);
  const setStatus=(message,state='success')=>{el('cvStatus').textContent=message;el('cvStatusPanel').hidden=!message;el('cvStatusPanel').dataset.state=state;};
  const escRe=v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  function getVal(raw,key,req=true){const m=raw.match(new RegExp('^\\s*'+escRe(key)+'\\s*=\\s*(.+?)\\s*$','im'));if(!m){if(req)throw new Error("ключ '"+key+"' не найден");return null;}return m[1].trim();}
  function cidrMask(p){if(!Number.isInteger(p)||p<0||p>32)throw new Error('плохой префикс /'+p);const o=[];let b=p;for(let i=0;i<4;i++){const a=Math.min(Math.max(b,0),8);o.push(a===0?0:(0xff<<(8-a))&0xff);b-=8;}return o.join('.');}
  const allowed=raw=>getVal(raw,'AllowedIPs').split(',').map(s=>s.trim()).filter(Boolean);
  function ipv4Cidr(value,label){
    const m=value.match(/^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/);
    if(!m||m[1].split('.').some(o=>Number(o)>255||String(Number(o))!==o)||Number(m[2])>32)throw new Error('Некорректный IPv4 CIDR в '+label);
    return {ip:m[1],prefix:Number(m[2])};
  }
  function addrIp(raw){return ipv4Cidr(getVal(raw,'Address').split(',')[0].trim(),'Address').ip;}
  function patch(raw){const re=/^(\s*AllowedIPs\s*=\s*)(.*?)(\s*)$/im;const m=raw.match(re);if(!m)throw new Error("'AllowedIPs' не найден");const a=m[2].split(',').map(s=>s.trim()).filter(Boolean);const has=a.some(x=>x.toLowerCase()===REQ_ALLOWED.toLowerCase());if(!has)a.push(REQ_ALLOWED);return{text:raw.replace(re,m[1]+a.join(', ')+m[3]),added:!has};}
  function toRoute(c){const {ip,prefix}=ipv4Cidr(c,'AllowedIPs');return 'route add '+ip+' mask '+cidrMask(prefix)+' 0.0.0.0 :: rem AntiZapretAWG';}
  function asc(raw){const fields=Awg.parseFields(raw),line=Awg.build(fields,{extended:true,modern:true});el('cvAscHint').textContent=Awg.hasModern(fields)?'AWG 3.1 · нужна поддержка ASC 3.1 (NetcrazeOS/KeeneticOS 5.2 Alpha 11 или новее). Команда содержит ключ защиты заголовков, если он задан в файле.':line&&Awg.tokens(line).length>9?'Расширенный формат · нужна NetcrazeOS/KeeneticOS 5.1 или новее.':'Короткий формат для интерфейса Wireguard0.';return line?'interface Wireguard0 wireguard asc '+line:'';}
  const baseName=fn=>{const i=fn.lastIndexOf('.');return i>0?fn.slice(0,i):fn;};
  async function handle(file){
    const version=++fileVersion;
    el('cvDlConf').disabled=el('cvDlBat').disabled=true;
    for(const id of ['cvAscPanel','cvPrevPanel','cvResults'])el(id).hidden=true;
    el('cvEmpty').hidden=false;
    for(const id of ['cvAsc','cvConf','cvRoutes'])el(id).value='';
    for(const preview of el('cvPrevPanel').querySelectorAll('details'))preview.open=false;
    routesText=confText='';el('cvCopyAsc').textContent='Копировать';
    el('cvFileName').textContent=file?file.name:'Выберите конфигурацию AmneziaWG';
    if(!file){setStatus('');return;}
    setStatus('Обработка файла…','loading');
    try{
      if(file.size>4*1024*1024)throw new Error('максимальный размер файла — 4 МиБ');
      const raw=await file.text();if(version!==fileVersion)return;
      if(!raw.trim())throw new Error('файл пуст');
      if(/^\s*(?:PreUp|PostUp|PreDown|PostDown)\s*=/im.test(raw))throw new Error('скриптовые хуки в профиле не поддерживаются');
      const pp=patch(raw);const a=allowed(pp.text);const aip=addrIp(pp.text);
      const lines=a.filter(c=>c.toLowerCase()!==REQ_ALLOWED.toLowerCase()).map(toRoute);
      const dnsLine='route add '+REQ_DNS+' mask 255.255.255.255 '+aip+' :: rem AntiZapretDNS';
      if(!lines.some(l=>l.toLowerCase()===dnsLine.toLowerCase()))lines.unshift(dnsLine);
      if(!lines.some(l=>l.toLowerCase()===REQ_ROUTE.toLowerCase()))lines.push(REQ_ROUTE);
      const ascLine=asc(pp.text);
      routesText=lines.join('\r\n')+'\r\n';routesName=baseName(file.name)+'.routes.bat';
      confText=pp.text;confName=baseName(file.name)+'.patched.conf';
      el('cvRoutes').value=routesText;el('cvConf').value=confText;el('cvPrevPanel').hidden=false;
      if(ascLine){el('cvAsc').value=ascLine;el('cvAscPanel').hidden=false;}
      el('cvEmpty').hidden=true;el('cvResults').hidden=false;
      el('cvDlConf').disabled=el('cvDlBat').disabled=false;
      setStatus('Готово · подсетей в AllowedIPs: '+a.length+'. '+(pp.added?'DNS-адрес добавлен.':'DNS-адрес уже присутствует.'));
    }catch(e){if(version===fileVersion)setStatus('Не удалось преобразовать файл: '+e.message,'error');}
  }
  el('cvFile').addEventListener('change',e=>handle(e.target.files[0]));
  el('cvDlConf').onclick=()=>downloadText(confText,confName,'text/plain;charset=utf-8');
  el('cvDlBat').onclick=()=>downloadText(routesText,routesName,'application/x-bat;charset=us-ascii');
  el('cvCopyAsc').onclick=async()=>{
    const v=el('cvAsc').value;if(!v)return;
    try{await navigator.clipboard.writeText(v);el('cvCopyAsc').textContent='Скопировано';setTimeout(()=>el('cvCopyAsc').textContent='Копировать',1500);}
    catch{el('cvAsc').select();setStatus('Не удалось скопировать автоматически. Нажмите Ctrl+C, чтобы скопировать выделенную команду.','error');}
  };
})();
