// Electron main process for Breeze IDE: window, file system, search, terminal, git, agents, sign-in and Vibe Mode.
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, net, protocol, safeStorage, session, shell } = require('electron');
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
const { findTools, freshPath, toolEnv, runPlan, runSteps, ensureBuildIgnored, mergePath, installHint, installUrl, unpacked } = require('./toolchains');
const { isFileUrl, resolveUnder, blockedRel, agentBlocked, safeGitArgs, shellCommand } = require('./guard');

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
// The one page the window may show. Anything else (a file dropped onto the window, a link) would run with the
// preload bridge, which can run commands, so the window never navigates away from it.
const APP_PAGE = path.join(__dirname, 'breeze.html');

// Only Breeze's own page may use the main process: not another page in the window, not a frame inside it.
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    const frame = e.senderFrame;
    if (!frame || frame.parent || !isFileUrl(frame.url, APP_PAGE)) throw new Error('Breeze only answers its own window');
    return fn(e, ...args);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Breeze Code',
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

  win.loadFile(APP_PAGE).catch(logError('loadFile'));

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isFileUrl(url, APP_PAGE)) e.preventDefault();
  });
  // A reload or crash drops the renderer's terminal state, so nothing may keep running for it.
  win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) killAllTerms(); });
  win.webContents.on('render-process-gone', killAllTerms);
  win.on('closed', () => { win = null; vibeView = null; stopWatching(); killAllTerms(); });
}

// The preview iframe is sandboxed (an opaque origin), and Chromium won't let an opaque origin load file://
// stylesheets, scripts or images. So the preview is served from breeze-preview://project/<path> instead.
const PREVIEW_SCHEME = 'breeze-preview';
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
async function servePreview(req) {
  try {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    let abs = resolveIn(rel);
    if ((await fsp.stat(abs)).isDirectory()) abs = resolveIn(path.join(rel, 'index.html')); // it may be a link too
    const res = await net.fetch(pathToFileURL(abs).href);
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' } });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
}

app.whenReady().then(() => {
  protocol.handle(PREVIEW_SCHEME, servePreview);
  // The menu bar is drawn in HTML; the native one would only duplicate it.
  Menu.setApplicationMenu(null);
  if (process.platform === 'darwin') app.dock?.setIcon(APP_ICON);
  // Windows only shows notifications (Vibe Mode's "your code is ready") for an app with a user model id.
  if (isWin) app.setAppUserModelId(app.isPackaged ? 'com.breeze.ide' : process.execPath);
  createWindow();
  getTools().catch(logError('toolchains'));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(logError('startup'));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ================= Paths ================= */
// resolveUnder (guard.js) refuses anything that leaves the folder, by `..` or through a link.
function resolveIn(rel = '') {
  if (!root) throw new Error('No folder is open');
  return resolveUnder(root, rel);
}
const relTo = (base, abs) => path.relative(base, abs).split(path.sep).join('/');
const toRel = abs => relTo(root, abs);
// Breeze Box chats work here when no project folder is open.
function boxDir() {
  const dir = path.join(app.getPath('documents'), 'Breeze Box');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

handle('fs:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return setRoot(r.filePaths[0]);
});

// Asks where to create a new project folder (its name is typed in the dialog), creates it and opens it.
handle('fs:createFolder', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Create a new project', buttonLabel: 'Create',
    defaultPath: path.join(app.getPath('documents'), 'my-breeze-project'),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (r.canceled || !r.filePath) return null;
  if (fs.existsSync(r.filePath)) {
    const inside = await fsp.readdir(r.filePath).catch(() => ['(a file)']);
    if (inside.length) throw new Error(`${path.basename(r.filePath)} already exists and isn't empty — pick another name`);
  }
  await fsp.mkdir(r.filePath, { recursive: true });
  return setRoot(r.filePath);
});

handle('fs:restore', async () => {
  const { lastRoot } = loadState();
  if (!lastRoot) return null;
  try { return await setRoot(lastRoot); } catch { saveState({ lastRoot: null }); return null; }
});

handle('fs:closeFolder', () => {
  root = null; stopWatching(); saveState({ lastRoot: null });
});

handle('fs:recent', () => (loadState().recent || []).map(p => ({ path: p, name: path.basename(p) })));

handle('fs:openRecent', async (_e, dir) => {
  if (!(loadState().recent || []).includes(dir)) throw new Error('Unknown folder');
  return setRoot(dir);
});

handle('fs:readDir', async (_e, rel) => {
  const entries = await fsp.readdir(resolveIn(rel), { withFileTypes: true });
  return entries.map(d => ({ name: d.name, dir: d.isDirectory() })).sort(byDirThenName);
});

handle('fs:readFile', async (_e, rel) => {
  const abs = resolveIn(rel);
  const st = await fsp.stat(abs);
  // Images are shown from their file URL, so only their size is needed here.
  if (IMAGE_FILE.test(abs)) return { image: true, size: st.size };
  if (st.size > MAX_FILE_BYTES) return { tooLarge: true, size: st.size };
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size };
});

handle('fs:writeFile', async (_e, rel, text) => {
  await fsp.writeFile(resolveIn(rel), text, 'utf8');
});

handle('fs:createFile', async (_e, rel) => {
  const abs = resolveIn(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, '', { flag: 'wx' });
});

handle('fs:createDir', async (_e, rel) => {
  await fsp.mkdir(resolveIn(rel), { recursive: false });
});

handle('fs:rename', async (_e, from, to) => {
  const dest = resolveIn(to);
  if (fs.existsSync(dest)) throw new Error('Something with that name already exists');
  await fsp.rename(resolveIn(from), dest);
});

// Deleting moves to the Recycle Bin / Trash so it can be undone.
handle('fs:trash', async (_e, rel) => {
  if (!rel) throw new Error('Refusing to delete the project folder');
  await shell.trashItem(resolveIn(rel));
});

handle('fs:fileUrl', (_e, rel) => pathToFileURL(resolveIn(rel)).href);
handle('fs:previewUrl', (_e, rel) => {
  resolveIn(rel); // throws when no folder is open or the path leaves the project
  return `${PREVIEW_SCHEME}://project/${String(rel).split(/[\/]/).map(encodeURIComponent).join('/')}`;
});

// Every file under `dir`, skipping build output and dependencies. Folders are read in parallel.
async function listFiles(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } // unreadable folder: skip it
  const files = entries.filter(d => d.isFile()).map(d => path.join(dir, d.name));
  const subdirs = entries.filter(d => d.isDirectory() && !IGNORED_DIRS.has(d.name)).map(d => path.join(dir, d.name));
  const nested = await Promise.all(subdirs.map(listFiles));
  return files.concat(...nested).slice(0, MAX_LISTED_FILES);
}

