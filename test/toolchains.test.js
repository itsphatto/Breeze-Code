const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { toolchainRoot, toolPaths, toolEnv, runPlan, runSteps, ensureBuildIgnored } = require('../toolchains');

const H = 'C:\\app\\runtime\\breeze_stdio.h';
const tools = { gcc: 'C:\\tc\\gcc.exe', gxx: 'C:\\tc\\g++.exe', python: 'C:\\tc\\python.exe' };

test('runPlan for C', () => {
  const r = runPlan('C:\\Users\\Dell NB\\proj\\hello.c', tools, 'win32', H);
  assert.deepEqual(r.steps[0].args, ['C:\\Users\\Dell NB\\proj\\hello.c', '-o', 'build\\hello.exe', '-std=c17', '-Wall', '-g', '-include', H]);
  assert.equal(r.steps[0].file, tools.gcc);
  assert.equal(r.steps[0].display, 'gcc "hello.c" -o "build\\hello.exe" -std=c17 -Wall -g');
  assert.equal(r.steps[0].cwd, 'C:\\Users\\Dell NB\\proj');
  assert.equal(r.steps[1].file, 'C:\\Users\\Dell NB\\proj\\build\\hello.exe');
  assert.equal(r.steps[1].display, 'build\\hello.exe');
  assert.equal(r.steps[1].cwd, 'C:\\Users\\Dell NB\\proj');
});

test('runPlan for .cc uses g++ and c++20', () => {
  const r = runPlan('C:\\p\\a.cc', tools, 'win32', H);
  assert.equal(r.steps[0].file, tools.gxx);
  assert.ok(r.steps[0].args.includes('-std=c++20'));
  assert.match(r.steps[0].display, /^g\+\+ "a\.cc"/);
  for (const ext of ['cpp', 'cxx']) assert.equal(runPlan(`C:\\p\\a.${ext}`, tools, 'win32', H).steps[0].file, tools.gxx);
});

test('runPlan for Python is one unbuffered step', () => {
  const r = runPlan('C:\\p\\app.py', tools, 'win32', H);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].file, tools.python);
  assert.deepEqual(r.steps[0].args, ['-u', 'C:\\p\\app.py']);
  assert.equal(r.steps[0].display, 'python -u "app.py"');
  assert.equal(r.steps[0].cwd, 'C:\\p');
});

test('runPlan on linux has no .exe', () => {
  const t = { gcc: '/usr/bin/cc', gxx: '/usr/bin/c++', python: '/usr/bin/python3' };
  const r = runPlan('/home/me/proj/hello.c', t, 'linux', '/app/h.h');
  assert.deepEqual(r.steps[0].args.slice(0, 3), ['/home/me/proj/hello.c', '-o', 'build/hello']);
  assert.equal(r.steps[1].file, '/home/me/proj/build/hello');
  assert.equal(r.steps[1].display, './build/hello');
  assert.equal(r.steps[0].cwd, '/home/me/proj');
});

test('runPlan rejects other files', () => {
  assert.deepEqual(runPlan('C:\\p\\a.js', tools, 'win32', H), { error: 'Breeze can run .c, .cpp and .py files' });
});

