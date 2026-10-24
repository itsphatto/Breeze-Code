const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanRel, parseClaim, findClashes, ownerOf, claimFirstTouch, claudeDenyArgs, notesFor, claimPrompt, buildBrief, snapshot, addToSnapshot, restore, changedSince } = require('../src/main/team');

/* ----- Claims and ownership ----- */
test('parseClaim reads the last json block', () => {
  const text = [
    'First thoughts:',
    '```json',
    '{"paths": ["ignored.js"]}',
    '```',
    'Final answer:',
    '```json',
    '{"paths":["web/","web\\\\App.tsx","./README.md"]}',
    '```',
  ].join('\n');
  assert.deepEqual(parseClaim(text), ['web/', 'web/App.tsx', 'README.md']);
});

test('parseClaim drops blocked and outside paths', () => {
  const text = '```json\n{"paths":["../x","/etc/passwd",".git/config",".env","src/a.js"]}\n```';
  assert.deepEqual(parseClaim(text), ['src/a.js']);
});

test('cleanRel makes absolute paths relative to the root', () => {
  const root = path.resolve('proj');
  assert.equal(cleanRel(path.join(root, 'web', 'a.js'), root), 'web/a.js');
  assert.equal(cleanRel(path.join(root, 'web') + path.sep, root), 'web/');
  assert.equal(cleanRel(path.resolve('elsewhere', 'a.js'), root), null);
  assert.equal(cleanRel(root, root), null);
  assert.equal(cleanRel(path.join(root, 'a.js')), null);
});

test('parseClaim tolerates junk', () => {
  assert.deepEqual(parseClaim('no block'), []);
  assert.deepEqual(parseClaim('```json {oops'), []);
  assert.deepEqual(parseClaim('```json\n{"paths":"x"}\n```'), []);
});

test('ownerOf: folder covers children, not prefix siblings', () => {
  const o = { 'web/': 'claude', 'server/api.js': 'codex' };
  assert.equal(ownerOf(o, 'web/components/Button.tsx'), 'claude');
  assert.equal(ownerOf(o, 'webapp/x.js'), null);
  assert.equal(ownerOf(o, 'server/api.js'), 'codex');
});

test('ownerOf picks the longest folder', () => {
  const o = { 'web/': 'claude', 'web/api/': 'codex' };
  assert.equal(ownerOf(o, 'web/api/x.ts'), 'codex');
});

test('findClashes', () => {
  const clashes = findClashes({
    claude: ['web/', 'package.json'],
    codex: ['server/', 'package.json', 'web/api.ts'],
  });
  clashes.sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(clashes, [
    { path: 'package.json', agents: ['claude', 'codex'] },
    { path: 'web/api.ts', agents: ['claude', 'codex'] },
  ]);
});

test('claimFirstTouch', () => {
  const o = {};
  assert.equal(claimFirstTouch(o, 'a.js', 'codex'), 'codex');
  assert.equal(claimFirstTouch(o, 'a.js', 'claude'), 'codex');
});

test('claudeDenyArgs', () => {
  const args = claudeDenyArgs({ 'web/': 'claude', 'server/': 'codex', 'x.js': 'codex' }, 'claude');
  assert.ok(args.includes('Edit(server/**)'));
  assert.ok(args.includes('Write(x.js)'));
  assert.ok(args.includes('NotebookEdit(server/**)'));
  assert.ok(!args.some(a => a.includes('web')));
});

test('notesFor', () => {
  assert.deepEqual(
    notesFor('Done.\nFor Codex: add /api/todos\nFor Claude:\nuse port 3001', ['Codex', 'Claude']),
    { Codex: 'add /api/todos', Claude: 'use port 3001' },
  );
  assert.deepEqual(notesFor('Done.', ['Codex']), {});
});

/* ----- Prompts ----- */
const team = {
  shared: 'A todo app',
  members: [
    { agentId: 'claude', name: 'Claude', task: 'build the UI' },
    { agentId: 'codex', name: 'Codex', task: 'build the API' },
  ],
};

test('claimPrompt asks for a json block and no edits', () => {
  const p = claimPrompt(team.members[0], team);
  assert.ok(p.includes('build the UI'));
  assert.ok(p.includes('A todo app'));
  assert.ok(p.includes('Codex: build the API'));
  assert.ok(p.includes('```json'));
  assert.ok(p.includes('{"paths": ['));
  assert.ok(p.includes('Do not change any files'));
});

test("buildBrief lists own and teammates' paths", () => {
  const brief = buildBrief(team.members[0], team, { 'web/': 'claude', 'server/': 'codex' });
  assert.ok(brief.includes('You own: web/'));
  assert.ok(brief.includes('Do not edit: server/ (Codex)'));
  assert.ok(brief.includes('For Codex:'));
  const none = buildBrief(team.members[0], team, {});
  assert.ok(none.includes('You own: any file no teammate owns'));
  assert.ok(!none.includes('Do not edit'));
});

