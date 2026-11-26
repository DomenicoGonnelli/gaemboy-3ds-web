/* GAEMBOY 3DS Home v3 — standalone GPL-3.0-or-later frontend adapter.
 * Does not modify the Azahar core or existing gameplay view.
 * Requires the underlying app's #library-list, original folder and refresh controls.
 */
(() => {
  'use strict';
  if (window.__gaemboyHomeV3) return;
  window.__gaemboyHomeV3 = true;

  const PREFIX = 'gb3';
  const SOURCE = 'https://github.com/DomenicoGonnelli/gaemboy-3ds-web';
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
    return {title:maybeTitle(metadataName)||title,fileName,path,ext:(fileName.match(VALID_EXT)||['3DS'])[1].toUpperCase(),element:play,img:imageUrl(img?.getAttribute('src'))};
  }
  function readGames() {
    const arr=[];
    const ids=new Set();
    for(const row of nativeList()) {
      const item=parseGameRow(row);if(!item)continue;
      const id=key(item);if(ids.has(id))continue;ids.add(id);arr.push(item);
    }
    return arr;
  }
  function hasGameView() {
    const known=['#game-view','#gameView','#view-game','#play-view','#emulation-view','#game-screen','#gameScreen'];
    for(const sel of known){const el=document.querySelector(sel);if(el && isVisible(el))return true;}
    const headings=legacy('h1,h2,h3').filter(el=>/^gioco$/i.test(textOf(el)));
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
  function makeCard(g) {
    const card=document.createElement('article');card.className='gb3-card';
    const cover=document.createElement('button');cover.className='gb3-cover';cover.type='button';cover.setAttribute('aria-label','Gioca a '+g.title);
    const wash=document.createElement('div');wash.className='gb3-cover-wash';cover.append(wash);
    const fallback=document.createElement('div');fallback.className='gb3-cover-fallback';fallback.textContent=getDecorativeTitle(g.title);
    const image=document.createElement('img');image.loading='lazy';image.alt='';image.hidden=true;
    const src=blobUrls.get(key(g)) || artworks.get(key(g)) || g.img;
    if(src){ image.src=src; image.hidden=false;image.onerror=()=>{image.hidden=true;fallback.hidden=false;};fallback.hidden=true; }
    cover.append(fallback,image);
    const platform=document.createElement('span');platform.className='gb3-platform';platform.textContent='NINTENDO 3DS';cover.append(platform);
    const caption=document.createElement('div');caption.className='gb3-card-label';
    const title=document.createElement('div');title.className='gb3-card-title';title.title=g.title;title.textContent=g.title;
    const bottom=document.createElement('div');bottom.className='gb3-card-bottom';
    const format=document.createElement('span');format.textContent=g.ext;
    const play=document.createElement('span');play.className='gb3-play';play.textContent='Gioca';play.insertAdjacentHTML('beforeend',icons.play);
    bottom.append(format,play);caption.append(title,bottom);
    const customize=document.createElement('button');customize.type='button';customize.className='gb3-change-cover';customize.title='Imposta una copertina dal dispositivo';customize.setAttribute('aria-label','Imposta copertina per '+g.title);customize.innerHTML=icons.photo;
    customize.addEventListener('click',ev=>{ev.stopPropagation();const picker=root.querySelector('#gb3-cover-input');picker.value='';picker.onchange=()=>{const file=picker.files?.[0];if(file)void installArtwork(g,file);};picker.click();});
    cover.addEventListener('click',()=>launch(g));
    card.append(cover,customize,caption);
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
    const found=games.filter(g=>g.title.toLocaleLowerCase('it').includes(filter));
    const sig=found.map(g=>key(g)+'|'+g.title+'|'+(blobUrls.get(key(g))||g.img)).join('\n');
    if(sig===displayedSnapshot)return;
    displayedSnapshot=sig;
    const grid=root.querySelector('#gb3-grid');
    grid.replaceChildren(...found.map(makeCard));
    const count=root.querySelector('#gb3-count');count.textContent=String(games.length);
    root.querySelector('#gb3-empty').hidden=games.length>0;
    grid.hidden=found.length===0;
    root.querySelector('#gb3-nomatch').hidden=!(games.length>0 && found.length===0);
    root.querySelector('#gb3-search').hidden=games.length===0;
    root.querySelector('#gb3-empty-title').textContent=didImport?'Nessuna ROM 3DS valida nella cartella':'Nessun gioco importato';
    for(const g of games) void loadArtwork(g);
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
        <header class="gb3-header"><div class="gb3-brand"><img src="home-v3-assets/logo.png" alt="" width="48" height="48"><div class="gb3-brand-name"><strong>GAEMBOY</strong><span>3DS LIBRARY</span></div></div><span class="gb3-header-note">La tua console, i tuoi giochi</span></header>
        <section class="gb3-config" aria-label="Configurazione cartella">
          <div class="gb3-config-copy"><div class="gb3-config-icon">${icons.folder}</div><div><div class="gb3-eyebrow">CARTELLA GIOCHI</div><strong id="gb3-folder-name">Nessuna cartella selezionata</strong><p id="gb3-folder-sub">Seleziona una cartella contenente giochi 3DS</p></div></div>
          <div class="gb3-config-buttons"><button id="gb3-select" type="button" class="gb3-button gb3-button-soft">Scegli cartella</button><button id="gb3-scan" type="button" class="gb3-button gb3-button-main">${icons.refresh} Importa ROM</button></div>
        </section>
        <div id="gb3-status" class="gb3-status" role="status" aria-live="polite" hidden></div>
        <section class="gb3-content" aria-label="Giochi Nintendo 3DS">
          <div class="gb3-titlebar"><div><div class="gb3-eyebrow">LA TUA COLLEZIONE</div><h1>La tua libreria <span id="gb3-count">0</span></h1><p>I giochi rimangono sul tuo dispositivo, senza upload.</p></div><label class="gb3-search" id="gb3-search" hidden>${icons.search}<input type="search" id="gb3-filter" placeholder="Cerca un gioco…" autocomplete="off" aria-label="Cerca un gioco"></label></div>
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
        <footer class="gb3-footer"><span>GAEMBOY 3DS · Basato su Azahar · Non affiliato a Nintendo</span><a href="${SOURCE}" target="_blank" rel="noopener noreferrer">Sorgenti GPLv3+</a></footer>
      </div>
      <input type="file" accept="image/png,image/jpeg,image/webp" id="gb3-cover-input" hidden>
    `;
    document.body.append(root);
    root.querySelector('#gb3-select').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-select-empty').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-scan').addEventListener('click',importGames);
    root.querySelector('#gb3-scan-empty').addEventListener('click',importGames);
    root.querySelector('#gb3-single').addEventListener('click',openSingleGame);
    root.querySelector('#gb3-filter').addEventListener('input',e=>{filter=e.target.value.toLocaleLowerCase('it');displayedSnapshot=null;renderCards();});
    document.addEventListener('change',e=>{
      const input=e.target;
      if(root.contains(input)||input.type!=='file'||!input.files?.length)return;
      const rel=input.files[0].webkitRelativePath||'';
      if(rel.includes('/')){folderName=rel.split('/')[0];chosen=true;void writeDB(PREF_STORE,'folder-name',folderName);scheduleRender();}
    },true);
    const obs=new MutationObserver(records=>{
      if(records.every(r=>root.contains(r.target)))return;
      if(!launchPending) scheduleRender();
      else if(hasGameView()) {launchPending=false;root.hidden=true;}
    });
    obs.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class','style']});
    refresh();setTimeout(refresh,700);setTimeout(refresh,2500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',build,{once:true});else build();
})();
