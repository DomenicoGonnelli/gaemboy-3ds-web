/* GAEMBOY 3DS Home v5 — standalone GPL-3.0-or-later frontend adapter.
 * Does not modify the Azahar core or existing gameplay view.
 * Requires the underlying app's #library-list, original folder and refresh controls.
 */
(() => {
  'use strict';
  if (window.__gaemboyHomeV5) return;
  window.__gaemboyHomeV5 = true;

  const PREFIX = 'gb3';
  const SOURCE = 'https://github.com/DomenicoGonnelli/gaemboy-3ds-web';
  // Keep previous DB so local custom covers and last directory survive the upgrade.
  const DB = 'gaemboy-3ds-home-ui-v3';
  const IMAGE_STORE = 'artwork';
  const PREF_STORE = 'preferences';
  const VALID_EXT = /\.(3dsx|3ds|cci|cxi|app|elf)(?=$|[\s)\]])/i;
  const UI_COMMAND = /^(?:riseleziona|seleziona|scegli|cambia|dimentica|aggiorna|importa|apri|cerca|browse|choose|refresh|remove|retry)\s+(?:la\s+)?(?:cartella|directory|folder|rom|giochi|games)?\s*$/i;
  const icons = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M20 7v5h-5M4 17v-5h5M6 9a7 7 0 0 1 12-2l2 5M18 15a7 7 0 0 1-12 2l-2-5"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 12 7-12 7z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16 4l4 4L8 20H4v-4z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 3h4l1 3H9l1-3zM6 7l1 13h10l1-13"/></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 6-5 4 3 3-3 5 5"/></svg>'
  };
  const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const key = (g) => norm(g.path || g.fileName || g.title).toLocaleLowerCase('it');
  const maybeTitle = (v) => norm(v).replace(/\.(3dsx|3ds|cci|cxi|app|elf)$/i,'').replace(/[._]+/g,' ').replace(/\s+/g,' ').trim();
  const isVisible = el => {
    if (!el || !el.isConnected || el.hidden) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.hidden || getComputedStyle(n).display === 'none' || getComputedStyle(n).visibility === 'hidden') return false;
      n = n.parentElement;
    }
    return true;
  };
  const legacy = selector => Array.from(document.querySelectorAll(selector)).filter(el => !root?.contains(el));
  const textOf = el => norm(el?.textContent || el?.value || el?.getAttribute('aria-label'));
  function originalButton(re) { return legacy('button,input[type="button"],input[type="submit"]').find(el => re.test(textOf(el))) || null; }
  function imageUrl(src) {
    try { if (!src) return ''; const u=new URL(src,location.href); return ['https:','http:','blob:','data:'].includes(u.protocol)?u.href:''; } catch { return ''; }
  }
  function createDatabase() {
    return new Promise((resolve,reject) => {
      const r=indexedDB.open(DB,1);
      r.onupgradeneeded=()=>{const db=r.result;db.createObjectStore(IMAGE_STORE);db.createObjectStore(PREF_STORE);};
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
  }
  async function readDB(store,id) {
    if (!('indexedDB' in window)) return null;
    try {const db=await createDatabase();return await new Promise((res,rej)=>{const t=db.transaction(store,'readonly');const r=t.objectStore(store).get(id);r.onsuccess=()=>res(r.result??null);r.onerror=()=>rej(r.error);t.oncomplete=()=>db.close();});}catch{return null;}
  }
  async function writeDB(store,id,value) {
    if (!('indexedDB' in window)) return;
    try {const db=await createDatabase();await new Promise((res,rej)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value,id);t.oncomplete=res;t.onerror=()=>rej(t.error);});db.close();}catch(err){console.warn('[Gaemboy Home] IndexedDB:',err);}
  }

  async function deleteDB(store,id) {
    if (!('indexedDB' in window)) return;
    try {const db=await createDatabase();await new Promise((res,rej)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).delete(id);t.oncomplete=res;t.onerror=()=>rej(t.error);});db.close();} catch(err){console.warn('[Gaemboy 3DS] delete artwork:',err);}
  }

  let root;
  let games = [];
  let filter = '';
  let lastHandle = null;
  let folderName = '';
  let chosen = false;
  let didImport = false;
  let launchPending = false;
  let pollTimer = 0;
  let rebuildTimer = 0;
  let displayedSnapshot = null;
  let artworks = new Map();
  const blobUrls = new Map();
  let coverNames = [];
  let coverMatches = new Map();
  let coverOnline = true;
  let openActionKey = '';
  let hiddenGames = new Set();
  let nameOverrides = {};
  const baseUrl = location.origin + location.pathname;
  const ART_BASE = 'https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Nintendo_3DS/master/Named_Boxarts/';
  function titleKey(raw) {
    return norm(raw).replace(/\.(3dsx|3ds|cci|cxi|app|elf|png)$/i,'')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/(?:\bdecrypted\b|\btrimmed\b|\b3ds\s*rom\b)/ig, ' ')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g,' and ').replace(/[^a-z0-9]+/gi,' ').trim().toLowerCase();
  }
  function chooseCoverFile(a,b) {
    const quality = name => ( /\(Europe\)/i.test(name)?10:0 ) + (/\(It[,)]/i.test(name)?3:0) + (/\(USA\)/i.test(name)?5:0) - (/\b(?:Beta|Proto|Demo)\b/i.test(name)?15:0);
    return quality(a) >= quality(b) ? a : b;
  }
  function buildCoverMap() {
    coverMatches = new Map();
    for(const name of coverNames) {
      if(typeof name !== 'string' || !/\.png$/i.test(name) || /[\\/]/.test(name)) continue;
      const k=titleKey(name);if(!k || k.length<3)continue;
      const existing=coverMatches.get(k);
      coverMatches.set(k,existing?chooseCoverFile(existing,name):name);
    }
  }
  function matchCover(g) {
    if(!coverOnline) return '';
    const name=coverMatches.get(titleKey(g.nativeTitle||g.title)) || coverMatches.get(titleKey(g.fileName));
    return name ? ART_BASE + encodeURIComponent(name) : '';
  }
  // Reproduce the official GAEMBOY FakeCover visual language (spine, hash-based
  // palette, title treatment). This draws locally: no external image or ROM upload.
  function hashTitle(input) {
    let h=2166136261;
    for (const ch of String(input)) { h=Math.imul(h^ch.charCodeAt(0),16777619); }
    return h>>>0;
  }
  function generatedCover(g) {
    const title = g.title || g.nativeTitle || g.fileName;
    const h=hashTitle(key(g));
    const hue=(h%65)+285; // GAEMBOY plum / magenta family
    const base=document.createElement('span');base.className='gb3-fake';
    base.dataset.pattern=String((h>>>4)%6);
    base.style.setProperty('--fc-base',`hsl(${hue} 51% 26%)`);
    base.style.setProperty('--fc-high',`hsl(${hue+11} 65% 45%)`);
    const spine=document.createElement('span');spine.className='gb3-fake-spine';
    const spineText=document.createElement('span');spineText.textContent='GAEMBOY 3DS';spine.append(spineText);
    const main=document.createElement('span');main.className='gb3-fake-inner';
    const pokemon=title.match(/^pok[eéèêë]mon\b\s*:?\s*(.*)$/i);
    if(pokemon){
      const brand=document.createElement('span');brand.className='gb3-fake-pokemon';brand.textContent='Pokémon';main.append(brand);
      if(pokemon[1]) {const sub=document.createElement('span');sub.className='gb3-fake-sub';sub.textContent=pokemon[1];main.append(sub);}
    } else {
      const ix=title.indexOf(':');
      const first=document.createElement('span');first.className='gb3-fake-title';
      first.textContent=ix>0?title.slice(0,ix).trim():title;
      first.style.fontSize=first.textContent.length>24?'clamp(11px,2.6cqw,19px)':'clamp(13px,3.7cqw,27px)';
      main.append(first);
      if(ix>0 && ix<title.length-1){const sub=document.createElement('span');sub.className='gb3-fake-sub';sub.textContent=title.slice(ix+1).trim();main.append(sub);}
    }
    base.append(spine,main);
    return base;
  }
  async function saveName(g,name) {
    const next=norm(name).slice(0,120);
    if(!next){setMessage('Inserisci un nome valido.','error');return;}
    nameOverrides[key(g)]=next;
    await writeDB(PREF_STORE,'name-overrides',nameOverrides);
    for(const item of games){if(key(item)===key(g))item.title=next;}
    displayedSnapshot=null;renderCards();setMessage('Nome del gioco aggiornato.','success');
  }
  function editGame(g) {
    const dialog=root.querySelector('#gb3-edit-modal');
    dialog.querySelector('#gb3-edit-title').value=g.title;
    dialog.querySelector('#gb3-edit-context').textContent=g.fileName;
    dialog.hidden=false;
    const form=dialog.querySelector('#gb3-edit-form');
    form.onsubmit=ev=>{ev.preventDefault();dialog.hidden=true;void saveName(g,dialog.querySelector('#gb3-edit-title').value);};
    dialog.querySelector('#gb3-edit-cover').onclick=()=>{dialog.hidden=true;chooseArtwork(g);};
    dialog.querySelector('#gb3-edit-reset').onclick=()=>{dialog.hidden=true;void removeArtwork(g);};
    dialog.querySelector('#gb3-edit-cancel').onclick=()=>{dialog.hidden=true;};
    dialog.querySelector('#gb3-edit-title').focus();
  }
  async function shareGame(g) {
    // Local user-owned ROMs cannot be shared by URL. Share the player only.
    const data={title:g.title+' · Gaemboy 3DS',text:'Apri Gaemboy 3DS per giocare ai tuoi giochi locali. Le ROM non sono incluse.',url:baseUrl};
    if(navigator.share){try{await navigator.share(data);return;}catch(err){if(err?.name==='AbortError')return;}}
    try {await navigator.clipboard.writeText(data.url);setMessage('Link a Gaemboy 3DS copiato: non contiene la ROM.','success');}
    catch {setMessage('Link da condividere: '+baseUrl,'info');}
  }
  async function removeFromLibrary(g) {
    if(!window.confirm('Rimuovere "'+g.title+'" dalla libreria?\nIl file ROM non verrà cancellato dal dispositivo.')) return;
    hiddenGames.add(key(g));
    await writeDB(PREF_STORE,'hidden-games',[...hiddenGames]);
    openActionKey='';displayedSnapshot=null;renderCards();
    setMessage('Gioco rimosso dalla libreria. La ROM è ancora nella cartella.','success');
  }
  async function restoreRemoved() {
    hiddenGames.clear();await writeDB(PREF_STORE,'hidden-games',[]);
    displayedSnapshot=null;renderCards();setMessage('Giochi rimossi ripristinati.','success');
  }
  async function getCoverCatalog() {
    try {
      const response=await fetch('home-v5-covers.json',{cache:'force-cache'});
      if(!response.ok) return;
      const json=await response.json();
      if(!Array.isArray(json.names))return;
      coverNames=json.names;buildCoverMap();displayedSnapshot=null;renderCards();
    } catch(err) { console.info('[Gaemboy 3DS] Cover catalog unavailable:',err); }
  }
  function setActions(g,card,open) {
    if(openActionKey && openActionKey!==key(g)) {
      root?.querySelectorAll('.gb3-card.is-open').forEach(el=>{el.classList.remove('is-open');el.querySelector('.gb3-action-menu')?.setAttribute('aria-expanded','false');});
    }
    openActionKey=open?key(g):'';
    card.classList.toggle('is-open',open);
    card.querySelector('.gb3-action-menu')?.setAttribute('aria-expanded',String(open));
  }
  function wireSwipe(card,g) {
    let startX=0,startY=0,lastX=0,tracking=false,dragged=false;
    const face=card.querySelector('.gb3-card-face');
    const finish=(ev, cancel=false)=>{
      if(!tracking)return;
      tracking=false;
      if(ev.pointerId!==undefined && card.hasPointerCapture?.(ev.pointerId))card.releasePointerCapture(ev.pointerId);
      const dx=lastX-startX;
      const dy=(ev.clientY ?? startY)-startY;
      card.classList.remove('is-swiping');
      face.style.removeProperty('transform');
      if(!cancel && dragged && Math.abs(dx)>46 && Math.abs(dx)>Math.abs(dy)*1.2){setActions(g,card,dx>0);}
      if(dragged){card.dataset.swipeBlocked='1';setTimeout(()=>{if(card.isConnected)delete card.dataset.swipeBlocked;},170);}
      dragged=false;
    };
    card.addEventListener('pointerdown',ev=>{
      if(!ev.isPrimary || ev.button!==0 || ev.target.closest('.gb3-action-menu,.gb3-change-cover'))return;
      startX=lastX=ev.clientX;startY=ev.clientY;tracking=true;dragged=false;
    });
    card.addEventListener('pointermove',ev=>{
      if(!tracking)return;
      const dx=ev.clientX-startX,dy=ev.clientY-startY;
      if(Math.abs(dy)>Math.abs(dx)*1.2 && Math.abs(dy)>9){tracking=false;return;}
      if(Math.abs(dx)>12 && Math.abs(dx)>Math.abs(dy)*1.2){
        if(!dragged){dragged=true;try{card.setPointerCapture(ev.pointerId);}catch{}}lastX=ev.clientX;card.classList.add('is-swiping');
        face.style.transform=`translateX(${Math.max(0,Math.min(138,dx+(card.classList.contains('is-open')?138:0)))}px)`;
      }
    });
    card.addEventListener('pointerup',ev=>finish(ev));
    card.addEventListener('pointercancel',ev=>finish(ev,true));
    card.addEventListener('keydown',ev=>{
      if(ev.key==='Escape' && card.classList.contains('is-open')){setActions(g,card,false);ev.preventDefault();}
      if(ev.key==='ArrowRight' && ev.target===card.querySelector('.gb3-cover')){setActions(g,card,true);ev.preventDefault();}
      if(ev.key==='ArrowLeft' && ev.target===card.querySelector('.gb3-cover')){setActions(g,card,false);ev.preventDefault();}
    });
  }

  // Patch the existing picker *before* the main script handles user clicks.
  // Keeps user gesture intact; provides a stable browser last-folder hint.
  if (typeof window.showDirectoryPicker === 'function') {
    const pick = window.showDirectoryPicker.bind(window);
    window.showDirectoryPicker = function (options = {}) {
      const opts = {...(options && typeof options === 'object' ? options : {})};
      if (!opts.id) opts.id='gaemboy-3ds-library';
      if (!opts.startIn && lastHandle) opts.startIn=lastHandle;
      let request;
      try {request=pick(opts);} catch (e) {return Promise.reject(e);}
      return Promise.resolve(request).then(handle => {
        if (handle?.kind === 'directory') {
          lastHandle=handle; chosen=true; folderName=handle.name || folderName;
          void writeDB(PREF_STORE,'directory-handle',handle);
          if (root) {renderFolder(); scheduleRender();}
        }
        return handle;
      });
    };
  }
  void readDB(PREF_STORE,'directory-handle').then(handle => {
    if (handle?.kind==='directory') {lastHandle=handle;folderName=handle.name || '';chosen=true;renderFolder();}
  });
  void readDB(PREF_STORE,'folder-name').then(name => {if (!folderName && typeof name==='string') {folderName=name;renderFolder();}});

  function nativeList() {
    const list = legacy('#library-list')[0];
    if (list) return [...list.children].filter(el=>el.nodeType===1);
    const heading=legacy('h1,h2,h3').find(h=>/^libreria(?:\s|$)/i.test(textOf(h)));
    if (!heading) return [];
    const next=legacy('h1,h2,h3').find(h=>h!==heading && !!(heading.compareDocumentPosition(h)&Node.DOCUMENT_POSITION_FOLLOWING));
    const scope=heading.parentElement;
    return scope ? [...scope.querySelectorAll('li,article,[data-game-path]')].filter(el=>!next||!!(el.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING)) : [];
  }
  function parseGameRow(row) {
    if (row.closest('#gb3-home')) return null;
    const raw=textOf(row);
    const filepath=row.dataset?.gamePath || row.dataset?.path || row.querySelector('[data-game-path]')?.dataset.gamePath || '';
    const named=(filepath + ' ' + raw).match(/(?:^|[\\/\s])(?!\S*[<>])([^\\/\n]+?\.(?:3dsx|3ds|cci|cxi|app|elf))(?=$|[\s)\]])/i);
    if (!named) return null; // absolutely require a real game filename, not a button label
    const fileName=norm(named[1]);
    if (UI_COMMAND.test(fileName) || !VALID_EXT.test(fileName)) return null;
    const buttons=Array.from(row.querySelectorAll('button,[role="button"],a[href]'));
    const play=buttons.find(b=>/^(?:gioca|avvia|play|launch)(?:\b|$)/i.test(textOf(b)))
      || buttons.find(b=>/^(?:riseleziona|conferma)\s+cartella/i.test(textOf(b)))
      || buttons.find(b=>b.dataset.gamePath)
      || (typeof row.click==='function'?row:null);
    if (!play) return null;
    const title=maybeTitle(fileName.split(/[\\/]/).pop());
    if (!title || UI_COMMAND.test(title)) return null;
    const metadataName=row.dataset?.gameTitle || row.querySelector('[data-title]')?.dataset.title;
    const img=row.querySelector('img');
    const path=filepath || fileName;
    return {title:maybeTitle(metadataName)||title,nativeTitle:maybeTitle(metadataName)||title,fileName,path,ext:(fileName.match(VALID_EXT)||['3DS'])[1].toUpperCase(),element:play,img:imageUrl(img?.getAttribute('src'))};
  }
  function readGames() {
    const arr=[];
    const ids=new Set();
    for(const row of nativeList()) {
      const item=parseGameRow(row);if(!item)continue;
      if(nameOverrides[key(item)])item.title=nameOverrides[key(item)];
      const id=key(item);if(ids.has(id))continue;ids.add(id);arr.push(item);
    }
    return arr;
  }
  function hasGameView() {
    const known=['#game-view','#gameView','#view-game','#play-view','#emulation-view','#game-screen','#gameScreen'];
    for(const sel of known){const el=document.querySelector(sel);if(el && isVisible(el))return true;}
    const headings=legacy('h1,h2,h3').filter(el=>/^gioco$/i.test(textOf(el)) && isVisible(el));
    for(const h of headings) {
      let n=h.parentElement;
      for(let depth=0;n && depth<4;depth++,n=n.parentElement) {
        if(n.querySelector('canvas') && isVisible(n))return true;
      }
    }
    return legacy('canvas').some(el=>isVisible(el) && el.getBoundingClientRect().width>100 && el.getBoundingClientRect().height>60);
  }
  function restoreHome() {
    if (!root) return;
    root.hidden=false;launchPending=false;
    scheduleRender();
  }
  function launch(g) {
    if (!g.element?.isConnected) {setMessage('Libreria aggiornata. Premi Importa ROM e riprova.','error');return;}
    launchPending=true;
    root.hidden=true; // delegate to the existing implementation, including its permission dialog
    try {g.element.click();} catch(err){restoreHome();setMessage('Non riesco ad aprire il gioco: '+err.message,'error');return;}
    clearTimeout(pollTimer);
    const started=Date.now();
    const check=()=>{
      if (!launchPending) return;
      if(hasGameView()) {launchPending=false;return;}
      if(Date.now()-started>8500){restoreHome();setMessage('Il gioco non è stato avviato. Controlla l’accesso alla cartella e riprova.','info');return;}
      pollTimer=setTimeout(check,400);
    };
    pollTimer=setTimeout(check,400);
  }
  function setMessage(message='',kind='info') {
    const el=root?.querySelector('#gb3-status');if(!el)return;
    el.hidden=!message;el.dataset.kind=kind;el.textContent=message;
  }
  function renderFolder() {
    if(!root)return;
    const label=folderName || (games.length?'Cartella giochi salvata':'Nessuna cartella selezionata');
    root.querySelector('#gb3-folder-name').textContent=label;
    root.querySelector('#gb3-folder-sub').textContent=folderName?'I file rimangono sul tuo dispositivo':'Seleziona una cartella contenente giochi 3DS';
    root.querySelector('#gb3-select').textContent=(folderName || chosen || games.length)?'Cambia cartella':'Scegli cartella';
    const enabled=!!(chosen||folderName||games.length);
    root.querySelector('#gb3-scan').disabled=!enabled;
    root.querySelector('#gb3-scan-empty').disabled=!enabled;
  }
  function getDecorativeTitle(title) {
    return (title.match(/[\p{L}\p{N}]+/gu)||[]).slice(0,2).map(w=>w[0]?.toUpperCase()).join('')||'3D';
  }
  function chooseArtwork(g) {
    const picker=root.querySelector('#gb3-cover-input');
    picker.value='';
    picker.onchange=()=>{const file=picker.files?.[0];if(file)void installArtwork(g,file);};
    picker.click();
  }
  async function removeArtwork(g) {
    const k=key(g);
    const previous=blobUrls.get(k);if(previous)URL.revokeObjectURL(previous);
    blobUrls.delete(k);artworks.delete(k);
    await deleteDB(IMAGE_STORE,k);
    displayedSnapshot=null;renderCards();setMessage('Copertina personalizzata rimossa.','success');
  }
  function makeCard(g) {
    const card=document.createElement('article');card.className='gb3-card';
    card.dataset.gameKey=key(g);
    if(openActionKey===key(g)) card.classList.add('is-open');
    const actions=document.createElement('div');actions.className='gb3-card-actions';
    const specs=[
      ['edit','Modifica',icons.edit,()=>editGame(g)],
      ['share','Condividi',icons.share,()=>void shareGame(g)],
      ['delete','Elimina',icons.trash,()=>void removeFromLibrary(g)]
    ];
    for(const [cl,label,svg,action] of specs) {
      const btn=document.createElement('button');btn.type='button';btn.className='gb3-action gb3-action-'+cl;
      btn.title=label;btn.setAttribute('aria-label',label+' '+g.title);
      btn.innerHTML=svg+'<span>'+label+'</span>';
      btn.addEventListener('click',ev=>{ev.stopPropagation();setActions(g,card,false);action();});actions.append(btn);
    }
    const face=document.createElement('div');face.className='gb3-card-face';
    const cover=document.createElement('button');cover.className='gb3-cover';cover.type='button';cover.setAttribute('aria-label','Gioca a '+g.title);
    const wash=document.createElement('div');wash.className='gb3-cover-wash';cover.append(wash);
    const fallback=generatedCover(g);
    const image=document.createElement('img');image.loading='lazy';image.alt='';image.hidden=true;
    const src=blobUrls.get(key(g)) || artworks.get(key(g)) || matchCover(g) || g.img;
    if(src){
      // In COEP-isolated pages remote covers require CORS; never let an image failure break the library.
      if(src.startsWith('https://'))image.crossOrigin='anonymous';
      image.src=src;image.hidden=false;
      image.onerror=()=>{if(g.img && image.src!==g.img && image.src.startsWith('https://')){image.crossOrigin=null;image.src=g.img;return;}image.hidden=true;fallback.hidden=false;};fallback.hidden=true;
    }
    cover.append(fallback,image);
    const platform=document.createElement('span');platform.className='gb3-platform';platform.textContent='3DS';cover.append(platform);
    const caption=document.createElement('div');caption.className='gb3-card-label';
    const title=document.createElement('div');title.className='gb3-card-title';title.title=g.title;title.textContent=g.title;
    const bottom=document.createElement('div');bottom.className='gb3-card-bottom';
    const format=document.createElement('span');format.textContent=g.ext;
    const play=document.createElement('span');play.className='gb3-play';play.textContent='Gioca';play.insertAdjacentHTML('beforeend',icons.play);
    bottom.append(format,play);caption.append(title,bottom);
    const menu=document.createElement('button');menu.type='button';menu.className='gb3-action-menu';menu.setAttribute('aria-label','Opzioni per '+g.title);menu.setAttribute('aria-expanded',String(openActionKey===key(g)));menu.textContent='•••';
    menu.addEventListener('click',ev=>{ev.stopPropagation();setActions(g,card,!card.classList.contains('is-open'));});
    cover.addEventListener('click',ev=>{if(card.dataset.swipeBlocked==='1'){ev.preventDefault();return;}if(card.classList.contains('is-open')){ev.preventDefault();setActions(g,card,false);return;}launch(g);});
    face.append(cover,caption,menu);card.append(actions,face);wireSwipe(card,g);
    return card;
  }
  async function installArtwork(g,file) {
    if(!file.type.startsWith('image/') || file.size > 4*1024*1024){setMessage('Seleziona un’immagine PNG/JPG/WebP inferiore a 4 MB.','error');return;}
    const k=key(g);await writeDB(IMAGE_STORE,k,file);
    const previous=blobUrls.get(k);if(previous)URL.revokeObjectURL(previous);
    const url=URL.createObjectURL(file);blobUrls.set(k,url);artworks.set(k,url);
    displayedSnapshot=null; renderCards();setMessage('Copertina aggiornata.','success');
  }
  async function loadArtwork(g) {
    const k=key(g);if(artworks.has(k)||blobUrls.has(k))return;
    artworks.set(k,'');
    const blob=await readDB(IMAGE_STORE,k);
    if(blob instanceof Blob) {
      const url=URL.createObjectURL(blob);blobUrls.set(k,url);artworks.set(k,url);
      displayedSnapshot=null; renderCards();
    }
  }
  function renderCards() {
    if(!root || root.hidden)return;
    const visibleGames=games.filter(g=>!hiddenGames.has(key(g)));
    const found=visibleGames.filter(g=>g.title.toLocaleLowerCase('it').includes(filter));
    const sig=found.map(g=>key(g)+'|'+g.title+'|'+(blobUrls.get(key(g))||artworks.get(key(g))||matchCover(g)||g.img)+'|'+openActionKey).join('\n')+'|hidden:'+hiddenGames.size;
    if(sig===displayedSnapshot)return;
    displayedSnapshot=sig;
    const grid=root.querySelector('#gb3-grid');
    grid.replaceChildren(...found.map(makeCard));
    const count=root.querySelector('#gb3-count');count.textContent=String(visibleGames.length);
    root.querySelector('#gb3-restore-games').hidden=hiddenGames.size===0;
    root.querySelector('#gb3-empty').hidden=visibleGames.length>0;
    grid.hidden=found.length===0;
    root.querySelector('#gb3-nomatch').hidden=!(visibleGames.length>0 && found.length===0);
    root.querySelector('#gb3-search').hidden=visibleGames.length===0;
    root.querySelector('#gb3-cover-toggle').hidden=visibleGames.length===0 || coverNames.length===0;
    root.querySelector('#gb3-cover-toggle').setAttribute('aria-pressed',String(coverOnline));
    root.querySelector('#gb3-empty-title').textContent=visibleGames.length===0&&hiddenGames.size>0?'Nessun gioco visibile':didImport?'Nessuna ROM 3DS valida nella cartella':'Nessun gioco importato';
    for(const g of visibleGames) void loadArtwork(g);
  }
  function refresh() {
    if(!root || launchPending)return;
    const next=readGames();
    const nextKey=next.map(g=>key(g)+'|'+g.title).join('\n');
    const lastKey=games.map(g=>key(g)+'|'+g.title).join('\n');
    if(nextKey!==lastKey){games=next;displayedSnapshot=null;}
    if(games.length) chosen=true;
    renderFolder();renderCards();
  }
  function scheduleRender() { clearTimeout(rebuildTimer);rebuildTimer=setTimeout(refresh,130); }
  function chooseFolder() {
    const btn=originalButton(/^(?:scegli|cambia|seleziona)\s+cartella(?:\s+giochi)?/i);
    if(!btn){setMessage('Selettore cartella non disponibile in questa versione.','error');return;}
    try{btn.click();setMessage('Conferma la cartella nel browser. Poi premi Importa ROM.');}
    catch(e){setMessage('Impossibile aprire il selettore: '+e.message,'error');}
  }
  function openSingleGame() {
    const btn=originalButton(/^apri\s+rom/i);
    if(!btn){setMessage('Apertura file singolo non disponibile in questa versione.','error');return;}
    launchPending=true;
    root.hidden=true;
    try {btn.click();} catch(e) {restoreHome();setMessage('Impossibile aprire il file: '+e.message,'error');return;}
    clearTimeout(pollTimer);
    const started=Date.now();
    const check=()=>{
      if(!launchPending)return;
      if(hasGameView()){launchPending=false;return;}
      if(Date.now()-started>8500){restoreHome();return;}
      pollTimer=setTimeout(check,400);
    };
    pollTimer=setTimeout(check,400);
  }
  function importGames() {
    const btn=originalButton(/^aggiorna(?:\s|$)|^scansiona(?:\s|$)/i);
    if(!btn){setMessage('Comando di scansione non disponibile.','error');return;}
    didImport=true;setMessage('Sto cercando giochi 3DS nella cartella…');
    try{btn.click();}catch(e){setMessage('Errore durante la scansione: '+e.message,'error');return;}
    setTimeout(()=>{refresh();setMessage(games.length?`${games.length} ${games.length===1?'gioco disponibile':'giochi disponibili'} nella libreria.`:'Nessuna ROM 3DS valida è presente nella cartella.','info');},1800);
    setTimeout(refresh,3000);
  }
  function build() {
    root=document.createElement('main');root.id='gb3-home';root.setAttribute('aria-label','Libreria Gaemboy 3DS');
    root.innerHTML=`
      <div class="gb3-wallpaper" aria-hidden="true"></div>
      <div class="gb3-shell">
        <header class="gb3-header"><div class="gb3-brand"><img src="home-v5-assets/logo.png" alt="" width="48" height="48"><div class="gb3-brand-name"><strong>GAEMBOY</strong><span>3DS LIBRARY</span></div></div><span class="gb3-header-note">La tua console, i tuoi giochi</span></header>
        <div class="gb3-scroller" id="gb3-scroller">
        <section class="gb3-config" aria-label="Configurazione cartella">
          <div class="gb3-config-copy"><div class="gb3-config-icon">${icons.folder}</div><div><div class="gb3-eyebrow">CARTELLA GIOCHI</div><strong id="gb3-folder-name">Nessuna cartella selezionata</strong><p id="gb3-folder-sub">Seleziona una cartella contenente giochi 3DS</p></div></div>
          <div class="gb3-config-buttons"><button id="gb3-restore-games" type="button" class="gb3-button gb3-button-soft" hidden>Ripristina rimossi</button><button id="gb3-select" type="button" class="gb3-button gb3-button-soft">Scegli cartella</button><button id="gb3-scan" type="button" class="gb3-button gb3-button-main">${icons.refresh} Importa ROM</button></div>
        </section>
        <div id="gb3-status" class="gb3-status" role="status" aria-live="polite" hidden></div>
        <section class="gb3-content" aria-label="Giochi Nintendo 3DS">
          <div class="gb3-titlebar"><div><div class="gb3-eyebrow">LA TUA COLLEZIONE</div><h1>La tua libreria <span id="gb3-count">0</span></h1><p>I giochi rimangono sul tuo dispositivo, senza upload.</p></div><div class="gb3-tools"><button id="gb3-cover-toggle" class="gb3-cover-toggle" type="button" aria-pressed="true" hidden>Copertine online · On</button><label class="gb3-search" id="gb3-search" hidden>${icons.search}<input type="search" id="gb3-filter" placeholder="Cerca un gioco…" autocomplete="off" aria-label="Cerca un gioco"></label></div></div>
          <div class="gb3-grid" id="gb3-grid" hidden></div>
          <div class="gb3-nomatch" id="gb3-nomatch" hidden>Nessun gioco corrisponde alla ricerca.</div>
          <div class="gb3-empty" id="gb3-empty">
            <div class="gb3-empty-icon">${icons.folder}</div><h2 id="gb3-empty-title">Nessun gioco importato</h2>
            <p>Per giocare al 3DS non è necessario caricare ROM di grandi dimensioni nel browser. Scegli una cartella del dispositivo che contenga i giochi: verranno elencati senza duplicare i file.</p>
            <div class="gb3-empty-cta"><button id="gb3-select-empty" type="button" class="gb3-button gb3-button-main">${icons.folder} Scegli cartella</button><button id="gb3-scan-empty" type="button" class="gb3-button gb3-button-soft">${icons.refresh} Importa ROM</button></div>
            <button class="gb3-single" id="gb3-single" type="button">Vuoi giocare senza creare una libreria? Apri un singolo file 3DS</button>
            <div class="gb3-steps"><span><b>1</b> Scegli cartella</span><span><b>2</b> Importa ROM</span><span><b>3</b> Gioca</span></div>
          </div>
        </section>
        <footer class="gb3-footer"><span>GAEMBOY 3DS · Basato su Azahar · Non affiliato a Nintendo</span><span><a href="https://github.com/libretro-thumbnails/Nintendo_-_Nintendo_3DS" target="_blank" rel="noopener noreferrer">Copertine: Libretro</a> · <a href="${SOURCE}" target="_blank" rel="noopener noreferrer">Sorgenti GPLv3+</a></span></footer>
        </div>
      </div>
      <input type="file" accept="image/png,image/jpeg,image/webp" id="gb3-cover-input" hidden>
      <div id="gb3-edit-modal" class="gb3-modal" role="dialog" aria-modal="true" aria-label="Modifica gioco" hidden>
        <form id="gb3-edit-form" class="gb3-dialog">
          <h2>Modifica gioco</h2><p id="gb3-edit-context"></p>
          <label>Nome nella libreria<input id="gb3-edit-title" type="text" maxlength="120" required></label>
          <div class="gb3-dialog-row"><button id="gb3-edit-cover" type="button">Cambia copertina</button><button id="gb3-edit-reset" type="button">Copertina automatica</button></div>
          <div class="gb3-dialog-row"><button id="gb3-edit-cancel" type="button">Annulla</button><button type="submit" class="gb3-dialog-save">Salva</button></div>
        </form>
      </div>
    `;
    document.body.append(root);
    root.querySelector('#gb3-select').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-select-empty').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-scan').addEventListener('click',importGames);
    root.querySelector('#gb3-scan-empty').addEventListener('click',importGames);
    root.querySelector('#gb3-single').addEventListener('click',openSingleGame);
    root.querySelector('#gb3-restore-games').addEventListener('click',()=>void restoreRemoved());
    root.querySelector('#gb3-edit-modal').addEventListener('click',ev=>{if(ev.target.id==='gb3-edit-modal')ev.currentTarget.hidden=true;});
    root.querySelector('#gb3-cover-toggle').addEventListener('click',()=>{
      coverOnline=!coverOnline;
      const btn=root.querySelector('#gb3-cover-toggle');btn.textContent='Copertine online · '+(coverOnline?'On':'Off');
      void writeDB(PREF_STORE,'online-covers',coverOnline);
      displayedSnapshot=null;renderCards();
    });
    root.querySelector('#gb3-filter').addEventListener('input',e=>{filter=e.target.value.toLocaleLowerCase('it');displayedSnapshot=null;renderCards();});
    document.addEventListener('change',e=>{
      const input=e.target;
      if(root.contains(input)||input.type!=='file'||!input.files?.length)return;
      const rel=input.files[0].webkitRelativePath||'';
      if(rel.includes('/')){folderName=rel.split('/')[0];chosen=true;void writeDB(PREF_STORE,'folder-name',folderName);scheduleRender();}
    },true);
    const obs=new MutationObserver(records=>{
      if(records.every(r=>root.contains(r.target)))return;
      if(!launchPending) {
        // When the existing player returns to its native library, show our Home
        // instead of dropping the user into the old selection page.
        if(root.hidden && !hasGameView() && isVisible(legacy('#library-list')[0])) restoreHome();
        else scheduleRender();
      } else if(hasGameView()) {launchPending=false;root.hidden=true;}
    });
    obs.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class','style']});
    void readDB(PREF_STORE,'online-covers').then(v=>{
      if(typeof v==='boolean') {coverOnline=v;root.querySelector('#gb3-cover-toggle').textContent='Copertine online · '+(v?'On':'Off');displayedSnapshot=null;renderCards();}
    });
    void readDB(PREF_STORE,'hidden-games').then(v=>{if(Array.isArray(v)) {hiddenGames=new Set(v.filter(x=>typeof x==='string'));displayedSnapshot=null;renderCards();}});
    void readDB(PREF_STORE,'name-overrides').then(v=>{if(v && typeof v==='object' && !Array.isArray(v)){nameOverrides=v;games.forEach(g=>{if(nameOverrides[key(g)])g.title=nameOverrides[key(g)];});displayedSnapshot=null;renderCards();}});
    void getCoverCatalog();
    refresh();setTimeout(refresh,700);setTimeout(refresh,2500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',build,{once:true});else build();
})();
