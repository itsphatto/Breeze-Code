const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMentions, shortName, mentionNames } = require('../src/main/mentions');

const agents = [
  { id: 'claude', name: 'Claude Code', found: true },
  { id: 'codex', name: 'Codex', found: true },
  { id: 'antigravity', name: 'Antigravity', found: false },
  { id: 'local', name: 'Ollama', found: true },
];

test('no mention gives no tasks', () => {
  assert.deepEqual(parseMentions('make a todo app', agents), { shared: 'make a todo app', tasks: [], unknown: [] });
});

test('splits tasks at each mention', () => {
  const r = parseMentions('@Claude make a front end for it\n@Codex make backend', agents);
  assert.deepEqual(r.tasks, [
    { agentId: 'claude', text: 'make a front end for it' },
    { agentId: 'codex', text: 'make backend' },
  ]);
  assert.equal(r.shared, '');
});

test('text before the first mention is shared', () => {
  const r = parseMentions('A todo app.\n@claude ui\n@codex api', agents);
  assert.equal(r.shared, 'A todo app.');
  assert.deepEqual(r.tasks.map(t => t.text), ['ui', 'api']);
});

test('matches case-insensitively and by full name', () => {
  const r = parseMentions('@claude code do x @CODEX do y', agents);
  assert.deepEqual(r.tasks.map(t => t.agentId), ['claude', 'codex']);
  assert.equal(r.tasks[0].text, 'do x');
  assert.equal(r.tasks[1].text, 'do y');
});

test('matches @local and @ollama to the local agent', () => {
  assert.deepEqual(parseMentions('@local hi', agents).tasks, [{ agentId: 'local', text: 'hi' }]);
  assert.deepEqual(parseMentions('@Ollama hi', agents).tasks, [{ agentId: 'local', text: 'hi' }]);
});

test('joins duplicate mentions', () => {
  const r = parseMentions('@Claude a @Codex b @Claude c', agents);
  assert.equal(r.tasks.length, 2);
  assert.deepEqual(r.tasks, [
    { agentId: 'claude', text: 'a\n\nc' },
    { agentId: 'codex', text: 'b' },
  ]);
});

test('email addresses are not mentions', () => {
  const r = parseMentions('mail me@codex.dev @Codex go', agents);
  assert.deepEqual(r.tasks, [{ agentId: 'codex', text: 'go' }]);
  assert.equal(r.shared, 'mail me@codex.dev');
});

test('unknown and not-installed mentions are reported', () => {
  const r = parseMentions('@Antigravity x @Gemini y', agents);
  assert.deepEqual(r.unknown, ['Antigravity', 'Gemini']);
  assert.deepEqual(r.tasks, []);
});

test('shortName and mentionNames', () => {
  assert.equal(shortName({ id: 'claude', name: 'Claude Code' }), 'Claude');
  assert.equal(shortName({ id: 'other', name: 'Other' }), 'Other');
  assert.deepEqual(mentionNames({ id: 'local', name: 'Ollama' }), ['local', 'ollama']);
});
