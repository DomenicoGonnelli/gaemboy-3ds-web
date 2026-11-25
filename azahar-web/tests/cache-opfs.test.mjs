import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRom, romFingerprint, listCatalog, cachedFile, cacheRom, removeCachedRom, cacheUsage } from '../web/gaemboy3ds-cache.js';

class FakeDirectory {
  constructor() {this.files = new Map(); this.dirs = new Map();}
  async getDirectoryHandle(name, options={}) {
    if (!this.dirs.has(name)) {
      if (!options.create) throw Object.assign(new Error('NotFound'),{name:'NotFoundError'});
      this.dirs.set(name,new FakeDirectory());
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name,options={}) {
    if (!this.files.has(name)) {
      if (!options.create) throw Object.assign(new Error('NotFound'),{name:'NotFoundError'});
      this.files.set(name,new Uint8Array());
    }
    return {
      kind:'file',
      getFile:async()=>new File([this.files.get(name)],name),
      createWritable:async()=>{
        const chunks=[];
        return {
          write:async bytes=>chunks.push(new Uint8Array(bytes)),
          close:async()=>{const length=chunks.reduce((n,c)=>n+c.byteLength,0);const all=new Uint8Array(length);let at=0;for(const c of chunks){all.set(c,at);at+=c.byteLength;}this.files.set(name,all);},
          abort:async()=>{},
        };
      },
    };
  }
  async removeEntry(name) {
    if (!this.files.delete(name)) throw Object.assign(new Error('NotFound'),{name:'NotFoundError'});
  }
  async *entries() {for(const name of this.files.keys()) yield [name,await this.getFileHandle(name)];}
}
function fakeDb() {
  const databases = new Map();
  globalThis.indexedDB = {
    open(name, version) {
      const req = {};
      setTimeout(() => {
        let db=databases.get(name);
        const upgrade=!db;
        if (!db) {
          const data=new Map();
          db={
            objectStoreNames:{contains:store=>data.has(store)},
            createObjectStore(store){data.set(store,new Map());},
            transaction(store){
              const tx={};
              tx.objectStore=()=>{
                const map=data.get(store);
                function run(op) {
                  const r={};
                  setTimeout(()=>{ try {r.result=op(); tx.oncomplete?.(); } catch(err){tx.error=err;tx.onerror?.();} },0);
                  return r;
                }
                return {
                  get:key=>run(()=>map.get(key)),
                  getAll:()=>run(()=>[...map.values()]),
                  put:(value,key)=>run(()=>{map.set(key??value.key,value);return value.key;}),
                  delete:key=>run(()=>map.delete(key)),
                };
              };
              return tx;
            },
            close(){},
          };
          databases.set(name,db);
        }
        req.result=db;
        if(upgrade)req.onupgradeneeded?.();
        req.onsuccess?.();
      },0);
      return req;
    },
  };
}

test('OPFS copy -> reload from cache -> deletion preserves catalog entry', async () => {
  fakeDb();
  const root=new FakeDirectory();
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ storage:{getDirectory:async()=>root,estimate:async()=>({quota:512*1024*1024,usage:0})} }});
  const bytes=new Uint8Array(4*1024*1024+8);
  for(let i=0;i<bytes.length;i+=1000)bytes[i]=(i/1000)%256;
  const file=new File([bytes],'Pokemon_Test.3ds');
  const record=await registerRom(file);
  assert.equal((await listCatalog()).length,1);
  const progress=[];
  const result=await cacheRom(file,record,{onProgress:n=>progress.push(n)});
  assert.equal(result.cached,true);
  assert.equal(progress.at(-1),1);
  const restored=await cachedFile(record);
  assert(restored instanceof File);
  assert.equal(restored.size,file.size);
  assert.equal(restored.name,file.name);
  assert.equal(await romFingerprint(restored),record.key);
  assert((await cacheUsage()).used>=file.size);
  await removeCachedRom(record.key);
  assert.equal(await cachedFile(record),null);
  assert.equal((await listCatalog()).length,1);
});
