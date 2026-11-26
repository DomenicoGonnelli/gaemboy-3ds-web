import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const base=path.resolve(import.meta.dirname,'../web');
const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
const js=fs.readFileSync(path.join(base,'gaemboy3ds-mobile19.js'),'utf8');
const css=fs.readFileSync(path.join(base,'gaemboy3ds-mobile19.css'),'utf8');
const page=fs.readFileSync(path.join(base,'gaemboy3ds-page.js'),'utf8');
test('native source screen is unchanged and split views are presentation-only',()=>{
 assert.equal((html.match(/id="screen"/g)||[]).length,1);
 assert.match(html,/gaemboy3ds-mobile19.css\?v=20/);
 assert.match(html,/gaemboy3ds-mobile19.js\?v=20/);
 assert.match(js,/stage.insertBefore\(pair,source\)/);
 assert.match(js,/drawImage\(source,0,0,sw,half,0,0,400,240\)/);
 assert.match(js,/drawImage\(source,sw\*\.1,half,sw\*\.8,half,0,0,320,240\)/);
});
test('touch on the separate lower display maps to original screen normalized coordinates',()=>{
 assert.match(js,/0\.1\+0\.8\*x,0\.5\+0\.5\*y/);
 assert.match(page,/window\.Gaemboy3DSTouchBridge/);
 assert.match(page,/writeI\('pointerDown',down\?1:0\)/);
 assert.match(js,/setPointerCapture\(e.pointerId\)/);
});
test('portrait, landscape, tablet and foldable layouts have real responsive styles',()=>{
 for(const mode of ['phone-portrait','phone-landscape','tablet','fold']) {
  assert.match(js,new RegExp(`gb19-\\$\\{next\\}|gb19-${mode}`));
  assert.match(css,new RegExp(`gb19-${mode}`));
 }
 assert.match(css,/\.gb19-screen-pair/);
 assert.match(js,/vertical-viewport-segments/);
});
test('desktop stays screen only, no skin or duplicate interactive buttons',()=>{
 assert.match(js,/if \(!b\.classList\.contains\('gb3-input-mobile'\)\) return 'desktop'/);
 assert.match(css,/body\.gb19-split-active/);
 assert.doesNotMatch(css,/data-button=/);
 for(let i=0;i<=13;i++)assert.match(html,new RegExp(`data-button="${i}"`));
});
test('existing cheat UI, save states and speed UI remain',()=>{
 for(const id of ['gb17-cheats-panel','gb18-cheat-type','gb14-state-gallery','gb15-speed-panel'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/content="game-ui20"/);
});