test('runPlan with no gcc says how to get it', () => {
  const none = { gcc: null, gxx: null, python: null };
  assert.match(runPlan('C:\\p\\a.c', none, 'win32', H).error, /npm run fetch-toolchains/);
  assert.match(runPlan('C:\\p\\a.cpp', none, 'win32', H).error, /Compilers aren't downloaded yet/);
  assert.match(runPlan('/p/a.c', none, 'darwin', H).error, /xcode-select --install/);
  assert.equal(runPlan('/p/a.c', none, 'linux', H).error, 'Install a C compiler with your package manager');
  assert.equal(runPlan('C:\\p\\a.py', none, 'win32', H).error, "Python isn't downloaded yet — run npm run fetch-toolchains");
  assert.equal(runPlan('/p/a.py', none, 'darwin', H).error, 'Install Python 3 (xcode-select --install)');
  assert.equal(runPlan('/p/a.py', none, 'linux', H).error, 'Install Python 3 with your package manager');
});

test('toolEnv prepends bins and keeps the Path key', () => {
  const env = toolEnv({ Path: 'C:\\Windows' }, ['A', 'B'], 'win32');
  assert.equal(env.Path, 'A;B;C:\\Windows');
  assert.equal('PATH' in env, false);
  assert.equal(toolEnv({ PATH: '/bin' }, [], 'linux').PATH, '/bin');
});

test('toolchainRoot dev vs packaged', () => {
  const o = { resourcesPath: 'r', appDir: 'a' };
  assert.equal(toolchainRoot({ ...o, isPackaged: true }), path.join('r', 'toolchains'));
  assert.equal(toolchainRoot({ ...o, isPackaged: false }), path.join('a', 'vendor'));
});

test('toolPaths on windows uses bundled files', async () => {
  const have = new Set(['R\\w64devkit\\bin\\gcc.exe', 'R\\w64devkit\\bin\\g++.exe', 'R\\w64devkit\\bin', 'R\\python\\python.exe', 'R\\python']);
  const t = await toolPaths({ platform: 'win32', root: 'R', exists: (p) => have.has(p), which: async () => null });
  assert.deepEqual(t, { gcc: 'R\\w64devkit\\bin\\gcc.exe', gxx: 'R\\w64devkit\\bin\\g++.exe', python: 'R\\python\\python.exe', binDirs: ['R\\w64devkit\\bin', 'R\\python'] });
});

test('toolPaths elsewhere uses which', async () => {
  const t = await toolPaths({ platform: 'linux', root: '/r', exists: () => false, which: async (c) => (c === 'c++' ? null : '/usr/bin/' + c) });
  assert.deepEqual(t, { gcc: '/usr/bin/cc', gxx: null, python: '/usr/bin/python3', binDirs: [] });
});

// Fake spawn: codes[i] is the exit code for the i-th spawn; undefined = hangs until killed.
function fakeSpawn(codes) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    calls.push({ file, args, opts, child: c });
    const code = codes[calls.length - 1];
    if (code !== undefined) setImmediate(() => { c.stdout.emit('data', Buffer.from('out')); c.emit('close', code); });
    return c;
  };
  return { spawn, calls };
}
const steps = [
  { display: 'c', file: 'gcc', args: ['x'], cwd: 'D' },
  { display: 'r', file: 'prog', args: [], cwd: 'D' },
];
const done = (f) => new Promise(f);

test('runSteps runs steps in order and reports the last code', async () => {
  const { spawn, calls } = fakeSpawn([0, 3]);
  const started = [], data = [];
  const [code, ms] = await done((res) => runSteps(steps, { spawn, env: { E: 1 }, onStart: (s) => started.push(s.display), onData: (d) => data.push(d), onChild() {}, onDone: (c, m) => res([c, m]) }));
  assert.equal(code, 3);
  assert.equal(typeof ms, 'number');
  assert.deepEqual(started, ['c', 'r']);
  assert.deepEqual(data, ['out', 'out']);
  assert.deepEqual(calls[0].opts, { cwd: 'D', env: { E: 1 }, windowsHide: true });
});

test('runSteps skips the program when compile fails', async () => {
  const { spawn, calls } = fakeSpawn([1]);
  const code = await done((res) => runSteps(steps, { spawn, env: {}, onStart() {}, onData() {}, onChild() {}, onDone: (c) => res(c) }));
  assert.equal(calls.length, 1);
  assert.equal(code, 1);
});

test('runSteps cancel during compile', async () => {
  const { spawn, calls } = fakeSpawn([]);
  let handle;
  const p = done((res) => { handle = runSteps(steps, { spawn, env: {}, onStart() {}, onData() {}, onChild() {}, onDone: (c) => res(c) }); });
  handle.cancel();
  assert.equal(await p, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].child.killed, true);
});

test('runSteps treats a spawn error as -1, once', async () => {
  const spawn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    setImmediate(() => { c.emit('error', new Error('spawn gcc ENOENT')); c.emit('close', null); });
    return c;
  };
  const data = [];
  let n = 0;
  const code = await done((res) => runSteps(steps, { spawn, env: {}, onStart() {}, onData: (d) => data.push(d), onChild() {}, onDone: (c) => { n++; res(c); } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(code, -1);
  assert.equal(n, 1);
  assert.equal(data[0], 'spawn gcc ENOENT\n');
});

test('ensureBuildIgnored appends once and never creates', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
  ensureBuildIgnored(d);
  assert.equal(fs.existsSync(path.join(d, '.gitignore')), false);
  fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/');
  ensureBuildIgnored(d);
  ensureBuildIgnored(d);
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), 'node_modules/\nbuild/\n');
  fs.writeFileSync(path.join(d, '.gitignore'), '/build/\n');
  ensureBuildIgnored(d);
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), '/build/\n');
  fs.rmSync(d, { recursive: true });
});