const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
// A dropped file arrives as bytes, so Breeze never reads a path the page names. Never overwrites: a taken name gets " (1)".
handle('fs:import', async (_e, dirRel, name, data) => {
  if (!(data instanceof Uint8Array)) throw new Error('Nothing to save');
  if (data.byteLength > IMPORT_MAX_BYTES) throw new Error(`${path.basename(String(name))} is larger than 50 MB`);
  const target = resolveIn(path.join(String(dirRel || ''), String(name)));
  if (path.relative(root, target).split(path.sep).some(p => /^(?:\.git|git~1)[. ]*$/i.test(p))) throw new Error('Files can’t be dropped into the .git folder');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const { dir, name: stem, ext } = path.parse(target);
  for (let n = 0; ; n++) {
    const candidate = n ? path.join(dir, `${stem} (${n})${ext}`) : target;
    try { await fsp.writeFile(candidate, data, { flag: 'wx' }); return toRel(candidate); }
    catch (err) { if (err.code !== 'EEXIST' || n > 999) throw err; }
  }
});




handle('fs:listFiles', async () => (await listFiles(resolveIn(''))).map(toRel));

handle('fs:search', (_e, query, matchCase) => searchProject(query, matchCase));

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
// Reads files a batch at a time and stops once there are enough results. `skip(rel)` leaves files out.
async function searchProject(query, matchCase, base = resolveIn(''), skip = () => false) {
  if (!query) return [];
  const files = (await listFiles(base)).filter(f => !skip(relTo(base, f)));
  const needle = matchCase ? query : query.toLowerCase();
  const results = [];
  const batch = async start => {
    if (start >= files.length || results.length >= MAX_SEARCH_RESULTS) return;
    const texts = await Promise.all(files.slice(start, start + 32).map(readSearchable));
    texts.forEach((text, k) => { if (text != null) searchText(text, relTo(base, files[start + k]), needle, matchCase, results); });
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
handle('lint:check', (_e, code, ext) => (typeof code === 'string' && code.length <= 400000 ? syntaxCheck(code, String(ext)) : null));

/* ================= Terminal ================= */
let nextTermId = 1;
handle('term:cwd', () => termCwd);

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
handle('term:run', async (_e, command) => {
  const cd = changeDir(command);
  if (cd) return cd;
  const { tools, pathValue } = await getTools();
  const id = nextTermId++;
  const child = spawn(command, { shell: true, cwd: termCwd, env: toolEnv(process.env, [...tools.binDirs, ...agentDirs()], process.platform, pathValue), windowsHide: true });
  terms.set(id, child);
  child.stdin.on('error', ignoreEpipe);
  // Decoded as a stream, so a character split across two chunks stays whole.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const send = chunk => win?.webContents.send('term:data', id, chunk);
  child.stdout.on('data', send);
  child.stderr.on('data', send);
  child.on('error', err => send(`${err.message}\n`));
  child.on('close', code => { terms.delete(id); win?.webContents.send('term:exit', id, code); });
  return { id };
});
handle('term:write', (_e, id, text) => {
  const stdin = terms.get(id)?.stdin;
  if (stdin?.writable) stdin.write(String(text));
});

// Compilers and Python found on this PC (memoised; `force` looks again, e.g. after the user installs one).
const ignoreEpipe = () => { /* the program exited before reading its input */ };
const probe = (file, args) => new Promise(res => {
  execFile(file, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => res({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout || '') }));
});
// lstat, not existsSync: Store app-execution aliases (WindowsApps\python.exe) fail existsSync
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
// Expands one `*` in the last path segment that has one.
function glob(pattern) {
  const parts = pattern.split(/[\\/]/);
  const i = parts.findIndex(p => p.includes('*'));
  if (i === -1) return [pattern];
  const parent = parts.slice(0, i).join(path.sep);
  const re = new RegExp('^' + parts[i].split('*').map(x => x.replaceAll(/\W/g, String.raw`\$&`)).join('.*') + '$', 'i');
  try {
    return fs.readdirSync(parent).filter(n => re.test(n)).map(n => [parent, n, ...parts.slice(i + 1)].join(path.sep));
  } catch { return []; }
}
let toolsPromise = null;
function getTools(force = false) {
  if (!toolsPromise || force) {
    const p = toolsPromise = (async () => {
      const inheritedKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path');
      const pathValue = mergePath(await freshPath(process.platform, probe), inheritedKey ? process.env[inheritedKey] : '', process.platform);
      const tools = await findTools({ platform: process.platform, pathValue, env: process.env, exists, glob, run: probe });
      return { tools, pathValue };
    })();
    p.catch(() => { if (toolsPromise === p) toolsPromise = null; }); // don't keep a failed lookup
  }
  return toolsPromise;
}

// Runs a .c, .cpp, .cs or .py file in the open folder, streaming into the terminal under one id.
let activeRun = null; // { id, cancel }
const SOURCE_FILE = /\.(?:c|cc|cpp|cxx|cs|py)$/i;
// The nearest .csproj in the .cs file's folder or a folder above it, without leaving the open project.
function nearestCsproj(abs) {
  if (!/\.cs$/i.test(abs)) return null;
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /\.csproj$/i.test(n)).sort(); } catch { /* unreadable: keep looking up */ }
    if (names.length) return path.join(dir, names[0]);
    if (path.relative(root, dir) === '' || dir === path.dirname(dir)) return null;
  }
}
handle('run:file', async (_e, rel) => {
  if (activeRun) return { error: 'A program is still running — press Ctrl+C to stop it' };
  if (!root) return { error: 'Open a folder first' };
  const claim = activeRun = { id: 0, cancel() { /* still starting */ } };
  const fail = error => { if (activeRun === claim) activeRun = null; return { error }; };
  try {
    const abs = resolveIn(rel);
    // gcc can't read inside the packaged app's asar archive; the header is unpacked next to it.
    const stdioHeader = unpacked(path.join(__dirname, 'runtime', 'breeze_stdio.h'));
    let { tools, pathValue } = await getTools();
    const opts = { csproj: nearestCsproj(abs) };
    let plan = runPlan(abs, tools, process.platform, stdioHeader, opts);
    if (plan.error && SOURCE_FILE.test(abs)) {
      ({ tools, pathValue } = await getTools(true));
      plan = runPlan(abs, tools, process.platform, stdioHeader, opts);
    }
    if (plan.error) return fail(plan.error);
    if (plan.steps.length > 1) fs.mkdirSync(path.join(plan.steps[0].cwd, 'build'), { recursive: true }); // gcc won't create it
    if (plan.steps.length > 1) { try { ensureBuildIgnored(root); } catch { /* .gitignore is a nicety */ } }
    if (activeRun !== claim) return { error: 'Cancelled' }; // the window reloaded while this was starting
    const id = claim.id = nextTermId++;
    const send = text => win?.webContents.send('term:data', id, text);
    // Start after the reply is sent, so the renderer knows the id before the first output arrives.
    setImmediate(() => {
      if (activeRun !== claim) return; // cancelled (window reloaded) before it started
      try {
        const { cancel } = runSteps(plan.steps, {
          spawn,
          env: toolEnv(process.env, tools.binDirs, process.platform, pathValue),
          onStart: step => send(`${step.cwd}> ${step.display}\n`),
          onData: send,
          onChild: child => { terms.set(id, child); child.stdin.on('error', ignoreEpipe); },
          onDone: (code, ms) => {
            terms.delete(id);
            if (activeRun === claim) activeRun = null;
            send(`${code === null ? 'stopped' : `exited with code ${code}`} · ${(ms / 1000).toFixed(1)}s\n`);
            win?.webContents.send('term:exit', id, code);
          },
        });
        claim.cancel = cancel;
      } catch (err) {
        if (activeRun === claim) activeRun = null;
        send(err.message + '\n');
        win?.webContents.send('term:exit', id, 1);
      }
    });
    return { id };
  } catch (err) {
    return fail(err.message);
  }
});

