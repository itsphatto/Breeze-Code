const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { findTools, freshPath, toolEnv, runPlan, runSteps, ensureBuildIgnored } = require('../toolchains');

const H = 'C:\\app\\runtime\\breeze_stdio.h';
const T = (p, name, version = '1.0') => ({ path: p, name, version });
const tools = {
  cc: T('C:\\tc\\gcc.exe', 'gcc'),
  cxx: T('C:\\tc\\g++.exe', 'g++'),
  python: T('C:\\tc\\python.exe', 'python'),
  binDirs: [],
};

test('runPlan for C', () => {
  const r = runPlan('C:\\Users\\Dell NB\\proj\\hello.c', tools, 'win32', H);
  assert.deepEqual(r.steps[0].args, ['C:\\Users\\Dell NB\\proj\\hello.c', '-o', 'build\\hello.exe', '-std=c17', '-Wall', '-g', '-include', H]);
  assert.equal(r.steps[0].file, tools.cc.path);
  assert.equal(r.steps[0].display, 'gcc "hello.c" -o "build\\hello.exe" -std=c17 -Wall -g');
  assert.equal(r.steps[0].cwd, 'C:\\Users\\Dell NB\\proj');
  assert.equal(r.steps[1].file, 'C:\\Users\\Dell NB\\proj\\build\\hello.exe');
  assert.equal(r.steps[1].display, 'build\\hello.exe');
  assert.equal(r.steps[1].cwd, 'C:\\Users\\Dell NB\\proj');
});

test('runPlan for .cc uses g++ and c++20', () => {
  const r = runPlan('C:\\p\\a.cc', tools, 'win32', H);
  assert.equal(r.steps[0].file, tools.cxx.path);
  assert.ok(r.steps[0].args.includes('-std=c++20'));
  assert.match(r.steps[0].display, /^g\+\+ "a\.cc"/);
  for (const ext of ['cpp', 'cxx']) assert.equal(runPlan(`C:\\p\\a.${ext}`, tools, 'win32', H).steps[0].file, tools.cxx.path);
});

test('runPlan for Python is one unbuffered step', () => {
  const r = runPlan('C:\\p\\app.py', tools, 'win32', H);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].file, tools.python.path);
  assert.deepEqual(r.steps[0].args, ['-u', 'C:\\p\\app.py']);
  assert.equal(r.steps[0].display, 'python -u "app.py"');
  assert.equal(r.steps[0].cwd, 'C:\\p');
});

test('runPlan via py passes -3', () => {
  const t = { ...tools, python: T('C:\\Windows\\py.exe', 'py') };
  const r = runPlan('C:\\p\\app.py', t, 'win32', H);
  assert.deepEqual(r.steps[0].args, ['-3', '-u', 'C:\\p\\app.py']);
  assert.equal(r.steps[0].file, 'C:\\Windows\\py.exe');
  assert.equal(r.steps[0].display, 'py -3 -u "app.py"');
});

test('runPlan shows clang when clang was found', () => {
  const t = { ...tools, cc: T('C:\\L\\clang.exe', 'clang'), cxx: T('C:\\L\\clang++.exe', 'clang++') };
  const r = runPlan('C:\\p\\hello.c', t, 'win32', H);
  assert.ok(r.steps[0].display.startsWith('clang "hello.c"'));
  assert.equal(r.steps[0].file, 'C:\\L\\clang.exe');
  assert.ok(runPlan('C:\\p\\a.cpp', t, 'win32', H).steps[0].display.startsWith('clang++ "a.cpp"'));
});

test('runPlan on linux has no .exe', () => {
  const t = { cc: T('/usr/bin/cc', 'cc'), cxx: T('/usr/bin/c++', 'c++'), python: T('/usr/bin/python3', 'python3'), binDirs: [] };
  const r = runPlan('/home/me/proj/hello.c', t, 'linux', '/app/h.h');
  assert.deepEqual(r.steps[0].args.slice(0, 3), ['/home/me/proj/hello.c', '-o', 'build/hello']);
  assert.equal(r.steps[1].file, '/home/me/proj/build/hello');
  assert.equal(r.steps[1].display, './build/hello');
  assert.equal(r.steps[0].cwd, '/home/me/proj');
});

