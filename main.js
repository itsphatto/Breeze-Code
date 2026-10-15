// Electron main process for Breeze IDE: window, file system, search, terminal and tool detection.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn, execFile, exec } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '__pycache__', '.venv']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LISTED_FILES = 10000;

let win = null;
let root = null;          // absolute path of the open project folder
let watcher = null;
let termCwd = os.homedir();
const terms = new Map();  // id -> child process

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
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Breeze IDE',
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

  win.loadFile(path.join(__dirname, 'breeze.html'));

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.on('closed', () => { win = null; stopWatching(); killAllTerms(); });
}

app.whenReady().then(() => {
  // The menu bar is drawn in HTML; the native one would only duplicate it.
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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
  } catch { watcher = null; }
}
function stopWatching() { watcher?.close(); watcher = null; }

/* ================= File system IPC ================= */
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
  return entries
    .map(d => ({ name: d.name, dir: d.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
});

ipcMain.handle('fs:readFile', async (_e, rel) => {
  const abs = resolveIn(rel);
  const st = await fsp.stat(abs);
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

ipcMain.handle('fs:fileUrl', (_e, rel) => require('url').pathToFileURL(resolveIn(rel)).href);

async function walk(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const d of entries) {
    if (out.length >= MAX_LISTED_FILES) return;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) { if (!IGNORED_DIRS.has(d.name)) await walk(abs, out); }
    else if (d.isFile()) out.push(abs);
  }
}

ipcMain.handle('fs:listFiles', async () => {
  const out = [];
  await walk(resolveIn(''), out);
  return out.map(toRel);
});

ipcMain.handle('fs:search', async (_e, query, matchCase) => {
  if (!query) return [];
  const files = [];
  await walk(resolveIn(''), files);
  const needle = matchCase ? query : query.toLowerCase();
  const results = [];
  for (const abs of files) {
    if (results.length >= 500) break;
    let buf;
    try {
      const st = await fsp.stat(abs);
      if (st.size > 1024 * 1024) continue;
      buf = await fsp.readFile(abs);
    } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < 500; i++) {
      const hay = matchCase ? lines[i] : lines[i].toLowerCase();
      const col = hay.indexOf(needle);
      if (col !== -1) results.push({ path: toRel(abs), line: i, col, text: lines[i].slice(0, 300) });
    }
  }
  return results;
});

/* ================= Terminal ================= */
let nextTermId = 1;
ipcMain.handle('term:cwd', () => termCwd);

ipcMain.handle('term:run', (_e, command) => {
  const cd = /^\s*cd(?:\s+(.*))?\s*$/i.exec(command);
  if (cd) {
    const target = cd[1] ? path.resolve(termCwd, cd[1].replace(/^["']|["']$/g, '')) : os.homedir();
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { error: `The system cannot find the path specified: ${target}` };
    termCwd = target;
    return { cwd: termCwd };
  }
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

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}
ipcMain.handle('term:kill', (_e, id) => { const c = terms.get(id); if (c) killTree(c); });
function killAllTerms() { for (const c of terms.values()) killTree(c); terms.clear(); }

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
      for (const sub of fs.readdirSync(base)) if (fs.existsSync(path.join(base, sub, file))) return path.join(base, sub, file);
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
  {
    id: 'gemini', name: 'Gemini CLI', vendor: 'Google', commands: ['gemini'],
    url: 'https://github.com/google-gemini/gemini-cli',
    paths: () => isWin ? [path.join(APPDATA, 'npm', 'gemini.cmd')] : ['/usr/local/bin/gemini', '/opt/homebrew/bin/gemini'],
  },
];

function which(cmd) {
  return new Promise(res => {
    execFile(isWin ? 'where' : 'which', [cmd], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return res(null);
      const hits = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // On Windows prefer the runnable shim (.cmd/.exe) over the extension-less sh script npm also writes.
      res((isWin && hits.find(h => /\.(cmd|exe|bat)$/i.test(h))) || hits[0] || null);
    });
  });
}

function versionOf(bin) {
  // Launching a GUI app's .exe would open its window, so only ask CLIs for a version.
  if (/\.app$/.test(bin) || (isWin && /\.exe$/i.test(bin) && !/(claude|codex|gemini|git|node)\.exe$/i.test(bin))) return Promise.resolve(null);
  return new Promise(res => {
    exec(`"${bin}" --version`, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return res(null);
      const m = /\d+\.\d+(?:\.\d+)?/.exec(stdout);
      res(m ? m[0] : null);
    });
  });
}

async function locate(commands, paths) {
  for (const c of commands) { const p = await which(c); if (p) return p; }
  return paths.find(p => p && fs.existsSync(p)) || null;
}

ipcMain.handle('sys:detect', async () => {
  const agents = await Promise.all(AGENTS.map(async a => {
    const bin = await locate(a.commands, a.paths());
    return { id: a.id, name: a.name, vendor: a.vendor, url: a.url, found: !!bin, path: bin, version: bin ? await versionOf(bin) : null };
  }));
  const tools = await Promise.all([['git', 'Git'], ['node', 'Node.js']].map(async ([cmd, name]) => {
    const bin = await which(cmd);
    return { id: cmd, name, found: !!bin, version: bin ? await versionOf(bin) : null };
  }));
  return { agents, tools, platform: process.platform };
});

/* ================= Window & shell IPC ================= */
ipcMain.handle('sys:openExternal', (_e, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
});
ipcMain.handle('win:reload', () => win?.webContents.reload());
ipcMain.handle('win:devtools', () => win?.webContents.toggleDevTools());
ipcMain.handle('win:quit', () => app.quit());
ipcMain.handle('win:edit', (_e, role) => {
  const wc = win?.webContents;
  if (wc && ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(role)) wc[role]();
});