const TASKKILL = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'taskkill.exe');
function killTree(child) {
  if (process.platform === 'win32') execFile(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone */ });
  else child.kill('SIGTERM');
}
handle('term:kill', (_e, id) => {
  const c = terms.get(id);
  if (c) killTree(c); // the whole tree first, then stop the run from starting its next step
  if (activeRun?.id === id) activeRun.cancel();
});
// Completes the last word of a terminal line to a file or folder in the terminal's folder.
handle('term:complete', async (_e, word) => {
  const w = unquote(String(word || ''));
  const cut = Math.max(w.lastIndexOf('/'), w.lastIndexOf('\\')) + 1;
  const dirPart = w.slice(0, cut), start = w.slice(cut).toLowerCase();
  let entries;
  try { entries = await fsp.readdir(path.resolve(termCwd, dirPart || '.'), { withFileTypes: true }); } catch { return []; } // no such folder
  return entries
    .filter(d => d.name.toLowerCase().startsWith(start))
    .map(d => ({ name: d.name, dir: d.isDirectory() }))
    .sort(byDirThenName)
    .slice(0, 60)
    .map(d => ({ text: dirPart + d.name + (d.dir ? '/' : ''), dir: d.dir }));
});
function killAllTerms() {
  for (const c of terms.values()) killTree(c);
  terms.clear();
  if (activeRun) { activeRun.cancel(); activeRun = null; }
}

/* ================= Tool & agent detection ================= */
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const isWin = process.platform === 'win32';

const AGENTS = [
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', commands: ['codex'],
    url: 'https://developers.openai.com/codex/cli',
    paths: () => isWin ? [path.join(APPDATA, 'npm', 'codex.cmd')] : ['/usr/local/bin/codex', '/opt/homebrew/bin/codex'],
  },
];
const agentBins = new Map(); // agent id -> executable found by the last scan
// Folders of the agents found off PATH, so the Terminal panel can run them by name.
const agentDirs = () => [...new Set([...agentBins.values()].filter(b => !b.endsWith('.app')).map(b => path.dirname(b)))];

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
  if (bin.endsWith('.app') || (isWin && /\.exe$/i.test(bin) && !/(?:codex|git|node)\.exe$/i.test(bin))) return Promise.resolve(null);
  return new Promise(res => {
    exec(`"${bin}" --version`, { windowsHide: true, timeout: 8000 }, (err, stdout) => res(err ? null : versionIn(stdout)));
  });
}

async function locate(commands, paths) {
  const found = await Promise.all(commands.map(which));
  return found.find(Boolean) || paths.find(p => p && fs.existsSync(p)) || null;
}

handle('sys:detect', async () => {
  const agents = await Promise.all(AGENTS.map(async a => {
    const bin = await locate(a.commands, a.paths());
    if (bin) agentBins.set(a.id, bin); else agentBins.delete(a.id);
    return { id: a.id, name: a.name, vendor: a.vendor, url: a.url, found: !!bin, path: bin, version: bin ? await versionOf(bin) : null };
  }));
  // A local LLM server (Ollama, LM Studio…) speaks the OpenAI API instead of being a CLI.
  let llm = await llmConfig(true).catch(() => null);
  // A saved server may have been closed since: it only counts as found while it answers and still has the model.
  if (llm) llm = await llmReachable(llm).then(() => llm, () => null);
  agents.push({ id: 'local', name: 'Local LLM', vendor: 'Ollama, LM Studio or any OpenAI-compatible server', url: 'https://ollama.com/download', api: true, found: !!llm, path: llm?.url ?? null, version: llm?.model ?? null, models: llm?.models ?? [] });
  // u.bot is a built-in mock agent: it needs nothing installed and only plays back a canned reply.
  agents.push({ id: 'ubot', name: 'u.bot', vendor: 'Mock agent', url: '', mock: true, found: true, path: null, version: null });
  const tools = await Promise.all([['git', 'Git'], ['node', 'Node.js']].map(async ([cmd, name]) => {
    const bin = await which(cmd);
    return { id: cmd, name, found: !!bin, version: bin ? await versionOf(bin) : null };
  }));
  const found = (await getTools(true)).tools;
  for (const [id, name, t, kind] of [['cc', 'C/C++', found.cc, 'c'], ['python', 'Python', found.python, 'py'], ['dotnet', 'C#', found.dotnet, 'cs']]) {
    tools.push({ id, name, found: !!t, version: t ? versionIn(t.version) : null, optional: true, hint: t ? null : installHint(kind, process.platform), url: t ? null : installUrl(kind, process.platform) });
  }
  return { agents, tools, platform: process.platform };
});

