/* Breeze IDE — renderer logic.
   Files, search, terminal and agent detection are real in the desktop app (main.js + preload.js).
   Opened in a plain browser, a small in-memory demo project stands in for the disk.
   Agent conversations, checkpoints and collaboration are still simulated. */

/* ================= Types ================= */
type AgentKey = 'planner' | 'builder';
type AgentStatus = 'idle' | 'working' | 'waiting' | 'done';
type Role = 'Host' | 'Editor' | 'Viewer';

interface Agent {
  name: string;
  letter: string;
  color: string;
  model: string;
  status: AgentStatus;
  task: string;
  used: number;
}
interface Commit {
  id: string;
  msg: string;
  agent: AgentKey | null;
  time: string;
  lane: number;
  files: [name: string, added: number, removed: number][];
}
interface Person { name: string; role: Role; color: string; }
interface GuestCursor { file: string; line: number; name: string; color: string; }
interface User { name: string; provider: string; login?: string; email?: string | null; avatar?: string | null; }
type AgentMode = 'plan' | 'build' | 'ask';
interface AgentEvent { t: 'session' | 'text' | 'plan' | 'tool' | 'file' | 'note' | 'error' | 'done'; id?: string; model?: string; text?: string; kind?: string; label?: string; path?: string; hint?: string; action?: string; ok?: boolean; stopped?: boolean; cost?: number; ms?: number; tokens?: number; }
interface AuthEvent { t: 'code' | 'waiting' | 'done' | 'error'; provider?: string; code?: string; uri?: string; user?: User; text?: string; }
interface GitFile { path: string; x: string; y: string; }
interface GitStatus { repo: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; hasCommits?: boolean; hasRemote?: boolean; files?: GitFile[]; }
interface GitCommit { hash: string; parents: string[]; author: string; when: string; refs: string[]; subject: string; }
interface GitCommitDetail { hash: string; author: string; email: string; when: string; message: string; files: { path: string; added: number; removed: number }[]; }

interface DirEntry { name: string; dir: boolean; }
interface FileRead { text?: string; binary?: boolean; tooLarge?: boolean; size: number; }
interface RootInfo { root: string; name: string; }
interface SearchHit { path: string; line: number; col: number; text: string; }
interface DetectedAgent { id: string; name: string; vendor: string; url: string; found: boolean; path: string | null; version: string | null; api?: boolean; }
interface DetectedTool { id: string; name: string; found: boolean; version: string | null; }
interface Detection { agents: DetectedAgent[]; tools: DetectedTool[]; platform: string; demo?: boolean; }

interface BreezeApi {
  fs: {
    openFolder(): Promise<RootInfo | null>;
    restore(): Promise<RootInfo | null>;
    closeFolder(): Promise<void>;
    recent(): Promise<{ path: string; name: string }[]>;
    openRecent(dir: string): Promise<RootInfo>;
    readDir(rel: string): Promise<DirEntry[]>;
    readFile(rel: string): Promise<FileRead>;
    writeFile(rel: string, text: string): Promise<void>;
    createFile(rel: string): Promise<void>;
    createDir(rel: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    trash(rel: string): Promise<void>;
    listFiles(): Promise<string[]>;
    search(query: string, matchCase: boolean): Promise<SearchHit[]>;
    fileUrl(rel: string): Promise<string>;
    onChange(cb: (paths: string[]) => void): () => void;
  };
  term: {
    cwd(): Promise<string>;
    run(command: string): Promise<{ id?: number; cwd?: string; error?: string }>;
    kill(id: number): Promise<void>;
    onData(cb: (id: number, chunk: string) => void): () => void;
    onExit(cb: (id: number, code: number | null) => void): () => void;
  };
  sys: { detect(): Promise<Detection>; openExternal(url: string): Promise<void>; };
  gemini: { status(): Promise<{ hasKey: boolean; model: string | null }>; setKey(key: string): Promise<{ model: string }>; clearKey(): Promise<void>; };
  agent: {
    run(opts: { agent: string; mode: AgentMode; prompt: string; session: string | null }): Promise<number>;
    stop(runId: number): Promise<void>;
    openApp(id: string): Promise<void>;
    onEvent(cb: (runId: number, ev: AgentEvent) => void): () => void;
  };
  git: {
    status(): Promise<GitStatus>;
    log(): Promise<{ head: string | null; commits: GitCommit[] }>;
    show(hash: string): Promise<GitCommitDetail>;
    diff(rel: string, staged: boolean): Promise<string>;
    init(): Promise<unknown>;
    stage(paths: string[]): Promise<unknown>;
    unstage(paths: string[], hasCommits: boolean): Promise<unknown>;
    discard(files: { path: string; untracked: boolean }[]): Promise<void>;
    commit(message: string, all: boolean): Promise<string>;
    branches(): Promise<string[]>;
    switchTo(name: string, create: boolean, from?: string): Promise<unknown>;
    sync(op: 'fetch' | 'pull' | 'push'): Promise<unknown>;
  };
  auth: {
    user(): Promise<User | null>;
    start(provider: string): Promise<{ started?: boolean; error?: string }>;
    cancel(): Promise<void>;
    signOut(): Promise<void>;
    onEvent(cb: (ev: AuthEvent) => void): () => void;
  };
  win: { reload(): Promise<void>; toggleDevTools(): Promise<void>; quit(): Promise<void>; edit(role: string): Promise<void>; };
}
interface Window { breeze?: BreezeApi; }

/* ================= Helpers ================= */
function $<T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document): T {
  return r.querySelector(s) as T;
}
function $$<T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document): T[] {
  return [...r.querySelectorAll<T>(s)];
}
const esc = (s: string): string => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
// IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message.
const errMsg = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

function toast(text: string): void {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  $('#toastRoot').replaceChildren(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 2600);
}

const store = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked or full */ }
  },
  del(key: string): void {
    try { localStorage.removeItem(key); } catch { /* storage blocked */ }
  },
};

/* ================= Platform (desktop bridge or in-browser demo) ================= */
const DEMO_FILES: Record<string, string> = {
  'index.html': `<!-- Brewed by Breeze -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ember &amp; Oak Coffee</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="hero">
    <h1>Ember &amp; Oak</h1>
    <p>Slow coffee for fast mornings.</p>
    <a href="#menu" class="cta">See the menu</a>
  </header>
  <section id="menu"></section>
  <script src="script.js"></script>
</body>
</html>
`,
  'styles.css': `/* Cozy, warm palette */
:root {
  --bean: #2b1d12;
  --cream: #f4ece1;
  --ember: #c2410c;
}
body { margin: 0; font-family: Georgia, serif; background: var(--cream); color: var(--bean); }
.hero {
  padding: 96px 24px;
  text-align: center;
}
.cta { background: var(--ember); color: #fff; padding: 10px 18px; border-radius: 999px; }
`,
  'script.js': `// Small touch: greet by time of day
const h = new Date().getHours();
const hello = h < 12 ? "Good morning" : "Hey there";
document.querySelector(".hero p").prepend(hello + ". ");
`,
  '.env': `# Protected — agents can't read this without your OK
MAPS_KEY=demo-key-not-real
`,
  'assets/beans.jpg': '',
};

let demoRun = 0;
const agentListeners: ((runId: number, ev: AgentEvent) => void)[] = [];
const authListeners: ((ev: AuthEvent) => void)[] = [];
function demoApi(): BreezeApi {
  const files = new Map(Object.entries(DEMO_FILES));
  const binary = new Set(['assets/beans.jpg']);
  const dirs = new Set(['assets']);
  const info: RootInfo = { root: 'demo:/coffee-shop-landing', name: 'coffee-shop-landing' };
  const under = (p: string, rel: string) => (rel ? p.startsWith(rel + '/') : true);
  const exists = (p: string) => files.has(p) || dirs.has(p);
  const needOpen = () => { if (!store.get('breeze.demoOpen', false)) throw new Error('No folder is open'); };
  return {
    fs: {
      async openFolder() { store.set('breeze.demoOpen', true); return info; },
      async restore() { return store.get('breeze.demoOpen', false) ? info : null; },
      async closeFolder() { store.del('breeze.demoOpen'); },
      async recent() { return [{ path: info.root, name: info.name }]; },
      async openRecent() { store.set('breeze.demoOpen', true); return info; },
      async readDir(rel) {
        needOpen();
        const seen = new Map<string, boolean>();
        const depth = rel ? rel.split('/').length : 0;
        for (const d of dirs) if (under(d, rel) && d.split('/').length === depth + 1) seen.set(baseName(d), true);
        for (const f of files.keys()) if (under(f, rel) && f.split('/').length === depth + 1) seen.set(baseName(f), false);
        return [...seen].map(([name, dir]) => ({ name, dir }))
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      },
      async readFile(rel) {
        if (!files.has(rel)) throw new Error('File not found');
        return binary.has(rel) ? { binary: true, size: 48213 } : { text: files.get(rel), size: (files.get(rel) ?? '').length };
      },
      async writeFile(rel, text) { files.set(rel, text); },
      async createFile(rel) { if (exists(rel)) throw new Error('A file with that name already exists'); files.set(rel, ''); },
      async createDir(rel) { if (exists(rel)) throw new Error('A folder with that name already exists'); dirs.add(rel); },
      async rename(from, to) {
        if (exists(to)) throw new Error('Something with that name already exists');
        const move = <T>(set: Map<string, T> | Set<string>) => {
          for (const k of [...set.keys()]) {
            if (k !== from && !k.startsWith(from + '/')) continue;
            const nk = to + k.slice(from.length);
            if (set instanceof Map) { set.set(nk, set.get(k) as T); set.delete(k); } else { set.delete(k); set.add(nk); }
          }
        };
        move(files); move(dirs); move(binary);
      },
      async trash(rel) {
        for (const set of [files, dirs, binary]) for (const k of [...set.keys()]) if (k === rel || k.startsWith(rel + '/')) set.delete(k);
      },
      async listFiles() { return [...files.keys()]; },
      async search(query, matchCase) {
        const out: SearchHit[] = [];
        const needle = matchCase ? query : query.toLowerCase();
        for (const [path, text] of files) {
          if (binary.has(path)) continue;
          text.split('\n').forEach((line, i) => {
            const col = (matchCase ? line : line.toLowerCase()).indexOf(needle);
            if (col !== -1) out.push({ path, line: i, col, text: line });
          });
        }
        return out;
      },
      async fileUrl() { return ''; },
      onChange() { return () => {}; },
    },
    term: {
      async cwd() { return 'coffee-shop-landing'; },
      async run() { return { error: 'The terminal runs commands only in the Breeze desktop app (npm start).' }; },
      async kill() {},
      onData() { return () => {}; },
      onExit() { return () => {}; },
    },
    sys: {
      async detect() {
        await wait(500);
        return {
          demo: true, platform: 'browser',
          agents: [
            { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', url: 'https://claude.com/product/claude-code', found: true, path: null, version: null },
            { id: 'codex', name: 'Codex', vendor: 'OpenAI', url: 'https://developers.openai.com/codex/cli', found: false, path: null, version: null },
            { id: 'antigravity', name: 'Antigravity', vendor: 'Google', url: 'https://antigravity.google', found: false, path: null, version: null },
            { id: 'gemini', name: 'Gemini', vendor: 'Google', url: 'https://aistudio.google.com/apikey', api: true, found: store.get('breeze.demoKey', false), path: null, version: store.get('breeze.demoKey', false) ? 'gemini-flash-latest' : null },
          ],
          tools: [{ id: 'git', name: 'Git', found: true, version: null }, { id: 'node', name: 'Node.js', found: true, version: null }],
        };
      },
      async openExternal(url) { window.open(url, '_blank', 'noopener'); },
    },
    // Browser preview only: canned answers so every panel can be tried without the desktop app.
    gemini: {
      async status() { return { hasKey: store.get('breeze.demoKey', false), model: 'gemini-flash-latest' }; },
      async setKey(key) { await wait(600); if (key.trim().length < 10) throw new Error('API key not valid. Please pass a valid API key.'); store.set('breeze.demoKey', true); return { model: 'gemini-flash-latest' }; },
      async clearKey() { store.del('breeze.demoKey'); },
    },
    agent: {
      async run({ mode }) {
        const id = ++demoRun;
        (async () => {
          const say = async (ev: AgentEvent, ms = 500) => { await wait(ms); agentListeners.forEach(cb => cb(id, ev)); };
          await say({ t: 'session', id: 'demo-session', model: 'demo' }, 100);
          await say({ t: 'tool', kind: 'read', label: 'Read index.html' });
          await say({ t: 'tool', kind: 'read', label: 'Read styles.css' });
          if (mode === 'build') {
            await say({ t: 'tool', kind: 'edit', label: 'Edited styles.css' });
            await say({ t: 'text', text: 'Done — I warmed up the hero colours in styles.css. (Browser preview: no files were really changed.)' });
          } else if (mode === 'plan') {
            await say({ t: 'text', text: 'I looked at the page and its styles.' });
            await say({ t: 'plan', text: '1. Make the hero taller with a warm gradient\n2. Turn the menu into three cards\n3. Add a footer with opening hours' });
          } else await say({ t: 'text', text: 'The page has a hero section, an empty menu section and a small greeting script. (Browser preview answer.)' });
          await say({ t: 'done', ok: true, ms: 2400 }, 300);
        })();
        return id;
      },
      async stop() {},
      async openApp() {},
      onEvent(cb) { agentListeners.push(cb); return () => {}; },
    },
    git: {
      async status() {
        return { repo: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, hasCommits: true, hasRemote: true,
          files: [{ path: 'styles.css', x: ' ', y: 'M' }, { path: 'index.html', x: 'M', y: ' ' }, { path: 'assets/new-logo.svg', x: '?', y: '?' }] };
      },
      async log() {
        return { head: 'd4f0b19aa', commits: [
          { hash: 'd4f0b19aa', parents: ['b72e1d0aa'], author: 'You', when: '3 minutes ago', refs: ['HEAD -> main'], subject: 'Greeting script' },
          { hash: 'c3d5a8eaa', parents: ['b72e1d0aa'], author: 'You', when: '6 minutes ago', refs: ['try-dark-menu'], subject: 'Try dark menu' },
          { hash: 'b72e1d0aa', parents: ['a91f3c2aa'], author: 'You', when: '9 minutes ago', refs: [], subject: 'Add base styles' },
          { hash: 'a91f3c2aa', parents: [], author: 'You', when: '12 minutes ago', refs: ['origin/main'], subject: 'Start project' },
        ] };
      },
      async show(hash) { return { hash, author: 'You', email: 'you@example.com', when: 'a few minutes ago', message: 'Demo checkpoint', files: [{ path: 'styles.css', added: 11, removed: 2 }] }; },
      async diff() { return '@@ -1,3 +1,3 @@\n /* Cozy, warm palette */\n-:root {\n+:root { /* demo change */\n   --bean: #2b1d12;'; },
      async init() { return ''; },
      async stage() { return ''; },
      async unstage() { return ''; },
      async discard() {},
      async commit() { throw new Error('Checkpoints are saved with git in the desktop app.'); },
      async branches() { return ['main', 'try-dark-menu']; },
      async switchTo() { throw new Error('Switching branches works in the desktop app.'); },
      async sync() { throw new Error('Push and pull work in the desktop app.'); },
    },
    auth: {
      async user() { return null; },
      async start(provider) {
        setTimeout(() => authListeners.forEach(cb => cb({ t: 'done', user: { provider, name: 'Demo user', login: 'demo' } })), 1400);
        return { started: true };
      },
      async cancel() {},
      async signOut() {},
      onEvent(cb) { authListeners.push(cb); return () => {}; },
    },
    win: {
      async reload() { location.reload(); },
      async toggleDevTools() { toast('Developer tools are available in the desktop app'); },
      async quit() { window.close(); },
      async edit(role) { document.execCommand(role); },
    },
  };
}

const isDesktop = !!window.breeze;
const api: BreezeApi = window.breeze ?? demoApi();

/* ================= App state (survives reloads) ================= */
interface AppState { onboarded: boolean; step: number; user: User | null; agent: string | null; detect: Detection | null; }
const appState: AppState = { onboarded: false, step: 0, user: null, agent: null, detect: null, ...store.get<Partial<AppState>>('breeze.app', {}) };
const saveApp = () => store.set('breeze.app', appState);

/* ================= Onboarding ================= */
let step = appState.step;
let user: User | null = appState.user;
function goStep(n: number): void {
  step = n; appState.step = n; saveApp();
  $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
  $$('.ob-dots span').forEach((d, i) => d.classList.toggle('on', i === n));
  if (n === 2) { detectTools(); renderProjectChoice(); }
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));

/* ----- Sign in (GitHub device flow / Google loopback, handled in main.js) ----- */
function setUser(u: User | null): void {
  user = u; appState.user = u; saveApp();
  renderUser();
}
function renderUser(): void {
  const initials = (user?.name ?? 'You').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const me = user?.avatar
    ? `<img class="avatar" src="${escAttr(user.avatar)}" alt="" title="${escAttr(user.name)} (host)">`
    : `<span class="avatar" style="background:#7aa9ff" title="${escAttr(user?.name ?? 'You')} (host)">${esc(initials)}</span>`;
  $('#avatars').innerHTML = me + guests.map(g => `<span class="avatar" style="background:${g.color}" title="${g.name} (${g.role})">${g.name.slice(0, 2).toUpperCase()}</span>`).join('');
  $('#userChip').textContent = user ? `● ${user.name} · ${user.provider}` : 'Not signed in';
}
function signinView(waiting: boolean): void {
  $('#signinChoices').classList.toggle('hidden', waiting);
  $('#signinWait').classList.toggle('hidden', !waiting);
  if (waiting) { $('#signinError').classList.add('hidden'); $('#signinCode').classList.add('hidden'); }
}
function signinError(text: string): void {
  signinView(false);
  $('#signinError').textContent = text;
  $('#signinError').classList.remove('hidden');
}
async function startSignIn(provider: string): Promise<void> {
  signinView(true);
  $('#signinMsg').textContent = `Opening ${provider} in your browser…`;
  const r = await api.auth.start(provider).catch(e => ({ error: errMsg(e) }) as { error?: string });
  if (r.error === 'not-configured') {
    signinError(`${provider} sign-in isn't set up for this copy of Breeze yet. Add a ${provider} OAuth client ID to breeze.config.json (see breeze.config.example.json) and restart Breeze — or continue without signing in.`);
  } else if (r.error) signinError(r.error);
}
$$('[data-signin]').forEach(b => b.onclick = () => startSignIn(b.dataset.signin ?? 'GitHub'));
$('#signinCancel').onclick = () => { api.auth.cancel(); signinView(false); };
$('#signinSkip').onclick = () => goStep(2);
$('#copyCode').onclick = () => { navigator.clipboard?.writeText($('#codeText').textContent ?? '').catch(() => {}); toast('Code copied'); };
api.auth.onEvent(ev => {
  if (ev.t === 'code') {
    $('#signinMsg').textContent = 'Enter this code on the GitHub page that just opened:';
    $('#codeText').textContent = ev.code ?? '';
    $('#signinCode').classList.remove('hidden');
    $('#openCodePage').onclick = () => api.sys.openExternal(ev.uri ?? 'https://github.com/login/device');
  } else if (ev.t === 'waiting') {
    $('#signinMsg').textContent = `Finish signing in with ${ev.provider} in your browser…`;
  } else if (ev.t === 'done' && ev.user) {
    setUser(ev.user);
    signinView(false);
    toast(`Signed in as ${ev.user.name}`);
    if (!appState.onboarded && step === 1) goStep(2);
  } else if (ev.t === 'error') signinError(ev.text ?? 'Sign-in failed');
});

