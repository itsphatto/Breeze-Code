const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

const WIN_EXTRA = [
  'C:\\msys64\\ucrt64\\bin',
  'C:\\msys64\\mingw64\\bin',
  'C:\\msys64\\clang64\\bin',
  'C:\\MinGW\\bin',
  'C:\\mingw64\\bin',
  'C:\\ProgramData\\mingw64\\mingw64\\bin',
];
const WINLIBS = '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs*\\mingw64\\bin';
// Where the .NET SDK installs when it isn't on the PATH (installers, Homebrew, distro packages, dotnet-install script).
const DOTNET_DIRS = (platform, env) => (platform === 'win32'
  ? [env.ProgramFiles && env.ProgramFiles + '\\dotnet', env.USERPROFILE && env.USERPROFILE + '\\.dotnet']
  : ['/usr/local/share/dotnet', '/usr/share/dotnet', '/usr/lib/dotnet', '/opt/homebrew/bin', env.HOME && env.HOME + '/.dotnet']
).filter(Boolean);

// Compilers in lookup order: [C compiler, its C++ partner]
const COMPILERS = (platform) => [
  ['gcc', 'g++'],
  ['clang', 'clang++'],
  ...(platform === 'win32' ? [] : [['cc', 'c++']]),
];

async function findTools(o) {
  const { platform, pathValue, env, exists, glob, run } = o;
  const win = platform === 'win32';
  const P = pathFor(platform);
  const clean = (d) => d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

  const pathDirs = (pathValue || '').split(win ? ';' : ':').map(clean).filter(Boolean);
  const dirs = [...pathDirs];
  if (win) {
    const extra = [...WIN_EXTRA];
    if (env.LOCALAPPDATA) extra.push(...glob(WINLIBS.replace('%LOCALAPPDATA%', env.LOCALAPPDATA)).map(clean));
    for (const d of extra) if (!dirs.some((x) => same(x, d))) dirs.push(d);
  }

  const file = (dir, name) => P.join(dir, win ? name + '.exe' : name);
  // First candidate that exists and passes `--version` (the Store python shortcut exits non-zero).
  const probe = async (candDirs, name, pre = []) => {
    for (const dir of candDirs) {
      const p = file(dir, name);
      if (!exists(p)) continue;
      const r = await run(p, [...pre, '--version']).catch(() => null);
      if (r && r.code === 0) return { dir, path: p, name, version: String(r.stdout || '').split(/\r?\n/)[0].trim() };
    }
    return null;
  };
  const tool = (f) => f && { path: f.path, name: f.name, version: f.version };

  let cc = null, cxx = null, ccDir = null;
  for (const [c, cpp] of COMPILERS(platform)) {
    const f = await probe(dirs, c);
    if (!f) continue;
    cc = tool(f);
    ccDir = f.dir;
    cxx = tool(await probe([f.dir], cpp));
    break;
  }

  let python = null;
  if (win) {
    const f = await probe(pathDirs, 'py', ['-3']);
    if (f) python = tool(f);
  }
  if (!python) {
    const f = await probe(pathDirs, win ? 'python' : 'python3');
    if (f) {
      const r = await run(f.path, ['-c', 'import sys; print(sys.executable)']).catch(() => null);
      const exe = r && r.code === 0 ? String(r.stdout || '').trim() : '';
      python = tool({ ...f, path: exe || f.path });
    }
  }

  // C#: the .NET SDK's `dotnet`. `dotnet --version` only exits 0 when an SDK (not just a runtime) is installed.
  const dotnetDirs = [...pathDirs];
  for (const d of DOTNET_DIRS(platform, env || {})) if (!dotnetDirs.some((x) => same(x, d))) dotnetDirs.push(d);
  const dotnet = tool(await probe(dotnetDirs, 'dotnet'));

  const binDirs = [];
  for (const t of [cc, cxx, python, dotnet]) {
    if (!t) continue;
    const d = P.dirname(t.path);
    if (!pathDirs.some((x) => same(x, d)) && !binDirs.some((x) => same(x, d))) binDirs.push(d);
  }
  return { cc, cxx, python, dotnet, binDirs };
}

