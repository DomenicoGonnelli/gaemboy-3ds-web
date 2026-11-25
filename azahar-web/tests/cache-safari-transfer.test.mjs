import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { mirrorMapComplete, prefersSequentialCache, readSourceChunk } from '../web/gaemboy3ds-cache.js';

const source = readFileSync(new URL('../web/gaemboy3ds-cache-transfer-worker.js', import.meta.url), 'utf8');
class Directory {
  files = new Map();
  async getDirectoryHandle(n) { assert.equal(n, 'gaemboy-rom-mirror'); return this; }
  async removeEntry(n) {
    if (!this.files.delete(n)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
  }
  async getFileHandle(name) {
    if (!this.files.has(name)) this.files.set(name,new Uint8Array(0));
    return { createSyncAccessHandle: async () => ({
      getSize: () => this.files.get(name).length,
      truncate: len => { this.files.set(name, this.files.get(name).slice(0,len)); },
      write: (bytes,{at}) => {
        const old=this.files.get(name),next=new Uint8Array(Math.max(old.length,at+bytes.length));
        next.set(old);next.set(bytes,at);this.files.set(name,next);return bytes.length;
      },
      flush() {}, close() {},
    }) };
  }
}
function start(dir) {
  const messages=[];
  const scope={ postMessage: m=>messages.push(m) };
  runInNewContext(source,{self:scope,navigator:{storage:{getDirectory:async()=>dir}},Uint8Array,DataView,Number,String,Error,ArrayBuffer});
  return { messages, send: data => scope.onmessage({data}) };
}

test('Safari detection enables sequential copy only for Safari/WebKit',()=>{
  assert.equal(prefersSequentialCache('Mozilla/5.0 Macintosh AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'),true);
  assert.equal(prefersSequentialCache('Mozilla/5.0 iPhone AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1'),true);
  assert.equal(prefersSequentialCache('Mozilla/5.0 Chrome/130.0 Safari/537.36'),false);
  assert.equal(prefersSequentialCache('Mozilla/5.0 Edg/130.0 Chrome/130.0 Safari/537.36'),false);
});

test('source read retries a transient Safari NotReadableError',async()=>{
  let attempts=0;
  const sourceFile={ slice(){return{arrayBuffer:async()=>{
    attempts++;
    if(attempts<2)throw Object.assign(new Error('busy'),{name:'NotReadableError'});
    return new Uint8Array([1,2,3,4]).buffer;
  }};}};
  const buf=await readSourceChunk(sourceFile,0,4);
  assert.deepEqual([...new Uint8Array(buf)],[1,2,3,4]);
  assert.equal(attempts,2);
});

test('OPFS transfer worker does not publish map until finished and resumes a partial',async()=>{
  const dir=new Directory(),key='d'.repeat(64);
  const bytes=new Uint8Array(5*1024*1024+7);
  for(let i=0;i<bytes.length;i+=1009)bytes[i]=i%233;
  const first=start(dir);
  await first.send({type:'start',key,size:bytes.length});
  assert.equal(first.messages.at(-1).type,'ready');
  const part=bytes.slice(0,4*1024*1024).buffer;
  await first.send({type:'chunk',offset:0,bytes:part});
  assert.equal(first.messages.at(-1).bytes,4*1024*1024);
  assert.equal(dir.files.has(key+'.map'),false);
  await first.send({type:'abort'});
  const next=start(dir);
  await next.send({type:'start',key,size:bytes.length});
  assert.equal(next.messages.at(-1).resumed,4*1024*1024);
  await next.send({type:'chunk',offset:4*1024*1024,bytes:bytes.slice(4*1024*1024).buffer});
  await next.send({type:'finish'});
  assert.equal(next.messages.at(-1).type,'complete');
  assert.deepEqual(dir.files.get(key+'.bin'),bytes);
  assert.equal(mirrorMapComplete(dir.files.get(key+'.map'),bytes.length),true);
});

test('OPFS transfer refuses to mark ROM complete with bytes missing',async()=>{
  const dir=new Directory(),key='e'.repeat(64),runner=start(dir);
  await runner.send({type:'start',key,size:1024});
  await runner.send({type:'chunk',offset:0,bytes:new Uint8Array([1,2,3]).buffer});
  await runner.send({type:'finish'});
  assert.equal(runner.messages.at(-1).type,'error');
  assert.equal(dir.files.has(key+'.map'),false);
});
