// GAEMBOY 3DS: persistent catalog + a single, disposable OPFS ROM cache.
// The .bin/.map format intentionally matches gaemboy3ds-worker.js; IDBFS saves are unrelated.
export const ROM_LIMIT = 3 * 1024 ** 3; // Free public site; Premium limit is explicit and verified.
export const ROM_RESERVE = 64 * 1024 ** 2;
const ROM_BLOCK = 1024 ** 2;
const COPY_CHUNK = 4 * ROM_BLOCK;

// Safari: copy before boot, avoiding simultaneous reads of the picked File by
// the emulator worker and the cache worker. All other browsers keep fast boot.
export function prefersSequentialCache(userAgent = globalThis.navigator?.userAgent || '') {
  const ua = String(userAgent);
  return /iP(?:hone|ad|od)/i.test(ua) ||
    (/Safari\//i.test(ua) && !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS)\//i.test(ua));
}

const READ_DELAYS = [0, 120, 350, 800, 1600, 2400];
export async function readSourceChunk(file, offset, end) {
  let lastError;
  for (const delay of READ_DELAYS) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const result = await file.slice(offset, end).arrayBuffer();
      if (result.byteLength !== end - offset) throw new Error('Lettura incompleta del file originale');
      return result;
    } catch (error) {
      lastError = error;
      if (error?.name !== 'NotReadableError') throw error;
    }
  }
  throw lastError;
}

const IDB_CHUNK_STORE = 'rom-cache-chunks';
const IDB_STATE_STORE = 'rom-cache-state';
const DIR_NAME = 'gaemboy-rom-mirror';
const DB_NAME = 'gaemboy3ds-library';
const STORE = 'games';
const ROM_RE = /\.(3ds|cci|cxi|app|3dsx|elf)$/i;

export function validRom(file) {
  return !!file && ROM_RE.test(String(file.name || '')) && Number.isSafeInteger(file.size) && file.size > 0;
}
// Exactly the sampling/hash algorithm used for saves and ROM mirrors in gaemboy3ds-worker.js.
export async function romFingerprint(file) {
  const sampleSize = Math.min(file.size, 128 * 1024);
  const positions = file.size <= sampleSize ? [0] :
    Array.from({ length: 9 }, (_, i) => Math.floor((file.size - sampleSize) * i / 8));
  const samples = await Promise.all(positions.map(p => file.slice(p, p + sampleSize).arrayBuffer()));
  const bytes = new Uint8Array(8 + samples.reduce((n, sample) => n + sample.byteLength, 0));
  new DataView(bytes.buffer).setBigUint64(0, BigInt(file.size), true);
  let offset = 8;
  for (const sample of samples) { bytes.set(new Uint8Array(sample), offset); offset += sample.byteLength; }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, x => x.toString(16).padStart(2, '0')).join('');
}

export function makeMirrorMap(size, block = ROM_BLOCK) {
  const total = Math.ceil(size / block);
  const bytes = new Uint8Array(8 + Math.ceil(total / 32) * 4);
  new DataView(bytes.buffer).setFloat64(0, size, true);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < total; i++) {
    const pos = 8 + (i >> 5) * 4;
    view.setUint32(pos, view.getUint32(pos, true) | ((1 << (i & 31)) >>> 0), true);
  }
  return bytes;
}

export function mirrorMapComplete(bytes, size, block = ROM_BLOCK) {
  const total = Math.ceil(size / block);
  if (bytes.byteLength !== 8 + Math.ceil(total / 32) * 4 ||
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true) !== size) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < total; i++) {
    if (!(view.getUint32(8 + (i >> 5) * 4, true) & (1 << (i & 31)))) return false;
  }
  return true;
}

