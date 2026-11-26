import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const web=path.resolve(import.meta.dirname,'../web');
const css=fs.readFileSync(path.join(web,'gaemboy3ds-mobile19.css'),'utf8');
const js=fs.readFileSync(path.join(web,'gaemboy3ds-mobile19.js'),'utf8');
const html=fs.readFileSync(path.join(web,'index.html'),'utf8');
test('UX19B can install on UX18 and contains no duplicate control widgets',()=>{
 assert.match(html,/game-ui20/);assert.match(html,/mobile19\.css\?v=20/);
 assert.equal((html.match(/id="screen"/g)||[]).length,1);
 assert.equal((html.match(/id="touch-controls"/g)||[]).length,1);
});
test('phone portrait has a non-overlapping shoulder ROW below the source screen',()=>{
 assert.match(css,/UX19B/);assert.match(css,/phone-portrait #touch-controls \.shoulders/);
 assert.match(css,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 assert.match(css,/phone-portrait #touch-controls \.control-deck/);
 assert.match(js,/r\.bottom-v\.top\+1/);
});
test('phone landscape uses side-by-side views and corners',()=>{
 assert.match(css,/phone-landscape #game-view \.gb19-screen-pair/);
 assert.match(css,/grid-template-columns:minmax\(0,5fr\) minmax\(0,4fr\)/);
 assert.match(css,/phone-landscape #touch-controls \.system-buttons/);
 assert.match(js,/0\.1\+0\.8\*x,0\.5\+0\.5\*y/);
});
test('tablet controls sit in a distinct lower belt and horizontal fold is tablet',()=>{
 assert.match(css,/tablet #touch-controls:not\(\[hidden\]\)/);
 assert.match(css,/height:clamp\(190px,23dvh,272px\)/);
 assert.match(js,/innerWidth > innerHeight \? 'tablet' : 'fold'/);
});
