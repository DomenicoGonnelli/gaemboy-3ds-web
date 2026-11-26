// Page side of the GAEMBOY 3DS web POC. The emulator runs in gaemboy3ds-worker.js (+ its pthreads);
// this page draws frames and writes input through the SharedState struct exported by
// gaemboy3ds_web.cpp (offsets below must match it), and plays audio through an AudioWorklet.
const OFF = {
  status: 0, frameSeq: 4, fbWidth: 8, fbHeight: 12, fbPtr: 16, throttle: 20, buttons: 24,
  pointerX: 28, pointerY: 32, pointerDown: 36, analogLX: 40, analogLY: 44, framesTotal: 48,
  audioFrames: 52, lastFrameMs: 56, avgFrameMs: 60, emuFps: 64, loadMs: 68, messageSeq: 72,
  message: 76, analogRX: 332, analogRY: 336, audioRingPtr: 340, audioRingFrames: 344,
  audioWrite: 348, audioRead: 352, audioDropped: 356,
};
import {
  validRom, registerRom, romFingerprint, listCatalog, putCatalogGame, deleteCatalogGame,
  cachedFile, cacheUsage, cacheRom, removeCachedRom, prefersSequentialCache, ROM_LIMIT,
} from './gaemboy3ds-cache.js?v=08';
import { allowedCacheGb, verifyGaemboyGrant, GIB } from './gaemboy3ds-entitlement.js?v=1';
import { GAEMBOY_PREMIUM_PUBLIC_JWK } from './gaemboy3ds-premium-key.js?v=1';
import { bindTouchControls } from './gaemboy3ds-touch.js?v=26';
import { ACTIONS, STORAGE_KEY, defaults, normalizeBindings, remap, toMaps, describeCode } from './gaemboy3ds-keymap.js?v=12';
import { formatGatewayInput, validateGatewayInput } from './gaemboy3ds-cheat-format.mjs?v=18';

const STATE_SIZE = 360;
const STATUS = ['avvio', 'caricamento…', 'in esecuzione', 'errore'];
const NATIVE_FPS = 59.83;
const AUDIO_HZ = 32728;
// libretro joypad ids: B0 Y1 Select2 Start3 Up4 Down5 Left6 Right7 A8 X9 L10 R11 ZL12 ZR13 Home14
function loadKeyboardBindings() {
  try { return normalizeBindings(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
  catch { return defaults(); }
}
let keyboardBindings = loadKeyboardBindings();
let { buttons: KEYMAP, sticks: STICK_KEYS } = toMaps(keyboardBindings);
let mappingAction = null;
function persistKeyboardBindings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keyboardBindings)); }
  catch { $('keymap-status').textContent = 'Impostazioni attive, ma non salvabili nel browser.'; }
}
function renderKeyboardBindings() {
  const root = $('keyboard-bindings');
  if (!root) return;
  root.replaceChildren();
  for (const action of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'gb3-key-row';
    const label = document.createElement('span');
    label.textContent = action.label;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'alt gb3-key-button';
    button.dataset.keyAction = action.id;
    button.textContent = mappingAction === action.id ? 'Premi un tasto...' : describeCode(keyboardBindings[action.id]);
    button.setAttribute('aria-label', `Cambia tasto per ${action.label}`);
    button.setAttribute('aria-pressed', String(mappingAction === action.id));
    button.onclick = () => {
      mappingAction = action.id;
      $('keymap-status').textContent = `Premi il nuovo tasto per ${action.label}. Esc annulla.`;
      renderKeyboardBindings();
      root.querySelector(`[data-key-action="${action.id}"]`)?.focus();
    };
    row.append(label, button); root.append(row);
  }
}
function cancelRemap() {
  if (!mappingAction) return false;
  mappingAction = null;
  $('keymap-status').textContent = 'Modifica annullata.';
  renderKeyboardBindings();
  return true;
}
// Standard Gamepad API layout mapped by position, Nintendo style (bottom = B, right = A, ...).
const PAD_BUTTONS = { 0: 0, 1: 8, 2: 1, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13, 8: 2, 9: 3, 12: 4, 13: 5, 14: 6, 15: 7, 16: 14 };
const PAD_DEADZONE = 0.15;

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const gameMenu = $('game-menu');
const touchControls = bindTouchControls($('touch-controls'));
const urlParams = new URLSearchParams(location.search);
// WebGL2 (GPU) everywhere, Safari included; ?sw forces the much slower software renderer.
const useSw = urlParams.has('sw');
const ctx = useSw ? canvas.getContext('2d') : null;
const logEl = $('log');
const bench = { startedAt: 0, frames: [] };
window.__gb3ds = bench;

// The log panel keeps the last lines only and is re-rendered at most twice a second.
const LOG_KEEP = 400;
const logLines = [];
// Larger history kept only for the "Scarica log" export (freeze reports).
const LOG_EXPORT_KEEP = 20000;
const logHistory = [];
let logDirty = false;
let logTotal = 0;
let logRate = { t: performance.now(), total: 0, perSec: 0 };
function log(line) {
  logHistory.push(`${(performance.now() / 1000).toFixed(3)} ${line}`);
  if (logHistory.length > LOG_EXPORT_KEEP) logHistory.splice(0, logHistory.length - LOG_EXPORT_KEEP);
  logLines.push(line);
  if (logLines.length > LOG_KEEP) logLines.splice(0, logLines.length - LOG_KEEP);
  logDirty = true;
}
setInterval(() => {
  if (!logDirty) return;
  logDirty = false;
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}, 500);
// Italian hints for the core messages a user hits with real game dumps.
const HINTS = [
  [/encrypted/i, 'Il gioco è criptato: Azahar richiede un dump decrittato della tua cartuccia (es. GodMode9 → "Decrypt").'],
  [/obtain loader|not supported|invalid format/i, 'Formato non riconosciuto: usa .3ds/.cci/.cxi/.app decrittati o un homebrew .3dsx (i .cia vanno prima installati).'],
  [/GBA Virtual Console/i, 'I titoli GBA Virtual Console non sono supportati da Azahar.'],
  [/system archive/i, 'Il gioco richiede file di sistema del 3DS che non sono inclusi.'],
  [/ROM metadata/i, 'Il file non sembra un gioco 3DS valido (danneggiato, troncato o di un altro sistema).'],
];
function notice(text, kind = 'info') {
  const hint = HINTS.find(([re]) => re.test(text));
  if (hint) text = `${text} — ${hint[1]}`;
  $('notice').hidden = false;
  $('notice').className = kind;
  $('notice').textContent = text;
  if (gameMenu.open && kind === 'bad') $('menu-status').textContent = text;
}

if (useSw) {
  notice(`Renderer software forzato da ?sw: i giochi 3D pesanti girano molto più lenti. Per WebGL2 (GPU, consigliato) apri ${location.origin}${location.pathname}`, 'bad');
}
if (!crossOriginIsolated) {
  notice('La pagina non è cross-origin isolated (servono header COOP/COEP): i thread WASM non possono partire.', 'bad');
}

// UX15 speed controls: selected target persists, actual multiplier is set only after user action.
const GB15_SPEED_KEY = 'gaemboy3ds-speed-target-v1';
function gb15ReadSpeed() {
  try { const value=Number(localStorage.getItem(GB15_SPEED_KEY)); return value>=0.5 && value<=8 && Number.isInteger(value*2) ? value : 2; }
  catch { return 2; }
}
let gb15SelectedSpeed = gb15ReadSpeed();
let gb15SpeedEnabled = false;
function gb15EffectiveSpeed() { return gb15SpeedEnabled ? gb15SelectedSpeed : 1; }
function gb15ApplySpeed() {
  const speed = gb15EffectiveSpeed();
  if (memory) writeI('throttle', speed > 1 ? 0 : 1);
  worker?.postMessage({type:'set-speed',value:speed});
  const fast = document.getElementById('gb13-quick-fast');
  fast?.setAttribute('aria-pressed',String(gb15SpeedEnabled));
  return speed;
}
function gb15PersistSpeed() {
  try { localStorage.setItem(GB15_SPEED_KEY,String(gb15SelectedSpeed)); } catch {}
}
let worker = null;
let memory = null;
let base = 0;
let cameraBuffer = 0;
let storageAvailable = false;
let featureBusy = false;
let mediaBusy = false;
let slots = [];
let nextRequestId = 1;
const pendingRequests = new Map();
const i32 = () => new Int32Array(memory.buffer);
const f32 = () => new Float32Array(memory.buffer);
const u8 = () => new Uint8Array(memory.buffer);
const readI = (k) => Atomics.load(i32(), (base + OFF[k]) >> 2);
const writeI = (k, v) => Atomics.store(i32(), (base + OFF[k]) >> 2, v);
const readF = (k) => f32()[(base + OFF[k]) >> 2];

function featureMessage(message, error = false) {
  $('feature-status').textContent = message;
  $('feature-status').className = error ? 'bad' : 'good';
  if (error) log(`[funzioni] ${message}`);
}

function refreshFeatureControls() {
  const running = !!memory && readI('status') === 2;
  $('touch-controls').disabled = !running || gameMenu.open;
  $('back-library').disabled = featureBusy || mediaBusy;
  $('storage-actions').disabled = $('cheat-actions').disabled = !running || !storageAvailable || featureBusy;
  $('media-actions').disabled = !running || mediaBusy;
  const selected = slots.find((slot) => slot.slot === Number($('state-slot').value));
  $('state-save').disabled = !selected;
  $('state-load').disabled = $('state-delete').disabled = !selected?.exists;
  $('camera-facing').disabled = !!cameraStream;
  gb13UpdateQuickAvailability();
}