async function freshPath(platform, run) {
  const fallback = () => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
    return (key && process.env[key]) || '';
  };
  if (platform !== 'win32') return process.env.PATH || '';
  try {
    const r = await run('powershell.exe', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
    const out = r && r.code === 0 ? String(r.stdout || '').trim() : '';
    return out || fallback();
  } catch {
    return fallback();
  }
}

function toolEnv(baseEnv, binDirs, platform, pathValue) {
  const env = { ...baseEnv };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const delim = platform === 'win32' ? ';' : ':';
  const base = pathValue != null ? pathValue : env[key];
  env[key] = [...binDirs, ...(base ? [base] : [])].join(delim);
  return env;
}

// What to tell the user when a tool isn't installed. `cmd` is the single command to run, if there is one;
// `url` is a page to download it from.
const DOTNET_URL = 'https://dotnet.microsoft.com/download';
const MISSING = {
  c: {
    win32: { lead: 'No C/C++ compiler found. Install one with:', cmd: 'winget install BrechtSanders.WinLibs.POSIX.UCRT' },
    darwin: { lead: 'No C/C++ compiler found. Install one with:', cmd: 'xcode-select --install' },
    other: { lead: 'No C/C++ compiler found. Install gcc with your package manager (e.g. sudo apt install build-essential)' },
  },
  py: {
    win32: { lead: "Python wasn't found. Install it with:", cmd: 'winget install Python.Python.3.13' },
    darwin: { lead: "Python wasn't found. Install it with:", cmd: 'xcode-select --install' },
    other: { lead: "Python wasn't found. Install python3 with your package manager" },
  },
  cs: {
    win32: { lead: 'No C# compiler found. Install the .NET SDK with:', cmd: 'winget install Microsoft.DotNet.SDK.10', url: DOTNET_URL },
    darwin: { lead: 'No C# compiler found. Install the .NET SDK with:', cmd: 'brew install --cask dotnet-sdk', url: DOTNET_URL },
    other: { lead: 'No C# compiler found. Install the .NET SDK with your package manager', url: 'https://learn.microsoft.com/dotnet/core/install/linux' },
  },
};
const entry = (kind, platform) => MISSING[kind][platform] || MISSING[kind].other;
// The lead and command, then the download page when there is one.
const download = (m) => (m.url ? `\n${m.cmd ? 'Or download it from' : 'Download it from'} ${m.url}` : '');
const missing = (kind, platform) => { const m = entry(kind, platform); return (m.cmd ? m.lead + '\n' + m.cmd : m.lead) + download(m); };
// Short install hint for the tools list: the command, or the plain advice where there is none.
const installHint = (kind, platform) => { const m = entry(kind, platform); return m.cmd || m.lead; };
// The download page for the tools list's "Get" button, if there is one.
const installUrl = (kind, platform) => entry(kind, platform).url || null;

// PATH entries: `fresh` first, then those of `inherited` that `fresh` lacks (case-insensitive on Windows, trailing separators ignored).
function mergePath(fresh, inherited, platform) {
  const win = platform === 'win32';
  const delim = win ? ';' : ':';
  const norm = (d) => { const c = d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, ''); return win ? c.toLowerCase() : c; };
  const seen = new Set();
  const out = [];
  for (const d of [...(fresh || '').split(delim), ...(inherited || '').split(delim)]) {
    const k = norm(d);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(d.trim());
  }
  return out.join(delim);
}

