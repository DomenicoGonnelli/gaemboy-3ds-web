/* GAEMBOY 3DS - incremental OPFS ROM writer (dedicated worker, no server upload).
 * Partial .bin files survive interrupted sessions; a .map is published ONLY after full copy.
 * Existing saves and state files are never opened by this worker.
 */
const BLOCK = 1024 * 1024;
const CHUNK = 4 * BLOCK;
const DIR = 'gaemboy-rom-mirror';
const hexKey = value => /^[0-9a-f]{64}$/.test(String(value || ''));

function completedMap(size) {
  const total = Math.ceil(size / BLOCK);
  const result = new Uint8Array(8 + Math.ceil(total / 32) * 4);
  const view = new DataView(result.buffer);
  view.setFloat64(0, size, true);
  for (let i = 0; i < total; i++) {
    const pos = 8 + (i >> 5) * 4;
    view.setUint32(pos, view.getUint32(pos, true) | (1 << (i & 31)), true);
  }
  return result;
}

self.onmessage = async ({ data }) => {
  const { file, key } = data || {};
  if (!hexKey(key) || !(file instanceof Blob) || !file.size) {
    self.postMessage({ type: 'error', code: 'invalid-input' }); return;
  }
  let sync = null;
  try {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS non supportato');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
    // Invalidates any old completed bitmap before modifying a partial ROM.
    try { await dir.removeEntry(`${key}.map`); } catch (e) { if (e?.name !== 'NotFoundError') throw e; }
    const handle = await dir.getFileHandle(`${key}.bin`, { create: true });
    if (!handle.createSyncAccessHandle) {
      self.postMessage({ type: 'unsupported' }); return;
    }
    sync = await handle.createSyncAccessHandle();
    const existing = sync.getSize();
    // A full-sized unverified .bin must be recopied: size alone is not proof of integrity.
    const resumed = existing > 0 && existing < file.size ? Math.floor(existing / CHUNK) * CHUNK : 0;
    if (existing !== resumed) sync.truncate(resumed);
    self.postMessage({ type: 'progress', bytes: resumed, total: file.size, resumed });
    for (let offset = resumed; offset < file.size; offset += CHUNK) {
      const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + CHUNK, file.size)).arrayBuffer());
      let at = 0;
      while (at < bytes.length) {
        const written = sync.write(bytes.subarray(at), { at: offset + at });
        if (!Number.isInteger(written) || written <= 0) throw new Error('Scrittura OPFS incompleta');
        at += written;
      }
      // Commit in increments: usable on next reimport even if the page is closed early.
      if ((offset / CHUNK) % 8 === 7 || offset + bytes.length === file.size) sync.flush();
      self.postMessage({ type: 'progress', bytes: offset + bytes.length, total: file.size, resumed });
    }
    sync.flush(); sync.close(); sync = null;
    const map = await dir.getFileHandle(`${key}.map`, { create: true });
    // Safari/WebKit implements OPFS synchronous access handles inside dedicated
    // workers, but older versions do not expose FileSystemFileHandle.createWritable().
    // Publish the completion bitmap with the SAME API used for the .bin file.
    const marker = completedMap(file.size);
    if (typeof map.createSyncAccessHandle === 'function') {
      const mapSync = await map.createSyncAccessHandle();
      try {
        mapSync.truncate(0);
        let offset = 0;
        while (offset < marker.length) {
          const wrote = mapSync.write(marker.subarray(offset), { at: offset });
          if (!Number.isInteger(wrote) || wrote <= 0) throw new Error('Scrittura mappa OPFS incompleta');
          offset += wrote;
        }
        mapSync.flush();
      } finally { mapSync.close(); }
    } else if (typeof map.createWritable === 'function') {
      const writable = await map.createWritable();
      try { await writable.write(marker); await writable.close(); }
      catch (error) { await writable.abort?.(); throw error; }
    } else {
      self.postMessage({ type: 'unsupported' }); return;
    }
    self.postMessage({ type: 'complete', bytes: file.size, resumed });
  } catch (error) {
    // Some browsers expose the method but do not allow sync handles on OPFS.
    // The caller can fall back to createWritable() for those implementations.
    if (['NotSupportedError', 'NotAllowedError'].includes(error?.name)) self.postMessage({ type: 'unsupported' });
    else self.postMessage({ type: 'error', code: error?.name || 'write-failed', message: String(error?.message || error) });
  } finally {
    try { sync?.close(); } catch { /* access handle is released when worker terminates */ }
  }
};