/* ================= Window & shell IPC ================= */
handle('sys:openExternal', (_e, url) => openInBrowser(url));
handle('win:reload', () => win?.webContents.reload());
handle('win:devtools', () => win?.webContents.toggleDevTools());
handle('win:quit', () => app.quit());
handle('win:edit', (_e, role) => {
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

/* ================= Local LLM API (Ollama, LM Studio or any OpenAI-compatible server) ================= */
// The usual addresses of Ollama and LM Studio, tried when nothing is configured yet.
const LLM_DEFAULTS = ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'];
// The server address without trailing slashes.
function llmBase(url) {
  const s = String(url || '').trim();
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}
const llmHeaders = key => (key ? { Authorization: `Bearer ${key}` } : {});

async function llmModels(url, key, timeout = 5000) {
  const r = await fetch(`${llmBase(url)}/models`, { headers: llmHeaders(key), signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `The server answered with status ${r.status}`);
  const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
  if (!ids.length) throw new Error('The server has no models yet. Download one first, for example: ollama pull llama3.1');
  return ids;
}
// The saved server; with `probe`, otherwise the first usual address that answers (it is then saved).
async function llmConfig(probe) {
  const s = loadState();
  if (s.llmUrl) return { url: s.llmUrl, model: s.llmModel, models: s.llmModels || [], key: getSecret('llmKey') };
  if (!probe || s.llmOff) return null;
  const answers = await Promise.all(LLM_DEFAULTS.map(u => llmModels(u, null, 700).then(models => ({ url: u, models }), () => null)));
  const hit = answers.find(Boolean);
  if (!hit) return null;
  saveState({ llmUrl: hit.url, llmModel: hit.models[0], llmModels: hit.models });
  return { url: hit.url, model: hit.models[0], models: hit.models, key: null };
}

// Checks that the saved server still answers and still has the chosen model (the user may have closed or unloaded it).
async function llmReachable(cfg) {
  let models;
  try { models = await llmModels(cfg.url, cfg.key, 2500); }
  catch { throw new Error('The local LLM server is not running. Start Ollama or LM Studio again, or choose another agent.'); }
  if (cfg.model && !models.includes(cfg.model)) throw new Error(`${cfg.model} is no longer loaded on the local LLM server. Load it again or pick another model.`);
  return models;
}

// With no address, the usual local addresses are tried with the key.
async function llmFind(key) {
  const errors = [];
  for (const u of LLM_DEFAULTS) {
    try { return { url: u, models: await llmModels(u, key, 1500) }; } catch (err) { errors.push(err); }
  }
  const answered = errors.find(e => !/fetch failed|timeout|aborted|ECONNREFUSED/i.test(e.message));
  throw answered || new Error('No local LLM server is running. Start Ollama or LM Studio, then connect again.');
}
handle('llm:connect', async (_e, url, key) => {
  url = llmBase(url);
  key = String(key || '').trim();
  if (!url) ({ url } = await llmFind(key));
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('Enter the server address, for example http://localhost:11434/v1');
  const models = await llmModels(url, key);
  setSecret('llmKey', key || null);
  saveState({ llmUrl: url, llmModel: models[0], llmModels: models, llmOff: false });
  return { url, model: models[0], models };
});
handle('llm:setModel', (_e, model) => {
  if (!(loadState().llmModels || []).includes(model)) throw new Error('That model is not on the server');
  saveState({ llmModel: model });
});
// Forget the server, and stop looking for one until the user connects again.
handle('llm:disconnect', () => {
  setSecret('llmKey', null);
  saveState({ llmUrl: null, llmModel: null, llmModels: null, llmOff: true });
});

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

handle('agent:run', (_e, opts) => {
  const runId = nextRun++;
  startRun(runId, opts).catch(err => {
    emit(runId, { t: 'error', text: err.message });
    emit(runId, { t: 'done', ok: false });
    runs.delete(runId);
  });
  return runId;
});
handle('agent:stop', (_e, runId) => {
  const r = runs.get(runId);
  if (!r) return;
  r.stopped = true;
  if (r.child) killTree(r.child);
  r.abort?.abort();
});
// Command-line flags for a CLI agent, and the prompt it reads from stdin.
function cliArgs(agent, mode, prompt, session) {
  const build = mode === 'build';
  const args = ['exec', '--json', '-s', build ? 'workspace-write' : 'read-only', '--skip-git-repo-check'];
  const model = loadState().codexModel;
  if (model && SAFE_MODEL.test(model)) args.push('-m', model);
  if (session) args.push('resume', session);
  args.push('-');
  if (build) return { args, prompt };
  const ask = mode === 'plan' ? 'Make a short numbered plan for this request. Do not change any files yet.' : 'Answer without changing any files.';
  return { args, prompt: `${ask}\n\n${prompt}` };
}
// Codex's config may name a model the signed-in account can't use (e.g. a ChatGPT plan without API models).
// Breeze then retries once with the best model from Codex's own model list and keeps using it.
const SAFE_MODEL = /^[\w.:-]{1,64}$/;
const MODEL_REFUSED = /model[^\n]{0,80}(?:is not supported|does not exist|not found|unsupported|not available)/i;
function codexModels() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'models_cache.json'), 'utf8'));
    return (j.models || []).filter(m => m.visibility !== 'hide' && SAFE_MODEL.test(m.slug || ''))
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map(m => m.slug);
  } catch { return []; }
}
function codexFallback(errText) {
  const refused = /'([\w.:-]+)' model|model '([\w.:-]+)'|model `([\w.:-]+)`/i.exec(errText);
  const bad = refused?.slice(1).find(Boolean);
  return codexModels().find(m => m !== bad && m !== loadState().codexModel) || null;
}

// Agents work in the open project; Breeze Box chats may also run without one, in the Breeze Box folder.
async function startRun(runId, { agent, mode, prompt, session, box }) {
  const base = root || (box ? boxDir() : null);
  if (!base) throw new Error('Open a folder first');
  if (session && !SAFE_ID.test(session)) session = null;
  const run = { child: null, abort: null, stopped: false };
  runs.set(runId, run);
  if (agent === 'local') return runLocal(runId, run, { mode, prompt, session, base });
  if (agent === 'ubot') return runMock(runId, run, { mode, prompt });
  const bin = agentBins.get(agent);
  if (!bin) throw new Error('That agent was not found on this computer. Rescan from Settings → Run Setup Again.');
  const launch = () => {
    const cli = cliArgs(agent, mode, prompt, session);
    // The prompt goes through stdin, so it never reaches a shell command line. Only fixed flags,
    // a validated model name and a validated session id do (npm .cmd shims need a shell on Windows).
    const opts = { cwd: base, windowsHide: true, env: process.env };
    const child = /\.(?:cmd|bat)$/i.test(bin)
      ? spawn(shellCommand(bin, cli.args), { ...opts, shell: true })
      : spawn(bin, cli.args, opts);
    run.child = child;
    child.stdin.on('error', () => { /* the agent exited before reading its prompt; its output says why */ });
    child.stdin.end(cli.prompt ?? undefined);
    streamCli(runId, run, child, codexEvent, mode, retryModel);
  };
  // Called once when Codex refuses its configured model.
  let retried = false;
  const retryModel = errText => {
    const model = !retried && agent === 'codex' ? codexFallback(errText) : null;
    if (!model) return false;
    retried = true;
    saveState({ codexModel: model });
    emit(runId, { t: 'note', text: `Codex can't use the model in its settings with your account, so Breeze switched it to ${model}.` });
    runs.set(runId, run);
    launch();
    return true;
  };
  launch();
}
// Parses one JSON event per line from the agent's stdout.
function streamCli(runId, run, child, parse, mode, retryModel) {
  const ctx = { done: false, lastError: '', stderr: '', lastText: '', retryModel };
  let buf = '';
  const line = text => {
    if (!text) return;
    try { parse(runId, JSON.parse(text), ctx, mode); } catch { ctx.stderr += text + '\n'; } // not JSON: keep it for the error message
  };
  // Decoded as a stream, so a character split across two chunks stays whole.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) line(l.trim());
  });
  child.stderr.on('data', chunk => { ctx.stderr = (ctx.stderr + chunk).slice(-4000); });
  child.on('error', err => { ctx.lastError = err.message; });
  child.on('close', code => {
    runs.delete(runId);
    if (ctx.retry && !run.stopped && ctx.retryModel?.(ctx.retry)) return;
    if (ctx.done) return;
    if (run.stopped) { emit(runId, { t: 'done', ok: false, stopped: true }); return; }
    emit(runId, { t: 'error', text: ctx.lastError || ctx.stderr.trim().split('\n').slice(-6).join('\n') || `The agent exited with code ${code}` });
    emit(runId, { t: 'done', ok: false });
  });
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
  // Codex's warning about a model it has no metadata for is noise to the user.
  error: (runId, it) => { if (it.message && !/^Model metadata for/i.test(it.message)) emit(runId, { t: 'note', text: it.message }); },
};
function codexEvent(runId, d, ctx, mode) {
  if (d.type === 'thread.started') emit(runId, { t: 'session', id: d.thread_id });
  else if (d.type === 'item.completed' && d.item) CODEX_ITEMS[d.item.type]?.(runId, d.item, ctx);
  else if (d.type === 'error') ctx.lastError = codexError(d.message || '');
  else if (d.type === 'turn.failed') {
    const text = codexError(d.error?.message || ctx.lastError || 'The turn failed');
    // A refused model gets one retry with another model once the process exits (see streamCli).
    if (MODEL_REFUSED.test(text) && ctx.retryModel && !ctx.retry) { ctx.retry = text; return; }
    ctx.done = true;
    emit(runId, { t: 'error', text });
    emit(runId, { t: 'done', ok: false });
  } else if (d.type === 'turn.completed') {
    ctx.done = true;
    if (mode === 'plan' && ctx.lastText) emit(runId, { t: 'plan', text: ctx.lastText });
    emit(runId, { t: 'done', ok: true, tokens: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0) });
  }
}

