const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sha256File, needsFetch, fetchTool } = require('../scripts/fetch-toolchains');

const entry = { version: '3.13.1', url: 'https://example.invalid/python.tar.gz', archive: 'tar.gz', inner: 'python', dest: 'python' };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-fetch-')); }

test('sha256File hashes a file', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'abc.txt');
    fs.writeFileSync(f, 'abc');
    assert.equal(await sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('needsFetch is false only for the same version', () => {
  assert.equal(needsFetch({ python: '3.13.1' }, 'python', '3.13.1'), false);
  assert.equal(needsFetch({ python: '3.12.0' }, 'python', '3.13.1'), true);
  assert.equal(needsFetch({}, 'python', '3.13.1'), true);
});

test('fetchTool refuses to unpack on checksum mismatch', async () => {
  const vendor = tmp();
  try {
    const download = async (_u, to) => fs.writeFileSync(to, 'not the archive');
    await assert.rejects(fetchTool('python', { ...entry, sha256: '00'.repeat(32) }, vendor, { download }), /Checksum mismatch for python/);
    assert.equal(fs.existsSync(path.join(vendor, 'python')), false);
  } finally { fs.rmSync(vendor, { recursive: true, force: true }); }
});