export function planEvictions(groups, incomingKey, incomingSize, freeBytes, protectedKeys = new Set(), limitBytes = ROM_LIMIT) {
  const active = groups.filter(g => g.key !== incomingKey);
  const ownSize = groups.find(g => g.key === incomingKey)?.bytes || 0;
  let used = groups.reduce((n, g) => n + g.bytes, 0);
  let free = freeBytes;
  const evict = [];
  // A resumable OPFS sync writer grows the existing .bin in place. The fallback
  // createWritable() may instead need a second copy; callers can opt into that reserve.
  const remaining = Math.max(0, incomingSize - ownSize);
  const needFree = remaining + ROM_RESERVE;
  const candidates = active.filter(g => !protectedKeys.has(g.key))
    .sort((a, b) => (a.lastPlayed || a.used || 0) - (b.lastPlayed || b.used || 0));
  while ((used - ownSize + incomingSize > limitBytes || free < needFree) && candidates.length) {
    const victim = candidates.shift();
    evict.push(victim);
    used -= victim.bytes;
    free += victim.bytes;
  }
  return { evict, enough: incomingSize <= limitBytes &&
    used - ownSize + incomingSize <= limitBytes && free >= needFree };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) req.result.createObjectStore('handles');
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
      if (!req.result.objectStoreNames.contains(IDB_CHUNK_STORE)) req.result.createObjectStore(IDB_CHUNK_STORE);
      if (!req.result.objectStoreNames.contains(IDB_STATE_STORE)) req.result.createObjectStore(IDB_STATE_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database occupato da un’altra scheda.'));
  });
}
async function dbAction(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  } finally { db.close(); }
}
const byRecent = (a, b) => (b.lastPlayed || b.addedAt || 0) - (a.lastPlayed || a.addedAt || 0);
export const listCatalog = async () => (await dbAction('readonly', store => store.getAll())).sort(byRecent);
export const getCatalogGame = key => dbAction('readonly', store => store.get(key));
export const putCatalogGame = entry => dbAction('readwrite', store => store.put(entry));
export const deleteCatalogGame = key => dbAction('readwrite', store => store.delete(key));

// IndexedDB Blob-chunk fallback for Safari/WebKit variants without either OPFS
// writing API. It shares the same quota as OPFS but never touches IDBFS saves.
const chunkId = (key, index) => `${key}:${String(index).padStart(6, '0')}`;
const chunkRange = key => IDBKeyRange.bound(`${key}:`, `${key};`);
async function idbAction(storeName, mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = operation(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || req?.error || new Error('IndexedDB non disponibile'));
    });
  } finally { db.close(); }
}
const cacheState = key => idbAction(IDB_STATE_STORE, 'readonly', store => store.get(key));
const allCacheStates = () => idbAction(IDB_STATE_STORE, 'readonly', store => store.getAll());

async function removeIdbCache(key) {
  if (!await cacheState(key)) return;
  const db = await openDb();
  try {
    const ids = await idbAction(IDB_CHUNK_STORE, 'readonly', store => store.getAllKeys(chunkRange(key)));
    await new Promise((resolve, reject) => {
      const tx = db.transaction([IDB_CHUNK_STORE, IDB_STATE_STORE], 'readwrite');
      for (const id of ids) tx.objectStore(IDB_CHUNK_STORE).delete(id);
      tx.objectStore(IDB_STATE_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Rimozione cache IndexedDB non riuscita'));
    });
  } finally { db.close(); }
}

async function cachedIdbFile(game) {
  if (!game?.key) return null;
  const state = await cacheState(game.key);
  if (!state?.completed || state.total !== game.size || state.bytesStored !== game.size) return null;
  const chunks = await idbAction(IDB_CHUNK_STORE, 'readonly', store => store.getAll(chunkRange(game.key)));
  const expected = Math.ceil(game.size / COPY_CHUNK);
  if (chunks.length !== expected || chunks.some((chunk, i) => !(chunk instanceof Blob) ||
      chunk.size !== Math.min(COPY_CHUNK, game.size - i * COPY_CHUNK))) return null;
  // Blob concatenation is lazy on most browsers; no arrayBuffer() of the full ROM.
  return new File(chunks, game.name, { lastModified: game.lastModified || Date.now() });
}

async function copyIdbChunks(file, game, onProgress) {
  let state = await cacheState(game.key);
  if (state && (state.total !== file.size || state.bytesStored % COPY_CHUNK !== 0 && !state.completed)) {
    await removeIdbCache(game.key);
    state = null;
  }
  let copied = state?.completed ? 0 : (state?.bytesStored || 0);
  if (state?.completed) { await removeIdbCache(game.key); }
  for (let offset = copied; offset < file.size; offset += COPY_CHUNK) {
    const end = Math.min(offset + COPY_CHUNK, file.size);
    // Materialise bytes now: persisting an un-read File.slice() can retain an
    // invalid external File backing store after Safari revokes picker access.
    const blob = new Blob([await readSourceChunk(file, offset, end)]);
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction([IDB_CHUNK_STORE, IDB_STATE_STORE], 'readwrite');
        tx.objectStore(IDB_CHUNK_STORE).put(blob, chunkId(game.key, Math.floor(offset / COPY_CHUNK)));
        tx.objectStore(IDB_STATE_STORE).put({ key: game.key, total: file.size,
          bytesStored: end, completed: end === file.size, updatedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Copia IndexedDB non riuscita'));
      });
    } finally { db.close(); }
    onProgress(end / file.size, end, file.size, copied);
    if (end !== file.size) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { cached: Boolean(await cachedIdbFile(game)), backend: 'indexeddb' };
}

export async function registerRom(file) {
  if (!validRom(file)) throw new Error('Seleziona una ROM 3DS valida (.3ds, .cci, .cxi, .app, .3dsx o .elf).');
  const key = await romFingerprint(file);
  const existing = await getCatalogGame(key);
  const entry = {
    key, name: existing?.name || file.name, size: file.size, lastModified: file.lastModified,
    addedAt: existing?.addedAt || Date.now(), lastPlayed: Date.now(),
  };
  await putCatalogGame(entry);
  return entry;
}

async function directory() {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(DIR_NAME, { create: true });
  } catch (error) {
    if (['NotSupportedError', 'NotAllowedError', 'SecurityError'].includes(error?.name)) return null;
    throw error;
  }
}