/* ----- AI agent detection ----- */
const AGENT_STYLE: Record<string, { letter: string; color: string }> = {
  claude: { letter: 'C', color: '#d97757' },
  codex: { letter: 'Cx', color: '#e4e4e7' },
  antigravity: { letter: 'A', color: '#7aa9ff' },
  gemini: { letter: 'G', color: '#a78bfa' },
};
let detecting: Promise<Detection> | null = null;

function detectTools(): Promise<Detection> {
  if (detecting) return detecting;
  $('#aiPill').className = 'pill'; $('#aiPill').textContent = 'Scanning…';
  $('#toolsPill').className = 'pill'; $('#toolsPill').textContent = 'Scanning…';
  if (!appState.detect) $('#agentList').innerHTML = '<div class="row" style="color:var(--text-3)"><div class="spinner" style="width:16px;height:16px;border-width:2px"></div>Checking this computer…</div>';
  detecting = api.sys.detect().then(d => {
    appState.detect = d;
    fixSelectedAgent();
    renderDetection();
    return d;
  }).catch(e => {
    $('#aiPill').className = 'pill warn'; $('#aiPill').textContent = 'Scan failed';
    $('#aiHint').textContent = errMsg(e);
    throw e;
  }).finally(() => { detecting = null; });
  return detecting;
}
// Keep the chosen agent if it is still usable, else fall back to the first one that is.
function fixSelectedAgent(): void {
  const found = appState.detect?.agents.filter(a => a.found) ?? [];
  if (!appState.agent || !found.some(a => a.id === appState.agent)) appState.agent = found[0]?.id ?? null;
  saveApp();
}

function agentOptionsHtml(d: Detection): string {
  return d.agents.map(a => {
    const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], color: '#a1a1aa' };
    const on = a.found && a.id === appState.agent;
    const mark = `<span class="mark" style="background:${st.color}">${st.letter}</span>`;
    if (a.api) {
      const side = a.found
        ? `<span class="side row" style="gap:6px"><span class="pill ${on ? 'blue' : 'ok'}">${on ? 'Selected' : 'Ready'}</span><button class="get" data-clearkey title="Remove the saved key">Remove</button></span>`
        : `<button class="get side" data-get="${escAttr(a.url)}">Get a key ↗</button>`;
      const sub = a.found ? `API key saved securely${a.version ? ` · ${a.version}` : ''}` : 'Uses your own Google AI Studio API key';
      return `<div class="agent-opt api ${a.found ? '' : 'missing'} ${on ? 'on' : ''}" ${a.found ? `role="button" tabindex="0" data-agent="${a.id}"` : ''}>
        ${mark}<span class="nm">${esc(a.name)} <small>API</small></span>${side}
        <span class="sub">${esc(sub)}</span>
        ${a.found ? '' : `<div class="key-row"><input class="input" type="password" placeholder="Paste your Gemini API key" autocomplete="off" spellcheck="false" data-key><button class="btn btn-sm" data-savekey>Save key</button></div><div class="key-err hidden"></div>`}</div>`;
    }
    const sub = a.found
      ? [a.version ? `v${a.version}` : 'Installed', a.path ?? (d.demo ? 'browser preview' : '')].filter(Boolean).join(' · ')
      : `${a.vendor} · not installed`;
    const side = a.found
      ? `<span class="pill ${on ? 'blue' : 'ok'} side">${on ? 'Selected' : 'Detected'}</span>`
      : `<button class="get side" data-get="${escAttr(a.url)}">Get it ↗</button>`;
    return `<div class="agent-opt ${a.found ? '' : 'missing'} ${on ? 'on' : ''}" ${a.found ? `role="button" tabindex="0" data-agent="${a.id}"` : ''}>
      ${mark}<span class="nm">${esc(a.name)}</span>${side}
      <span class="sub" title="${escAttr(sub)}">${esc(sub)}</span></div>`;
  }).join('');
}
function bindAgentOptions(root: HTMLElement, onChange: () => void): void {
  $$('[data-agent]', root).forEach(el => {
    const pick = () => { appState.agent = el.dataset.agent ?? null; saveApp(); onChange(); };
    el.onclick = e => { if (!(e.target as HTMLElement).closest('button, input')) pick(); };
    el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); pick(); } };
  });
  $$('[data-get]', root).forEach(b => b.onclick = e => { e.stopPropagation(); api.sys.openExternal(b.dataset.get ?? ''); });
  const gemini = () => appState.detect?.agents.find(a => a.id === 'gemini');
  const input = root.querySelector<HTMLInputElement>('[data-key]');
  const saveBtn = root.querySelector<HTMLButtonElement>('[data-savekey]');
  if (input && saveBtn) {
    const save = async () => {
      const err = root.querySelector<HTMLElement>('.key-err');
      saveBtn.disabled = true; saveBtn.textContent = 'Checking…';
      try {
        const { model } = await api.gemini.setKey(input.value);
        const g = gemini();
        if (g) { g.found = true; g.version = model; }
        if (!selectedAgent()) appState.agent = 'gemini';
        saveApp();
        toast('Gemini key saved');
        onChange();
      } catch (e) {
        saveBtn.disabled = false; saveBtn.textContent = 'Save key';
        if (err) { err.textContent = errMsg(e); err.classList.remove('hidden'); }
      }
    };
    saveBtn.onclick = save;
    input.onkeydown = e => { if (e.key === 'Enter') save(); };
  }
  root.querySelector<HTMLElement>('[data-clearkey]')?.addEventListener('click', async e => {
    e.stopPropagation();
    await api.gemini.clearKey();
    const g = gemini();
    if (g) { g.found = false; g.version = null; }
    fixSelectedAgent();
    onChange();
  });
}

function renderDetection(): void {
  const d = appState.detect;
  if (!d) return;
  const found = d.agents.filter(a => a.found);
  $('#agentList').innerHTML = agentOptionsHtml(d);
  bindAgentOptions($('#agentList'), renderDetection);
  $('#aiPill').className = found.length ? 'pill ok' : 'pill warn';
  $('#aiPill').textContent = found.length ? `${found.length} ready` : 'None ready';
  $('#aiHint').textContent = found.length
    ? 'Pick the agent Breeze hands work to. Installed agents use their own sign-in; Gemini uses your API key.'
    : 'No coding agent found. Install one and rescan, or paste a Gemini API key.';
  if (d.demo) $('#aiHint').textContent += ' (Browser preview.)';

  $('#toolList').innerHTML = d.tools.map(t => t.found
    ? `<span class="pill ok">${t.name}${t.version ? ' ' + esc(t.version) : ''} ready</span>`
    : `<span class="pill warn">${t.name} missing</span><button class="btn btn-sm" data-get="${t.id === 'git' ? 'https://git-scm.com/downloads' : 'https://nodejs.org/en/download'}">Get ${t.name} ↗</button>`).join('');
  $$('[data-get]', $('#toolList')).forEach(b => b.onclick = () => api.sys.openExternal(b.dataset.get ?? ''));
  const missing = d.tools.filter(t => !t.found).map(t => t.name);
  $('#toolsPill').className = missing.length ? 'pill warn' : 'pill ok';
  $('#toolsPill').textContent = missing.length ? `${missing.join(' & ')} missing` : 'Ready';

  const sb = $('#sbTools');
  sb.innerHTML = `<span class="${missing.length ? 'dot-warn' : 'dot-ok'}"></span> ${d.tools.map(t => `${t.name.replace('.js', '')} ${t.found ? 'ready' : 'missing'}`).join(' · ')}`;
  renderAgentPill();
}
$('#rescan').onclick = () => { detectTools(); };

function selectedAgent(): DetectedAgent | null {
  return appState.detect?.agents.find(a => a.id === appState.agent && a.found) ?? null;
}
function renderAgentPill(): void {
  const a = selectedAgent();
  $('#agentPill').textContent = a ? a.name : 'Choose an agent';
  agentsDef.planner.model = agentsDef.builder.model = a ? (a.api && a.version ? a.version : a.name) : 'no agent';
  renderAgents();
}
$('#agentPill').onclick = openAgentPicker;
function openAgentPicker(): void {
  openModal(`<h3>Choose your AI agent</h3><p class="sub">Installed coding agents are found automatically. Gemini works with an API key.</p>
    <div class="agent-list" id="pickList"></div>
    <div class="row" style="justify-content:space-between;margin-top:16px"><button class="btn btn-sm btn-ghost" id="pickRescan">Scan again</button><button class="btn btn-primary" data-close>Done</button></div>`, m => {
    const render = () => {
      if (!appState.detect) { $('#pickList', m).innerHTML = '<div style="color:var(--text-3)">Scanning…</div>'; return; }
      $('#pickList', m).innerHTML = agentOptionsHtml(appState.detect);
      bindAgentOptions($('#pickList', m), () => { render(); renderDetection(); });
    };
    render();
    $('#pickRescan', m).onclick = () => { $('#pickList', m).innerHTML = '<div style="color:var(--text-3)">Scanning…</div>'; detectTools().then(render, () => {}); };
  });
}

/* ----- Start a project ----- */
let projMode = 'describe';
function renderProjectChoice(): void {
  $$('[data-seg]').forEach(x => x.classList.toggle('on', x.dataset.seg === projMode));
  $('#projPrompt').classList.toggle('hidden', projMode !== 'describe');
  $('#projFolderRow').classList.toggle('hidden', projMode !== 'folder');
  $('#projFolder').textContent = rootInfo ? rootInfo.root : 'No folder chosen';
}
$$('[data-seg]').forEach(b => b.onclick = () => { projMode = b.dataset.seg ?? 'describe'; renderProjectChoice(); });
$('#pickFolder').onclick = async () => {
  const r = await api.fs.openFolder();
  if (r) { await loadWorkspace(r); renderProjectChoice(); }
};
$('#startBuilding').onclick = () => {
  appState.onboarded = true; saveApp();
  showIde();
  const p = $<HTMLInputElement>('#projPrompt').value.trim();
  if (projMode === 'describe' && p) $<HTMLTextAreaElement>('#prompt').value = p;
};
function showIde(): void {
  $('#onboard').classList.add('hidden'); $('#ide').classList.remove('hidden');
  renderUser();
  applyLayout();
  renderEditor();
}

/* ================= Agents (data) ================= */
const agentsDef: Record<AgentKey, Agent> = {
  planner: { name: 'Planner', letter: 'P', color: 'var(--c-planner)', model: 'no agent', status: 'idle', task: 'Waiting for a prompt', used: 0 },
  builder: { name: 'Builder', letter: 'B', color: 'var(--c-builder)', model: 'no agent', status: 'idle', task: 'Waiting for a plan', used: 0 },
};
const statusLabel: Record<AgentStatus, string> = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', done: 'Done' };

