const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { findTools, freshPath, toolEnv, runPlan, runSteps, ensureBuildIgnored, mergePath, installHint, installUrl, unpacked } = require('../src/main/toolchains');

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
  assert.deepEqual(runPlan('C:\\p\\a.js', tools, 'win32', H), { error: 'Breeze can run .c, .cpp, .cs and .py files' });
});

const WIN_C = 'No C/C++ compiler found. Install one with:\nwinget install BrechtSanders.WinLibs.POSIX.UCRT';

test('runPlan missing C on Windows gives the winget command', () =>
  assert.equal(runPlan('C:\\p\\a.c', { cc: null, cxx: null, python: null, binDirs: [] }, 'win32', H).error, WIN_C));

test('runPlan with no tools says how to get them', () => {
  const none = { cc: null, cxx: null, python: null, binDirs: [] };
  assert.equal(runPlan('C:\\p\\a.cpp', none, 'win32', H).error, WIN_C);
  assert.equal(runPlan('/p/a.c', none, 'darwin', H).error, 'No C/C++ compiler found. Install one with:\nxcode-select --install');
  assert.equal(runPlan('/p/a.c', none, 'linux', H).error, 'No C/C++ compiler found. Install gcc with your package manager (e.g. sudo apt install build-essential)');
  assert.equal(runPlan('C:\\p\\a.py', none, 'win32', H).error, "Python wasn't found. Install it with:\nwinget install Python.Python.3.13");
  assert.equal(runPlan('/p/a.py', none, 'darwin', H).error, "Python wasn't found. Install it with:\nxcode-select --install");
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
  assert.deepEqual(none, { cc: null, cxx: null, python: null, dotnet: null, binDirs: [] });
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

test('runSteps keeps a multi-byte character split across chunks whole', async () => {
  const bytes = Buffer.from('é');
  const spawn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', bytes.subarray(0, 1)); c.stdout.emit('data', bytes.subarray(1)); c.emit('close', 0); });
    return c;
  };
  const data = [];
  await done((res) => runSteps([steps[0]], { spawn, env: {}, onStart() {}, onData: (d) => data.push(d), onChild() {}, onDone: res }));
  assert.equal(data.join(''), 'é');
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

test('runPlan Python step sets PYTHONUTF8', () => {
  assert.equal(runPlan('C:\\p\\a.py', tools, 'win32', H).steps[0].env.PYTHONUTF8, '1');
  assert.equal(runPlan('C:\\p\\a.c', tools, 'win32', H).steps[0].env, undefined);
});

test('runSteps merges step.env over env when spawning', async () => {
  const { spawn, calls } = fakeSpawn([0, 0]);
  await done((res) => runSteps([{ ...steps[0], env: { X: '2', PYTHONUTF8: '1' } }, steps[1]], { spawn, env: { X: '1', Y: '1' }, onStart() {}, onData() {}, onChild() {}, onDone: res }));
  assert.deepEqual(calls[0].opts.env, { X: '2', Y: '1', PYTHONUTF8: '1' });
  assert.deepEqual(calls[1].opts.env, { X: '1', Y: '1' });
});

test('installHint gives the bare command, or the advice where there is none', () => {
  assert.equal(installHint('c', 'win32'), 'winget install BrechtSanders.WinLibs.POSIX.UCRT');
  assert.equal(installHint('py', 'win32'), 'winget install Python.Python.3.13');
  assert.equal(installHint('c', 'darwin'), 'xcode-select --install');
  assert.match(installHint('py', 'linux'), /^Python wasn't found. Install python3/);
});

test('mergePath keeps fresh first, then inherited entries it lacks', () => {
  assert.equal(
    mergePath('C:\\Windows;C:\\Tools\\', 'c:\\windows\\;C:\\venv\\Scripts;C:\\tools;;C:\\nm\\.bin', 'win32'),
    'C:\\Windows;C:\\Tools\\;C:\\venv\\Scripts;C:\\nm\\.bin');
  assert.equal(mergePath('/usr/bin:/bin', '/opt/x:/usr/bin/:/Bin', 'linux'), '/usr/bin:/bin:/opt/x:/Bin');
  assert.equal(mergePath('', undefined, 'linux'), '');
});

/* ----- C# ----- */
const withDotnet = (version = '10.0.401') => ({ ...tools, dotnet: T('C:\\Program Files\\dotnet\\dotnet.exe', 'dotnet', version) });

test('runPlan runs a lone .cs file with dotnet run', () => {
  const r = runPlan('C:\\p\\Hello.cs', withDotnet(), 'win32', H);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].file, 'C:\\Program Files\\dotnet\\dotnet.exe');
  assert.deepEqual(r.steps[0].args, ['run', 'C:\\p\\Hello.cs']);
  assert.equal(r.steps[0].display, 'dotnet run "Hello.cs"');
  assert.equal(r.steps[0].cwd, 'C:\\p');
  assert.equal(r.steps[0].env.DOTNET_NOLOGO, '1');
});

test('runPlan runs the nearest C# project when there is one, on any SDK', () => {
  const r = runPlan('C:\\p\\App\\src\\Program.cs', withDotnet('8.0.100'), 'win32', H, { csproj: 'C:\\p\\App\\App.csproj' });
  assert.deepEqual(r.steps[0].args, ['run', '--project', 'C:\\p\\App\\App.csproj']);
  assert.equal(r.steps[0].display, 'dotnet run --project "App.csproj"');
  assert.equal(r.steps[0].cwd, 'C:\\p\\App');
});

test('runPlan says an old .NET SDK cannot run a lone .cs file, and how to fix it', () => {
  const err = runPlan('C:\\p\\Hello.cs', withDotnet('8.0.404'), 'win32', H).error;
  assert.match(err, /^\.NET SDK 8\.0\.404 can't run a single \.cs file; that needs \.NET 10 or newer\./);
  assert.match(err, /\nwinget install Microsoft\.DotNet\.SDK\.10\n/);
  assert.match(err, /https:\/\/dotnet\.microsoft\.com\/download/);
  assert.match(err, /dotnet new console$/);
});

test('runPlan without the .NET SDK gives an install command and a download link', () => {
  const none = { cc: null, cxx: null, python: null, dotnet: null, binDirs: [] };
  assert.equal(runPlan('C:\\p\\a.cs', none, 'win32', H).error,
    'No C# compiler found. Install the .NET SDK with:\nwinget install Microsoft.DotNet.SDK.10\nOr download it from https://dotnet.microsoft.com/download');
  assert.equal(runPlan('/p/a.cs', none, 'darwin', H).error,
    'No C# compiler found. Install the .NET SDK with:\nbrew install --cask dotnet-sdk\nOr download it from https://dotnet.microsoft.com/download');
  assert.equal(runPlan('/p/a.cs', none, 'linux', H).error,
    'No C# compiler found. Install the .NET SDK with your package manager\nDownload it from https://learn.microsoft.com/dotnet/core/install/linux');
});

test('installHint and installUrl for C#', () => {
  assert.equal(installHint('cs', 'win32'), 'winget install Microsoft.DotNet.SDK.10');
  assert.equal(installUrl('cs', 'win32'), 'https://dotnet.microsoft.com/download');
  assert.equal(installUrl('c', 'win32'), null);
});

test('findTools finds dotnet on the PATH', async () => {
  const r = await findTools(machine('win32', { 'C:\\bin\\dotnet.exe': '10.0.401\r\n' }));
  assert.deepEqual(r.dotnet, { path: 'C:\\bin\\dotnet.exe', name: 'dotnet', version: '10.0.401' });
  assert.deepEqual(r.binDirs, []);
});

test('findTools finds dotnet in Program Files off the PATH and adds its folder', async () => {
  const m = machine('win32', { 'C:\\Program Files\\dotnet\\dotnet.exe': '10.0.100' });
  m.env.ProgramFiles = 'C:\\Program Files';
  const r = await findTools(m);
  assert.equal(r.dotnet.path, 'C:\\Program Files\\dotnet\\dotnet.exe');
  assert.deepEqual(r.binDirs, ['C:\\Program Files\\dotnet']);
});

test('findTools ignores a dotnet with no SDK (its --version fails)', async () => {
  const m = machine('linux', {}, { exists: (p) => p === '/usr/share/dotnet/dotnet' });
  const r = await findTools(m);
  assert.equal(r.dotnet, null);
  assert.ok(m.calls.some((c) => c[0] === '/usr/share/dotnet/dotnet' && c[1] === '--version'));
});

test('unpacked points into app.asar.unpacked in the packaged app, and changes nothing in development', () => {
  assert.equal(unpacked('C:\\Program Files\\Breeze IDE\\resources\\app.asar\\runtime\\breeze_stdio.h'),
    'C:\\Program Files\\Breeze IDE\\resources\\app.asar.unpacked\\runtime\\breeze_stdio.h');
  assert.equal(unpacked('/opt/Breeze/resources/app.asar/runtime/breeze_stdio.h'), '/opt/Breeze/resources/app.asar.unpacked/runtime/breeze_stdio.h');
  assert.equal(unpacked('D:\\Project-B\\runtime\\breeze_stdio.h'), 'D:\\Project-B\\runtime\\breeze_stdio.h');
  assert.equal(unpacked('C:\\r\\app.asar.unpacked\\runtime\\h'), 'C:\\r\\app.asar.unpacked\\runtime\\h');
});
