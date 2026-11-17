// Hosts the Emscripten module in a dedicated worker so the user's game file can be mounted with
// WORKERFS: the core reads it lazily (FileReaderSync on slices), nothing is copied into memory or
// uploaded anywhere. Saves live in IDBFS (IndexedDB) and are flushed periodically.
import createGaemboy3DS from './gaemboy3ds.js?v=6';

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