// u.bot: a mock agent. It reads nothing and changes nothing; it plays a short scripted run so the whole chat flow can be tried.
async function runMock(runId, run, { mode, prompt }) {
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const said = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 120);
  const steps = [
    [{ t: 'session', id: `ubot-${runId}`, model: 'mock' }, 150],
    [{ t: 'tool', kind: 'read', label: 'Looked around the project (mock)' }, 700],
  ];
  if (mode === 'plan') {
    steps.push([{ t: 'text', text: `u.bot here. You asked: "${said}"` }, 600], [{ t: 'plan', text: '1. Look at the files involved\n2. Make the change\n3. Check that it still runs\n\n(Mock plan: u.bot is a stand-in agent.)' }, 500]);
  } else {
    steps.push([{ t: 'text', text: `u.bot here. You asked: "${said}"\n\nI'm a mock agent, so I didn't change anything.` }, 800]);
  }
  steps.push([{ t: 'done', ok: true, ms: 1500, tokens: 0 }, 300]);
  const started = Date.now();
  for (const [ev, ms] of steps) {
    await pause(ms);
    if (run.stopped) { runs.delete(runId); emit(runId, { t: 'done', ok: false, stopped: true }); return; }
    emit(runId, ev.t === 'done' ? { ...ev, ms: Date.now() - started } : ev);
  }
  runs.delete(runId);
}

