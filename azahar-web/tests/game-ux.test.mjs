import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const base=path.resolve(import.meta.dirname,'../web');
const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
const css=fs.readFileSync(path.join(base,'gaemboy3ds-game.css'),'utf8');
const js=fs.readFileSync(path.join(base,'gaemboy3ds-game.js'),'utf8');
const page=fs.readFileSync(path.join(base,'gaemboy3ds-page.js'),'utf8');
function evaluate({mobile=false,coarse=mobile,config={},width=1200}={}) {
 const classes=new Set(); const handlers={}; const body={classList:{toggle(name,on){on?classes.add(name):classes.delete(name);},add(name){classes.add(name);},remove(name){classes.delete(name);}},dataset:{}};
 const screen={setAttribute(name,value){screen[name]=value;}};
 const ctx={
   window:{innerWidth:width,Gaemboy3DSGameOptions:config,matchMedia(){return{matches:coarse,addEventListener(type,fn){handlers.media=fn;}};},addEventListener(type,fn){handlers[type]=fn;}},
   navigator:{userAgent:mobile?'Mozilla iPhone':'Mozilla Macintosh',platform:mobile?'iPhone':'MacIntel',maxTouchPoints:mobile?5:0},
   document:{body,getElementById(id){return id==='gb3-console'?screen:null;},addEventListener(type,fn){if(type==='DOMContentLoaded')fn();}}
 };
 vm.runInNewContext(js,ctx);
 return {classes,body,handlers,screen};
}
test('same renderer canvas and original touch control IDs remain intact',()=>{
 assert.equal((html.match(/id="screen"/g)||[]).length,1);
 assert.equal((html.match(/id="touch-controls"/g)||[]).length,1);
 for(let i=0;i<=13;i++) assert.match(html,new RegExp(`data-button="${i}"`));
 assert.match(html,/data-stick="left"/);assert.match(html,/data-stick="right"/);
});
test('desktop defaults to only screens, with touch controls hidden and no skin',()=>{
 const {classes}=evaluate();
 assert(classes.has('gb3-input-desktop'));
 assert(classes.has('gb3-game-no-skin'));
 assert(classes.has('gb3-game-controls-hidden'));
 assert(!classes.has('gb3-game-skin'));
 assert.doesNotMatch(css,/\.gb3-console\s*\{[^}]*border:2px/);
});
test('mobile gets touch controls and no decorative skin',()=>{
 const {classes}=evaluate({mobile:true,config:{desktopSkin:'gaemboy'}});
 assert(classes.has('gb3-input-mobile'));
 assert(!classes.has('gb3-game-controls-hidden'));
 assert(!classes.has('gb3-game-skin'));
});
test('host can override auto mode, without reintroducing skin',()=>{
 const {classes}=evaluate({mobile:true,config:{inputMode:'desktop',showDesktopControls:false}});
 assert(classes.has('gb3-input-desktop')); assert(classes.has('gb3-game-controls-hidden'));
 const touch=evaluate({config:{inputMode:'mobile'}}).classes;
 assert(touch.has('gb3-input-mobile'));assert(!touch.has('gb3-game-controls-hidden'));
});
test('desktop with narrow viewport still stays desktop when using mouse',()=>{
 const {classes}=evaluate({width:420,coarse:false}); assert(classes.has('gb3-input-desktop'));
});
test('styles use phone layout and do not hide the native menu',()=>{
 assert.match(css,/gb3-input-mobile/); assert.match(css,/orientation:landscape/);
 assert.match(css,/#game-menu/);assert.match(css,/#keyboard-bindings/);
});
test('menu retains existing buttons, save states and diagnostics',()=>{
 for(const id of ['audio','throttle','save','back-library','state-save','state-load','cheat-add','mic-toggle','camera-toggle','dl-log','keyboard-reset','keyboard-bindings']) assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/content="game-ui17"/);
 assert.match(page,/gaemboy3ds-keymap\.js\?v=12/);
});
test('Escape opens/closes the menu and mapping stays in localStorage',()=>{
 assert.match(page,/event\.code !== 'Escape'/);
 assert.match(page,/gameMenu\.open\) gameMenu\.close\(\); else openGameMenu\(\)/);
 assert.match(page,/localStorage\.setItem\(STORAGE_KEY/);
 assert.match(page,/function renderKeyboardBindings\(/);
});