// `opts.csproj` is the nearest .csproj at or above a .cs file, if any (main.js looks it up).
function runPlan(absFile, tools, platform, stdioHeader, opts = {}) {
  const P = pathFor(platform);
  const cwd = P.dirname(absFile);
  const { name, ext, base } = P.parse(absFile);
  const e = ext.toLowerCase();

  if (e === '.cs') {
    const dn = tools.dotnet;
    if (!dn) return { error: missing('cs', platform) };
    const env = { DOTNET_NOLOGO: '1' };
    // Inside a project, run the project: it builds every .cs file in it.
    if (opts.csproj) {
      return { steps: [{ display: `dotnet run --project "${P.basename(opts.csproj)}"`, file: dn.path, args: ['run', '--project', opts.csproj], cwd: P.dirname(opts.csproj), env }] };
    }
    // A lone .cs file runs as a file-based app, which needs the .NET 10 SDK or newer.
    const major = Number(/^(\d+)\./.exec(dn.version)?.[1] || 0);
    if (major && major < 10) {
      const m = entry('cs', platform);
      return { error: `.NET SDK ${dn.version} can't run a single .cs file; that needs .NET 10 or newer.` +
        (m.cmd ? `\nUpdate with:\n${m.cmd}` : '') + download(m) + '\nOr make this folder a project with: dotnet new console' };
    }
    return { steps: [{ display: `dotnet run "${base}"`, file: dn.path, args: ['run', absFile], cwd, env }] };
  }

  if (e === '.py') {
    const py = tools.python;
    if (!py) return { error: missing('py', platform) };
    const pre = py.name === 'py' ? ['-3'] : [];
    return {
      // UTF-8 so print("café ✓") works when stdout is a pipe on a non-UTF-8 Windows code page
      steps: [{ display: `${py.name} ${[...pre, '-u'].join(' ')} "${base}"`, file: py.path, args: [...pre, '-u', absFile], cwd, env: { PYTHONUTF8: '1' } }],
    };
  }

  const cpp = ['.cpp', '.cc', '.cxx'].includes(e);
  if (e !== '.c' && !cpp) return { error: 'Breeze can run .c, .cpp, .cs and .py files' };
  const compiler = cpp ? tools.cxx : tools.cc;
  if (!compiler) return { error: missing('c', platform) };

  const out = P.join('build', name + (platform === 'win32' ? '.exe' : ''));
  const std = cpp ? '-std=c++20' : '-std=c17';
  const flags = [std, '-Wall', '-g'];
  return {
    steps: [
      {
        display: `${compiler.name} "${base}" -o "${out}" ${flags.join(' ')}`,
        file: compiler.path,
        args: [absFile, '-o', out, ...flags, '-include', stdioHeader],
        cwd,
      },
      { display: platform === 'win32' ? out : './' + out, file: P.join(cwd, out), args: [], cwd },
    ],
  };
}

function runSteps(steps, { spawn, env, onStart, onData, onChild, onDone }) {
  let child = null;
  let cancelled = false;
  let finished = false;
  let t0 = 0;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    onDone(code, Date.now() - t0);
  };

  const next = (i) => {
    if (cancelled) return finish(null);
    const step = steps[i];
    onStart(step);
    if (!t0) t0 = Date.now();
    let settled = false;
    const end = (code) => {
      if (settled) return;
      settled = true;
      for (const d of decoders) { const rest = d.end(); if (rest) onData(rest); }
      if (cancelled) finish(null);
      else if (code !== 0 || i === steps.length - 1) finish(code);
      else next(i + 1);
    };
    child = spawn(step.file, step.args, { cwd: step.cwd, env: step.env ? { ...env, ...step.env } : env, windowsHide: true });
    onChild(child);
    // one decoder per stream so a multi-byte character split across chunks stays whole
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    child.stdout.on('data', (b) => onData(decoders[0].write(b)));
    child.stderr.on('data', (b) => onData(decoders[1].write(b)));
    child.on('error', (err) => {
      if (settled) return;
      onData(err.message + '\n');
      settled = true;
      finish(-1);
    });
    child.on('close', end);
  };

  if (steps.length) next(0);
  else finish(0);

  return {
    cancel() {
      cancelled = true;
      if (child) child.kill();
    },
  };
}

// Outside programs (gcc reading the -include header) can't see into the packaged app's asar archive, so
// electron-builder unpacks those files next to it (asarUnpack in package.json). In development nothing changes.
const unpacked = (p) => p.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');

function ensureBuildIgnored(rootDir) {
  const file = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(/\r?\n/).some((l) => ['build', 'build/', '/build/'].includes(l.trim()))) return;
  fs.appendFileSync(file, (text === '' || text.endsWith('\n') ? '' : '\n') + 'build/\n');
}

module.exports = { findTools, freshPath, toolEnv, runPlan, runSteps, ensureBuildIgnored, mergePath, installHint, installUrl, unpacked };
