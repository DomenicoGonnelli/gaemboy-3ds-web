import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, defaults, normalizeBindings, remap, toMaps, validCode, describeCode } from '../web/gaemboy3ds-keymap.js';
test('keyboard defaults preserve the previous emulation mapping',()=>{
 const v=defaults();const out=toMaps(v);
 assert.equal(out.buttons.KeyX,8);assert.equal(out.buttons.KeyZ,0);
 assert.equal(out.buttons.ArrowUp,4);assert.equal(out.buttons.Enter,3);
 assert.deepEqual(out.sticks.KeyJ,['analogLX',-1]);assert.equal(ACTIONS.length,22);
});
test('Escape and browser management keys are reserved',()=>{
 for(const code of ['Escape','Tab','F5','MetaLeft','ControlLeft','ShiftRight','AltLeft']) assert.equal(validCode(code),false);
 assert.equal(validCode('KeyV'),true);assert.equal(validCode('ArrowDown'),true);
});
test('remapping swaps a duplicate to preserve all keys',()=>{
 let initial=defaults();const updated=remap(initial,'a','KeyZ');
 assert.equal(updated.a,'KeyZ');assert.equal(updated.b,'KeyX');
 assert.equal(toMaps(updated).buttons.KeyZ,8);
 assert.equal(new Set(Object.values(updated)).size,ACTIONS.length);
});
test('invalid input never corrupts the mapping',()=>{
 const initial=defaults();assert.equal(remap(initial,'a','Escape'),null);
 assert.equal(remap(initial,'unknown','KeyH'),null);
 const repaired=normalizeBindings({...initial,a:'Escape',b:'KeyX'});
 assert.equal(new Set(Object.values(repaired)).size,ACTIONS.length);
 assert.equal(repaired.a!== 'Escape',true);
});
test('labels are readable to users',()=>{
 assert.equal(describeCode('KeyX'),'X');assert.equal(describeCode('ArrowLeft'),'Sinistra');
});