/* ================= Languages & highlighting ================= */
type Tok = [cls: string | null, text: string];
const LANGS: Record<string, [lexer: string, name: string]> = {
  html: ['html', 'HTML'], htm: ['html', 'HTML'], xml: ['html', 'XML'], svg: ['html', 'SVG'], vue: ['html', 'Vue'],
  css: ['css', 'CSS'], scss: ['css', 'SCSS'], less: ['css', 'Less'],
  js: ['js', 'JavaScript'], mjs: ['js', 'JavaScript'], cjs: ['js', 'JavaScript'], jsx: ['js', 'JavaScript JSX'],
  ts: ['js', 'TypeScript'], tsx: ['js', 'TypeScript JSX'], mts: ['js', 'TypeScript'], cts: ['js', 'TypeScript'],
  json: ['json', 'JSON'], jsonc: ['js', 'JSON with Comments'],
  md: ['md', 'Markdown'], markdown: ['md', 'Markdown'],
  py: ['py', 'Python'],
};
function langOf(path: string): [lexer: string, name: string] {
  const name = baseName(path).toLowerCase();
  if (name.startsWith('.env')) return ['py', 'Environment'];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return LANGS[ext] ?? ['', 'Plain Text'];
}
const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set type interface enum implements private public protected readonly declare as true false null undefined';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
const STR_RE = String.raw`"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?`;
const NUM_RE = String.raw`\b(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const words = (s: string) => s.split(' ').join('|');
const LEXERS: Record<string, RegExp> = {
  js: new RegExp(String.raw`(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<str>${STR_RE}|\x60(?:\\[\s\S]|[^\x60\\])*\x60?)|(?<num>${NUM_RE})|(?<kw>\b(?:${words(JS_KW)})\b)|(?<prop>\b[A-Za-z_$][\w$]*(?=\())`, 'g'),
  css: new RegExp(String.raw`(?<com>\/\*[\s\S]*?(?:\*\/|$))|(?<str>${STR_RE})|(?<kw>@[\w-]+|!important)|(?<tag>[.#]?-?[A-Za-z_][\w-]*(?=[^{};]*\{))|(?<prop>--?[A-Za-z_][\w-]*(?=\s*:))|(?<num>#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)`, 'g'),
  json: new RegExp(String.raw`(?<prop>"(?:\\.|[^"\\\n])*"(?=\s*:))|(?<str>"(?:\\.|[^"\\\n])*"?)|(?<num>-?${NUM_RE})|(?<kw>\b(?:true|false|null)\b)`, 'g'),
  py: new RegExp(String.raw`(?<com>#[^\n]*)|(?<str>"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${STR_RE})|(?<num>${NUM_RE})|(?<kw>\b(?:${words(PY_KW)})\b)|(?<prop>\b[A-Za-z_]\w*(?=\())`, 'g'),
  md: new RegExp(String.raw`(?<kw>^#{1,6}[^\n]*)|(?<str>\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)|\x60[^\x60\n]*\x60)|(?<com>^>[^\n]*)|(?<attr>\*\*[^*\n]+\*\*|\[[^\]\n]*\]\([^)\n]*\))`, 'gm'),
  html: /(?<com><!--[\s\S]*?(?:-->|$))|(?<tagblock><[!/]?[A-Za-z][^>]*>?)/g,
};
const HTML_TAG = /(?<tag>^<[!/]?[\w:-]+|\/?>$)|(?<str>"[^"]*"?|'[^']*'?)|(?<attr>[^\s="'<>/]+)/g;

function lex(text: string, re: RegExp): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last) out.push([null, text.slice(last, m.index)]);
    const kind = Object.keys(m.groups ?? {}).find(k => m!.groups![k] !== undefined) ?? null;
    if (kind === 'tagblock') out.push(...lex(m[0], HTML_TAG)); // lex() resets lastIndex of the inner regex only
    else out.push([kind, m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push([null, text.slice(last)]);
  return out;
}
// Highlight a whole document and return one HTML string per line (tokens can span lines).
function highlightLines(text: string, lexer: string): string[] {
  if (!LEXERS[lexer] || text.length > 400000) return text.split('\n').map(esc);
  const re = LEXERS[lexer];
  const toks = lex(text, re);
  const lines: string[] = [''];
  for (const [cls, t] of toks) {
    t.split('\n').forEach((part, i) => {
      if (i > 0) lines.push('');
      if (part) lines[lines.length - 1] += cls ? `<span class="tk-${cls}">${esc(part)}</span>` : esc(part);
    });
  }
  return lines;
}
const COMMENT: Record<string, [string, string]> = { js: ['// ', ''], py: ['# ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };

/* ----- Colored file & folder icons (16×16 inline SVG) ----- */
const svg16 = (body: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
const badge = (bg: string, fg: string, label: string, size = 6.4) =>
  svg16(`<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/><text x="8" y="11.2" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="${size}" fill="${fg}">${label}</text>`);
const page = (color: string, inner = '') =>
  svg16(`<path d="M3.5 1.5h6l3 3v10h-9z" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>${inner}`);
const ICONS: Record<string, string> = {
  html: svg16('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="#f16529" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 3.5-2 9" stroke="#f9a77d" stroke-width="1.4" stroke-linecap="round"/>'),
  css: svg16('<path d="M6.3 2.5 5 13.5M11 2.5 9.7 13.5M2.8 6h11M2.2 10h11" fill="none" stroke="#42a5f5" stroke-width="1.6" stroke-linecap="round"/>'),
  scss: svg16('<circle cx="8" cy="8" r="6.5" fill="#cd6799"/><path d="M10.5 5.5c-1-1-4-.6-4 .9 0 1.6 3.5 1.3 3.5 3 0 1.4-2.6 1.6-3.8.6" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>'),
  js: badge('#f1d33b', '#1e1e1e', 'JS'),
  ts: badge('#3178c6', '#ffffff', 'TS'),
  jsx: svg16('<g fill="none" stroke="#61dafb" stroke-width="1"><ellipse cx="8" cy="8" rx="6.6" ry="2.6"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(120 8 8)"/></g><circle cx="8" cy="8" r="1.4" fill="#61dafb"/>'),
  json: svg16('<path d="M6 2.5c-1.6 0-1.8.8-1.8 2v1.3c0 1-.5 1.7-1.7 1.9v.6c1.2.2 1.7.9 1.7 1.9v1.3c0 1.2.2 2 1.8 2M10 2.5c1.6 0 1.8.8 1.8 2v1.3c0 1 .5 1.7 1.7 1.9v.6c-1.2.2-1.7.9-1.7 1.9v1.3c0 1.2-.2 2-1.8 2" fill="none" stroke="#f5b942" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="#f5b942"/>'),
  md: svg16('<rect x="1" y="3.5" width="14" height="9" rx="2" fill="none" stroke="#6aa8d8" stroke-width="1.2"/><path d="M3.5 10.5v-4l1.8 2 1.8-2v4M11.2 6.3v4M9.6 8.9l1.6 1.6 1.6-1.6" fill="none" stroke="#6aa8d8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  image: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#b388ff" fill-opacity=".18" stroke="#b388ff" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.3" fill="#ffd166"/><path d="m2.5 12.5 4-4 2.5 2.5 1.8-1.8 3 3.3z" fill="#b388ff"/>'),
  svg: svg16('<path d="M8 1.8 14.2 8 8 14.2 1.8 8z" fill="#ffb13b" fill-opacity=".2" stroke="#ffb13b" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.6" fill="#ffb13b"/>'),
  env: svg16('<circle cx="5.5" cy="8" r="3" fill="none" stroke="#e5c07b" stroke-width="1.5"/><path d="M8.5 8h6M12.5 8v2.4M14.5 8v1.6" fill="none" stroke="#e5c07b" stroke-width="1.5" stroke-linecap="round"/>'),
  git: svg16('<path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="#f05033"/><path d="M6.4 5.2v5.6M6.4 6.6 9.6 9.4" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><circle cx="6.4" cy="10.6" r="1" fill="#fff"/><circle cx="9.6" cy="9.4" r="1" fill="#fff"/><circle cx="6.4" cy="5" r="1" fill="#fff"/>'),
  node: svg16('<path d="M8 1.3 13.8 4.6v6.8L8 14.7 2.2 11.4V4.6z" fill="#8cc84b" fill-opacity=".2" stroke="#8cc84b" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 6.2v3.6M10 6.2v3.6M6 6.2l4 3.6" stroke="#8cc84b" stroke-width="1.2" stroke-linecap="round"/>'),
  py: svg16('<path d="M8 1.5c-3 0-3 1.3-3 2.3V6h3.2v.6H3.6C2.3 6.6 1.5 7.6 1.5 9.4s.8 2.9 2 2.9H5V10.5c0-1.2 1-2.2 2.2-2.2h3.3c1 0 1.8-.8 1.8-1.8V3.8c0-1.2-1.2-2.3-4.3-2.3z" fill="#3776ab"/><path d="M8 14.5c3 0 3-1.3 3-2.3V10H7.8v-.6h4.6c1.3 0 2.1-1 2.1-2.8s-.8-2.9-2-2.9H11v1.8c0 1.2-1 2.2-2.2 2.2H5.5c-1 0-1.8.8-1.8 1.8v2.7c0 1.2 1.2 2.3 4.3 2.3z" fill="#ffd43b"/>'),
  shell: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#4caf50" fill-opacity=".14" stroke="#4caf50" stroke-width="1.2"/><path d="m4.3 6 2.2 2-2.2 2M8 10.5h3.5" fill="none" stroke="#4caf50" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  config: page('#c792ea', '<path d="M5.5 8h5M5.5 10.5h3.5" stroke="#c792ea" stroke-width="1.1" stroke-linecap="round"/>'),
  text: page('#a1a1aa', '<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" stroke="#a1a1aa" stroke-width="1" stroke-linecap="round"/>'),
  lock: page('#8b8b95', '<rect x="5.6" y="8.6" width="4.8" height="3.6" rx=".8" fill="#8b8b95"/><path d="M6.6 8.6V7.6a1.4 1.4 0 0 1 2.8 0v1" fill="none" stroke="#8b8b95" stroke-width="1"/>'),
  license: page('#e5c07b', '<circle cx="8" cy="9" r="1.8" fill="none" stroke="#e5c07b" stroke-width="1"/>'),
  file: page('#8b8b95'),
};
const EXT_ICON: Record<string, string> = {
  html: 'html', htm: 'html', xml: 'html', vue: 'html', css: 'css', less: 'css', scss: 'scss', sass: 'scss',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', tsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', json: 'json', jsonc: 'json', md: 'md', markdown: 'md',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image', svg: 'svg',
  py: 'py', sh: 'shell', bash: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell', yml: 'config', yaml: 'config', toml: 'config', ini: 'config',
  txt: 'text', log: 'text', csv: 'text', lock: 'lock',
};
function fileIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith('.env')) return ICONS.env;
  if (n.startsWith('.git')) return ICONS.git;
  if (n === 'package.json' || n === 'package-lock.json' || n === '.npmrc' || n === '.nvmrc') return ICONS.node;
  if (n.startsWith('license')) return ICONS.license;
  if (/^(tsconfig|jsconfig)[\w.-]*\.json$/.test(n)) return ICONS.ts;
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
  return ICONS[EXT_ICON[ext] ?? 'file'];
}
// Folder colours follow what the folder usually holds.
const FOLDER_COLORS: [RegExp, string][] = [
  [/^(src|app|lib|source)$/, '#7aa9ff'], [/^(node_modules)$/, '#8cc84b'], [/^\.git$/, '#f05033'], [/^\.(claude|vscode|idea|github)$/, '#d97757'],
  [/^(assets|images?|img|public|static|media|icons?)$/, '#ffb74d'], [/^(tests?|__tests__|spec)$/, '#4db6ac'], [/^(dist|build|out|\.next)$/, '#9e9e9e'],
  [/^(components?|ui|views?|pages?)$/, '#c4b5fd'], [/^(styles?|css)$/, '#42a5f5'], [/^(docs?)$/, '#6aa8d8'],
];
function folderIcon(name: string, open: boolean): string {
  const c = FOLDER_COLORS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? '#90a4c4';
  return open
    ? svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h5.7a1 1 0 0 1 1 1V7H4.2a1 1 0 0 0-.95.68L1.5 12.5z" fill="${c}" fill-opacity=".55"/><path d="M3.3 7.7A1 1 0 0 1 4.25 7h10.3l-1.9 5.8a1 1 0 0 1-.95.7H1.5z" fill="${c}"/>`)
    : svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h6.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="${c}"/><path d="M1.5 6h13" stroke="#000" stroke-opacity=".18"/>`);
}
const CHEV = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ================= Workspace ================= */
interface Buffer {
  path: string;
  kind: 'text' | 'binary' | 'large';
  text: string;
  saved: string;
  eol: '\n' | '\r\n';
  size: number;
  ta: HTMLTextAreaElement | null;
}
interface Session { tabs: string[]; active: string | null; expanded: string[]; pos: Record<string, [number, number]>; }

let rootInfo: RootInfo | null = null;
const dirCache = new Map<string, DirEntry[]>();
const expanded = new Set<string>();
const buffers = new Map<string, Buffer>();
let openTabs: string[] = [];
let active: string | null = null;
const locks: Record<string, AgentKey> = {};
const added: Record<string, Set<number>> = {};
let guestCursor: GuestCursor | null = null;
let ctxPath: string | null = null;

const sessionKey = () => `breeze.session:${rootInfo?.root ?? ''}`;
const hotExitKey = () => `breeze.dirty:${rootInfo?.root ?? ''}`;
const isDirty = (b?: Buffer) => !!b && b.kind === 'text' && b.text !== b.saved;
let sessionTimer: number | undefined;
function saveSession(): void {
  if (!rootInfo) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushSession, 300);
}
function flushSession(): void {
  if (!rootInfo) return;
  clearTimeout(sessionTimer);
  const pos: Session['pos'] = {};
  for (const b of buffers.values()) if (b.ta) pos[b.path] = [b.ta.selectionStart, b.ta.scrollTop];
  store.set(sessionKey(), { tabs: openTabs, active, expanded: [...expanded], pos } as Session);
  // Hot exit: unsaved edits survive a reload or a crash.
  const dirty: Record<string, string> = {};
  for (const b of buffers.values()) if (isDirty(b)) dirty[b.path] = b.text;
  if (Object.keys(dirty).length) store.set(hotExitKey(), dirty); else store.del(hotExitKey());
}
window.addEventListener('beforeunload', flushSession);

async function loadWorkspace(info: RootInfo): Promise<void> {
  if (rootInfo) { flushSession(); resetWorkspace(); }
  rootInfo = info;
  $('#projectName').textContent = info.name;
  $('#projectName').title = info.root;
  document.title = `${info.name} — Breeze IDE`;
  const s = store.get<Session>(sessionKey(), { tabs: [], active: null, expanded: [], pos: {} });
  const dirty = store.get<Record<string, string>>(hotExitKey(), {});
  expanded.clear();
  await loadDir('');
  for (const d of s.expanded) { expanded.add(d); await loadDir(d); }
  renderTree();
  for (const p of s.tabs) {
    const b = await loadBuffer(p);
    if (!b) continue;
    if (b.kind === 'text' && dirty[p] != null) { b.text = dirty[p]; if (b.ta) b.ta.value = b.text; }
    if (b.ta && s.pos[p]) { b.ta.setSelectionRange(s.pos[p][0], s.pos[p][0]); b.ta.scrollTop = s.pos[p][1]; }
    openTabs.push(p);
  }
  active = s.active && openTabs.includes(s.active) ? s.active : openTabs[0] ?? null;
  renderTabs(); renderEditor(); renderTree();
  restoreChat();
  refreshGit();
  term.cwd = await api.term.cwd(); renderPs();
}
function resetWorkspace(): void {
  for (const b of buffers.values()) b.ta?.remove();
  buffers.clear(); dirCache.clear(); expanded.clear();
  openTabs = []; active = null; rootInfo = null;
  stopPreview();
  $('#projectName').textContent = 'No folder';
  document.title = 'Breeze IDE';
  gitState = { repo: false }; gitLog = { head: null, commits: [] };
  renderScm(); renderBranch(); emptyChat();
}

async function loadDir(rel: string): Promise<void> {
  try { dirCache.set(rel, await api.fs.readDir(rel)); }
  catch { dirCache.delete(rel); expanded.delete(rel); }
}

async function loadBuffer(path: string): Promise<Buffer | null> {
  const existing = buffers.get(path);
  if (existing) return existing;
  let r: FileRead;
  try { r = await api.fs.readFile(path); } catch (e) { toast(`Couldn't open ${baseName(path)}: ${errMsg(e)}`); return null; }
  const raw = r.text ?? '';
  const b: Buffer = {
    path, size: r.size,
    kind: r.binary ? 'binary' : r.tooLarge ? 'large' : 'text',
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    text: raw.replace(/\r\n/g, '\n'), saved: '', ta: null,
  };
  b.saved = b.text;
  if (b.kind === 'text') b.ta = createTextarea(b);
  buffers.set(path, b);
  return b;
}

// Each open file keeps its own textarea so undo history survives tab switches.
function createTextarea(b: Buffer): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  ta.className = 'ta hidden';
  ta.spellcheck = false;
  ta.wrap = 'off';
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('aria-label', `Editing ${b.path}`);
  ta.value = b.text;
  ta.addEventListener('input', () => {
    const wasDirty = isDirty(b);
    b.text = ta.value;
    if (wasDirty !== isDirty(b)) { renderTabs(); renderTree(); }
    if (findOpen) runFind(false);
    queueRender(); saveSession();
  });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keydown', editorKeys);
  for (const ev of ['keyup', 'mouseup', 'select', 'selectionchange', 'focus']) ta.addEventListener(ev, updateCaret);
  $('#editor .code').appendChild(ta);
  return ta;
}

/* ================= Explorer ================= */
function renderTree(): void {
  const el = $('#tree');
  if (!rootInfo) {
    el.innerHTML = `<div class="side-note">You have not opened a folder yet.<button class="btn btn-primary btn-sm" data-act="file.openFolder">Open Folder</button></div><div id="recentList"></div>`;
    renderRecent();
    return;
  }
  const rows: string[] = [];
  const decor = gitDecor();
  const letters: Record<string, string> = { 'git-m': 'M', 'git-u': 'U', 'git-a': 'A', 'git-d': 'D' };
  const walk = (rel: string, depth: number) => {
    for (const e of dirCache.get(rel) ?? []) {
      const p = joinPath(rel, e.name);
      const open = e.dir && expanded.has(p);
      const lock = locks[p];
      const lockTag = lock ? `<span class="lock" style="background:${agentsDef[lock].color};color:#000">${agentsDef[lock].name}</span>` : '';
      const g = e.dir ? (decor.dirs.has(p) ? 'has-changes' : '') : decor.files.get(p) ?? '';
      const enter = rel && rel === justExpanded ? 'enter' : '';
      const cls = ['tree-item', p === active ? 'on' : '', isDirty(buffers.get(p)) ? 'dirty' : '', p === ctxPath ? 'ctx' : '', g, enter].filter(Boolean).join(' ');
      rows.push(`<div class="${cls}" style="padding-left:${4 + depth * 12}px" data-path="${escAttr(p)}" ${e.dir ? 'data-dir="1"' : ''} title="${escAttr(p)}">
        <span class="chev ${e.dir ? (open ? 'open' : '') : 'none'}">${CHEV}</span><span class="ico">${e.dir ? folderIcon(e.name, open) : fileIcon(e.name)}</span><span class="nm">${esc(e.name)}</span>${lockTag}${!e.dir && g && !lock ? `<span class="gst">${letters[g] ?? ''}</span>` : ''}</div>`);
      if (open) walk(p, depth + 1);
    }
  };
  walk('', 0);
  el.innerHTML = rows.join('') || '<p class="side-note">This folder is empty.</p>';
  justExpanded = null;
}
// The folder whose children should animate in on the next render.
let justExpanded: string | null = null;
async function renderRecent(): Promise<void> {
  const recent = await api.fs.recent().catch(() => []);
  const el = document.getElementById('recentList');
  if (!el || !recent.length) return;
  el.innerHTML = `<div class="side-head" style="padding-left:8px">Recent</div>` +
    recent.map(r => `<div class="tree-item" data-recent="${escAttr(r.path)}" title="${escAttr(r.path)}"><span class="ico">▸</span><span class="nm">${esc(r.name)}</span></div>`).join('');
}
$('#tree').addEventListener('click', e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-path],[data-recent],[data-act]');
  if (!t) return;
  if (t.dataset.act) return; // handled by the global data-act listener
  if (t.dataset.recent) { openRecentFolder(t.dataset.recent); return; }
  const p = t.dataset.path as string;
  if (t.dataset.dir) toggleDir(p); else openFile(p);
});
$('#tree').addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!rootInfo) return;
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
  const p = t?.dataset.path ?? '';
  const isDir = !t || !!t.dataset.dir;
  ctxPath = p || null; renderTree();
  const dir = isDir ? p : dirName(p);
  popupMenu(e.clientX, e.clientY, [
    { label: 'New File…', run: () => newEntry(dir, false) },
    { label: 'New Folder…', run: () => newEntry(dir, true) },
    ...(p ? [
      { sep: true },
      { label: 'Rename…', key: 'F2', run: () => renameEntry(p) },
      { label: 'Delete', key: 'Delete', run: () => deleteEntry(p, isDir) },
      { sep: true },
      { label: 'Copy Relative Path', run: () => { navigator.clipboard?.writeText(p).catch(() => {}); toast('Path copied'); } },
    ] as MenuItem[] : []),
  ], () => { ctxPath = null; renderTree(); });
});
async function toggleDir(p: string): Promise<void> {
  if (expanded.has(p)) expanded.delete(p);
  else { expanded.add(p); if (!dirCache.has(p)) await loadDir(p); justExpanded = p; }
  renderTree(); saveSession();
}
async function refreshTree(): Promise<void> {
  if (!rootInfo) return;
  await loadDir('');
  for (const d of [...expanded]) await loadDir(d);
  renderTree();
}
// The folder new files go into: right-clicked folder, else the active file's folder, else the root.
const targetDir = () => (active ? dirName(active) : '');

function askName(title: string, initial: string, okLabel: string): Promise<string | null> {
  return new Promise(res => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; res(v); } };
    openModal(`<h3>${esc(title)}</h3><input class="input" style="width:100%;margin:12px 0 14px" id="nameIn" spellcheck="false" value="${escAttr(initial)}">
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nameOk">${okLabel}</button></div>`, m => {
      const input = $<HTMLInputElement>('#nameIn', m);
      input.focus();
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      const ok = () => { const v = input.value.trim(); if (v) { finish(v); closeModal(); } };
      $('#nameOk', m).onclick = ok;
      input.onkeydown = e => { if (e.key === 'Enter') ok(); };
    }, () => finish(null));
  });
}
async function newEntry(dir: string, folder: boolean): Promise<void> {
  if (!rootInfo) { toast('Open a folder first'); return; }
  const name = await askName(folder ? 'New folder' : 'New file', '', 'Create');
  if (!name) return;
  const rel = joinPath(dir, name.replace(/\\/g, '/').replace(/^\/+/, ''));
  try {
    if (folder) await api.fs.createDir(rel); else await api.fs.createFile(rel);
  } catch (e) { toast(errMsg(e)); return; }
  for (let d = dirName(rel); d; d = dirName(d)) expanded.add(d);
  if (folder) expanded.add(rel);
  await refreshTree(); saveSession();
  if (!folder) openFile(rel);
}
async function renameEntry(p: string): Promise<void> {
  const name = await askName('Rename', baseName(p), 'Rename');
  if (!name || name === baseName(p)) return;
  if (/[\\/]/.test(name)) { toast('Names cannot contain slashes'); return; }
  const to = joinPath(dirName(p), name);
  try { await api.fs.rename(p, to); } catch (e) { toast(errMsg(e)); return; }
  const move = (x: string) => (x === p ? to : x.startsWith(p + '/') ? to + x.slice(p.length) : x);
  for (const b of [...buffers.values()]) {
    const np = move(b.path);
    if (np !== b.path) { buffers.delete(b.path); b.path = np; buffers.set(np, b); }
  }
  openTabs = openTabs.map(move);
  if (active) active = move(active);
  for (const d of [...expanded]) { expanded.delete(d); expanded.add(move(d)); }
  dirCache.clear();
  await refreshTree(); renderTabs(); renderEditor(); saveSession();
}
function deleteEntry(p: string, isDir: boolean): void {
  openModal(`<h3>Delete ${esc(baseName(p))}?</h3><p class="sub">${isDir ? 'The folder and everything in it' : 'The file'} will be moved to the ${isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'}, so you can restore it.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="delOk">Move to ${isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'}</button></div>`, m => {
    $('#delOk', m).onclick = async () => {
      closeModal();
      try { await api.fs.trash(p); } catch (e) { toast(errMsg(e)); return; }
      for (const path of [...openTabs]) if (path === p || path.startsWith(p + '/')) dropTab(path);
      expanded.delete(p);
      await refreshTree(); renderTabs(); renderEditor(); saveSession();
    };
  });
}