test('runPlan rejects other files', () => {
  assert.deepEqual(runPlan('C:\\p\\a.js', tools, 'win32', H), { error: 'Breeze can run .c, .cpp and .py files' });
});

const WIN_C = 'No C/C++ compiler found. Install one with: winget install BrechtSanders.WinLibs.POSIX.UCRT';

test('runPlan missing C on Windows gives the winget command', () =>
  assert.equal(runPlan('C:\\p\\a.c', { cc: null, cxx: null, python: null, binDirs: [] }, 'win32', H).error, WIN_C));

test('runPlan with no tools says how to get them', () => {
  const none = { cc: null, cxx: null, python: null, binDirs: [] };
  assert.equal(runPlan('C:\\p\\a.cpp', none, 'win32', H).error, WIN_C);
  assert.equal(runPlan('/p/a.c', none, 'darwin', H).error, 'No C/C++ compiler found. Install one with: xcode-select --install');
  assert.equal(runPlan('/p/a.c', none, 'linux', H).error, 'No C/C++ compiler found. Install gcc with your package manager (e.g. sudo apt install build-essential)');
  assert.equal(runPlan('C:\\p\\a.py', none, 'win32', H).error, "Python wasn't found. Install it with: winget install Python.Python.3.13");
  assert.equal(runPlan('/p/a.py', none, 'darwin', H).error, "Python wasn't found. Install it with: xcode-select --install");
  assert.equal(runPlan('/p/a.py', none, 'linux', H).error, "Python wasn't found. Install python3 with your package manager");
});

test('runPlan with C found but no C++ gives the compiler message for .cpp', () => {
  assert.match(runPlan('/p/a.cpp', { ...tools, cxx: null }, 'linux', H).error, /^No C\/C\+\+ compiler found/);
});

test('toolEnv prepends bins and keeps the Path key', () => {
  const env = toolEnv({ Path: 'C:\\Windows' }, ['A', 'B'], 'win32');
  assert.equal(env.Path, 'A;B;C:\\Windows');
  assert.equal('PATH' in env, false);
  assert.equal(toolEnv({ PATH: '/bin' }, [], 'linux').PATH, '/bin');
});

test('toolEnv uses pathValue when given', () => {
  assert.equal(toolEnv({ Path: 'old' }, ['A'], 'win32', 'fresh').Path, 'A;fresh');
  assert.equal(toolEnv({ PATH: 'old' }, [], 'linux', 'fresh').PATH, 'fresh');
});

// Fake machine for findTools. `ok` maps a file (plus '|-3' for py -3) to its --version stdout;
// anything else exits 9009. `<file>|exe` is what that interpreter prints for sys.executable.
function machine(platform, ok, extra = {}) {
  const calls = [];
  return {
    calls,
    platform,
    pathValue: platform === 'win32' ? 'C:\\Windows;C:\\bin' : '/usr/bin:/bin',
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    exists: (p) => p in ok || p + '|-3' in ok,
    glob: () => [],
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes('-c')) return { code: 0, stdout: ok[file + '|exe'] ?? file + '\n' };
      const key = file + (args[0] === '-3' ? '|-3' : '');
      return key in ok ? { code: 0, stdout: ok[key] } : { code: 9009, stdout: '' };
    },
    ...extra,
  };
}

test('findTools finds gcc on PATH and g++ beside it', async () => {
  const r = await findTools(machine('win32', { 'C:\\bin\\gcc.exe': 'gcc (x) 14.2.0\nmore', 'C:\\bin\\g++.exe': 'g++ (x) 14.2.0' }));
  assert.deepEqual(r.cc, { path: 'C:\\bin\\gcc.exe', name: 'gcc', version: 'gcc (x) 14.2.0' });
  assert.equal(r.cxx.path, 'C:\\bin\\g++.exe');
  assert.equal(r.cxx.name, 'g++');
  assert.deepEqual(r.binDirs, []);
});

