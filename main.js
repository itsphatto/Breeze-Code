// Electron main process for Breeze IDE: window, file system, search, terminal, git, agents and sign-in.
const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require('electron');
const { spawn, execFile, exec } = require('child_process');
const crypto = require('crypto');
const http = require('http');
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

ipcMain.handle('fs:search', (_e, query, matchCase) => searchProject(query, matchCase));

async function searchProject(query, matchCase) {
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
}

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
];
const agentBins = new Map(); // agent id -> executable found by the last scan

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
  const stable = names.filter(n => /^gemini-[\d.]+-(flash|pro)$/.test(n))
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
  const build = mode === 'build';
  let args;
  if (agent === 'claude') {
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', build ? 'acceptEdits' : 'plan'];
    if (session) args.push('--resume', session);
  } else {
    args = ['exec', '--json', '-s', build ? 'workspace-write' : 'read-only', '--skip-git-repo-check'];
    if (session) args.push('resume', session);
    args.push('-');
    if (!build) prompt = `${mode === 'plan' ? 'Make a short numbered plan for this request. Do not change any files yet.' : 'Answer without changing any files.'}\n\n${prompt}`;
  }
  // The prompt goes through stdin, so it never reaches a shell command line. Only fixed flags and
  // a validated session id do (npm .cmd shims need a shell on Windows).
  const child = spawn(bin, args, { cwd: root, shell: /\.(cmd|bat)$/i.test(bin), windowsHide: true, env: process.env });
  run.child = child;
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const ctx = { done: false, lastError: '', stderr: '', lastText: '' };
  const parse = agent === 'claude' ? claudeEvent : codexEvent;
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { ctx.stderr += line + '\n'; continue; }
      parse(runId, d, ctx, mode);
    }
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

function describeTool(name, input = {}) {
  const file = relOut(input.file_path || input.path || input.notebook_path);
  switch (name) {
    case 'Read': return { kind: 'read', label: `Read ${file}` };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { kind: 'edit', label: `Edited ${file}` };
    case 'Write': return { kind: 'edit', label: `Wrote ${file}` };
    case 'Bash': case 'PowerShell': return { kind: 'run', label: `$ ${input.command || ''}` };
    case 'Glob': case 'Grep': return { kind: 'search', label: `Searched for ${input.pattern || ''}` };
    case 'WebFetch': return { kind: 'web', label: `Fetched ${input.url || ''}` };
    case 'WebSearch': return { kind: 'web', label: `Searched the web for ${input.query || ''}` };
    case 'TodoWrite': return { kind: 'todo', label: 'Updated its to-do list' };
    case 'Task': case 'Agent': return { kind: 'agent', label: `Started a helper: ${input.description || ''}` };
    default: return { kind: 'tool', label: name };
  }
}

function claudeEvent(runId, d, ctx) {
  if (d.type === 'system' && d.subtype === 'init') emit(runId, { t: 'session', id: d.session_id, model: d.model });
  else if (d.type === 'assistant') {
    for (const c of d.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) { ctx.lastText = c.text; emit(runId, { t: 'text', text: c.text }); }
      else if (c.type === 'tool_use') {
        if (c.name === 'ExitPlanMode') { emit(runId, { t: 'plan', text: c.input?.plan || ctx.lastText }); continue; }
        emit(runId, { t: 'tool', ...describeTool(c.name, c.input) });
        if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(c.name)) emit(runId, { t: 'file', path: relOut(c.input?.file_path || c.input?.notebook_path) });
      }
    }
  } else if (d.type === 'result') {
    ctx.done = true;
    const ok = d.subtype === 'success' && !d.is_error;
    if (!ok) {
      const text = String(d.result || d.subtype || 'The agent stopped with an error');
      emit(runId, { t: 'error', text, hint: /log ?in/i.test(text) ? 'Run "claude" in the Terminal panel once and sign in with /login, then try again.' : undefined });
    }
    emit(runId, { t: 'done', ok, cost: d.total_cost_usd, ms: d.duration_ms });
  }
}