api.fs.onChange(async paths => {
  queueGitRefresh();
  const dirs = new Set(paths.map(dirName));
  for (const d of dirs) if (dirCache.has(d)) await loadDir(d);
  // The changed path may itself be a cached folder (e.g. created then filled).
  for (const p of paths) if (dirCache.has(p)) await loadDir(p);
  renderTree();
  for (const p of paths) {
    const b = buffers.get(p);
    if (!b || b.kind !== 'text' || isDirty(b)) continue;
    try {
      const r = await api.fs.readFile(p);
      const text = (r.text ?? '').replace(/\r\n/g, '\n');
      if (r.text == null || text === b.saved) continue;
      b.text = b.saved = text;
      if (b.ta) { const s = b.ta.selectionStart; b.ta.value = text; b.ta.setSelectionRange(s, s); }
      if (p === active) renderCode();
    } catch { /* deleted or unreadable — leave the buffer as it is */ }
  }
});

/* ================= Opening, tabs & saving ================= */
function openFile(path: string, at?: { line: number; col: number; len?: number }): void {
  if (/^\.env/.test(baseName(path)) && !buffers.has(path)) {
    openModal(`<h3>This is a protected file</h3><p class="sub">${esc(baseName(path))} holds secrets. You can view it, but agents can't read it unless you allow it each time.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="openEnv">Open for me only</button></div>`,
      m => $('#openEnv', m).onclick = () => { closeModal(); actuallyOpen(path, at); });
    return;
  }
  actuallyOpen(path, at);
}
async function actuallyOpen(path: string, at?: { line: number; col: number; len?: number }): Promise<void> {
  const b = await loadBuffer(path);
  if (!b) return;
  if (!openTabs.includes(path)) openTabs.push(path);
  setActive(path);
  if (at && b.ta) {
    const off = offsetOf(b.text, at.line, at.col);
    b.ta.focus();
    b.ta.setSelectionRange(off, off + (at.len ?? 0));
    revealOffset(b, off);
  }
}
function setActive(path: string | null): void {
  const changed = active !== path;
  active = path;
  renderTabs(); renderEditor(); renderTree(); saveSession();
  if (changed) for (const el of [$('#hl'), $('#gutter')]) { el.classList.remove('switch'); void el.offsetWidth; el.classList.add('switch'); }
  if (running && path && /\.(html?|css|js)$/i.test(path)) $('#urlText').title = path;
}
const seenTabs = new Set<string>();
function renderTabs(): void {
  $('#tabs').innerHTML = openTabs.map(n => {
    const lock = locks[n];
    const enter = seenTabs.has(n) ? '' : 'enter';
    seenTabs.add(n);
    return `<div class="tab ${n === active ? 'on' : ''} ${isDirty(buffers.get(n)) ? 'dirty' : ''} ${enter}" data-tab="${escAttr(n)}" title="${escAttr(n)}">${lock ? `<span class="dot" style="background:${agentsDef[lock].color}"></span>` : ''}<span class="ico">${fileIcon(baseName(n))}</span>${esc(baseName(n))}<span class="x" data-close-tab="1" title="Close (Ctrl+W)"><span>✕</span></span></div>`;
  }).join('');
}
$('#tabs').addEventListener('click', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!tab) return;
  const p = tab.dataset.tab as string;
  if ((e.target as HTMLElement).closest('[data-close-tab]')) closeTab(p); else setActive(p);
});
$('#tabs').addEventListener('auxclick', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (tab && e.button === 1) closeTab(tab.dataset.tab as string);
});
function dropTab(path: string): void {
  const i = openTabs.indexOf(path);
  if (i === -1) return;
  openTabs.splice(i, 1);
  buffers.get(path)?.ta?.remove();
  buffers.delete(path);
  if (active === path) active = openTabs[Math.min(i, openTabs.length - 1)] ?? null;
}
function closeTab(path: string): void {
  const b = buffers.get(path);
  const finish = () => { dropTab(path); renderTabs(); renderEditor(); renderTree(); saveSession(); };
  if (!isDirty(b)) { finish(); return; }
  openModal(`<h3>Save changes to ${esc(baseName(path))}?</h3><p class="sub">Your changes will be lost if you don't save them.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn" id="dontSave">Don't Save</button><button class="btn btn-primary" id="doSave">Save</button></div>`, m => {
    $('#dontSave', m).onclick = () => { closeModal(); finish(); };
    $('#doSave', m).onclick = async () => { closeModal(); if (await saveFile(path)) finish(); };
  });
}
async function saveFile(path: string | null = active): Promise<boolean> {
  const b = path ? buffers.get(path) : undefined;
  if (!b || b.kind !== 'text') return false;
  const text = b.text;
  try { await api.fs.writeFile(b.path, b.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text); }
  catch (e) { toast(`Couldn't save ${baseName(b.path)}: ${errMsg(e)}`); return false; }
  b.saved = text;
  renderTabs(); renderTree(); flushSession();
  if (running) reloadPreview();
  return true;
}
async function saveAll(): Promise<void> {
  const dirty = [...buffers.values()].filter(isDirty);
  for (const b of dirty) await saveFile(b.path);
  if (dirty.length) toast(`Saved ${dirty.length} file${dirty.length > 1 ? 's' : ''}`);
}

/* ================= Code editor ================= */
const LINE_H = 21;
const INDENT = '  ';
const hlInner = document.createElement('div');
$('#hl').appendChild(hlInner);
hlInner.style.position = 'relative';
const gutInner = document.createElement('div');
$('#gutter').appendChild(gutInner);
let charW = 0;
let curLine = -1;
let renderQueued = false;

const activeBuf = (): Buffer | undefined => (active ? buffers.get(active) : undefined);
function activeText(): (Buffer & { ta: HTMLTextAreaElement }) | undefined {
  const b = activeBuf();
  return b && b.kind === 'text' && b.ta ? b as Buffer & { ta: HTMLTextAreaElement } : undefined;
}
function measureChar(): number {
  if (charW) return charW;
  const s = document.createElement('span');
  s.textContent = 'x'.repeat(200);
  s.style.visibility = 'hidden';
  hlInner.appendChild(s);
  charW = s.getBoundingClientRect().width / 200 || 7.8;
  s.remove();
  return charW;
}
document.fonts?.ready.then(() => { charW = 0; renderCode(); });

const lineStart = (v: string, pos: number) => v.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (v: string, pos: number) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i; };
function lineAt(v: string, pos: number): number {
  let n = 0;
  for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1)) n++;
  return n;
}
function offsetOf(v: string, line: number, col: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) { const nl = v.indexOf('\n', off); if (nl === -1) return v.length; off = nl + 1; }
  return Math.min(off + col, lineEnd(v, off));
}
function visualCol(lineText: string, col: number): number {
  let v = 0;
  for (let i = 0; i < col; i++) v = lineText[i] === '\t' ? v + 4 - (v % 4) : v + 1;
  return v;
}

function renderEditor(): void {
  const b = activeBuf();
  for (const x of buffers.values()) x.ta?.classList.toggle('hidden', x !== b);
  const empty = $('#editorEmpty');
  if (!b || b.kind !== 'text') {
    empty.classList.remove('hidden');
    empty.innerHTML = !b ? welcomeHtml()
      : `<div><h4>${esc(baseName(b.path))}</h4><div>${b.kind === 'binary' ? 'This file is binary, so Breeze can\'t show it as text.' : `This file is too large to open (${(b.size / 1048576).toFixed(1)} MB).`}</div></div>`;
    hlInner.innerHTML = ''; gutInner.innerHTML = '';
    closeFind();
    updateStatus();
    return;
  }
  empty.classList.add('hidden');
  if (findOpen) runFind(false);
  renderCode();
  if (document.activeElement === document.body || document.activeElement?.classList.contains('ta')) b.ta?.focus({ preventScroll: true });
}
function welcomeHtml(): string {
  const k = (keys: string, what: string) => `<span>${what}</span><kbd>${keys}</kbd>`;
  return `<div><img src="Agent.png" alt=""><h4>${rootInfo ? 'No file open' : 'Open a folder to start'}</h4>
    <div class="keys">${rootInfo
      ? k('Ctrl+P', 'Go to file') + k('Ctrl+N', 'New file') + k('Ctrl+Shift+F', 'Search files') + k('Ctrl+`', 'Terminal')
      : k('Ctrl+O', 'Open folder') + k('Ctrl+B', 'Toggle side bar') + k('Ctrl+Alt+B', 'Toggle agents')}</div></div>`;
}
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderCode(); });
}
function renderCode(): void {
  const b = activeText();
  if (!b) return;
  const lines = highlightLines(b.text, langOf(b.path)[0]);
  const add = added[b.path];
  curLine = lineAt(b.text, b.ta.selectionStart);
  const cw = measureChar();
  let overlay = '';
  if (findOpen && findLen) {
    const vis = findHits.length > 3000 ? findHits.slice(Math.max(0, findIdx - 1500), findIdx + 1500) : findHits;
    for (const off of vis) {
      const ln = lineAt(b.text, off), ls = lineStart(b.text, off);
      const lt = b.text.slice(ls, lineEnd(b.text, ls));
      const x = visualCol(lt, off - ls) * cw, w = (visualCol(lt, off - ls + findLen) * cw) - x;
      overlay += `<div class="hit ${off === findHits[findIdx] ? 'cur' : ''}" style="top:${ln * LINE_H}px;left:${x}px;width:${Math.max(w, 2)}px"></div>`;
    }
  }
  if (guestCursor && guestCursor.file === b.path) {
    overlay += `<span class="cursor" style="top:${guestCursor.line * LINE_H + 2}px;left:${4 * cw}px;background:${guestCursor.color}"><span class="who" style="background:${guestCursor.color}">${guestCursor.name}</span></span>`;
  }
  hlInner.innerHTML = lines.map((h, i) => `<div class="ln${add?.has(i) ? ' added' : ''}${i === curLine ? ' cur-line' : ''}">${h}</div>`).join('') + overlay;
  $('#gutter').style.width = `${Math.max(3, String(lines.length).length) * 8 + 32}px`;
  gutInner.innerHTML = lines.map((_, i) => `<div${i === curLine ? ' class="cur"' : ''}>${i + 1}</div>`).join('');
  syncScroll();
  updateStatus();
}
function syncScroll(): void {
  const b = activeText();
  if (!b) return;
  hlInner.style.transform = `translate(${-b.ta.scrollLeft}px, ${-b.ta.scrollTop}px)`;
  gutInner.style.transform = `translateY(${-b.ta.scrollTop}px)`;
}
function updateCaret(): void {
  const b = activeText();
  if (!b) return;
  const i = lineAt(b.text, b.ta.selectionStart);
  if (i !== curLine) {
    hlInner.children[curLine]?.classList.remove('cur-line');
    gutInner.children[curLine]?.classList.remove('cur');
    hlInner.children[i]?.classList.add('cur-line');
    gutInner.children[i]?.classList.add('cur');
    curLine = i;
  }
  updateStatus();
}
function updateStatus(): void {
  const b = activeBuf();
  const hasText = !!b && b.kind === 'text' && !!b.ta;
  $('#sbPos').classList.toggle('hidden', !hasText);
  $('#sbLang').textContent = b ? langOf(b.path)[1] : '';
  $('#sbLang').classList.toggle('hidden', !b);
  $('#sbEol').textContent = b?.kind === 'text' ? `${b.eol === '\r\n' ? 'CRLF' : 'LF'} · UTF-8` : '';
  $('#sbEol').classList.toggle('hidden', !b);
  if (!hasText || !b?.ta) return;
  const { selectionStart: s, selectionEnd: e } = b.ta;
  const ls = lineStart(b.text, s);
  $('#sbPos').textContent = `Ln ${lineAt(b.text, s) + 1}, Col ${s - ls + 1}${e > s ? ` (${e - s} selected)` : ''}`;
}
function revealOffset(b: Buffer, off: number): void {
  if (!b.ta) return;
  const top = lineAt(b.text, off) * LINE_H;
  const ta = b.ta;
  if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - LINE_H * 3) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  const ls = lineStart(b.text, off);
  const x = visualCol(b.text.slice(ls, lineEnd(b.text, ls)), off - ls) * measureChar();
  if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 80) ta.scrollLeft = Math.max(0, x - ta.clientWidth / 2);
  syncScroll(); updateCaret();
}

// Replace a range through the browser's editing pipeline so Ctrl+Z can undo it.
function replaceRange(ta: HTMLTextAreaElement, start: number, end: number, text: string, selStart?: number, selEnd?: number): void {
  ta.focus();
  ta.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input'));
  }
  if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
}
function selectedLines(ta: HTMLTextAreaElement): [number, number] {
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  return [lineStart(v, s), lineEnd(v, e > s && v[e - 1] === '\n' ? e - 1 : e)];
}
function editorKeys(e: KeyboardEvent): void {
  const ta = e.target as HTMLTextAreaElement;
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (!e.shiftKey && !v.slice(s, en).includes('\n')) { replaceRange(ta, s, en, INDENT); return; }
    const [ls, le] = selectedLines(ta);
    const block = v.slice(ls, le);
    const lines = block.split('\n');
    const out = lines.map(l => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, '') : INDENT + l)).join('\n');
    const firstDelta = out.split('\n')[0].length - lines[0].length;
    replaceRange(ta, ls, le, out, Math.max(ls, s + firstDelta), en + out.length - block.length);
    return;
  }
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    const ls = lineStart(v, s);
    const before = v.slice(ls, s);
    const indent = (/^[ \t]*/.exec(before) ?? [''])[0];
    const opens = /[{[(]\s*$/.test(before) || (langOf(active ?? '')[0] === 'py' && /:\s*$/.test(before)) || /<([a-zA-Z][\w-]*)[^>]*>$/.test(before) && v.slice(en).startsWith('</');
    const extra = opens ? INDENT : '';
    if (opens && /^\s*[}\])<]/.test(v.slice(en, lineEnd(v, en)))) {
      replaceRange(ta, s, en, `\n${indent}${extra}\n${indent}`, s + 1 + indent.length + extra.length);
    } else {
      replaceRange(ta, s, en, `\n${indent}${extra}`);
    }
  }
}
function toggleComment(): void {
  const b = activeText();
  if (!b) return;
  const c = COMMENT[langOf(b.path)[0]];
  if (!c) { toast('No comment syntax for this file type'); return; }
  const ta = b.ta;
  const [ls, le] = selectedLines(ta);
  const block = ta.value.slice(ls, le);
  const lines = block.split('\n');
  const [open, close] = c;
  const isCommented = (l: string) => !l.trim() || (l.trimStart().startsWith(open.trim()) && (!close || l.trimEnd().endsWith(close.trim())));
  const uncomment = lines.every(isCommented) && lines.some(l => l.trim());
  const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => (/^\s*/.exec(l) ?? [''])[0].length));
  const out = lines.map(l => {
    if (!l.trim()) return l;
    if (uncomment) {
      let r = l.replace(new RegExp(`^(\\s*)${open.trim().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ?`), '$1');
      if (close) r = r.replace(new RegExp(` ?${close.trim().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`), '');
      return r;
    }
    return l.slice(0, minIndent) + open + l.slice(minIndent) + close;
  }).join('\n');
  replaceRange(ta, ls, le, out, ls, ls + out.length);
}
function moveLines(dir: -1 | 1): void {
  const b = activeText();
  if (!b) return;
  const ta = b.ta, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  const [ls, le] = selectedLines(ta);
  const block = v.slice(ls, le);
  if (dir < 0) {
    if (ls === 0) return;
    const pls = lineStart(v, ls - 1);
    const prev = v.slice(pls, ls - 1);
    replaceRange(ta, pls, le, `${block}\n${prev}`, s - prev.length - 1, en - prev.length - 1);
  } else {
    if (le >= v.length) return;
    const nle = lineEnd(v, le + 1);
    const next = v.slice(le + 1, nle);
    replaceRange(ta, ls, nle, `${next}\n${block}`, s + next.length + 1, en + next.length + 1);
  }
}
function duplicateLines(): void {
  const b = activeText();
  if (!b) return;
  const ta = b.ta, s = ta.selectionStart, en = ta.selectionEnd;
  const [ls, le] = selectedLines(ta);
  const block = ta.value.slice(ls, le);
  replaceRange(ta, le, le, `\n${block}`, s + block.length + 1, en + block.length + 1);
}
function selectLine(): void {
  const b = activeText();
  if (!b) return;
  const [ls, le] = selectedLines(b.ta);
  b.ta.focus();
  b.ta.setSelectionRange(ls, Math.min(le + 1, b.ta.value.length));
  updateCaret();
}

/* ----- Find in file ----- */
let findOpen = false;
let findHits: number[] = [];
let findIdx = -1;
let findLen = 0;
const findInput = $<HTMLInputElement>('#findInput');
function openFind(): void {
  const b = activeText();
  if (!b) return;
  const sel = b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd);
  if (sel && !sel.includes('\n')) findInput.value = sel;
  findOpen = true;
  $('#findbar').classList.remove('hidden');
  findInput.focus(); findInput.select();
  runFind(true);
}
function closeFind(): void {
  if (!findOpen) return;
  findOpen = false; findHits = []; findLen = 0;
  $('#findbar').classList.add('hidden');
  renderCode();
}
function runFind(jump: boolean): void {
  const b = activeText();
  const q = findInput.value;
  findHits = []; findLen = q.length;
  if (b && q) {
    const hay = b.text.toLowerCase(), n = q.toLowerCase();
    for (let i = hay.indexOf(n); i !== -1 && findHits.length < 20000; i = hay.indexOf(n, i + n.length)) findHits.push(i);
  }
  const from = b ? b.ta.selectionStart : 0;
  findIdx = findHits.length ? Math.max(0, findHits.findIndex(h => h >= from)) : -1;
  if (findIdx === -1 && findHits.length) findIdx = 0;
  if (jump) selectHit(); else { renderFindCount(); queueRender(); }
}
function renderFindCount(): void {
  $('#findCount').textContent = !findInput.value ? '' : findHits.length ? `${findIdx + 1} of ${findHits.length}` : 'No results';
}
function stepFind(d: number): void {
  if (!findHits.length) return;
  findIdx = (findIdx + d + findHits.length) % findHits.length;
  selectHit();
}
function selectHit(): void {
  const b = activeText();
  renderFindCount();
  if (b && findIdx >= 0) {
    const off = findHits[findIdx];
    b.ta.setSelectionRange(off, off + findLen);
    revealOffset(b, off);
  }
  renderCode();
}
findInput.addEventListener('input', () => runFind(true));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.stopPropagation(); closeFind(); activeText()?.ta.focus(); }
});
$('#findNext').onclick = () => stepFind(1);
$('#findPrev').onclick = () => stepFind(-1);
$('#findClose').onclick = () => { closeFind(); activeText()?.ta.focus(); };

/* ----- Go to line / file ----- */
function goToLine(): void {
  const b = activeText();
  if (!b) { toast('Open a file first'); return; }
  const total = b.text.split('\n').length;
  openModal(`<input class="input" style="width:100%" id="lineIn" placeholder="Go to line (1 – ${total})" inputmode="numeric">`, m => {
    const input = $<HTMLInputElement>('#lineIn', m);
    input.focus();
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const n = clamp(parseInt(input.value, 10) || 1, 1, total);
      closeModal();
      const off = offsetOf(b.text, n - 1, 0);
      b.ta.focus(); b.ta.setSelectionRange(off, off);
      revealOffset(b, off);
    };
  }, undefined, 'top');
}
async function quickOpen(): Promise<void> {
  if (!rootInfo) { toast('Open a folder first'); return; }
  let all: string[] = [];
  let sel = 0;
  let shown: string[] = [];
  openModal(`<input class="input" style="width:100%" id="qoIn" placeholder="Search files by name" spellcheck="false"><div class="qo-list" id="qoList"><div class="side-note">Loading…</div></div>`, m => {
    const input = $<HTMLInputElement>('#qoIn', m);
    input.focus();
    const score = (p: string, q: string): number => {
      const name = baseName(p).toLowerCase(), full = p.toLowerCase();
      if (!q) return 1;
      if (name.startsWith(q)) return 4;
      if (name.includes(q)) return 3;
      if (full.includes(q)) return 2;
      let i = 0;
      for (const ch of full) if (ch === q[i]) i++;
      return i === q.length ? 1 : 0;
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.map(p => [p, score(p, q)] as [string, number]).filter(x => x[1] > 0)
        .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 60).map(x => x[0]);
      sel = clamp(sel, 0, Math.max(0, shown.length - 1));
      $('#qoList', m).innerHTML = shown.map((p, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${fileIcon(baseName(p))}&nbsp; ${esc(baseName(p))}</span><small>${esc(dirName(p))}</small></div>`).join('')
        || '<div class="side-note">No matching files.</div>';
      $$('[data-i]', m).forEach(el => el.onclick = () => { closeModal(); openFile(shown[Number(el.dataset.i)]); });
    };
    input.oninput = () => { sel = 0; render(); };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel += e.key === 'ArrowDown' ? 1 : -1; render(); $('.qo-item.on', m)?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter' && shown[sel]) { closeModal(); openFile(shown[sel]); }
    };
    api.fs.listFiles().then(list => { all = list; render(); }, err => { $('#qoList', m).innerHTML = `<div class="side-note">${esc(errMsg(err))}</div>`; });
  }, undefined, 'top');
}

