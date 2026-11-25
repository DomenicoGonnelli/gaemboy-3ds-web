import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { mirrorMapComplete } from '../web/gaemboy3ds-cache.js';

const MiB = 1024 * 1024;
const source = readFileSync(new URL('../web/gaemboy3ds-cache-copy-worker.js', import.meta.url), 'utf8');

class FakeDirectory {
  files = new Map();
  failAfterWrites = Infinity;
  writes = 0;
  syncOnly = false;
  async getDirectoryHandle(name) { assert.equal(name, 'gaemboy-rom-mirror'); return this; }
  async removeEntry(name) {
    if (!this.files.delete(name)) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
  }
  async getFileHandle(name) {
    if (!this.files.has(name)) this.files.set(name, new Uint8Array(0));
    const self = this;
    return {
      // WebKit simulation: no async createWritable method anywhere.
      ...(this.syncOnly ? {} : { async createWritable() {
        let bytes;
        return {
          async write(data) { bytes = new Uint8Array(data); },
          async close() { self.files.set(name,bytes); },
          async abort() {},
        };
      }}),
      async createSyncAccessHandle() {
        return {
          getSize: () => self.files.get(name).byteLength,
          truncate(size) { self.files.set(name, self.files.get(name).slice(0, size)); },
          write(data, { at }) {
            self.writes++;
            if (self.writes > self.failAfterWrites) throw new Error('Simulated browser interruption');
            const old = self.files.get(name);
            const next = new Uint8Array(Math.max(old.byteLength, at + data.byteLength));
            next.set(old);next.set(data,at);self.files.set(name,next);
            return data.byteLength;
          },
          flush() {}, close() {},
        };
      },
    };
  }
}

async function runWorker(dir, file, key) {
  const messages=[];
  const scope={ postMessage: message => messages.push(message) };
  runInNewContext(source, { self:scope, navigator:{storage:{getDirectory:async()=>dir}}, Blob, Uint8Array, DataView, Number, Error });
  await scope.onmessage({data:{file,key}});
  return messages;
}

test('incremental cache worker only publishes .map after successful full copy',async()=>{
  const dir = new FakeDirectory();
  const bytes = new Uint8Array(11*MiB+11);
  for(let i=0;i<bytes.length;i+=1017)bytes[i]=i%251;
  const key='a'.repeat(64),file=new Blob([bytes]);
  dir.failAfterWrites=1;
  const interrupted=await runWorker(dir,file,key);
  assert.equal(interrupted.at(-1).type,'error');
  assert.equal(dir.files.has(key+'.map'),false);
  assert.equal(dir.files.get(key+'.bin').byteLength,4*MiB);
  dir.failAfterWrites=Infinity;
  const resumed=await runWorker(dir,file,key);
  assert.equal(resumed.at(-1).type,'complete');
  assert.equal(resumed[0].resumed,4*MiB);
  assert.deepEqual(dir.files.get(key+'.bin'),bytes);
  assert.equal(mirrorMapComplete(dir.files.get(key+'.map'),file.size),true);
});

test('a full-length file missing its map is recopied rather than trusted',async()=>{
  const dir=new FakeDirectory();
  const file=new Blob([new Uint8Array([1,2,3,4])]),key='b'.repeat(64);
  dir.files.set(key+'.bin',new Uint8Array([8,9,7,6]));
  const messages=await runWorker(dir,file,key);
  assert.equal(messages[0].resumed,0);
  assert.deepEqual(dir.files.get(key+'.bin'),new Uint8Array([1,2,3,4]));
  assert.equal(mirrorMapComplete(dir.files.get(key+'.map'),file.size),true);
});

test('invalid key is rejected without creating any files',async()=>{
  const dir=new FakeDirectory();
  const messages=await runWorker(dir,new Blob(['hello']),'../../saves');
  assert.equal(messages.at(-1).code,'invalid-input');
  assert.equal(dir.files.size,0);
});

test('Safari OPFS writer publishes both data and bitmap without createWritable()', async () => {
  const dir = new FakeDirectory();
  dir.syncOnly = true;
  const file = new Blob([new Uint8Array([7, 9, 11, 13, 15])]);
  const key = 'c'.repeat(64);
  const messages = await runWorker(dir, file, key);
  assert.equal(messages.at(-1).type, 'complete');
  assert.equal(mirrorMapComplete(dir.files.get(key+'.map'),file.size),true);
  assert.deepEqual(dir.files.get(key+'.bin'),new Uint8Array([7,9,11,13,15]));
});
