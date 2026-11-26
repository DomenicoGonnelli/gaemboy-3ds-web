import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../web/', import.meta.url);
const page = readFileSync(new URL('gaemboy3ds-page.js', dir), 'utf8');
const home = readFileSync(new URL('home-v5.js', dir), 'utf8');
const cache = readFileSync(new URL('gaemboy3ds-cache.js', dir), 'utf8');
const html = readFileSync(new URL('index.html', dir), 'utf8');
const between = (src, a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a) + a.length));

test('adding or reimporting a ROM registers a card and caches, NEVER autoboots', () => {
  const importFunction = between(page, 'async function importFiles(', "$('lib-filter').oninput");
  assert.match(importFunction, /libGames\.set\(game\.key, game\)/);
  assert.match(importFunction, /renderLibrary\(\)/);
  assert.match(importFunction, /await queueCache\(file, game\)/);
  assert.doesNotMatch(importFunction, /launchLibraryGame\(/);
  assert.doesNotMatch(importFunction, /\bboot\(/);
});

test('uncached ROM prompts and immediately opens native file picker from click', () => {
  const picker = between(page, 'function openRomPickerFor(', 'async function launchLibraryGame(');
  assert.match(picker, /window\.alert\(message\)/);
  assert.match(picker, /\$\('file'\)\.click\(\)/);
  assert.doesNotMatch(picker, /\bawait\b/);
  const launch = between(page, 'async function launchLibraryGame(', 'function queueCache(');
  assert.match(launch, /if \(!game\.cached\) return openRomPickerFor\(game\)/);
  assert.match(launch, /await cachedFile\(game\)/);
  assert.match(launch, /if \(!file\)/);
  assert.doesNotMatch(launch, /sessionFiles\.get\(/);
});

test('loading and ready states propagate to library cards with visible progress', () => {
  assert.match(page, /item\.dataset\.copying/);
  assert.match(home, /gb3-rom-import-meter/);
  assert.match(home, /Importazione in corso/);
  assert.match(home, /Pronto per giocare/);
  assert.match(home, /Da reimportare/);
  assert.match(page, /libState\.copyingKey = game\.key/);
  assert.match(page, /sessionFiles\.delete\(game\.key\)/);
  assert.match(html, /gaemboy3ds-page\.js\?v=13/);
});

test('registering a ROM does not set last played time until actual launch', () => {
  const register = between(cache, 'export async function registerRom(', 'async function directory(');
  assert.match(register, /lastPlayed: existing\?\.lastPlayed \|\| 0/);
  const launch = between(page, 'async function launchLibraryGame(', 'function queueCache(');
  assert.match(launch, /game\.lastPlayed = Date\.now\(\)/);
});
