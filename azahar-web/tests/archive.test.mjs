import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveArchive } from '../web/gaemboy3ds-archive.js';

test('save archive contains valid stored ZIP records and UTF-8 names', async () => {
  const name = 'salvataggi/partita-é.dat';
  const archive = createSaveArchive([{
    name,
    data: new TextEncoder().encode('123456789'),
    modified: new Date('2024-01-02T03:04:06Z'),
  }]);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const nameLength = view.getUint16(26, true);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x0800);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  assert.equal(view.getUint32(22, true), 9);
  assert.equal(new TextDecoder().decode(bytes.slice(30, 30 + nameLength)), name);
  assert.equal(new TextDecoder().decode(bytes.slice(30 + nameLength, 39 + nameLength)), '123456789');
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 1);
  assert.equal(view.getUint32(view.getUint32(end + 16, true), true), 0x02014b50);
});

test('save archive rejects traversal and absolute paths', () => {
  for (const name of ['../save', '/save', 'a/../save', 'a\\save']) {
    assert.throws(() => createSaveArchive([{ name, data: new Uint8Array(), modified: new Date() }]));
  }
});
