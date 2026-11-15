// Runs build/web/index.html?autorun in real browser engines and saves the results.
// usage: PLAYWRIGHT=/path/to/node_modules/playwright node scripts/run-browsers.mjs http://127.0.0.1:8765/
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT || 'playwright');
const url = process.argv[2] || 'http://127.0.0.1:8765/';
const resultsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

const engines = [
  { name: 'chromium', launch: () => pw.chromium.launch() },
  { name: 'chrome', launch: () => pw.chromium.launch({ channel: 'chrome' }) },
  { name: 'webkit', launch: () => pw.webkit.launch() },
];

for (const engine of engines) {
  let browser;
  try {
    browser = await engine.launch();
  } catch (err) {
    console.log(`${engine.name}: not available (${err.message.split('\n')[0]})`);
    continue;
  }
  const page = await browser.newPage();
  await page.goto(`${url}?autorun`);
  await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.state), null, {
    timeout: 300_000,
  });
  const state = await page.evaluate(() => document.body.dataset.state);
  const ua = await page.evaluate(() => navigator.userAgent);
  const results = await page.evaluate(() => window.__benchResults);
  if (state !== 'done') {
    console.log(`${engine.name}: ERROR`, await page.textContent('#status'));
  } else {
    console.log(`\n${engine.name} — ${ua}`);
    for (const r of results) {
      console.log(
        `${r.name.padEnd(24)} dyncom ${r.dyncom.mips.toFixed(0).padStart(4)} MIPS ${r.dyncom.rt
          .toFixed(0)
          .padStart(4)}% | fastinterp ${r.fastinterp.mips.toFixed(0).padStart(4)} MIPS ${r.fastinterp.rt
          .toFixed(0)
          .padStart(4)}% | ${r.dyncom.ok && r.fastinterp.ok ? 'OK' : 'CHECKSUM FAIL'}`,
      );
    }
    writeFileSync(join(resultsDir, `wasm-${engine.name}.json`), JSON.stringify({ userAgent: ua, results }, null, 1));
  }
  await browser.close();
}
