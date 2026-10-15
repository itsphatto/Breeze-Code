const fs = require('node:fs');
const path = require('node:path');

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

const toolchainRoot = ({ isPackaged, resourcesPath, appDir }) =>
  isPackaged ? path.join(resourcesPath, 'toolchains') : path.join(appDir, 'vendor');

async function toolPaths({ platform, root, exists, which }) {
  if (platform !== 'win32') {
    return { gcc: await which('cc'), gxx: await which('c++'), python: await which('python3'), binDirs: [] };
  }
  const P = path.win32;
  const gccBin = P.join(root, 'w64devkit', 'bin');
  const pyDir = P.join(root, 'python');
  const pick = (p) => (exists(p) ? p : null);
  return {
    gcc: pick(P.join(gccBin, 'gcc.exe')),
    gxx: pick(P.join(gccBin, 'g++.exe')),
    python: pick(P.join(pyDir, 'python.exe')),
    binDirs: [gccBin, pyDir, P.join(pyDir, 'Scripts')].filter(exists),
  };
}

function toolEnv(baseEnv, binDirs, platform) {
  const env = { ...baseEnv };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const delim = platform === 'win32' ? ';' : ':';
  env[key] = [...binDirs, ...(env[key] ? [env[key]] : [])].join(delim);
  return env;
}

const MISSING = {
  c: {
    win32: "Compilers aren't downloaded yet — run npm run fetch-toolchains",
    darwin: 'Install a C compiler (xcode-select --install)',
    other: 'Install a C compiler with your package manager',
  },
  py: {
    win32: "Python isn't downloaded yet — run npm run fetch-toolchains",
    darwin: 'Install Python 3 (xcode-select --install)',
    other: 'Install Python 3 with your package manager',
  },
};
const missing = (kind, platform) => MISSING[kind][platform] || MISSING[kind].other;

function runPlan(absFile, tools, platform, stdioHeader) {
  const P = pathFor(platform);
  const cwd = P.dirname(absFile);
  const { name, ext, base } = P.parse(absFile);
  const e = ext.toLowerCase();

  if (e === '.py') {
    if (!tools.python) return { error: missing('py', platform) };
    return { steps: [{ display: `python -u "${base}"`, file: tools.python, args: ['-u', absFile], cwd }] };
  }

  const cpp = ['.cpp', '.cc', '.cxx'].includes(e);
  if (e !== '.c' && !cpp) return { error: 'Breeze can run .c, .cpp and .py files' };
  const compiler = cpp ? tools.gxx : tools.gcc;
  if (!compiler) return { error: missing('c', platform) };

  const out = P.join('build', name + (platform === 'win32' ? '.exe' : ''));
  const std = cpp ? '-std=c++20' : '-std=c17';
  const flags = [std, '-Wall', '-g'];
  return {
    steps: [
      {
        display: `${cpp ? 'g++' : 'gcc'} "${base}" -o "${out}" ${flags.join(' ')}`,
        file: compiler,
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
      if (cancelled) finish(null);
      else if (code !== 0 || i === steps.length - 1) finish(code);
      else next(i + 1);
    };
    child = spawn(step.file, step.args, { cwd: step.cwd, env, windowsHide: true });
    onChild(child);
    const feed = (b) => onData(b.toString('utf8'));
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
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

function ensureBuildIgnored(rootDir) {
  const file = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(/\r?\n/).some((l) => ['build', 'build/', '/build/'].includes(l.trim()))) return;
  fs.appendFileSync(file, (text === '' || text.endsWith('\n') ? '' : '\n') + 'build/\n');
}

module.exports = { toolchainRoot, toolPaths, toolEnv, runPlan, runSteps, ensureBuildIgnored };
