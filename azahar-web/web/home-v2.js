/* GAEMBOY 3DS Home v2 — progressive UI adapter, GPL-3.0-or-later.
   Leaves the original emulator, folder picker, game loading and persistence untouched.
   Home controls delegate to the existing application, rather than copying ROMs.
*/
(() => {
  'use strict';
  if (window.__gb3HomeV2Installed) return;
  window.__gb3HomeV2Installed = true;

  const SOURCE_URL = 'https://github.com/DomenicoGonnelli/gaemboy-3ds-web';
  const FOLDER_KEY = 'gb3-home-v2-folder-label';
  const ICON = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 12 7-12 7z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 9a7 7 0 0112-2l2 5M18 15a7 7 0 01-12 2l-2-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).toLocaleLowerCase('it');
  let root;
  let gameNodes = [];
  let demoNodes = [];
  let filter = '';
  let folderChosen = false;
  let importRequested = false;
  let busy = false;
  let renderTimer = 0;
  let lastFingerprint = '';
  let status = null;
  let visible = true;

  function legacyAll(selector) {
    return [...document.querySelectorAll(selector)].filter(el => !root || !root.contains(el));
  }
  function legacyButton(pattern) {
    const choices = legacyAll('button, input[type="button"], input[type="submit"]');
    return choices.find(el => pattern.test(norm(el.textContent || el.value || el.getAttribute('aria-label')))) || null;
  }
  function findHeading(pattern) {
    return legacyAll('h1,h2,h3,h4,[role="heading"]').find(el => pattern.test(norm(el.textContent)));
  }
  function after(a, b) { return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)); }
  function getLegacyGames() {
    const heading = findHeading(/^libreria(?:\s|$)/);
    const demo = findHeading(/^demo(?:\s|$)/);
    if (!heading) return [];
    const elements = legacyAll('button,[role="button"],a[href], [data-game-path]');
    const candidates = elements.filter(el => after(heading, el) && (!demo || after(el, demo)));
    const seen = new Set();
    const games = [];
    for (const el of candidates) {
      if (el.closest('footer')) continue;
      const label = norm(el.textContent || el.value);
      if (/^(aggiorna|dimentica cartella|cerca|scegli cartella|apri rom|importa|filtra|ordina)(\s|$)/.test(label)) continue;
      // A launch button may be labelled only "Gioca"; use its row for the title.
      const row = el.closest('li,tr,article,.game-card,.game-row,.library-item,.rom-item,[data-path]') || el.parentElement;
      const rowText = clean(row?.textContent || '');
      const path = el.dataset.gamePath || el.dataset.path || row?.dataset.path || row?.dataset.gamePath || '';
      const looksGame = /\.(3ds|3dsx|cci|cxi|app|elf)\b/i.test(rowText + ' ' + path + ' ' + label);
      const looksLauncher = /\b(gioca|avvia|play|launch)\b/i.test(label);
      if (!looksGame && !looksLauncher) continue;
      const rawTitle = clean(rowText.replace(/\b(gioca|avvia|play|launch)\b/gi, '').replace(/\b(3ds|3dsx|cci|cxi|app|elf)\b/gi, '')) || clean(path || el.textContent);
      let title = clean(rawTitle.replace(/\b\d+(?:[.,]\d+)?\s*(?:MB|GB|KB)\b/gi, '').replace(/\.((3ds|3dsx|cci|cxi|app|elf))\b/gi, '').replace(/[|•·]+$/g, ''));
      if (!title || /^(rom|gioco)$/i.test(title)) title = clean(path.split('/').pop() || el.textContent || 'Gioco 3DS');
      const dedupe = (path || title).toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const fmt = ((path + ' ' + rowText).match(/\.(3dsx|3ds|cci|cxi|app|elf)\b/i) || [,'3DS'])[1].toUpperCase();
      const img = row?.querySelector('img');
      games.push({title, path, fmt, img:img?.getAttribute('src') || '', element:el});
    }
    return games;
  }
  function getDemos() {
    const demo = findHeading(/^demo(?:\s|$)/);
    if (!demo) return [];
    const next = legacyAll('h1,h2,h3').find(el => after(demo, el));
    return legacyAll('button').filter(el => after(demo, el) && (!next || after(el, next)))
      .filter(el => /craftus|haxagon|demo/i.test(clean(el.textContent)))
      .map(el => ({ title: clean(el.textContent), fmt: 'DEMO', path:'demo', img:'', element:el }));
  }
  function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  function safeImage(src) {
    if (!src) return '';
    try { const u = new URL(src, location.href); return ['http:', 'https:', 'blob:', 'data:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
  }
  function selectedFolderLabel() {
    try {return localStorage.getItem(FOLDER_KEY) || '';} catch {return '';}
  }
  function saveFolderLabel(s) {
    try { if (s) localStorage.setItem(FOLDER_KEY, s); } catch { /* private mode */ }
  }
  function statusMessage(message, kind='info') {
    status = message ? {message,kind} : null;
    const el = root?.querySelector('#gb3-status');
    if (!el) return;
    el.hidden = !status;
    el.dataset.state = kind;
    el.textContent = message || '';
  }
  function displayFolder() {
    const label = selectedFolderLabel();
    root.querySelector('#gb3-folder-name').textContent = label || (folderChosen || gameNodes.length ? 'Cartella locale configurata' : 'Nessuna cartella selezionata');
    root.querySelector('#gb3-folder-detail').textContent = gameNodes.length ? 'I giochi restano sul tuo dispositivo' : 'Seleziona la cartella che contiene i tuoi giochi';
    const choose = root.querySelector('#gb3-choose');
    choose.textContent = (folderChosen || gameNodes.length || label) ? 'Cambia cartella' : 'Scegli cartella';
    root.querySelector('#gb3-import-top').disabled = !(folderChosen || gameNodes.length || label);
    root.querySelector('#gb3-import-empty').disabled = !(folderChosen || gameNodes.length || label);
  }
  function makeGameCard(game, index) {
    const choices = [['#602954','#253b75'],['#423986','#9d346b'],['#186071','#242c5b'],['#782c4c','#3c255b'],['#304e6c','#5c2a68'],['#8c3c52','#3e2459']];
    const [a,b] = choices[hash(game.title) % choices.length];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gb-game';
    button.setAttribute('aria-label', `Gioca a ${game.title}`);
    button.dataset.gameIndex = String(index);
    const cover = document.createElement('div');
    cover.className = 'gb-cover';
    cover.style.setProperty('--cover-a',a);
    cover.style.setProperty('--cover-b',b);
    const chip = document.createElement('span'); chip.className='gb-cover-chip'; chip.textContent=game.fmt;
    cover.appendChild(chip);
    const url = safeImage(game.img);
    if (url) { const img = document.createElement('img'); img.src=url; img.alt=''; img.loading='lazy'; img.onerror=()=>img.replaceWith(symbol(game)); cover.appendChild(img); }
    else cover.appendChild(symbol(game));
    const body = document.createElement('div'); body.className='gb-card-body';
    const name = document.createElement('div'); name.className='gb-game-name'; name.textContent=game.title; name.title=game.title;
    const foot = document.createElement('div'); foot.className='gb-card-foot';
    const type = document.createElement('span'); type.textContent='Nintendo 3DS';
    const play = document.createElement('span'); play.className='gb-card-play'; play.innerHTML = `Gioca ${ICON.play}`;
    foot.append(type,play); body.append(name,foot); button.append(cover,body);
    button.addEventListener('click',()=>launchGame(game));
    return button;
  }
  function symbol(game) {
    const s=document.createElement('span');s.className='gb-cover-symbol';
    const words=game.title.replace(/[^\p{L}\p{N} ]/gu,'').trim().split(/\s+/).filter(Boolean);
    s.textContent=(words.length>=2? words[0][0]+words[1][0] : (words[0]||'3D').slice(0,2)).toUpperCase();
    return s;
  }
  function launchGame(game) {
    if (!game.element?.isConnected) {
      statusMessage('La libreria è cambiata. Premi Importa ROM per aggiornare i giochi.','error');
      return;
    }
    // Reuse the original app's click handler and permission flow. Do not rewrite gameplay.
    root.hidden=true;
    visible=false;
    try { game.element.click(); }
    catch(err) { visible=true; root.hidden=false; statusMessage(`Impossibile avviare il gioco: ${err.message}`,'error'); }
  }
  function updateCards() {
    if (!root || !visible) return;
    const games = getLegacyGames();
    const fp = games.map(g => g.title + '|' + g.path).join('\n');
    if (fp !== lastFingerprint) { gameNodes = games; lastFingerprint = fp; }
    const displayed = (importRequested || !folderChosen) ? gameNodes.filter(g => norm(g.title).includes(norm(filter))) : [];
    demoNodes = getDemos();
    const cardWrap=root.querySelector('#gb3-games');
    const noResults=root.querySelector('#gb3-empty');
    const count=root.querySelector('#gb3-count');
    count.textContent=String(displayed.length);
    const hasGames=displayed.length>0;
    cardWrap.hidden=!hasGames;
    noResults.hidden=hasGames || (!!filter && gameNodes.length>0);
    root.querySelector('#gb3-search').hidden=gameNodes.length===0;
    const searchNoMatch=root.querySelector('#gb3-no-match');
    searchNoMatch.hidden=!(!!filter && gameNodes.length>0 && !hasGames);
    cardWrap.replaceChildren(...displayed.map(makeGameCard));
    const demosSection = root.querySelector('#gb3-demos-section');
    demosSection.hidden = demoNodes.length === 0;
    root.querySelector('#gb3-demos').replaceChildren(...demoNodes.map(makeGameCard));
    if (!hasGames && gameNodes.length===0) {
      root.querySelector('#gb3-empty-title').textContent=importRequested?'Nessuna ROM valida trovata':'Nessun gioco importato';
      root.querySelector('#gb3-empty-desc').textContent=importRequested?
        'Nessuna ROM 3DS valida è presente nella cartella selezionata. Controlla i file e riprova.':
        'Per giocare al 3DS non è necessario caricare ROM di grandi dimensioni nel browser. Seleziona una cartella con i file dei tuoi giochi: rimarranno sul dispositivo.';
    }
    displayFolder();
  }
  function chooseFolder() {
    const btn=legacyButton(/scegli cartella|cambia cartella|seleziona cartella/i);
    if (!btn) return statusMessage('Il selettore cartella originale non è stato trovato. Controlla la versione del progetto.','error');
    // Use the existing folder selection API, including the Safari/Firefox fallback.
    try {
      folderChosen=true;
      importRequested=false;
      statusMessage('Seleziona la cartella nel browser, poi premi Importa ROM.');
      btn.click();
      updateCards();
    } catch(e) { statusMessage('Impossibile aprire il selettore: '+e.message,'error'); }
  }
  function importGames() {
    const btn=legacyButton(/^aggiorna\b|^scansiona\b|^importa rom\b/i);
    if (!btn) return statusMessage('Il pulsante originale Aggiorna non è stato trovato.','error');
    importRequested=true; busy=true;
    statusMessage('Ricerca dei giochi nella cartella selezionata…');
    try { btn.click(); } catch(e) {busy=false;return statusMessage('Errore durante la scansione: '+e.message,'error');}
    setTimeout(() => {
      busy=false;
      updateCards();
      if (gameNodes.length) statusMessage(`${gameNodes.length} giochi disponibili nella tua libreria.`,'success');
      else statusMessage('Nessuna ROM 3DS valida è presente nella cartella selezionata.','error');
    }, 3500);
  }
  function build() {
    root=document.createElement('div');root.id='gb3-home';root.setAttribute('role','region');root.setAttribute('aria-label','Libreria giochi 3DS');
    root.innerHTML=`
      <div class="gb-shell">
        <header class="gb-topbar">
          <div class="gb-brand"><div class="gb-mark" aria-hidden="true">G</div><div class="gb-wordmark">GAEMBOY<span>NINTENDO 3DS</span></div></div>
          <div class="gb-top-note">Emulazione locale · Nessun upload</div>
        </header>
        <section class="gb-hero" aria-label="Benvenuto">
          <div><div class="gb-eyebrow">La tua console. I tuoi giochi.</div><h1>Il tuo mondo 3DS,<br>sempre con te.</h1><p>Organizza la tua libreria e riprendi i tuoi giochi. I file rimangono sul tuo dispositivo, senza upload e senza importazioni pesanti.</p></div>
          <div class="gb-console" aria-hidden="true"><div class="gb-upper"></div><div class="gb-lower"><span class="gb-pad">✚</span><div class="gb-screen"></div><span class="gb-pad">✦</span></div></div>
        </section>
        <section class="gb-source" aria-label="Configurazione cartella">
          <div class="gb-source-info"><div class="gb-source-icon">${ICON.folder}</div><div><div class="gb-source-title" id="gb3-folder-name">Nessuna cartella selezionata</div><div class="gb-source-sub" id="gb3-folder-detail">Seleziona la cartella che contiene i tuoi giochi</div></div></div>
          <div class="gb-source-actions"><button class="gb-btn" id="gb3-choose" type="button">Scegli cartella</button><button class="gb-btn gb-btn-primary" type="button" id="gb3-import-top">${ICON.refresh} Importa ROM</button></div>
        </section>
        <div id="gb3-status" class="gb-status" role="status" aria-live="polite" hidden></div>
        <section aria-label="Giochi">
          <div class="gb-section-head"><div><h2>La tua libreria <span class="gb-count" id="gb3-count">0</span></h2><p>Seleziona un gioco per iniziare.</p></div>
            <label id="gb3-search" class="gb-search" hidden>${ICON.search}<input type="search" id="gb3-filter" placeholder="Cerca un gioco…" autocomplete="off" aria-label="Cerca gioco"></label></div>
          <div class="gb-library" id="gb3-games" hidden></div>
          <div id="gb3-no-match" class="gb-empty" hidden><h3>Nessun risultato</h3><p>Prova a cercare un altro titolo.</p></div>
          <div id="gb3-empty" class="gb-empty">
            <div class="gb-empty-art">${ICON.folder}</div>
            <h3 id="gb3-empty-title">Nessun gioco importato</h3>
            <p id="gb3-empty-desc">Per giocare al 3DS non è necessario caricare ROM di grandi dimensioni nel browser. Seleziona una cartella con i file dei tuoi giochi: rimarranno sul dispositivo.</p>
            <div class="gb-empty-actions"><button type="button" id="gb3-choose-empty" class="gb-btn gb-btn-primary">${ICON.folder} Scegli cartella</button><button type="button" id="gb3-import-empty" class="gb-btn">${ICON.plus} Importa ROM</button></div>
            <div class="gb-steps"><div class="gb-step"><span>1</span> Scegli cartella</div><div class="gb-step-divider">→</div><div class="gb-step"><span>2</span> Importa ROM</div><div class="gb-step-divider">→</div><div class="gb-step"><span>3</span> Gioca</div></div>
          </div>
        </section>
        <section id="gb3-demos-section" class="gb-demos-section" hidden><div class="gb-section-head"><div><h2>Prova una demo</h2><p>Scopri come funziona il 3DS Web con una demo libera.</p></div></div><div id="gb3-demos" class="gb-library"></div></section>
        <footer class="gb-footer"><span>GAEMBOY 3DS · Basato su Azahar · Non affiliato a Nintendo · I giochi restano sul tuo dispositivo.</span><a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">Codice sorgente · GPLv3+</a></footer>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#gb3-choose').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-choose-empty').addEventListener('click',chooseFolder);
    root.querySelector('#gb3-import-top').addEventListener('click',importGames);
    root.querySelector('#gb3-import-empty').addEventListener('click',importGames);
    root.querySelector('#gb3-filter').addEventListener('input',e=>{filter=e.target.value;updateCards();});
    document.addEventListener('change', e => {
      const input = e.target;
      if (root.contains(input) || input?.type !== 'file' || !input.files?.length) return;
      const path = input.files[0].webkitRelativePath || '';
      if (path.includes('/')) { saveFolderLabel(path.split('/')[0]); folderChosen=true; updateCards(); }
    }, true);
    // Persisted library is owned by the original application; wait for its async IndexedDB restore.
    updateCards();
    setTimeout(updateCards,600);
    setTimeout(updateCards,1800);
    setTimeout(updateCards,4500);
    // Mutation observer only sees changes outside this overlay, preventing recursive renders.
    const observer = new MutationObserver(list => {
      if (!visible || list.every(record => root.contains(record.target))) return;
      clearTimeout(renderTimer);renderTimer=setTimeout(updateCards,120);
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',build,{once:true});
  else build();
})();