/* ----- Local LLM agent loop (OpenAI-style function calling over the project folder) ----- */
// Keeping token use down: the first message carries a map of the project (so the model doesn't explore it
// call by call), files are read as windows of numbered lines, edits send only the changed snippet, and every
// request is fitted to the model's context by agentbrain.compactHistory. Repeated calls and endless loops stop early.
const brain = require('./agentbrain');
const llmSessions = new Map(); // session id -> chat messages (earlier turns already settled)
const LLM_TOOLS = [
  { name: 'list_files', description: 'List the files and folders under a folder, two levels deep. Folders end with "/".', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder relative to the project root; "." for the root' } } } },
  { name: 'read_file', description: `Read numbered lines of a text file (${brain.READ_LINES} lines unless end_line says otherwise). Read only the part you need.`, parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer', description: 'First line to read, from 1' }, end_line: { type: 'integer', description: 'Last line to read' } }, required: ['path'] } },
  { name: 'search_files', description: 'Find lines containing some text (plain text, not a regex) across the project. Use it to find code before reading files.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'edit_file', description: 'Change a file by replacing one exact snippet. old_text must appear exactly once in the file: copy it from read_file, without the line numbers.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'write_file', description: 'Create a new file, or replace a whole file, with its complete contents. For changes to an existing file use edit_file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
].map(fn => ({ type: 'function', function: fn }));
const WRITE_TOOLS = new Set(['edit_file', 'write_file']);
const LIST_MAX = 200;

// Each tool works inside ctx.base: the open project, or the Breeze Box folder. Secrets (.env…) and the .git
// folder are off limits: what the model reads goes to the LLM server, and git's config and hooks run commands.
function agentPath(ctx, rel) {
  const abs = resolveUnder(ctx.base, rel);
  const why = agentBlocked(ctx.base, abs);
  if (why) throw new Error(why);
  return abs;
}
const LLM_TOOL_FNS = {
  async list_files(ctx, a) {
    const dir = agentPath(ctx, a.path || '.');
    emit(ctx.runId, { t: 'tool', kind: 'read', label: `Listed ${a.path && a.path !== '.' ? a.path : 'the project'}` });
    const out = [];
    const walk = async (d, indent, level) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of entries) {
        if (out.length >= LIST_MAX) return;
        if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
        out.push(`${indent}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory() && level < 1) await walk(path.join(d, e.name), `${indent}  `, level + 1);
      }
    };
    await walk(dir, '', 0);
    if (!out.length) return 'Empty folder.';
    return out.join('\n') + (out.length >= LIST_MAX ? '\n… more entries; list a subfolder' : '');
  },
  async read_file(ctx, a) {
    const abs = agentPath(ctx, a.path);
    await fsp.stat(abs); // a missing file comes back as an error the model can read
    const rel = relTo(ctx.base, abs);
    const range = a.start_line > 1 || a.end_line ? ` (lines ${a.start_line || 1}–${a.end_line || ''})` : '';
    emit(ctx.runId, { t: 'tool', kind: 'read', label: `Read ${rel}${range}` });
    const text = await readSearchable(abs);
    if (text == null) return 'Not a readable text file (binary, or larger than 1 MB).';
    return brain.readRange(text, rel, a.start_line, a.end_line);
  },
  async search_files(ctx, a) {
    emit(ctx.runId, { t: 'tool', kind: 'search', label: `Searched for ${a.query}` });
    return brain.formatHits(await searchProject(String(a.query || ''), false, ctx.base, blockedRel));
  },
  async edit_file(ctx, a) {
    const abs = agentPath(ctx, a.path);
    const rel = relTo(ctx.base, abs);
    const { text, line } = brain.applyEdit(await fsp.readFile(abs, 'utf8'), a.old_text, a.new_text);
    await fsp.writeFile(abs, text, 'utf8');
    emit(ctx.runId, { t: 'tool', kind: 'edit', label: `Edited ${rel}` });
    emit(ctx.runId, { t: 'file', path: relOut(abs) });
    return `Edited ${rel} at line ${line}.`;
  },
  async write_file(ctx, a) {
    const abs = agentPath(ctx, a.path);
    const content = String(a.content ?? '');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    emit(ctx.runId, { t: 'tool', kind: 'edit', label: `Wrote ${relTo(ctx.base, abs)}` });
    emit(ctx.runId, { t: 'file', path: relOut(abs) });
    return `Saved ${relTo(ctx.base, abs)} (${content.split('\n').length} lines).`;
  },
};
async function llmTool(ctx, call) {
  const name = call.function?.name;
  const fn = LLM_TOOL_FNS[name];
  if (!fn) throw new Error(`There is no tool called ${name}. Use one of: ${ctx.toolNames.join(', ')}.`);
  if (WRITE_TOOLS.has(name) && ctx.mode !== 'build') throw new Error('This is read-only mode, so files can’t be changed. Describe the change instead.');
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('The arguments were not valid JSON. Call the tool again with a JSON object.'); }
  if (WRITE_TOOLS.has(name)) ctx.seen.clear(); // files changed, so reading them again is fair
  else {
    const key = brain.callKey(name, args);
    if (ctx.seen.has(key) && ctx.turn - ctx.seen.get(key) <= 2) return 'You just made this exact call and its result is above. Use it, or try something different.';
    ctx.seen.set(key, ctx.turn);
  }
  return fn(ctx, args);
}
// Runs a reply's tool calls one after another (a later call may read what an earlier one wrote).
function runToolCalls(ctx, calls) {
  return calls.reduce(async (prev, call) => {
    const replies = await prev;
    let content;
    try { content = String(await llmTool(ctx, call)); } catch (err) { content = `Error: ${err.message}`; }
    return [...replies, { role: 'tool', tool_call_id: call.id, content }];
  }, Promise.resolve([]));
}
const LLM_MODE_NOTE = {
  build: 'Build mode: make the change with edit_file (write_file only for new files), then say what you changed.',
  plan: 'Plan mode: read only. Look at the code you need, then reply with a short numbered plan of the changes.',
  ask: 'Ask mode: read only. Answer the question directly.',
};
// Reliability rules adapted from the Gravitas skill (MIT, github.com/udaysharmadev/Gravitas), trimmed to the tools this agent has.
const llmSystemPrompt = base => `You are Breeze, a coding agent working in the user's project "${path.basename(base)}".
Work efficiently:
- The first message has a map of the project. Use search_files to find code, then read_file only the lines you need.
- Read code before you change it. Change files with edit_file; use write_file only for new files.
- Never repeat a tool call with the same arguments. Stop calling tools as soon as you can answer.
- Only say something works or is fixed if a tool result showed it. Say what you could not check.
- Stay inside the project and do only what was asked.
Reply short and plain. After changing files, list the files, what you checked, and why.
When the user asks for code or a file to keep (and you are not writing it into the project), give it as one fenced block with the language and a file name, like \`\`\`html index.html, so it shows as a card they can copy or download.`;
async function llmPost(cfg, body, signal) {
  const r = await fetch(`${cfg.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...llmHeaders(cfg.key) },
    body: JSON.stringify(body),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.error || `The server answered with status ${r.status}`);
  return j;
}
// Some local models can't call tools; they still answer, just without looking at files.
async function llmRequest(ctx, body, signal) {
  if (ctx.noTools || !body.tools) return llmPost(ctx.cfg, { ...body, tools: undefined }, signal);
  try {
    return await llmPost(ctx.cfg, body, signal);
  } catch (err) {
    if (!/tool/i.test(err.message)) throw err;
    ctx.noTools = true;
    emit(ctx.runId, { t: 'note', text: `${ctx.cfg.model} can't use tools, so it answers without looking at your files.` });
    return llmPost(ctx.cfg, { ...body, tools: undefined }, signal);
  }
}
// A reply that is only a tool call written as text ({"name": "read_file", "arguments": {...}}), possibly fenced,
// becomes real tool calls. Anything else (prose, other JSON, unknown tool names) is left alone.
function textToolCalls(text, toolNames) {
  const body = String(text ?? '').trim().replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```$/, '').trim();
  if (!/^[[{]/.test(body)) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const c of list) {
    const fn = c?.function ?? c;
    const args = fn?.arguments ?? fn?.parameters ?? {};
    if (typeof fn?.name !== 'string' || !toolNames.includes(fn.name) || args === null || typeof args === 'number') return null;
    calls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, type: 'function', function: { name: fn.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  }
  return calls.length ? calls : null;
}
const LLM_MAX_TURNS = 24;
const LLM_REPLY_RESERVE = 1500; // tokens left free for the model's own reply
// Ollama runs models with a small context unless it was raised on the server; other servers usually allow more.
// `llmContext` in the saved state overrides the guess.
function llmBudget(cfg) {
  const window = Number(loadState().llmContext) || (/:11434\b/.test(cfg.url) ? 4096 : 8192);
  return Math.max(1500, window - LLM_REPLY_RESERVE - brain.tokensOf(JSON.stringify(LLM_TOOLS)));
}
// Reasoning models (Qwen 3, DeepSeek R1…) put their thinking in <think> tags: it is neither shown nor kept.
const withoutThinking = s => String(s ?? '').replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();
async function runLocal(runId, run, { mode, prompt, session, base }) {
  const cfg = await llmConfig(false);
  if (!cfg?.model) throw new Error('Connect a local LLM server first (Settings → Run Setup Again).');
  await llmReachable(cfg);
  const sid = session && llmSessions.has(session) ? session : crypto.randomUUID();
  const fresh = !llmSessions.has(sid);
  const messages = llmSessions.get(sid) || [{ role: 'system', content: llmSystemPrompt(base) }];
  llmSessions.set(sid, messages);
  emit(runId, { t: 'session', id: sid, model: cfg.model });
  const budget = llmBudget(cfg);
  const map = fresh ? `Project map:\n${brain.projectMap((await listFiles(base)).map(f => relTo(base, f)), Math.min(2400, Math.floor(budget * 0.8)))}\n\n` : '';
  messages.push({ role: 'user', content: `${map}${prompt}\n\n(${LLM_MODE_NOTE[mode] ?? LLM_MODE_NOTE.ask})` });
  const tools = LLM_TOOLS.filter(t => mode === 'build' || !WRITE_TOOLS.has(t.function.name));
  const ctx = { runId, base, cfg, mode, noTools: false, seen: new Map(), turn: 0, toolNames: tools.map(t => t.function.name) };
  run.abort = new AbortController();
  const started = Date.now();
  let tokens = 0, lastText = '';
  // One request; only the assistant's text and tool calls are kept (servers add extra fields).
  const ask = async withTools => {
    const body = { model: cfg.model, messages: brain.compactHistory(messages, budget), temperature: 0.2, stream: false };
    if (withTools) body.tools = tools;
    const j = await llmRequest(ctx, body, run.abort.signal);
    tokens += j.usage?.total_tokens || 0;
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new Error('The model returned no answer');
    let text = withoutThinking(msg.content);
    let calls = msg.tool_calls?.length ? msg.tool_calls : null;
    // Small models often print the call as JSON text instead of using the tool API: run it rather than show it.
    if (!calls && withTools) {
      calls = textToolCalls(text, ctx.toolNames);
      if (calls) text = '';
    }
    messages.push({ role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) });
    if (text) { lastText = text; emit(runId, { t: 'text', text }); }
    return calls;
  };
  try {
    for (let n = 0; n < LLM_MAX_TURNS && !run.stopped; n++) {
      ctx.turn = n;
      const calls = await ask(true);
      if (!calls) break;
      messages.push(...await runToolCalls(ctx, calls));
      if (n === LLM_MAX_TURNS - 1 && !run.stopped) {
        emit(runId, { t: 'note', text: `${cfg.model} used ${LLM_MAX_TURNS} steps, so Breeze asked it to answer with what it found.` });
        messages.push({ role: 'user', content: 'You have used many steps. Stop using tools and answer now with what you found.' });
        await ask(false);
      }
    }
  } catch (err) {
    if (!run.stopped) throw err; // stopping aborts the request
  } finally {
    // Later turns keep the conversation, not this turn's raw tool output.
    messages.splice(0, messages.length, ...brain.settle(messages));
  }
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
    const child = execFile(bin, safeGitArgs(args), {
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
handle('git:status', async () => {
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

handle('git:log', async () => {
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

handle('git:show', async (_e, hash) => {
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

handle('git:diff', (_e, rel, staged) => git(['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', ...checkPaths(rel)]));
handle('git:init', () => git(['init']));
handle('git:stage', (_e, paths) => git(['add', '-A', '--', ...checkPaths(paths)]));
handle('git:unstage', (_e, paths, hasCommits) => {
  const p = checkPaths(paths);
  return hasCommits ? git(['restore', '--staged', '--', ...p]) : git(['rm', '--cached', '-r', '-q', '--', ...p]);
});
// Discarding untracked files moves them to the Recycle Bin rather than deleting them.
handle('git:discard', async (_e, files) => {
  const tracked = files.filter(f => !f.untracked).map(f => f.path);
  const untracked = files.filter(f => f.untracked).map(f => f.path);
  checkPaths([...tracked, ...untracked]);
  await Promise.all(untracked.map(p => shell.trashItem(resolveIn(p))));
  if (tracked.length) await git(['restore', '--worktree', '--', ...tracked]);
});
handle('git:commit', async (_e, message, all) => {
  if (!String(message || '').trim()) throw new Error('Write a message for this checkpoint first');
  if (all) await git(['add', '-A']);
  await git(['commit', '-F', '-'], { input: message });
  return (await git(['rev-parse', '--short', 'HEAD'])).trim();
});
handle('git:branches', async () => {
  const out = await git(['branch', '--format=%(refname:short)']).catch(() => '');
  return out.split('\n').map(s => s.trim()).filter(Boolean);
});
handle('git:switch', async (_e, name, create, from) => {
  await git(['check-ref-format', '--branch', name]);
  if (from && !HASH.test(from)) throw new Error('Bad commit id');
  return git(create ? ['switch', '-c', name, ...(from ? [from] : [])] : ['switch', name]);
});

handle('git:deleteBranch', async (_e, name) => {
  const names = (await git(['branch', '--format=%(refname:short)'])).split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.includes(String(name))) throw new Error('That branch no longer exists');
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  if (name === current) throw new Error("You can't delete the branch you're on. Switch to another branch first.");
  return git(['branch', '-D', '--', name]);
});

handle('git:sync', async (_e, op) => {
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

// Every account signed in on this computer is remembered; one of them is active.
const accountId = u => `${u.provider}:${u.login}`;
function accountsState() {
  const s = loadState();
  const accounts = s.accounts || (s.user ? [s.user] : []);
  return { accounts, active: s.user ? accountId(s.user) : null };
}
function addAccount(user) {
  const { accounts } = accountsState();
  saveState({ user, accounts: [...accounts.filter(a => accountId(a) !== accountId(user)), user] });
}
handle('auth:user', () => loadState().user || null);
handle('auth:accounts', () => accountsState());
handle('auth:switch', (_e, id) => {
  const user = accountsState().accounts.find(a => accountId(a) === id);
  if (!user) throw new Error('That account is no longer signed in');
  saveState({ user });
  return user;
});
// Signs the active account out and switches to the next one, if any.
handle('auth:signOut', () => {
  const { accounts, active } = accountsState();
  if (active) setSecret(`token:${active}`, null);
  const rest = accounts.filter(a => accountId(a) !== active);
  const user = rest[0] || null;
  saveState({ accounts: rest, user });
  return user;
});
handle('auth:cancel', () => { authAbort?.abort(); authAbort = null; });
handle('auth:start', (_e, provider) => {
  const cfg = authConfig();
  if (provider === 'GitHub' && !cfg.github.clientId) return { error: 'not-configured' };
  if (provider === 'Google' && !cfg.google.clientId) return { error: 'not-configured' };
  authAbort?.abort();
  const ac = new AbortController();
  authAbort = ac;
  (provider === 'GitHub' ? githubSignIn(cfg.github, ac.signal) : googleSignIn(cfg.google, ac.signal))
    .then(user => { addAccount(user); authEmit({ t: 'done', user }); })
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
  const ur = await fetch('https://api.github.com/user', {
    signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Breeze-IDE' },
  });
  if (!ur.ok) throw new Error('GitHub signed you in but did not share your profile. Try again.');
  const u = await ur.json();
  const user = { provider: 'GitHub', name: u.name || u.login, login: u.login, email: u.email || null, avatar: u.avatar_url || null };
  setSecret(`token:${accountId(user)}`, token);
  return user;
}

// Google: authorization code + PKCE through a one-shot loopback server on 127.0.0.1.
// The page the browser lands on after Google: Breeze's look, with Unbounded headings and Inter text.
const PAGE_ICON = {
  ok: '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  fail: '<path d="M12 7.5v5.5M12 16.5v.01" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
};
// The Breeze IDE wordmark is inlined so the one-shot server needs no asset route.
let wordmarkUri = null;
function wordmarkSrc() {
  if (wordmarkUri === null) {
    try { wordmarkUri = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'BreezeCode.png')).toString('base64')}`; } catch { wordmarkUri = ''; }
  }
  return wordmarkUri;
}
function googleRedirectPage(ok) {
  const title = ok ? 'You’re signed in' : 'Sign-in didn’t finish';
  const text = ok ? 'Breeze has your account now. You can close this tab and head back to Breeze.' : 'Nothing was changed. Close this tab and try again from Breeze.';
  // The badge starts on the brand blue and eases to green once the sign-in lands; a failure stays amber.
  const tone = ok
    ? { from: '#005EFF', to: '#57C478', shadowFrom: 'rgba(0,94,255,.45)', shadowTo: 'rgba(87,196,120,.45)', glowFrom: 'rgba(0,94,255,.32)', glowTo: 'rgba(87,196,120,.3)' }
    : { from: '#d97706', to: '#d97706', shadowFrom: 'rgba(217,119,6,.4)', shadowTo: 'rgba(217,119,6,.4)', glowFrom: 'rgba(0,94,255,.32)', glowTo: 'rgba(217,119,6,.26)' };
  const logo = wordmarkSrc();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Breeze</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
  @property --glow { syntax: '<color>'; inherits: false; initial-value: ${tone.glowFrom}; }
  @property --gx { syntax: '<percentage>'; inherits: false; initial-value: 50%; }
  @property --gy { syntax: '<percentage>'; inherits: false; initial-value: -10%; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #f5f5f7; font: 15px/1.6 Inter, system-ui, sans-serif;
    background: radial-gradient(900px 460px at var(--gx, 50%) var(--gy, -10%), var(--glow, ${tone.glowFrom}), transparent 70%), #000;
    animation: glowTone 1.2s .5s cubic-bezier(.4,0,.2,1) both, sway 11s ease-in-out infinite alternate; }
  .card { width: min(440px, 100%); text-align: center; padding: 40px 36px 34px; border-radius: 24px; border: 1px solid rgba(255,255,255,.1);
    background: rgba(28,28,34,.55); backdrop-filter: blur(22px) saturate(160%); box-shadow: 0 30px 90px rgba(0,0,0,.55); animation: rise .5s cubic-bezier(.2,.8,.2,1); }
  .badge { width: 64px; height: 64px; margin: 0 auto 22px; border-radius: 50%; display: grid; place-items: center;
    background: ${tone.from}; box-shadow: 0 10px 30px ${tone.shadowFrom}; animation: badgeTone 1s .55s cubic-bezier(.4,0,.2,1) both; }
  .badge path { stroke-dasharray: 20; stroke-dashoffset: 20; animation: draw .45s .3s ease-out forwards; }
  h1 { margin: 0 0 10px; font: 700 26px/1.2 Unbounded, Inter, sans-serif; letter-spacing: -.01em; }
  p { margin: 0; color: #a1a1aa; }
  .brand { margin-top: 26px; display: flex; align-items: center; justify-content: center; color: #6b6b75; font: 600 12px Unbounded, Inter, sans-serif; }
  .brand img { display: block; height: 20px; width: auto; opacity: .75; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.98); } }
  @keyframes badgeTone { from { background: ${tone.from}; box-shadow: 0 10px 30px ${tone.shadowFrom}; } to { background: ${tone.to}; box-shadow: 0 10px 30px ${tone.shadowTo}; } }
  @keyframes glowTone { from { --glow: ${tone.glowFrom}; } to { --glow: ${tone.glowTo}; } }
  @keyframes sway { from { --gx: 34%; --gy: -14%; } to { --gx: 66%; --gy: 2%; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) { body, .badge, .badge path { animation: none; } .badge path { stroke-dashoffset: 0; } .badge { background: ${tone.to}; } }
</style></head><body>
<main class="card">
  <div class="badge"><svg width="30" height="30" viewBox="0 0 24 24">${ok ? PAGE_ICON.ok : PAGE_ICON.fail}</svg></div>
  <h1>${title}</h1>
  <p>${text}</p>
  <div class="brand">${logo ? `<img src="${logo}" alt="Breeze IDE">` : 'Breeze'}</div>
</main></body></html>`;
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
  const ur = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { signal, headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!ur.ok) throw new Error('Google signed you in but did not share your profile. Try again.');
  const u = await ur.json();
  const user = { provider: 'Google', name: u.name || u.email, login: u.email, email: u.email || null, avatar: u.picture || null };
  if (tok.refresh_token) setSecret(`token:${accountId(user)}`, tok.refresh_token);
  return user;
}

/* ================= Vibe Mode: social feeds ================= */
// Feeds live in their own browser session (persist:vibe), apart from the app. Signing in happens on the
// site itself in a Breeze window; Breeze only checks whether a sign-in cookie exists.
const VIBE_PARTITION = 'persist:vibe';
const VIBE_SITES = {
  instagram: { name: 'Instagram Reels', url: 'https://www.instagram.com/reels/', cookie: ['instagram.com', 'sessionid'], domains: ['instagram.com'] },
  facebook: { name: 'Facebook Reels', url: 'https://www.facebook.com/reel/', cookie: ['facebook.com', 'c_user'], domains: ['facebook.com'] },
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

handle('vibe:status', async () => {
  const ids = Object.keys(VIBE_SITES);
  const states = await Promise.all(ids.map(signedIn));
  return Object.fromEntries(ids.map((id, i) => [id, states[i]]));
});
// Opens the site in a Breeze window; resolves with the sign-in state once the user closes it.
handle('vibe:connect', (_e, id) => {
  const site = vibeSite(id);
  return new Promise(resolve => {
    const w = new BrowserWindow({ parent: win, width: 460, height: 820, title: `Connect ${site.name} — Breeze`, icon: APP_ICON, autoHideMenuBar: true, backgroundColor: '#000000', webPreferences: feedPrefs() });
    guardFeed(w.webContents);
    w.loadURL(site.url).catch(logError('connect'));
    w.on('closed', () => { signedIn(id).then(resolve, () => resolve(false)); });
  });
});
// Forgets the site's sign-in by removing its cookies from the feed session.
handle('vibe:disconnect', async (_e, id) => {
  const ses = vibeSession();
  const lists = await Promise.all(vibeSite(id).domains.map(domain => ses.cookies.get({ domain })));
  await Promise.all(lists.flat().map(c => ses.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path}`, c.name)));
});
const toBounds = b => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });
// Lays the live feed over the renderer's 9:16 frame.
handle('vibe:show', (_e, id, bounds) => {
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
handle('vibe:bounds', (_e, bounds) => vibeView?.setBounds(toBounds(bounds)));
handle('vibe:mute', (_e, muted) => vibeView?.webContents.setAudioMuted(!!muted));
// Closing the view also stops its video and sound.
handle('vibe:hide', () => {
  if (!vibeView) return;
  win?.contentView.removeChildView(vibeView);
  vibeView.webContents.close();
  vibeView = null;
});

/* ================= Discord Rich Presence ================= */
// Talks to the Discord app on this computer. It needs the id of a Discord application (made once at
// https://discord.com/developers/applications); the id is public, not a secret.
const { DiscordRpc } = require('./discord');
const DEFAULT_DISCORD_CLIENT_ID = '';
function discordClientId() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'breeze.config.json'), 'utf8')); } catch { /* not configured */ }
  return String(process.env.BREEZE_DISCORD_CLIENT_ID || file.discord?.clientId || DEFAULT_DISCORD_CLIENT_ID).trim();
}
let discordRpc = null;
let discordWanted = null;   // the activity the renderer asked for last
let discordSentAt = 0;
let discordTimer = null;
const DISCORD_GAP = 4000;   // Discord allows about 5 updates per 20 seconds

