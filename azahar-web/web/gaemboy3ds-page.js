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
const STATE_SIZE = 360;
const STATUS = ['avvio', 'caricamento…', 'in esecuzione', 'errore'];
const NATIVE_FPS = 59.83;
const AUDIO_HZ = 32728;
// libretro joypad ids: B0 Y1 Select2 Start3 Up4 Down5 Left6 Right7 A8 X9 L10 R11 ZL12 ZR13 Home14
const KEYMAP = {
  ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, KeyX: 8, KeyZ: 0, KeyS: 9, KeyA: 1,
  KeyQ: 10, KeyW: 11, KeyE: 12, KeyR: 13, Enter: 3, Backspace: 2,
};
// Analog sticks on the keyboard (libretro analog: Y grows downwards).
const STICK_KEYS = {
  KeyJ: ['analogLX', -1], KeyL: ['analogLX', 1], KeyI: ['analogLY', -1], KeyK: ['analogLY', 1],
  KeyF: ['analogRX', -1], KeyH: ['analogRX', 1], KeyT: ['analogRY', -1], KeyG: ['analogRY', 1],
};
// Standard Gamepad API layout mapped by position, Nintendo style (bottom = B, right = A, ...).
const PAD_BUTTONS = { 0: 0, 1: 8, 2: 1, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13, 8: 2, 9: 3, 12: 4, 13: 5, 14: 6, 15: 7, 16: 14 };
const PAD_DEADZONE = 0.15;

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
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
}

if (useSw) {
  notice(`Renderer software forzato da ?sw: i giochi 3D pesanti girano molto più lenti. Per WebGL2 (GPU, consigliato) apri ${location.origin}${location.pathname}`, 'bad');
}
if (!crossOriginIsolated) {
  notice('La pagina non è cross-origin isolated (servono header COOP/COEP): i thread WASM non possono partire.', 'bad');
}

let worker = null;
let memory = null;
let base = 0;
const i32 = () => new Int32Array(memory.buffer);
const f32 = () => new Float32Array(memory.buffer);
const u8 = () => new Uint8Array(memory.buffer);
const readI = (k) => Atomics.load(i32(), (base + OFF[k]) >> 2);
const writeI = (k, v) => Atomics.store(i32(), (base + OFF[k]) >> 2, v);
const readF = (k) => f32()[(base + OFF[k]) >> 2];

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
function boot(file) {
  if (worker) return;
  for (const id of ['demo', 'demo3d']) $(id).disabled = true;
  $('pick').disabled = true;
  $('rom-info').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · letto in locale, nessun upload`;
  log(`Avvio ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
  const t0 = performance.now();
  worker = new Worker('./gaemboy3ds-worker.js?v=15', { type: 'module' });
  worker.onerror = (e) => {
    const msg = `${e.message || 'errore sconosciuto'} (${e.filename || '?'}:${e.lineno || '?'})`;
    log(`[worker] ${msg}`);
    notice(`Il worker dell'emulatore si è interrotto: ${msg}`, 'bad');
  };
  worker.onmessageerror = () => log('[worker] messaggio non deserializzabile');
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'logs':
        for (const line of data.lines) log(line);
        if (data.dropped) log(`… ${data.dropped} righe di log omesse`);
        logTotal = data.total;
        break;
      case 'error':
        notice(`Errore nel caricamento del modulo: ${data.message}`, 'bad');
        log(`[errore] ${data.message}`);
        break;
      case 'perf':
        onPerf(data);
        break;
      case 'saved':
        $('s-saves').textContent = data.ok ? `ok ${new Date().toLocaleTimeString()}` : `errore: ${data.error}`;
        break;
      case 'ready':
        memory = data.memory;
        base = data.state;
        if (data.stateSize !== STATE_SIZE) {
          notice(`Struct condivisa incoerente (${data.stateSize} B, attesi ${STATE_SIZE}): ricompila.`, 'bad');
          return;
        }
        log(`Modulo WASM pronto in ${(performance.now() - t0).toFixed(0)} ms`);
        bench.startedAt = performance.now();
        for (const id of ['throttle', 'audio', 'save']) $(id).disabled = false;
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
  if (offscreen) {
    worker.postMessage({ type: 'boot', file, extraArgs, canvas: offscreen }, [offscreen]);
  } else {
    if (!extraArgs.includes('--sw')) extraArgs.push('--sw');
    worker.postMessage({ type: 'boot', file, extraArgs });
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
  // input: keyboard | gamepad
  const pad = readGamepad();
  writeI('buttons', keyButtons | pad.buttons);
  const key = { analogLX: 0, analogLY: 0, analogRX: 0, analogRY: 0 };
  for (const code of keySticks) {
    const [axis, dir] = STICK_KEYS[code];
    key[axis] += dir;
  }
  const axis = (k, v) => writeI(k, Math.round(Math.max(-1, Math.min(1, key[k] || v)) * 0x7fff));
  axis('analogLX', pad.axes[0]);
  axis('analogLY', pad.axes[1]);
  axis('analogRX', pad.axes[2]);
  axis('analogRY', pad.axes[3]);

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
  const frames = readI('framesTotal');
  const fps = readF('emuFps');
  const avgMs = readF('avgFrameMs');
  const audio = readI('audioFrames');
  const elapsed = (performance.now() - bench.startedAt) / 1000;
  const speed = (100 * fps) / NATIVE_FPS;
  const buffered = (readI('audioWrite') - readI('audioRead')) >>> 0;
  $('s-status').textContent = STATUS[status] ?? status;
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
  if (status === 3 && $('notice').hidden) notice('Il core non è riuscito a caricare il file (vedi log).', 'bad');
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
    notice(`L'emulazione sembra bloccata (frame fermi a ${frames}). Premi "Scarica log" e inviami il file.`, 'bad');
  }
}