/* ================= Search across files ================= */
let searchCase = false;
$('#searchCase').onclick = () => { searchCase = !searchCase; $('#searchCase').classList.toggle('on', searchCase); runSearch(); };
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
async function runSearch(): Promise<void> {
  const q = $<HTMLInputElement>('#searchInput').value;
  const out = $('#searchResults');
  if (!rootInfo) { out.innerHTML = '<p class="side-note">Open a folder to search it.</p>'; return; }
  if (!q) { out.innerHTML = '<p class="side-note">Type and press Enter to search across files.</p>'; return; }
  out.innerHTML = '<p class="side-note">Searching…</p>';
  let hits: SearchHit[];
  try { hits = await api.fs.search(q, searchCase); } catch (e) { out.innerHTML = `<p class="side-note">${esc(errMsg(e))}</p>`; return; }
  if (!hits.length) { out.innerHTML = '<p class="side-note">No results.</p>'; return; }
  const byFile = new Map<string, SearchHit[]>();
  for (const h of hits) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
  out.innerHTML = `<p class="side-note" style="padding-top:0">${hits.length}${hits.length >= 500 ? '+' : ''} results in ${byFile.size} files</p>` +
    [...byFile].map(([p, hs]) => `<div class="result-file">${fileIcon(baseName(p))} ${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>` +
      hs.map((h, i) => {
        const start = Math.max(0, h.col - 30);
        const pre = h.text.slice(start, h.col).trimStart(), hit = h.text.slice(h.col, h.col + q.length), post = h.text.slice(h.col + q.length, h.col + q.length + 80);
        return `<div class="result-line" data-p="${escAttr(p)}" data-i="${i}">${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`;
      }).join('')).join('');
  $$('.result-line', out).forEach(el => el.onclick = () => {
    const h = (byFile.get(el.dataset.p as string) ?? [])[Number(el.dataset.i)];
    if (h) openFile(h.path, { line: h.line, col: h.col, len: q.length });
  });
}

/* ================= Preview ================= */
let running = false;
let previewPath: string | null = null;
const frame = $<HTMLIFrameElement>('#previewFrame');
frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
function renderPreview(): void {
  $('#previewEmpty').classList.toggle('hidden', running);
  frame.classList.toggle('hidden', !running);
  $('#liveDot').classList.toggle('hidden', !running);
  if (!running) { $('#urlText').textContent = 'Not running'; frame.removeAttribute('src'); frame.removeAttribute('srcdoc'); }
}
async function startPreview(): Promise<void> {
  if (!rootInfo) { toast('Open a folder first'); return; }
  const entry = (dirCache.get('') ?? []).find(e => !e.dir && /^index\.html?$/i.test(e.name));
  const target = entry?.name ?? (active && /\.html?$/i.test(active) ? active : null);
  if (!target) { toast('Add an index.html (or open an .html file) to preview it'); return; }
  previewPath = target;
  running = true;
  layout.previewOpen = true; applyLayout();
  renderPreview();
  await reloadPreview();
}
async function reloadPreview(): Promise<void> {
  if (!running || !previewPath) return;
  const url = await api.fs.fileUrl(previewPath).catch(() => '');
  if (url) {
    $('#urlText').textContent = url.replace(/^file:\/\/\//, '');
    frame.removeAttribute('srcdoc');
    frame.src = `${url}?t=${Date.now()}`;
  } else {
    // Browser demo: no file URLs, so inline the saved HTML.
    const r = await api.fs.readFile(previewPath).catch(() => null);
    $('#urlText').textContent = previewPath;
    frame.srcdoc = r?.text ?? '';
  }
}
function stopPreview(): void { running = false; previewPath = null; renderPreview(); }
$('#runBtn').onclick = () => (running ? reloadPreview().then(() => toast('Preview reloaded — it also reloads every time you save')) : startPreview());

/* ================= Terminal ================= */
const term = { cwd: '', proc: null as number | null, history: [] as string[], hIdx: 0 };
const termOut = $('#termOut');
const termInput = $<HTMLInputElement>('#termInput');
function renderPs(): void { $('#termPs').textContent = `${term.cwd || '~'}>`; }
function termWrite(text: string, cls = ''): void {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = clean;
  termOut.appendChild(span);
  while (termOut.childNodes.length > 3000) termOut.firstChild?.remove();
  $('#termBody').scrollTop = $('#termBody').scrollHeight;
}
termInput.addEventListener('keydown', async e => {
  if (e.key === 'c' && e.ctrlKey && term.proc != null && termInput.selectionStart === termInput.selectionEnd) { e.preventDefault(); api.term.kill(term.proc); termWrite('^C\n'); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    term.hIdx = clamp(term.hIdx + (e.key === 'ArrowUp' ? -1 : 1), 0, term.history.length);
    termInput.value = term.history[term.hIdx] ?? '';
    return;
  }
  if (e.key !== 'Enter') return;
  const cmd = termInput.value;
  termInput.value = '';
  if (term.proc != null) { termWrite(cmd + '\n'); toast('A command is still running — press Ctrl+C to stop it'); return; }
  termWrite(`${term.cwd}> `, 'ps'); termWrite(cmd + '\n', 'cmd');
  if (!cmd.trim()) return;
  term.history.push(cmd); term.hIdx = term.history.length;
  if (/^\s*(cls|clear)\s*$/i.test(cmd)) { termOut.innerHTML = ''; return; }
  const r = await api.term.run(cmd).catch(err => ({ error: errMsg(err) }) as { id?: number; cwd?: string; error?: string });
  if (r.error) termWrite(r.error + '\n', 'err');
  if (r.cwd) { term.cwd = r.cwd; renderPs(); }
  if (r.id != null) { term.proc = r.id; $('#termPs').style.opacity = '.4'; }
});
api.term.onData((id, chunk) => { if (id === term.proc) termWrite(chunk); });
api.term.onExit((id, code) => {
  if (id !== term.proc) return;
  term.proc = null; $('#termPs').style.opacity = '';
  if (code) termWrite(`exited with code ${code}\n`, 'err');
});
$('#termBody').addEventListener('mouseup', () => { if (!getSelection()?.toString()) termInput.focus(); });
$('#termToggle').addEventListener('click', e => { if (!(e.target as HTMLElement).closest('button')) run('term.toggle'); });

/* ================= Layout: resizable, collapsible panels ================= */
interface Layout { side: number; agents: number; term: number; preview: number; sideOpen: boolean; agentsOpen: boolean; termOpen: boolean; previewOpen: boolean; view: string; }
const DEFAULT_LAYOUT: Layout = { side: 240, agents: 340, term: 200, preview: 460, sideOpen: true, agentsOpen: true, termOpen: false, previewOpen: true, view: 'files' };
const layout: Layout = { ...DEFAULT_LAYOUT, ...store.get<Partial<Layout>>('breeze.layout', {}) };
function applyLayout(): void {
  const main = $('#main'), work = $('#work'), t = $('#terminal');
  main.style.setProperty('--side-w', layout.sideOpen ? `${layout.side}px` : '0px');
  main.style.setProperty('--agents-w', layout.agentsOpen ? `${layout.agents}px` : '0px');
  main.classList.toggle('no-side', !layout.sideOpen);
  main.classList.toggle('no-agents', !layout.agentsOpen);
  const maxPreview = work.clientWidth ? work.clientWidth - 220 : layout.preview;
  work.style.setProperty('--preview-w', `${clamp(layout.preview, 220, Math.max(220, maxPreview))}px`);
  work.classList.toggle('no-preview', !layout.previewOpen);
  t.style.setProperty('--term-h', `${clamp(layout.term, 80, Math.max(80, innerHeight - 220))}px`);
  t.classList.toggle('open', layout.termOpen);
  $('#termTitle').textContent = `${layout.termOpen ? '▾' : '▸'} Terminal`;
  const icon = (id: string, sym: string, on: boolean) => $(`#${id} use`).setAttribute('href', `#i-${sym}${on ? '-on' : ''}`);
  icon('tglSide', 'left', layout.sideOpen); icon('tglTerm', 'bottom', layout.termOpen); icon('tglAgents', 'right', layout.agentsOpen);
  store.set('breeze.layout', layout);
  syncScroll();
}
window.addEventListener('resize', applyLayout);
$$<HTMLElement>('[data-sash]').forEach(sash => {
  const kind = sash.dataset.sash as 'side' | 'agents' | 'preview' | 'term';
  sash.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, start = { ...layout };
    if (kind === 'preview') start.preview = $('#previewPane').getBoundingClientRect().width;
    document.body.classList.add(kind === 'term' ? 'resizing-h' : 'resizing');
    sash.classList.add('active');
    // Dragging below a threshold collapses the panel; dragging back out reopens it.
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (kind === 'side') { const w = start.side + dx; layout.sideOpen = w >= 120; if (layout.sideOpen) layout.side = clamp(w, 170, 640); }
      if (kind === 'agents') { const w = start.agents - dx; layout.agentsOpen = w >= 180; if (layout.agentsOpen) layout.agents = clamp(w, 260, 720); }
      if (kind === 'preview') { const w = start.preview - dx; layout.previewOpen = w >= 140; if (layout.previewOpen) layout.preview = clamp(w, 220, $('#work').clientWidth - 220); }
      if (kind === 'term') { const h = start.term - dy; layout.termOpen = h >= 60; if (layout.termOpen) layout.term = clamp(h, 80, innerHeight - 220); }
      applyLayout();
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      document.body.classList.remove('resizing', 'resizing-h'); sash.classList.remove('active');
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  sash.addEventListener('dblclick', () => { (layout as unknown as Record<string, number>)[kind] = DEFAULT_LAYOUT[kind]; applyLayout(); });
});
$('#tglSide').onclick = () => run('view.toggleSide');
$('#tglTerm').onclick = () => run('term.toggle');
$('#tglAgents').onclick = () => run('view.toggleAgents');

/* ================= Commands, menu bar & shortcuts ================= */
interface MenuItem { label?: string; act?: string; run?: () => void; key?: string; sep?: boolean; checked?: () => boolean; enabled?: () => boolean; native?: boolean; }
const hasFile = () => !!activeText();
const commands: Record<string, () => unknown> = {
  'file.newFile': () => newEntry(targetDir(), false),
  'file.newFolder': () => newEntry(targetDir(), true),
  'file.openFolder': openFolderCmd,
  'file.openRecent': openRecentPicker,
  'file.save': () => saveFile(),
  'file.saveAll': saveAll,
  'file.closeEditor': () => { if (active) closeTab(active); },
  'file.closeFolder': closeFolderCmd,
  'file.exit': () => api.win.quit(),
  'edit.undo': () => editRole('undo'),
  'edit.redo': () => editRole('redo'),
  'edit.cut': () => editRole('cut'),
  'edit.copy': () => editRole('copy'),
  'edit.paste': () => editRole('paste'),
  'edit.find': openFind,
  'edit.comment': toggleComment,
  'edit.selectAll': () => editRole('selectAll'),
  'sel.line': selectLine,
  'sel.dup': duplicateLines,
  'sel.up': () => moveLines(-1),
  'sel.down': () => moveLines(1),
  'view.files': () => showView('files', true),
  'view.search': () => { showView('search', true); const i = $<HTMLInputElement>('#searchInput'); const b = activeText(); const s = b ? b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd) : ''; if (s && !s.includes('\n')) i.value = s; i.focus(); i.select(); },
  'view.git': () => showView('git', true),
  'view.people': () => showView('people', true),
  'view.toggleSide': () => { layout.sideOpen = !layout.sideOpen; applyLayout(); },
  'view.toggleAgents': () => { layout.agentsOpen = !layout.agentsOpen; applyLayout(); },
  'view.togglePreview': () => { layout.previewOpen = !layout.previewOpen; applyLayout(); },
  'view.resetLayout': () => { Object.assign(layout, DEFAULT_LAYOUT, { view: layout.view }); applyLayout(); },
  'win.reload': () => { flushSession(); api.win.reload(); },
  'win.devtools': () => api.win.toggleDevTools(),
  'go.file': quickOpen,
  'go.line': goToLine,
  'go.nextEditor': () => cycleTab(1),
  'go.prevEditor': () => cycleTab(-1),
  'run.start': () => (running ? reloadPreview() : startPreview()),
  'run.reload': reloadPreview,
  'run.stop': () => { stopPreview(); toast('Preview stopped'); },
  'term.toggle': () => { layout.termOpen = !layout.termOpen; applyLayout(); if (layout.termOpen) termInput.focus(); },
  'term.focus': () => { layout.termOpen = true; applyLayout(); termInput.focus(); },
  'term.clear': () => { termOut.innerHTML = ''; },
  'term.kill': () => { if (term.proc != null) { api.term.kill(term.proc); termWrite('^C\n'); } else toast('Nothing is running'); },
  'explorer.refresh': refreshTree,
  'explorer.collapse': () => { expanded.clear(); renderTree(); saveSession(); },
  'help.welcome': () => setActive(null),
  'help.keys': showShortcuts,
  'help.setup': () => { appState.onboarded = false; saveApp(); $('#ide').classList.add('hidden'); $('#onboard').classList.remove('hidden'); goStep(2); },
  'account.signIn': () => { appState.onboarded = false; saveApp(); $('#ide').classList.add('hidden'); $('#onboard').classList.remove('hidden'); goStep(1); },
  'account.signOut': async () => { await api.auth.signOut(); setUser(null); toast('Signed out'); },
  'help.about': () => openModal(`<h3>Breeze IDE</h3><p class="sub">Smooth as a breeze.</p><p class="sub" style="font-size:12px">${isDesktop ? 'Desktop app' : 'Browser preview'} · ${esc(navigator.userAgent.match(/Electron\/[\d.]+|Chrome\/[\d.]+/)?.[0] ?? '')}</p><div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-close>OK</button></div>`),
};
function run(act: string): void {
  const fn = commands[act];
  if (fn) Promise.resolve(fn()).catch(e => toast(errMsg(e)));
}
function editRole(role: string): void {
  activeText()?.ta.focus();
  api.win.edit(role);
}
function cycleTab(d: number): void {
  if (!openTabs.length) return;
  const i = active ? openTabs.indexOf(active) : -1;
  setActive(openTabs[(i + d + openTabs.length) % openTabs.length]);
}
async function openFolderCmd(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const r = await api.fs.openFolder();
  if (r) await loadWorkspace(r);
}
async function openRecentFolder(dir: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  try { await loadWorkspace(await api.fs.openRecent(dir)); } catch (e) { toast(errMsg(e)); }
}
async function openRecentPicker(): Promise<void> {
  const recent = await api.fs.recent();
  if (!recent.length) { toast('No recent folders yet'); return; }
  openModal(`<h3>Open recent</h3><div class="qo-list">${recent.map(r => `<div class="qo-item" data-r="${escAttr(r.path)}"><span>${esc(r.name)}</span><small>${esc(r.path)}</small></div>`).join('')}</div>`,
    m => $$('[data-r]', m).forEach(el => el.onclick = () => { closeModal(); openRecentFolder(el.dataset.r as string); }), undefined, 'top');
}
async function closeFolderCmd(): Promise<void> {
  if (!rootInfo || !(await confirmDiscard())) return;
  store.del(hotExitKey());
  await api.fs.closeFolder();
  resetWorkspace();
  renderTree(); renderTabs(); renderEditor();
}
// Before leaving a folder: save, discard or cancel any unsaved files.
function confirmDiscard(): Promise<boolean> {
  const dirty = [...buffers.values()].filter(isDirty);
  if (!dirty.length) return Promise.resolve(true);
  return new Promise(res => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; res(v); } };
    openModal(`<h3>Save changes to ${dirty.length} file${dirty.length > 1 ? 's' : ''}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn" id="dDiscard">Don't Save</button><button class="btn btn-primary" id="dSave">Save All</button></div>`, m => {
      $('#dDiscard', m).onclick = () => {
        for (const b of dirty) { b.text = b.saved; if (b.ta) b.ta.value = b.saved; }
        finish(true); closeModal();
      };
      $('#dSave', m).onclick = async () => { await saveAll(); finish(true); closeModal(); };
    }, () => finish(false));
  });
}

