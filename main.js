// Electron main process for Breeze IDE: window, file system, search, terminal, git, agents, sign-in and Vibe Mode.
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const { spawn, execFile, exec } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const nodeModule = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '__pycache__', '.venv']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const MAX_LISTED_FILES = 10000;
const MAX_SEARCH_RESULTS = 500;

let win = null;
let root = null;          // absolute path of the open project folder
let watcher = null;
let termCwd = os.homedir();
const terms = new Map();  // id -> child process

// Logs a failure from work nobody waits for. A page load that a redirect or reload replaced isn't one.
const logError = where => err => {
  if (err?.code !== 'ERR_ABORTED') console.error(`[breeze] ${where}:`, err?.message ?? err);
};
// Opens an https link in the user's browser.
function openInBrowser(url) {
  if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url).catch(logError('openExternal'));
}

/* ================= Persisted main-process state ================= */
const statePath = () => path.join(app.getPath('userData'), 'breeze-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return { lastRoot: null, recent: [] }; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  try { fs.writeFileSync(statePath(), JSON.stringify(s, null, 2)); } catch { /* best effort */ }
  return s;
}

/* ================= Window ================= */
// The app icon on the taskbar, window and dock.
const APP_ICON = path.join(__dirname, 'Icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Breeze IDE',
    icon: APP_ICON,
    backgroundColor: '#000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b0d', symbolColor: '#a1a1aa', height: 38 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'breeze.html')).catch(logError('loadFile'));

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.on('closed', () => { win = null; vibeView = null; stopWatching(); killAllTerms(); });
}

app.whenReady().then(() => {
  // The menu bar is drawn in HTML; the native one would only duplicate it.
  Menu.setApplicationMenu(null);
  if (process.platform === 'darwin') app.dock?.setIcon(APP_ICON);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(logError('startup'));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ================= Paths ================= */
// Resolve a project-relative path and refuse anything that escapes the open folder.
function resolveIn(rel = '') {
  if (!root) throw new Error('No folder is open');
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new Error('That path is outside the project');
  return abs;
}
const toRel = abs => path.relative(root, abs).split(path.sep).join('/');

async function setRoot(dir) {
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new Error('Not a folder');
  root = dir;
  termCwd = dir;
  const recent = [dir, ...(loadState().recent || []).filter(r => r !== dir)].slice(0, 10);
  saveState({ lastRoot: dir, recent });
  startWatching();
  return { root: dir, name: path.basename(dir) };
}

/* ================= Watching ================= */
function startWatching() {
  stopWatching();
  let pending = new Set();
  let timer = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_type, file) => {
      if (!file) return;
      const rel = String(file).split(path.sep).join('/');
      if (rel.split('/').some(part => part === '.git' || part === 'node_modules')) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        win?.webContents.send('fs:changed', [...pending]);
        pending = new Set();
      }, 250);
    });
    watcher.on('error', () => stopWatching());
  } catch { watcher = null; } // some file systems can't be watched; Refresh still works
}
function stopWatching() { watcher?.close(); watcher = null; }

/* ================= File system IPC ================= */
// Folders first, then names A–Z.
function byDirThenName(a, b) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

ipcMain.handle('fs:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return setRoot(r.filePaths[0]);
});

ipcMain.handle('fs:restore', async () => {
  const { lastRoot } = loadState();
  if (!lastRoot) return null;
  try { return await setRoot(lastRoot); } catch { saveState({ lastRoot: null }); return null; }
});

ipcMain.handle('fs:closeFolder', () => {
  root = null; stopWatching(); saveState({ lastRoot: null });
});

ipcMain.handle('fs:recent', () => (loadState().recent || []).map(p => ({ path: p, name: path.basename(p) })));

ipcMain.handle('fs:openRecent', async (_e, dir) => {
  if (!(loadState().recent || []).includes(dir)) throw new Error('Unknown folder');
  return setRoot(dir);
});

ipcMain.handle('fs:readDir', async (_e, rel) => {
  const entries = await fsp.readdir(resolveIn(rel), { withFileTypes: true });
  return entries.map(d => ({ name: d.name, dir: d.isDirectory() })).sort(byDirThenName);
});

ipcMain.handle('fs:readFile', async (_e, rel) => {
  const abs = resolveIn(rel);
  const st = await fsp.stat(abs);
  // Images are shown from their file URL, so only their size is needed here.
  if (IMAGE_FILE.test(abs)) return { image: true, size: st.size };
  if (st.size > MAX_FILE_BYTES) return { tooLarge: true, size: st.size };
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size };
});

ipcMain.handle('fs:writeFile', async (_e, rel, text) => {
  await fsp.writeFile(resolveIn(rel), text, 'utf8');
});

ipcMain.handle('fs:createFile', async (_e, rel) => {
  const abs = resolveIn(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, '', { flag: 'wx' });
});

ipcMain.handle('fs:createDir', async (_e, rel) => {
  await fsp.mkdir(resolveIn(rel), { recursive: false });
});

ipcMain.handle('fs:rename', async (_e, from, to) => {
  const dest = resolveIn(to);
  if (fs.existsSync(dest)) throw new Error('Something with that name already exists');
  await fsp.rename(resolveIn(from), dest);
});

// Deleting moves to the Recycle Bin / Trash so it can be undone.
ipcMain.handle('fs:trash', async (_e, rel) => {
  if (!rel) throw new Error('Refusing to delete the project folder');
  await shell.trashItem(resolveIn(rel));
});

ipcMain.handle('fs:fileUrl', (_e, rel) => pathToFileURL(resolveIn(rel)).href);

// Every file under `dir`, skipping build output and dependencies. Folders are read in parallel.
async function listFiles(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } // unreadable folder: skip it
  const files = entries.filter(d => d.isFile()).map(d => path.join(dir, d.name));
  const subdirs = entries.filter(d => d.isDirectory() && !IGNORED_DIRS.has(d.name)).map(d => path.join(dir, d.name));
  const nested = await Promise.all(subdirs.map(listFiles));
  return files.concat(...nested).slice(0, MAX_LISTED_FILES);
}

ipcMain.handle('fs:listFiles', async () => (await listFiles(resolveIn(''))).map(toRel));

ipcMain.handle('fs:search', (_e, query, matchCase) => searchProject(query, matchCase));

