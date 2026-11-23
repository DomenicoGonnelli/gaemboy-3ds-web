/* GAEMBOY 3DS Home: No-Intro identity (SHA-1, then NCCH product code) and Libretro cover. */
(() => {
  'use strict';
  const WORKER_URL='home-v5-hash-worker.js?v=5.3.3';
  const INDEX_URL='home-v5-hashes.json?v=5.3.3';
  const COVER_BASE='https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Nintendo_3DS/master/Named_Boxarts/';
  let indexPromise=null, worker=null, queue=[],current=null,seq=0;
  const pending=new Map();
  const normalized=s=>String(s||'').replace(/\.(?:3ds|cci|cxi|3dsx|app|png)$/i,'')
    .replace(/\([^)]*\)/g,' ').replace(/\[[^\]]*\]/g,' ').replace(/&/g,' and ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,' ').trim().toLowerCase();
  function startNext(){
    if(current||!queue.length)return;
    current=queue.shift();
    worker.postMessage({id:current.id,file:current.file});
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
      const error=new Error(ev.message||'Worker unavailable');
      if(current){current.reject(error);current=null;}
      queue.splice(0).forEach(job=>job.reject(error));
      worker.terminate();worker=null;
    };
    return worker;
  }
  function fileIdentity(file){
    getWorker();
    return new Promise((resolve,reject)=>{queue.push({id:++seq,file,resolve,reject});startNext();});
  }
  async function loadIndex(){
    if(!indexPromise){indexPromise=fetch(INDEX_URL,{cache:'force-cache'}).then(r=>{
      if(!r.ok)throw new Error('No-Intro index HTTP '+r.status);
      return r.json();
    }).then(db=>{
      if(db.schema!==1 || !db.sha1 || typeof db.sha1!=='object')throw new Error('Invalid 3DS No-Intro index');
      const bySerial=new Map();
      for(const row of Object.values(db.sha1)){
        if(!row?.serial)continue;
        const k=row.serial.toUpperCase();
        if(!bySerial.has(k))bySerial.set(k,[]);
        if(!bySerial.get(k).some(v=>v.name===row.name))bySerial.get(k).push(row);
      }
      return {bySha1:db.sha1,bySerial};
    }).catch(e=>{console.warn('[Gaemboy 3DS] SHA-1 catalog not loaded:',e);return null;});}
    return indexPromise;
  }
  function matchCover(meta,names,locale='it'){
    if(!meta?.name||!Array.isArray(names)||!names.length)return '';
    const target=normalized(meta.name),region=String(meta.name).match(/\((Europe|Italy|USA|Japan|World)\)/i)?.[1]?.toLowerCase()||'';
    let result='',best=-1e9;
    for(const n of names){
      if(typeof n!=='string'||!n.toLowerCase().endsWith('.png')||n.includes('/')||n.includes('\\'))continue;
      if(normalized(n)!==target)continue;
      const italian=String(locale).toLowerCase().startsWith('it');
      const exact=n.replace(/\.png$/i,'')===meta.name;
      const tag=n.toLowerCase();
      let score=(exact?55:0)+(region && tag.includes('('+region+')')?20:0);
      if(italian){
        if(tag.includes('(italy)'))score+=40;
        else if(/\(europe\)/i.test(n) && /\([^)]*\bit\b[^)]*\)/i.test(n))score+=33;
        else if(tag.includes('(europe)'))score+=25;
        else if(tag.includes('(usa)'))score+=10;
      }else if(region && tag.includes('('+region+')'))score+=25;
      if(/\b(?:beta|proto|demo|kiosk)\b/i.test(n))score-=35;
      if(score>best){best=score;result=n;}
    }
    return result ? COVER_BASE+encodeURIComponent(result):'';
  }
  function findEntry(index,identity){
    if(!index||!identity)return null;
    const sha=index.bySha1[String(identity.sha1||'').toLowerCase()];
    if(sha)return {entry:sha,method:'sha1'};
    const candidates=index.bySerial.get(String(identity.serial||'').toUpperCase())||[];
    if(!candidates.length)return null;
    // Serial identifies a title, not the exact ROM revision; choose the first
    // non-beta edition only if all candidates describe the same normalized title.
    if(new Set(candidates.map(v=>normalized(v.name))).size>1)return null;
    return {entry:candidates.find(v=>!/\b(?:beta|proto|demo)\b/i.test(v.name))||candidates[0],method:'serial'};
  }
  window.Gaemboy3DSRomIdentity={loadIndex,fileIdentity,findEntry,matchCover,normalized};
})();
