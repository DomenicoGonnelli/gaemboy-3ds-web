// Runs the benchmark off the main thread, like a real emulation worker would.
import createModule from './cpu_bench_web.js';

const post = (type, data) => self.postMessage({ type, ...data });

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  try {
    const [mod, image, expectedText] = await Promise.all([
      createModule(),
      fetch('./bench.bin').then((r) => r.arrayBuffer()),
      fetch('./expected.txt').then((r) => r.text()),
    ]);
    const expected = {};
    for (const line of expectedText.trim().split('\n')) {
      const [w, , hex] = line.trim().split(/\s+/);
      expected[Number(w)] = parseInt(hex, 16) >>> 0;
    }

    const bytes = new Uint8Array(image);
    const ptr = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    mod._poc_set_image(ptr, bytes.length);
    mod._free(ptr);

    const workloads = JSON.parse(mod.UTF8ToString(mod._poc_workloads()));
    const only = data.only ?? null;
    post('workloads', { workloads });
    for (const w of workloads) {
      if (only !== null && w.id !== only) continue;
      const run = (core) => JSON.parse(mod.UTF8ToString(mod._poc_run(core, w.id, w.iters)));
      const dyn = run(0);
      const fi = run(1);
      post('result', { workload: w, dyn, fi, expected: expected[w.id] });
    }
    post('done', {});
  } catch (err) {
    post('error', { message: String(err && err.stack ? err.stack : err) });
  }
};
