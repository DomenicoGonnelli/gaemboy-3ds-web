import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dir = new URL('../web/', import.meta.url);
const home = readFileSync(new URL('home-v5.js', dir), 'utf8');
const page = readFileSync(new URL('gaemboy3ds-page.js', dir), 'utf8');
const css = readFileSync(new URL('home-v5.css', dir), 'utf8');
const html = readFileSync(new URL('index.html', dir), 'utf8');

test('standalone shows internal picker; ?embed=1 or config external hides host-duplicate controls', () => {
  assert.match(home, /get\('embed'\) === '1'/);
  assert.match(home, /\? 'external' : 'internal'/);
  assert.match(home, /window\.Gaemboy3DSHomeOptions/);
  assert.match(home, /root\.dataset\.addGameButton=embedOptions\.addGameButton/);
  assert.match(css, /data-add-game-button="external"\] #gb3-select/);
  assert.match(css, /data-add-game-button="external"\] #gb3-select-empty/);
  assert.match(css, /data-add-game-button="external"\] #gb3-single/);
});

test('host integration reuses original ROM import and does not autoboot', () => {
  assert.match(home, /window\.Gaemboy3DSHome = Object\.freeze/);
  assert.match(home, /addGame: \(\) => \{openSingleGame\(\);\}/);
  assert.match(page, /importRomFiles: files => importFiles\(files\)/);
  assert.match(page, /event\.source !== window\.parent/);
  assert.match(page, /allowedGaemboyHosts\.has\(event\.origin\)/);
  assert.match(page, /data\.type !== 'gaemboy3ds:import-rom-files'/);
  assert.match(page, /file instanceof File/);
});

test('credits remain in home by default, host relocation only when visible', () => {
  assert.match(home, /<footer class="gb3-footer">/);
  assert.match(home, /Sorgenti GPLv3\+/);
  assert.match(home, /creditsPlacement === 'host'/);
  assert.match(home, /getClientRects\(\)\.length > 0/);
  assert.match(css, /margin-top:auto!important/);
  assert.match(css, /gb3-footer-host/);
});

test('branding removed from home, logo used as browser favicon', () => {
  assert.doesNotMatch(home, /<header class="gb3-header">/);
  assert.match(html, /rel="icon"[^>]*home-v5-assets\/logo\.png\?v=10/);
  assert.match(html, /rel="apple-touch-icon"/);
});