const MENUS: [string, MenuItem[]][] = [
  ['File', [
    { label: 'New File…', act: 'file.newFile', key: 'Ctrl+N' },
    { label: 'New Folder…', act: 'file.newFolder' },
    { sep: true },
    { label: 'Open Folder…', act: 'file.openFolder', key: 'Ctrl+O' },
    { label: 'Open Recent…', act: 'file.openRecent' },
    { sep: true },
    { label: 'Save', act: 'file.save', key: 'Ctrl+S', enabled: hasFile },
    { label: 'Save All', act: 'file.saveAll', key: 'Ctrl+Alt+S', enabled: () => [...buffers.values()].some(isDirty) },
    { sep: true },
    { label: 'Close Editor', act: 'file.closeEditor', key: 'Ctrl+W', enabled: () => !!active },
    { label: 'Close Folder', act: 'file.closeFolder', enabled: () => !!rootInfo },
    { sep: true },
    { label: 'Exit', act: 'file.exit' },
  ]],
  ['Edit', [
    { label: 'Undo', act: 'edit.undo', key: 'Ctrl+Z', native: true },
    { label: 'Redo', act: 'edit.redo', key: 'Ctrl+Y', native: true },
    { sep: true },
    { label: 'Cut', act: 'edit.cut', key: 'Ctrl+X', native: true },
    { label: 'Copy', act: 'edit.copy', key: 'Ctrl+C', native: true },
    { label: 'Paste', act: 'edit.paste', key: 'Ctrl+V', native: true },
    { sep: true },
    { label: 'Find', act: 'edit.find', key: 'Ctrl+F', enabled: hasFile },
    { label: 'Find in Files', act: 'view.search', key: 'Ctrl+Shift+F' },
    { sep: true },
    { label: 'Toggle Line Comment', act: 'edit.comment', key: 'Ctrl+/', enabled: hasFile },
  ]],
  ['Selection', [
    { label: 'Select All', act: 'edit.selectAll', key: 'Ctrl+A', native: true },
    { label: 'Select Line', act: 'sel.line', key: 'Ctrl+L', enabled: hasFile },
    { sep: true },
    { label: 'Copy Line Down', act: 'sel.dup', key: 'Shift+Alt+Down', enabled: hasFile },
    { label: 'Move Line Up', act: 'sel.up', key: 'Alt+Up', enabled: hasFile },
    { label: 'Move Line Down', act: 'sel.down', key: 'Alt+Down', enabled: hasFile },
  ]],
  ['View', [
    { label: 'Explorer', act: 'view.files', key: 'Ctrl+Shift+E' },
    { label: 'Search', act: 'view.search', key: 'Ctrl+Shift+F' },
    { label: 'Checkpoints', act: 'view.git', key: 'Ctrl+Shift+G' },
    { label: 'People', act: 'view.people' },
    { sep: true },
    { label: 'Primary Side Bar', act: 'view.toggleSide', key: 'Ctrl+B', checked: () => layout.sideOpen },
    { label: 'Agents Panel', act: 'view.toggleAgents', key: 'Ctrl+Alt+B', checked: () => layout.agentsOpen },
    { label: 'Terminal', act: 'term.toggle', key: 'Ctrl+`', checked: () => layout.termOpen },
    { label: 'Preview', act: 'view.togglePreview', checked: () => layout.previewOpen },
    { label: 'Reset Layout', act: 'view.resetLayout' },
    { sep: true },
    { label: 'Reload Window', act: 'win.reload', key: 'Ctrl+R' },
    { label: 'Toggle Developer Tools', act: 'win.devtools', key: 'Ctrl+Shift+I' },
  ]],
  ['Go', [
    { label: 'Go to File…', act: 'go.file', key: 'Ctrl+P' },
    { label: 'Go to Line…', act: 'go.line', key: 'Ctrl+G', enabled: hasFile },
    { sep: true },
    { label: 'Next Editor', act: 'go.nextEditor', key: 'Ctrl+Tab' },
    { label: 'Previous Editor', act: 'go.prevEditor', key: 'Ctrl+Shift+Tab' },
  ]],
  ['Run', [
    { label: 'Start Preview', act: 'run.start', key: 'F5' },
    { label: 'Reload Preview', act: 'run.reload', key: 'Ctrl+F5', enabled: () => running },
    { label: 'Stop Preview', act: 'run.stop', key: 'Shift+F5', enabled: () => running },
  ]],
  ['Terminal', [
    { label: 'Focus Terminal', act: 'term.focus', key: 'Ctrl+Shift+`' },
    { label: 'Toggle Terminal', act: 'term.toggle', key: 'Ctrl+`' },
    { sep: true },
    { label: 'Clear Terminal', act: 'term.clear' },
    { label: 'Stop Running Command', act: 'term.kill', enabled: () => term.proc != null },
  ]],
  ['Help', [
    { label: 'Welcome', act: 'help.welcome' },
    { label: 'Keyboard Shortcuts', act: 'help.keys' },
    { label: 'Run Setup Again', act: 'help.setup' },
    { sep: true },
    { label: 'Sign In…', act: 'account.signIn', enabled: () => !user },
    { label: 'Sign Out', act: 'account.signOut', enabled: () => !!user },
    { sep: true },
    { label: 'About Breeze IDE', act: 'help.about' },
  ]],
];
// Go, Run and Help stay out of the menu bar; their shortcuts still work and Help lives under the gear button.
const BAR_MENUS = MENUS.filter(([name]) => !['Go', 'Run', 'Help'].includes(name));
// Shortcuts handled by the editor itself or by keydown elsewhere, but listed for discoverability.
const EXTRA_KEYS: [string, string][] = [['F2', 'explorer.rename']];
commands['explorer.rename'] = () => { if (active) renameEntry(active); };

const canonKey = (combo: string): string => {
  const parts = combo.split('+');
  const key = parts.pop() as string;
  const mods = new Set(parts);
  return ['Ctrl', 'Shift', 'Alt'].filter(m => mods.has(m)).concat(key.length === 1 ? key.toUpperCase() : key).join('+');
};
const keymap = new Map<string, string>();
for (const [, items] of MENUS) for (const it of items) if (it.key && it.act && !it.native) keymap.set(canonKey(it.key), it.act);
for (const [k, act] of EXTRA_KEYS) keymap.set(canonKey(k), act);
function comboOf(e: KeyboardEvent): string {
  const keyName = e.code === 'Backquote' ? '`' : e.code === 'Slash' ? '/' : e.key.startsWith('Arrow') ? e.key.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', keyName].filter(Boolean).join('+');
}
// Commands that only make sense while typing in the code editor.
const EDITOR_ONLY = new Set(['edit.comment', 'sel.line', 'sel.dup', 'sel.up', 'sel.down']);

let openMenuIdx = -1;
let kbIdx = -1;
let menuItems: MenuItem[] = [];
let menuOnClose: (() => void) | null = null;
function buildMenubar(): void {
  $('#menubar').innerHTML = BAR_MENUS.map(([name], i) => `<button class="menu-top" data-menu="${i}">${name}</button>`).join('');
  $$('[data-menu]').forEach(b => {
    const i = Number(b.dataset.menu);
    b.onmousedown = e => { e.preventDefault(); if (openMenuIdx === i) closeMenu(); else openMenu(i); };
    b.onmouseenter = () => { if (openMenuIdx !== -1 && openMenuIdx !== i) openMenu(i); };
  });
}
function openMenu(i: number, viaKeyboard = false): void {
  const btn = $(`[data-menu="${i}"]`);
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, BAR_MENUS[i][1], viaKeyboard);
  openMenuIdx = i;
  $$('[data-menu]').forEach(b => b.classList.toggle('open', b === btn));
}
function popupMenu(x: number, y: number, items: MenuItem[], onClose?: () => void): void {
  showMenu(x, y, items, false);
  openMenuIdx = -2;
  menuOnClose = onClose ?? null;
}
function showMenu(x: number, y: number, items: MenuItem[], viaKeyboard: boolean): void {
  menuItems = items;
  kbIdx = viaKeyboard ? items.findIndex(it => !it.sep) : -1;
  const root = $('#menuRoot');
  root.innerHTML = `<div class="menu" role="menu">${items.map((it, i) => it.sep ? '<div class="menu-sep"></div>'
    : `<button class="menu-item ${it.checked?.() ? 'checked' : ''} ${i === kbIdx ? 'kb' : ''}" role="menuitem" data-mi="${i}" ${it.enabled && !it.enabled() ? 'disabled' : ''}><span>${esc(it.label ?? '')}</span>${it.key ? `<span class="key">${it.key}</span>` : ''}</button>`).join('')}</div>`;
  const m = $('.menu', root);
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
  $$('[data-mi]', m).forEach(b => {
    b.onmousedown = e => e.preventDefault(); // keep focus (and the selection) in the editor
    b.onclick = () => activateMenuItem(items[Number(b.dataset.mi)]);
  });
}
function activateMenuItem(it: MenuItem): void {
  if (it.enabled && !it.enabled()) return;
  closeMenu();
  if (it.run) it.run(); else if (it.act) run(it.act);
}
function closeMenu(): void {
  if (openMenuIdx === -1) return;
  openMenuIdx = -1; kbIdx = -1;
  $('#menuRoot').innerHTML = '';
  $$('[data-menu]').forEach(b => b.classList.remove('open'));
  const cb = menuOnClose; menuOnClose = null; cb?.();
}
document.addEventListener('mousedown', e => {
  if (openMenuIdx !== -1 && !(e.target as HTMLElement).closest('.menu, .menubar')) closeMenu();
});
window.addEventListener('blur', closeMenu);
function menuKeys(e: KeyboardEvent): boolean {
  if (openMenuIdx === -1) return false;
  const usable = menuItems.map((it, i) => (!it.sep && (!it.enabled || it.enabled()) ? i : -1)).filter(i => i !== -1);
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const pos = usable.indexOf(kbIdx);
    kbIdx = usable[(pos + (e.key === 'ArrowDown' ? 1 : -1) + usable.length) % usable.length] ?? -1;
    $$('[data-mi]').forEach(b => b.classList.toggle('kb', Number(b.dataset.mi) === kbIdx));
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && openMenuIdx >= 0) {
    openMenu((openMenuIdx + (e.key === 'ArrowRight' ? 1 : -1) + BAR_MENUS.length) % BAR_MENUS.length, true);
  } else if (e.key === 'Enter' && kbIdx >= 0) activateMenuItem(menuItems[kbIdx]);
  else return false;
  e.preventDefault();
  return true;
}

document.addEventListener('keydown', e => {
  if (menuKeys(e)) return;
  if (e.key === 'Escape') {
    if (modalOpen()) { closeModal(); return; }
    if (findOpen) { closeFind(); activeText()?.ta.focus(); return; }
  }
  if (modalOpen() || $('#ide').classList.contains('hidden')) return;
  const act = keymap.get(comboOf(e));
  if (!act) return;
  const inEditor = (document.activeElement as HTMLElement | null)?.classList.contains('ta');
  if (EDITOR_ONLY.has(act) && !inEditor) return;
  if (act === 'explorer.rename' && (document.activeElement as HTMLElement | null)?.matches('input, textarea')) return;
  e.preventDefault();
  run(act);
}, true);
// Alt alone (released without another key) opens the menu bar, like a native app.
let altAlone = false;
document.addEventListener('keydown', e => { altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey; }, true);
document.addEventListener('keyup', e => {
  if (e.key === 'Alt' && altAlone && !$('#ide').classList.contains('hidden') && !modalOpen()) {
    e.preventDefault();
    if (openMenuIdx === -1) openMenu(0, true); else closeMenu();
  }
  altAlone = false;
}, true);

$('#settingsBtn').onclick = () => {
  const r = $('#settingsBtn').getBoundingClientRect();
  popupMenu(r.right + 6, r.top, MENUS.find(([name]) => name === 'Help')?.[1] ?? []);
};

function showShortcuts(): void {
  const rows: string[] = [];
  for (const [menu, items] of MENUS) for (const it of items) if (it.key) rows.push(`<span>${menu} › ${esc(it.label ?? '')}</span><kbd>${it.key}</kbd>`);
  rows.push('<span>Editor › Indent / outdent</span><kbd>Tab / Shift+Tab</kbd>', '<span>Explorer › Rename file</span><kbd>F2</kbd>', '<span>Menu bar</span><kbd>Alt</kbd>');
  openModal(`<h3>Keyboard shortcuts</h3><p class="sub">Drag any panel edge to resize it; drag it closed to hide it.</p><div class="kbd-table">${rows.join('')}</div><div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-close>Close</button></div>`);
}

// Buttons with data-act anywhere in the page run the matching command.
document.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (b && !b.closest('.menu')) { e.stopPropagation(); run(b.dataset.act as string); }
});

/* ================= Agents (UI) ================= */
function renderAgents(): void {
  $('#agentCards').innerHTML = Object.values(agentsDef).map(a => `
    <div class="agent ${a.status}">
      <div class="ava" style="background:${a.color}">${a.letter}</div>
      <div><span class="name">${a.name}</span> <span style="color:var(--text-3);font-size:11px">${esc(a.model)}</span></div>
      <div class="row" style="gap:4px"><span class="status ${a.status}">${statusLabel[a.status]}</span>
        ${a.status === 'working' ? '<button class="icon-btn" title="Stop" data-act="agent.stop">■</button>' : ''}</div>
      <div class="task">${esc(a.task)}</div>
      <div class="meter" title="${a.used} tool calls"><i style="width:${Math.min(100, a.used * 4)}%;background:${a.color}"></i></div>
    </div>`).join('');
}
function setAgent(k: AgentKey, status: AgentStatus, task: string, used?: number): void {
  Object.assign(agentsDef[k], { status, task });
  if (used != null) agentsDef[k].used = used;
  renderAgents(); vibeTick();
}

const chat = $('#chat');
function addMsg(html: string): HTMLElement {
  const d = document.createElement('div'); d.innerHTML = html;
  const el = d.firstElementChild as HTMLElement;
  chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
  saveChat();
  return el;
}
function agentMsg(k: AgentKey, html: string): HTMLElement {
  const a = agentsDef[k];
  const when = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return addMsg(`<div class="msg"><div class="meta"><span class="avatar" style="background:${a.color};width:16px;height:16px;font-size:9px;margin:0;border:none">${a.letter}</span><b>${a.name}</b> ${when}</div><div class="body">${html}</div></div>`);
}
function userMsg(text: string): void {
  const when = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  addMsg(`<div class="msg user"><div class="meta"><b>${esc(user?.name ?? 'You')}</b> ${when}</div><div class="body">${esc(text)}</div></div>`);
}
function emptyChat(): void {
  chat.innerHTML = `<div class="empty"><div><img src="Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div>Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
}
// A small, safe subset of Markdown for agent replies: code blocks, inline code, bold and line breaks.
function md(text: string): string {
  return text.split(/```[\w-]*\n?/).map((part, i) => (i % 2
    ? `<pre>${esc(part.replace(/\n$/, ''))}</pre>`
    : esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>'))).join('');
}
const TOOL_ICON: Record<string, string> = { read: '◔', edit: '✎', run: '❯', search: '⌕', web: '◍', todo: '☑', agent: '◇', tool: '•', note: 'ℹ' };
function toolLine(kind: string, label: string): void {
  addMsg(`<div class="tool-line ${kind}"><span class="ti">${TOOL_ICON[kind] ?? '•'}</span><span class="tl">${esc(label)}</span></div>`);
}

// Chat history is kept per project folder so a reload brings it back.
const chatKey = () => `breeze.chat:${rootInfo?.root ?? ''}`;
const agentSessionKey = () => `breeze.agentSession:${rootInfo?.root ?? ''}:${appState.agent ?? ''}`;
let chatTimer: number | undefined;
function saveChat(): void {
  clearTimeout(chatTimer);
  chatTimer = setTimeout(() => {
    if (!rootInfo) return;
    const html = chat.querySelector('.empty') ? '' : chat.innerHTML;
    if (html && html.length < 400000) store.set(chatKey(), html); else store.del(chatKey());
  }, 400);
}
function restoreChat(): void {
  const html = store.get<string>(chatKey(), '');
  if (!html) { emptyChat(); return; }
  chat.innerHTML = html;
  // Buttons from an earlier run have no handlers any more; show them as settled.
  $$('[data-live]', chat).forEach(el => { el.outerHTML = '<div class="resolved">Earlier session</div>'; });
  chat.scrollTop = chat.scrollHeight;
}

interface Run { id: number; agent: string; mode: AgentMode; uiMode: string; phase: AgentKey; tools: number; files: Set<string>; plan: string | null; lastText: string; lastMsg?: HTMLElement; }
let agentRun: Run | null = null;
let lastRunFiles: string[] = [];
const promptBox = $<HTMLTextAreaElement>('#prompt');
$('#send').onclick = () => (agentRun ? stopAgent() : sendPrompt());
promptBox.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); } });
$('#newChat').onclick = () => {
  if (agentRun) stopAgent();
  store.del(agentSessionKey()); store.del(chatKey());
  emptyChat();
  setAgent('planner', 'idle', 'Waiting for a prompt', 0);
  setAgent('builder', 'idle', 'Waiting for a plan', 0);
  promptBox.focus();
};
commands['agent.stop'] = () => stopAgent();

function setBusy(on: boolean): void {
  const b = $('#send');
  b.classList.toggle('stop', on);
  b.textContent = on ? '■ Stop' : 'Send ↵';
  b.title = on ? 'Stop the agent' : 'Send (Enter)';
}
function stopAgent(): void {
  if (agentRun) api.agent.stop(agentRun.id);
}

