import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const web=path.resolve(import.meta.dirname,'../web');
const worker=fs.readFileSync(path.join(web,'gaemboy3ds-worker.js'),'utf8');
const page=fs.readFileSync(path.join(web,'gaemboy3ds-page.js'),'utf8');
const html=fs.readFileSync(path.join(web,'index.html'),'utf8');
const css=fs.readFileSync(path.join(web,'gaemboy3ds-game.css'),'utf8');
function slotsInMemory() {
  const stored=new Map([
    ['/gaemboy/3ds/saves/web-states/game/slot-1.gb3dsstate',{size:88,mtime:new Date(1000)}],
    ['/gaemboy/3ds/saves/web-states/game/slot-3.gb3dsstate',{size:99,mtime:new Date(3000)}],
    ['/gaemboy/3ds/saves/web-states/game/slot-3.preview.webp',{size:200,mtime:new Date(3000)}],
  ]);
  const src=worker.slice(worker.indexOf('const stateDir ='),worker.indexOf('function listCheats()'));
  const context={SAVES:'/gaemboy/3ds/saves',gameKey:'game',SLOT_COUNT:12,Number,
    mod:{FS:{analyzePath(p){return {exists:stored.has(p)}},stat(p){return stored.get(p)}}}};
  vm.runInNewContext(src+'\noutput=listSlots();',context);
  return context.output;
}
test('history keeps existing legacy slots, adds 9 more and detects preview sidecars',()=>{
  const slots=slotsInMemory();
  assert.equal(slots.length,12);
  assert.deepEqual(slots.filter(x=>x.exists).map(x=>x.slot).join(','),'1,3');
  assert.equal(slots[2].hasPreview,true);
  assert.equal(slots[0].hasPreview,false);
  assert.equal(slots[3].exists,false);
});
test('save states and screenshot are both written in IDBFS and synced once',()=>{
  assert.match(worker,/const previewPath = \(slot\) =>/);
  const fragment=worker.slice(worker.indexOf("case 'save-state':"),worker.indexOf("case 'load-state':"));
  assert.match(fragment,/mod\.FS\.rename\(temporary, path\)/);
  assert.match(fragment,/mod\.FS\.writeFile\(imagePath, bytes\)/);
  assert.match(fragment,/await syncSaves\('save state'\)/);
  assert.match(fragment,/case 'slot-preview'/);
  assert.match(fragment,/case 'capture-preview'/);
});
test('deleting a save removes only its state and preview, not ROM or any other saves',()=>{
  const fragment=worker.slice(worker.indexOf("case 'delete-state':"),worker.indexOf("case 'cheats':"));
  assert.match(fragment,/mod\.FS\.unlink\(path\)/);
  assert.match(fragment,/mod\.FS\.unlink\(imagePath\)/);
  assert.doesNotMatch(fragment,/removeCachedRom|ROM_MIRROR_LIMIT|deleteCatalog/);
});
test('gallery has screenshot cards and requires click-to-save/load, no auto-overwrite',()=>{
  assert.match(html,/id="gb14-state-gallery"/);
  assert.match(html,/id="gb14-gallery-list"/);
  assert.match(page,/function gb14StateCard\(slot, mode, snapshot/);
  assert.match(page,/gb14SaveState\(slot\.slot\)/);
  assert.match(page,/gb14LoadState\(slot\.slot\)/);
  assert.match(page,/entry\.exists && promptOverwrite && !confirm/);
  assert.match(page,/slots\.find\(x => !x\.exists\)/);
  assert.match(css,/\.gb14-state-preview img/);
});
test('settings tile and Tasti shortcut removed, while save actions and keyboard settings remain',()=>{
  assert.doesNotMatch(html,/id="gb13-quick-settings"/);
  assert.doesNotMatch(html,/id="gb14-open-keys"/);
  assert.doesNotMatch(page,/\$\('gb14-open-keys'\)/);
  assert.match(html,/id="keyboard-settings"/);
  assert.match(html,/id="gb13-quick-save"/);
  assert.match(html,/id="gb13-quick-load"/);
});

test('worker: create, list, load and delete a historical state with its preview', async()=>{
  const files = new Map(); let clock = 1000; let synced = 0;
  const FS = {
    analyzePath(p) { return { exists: files.has(p) }; },
    writeFile(p, contents) { files.set(p,{data: new Uint8Array(contents), mtime:new Date(++clock)}); },
    rename(oldPath,newPath) { const item=files.get(oldPath); assert(item,'temporary state exists'); files.set(newPath,item); files.delete(oldPath); },
    unlink(p) { files.delete(p); },
    stat(p) { const item=files.get(p); return {size:item.data.byteLength,mtime:item.mtime}; },
    readFile(p) { return files.get(p).data; },
  };
  const ctx = {
    SAVES:'/gaemboy/3ds/saves',gameKey:'game',SLOT_COUNT:12,
    storageError:null,Number,Uint8Array,Blob,Error,
    mod:{FS,_gb3ds_save_state_file(p){ FS.writeFile(p,new Uint8Array([1,2,3,4])); return 1; },
      _gb3ds_load_state_file(p){return FS.analyzePath(p).exists ? 1 : 0;}},
    ensurePath(){},callWithStrings(strings,fn){return fn(...strings)},
    async syncSaves(){ synced++; },logLine(){},
  };
  const helper=worker.slice(worker.indexOf('const stateDir ='),worker.indexOf('function listCheats()'));
  const actions=worker.slice(worker.indexOf('async function command('),worker.indexOf("    case 'cheats':"));
  vm.runInNewContext(helper+'\n'+actions+'default: throw new Error("unexpected action");\n  }\n}\n',ctx);
  const data=new Uint8Array([82,73,70,70]);
  const first=await ctx.command('save-state',{slot:4,preview:data});
  assert.equal(first.slots[3].exists,true);
  assert.equal(first.slots[3].hasPreview,true);
  assert.equal(synced,1);
  const preview=await ctx.command('slot-preview',{slot:4});
  assert.equal(Array.from(preview.preview).join(','),'82,73,70,70');
  assert.equal((await ctx.command('load-state',{slot:4})).slots[3].exists,true);
  await ctx.command('delete-state',{slot:4});
  assert.equal(files.has('/gaemboy/3ds/saves/web-states/game/slot-4.gb3dsstate'),false);
  assert.equal(files.has('/gaemboy/3ds/saves/web-states/game/slot-4.preview.webp'),false);
  assert.equal(synced,2);
});
