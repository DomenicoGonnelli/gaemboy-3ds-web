import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const web=path.resolve(import.meta.dirname,'../web');
const html=fs.readFileSync(path.join(web,'index.html'),'utf8');
const js=fs.readFileSync(path.join(web,'gaemboy3ds-layout20.js'),'utf8');
const css=fs.readFileSync(path.join(web,'gaemboy3ds-layout20.css'),'utf8');
const mobile=fs.readFileSync(path.join(web,'gaemboy3ds-mobile19.js'),'utf8');
const page=fs.readFileSync(path.join(web,'gaemboy3ds-page.js'),'utf8');
test('UX20 ships editor with one original Gaemboy resize icon, no React dependencies',()=>{
 assert.match(html,/id="gb20-quick-layout"/);
 assert.match(html,/gaemboy-menu-icons\/resize\.png/);
 assert.match(html,/gaemboy3ds-layout20\.js\?v=20/);
 assert.match(html,/gaemboy3ds-layout20\.css\?v=20/);
 assert.equal((html.match(/id="gb20-quick-layout"/g)||[]).length,1);
 assert.ok(fs.statSync(path.join(web,'gaemboy-menu-icons/resize.png')).size>1000);
 assert.doesNotMatch(js,/react-dom|import\(/);
});
test('Layout editor uses normalized coordinates and per-device orientation persistence',()=>{
 for(const pattern of [/localStorage\.setItem\(storageKey\(/,/localStorage\.getItem\(storageKey\(/, /innerWidth > innerHeight/,/gaemboy3ds\.layout\.v1\./,/Math\.min\(/,/gb20-edit-mode/])assert.match(js,pattern);
 assert.match(js,/pointerdown/);assert.match(js,/pointermove/);
 assert.match(js,/data-gb20="save"/);assert.match(js,/data-gb20="reset"/);assert.match(js,/data-gb20="cancel"/);
});
test('Only mirrors the original canvas and maps the lower touch to native 3DS coords',()=>{
 assert.match(mobile,/setForceSplit/);assert.match(mobile,/getViews/);
 assert.match(mobile,/0\.1\+0\.8\*x,0\.5\+0\.5\*y/);
 assert.match(mobile,/drawImage\(source/);
 assert.match(css,/gb20-custom/);
 assert.match(css,/gb19-screen-pair/);
 assert.match(page,/gaemboy3ds:layout-cancel/);
});
test('UX20 keeps desktop free of gamepad controls and editor frame responsive',()=>{
 assert.match(css,/gb20-custom\.gb3-input-desktop/);
 assert.match(css,/gb20-toolbar/);
 assert.match(css,/gb20-handle/);
 assert.match(css,/touch-action:none/);
 assert.match(js,/id==='upper'\|\|id==='lower'/);
});
