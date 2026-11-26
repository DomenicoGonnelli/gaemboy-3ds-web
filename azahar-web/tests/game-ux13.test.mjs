import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const web=path.resolve(import.meta.dirname,'../web');
const html=fs.readFileSync(path.join(web,'index.html'),'utf8');
const css=fs.readFileSync(path.join(web,'gaemboy3ds-game.css'),'utf8');
const page=fs.readFileSync(path.join(web,'gaemboy3ds-page.js'),'utf8');
const game=fs.readFileSync(path.join(web,'gaemboy3ds-game.js'),'utf8');
function ids(s) { return [...s.matchAll(/id="([^"]+)"/g)].map(x=>x[1]); }
function localMenu(){
 const elements=new Map(); const calls=[];
 function get(id){
   if(!elements.has(id)) {
    const classes=new Set();
    elements.set(id,{
     id, disabled:false, hidden:false, open:false, textContent:'', classList:{add(v){classes.add(v);},remove(v){classes.delete(v);},contains(v){return classes.has(v);},toggle(v,on){if(on)classes.add(v);else classes.delete(v);}},
     click(){calls.push(id);if(this.onclick)this.onclick();}, focus(){}, scrollIntoView(){}, addEventListener(){}, setAttribute(n,v){this[n]=v;},
     querySelectorAll(){return [];}
    });
   }
   return elements.get(id);
 }
 const section=page.slice(page.indexOf('function gb13Feedback('),page.indexOf("$('back-library').onclick = async"));
 assert(section.includes('gb13UpdateQuickAvailability'));
 const context={
  $:get, memory:null, storageAvailable:false, featureBusy:false,mediaBusy:false,
  readI:()=>2, savePreview:async()=>null, gb14CloseGallery:()=>{},
  MutationObserver:class{observe(){}},
  gameMenu:{open:true,classList:get('menuClasses').classList},
  document:{body:{classList:get('bodyClasses').classList},createElement:()=>({click(){}})},
  screen:{orientation:{}}, URL:{createObjectURL(){}},setTimeout(){},Date,
 };
 vm.runInNewContext(section,context);
 return {get,calls,context};
}
test('approved desktop mode remains screen-only, with no virtual controls or skin',()=>{
 assert.match(game,/gb3-game-no-skin/);
 assert.match(css,/body\.gb3-input-desktop #touch-controls\s*\{display:none!important;/);
 assert.match(css,/body\.playing\s*\{[\s\S]*?background:#000;/);
 assert.match(html,/id="screen" width="400" height="480"/);
 assert.doesNotMatch(html, /gb3-lid|gb3-console-bottom/);
});
test('tablet and phone stay in touch mode with original core input IDs',()=>{
 assert.match(game,/iPhone\|iPod\|iPad\|Android\|Mobile/);
 assert.match(game,/inputMode === 'desktop'/);
 for(const id of ['touch-controls','screen','game-menu','state-save','state-load','mic-toggle','cheat-add','keyboard-bindings','keyboard-reset']) {
  assert.equal(ids(html).filter(v=>v===id).length,1,`exactly one ${id}`);
 }
 for(let b=0;b<=13;b++) assert.match(html,new RegExp(`data-button="${b}"`));
 assert.match(html,/data-stick="left"/);assert.match(html,/data-stick="right"/);
});
test('Gaemboy black pause screen and plum bottom action tray, not a popup settings menu',()=>{
 assert.match(html,/<dialog id="game-menu" class="gb13-pause"/);
 assert.match(css,/dialog#game-menu\.gb13-pause\s*\{[\s\S]*?position:fixed;inset:0;width:100%;height:100%/);
 assert.match(css,/#game-menu\.gb13-pause \.gb13-pause-tray/);
 assert.match(html,/id="close-menu"[^>]*>Riprendi<\/button>/);
 assert.match(page,/\$\('menu-title'\)\.textContent = \$\('game-title'\)\.textContent/);
 assert.match(page,/if \(gameMenu\.open\) gameMenu\.close\(\); else openGameMenu\(\)/);
});
test('quick actions open history galleries and preserve existing core controls',()=>{
 const {get,context}=localMenu();
 get('gb14-open-keys').onclick();
 assert.equal(get('gb13-settings-panel').hidden,false);
 get('gb13-settings-back').onclick();
 assert.equal(get('gb13-settings-panel').hidden,true);
 assert.match(page,/\$\('gb13-quick-save'\)\.onclick = \(\) => \{ void gb14OpenGallery\('save'\)/);
 assert.match(page,/\$\('gb13-quick-load'\)\.onclick = \(\) => \{ void gb14OpenGallery\('load'\)/);
 assert.match(page,/gb15ApplySpeed\(\)/);
 assert.match(page,/\$\('mic-toggle'\)\.click\(\)/);
 assert.match(page,/\$\('back-library'\)\.click\(\)/);
 assert.match(html,/id="gb13-quick-link"[^>]*disabled="disabled"/);
 assert.match(page,/\$\('gb13-quick-link'\)\.disabled = true/);
 assert.doesNotMatch(html,/id="gb13-quick-settings"/);
});
test('keyboard remapping remains secondary and Escape stays reserved',()=>{
 assert.match(html,/id="keyboard-settings"/);
 assert.match(html,/id="gb13-settings-panel"[^>]*hidden/);
 assert.match(page,/event\.code !== 'Escape'/);
 assert.match(page,/localStorage\.setItem\(STORAGE_KEY/);
});
test('UX14 assets and metadata are versioned independently of home/cache',()=>{
 assert.match(html,/name="gaemboy-build" content="game-ui16"/);
 assert(html.includes('gaemboy3ds-game.css?v=16'));
 assert(html.includes('gaemboy3ds-page.js?v=15'));
 assert(html.includes('gaemboy3ds-game.js?v=13'));
 assert.match(html,/home-v5\.js\?v=10/);
});
