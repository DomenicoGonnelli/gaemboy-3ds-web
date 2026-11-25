import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerRom, cacheRom, cachedFile, cacheUsage, removeCachedRom, listCatalog, romFingerprint,
} from '../web/gaemboy3ds-cache.js';

// Browser-independent IndexedDB simulation: every transaction finishes atomically.
function mockIndexedDB() {
  const stores = new Map();
  const db = {
    objectStoreNames: { contains: key => stores.has(key) },
    createObjectStore(key, opts = {}) { stores.set(key, { records: new Map(), keyPath: opts.keyPath }); },
    transaction(names) {
      const tx = { jobs: [], queued: false };
      const schedule = () => {
        if (tx.queued) return;
        tx.queued = true;
        setTimeout(() => {
          try {
            for (const [req, job] of tx.jobs) req.result = job();
            tx.oncomplete?.();
          } catch (e) { tx.error = e; tx.onerror?.(); }
        }, 0);
      };
      tx.objectStore = name => {
        assert(stores.has(name), name);
        const { records, keyPath } = stores.get(name);
        const match = (key, range) => !range || (key >= range.lower && key <= range.upper);
        const request = job => { const req = {}; tx.jobs.push([req, job]); schedule(); return req; };
        return {
          get: key => request(() => records.get(key)),
          getAll: range => request(() => [...records].filter(([key]) => match(key, range)).sort(([a],[b]) => String(a).localeCompare(String(b))).map(([,v]) => v)),
          getAllKeys: range => request(() => [...records.keys()].filter(k => match(k, range)).sort()),
          put: (value, key) => request(() => {
            const id = key ?? value[keyPath];
            records.set(id, value);
            return id;
          }),
          delete: key => request(() => records.delete(key)),
        };
      };
      return tx;
    },
    close() {},
  };
  globalThis.indexedDB = {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  globalThis.IDBKeyRange = { bound(lower, upper) { return { lower, upper }; } };
}

class NoWritableDirectory {
  files = new Map();
  async getDirectoryHandle() { return this; }
  async getFileHandle(name, opts = {}) {
    if (!this.files.has(name)) {
      if (!opts.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      this.files.set(name, new Blob());
    }
    return { kind: 'file', getFile: async () => this.files.get(name) };
  }
  async removeEntry(name) {
    if (!this.files.delete(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
  }
  async *entries() {
    for (const name of this.files.keys()) yield [name, await this.getFileHandle(name)];
  }
}

test('Safari fallback: no OPFS writable methods still persists chunks and restarts ROM', async () => {
  mockIndexedDB();
  const dir = new NoWritableDirectory();
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{
    storage:{getDirectory:async()=>dir,estimate:async()=>({quota:512*1024*1024,usage:0})},
  }});
  const bytes = new Uint8Array(5*1024*1024+37);
  for (let i=0;i<bytes.length;i+=377) bytes[i]=i%251;
  const file = new File([bytes], 'Zaffiro_Omega.3ds');
  const game = await registerRom(file);
  const progress=[];
  const result = await cacheRom(file,game,{onProgress:ratio=>progress.push(ratio)});
  assert.equal(result.cached,true);
  assert.equal(result.backend,'indexeddb');
  assert.equal(progress.at(-1),1);
  const reloaded = await cachedFile(game);
  assert(reloaded instanceof File);
  assert.equal(reloaded.size,file.size);
  assert.equal(await romFingerprint(reloaded),game.key);
  assert((await cacheUsage()).used>=file.size);
  await removeCachedRom(game.key);
  assert.equal(await cachedFile(game),null);
  assert.equal((await listCatalog()).length,1);
});
