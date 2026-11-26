import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const web = path.resolve(import.meta.dirname, '../web');
const html = fs.readFileSync(path.join(web,'index.html'),'utf8');
const css = fs.readFileSync(path.join(web,'gaemboy3ds-game.css'),'utf8');
const page = fs.readFileSync(path.join(web,'gaemboy3ds-page.js'),'utf8');

test('pause menu removes Tasti link and restores native pink Riprendi', () => {
  assert.doesNotMatch(html, /id="gb14-open-keys"/);
  assert.match(html, /id="close-menu"[^>]*>Riprendi<\/button>/);
  assert.match(css, /#close-menu\.gb13-resume[^}]*\{[^}]*color:#d61750!important/);
  assert.match(css, /#close-menu\.gb13-resume:hover[^}]*\{[^}]*color:#b01240!important/);
  assert.doesNotMatch(page, /\$\('gb14-open-keys'\)/);
  assert.match(html, /id="keyboard-bindings"/); // bindings still retained
});
test('cheat panel uses original Gaemboy look without React or new core cheat types', () => {
  for (const id of ['gb17-cheats-panel','cheat-actions','gb17-cheat-new','gb17-cheat-form',
     'cheat-add','cheat-name','cheat-code','cheat-enabled','cheat-list','gb17-cheat-count']) {
     assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(css, /linear-gradient\(135deg,#10b981 0%,#059669 100%\)/);
  assert.match(css, /\.gb17-cheat-item\.enabled/);
  assert.match(css, /\.gb17-cheat-toggle input:checked \+ \.gb17-toggle-slider/);
  assert.match(html, /Formato supportato dal core 3DS: Gateway/);
  assert.doesNotMatch(html,/id="gb13-cheat-details"/);
  assert.match(page,/performFeature\('add-cheat'/);
  assert.match(page,/performFeature\('toggle-cheat'/);
  assert.match(page,/performFeature\('delete-cheat'/);
  assert.match(html, /content="game-ui17"/);
});

test('cheat cards preserve underlying worker index after enabled-first sorting', async () => {
  function node(tag) {
    const n={tag,children:[],events:{},className:'',textContent:'',checked:false,disabled:false,
      append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
      addEventListener(evt,fn){this.events[evt]=fn;},setAttribute(n,v){this[n]=v;}};
    return n;
  }
  const list=node('list'),counter=node('count'),empty=node('empty');
  const fake={'cheat-list':list,'gb17-cheat-count':counter,'gb17-cheat-empty':empty};
  const calls=[];
  const source=page.slice(page.indexOf('function renderCheats(items) {'),page.indexOf('\nasync function performFeature(',page.indexOf('function renderCheats(items) {')));
  const context={ document:{createElement:node}, $:id=>fake[id],
    performFeature:async (name,data)=>{calls.push({name,data});return {cheats:[]};},
    confirm:()=>true };
  vm.runInNewContext(source,context);
  context.renderCheats([{name:'Spento',code:'12345678 12345678',enabled:false},{name:'Acceso',code:'ABCD1234 ABCD1234',enabled:true}]);
  assert.equal(list.children.length,2);
  assert.equal(list.children[0].children[0].children[0].textContent,'Acceso');
  const actions=list.children[0].children[1];
  const checkbox=actions.children[0].children[0];
  checkbox.checked=false;
  await checkbox.events.change();
  assert.equal(calls[0].name,'toggle-cheat');
  assert.equal(calls[0].data.index,1,'original worker index must be used');
  actions.children[1].events.click();
  await Promise.resolve();
  assert.equal(calls[1].name,'delete-cheat');
  assert.equal(calls[1].data.index,1);
  assert.equal(counter.textContent,'2 codici');
});

test('cheat form toggle does not start the emulator or change save / cache modules', () => {
  assert.match(page,/function gb17ShowCheatForm\(show\)/);
  assert.match(page,/function gb17CloseCheats\(\)/);
  assert.match(page,/\$\('gb13-quick-cheats'\)\.onclick = \(\) => void gb17OpenCheats\(\)/);
  assert.match(page,/gb17CloseCheats\(\);/);
  assert.match(html,/gaemboy3ds-page\.js\?v=17/);
});
