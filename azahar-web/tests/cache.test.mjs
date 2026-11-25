import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validRom, romFingerprint, makeMirrorMap, mirrorMapComplete, planEvictions, ROM_LIMIT, ROM_RESERVE } from '../web/gaemboy3ds-cache.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

test('validates extensions and nonempty files', () => {
  assert.equal(validRom(new File(['a'], 'Mario Kart.3ds')), true);
  assert.equal(validRom(new File(['a'], 'Mario Kart.CCI')), true);
  assert.equal(validRom(new File([], 'Mario Kart.3ds')), false);
  assert.equal(validRom(new File(['a'], 'unrelated.zip')), false);
});

test('fingerprint matches the existing worker sampling algorithm', async () => {
  const bytes = new Uint8Array(1_600_000);
  for (let i = 0; i < bytes.length; i += 32) bytes[i] = (i / 32) % 253;
  const file = new File([bytes], 'test.3ds');
  const size = Math.min(file.size, 128 * 1024);
  const starts = Array.from({ length: 9 }, (_, i) => Math.floor((file.size - size) * i / 8));
  const header = Buffer.alloc(8); header.writeBigUInt64LE(BigInt(file.size));
  const hash = createHash('sha256');hash.update(header);
  for (const start of starts) hash.update(bytes.subarray(start, start + size));
  assert.equal(await romFingerprint(file), hash.digest('hex'));
  assert.equal((await romFingerprint(file)).length, 64);
});

test('complete bitmap uses exactly the legacy .map format', () => {
  for (const size of [1, MiB, MiB + 1, 32 * MiB + 3, 101 * MiB]) {
    const map = makeMirrorMap(size);
    assert.equal(map.byteLength, 8 + Math.ceil(Math.ceil(size / MiB) / 32) * 4);
    assert.equal(mirrorMapComplete(map, size), true);
    assert.equal(mirrorMapComplete(map, size + MiB), false);
    const corrupt = map.slice();
    new DataView(corrupt.buffer).setUint32(8, 0, true);
    assert.equal(mirrorMapComplete(corrupt, size), false);
  }
});

test('evicts least recently used ROM, never the active ROM', () => {
  const groups = [
    {key:'active', bytes:800 * MiB, lastPlayed:100},
    {key:'older', bytes:900 * MiB, lastPlayed:5},
    {key:'newer', bytes:200 * MiB, lastPlayed:90},
  ];
  const plan = planEvictions(groups,'incoming',1400 * MiB,2 * GiB, new Set(['active']));
  assert.equal(plan.enough,true);
  assert.deepEqual(plan.evict.map(x=>x.key),['older']);
});

test('never approves a ROM larger than the 3 GiB free application cap', () => {
  const plan = planEvictions([], 'big', ROM_LIMIT + 1, 20 * GiB);
  assert.equal(plan.enough,false);
});

test('returns insufficient capacity when no safely evictable ROM exists', () => {
  const plan = planEvictions([{key:'playing', bytes:1.5 * GiB, lastPlayed:10}], 'incoming', 900 * MiB,
    700 * MiB, new Set(['playing']));
  assert.equal(plan.enough,false);
});

test('leaves reserve for the other persistent storage', () => {
  const plan = planEvictions([], 'incoming', 100 * MiB, 100 * MiB + ROM_RESERVE - 1);
  assert.equal(plan.enough,false);
});

test('Premium quota 5 or 8 GiB changes eviction limit without affecting free default', () => {
  const selected = new Set();
  assert.equal(planEvictions([], 'new', 4 * GiB, 9 * GiB, selected).enough, false);
  assert.equal(planEvictions([], 'new', 4 * GiB, 9 * GiB, selected, 5 * GiB).enough, true);
  assert.equal(planEvictions([], 'new', 7 * GiB, 9 * GiB, selected, 8 * GiB).enough, true);
  assert.equal(planEvictions([], 'new', 9 * GiB, 12 * GiB, selected, 8 * GiB).enough, false);
});
