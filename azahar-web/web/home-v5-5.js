/* GAEMBOY 3DS Home v5.5 - official proportions, last played hero, save preview bridge.
 * Standalone DOM addon: does not replace home-v5.js handlers or touch Azahar/player.
 * Copyright (c) GAEMBOY contributors, distributed with GAEMBOY 3DS GPL project.
 */
(() => {
  'use strict';
  if (window.__GB3_HOME_550) return;
  window.__GB3_HOME_550 = true;
  const DB = 'gaemboy-3ds-home-ui-v3';
  const PREF = 'preferences';
  const ART = 'artwork';
  const PLAYED_KEY = 'gb55-played-map';
  const SAVED_KEY = 'gb55-saved-map';
  const MAX_SHOTS = 6;
  const played = Object.create(null);
  const saved = Object.create(null);
  const previewUrls = new Map();
  let ready = false, root = null, hero = null, grid = null;
  let renderQueued = false, selected = '', expanded = false;
  let dbPromise = null;
  const q = (sel, scope = document) => scope.querySelector(sel);
  const normalizedKey = key => String(key || '').trim().toLocaleLowerCase('it');
  const games = () => [...(grid?.querySelectorAll('.mini-card[data-game-key]') || [])];
  const date = ts => Number.isFinite(+ts) && +ts > 0 ?
    new Intl.DateTimeFormat(navigator.language || 'it-IT', {dateStyle:'medium',timeStyle:'short'}).format(new Date(+ts)) : '';
  const dbOpen = () => {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PREF)) db.createObjectStore(PREF);
        if (!db.objectStoreNames.contains(ART)) db.createObjectStore(ART);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(err => { dbPromise = null; console.warn('[GAEMBOY 3DS v5.5] IndexedDB unavailable:', err); return null; });
    return dbPromise;
  };
  async function read(store, key) {
    const db = await dbOpen(); if (!db) return null;
    return new Promise(resolve => {
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function write(store, key, value) {
    const db = await dbOpen(); if (!db) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => { console.warn('[GAEMBOY 3DS v5.5] Could not save:', key); resolve(); };
      } catch { resolve(); }
    });
  }
  async function remove(store, key) {
    const db = await dbOpen(); if (!db) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      } catch { resolve(); }
    });
  }
  const asMap = (value, out) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, datum] of Object.entries(value)) if (key.length < 1050) out[normalizedKey(key)] = datum;
  };
  const getKey = card => normalizedKey(card?.getAttribute('data-game-key'));
  const getTitle = card => q('.mini-name', card)?.textContent?.trim() || getKey(card).split('/').pop();
  const coverSource = card => {
    const img = q('.mini-art img:not([hidden])', card);
    if (!img || !img.getAttribute('src') || img.style.display === 'none') return '';
    return img.currentSrc || img.src;
  };
  function formatMiniDates() {
    for (const card of games()) {
      const key = getKey(card), info = q('.mini-info', card);
      if (!info) continue;
      let dateEl = q('.mini-date.gb55-date', info);
      if (!dateEl) { dateEl = document.createElement('span'); dateEl.className = 'mini-date gb55-date'; info.append(dateEl); }
      dateEl.textContent = saved[key]?.at ? `Ultimo salvataggio: ${date(saved[key].at)}` : 'Nessun salvataggio';
    }
  }
  function makeElement(tag, cls = '', content = '') {
    const el = document.createElement(tag); if (cls) el.className = cls;
    if (content) el.textContent = content; return el;
  }
  function findHeroGame() {
    // Only a game that was ACTUALLY launched or saved becomes a featured game.
    const cards = games().filter(c => !c.hasAttribute('hidden'));
    const candidates = cards.map(card => {
      const key = getKey(card);
      return {card, key, at: Math.max(Number(played[key] || 0), Number(saved[key]?.at || 0))};
    }).filter(x => x.at > 0);
    candidates.sort((a,b) => b.at - a.at);
    return candidates[0] || null;
  }
  function thumbUrl(gameKey, meta) {
    return previewUrls.get(gameKey + ':' + meta.id) || '';
  }
  async function loadThumbs(gameKey) {
    const meta = saved[gameKey]; if (!meta || !Array.isArray(meta.shots)) return;
    for (const shot of meta.shots.slice(0, MAX_SHOTS)) {
      const id = gameKey + ':' + shot.id;
      if (previewUrls.has(id)) continue;
      const blob = await read(ART, 'gb55-shot:' + id);
      if (blob instanceof Blob && blob.type.startsWith('image/')) {
        previewUrls.set(id, URL.createObjectURL(blob)); scheduleRender();
      }
    }
  }
  function showThumbs(node, gameKey) {
    node.replaceChildren();
    const shots = saved[gameKey]?.shots?.slice(0, MAX_SHOTS) || [];
    if (!shots.length) {
      node.append(makeElement('p', 'gb55-shot-empty', 'Non ci sono ancora screenshot di save state registrati.'));
      return;
    }
    const rail = makeElement('div', 'gb55-shots');
    for (const item of shots) {
      const tile = makeElement('div', 'gb55-shot');
      const imageUrl = thumbUrl(gameKey, item);
      if (imageUrl) {const img = new Image(); img.src = imageUrl; img.alt = 'Anteprima salvataggio'; img.loading = 'lazy'; tile.append(img);}
      else tile.append(makeElement('div', 'gb55-shot-empty', 'Salvataggio'));
      tile.append(makeElement('small', '', date(item.at)));
      rail.append(tile);
    }
    node.append(rail);
  }
  function renderHero(info) {
    if (!root || !grid) return;
    if (!info) {
      if (hero) {hero.remove(); hero = null;}
      grid.classList.remove('gb55-has-featured');
      return;
    }
    const {card, key} = info;
    selected = key;
    if (!hero) {
      hero = makeElement('section', 'gb55-featured');
      hero.setAttribute('aria-label', 'Ultima ROM giocata');
      const section = grid.closest('.gb3-content') || grid.parentElement;
      const titlebar = q('.gb3-titlebar', section);
      section.insertBefore(hero, titlebar || grid);
    }
    const label = makeElement('div', 'gb55-section-label', 'ULTIMA ROM GIOCATA');
    const frame = makeElement('article', 'gb55-hero');
    let suppressNextMainClick = false;
    const actions = makeElement('div', 'gb55-hero-actions');
    for (const [label, cls] of [['Modifica','edit'],['Condividi','share'],['Elimina','delete']]) {
      const b = makeElement('button', 'gb55-action ' + cls, label);
      b.type = 'button'; b.setAttribute('aria-label', label);
      b.addEventListener('click', e => {
        e.stopPropagation();
        const source = q('.mini-card-actions .row-action.' + cls, card);
        if (source) source.click();
      });
      actions.append(b);
    }
    const track = makeElement('div', 'gb55-hero-track');
    const wash = makeElement('div', 'gb55-hero-wash'); wash.setAttribute('aria-hidden', 'true');
    const imageSrc = coverSource(card);
    if (imageSrc) wash.style.backgroundImage = `url("${imageSrc.replaceAll('"','%22')}")`;
    const fade = makeElement('div', 'gb55-hero-veil'); fade.setAttribute('aria-hidden','true');
    const main = makeElement('div', 'gb55-hero-main');
    const cover = makeElement('div', 'gb55-hero-cover');
    const sourceArt = q('.mini-art', card);
    if (imageSrc) {const img = new Image(); img.src = imageSrc; img.alt = ''; cover.append(img);}
    else if (sourceArt) cover.append(sourceArt.cloneNode(true));
    const content = makeElement('div', 'gb55-hero-info');
    content.append(makeElement('span','gb55-chip','3DS'));
    content.append(makeElement('h2','',getTitle(card)));
    const when = makeElement('div','gb55-hero-when');
    if (saved[key]?.at) {
      when.append(makeElement('span','gb55-when-label','Ultimo salvataggio locale:'));
      when.append(makeElement('strong','',date(saved[key].at)));
    } else {
      when.append(makeElement('span','gb55-when-label','Nessun salvataggio registrato'));
    }
    const lastPlay = Number(played[key] || 0);
    if (lastPlay) when.append(makeElement('span','gb55-last-played',`Ultima partita: ${date(lastPlay)}`));
    content.append(when);
    const expand = makeElement('button','gb55-more',expanded ? 'Chiudi dettagli  ⌃' : 'Maggiori dettagli  ⌄');
    expand.type = 'button';expand.setAttribute('aria-expanded',String(expanded));
    expand.addEventListener('click', e=>{e.stopPropagation(); expanded=!expanded;renderHero(info);});
    content.append(expand);
    const chevron = makeElement('span','gb55-chevron','›');chevron.setAttribute('aria-hidden','true');
    main.append(cover,content,chevron);
    main.tabIndex = 0; main.setAttribute('role','button');main.setAttribute('aria-label','Gioca a '+getTitle(card));
    main.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      if (suppressNextMainClick) {suppressNextMainClick = false; e.preventDefault(); return;}
      if (frame.classList.contains('gb55-open-actions')) {frame.classList.remove('gb55-open-actions');return;}
      const play = q('.mini-card-content',card);
      if (play) play.click();
    });
    main.addEventListener('keydown',e=>{if(e.target===main && (e.key==='Enter'||e.key===' ')){e.preventDefault();main.click();}});
    let startX=0, startY=0, inGesture=false;
    main.addEventListener('pointerdown',e=>{startX=e.clientX;startY=e.clientY;inGesture=true;});
    main.addEventListener('pointerup',e=>{if(!inGesture)return;inGesture=false;
      const dx=e.clientX-startX,dy=e.clientY-startY;
      if(Math.abs(dx)>60 && Math.abs(dx)>Math.abs(dy)*1.5){
        suppressNextMainClick = true;
        frame.classList.toggle('gb55-open-actions',dx<0);e.preventDefault();
        setTimeout(()=>{suppressNextMainClick=false;},350);
      }
    });
    track.append(wash,fade,main);
    if (expanded) {
      const panel = makeElement('div','gb55-save-panel');
      panel.append(makeElement('h3','','Save state'));
      showThumbs(panel, key);
      track.append(panel);
    }
    frame.append(actions,track);
    hero.replaceChildren(label,frame);
    if (expanded) void loadThumbs(key);
  }
  function render() {
    renderQueued = false;
    if (!ready || !root || !grid || !root.isConnected) return;
    const gameFilter = q('#gb3-filter',root)?.value?.trim().toLocaleLowerCase('it') || '';
    const info = findHeroGame();
    const featuredMatchesFilter = info && (!gameFilter || getTitle(info.card).toLocaleLowerCase('it').includes(gameFilter));
    for (const card of games()) card.classList.toggle('gb55-featured-source', Boolean(featuredMatchesFilter && getKey(card) === info.key));
    grid.classList.toggle('gb55-has-featured', Boolean(featuredMatchesFilter));
    grid.closest('.gb3-content')?.classList.toggle('gb55-only-featured', Boolean(featuredMatchesFilter && games().length === 1));
    renderHero(featuredMatchesFilter ? info : null);
    formatMiniDates();
  }
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true; requestAnimationFrame(render);
  }
  function visibleCanvas() {
    return [...document.querySelectorAll('canvas')].some(canvas => !root?.contains(canvas) &&
      canvas.getClientRects().length > 0 && canvas.getBoundingClientRect().width >= 80);
  }
  function trackPlay(key) {
    if (!key) return;
    let checks = 0;
    const timer = setInterval(async () => {
      checks++;
      if (root?.hidden && visibleCanvas()) {
        clearInterval(timer);
        played[key] = Date.now(); await write(PREF, PLAYED_KEY, played);
        console.info('[GAEMBOY 3DS] Ultimo gioco avviato:',key);
        scheduleRender();
      } else if (checks >= 28) clearInterval(timer);
    }, 400);
  }
  function currentGameKey() {
    const info = findHeroGame(); return selected || info?.key || '';
  }
  async function screenshotBlob(input) {
    if (input instanceof Blob && input.type.startsWith('image/') && input.size < 8*1024*1024) return input;
    if (typeof input === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(input) && input.length < 9*1024*1024) {
      try {return await (await fetch(input)).blob();}catch{return null;}
    }
    return null;
  }
  async function compactScreenshot(blob) {
    try {
      const bitmap=await createImageBitmap(blob);
      const scale=Math.min(1,640/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));
      canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      bitmap.close?.();
      const output=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.82));
      return output || blob;
    }catch{return blob;}
  }
  async function recordSaveState(detail = {}) {
    const key = normalizedKey(detail.gameKey || detail.path || currentGameKey());
    if (!key || !games().some(card => getKey(card)===key)) {
      console.warn('[GAEMBOY 3DS v5.5] Save state not linked to a known game; event ignored.');
      return false;
    }
    const when = Number(detail.savedAt || Date.now());
    if (!Number.isFinite(when) || when < 0 || when > Date.now()+300000) return false;
    const previous = saved[key] || {at:0,shots:[]};
    const next={at:Math.max(Number(previous.at||0),when),shots:Array.isArray(previous.shots)?previous.shots.slice(0,MAX_SHOTS):[]};
    const blob=await screenshotBlob(detail.screenshot);
    if (blob) {
      const compact=await compactScreenshot(blob);
      const id=String(when)+'-'+Math.random().toString(36).slice(2,7);
      await write(ART,'gb55-shot:'+key+':'+id,compact);
      next.shots.unshift({id,at:when});
      for(const excess of next.shots.splice(MAX_SHOTS)) {
        await remove(ART,'gb55-shot:'+key+':'+excess.id);
        const url=previewUrls.get(key+':'+excess.id);
        if(url) URL.revokeObjectURL(url);
        previewUrls.delete(key+':'+excess.id);
      }
    }
    saved[key]=next;await write(PREF,SAVED_KEY,saved);
    scheduleRender();void loadThumbs(key);
    return true;
  }
  function attach() {
    root=q('#gb3-home');grid=q('#gb3-grid',root||document);
    if (!root || !grid) {setTimeout(attach,250);return;}
    grid.addEventListener('click',e=>{
      const face=e.target.closest('.mini-card-content');
      if (!face || !grid.contains(face)) return;
      const card=face.closest('.mini-card');
      if (card && !card.classList.contains('open') && card.dataset.swipeBlocked!=='1') {
        selected=getKey(card);trackPlay(selected);
      }
    },true);
    grid.addEventListener('load',scheduleRender,true);
    const filter=q('#gb3-filter',root);
    filter?.addEventListener('input',scheduleRender);
    const mo=new MutationObserver(mutations=>{
      if (mutations.some(m=>m.type==='childList')) scheduleRender();
    });
    mo.observe(grid,{childList:true});
    ready=true; scheduleRender();
  }
  window.addEventListener('gaemboy3ds:savestate-saved',e=>void recordSaveState(e.detail));
  window.Gaemboy3DSHome55={
    recordSaveState,
    status:()=>({lastPlayed:Object.keys(played).length,lastSaveGames:Object.keys(saved).length,
      featuredKey:selected,hasScreenshotBridge:true, note:'Screenshot mostrati solo dopo un evento reale di salvataggio.'})
  };
  void (async()=>{
    asMap(await read(PREF,PLAYED_KEY),played);
    asMap(await read(PREF,SAVED_KEY),saved);
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach,{once:true});
    else attach();
  })();
})();
