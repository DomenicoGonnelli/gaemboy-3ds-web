import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatGatewayInput, validateGatewayInput } from '../web/gaemboy3ds-cheat-format.mjs';
const web = path.resolve(import.meta.dirname, '../web');
const html = fs.readFileSync(path.join(web,'index.html'),'utf8');
const js = fs.readFileSync(path.join(web,'gaemboy3ds-page.js'),'utf8');
const worker = fs.readFileSync(path.join(web,'gaemboy3ds-worker.js'),'utf8');
const css = fs.readFileSync(path.join(web,'gaemboy3ds-game.css'),'utf8');

test('gateway formatting supports contiguous, spaced and multiline input',()=>{
 assert.equal(formatGatewayInput('aa00bb11ff22dd33'), 'AA00BB11 FF22DD33');
 assert.equal(formatGatewayInput('aa00bb11  ff22dd33\n00000000 00000001'), 'AA00BB11 FF22DD33\n00000000 00000001');
 assert.equal(formatGatewayInput('0123456789abcdef0000000100000002'), '01234567 89ABCDEF\n00000001 00000002');
});
test('invalid characters are not silently deleted or converted into another cheat',()=>{
 assert.equal(formatGatewayInput('abcd1234 GHIJ5678'), 'ABCD1234 GHIJ5678');
 assert.equal(validateGatewayInput('ABCD1234 GHIJ5678').ok,false);
 assert.equal(validateGatewayInput('ABCD1234 0000AB').ok,false);
 assert.equal(validateGatewayInput('ABCD1234 0000ABCD').ok,true);
});
test('validation identifies incorrect lines, empty payload and line limit',()=>{
 assert.match(validateGatewayInput(' ').message,/almeno/);
 assert.match(validateGatewayInput('1234').message,/Riga 1/);
 assert.match(validateGatewayInput('AAAAAAAA BBBBBBBB\n????').message,/Riga 2/);
 assert.equal(validateGatewayInput('00000000 00000000\n00000001 00000001').ok,true);
 assert.match(validateGatewayInput(('00000000 00000000\n').repeat(257)).message,/256/);
});
test('only actual core-supported 3DS type is selectable',()=>{
 assert.match(html,/id="gb18-cheat-type"/);
 assert.match(html,/<option value="gateway">Gateway \(3DS\)/);
 for(const id of ['action-replay-ds','gameshark','codebreaker','gamegenie']){
  assert.match(html,new RegExp(`<option value="${id}" disabled>`));
 }
 assert.match(html,/id="gb18-cheat-validation"/);
 assert.match(html,/id="cheat-add"[^>]*disabled/);
});
test('dialog is centered and scrollable for mobile safe area',()=>{
 assert.match(css,/\.gb17-cheat-panel:not\(\[hidden\]\) \{[\s\S]*?top:50%;left:50%;transform:translate\(-50%,-50%\)/);
 assert.match(css,/\.gb17-cheat-content \{[\s\S]*?overflow-y:auto/);
 assert.match(css,/safe-area-inset-bottom/);
 assert.match(js,/gameMenu\.classList\.add\('gb17-cheats-open'\)/);
 assert.match(js,/gameMenu\.classList\.remove\('gb17-cheats-open'\)/);
});
test('save only after frontend validation and native core dry run',()=>{
 assert.match(worker,/case 'validate-cheat':[\s\S]*?addCheat\(\{[^}]+enabled: false \}, true\)/);
 assert.match(js,/const preflight = await performFeature\('validate-cheat', \{name, code\}\)/);
 const submit=js.slice(js.indexOf("$('cheat-add').onclick = async () => {"),js.indexOf('// ---------------------------------------------------------------- microphone and camera'));
 assert(submit.indexOf("const preflight = await performFeature('validate-cheat'") < submit.indexOf("performFeature('add-cheat'"));
 assert.match(submit,/if \(!validation\.ok\)/);
 assert.match(submit,/if \(!preflight\)/);
 assert.match(js,/function gb18RefreshCheatValidation\(/);
 assert.match(html,/game-ui20/);
});