/* ----- Snapshots ----- */
function tempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-team-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const put = (root, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

test('snapshot expands folders and records absent files', async t => {
  const root = tempProject(t);
  put(root, 'web/a.js', 'a');
  put(root, 'web/sub/b.js', 'b');
  put(root, 'web/node_modules/dep/index.js', 'x');
  put(root, 'web/.env', 'SECRET=1');
  put(root, 'web/sub/.env.local', 'SECRET=2');
  put(root, 'web/.git/config', 'x');
  const snap = await snapshot(root, ['web/', 'new.js']);
  assert.deepEqual([...snap.files.keys()].sort(), ['new.js', 'web/a.js', 'web/sub/b.js']);
  assert.equal(snap.files.get('new.js'), null);
  assert.equal(snap.files.get('web/a.js').toString(), 'a');
});

test('restore undoes a modify, a create and a delete', async t => {
  const root = tempProject(t);
  put(root, 'web/a.js', 'a');
  put(root, 'web/sub/b.js', 'b');
  const snap = await snapshot(root, ['web/', 'new.js']);
  put(root, 'web/a.js', 'changed');
  put(root, 'new.js', 'created');
  fs.rmSync(path.join(root, 'web/sub'), { recursive: true });
  const changed = await changedSince(root, snap);
  assert.deepEqual(changed.sort(), ['new.js', 'web/a.js', 'web/sub/b.js']);
  for (const rel of changed) await restore(root, rel, snap);
  assert.deepEqual(await changedSince(root, snap), []);
  assert.equal(fs.existsSync(path.join(root, 'new.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'web/sub/b.js'), 'utf8'), 'b');
});

test('addToSnapshot records a file once, before it changes', async t => {
  const root = tempProject(t);
  put(root, 'x.js', 'one');
  const snap = await snapshot(root, []);
  await addToSnapshot(snap, root, 'x.js');
  put(root, 'x.js', 'two');
  await addToSnapshot(snap, root, 'x.js'); // already seen: the first content stays
  assert.equal(snap.files.get('x.js').toString(), 'one');
  assert.deepEqual(await changedSince(root, snap), ['x.js']);
  await restore(root, 'x.js', snap);
  assert.equal(fs.readFileSync(path.join(root, 'x.js'), 'utf8'), 'one');
  await restore(root, 'unknown.js', snap); // no entry: nothing happens
});

test('snapshot skips large files', async t => {
  const root = tempProject(t);
  put(root, 'big.bin', Buffer.alloc(2 * 1024 * 1024 + 1));
  put(root, 'ok.txt', 'ok');
  const snap = await snapshot(root, ['big.bin', 'ok.txt']);
  assert.deepEqual(snap.skipped, ['big.bin']);
  assert.equal(snap.files.has('big.bin'), false);
  assert.equal(snap.files.has('ok.txt'), true);
});

test('addToSnapshot keeps the first content when calls overlap', async t => {
  const root = tempProject(t);
  put(root, 'x.js', 'one');
  const snap = await snapshot(root, []);
  const first = addToSnapshot(snap, root, 'x.js');
  const second = addToSnapshot(snap, root, 'x.js');
  await Promise.all([first, second]);
  assert.equal(snap.files.get('x.js').toString(), 'one');
  assert.equal(snap.files.size, 1);
});

test('restore refuses a path outside the root', async t => {
  const root = tempProject(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, 'keep');
  t.after(() => fs.rmSync(outside, { force: true }));
  const snap = await snapshot(root, []);
  const rel = `../${path.basename(outside)}`;
  await addToSnapshot(snap, root, 'a.js'); // inside is fine
  await assert.rejects(addToSnapshot(snap, root, rel), /outside the project/);
  await assert.rejects(addToSnapshot(snap, root, outside), /outside the project/);
  snap.files.set(rel, Buffer.from('overwrite')); // even a hand-made entry can't escape
  await assert.rejects(restore(root, rel, snap), /outside the project/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('restore refuses to write through a symlinked file', async t => {
  const root = tempProject(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-target.txt`);
  fs.writeFileSync(outside, 'keep');
  t.after(() => fs.rmSync(outside, { force: true }));
  put(root, 'a.js', 'orig');
  const snap = await snapshot(root, ['a.js']);
  fs.rmSync(path.join(root, 'a.js'));
  try { fs.symlinkSync(outside, path.join(root, 'a.js'), 'file'); } catch (err) { return t.skip(`can't create symlinks here: ${err.code}`); }
  assert.deepEqual(await changedSince(root, snap), ['a.js']);
  await assert.rejects(restore(root, 'a.js', snap), /link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('restore refuses to write through a symlinked folder', async t => {
  const root = tempProject(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-team-out-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  put(outsideDir, 'a.js', 'keep');
  put(root, 'web/a.js', 'orig');
  const snap = await snapshot(root, ['web/']);
  fs.rmSync(path.join(root, 'web'), { recursive: true });
  try { fs.symlinkSync(outsideDir, path.join(root, 'web'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (err) { return t.skip(`can't create symlinks here: ${err.code}`); }
  await assert.rejects(restore(root, 'web/a.js', snap), /link/);
  assert.equal(fs.readFileSync(path.join(outsideDir, 'a.js'), 'utf8'), 'keep');
  // a path reached through the link is not recorded at all
  const snap2 = await snapshot(root, ['web/new.js']);
  assert.equal(snap2.files.size, 0);
});

test('restore will not remove a folder that took the place of an absent file', async t => {
  const root = tempProject(t);
  const snap = await snapshot(root, ['new.js']);
  put(root, 'new.js/inner.txt', 'x');
  await assert.rejects(restore(root, 'new.js', snap), /not a file/);
  assert.equal(fs.existsSync(path.join(root, 'new.js', 'inner.txt')), true);
});
