const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cleanRel, parseClaim, findClashes, ownerOf, claimFirstTouch, claudeDenyArgs, notesFor, claimPrompt, buildBrief } = require('../src/main/team');

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