function requestCommand(action, data = {}) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    try {
      worker.postMessage({ type: 'command', id, action, ...data });
    } catch (err) {
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

function failRequests(message) {
  for (const { reject } of pendingRequests.values()) reject(new Error(message));
  pendingRequests.clear();
}

function renderSlots(items) {
  slots = items;
  const selector = $('state-slot');
  const selected = Number(selector.value) || 1;
  selector.replaceChildren();
  for (const slot of items) {
    const option = document.createElement('option');
    option.value = String(slot.slot);
    option.textContent = slot.exists
      ? `Slot ${slot.slot} — ${new Date(slot.modified).toLocaleString()}`
      : `Slot ${slot.slot} — vuoto`;
    selector.append(option);
  }
  selector.value = String(Math.min(items.length, selected));
  refreshFeatureControls();
  if ($('gb14-state-gallery') && !$('gb14-state-gallery').hidden) void gb14RenderGallery();
}

function renderCheats(items) {
  // Gaemboy CheatCodesModal UX: enabled codes first, with a native accessible switch.
  // Keep the original worker index for toggle/delete (the visual order can differ).
  const list = $('cheat-list');
  list.replaceChildren();
  const sorted = items.map((cheat, index) => ({ cheat, index }))
    .sort((a,b) => Number(!!b.cheat.enabled) - Number(!!a.cheat.enabled));
  $('gb17-cheat-count').textContent = `${items.length} codic${items.length === 1 ? 'e' : 'i'}`;
  $('gb17-cheat-empty').hidden = items.length !== 0;
  for (const {cheat, index} of sorted) {
    const item = document.createElement('article');
    item.className = `gb17-cheat-item${cheat.enabled ? ' enabled' : ''}`;
    const info = document.createElement('div');
    info.className = 'gb17-cheat-info';
    const name = document.createElement('strong');
    name.className = 'gb17-cheat-name'; name.textContent = cheat.name;
    const details = document.createElement('div'); details.className = 'gb17-cheat-details';
    const code = document.createElement('code'); code.className = 'gb17-cheat-code'; code.textContent = cheat.code;
    const format = document.createElement('span'); format.className = 'gb17-cheat-type'; format.textContent = 'Gateway';
    details.append(code, format);
    info.append(name, details);
    const actions = document.createElement('div'); actions.className = 'gb17-cheat-row-actions';
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'gb17-cheat-toggle';
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!cheat.enabled;
    enabled.setAttribute('aria-label', `Attiva ${cheat.name}`);
    const slider = document.createElement('span'); slider.className = 'gb17-toggle-slider'; slider.setAttribute('aria-hidden','true');
    enabled.addEventListener('change', async () => {
      enabled.disabled = true;
      const result = await performFeature('toggle-cheat', { index, enabled: enabled.checked }, 'Cheat aggiornato.');
      if (!result) enabled.checked = !!cheat.enabled;
      enabled.disabled = false;
    });
    toggleLabel.append(enabled,slider);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'gb17-cheat-delete';
    remove.textContent = 'Elimina'; remove.setAttribute('aria-label', `Elimina ${cheat.name}`);
    remove.addEventListener('click', () => {
      if (confirm(`Eliminare il cheat "${cheat.name}"?`)) {
        void performFeature('delete-cheat', { index }, 'Cheat eliminato.');
      }
    });
    actions.append(toggleLabel,remove); item.append(info,actions); list.append(item);
  }
}

async function performFeature(action, data = {}, success = '') {
  featureBusy = true;
  refreshFeatureControls();
  try {
    const result = await requestCommand(action, data);
    if (result.slots) renderSlots(result.slots);
    if (result.cheats) renderCheats(result.cheats);
    if (success) featureMessage(success);
    return result;
  } catch (err) {
    let message = err.message || String(err);
    const refresh = action === 'save-state' || action === 'delete-state' ? 'slots' :
      action === 'add-cheat' || action === 'toggle-cheat' || action === 'delete-cheat' ? 'cheats' : null;
    if (refresh) {
      try {
        const current = await requestCommand(refresh);
        if (current.slots) renderSlots(current.slots);
        if (current.cheats) renderCheats(current.cheats);
      } catch (refreshError) {
        message += ` Impossibile aggiornare la lista: ${refreshError.message || refreshError}`;
      }
    }
    featureMessage(message, true);
    return null;
  } finally {
    featureBusy = false;
    refreshFeatureControls();
  }
}

async function initializeFeatures() {
  await performFeature('slots');
  await performFeature('cheats');
}

// ---------------------------------------------------------------- audio
let audioCtx = null;
let audioNode = null;
let audioOn = true;
async function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext({ latencyHint: 'interactive' });
    await audioCtx.audioWorklet.addModule('./gaemboy3ds-audio.js');
    audioNode = new AudioWorkletNode(audioCtx, 'gaemboy3ds-audio', { outputChannelCount: [2] });
    audioNode.connect(audioCtx.destination);
    audioNode.port.postMessage({ type: 'mute', muted: !audioOn });
    if (memory) initAudio();
  } catch (err) {
    log(`[audio] non disponibile: ${err}`);
    audioCtx = null;
  }
}
function initAudio() {
  if (!audioNode || !memory) return;
  audioNode.port.postMessage({
    type: 'init', buffer: memory.buffer, state: base, srcRate: AUDIO_HZ,
    ringPtr: readI('audioRingPtr'), ringFrames: readI('audioRingFrames'),
  });
  audioCtx.resume();
}

// ---------------------------------------------------------------- boot
function boot(file, managedCache = false) {
  if (worker) return;
  for (const id of ['demo', 'demo3d']) $(id).disabled = true;
  $('pick').disabled = true;
  $('rom-info').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · letto in locale, nessun upload`;
  log(`Avvio ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
  const t0 = performance.now();
  worker = new Worker('./gaemboy3ds-worker.js?v=14', { type: 'module' });
  $('selection-view').hidden = $('selection-footer').hidden = true;
  $('game-view').hidden = false;
  document.body.classList.add('playing');
  dispatchEvent(new CustomEvent('gaemboy3ds:game-booting', { detail: { name: file.name, gameKey: activeGameKey, gamePath: activeGameKey ? (libGames.has(activeGameKey) ? gamePath(libGames.get(activeGameKey)) : '') : '' } }));
  $('game-title').textContent = file.name;
  $('notice').hidden = true;
  $('game-status').textContent = 'Caricamento…';
  canvas.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  renderLibrary();
  worker.onerror = (e) => {
    watchdog.reported = true;
    const msg = `${e.message || 'errore sconosciuto'} (${e.filename || '?'}:${e.lineno || '?'})`;
    log(`[worker] ${msg}`);
    $('game-status').textContent = 'Errore: apri il Menu per cambiare gioco.';
    resetInput();
    $('touch-controls').disabled = true;
    notice(`Il worker dell'emulatore si è interrotto: ${msg}`, 'bad');
    failRequests(`Worker interrotto: ${msg}`);
  };
  worker.onmessageerror = () => {
    log('[worker] messaggio non deserializzabile');
    failRequests('Risposta del worker non leggibile.');
  };
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'logs':
        for (const line of data.lines) log(line);
        if (data.dropped) log(`… ${data.dropped} righe di log omesse`);
        logTotal = data.total;
        break;
      case 'error':
        $('game-status').textContent = 'Caricamento non riuscito: apri il Menu per cambiare gioco.';
        notice(`Errore nel caricamento del modulo: ${data.message}`, 'bad');
        log(`[errore] ${data.message}`);
        failRequests(data.message);
        break;
      case 'warning':
        featureMessage(data.message, true);
        break;
      case 'response': {
        const request = pendingRequests.get(data.id);
        if (!request) break;
        pendingRequests.delete(data.id);
        if (data.ok) request.resolve(data.result);
        else request.reject(new Error(data.error));
        break;
      }
      case 'perf':
        onPerf(data);
        break;
      case 'saved':
        $('s-saves').textContent = data.ok ? `ok ${new Date().toLocaleTimeString()}` : `errore: ${data.error}`;
        if (!data.ok) notice(`Impossibile conservare i salvataggi nel browser: ${data.error}`, 'bad');
        break;
      case 'ready':
        memory = data.memory;
        base = data.state;
        gb15ApplySpeed();
        cameraBuffer = data.cameraBuffer;
        if (data.stateSize !== STATE_SIZE) {
          notice(`Struct condivisa incoerente (${data.stateSize} B, attesi ${STATE_SIZE}): ricompila.`, 'bad');
          return;
        }
        log(`Modulo WASM pronto in ${(performance.now() - t0).toFixed(0)} ms`);
        bench.startedAt = performance.now();
        for (const id of ['throttle', 'audio', 'save']) $(id).disabled = false;
        storageAvailable = !data.storageError;
        if (data.storageError) featureMessage(`Salvataggi non disponibili: ${data.storageError}`, true);
        refreshFeatureControls();
        if (storageAvailable && readI('status') === 2) initializeFeatures();
        initAudio();
        requestAnimationFrame(frame);
        setInterval(updateStats, 250);
        break;
      default:
        break;
    }
  };
  // ?args=a,b passes extra argv to the frontend (e.g. --io-selftest for large-file diagnostics).
  const extraArgs = (new URLSearchParams(location.search).get('args') || '').split(',').filter(Boolean);
  if (useSw) extraArgs.push('--sw');
  // ?cpu=NN underclocks the emulated CPU (Citra's classic fix for CPU-bound heavy games).
  const cpuClock = parseInt(new URLSearchParams(location.search).get('cpu'), 10);
  if (cpuClock >= 25 && cpuClock <= 400) {
    extraArgs.push(`--opt=citra_cpu_clock_percentage=${cpuClock}`);
    log(`[gaemboy] clock CPU emulata al ${cpuClock}%`);
  }
  // ?stream=ring restores the old ring-buffer upload path (default: orphan every upload).
  if (new URLSearchParams(location.search).get('stream') === 'ring') extraArgs.push('--stream=ring');
  // ?shaders=sync disables background shader linking (default: async, draws skipped until ready).
  if (new URLSearchParams(location.search).get('shaders') === 'sync') extraArgs.push('--shaders=sync');
  let offscreen = null;
  if (!useSw && canvas.transferControlToOffscreen) {
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch (err) {
      log(`[video] OffscreenCanvas non disponibile, uso software: ${err.message}`);
    }
  }
  // Ask to keep site storage (saves and the local ROM copy) from being evicted under pressure.
  navigator.storage?.persist?.().catch(() => {});
  if (offscreen) {
    worker.postMessage({ type: 'boot', file, extraArgs, managedCache, canvas: offscreen }, [offscreen]);
  } else {
    if (!extraArgs.includes('--sw')) extraArgs.push('--sw');
    worker.postMessage({ type: 'boot', file, extraArgs, managedCache });
  }
}

