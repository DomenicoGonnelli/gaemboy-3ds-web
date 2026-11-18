import assert from 'node:assert/strict';
import test from 'node:test';
import { gamesFromFileList, isGameFile, MAX_GAMES, openGame, scanDirectoryHandle } from '../web/gaemboy3ds-library.js';

function fakeFile(name, size = 10) {
  return { name, size, lastModified: 1, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) };
}

function dir(name, children) {
  return {
    kind: 'directory',
    name,
    async *values() { yield* children; },
  };
}

function fileHandle(name, size = 10) {
  return { kind: 'file', name, getFile: async () => fakeFile(name, size) };
}

test('recognises 3DS game files only', () => {
  assert.ok(isGameFile('Zelda.3DS'));
  assert.ok(isGameFile('demo.3dsx'));
  assert.ok(!isGameFile('readme.txt'));
  assert.ok(!isGameFile('._Zelda.3ds'));
});

test('builds the library from a webkitdirectory FileList, skipping hidden folders', () => {
  const files = [
    { ...fakeFile('b.cci'), webkitRelativePath: 'Giochi/RPG/b.cci' },
    { ...fakeFile('a.3ds', 2), webkitRelativePath: 'Giochi/a.3ds' },
    { ...fakeFile('c.3ds'), webkitRelativePath: 'Giochi/.Trash/c.3ds' },
    { ...fakeFile('d.3ds'), webkitRelativePath: 'Giochi/__MACOSX/d.3ds' },
    { ...fakeFile('notes.txt'), webkitRelativePath: 'Giochi/notes.txt' },
  ];
  const result = gamesFromFileList(files);
  assert.equal(result.folderName, 'Giochi');
  assert.deepEqual(result.games.map((g) => g.path), ['a.3ds', 'RPG/b.cci']);
  assert.equal(result.games[0].file, files[1]);
  assert.equal(result.truncated, false);
});

test('scans a directory handle recursively and reads metadata only', async () => {
  const root = dir('Giochi', [
    fileHandle('z.3ds', 5),
    dir('Homebrew', [fileHandle('hb.3dsx', 7), fileHandle('icon.png')]),
    dir('.hidden', [fileHandle('x.3ds')]),
  ]);
  const result = await scanDirectoryHandle(root);
  assert.equal(result.folderName, 'Giochi');
  assert.deepEqual(result.games.map((g) => [g.path, g.size]), [['Homebrew/hb.3dsx', 7], ['z.3ds', 5]]);
  assert.ok(result.games.every((g) => g.handle && !g.file));
});

test('caps very large folders', async () => {
  const many = Array.from({ length: MAX_GAMES + 3 }, (_, i) => fileHandle(`g${i}.3ds`));
  const result = await scanDirectoryHandle(dir('Big', many));
  assert.equal(result.games.length, MAX_GAMES);
  assert.equal(result.truncated, true);
});

test('openGame reports files that disappeared from the folder', async () => {
  const gone = { handle: { getFile: async () => { throw Object.assign(new Error('gone'), { name: 'NotFoundError' }); } } };
  await assert.rejects(openGame(gone), { name: 'NotFoundError' });
  await assert.rejects(openGame({ path: 'x.3ds' }), /riseleziona/);
  const file = fakeFile('ok.3ds');
  assert.equal(await openGame({ file }), file);
});