// Per-second breakdown sent by the worker (see gaemboy3ds-worker.js): kept for the log export.
const perfHistory = [];
function onPerf(p) {
  const t = bench.startedAt ? (performance.now() - bench.startedAt) / 1000 : 0;
  perfHistory.push({ t: Math.round(t * 10) / 10, ...p });
  if (perfHistory.length > 900) perfHistory.splice(0, perfHistory.length - 900);
  const glTotal = Object.values(p.gl).reduce((a, b) => a + b, 0);
  const links = p.compiles.linkProgram || 0;
  const el = $('s-perf');
  el.textContent = `GL ${glTotal.toFixed(0)} ms/s · shader ${(p.gl.shader || 0).toFixed(0)} ms` +
    `${links ? ` (${links} link)` : ''} · file ${p.fileMs} ms · frame max ${p.tickMax} ms`;
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

// ---------------------------------------------------------------- UI
async function startDemo(name) {
  ensureAudio();
  const res = await fetch(`./homebrew/${name}`);
  if (!res.ok) {
    notice(`Demo ${name} non trovata (${res.status}): usa "Carica gioco…".`, 'bad');
    return;
  }
  boot(new File([await res.blob()], name));
}
$('demo').onclick = () => startDemo($('demo').dataset.file);
$('demo3d').onclick = () => startDemo($('demo3d').dataset.file);
// Hosted builds only ship redistributable demos: hide buttons whose file is not deployed.
for (const id of ['demo', 'demo3d']) {
  fetch(`./homebrew/${$(id).dataset.file}`, { method: 'HEAD' })
    .then((r) => { if (!r.ok) $(id).hidden = true; })
    .catch(() => { $(id).hidden = true; });
}
$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  ensureAudio();
  boot(file);
};
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file || worker) return;
  ensureAudio();
  boot(file);
});
$('throttle').onclick = () => {
  const next = readI('throttle') ? 0 : 1;
  writeI('throttle', next);
  $('throttle').textContent = next ? 'Velocità: 60 fps' : 'Velocità: massima';
};
$('audio').onclick = async () => {
  audioOn = !audioOn;
  await ensureAudio();
  if (audioNode) audioNode.port.postMessage({ type: 'mute', muted: !audioOn });
  if (audioCtx) audioCtx.resume();
  $('audio').textContent = audioOn ? 'Audio: on' : 'Audio: off';
};
$('save').onclick = () => worker && worker.postMessage({ type: 'sync' });
addEventListener('pagehide', () => worker && worker.postMessage({ type: 'sync' }));

addEventListener('keydown', (e) => {
  if (!memory || e.target instanceof HTMLInputElement) return;
  if (e.code in KEYMAP) { keyButtons |= 1 << KEYMAP[e.code]; e.preventDefault(); }
  if (e.code in STICK_KEYS) { keySticks.add(e.code); e.preventDefault(); }
});
addEventListener('keyup', (e) => {
  if (e.code in KEYMAP) { keyButtons &= ~(1 << KEYMAP[e.code]); e.preventDefault(); }
  if (e.code in STICK_KEYS) { keySticks.delete(e.code); e.preventDefault(); }
});
addEventListener('blur', () => { keyButtons = 0; keySticks.clear(); });

// libretro pointer space is [-0x7fff, 0x7fff] over the whole output frame; the core maps it onto
// the bottom screen when it falls inside its rectangle. Works for mouse, pen and touch.
function pointer(e, down) {
  if (!memory) return;
  const r = canvas.getBoundingClientRect();
  writeI('pointerX', Math.round((((e.clientX - r.left) / r.width) * 2 - 1) * 0x7fff));
  writeI('pointerY', Math.round((((e.clientY - r.top) / r.height) * 2 - 1) * 0x7fff));
  if (down !== undefined) writeI('pointerDown', down ? 1 : 0);
}
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointer(e, true); });
canvas.addEventListener('pointermove', (e) => pointer(e));
canvas.addEventListener('pointerup', (e) => pointer(e, false));
canvas.addEventListener('pointercancel', (e) => pointer(e, false));

const params = new URLSearchParams(location.search);
if (params.has('mute')) { audioOn = false; $('audio').textContent = 'Audio: off'; }
if (params.get('demo') !== null) (params.get('demo') === '3d' ? $('demo3d') : $('demo')).click();