export async function scanMirrors(dir) {
  const groups = new Map();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !/^[a-f0-9]{64}\.(bin|map)$/.test(name)) continue;
    const key = name.slice(0, 64);
    const file = await handle.getFile();
    if (!groups.has(key)) groups.set(key, { key, bytes: 0, used: 0 });
    const group = groups.get(key);
    group.bytes += file.size;
    group.used = Math.max(group.used, file.lastModified);
  }
  const catalog = await listCatalog();
  const recents = new Map(catalog.map(g => [g.key, g.lastPlayed || g.addedAt || 0]));
  return [...groups.values()].map(g => ({ ...g, lastPlayed: recents.get(g.key) || g.used }));
}

export async function cachedFile(game) {
  if (!game?.key) return null;
  const dir = await directory();
  if (dir) try {
    const [bin, map] = await Promise.all([
      dir.getFileHandle(`${game.key}.bin`), dir.getFileHandle(`${game.key}.map`),
    ]);
    const [file, marker] = await Promise.all([bin.getFile(), map.getFile()]);
    if (file.size === game.size && mirrorMapComplete(new Uint8Array(await marker.arrayBuffer()), game.size)) {
      return new File([file], game.name, { lastModified: game.lastModified || Date.now() });
    }
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
  return cachedIdbFile(game);
}

export async function cacheUsage() {
  const dir = await directory();
  const groups = dir ? await scanMirrors(dir) : [];
  const idb = await allCacheStates();
  return { supported: Boolean(dir || typeof indexedDB !== 'undefined'),
    used: groups.reduce((s, g) => s + g.bytes, 0) + idb.reduce((s, g) => s + (g.bytesStored || 0), 0),
    limit: ROM_LIMIT };
}

async function eraseMirror(dir, key) {
  for (const suffix of ['map', 'bin']) {
    try { await dir.removeEntry(`${key}.${suffix}`); }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
  }
}

export async function removeCachedRom(key) {
  const dir = await directory();
  if (dir) await eraseMirror(dir, key);
  await removeIdbCache(key);
}

// Safari transfer protocol: read each 4 MiB chunk on the page, transfer only the
// ArrayBuffer to a dedicated worker, write it to OPFS and wait for ACK. No 2 GB
// buffer, no long-lived File clone in a worker, no concurrent core reads.
async function transferCopy(file, game, onProgress) {
  if (typeof Worker !== 'function') return { supported: false };
  let worker;
  try {
    worker = new Worker(new URL('./gaemboy3ds-cache-transfer-worker.js?v=07', import.meta.url), { type: 'module' });
  } catch { return { supported: false }; }
  return new Promise(resolve => {
    let settled = false;
    let offset = 0;
    let resumed = 0;
    let sourceFailure = null;
    let abortTimer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (abortTimer !== null) clearTimeout(abortTimer);
      worker.terminate();
      resolve(result);
    };
    const failSource = error => {
      sourceFailure = { supported: true, cached: false, reason: 'source-unreadable',
        error: String(error?.message || error), bytes: offset, total: file.size };
      // Let the worker close its OPFS access handle before the next reimport.
      try { worker.postMessage({ type: 'abort' }); }
      catch { finish(sourceFailure); return; }
      abortTimer = setTimeout(() => finish(sourceFailure), 2000);
    };
    const pump = async () => {
      if (settled) return;
      if (offset >= file.size) {
        worker.postMessage({ type: 'finish' });
        return;
      }
      const end = Math.min(file.size, offset + COPY_CHUNK);
      try {
        const bytes = await readSourceChunk(file, offset, end);
        if (!settled) worker.postMessage({ type: 'chunk', offset, bytes }, [bytes]);
      } catch (error) { if (!settled) failSource(error); }
    };
    worker.onerror = event => {
      event.preventDefault?.();
      finish({ supported: false, reason: 'transfer-worker-unavailable' });
    };
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'aborted' && sourceFailure) {
        finish(sourceFailure);
      } else if (sourceFailure) {
        return;
      } else if (data.type === 'ready') {
        resumed = data.resumed || 0;
        offset = resumed;
        onProgress(file.size ? offset / file.size : 0, offset, file.size, resumed);
        void pump();
      } else if (data.type === 'written') {
        if (!Number.isSafeInteger(data.bytes) || data.bytes < offset || data.bytes > file.size) {
          finish({ supported: true, cached: false, reason: 'invalid-worker-ack' }); return;
        }
        offset = data.bytes;
        onProgress(offset / file.size, offset, file.size, resumed);
        void pump();
      } else if (data.type === 'complete') {
        finish({ supported: true, cached: true, backend: 'opfs-transfer', resumed });
      } else if (data.type === 'unsupported') {
        finish({ supported: false, reason: 'opfs-sync-unsupported' });
      } else if (data.type === 'error') {
        finish({ supported: true, cached: false, reason: data.code || 'opfs-write-failed',
          error: data.message, stage: data.stage, bytes: offset, total: file.size });
      }
    };
    try { worker.postMessage({ type: 'start', key: game.key, size: file.size }); }
    catch { finish({ supported: false, reason: 'transfer-post-failed' }); }
  });
}