// ---------------------------------------------------------------- video + input loop
let lastSeq = 0;
let lastMsgSeq = 0;
let image = null;
let keyButtons = 0;
const keySticks = new Set();
let padName = '';

function readGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = [...pads].find((p) => p && p.connected);
  if (!pad) {
    padName = '';
    return { buttons: 0, axes: [0, 0, 0, 0] };
  }
  padName = pad.id;
  let buttons = 0;
  for (const [idx, id] of Object.entries(PAD_BUTTONS)) {
    const b = pad.buttons[idx];
    if (b && (b.pressed || b.value > 0.5)) buttons |= 1 << id;
  }
  const axes = [0, 1, 2, 3].map((i) => {
    const v = pad.axes[i] || 0;
    return Math.abs(v) < PAD_DEADZONE ? 0 : v;
  });
  return { buttons, axes };
}

function frame() {
  const acceptingInput = !gameMenu.open && !document.hidden && readI('status') === 2;
  const pad = acceptingInput ? readGamepad() : { buttons: 0, axes: [0, 0, 0, 0] };
  const touch = touchControls.read();
  writeI('buttons', acceptingInput ? keyButtons | pad.buttons | touch.buttons : 0);
  const key = { analogLX: 0, analogLY: 0, analogRX: 0, analogRY: 0 };
  for (const code of keySticks) {
    const [axis, dir] = STICK_KEYS[code];
    key[axis] += dir;
  }
  const axis = (k, index) => writeI(k, acceptingInput
    ? Math.round(Math.max(-1, Math.min(1, key[k] || touch.axes[index] || pad.axes[index])) * 0x7fff) : 0);
  axis('analogLX', 0);
  axis('analogLY', 1);
  axis('analogRX', 2);
  axis('analogRY', 3);

  // video (in WebGL2 mode the worker draws directly onto the OffscreenCanvas)
  if (ctx) {
    const seq = readI('frameSeq');
    if (seq !== lastSeq) {
      lastSeq = seq;
      const w = readI('fbWidth');
      const h = readI('fbHeight');
      const ptr = readI('fbPtr');
      if (w > 0 && h > 0) {
        if (!image || image.width !== w || image.height !== h) {
          canvas.width = w;
          canvas.height = h;
          image = new ImageData(w, h);
        }
        image.data.set(u8().subarray(ptr, ptr + w * h * 4));
        ctx.putImageData(image, 0, 0);
      }
    }
  }
  requestAnimationFrame(frame);
}

function updateStats() {
  const status = readI('status');
  refreshFeatureControls();
  const frames = readI('framesTotal');
  const fps = readF('emuFps');
  const avgMs = readF('avgFrameMs');
  const audio = readI('audioFrames');
  const elapsed = (performance.now() - bench.startedAt) / 1000;
  const speed = (100 * fps) / NATIVE_FPS;
  const buffered = (readI('audioWrite') - readI('audioRead')) >>> 0;
  $('s-status').textContent = STATUS[status] ?? status;
  $('game-status').textContent = status === 2 ? ((managedCachePct ?? romCopyPct) != null && (managedCachePct ?? romCopyPct) < 100 ? `Prima partita: copia locale del gioco ${managedCachePct ?? romCopyPct}%` : '') : status === 3 ? 'Errore: apri il Menu per cambiare gioco.' : 'Caricamento…';
  $('s-renderer').textContent = ctx ? 'Software (CPU)' : 'WebGL2 (GPU)';
  $('s-status').className = status === 2 ? 'good' : status === 3 ? 'bad' : 'mid';
  $('s-load').textContent = readF('loadMs') ? `${readF('loadMs').toFixed(0)} ms` : '—';
  $('s-frames').textContent = frames;
  $('s-fps').textContent = fps.toFixed(1);
  $('s-speed').textContent = `${speed.toFixed(0)}%`;
  $('s-speed').className = speed >= 95 ? 'good' : speed >= 60 ? 'mid' : 'bad';
  $('s-ms').textContent = `${avgMs.toFixed(1)} ms (budget 16,7)`;
  $('s-audio').textContent = audio
    ? `${(audio / AUDIO_HZ).toFixed(1)} s · buffer ${((1000 * buffered) / AUDIO_HZ).toFixed(0)} ms${audioOn ? '' : ' · muto'}`
    : `nessun campione${audioOn ? '' : ' · muto'}`;
  $('s-input').textContent = padName ? `tastiera + ${padName.slice(0, 28)}` : 'tastiera + touch';
  $('s-mem').textContent = `${navigator.hardwareConcurrency} core · ${(memory.buffer.byteLength / 1048576).toFixed(0)} MB`;
  const now = performance.now();
  if (now - logRate.t >= 2000) {
    logRate = { t: now, total: logTotal, perSec: ((logTotal - logRate.total) * 1000) / (now - logRate.t) };
  }
  $('s-log').textContent = `${logRate.perSec.toFixed(0)} righe/s`;
  $('s-log').className = logRate.perSec > 50 ? 'mid' : '';
  const msgSeq = readI('messageSeq');
  if (msgSeq !== lastMsgSeq) {
    lastMsgSeq = msgSeq;
    const bytes = u8().slice(base + OFF.message, base + OFF.message + 256);
    const msg = new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
    log(`[core] ${msg}`);
    notice(msg, status === 3 || /encrypt|fail|error|unable|not supported/i.test(msg) ? 'bad' : 'info');
  }
  if (status === 3 && $('notice').hidden) notice('Il core non è riuscito a caricare il file (Menu → Avanzate).', 'bad');
  bench.frames.push({ t: elapsed, frames, fps, avgMs, audioSeconds: audio / AUDIO_HZ, status });
  if (bench.frames.length > 4000) bench.frames.splice(0, bench.frames.length - 4000);
  checkFreeze(status, frames, now);
}

// Watchdog: the stats above are read from shared memory, so they keep updating even when the
// emulator thread is stuck — a frame counter that stops while "running" means a freeze.
const watchdog = { frames: -1, since: 0, reported: false };
function checkFreeze(status, frames, now) {
  if (status !== 2 || frames !== watchdog.frames) {
    if (watchdog.reported && status === 2) {
      log(`[watchdog] l'emulazione è ripartita (frame ${frames})`);
      notice('L\'emulazione è ripartita.', 'info');
    }
    watchdog.frames = frames;
    watchdog.since = now;
    watchdog.reported = false;
    return;
  }
  if (!watchdog.reported && now - watchdog.since > 5000 && !document.hidden) {
    watchdog.reported = true;
    log(`[watchdog] nessun frame da ${((now - watchdog.since) / 1000).toFixed(1)} s (fermo a ${frames})`);
    notice(`L'emulazione sembra bloccata (frame fermi a ${frames}). Apri Menu → Avanzate per scaricare il log.`, 'bad');
  }
}

// Per-second breakdown sent by the worker (see gaemboy3ds-worker.js): kept for the log export.
const perfHistory = [];
let romCopyPct = null;
function onPerf(p) {
  const t = bench.startedAt ? (performance.now() - bench.startedAt) / 1000 : 0;
  perfHistory.push({ t: Math.round(t * 10) / 10, ...p });
  romCopyPct = p.romCopy;
  if (perfHistory.length > 900) perfHistory.splice(0, perfHistory.length - 900);
  const glTotal = Object.values(p.gl).reduce((a, b) => a + b, 0);
  const links = p.compiles.linkProgram || 0;
  const el = $('s-perf');
  el.textContent = `GL ${glTotal.toFixed(0)} ms/s · shader ${(p.gl.shader || 0).toFixed(0)} ms` +
    `${links ? ` (${links} link)` : ''} · file ${p.fileMs} ms` +
    `${p.romCopy != null && p.romCopy < 100 ? ` · copia ROM ${p.romCopy}%` : ''} · frame max ${p.tickMax} ms`;
  el.className = p.tickMax > 100 ? 'bad' : p.tickMax > 34 ? 'mid' : '';
  for (const l of p.long) log(`[perf] chiamata lenta: ${l}`);
}