async function discordConnect() {
  const id = discordClientId();
  if (!/^\d{15,22}$/.test(id)) throw new Error('Discord presence needs a Discord application id. Add "discord": { "clientId": "…" } to breeze.config.json or set BREEZE_DISCORD_CLIENT_ID.');
  if (discordRpc?.connected) return discordRpc.user;
  discordRpc = new DiscordRpc(id);
  discordRpc.onClose = () => { discordRpc = null; };
  return discordRpc.connect();
}
function discordFlush() {
  clearTimeout(discordTimer);
  const wait = discordSentAt + DISCORD_GAP - Date.now();
  if (wait > 0) { discordTimer = setTimeout(discordFlush, wait); return; }
  if (!discordRpc?.connected || !discordWanted) return;
  discordSentAt = Date.now();
  discordRpc.setActivity({ ...discordWanted, largeImageKey: 'breeze', largeImageText: 'Breeze Code' }).catch(logError('discord'));
}
const discordText = (s, max = 120) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : undefined);
handle('discord:set', async (_e, a) => {
  const user = await discordConnect();
  discordWanted = { details: discordText(a?.details), state: discordText(a?.state), startTimestamp: Number(a?.start) || undefined };
  discordFlush();
  return { user: user?.global_name || user?.username || null };
});
handle('discord:clear', async () => {
  discordWanted = null;
  clearTimeout(discordTimer);
  if (!discordRpc) return;
  await discordRpc.setActivity(null).catch(logError('discord'));
  discordRpc.close();
  discordRpc = null;
});
app.on('before-quit', () => discordRpc?.close());
