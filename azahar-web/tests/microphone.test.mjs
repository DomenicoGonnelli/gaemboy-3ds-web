import test from 'node:test';
import assert from 'node:assert/strict';

let Microphone;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (_name, processor) => { Microphone = processor; };
await import('../web/gaemboy3ds-microphone.js');

for (const rate of [44100, 48000, 96000]) {
  test(`microphone converts ${rate} Hz input to 48000 Hz without blocking`, () => {
    globalThis.sampleRate = rate;
    const buffer = new SharedArrayBuffer(12 + 65536 * 2);
    const control = new Int32Array(buffer, 0, 3);
    const samples = new Int16Array(buffer, 12);
    const processor = new Microphone({ processorOptions: { buffer } });
    const input = new Float32Array(128).fill(0.5);
    processor.process([[input]]);
    assert.equal(Atomics.load(control, 0), 0);
    Atomics.store(control, 2, 1);
    for (let remaining = rate; remaining > 0; remaining -= 128) {
      processor.process([[input.subarray(0, Math.min(128, remaining))]]);
    }
    assert.equal(Atomics.load(control, 0), 48000);
    assert.equal(samples[0], 16384);
    assert.equal(samples[47999], 16384);
  });
}

test('microphone ring does not overwrite unread samples and handles counter wrap', () => {
  globalThis.sampleRate = 48000;
  const buffer = new SharedArrayBuffer(12 + 4 * 2);
  const control = new Int32Array(buffer, 0, 3);
  const samples = new Int16Array(buffer, 12);
  const processor = new Microphone({ processorOptions: { buffer } });
  Atomics.store(control, 0, -2);
  Atomics.store(control, 1, -2);
  Atomics.store(control, 2, 1);
  processor.process([[new Float32Array([0.25, 0.5, 0.75, 1, -1])]]);
  assert.equal(Atomics.load(control, 0), 2);
  assert.deepEqual([...samples], [24575, 32767, 8192, 16384]);
  Atomics.store(control, 1, 0);
  processor.process([[new Float32Array([-1, -0.5])]]);
  assert.equal(Atomics.load(control, 0), 4);
  assert.deepEqual([...samples], [24575, 32767, -32767, -16383]);
});
