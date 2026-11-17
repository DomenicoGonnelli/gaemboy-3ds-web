// Hosts the Emscripten module in a dedicated worker so the user's game file can be mounted with
// WORKERFS: the core reads it lazily (FileReaderSync on slices), nothing is copied into memory or
// uploaded anywhere. Saves live in IDBFS (IndexedDB) and are flushed periodically.
import createGaemboy3DS from './gaemboy3ds.js?v=13';

const SAVES = '/gaemboy/3ds/saves';
// libctru homebrew only start NDSP if sdmc:/3ds/dspfirm.cdc exists; Azahar's HLE DSP ignores
// its content, so an empty placeholder (no Nintendo code) is enough. Retail games don't need it.
const DSP_PLACEHOLDER = `${SAVES}/Azahar/sdmc/3ds/dspfirm.cdc`;
const SYNC_MS = 10000;

const post = (type, data = {}, transfer) => self.postMessage({ type, ...data }, transfer);
let mod = null;

// Core logs are batched: a game spamming warnings must not flood the page's main thread.
const LOG_MAX_PER_FLUSH = 200;
let logBuffer = [];
let logDropped = 0;
let logTotal = 0;
const logLine = (line) => {
  logTotal++;
  if (logBuffer.length < LOG_MAX_PER_FLUSH) logBuffer.push(line);
  else logDropped++;
};
setInterval(() => {
  if (!logBuffer.length && !logDropped) return;
  post('logs', { lines: logBuffer, dropped: logDropped, total: logTotal });
  logBuffer = [];
  logDropped = 0;
}, 250);
let syncing = false;

// ---------------------------------------------------------------- perf breakdown
// Lightweight per-second breakdown of where the emulator thread spends time: WebGL calls by
// category (shader compile/link stalls surface in the blocking calls or the first draw with a new
// program), lazy reads of the game file and the duration of each frame tick. Single calls over
// LONG_CALL_MS are reported by name so freezes can be attributed.
const LONG_CALL_MS = 25;
const GL_CATEGORY = {
  shader: ['createShader', 'shaderSource', 'compileShader', 'attachShader', 'createProgram', 'linkProgram',
    'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'deleteShader',
    'deleteProgram', 'detachShader', 'bindAttribLocation', 'getUniformLocation', 'getUniformBlockIndex',
    'uniformBlockBinding', 'getAttribLocation', 'useProgram', 'getActiveUniform', 'getActiveAttrib'],
  draw: ['drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced', 'clear',
    'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi'],
  upload: ['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'texStorage2D', 'texImage3D',
    'texSubImage3D', 'compressedTexImage2D', 'copyTexSubImage2D', 'copyBufferSubData', 'generateMipmap'],
  sync: ['readPixels', 'getError', 'finish', 'flush', 'fenceSync', 'clientWaitSync', 'getSyncParameter',
    'getBufferSubData', 'checkFramebufferStatus', 'getParameter'],
  fbo: ['blitFramebuffer', 'framebufferTexture2D', 'framebufferRenderbuffer', 'bindFramebuffer',
    'invalidateFramebuffer', 'createFramebuffer', 'createTexture', 'deleteTexture', 'renderbufferStorage'],
};
const perf = { gl: {}, glCount: {}, file: 0, fileBytes: 0, fileCalls: 0, ticks: 0, tickMs: 0, tickMax: 0, long: [] };
const resetPerf = () => {
  perf.gl = {}; perf.glCount = {};
  perf.file = perf.fileBytes = perf.fileCalls = perf.ticks = perf.tickMs = perf.tickMax = 0;
  perf.long = [];
};
const noteLong = (name, dt) => { if (perf.long.length < 20) perf.long.push(`${name} ${dt.toFixed(0)}ms`); };
function instrumentGL() {
  const P = self.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (!P) return;
  const cat = {};
  for (const [c, names] of Object.entries(GL_CATEGORY)) for (const n of names) cat[n] = c;
  for (const name of Object.getOwnPropertyNames(P)) {
    const d = Object.getOwnPropertyDescriptor(P, name);
    if (!d || typeof d.value !== 'function' || name === 'constructor') continue;
    const fn = d.value;
    const c = cat[name] || 'other';
    P[name] = function (...args) {
      const t0 = performance.now();
      const r = fn.apply(this, args);
      const dt = performance.now() - t0;
      perf.gl[c] = (perf.gl[c] || 0) + dt;
      if (c === 'shader' && (name === 'linkProgram' || name === 'compileShader')) {
        perf.glCount[name] = (perf.glCount[name] || 0) + 1;
      }
      if (dt > LONG_CALL_MS) noteLong(name, dt);
      return r;
    };
  }
}
function instrumentFileReads() {
  if (!self.FileReaderSync) return;
  const P = FileReaderSync.prototype;
  const fn = P.readAsArrayBuffer;
  P.readAsArrayBuffer = function (blob) {
    const t0 = performance.now();
    const r = fn.call(this, blob);
    const dt = performance.now() - t0;
    perf.file += dt;
    perf.fileCalls++;
    perf.fileBytes += blob.size || 0;
    if (dt > LONG_CALL_MS) noteLong(`fileRead ${((blob.size || 0) / 1024).toFixed(0)}KB`, dt);
    return r;
  };
}
// The frontend schedules each frame through self.__gb3ds_mc (MessageChannel); wrap its handler
// once it exists to time whole ticks (emulation + GL submission + throttle wait).
function instrumentTicks() {
  const mc = self.__gb3ds_mc;
  if (!mc || mc.__gbWrapped) return;
  const handler = mc.port1.onmessage;
  if (!handler) return;
  mc.__gbWrapped = true;
  mc.port1.onmessage = (e) => {
    const t0 = performance.now();
    handler(e);
    const dt = performance.now() - t0;
    perf.ticks++;
    perf.tickMs += dt;
    if (dt > perf.tickMax) perf.tickMax = dt;
  };
}
instrumentGL();
instrumentFileReads();
setInterval(() => {
  instrumentTicks();
  const gl = {};
  for (const [k, v] of Object.entries(perf.gl)) gl[k] = Math.round(v * 10) / 10;
  post('perf', {
    ticks: perf.ticks,
    tickMs: Math.round(perf.tickMs),
    tickMax: Math.round(perf.tickMax),
    gl,
    compiles: perf.glCount,
    fileMs: Math.round(perf.file),
    fileKB: Math.round(perf.fileBytes / 1024),
    fileCalls: perf.fileCalls,
    long: perf.long,
  });
  resetPerf();
}, 1000);