async function sendPrompt(): Promise<void> {
  const text = promptBox.value.trim();
  if (!text || agentRun) return;
  const agent = selectedAgent();
  if (!agent) { openAgentPicker(); return; }
  if (!rootInfo) { toast('Open a folder first, so the agent knows what to work on'); return; }
  const uiMode = $<HTMLSelectElement>('#agentMode').value;
  promptBox.value = '';
  if (chat.querySelector('.empty')) chat.innerHTML = '';
  userMsg(text);
  await startAgentRun(agent.id, uiMode === 'build' ? 'build' : uiMode === 'ask' ? 'ask' : 'plan', text, uiMode);
}

async function startAgentRun(agentId: string, mode: AgentMode, prompt: string, uiMode: string): Promise<void> {
  const phase: AgentKey = mode === 'build' ? 'builder' : 'planner';
  setAgent(phase, 'working', mode === 'build' ? 'Working on your request' : 'Reading the project', 0);
  if (phase === 'planner') setAgent('builder', 'idle', 'Waiting for a plan', 0);
  setBusy(true);
  try {
    const id = await api.agent.run({ agent: agentId, mode, prompt, session: store.get<string | null>(agentSessionKey(), null) });
    agentRun = { id, agent: agentId, mode, uiMode, phase, tools: 0, files: new Set(), plan: null, lastText: '' };
  } catch (e) {
    setBusy(false);
    setAgent(phase, 'idle', 'Could not start', 0);
    errorCard(errMsg(e));
  }
}

function errorCard(text: string, hint?: string, action?: string): void {
  const el = addMsg(`<div class="card error"><h5>⚠ The agent hit a problem</h5><pre>${esc(text)}</pre>${hint ? `<p>${esc(hint)}</p>` : ''}${action === 'openApp' ? '<div class="row" data-live><button class="btn btn-sm btn-primary" data-openapp>Open project in Antigravity</button></div>' : ''}</div>`);
  el.querySelector<HTMLElement>('[data-openapp]')?.addEventListener('click', () => api.agent.openApp(agentRun?.agent ?? appState.agent ?? '').catch(e => toast(errMsg(e))));
}

api.agent.onEvent((runId, ev) => {
  const r = agentRun;
  if (!r || runId !== r.id) return;
  if (ev.t === 'session' && ev.id) store.set(agentSessionKey(), ev.id);
  else if (ev.t === 'text' && ev.text) { r.lastText = ev.text; r.lastMsg = agentMsg(r.phase, md(ev.text)); }
  else if (ev.t === 'tool') {
    r.tools++;
    toolLine(ev.kind ?? 'tool', ev.label ?? '');
    setAgent(r.phase, 'working', ev.label ?? 'Working', r.tools);
  } else if (ev.t === 'file' && ev.path) {
    r.files.add(ev.path);
    locks[ev.path] = r.phase;
    renderTree(); renderTabs();
    queueGitRefresh();
  } else if (ev.t === 'plan') r.plan = ev.text ?? '';
  else if (ev.t === 'note' && ev.text) toolLine('note', ev.text);
  else if (ev.t === 'error') {
    // Some CLIs print the error as a reply too; show it once, in the error card.
    if (r.lastMsg && ev.text?.trim() === r.lastText.trim()) r.lastMsg.remove();
    errorCard(ev.text ?? 'Unknown error', ev.hint, ev.action);
  }
  else if (ev.t === 'done') finishRun(r, ev);
});

function finishRun(r: Run, ev: AgentEvent): void {
  agentRun = null;
  setBusy(false);
  for (const k of Object.keys(locks)) delete locks[k];
  renderTree(); renderTabs();
  lastRunFiles = [...r.files];
  vibeDone();
  queueGitRefresh();
  if (ev.stopped) { addMsg('<div class="handoff">Stopped by you</div>'); setAgent(r.phase, 'idle', 'Stopped', r.tools); return; }
  if (!ev.ok) { setAgent(r.phase, 'idle', 'Stopped with an error', r.tools); return; }
  const bits = [ev.ms ? `${Math.max(1, Math.round(ev.ms / 1000))}s` : '', r.files.size ? `${r.files.size} file${r.files.size > 1 ? 's' : ''} changed` : '', ev.cost ? `$${ev.cost.toFixed(2)}` : ev.tokens ? `${ev.tokens.toLocaleString()} tokens` : ''].filter(Boolean);
  if (r.uiMode === 'plan' && r.mode === 'plan') {
    const plan = (r.plan || r.lastText).trim();
    if (!plan) { setAgent('planner', 'done', 'Answered', r.tools); return; }
    setAgent('planner', 'waiting', 'Waiting for plan approval', r.tools);
    const el = addMsg(`<div class="card plan"><h5>📋 Plan</h5><div class="plan-body">${md(plan)}</div><div class="row" data-live><button class="btn btn-primary btn-sm" data-plan="ok">Approve &amp; build</button><button class="btn btn-sm" data-plan="edit">Change something</button></div></div>`);
    $$('[data-plan]', el).forEach(b => b.onclick = () => {
      const ok = b.dataset.plan === 'ok';
      $('[data-live]', el).outerHTML = `<div class="resolved">${ok ? '✓ Approved' : '✎ Asked for changes'}</div>`;
      saveChat();
      if (ok) {
        setAgent('planner', 'done', 'Plan handed off', r.tools);
        addMsg('<div class="handoff">Planner → Builder</div>');
        startAgentRun(r.agent, 'build', 'The plan is approved. Implement it now, then summarize what you changed.', 'build');
      } else {
        setAgent('planner', 'idle', 'Waiting for your changes', r.tools);
        promptBox.focus();
        promptBox.placeholder = 'What should change in the plan?';
      }
    });
    return;
  }
  setAgent(r.phase, 'done', r.files.size ? `Changed ${r.files.size} file${r.files.size > 1 ? 's' : ''}` : 'Answered', r.tools);
  const el = addMsg(`<div class="run-done"><span>✓ Done${bits.length ? ' · ' + bits.join(' · ') : ''}</span>${r.files.size ? '<button class="btn btn-sm" data-live data-review>Review changes</button>' : ''}</div>`);
  el.querySelector<HTMLElement>('[data-review]')?.addEventListener('click', () => showView('git', true));
  promptBox.placeholder = 'Describe what you want to build…';
  if (r.files.size && running) reloadPreview();
}

/* ================= Source control (git) ================= */
let gitState: GitStatus = { repo: false };
let gitLog: { head: string | null; commits: GitCommit[] } = { head: null, commits: [] };
let gitBusy = false;
let openCommit: string | null = null;
const commitDetails = new Map<string, GitCommitDetail>();
const scmCollapsed = new Set<string>(store.get<string[]>('breeze.scmCollapsed', []));
let gitTimer: number | undefined;
function queueGitRefresh(): void { clearTimeout(gitTimer); gitTimer = setTimeout(refreshGit, 400); }
window.addEventListener('focus', () => { if (rootInfo) queueGitRefresh(); });

async function refreshGit(): Promise<void> {
  if (!rootInfo) { gitState = { repo: false }; renderScm(); renderBranch(); return; }
  try {
    gitState = await api.git.status();
    gitLog = gitState.repo && gitState.hasCommits ? await api.git.log() : { head: null, commits: [] };
  } catch (e) { gitState = { repo: false }; }
  renderScm(); renderBranch(); renderTree();
}
function renderBranch(): void {
  const b = $('#sbBranch');
  const s = gitState;
  b.textContent = s.repo ? `⎇ ${s.branch || 'main'}${s.ahead ? ` ↑${s.ahead}` : ''}${s.behind ? ` ↓${s.behind}` : ''}` : '⎇ no repository';
  const n = s.files?.length ?? 0;
  const badge = $('.act-btn[data-view=git] .badge');
  badge.textContent = n > 99 ? '99+' : n ? String(n) : '';
  badge.classList.toggle('hidden', !n);
}
// Explorer decorations: path -> status class, plus every folder that contains a change.
function gitDecor(): { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>(), dirs = new Set<string>();
  for (const f of gitState.files ?? []) {
    files.set(f.path, statusOf(f).cls);
    for (let d = dirName(f.path); d; d = dirName(d)) dirs.add(d);
  }
  return { files, dirs };
}
function statusOf(f: GitFile, staged = false): { letter: string; cls: string; title: string } {
  const c = staged ? f.x : f.y === ' ' ? f.x : f.y;
  if (f.x === '?' || f.y === '?') return { letter: 'U', cls: 'git-u', title: 'Untracked' };
  if (c === 'A') return { letter: 'A', cls: 'git-a', title: 'Added' };
  if (c === 'D') return { letter: 'D', cls: 'git-d', title: 'Deleted' };
  if (c === 'R') return { letter: 'R', cls: 'git-m', title: 'Renamed' };
  if (c === 'U') return { letter: '!', cls: 'git-d', title: 'Conflict' };
  return { letter: 'M', cls: 'git-m', title: 'Modified' };
}

function renderScm(): void {
  const el = $('#scm');
  if (!rootInfo) { el.innerHTML = '<p class="side-note">Open a folder to use source control.</p>'; return; }
  if (!gitState.repo) {
    el.innerHTML = `<div class="side-note">This folder isn't a git repository yet. Turn it on to save checkpoints you can always go back to.<button class="btn btn-primary btn-sm" data-act="git.init">Initialize Repository</button></div>`;
    return;
  }
  const files = gitState.files ?? [];
  const staged = files.filter(f => f.x !== ' ' && f.x !== '?');
  const changes = files.filter(f => f.y !== ' ' || f.x === '?');
  const commitLabel = staged.length ? 'Commit' : changes.length ? 'Commit All' : 'Commit';
  const s = gitState;
  const syncLabel = !s.hasRemote ? '' : !s.upstream ? 'Publish Branch' : s.behind ? `Sync ↓${s.behind}${s.ahead ? ` ↑${s.ahead}` : ''}` : s.ahead ? `Push ↑${s.ahead}` : '';
  const row = (f: GitFile, inStaged: boolean) => {
    const st = statusOf(f, inStaged);
    return `<div class="scm-row ${st.cls}${seenScm.has(f.path + inStaged) ? '' : ' enter'}" data-file="${escAttr(f.path)}" data-staged="${inStaged ? 1 : ''}" title="${escAttr(f.path)} · ${st.title}">
      <span class="ico">${fileIcon(baseName(f.path))}</span><span class="nm">${esc(baseName(f.path))}</span><span class="dir">${esc(dirName(f.path))}</span>
      <span class="acts">
        <button class="icon-btn" data-scm="open" title="Open File">↗</button>
        ${inStaged ? '' : '<button class="icon-btn" data-scm="discard" title="Discard Changes">↺</button>'}
        <button class="icon-btn" data-scm="${inStaged ? 'unstage' : 'stage'}" title="${inStaged ? 'Unstage' : 'Stage'} Changes">${inStaged ? '−' : '+'}</button>
      </span><span class="st">${st.letter}</span></div>`;
  };
  const section = (key: string, title: string, list: GitFile[], inStaged: boolean, acts: string) => !list.length ? '' : `
    <div class="scm-sec ${scmCollapsed.has(key) ? 'closed' : ''}" data-sec="${key}">
      <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">${title}</span><span class="acts">${acts}</span><span class="count">${list.length}</span></div>
      <div class="scm-list">${list.map(f => row(f, inStaged)).join('')}</div>
    </div>`;
  const html = `
    <div class="commit-box">
      <textarea class="input" id="scmMsg" rows="2" placeholder="Message (Ctrl+Enter to commit on ‘${escAttr(s.branch || 'main')}’)"></textarea>
      <button class="btn btn-primary btn-sm commit-btn" data-act="git.commit" ${files.length ? '' : 'disabled'}>✓ ${commitLabel}</button>
      ${syncLabel ? `<button class="btn btn-sm commit-btn" data-act="git.sync">${syncLabel}</button>` : ''}
    </div>
    ${section('staged', 'Staged Changes', staged, true, '<button class="icon-btn" data-scm-all="unstage" title="Unstage All">−</button>')}
    ${section('changes', 'Changes', changes, false, '<button class="icon-btn" data-scm-all="discard" title="Discard All Changes">↺</button><button class="icon-btn" data-scm-all="stage" title="Stage All Changes">+</button>')}
    ${!files.length ? '<p class="side-note">No changes. Everything is saved in a checkpoint.</p>' : ''}
    <div class="scm-sec graph ${scmCollapsed.has('graph') ? 'closed' : ''}" data-sec="graph">
      <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">Checkpoints</span><span class="count">${gitLog.commits.length}</span></div>
      <div class="scm-list">${renderGraphRows()}</div>
    </div>`;
  el.innerHTML = html;
  seenScm.clear();
  for (const f of staged) seenScm.add(f.path + true);
  for (const f of changes) seenScm.add(f.path + false);
  const msg = $<HTMLTextAreaElement>('#scmMsg', el);
  msg.value = scmDraft;
  msg.oninput = () => { scmDraft = msg.value; };
  msg.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run('git.commit'); } };
}
let scmDraft = '';
const seenScm = new Set<string>();

$('#scm').addEventListener('click', async e => {
  const t = e.target as HTMLElement;
  const head = t.closest<HTMLElement>('.scm-head');
  if (head && !t.closest('button')) {
    const key = (head.parentElement as HTMLElement).dataset.sec as string;
    if (scmCollapsed.has(key)) scmCollapsed.delete(key); else scmCollapsed.add(key);
    head.parentElement?.classList.toggle('closed');
    store.set('breeze.scmCollapsed', [...scmCollapsed]);
    return;
  }
  const all = t.closest<HTMLElement>('[data-scm-all]');
  if (all) {
    const files = gitState.files ?? [];
    const kind = all.dataset.scmAll;
    if (kind === 'stage') gitOp(() => api.git.stage(files.filter(f => f.y !== ' ' || f.x === '?').map(f => f.path)));
    if (kind === 'unstage') gitOp(() => api.git.unstage(files.filter(f => f.x !== ' ' && f.x !== '?').map(f => f.path), !!gitState.hasCommits));
    if (kind === 'discard') confirmDiscardChanges(files.filter(f => f.y !== ' ' || f.x === '?'));
    return;
  }
  const commitRow = t.closest<HTMLElement>('[data-commit]');
  if (commitRow) { toggleCommit(commitRow.dataset.commit as string); return; }
  const rowEl = t.closest<HTMLElement>('.scm-row');
  if (!rowEl) return;
  const path = rowEl.dataset.file as string;
  const inStaged = !!rowEl.dataset.staged;
  const f = (gitState.files ?? []).find(x => x.path === path);
  const act = t.closest<HTMLElement>('[data-scm]')?.dataset.scm;
  if (act === 'open') openFile(path);
  else if (act === 'stage') gitOp(() => api.git.stage([path]));
  else if (act === 'unstage') gitOp(() => api.git.unstage([path], !!gitState.hasCommits));
  else if (act === 'discard' && f) confirmDiscardChanges([f]);
  else if (f) showDiff(f, inStaged);
});