function downloadLog() {
  const report = {
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    url: location.href,
    renderer: ctx ? 'software' : 'webgl2',
    rom: $('rom-info').textContent,
    notice: $('notice').hidden ? '' : $('notice').textContent,
    watchdog,
    stats: bench.frames.slice(-240),
    perf: perfHistory,
    logs: logHistory,
  };
  const blob = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gaemboy3ds-log-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('dl-log').onclick = downloadLog;

// ---------------------------------------------------------------- simple, persistent ROM library
// Only the catalog and ROM cache live in browser storage. IDBFS saves are never evicted.
const libGames = new Map();
const sessionFiles = new Map();
let activeGameKey = null;
let pendingImportKey = null;
let cacheBusy = false;
let managedCachePct = null;
let importQueue = Promise.resolve();
const CACHE_LAST_ERROR = 'gb3-cache-last-error';
const CACHE_PENDING_COPY = 'gb3-cache-pending-copy';
function getCachePreference(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function writeCachePreference(key, value) {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* private browsing */ }
}
const interruptedCopy = getCachePreference(CACHE_PENDING_COPY);
const previousCacheMessage = interruptedCopy
  ? `La copia di «${interruptedCopy}» è stata interrotta. Reimporta la ROM per riprenderla.`
  : getCachePreference(CACHE_LAST_ERROR);
const libState = { ready: false, used: 0, limit: ROM_LIMIT, status: '', premium: false, maxGb: 3, selectedGb: 3, copying: false, copyingKey: null, copyingName: '', copyProgress: null, cacheMessage: previousCacheMessage };
function cacheNotice(message) {
  libState.cacheMessage = message;
  writeCachePreference(CACHE_LAST_ERROR, message);
}
let verifiedGrant = null;
let selectedTierInMemory = null;
const CACHE_PREF = 'gb3-cache-preferred-tier';
// Only a signed, short-lived grant issued by Gaemboy can unlock the 5/8 GB tiers.
// A direct visit without a grant ALWAYS starts with the free 3 GiB limit.
async function restorePremiumGrant() {
  try {
    const hash = new URLSearchParams(location.hash.slice(1));
    const fresh = hash.get('gb3ds_access');
    let token = fresh || (history.state && history.state.gb3dsAccessToken) || null;
    if (fresh) {
      // Keep the grant out of address bar, referrers and copy-pasted links.
      hash.delete('gb3ds_access');
      const nextHash = hash.toString();
      history.replaceState({ ...(history.state || {}), gb3dsAccessToken: fresh }, '',
        location.pathname + location.search + (nextHash ? '#' + nextHash : ''));
    }
    if (token) verifiedGrant = await verifyGaemboyGrant(token, GAEMBOY_PREMIUM_PUBLIC_JWK);
  } catch (error) {
    verifiedGrant = null;
    log('[premium] Accesso non verificato, limite gratuito: ' + error.message);
    // Clear invalid or expired grants. Never persist Premium credentials in localStorage.
    const current = { ...(history.state || {}) };
    delete current.gb3dsAccessToken;
    history.replaceState(current, '', location.pathname + location.search + location.hash);
  }
  updatePremiumCacheLimit();
}
function updatePremiumCacheLimit() {
  const active = verifiedGrant?.exp > Date.now() / 1000 ? verifiedGrant : null;
  libState.premium = Boolean(active);
  libState.maxGb = active?.maxGb || 3;
  let requested = selectedTierInMemory ?? 3;
  try { requested = selectedTierInMemory ?? Number(localStorage.getItem(CACHE_PREF) || 3); } catch { /* Private mode */ }
  libState.selectedGb = allowedCacheGb(active, requested);
  libState.limit = libState.selectedGb * GIB;
  return libState.limit;
}
function choosePremiumCacheGb(value) {
  updatePremiumCacheLimit();
  const requested = Number(value);
  if (![3, 5, 8].includes(requested) || requested > libState.maxGb) return false;
  selectedTierInMemory = requested;
  try { localStorage.setItem(CACHE_PREF, String(requested)); } catch { /* Private mode: selection lasts only for this page */ }
  updatePremiumCacheLimit();
  void updateSpace();
  return true;
}
const premiumReady = restorePremiumGrant();


function libStatus(message, error = false) {
  libState.status = message;
  $('lib-status').textContent = message;
  $('lib-status').className = error ? 'bad' : '';
  dispatchEvent(new CustomEvent('gaemboy3ds:library-updated', { detail: { ...libState } }));
}
function formatSize(bytes) {
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(0)} MB`;
}
const gamePath = g => `${g.key.slice(0, 12)}/${g.name}`;
async function updateSpace() {
  try {
    const usage = await cacheUsage();
    libState.used = usage.used;
    updatePremiumCacheLimit();
    libState.supported = usage.supported;
    if (!cacheBusy) libState.copyProgress = null;
  } catch (error) {
    libState.supported = false;
    log('[cache] Impossibile leggere lo spazio: ' + (error.message || error));
  }
  dispatchEvent(new CustomEvent('gaemboy3ds:cache-usage', { detail: { ...libState } }));
}
function renderLibrary() {
  const list = $('lib-list');
  list.replaceChildren();
  $('library').hidden = false;
  $('lib-forget').hidden = true;
  $('lib-refresh').hidden = true;
  $('lib-filter').hidden = libGames.size < 8;
  const query = $('lib-filter').value.trim().toLowerCase();
  for (const game of [...libGames.values()].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))) {
    if (query && !game.name.toLowerCase().includes(query)) continue;
    const item = document.createElement('li');
    item.dataset.gamePath = gamePath(game);
    item.dataset.gameTitle = game.name.replace(/\.(3ds|cci|cxi|app|3dsx|elf)$/i, '').replace(/[._]/g,' ');
    item.dataset.cached = game.cached ? 'true' : 'false';
    item.dataset.copying = libState.copying && libState.copyingKey === game.key ? 'true' : 'false';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = 'Gioca'; // The existing home adapter recognizes this action.
    play.title = item.dataset.copying === 'true' ? 'Attendi la fine dell’importazione' : game.cached ? 'Gioca' : 'Importa nuovamente la ROM';
    play.disabled = !!worker;
    play.onclick = () => void launchLibraryGame(game.key);
    const label = document.createElement('span'); label.className = 'game'; label.textContent = game.name;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `${formatSize(game.size)} · ${item.dataset.copying === 'true' ? 'Importazione in corso' : game.cached ? 'Pronto per giocare' : 'Da reimportare'}`;
    item.append(play, label, meta); list.append(item);
  }
  dispatchEvent(new CustomEvent('gaemboy3ds:library-updated', { detail: { ...libState } }));
}

async function restoreCacheCatalog() {
  try {
    const saved = await listCatalog();
    for (const game of saved) {
      // A partially-written mirror must never be presented as a playable ROM.
      let cached = false;
      try { cached = Boolean(await cachedFile(game)); }
      catch (error) { log('[cache] Lettura ' + game.name + ': ' + error.message); }
      libGames.set(game.key, { ...game, cached });
    }
    libState.ready = true;
    renderLibrary();
    await premiumReady;
    await updateSpace();
    libStatus(saved.length ? `${saved.length} giochi nella libreria.` : 'Premi + Aggiungi gioco per iniziare.');
  } catch (error) { libStatus(`Libreria locale non disponibile: ${error.message}`, true); }
}

function openRomPickerFor(game) {
  // This path runs synchronously from the user's click so Safari can open Finder.
  pendingImportKey = game.key;
  const message = `La ROM di «${game.name}» non è disponibile nella memoria locale.\n\nImporta nuovamente lo stesso file per ripristinarla. I salvataggi resteranno disponibili.`;
  window.alert(message);
  libStatus(`Importa nuovamente «${game.name}». I salvataggi sono conservati.`);
  $('file').multiple = false;
  $('file').value = '';
  $('file').click();
  return 'needs-reimport';
}
async function launchLibraryGame(key) {
  if (worker) return 'already-playing';
  const game = libGames.get(key);
  if (!game) return 'missing-game';
  if (libState.copying && libState.copyingKey === key) {
    libStatus(`Importazione di «${game.name}» in corso (${libState.copyProgress ?? 0}%). Attendi prima di avviare.`);
    return 'importing';
  }
  // Do not fall back to the picker File: it can be revoked after import, and
  // doing so misleadingly marks an uncached ROM as playable after a refresh.
  if (!game.cached) return openRomPickerFor(game);
  let file = null;
  try { file = await cachedFile(game); }
  catch (error) { log(`[cache] Lettura ROM archiviata: ${error?.name || error?.message || error}`); }
  if (!file) {
    game.cached = false;
    renderLibrary();
    return openRomPickerFor(game);
  }
  try {
    await ensureAudio();
    activeGameKey = key;
    boot(file, true); // Reuse verified cache; never create a second mirror.
    game.lastPlayed = Date.now();
    await putCatalogGame({ key: game.key, name: game.name, size: game.size,
      lastModified: game.lastModified, addedAt: game.addedAt, lastPlayed: game.lastPlayed });
    return 'started';
  } catch (error) {
    libStatus(`Impossibile avviare «${game.name}»: ${error.message}`, true);
    return 'failed';
  }
}

function queueCache(file, game) {
  importQueue = importQueue.then(async () => {
    cacheBusy = true;
    libState.copying = true;
    libState.copyingKey = game.key;
    libState.copyingName = game.name;
    libState.copyProgress = 0;
    game.cached = false;
    renderLibrary();
    cacheNotice('');
    writeCachePreference(CACHE_PENDING_COPY, game.name);
    try {
      libStatus(`Salvataggio locale di «${game.name}» in corso…`);
      await premiumReady;
      const limitBytes = updatePremiumCacheLimit();
      const previousUsage = libState.used;
      let lastProgressUpdate = 0;
      const result = await cacheRom(file, game, {
        limitBytes,
        activeKeys: new Set(activeGameKey ? [activeGameKey] : []),
        confirmEviction: async (evict) => {
          // First eviction is explained; future evictions are automatic once accepted.
          if (localStorage.getItem('gb3-cache-auto-evict') === '1') return true;
          const bytes = evict.reduce((n, x) => n + x.bytes, 0);
          const agreed = confirm(`Per conservare questo gioco, Gaemboy libererà ${formatSize(bytes)} di cache delle ROM meno usate.\n\nLe card e tutti i salvataggi restano disponibili.\n\nProcedere? (La prossima volta sarà automatico)`);
          if (agreed) localStorage.setItem('gb3-cache-auto-evict', '1');
          return agreed;
        },
        onProgress: (fraction, copiedBytes, totalBytes, resumedBytes = 0) => {
          managedCachePct = Math.floor(fraction * 100);
          libState.copyProgress = managedCachePct;
          // The OPFS writer can be mid-transaction. Reflect its observed progress
          // without treating a partial .bin as a reusable ROM.
          libState.used = Math.min(libState.limit, Math.max(previousUsage, previousUsage + Math.max(0, copiedBytes - resumedBytes)));
          const now = Date.now();
          if (now - lastProgressUpdate > 350 || fraction === 1) {
            lastProgressUpdate = now;
            dispatchEvent(new CustomEvent('gaemboy3ds:cache-usage', { detail: { ...libState } }));
          }
          const phase = prefersSequentialCache() ? "preparazione prima dell’avvio" : "puoi continuare a giocare";
          libStatus(`Salvataggio di «${game.name}»: ${Math.floor(fraction * 100)}% · ${phase}`);
        },
      });
      if (result.cached) {
        // Never report the ROM as ready until the persisted copy can actually be
        // reopened. On Safari the OPFS / IndexedDB backend may fail late.
        const stored = await cachedFile(game);
        if (!stored) throw new Error('La copia non è leggibile dopo la scrittura. Il file originale resta utilizzabile in questa sessione.');
        // Verify real bytes, not just the OPFS .bin size and completion bitmap.
        if (await romFingerprint(stored) !== game.key) {
          await removeCachedRom(game.key);
          throw new Error('Verifica della copia non riuscita: file locale diverso dalla ROM importata.');
        }
        cacheNotice('');
        game.cached = true;
        libStatus(`«${game.name}» pronto per giocare: premi la sua copertina.`, false);
      } else if (result.reason === 'oversize') {
        libState.cacheMessage = `La ROM supera la cache da ${libState.selectedGb} GB. Il gioco funziona, ma andrà reimportato.`;
        libStatus(libState.cacheMessage, false);
      } else {
        const reasons = {
          'space': 'Spazio insufficiente nel browser per salvare la ROM. Il gioco continua a funzionare.',
          'quota-unavailable': 'Il browser non comunica lo spazio disponibile. Copia locale non eseguita.',
          'unsupported': 'Questo browser non consente l’archiviazione locale delle ROM.',
          'cancelled': 'Pulizia della cache annullata. La ROM non è stata salvata.'
        };
        if (result.reason === 'source-unreadable') {
          const pct = Math.max(0, Math.min(100, Math.floor(100 * (result.bytes || 0) / (result.total || file.size))));
          cacheNotice(`Copia sospesa al ${pct}%: Safari non riesce a leggere il file originale. La parte già copiata è conservata. Reimporta la stessa ROM per riprendere senza perdere i salvataggi.`);
        } else if (result.reason === 'NotReadableError') {
          const stage = result.stage === 'writing' ? 'scrittura OPFS' : 'accesso alla memoria locale';
          cacheNotice(`Copia sospesa: errore durante ${stage} (NotReadableError). La ROM non è ancora riapribile. La parte copiata resta disponibile per il prossimo tentativo.`);
        } else {
          cacheNotice(reasons[result.reason] || `La ROM non è stata memorizzata (${result.reason}).`);
        }
        libStatus(libState.cacheMessage, false);
      }
    } catch (error) {
      cacheNotice(`Copia non riuscita: ${error.message}`);
      libStatus(`Puoi continuare a giocare, ma ${libState.cacheMessage}`, true);
    } finally {
      cacheBusy = false;
      writeCachePreference(CACHE_PENDING_COPY, '');
      libState.copying = false;
      libState.copyingKey = null;
      libState.copyingName = '';
      libState.copyProgress = null;
      // The picker File is temporary; a game is playable after refresh ONLY
      // if the independently verified persistent cache is available.
      sessionFiles.delete(game.key);
      managedCachePct = null;
      await updateCacheFlags();
    }
  }).catch(error => { log('[cache] ' + error); });
  return importQueue;
}

async function updateCacheFlags() {
  for (const game of libGames.values()) {
    try { game.cached = Boolean(await cachedFile(game)); }
    catch { game.cached = false; }
  }
  renderLibrary();
  await updateSpace();
}

async function importFiles(files, requestedKey = null) {
  const valid = Array.from(files || []).filter(validRom);
  if (!valid.length) { libStatus('Seleziona una ROM 3DS valida.', true); return; }
  if (requestedKey && valid.length !== 1) { libStatus('Seleziona soltanto la ROM richiesta.', true); return; }
  for (const file of valid) {
    try {
      const id = await romFingerprint(file);
      if (requestedKey && requestedKey !== id) {
        libStatus('La ROM selezionata è differente. Importa lo stesso file per mantenere i salvataggi.', true);
        return;
      }
      const game = await registerRom(file, id);
      game.cached = Boolean(await cachedFile(game));
      libGames.set(game.key, game);
      // A card appears immediately. Import does NOT start the emulator.
      renderLibrary();
      if (!game.cached) {
        sessionFiles.set(game.key, file);
        await queueCache(file, game);
      } else {
        libStatus(`«${game.name}» già nella cache. Clicca la copertina per giocare.`);
      }
    } catch (error) {
      cacheNotice(`Importazione non riuscita: ${error?.name || 'Errore'} (${error?.message || error}).`);
      libStatus(libState.cacheMessage, true);
    }
  }
  renderLibrary();
}

$('lib-filter').oninput = renderLibrary;
$('pick').onclick = () => {
  pendingImportKey = null;
  $('file').multiple = true;
  $('file').value = '';
  $('file').click();
};
$('file').accept = '.3ds,.cci,.cxi,.app,.3dsx,.elf';
$('file').onchange = e => {
  const pending = pendingImportKey;
  pendingImportKey = null;
  void importFiles(e.target.files, pending);
};
$('file').addEventListener('cancel', () => { pendingImportKey = null; dispatchEvent(new Event('gaemboy3ds:picker-cancelled')); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); if (!worker) void importFiles(e.dataTransfer?.files); });

// Expiring entitlements downgrade the next cache operation to 3 GiB automatically.
setInterval(() => {
  if (libState.premium && verifiedGrant?.exp <= Date.now() / 1000) void updateSpace();
}, 60000);

window.Gaemboy3DSCacheLibrary = {
  enabled: true,
  chooseCacheGb: choosePremiumCacheGb,
  status: () => ({ ...libState, games: libGames.size, copying: cacheBusy }),
  add: () => $('pick').click(),
  // Files chosen by the Gaemboy host (e.g. iframe integration): import, don't boot.
  importRomFiles: files => importFiles(files),
  launch: async path => {
    const game = [...libGames.values()].find(g => gamePath(g) === path);
    return game ? launchLibraryGame(game.key) : 'missing-game';
  },
  fileForCover: async path => {
    const game = [...libGames.values()].find(g => gamePath(g) === path);
    return game ? (sessionFiles.get(game.key) || await cachedFile(game)) : null;
  },
  remove: async path => {
    const game = [...libGames.values()].find(g => gamePath(g) === path);
    if (!game || game.key === activeGameKey || cacheBusy) return false;
    await removeCachedRom(game.key);
    await deleteCatalogGame(game.key);
    libGames.delete(game.key); sessionFiles.delete(game.key);
    await updateCacheFlags();
    return true;
  },
  refresh: updateCacheFlags,
};
// Cross-origin embed: the Gaemboy host must open the file picker itself from a
// user gesture, then send the selected File objects with postMessage. Triggering
// a remote picker via postMessage can be blocked by browser user-activation rules.
// Ignore all other origins and non-File payloads; never accept remote URLs.
const allowedGaemboyHosts = new Set([location.origin, 'https://gaemboy.com', 'https://www.gaemboy.com']);
addEventListener('message', event => {
  if (event.source !== window.parent || !allowedGaemboyHosts.has(event.origin)) return;
  const data = event.data;
  if (!data || data.type !== 'gaemboy3ds:import-rom-files' || !Array.isArray(data.files)) return;
  if (data.files.length < 1 || data.files.length > 30 ||
      !data.files.every(file => typeof File !== 'undefined' && file instanceof File)) return;
  void importFiles(data.files);
});
void restoreCacheCatalog();

// ---------------------------------------------------------------- UI
async function startDemo(name) {
  ensureAudio();
  try {
    const res = await fetch(`./homebrew/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    boot(new File([await res.blob()], name));
  } catch (err) {
    notice(`Impossibile aprire la demo ${name}: ${err.message}. Usa «Apri ROM».`, 'bad');
  }
}
$('demo').onclick = () => startDemo($('demo').dataset.file);
$('demo3d').onclick = () => startDemo($('demo3d').dataset.file);
// Hosted builds only ship redistributable demos: hide buttons whose file is not deployed.
function hideEmptyDemos() {
  const picker = document.querySelector('.demo-picker');
  if (picker && ['demo', 'demo3d'].every((id) => $(id).hidden)) picker.hidden = true;
}
for (const id of ['demo', 'demo3d']) {
  const hide = () => { $(id).hidden = true; hideEmptyDemos(); };
  fetch(`./homebrew/${$(id).dataset.file}`, { method: 'HEAD' })
    .then((r) => { if (!r.ok) hide(); })
    .catch(hide);
}
$('throttle').onclick = () => {
  gb15SpeedEnabled = !gb15SpeedEnabled;
  const speed=gb15ApplySpeed();
  $('throttle').textContent = speed === 1 ? 'Velocità: 60 fps' : `Velocità richiesta: ${String(speed).replace('.',',')}×`;
};
$('audio').onclick = async () => {
  audioOn = !audioOn;
  await ensureAudio();
  if (audioNode) audioNode.port.postMessage({ type: 'mute', muted: !audioOn });
  if (audioCtx) audioCtx.resume();
  $('audio').textContent = audioOn ? 'Audio: on' : 'Audio: off';
};
$('save').onclick = () => worker && worker.postMessage({ type: 'sync' });
function openGameMenu() {
  if (!document.body.classList.contains('playing') || gameMenu.open) return;
  resetInput();
  gb13CloseSettings();
  gb15CloseSpeedPanel();
  gb17CloseCheats();
  $('menu-title').textContent = $('game-title').textContent || 'Gioco in pausa';
  gameMenu.showModal();
  refreshFeatureControls();
  renderKeyboardBindings();
}
$('open-menu').onclick = openGameMenu;
$('close-menu').onclick = () => { cancelRemap(); gameMenu.close(); };
$('keyboard-reset').onclick = () => {
  resetInput();
  keyboardBindings = defaults();
  ({buttons: KEYMAP, sticks: STICK_KEYS} = toMaps(keyboardBindings));
  mappingAction = null;
  persistKeyboardBindings();
  $('keymap-status').textContent = 'Tasti predefiniti ripristinati.';
  renderKeyboardBindings();
};
// Escape is reserved for the game menu, never a configurable gameplay key.
window.addEventListener('keydown', (event) => {
  if (mappingAction) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === 'Escape') { cancelRemap(); return; }
    if (event.repeat) return;
    const updated = remap(keyboardBindings, mappingAction, event.code);
    if (!updated) { $('keymap-status').textContent = 'Tasto non disponibile. Scegli una lettera, numero, freccia o Invio.'; return; }
    resetInput();
    keyboardBindings = updated;
    ({buttons: KEYMAP, sticks: STICK_KEYS} = toMaps(keyboardBindings));
    mappingAction = null;
    persistKeyboardBindings();
    $('keymap-status').textContent = 'Tasto aggiornato.';
    renderKeyboardBindings();
    return;
  }
  if (event.code !== 'Escape' || !document.body.classList.contains('playing')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (gameMenu.open) gameMenu.close(); else openGameMenu();
}, { capture: true });
gameMenu.addEventListener('cancel', (e) => {
  if (mappingAction) { e.preventDefault(); cancelRemap(); }
});
gameMenu.addEventListener('close', () => {
  gb17CloseCheats();
  gb14CloseGallery();
  gb13CloseSettings();
  gb15CloseSpeedPanel();
  mappingAction = null;
  resetInput();
  refreshFeatureControls();
  canvas.focus({ preventScroll: true });
});
// ---------------------------------------------------------------- Gaemboy-style pause menu (Patch 13)
// The quick buttons delegate to the existing, tested 3DS handlers. No duplicate
// save-state format, new emulator inputs or new unsupported link implementation.
function gb13Feedback(message, error = false) {
  const node = $('gb13-quick-status');
  node.textContent = message;
  node.classList.toggle('bad', error);
}
function gb13CloseSettings() {
  gameMenu.classList.remove('gb13-settings-open');
  $('gb13-settings-panel').hidden = true;
  $('gb13-pause-actions').hidden = false;
  $('gb13-settings-title').textContent = 'Impostazioni';
}
function gb13OpenSettings(title = 'Impostazioni', detailsId = null) {
  gb17CloseCheats();
  gb14CloseGallery();
  gb15CloseSpeedPanel();
  gameMenu.classList.add('gb13-settings-open');
  $('gb13-settings-panel').hidden = false;
  $('gb13-pause-actions').hidden = true;
  $('gb13-settings-title').textContent = title;
  for (const panel of $('gb13-settings-panel').querySelectorAll('details')) panel.open = false;
  if (detailsId) {
    const panel = $(detailsId);
    if (panel) { panel.open = true; panel.scrollIntoView({block:'nearest',behavior:'auto'}); }
  }
  $('gb13-settings-back').focus({preventScroll:true});
}
function gb13UpdateQuickAvailability() {
  const running = !!memory && readI('status') === 2;
  const readyToSave = running && storageAvailable && !featureBusy;
  $('gb13-quick-save').disabled = !readyToSave || $('state-save').disabled;
  $('gb13-quick-load').disabled = !readyToSave;
  $('gb13-quick-fast').disabled = !running;
  $('gb13-quick-mic').disabled = !running || mediaBusy;
  // Link-cable emulation is not implemented by the Azahar web core.
  $('gb13-quick-link').disabled = true;
  $('gb13-quick-fast').setAttribute('aria-pressed', String(running && gb15SpeedEnabled));
}
$('gb13-settings-back').onclick = gb13CloseSettings;
// UX17: Gaemboy cheat modal appearance, without React or any new core functions.
function gb17ShowCheatForm(show) {
  $('gb17-cheat-form').hidden = !show;
  if (show) gb18RefreshCheatValidation();
  $('gb17-cheat-new').hidden = !!show;
  if (show) $('cheat-name').focus({preventScroll:true});
}
function gb17CloseCheats() {
  $('gb17-cheats-panel').hidden = true;
  gb17ShowCheatForm(false);
  $('gb13-pause-actions').hidden = false;
  $('gb17-cheat-status').textContent = '';
  gameMenu.classList.remove('gb17-cheats-open');
}
async function gb17OpenCheats() {
  gb14CloseGallery();
  gb15CloseSpeedPanel();
  gb13CloseSettings();
  $('gb13-pause-actions').hidden = true;
  $('gb17-cheats-panel').hidden = false;
  gameMenu.classList.add('gb17-cheats-open');
  gb17ShowCheatForm(false);
  try { await performFeature('cheats'); }
  catch (err) { $('gb17-cheat-status').textContent = 'Impossibile leggere i cheat: ' + (err.message || String(err)); }
}
$('gb13-quick-cheats').onclick = () => void gb17OpenCheats();
$('gb17-cheats-back').onclick = gb17CloseCheats;
$('gb17-cheat-new').onclick = () => gb17ShowCheatForm(true);
$('gb17-cheat-cancel').onclick = () => gb17ShowCheatForm(false);
// UX15 speed selection: slider and quick-toggle share the same worker pacing controller.
function gb15CloseSpeedPanel() {
  $('gb15-speed-panel').hidden = true;
  $('gb13-pause-actions').hidden = false;
}
function gb15SpeedText(value) { return value.toFixed(1).replace('.',',')+'×'; }
function gb15UpdateSpeedLabel() {
  $('gb15-speed-output').textContent = gb15SpeedText(Number($('gb15-speed-range').value));
}
$('gb13-quick-speed').onclick = () => {
  gb17CloseCheats();
  gb14CloseGallery();
  gb13CloseSettings();
  $('gb13-pause-actions').hidden = true;
  $('gb15-speed-panel').hidden = false;
  $('gb15-speed-range').value = String(gb15SelectedSpeed);
  gb15UpdateSpeedLabel();
  $('gb15-speed-range').focus({preventScroll:true});
};
$('gb15-speed-back').onclick = gb15CloseSpeedPanel;
$('gb15-speed-range').addEventListener('input',gb15UpdateSpeedLabel);
$('gb15-speed-apply').onclick = () => {
  gb15SelectedSpeed = Number($('gb15-speed-range').value);
  gb15SpeedEnabled = gb15SelectedSpeed !== 1;
  gb15PersistSpeed();
  gb15ApplySpeed();
  gb15CloseSpeedPanel();
  gb13Feedback(`Velocità richiesta: ${gb15SpeedText(gb15EffectiveSpeed())}. La velocità reale dipende dal dispositivo.`);
};
$('gb15-speed-default').onclick = () => {
  $('gb15-speed-range').value = '1';
  $('gb15-speed-apply').click();
};
$('gb13-quick-save').onclick = () => { void gb14OpenGallery('save'); };
$('gb13-quick-load').onclick = () => { void gb14OpenGallery('load'); };
$('gb13-quick-fast').onclick = () => {
  if (!memory || $('gb13-quick-fast').disabled) return;
  $('throttle').click();
  gb13UpdateQuickAvailability();
  gb13Feedback('Velocità richiesta: '+gb15SpeedText(gb15EffectiveSpeed())+'.');
};
$('gb13-quick-mic').onclick = () => {
  if ($('mic-toggle').disabled) return;
  $('mic-toggle').click();
  gb13Feedback('Richiesta microfono avviata.');
};
$('gb13-quick-exit').onclick = () => $('back-library').click();
$('gb13-quick-screenshot').onclick = async () => {
  const blob = await savePreview();
  if (!blob) { gb13Feedback('Screenshot non disponibile con questo renderer.',true); return; }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gaemboy3ds-screenshot-' + Date.now() + '.png';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),60000);
  gb13Feedback('Screenshot acquisito.');
};
// Forward core status messages to the visible quick-action footer.
new MutationObserver(() => {
  if (!gameMenu.open) return;
  const message = $('feature-status').textContent.trim();
  if (message) gb13Feedback(message,$('feature-status').classList.contains('bad'));
}).observe($('feature-status'),{childList:true,characterData:true,subtree:true});

