import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base=new URL('../web/', import.meta.url);
const html=readFileSync(new URL('index.html',base),'utf8');
const css=readFileSync(new URL('gaemboy3ds-menu21.css',base),'utf8');
test('UX21 loads the compact menu stylesheet after all gameplay layouts',()=>{
 const p=html.indexOf('gaemboy3ds-menu21.css?v=21');
 assert.ok(p>html.indexOf('gaemboy3ds-layout20.css?v=20'));
 assert.match(html, /id="gb13-pause-actions"/);
});
test('UX21 keeps all ten original menu buttons and their handlers',()=>{
 const actions=html.match(/id="gb13-quick-(?:save|load|cheats|fast|speed|screenshot|mic|link|exit)"/g)||[];
 assert.equal(actions.length,9);
 assert.match(html,/id="gb20-quick-layout"/);
 assert.match(html,/id="close-menu"[^>]*>Riprendi</);
});
test('UX21 mobile portrait has two rows of five, landscape one of ten with no horizontal scrolling',()=>{
 assert.match(css,/body\.gb19-phone-portrait[\s\S]*?grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
 assert.match(css,/body\.gb19-phone-landscape[\s\S]*?grid-template-columns:repeat\(10,minmax\(0,1fr\)\)/);
 assert.equal((css.match(/overflow-x:visible !important/g)||[]).length,2);
 assert.match(css,/gb13-pause-actions\[hidden\] \{display:none !important;\}/);
 assert.match(css,/\.gb16-menu-icon/);
});