function syncSaves(reason) {
  if (!mod || syncing) return;
  syncing = true;
  mod.FS.syncfs(false, (err) => {
    syncing = false;
    post('saved', { ok: !err, reason, error: err ? String(err) : undefined });
  });
}

function ensurePath(FS, dir) {
  let cur = '';
  for (const part of dir.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'sync') {
    syncSaves('richiesta');
    return;
  }
  if (data.type !== 'boot' || mod) return;
  const file = data.file;
  const romName = file.name.replace(/[^\w.\- ]/g, '_');
  try {
    mod = await createGaemboy3DS({
      canvas: data.canvas || undefined,
      arguments: [`/rom/${romName}`, ...(data.extraArgs || [])],
      print: logLine,
      printErr: logLine,
      preRun: [(m) => {
        const { FS } = m;
        FS.mkdir('/rom');
        FS.mount(FS.filesystems.WORKERFS, { blobs: [{ name: romName, data: file }] }, '/rom');
        ensurePath(FS, SAVES);
        FS.mount(FS.filesystems.IDBFS, {}, SAVES);
        m.addRunDependency('gb3ds-idbfs');
        FS.syncfs(true, (err) => {
          if (err) logLine(`[gaemboy] IDBFS non disponibile: ${err}`);
          if (data.dspPlaceholder !== false) {
            try {
              FS.stat(DSP_PLACEHOLDER);
            } catch {
              ensurePath(FS, DSP_PLACEHOLDER.slice(0, DSP_PLACEHOLDER.lastIndexOf('/')));
              FS.writeFile(DSP_PLACEHOLDER, new Uint8Array(0x400));
            }
          }
          m.removeRunDependency('gb3ds-idbfs');
        });
      }],
    });
    post('ready', {
      memory: mod.wasmMemory,
      state: mod._gb3ds_state(),
      stateSize: mod._gb3ds_state_size(),
      romName,
      romSize: file.size,
    });
    setInterval(() => syncSaves('periodico'), SYNC_MS);
  } catch (err) {
    post('error', { message: String(err && err.stack ? err.stack : err) });
  }
};