function codexError(msg) {
  try { const j = JSON.parse(msg); return j.error?.message || j.message || msg; } catch { return msg; }
}
function codexEvent(runId, d, ctx, mode) {
  if (d.type === 'thread.started') emit(runId, { t: 'session', id: d.thread_id });
  else if (d.type === 'item.completed' && d.item) {
    const it = d.item;
    if (it.type === 'agent_message' && it.text) { ctx.lastText = it.text; emit(runId, { t: 'text', text: it.text }); }
    else if (it.type === 'command_execution') emit(runId, { t: 'tool', kind: 'run', label: `$ ${it.command}${it.exit_code ? `  (exit ${it.exit_code})` : ''}` });
    else if (it.type === 'file_change') {
      for (const ch of it.changes || []) {
        emit(runId, { t: 'tool', kind: 'edit', label: `${ch.kind === 'add' ? 'Created' : ch.kind === 'delete' ? 'Deleted' : 'Edited'} ${relOut(ch.path)}` });
        emit(runId, { t: 'file', path: relOut(ch.path) });
      }
    }
    else if (it.type === 'mcp_tool_call') emit(runId, { t: 'tool', kind: 'tool', label: `${it.server}: ${it.tool}` });
    else if (it.type === 'web_search') emit(runId, { t: 'tool', kind: 'web', label: `Searched the web for ${it.query}` });
    else if (it.type === 'todo_list') emit(runId, { t: 'tool', kind: 'todo', label: 'Updated its to-do list' });
    else if (it.type === 'error' && it.message) emit(runId, { t: 'note', text: it.message });
  } else if (d.type === 'error') ctx.lastError = codexError(d.message || '');
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

async function geminiTool(runId, name, a = {}) {
  if (name === 'list_files') {
    const entries = await fsp.readdir(resolveIn(a.path || '.'), { withFileTypes: true });
    emit(runId, { t: 'tool', kind: 'read', label: `Listed ${a.path && a.path !== '.' ? a.path : 'the project'}` });
    return entries.slice(0, 500).map(d => d.name + (d.isDirectory() ? '/' : '')).join('\n');
  }
  if (name === 'read_file') {
    const abs = resolveIn(a.path);
    const st = await fsp.stat(abs);
    emit(runId, { t: 'tool', kind: 'read', label: `Read ${relOut(abs)}` });
    if (st.size > 400 * 1024) return 'File is too large to read.';
    return fsp.readFile(abs, 'utf8');
  }
  if (name === 'search_files') {
    emit(runId, { t: 'tool', kind: 'search', label: `Searched for ${a.query}` });
    const hits = await searchProject(String(a.query || ''), false);
    return hits.slice(0, 100).map(h => `${h.path}:${h.line + 1}: ${h.text}`).join('\n') || 'No matches.';
  }
  if (name === 'write_file') {
    const abs = resolveIn(a.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, String(a.content ?? ''), 'utf8');
    emit(runId, { t: 'tool', kind: 'edit', label: `Wrote ${relOut(abs)}` });
    emit(runId, { t: 'file', path: relOut(abs) });
    return 'Saved.';
  }
  throw new Error(`Unknown tool ${name}`);
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
  const build = mode === 'build';
  const system = [
    `You are Breeze, a coding agent working inside the user's project folder "${path.basename(root)}".`,
    'Use the tools to look at the project before answering. Keep replies short and friendly.',
    build ? 'You may change files with write_file; always write the complete file.' : 'Do not change any files.',
    mode === 'plan' ? 'Reply with a short numbered plan of the changes you would make.' : '',
  ].join(' ');
  const tools = [{ functionDeclarations: GEMINI_TOOLS.filter(t => build || t.name !== 'write_file') }];
  run.abort = new AbortController();
  const started = Date.now();
  let tokens = 0, lastText = '';
  for (let turn = 0; turn < 30 && !run.stopped; turn++) {
    let r;
    try {
      r = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents, tools, systemInstruction: { parts: [{ text: system }] } }),
        signal: run.abort.signal,
      });
    } catch (err) { if (run.stopped) break; throw err; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Gemini answered with status ${r.status}`);
    tokens += j.usageMetadata?.totalTokenCount || 0;
    const content = j.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new Error(`Gemini returned no answer (${j.candidates?.[0]?.finishReason || 'empty response'})`);
    contents.push(content);
    const replies = [];
    for (const part of content.parts) {
      if (part.text && !part.thought) { lastText = part.text; emit(runId, { t: 'text', text: part.text }); }
      if (part.functionCall) {
        let result;
        try { result = await geminiTool(runId, part.functionCall.name, part.functionCall.args); }
        catch (err) { result = `Error: ${err.message}`; }
        replies.push({ functionResponse: { name: part.functionCall.name, response: { result } } });
      }
    }
    if (!replies.length) break;
    contents.push({ role: 'user', parts: replies });
  }
  runs.delete(runId);
  if (run.stopped) { emit(runId, { t: 'done', ok: false, stopped: true }); return; }
  if (mode === 'plan' && lastText) emit(runId, { t: 'plan', text: lastText });
  emit(runId, { t: 'done', ok: true, ms: Date.now() - started, tokens });
}

/* ================= Git ================= */
function git(args, { input, timeout = 60000 } = {}) {
  return new Promise((res, rej) => {
    const child = execFile('git', args, {
      cwd: resolveIn(''), windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout)));
    if (input != null) child.stdin.end(input);
  });
}
const checkPaths = paths => (Array.isArray(paths) ? paths : [paths]).map(p => { resolveIn(p); return p; });
const HASH = /^[0-9a-f]{4,40}$/i;

ipcMain.handle('git:status', async () => {
  if (!root) return { repo: false };
  let top;
  try { top = (await git(['rev-parse', '--show-toplevel'])).trim(); } catch { return { repo: false }; }
  const out = await git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const res = { repo: true, branch: '', upstream: '', ahead: 0, behind: 0, hasCommits: true, hasRemote: false, files: [] };
  res.hasRemote = !!(await git(['remote']).catch(() => '')).trim();
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const head = e.slice(3);
      if (head.startsWith('No commits yet on ')) { res.hasCommits = false; res.branch = head.slice(18); continue; }
      const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head) || [];
      res.branch = m[1] === 'HEAD (no branch)' ? 'detached' : m[1] || '';
      res.upstream = m[2] || '';
      res.ahead = Number(/ahead (\d+)/.exec(m[3] || '')?.[1] || 0);
      res.behind = Number(/behind (\d+)/.exec(m[3] || '')?.[1] || 0);
      continue;
    }
    const x = e[0], y = e[1];
    const rel = path.relative(root, path.join(top, e.slice(3)));
    if (x === 'R' || x === 'C') i++; // the next entry is the original path
    if (rel.startsWith('..')) continue; // outside the open folder
    res.files.push({ path: rel.split(path.sep).join('/'), x, y });
  }
  return res;
});

ipcMain.handle('git:log', async () => {
  let out;
  try { out = await git(['log', '--all', '--topo-order', '-n', '150', '-z', '--pretty=format:%H%x1f%P%x1f%an%x1f%ar%x1f%D%x1f%s']); }
  catch { return { head: null, commits: [] }; }
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
  for (const f of files) {
    checkPaths(f.path);
    if (f.untracked) await shell.trashItem(resolveIn(f.path));
    else await git(['restore', '--worktree', '--', f.path]);
  }
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
  shell.openExternal(dc.verification_uri);
  let interval = (dc.interval || 5) * 1000;
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  let token = null;
  while (!token) {
    if (Date.now() > deadline) throw new Error('The code expired. Try again.');
    await sleep(interval, signal);
    const t = await post('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: dc.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (t.access_token) token = t.access_token;
    else if (t.error === 'slow_down') interval += 5000;
    else if (t.error !== 'authorization_pending') throw new Error(t.error_description || t.error);
  }
  setSecret('githubToken', token);
  const u = await (await fetch('https://api.github.com/user', {
    signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Breeze-IDE' },
  })).json();
  return { provider: 'GitHub', name: u.name || u.login, login: u.login, email: u.email || null, avatar: u.avatar_url || null };
}

// Google: authorization code + PKCE through a one-shot loopback server on 127.0.0.1.
async function googleSignIn({ clientId, clientSecret }, signal) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  let redirect = '';
  const code = await new Promise((res, rej) => {
    const server = http.createServer((req, resp) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { resp.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><title>Breeze</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#f5f5f7;font-family:system-ui"><div style="text-align:center"><h2>${ok ? 'You are signed in to Breeze' : 'Sign-in did not finish'}</h2><p style="color:#a1a1aa">You can close this tab and go back to Breeze.</p></div>`);
      server.close();
      if (ok) res(u.searchParams.get('code'));
      else rej(new Error(u.searchParams.get('error') || 'Sign-in did not finish'));
    });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile',
        code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
      }).toString();
      shell.openExternal(auth.href);
      authEmit({ t: 'waiting', provider: 'Google' });
    });
    signal.addEventListener('abort', () => { server.close(); rej(new Error('cancelled')); }, { once: true });
  });
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