$('back-library').onclick = async () => {
  if (cacheBusy && !confirm('La ROM è ancora in fase di salvataggio. Uscendo adesso la copia resterà incompleta e potrebbe essere necessario reimportarla. Continuare?')) return;
  if (!confirm('Tornare alla selezione giochi? I progressi non salvati nel gioco o in uno stato andranno persi.')) return;
  resetInput();
  if (storageAvailable) {
    const result = await performFeature('sync-saves');
    if (!result) return;
  }
  // A fresh document is required to recreate the worker and its transferred canvas.
  const url = new URL(location.href);
  url.searchParams.delete('demo');
  location.replace(url.href);
};

$('state-slot').onchange = refreshFeatureControls;
async function savePreview() {
  try {
    if (ctx) return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!memory || !base) return null;
    const w = readI('fbWidth'), h = readI('fbHeight'), ptr = readI('fbPtr');
    if (w < 1 || h < 1 || w * h > 4096 * 4096 || ptr < 1 || ptr + w * h * 4 > memory.buffer.byteLength) return null;
    const data = new Uint8ClampedArray(memory.buffer, ptr, w * h * 4).slice();
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
    return await new Promise(resolve => c.toBlob(resolve, 'image/png'));
  } catch { return null; }
}
// Generate the screenshot before saving state, not after resuming gameplay.
// The transferred WebGL canvas belongs to the worker, so prefer a worker snapshot.
async function gb14CapturePreview() {
  let blob = null;
  try { blob = (await requestCommand('capture-preview'))?.preview || null; } catch {}
  if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) blob = await savePreview();
  if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * scale));
    c.height = Math.max(1, Math.round(bitmap.height * scale));
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close?.();
    const compressed = await new Promise(resolve => c.toBlob(resolve, 'image/webp', 0.72));
    if (compressed) blob = compressed;
  } catch { /* A raw WebP preview is better than losing the save. */ }
  return blob.size <= 2 * 1024 * 1024 ? blob : null;
}
async function gb14SaveState(slot, promptOverwrite = true) {
  const entry = slots.find(x => x.slot === slot);
  if (!entry || featureBusy) return false;
  if (entry.exists && promptOverwrite && !confirm(`Sovrascrivere il salvataggio ${slot}?`)) return false;
  const screenshot = await gb14CapturePreview();
  const preview = screenshot ? new Uint8Array(await screenshot.arrayBuffer()) : null;
  const result = await performFeature('save-state', {slot, preview}, 'Salvataggio rapido creato.');
  if (!result) return false;
  if (activeGameKey) {
    const game = libGames.get(activeGameKey);
    if (game) dispatchEvent(new CustomEvent('gaemboy3ds:savestate-saved', {detail: {
      gameKey: gamePath(game), savedAt: Date.now(), screenshot,
    }}));
  }
  return true;
}
async function gb14LoadState(slot) {
  if (!slots.some(x => x.slot === slot && x.exists) || featureBusy) return false;
  const result = await performFeature('load-state', {slot}, 'Salvataggio caricato.');
  if (!result) return false;
  gb14CloseGallery();
  gameMenu.close();
  return true;
}
async function gb14DeleteState(slot) {
  if (!slots.some(x => x.slot === slot && x.exists) || featureBusy) return false;
  if (!confirm(`Eliminare il salvataggio ${slot}? Questa operazione non può essere annullata.`)) return false;
  return !!(await performFeature('delete-state', {slot}, 'Salvataggio eliminato.'));
}
$('state-save').onclick = () => void gb14SaveState(Number($('state-slot').value));
$('state-load').onclick = () => void gb14LoadState(Number($('state-slot').value));
$('state-delete').onclick = () => void gb14DeleteState(Number($('state-slot').value));