// A file's text if it is small and not binary, else null.
async function readSearchable(abs) {
  try {
    const st = await fsp.stat(abs);
    if (st.size > 1024 * 1024) return null;
    const buf = await fsp.readFile(abs);
    return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
  } catch {
    return null; // deleted or locked while searching
  }
}
function searchText(text, rel, needle, matchCase, results) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
    const col = (matchCase ? lines[i] : lines[i].toLowerCase()).indexOf(needle);
    if (col !== -1) results.push({ path: rel, line: i, col, text: lines[i].slice(0, 300) });
  }
}
// Reads files a batch at a time and stops once there are enough results.
async function searchProject(query, matchCase) {
  if (!query) return [];
  const files = await listFiles(resolveIn(''));
  const needle = matchCase ? query : query.toLowerCase();
  const results = [];
  const batch = async start => {
    if (start >= files.length || results.length >= MAX_SEARCH_RESULTS) return;
    const texts = await Promise.all(files.slice(start, start + 32).map(readSearchable));
    texts.forEach((text, k) => { if (text != null) searchText(text, toRel(files[start + k]), needle, matchCase, results); });
    await batch(start + 32);
  };
  await batch(0);
  return results;
}

/* ================= Syntax check (JavaScript / TypeScript) ================= */
// V8 compiles the code into a function that is never called, so this only finds syntax errors.
// Returns { ok: true }, the first error as { line, col, len, msg, eof } (0-based), or null when it can't tell.
const MODULE_SYNTAX = [/^[ \t]*import\s*[\w$*{'"]/m, /^[ \t]*export\b/m, /\bimport\.meta\b/];
const MODULE_WRAP = '(async function(){"use strict";';
const blank = s => s.replaceAll(/[^\n]/g, ' ');

// The end of an `import … from '…'` or `export … from '…'` statement starting at `from`, or -1.
function statementEnd(code, from) {
  let i = from;
  const brace = code.indexOf('{', i);
  const quote = code.slice(i).search(/["']/) + i;
  if (brace !== -1 && brace < quote) i = code.indexOf('}', brace) + 1;
  const q = code.slice(i).search(/["']|;|\n\s*\n/);
  if (q === -1 || !/["']/.test(code[i + q])) return i; // `export { a, b };` with no module
  const open = i + q, close = code.indexOf(code[open], open + 1);
  if (close === -1) return -1;
  let end = close + 1;
  const attrs = /^\s*(?:with|assert)\s*\{[^}]*\}/.exec(code.slice(end));
  if (attrs) end += attrs[0].length;
  return code[end] === ';' ? end + 1 : end;
}
// Blank out import/export syntax (same length, same lines) so module code parses inside a function.
function moduleAsScript(code) {
  const chars = [...code];
  const wipe = (from, to) => { for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' '; };
  if (code.startsWith('#!')) wipe(0, code.indexOf('\n') === -1 ? code.length : code.indexOf('\n'));
  for (const m of code.matchAll(/^[ \t]*import\b(?![ \t]*[.(])/gm)) {
    const end = statementEnd(code, m.index + m[0].length);
    if (end > 0) wipe(m.index, end);
  }
  for (const m of code.matchAll(/^[ \t]*export[ \t]*(?=[*{])/gm)) {
    const end = statementEnd(code, m.index + m[0].length);
    if (end > 0) wipe(m.index, end);
  }
  return chars.join('')
    .replaceAll(/\bimport\.meta\b/g, 'Object.meta')
    .replaceAll(/^([ \t]*)export[ \t]+default\b/gm, (m, ind) => ind + 'void' + ' '.repeat(m.length - ind.length - 4))
    .replaceAll(/^[ \t]*export[ \t]+(?=(?:async[ \t]+)?function\b|class\b|const\b|let\b|var\b)/gm, blank);
}

// V8 and Node's TypeScript stripper both report "<file>:LINE", the source line(s), then a row of carets.
function syntaxError(e, code, shift) {
  const rows = String(e.stack || '').split('\n');
  const line = Number(rows[0].slice(rows[0].lastIndexOf(':') + 1)) - 1;
  if (!Number.isInteger(line) || line < 0) return null;
  const caret = rows.slice(1, 6).find(r => r.trim() && /^\^+$/.test(r.trim())) || '';
  const lines = code.split('\n');
  const eof = line >= lines.length || /end of input/i.test(e.message);
  if (line >= lines.length) return { line: lines.length - 1, col: lines.at(-1).length, len: 1, msg: 'Unexpected end of input', eof };
  const col = Math.max(0, caret.indexOf('^') - (line === 0 ? shift : 0));
  return { line, col, len: Math.max(1, caret.trim().length), msg: e.message, eof };
}
// Types are blanked out in place (same positions); enums and namespaces need a real compiler, so those return null.
function stripTypes(code) {
  try { return { src: nodeModule.stripTypeScriptTypes(code, { mode: 'strip' }) }; }
  catch (e) { return { error: e.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' ? syntaxError(e, code, 0) : null }; }
}
function syntaxCheck(code, ext) {
  let src = code;
  if (/^[mc]?ts$/.test(ext)) {
    const r = stripTypes(code);
    if (!r.src) return r.error;
    src = r.src;
  }
  const isModule = /^m[jt]s$/.test(ext) || MODULE_SYNTAX.some(re => re.test(src));
  if (isModule) src = `${MODULE_WRAP}${moduleAsScript(src)}\n})`;
  try {
    vm.compileFunction(src, [], { filename: 'check' });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof SyntaxError)) return null;
    if (e.message === "Unexpected token '<'" && /^[mc]?js$/.test(ext)) return null; // probably JSX in a .js file
    return syntaxError(e, code, isModule ? MODULE_WRAP.length : 0);
  }
}
ipcMain.handle('lint:check', (_e, code, ext) => (typeof code === 'string' && code.length <= 400000 ? syntaxCheck(code, String(ext)) : null));

/* ================= Terminal ================= */
let nextTermId = 1;
ipcMain.handle('term:cwd', () => termCwd);

const unquote = s => (s.length > 1 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s);
// "cd somewhere" changes the terminal's folder instead of running in a shell that exits right away.
function changeDir(command) {
  const t = command.trim();
  if (!/^cd(?:\s|$)/i.test(t)) return null;
  const arg = unquote(t.slice(2).trim());
  const target = arg ? path.resolve(termCwd, arg) : os.homedir();
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { error: `The system cannot find the path specified: ${target}` };
  termCwd = target;
  return { cwd: termCwd };
}
ipcMain.handle('term:run', (_e, command) => {
  const cd = changeDir(command);
  if (cd) return cd;
  const id = nextTermId++;
  const child = spawn(command, { shell: true, cwd: termCwd, env: process.env, windowsHide: true });
  terms.set(id, child);
  const send = chunk => win?.webContents.send('term:data', id, chunk.toString());
  child.stdout.on('data', send);
  child.stderr.on('data', send);
  child.on('error', err => send(`${err.message}\n`));
  child.on('close', code => { terms.delete(id); win?.webContents.send('term:exit', id, code); });
  return { id };
});

const TASKKILL = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'taskkill.exe');
function killTree(child) {
  if (process.platform === 'win32') execFile(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone */ });
  else child.kill('SIGTERM');
}
ipcMain.handle('term:kill', (_e, id) => { const c = terms.get(id); if (c) killTree(c); });
function killAllTerms() {
  for (const c of terms.values()) killTree(c);
  terms.clear();
}

/* ================= Tool & agent detection ================= */
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const isWin = process.platform === 'win32';

// The file inside the newest versioned sub-folder, directly or one level deeper,
// e.g. Claude desktop's bundled Claude Code at claude-code/<version>/<hash>/claude.exe.
function newestVersioned(dir, file) {
  try {
    const vers = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) {
      const base = path.join(dir, v);
      if (fs.existsSync(path.join(base, file))) return path.join(base, file);
      const sub = fs.readdirSync(base).find(s => fs.existsSync(path.join(base, s, file)));
      if (sub) return path.join(base, sub, file);
    }
  } catch { /* not installed */ }
  return null;
}

const AGENTS = [
  {
    id: 'claude', name: 'Claude Code', vendor: 'Anthropic', commands: ['claude'],
    url: 'https://claude.com/product/claude-code',
    paths: () => isWin
      ? [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(APPDATA, 'npm', 'claude.cmd'), newestVersioned(path.join(APPDATA, 'Claude', 'claude-code'), 'claude.exe')]
      : [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'],
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', commands: ['codex'],
    url: 'https://developers.openai.com/codex/cli',
    paths: () => isWin ? [path.join(APPDATA, 'npm', 'codex.cmd')] : ['/usr/local/bin/codex', '/opt/homebrew/bin/codex'],
  },
  {
    id: 'antigravity', name: 'Antigravity', vendor: 'Google', commands: ['antigravity', 'antigravity-ide'],
    url: 'https://antigravity.google',
    paths: () => isWin
      ? [
        path.join(LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd'),
        path.join(LOCALAPPDATA, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'),
        path.join(LOCALAPPDATA, 'Programs', 'Antigravity', 'Antigravity.exe'),
        path.join(LOCALAPPDATA, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      ]
      : ['/Applications/Antigravity.app', '/usr/local/bin/antigravity', '/usr/bin/antigravity'],
  },
];
const agentBins = new Map(); // agent id -> executable found by the last scan

function which(cmd) {
  return new Promise(res => {
    execFile(isWin ? 'where' : 'which', [cmd], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) { res(null); return; }
      const hits = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // On Windows prefer the runnable shim (.cmd/.exe) over the extension-less sh script npm also writes.
      res((isWin && hits.find(h => /\.(?:cmd|exe|bat)$/i.test(h))) || hits[0] || null);
    });
  });
}

// "git version 2.45.1.windows.1" → "2.45.1"
function versionIn(text) {
  const token = text.split(/[^\d.]+/).find(t => /^\d+\.\d+/.test(t));
  return token ? token.split('.').slice(0, 3).filter(Boolean).join('.') : null;
}
function versionOf(bin) {
  // Launching a GUI app's .exe would open its window, so only ask CLIs for a version.
  if (bin.endsWith('.app') || (isWin && /\.exe$/i.test(bin) && !/(?:claude|codex|gemini|git|node)\.exe$/i.test(bin))) return Promise.resolve(null);
  return new Promise(res => {
    exec(`"${bin}" --version`, { windowsHide: true, timeout: 8000 }, (err, stdout) => res(err ? null : versionIn(stdout)));
  });
}

async function locate(commands, paths) {
  const found = await Promise.all(commands.map(which));
  return found.find(Boolean) || paths.find(p => p && fs.existsSync(p)) || null;
}

ipcMain.handle('sys:detect', async () => {
  const agents = await Promise.all(AGENTS.map(async a => {
    const bin = await locate(a.commands, a.paths());
    if (bin) agentBins.set(a.id, bin); else agentBins.delete(a.id);
    return { id: a.id, name: a.name, vendor: a.vendor, url: a.url, found: !!bin, path: bin, version: bin ? await versionOf(bin) : null };
  }));
  // Gemini runs through Google's API with the user's own key instead of a local CLI.
  agents.push({ id: 'gemini', name: 'Gemini', vendor: 'Google', url: 'https://aistudio.google.com/apikey', api: true, found: !!getSecret('geminiKey'), path: null, version: loadState().geminiModel || null });
  const tools = await Promise.all([['git', 'Git'], ['node', 'Node.js']].map(async ([cmd, name]) => {
    const bin = await which(cmd);
    return { id: cmd, name, found: !!bin, version: bin ? await versionOf(bin) : null };
  }));
  return { agents, tools, platform: process.platform };
});

/* ================= Window & shell IPC ================= */
ipcMain.handle('sys:openExternal', (_e, url) => openInBrowser(url));
ipcMain.handle('win:reload', () => win?.webContents.reload());
ipcMain.handle('win:devtools', () => win?.webContents.toggleDevTools());
ipcMain.handle('win:quit', () => app.quit());
ipcMain.handle('win:edit', (_e, role) => {
  const wc = win?.webContents;
  if (wc && ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(role)) wc[role]();
});

/* ================= Secrets (encrypted with the OS keychain) ================= */
const secretsPath = () => path.join(app.getPath('userData'), 'breeze-secrets.json');
function readSecrets() {
  try { return JSON.parse(fs.readFileSync(secretsPath(), 'utf8')); } catch { return {}; }
}
function getSecret(name) {
  const enc = readSecrets()[name];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
function setSecret(name, value) {
  const all = readSecrets();
  if (value == null) delete all[name];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer');
    all[name] = safeStorage.encryptString(value).toString('base64');
  }
  fs.writeFileSync(secretsPath(), JSON.stringify(all));
}

/* ================= Gemini API key ================= */
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

async function geminiModels(key) {
  const r = await fetch(`${GEMINI_API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Gemini answered with status ${r.status}`);
  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
}
// Prefer Google's rolling "latest flash" alias, else the newest stable Flash, else anything Gemini.
function pickModel(names) {
  if (names.includes('gemini-flash-latest')) return 'gemini-flash-latest';
  const stable = names.filter(n => /^gemini-[\d.]+-(?:flash|pro)$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return stable.find(n => n.endsWith('flash')) || stable[0] || names.find(n => n.startsWith('gemini')) || 'gemini-2.5-flash';
}

ipcMain.handle('gemini:status', () => ({ hasKey: !!getSecret('geminiKey'), model: loadState().geminiModel || null }));
ipcMain.handle('gemini:setKey', async (_e, key) => {
  key = String(key || '').trim();
  if (!key) throw new Error('Paste an API key first');
  const model = pickModel(await geminiModels(key));
  setSecret('geminiKey', key);
  saveState({ geminiModel: model });
  return { model };
});
ipcMain.handle('gemini:clearKey', () => { setSecret('geminiKey', null); saveState({ geminiModel: null }); });

/* ================= Agents ================= */
// Every run streams normalized events to the renderer:
// session · text · plan · tool · file · note · error · done
const runs = new Map();
let nextRun = 1;
const emit = (runId, ev) => win?.webContents.send('agent:event', runId, ev);
const relOut = p => {
  if (!p || !root) return p || '';
  const r = path.relative(root, path.resolve(root, p));
  return r.startsWith('..') ? p : r.split(path.sep).join('/');
};
const SAFE_ID = /^[\w-]{6,80}$/;

ipcMain.handle('agent:run', (_e, opts) => {
  const runId = nextRun++;
  startRun(runId, opts).catch(err => {
    emit(runId, { t: 'error', text: err.message });
    emit(runId, { t: 'done', ok: false });
    runs.delete(runId);
  });
  return runId;
});
ipcMain.handle('agent:stop', (_e, runId) => {
  const r = runs.get(runId);
  if (!r) return;
  r.stopped = true;
  if (r.child) killTree(r.child);
  r.abort?.abort();
});
// Antigravity has no headless mode, so Breeze opens the project in its own window.
ipcMain.handle('agent:openApp', (_e, id) => {
  const bin = agentBins.get(id);
  if (!bin || !root) throw new Error('Open a folder first');
  const child = spawn(`"${bin}" "${root}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
});

// Command-line flags for a CLI agent, and the prompt it reads from stdin.
function cliArgs(agent, mode, prompt, session) {
  const build = mode === 'build';
  if (agent === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', build ? 'acceptEdits' : 'plan'];
    if (session) args.push('--resume', session);
    return { args, prompt };
  }
  const args = ['exec', '--json', '-s', build ? 'workspace-write' : 'read-only', '--skip-git-repo-check'];
  if (session) args.push('resume', session);
  args.push('-');
  if (build) return { args, prompt };
  const ask = mode === 'plan' ? 'Make a short numbered plan for this request. Do not change any files yet.' : 'Answer without changing any files.';
  return { args, prompt: `${ask}\n\n${prompt}` };
}
async function startRun(runId, { agent, mode, prompt, session }) {
  if (!root) throw new Error('Open a folder first');
  if (session && !SAFE_ID.test(session)) session = null;
  const run = { child: null, abort: null, stopped: false };
  runs.set(runId, run);
  if (agent === 'gemini') return runGemini(runId, run, { mode, prompt, session });
  const bin = agentBins.get(agent);
  if (!bin) throw new Error('That agent was not found on this computer. Rescan from Settings → Run Setup Again.');
  if (agent === 'antigravity') {
    emit(runId, { t: 'error', text: 'Antigravity runs its agents inside its own app window.', action: 'openApp' });
    emit(runId, { t: 'done', ok: false });
    runs.delete(runId);
    return;
  }
  const cli = cliArgs(agent, mode, prompt, session);
  // The prompt goes through stdin, so it never reaches a shell command line. Only fixed flags and
  // a validated session id do (npm .cmd shims need a shell on Windows).
  const child = spawn(bin, cli.args, { cwd: root, shell: /\.(?:cmd|bat)$/i.test(bin), windowsHide: true, env: process.env });
  run.child = child;
  child.stdin.on('error', () => { /* the agent exited before reading its prompt; its output says why */ });
  child.stdin.end(cli.prompt);
  streamCli(runId, run, child, agent === 'claude' ? claudeEvent : codexEvent, mode);
}
// Parses one JSON event per line from the agent's stdout.
function streamCli(runId, run, child, parse, mode) {
  const ctx = { done: false, lastError: '', stderr: '', lastText: '' };
  let buf = '';
  const line = text => {
    if (!text) return;
    try { parse(runId, JSON.parse(text), ctx, mode); } catch { ctx.stderr += text + '\n'; } // not JSON: keep it for the error message
  };
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) line(l.trim());
  });
  child.stderr.on('data', chunk => { ctx.stderr = (ctx.stderr + chunk.toString()).slice(-4000); });
  child.on('error', err => { ctx.lastError = err.message; });
  child.on('close', code => {
    runs.delete(runId);
    if (ctx.done) return;
    if (run.stopped) { emit(runId, { t: 'done', ok: false, stopped: true }); return; }
    emit(runId, { t: 'error', text: ctx.lastError || ctx.stderr.trim().split('\n').slice(-6).join('\n') || `The agent exited with code ${code}` });
    emit(runId, { t: 'done', ok: false });
  });
}

const TOOL_LABELS = {
  Read: ['read', 'Read'], Edit: ['edit', 'Edited'], MultiEdit: ['edit', 'Edited'], NotebookEdit: ['edit', 'Edited'], Write: ['edit', 'Wrote'],
};
function describeTool(name, input = {}) {
  const file = relOut(input.file_path || input.path || input.notebook_path);
  if (TOOL_LABELS[name]) return { kind: TOOL_LABELS[name][0], label: `${TOOL_LABELS[name][1]} ${file}` };
  switch (name) {
    case 'Bash': case 'PowerShell': return { kind: 'run', label: `$ ${input.command || ''}` };
    case 'Glob': case 'Grep': return { kind: 'search', label: `Searched for ${input.pattern || ''}` };
    case 'WebFetch': return { kind: 'web', label: `Fetched ${input.url || ''}` };
    case 'WebSearch': return { kind: 'web', label: `Searched the web for ${input.query || ''}` };
    case 'TodoWrite': return { kind: 'todo', label: 'Updated its to-do list' };
    case 'Task': case 'Agent': return { kind: 'agent', label: `Started a helper: ${input.description || ''}` };
    default: return { kind: 'tool', label: name };
  }
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
function claudeContent(runId, c, ctx) {
  if (c.type === 'text' && c.text.trim()) { ctx.lastText = c.text; emit(runId, { t: 'text', text: c.text }); return; }
  if (c.type !== 'tool_use') return;
  if (c.name === 'ExitPlanMode') { emit(runId, { t: 'plan', text: c.input?.plan || ctx.lastText }); return; }
  emit(runId, { t: 'tool', ...describeTool(c.name, c.input) });
  if (EDIT_TOOLS.has(c.name)) emit(runId, { t: 'file', path: relOut(c.input?.file_path || c.input?.notebook_path) });
}
function claudeResult(runId, d, ctx) {
  ctx.done = true;
  const ok = d.subtype === 'success' && !d.is_error;
  if (!ok) {
    const text = String(d.result || d.subtype || 'The agent stopped with an error');
    const hint = /log ?in/i.test(text) ? 'Run "claude" in the Terminal panel once and sign in with /login, then try again.' : undefined;
    emit(runId, { t: 'error', text, hint });
  }
  emit(runId, { t: 'done', ok, cost: d.total_cost_usd, ms: d.duration_ms });
}
function claudeEvent(runId, d, ctx) {
  if (d.type === 'system' && d.subtype === 'init') emit(runId, { t: 'session', id: d.session_id, model: d.model });
  else if (d.type === 'assistant') for (const c of d.message?.content || []) claudeContent(runId, c, ctx);
  else if (d.type === 'result') claudeResult(runId, d, ctx);
}

function codexError(msg) {
  try { const j = JSON.parse(msg); return j.error?.message || j.message || msg; } catch { return msg; } // plain text already
}
const CHANGE_VERB = { add: 'Created', delete: 'Deleted' };
const CODEX_ITEMS = {
  agent_message: (runId, it, ctx) => { if (it.text) { ctx.lastText = it.text; emit(runId, { t: 'text', text: it.text }); } },
  command_execution: (runId, it) => {
    const exit = it.exit_code ? `  (exit ${it.exit_code})` : '';
    emit(runId, { t: 'tool', kind: 'run', label: `$ ${it.command}${exit}` });
  },
  file_change: (runId, it) => {
    for (const ch of it.changes || []) {
      emit(runId, { t: 'tool', kind: 'edit', label: `${CHANGE_VERB[ch.kind] || 'Edited'} ${relOut(ch.path)}` });
      emit(runId, { t: 'file', path: relOut(ch.path) });
    }
  },
  mcp_tool_call: (runId, it) => emit(runId, { t: 'tool', kind: 'tool', label: `${it.server}: ${it.tool}` }),
  web_search: (runId, it) => emit(runId, { t: 'tool', kind: 'web', label: `Searched the web for ${it.query}` }),
  todo_list: runId => emit(runId, { t: 'tool', kind: 'todo', label: 'Updated its to-do list' }),
  error: (runId, it) => { if (it.message) emit(runId, { t: 'note', text: it.message }); },
};
function codexEvent(runId, d, ctx, mode) {
  if (d.type === 'thread.started') emit(runId, { t: 'session', id: d.thread_id });
  else if (d.type === 'item.completed' && d.item) CODEX_ITEMS[d.item.type]?.(runId, d.item, ctx);
  else if (d.type === 'error') ctx.lastError = codexError(d.message || '');
  else if (d.type === 'turn.failed') {
    ctx.done = true;
    emit(runId, { t: 'error', text: codexError(d.error?.message || ctx.lastError || 'The turn failed') });
    emit(runId, { t: 'done', ok: false });
  } else if (d.type === 'turn.completed') {
    ctx.done = true;
    if (mode === 'plan' && ctx.lastText) emit(runId, { t: 'plan', text: ctx.lastText });
    emit(runId, { t: 'done', ok: true, tokens: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0) });
  }
}

/* ----- Gemini agent loop (function calling over the project folder) ----- */
const geminiSessions = new Map(); // session id -> conversation contents
const GEMINI_TOOLS = [
  { name: 'list_files', description: 'List the files and folders in a project folder. Folders end with "/".', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder relative to the project root; "." for the root' } } } },
  { name: 'read_file', description: 'Read a text file from the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_files', description: 'Find lines containing some text across the project.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'write_file', description: 'Create or overwrite a file with its complete new contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
];

const GEMINI_TOOL_FNS = {
  async list_files(runId, a) {
    const entries = await fsp.readdir(resolveIn(a.path || '.'), { withFileTypes: true });
    emit(runId, { t: 'tool', kind: 'read', label: `Listed ${a.path && a.path !== '.' ? a.path : 'the project'}` });
    return entries.slice(0, 500).map(d => d.name + (d.isDirectory() ? '/' : '')).join('\n');
  },
  async read_file(runId, a) {
    const abs = resolveIn(a.path);
    const st = await fsp.stat(abs);
    emit(runId, { t: 'tool', kind: 'read', label: `Read ${relOut(abs)}` });
    if (st.size > 400 * 1024) return 'File is too large to read.';
    return fsp.readFile(abs, 'utf8');
  },
  async search_files(runId, a) {
    emit(runId, { t: 'tool', kind: 'search', label: `Searched for ${a.query}` });
    const hits = await searchProject(String(a.query || ''), false);
    return hits.slice(0, 100).map(h => `${h.path}:${h.line + 1}: ${h.text}`).join('\n') || 'No matches.';
  },
  async write_file(runId, a) {
    const abs = resolveIn(a.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, String(a.content ?? ''), 'utf8');
    emit(runId, { t: 'tool', kind: 'edit', label: `Wrote ${relOut(abs)}` });
    emit(runId, { t: 'file', path: relOut(abs) });
    return 'Saved.';
  },
};
async function geminiTool(runId, name, args = {}) {
  const fn = GEMINI_TOOL_FNS[name];
  if (!fn) throw new Error(`Unknown tool ${name}`);
  return fn(runId, args);
}
// Runs the reply's tool calls one after another (a later call may read what an earlier one wrote).
function runToolCalls(runId, parts) {
  const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);
  return calls.reduce(async (prev, call) => {
    const replies = await prev;
    let result;
    try { result = await geminiTool(runId, call.name, call.args); } catch (err) { result = `Error: ${err.message}`; }
    return [...replies, { functionResponse: { name: call.name, response: { result } } }];
  }, Promise.resolve([]));
}
function geminiSystem(mode) {
  const build = mode === 'build';
  return [
    `You are Breeze, a coding agent working inside the user's project folder "${path.basename(root)}".`,
    'Use the tools to look at the project before answering. Keep replies short and friendly.',
    build ? 'You may change files with write_file; always write the complete file.' : 'Do not change any files.',
    mode === 'plan' ? 'Reply with a short numbered plan of the changes you would make.' : '',
  ].join(' ');
}
async function geminiRequest(model, key, body, signal) {
  const r = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Gemini answered with status ${r.status}`);
  return j;
}
async function runGemini(runId, run, { mode, prompt, session }) {
  const key = getSecret('geminiKey');
  if (!key) throw new Error('Add a Gemini API key first (Settings → Run Setup Again).');
  const model = loadState().geminiModel || 'gemini-2.5-flash';
  const sid = session && geminiSessions.has(session) ? session : crypto.randomUUID();
  const contents = geminiSessions.get(sid) || [];
  geminiSessions.set(sid, contents);
  emit(runId, { t: 'session', id: sid, model });
  contents.push({ role: 'user', parts: [{ text: prompt }] });
  const body = {
    contents,
    tools: [{ functionDeclarations: GEMINI_TOOLS.filter(t => mode === 'build' || t.name !== 'write_file') }],
    systemInstruction: { parts: [{ text: geminiSystem(mode) }] },
  };
  run.abort = new AbortController();
  const started = Date.now();
  let tokens = 0, lastText = '';
  // One model turn; it continues while the model keeps calling tools (up to 30 turns).
  const turn = async n => {
    if (n >= 30 || run.stopped) return;
    let j;
    try {
      j = await geminiRequest(model, key, body, run.abort.signal);
    } catch (err) {
      if (run.stopped) return; // stopping aborts the request
      throw err;
    }
    tokens += j.usageMetadata?.totalTokenCount || 0;
    const content = j.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new Error(`Gemini returned no answer (${j.candidates?.[0]?.finishReason || 'empty response'})`);
    contents.push(content);
    for (const part of content.parts) if (part.text && !part.thought) { lastText = part.text; emit(runId, { t: 'text', text: part.text }); }
    const replies = await runToolCalls(runId, content.parts);
    if (!replies.length) return;
    contents.push({ role: 'user', parts: replies });
    await turn(n + 1);
  };
  await turn(0);
  runs.delete(runId);
  if (run.stopped) { emit(runId, { t: 'done', ok: false, stopped: true }); return; }
  if (mode === 'plan' && lastText) emit(runId, { t: 'plan', text: lastText });
  emit(runId, { t: 'done', ok: true, ms: Date.now() - started, tokens });
}

/* ================= Git ================= */
// Git runs from its full path: the usual install folders first, then wherever PATH finds it.
let gitPath = null;
async function gitBin() {
  if (gitPath) return gitPath;
  const known = isWin
    ? [path.join(process.env.ProgramFiles || String.raw`C:\Program Files`, 'Git', 'cmd', 'git.exe'), path.join(LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  gitPath = known.find(p => fs.existsSync(p)) || await which('git');
  if (!gitPath) throw new Error('Git is not installed. Get it from https://git-scm.com/downloads');
  return gitPath;
}
async function git(args, { input, timeout = 60000 } = {}) {
  const bin = await gitBin();
  return new Promise((res, rej) => {
    const child = execFile(bin, args, {
      cwd: resolveIn(''), windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout)));
    if (input != null) child.stdin.end(input);
  });
}
const checkPaths = paths => (Array.isArray(paths) ? paths : [paths]).map(p => { resolveIn(p); return p; });
const HASH = /^[0-9a-f]{4,40}$/i;

// "## main...origin/main [ahead 1, behind 2]" → branch, upstream, ahead and behind.
function parseBranchHeader(head) {
  if (head.startsWith('No commits yet on ')) return { hasCommits: false, branch: head.slice(18) };
  let rest = head, track = '';
  const bracket = rest.lastIndexOf(' [');
  if (bracket !== -1 && rest.endsWith(']')) {
    track = rest.slice(bracket + 2, -1);
    rest = rest.slice(0, bracket);
  }
  const [branch, upstream = ''] = rest.split('...');
  const count = word => Number(new RegExp(String.raw`${word} (\d+)`).exec(track)?.[1] || 0);
  return { branch: branch === 'HEAD (no branch)' ? 'detached' : branch, upstream, ahead: count('ahead'), behind: count('behind') };
}
ipcMain.handle('git:status', async () => {
  if (!root) return { repo: false };
  let top;
  try { top = (await git(['rev-parse', '--show-toplevel'])).trim(); } catch { return { repo: false }; } // not a repository
  const [out, remotes] = await Promise.all([
    git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']),
    git(['remote']).catch(() => ''),
  ]);
  const res = { repo: true, branch: '', upstream: '', ahead: 0, behind: 0, hasCommits: true, hasRemote: !!remotes.trim(), files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.startsWith('## ')) Object.assign(res, parseBranchHeader(e.slice(3)));
    else if (e) {
      const x = e[0], y = e[1];
      const rel = path.relative(root, path.join(top, e.slice(3)));
      if (x === 'R' || x === 'C') i++; // the next entry is the original path
      if (!rel.startsWith('..')) res.files.push({ path: rel.split(path.sep).join('/'), x, y }); // skip files outside the open folder
    }
  }
  return res;
});

ipcMain.handle('git:log', async () => {
  let out;
  try { out = await git(['log', '--all', '--topo-order', '-n', '150', '-z', '--pretty=format:%H%x1f%P%x1f%an%x1f%ar%x1f%D%x1f%s']); }
  catch { return { head: null, commits: [] }; } // no commits yet
  const head = (await git(['rev-parse', 'HEAD']).catch(() => '')).trim();
  const commits = out.split('\0').filter(Boolean).map(rec => {
    const [hash, parents, author, when, refs, subject] = rec.split('\x1f');
    return { hash, parents: parents ? parents.split(' ') : [], author, when, refs: refs ? refs.split(', ') : [], subject };
  });
  return { head, commits };
});

ipcMain.handle('git:show', async (_e, hash) => {
  if (!HASH.test(hash)) throw new Error('Bad commit id');
  const out = await git(['show', '--numstat', '--format=%H%x1f%an%x1f%ae%x1f%ar%x1f%B%x1e', hash]);
  const [header, stats = ''] = out.split('\x1e');
  const [full, author, email, when, body] = header.split('\x1f');
  const files = stats.trim().split('\n').filter(Boolean).map(l => {
    const [a, d, ...p] = l.split('\t');
    return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), removed: d === '-' ? 0 : Number(d) };
  });
  return { hash: full, author, email, when, message: (body || '').trim(), files };
});

ipcMain.handle('git:diff', (_e, rel, staged) => git(['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', ...checkPaths(rel)]));
ipcMain.handle('git:init', () => git(['init']));
ipcMain.handle('git:stage', (_e, paths) => git(['add', '-A', '--', ...checkPaths(paths)]));
ipcMain.handle('git:unstage', (_e, paths, hasCommits) => {
  const p = checkPaths(paths);
  return hasCommits ? git(['restore', '--staged', '--', ...p]) : git(['rm', '--cached', '-r', '-q', '--', ...p]);
});
// Discarding untracked files moves them to the Recycle Bin rather than deleting them.
ipcMain.handle('git:discard', async (_e, files) => {
  const tracked = files.filter(f => !f.untracked).map(f => f.path);
  const untracked = files.filter(f => f.untracked).map(f => f.path);
  checkPaths([...tracked, ...untracked]);
  await Promise.all(untracked.map(p => shell.trashItem(resolveIn(p))));
  if (tracked.length) await git(['restore', '--worktree', '--', ...tracked]);
});
ipcMain.handle('git:commit', async (_e, message, all) => {
  if (!String(message || '').trim()) throw new Error('Write a message for this checkpoint first');
  if (all) await git(['add', '-A']);
  await git(['commit', '-F', '-'], { input: message });
  return (await git(['rev-parse', '--short', 'HEAD'])).trim();
});
ipcMain.handle('git:branches', async () => {
  const out = await git(['branch', '--format=%(refname:short)']).catch(() => '');
  return out.split('\n').map(s => s.trim()).filter(Boolean);
});
ipcMain.handle('git:switch', async (_e, name, create, from) => {
  await git(['check-ref-format', '--branch', name]);
  if (from && !HASH.test(from)) throw new Error('Bad commit id');
  return git(create ? ['switch', '-c', name, ...(from ? [from] : [])] : ['switch', name]);
});
ipcMain.handle('git:sync', async (_e, op) => {
  const opts = { timeout: 120000 };
  if (op === 'fetch') return git(['fetch', '--all', '--prune'], opts);
  if (op === 'pull') return git(['pull', '--ff-only'], opts);
  if (op === 'push') {
    const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '');
    return git(upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], opts);
  }
  throw new Error('Unknown sync operation');
});

/* ================= Sign in with GitHub / Google ================= */
// Client ids come from breeze.config.json next to this file, or from environment variables.
// A .env next to this file fills in environment variables; ones already set in the shell win.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env */ }
function authConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'breeze.config.json'), 'utf8')); } catch { /* not configured */ }
  return {
    github: { clientId: process.env.BREEZE_GITHUB_CLIENT_ID || file.github?.clientId || '' },
    google: {
      clientId: process.env.BREEZE_GOOGLE_CLIENT_ID || file.google?.clientId || '',
      clientSecret: process.env.BREEZE_GOOGLE_CLIENT_SECRET || file.google?.clientSecret || '',
    },
  };
}
let authAbort = null;
const authEmit = ev => win?.webContents.send('auth:event', ev);
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('cancelled')); }, { once: true });
});

ipcMain.handle('auth:user', () => loadState().user || null);
ipcMain.handle('auth:signOut', () => {
  saveState({ user: null });
  setSecret('githubToken', null);
  setSecret('googleToken', null);
});
ipcMain.handle('auth:cancel', () => { authAbort?.abort(); authAbort = null; });
ipcMain.handle('auth:start', (_e, provider) => {
  const cfg = authConfig();
  if (provider === 'GitHub' && !cfg.github.clientId) return { error: 'not-configured' };
  if (provider === 'Google' && !cfg.google.clientId) return { error: 'not-configured' };
  authAbort?.abort();
  const ac = new AbortController();
  authAbort = ac;
  (provider === 'GitHub' ? githubSignIn(cfg.github, ac.signal) : googleSignIn(cfg.google, ac.signal))
    .then(user => { saveState({ user }); authEmit({ t: 'done', user }); })
    .catch(err => { if (!ac.signal.aborted) authEmit({ t: 'error', text: err.message }); })
    .finally(() => { if (authAbort === ac) authAbort = null; });
  return { started: true };
});

// GitHub device flow: the user types a short code on github.com; no client secret needed.
async function githubSignIn({ clientId }, signal) {
  const post = async (url, body) => (await fetch(url, {
    method: 'POST', signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  const dc = await post('https://github.com/login/device/code', { client_id: clientId, scope: 'read:user user:email' });
  if (dc.error) throw new Error(dc.error_description || dc.error);
  authEmit({ t: 'code', provider: 'GitHub', code: dc.user_code, uri: dc.verification_uri });
  openInBrowser(dc.verification_uri);
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  // Ask GitHub every few seconds until the user has entered the code.
  const poll = async interval => {
    if (Date.now() > deadline) throw new Error('The code expired. Try again.');
    await sleep(interval, signal);
    const t = await post('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: dc.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (t.access_token) return t.access_token;
    if (t.error === 'slow_down') return poll(interval + 5000);
    if (t.error === 'authorization_pending') return poll(interval);
    throw new Error(t.error_description || t.error);
  };
  const token = await poll((dc.interval || 5) * 1000);
  setSecret('githubToken', token);
  const u = await (await fetch('https://api.github.com/user', {
    signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Breeze-IDE' },
  })).json();
  return { provider: 'GitHub', name: u.name || u.login, login: u.login, email: u.email || null, avatar: u.avatar_url || null };
}

// Google: authorization code + PKCE through a one-shot loopback server on 127.0.0.1.
function googleRedirectPage(ok) {
  const title = ok ? 'You are signed in to Breeze' : 'Sign-in did not finish';
  return `<!doctype html><title>Breeze</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#f5f5f7;font-family:system-ui"><div style="text-align:center"><h2>${title}</h2><p style="color:#a1a1aa">You can close this tab and go back to Breeze.</p></div>`;
}
function waitForGoogleCode({ clientId, challenge, state }, signal) {
  return new Promise((res, rej) => {
    let redirect = '';
    const server = http.createServer((req, resp) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { resp.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(googleRedirectPage(ok));
      server.close();
      if (ok) res({ code: u.searchParams.get('code'), redirect });
      else rej(new Error(u.searchParams.get('error') || 'Sign-in did not finish'));
    });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile',
        code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
      }).toString();
      openInBrowser(auth.href);
      authEmit({ t: 'waiting', provider: 'Google' });
    });
    signal.addEventListener('abort', () => { server.close(); rej(new Error('cancelled')); }, { once: true });
  });
}
async function googleSignIn({ clientId, clientSecret }, signal) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const { code, redirect } = await waitForGoogleCode({ clientId, challenge, state }, signal);
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}),
      code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code',
    }),
  });
  const tok = await tr.json();
  if (!tr.ok) throw new Error(tok.error_description || tok.error || 'Google did not accept the sign-in');
  if (tok.refresh_token) setSecret('googleToken', tok.refresh_token);
  const u = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { signal, headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
  return { provider: 'Google', name: u.name || u.email, login: u.email, email: u.email || null, avatar: u.picture || null };
}

/* ================= Vibe Mode: social feeds ================= */
// Feeds live in their own browser session (persist:vibe), apart from the app. Signing in happens on the
// site itself in a Breeze window; Breeze only checks whether a sign-in cookie exists.
const VIBE_PARTITION = 'persist:vibe';
const VIBE_SITES = {
  youtube: { name: 'YouTube Shorts', url: 'https://www.youtube.com/shorts', cookie: ['youtube.com', 'LOGIN_INFO'], domains: ['youtube.com', 'google.com'] },
  tiktok: { name: 'TikTok', url: 'https://www.tiktok.com/foryou', cookie: ['tiktok.com', 'sessionid'], domains: ['tiktok.com'] },
  instagram: { name: 'Instagram Reels', url: 'https://www.instagram.com/reels/', cookie: ['instagram.com', 'sessionid'], domains: ['instagram.com'] },
  facebook: { name: 'Facebook Reels', url: 'https://www.facebook.com/reel/', cookie: ['facebook.com', 'c_user'], domains: ['facebook.com'] },
  x: { name: 'X', url: 'https://x.com/home', cookie: ['x.com', 'auth_token'], domains: ['x.com', 'twitter.com'] },
};
let vibeView = null;
let vibeSessionReady = false;
function vibeSite(id) {
  const site = Object.hasOwn(VIBE_SITES, id) ? VIBE_SITES[id] : null;
  if (!site) throw new Error('Unknown feed');
  return site;
}
// Some sites refuse sign-in from embedded browsers, so the feed session presents a plain Chrome user agent.
function vibeSession() {
  const ses = session.fromPartition(VIBE_PARTITION);
  if (!vibeSessionReady) {
    const ua = ses.getUserAgent().split(' ').filter(t => !t.startsWith('Electron/') && !t.startsWith(`${app.getName()}/`)).join(' ');
    ses.setUserAgent(ua);
    // Fullscreen video is fine; cameras, microphones, location and notifications are not.
    ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen'));
    vibeSessionReady = true;
  }
  return ses;
}
const feedPrefs = () => ({ session: vibeSession(), sandbox: true, contextIsolation: true, nodeIntegration: false });
// Feed pages may only load https; links that open new windows load in place.
function guardFeed(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) wc.loadURL(url).catch(logError('feed popup'));
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('https://')) e.preventDefault(); });
}
async function signedIn(id) {
  const [domain, name] = vibeSite(id).cookie;
  const cookies = await vibeSession().cookies.get({ domain, name });
  return cookies.length > 0;
}

