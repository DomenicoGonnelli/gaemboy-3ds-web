/* GAEMBOY 3DS Home v5.2 — standalone GPL-3.0-or-later frontend adapter.
 * Does not modify the Azahar core or existing gameplay view.
 * Reads the underlying #library-list supplied by the persistent ROM cache catalog.
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
  let sessionFileList = null; // Safari input directory files: kept until page unload (not persisted to disk).
  let folderName = '';
  let chosen = false;
  let didImport = false;
  let selectionPending = false;
  let scanActive = false;
  let scanToken = 0;
  let autoScanTimer = 0;
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
    displayedSnapshot=null;renderCards();gb3SaveSnapshotSoon();setMessage('Nome del gioco aggiornato.','success');
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
    if(!window.confirm('Rimuovere "'+g.title+'" dalla libreria?\nLa ROM in cache verrà rimossa, ma salvataggi, save state e screenshot resteranno disponibili.')) return;
    const manager=window.Gaemboy3DSCacheLibrary;
    if(manager?.enabled) {
      try {
        if(!(await manager.remove(g.path))){setMessage('Non è possibile eliminare una ROM durante il suo utilizzo o la copia.','error');return;}
        openActionKey='';displayedSnapshot=null;refresh();
        setMessage('Gioco rimosso dalla libreria; salvataggi e screenshot conservati.','success');
      } catch(err) {setMessage('Rimozione non riuscita: '+err.message,'error');}
      return;
    }
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
  // Matches the original GamesPage mini-card: swipe LEFT exposes the three
  // icon-only actions on the RIGHT; swipe RIGHT closes them.
  function setActions(g,card,open) {
    root?.querySelectorAll('.mini-card.open').forEach(el=>{
      if(el!==card){el.classList.remove('open');el.querySelector('.mini-card-content')?.style.removeProperty('transform');}
    });
    openActionKey=open?key(g):'';
    card.classList.toggle('open',open);
    card.querySelector('.mini-card-content')?.style.removeProperty('transform');
  }
  function wireSwipe(card,g) {
    const face=card.querySelector('.mini-card-content');
    const WIDTH=138, LOCK=12;
    let gesture=null;
    const end=(ev,cancel=false)=>{
      if(!gesture)return;
      const state=gesture;gesture=null;
      card.classList.remove('swiping');
      if(card.hasPointerCapture?.(ev.pointerId))card.releasePointerCapture(ev.pointerId);
      face.style.removeProperty('transform');
      if(state.horizontal && !cancel){
        const dx=state.x-state.startX;
        // Preserve open state on a light accidental touch; require a clear drag.
        const shouldOpen=state.wasOpen ? dx<6 : dx < -WIDTH/2;
        setActions(g,card,shouldOpen);
      }
      if(state.horizontal){
        card.dataset.swipeBlocked='1';
        setTimeout(()=>{if(card.isConnected)delete card.dataset.swipeBlocked;},210);
      }
    };
    card.addEventListener('pointerdown',ev=>{
      if(!ev.isPrimary || (ev.pointerType==='mouse' && ev.button!==0) || ev.target.closest('.mini-card-actions'))return;
      gesture={id:ev.pointerId,startX:ev.clientX,startY:ev.clientY,x:ev.clientX,y:ev.clientY,
        axis:null,horizontal:false,wasOpen:card.classList.contains('open'),scroller:ev.pointerType==='mouse'?null:root.querySelector('.gb3-scroller')};
    });
    card.addEventListener('pointermove',ev=>{
      if(!gesture || gesture.id!==ev.pointerId)return;
      const s=gesture, previousY=s.y;s.x=ev.clientX;s.y=ev.clientY;
      const dx=s.x-s.startX,dy=s.y-s.startY;
      if(!s.axis){
        if(Math.max(Math.abs(dx),Math.abs(dy))<LOCK)return;
        s.axis=Math.abs(dx)>Math.abs(dy)*2?'horizontal':'vertical';
      } else if(s.axis==='horizontal' && Math.abs(dy)>Math.abs(dx)){
        s.axis='vertical';s.horizontal=false;card.classList.remove('swiping');face.style.removeProperty('transform');
      }
      if(s.axis==='vertical'){
        if(s.scroller) s.scroller.scrollTop+=previousY-s.y;
        return;
      }
      if(!s.horizontal){
        s.horizontal=true;card.classList.add('swiping');
        try{card.setPointerCapture(ev.pointerId);}catch{}
      }
      ev.preventDefault();
      face.style.transform=`translateX(${Math.max(-WIDTH,Math.min(0,(s.wasOpen?-WIDTH:0)+dx))}px)`;
    });
    card.addEventListener('pointerup',ev=>end(ev));
    card.addEventListener('pointercancel',ev=>end(ev,true));
    card.addEventListener('keydown',ev=>{
      if(ev.target!==face)return;
      if(ev.key==='Escape' || ev.key==='ArrowRight'){setActions(g,card,false);ev.preventDefault();}
      if(ev.key==='ArrowLeft'){setActions(g,card,true);ev.preventDefault();}
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
          if (selectionPending) {
            selectionPending=false;
            // Let the native folder handler finish saving its own handle first.
            scheduleAutomaticScan();
          }
        }
        return handle;
      }, err => {
        if (selectionPending) {
          selectionPending=false;
          if (err?.name==='AbortError') setMessage('Selezione annullata. Nessuna modifica alla libreria.');
          else setMessage('Impossibile accedere alla cartella: '+(err?.message||err),'error');
        }
        throw err;
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
    if (!g.element?.isConnected) {setMessage('Per avviare questo gioco conferma la cartella salvata; la copertina rimane visibile senza permessi.');chooseFolder();return;}
    launchPending=true;
    root.hidden=true; // native player reuses in-page folder/file references when its own access is valid
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
    const state=window.Gaemboy3DSCacheLibrary?.status();
    if(!window.Gaemboy3DSCacheLibrary?.enabled)return;
    const used=state?.used||0, limit=state?.limit||3*1024**3;
    const size=n=>n>=1024**3?(n/1024**3).toFixed(2)+' GB':Math.round(n/1024**2)+' MB';
    root.querySelector('#gb3-folder-name').textContent=games.length+' giochi nella tua libreria';
    root.querySelector('#gb3-folder-sub').textContent=state?.supported===false
      ? 'Memoria locale non disponibile: le ROM si potranno comunque aprire.'
      : `Cache locale ${size(used)} / ${size(limit)} · Salvataggi separati`;
    const quotaControl=root.querySelector('#gb3-cache-tier');
    const quotaWrap=root.querySelector('#gb3-cache-settings');
    if (quotaControl && quotaWrap) {
      quotaWrap.hidden=!state?.premium;
      if (state?.premium) {
        quotaControl.value=String(state.selectedGb || 3);
        for(const option of quotaControl.options) option.disabled=Number(option.value)>state.maxGb;
      }
    }
    root.querySelector('#gb3-select').textContent='+ Aggiungi gioco';
    root.querySelector('#gb3-scan').hidden=true;
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
    // DOM structure/classes are the same as GAEMBOY's GamesPage mini-card.
    const card=document.createElement('article');card.className='mini-card';card.dataset.gameKey=key(g);
    if(openActionKey===key(g))card.classList.add('open');
    const actions=document.createElement('div');actions.className='mini-card-actions';
    const specs=[
      ['edit','Modifica','moreUserProfile.png',()=>editGame(g)],
      ['share','Condividi','shareAppUserProfile.png',()=>void shareGame(g)],
      ['delete','Elimina','deleteTeamUserProfile.png',()=>void removeFromLibrary(g)]
    ];
    for(const [cl,label,png,action] of specs){
      const btn=document.createElement('button');btn.type='button';btn.className='row-action '+cl;
      btn.title=label;btn.setAttribute('aria-label',label+' '+g.title);
      const ico=document.createElement('span');ico.className='row-action-icon';
      const img=document.createElement('img');img.alt='';img.src='home-v5-assets/icons/'+png;ico.append(img);btn.append(ico);
      btn.addEventListener('click',ev=>{ev.stopPropagation();setActions(g,card,false);action();});
      actions.append(btn);
    }
    const face=document.createElement('div');face.className='mini-card-content';
    face.tabIndex=0;face.setAttribute('role','button');face.setAttribute('aria-label','Gioca a '+g.title);
    const fill=document.createElement('div');fill.className='mini-fill';
    const wash=document.createElement('div');wash.className='mini-wash';
    const veil=document.createElement('div');veil.className='mini-veil';
    const art=document.createElement('div');art.className='mini-art';
    const fallback=generatedCover(g);
    const image=document.createElement('img');image.loading='lazy';image.alt='';image.hidden=true;
    const src=blobUrls.get(key(g)) || artworks.get(key(g)) || matchCover(g) || g.img;
    if(src){
      if(src.startsWith('https://'))image.crossOrigin='anonymous';
      image.src=src;image.hidden=false;
      // Apply the same artwork as a blurred background layer, as in GamesPage.
      wash.style.backgroundImage=`url("${src.replaceAll('"','%22')}")`;
      image.onerror=()=>{
        if(g.img && image.src!==g.img && image.src.startsWith('https://')){
          image.crossOrigin=null;image.src=g.img;wash.style.removeProperty('background-image');return;
        }
        image.hidden=true;fallback.hidden=false;art.classList.add('mini-art--fallback');wash.style.removeProperty('background-image');
      };
      fallback.hidden=true;
    } else art.classList.add('mini-art--fallback');
    art.append(fallback,image);
    const info=document.createElement('div');info.className='mini-info';
    const title=document.createElement('span');title.className='mini-name';title.title=g.title;title.textContent=g.title;
    info.append(title);
    if(g.element?.closest('li')?.dataset.cached==='false'){
      const hint=document.createElement('small');hint.className='gb3-cache-hint';hint.textContent='Da reimportare';info.append(hint);
    }
    face.append(fill,wash,veil,art,info);
    face.addEventListener('click',ev=>{
      if(card.dataset.swipeBlocked==='1'){ev.preventDefault();return;}
      if(card.classList.contains('open')){setActions(g,card,false);return;}
      launch(g);
    });
    face.addEventListener('keydown',ev=>{
      if(ev.key==='Enter' || ev.key===' '){ev.preventDefault();if(card.classList.contains('open'))setActions(g,card,false);else launch(g);}
    });
    card.append(actions,face);wireSwipe(card,g);
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
    let blob=await readDB(IMAGE_STORE,k); // user-selected artwork has priority
    if(!(blob instanceof Blob))blob=await readDB(IMAGE_STORE,GB3_COVER_PREFIX+k);
    if(blob instanceof Blob) {
      const url=URL.createObjectURL(blob);blobUrls.set(k,url);artworks.set(k,url);
      displayedSnapshot=null;renderCards();
    }
  }

  function renderCards() {
    if(!root || root.hidden)return;
    const visibleGames=games.filter(g=>!hiddenGames.has(key(g)));
    const found=visibleGames.filter(g=>g.title.toLocaleLowerCase('it').includes(filter));
    const sig=found.map(g=>key(g)+'|'+g.title+'|'+(blobUrls.get(key(g))||artworks.get(key(g))||matchCover(g)||g.img)+'|'+g.element?.closest('li')?.dataset.cached+'|'+openActionKey).join('\n')+'|hidden:'+hiddenGames.size;
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
    root.querySelector('#gb3-empty-title').textContent=scanActive?'Ricerca dei giochi in corso…':visibleGames.length===0&&hiddenGames.size>0?'Nessun gioco visibile':didImport?'Nessuna ROM 3DS valida nella cartella':'Nessun gioco importato';
    for(const g of visibleGames) void loadArtwork(g);
  }
  function refresh() {
    if(!root || launchPending)return;
    const native=readGames();
    if(window.Gaemboy3DSCacheLibrary?.enabled || native.length){
      const next=gb3MergeNativeGames(native);
      const nextKey=next.map(g=>key(g)+'|'+g.title+'|'+g.element?.closest('li')?.dataset.cached).join('\n');
      const oldKey=games.map(g=>key(g)+'|'+g.title+'|'+g.element?.closest('li')?.dataset.cached).join('\n');
      if(nextKey!==oldKey||games.some(g=>!g.element?.isConnected)){
        games=next;displayedSnapshot=null;gb3SaveSnapshotSoon();
      }
    }
    // A missing FileList is not an empty game collection: retain last known metadata.
    if(games.length)chosen=true;
    renderFolder();renderCards();
  }

  function scheduleRender() { clearTimeout(rebuildTimer);rebuildTimer=setTimeout(refresh,130); }
  function scheduleAutomaticScan() {
    clearTimeout(autoScanTimer);
    setMessage('Cartella confermata. Sto cercando i giochi 3DS…');
    // Avoid scanning synchronously before the original app stores the new handle.
    autoScanTimer=setTimeout(() => importGames(true), 350);
  }
  function chooseFolder() {
    // The native file input retains the user gesture. No folder permission is requested.
    openSingleGame();
  }
  function openSingleGame() {
    const btn=document.querySelector('#pick') || originalButton(/^apri\s+rom/i);
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
  function importGames(fromPicker=false) {
    if(scanActive) return;
    const btn=originalButton(/^aggiorna(?:\s|$)|^scansiona(?:\s|$)/i);
    if(!btn){setMessage('Scansione non disponibile: il selettore originale non espone il comando Aggiorna.','error');return;}
    if (btn.disabled) {
      // The native app is scanning already. Wait and refresh the visible library.
      setMessage('Sto cercando giochi 3DS nella cartella…');
      setTimeout(()=>{refresh();setMessage(games.length?`${games.length} giochi disponibili nella libreria.`:'Controlla la cartella o riprova Aggiorna libreria.');},2000);
      return;
    }
    didImport=true;scanActive=true;scanToken++;
    const token=scanToken;
    const before=readGames().map(g=>key(g)).join('\n');
    setMessage('Sto cercando giochi 3DS nella cartella…');
    displayedSnapshot=null;renderCards();renderFolder();
    try {btn.click();}catch(e){scanActive=false;renderFolder();setMessage('Errore durante la scansione: '+e.message,'error');return;}
    const start=Date.now();
    const check=()=>{
      if(token!==scanToken || !root) return;
      refresh();
      const current=readGames().map(g=>key(g)).join('\n');
      const elapsed=Date.now()-start;
      if(games.length && (!fromPicker || current!==before || elapsed>=1500)) {
        scanActive=false;displayedSnapshot=null;renderCards();renderFolder();
        setMessage(`${games.length} ${games.length===1?'gioco disponibile':'giochi disponibili'} nella libreria.`,'success');
      } else if(elapsed>=10000) {
        scanActive=false;displayedSnapshot=null;renderCards();renderFolder();
        setMessage(games.length?`${games.length} giochi disponibili nella libreria.`:'Nessuna ROM 3DS valida è presente nella cartella.');
      } else setTimeout(check,500);
    };
    setTimeout(check,500);
  }
  function build() {
    root=document.createElement('main');root.id='gb3-home';root.setAttribute('aria-label','Libreria Gaemboy 3DS');
    root.innerHTML=`
      <div class="gb3-wallpaper" aria-hidden="true"></div>
      <div class="gb3-shell">
        <header class="gb3-header"><div class="gb3-brand"><img src="home-v5-assets/logo.png" alt="" width="48" height="48"><div class="gb3-brand-name"><strong>GAEMBOY</strong><span>3DS LIBRARY</span></div></div><span class="gb3-header-note">La tua console, i tuoi giochi</span></header>
        <div class="gb3-scroller" id="gb3-scroller">
        <section class="gb3-config" aria-label="Gestione libreria">
          <div class="gb3-config-copy"><div class="gb3-config-icon">${icons.folder}</div><div><div class="gb3-eyebrow">LIBRERIA LOCALE</div><strong id="gb3-folder-name">Nessun gioco importato</strong><p id="gb3-folder-sub">ROM salvate automaticamente, senza caricarle online</p></div></div>
          <div class="gb3-config-buttons"><label id="gb3-cache-settings" class="gb3-cache-settings" hidden>Cache Premium <select id="gb3-cache-tier" aria-label="Spazio cache Premium"><option value="3">3 GB</option><option value="5">5 GB</option><option value="8">8 GB</option></select></label><button id="gb3-restore-games" type="button" class="gb3-button gb3-button-soft" hidden>Ripristina rimossi</button><button id="gb3-select" type="button" class="gb3-button gb3-button-main">+ Aggiungi gioco</button><button id="gb3-scan" type="button" class="gb3-button gb3-button-soft" hidden>${icons.refresh} Aggiorna libreria</button></div>
        </section>
        <div id="gb3-status" class="gb3-status" role="status" aria-live="polite" hidden></div>
        <section class="gb3-content" aria-label="Giochi Nintendo 3DS">
          <div class="gb3-titlebar"><div><div class="gb3-eyebrow">LA TUA COLLEZIONE</div><h1>La tua libreria <span id="gb3-count">0</span></h1><p>Le tue ROM e i salvataggi rimangono sul dispositivo.</p></div><div class="gb3-tools"><button id="gb3-cover-toggle" class="gb3-cover-toggle" type="button" aria-pressed="true" hidden>Copertine online · On</button><label class="gb3-search" id="gb3-search" hidden>${icons.search}<input type="search" id="gb3-filter" placeholder="Cerca un gioco…" autocomplete="off" aria-label="Cerca un gioco"></label></div></div>
          <div class="gb3-grid" id="gb3-grid" hidden></div>
          <div class="gb3-nomatch" id="gb3-nomatch" hidden>Nessun gioco corrisponde alla ricerca.</div>
          <div class="gb3-empty" id="gb3-empty">
            <div class="gb3-empty-icon">${icons.folder}</div><h2 id="gb3-empty-title">Nessun gioco importato</h2>
            <p>Aggiungi una ROM per iniziare: Gaemboy la conserva automaticamente finché c’è spazio. I salvataggi rimangono anche se una ROM viene rimossa dalla cache.</p>
            <div class="gb3-empty-cta"><button id="gb3-select-empty" type="button" class="gb3-button gb3-button-main">${icons.folder} + Aggiungi gioco</button></div>
            <button class="gb3-single" id="gb3-single" type="button" hidden>Aggiungi un altro gioco</button>
            <div class="gb3-steps"><span><b>1</b> Aggiungi la tua ROM</span><span><b>2</b> Gioca, Gaemboy salva una copia locale</span></div>
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
    root.querySelector('#gb3-cache-tier').addEventListener('change', e => {
      const ok=window.Gaemboy3DSCacheLibrary?.chooseCacheGb(Number(e.target.value));
      if(!ok)setMessage('La cache da 5 o 8 GB richiede Gaemboy Premium.', 'info');
      renderFolder();
    });
    root.querySelector('#gb3-select').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-select-empty').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-scan').addEventListener('click',()=>importGames(false));
    root.querySelector('#gb3-single').addEventListener('click',openSingleGame);
    window.addEventListener('gaemboy3ds:library-updated',scheduleRender);
    window.addEventListener('gaemboy3ds:cache-usage',scheduleRender);
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
      if(rel.includes('/')) {
        sessionFileList=input.files; // FileList stays available to the original player while this page is alive.
        folderName=rel.split('/')[0];chosen=true;
        void writeDB(PREF_STORE,'folder-name',folderName);scheduleRender();
        if (selectionPending) {selectionPending=false;scheduleAutomaticScan();}
      }
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
    // On a deferred script, readyState is often 'interactive'. Build runs
    // before the hash bridge below wraps getCoverCatalog(). Defer this
    // call one microtask so the wrapper and Title ID index initialize.
    queueMicrotask(() => void getCoverCatalog());
    void gb3RestoreSnapshot();
    refresh();setTimeout(refresh,700);setTimeout(refresh,2500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',build,{once:true});else queueMicrotask(build);

  // GB3_HASH_V533_BRIDGE -- stable integration via function wrappers, no fragile HTML anchors.
  const gb3ExactCovers = new Map();
  const gb3HashStatus = new Map();
  let gb3HashCatalog = null;
  let gb3HashReady = false;

  // GB3_SNAPSHOT_V540 -- Persistent LIBRARY METADATA, not ROMs or permissions.
  // Safari can show remembered games/covers even with no FileList after reload.
  const GB3_LIBRARY_PREF='gb3-library-snapshot-v540';
  const GB3_COVER_PREFIX='gb3-verified-cover:';
  const gb3KnownGames=new Map();
  const gb3CoverDownloads=new Set();
  let gb3SnapshotTimer=0;
  let gb3Restored=false;
  function gb3SerializableGame(g){
    const id=key(g),verified=gb3ExactCovers.get(id)||g.verifiedCover||'';
    return {
      title:String(g.title||'').slice(0,120),
      nativeTitle:String(g.nativeTitle||'').slice(0,120),
      fileName:String(g.fileName||'').slice(0,300),
      path:String(g.path||g.fileName||'').slice(0,1000),
      ext:String(g.ext||'3DS').slice(0,8),
      verifiedCover:/^https:\/\/raw\.githubusercontent\.com\/libretro-thumbnails\//.test(verified)?verified:''
    };
  }
  function gb3SaveSnapshotSoon(){
    if(!gb3Restored || !games.length)return; // Never destroy the remembered library on a temporary 0-file scan.
    clearTimeout(gb3SnapshotTimer);
    gb3SnapshotTimer=setTimeout(async()=>{
      const all=games.filter(g=>VALID_EXT.test(String(g.fileName||''))).map(g=>gb3SerializableGame(g));
      if(!all.length)return;
      for(const g of all) gb3KnownGames.set(key(g),g);
      await writeDB(PREF_STORE,GB3_LIBRARY_PREF,{schema:1,folderName:folderName||'',games:all,savedAt:Date.now()});
    },250);
  }
  async function gb3RestoreSnapshot(){
    const saved=await readDB(PREF_STORE,GB3_LIBRARY_PREF);
    gb3Restored=true;
    if(!saved||saved.schema!==1||!Array.isArray(saved.games)){gb3SaveSnapshotSoon();return;}
    const entries=saved.games.filter(x=>x&&typeof x.fileName==='string'&&VALID_EXT.test(x.fileName)).slice(0,2000);
    for(const x of entries){
      const g={title:String(x.title||x.fileName),nativeTitle:String(x.nativeTitle||x.title||''),
        fileName:x.fileName,path:String(x.path||x.fileName),ext:String(x.ext||'3DS'),
        verifiedCover:typeof x.verifiedCover==='string'?x.verifiedCover:'',img:'',element:null};
      const k=key(g);gb3KnownGames.set(k,g);
      if(g.verifiedCover)gb3ExactCovers.set(k,g.verifiedCover);
    }
    if(!folderName&&typeof saved.folderName==='string')folderName=saved.folderName;
    const native=readGames();
    if(!native.length&&!games.length && !window.Gaemboy3DSCacheLibrary?.enabled){games=[...gb3KnownGames.values()];}
    else if(native.length){games=native.map(g=>{
      const old=gb3KnownGames.get(key(g));
      return old?{...g,verifiedCover:old.verifiedCover||''}:g;
    });}
    if(games.length)chosen=true;
    displayedSnapshot=null;renderFolder();renderCards();
    gb3SaveSnapshotSoon();
    console.info('[GAEMBOY 3DS] Restored library metadata from IndexedDB:',entries.length,'games; ROM files NOT copied.');
  }
  async function gb3CacheVerifiedCover(g,url){
    const k=key(g);
    if(!url||!/^https:\/\/raw\.githubusercontent\.com\/libretro-thumbnails\//.test(url)||gb3CoverDownloads.has(k))return;
    gb3CoverDownloads.add(k);
    try {
      const previous=await readDB(PREF_STORE,GB3_COVER_PREFIX+k);
      if(previous===url)return;
      const response=await fetch(url,{mode:'cors',credentials:'omit'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const blob=await response.blob();
      if(!blob.type.startsWith('image/')||blob.size>3*1024*1024)throw new Error('Invalid/large image');
      await writeDB(IMAGE_STORE,GB3_COVER_PREFIX+k,blob);
      await writeDB(PREF_STORE,GB3_COVER_PREFIX+k,url);
      console.info('[GAEMBOY 3DS] Cached verified cover in browser:',g.fileName);
    } catch(err) {
      // If a CDN blocks CORS, the verified remote URL still persists in metadata.
      console.info('[GAEMBOY 3DS] Cover URL saved; local image cache not available:',err?.message||err);
    } finally {gb3CoverDownloads.delete(k);}
  }
  function gb3MergeNativeGames(next){
    return next.map(g=>{
      const saved=gb3KnownGames.get(key(g));
      if(saved?.verifiedCover){
        if(!gb3ExactCovers.has(key(g)))gb3ExactCovers.set(key(g),saved.verifiedCover);
        return {...g,verifiedCover:saved.verifiedCover};
      }
      return g;
    });
  }
  // Debug only exposes file names/cover URLs; no ROM data.
  window.Gaemboy3DSLibraryCache={status:()=>({
    visibleGames:games.length,cachedMetadata:gb3KnownGames.size,
    verifiedCovers:gb3ExactCovers.size,folderPermissionAvailable:Boolean(lastHandle),
    note:'Le copertine e i titoli sono persistenti; i permessi per leggere/avviare le ROM sono separati.'
  })};


  // GB3_SESSION_V537 -- keep native directory selection files alive on Safari.
  // Copies only File object references, not the underlying ROM data. A browser
  // reload clears this in-memory list: Safari requires user selection again.
  const gb3PickedFiles=[];
  const gb3GameFilePattern=/\.(?:3ds|3dsx|cci|cxi|app|elf)$/i;
  function gb3Path(p){return String(p||'').replace(/\\/g,'/').replace(/^\.\//,'').toLowerCase();}
  // GB3_FILE_ASSOC_V539: resolve the File selected in Safari against the
  // game's library metadata. Some native library rows use a display/legacy
  // filename that differs from File.name. Never guess if >1 file/game exists.
  let gb3FileAssociationReport={result:'not checked'};
  const gb3NormalizedFilePath=value=>{
    let raw=String(value||'').trim().replace(/\\/g,'/');
    try {raw=decodeURIComponent(raw);}catch(_){}
    return raw.normalize('NFC').toLocaleLowerCase('it')
      .replace(/\/+/g,'/').replace(/^\.\//,'');
  };
  function gb3PickedCandidateFiles(){
    const files=[...gb3PickedFiles];
    if(sessionFileList?.length)files.push(...Array.from(sessionFileList));
    for(const input of document.querySelectorAll('input[type="file"]')){
      if(root?.contains(input))continue;
      if(input.files?.length)files.push(...Array.from(input.files));
    }
    // Avoid counting one File twice when the browser emits change and input.
    const unique=[];const references=new Set();const identities=new Set();
    for(const file of files){
      if(!file || !gb3GameFilePattern.test(String(file.name||'')))continue;
      if(references.has(file))continue;
      references.add(file);
      // Safari may produce two File objects representing the same picker item.
      // Distinguish same-named files in different subdirectories using the path.
      const fingerprint=[gb3NormalizedFilePath(file.webkitRelativePath||file.name),
        file.size,file.lastModified].join('|');
      if(identities.has(fingerprint))continue;
      identities.add(fingerprint);unique.push(file);
    }
    return unique;
  }
  function gb3FindPickedGame(g){
    const files=gb3PickedCandidateFiles();
    const wanted=gb3NormalizedFilePath(g.path||g.fileName||'');
    const basename=gb3NormalizedFilePath(g.fileName||wanted.split('/').pop()).split('/').pop();
    const possiblePaths=file=>{
      const rel=gb3NormalizedFilePath(file.webkitRelativePath||'');
      const name=gb3NormalizedFilePath(file.name||'');
      return [rel,name].filter(Boolean);
    };
    let exact=files.filter(file=>possiblePaths(file).some(path=>
      wanted && (path===wanted||path.endsWith('/'+wanted))));
    if(exact.length===1){
      gb3FileAssociationReport={result:'path match',game:g.fileName,file:exact[0].name};
      return exact[0];
    }
    if(exact.length>1){
      gb3FileAssociationReport={result:'ambiguous full path',game:g.fileName,candidates:exact.length};
      return null;
    }
    exact=files.filter(file=>gb3NormalizedFilePath(file.name).split('/').pop()===basename);
    if(exact.length===1){
      gb3FileAssociationReport={result:'filename match',game:g.fileName,file:exact[0].name};
      return exact[0];
    }
    if(exact.length>1){
      gb3FileAssociationReport={result:'ambiguous filename',game:g.fileName,candidates:exact.length};
      return null;
    }
    // A Safari directory picker can return a single File while the native
    // library exposes a different name (old metadata or renamed file). Only
    // reconcile 1:1; with two or more games/files we never infer a pairing.
    const catalogGames=games.filter(item=>gb3GameFilePattern.test(String(item.fileName||'')));
    if(files.length===1 && catalogGames.length===1 &&
        key(catalogGames[0])===key(g) && !scanActive){
      const file=files[0];
      gb3FileAssociationReport={result:'unique 1:1 fallback',game:g.fileName,file:file.name};
      console.info('[GAEMBOY 3DS] Using unique single-file library mapping for cover identification:',
        g.fileName,'->',file.name);
      return file;
    }
    gb3FileAssociationReport={result:'no safe match',game:g.fileName,
      candidates:files.map(f=>f.name),libraryGames:catalogGames.map(item=>item.fileName)};
    return null;
  }
  function gb3CaptureNativeFiles(event){
    const input=event.target;
    if(!input||input.tagName!=='INPUT'||input.type!=='file'||root?.contains(input))return;
    const files=Array.from(input.files||[]);
    if(!files.some(f=>gb3GameFilePattern.test(f.name)))return;
    const selected=files.filter(f=>gb3GameFilePattern.test(f.name));
    const directory=Boolean(input.webkitdirectory||input.hasAttribute('webkitdirectory')||
      files.some(f=>String(f.webkitRelativePath||'').includes('/')));
    if(directory)gb3PickedFiles.length=0; // a new directory replaces the old one
    for(const file of selected){
      const path=gb3Path(file.webkitRelativePath||file.name);
      if(!gb3PickedFiles.some(f=>gb3Path(f.webkitRelativePath||f.name)===path)) gb3PickedFiles.push(file);
    }
    gb3HashStatus.clear(); // previous 'no file' errors must be retried
    console.info('[GAEMBOY 3DS] Local files available for cover identification:',gb3PickedFiles.length);
    setTimeout(()=>{if(gb3HashReady)gb3IdentifyVisibleGames();},350);
    setTimeout(()=>{if(gb3HashReady)gb3IdentifyVisibleGames();},1800);
  }
  document.addEventListener('change',gb3CaptureNativeFiles,true);
  // Some pickers trigger input before change; harmless if both fire.
  document.addEventListener('input',gb3CaptureNativeFiles,true);

  // GB3_DETACHED_PICKER_V538: native Safari folder picker may use a detached input.
  // Such a change event never bubbles to document: listen on the input itself.
  const gb3ObservedPickers=new WeakSet();
  function gb3ObserveFilePicker(input){
    if(!input || input.type!=='file' || root?.contains(input) || gb3ObservedPickers.has(input))return;
    gb3ObservedPickers.add(input);
    input.addEventListener('change',gb3CaptureNativeFiles,true);
    input.addEventListener('input',gb3CaptureNativeFiles,true);
  }
  const gb3OriginalFileClick=HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click=function(...args){
    gb3ObserveFilePicker(this);
    return Reflect.apply(gb3OriginalFileClick,this,args);
  };
  const gb3OriginalShowPicker=HTMLInputElement.prototype.showPicker;
  if(typeof gb3OriginalShowPicker==='function'){
    HTMLInputElement.prototype.showPicker=function(...args){
      gb3ObserveFilePicker(this);
      return Reflect.apply(gb3OriginalShowPicker,this,args);
    };
  }
  // Also support long-lived attached inputs activated through an HTML label.
  for(const input of document.querySelectorAll('input[type="file"]')) gb3ObserveFilePicker(input);

  window.Gaemboy3DSCoverAccess={status:()=>({
    sessionFiles:gb3PickedFiles.length,
    directoryHandleAvailable:Boolean(lastHandle),
    coverCatalogReady:gb3HashReady,
    matchedCovers:gb3ExactCovers.size
  })};

  // On-device only: optional diagnostic for matching a saved game to a File.
  window.Gaemboy3DSCoverAccess.debug=()=>({
    ...window.Gaemboy3DSCoverAccess.status(),
    library:games.map(g=>({name:g.fileName,path:g.path})),
    selectedFiles:gb3PickedCandidateFiles().map(f=>({
      name:f.name,relativePath:f.webkitRelativePath||'',size:f.size
    })),
    lastAssociation:gb3FileAssociationReport
  });

  async function gb3ReadGameFile(g) {
    if(window.Gaemboy3DSCacheLibrary?.enabled) {
      try {return await window.Gaemboy3DSCacheLibrary.fileForCover(g.path);} catch(_) {return null;}
    }
    const wanted = String(g.path || g.fileName || '').replace(/\\/g, '/');
    const name = String(g.fileName || wanted.split('/').pop() || '').split('/').pop();
    if (!name) return null;
    const picked=gb3FindPickedGame(g);
    if(picked)return picked;
    if (sessionFileList?.length) {
      const found = Array.from(sessionFileList).find(file => {
        const rel = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
        return rel === wanted || rel === name || rel.endsWith('/' + wanted) || rel.endsWith('/' + name);
      });
      if (found) return found;
    }
    if (!lastHandle || lastHandle.kind !== 'directory') return null;
    try {
      // Never prompt for filesystem permission during background cover identification.
      if (typeof lastHandle.queryPermission === 'function' &&
          await lastHandle.queryPermission({mode: 'read'}) !== 'granted') return null;
      const parts = wanted.split('/').filter(Boolean);
      if (parts[0] === lastHandle.name) parts.shift();
      const lookup = async path => {
        if (!path.length) return null;
        let dir = lastHandle;
        for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return (await dir.getFileHandle(path[path.length - 1])).getFile();
      };
      try { const file = await lookup(parts); if (file) return file; } catch (_) {}
      try { const file = await lookup([name]); if (file) return file; } catch (_) {}
      // The legacy list sometimes exposes filenames only. Bounded local search.
      const stack = [{dir: lastHandle, depth: 0}];
      let visited = 0;
      while (stack.length && visited < 2500) {
        const {dir, depth} = stack.pop();
        for await (const [entryName, entry] of dir.entries()) {
          if (++visited > 2500) break;
          if (entry.kind === 'file' && entryName === name) return entry.getFile();
          if (entry.kind === 'directory' && depth < 7) stack.push({dir: entry, depth: depth + 1});
        }
      }
    } catch (e) {
      console.info('[GAEMBOY 3DS] Cover lookup waiting for folder permission:', e?.message || e);
    }
    return null;
  }

  const gb3HashRetries=new Set();
  // GB3_HASH_V535: metadata first, SHA-1 only when internal 3DS ID is unknown.
  async function gb3IdentifyCover(g) {
    const k=key(g), engine=window.Gaemboy3DSRomIdentity;
    if(!engine||!gb3HashCatalog||!coverOnline)return;
    const previous=gb3HashStatus.get(k);
    if(previous==='running'||previous==='done'||
       (typeof previous==='number'&&Date.now()-previous<5000))return;
    gb3HashStatus.set(k,'running');
    try {
      const file=await gb3ReadGameFile(g);
      if(!file){
        gb3HashStatus.set(k,Date.now());
        if(!gb3HashRetries.has(k)){
          gb3HashRetries.add(k);
          setTimeout(()=>{if(root&&!root.hidden)void gb3IdentifyCover(g);},5500);
        }
        console.info('[GAEMBOY 3DS] Cannot inspect '+g.fileName+': no readable folder reference. Select/confirm folder once.');
        return;
      }
      const cacheKey='rom-identity-v535-'+k;
      let identity=await readDB(PREF_STORE,cacheKey);
      if(!identity||identity.size!==file.size||identity.lastModified!==file.lastModified||identity.folder!==folderName){
        const header=await engine.quickIdentity(file);
        identity={...header,size:file.size,lastModified:file.lastModified,folder:folderName};
        let matched=engine.findEntry(gb3HashCatalog,identity);
        if(!matched){
          // Decrypted/modified ROMs may not match No-Intro SHA-1; only hash if
          // both internal Title ID and product code were unrecognized.
          const full=await engine.fileIdentity(file);
          identity={...identity,sha1:full.sha1,serial:full.serial||identity.serial,
            titleId:full.titleId||identity.titleId};
        }
        await writeDB(PREF_STORE,cacheKey,identity);
      }
      const hit=engine.findEntry(gb3HashCatalog,identity);
      const cover=hit&&engine.matchCover(hit.entry,coverNames,navigator.language||'it');
      if(cover&&gb3ExactCovers.get(k)!==cover){
        gb3ExactCovers.set(k,cover);
        g.verifiedCover=cover;
        gb3KnownGames.set(k,gb3SerializableGame(g));
        gb3SaveSnapshotSoon();
        void gb3CacheVerifiedCover(g,cover);
        displayedSnapshot=null;renderCards();
      }
      if(hit){
        console.info('[GAEMBOY 3DS] Cover match ('+hit.method+') for '+g.fileName+': '+hit.entry.name+' - '+(cover?'found':'Libretro artwork unavailable'));
      } else {
        console.info('[GAEMBOY 3DS] Unknown ROM identity (no verified Title ID/product code/SHA-1) for '+g.fileName,
          {titleId:identity.titleId||'',serial:identity.serial||''});
      }
      gb3HashStatus.set(k,'done');
    } catch(e){
      gb3HashStatus.set(k,Date.now());
      console.warn('[GAEMBOY 3DS] Cover detection failed:',e);
    }
  }

  function gb3IdentifyVisibleGames() {
    if (!gb3HashReady || !coverOnline || !root || root.hidden) return;
    for (const game of games) {
      if (!hiddenGames.has(key(game)) && (game.element?.isConnected || lastHandle || gb3PickedCandidateFiles().length)) void gb3IdentifyCover(game);
    }
  }

  // Only a verified SHA-1 / serial match may supply an automatic online cover.
  // User-selected artwork is preserved by the existing Home implementation.
  matchCover = function(g) {
    return coverOnline ? (gb3ExactCovers.get(key(g)) || '') : '';
  };
  const gb3OriginalMakeCard = makeCard;
  makeCard = function(g) {
    // Suppress the legacy, filename-derived image and its automatic fallback
    // without changing the existing card layout, swipe menu or click handler.
    return gb3OriginalMakeCard({...g, img: ''});
  };
  const gb3OriginalRenderCards = renderCards;
  renderCards = function(...args) {
    const result = gb3OriginalRenderCards.apply(this, args);
    if (gb3HashReady && root && !root.hidden) queueMicrotask(gb3IdentifyVisibleGames);
    return result;
  };
  const gb3OriginalCoverCatalog = getCoverCatalog;
  getCoverCatalog = async function(...args) {
    await gb3OriginalCoverCatalog.apply(this, args);
    const engine = window.Gaemboy3DSRomIdentity;
    if (!engine) {console.warn('[GAEMBOY 3DS] Cover engine script unavailable'); return;}
    gb3HashCatalog = await engine.loadIndex();
    gb3HashReady = Boolean(gb3HashCatalog);
    displayedSnapshot = null;
    renderCards();
    gb3IdentifyVisibleGames();
  };

})();
