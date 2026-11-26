import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root=path.resolve(import.meta.dirname,'../web');
const read=(f)=>fs.readFileSync(path.join(root,f),'utf8');
const html=read('index.html'),css=read('gaemboy3ds-game.css'),page=read('gaemboy3ds-page.js'),worker=read('gaemboy3ds-worker.js');
test('cards use larger minimum width and prevent save/delete labels from colliding',()=>{
 assert.match(css,/grid-template-columns:repeat\(auto-fill,minmax\(min\(100%,250px\),1fr\)\)/);
 assert.match(css,/\.gb14-state-actions button \{font-size:\.86rem;min-width:0;white-space:nowrap;/);
 assert.match(css,/\.gb14-state-actions \{display:grid;grid-template-columns:minmax\(0,1fr\) auto;/);
 assert.match(css,/@media\(max-width:600px\) \{\s*#game-menu\.gb13-pause \.gb14-gallery-list \{grid-template-columns:repeat\(auto-fill,minmax\(min\(100%,240px\),1fr\)\)/);
});
test('speed slider accepts 0.5 to 8 in half steps, with no empty advanced settings redirect',()=>{
 assert.match(html,/id="gb15-speed-range" min="0.5" max="8" step="0.5"/);
 assert.match(html,/id="gb15-speed-apply"/);
 assert.match(page,/\$\('gb15-speed-apply'\)\.onclick/);
 assert.match(page,/worker\?\.postMessage\(\{type:'set-speed',value:speed\}\)/);
 assert.match(worker,/if \(data.type === 'set-speed'\)/);
 assert.doesNotMatch(page,/\$\('gb13-quick-speed'\)\.onclick = \(\) => gb13OpenSettings/);
});
test('worker rounds speed safely and enforces pacing between ticks',()=>{
 const segment=worker.slice(worker.indexOf('let gb15SpeedTarget = 1;'),worker.indexOf('instrumentGL();',worker.indexOf('let gb15SpeedTarget = 1;')));
 let current=1000; const timers=[];let frames=0;
 const mc={__gbWrapped:false,port1:{onmessage(){frames++}}};
 const context={self:{__gb3ds_mc:mc},perf:{ticks:0,tickMs:0,tickMax:0},performance:{now(){return current;}},setTimeout(fn,ms){timers.push({fn,ms});},lastPerfFlush:1e9,flushPerf(){}};
 vm.runInNewContext(segment,context);
 context.gb15SetSpeed(20); assert.equal(vm.runInNewContext('gb15SpeedTarget',context),8);
 context.gb15SetSpeed(-20);assert.equal(vm.runInNewContext('gb15SpeedTarget',context),.5);
 context.gb15SetSpeed(2.25);assert.equal(vm.runInNewContext('gb15SpeedTarget',context),2.5);
 context.gb15SetSpeed(.5);context.instrumentTicks();
 mc.port1.onmessage({});assert.equal(frames,1);
 current=1020;mc.port1.onmessage({}); assert.equal(frames,1);assert(timers.length>0 && timers[0].ms>=13);
 current+=timers[0].ms;timers.shift().fn();assert.equal(frames,2);
 assert.equal(context.perf.ticks,2);
});
test('incorrect rotate screen command removed, native renderer/touch kept untouched',()=>{
 assert.doesNotMatch(html,/id="gb13-quick-rotate"/);
 assert.doesNotMatch(page,/\$\('gb13-quick-rotate'\)/);
 assert.match(html,/id="screen" width="400" height="480"/);
 assert.match(html,/id="touch-controls"/);
});
