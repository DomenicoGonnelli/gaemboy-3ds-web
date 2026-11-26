/* Gaemboy 3DS Fix 07: Safari file-picker -> main-thread chunks -> OPFS worker.
 * A complete .map is published ONLY after every ROM byte was written.
 * The ROM .bin is resumable; IDBFS saves and game metadata are never touched.
 */
const DIR = 'gaemboy-rom-mirror';
const BLOCK = 1024 * 1024;
const CHUNK = 4 * BLOCK;
let io = null;
let dir = null;
let key = '';
let size = 0;
let position = 0;
let state = 'idle';

function completeMap(bytes) {
  const blocks = Math.ceil(bytes / BLOCK);
  const output = new Uint8Array(8 + Math.ceil(blocks / 32) * 4);
  const view = new DataView(output.buffer);
  view.setFloat64(0, bytes, true);
  for (let i = 0; i < blocks; i++) {
    const at = 8 + (i >> 5) * 4;
    view.setUint32(at, view.getUint32(at, true) | (1 << (i & 31)), true);
  }
  return output;
}
function writeAll(handle, bytes, at) {
  let n = 0;
  while (n < bytes.byteLength) {
    const count = handle.write(bytes.subarray(n), { at: at + n });
    if (!Number.isInteger(count) || count <= 0) throw new Error('OPFS ha scritto meno byte del previsto');
    n += count;
  }
}
function closeIo() { if (io) { try { io.close(); } catch {} io = null; } }
function errorMessage(error, stage) {
  self.postMessage({ type: 'error', stage, code: error?.name || 'opfs-error', message: String(error?.message || error) });
}
self.onmessage = async ({ data }) => {
  const type = data?.type;
  if (type === 'abort') { closeIo(); state = 'idle'; self.postMessage({ type: 'aborted' }); return; }
  try {
    if (type === 'start') {
      if (state !== 'idle' || !/^[a-f0-9]{64}$/.test(String(data.key)) ||
          !Number.isSafeInteger(data.size) || data.size <= 0) throw new Error('Dati ROM non validi');
      if (!navigator.storage?.getDirectory) { self.postMessage({ type: 'unsupported' }); return; }
      state = 'opening'; key = data.key; size = data.size;
      dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
      // Invalidate stale or partial maps before any write. No false completed cache.
      try { await dir.removeEntry(`${key}.map`); }
      catch (error) { if (error?.name !== 'NotFoundError') throw error; }
      const handle = await dir.getFileHandle(`${key}.bin`, { create: true });
      if (typeof handle.createSyncAccessHandle !== 'function') {
        state = 'idle'; self.postMessage({ type: 'unsupported' }); return;
      }
      io = await handle.createSyncAccessHandle();
      const previous = io.getSize();
      position = previous > 0 && previous < size ? Math.floor(previous / CHUNK) * CHUNK : 0;
      if (previous !== position) io.truncate(position);
      state = 'writing';
      self.postMessage({ type: 'ready', resumed: position, total: size });
    } else if (type === 'chunk') {
      if (state !== 'writing' || data.offset !== position || !(data.bytes instanceof ArrayBuffer))
        throw new Error('Blocco non valido o fuori sequenza');
      const bytes = new Uint8Array(data.bytes);
      if (!bytes.length || bytes.length > CHUNK || position + bytes.length > size) throw new Error('Dimensione blocco non valida');
      writeAll(io, bytes, position);
      position += bytes.length;
      io.flush();
      self.postMessage({ type: 'written', bytes: position });
    } else if (type === 'finish') {
      if (state !== 'writing' || position !== size) throw new Error('La ROM non e completa');
      io.flush(); closeIo();
      const markerHandle = await dir.getFileHandle(`${key}.map`, { create: true });
      if (typeof markerHandle.createSyncAccessHandle !== 'function') {
        state = 'idle'; self.postMessage({ type: 'unsupported' }); return;
      }
      const marker = await markerHandle.createSyncAccessHandle();
      try {
        marker.truncate(0);
        writeAll(marker, completeMap(size), 0);
        marker.flush();
      } finally { marker.close(); }
      state = 'complete';
      self.postMessage({ type: 'complete', bytes: size });
    }
  } catch (error) {
    const failedStage = state;
    closeIo(); state = 'idle';
    if (['NotSupportedError', 'NotAllowedError'].includes(error?.name)) {
      self.postMessage({ type: 'unsupported' });
    } else errorMessage(error, failedStage);
  }
};
