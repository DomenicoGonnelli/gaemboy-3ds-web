/* GAEMBOY 3DS identity 5.3.5: title ID/product code first, SHA-1 for fallback. */
(() => {
  'use strict';
  const WORKER_URL='home-v5-hash-worker.js?v=5.3.5';
  const HASH_INDEX_URL='home-v5-hashes.json?v=5.3.5';
  const TITLE_INDEX_URL='home-v5-titles.json?v=5.3.5';
  const COVER_BASE='https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Nintendo_3DS/master/Named_Boxarts/';
  const BUILTIN=[
    {name:'Pokemon Alpha Sapphire (Europe) (En,Ja,Fr,De,Es,It,Ko)',region:'EUR',languages:'en,ja,fr,de,es,it,ko',titleId:'000400000011C500',serial:'CTR-ECLA'},
    {name:'Pokemon Omega Ruby (Europe) (En,Ja,Fr,De,Es,It,Ko)',region:'EUR',languages:'en,ja,fr,de,es,it,ko',titleId:'000400000011C400',serial:'CTR-ECRA'}
  ];
  let indexPromise=null,worker=null,current=null,sequence=0;
  const queue=[];
  const normalized=s=>String(s||'').replace(/\.(?:3ds|cci|cxi|3dsx|app|png)$/i,'')
    .replace(/\([^)]*\)/g,' ').replace(/\[[^\]]*\]/g,' ').replace(/&/g,' and ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,' ').trim().toLowerCase();
  function startNext(){
    if(current||!queue.length)return;
    current=queue.shift();
    worker.postMessage({id:current.id,file:current.file,mode:current.mode});
  }
  function getWorker(){
    if(worker)return worker;
    worker=new Worker(WORKER_URL);
    worker.onmessage=ev=>{
      const m=ev.data||{};
      if(m.progress!==undefined)return;
      if(!current||m.id!==current.id)return;
      const job=current;current=null;
      if(m.error)job.reject(new Error(m.error));else job.resolve(m);
      startNext();
    };
    worker.onerror=ev=>{
      const error=new Error(ev.message||'3DS identity worker unavailable');
      if(current){current.reject(error);current=null;}
      queue.splice(0).forEach(job=>job.reject(error));
      worker.terminate();worker=null;
    };
    return worker;
  }
  function run(file,mode){
    getWorker();
    return new Promise((resolve,reject)=>{queue.push({id:++sequence,file,mode,resolve,reject});startNext();});
  }
  function fileIdentity(file){return run(file,'sha1');}
  function quickIdentity(file){return run(file,'header');}
  function addTitle(index,row){
    if(!row?.name)return;
    const titleId=String(row.titleId||row.titleid||'').toUpperCase();
    const serial=String(row.serial||'').toUpperCase();
    const entry={name:row.name,serial,titleId,region:row.region||'',languages:row.languages||''};
    if(/^[0-9A-F]{16}$/.test(titleId)){
      if(!index.byTitleId.has(titleId))index.byTitleId.set(titleId,[]);
      if(!index.byTitleId.get(titleId).some(e=>e.name===entry.name&&e.region===entry.region)) index.byTitleId.get(titleId).push(entry);
    }
    if(serial){
      const variants=[serial];
      if(/^CTR-[A-Z0-9]{4}$/.test(serial)) variants.push('CTR-P-'+serial.slice(4));
      if(/^CTR-P-[A-Z0-9]{4}$/.test(serial)) variants.push('CTR-'+serial.slice(6));
      for(const v of variants){
        if(!index.byProductCode.has(v))index.byProductCode.set(v,[]);
        if(!index.byProductCode.get(v).some(e=>e.name===entry.name&&e.region===entry.region))index.byProductCode.get(v).push(entry);
      }
    }
  }
  function score(row){
    const region=String(row.region||'').toUpperCase();
    const title=row.name||'';
    return (region==='EUR'||region==='EUROPE'?40:region==='USA'?10:0)
       +(/\bIt\b/i.test(String(row.languages||''))?15:0)
       -( /\b(?:Demo|Beta|Proto)\b/i.test(title)?100:0);
  }
  function choose(rows){
    if(!rows?.length)return null;
    const names=new Set(rows.map(r=>normalized(r.name)));
    // Never guess when different games share a product code / ID.
    if(names.size!==1)return null;
    return rows.slice().sort((a,b)=>score(b)-score(a))[0];
  }
  async function loadIndex(){
    if(!indexPromise)indexPromise=(async()=>{
      const index={bySha1:{},bySerial:new Map(),byTitleId:new Map(),byProductCode:new Map()};
      for(const row of BUILTIN)addTitle(index,row);
      const [hashResp,titleResp]=await Promise.allSettled([
        fetch(HASH_INDEX_URL,{cache:'force-cache'}).then(r=>{if(!r.ok)throw new Error('SHA-1 '+r.status);return r.json();}),
        fetch(TITLE_INDEX_URL,{cache:'force-cache'}).then(r=>{if(!r.ok)throw new Error('Title ID '+r.status);return r.json();})
      ]);
      if(hashResp.status==='fulfilled'&&hashResp.value?.schema===1){
        index.bySha1=hashResp.value.sha1||{};
        for(const row of Object.values(index.bySha1)){
          if(!row?.serial)continue;
          const k=String(row.serial).toUpperCase();
          if(!index.bySerial.has(k))index.bySerial.set(k,[]);
          index.bySerial.get(k).push(row);
        }
      }else console.warn('[GAEMBOY 3DS] SHA-1 catalog unavailable');
      if(titleResp.status==='fulfilled'&&titleResp.value?.schema===1&&Array.isArray(titleResp.value.games)){
        for(const row of titleResp.value.games)addTitle(index,row);
      } else console.warn('[GAEMBOY 3DS] Title catalog unavailable: built-in mappings only');
      return index;
    })();
    return indexPromise;
  }
  function findEntry(index,identity){
    if(!index||!identity)return null;
    const sha=index.bySha1[String(identity.sha1||'').toLowerCase()];
    if(sha)return {entry:sha,method:'SHA-1'};
    const titleId=String(identity.titleId||'').toUpperCase();
    const title=choose(index.byTitleId.get(titleId));
    if(title)return {entry:title,method:'Title ID'};
    const serial=String(identity.serial||'').toUpperCase();
    const product=choose(index.byProductCode.get(serial))||choose(index.bySerial.get(serial));
    if(product)return {entry:product,method:'product code'};
    return null;
  }
  function matchCover(meta,names,locale='it'){
    if(!meta?.name)return '';
    const target=normalized(meta.name);
    if(!Array.isArray(names))names=[];
    const preferred=String(locale).toLowerCase().startsWith('it');
    let result='',best=-Infinity;
    for(const name of names){
      if(typeof name!=='string'||!name.toLowerCase().endsWith('.png')||/[\\/]/.test(name))continue;
      if(normalized(name)!==target)continue;
      const t=name.toLowerCase();
      let s=0;
      if(name.replace(/\.png$/i,'')===meta.name)s+=40;
      if(t.includes('(europe)'))s+=preferred?55:25;
      if(t.includes('(italy)'))s+=preferred?65:15;
      if(t.includes('(usa)'))s+=10;
      if(preferred&&/\([^)]*\bit\b[^)]*\)/i.test(name))s+=20;
      if(/\b(?:demo|beta|proto|kiosk)\b/i.test(name))s-=100;
      if(s>best){best=s;result=name;}
    }
    // Known cover paths also work when the manifest fails to load (e.g. 404).
    if(!result&&target==='pokemon alpha sapphire')
      result='Pokemon Alpha Sapphire (Europe) (En,Ja,Fr,De,Es,It,Ko) (Rev 2).png';
    if(!result&&target==='pokemon omega ruby')
      result='Pokemon Omega Ruby (Europe) (En,Ja,Fr,De,Es,It,Ko) (Rev 2).png';
    return result?COVER_BASE+encodeURIComponent(result):'';
  }
  window.Gaemboy3DSRomIdentity={loadIndex,fileIdentity,quickIdentity,findEntry,matchCover,normalized};
})();