async function gitOp(fn: () => Promise<unknown>, done?: string): Promise<boolean> {
  if (gitBusy) return false;
  gitBusy = true;
  $('#scm').classList.add('busy');
  try { await fn(); if (done) toast(done); return true; }
  catch (e) {
    const m = errMsg(e);
    if (m.length > 90 || m.includes('\n')) openModal(`<h3>Git said no</h3><pre class="git-err">${esc(m)}</pre><div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-close>OK</button></div>`);
    else toast(m);
    return false;
  } finally {
    gitBusy = false;
    $('#scm').classList.remove('busy');
    await refreshGit();
  }
}
function confirmDiscardChanges(files: GitFile[]): void {
  if (!files.length) return;
  const untracked = files.filter(f => f.x === '?').length;
  openModal(`<h3>Discard ${files.length === 1 ? `changes in ${esc(baseName(files[0].path))}` : `${files.length} changes`}?</h3>
    <p class="sub">${untracked ? `${untracked} new file${untracked > 1 ? 's go' : ' goes'} to the Recycle Bin. ` : ''}Edits to tracked files go back to the last checkpoint. This can't be undone with Ctrl+Z.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="discardOk">Discard</button></div>`, m => {
    $('#discardOk', m).onclick = () => {
      closeModal();
      gitOp(() => api.git.discard(files.map(f => ({ path: f.path, untracked: f.x === '?' }))));
    };
  });
}
async function showDiff(f: GitFile, staged: boolean): Promise<void> {
  let text = '';
  try {
    if (f.x === '?') {
      const r = await api.fs.readFile(f.path);
      text = (r.text ?? '(binary file)').split('\n').map(l => '+' + l).join('\n');
    } else text = await api.git.diff(f.path, staged);
  } catch (e) { toast(errMsg(e)); return; }
  const lines = text.split('\n').filter(l => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  const body = lines.map(l => {
    const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return `<div class="dl ${cls}">${esc(l) || ' '}</div>`;
  }).join('') || '<div class="dl">No textual changes.</div>';
  openModal(`<div class="diff-head"><span class="ico">${fileIcon(baseName(f.path))}</span><b>${esc(f.path)}</b><span class="pill">${staged ? 'Staged' : statusOf(f).title}</span></div>
    <div class="diff">${body}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="diffOpen">Open File</button><button class="btn btn-primary" id="diffStage">${staged ? 'Unstage' : 'Stage'}</button></div>`, m => {
    $('#diffOpen', m).onclick = () => { closeModal(); openFile(f.path); };
    $('#diffStage', m).onclick = () => { closeModal(); gitOp(() => (staged ? api.git.unstage([f.path], !!gitState.hasCommits) : api.git.stage([f.path]))); };
  }, undefined, 'top');
}

/* ----- Commit graph ----- */
const LANE_COLORS = ['#7aa9ff', '#c4b5fd', '#86efac', '#fdba74', '#f9a8d4', '#7dd3fc'];
interface GraphRow { c: GitCommit; lane: number; before: (string | null)[]; after: (string | null)[]; merges: number[]; forks: number[]; }
function layoutGraph(commits: GitCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) { lane = lanes.indexOf(null); if (lane === -1) lane = lanes.length; lanes[lane] = c.hash; }
    const before = lanes.slice();
    const merges = before.map((h, i) => (h === c.hash && i !== lane ? i : -1)).filter(i => i >= 0);
    merges.forEach(i => { lanes[i] = null; });
    const forks: number[] = [];
    lanes[lane] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      let i = lanes.indexOf(p);
      if (i === -1) { i = lanes.indexOf(null); if (i === -1) i = lanes.length; lanes[i] = p; }
      forks.push(i);
    }
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    rows.push({ c, lane, before, after: lanes.slice(), merges, forks });
  }
  return rows;
}
function renderGraphRows(): string {
  if (!gitLog.commits.length) return '<p class="side-note">No checkpoints yet. Commit your changes to save the first one.</p>';
  const rows = layoutGraph(gitLog.commits);
  const H = 30, X = (i: number) => 10 + i * 12, mid = H / 2;
  const width = Math.min(6, Math.max(...rows.map(r => Math.max(r.before.length, r.after.length, r.lane + 1)))) * 12 + 8;
  return rows.map(r => {
    const col = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
    let svg = '';
    r.before.forEach((h, i) => {
      if (!h) return;
      if (i === r.lane) svg += `<path d="M${X(i)} 0V${mid}" stroke="${col(i)}"/>`;
      else if (r.merges.includes(i)) svg += `<path d="M${X(i)} 0C${X(i)} ${mid} ${X(r.lane)} ${mid / 2} ${X(r.lane)} ${mid}" stroke="${col(i)}"/>`;
      else svg += `<path d="M${X(i)} 0V${H}" stroke="${col(i)}"/>`;
    });
    if (r.after[r.lane]) svg += `<path d="M${X(r.lane)} ${mid}V${H}" stroke="${col(r.lane)}"/>`;
    for (const f of r.forks) svg += `<path d="M${X(r.lane)} ${mid}C${X(r.lane)} ${H} ${X(f)} ${mid} ${X(f)} ${H}" stroke="${col(f)}"/>`;
    const isHead = r.c.hash === gitLog.head;
    svg += `<circle cx="${X(r.lane)}" cy="${mid}" r="${isHead ? 5 : 4}" fill="${isHead ? col(r.lane) : 'var(--bg-1)'}" stroke="${col(r.lane)}" stroke-width="2"/>`;
    const refs = r.c.refs.map(ref => {
      const name = ref.replace(/^HEAD -> /, '');
      const cls = ref.startsWith('HEAD') ? 'head' : ref.startsWith('tag: ') ? 'tag' : ref.includes('/') ? 'remote' : 'branch';
      return `<span class="ref ${cls}">${esc(name.replace(/^tag: /, ''))}</span>`;
    }).join('');
    const open = openCommit === r.c.hash;
    const detail = open ? commitDetailHtml(commitDetails.get(r.c.hash)) : '';
    return `<div class="commit ${open ? 'on' : ''}" data-commit="${r.c.hash}" title="${escAttr(r.c.subject)}">
      <svg width="${width}" height="${H}" fill="none" stroke-width="2">${svg}</svg>
      <div class="msgline"><div>${refs}${esc(r.c.subject)}</div><small>${esc(r.c.author)} · ${esc(r.c.when)}</small></div>
    </div>${detail}`;
  }).join('');
}
function commitDetailHtml(d?: GitCommitDetail): string {
  if (!d) return '<div class="commit-detail"><div class="side-note">Loading…</div></div>';
  return `<div class="commit-detail">
    <div class="cd-msg">${esc(d.message)}</div>
    <div class="cd-meta">${esc(d.author)} · ${esc(d.when)} · <code>${d.hash.slice(0, 8)}</code></div>
    ${d.files.map(f => `<div class="file" data-open-file="${escAttr(f.path)}"><span class="ico">${fileIcon(baseName(f.path))}</span><span class="fp">${esc(f.path)}</span><span><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span></div>`).join('')}
    <div class="row" style="margin-top:8px"><button class="btn btn-sm" data-branch-from="${d.hash}">Branch from here</button><button class="btn btn-sm" data-copy-hash="${d.hash}">Copy id</button></div>
  </div>`;
}
async function toggleCommit(hash: string): Promise<void> {
  openCommit = openCommit === hash ? null : hash;
  renderScm();
  if (openCommit && !commitDetails.has(hash)) {
    try { commitDetails.set(hash, await api.git.show(hash)); } catch (e) { toast(errMsg(e)); openCommit = null; }
    renderScm();
  }
}
$('#scm').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const f = t.closest<HTMLElement>('[data-open-file]');
  if (f) { e.stopPropagation(); openFile(f.dataset.openFile as string); }
  const b = t.closest<HTMLElement>('[data-branch-from]');
  if (b) { e.stopPropagation(); newBranch(b.dataset.branchFrom); }
  const c = t.closest<HTMLElement>('[data-copy-hash]');
  if (c) { e.stopPropagation(); navigator.clipboard?.writeText(c.dataset.copyHash ?? '').catch(() => {}); toast('Commit id copied'); }
}, true);

async function commitNow(): Promise<void> {
  const msg = scmDraft.trim();
  if (!msg) { toast('Write a short message describing this checkpoint'); $('#scmMsg')?.focus(); return; }
  const files = gitState.files ?? [];
  if (!files.length) { toast('Nothing to commit'); return; }
  await saveAll();
  const all = !files.some(f => f.x !== ' ' && f.x !== '?');
  let hash = '';
  if (await gitOp(async () => { hash = await api.git.commit(msg, all); })) {
    scmDraft = '';
    renderScm();
    toast(`Checkpoint saved · ${hash}`);
  }
}
async function newBranch(from?: string): Promise<void> {
  const name = await askName(from ? 'New branch from this checkpoint' : 'New branch', '', 'Create');
  if (!name) return;
  gitOp(() => api.git.switchTo(name, true, from), `Switched to new branch ${name}`);
}
async function pickBranch(): Promise<void> {
  if (!gitState.repo) { showView('git', true); return; }
  const branches = await api.git.branches().catch(() => [] as string[]);
  openModal(`<input class="input" style="width:100%" id="brIn" placeholder="Switch to a branch, or type a new name" spellcheck="false"><div class="qo-list" id="brList"></div>`, m => {
    const input = $<HTMLInputElement>('#brIn', m);
    input.focus();
    const render = () => {
      const q = input.value.trim();
      const list = branches.filter(b => b.toLowerCase().includes(q.toLowerCase()));
      $('#brList', m).innerHTML = (q && !branches.includes(q) ? `<div class="qo-item" data-new="1"><span>＋ Create branch “${esc(q)}”</span></div>` : '')
        + list.map(b => `<div class="qo-item ${b === gitState.branch ? 'on' : ''}" data-br="${escAttr(b)}"><span>⎇ ${esc(b)}</span>${b === gitState.branch ? '<small>current</small>' : ''}</div>`).join('');
      $$('[data-br]', m).forEach(el => el.onclick = () => { closeModal(); if (el.dataset.br !== gitState.branch) gitOp(() => api.git.switchTo(el.dataset.br as string, false), `Switched to ${el.dataset.br}`); });
      $('[data-new]', m)?.addEventListener('click', () => { closeModal(); gitOp(() => api.git.switchTo(q, true), `Switched to new branch ${q}`); });
    };
    input.oninput = render;
    input.onkeydown = e => { if (e.key === 'Enter') ($('[data-new], [data-br]', m) as HTMLElement | null)?.click(); };
    render();
  }, undefined, 'top');
}
$('#sbBranch').onclick = pickBranch;
Object.assign(commands, {
  'git.refresh': refreshGit,
  'git.init': () => gitOp(() => api.git.init(), 'Repository created'),
  'git.commit': commitNow,
  'git.sync': () => {
    const s = gitState;
    if (!s.upstream) return gitOp(() => api.git.sync('push'), 'Branch published');
    if (s.behind) return gitOp(async () => { await api.git.sync('pull'); if (s.ahead) await api.git.sync('push'); }, 'In sync');
    return gitOp(() => api.git.sync('push'), 'Pushed');
  },
  'git.more': () => {
    const r = $('[data-act="git.more"]').getBoundingClientRect();
    popupMenu(r.left, r.bottom + 4, [
      { label: 'Pull', run: () => gitOp(() => api.git.sync('pull'), 'Pulled') },
      { label: 'Push', run: () => gitOp(() => api.git.sync('push'), 'Pushed') },
      { label: 'Fetch', run: () => gitOp(() => api.git.sync('fetch'), 'Fetched') },
      { sep: true },
      { label: 'Switch Branch…', run: pickBranch },
      { label: 'Create Branch…', run: () => newBranch() },
    ]);
  },
});

/* ================= Views ================= */
function showView(v: string, reveal = false): void {
  layout.view = v;
  if (reveal && !layout.sideOpen) layout.sideOpen = true;
  applyLayout();
  $$('.act-btn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== v));
  if (v === 'git') refreshGit();
  if (v === 'people') renderPeople();
}
// Clicking the active view's icon again collapses the side bar, like VS Code.
$$('.act-btn[data-view]').forEach(b => b.onclick = () => {
  const v = b.dataset.view as string;
  if (v === layout.view && layout.sideOpen) { layout.sideOpen = false; applyLayout(); } else showView(v, true);
});

/* ================= Collaboration ================= */
let sharing = false;
let shareKey = '';
let guests: Person[] = [];
const share: Record<'files' | 'preview' | 'terminal', boolean> = { files: true, preview: true, terminal: false };

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const raw = [...bytes].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 26);
  return 'brz-' + (raw.match(/.{1,6}/g) ?? []).join('-');
}
$('#shareBtn').onclick = openShare;
function openShare(): void {
  if (!shareKey) shareKey = newKey();
  openModal(`
    <h3>Share this project</h3>
    <p class="sub">Send this key to a friend. They'll wait until you let them in.</p>
    <div class="keybox"><span style="flex:1" id="keyText">${shareKey}</span><button class="btn btn-sm" id="copyKey">Copy</button></div>
    <div class="toggle-row"><span>Share files</span><button class="switch ${share.files ? 'on' : ''}" data-sw="files" aria-label="Share files"></button></div>
    <div class="toggle-row"><span>Share preview</span><button class="switch ${share.preview ? 'on' : ''}" data-sw="preview" aria-label="Share preview"></button></div>
    <div class="toggle-row"><span>Share terminal <small style="color:var(--text-3)">(they could see command output)</small></span><button class="switch ${share.terminal ? 'on' : ''}" data-sw="terminal" aria-label="Share terminal"></button></div>
    <p style="color:var(--text-3);font-size:12px;margin:10px 0 0">Relay runs on <b style="color:var(--text-2)">ALEX-LAPTOP</b> (LAN, tunnel backup). It can see shared code. Key expires in 4 hours.</p>
    <div id="joinSlot"></div>
    <div class="row" style="justify-content:space-between;margin-top:16px">
      <div class="row"><button class="btn btn-sm btn-ghost" id="regen">New key</button>${sharing ? '<button class="btn btn-sm btn-ghost" id="endShare" style="color:var(--err)">End session</button>' : ''}</div>
      <button class="btn btn-primary" data-close>${sharing ? 'Done' : 'Start sharing'}</button>
    </div>`, m => {
    $('#copyKey', m).onclick = () => { navigator.clipboard?.writeText(shareKey).catch(() => {}); toast('Key copied'); };
    $('#regen', m).onclick = () => { shareKey = newKey(); $('#keyText', m).textContent = shareKey; toast('Old key revoked'); };
    $$('[data-sw]', m).forEach(s => s.onclick = () => {
      const k = s.dataset.sw as keyof typeof share;
      share[k] = !share[k]; s.classList.toggle('on');
    });
    const end = m.querySelector<HTMLElement>('#endShare');
    if (end) end.onclick = () => { sharing = false; guests = []; guestCursor = null; shareKey = ''; closeModal(); updateShare(); renderCode(); toast('Session ended'); };
    if (!sharing) { sharing = true; updateShare(); setTimeout(() => joinRequest(m), 2200); }
  });
}
function joinRequest(m: HTMLElement): void {
  const slot = m.querySelector<HTMLElement>('#joinSlot');
  if (!slot || !slot.isConnected || guests.length) return;
  let role: Role = 'Viewer';
  slot.innerHTML = `<div class="join-req"><div style="font-weight:600;margin-bottom:6px">Sam wants to join</div>
    <div class="row" style="margin-bottom:10px"><span style="color:var(--text-2)">Role:</span><div class="seg" style="flex:1"><button class="on" data-role>Viewer</button><button data-role>Editor</button></div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-sm" id="denyJoin">Deny</button><button class="btn btn-sm btn-primary" id="allowJoin">Allow</button></div></div>`;
  $$('[data-role]', slot).forEach(b => b.onclick = () => { role = b.textContent as Role; $$('[data-role]', slot).forEach(x => x.classList.toggle('on', x === b)); });
  $('#denyJoin', slot).onclick = () => { slot.innerHTML = '<p class="resolved" style="margin-top:10px">Request denied.</p>'; };
  $('#allowJoin', slot).onclick = () => {
    guests.push({ name: 'Sam', role, color: '#fb923c' });
    slot.innerHTML = `<p class="resolved" style="margin-top:10px">✓ Sam joined as ${role}.</p>`;
    updateShare();
    if (role === 'Editor' && active) { guestCursor = { file: active, line: Math.min(10, (activeBuf()?.text.split('\n').length ?? 1) - 1), name: 'Sam', color: '#fb923c' }; renderCode(); }
  };
}
function updateShare(): void {
  $('#sbShare').textContent = sharing ? `● Sharing · ${guests.length + 1} people` : 'Not sharing';
  renderUser();
  $('#termShare').textContent = share.terminal && sharing ? 'Shared' : 'Not shared';
  renderPeople();
}
function renderPeople(): void {
  const rows: Person[] = [{ name: 'You', role: 'Host', color: '#7aa9ff' }, ...guests];
  $('#people').innerHTML = rows.map(p => `<div class="tree-item"><span class="avatar" style="background:${p.color};margin:0;width:20px;height:20px;font-size:9px">${p.name.slice(0, 2).toUpperCase()}</span>${p.name}<span class="pill" style="margin-left:auto">${p.role}</span></div>`).join('')
    + (sharing ? '' : `<p style="color:var(--text-3);padding:8px">Press <b>Share</b> to invite someone.</p>`);
}

/* ================= Vibe mode ================= */
let vibeArmed = false;
let vibeTimer: number | null = null;
$('#vibeArm').onclick = () => {
  vibeArmed = !vibeArmed;
  $('#vibeArm').textContent = vibeArmed ? '◉ Vibe Mode armed' : '◌ Vibe Mode off';
  $('#vibeArm').classList.toggle('armed', vibeArmed);
  if (!vibeArmed) $('#vibe').classList.add('hidden');
  toast(vibeArmed ? 'Vibe Mode armed — a Short plays if agents take longer than 5 s' : 'Vibe Mode off');
};
function vibeTick(): void {
  const working = Object.values(agentsDef).some(a => a.status === 'working' || a.status === 'waiting');
  if (vibeArmed && working && vibeTimer == null && $('#vibe').classList.contains('hidden')) {
    vibeTimer = setTimeout(() => { $('#vibeReady').classList.add('hidden'); $('#vibe').classList.remove('hidden'); }, 5000);
  }
}
function vibeDone(): void {
  if (vibeTimer != null) clearTimeout(vibeTimer);
  vibeTimer = null;
  if (!$('#vibe').classList.contains('hidden')) $('#vibeReady').classList.remove('hidden');
}
$('#vibeClose').onclick = () => $('#vibe').classList.add('hidden');
$('#vibeBack').onclick = () => { $('#vibe').classList.add('hidden'); const t = lastRunFiles[0]; if (t) openFile(t); };

/* ================= Discord ================= */
let discord = false;
$('#discord').onclick = () => {
  if (discord) { discord = false; $('#discord').textContent = 'Discord: off'; return; }
  const detail = [rootInfo?.name ?? 'No project', active ? baseName(active) : null, active ? langOf(active)[1] : null].filter(Boolean).map(s => esc(s as string)).join(' · ');
  openModal(`<h3>Show what you're doing on Discord?</h3><p class="sub">Your friends will see:</p>
    <div class="setup-card" style="margin-bottom:12px"><b>Breeze IDE</b><div style="color:var(--text-2)">Vibe coding with agents</div><div style="color:var(--text-2)">${detail}</div><div style="color:var(--text-3);font-size:12px">00:14 elapsed</div></div>
    <p class="sub" style="font-size:12px">Project and file names can include client or employer names. You can hide details anytime from the status bar.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="dOn">Turn on</button></div>`,
    m => $('#dOn', m).onclick = () => { discord = true; $('#discord').textContent = 'Discord: on'; closeModal(); });
};

/* ================= Modal & misc ================= */
let modalOnClose: (() => void) | null = null;
const modalOpen = () => !!document.querySelector('#modalRoot .scrim:not(.closing)');
function openModal(html: string, bind?: (m: HTMLElement) => void, onClose?: () => void, place: 'center' | 'top' = 'center'): void {
  closeModal();
  $$('#modalRoot .scrim.closing').forEach(x => x.remove());
  $('#modalRoot').insertAdjacentHTML('beforeend', `<div class="scrim ${place === 'top' ? 'top' : ''}"><div class="modal ${place === 'top' ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`);
  const m = $('#modalRoot .scrim:not(.closing) .modal');
  modalOnClose = onClose ?? null;
  $('#modalRoot .scrim:not(.closing)').onmousedown = e => { if ((e.target as HTMLElement).classList.contains('scrim')) closeModal(); };
  $$('[data-close]', m).forEach(b => b.onclick = closeModal);
  bind?.(m);
}
function closeModal(): void {
  const scrim = $('#modalRoot .scrim:not(.closing)');
  if (!scrim) return;
  // Play the closing animation on a detached copy so a new modal can open immediately.
  scrim.classList.add('closing');
  setTimeout(() => scrim.remove(), 150);
  const cb = modalOnClose; modalOnClose = null; cb?.();
}
function bindToasts(root: ParentNode = document): void {
  $$('[data-toast]', root).forEach(b => b.onclick = () => toast(b.dataset.toast ?? ''));
}

/* ================= Init ================= */
async function boot(): Promise<void> {
  buildMenubar();
  applyLayout();
  showView(layout.view);
  renderTree(); renderTabs(); renderEditor(); renderAgents(); renderPreview(); emptyChat(); renderScm(); renderBranch(); bindToasts();
  renderDetection();
  // The main process remembers who signed in; it wins over the renderer's copy.
  const signed = await api.auth.user().catch(() => null);
  if (signed || isDesktop) { user = signed; appState.user = signed; saveApp(); }
  if (appState.onboarded) showIde();
  else goStep(step);
  const info = await api.fs.restore().catch(() => null);
  if (info) await loadWorkspace(info);
  else { term.cwd = await api.term.cwd(); renderPs(); }
  renderTree();
  if (step === 2) renderProjectChoice();
  // Refresh the tool and agent status in the background; the cached result shows meanwhile.
  if (appState.onboarded) detectTools().catch(() => {});
}
boot();
