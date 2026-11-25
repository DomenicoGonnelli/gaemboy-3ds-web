import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname,'../web');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const css = fs.readFileSync(path.join(root,'gaemboy3ds-game.css'),'utf8');
const js = fs.readFileSync(path.join(root,'gaemboy3ds-game.js'),'utf8');
function evaluate(mobile, config={}) {
  const classes = new Set();
  const body = { classList: {toggle(k,b) { b ? classes.add(k) : classes.delete(k); }}, dataset:{} };
  let applyHandler = null;
  const ctx = {
    window: {Gaemboy3DSGameOptions:config, matchMedia() { return { matches:mobile, addEventListener(name,fn) { applyHandler=fn; } }; }},
    document: {body, addEventListener(type,fn) { if (type==='DOMContentLoaded') fn(); }, getElementById(id) { return id==='gb3-console' ? {setAttribute() {}} : null; }}
  };
  vm.runInNewContext(js,ctx);
  return { classes, ctx, body, applyHandler };
}
test('game view retains single canvas and original control identifiers',()=>{
  assert.equal((html.match(/id="screen"/g)||[]).length,1);
  assert.equal((html.match(/id="touch-controls"/g)||[]).length,1);
  assert.equal((html.match(/id="open-menu"/g)||[]).length,1);
  for (const n of [0,1,2,3,4,5,6,7,8,9,10,11,12,13]) assert.match(html,new RegExp(`data-button="${n}"`));
  assert.match(html,/data-stick="left"/);
  assert.match(html,/data-stick="right"/);
  assert.match(html,/gaemboy3ds-game\.css\?v=11/);
  assert.match(html,/gaemboy3ds-game\.js\?v=11/);
});
test('desktop defaults to themed skin and active onscreen controls',()=>{
  const {classes}=evaluate(false);
  assert(classes.has('gb3-game-skin'));
  assert(!classes.has('gb3-game-no-skin'));
  assert(!classes.has('gb3-game-controls-hidden'));
});
test('touch/mobile never shows skin even if asked to',()=>{
  const {classes}=evaluate(true,{desktopSkin:'gaemboy',mobileSkin:true});
  assert(classes.has('gb3-game-no-skin'));
  assert(!classes.has('gb3-game-skin'));
});
test('host can disable desktop skin or onscreen controls',()=>{
  const {classes}=evaluate(false,{desktopSkin:'none',showDesktopControls:false});
  assert(classes.has('gb3-game-no-skin'));
  assert(classes.has('gb3-game-controls-hidden'));
});
test('palette options are whitelisted',()=>{
  assert.equal(evaluate(false,{palette:'violet'}).body.dataset.gb3Palette,'violet');
  assert.equal(evaluate(false,{palette:'evil'}).body.dataset.gb3Palette,'rose');
});
test('CSS retains pointer targets and mobile responsive layout',()=>{
  assert.match(css,/pointer-events:auto/);
  assert.match(css,/max-width:840px/);
  assert.match(css,/orientation:landscape/);
  assert.match(css,/body\.gb3-game-no-skin \.gb3-lid/);
  assert.match(css,/#game-menu/);
});