let gb14GalleryMode = null;
let gb14GalleryToken = 0;
const gb14PreviewUrls = new Set();
function gb14ClearPreviews() {
  for (const url of gb14PreviewUrls) URL.revokeObjectURL(url);
  gb14PreviewUrls.clear();
}
function gb14CloseGallery() {
  gb14GalleryMode = null;
  gb14GalleryToken++;
  gb14ClearPreviews();
  $('gb14-state-gallery').hidden = true;
  $('gb13-pause-actions').hidden = false;
}
function gb14CreateElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function gb14PreviewPlaceholder(message) {
  const placeholder = gb14CreateElement('span', 'gb14-fallback');
  const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
  icon.setAttribute('viewBox','0 0 24 24'); icon.setAttribute('aria-hidden','true');
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d','M4 5h16v14H4z M7 16l4-4 3 3 2-2 2 3 M8 9h.01');
  icon.append(path);
  placeholder.append(icon, document.createTextNode(message));
  return placeholder;
}
function gb14StateCard(slot, mode, snapshot = null) {
  const node = gb14CreateElement('article','gb14-state-card');
  const preview = gb14CreateElement('div','gb14-state-preview');
  if (snapshot) {
    const image = document.createElement('img');
    const url = URL.createObjectURL(snapshot); gb14PreviewUrls.add(url);
    image.src = url; image.alt = `Anteprima del salvataggio ${slot.slot}`; image.loading = 'lazy';
    preview.append(image);
  } else preview.append(gb14PreviewPlaceholder('Anteprima non disponibile'));
  const details = gb14CreateElement('div','gb14-state-details');
  details.append(gb14CreateElement('strong','',`Salvataggio ${slot.slot}`));
  const date = slot.modified ? new Date(slot.modified).toLocaleString('it-IT',{dateStyle:'medium',timeStyle:'short'}) : '';
  details.append(gb14CreateElement('small','',date));
  const actions = gb14CreateElement('div','gb14-state-actions');
  const main = gb14CreateElement('button','', mode === 'load' ? 'Carica' : 'Sovrascrivi');
  main.type = 'button';
  main.onclick = async () => {
    const ok = mode === 'load' ? await gb14LoadState(slot.slot) : await gb14SaveState(slot.slot);
    if (ok && mode === 'save') void gb14RenderGallery();
  };
  actions.append(main);
  if (mode === 'save') {
    const remove = gb14CreateElement('button','gb14-delete','Elimina');
    remove.type = 'button'; remove.setAttribute('aria-label', `Elimina salvataggio ${slot.slot}`);
    remove.onclick = async () => { if (await gb14DeleteState(slot.slot)) void gb14RenderGallery(); };
    actions.append(remove);
  }
  node.append(preview,details,actions);
  return node;
}
async function gb14RenderGallery() {
  const mode = gb14GalleryMode;
  if (!mode) return;
  const token = ++gb14GalleryToken;
  gb14ClearPreviews();
  const list = $('gb14-gallery-list'); list.replaceChildren();
  const existing = slots.filter(x => x.exists).sort((a,b)=>(b.modified || 0)-(a.modified || 0));
  $('gb14-gallery-count').textContent = `${existing.length} / ${slots.length} salvataggi`;
  $('gb14-gallery-title').textContent = mode === 'save' ? 'Salvataggio rapido' : 'Caricamento rapido';
  $('gb14-gallery-message').textContent = '';
  if (mode === 'save') {
    const free = slots.find(x => !x.exists);
    if (free) {
      const card = gb14CreateElement('article','gb14-state-card gb14-create');
      const preview = gb14CreateElement('div','gb14-state-preview');
      preview.append(gb14PreviewPlaceholder('+ Nuovo salvataggio'));
      const details = gb14CreateElement('div','gb14-state-details');
      details.append(gb14CreateElement('strong','','Salva senza sovrascrivere'));
      const actions = gb14CreateElement('div','gb14-state-actions');
      const add = gb14CreateElement('button','','Salva ora'); add.type = 'button';
      add.onclick = async () => { if (await gb14SaveState(free.slot, false)) void gb14RenderGallery(); };
      actions.append(add); card.append(preview,details,actions); list.append(card);
    } else $('gb14-gallery-message').textContent = 'Archivio pieno: seleziona un salvataggio da sovrascrivere o eliminare.';
  }
  if (!existing.length && mode === 'load') {
    $('gb14-gallery-message').textContent = 'Nessun salvataggio rapido. Creane uno dal menu di pausa.';
    return;
  }
  for (const slot of existing) {
    if (token !== gb14GalleryToken || mode !== gb14GalleryMode) return;
    let image = null;
    if (slot.hasPreview) {
      try {
        const response = await requestCommand('slot-preview',{slot:slot.slot});
        if (response?.preview) image = new Blob([response.preview], {type:'image/webp'});
      } catch {}
    }
    if (token !== gb14GalleryToken || mode !== gb14GalleryMode) return;
    list.append(gb14StateCard(slot,mode,image));
  }
}
async function gb14OpenGallery(mode) {
  gb17CloseCheats();
  if (!storageAvailable || !memory || featureBusy) {
    gb13Feedback('Salvataggi non disponibili: verifica che il gioco sia in esecuzione.',true);
    return;
  }
  gb13CloseSettings();
  gb15CloseSpeedPanel();
  gb14GalleryMode = mode;
  $('gb13-pause-actions').hidden = true;
  $('gb14-state-gallery').hidden = false;
  await gb14RenderGallery();
}
$('gb14-gallery-back').onclick = gb14CloseGallery;
$('export-saves').onclick = async () => {
  const result = await performFeature('export-saves');
  if (!result) return;
  const url = URL.createObjectURL(result.archive);
  const link = document.createElement('a');
  link.href = url;
  link.download = `gaemboy3ds-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  featureMessage(`Backup esportato: ${result.files} file.`);
};
// UX18: match the original Gaemboy cheat form interaction, with Gateway-only core support.
function gb18RefreshCheatValidation() {
  const type = $('gb18-cheat-type').value;
  const code = validateGatewayInput($('cheat-code').value);
  const named = $('cheat-name').value.trim();
  const typeOK = type === 'gateway';
  const ok = typeOK && !!named && code.ok;
  const message = !typeOK ? 'Questo formato non è supportato dal core 3DS.' :
    $('cheat-code').value.trim() && !code.ok ? code.message :
    !named ? 'Inserisci un nome per il cheat.' : code.message;
  const feedback = $('gb18-cheat-validation');
  feedback.textContent = message;
  feedback.classList.toggle('invalid', !ok);
  $('cheat-code').setAttribute('aria-invalid', String(!code.ok));
  $('cheat-add').disabled = !ok;
  return { ok, code, message };
}
$('gb18-cheat-type').addEventListener('change', gb18RefreshCheatValidation);
$('cheat-name').addEventListener('input', gb18RefreshCheatValidation);
$('cheat-code').addEventListener('input', () => {
  const input = $('cheat-code');
  const before = input.value;
  const cursor = input.selectionStart ?? before.length;
  const formatted = formatGatewayInput(before);
  if (before !== formatted) {
    const newCursor = formatGatewayInput(before.slice(0, cursor)).length;
    input.value = formatted;
    try { input.setSelectionRange(newCursor, newCursor); } catch {}
  }
  gb18RefreshCheatValidation();
});
$('cheat-add').onclick = async () => {
  const validation = gb18RefreshCheatValidation();
  if (!validation.ok) {
    $('gb17-cheat-status').textContent = validation.message;
    $('cheat-code').focus({preventScroll: true});
    return;
  }
  const name = $('cheat-name').value.trim();
  const code = validation.code.code;
  // A second, authoritative dry run through the Azahar Gateway parser.
  // No cheat is created or persisted when the core rejects a valid-looking instruction.
  const preflight = await performFeature('validate-cheat', {name, code});
  if (!preflight) {
    $('gb17-cheat-status').textContent = 'Codice rifiutato dal core 3DS. Controlla le istruzioni Gateway.';
    return;
  }
  const result = await performFeature('add-cheat', {
    name, code, enabled: $('cheat-enabled').checked,
  }, 'Cheat aggiunto.');
  if (result) {
    $('cheat-name').value = '';
    $('cheat-code').value = '';
    $('cheat-enabled').checked = false;
    $('gb18-cheat-type').value = 'gateway';
    gb17ShowCheatForm(false);
    $('gb17-cheat-status').textContent = 'Cheat aggiunto.';
  }
};

// ---------------------------------------------------------------- microphone and camera
let microphoneStream = null;
let microphoneContext = null;
let microphoneNode = null;
let microphoneBuffer = null;
let cameraStream = null;
let cameraVideo = null;
let cameraTimer = null;
let pageActive = true;

function stopMicrophone() {
  if (microphoneBuffer) Atomics.store(new Int32Array(microphoneBuffer, 0, 3), 2, 0);
  if (worker) worker.postMessage({ type: 'microphone-buffer', buffer: null });
  if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
  if (microphoneNode) microphoneNode.disconnect();
  if (microphoneContext && microphoneContext.state !== 'closed') {
    microphoneContext.close().catch((err) => log(`[microfono] chiusura: ${err}`));
  }
  microphoneStream = microphoneContext = microphoneNode = microphoneBuffer = null;
  $('mic-toggle').textContent = 'Attiva microfono';
  $('mic-status').textContent = 'Disattivato';
}

async function startMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode || !window.SharedArrayBuffer) {
    throw new Error('Il browser non supporta la cattura audio richiesta.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  }, video: false });
  if (!pageActive) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('Pagina chiusa.');
  }
  microphoneStream = stream;
  try {
    microphoneContext = new AudioContext({ latencyHint: 'interactive' });
    await microphoneContext.audioWorklet.addModule('./gaemboy3ds-microphone.js?v=26');
    if (!pageActive) throw new Error('Pagina chiusa.');
    microphoneBuffer = new SharedArrayBuffer(12 + 65536 * 2);
    microphoneNode = new AudioWorkletNode(microphoneContext, 'gaemboy3ds-microphone', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { buffer: microphoneBuffer },
    });
    const source = microphoneContext.createMediaStreamSource(stream);
    const silent = microphoneContext.createGain();
    silent.gain.value = 0;
    source.connect(microphoneNode).connect(silent).connect(microphoneContext.destination);
    worker.postMessage({ type: 'microphone-buffer', buffer: microphoneBuffer });
    await microphoneContext.resume();
    if (!pageActive || microphoneContext.state !== 'running') throw new Error('Acquisizione audio non avviata.');
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      stopMicrophone();
      featureMessage('Microfono scollegato.', true);
      refreshFeatureControls();
    }, { once: true });
    microphoneNode.addEventListener('processorerror', () => {
      stopMicrophone();
      featureMessage('Elaborazione del microfono interrotta.', true);
      refreshFeatureControls();
    }, { once: true });
    $('mic-toggle').textContent = 'Disattiva microfono';
    $('mic-status').textContent = 'Attivo';
  } catch (err) {
    stopMicrophone();
    throw err;
  }
}

function stopCamera() {
  if (cameraTimer) clearInterval(cameraTimer);
  if (memory && cameraBuffer) Atomics.store(new Int32Array(memory.buffer, cameraBuffer, 2), 1, 0);
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  if (cameraVideo) cameraVideo.srcObject = null;
  cameraStream = cameraVideo = cameraTimer = null;
  $('camera-toggle').textContent = 'Attiva fotocamera';
  $('camera-status').textContent = 'Disattivata';
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !cameraBuffer) {
    throw new Error('Il browser non supporta la cattura video richiesta.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: $('camera-facing').value }, width: { ideal: 320 }, height: { ideal: 240 } },
    audio: false,
  });
  if (!pageActive) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('Pagina chiusa.');
  }
  cameraStream = stream;
  try {
    cameraVideo = document.createElement('video');
    cameraVideo.muted = true;
    cameraVideo.playsInline = true;
    cameraVideo.srcObject = stream;
    await cameraVideo.play();
    if (!pageActive) throw new Error('Pagina chiusa.');
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = 320;
    frameCanvas.height = 240;
    const context = frameCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Impossibile preparare i frame della fotocamera.');
    cameraTimer = setInterval(() => {
      try {
        if (!cameraVideo?.videoWidth) return;
        context.drawImage(cameraVideo, 0, 0, 320, 240);
        const pixels = context.getImageData(0, 0, 320, 240).data;
        const header = new Int32Array(memory.buffer, cameraBuffer, 2);
        if (Atomics.compareExchange(header, 0, 0, 1) !== 0) return;
        try {
          new Uint8Array(memory.buffer, cameraBuffer + 8, pixels.length).set(pixels);
          Atomics.store(header, 1, 1);
        } finally {
          Atomics.store(header, 0, 0);
        }
      } catch (err) {
        stopCamera();
        featureMessage(`Fotocamera interrotta: ${err.message || err}`, true);
        refreshFeatureControls();
      }
    }, 1000 / 30);
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      stopCamera();
      featureMessage('Fotocamera scollegata.', true);
      refreshFeatureControls();
    }, { once: true });
    $('camera-toggle').textContent = 'Disattiva fotocamera';
    $('camera-status').textContent = 'Attiva';
  } catch (err) {
    stopCamera();
    throw err;
  }
}

async function toggleMedia(kind) {
  mediaBusy = true;
  refreshFeatureControls();
  try {
    if (kind === 'microfono') {
      if (microphoneStream) stopMicrophone();
      else await startMicrophone();
    } else {
      if (cameraStream) stopCamera();
      else await startCamera();
    }
  } catch (err) {
    featureMessage(`Impossibile attivare ${kind}: ${err.message || err}`, true);
  } finally {
    mediaBusy = false;
    refreshFeatureControls();
  }
}
$('mic-toggle').onclick = () => toggleMedia('microfono');
$('camera-toggle').onclick = () => toggleMedia('fotocamera');
addEventListener('pagehide', () => {
  resetInput();
  pageActive = false;
  stopMicrophone();
  stopCamera();
  if (worker) worker.postMessage({ type: 'sync' });
});

const isControl = (target) => target instanceof Element &&
  !!target.closest('input, textarea, select, button, summary, a, [contenteditable="true"]');
addEventListener('keydown', (e) => {
  if (!memory || gameMenu.open || readI('status') !== 2 || isControl(e.target)) return;
  if (e.code in KEYMAP) { keyButtons |= 1 << KEYMAP[e.code]; e.preventDefault(); }
  if (e.code in STICK_KEYS) { keySticks.add(e.code); e.preventDefault(); }
});
addEventListener('keyup', (e) => {
  if (e.code in KEYMAP) { keyButtons &= ~(1 << KEYMAP[e.code]); if (!isControl(e.target)) e.preventDefault(); }
  if (e.code in STICK_KEYS) { keySticks.delete(e.code); if (!isControl(e.target)) e.preventDefault(); }
});
let screenPointer = null;
function resetInput() {
  keyButtons = 0;
  keySticks.clear();
  touchControls.reset();
  screenPointer = null;
  if (memory) {
    for (const key of ['buttons', 'analogLX', 'analogLY', 'analogRX', 'analogRY', 'pointerDown']) writeI(key, 0);
  }
}
addEventListener('blur', resetInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetInput();
});

// libretro pointer space is [-0x7fff, 0x7fff] over the whole output frame; the core maps it onto
// the bottom screen when it falls inside its rectangle. Works for mouse, pen and touch.
function pointer(e, down) {
  if (!memory || gameMenu.open || readI('status') !== 2) return;
  const r = canvas.getBoundingClientRect();
  const coordinate = (position, start, size) =>
    Math.round(Math.max(-1, Math.min(1, ((position - start) / size) * 2 - 1)) * 0x7fff);
  writeI('pointerX', coordinate(e.clientX, r.left, r.width));
  writeI('pointerY', coordinate(e.clientY, r.top, r.height));
  if (down !== undefined) writeI('pointerDown', down ? 1 : 0);
}
canvas.addEventListener('pointerdown', (e) => {
  if (screenPointer !== null || !memory || gameMenu.open || readI('status') !== 2) return;
  e.preventDefault();
  screenPointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  pointer(e, true);
});
canvas.addEventListener('pointermove', (e) => { if (screenPointer === e.pointerId) pointer(e); });
function releaseScreen(e) {
  if (screenPointer !== e.pointerId) return;
  if (memory) writeI('pointerDown', 0);
  screenPointer = null;
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, releaseScreen);

// iOS Safari: stop pinch/double-tap zoom, rubber-band scroll and long-press callouts while playing.
const playing = () => document.body.classList.contains('playing');
const insideMenu = (target) => target instanceof Element && !!target.closest('#game-menu');
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault());
}
document.addEventListener('touchmove', (e) => {
  if (playing() && !insideMenu(e.target)) e.preventDefault();
}, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (playing() && !insideMenu(e.target) && now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('dblclick', (e) => {
  if (playing() && !insideMenu(e.target)) e.preventDefault();
});
document.addEventListener('contextmenu', (e) => {
  if (playing() && !insideMenu(e.target)) e.preventDefault();
});
// iOS only lets audio start from a user gesture: resume on touch if it was suspended.
document.addEventListener('pointerdown', () => {
  if (audioOn && audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
}, { capture: true });

const params = new URLSearchParams(location.search);
if (params.has('mute')) { audioOn = false; $('audio').textContent = 'Audio: off'; }
if (params.get('demo') !== null) (params.get('demo') === '3d' ? $('demo3d') : $('demo')).click();