// Uses a dedicated worker so large ROMs never need to be buffered in the UI thread.
// Explicit 'unsupported' falls back to createWritable() in the page.
async function incrementalCopy(file, game, onProgress) {
  if (typeof Worker !== 'function') return { supported: false };
  let worker;
  try {
    worker = new Worker(new URL('./gaemboy3ds-cache-copy-worker.js?v=06', import.meta.url), { type: 'module' });
  } catch { return { supported: false }; }
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(result);
    };
    worker.onerror = event => {
      event.preventDefault?.();
      finish({ supported: false, reason: 'worker-unavailable' });
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        onProgress(data.bytes / data.total, data.bytes, data.total, data.resumed || 0);
      } else if (data.type === 'complete') {
        finish({ supported: true, cached: true, resumed: data.resumed || 0 });
      } else if (data.type === 'unsupported') {
        finish({ supported: false });
      } else if (data.type === 'error') {
        finish({ supported: true, cached: false, reason: data.code || 'write-failed', error: data.message });
      }
    };
    try { worker.postMessage({ file, key: game.key }); }
    catch (error) { finish({ supported: false, reason: error?.name || 'worker-post-failed' }); }
  });
}

export async function cacheRom(file, game, { activeKeys = new Set(), confirmEviction = () => false, onProgress = () => {}, limitBytes = ROM_LIMIT } = {}) {
  if (!validRom(file) || file.size !== game.size) throw new Error('File ROM non corrispondente.');
  // Caller may raise the cap only after validating a signed Gaemboy entitlement.
  limitBytes = Number.isFinite(limitBytes) ? Math.max(0, Math.min(8 * 1024 ** 3, limitBytes)) : ROM_LIMIT;
  if (file.size > limitBytes) return { cached: false, reason: 'oversize' };
  const dir = await directory();
  if (!dir && typeof indexedDB === 'undefined') return { cached: false, reason: 'unsupported' };
  if (await cachedFile(game)) return { cached: true, reused: true };
  const execute = async () => {
    // A second browser tab cannot safely overwrite a mirror while the first one is using it.
    if (await cachedFile(game)) return { cached: true, reused: true };
    const groups = [
      ...(dir ? await scanMirrors(dir) : []),
      ...(await allCacheStates()).map(s => ({ key: s.key, bytes: s.bytesStored || 0, used: s.updatedAt || 0 })),
    ];
    const usage = await navigator.storage?.estimate?.();
    if (!usage || !Number.isFinite(usage.quota) || !Number.isFinite(usage.usage))
      return { cached: false, reason: 'quota-unavailable' };
    const free = Math.max(0, usage.quota - usage.usage);
    const plan = planEvictions(groups, game.key, game.size, free, activeKeys, limitBytes);
    if (!plan.enough) return { cached: false, reason: 'space', freeBytes: free, requiredBytes: game.size + ROM_RESERVE };
    if (plan.evict.length && !(await confirmEviction(plan.evict)))
      return { cached: false, reason: 'cancelled' };
    // Replacing an incomplete mirror invalidates its bitmap first; never publish partial bytes.
    for (const victim of plan.evict) {
      if (dir) await eraseMirror(dir, victim.key);
      await removeIdbCache(victim.key);
    }
    // Worker API is supported in WebKit; it publishes both .bin AND .map via
    // createSyncAccessHandle, never createWritable() alone.
    if (dir && prefersSequentialCache()) {
      const transfer = await transferCopy(file, game, onProgress);
      if (transfer.supported) return transfer;
    }
    if (dir) {
      const incremental = await incrementalCopy(file, game, onProgress);
      if (incremental.supported) return incremental;
    }
    // Chromium can also provide async writable streams, but Safari may expose
    // neither on the page. Check BOTH handles before attempting either one.
    const target = dir ? await dir.getFileHandle(`${game.key}.bin`, { create: true }) : null;
    const markerTarget = dir ? await dir.getFileHandle(`${game.key}.map`, { create: true }) : null;
    if (!target || typeof target.createWritable !== 'function' ||
        !markerTarget || typeof markerTarget.createWritable !== 'function') {
      if (dir) await eraseMirror(dir, game.key);
      return copyIdbChunks(file, game, onProgress);
    }
    // An async writer may use another full-size temporary file internally.
    const updated = await scanMirrors(dir);
    const priorSize = updated.find(g => g.key === game.key)?.bytes || 0;
    const recent = await navigator.storage.estimate();
    if (recent.quota - recent.usage + priorSize < file.size + ROM_RESERVE)
      return { cached: false, reason: 'space' };
    await eraseMirror(dir, game.key);
    const asyncTarget = await dir.getFileHandle(`${game.key}.bin`, { create: true });
    const writer = await asyncTarget.createWritable();
    let copied = 0;
    try {
      for (let offset = 0; offset < file.size; offset += COPY_CHUNK) {
        const end = Math.min(file.size, offset + COPY_CHUNK);
        await writer.write(await file.slice(offset, end).arrayBuffer());
        copied = end;
        onProgress(copied / file.size, copied, file.size);
        // Yield to rendering/input; the original File remains available to the running core.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await writer.close();
      const map = await dir.getFileHandle(`${game.key}.map`, { create: true });
      const mark = await map.createWritable();
      try { await mark.write(makeMirrorMap(file.size)); await mark.close(); }
      catch (error) { await mark.abort().catch(() => {}); throw error; }
      return { cached: true };
    } catch (error) {
      await writer.abort().catch(() => {});
      await eraseMirror(dir, game.key).catch(() => {});
      return { cached: false, reason: error?.name || 'write-failed', error };
    }
  };
  if (navigator.locks?.request) {
    // A single cross-tab lock protects selection and writing of all ROM cache files.
    return navigator.locks.request('gaemboy-3ds-rom-cache', { mode: 'exclusive' }, execute);
  }
  return execute();
}
