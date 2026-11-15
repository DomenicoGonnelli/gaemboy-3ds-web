// Page side of the GAEMBOY 3DS web POC: boots the Emscripten module, draws frames and feeds input
// through the SharedState struct exported by gaemboy3ds_web.cpp (offsets below must match it).
import createGaemboy3DS from './gaemboy3ds.js';

const OFF = {
  status: 0, frameSeq: 4, fbWidth: 8, fbHeight: 12, fbPtr: 16, throttle: 20, buttons: 24,
  pointerX: 28, pointerY: 32, pointerDown: 36, analogLX: 40, analogLY: 44, framesTotal: 48,
  audioFrames: 52, lastFrameMs: 56, avgFrameMs: 60, emuFps: 64, loadMs: 68, messageSeq: 72,
  message: 76,
};
const STATUS = ['avvio', 'caricamento…', 'in esecuzione', 'errore'];
const KEYMAP = {
  ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, KeyX: 8, KeyZ: 0, KeyS: 9, KeyA: 1,
  KeyQ: 10, KeyW: 11, Enter: 3, Backspace: 2,
};
const NATIVE_FPS = 59.83;
const AUDIO_HZ = 32728;

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const logEl = $('log');
const bench = { startedAt: 0, frames: [] };
window.__gb3ds = bench;

function log(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

if (!crossOriginIsolated) {
  log('ERRORE: la pagina non è cross-origin isolated (servono header COOP/COEP): i thread WASM non possono partire.');
}

let mod = null;
let base = 0;
const i32 = () => new Int32Array(mod.wasmMemory.buffer);
const f32 = () => new Float32Array(mod.wasmMemory.buffer);
const u8 = () => new Uint8Array(mod.wasmMemory.buffer);
const readI = (k) => Atomics.load(i32(), (base + OFF[k]) >> 2);
const writeI = (k, v) => Atomics.store(i32(), (base + OFF[k]) >> 2, v);
const readF = (k) => f32()[(base + OFF[k]) >> 2];

async function boot(name, bytes) {
  $('demo').disabled = true;
  document.querySelector('label.btn').style.display = 'none';
  log(`Carico ${name} (${(bytes.length / 1048576).toFixed(1)} MB)…`);
  const romPath = `/rom/${name.replace(/[^\w.-]/g, '_')}`;
  const t0 = performance.now();
  mod = await createGaemboy3DS({
    arguments: [romPath],
    print: (s) => log(s),
    printErr: (s) => log(s),
    preRun: [(m) => {
      m.FS.mkdir('/rom');
      m.FS.writeFile(romPath, bytes);
    }],
  });
  base = mod._gb3ds_state();
  log(`Modulo WASM pronto in ${(performance.now() - t0).toFixed(0)} ms (state @ ${base}, ${mod._gb3ds_state_size()} B)`);
  bench.startedAt = performance.now();
  $('throttle').disabled = false;
  requestAnimationFrame(draw);
  setInterval(updateStats, 250);
}

let lastSeq = 0;
let lastMsgSeq = 0;
let image = null;
function draw() {
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
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        image = new ImageData(w, h);
      }
      image.data.set(u8().subarray(ptr, ptr + w * h * 4));
      ctx.putImageData(image, 0, 0);
    }
  }
  requestAnimationFrame(draw);
}

function updateStats() {
  const status = readI('status');
  const frames = readI('framesTotal');
  const fps = readF('emuFps');
  const avgMs = readF('avgFrameMs');
  const audio = readI('audioFrames');
  const elapsed = (performance.now() - bench.startedAt) / 1000;
  const speed = (100 * fps) / NATIVE_FPS;
  $('s-status').textContent = STATUS[status] ?? status;
  $('s-status').className = status === 2 ? 'good' : status === 3 ? 'bad' : 'mid';
  $('s-load').textContent = readF('loadMs') ? `${readF('loadMs').toFixed(0)} ms` : '—';
  $('s-frames').textContent = frames;
  $('s-fps').textContent = fps.toFixed(1);
  $('s-speed').textContent = `${speed.toFixed(0)}%`;
  $('s-speed').className = speed >= 95 ? 'good' : speed >= 60 ? 'mid' : 'bad';
  $('s-ms').textContent = `${avgMs.toFixed(1)} ms (budget 16,7)`;
  $('s-audio').textContent = `${(audio / AUDIO_HZ).toFixed(1)} s in ${elapsed.toFixed(1)} s`;
  $('s-mem').textContent = `${navigator.hardwareConcurrency} core · ${(mod.wasmMemory.buffer.byteLength / 1048576).toFixed(0)} MB`;
  const msgSeq = readI('messageSeq');
  if (msgSeq !== lastMsgSeq) {
    lastMsgSeq = msgSeq;
    const bytes = u8().slice(base + OFF.message, base + OFF.message + 256);
    log(`[core] ${new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)))}`);
  }
  bench.frames.push({ t: elapsed, frames, fps, avgMs, audioSeconds: audio / AUDIO_HZ, status });
}

$('demo').onclick = async () => {
  const res = await fetch('./homebrew/SuperHaxagon.3dsx');
  if (!res.ok) {
    log(`Demo non trovata (${res.status}): usa "Carica" con un tuo homebrew.`);
    return;
  }
  boot('SuperHaxagon.3dsx', new Uint8Array(await res.arrayBuffer()));
};
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  if (file) boot(file.name, new Uint8Array(await file.arrayBuffer()));
};
$('throttle').onclick = () => {
  const next = readI('throttle') ? 0 : 1;
  writeI('throttle', next);
  $('throttle').textContent = next ? 'Velocità: 60 fps' : 'Velocità: massima';
};

let buttons = 0;
const setButton = (id, down) => {
  buttons = down ? buttons | (1 << id) : buttons & ~(1 << id);
  if (mod) writeI('buttons', buttons);
};
addEventListener('keydown', (e) => {
  if (e.code in KEYMAP) { setButton(KEYMAP[e.code], true); e.preventDefault(); }
});
addEventListener('keyup', (e) => {
  if (e.code in KEYMAP) { setButton(KEYMAP[e.code], false); e.preventDefault(); }
});

// libretro pointer space is [-0x7fff, 0x7fff] over the whole output frame; the core maps it onto
// the bottom screen when it falls inside its rectangle.
function pointer(e, down) {
  if (!mod) return;
  const r = canvas.getBoundingClientRect();
  const x = Math.round((((e.clientX - r.left) / r.width) * 2 - 1) * 0x7fff);
  const y = Math.round((((e.clientY - r.top) / r.height) * 2 - 1) * 0x7fff);
  writeI('pointerX', x);
  writeI('pointerY', y);
  if (down !== undefined) writeI('pointerDown', down ? 1 : 0);
}
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointer(e, true); });
canvas.addEventListener('pointermove', (e) => pointer(e));
canvas.addEventListener('pointerup', (e) => pointer(e, false));

if (new URLSearchParams(location.search).has('demo')) $('demo').click();