test('findTools finds MSYS2 gcc off PATH and adds its bin', async () => {
  const d = 'C:\\msys64\\ucrt64\\bin';
  const r = await findTools(machine('win32', { [d + '\\gcc.exe']: 'gcc 1', [d + '\\g++.exe']: 'g++ 1' }));
  assert.equal(r.cc.path, d + '\\gcc.exe');
  assert.deepEqual(r.binDirs, [d]);
});

test('findTools resolves the WinLibs winget wildcard through glob', async () => {
  const d = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.UCRT_x\\mingw64\\bin';
  const globbed = [];
  const m = machine('win32', { [d + '\\gcc.exe']: 'gcc 1', [d + '\\g++.exe']: 'g++ 1' }, {
    glob: (p) => { globbed.push(p); return p.includes('WinLibs*') ? [d] : []; },
  });
  const r = await findTools(m);
  assert.equal(r.cc.path, d + '\\gcc.exe');
  assert.deepEqual(r.binDirs, [d]);
  assert.ok(globbed[0].endsWith('BrechtSanders.WinLibs*\\mingw64\\bin'));
});

test('findTools falls back to clang', async () => {
  const r = await findTools(machine('win32', { 'C:\\bin\\clang.exe': 'clang 18', 'C:\\bin\\clang++.exe': 'clang 18' }));
  assert.equal(r.cc.name, 'clang');
  assert.equal(r.cxx.name, 'clang++');
});

test('findTools leaves cxx null without a twin, and everything null when nothing works', async () => {
  const r = await findTools(machine('win32', { 'C:\\bin\\gcc.exe': 'gcc 1' }));
  assert.equal(r.cc.name, 'gcc');
  assert.equal(r.cxx, null);
  const none = await findTools(machine('win32', {}));
  assert.deepEqual(none, { cc: null, cxx: null, python: null, binDirs: [] });
});

test('findTools rejects the Store python shortcut', async () => {
  const m = machine('win32', {}, { pathValue: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps', exists: () => true });
  const r = await findTools(m); // every --version exits 9009
  assert.equal(r.python, null);
  assert.ok(m.calls.some((c) => c[0].endsWith('WindowsApps\\python.exe') && c[1] === '--version'));
});

test('findTools prefers the py launcher', async () => {
  const r = await findTools(machine('win32', {
    'C:\\Windows\\py.exe|-3': 'Python 3.13.1',
    'C:\\bin\\python.exe': 'Python 3.11',
  }));
  assert.deepEqual(r.python, { path: 'C:\\Windows\\py.exe', name: 'py', version: 'Python 3.13.1' });
});

test('findTools falls back to python and resolves its interpreter', async () => {
  const r = await findTools(machine('win32', { 'C:\\bin\\python.exe': 'Python 3.11.9', 'C:\\bin\\python.exe|exe': 'C:\\Real\\python.exe\r\n' }));
  assert.deepEqual(r.python, { path: 'C:\\Real\\python.exe', name: 'python', version: 'Python 3.11.9' });
});

test('findTools on linux uses cc and python3', async () => {
  const r = await findTools(machine('linux', { '/usr/bin/cc': 'cc 13', '/usr/bin/c++': 'c++ 13', '/bin/python3': 'Python 3.12.3' }));
  assert.equal(r.cc.name, 'cc');
  assert.equal(r.cc.path, '/usr/bin/cc');
  assert.equal(r.cxx.path, '/usr/bin/c++');
  assert.equal(r.python.name, 'python3');
  assert.equal(r.python.path, '/bin/python3');
});

test('freshPath joins machine and user Path on Windows', async () => {
  let seen;
  const got = await freshPath('win32', async (file, args) => { seen = [file, args[0]]; return { code: 0, stdout: 'A;B\r\n' }; });
  assert.equal(got, 'A;B');
  assert.deepEqual(seen, ['powershell.exe', '-NoProfile']);
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
  assert.equal(await freshPath('win32', async () => ({ code: 1, stdout: '' })), process.env[key]);
  assert.equal(await freshPath('win32', async () => { throw new Error('x'); }), process.env[key]);
  assert.equal(await freshPath('linux', async () => { throw new Error('unused'); }), process.env.PATH);
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