ipcMain.handle('vibe:status', async () => {
  const ids = Object.keys(VIBE_SITES);
  const states = await Promise.all(ids.map(signedIn));
  return Object.fromEntries(ids.map((id, i) => [id, states[i]]));
});
// Opens the site in a Breeze window; resolves with the sign-in state once the user closes it.
ipcMain.handle('vibe:connect', (_e, id) => {
  const site = vibeSite(id);
  return new Promise(resolve => {
    const w = new BrowserWindow({ parent: win, width: 460, height: 820, title: `Connect ${site.name} — Breeze`, icon: APP_ICON, autoHideMenuBar: true, backgroundColor: '#000000', webPreferences: feedPrefs() });
    guardFeed(w.webContents);
    w.loadURL(site.url).catch(logError('connect'));
    w.on('closed', () => { signedIn(id).then(resolve, () => resolve(false)); });
  });
});
// Forgets the site's sign-in by removing its cookies from the feed session.
ipcMain.handle('vibe:disconnect', async (_e, id) => {
  const ses = vibeSession();
  const lists = await Promise.all(vibeSite(id).domains.map(domain => ses.cookies.get({ domain })));
  await Promise.all(lists.flat().map(c => ses.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path}`, c.name)));
});
const toBounds = b => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });
// Lays the live feed over the renderer's 9:16 frame.
ipcMain.handle('vibe:show', (_e, id, bounds) => {
  const site = vibeSite(id);
  if (!win) return;
  if (!vibeView) {
    vibeView = new WebContentsView({ webPreferences: feedPrefs() });
    vibeView.setBorderRadius(16);
    vibeView.setBackgroundColor('#000000');
    guardFeed(vibeView.webContents);
    win.contentView.addChildView(vibeView);
  }
  vibeView.setBounds(toBounds(bounds));
  vibeView.webContents.loadURL(site.url).catch(logError('feed'));
});
ipcMain.handle('vibe:bounds', (_e, bounds) => vibeView?.setBounds(toBounds(bounds)));
ipcMain.handle('vibe:mute', (_e, muted) => vibeView?.webContents.setAudioMuted(!!muted));
// Closing the view also stops its video and sound.
ipcMain.handle('vibe:hide', () => {
  if (!vibeView) return;
  win?.contentView.removeChildView(vibeView);
  vibeView.webContents.close();
  vibeView = null;
});
