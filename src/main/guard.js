// Checks that keep the window, the agents and git inside what the user opened.
// Plain functions with no Electron, so test/guard.test.js can cover them.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/* ----- The app's own page ----- */
// True when `url` is the file:// address of `file` (query and hash ignored).
function isFileUrl(url, file, platform = process.platform) {
  let p;
  try { p = fileURLToPath(url); } catch { return false; } // not a file URL (or no URL at all)
  const norm = s => (platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s));
  return norm(p) === norm(file);
}

/* ----- Paths inside the project ----- */
const OUTSIDE = 'That path is outside the project';
// `back` is a path relative to some base; true when it leads out of that base.
const leaves = back => back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back);
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
// Where `abs` really is: its nearest existing ancestor with links and junctions followed, plus the part
// that doesn't exist yet (a file about to be created).
function realTarget(abs) {
  let p = abs, rest = '';
  for (;;) {
    try { return path.join(fs.realpathSync.native(p), rest); }
    catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      // A broken link would be followed by a write to wherever it points.
      if (isLink(p)) throw new Error(OUTSIDE);
      const up = path.dirname(p);
      if (up === p) throw err;
      rest = path.join(path.basename(p), rest);
      p = up;
    }
  }
}
const realRelative = (base, abs) => path.relative(fs.realpathSync.native(base), realTarget(abs));
// Resolve `rel` inside `base` and refuse anything that leaves it, by `..` or through a symlink or junction.
function resolveUnder(base, rel = '') {
  const abs = path.resolve(base, rel);
  if (leaves(path.relative(base, abs)) || leaves(realRelative(base, abs))) throw new Error(OUTSIDE);
  return abs;
}

/* ----- What agents may touch ----- */
// Secrets (.env, .env.local…) and git's own folder, whose config and hooks run commands.
// `rel` is relative to the project; returns why the path is off limits, or null.
function blockedRel(rel) {
  const parts = String(rel).split(/[\\/]/).filter(p => p && p !== '.');
  if (parts.some(p => p.toLowerCase() === '.git')) return 'The .git folder is off limits to agents: its config and hooks can run commands.';
  const name = parts.at(-1) ?? '';
  if (/^\.env/i.test(name)) return `${name} holds secrets, so agents can't read or change it.`;
  return null;
}
// The same check on the path as written and on where it really leads (Windows also reaches .git as "GIT~1" or ".git.").
function agentBlocked(base, abs) {
  return blockedRel(path.relative(base, abs)) ?? blockedRel(realRelative(base, abs));
}

/* ----- Git ----- */
// A repository's own config can name commands git runs by itself (core.fsmonitor on status, diff.external and
// textconv drivers on diff and show). Breeze runs git whenever files change, so those are off for every call it makes.
function safeGitArgs(args) {
  const [cmd, ...rest] = args;
  const noDrivers = cmd === 'diff' || cmd === 'show' ? ['--no-ext-diff', '--no-textconv'] : [];
  return ['-c', 'core.fsmonitor=false', cmd, ...noDrivers, ...rest];
}

/* ----- Programs that need cmd.exe ----- */
// npm's .cmd shims only run through a shell on Windows. The program is quoted, so a path with spaces works,
// and only plain arguments are allowed, so nothing in them can act as shell syntax.
const PLAIN_ARG = /^[\w.:=@/-]+$/;
function shellCommand(bin, args) {
  if (bin.includes('"')) throw new Error(`Can't run ${bin} through a shell`);
  const bad = args.find(a => !PLAIN_ARG.test(a));
  if (bad != null) throw new Error(`Refusing to pass ${JSON.stringify(bad)} through a shell`);
  return [`"${bin}"`, ...args].join(' ');
}

module.exports = { isFileUrl, resolveUnder, blockedRel, agentBlocked, safeGitArgs, shellCommand, OUTSIDE };
