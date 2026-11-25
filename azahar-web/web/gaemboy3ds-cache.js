// GAEMBOY 3DS: persistent catalog + a single, disposable OPFS ROM cache.
// The .bin/.map format intentionally matches gaemboy3ds-worker.js; IDBFS saves are unrelated.
export const ROM_LIMIT = 3 * 1024 ** 3; // Free public site; Premium limit is explicit and verified.
export const ROM_RESERVE = 64 * 1024 ** 2;
const ROM_BLOCK = 1024 ** 2;
const COPY_CHUNK = 4 * ROM_BLOCK;
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
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) req.result.createObjectStore('handles');
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
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
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
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
  const dir = await directory();
  if (!dir || !game?.key) return null;
  try {
    const [bin, map] = await Promise.all([
      dir.getFileHandle(`${game.key}.bin`), dir.getFileHandle(`${game.key}.map`),
    ]);
    const [file, marker] = await Promise.all([bin.getFile(), map.getFile()]);
    if (file.size !== game.size || !mirrorMapComplete(new Uint8Array(await marker.arrayBuffer()), game.size)) return null;
    // File([Blob]) is a lazy Blob wrapper: the core still uses WORKERFS.slice(), not full memory copy.
    return new File([file], game.name, { lastModified: game.lastModified || Date.now() });
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

export async function cacheUsage() {
  const dir = await directory();
  if (!dir) return { supported: false, used: 0, limit: ROM_LIMIT };
  const groups = await scanMirrors(dir);
  return { supported: true, used: groups.reduce((s, g) => s + g.bytes, 0), limit: ROM_LIMIT };
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
}

// Uses a dedicated worker so large ROMs never need to be buffered in the UI thread.
// Explicit 'unsupported' falls back to createWritable() in the page.
async function incrementalCopy(file, game, onProgress) {
  if (typeof Worker !== 'function') return { supported: false };
  let worker;
  try {
    worker = new Worker(new URL('./gaemboy3ds-cache-copy-worker.js', import.meta.url), { type: 'module' });
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
  if (!dir) return { cached: false, reason: 'unsupported' };
  if (await cachedFile(game)) return { cached: true, reused: true };
  const execute = async () => {
    // A second browser tab cannot safely overwrite a mirror while the first one is using it.
    if (await cachedFile(game)) return { cached: true, reused: true };
    const groups = await scanMirrors(dir);
    const usage = await navigator.storage?.estimate?.();
    if (!usage || !Number.isFinite(usage.quota) || !Number.isFinite(usage.usage))
      return { cached: false, reason: 'quota-unavailable' };
    const free = Math.max(0, usage.quota - usage.usage);
    const plan = planEvictions(groups, game.key, game.size, free, activeKeys, limitBytes);
    if (!plan.enough) return { cached: false, reason: 'space', freeBytes: free, requiredBytes: game.size + ROM_RESERVE };
    if (plan.evict.length && !(await confirmEviction(plan.evict)))
      return { cached: false, reason: 'cancelled' };
    // Replacing an incomplete mirror invalidates its bitmap first; never publish partial bytes.
    for (const victim of plan.evict) await eraseMirror(dir, victim.key);
    // Keep any incomplete .bin: a repeated import can continue after the last
    // fully-written 4 MiB chunk. The worker publishes the .map only on success.
    const incremental = await incrementalCopy(file, game, onProgress);
    if (incremental.supported) return incremental;
    // Fallback is an atomic copy. It needs room for a temporary full file, not
    // just the missing part of an existing mirror.
    const updated = await scanMirrors(dir);
    const priorSize = updated.find(g => g.key === game.key)?.bytes || 0;
    const recent = await navigator.storage.estimate();
    if (recent.quota - recent.usage + priorSize < file.size + ROM_RESERVE)
      return { cached: false, reason: 'space' };
    await eraseMirror(dir, game.key);
    const target = await dir.getFileHandle(`${game.key}.bin`, { create: true });
    const writer = await target.createWritable();
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
