/* Breeze IDE — renderer logic.
   Files, search, terminal and agent detection are real in the desktop app (main.js + preload.js).
   Opened in a plain browser, a small in-memory demo project stands in for the disk.
   Agent conversations, checkpoints and collaboration are still simulated. */

/* ================= Types ================= */
type AgentKey = 'planner' | 'builder';
type AgentStatus = 'idle' | 'working' | 'waiting' | 'done';

interface Agent {
  name: string;
  letter: string;
  tint: string;   // colour class suffix, see .tint-* in breeze.css
  model: string;
  status: AgentStatus;
  task: string;
  used: number;
}
interface User { name: string; provider: string; login?: string; email?: string | null; avatar?: string | null; }
type AgentMode = 'plan' | 'build' | 'ask';
interface AgentEvent { t: 'session' | 'text' | 'plan' | 'tool' | 'file' | 'note' | 'error' | 'done'; id?: string; model?: string; text?: string; kind?: string; label?: string; path?: string; hint?: string; action?: string; ok?: boolean; stopped?: boolean; cost?: number; ms?: number; tokens?: number; }
interface AuthEvent { t: 'code' | 'waiting' | 'done' | 'error'; provider?: string; code?: string; uri?: string; user?: User; text?: string; }
interface GitFile { path: string; x: string; y: string; }
interface GitStatus { repo: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; hasCommits?: boolean; hasRemote?: boolean; files?: GitFile[]; }
interface GitCommit { hash: string; parents: string[]; author: string; when: string; refs: string[]; subject: string; }
interface GitCommitDetail { hash: string; author: string; email: string; when: string; message: string; files: { path: string; added: number; removed: number }[]; }

interface DirEntry { name: string; dir: boolean; }
interface FileRead { text?: string; binary?: boolean; tooLarge?: boolean; image?: boolean; size: number; }
interface Diag { line: number; col: number; len: number; msg: string; }
type SyntaxResult = { ok: true } | (Diag & { eof?: boolean }) | null;
interface RootInfo { root: string; name: string; }
interface SearchHit { path: string; line: number; col: number; text: string; }
interface DetectedAgent { id: string; name: string; vendor: string; url: string; found: boolean; path: string | null; version: string | null; api?: boolean; models?: string[]; }
interface Accounts { accounts: User[]; active: string | null; }
interface Completion { text: string; dir: boolean; }
interface DetectedTool { id: string; name: string; found: boolean; version: string | null; }
interface Detection { agents: DetectedAgent[]; tools: DetectedTool[]; platform: string; demo?: boolean; }
interface Rect { x: number; y: number; width: number; height: number; }

interface BreezeApi {
  fs: {
    openFolder(): Promise<RootInfo | null>;
    createFolder(): Promise<RootInfo | null>;
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
  lint: { check(code: string, ext: string): Promise<SyntaxResult>; };
  term: {
    cwd(): Promise<string>;
    run(command: string): Promise<{ id?: number; cwd?: string; error?: string }>;
    kill(id: number): Promise<void>;
    complete(word: string): Promise<Completion[]>;
    onData(cb: (id: number, chunk: string) => void): () => void;
    onExit(cb: (id: number, code: number | null) => void): () => void;
  };
  sys: { detect(): Promise<Detection>; openExternal(url: string): Promise<void>; };
  // A local LLM server (Ollama, LM Studio or anything OpenAI-compatible).
  llm: { connect(url: string, key: string): Promise<{ model: string; models: string[] }>; setModel(model: string): Promise<void>; disconnect(): Promise<void>; };
  agent: {
    run(opts: { agent: string; mode: AgentMode; prompt: string; session: string | null; box?: boolean }): Promise<number>;
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
    accounts(): Promise<Accounts>;
    switchTo(id: string): Promise<User>;
    start(provider: string): Promise<{ started?: boolean; error?: string }>;
    cancel(): Promise<void>;
    signOut(): Promise<User | null>;
    onEvent(cb: (ev: AuthEvent) => void): () => void;
  };
  // Social feeds for Vibe Mode. The desktop app signs in through its own browser window and lays the feed over #vibeFrame.
  vibe: {
    status(): Promise<Record<string, boolean>>;
    connect(id: string): Promise<boolean>;
    disconnect(id: string): Promise<void>;
    show(id: string, bounds: Rect): Promise<void>;
    bounds(bounds: Rect): Promise<void>;
    mute(muted: boolean): Promise<void>;
    hide(): Promise<void>;
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
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s: string): string => s.replaceAll(/[&<>]/g, c => ESCAPES[c]);
const escAttr = (s: string): string => esc(s).replaceAll('"', '&quot;');
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
// IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message.
const errMsg = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};
// Folders first, then names A–Z.
const byDirThenName = (a: DirEntry, b: DirEntry): number => {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};

function toast(text: string): void {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  $('#toastRoot').replaceChildren(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 2600);
}
// Starts async work without waiting for it; a failure shows as a toast.
function background(work: Promise<unknown>): void {
  work.catch(e => toast(errMsg(e)));
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
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
// Browser preview: a drawn stand-in for the demo project's photo.
const bean = ([x, y, r]: number[]) =>
  `<g transform="translate(${x} ${y}) rotate(${r})"><ellipse rx="54" ry="36" fill="#6b4226"/><path d="M-46 0c24-16 68 16 92 0" fill="none" stroke="#2b1d12" stroke-width="7" stroke-linecap="round"/></g>`;
const DEMO_BEANS = [[190, 160, -30], [320, 225, 20], [450, 150, -10], [255, 300, 40], [470, 290, -40]].map(bean).join('');
const DEMO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4ece1"/>${DEMO_BEANS}</svg>`);

let demoRun = 0;
const agentListeners: ((runId: number, ev: AgentEvent) => void)[] = [];
const authListeners: ((ev: AuthEvent) => void)[] = [];
// Browser preview: replays a short, canned agent run.
async function demoReplay(id: number, mode: AgentMode): Promise<void> {
  const steps: [AgentEvent, number][] = [
    [{ t: 'session', id: 'demo-session', model: 'demo' }, 100],
    [{ t: 'tool', kind: 'read', label: 'Read index.html' }, 600],
    [{ t: 'tool', kind: 'read', label: 'Read styles.css' }, 900],
  ];
  if (mode === 'build') {
    steps.push(
      [{ t: 'tool', kind: 'edit', label: 'Edited styles.css' }, 2500],
      [{ t: 'tool', kind: 'run', label: '$ npx prettier --check styles.css' }, 3000],
      [{ t: 'text', text: 'Done — I warmed up the hero colours in styles.css. (Browser preview: no files were really changed.)' }, 2500],
    );
  } else if (mode === 'plan') {
    steps.push(
      [{ t: 'text', text: 'I looked at the page and its styles.' }, 600],
      [{ t: 'plan', text: '1. Make the hero taller with a warm gradient\n2. Turn the menu into three cards\n3. Add a footer with opening hours' }, 500],
    );
  } else {
    steps.push([{ t: 'text', text: 'The page has a hero section, an empty menu section and a small greeting script. (Browser preview answer.)' }, 600]);
  }
  steps.push([{ t: 'done', ok: true, ms: 2400 }, 300]);
  // Each step waits for the one before it.
  await steps.reduce(async (prev, [ev, ms]) => {
    await prev;
    await wait(ms);
    agentListeners.forEach(cb => cb(id, ev));
  }, Promise.resolve());
}
// Browser preview: clipboard and selection commands act on the focused field.
async function demoEdit(role: string): Promise<void> {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  const [s, e] = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
  if (role === 'selectAll') el.select();
  else if (role === 'copy' || role === 'cut') {
    await navigator.clipboard.writeText(el.value.slice(s, e));
    if (role === 'cut') el.setRangeText('', s, e, 'end');
  } else if (role === 'paste') el.setRangeText(await navigator.clipboard.readText(), s, e, 'end');
  el.dispatchEvent(new Event('input'));
}

function demoApi(): BreezeApi {
  const files = new Map(Object.entries(DEMO_FILES));
  const binary = new Set(['assets/beans.jpg']);
  const dirs = new Set(['assets']);
  let info: RootInfo = { root: 'demo:/coffee-shop-landing', name: 'coffee-shop-landing' };
  let accounts: User[] = [];
  let current: User | null = null;
  const accountKey = (u: User) => u.provider + ':' + (u.login ?? '');
  const under = (p: string, rel: string) => (rel ? p.startsWith(rel + '/') : true);
  const exists = (p: string) => files.has(p) || dirs.has(p);
  const inside = (k: string, rel: string) => k === rel || k.startsWith(rel + '/');
  const needOpen = () => { if (!store.get('breeze.demoOpen', false)) throw new Error('No folder is open'); };
  const feeds = () => store.get<Record<string, boolean>>('breeze.demoVibe', {});
  return {
    fs: {
      async openFolder() { store.set('breeze.demoOpen', true); return info; },
      // Browser preview: a new, empty in-memory project.
      async createFolder() {
        files.clear(); dirs.clear(); binary.clear();
        files.set('README.md', '# My Breeze project\n');
        info = { root: 'demo:/my-breeze-project', name: 'my-breeze-project' };
        store.set('breeze.demoOpen', true);
        return info;
      },
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
        return [...seen].map(([name, dir]) => ({ name, dir })).sort(byDirThenName);
      },
      async readFile(rel) {
        if (!files.has(rel)) throw new Error('File not found');
        if (binary.has(rel)) return IMAGE_FILE.test(rel) ? { image: true, size: 48213 } : { binary: true, size: 48213 };
        return { text: files.get(rel), size: (files.get(rel) ?? '').length };
      },
      async writeFile(rel, text) { files.set(rel, text); },
      async createFile(rel) {
        if (exists(rel)) throw new Error('A file with that name already exists');
        files.set(rel, '');
      },
      async createDir(rel) {
        if (exists(rel)) throw new Error('A folder with that name already exists');
        dirs.add(rel);
      },
      async rename(from, to) {
        if (exists(to)) throw new Error('Something with that name already exists');
        const renamed = (k: string) => to + k.slice(from.length);
        // Snapshot the keys first: the maps change while we go.
        const fileKeys = [...files.keys()].filter(k => inside(k, from));
        for (const k of fileKeys) { files.set(renamed(k), files.get(k) ?? ''); files.delete(k); }
        for (const set of [dirs, binary]) {
          const keys = [...set].filter(k => inside(k, from));
          for (const k of keys) { set.delete(k); set.add(renamed(k)); }
        }
      },
      async trash(rel) {
        const gone = [...files.keys(), ...dirs, ...binary].filter(k => inside(k, rel));
        for (const k of gone) { files.delete(k); dirs.delete(k); binary.delete(k); }
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
      // No file URLs in the browser: images get a drawn stand-in, everything else ''.
      async fileUrl(rel) { return binary.has(rel) && IMAGE_FILE.test(rel) ? DEMO_IMAGE : ''; },
      onChange() { return () => {}; },
    },
    lint: { async check() { return null; } },
    term: {
      async cwd() { return 'coffee-shop-landing'; },
      async run() { return { error: 'The terminal runs commands only in the Breeze desktop app (npm start).' }; },
      async kill() { /* nothing runs in the browser */ },
      async complete(word) {
        const names = [...new Set([...files.keys(), ...dirs].map(p => p.split('/')[0]))];
        return names.filter(n => n.toLowerCase().startsWith(word.toLowerCase())).sort((a, b) => a.localeCompare(b)).map(n => ({ text: dirs.has(n) ? n + '/' : n, dir: dirs.has(n) }));
      },
      onData() { return () => {}; },
      onExit() { return () => {}; },
    },
    sys: {
      async detect() {
        await wait(500);
        const llm = store.get<string | null>('breeze.demoLlm', null);
        return {
          demo: true, platform: 'browser',
          agents: [
            { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', url: 'https://claude.com/product/claude-code', found: true, path: null, version: null },
            { id: 'codex', name: 'Codex', vendor: 'OpenAI', url: 'https://developers.openai.com/codex/cli', found: false, path: null, version: null },
            { id: 'antigravity', name: 'Antigravity', vendor: 'Google', url: 'https://antigravity.google', found: false, path: null, version: null },
            { id: 'local', name: 'Local LLM', vendor: 'Ollama, LM Studio or any OpenAI-compatible server', url: 'https://ollama.com/download', api: true, found: !!llm, path: llm ? 'http://127.0.0.1:11434/v1' : null, version: llm, models: llm ? ['llama3.1', 'qwen2.5-coder'] : [] },
          ],
          tools: [{ id: 'git', name: 'Git', found: true, version: null }, { id: 'node', name: 'Node.js', found: true, version: null }],
        };
      },
      async openExternal(url) { window.open(url, '_blank', 'noopener'); },
    },
    // Browser preview only: canned answers so every panel can be tried without the desktop app.
    llm: {
      async connect(url) {
        await wait(500);
        if (!/^https?:\/\/\S+/i.test(url.trim())) throw new Error('Enter the server address, for example http://localhost:11434/v1');
        store.set('breeze.demoLlm', 'llama3.1');
        return { model: 'llama3.1', models: ['llama3.1', 'qwen2.5-coder'] };
      },
      async setModel(model) { store.set('breeze.demoLlm', model); },
      async disconnect() { store.del('breeze.demoLlm'); },
    },
    agent: {
      async run({ mode }) {
        const id = ++demoRun;
        background(demoReplay(id, mode));
        return id;
      },
      async stop() { /* demo runs finish on their own */ },
      async openApp() { /* no other apps in the browser */ },
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
      async discard() { /* nothing to discard in the demo */ },
      async commit() { throw new Error('Checkpoints are saved with git in the desktop app.'); },
      async branches() { return ['main', 'try-dark-menu']; },
      async switchTo() { throw new Error('Switching branches works in the desktop app.'); },
      async sync() { throw new Error('Push and pull work in the desktop app.'); },
    },
    auth: {
      async user() { return current; },
      async accounts() { return { accounts, active: current ? accountKey(current) : null }; },
      async switchTo(id) {
        const u = accounts.find(a => accountKey(a) === id);
        if (!u) throw new Error('That account is no longer signed in');
        current = u;
        return u;
      },
      async start(provider) {
        const n = accounts.filter(a => a.provider === provider).length + 1;
        const user: User = { provider, name: `Demo ${provider} ${n}`, login: 'demo' + n };
        setTimeout(() => {
          accounts = [...accounts, user];
          current = user;
          authListeners.forEach(cb => cb({ t: 'done', user }));
        }, 1400);
        return { started: true };
      },
      async cancel() { /* the demo sign-in finishes by itself */ },
      async signOut() {
        accounts = accounts.filter(a => a !== current);
        current = accounts[0] ?? null;
        return current;
      },
      onEvent(cb) { authListeners.push(cb); return () => {}; },
    },
    // Browser preview: "connecting" opens the site in a new tab; the feed itself only plays in the desktop app.
    vibe: {
      async status() { return feeds(); },
      async connect(id) {
        const site = SOCIAL_SITES.find(s => s.id === id);
        if (site) window.open(site.url, '_blank', 'noopener');
        store.set('breeze.demoVibe', { ...feeds(), [id]: true });
        return true;
      },
      async disconnect(id) { store.set('breeze.demoVibe', { ...feeds(), [id]: false }); },
      async show() { /* placeholder only */ },
      async bounds() { /* placeholder only */ },
      async mute() { /* placeholder only */ },
      async hide() { /* placeholder only */ },
    },
    win: {
      async reload() { location.reload(); },
      async toggleDevTools() { toast('Developer tools are available in the desktop app'); },
      async quit() { window.close(); },
      edit: demoEdit,
    },
  };
}

// The feeds Vibe Mode can play. Sign-in and the feed itself are handled by main.js in the desktop app.
interface SocialSite { id: string; name: string; mark: string; url: string; }
const SOCIAL_SITES: SocialSite[] = [
  { id: 'youtube', name: 'YouTube Shorts', mark: '▶', url: 'https://www.youtube.com/shorts' },
  { id: 'tiktok', name: 'TikTok', mark: '♪', url: 'https://www.tiktok.com/foryou' },
  { id: 'instagram', name: 'Instagram Reels', mark: '◎', url: 'https://www.instagram.com/reels/' },
  { id: 'facebook', name: 'Facebook Reels', mark: 'f', url: 'https://www.facebook.com/reel/' },
  { id: 'x', name: 'X', mark: '𝕏', url: 'https://x.com/home' },
];

const isDesktop = !!window.breeze;
const api: BreezeApi = window.breeze ?? demoApi();

/* ================= App state (survives reloads) ================= */
type WorkMode = 'ide' | 'box';
interface AppState {
  onboarded: boolean; step: number; user: User | null; agent: string | null; detect: Detection | null;
  vibeArmed: boolean; vibeSites: string[]; vibeSite: string | null; mode: WorkMode;
}
const appState: AppState = {
  onboarded: false, step: 0, user: null, agent: null, detect: null, vibeArmed: false, vibeSites: [], vibeSite: null, mode: 'ide',
  ...store.get<Partial<AppState>>('breeze.app', {}),
};
const saveApp = () => store.set('breeze.app', appState);

/* ================= Onboarding: welcome → login → agent → mode ================= */
const STEP = { welcome: 0, signIn: 1, agent: 2, mode: 3 };
let step = Math.min(appState.step, STEP.mode);
let user: User | null = appState.user;
function goStep(n: number): void {
  step = n; appState.step = n; saveApp();
  $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
  $$('.ob-dots span').forEach((d, i) => d.classList.toggle('on', i === n));
  if (n === STEP.agent) detectTools().catch(() => { /* the agent card shows the error */ });
  if (n === STEP.mode) renderModeChoice();
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));

/* ----- Accounts ----- */
function setUser(u: User | null): void {
  user = u; appState.user = u; saveApp();
  renderUser();
}
const initialsOf = (name: string) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
function avatarHtml(u: User | null, title: string): string {
  const name = u?.name ?? 'You';
  if (u?.avatar) return `<img class="avatar" src="${escAttr(u.avatar)}" alt="" title="${escAttr(title)}">`;
  return `<span class="avatar tint-host" title="${escAttr(title)}">${esc(initialsOf(name))}</span>`;
}
function renderUser(): void {
  const title = user ? `${user.name} · ${user.provider}` : 'Not signed in';
  $('#avatars').innerHTML = avatarHtml(user, title);
  $('#boxAvatar').innerHTML = avatarHtml(user, title);
  $('#userChip').textContent = user ? `● ${user.name} · ${user.provider}` : 'Not signed in';
}
let accounts: Accounts = { accounts: [], active: null };
const accountKey = (u: User) => `${u.provider}:${u.login ?? ''}`;
async function refreshAccounts(): Promise<void> {
  accounts = await api.auth.accounts().catch(() => accounts);
}
async function switchAccount(a: User): Promise<void> {
  if (accountKey(a) === accounts.active) return;
  setUser(await api.auth.switchTo(accountKey(a)));
  await refreshAccounts();
  toast(`Switched to ${a.name}`);
}
async function signOut(): Promise<void> {
  const next = await api.auth.signOut();
  setUser(next);
  await refreshAccounts();
  toast(next ? `Signed out — now using ${next.name}` : 'Signed out');
}
function accountItems(): MenuItem[] {
  const list: MenuItem[] = accounts.accounts.map(a => ({
    label: a.name, key: a.provider, checked: () => accountKey(a) === accounts.active, run: () => background(switchAccount(a)),
  }));
  return [...list, ...(list.length ? [{ sep: true }] : []), { label: 'Add account…', run: addAccount }];
}
// Clicking your picture: who you are, your other accounts (in a submenu) and signing out.
function openAccountMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const items: MenuItem[] = user
    ? [{ header: user }, { label: 'Accounts', sub: accountItems }, { sep: true }, { label: 'Sign Out', run: () => background(signOut()) }]
    : [{ label: 'Sign In…', run: addAccount }, ...(accounts.accounts.length ? [{ label: 'Accounts', sub: accountItems }] : [])];
  popupMenu(r.right - 260, r.bottom + 6, items);
}
for (const id of ['#avatars', '#boxAvatar']) {
  $(id).onclick = e => {
    if (openMenuIdx === -2) { closeMenu(); return; }
    const anchor = e.currentTarget as HTMLElement; // gone from the event once we've awaited
    background(refreshAccounts().then(() => openAccountMenu(anchor)));
  };
}

/* ----- Sign in (GitHub device flow / Google loopback, handled in main.js) ----- */
// The onboarding step and the "Add account" dialog share this panel; signinRoot is the one in use.
const SIGNIN_PANEL = `<div class="signin-btns" data-si="choices">
    <button class="btn" data-signin="GitHub"><svg width="18" height="18"><use href="#i-gh"/></svg>Continue with GitHub</button>
    <button class="btn" data-signin="Google"><svg width="18" height="18"><use href="#i-google"/></svg>Continue with Google</button>
    <p class="signin-error hidden" data-si="error" role="alert"></p>
  </div>
  <div class="waiting hidden" data-si="wait">
    <div class="spinner"></div><div data-si="msg">Waiting for your browser…</div>
    <div class="device-code hidden" data-si="code"><span data-si="codeText"></span><button class="btn btn-sm" data-si="copy">Copy</button><button class="btn btn-sm" data-si="openPage">Open page ↗</button></div>
    <button class="btn btn-sm" data-si="cancel">Cancel</button>
  </div>`;
const onboardSignin = $('#obSignin');
let signinRoot = onboardSignin;
const si = (part: string) => $(`[data-si="${part}"]`, signinRoot);
function signinView(waiting: boolean): void {
  si('choices').classList.toggle('hidden', waiting);
  si('wait').classList.toggle('hidden', !waiting);
  if (waiting) { si('error').classList.add('hidden'); si('code').classList.add('hidden'); }
}
function signinError(text: string): void {
  signinView(false);
  si('error').textContent = text;
  si('error').classList.remove('hidden');
}
async function startSignIn(provider: string): Promise<void> {
  signinView(true);
  si('msg').textContent = `Opening ${provider} in your browser…`;
  const r = await api.auth.start(provider).catch((e: unknown) => ({ error: errMsg(e) }) as { error?: string });
  if (r.error === 'not-configured') {
    signinError(`Looks like ${provider} login isn't hooked up yet! Grab a Client ID, add it to .env (or breeze.config.json — there's an example config to help), and give Breeze a restart. Or, skip it for now and jump right in.`);
  } else if (r.error) signinError(r.error);
}
function bindSignin(root: HTMLElement): void {
  $$('[data-signin]', root).forEach(b => b.onclick = () => void startSignIn(b.dataset.signin ?? 'GitHub'));
  $('[data-si="cancel"]', root).onclick = () => { background(api.auth.cancel()); signinView(false); };
  $('[data-si="copy"]', root).onclick = () => background(navigator.clipboard.writeText(si('codeText').textContent ?? '').then(() => toast('Code copied')));
}
bindSignin(onboardSignin);
$('#signinSkip').onclick = () => goStep(STEP.agent);
function addAccount(): void {
  openModal(`<h3>Add an account</h3><p class="sub">Sign in with another GitHub or Google account. Switch between accounts from your picture in the title bar.</p><div class="signin-modal">${SIGNIN_PANEL}</div>`, m => {
    signinRoot = $('.signin-modal', m);
    bindSignin(signinRoot);
  }, () => {
    if (!si('wait').classList.contains('hidden')) background(api.auth.cancel());
    signinRoot = onboardSignin;
  });
}
api.auth.onEvent(ev => {
  if (ev.t === 'code') {
    si('msg').textContent = 'Enter this code on the GitHub page that just opened:';
    si('codeText').textContent = ev.code ?? '';
    si('code').classList.remove('hidden');
    si('openPage').onclick = () => background(api.sys.openExternal(ev.uri ?? 'https://github.com/login/device'));
  } else if (ev.t === 'waiting') {
    si('msg').textContent = `Finish signing in with ${ev.provider} in your browser…`;
  } else if (ev.t === 'done' && ev.user) {
    setUser(ev.user);
    signinView(false);
    background(refreshAccounts());
    toast(`Signed in as ${ev.user.name}`);
    if (signinRoot === onboardSignin) { if (!appState.onboarded && step === STEP.signIn) goStep(STEP.agent); }
    else closeModal();
  } else if (ev.t === 'error') signinError(ev.text ?? 'Sign-in failed');
});

/* ----- Vibe Mode feeds (the feed picker) ----- */
// Sites the user connected live in appState.vibeSites; signedIn says which of them have a session cookie.
let signedIn: Record<string, boolean> = {};
const siteById = (id: string | null) => SOCIAL_SITES.find(s => s.id === id);
const connectedSites = () => SOCIAL_SITES.filter(s => appState.vibeSites.includes(s.id));
function feedCardHtml(s: SocialSite): string {
  const connected = appState.vibeSites.includes(s.id);
  const cls = ['social-card', connected ? 'connected' : '', s.id === appState.vibeSite ? 'on' : ''].filter(Boolean).join(' ');
  let sub = 'Not connected';
  if (connected) sub = signedIn[s.id] ? 'Signed in' : 'Connected · not signed in';
  return `<div class="${cls}" data-site="${s.id}" role="button" tabindex="0">
    <span class="mark tint-${s.id}">${s.mark}</span><span class="nm">${esc(s.name)}</span><span class="sub">${sub}</span>
    <button class="btn btn-sm" data-connect="${s.id}">${connected ? 'Disconnect' : 'Connect ↗'}</button></div>`;
}
async function renderFeedChoices(root: HTMLElement): Promise<void> {
  signedIn = await api.vibe.status().catch(() => ({}));
  const draw = () => {
    root.innerHTML = SOCIAL_SITES.map(feedCardHtml).join('');
    $$('[data-site]', root).forEach(card => {
      const id = card.dataset.site ?? '';
      const pick = (onButton: boolean) => {
        // A connected card's body makes it the feed Vibe Mode plays; the button connects or disconnects.
        if (!onButton && appState.vibeSites.includes(id)) { appState.vibeSite = id; saveApp(); draw(); return; }
        background(toggleFeed(id).then(draw));
      };
      card.onclick = e => pick(!!(e.target as HTMLElement).closest('[data-connect]'));
      card.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); pick(false); } };
    });
  };
  draw();
}
async function toggleFeed(id: string): Promise<void> {
  const site = siteById(id);
  if (!site) return;
  if (appState.vibeSites.includes(id)) {
    await api.vibe.disconnect(id);
    appState.vibeSites = appState.vibeSites.filter(x => x !== id);
    signedIn[id] = false;
    if (appState.vibeSite === id) appState.vibeSite = appState.vibeSites[0] ?? null;
    saveApp();
    toast(`${site.name} disconnected`);
    return;
  }
  toast(`Sign in to ${site.name} in the window that opened, then close it`);
  signedIn[id] = await api.vibe.connect(id);
  appState.vibeSites = [...appState.vibeSites, id];
  appState.vibeSite = id;
  saveApp();
  setVibeArmed(true);
  toast(signedIn[id] ? `${site.name} connected` : `${site.name} added — it plays without your account until you sign in`);
}

/* ----- AI agent detection ----- */
const AGENT_STYLE: Record<string, { letter: string; tint: string }> = {
  claude: { letter: 'C', tint: 'claude' },
  codex: { letter: 'Cx', tint: 'codex' },
  antigravity: { letter: 'A', tint: 'antigravity' },
  local: { letter: 'L', tint: 'local' },
};
let detecting: Promise<Detection> | null = null;

function detectTools(): Promise<Detection> {
  if (detecting) return detecting;
  $('#aiPill').className = 'pill'; $('#aiPill').textContent = 'Scanning…';
  $('#toolsPill').className = 'pill'; $('#toolsPill').textContent = 'Scanning…';
  if (!appState.detect) $('#agentList').innerHTML = '<div class="row text-3"><div class="spinner sm"></div>Checking this computer…</div>';
  detecting = api.sys.detect().then(d => {
    appState.detect = d;
    fixSelectedAgent();
    renderDetection();
    return d;
  }).catch((e: unknown) => {
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

const pillClass = (on: boolean) => (on ? 'blue' : 'ok');
const LLM_DEFAULT_URL = 'http://localhost:11434/v1';
function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}
// The local LLM card: server address to connect, or (once connected) its address and a model picker.
function localAgentHtml(a: DetectedAgent, on: boolean, mark: string): string {
  const name = `<span class="nm">${esc(a.name)} <small>API</small></span>`;
  if (!a.found) {
    return `<div class="agent-opt api missing">${mark}${name}
      <button class="get side" data-get="${escAttr(a.url)}">Get Ollama ↗</button>
      <span class="sub">Ollama, LM Studio or any OpenAI-compatible server</span>
      <div class="key-row"><input class="input url" data-llm-url aria-label="Server address" placeholder="${LLM_DEFAULT_URL}" value="${LLM_DEFAULT_URL}" spellcheck="false"><input class="input" type="password" data-llm-key aria-label="API key (optional)" placeholder="API key (optional)" autocomplete="off"><button class="btn btn-sm" data-llm-connect>Connect</button></div>
      <div class="key-err hidden"></div></div>`;
  }
  const label = on ? 'Selected' : 'Ready';
  const options = (a.models ?? []).map(m => `<option value="${escAttr(m)}"${m === a.version ? ' selected' : ''}>${esc(m)}</option>`).join('');
  return `<div class="agent-opt api ${on ? 'on' : ''}" role="button" tabindex="0" data-agent="${a.id}">${mark}${name}
    <span class="side row gap-6"><span class="pill ${pillClass(on)}">${label}</span><button class="get" data-llm-off title="Forget this server">Remove</button></span>
    <span class="sub" title="${escAttr(a.path ?? '')}">${esc(a.path ?? '')}</span>
    <div class="key-row"><select class="select" data-llm-model aria-label="Model">${options}</select></div></div>`;
}
function cliAgentHtml(a: DetectedAgent, on: boolean, mark: string, demo: boolean): string {
  const where = a.path ?? (demo ? 'browser preview' : '');
  const version = a.version ? 'v' + a.version : 'Installed';
  const sub = a.found ? [version, where].filter(Boolean).join(' · ') : a.vendor + ' · not installed';
  const label = on ? 'Selected' : 'Detected';
  const side = a.found
    ? `<span class="pill ${pillClass(on)} side">${label}</span>`
    : `<button class="get side" data-get="${escAttr(a.url)}">Get it ↗</button>`;
  const attrs = a.found ? `role="button" tabindex="0" data-agent="${a.id}"` : '';
  return `<div class="agent-opt ${a.found ? '' : 'missing'} ${on ? 'on' : ''}" ${attrs}>
    ${mark}<span class="nm">${esc(a.name)}</span>${side}
    <span class="sub" title="${escAttr(sub)}">${esc(sub)}</span></div>`;
}
function agentOptionsHtml(d: Detection): string {
  return d.agents.map(a => {
    const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], tint: 'default' };
    const on = a.found && a.id === appState.agent;
    const mark = `<span class="mark tint-${st.tint}">${st.letter}</span>`;
    return a.api ? localAgentHtml(a, on, mark) : cliAgentHtml(a, on, mark, !!d.demo);
  }).join('');
}
function bindLocalLlm(root: HTMLElement, onChange: () => void): void {
  const local = () => appState.detect?.agents.find(a => a.id === 'local');
  const connect = root.querySelector<HTMLButtonElement>('[data-llm-connect]');
  if (connect) {
    const url = $<HTMLInputElement>('[data-llm-url]', root), key = $<HTMLInputElement>('[data-llm-key]', root);
    const save = async () => {
      const err = root.querySelector<HTMLElement>('.key-err');
      connect.disabled = true; connect.textContent = 'Connecting…';
      try {
        const r = await api.llm.connect(url.value, key.value);
        Object.assign(local() ?? {}, { found: true, path: trimSlashes(url.value.trim()), version: r.model, models: r.models });
        if (!selectedAgent()) appState.agent = 'local';
        saveApp();
        toast(`Connected · ${r.model}`);
        onChange();
      } catch (e) {
        connect.disabled = false; connect.textContent = 'Connect';
        if (err) { err.textContent = errMsg(e); err.classList.remove('hidden'); }
      }
    };
    connect.onclick = () => void save();
    for (const input of [url, key]) input.onkeydown = e => { if (e.key === 'Enter') void save(); };
  }
  const model = root.querySelector<HTMLSelectElement>('[data-llm-model]');
  if (model) model.onchange = () => background(api.llm.setModel(model.value).then(() => {
    Object.assign(local() ?? {}, { version: model.value });
    saveApp();
    renderAgentPill();
    toast(`Local LLM model · ${model.value}`);
  }));
  root.querySelector<HTMLElement>('[data-llm-off]')?.addEventListener('click', e => {
    e.stopPropagation();
    background(api.llm.disconnect().then(() => {
      Object.assign(local() ?? {}, { found: false, path: null, version: null, models: [] });
      fixSelectedAgent();
      onChange();
    }));
  });
}
function bindAgentOptions(root: HTMLElement, onChange: () => void): void {
  $$('[data-agent]', root).forEach(el => {
    const pick = () => { appState.agent = el.dataset.agent ?? null; saveApp(); onChange(); };
    el.onclick = e => { if (!(e.target as HTMLElement).closest('button, input, select')) pick(); };
    el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); pick(); } };
  });
  $$('[data-get]', root).forEach(b => b.onclick = e => { e.stopPropagation(); background(api.sys.openExternal(b.dataset.get ?? '')); });
  bindLocalLlm(root, onChange);
}

const TOOL_DOWNLOADS: Record<string, string> = { git: 'https://git-scm.com/downloads', node: 'https://nodejs.org/en/download' };
function toolHtml(t: DetectedTool): string {
  if (!t.found) return `<span class="pill warn">${t.name} missing</span><button class="btn btn-sm" data-get="${TOOL_DOWNLOADS[t.id] ?? ''}">Get ${t.name} ↗</button>`;
  const version = t.version ? ' ' + esc(t.version) : '';
  return `<span class="pill ok">${t.name}${version} ready</span>`;
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
    ? 'Pick the agent Breeze hands work to. Installed agents use their own sign-in; a local LLM runs on your own computer.'
    : 'No coding agent found. Install one and rescan, or connect a local LLM server.';
  if (d.demo) $('#aiHint').textContent += ' (Browser preview.)';

  $('#toolList').innerHTML = d.tools.map(toolHtml).join('');
  $$('[data-get]', $('#toolList')).forEach(b => b.onclick = () => background(api.sys.openExternal(b.dataset.get ?? '')));
  const missing = d.tools.filter(t => !t.found).map(t => t.name);
  $('#toolsPill').className = missing.length ? 'pill warn' : 'pill ok';
  $('#toolsPill').textContent = missing.length ? `${missing.join(' & ')} missing` : 'Ready';

  const summary = d.tools.map(t => `${t.name.replace('.js', '')} ${t.found ? 'ready' : 'missing'}`).join(' · ');
  $('#sbTools').innerHTML = `<span class="${missing.length ? 'dot-warn' : 'dot-ok'}"></span> ${summary}`;
  renderAgentPill();
}
$('#rescan').onclick = () => { detectTools().catch(() => { /* the agent card shows the error */ }); };

function selectedAgent(): DetectedAgent | null {
  return appState.detect?.agents.find(a => a.id === appState.agent && a.found) ?? null;
}
function modelLabel(a: DetectedAgent | null): string {
  if (!a) return 'no agent';
  return a.api && a.version ? a.version : a.name;
}
function renderAgentPill(): void {
  const a = selectedAgent();
  $('#agentPill').textContent = a ? a.name : 'Choose an agent';
  const model = a?.api && a.version ? ' · ' + a.version : '';
  $('#boxModel').textContent = a ? `${a.name}${model} ▾` : 'Choose an agent ▾';
  agentsDef.planner.model = agentsDef.builder.model = modelLabel(a);
  renderAgents();
}
$('#agentPill').onclick = openAgentPicker;
function openAgentPicker(): void {
  openModal(`<h3>Choose your AI agent</h3><p class="sub">Installed coding agents are found automatically. A local LLM connects by its server address.</p>
    <div class="agent-list" id="pickList"></div>
    <div class="row between spaced"><button class="btn btn-sm btn-ghost" id="pickRescan">Scan again</button><button class="btn btn-primary" data-close>Done</button></div>`, m => {
    const scanning = '<div class="text-3">Scanning…</div>';
    const render = () => {
      if (!appState.detect) { $('#pickList', m).innerHTML = scanning; return; }
      $('#pickList', m).innerHTML = agentOptionsHtml(appState.detect);
      bindAgentOptions($('#pickList', m), () => { render(); renderDetection(); });
    };
    render();
    $('#pickRescan', m).onclick = () => { $('#pickList', m).innerHTML = scanning; detectTools().then(render, () => { /* shown in the agent card */ }); };
  });
}

/* ----- Mode: IDE or Breeze Box, and the project to start with ----- */
function renderModeChoice(): void {
  $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === appState.mode));
  $('#projFolder').textContent = rootInfo ? rootInfo.root : 'No folder yet';
  $('#projFolder').title = rootInfo?.root ?? '';
  $('#startBuilding').textContent = appState.mode === 'box' ? 'Open Breeze Box' : 'Start building';
}
$$('[data-mode]').forEach(b => b.onclick = () => {
  appState.mode = b.dataset.mode === 'box' ? 'box' : 'ide';
  saveApp();
  renderModeChoice();
});
// "Open folder" picks an existing folder; "Create new" makes a new, empty project folder. Both open it.
async function chooseProject(create: boolean): Promise<void> {
  const r = await (create ? api.fs.createFolder() : api.fs.openFolder());
  if (!r) return;
  await loadWorkspace(r);
  renderModeChoice();
  toast(create ? `Created ${r.name}` : `Opened ${r.name}`);
}
$('#pickFolder').onclick = () => background(chooseProject(false));
$('#createFolder').onclick = () => background(chooseProject(true));
$('#feedsLink').onclick = () => openFeedPicker();
$('#startBuilding').onclick = () => {
  appState.onboarded = true; saveApp();
  enterMode(appState.mode);
};
function showIde(): void {
  $('#onboard').classList.add('hidden'); $('#box').classList.add('hidden'); $('#ide').classList.remove('hidden');
  useSurface('ide');
  renderUser();
  applyLayout();
  renderEditor();
}

/* ================= Agents (data) ================= */
const agentsDef: Record<AgentKey, Agent> = {
  planner: { name: 'Planner', letter: 'P', tint: 'planner', model: 'no agent', status: 'idle', task: 'Waiting for a prompt', used: 0 },
  builder: { name: 'Builder', letter: 'B', tint: 'builder', model: 'no agent', status: 'idle', task: 'Waiting for a plan', used: 0 },
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
  png: ['', 'PNG Image'], jpg: ['', 'JPEG Image'], jpeg: ['', 'JPEG Image'], gif: ['', 'GIF Image'], webp: ['', 'WebP Image'],
  avif: ['', 'AVIF Image'], bmp: ['', 'Bitmap Image'], ico: ['', 'Icon'],
};
const extOf = (path: string) => { const n = baseName(path).toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''; };
function langOf(path: string): [lexer: string, name: string] {
  if (baseName(path).toLowerCase().startsWith('.env')) return ['py', 'Environment'];
  return LANGS[extOf(path)] ?? ['', 'Plain Text'];
}

// A lexer is an ordered list of small token patterns, joined into one regex with a named group per kind.
type TokenRule = [kind: string, pattern: RegExp];
const either = (...patterns: RegExp[]) => new RegExp(patterns.map(p => p.source).join('|'));
const lexer = (rules: TokenRule[], flags = 'g') => new RegExp(rules.map(([kind, p]) => `(?<${kind}>${p.source})`).join('|'), flags);
const keywords = (list: string) => new RegExp(String.raw`\b(?:${list.replaceAll(' ', '|')})\b`);
const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set type interface enum implements private public protected readonly declare as true false null undefined';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
const LINE_COMMENT = /\/\/[^\n]*/;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/;
const QUOTED = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/;
const BACKTICKED = /`(?:\\[\s\S]|[^`\\])*`?/;
const NUMBER = either(/\b0[xX][\da-fA-F]+\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/);
const CALL = /\b[A-Za-z_$][\w$]*(?=\()/;
const LEXERS: Record<string, RegExp> = {
  js: lexer([['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['str', either(QUOTED, BACKTICKED)], ['num', NUMBER], ['kw', keywords(JS_KW)], ['prop', CALL]]),
  css: lexer([
    ['com', BLOCK_COMMENT], ['str', QUOTED], ['kw', /@[\w-]+|!important/],
    ['prop', /--?[A-Za-z_][\w-]*(?=\s*:)/],
    ['num', either(/#[\da-fA-F]{3,8}\b/, /-?\b\d+(?:\.\d+)?(?:%|[a-z]{1,3})?/)],
  ]),
  json: lexer([['prop', /"(?:\\.|[^"\\\n])*"(?=\s*:)/], ['str', /"(?:\\.|[^"\\\n])*"?/], ['num', either(/-/, NUMBER)], ['kw', /\b(?:true|false|null)\b/]]),
  py: lexer([['com', /#[^\n]*/], ['str', either(/"""[\s\S]*?(?:"""|$)/, /'''[\s\S]*?(?:'''|$)/, QUOTED)], ['num', NUMBER], ['kw', keywords(PY_KW)], ['prop', /\b[A-Za-z_]\w*(?=\()/]]),
  md: lexer([
    ['kw', /(?<=^|\n)#{1,6}[^\n]*/], ['str', either(/```[^`]*(?:```|$)/, /`[^`\n]*`/)], ['com', /(?<=^|\n)>[^\n]*/],
    ['attr', either(/\*\*[^*\n]+\*\*/, /\[[^[\]\n]*\]\([^()\n]*\)/)],
  ]),
  html: lexer([['com', /<!--[\s\S]*?(?:-->|$)/], ['tagblock', /<[!/]?[A-Za-z][^>]*>?/]]),
};
const HTML_TAG = lexer([['tag', /^<[!/]?[\w:-]+|\/?>$/], ['str', /"[^"]*"?|'[^']*'?/], ['attr', /[^\s="'<>/]+/]]);

function lex(text: string, re: RegExp): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last) out.push([null, text.slice(last, m.index)]);
    const groups = m.groups ?? {};
    const kind = Object.keys(groups).find(k => groups[k] !== undefined) ?? null;
    if (kind === 'tagblock') out.push(...lex(m[0], HTML_TAG)); // lex() resets lastIndex of the inner regex only
    else out.push([kind, m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push([null, text.slice(last)]);
  return out;
}
// CSS: plain text outside any { } block is a selector.
function markSelectors(toks: Tok[]): Tok[] {
  let depth = 0;
  const out: Tok[] = [];
  for (const [cls, text] of toks) {
    if (cls) { out.push([cls, text]); continue; }
    for (const part of text.split(/([{}])/)) {
      if (part === '{') depth++;
      else if (part === '}') depth = Math.max(0, depth - 1);
      const selector = depth === 0 && part !== '}' && part.trim() !== '';
      out.push([selector ? 'tag' : null, part]);
    }
  }
  return out;
}
// Highlight a whole document and return one HTML string per line (tokens can span lines).
function highlightLines(text: string, lexerName: string): string[] {
  if (!LEXERS[lexerName] || text.length > 400000) return text.split('\n').map(esc);
  const lines: string[] = [''];
  const toks = lex(text, LEXERS[lexerName]);
  for (const [cls, t] of lexerName === 'css' ? markSelectors(toks) : toks) {
    t.split('\n').forEach((part, i) => {
      if (i > 0) lines.push('');
      if (part) lines[lines.length - 1] += cls ? `<span class="tk-${cls}">${esc(part)}</span>` : esc(part);
    });
  }
  return lines;
}
const COMMENT: Record<string, [string, string]> = { js: ['// ', ''], py: ['# ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };

/* ================= Syntax checks (red error lines) ================= */
// Quick structural checks that work everywhere: brackets, strings, comments, tags, JSON, Python blocks.
// In the desktop app JavaScript and TypeScript are also compiled by V8 (main.js) for exact errors.
interface RawDiag { at: number; len: number; msg: string; }
interface ScanOpts { lineCom?: string; blockCom?: boolean; quotes: string; template?: boolean; regex?: boolean; triple?: boolean; jsx?: boolean; }
interface Opened { ch: string; at: number; tmpl?: number; }
const LINT_MAX = 400000;
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = ')]}';
const SPACE = ' \n\t\r';
// A "/" starts a regex (not a division) after an operator, an opening bracket or one of these keywords.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof))\s*$/;
const JS_SCAN: ScanOpts = { lineCom: '//', blockCom: true, quotes: `'"`, template: true, regex: true };
const CSS_SCAN: ScanOpts = { blockCom: true, quotes: `'"` };
const PY_SCAN: ScanOpts = { lineCom: '#', quotes: `'"`, triple: true };
const neverClosed = (s: Opened): RawDiag =>
  ({ at: s.at, len: 1, msg: s.tmpl == null ? `'${s.ch}' is never closed` : 'Template expression is never closed (missing })' });

// Finds unbalanced brackets and unclosed strings/comments. Also returns the text with comments and
// string contents blanked (same length), so later checks don't trip over them.
class CodeScanner {
  readonly diags: RawDiag[] = [];
  private readonly out: string[] = [];
  private readonly stack: Opened[] = [];
  private i = 0;
  private last = 0;
  private readonly t: string;
  private readonly o: ScanOpts;
  constructor(t: string, o: ScanOpts) { this.t = t; this.o = o; }

  run(): { diags: RawDiag[]; masked: string } {
    while (this.i < this.t.length) this.step();
    for (const s of this.stack) this.diags.push(neverClosed(s));
    this.out.push(this.t.slice(this.last));
    return { diags: this.diags, masked: this.out.join('') };
  }
  // Python joins lines inside strings so a multi-line string reads as one logical line.
  private mask(from: number, to: number): void {
    this.out.push(this.t.slice(this.last, from), this.t.slice(from, to).replace(this.o.triple ? /[^]/g : /[^\n]/g, ' '));
    this.last = to;
  }
  private step(): void {
    const c = this.t[this.i];
    if (SPACE.includes(c)) { this.i++; return; }
    if (this.comment(c) || this.quoted(c) || this.regex(c)) return;
    if (PAIRS[c]) { this.stack.push({ ch: c, at: this.i }); this.i++; return; }
    if (CLOSERS.includes(c)) { this.close(c); return; }
    this.i++;
  }
  private comment(c: string): boolean {
    const { t, o, i } = this;
    if (o.lineCom && t.startsWith(o.lineCom, i) && (o.regex || t[i - 1] !== ':')) {
      const e = lineEnd(t, i);
      this.mask(i, e); this.i = e;
      return true;
    }
    if (!o.blockCom || c !== '/' || t[i + 1] !== '*') return false;
    const e = t.indexOf('*/', i + 2);
    if (e === -1) this.unclosed(i, 2, 'Comment is never closed (missing */)');
    else { this.mask(i, e + 2); this.i = e + 2; }
    return true;
  }
  // The rest of the file was swallowed by something that never ends.
  private unclosed(at: number, len: number, msg: string): void {
    this.diags.push({ at, len, msg });
    this.mask(at + len, this.t.length);
    this.i = this.t.length;
  }
  private quoted(c: string): boolean {
    const { t, o, i } = this;
    if (o.triple && (t.startsWith('"""', i) || t.startsWith("'''", i))) {
      const q = t.slice(i, i + 3), e = t.indexOf(q, i + 3);
      if (e === -1) this.unclosed(i, 3, `String is never closed (missing ${q})`);
      else { this.mask(i + 3, e); this.i = e + 3; }
      return true;
    }
    if (o.template && c === '`') { this.i = this.template(i + 1, i); return true; }
    if (!o.quotes.includes(c)) return false;
    let j = i + 1;
    while (j < t.length && t[j] !== c && t[j] !== '\n') j += t[j] === '\\' ? 2 : 1;
    if (t[j] === c) { this.mask(i + 1, j); this.i = j + 1; return true; }
    if (o.jsx) { this.i++; return true; } // JSX text can hold a lone apostrophe
    this.diags.push({ at: i, len: Math.max(1, j - i), msg: `String is never closed (missing ${c})` });
    this.mask(i + 1, j); this.i = j;
    return true;
  }
  // Continues a template literal from `from` (just after ` or after a ${…}); returns where code resumes.
  private template(from: number, start: number): number {
    const t = this.t;
    for (let j = from; j < t.length; j++) {
      if (t[j] === '\\') j++;
      else if (t[j] === '`') { this.mask(from, j); return j + 1; }
      else if (t[j] === '$' && t[j + 1] === '{') { this.mask(from, j); this.stack.push({ ch: '{', at: j + 1, tmpl: start }); return j + 2; }
    }
    this.diags.push({ at: start, len: 1, msg: 'Template literal is never closed (missing `)' });
    this.mask(from, t.length);
    return t.length;
  }
  private regex(c: string): boolean {
    const { t, i } = this;
    if (!this.o.regex || c !== '/' || !REGEX_AFTER.test(t.slice(Math.max(0, i - 12), i))) return false;
    let j = i + 1, inClass = false;
    while (j < t.length && t[j] !== '\n' && (inClass || t[j] !== '/')) {
      if (t[j] === '\\') j++;
      else if (t[j] === '[') inClass = true;
      else if (t[j] === ']') inClass = false;
      j++;
    }
    if (t[j] !== '/') return false; // a division after all
    this.mask(i + 1, j); this.i = j + 1;
    return true;
  }
  private close(c: string): void {
    if (!this.stack.some(s => PAIRS[s.ch] === c)) {
      this.diags.push({ at: this.i, len: 1, msg: `Unexpected '${c}'` });
      this.i++;
      return;
    }
    // Anything opened after the matching bracket was left open.
    while (PAIRS[this.stack.at(-1)?.ch ?? ''] !== c) this.diags.push(neverClosed(this.stack.pop() as Opened));
    const open = this.stack.pop() as Opened;
    this.i = open.tmpl == null ? this.i + 1 : this.template(this.i + 1, open.tmpl);
  }
}
const scanCode = (t: string, o: ScanOpts) => new CodeScanner(t, o).run();

// A small JSON parser that reports where the first mistake is. `loose` allows comments and trailing commas (tsconfig etc.).
class JsonChecker {
  private i = 0;
  private readonly t: string;
  private readonly loose: boolean;
  constructor(t: string, loose: boolean) { this.t = t; this.loose = loose; }

  check(): RawDiag[] {
    try {
      this.ws();
      if (this.i >= this.t.length) return [];
      this.value();
      this.ws();
      if (this.i < this.t.length) this.fail('Unexpected text after the end of the JSON');
      return [];
    } catch (e) {
      if (e instanceof JsonMistake) return [e.diag];
      throw e;
    }
  }
  private fail(msg: string, at = this.i, len = 1): never { throw new JsonMistake({ at, len, msg }); }
  private get ended() { return this.i >= this.t.length; }
  private ws(): void {
    const t = this.t;
    while (!this.ended) {
      if (SPACE.includes(t[this.i])) this.i++;
      else if (this.loose && t.startsWith('//', this.i)) this.i = lineEnd(t, this.i);
      else if (this.loose && t.startsWith('/*', this.i)) this.skipComment();
      else return;
    }
  }
  private skipComment(): void {
    const e = this.t.indexOf('*/', this.i + 2);
    if (e === -1) this.fail('Comment is never closed (missing */)', this.i, 2);
    this.i = e + 2;
  }
  private str(): void {
    const t = this.t, s = this.i++;
    while (!this.ended && t[this.i] !== '"' && t[this.i] !== '\n') this.i += t[this.i] === '\\' ? 2 : 1;
    if (t[this.i] !== '"') this.fail('String is never closed (missing ")', s, Math.max(1, this.i - s));
    this.i++;
  }
  // The items of an object or array, up to the closing bracket.
  private list(close: string, item: () => void): void {
    this.i++; this.ws();
    if (this.t[this.i] === close) { this.i++; return; }
    for (;;) {
      item(); this.ws();
      if (this.t[this.i] === close) { this.i++; return; }
      if (this.t[this.i] !== ',') this.fail(this.ended ? `Expected '${close}' but the file ended` : `Expected ',' or '${close}'`);
      const comma = this.i++;
      this.ws();
      if (this.t[this.i] === close) {
        if (!this.loose) this.fail('Trailing commas are not allowed in JSON', comma);
        this.i++;
        return;
      }
    }
  }
  private member(): void {
    this.ws();
    const c = this.t[this.i];
    if (c !== '"') {
      if (this.ended) this.fail('Expected a property name but the file ended');
      this.fail(/['\w$]/.test(c) ? 'Property names need double quotes' : 'Expected a property name');
    }
    this.str(); this.ws();
    if (this.t[this.i] !== ':') this.fail("Expected ':' after the property name");
    this.i++;
    this.value();
  }
  private value(): void {
    this.ws();
    const c = this.t[this.i];
    if (c === '{') { this.list('}', () => this.member()); return; }
    if (c === '[') { this.list(']', () => this.value()); return; }
    if (c === '"') { this.str(); return; }
    const word = ['true', 'false', 'null'].find(w => this.t.startsWith(w, this.i));
    if (word) { this.i += word.length; return; }
    const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    num.lastIndex = this.i;
    const hit = num.exec(this.t);
    if (hit) { this.i += hit[0].length; return; }
    if (c === "'") this.fail('Strings need double quotes in JSON');
    this.fail(this.ended ? 'Expected a value but the file ended' : `Unexpected '${c}'`);
  }
}
class JsonMistake extends Error {
  readonly diag: RawDiag;
  constructor(diag: RawDiag) { super(diag.msg); this.diag = diag; }
}

// CSS: every declaration inside a rule needs "property: value", and a ';' before the next one.
function cssDeclMistake(text: string, at: number): RawDiag | null {
  if (!text.includes(':')) return { at, len: text.length, msg: "Expected ':' between the property and its value" };
  const rows = text.split('\n');
  const k = rows.findIndex((r, n) => n < rows.length - 1 && r.includes(':') && /^\s*[-\w]+\s*:/.test(rows[n + 1]));
  return k === -1 ? null : { at: at + rows.slice(0, k + 1).join('\n').length, len: 1, msg: "Missing ';' at the end of this line" };
}
function lintCssDecls(masked: string): RawDiag[] {
  const out: RawDiag[] = [];
  let depth = 0, seg = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c !== '{' && c !== '}' && c !== ';') continue;
    const text = masked.slice(seg, i), s = text.trim();
    const mistake = depth > 0 && c !== '{' && s && !s.startsWith('@') ? cssDeclMistake(s, seg + text.indexOf(s[0])) : null;
    if (mistake) out.push(mistake);
    depth = Math.max(0, depth + (c === '{' ? 1 : 0) - (c === '}' ? 1 : 0));
    seg = i + 1;
  }
  return out;
}

// Python: block statements end in ':' and indentation has to line up.
const PY_BLOCK = /^(?:async\s+)?(if|elif|else|for|while|def|class|try|except|finally|with)\b/;
interface LogicalLine { at: number; text: string; }
const bracketDelta = (ln: string) => [...ln].reduce((d, ch) => d + Number('([{'.includes(ch)) - Number(')]}'.includes(ch)), 0);
// Joins lines that continue inside brackets or after a backslash.
function logicalLines(masked: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let cur: LogicalLine | null = null;
  let off = 0, depth = 0;
  for (const ln of masked.split('\n')) {
    const at = off;
    off += ln.length + 1;
    if (!cur && !ln.trim()) continue;
    if (cur) cur.text += '\n' + ln;
    else cur = { at, text: ln };
    depth = Math.max(0, depth + bracketDelta(ln));
    if (depth === 0 && !/\\\s*$/.test(ln)) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  return lines;
}
// The block's ':' sits outside any brackets (and isn't a := walrus).
function hasBlockColon(body: string): boolean {
  let d = 0;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    else if (ch === ':' && d === 0 && body[k + 1] !== '=') return true;
  }
  return false;
}
class PythonChecker {
  readonly out: RawDiag[] = [];
  private readonly indents = [0];
  private opener: string | null = null; // the keyword of the previous line, if it ended with ':'

  line(L: LogicalLine): void {
    const lead = /^[ \t]*/.exec(L.text)?.[0] ?? '';
    const body = L.text.trim();
    this.indent(L, lead);
    const kw = PY_BLOCK.exec(body)?.[1] ?? null;
    if (kw && !hasBlockColon(body)) this.out.push({ at: L.at + L.text.trimEnd().length, len: 1, msg: `Expected ':' after the '${kw}' line` });
    this.opener = /:\s*$/.test(body) ? kw ?? '' : null;
  }
  private indent(L: LogicalLine, lead: string): void {
    const ind = lead.replaceAll('\t', '        ').length;
    const top = this.indents.at(-1) ?? 0;
    const span = Math.max(1, lead.length);
    if (this.opener !== null && ind <= top) {
      const after = this.opener ? ` after the '${this.opener}' line` : '';
      this.out.push({ at: L.at + lead.length, len: 1, msg: 'Expected an indented block' + after });
    } else if (ind > top) {
      if (this.opener === null) this.out.push({ at: L.at, len: span, msg: 'Unexpected indent' });
      else this.indents.push(ind);
    } else if (ind < top) {
      while (this.indents.length > 1 && (this.indents.at(-1) ?? 0) > ind) this.indents.pop();
      if (this.indents.at(-1) !== ind) this.out.push({ at: L.at, len: span, msg: 'This indent does not match any outer block' });
    }
  }
}
function lintPython(masked: string): RawDiag[] {
  const checker = new PythonChecker();
  for (const L of logicalLines(masked)) checker.line(L);
  return checker.out;
}

// HTML (and strict XML/SVG): every element that needs a closing tag gets one, in the right order.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp']);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const JS_TYPES = new Set(['module', 'text/javascript', 'application/javascript']);
const MARKUP = /<!--|<!\[CDATA\[|<[!?]|<\/?([A-Za-z][\w:.-]*)/g;
interface OpenTag { name: string; at: number; len: number; }
class MarkupChecker {
  readonly out: RawDiag[] = [];
  private readonly stack: OpenTag[] = [];
  private readonly lower: string;
  private readonly re = new RegExp(MARKUP.source, 'g');
  private readonly t: string;
  private readonly xml: boolean;
  constructor(t: string, xml: boolean) {
    this.t = t;
    this.xml = xml;
    this.lower = xml ? t : t.toLowerCase();
  }

  run(): RawDiag[] {
    for (let m = this.re.exec(this.t); m; m = this.re.exec(this.t)) if (!this.token(m)) break;
    for (const s of this.stack) if (this.needsEnd(s.name)) this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed` });
    return this.out;
  }
  private needsEnd(name: string): boolean { return this.xml || !OPTIONAL_END.has(name); }
  private isVoid(name: string): boolean { return !this.xml && VOID_TAGS.has(name); }
  // Handles one match; false stops the scan (the rest of the file is unreadable).
  private token(m: RegExpExecArray): boolean {
    if (m[0] === '<!--') return this.skipTo(m, '-->', 'Comment');
    if (m[0] === '<![CDATA[') return this.skipTo(m, ']]>', 'CDATA section');
    if (!m[1]) return this.skipTo(m, '>', 'Tag');
    const end = this.tagEnd(m);
    if (end === -1) return true;
    const name = this.xml ? m[1] : m[1].toLowerCase();
    const tag = { name, at: m.index, len: end + 1 - m.index };
    this.re.lastIndex = end + 1;
    if (m[0][1] === '/') this.closeTag(tag, m[1]);
    else this.openTag(tag, m[0].length, this.t.slice(m.index + m[0].length, end));
    return true;
  }
  private skipTo(m: RegExpExecArray, end: string, what: string): boolean {
    const e = this.t.indexOf(end, m.index + m[0].length);
    if (e === -1) { this.out.push({ at: m.index, len: m[0].length, msg: `${what} is never closed (missing ${end})` }); return false; }
    this.re.lastIndex = e + end.length;
    return true;
  }
  // Finds the tag's '>' while skipping quoted attribute values; -1 (and a problem) when there is none.
  private tagEnd(m: RegExpExecArray): number {
    const t = this.t;
    let j = m.index + m[0].length, q = '';
    for (; j < t.length; j++) {
      const c = t[j];
      if (q) { if (c === q) q = ''; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>' || c === '<') break;
    }
    if (t[j] === '>') return j;
    const msg = q ? `Attribute value is never closed (missing ${q})` : `<${m[1]}> tag is never closed (missing >)`;
    this.out.push({ at: m.index, len: m[0].length, msg });
    this.re.lastIndex = j;
    return -1;
  }
  private closeTag(tag: OpenTag, raw: string): void {
    if (this.isVoid(tag.name)) { this.out.push({ ...tag, msg: `<${raw}> never takes a closing tag` }); return; }
    const k = this.stack.map(s => s.name).lastIndexOf(tag.name);
    if (k < 0) { this.out.push({ ...tag, msg: `Unexpected </${raw}>: no <${raw}> is open here` }); return; }
    for (const s of this.stack.splice(k).slice(1)) {
      if (this.needsEnd(s.name)) this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed (expected </${s.name}> before </${raw}>)` });
    }
  }
  private openTag(tag: OpenTag, nameLen: number, attrs: string): void {
    if (attrs.endsWith('/') || this.isVoid(tag.name)) return;
    this.stack.push({ name: tag.name, at: tag.at, len: nameLen });
    if (!this.xml && RAW_TAGS.has(tag.name)) this.rawText(tag.name, attrs);
  }
  // <script>, <style>…: skip to the closing tag, checking the code inside on the way.
  private rawText(name: string, attrs: string): void {
    const from = this.re.lastIndex;
    const end = this.lower.indexOf(`</${name}`, from);
    if (end === -1) { this.re.lastIndex = this.t.length; return; } // reported as never closed
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1].toLowerCase();
    let opts: ScanOpts | null = null;
    if (name === 'style') opts = CSS_SCAN;
    else if (name === 'script' && (!type || JS_TYPES.has(type))) opts = JS_SCAN;
    if (opts) for (const d of scanCode(this.t.slice(from, end), opts).diags) this.out.push({ ...d, at: d.at + from });
    this.re.lastIndex = end;
  }
}

const JS_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const V8_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']); // JSX/TSX need a JSX-aware parser
const looseJson = (path: string) => /^(?:tsconfig|jsconfig)\b/i.test(baseName(path)) || path.startsWith('.vscode/');
function lintCss(text: string, ext: string): RawDiag[] {
  const r = scanCode(text, ext === 'css' ? CSS_SCAN : { ...CSS_SCAN, lineCom: '//' });
  return ext === 'css' && !r.diags.length ? lintCssDecls(r.masked) : r.diags;
}
function lintPy(text: string): RawDiag[] {
  const r = scanCode(text, PY_SCAN);
  return r.diags.length ? r.diags : lintPython(r.masked);
}
// Which check runs for each file extension.
const LINTERS: Record<string, (text: string, path: string) => RawDiag[]> = {
  json: (t, p) => new JsonChecker(t, looseJson(p)).check(),
  jsonc: t => new JsonChecker(t, true).check(),
  css: t => lintCss(t, 'css'), scss: t => lintCss(t, 'scss'), less: t => lintCss(t, 'less'),
  html: t => new MarkupChecker(t, false).run(), htm: t => new MarkupChecker(t, false).run(), vue: t => new MarkupChecker(t, false).run(),
  xml: t => new MarkupChecker(t, true).run(), svg: t => new MarkupChecker(t, true).run(),
  py: lintPy,
};
for (const ext of JS_EXT) LINTERS[ext] = t => scanCode(t, { ...JS_SCAN, jsx: ext === 'jsx' || ext === 'tsx' }).diags;
function lintStructure(text: string, path: string): RawDiag[] {
  return LINTERS[extOf(path)]?.(text, path) ?? [];
}
function toDiags(t: string, raw: RawDiag[]): Diag[] {
  const starts = [0];
  for (let k = t.indexOf('\n'); k !== -1; k = t.indexOf('\n', k + 1)) starts.push(k + 1);
  return raw.map(d => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= d.at) lo = mid; else hi = mid - 1; }
    return { line: lo, col: d.at - starts[lo], len: d.len, msg: d.msg };
  }).sort((a, b) => a.line - b.line || a.col - b.col);
}

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
interface Snapshot { text: string; sel: [number, number]; }
interface Buffer {
  path: string;
  kind: 'text' | 'binary' | 'large' | 'image';
  text: string;
  saved: string;
  eol: '\n' | '\r\n';
  size: number;
  ta: HTMLTextAreaElement | null;
  url?: string;          // images: where the picture loads from
  diags?: Diag[];        // syntax errors from the last check
  diagLines?: number;    // line count the errors were found at (they're hidden while it differs)
  lintSeq?: number;
  lintTimer?: number;
  undo: Snapshot[];      // the editor keeps its own history (see "Undo & redo")
  redo: Snapshot[];
  lastEdit: { kind: string; at: number } | null;
}
interface Session { tabs: string[]; active: string | null; expanded: string[]; pos: Record<string, [number, number]>; }

let rootInfo: RootInfo | null = null;
const dirCache = new Map<string, DirEntry[]>();
const expanded = new Set<string>();
const buffers = new Map<string, Buffer>();
const textareaOwner = new WeakMap<HTMLTextAreaElement, Buffer>();
let openTabs: string[] = [];
let active: string | null = null;
const locks: Record<string, AgentKey> = {};
const added: Record<string, Set<number>> = {};
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

// Puts back a tab's unsaved text and caret from the last session.
function restoreBuffer(b: Buffer, s: Session, dirty: Record<string, string>): void {
  if (b.kind === 'text' && dirty[b.path] != null) { b.text = dirty[b.path]; if (b.ta) b.ta.value = b.text; }
  const pos = s.pos[b.path];
  if (b.ta && pos) { b.ta.setSelectionRange(pos[0], pos[0]); b.ta.scrollTop = pos[1]; }
}
async function loadWorkspace(info: RootInfo): Promise<void> {
  if (rootInfo) { flushSession(); resetWorkspace(); }
  rootInfo = info;
  $('#projectName').textContent = info.name;
  $('#projectName').title = info.root;
  document.title = `${info.name} — Breeze IDE`;
  const s = store.get<Session>(sessionKey(), { tabs: [], active: null, expanded: [], pos: {} });
  const dirty = store.get<Record<string, string>>(hotExitKey(), {});
  expanded.clear();
  for (const d of s.expanded) expanded.add(d);
  await Promise.all(['', ...s.expanded].map(loadDir));
  renderTree();
  const loaded = await Promise.all(s.tabs.map(loadBuffer));
  for (const b of loaded) {
    if (!b) continue;
    restoreBuffer(b, s, dirty);
    openTabs.push(b.path);
  }
  active = s.active && openTabs.includes(s.active) ? s.active : openTabs[0] ?? null;
  renderTabs(); renderEditor(); renderTree();
  restoreChat(SURFACES.ide);
  renderBoxFolder();
  void refreshGit();
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
  catch { dirCache.delete(rel); expanded.delete(rel); } // gone or unreadable: show it collapsed
}

function kindOf(r: FileRead): Buffer['kind'] {
  if (r.image) return 'image';
  if (r.binary) return 'binary';
  return r.tooLarge ? 'large' : 'text';
}
async function loadBuffer(path: string): Promise<Buffer | null> {
  const existing = buffers.get(path);
  if (existing) return existing;
  let r: FileRead;
  try { r = await api.fs.readFile(path); } catch (e) { toast(`Couldn't open ${baseName(path)}: ${errMsg(e)}`); return null; }
  const raw = r.text ?? '';
  const b: Buffer = {
    path, size: r.size, kind: kindOf(r),
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    text: raw.replaceAll('\r\n', '\n'), saved: '', ta: null,
    undo: [], redo: [], lastEdit: null,
  };
  b.saved = b.text;
  if (b.kind === 'image') b.url = await api.fs.fileUrl(path).catch(() => '');
  if (b.kind === 'text') { b.ta = createTextarea(b); scheduleLint(b, 0); }
  buffers.set(path, b);
  return b;
}

/* ----- Syntax errors for a buffer ----- */
function scheduleLint(b: Buffer, delay = 450): void {
  clearTimeout(b.lintTimer);
  b.lintTimer = setTimeout(() => void lintBuffer(b), delay);
}
// V8 has the final word on JavaScript/TypeScript: it is exact, and clean code clears any false alarm.
// When both find something, the structural messages win on shared lines (they say more).
function mergeSyntax(diags: Diag[], r: SyntaxResult): Diag[] {
  if (!r) return diags;
  if ('ok' in r) return [];
  if (diags.length && (r.eof || diags.some(d => d.line === r.line))) return diags;
  return [...diags, { line: r.line, col: r.col, len: r.len, msg: r.msg }].sort((x, y) => x.line - y.line);
}
async function lintBuffer(b: Buffer): Promise<void> {
  if (b.kind !== 'text' || buffers.get(b.path) !== b) return;
  const seq = b.lintSeq = (b.lintSeq ?? 0) + 1;
  const text = b.text, ext = extOf(b.path);
  let diags: Diag[] = [];
  if (text.length <= LINT_MAX) {
    diags = toDiags(text, lintStructure(text, b.path));
    if (V8_EXT.has(ext)) {
      const r = await api.lint.check(text, ext).catch(() => null);
      if (seq !== b.lintSeq) return; // a newer check is on its way
      diags = mergeSyntax(diags, r);
    }
  }
  const had = !!b.diags?.length;
  b.diags = diags;
  b.diagLines = text.split('\n').length;
  if (had !== !!diags.length) renderTabs();
  if (b.path === active) renderCode();
}

// Each open file keeps its own textarea (and history) across tab switches.
function createTextarea(b: Buffer): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  ta.className = 'ta hidden';
  ta.spellcheck = false;
  ta.wrap = 'off';
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('aria-label', `Editing ${b.path}`);
  ta.value = b.text;
  textareaOwner.set(ta, b);
  ta.addEventListener('beforeinput', e => beforeEdit(b, e));
  ta.addEventListener('input', () => {
    const wasDirty = isDirty(b);
    b.text = ta.value;
    if (wasDirty !== isDirty(b)) { renderTabs(); renderTree(); }
    if (findOpen) runFind(false);
    queueRender(); saveSession(); scheduleLint(b);
    // Suggest words while typing one; any other edit closes the list.
    if (b.lastEdit?.kind === 'type' && Date.now() - b.lastEdit.at < 100) editorSuggest(b); else hideSuggest();
  });
  ta.addEventListener('blur', hideSuggest);
  ta.addEventListener('mousedown', hideSuggest);
  ta.addEventListener('scroll', () => { if (suggest?.owner === ta) editorSuggest(b); }); // follow the caret
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keydown', editorKeys);
  for (const ev of ['keyup', 'mouseup', 'select', 'selectionchange', 'focus']) ta.addEventListener(ev, updateCaret);
  $('#editor .code').appendChild(ta);
  return ta;
}

/* ----- Undo & redo ----- */
// The editor records its own history, so edits made by commands (indent, comment, move line…) undo
// exactly like typing. Typing groups into words; a pause of a second starts a new step.
const GROUPED = new Set(['type', 'deleteContentBackward', 'deleteContentForward']);
function remember(b: Buffer, kind: string): void {
  const ta = b.ta;
  if (!ta) return;
  const now = Date.now();
  const grouped = GROUPED.has(kind) && b.lastEdit?.kind === kind && now - b.lastEdit.at < 1000;
  b.lastEdit = { kind, at: now };
  if (grouped) return;
  b.undo.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
  if (b.undo.length > 500) b.undo.shift();
  b.redo = [];
}
function beforeEdit(b: Buffer, e: InputEvent): void {
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault();
    stepHistory(b, e.inputType === 'historyUndo');
    return;
  }
  const word = e.inputType === 'insertText' && !!e.data && !/\s/.test(e.data);
  remember(b, word ? 'type' : e.inputType);
}
function stepHistory(b: Buffer, back: boolean): void {
  const ta = b.ta;
  const [from, to] = back ? [b.undo, b.redo] : [b.redo, b.undo];
  const snap = from.pop();
  if (!ta || !snap) return;
  to.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
  b.lastEdit = null;
  ta.value = snap.text;
  ta.setSelectionRange(snap.sel[0], snap.sel[1]);
  ta.dispatchEvent(new Event('input'));
  revealOffset(b, snap.sel[0]);
}

/* ================= Explorer ================= */
const GIT_LETTER: Record<string, string> = { 'git-m': 'M', 'git-u': 'U', 'git-a': 'A', 'git-d': 'D' };
function chevClass(e: DirEntry, open: boolean): string {
  if (!e.dir) return 'none';
  return open ? 'open' : '';
}
function treeRow(e: DirEntry, p: string, depth: number, decor: ReturnType<typeof gitDecor>, enter: boolean): string {
  const open = e.dir && expanded.has(p);
  const lock = locks[p];
  const lockTag = lock ? `<span class="lock tint-${lock}">${agentsDef[lock].name}</span>` : '';
  const g = e.dir ? (decor.dirs.has(p) && 'has-changes') || '' : decor.files.get(p) ?? '';
  const gitTag = !e.dir && g && !lock ? `<span class="gst">${GIT_LETTER[g] ?? ''}</span>` : '';
  const cls = ['tree-item', p === active ? 'on' : '', isDirty(buffers.get(p)) ? 'dirty' : '', p === ctxPath ? 'ctx' : '', g, enter ? 'enter' : ''].filter(Boolean).join(' ');
  const icon = e.dir ? folderIcon(e.name, open) : fileIcon(e.name);
  return `<div class="${cls}" data-depth="${depth}" data-path="${escAttr(p)}" ${e.dir ? 'data-dir="1"' : ''} title="${escAttr(p)}">
    <span class="chev ${chevClass(e, open)}">${CHEV}</span><span class="ico">${icon}</span><span class="nm">${esc(e.name)}</span>${lockTag}${gitTag}</div>`;
}
function renderTree(): void {
  const el = $('#tree');
  if (!rootInfo) {
    el.innerHTML = `<div class="side-note">You have not opened a folder yet.<button class="btn btn-primary btn-sm" data-act="file.openFolder">Open Folder</button></div><div id="recentList"></div>`;
    void renderRecent();
    return;
  }
  const rows: string[] = [];
  const decor = gitDecor();
  const walk = (rel: string, depth: number) => {
    for (const e of dirCache.get(rel) ?? []) {
      const p = joinPath(rel, e.name);
      rows.push(treeRow(e, p, depth, decor, !!rel && rel === justExpanded));
      if (e.dir && expanded.has(p)) walk(p, depth + 1);
    }
  };
  walk('', 0);
  el.innerHTML = rows.join('') || '<p class="side-note">This folder is empty.</p>';
  // Indentation is set through the DOM: the CSP allows no inline style attributes.
  for (const row of $$('[data-depth]', el)) row.style.paddingLeft = `${4 + Number(row.dataset.depth) * 12}px`;
  justExpanded = null;
}
// The folder whose children should animate in on the next render.
let justExpanded: string | null = null;
async function renderRecent(): Promise<void> {
  const recent = await api.fs.recent().catch(() => []);
  const el = document.getElementById('recentList');
  if (!el || !recent.length) return;
  const rows = recent.map(r => `<div class="tree-item" data-recent="${escAttr(r.path)}" title="${escAttr(r.path)}"><span class="ico">▸</span><span class="nm">${esc(r.name)}</span></div>`);
  el.innerHTML = '<div class="side-head pl-8">Recent</div>' + rows.join('');
}
$('#tree').addEventListener('click', e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-path],[data-recent],[data-act]');
  if (!t || t.dataset.act) return; // data-act buttons are handled by the global listener
  if (t.dataset.recent) { void openRecentFolder(t.dataset.recent); return; }
  const p = t.dataset.path as string;
  if (t.dataset.dir) void toggleDir(p); else openFile(p);
});
$('#tree').addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!rootInfo) return;
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
  const p = t?.dataset.path ?? '';
  const isDir = !t || !!t.dataset.dir;
  ctxPath = p || null; renderTree();
  const dir = isDir ? p : dirName(p);
  const fileItems: MenuItem[] = p ? [
    { sep: true },
    { label: 'Rename…', key: 'F2', run: () => background(renameEntry(p)) },
    { label: 'Delete', key: 'Delete', run: () => deleteEntry(p, isDir) },
    { sep: true },
    { label: 'Copy Relative Path', run: () => background(navigator.clipboard.writeText(p).then(() => toast('Path copied'))) },
  ] : [];
  popupMenu(e.clientX, e.clientY, [
    { label: 'New File…', run: () => background(newEntry(dir, false)) },
    { label: 'New Folder…', run: () => background(newEntry(dir, true)) },
    ...fileItems,
  ], () => { ctxPath = null; renderTree(); });
});
async function toggleDir(p: string): Promise<void> {
  if (expanded.has(p)) expanded.delete(p);
  else {
    expanded.add(p);
    if (!dirCache.has(p)) await loadDir(p);
    justExpanded = p;
  }
  renderTree(); saveSession();
}
async function refreshTree(): Promise<void> {
  if (!rootInfo) return;
  await Promise.all(['', ...expanded].map(loadDir));
  renderTree();
}
// The folder new files go into: right-clicked folder, else the active file's folder, else the root.
const targetDir = () => (active ? dirName(active) : '');

// Wraps a promise's resolve so only the first answer counts (a dialog can be confirmed and then closed).
function settleOnce<T>(resolve: (v: T) => void): (v: T) => void {
  let done = false;
  return v => {
    if (done) return;
    done = true;
    resolve(v);
  };
}
function askName(title: string, initial: string, okLabel: string): Promise<string | null> {
  return new Promise(res => {
    const finish = settleOnce(res);
    openModal(`<h3>${esc(title)}</h3><input class="input name-input" id="nameIn" aria-label="${escAttr(title)}" spellcheck="false" value="${escAttr(initial)}">
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nameOk">${okLabel}</button></div>`, m => {
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
  const rel = joinPath(dir, name.replaceAll('\\', '/').replace(/^\/+/, ''));
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
  const move = (x: string) => {
    if (x === p) return to;
    return x.startsWith(p + '/') ? to + x.slice(p.length) : x;
  };
  const moved = [...buffers.values()].filter(b => move(b.path) !== b.path);
  for (const b of moved) { buffers.delete(b.path); b.path = move(b.path); buffers.set(b.path, b); scheduleLint(b, 0); }
  await Promise.all(moved.filter(b => b.kind === 'image').map(async b => { b.url = await api.fs.fileUrl(b.path).catch(() => ''); }));
  openTabs = openTabs.map(move);
  if (active) active = move(active);
  const dirs = [...expanded];
  expanded.clear();
  for (const d of dirs) expanded.add(move(d));
  dirCache.clear();
  await refreshTree(); renderTabs(); renderEditor(); saveSession();
}
const binName = () => (isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash');
function deleteEntry(p: string, isDir: boolean): void {
  const what = isDir ? 'The folder and everything in it' : 'The file';
  const bin = binName();
  openModal(`<h3>Delete ${esc(baseName(p))}?</h3><p class="sub">${what} will be moved to the ${bin}, so you can restore it.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="delOk">Move to ${bin}</button></div>`, m => {
    $('#delOk', m).onclick = () => background((async () => {
      closeModal();
      await api.fs.trash(p);
      for (const path of openTabs.filter(x => x === p || x.startsWith(p + '/'))) dropTab(path);
      expanded.delete(p);
      await refreshTree(); renderTabs(); renderEditor(); saveSession();
    })());
  });
}

// Files changed on disk (by an agent, git or another editor): reload what isn't being edited.
async function reloadImage(b: Buffer): Promise<void> {
  // Same file URL, new query: the viewer reloads the picture.
  const url = b.url ?? '';
  const q = url.indexOf('?');
  b.url = `${q === -1 ? url : url.slice(0, q)}?v=${Date.now()}`;
  b.size = (await api.fs.readFile(b.path).catch(() => null))?.size ?? b.size;
  if (b.path === active) renderEditor();
}
async function reloadText(b: Buffer): Promise<void> {
  const r = await api.fs.readFile(b.path).catch(() => null); // deleted or unreadable: keep the buffer
  if (r?.text == null) return;
  const text = r.text.replaceAll('\r\n', '\n');
  if (text === b.saved || isDirty(b)) return;
  remember(b, 'reload');
  b.text = b.saved = text;
  if (b.ta) { const s = b.ta.selectionStart; b.ta.value = text; b.ta.setSelectionRange(s, s); }
  if (b.path === active) renderCode();
  scheduleLint(b, 0);
}
api.fs.onChange(paths => background((async () => {
  queueGitRefresh();
  // Reload changed folders, and changed paths that are themselves cached folders (e.g. created then filled).
  const dirs = new Set([...paths.map(dirName), ...paths].filter(d => dirCache.has(d)));
  await Promise.all([...dirs].map(loadDir));
  renderTree();
  const changed = paths.map(p => buffers.get(p)).filter((b): b is Buffer => !!b);
  await Promise.all(changed.map(b => {
    if (b.kind === 'image' && b.url?.startsWith('file:')) return reloadImage(b);
    return b.kind === 'text' && !isDirty(b) ? reloadText(b) : null;
  }));
})()));

/* ================= Opening, tabs & saving ================= */
type Spot = { line: number; col: number; len?: number };
function openFile(path: string, at?: Spot): void {
  if (baseName(path).startsWith('.env') && !buffers.has(path)) {
    openModal(`<h3>This is a protected file</h3><p class="sub">${esc(baseName(path))} holds secrets. You can view it, but agents can't read it unless you allow it each time.</p><div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="openEnv">Open for me only</button></div>`,
      m => { $('#openEnv', m).onclick = () => { closeModal(); void actuallyOpen(path, at); }; });
    return;
  }
  void actuallyOpen(path, at);
}
async function actuallyOpen(path: string, at?: Spot): Promise<void> {
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
  if (changed) for (const el of [$('#hl'), $('#gutter')]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  if (running && path && /\.(html?|css|js)$/i.test(path)) $('#urlText').title = path;
}
const seenTabs = new Set<string>();
function tabHtml(n: string): string {
  const lock = locks[n];
  const b = buffers.get(n);
  const cls = ['tab', n === active ? 'on' : '', isDirty(b) ? 'dirty' : '', b?.diags?.length ? 'has-err' : '', seenTabs.has(n) ? '' : 'enter'].filter(Boolean).join(' ');
  seenTabs.add(n);
  const dot = lock ? `<span class="dot tint-${lock}"></span>` : '';
  return `<div class="${cls}" data-tab="${escAttr(n)}" title="${escAttr(n)}">${dot}<span class="ico">${fileIcon(baseName(n))}</span>${esc(baseName(n))}<span class="x" data-close-tab="1" title="Close (Ctrl+W)"><span>✕</span></span></div>`;
}
function renderTabs(): void {
  // Re-rendering mid-drag would drop the tab being dragged; catch up when it lands.
  if (tabDrag?.moved) { tabDrag.stale = true; return; }
  $('#tabs').innerHTML = openTabs.map(tabHtml).join('');
}
$('#tabs').addEventListener('click', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!tab || justDragged) return;
  const p = tab.dataset.tab as string;
  if ((e.target as HTMLElement).closest('[data-close-tab]')) closeTab(p); else setActive(p);
});
$('#tabs').addEventListener('wheel', e => {
  const t = e.currentTarget as HTMLElement;
  if (!e.deltaX && e.deltaY) { t.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });
$('#tabs').addEventListener('auxclick', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (tab && e.button === 1) closeTab(tab.dataset.tab as string);
});

// Closes several tabs at once, asking once about any unsaved ones.
function closeTabs(paths: string[]): void {
  const dirty = paths.map(p => buffers.get(p)).filter((b): b is Buffer => isDirty(b));
  const finish = () => {
    for (const p of paths) dropTab(p);
    renderTabs(); renderEditor(); renderTree(); saveSession();
  };
  if (!dirty.length) { finish(); return; }
  openModal(`<h3>Save changes to ${plural(dirty.length, 'file')}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="tabsDontSave">Don't Save</button><button class="btn btn-primary" id="tabsSave">Save</button></div>`, m => {
    $('#tabsDontSave', m).onclick = () => { closeModal(); finish(); };
    $('#tabsSave', m).onclick = () => {
      closeModal();
      background(Promise.all(dirty.map(b => saveFile(b.path))).then(saved => { if (saved.every(Boolean)) finish(); }));
    };
  });
}
// Shows a file in the explorer, opening the folders above it.
function revealInTree(p: string): void {
  for (let d = dirName(p); d; d = dirName(d)) expanded.add(d);
  showView('files', true);
  background(refreshTree().then(() => $$('#tree [data-path]').find(el => el.dataset.path === p)?.scrollIntoView({ block: 'nearest' })));
}
// Right-clicking a tab: close it, the others, the ones to its right, the saved ones or all of them.
$('#tabs').addEventListener('contextmenu', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!tab) return;
  e.preventDefault();
  const p = tab.dataset.tab as string;
  const others = openTabs.filter(x => x !== p);
  const right = openTabs.slice(openTabs.indexOf(p) + 1);
  const saved = openTabs.filter(x => !isDirty(buffers.get(x)));
  popupMenu(e.clientX, e.clientY, [
    { label: 'Close', key: 'Ctrl+W', run: () => closeTab(p) },
    { label: 'Close Other Tabs', enabled: () => others.length > 0, run: () => closeTabs(others) },
    { label: 'Close Tabs to the Right', enabled: () => right.length > 0, run: () => closeTabs(right) },
    { label: 'Close Saved Tabs', enabled: () => saved.length > 0, run: () => closeTabs(saved) },
    { label: 'Close All Tabs', run: () => closeTabs([...openTabs]) },
    { sep: true },
    { label: 'Copy Relative Path', run: () => background(navigator.clipboard.writeText(p).then(() => toast('Path copied'))) },
    { label: 'Reveal in Explorer', run: () => revealInTree(p) },
  ]);
});

/* ----- Dragging tabs to reorder them ----- */
// The dragged tab follows the pointer; once its middle passes a neighbour's middle the two swap,
// and the neighbour slides into its new place.
interface TabDrag { el: HTMLElement; path: string; startX: number; moved: boolean; stale: boolean; }
let tabDrag: TabDrag | null = null;
let justDragged = false;
const middle = (el: Element) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
function slideFrom(el: Element, fromLeft: number): void {
  const dx = fromLeft - el.getBoundingClientRect().left;
  if (dx) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
// Moves `other` to the far side of the dragged tab, keeping the dragged tab under the pointer.
function swapTab(d: TabDrag, other: Element, clientX: number): void {
  const before = d.el.offsetLeft, otherLeft = other.getBoundingClientRect().left;
  if (other === d.el.nextElementSibling) d.el.before(other); else d.el.after(other);
  d.startX += d.el.offsetLeft - before;
  d.el.style.transform = `translateX(${clientX - d.startX}px)`;
  slideFrom(other, otherLeft);
}
function dragTabMove(e: PointerEvent): void {
  const d = tabDrag;
  if (!d) return;
  const dx = e.clientX - d.startX;
  if (!d.moved && Math.abs(dx) < 5) return;
  if (!d.moved) { d.moved = true; d.el.classList.add('dragging'); $('#tabs').classList.add('drag-active'); }
  d.el.style.transform = `translateX(${dx}px)`;
  const mid = middle(d.el);
  const next = d.el.nextElementSibling, prev = d.el.previousElementSibling;
  if (next && mid > middle(next)) swapTab(d, next, e.clientX);
  else if (prev && mid < middle(prev)) swapTab(d, prev, e.clientX);
}
function dragTabEnd(e: PointerEvent): void {
  removeEventListener('pointermove', dragTabMove);
  removeEventListener('pointerup', dragTabEnd);
  const d = tabDrag;
  tabDrag = null;
  if (!d?.moved) return;
  // The click that follows a drag must not activate or close anything.
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  $('#tabs').classList.remove('drag-active');
  openTabs = $$('#tabs [data-tab]').map(t => t.dataset.tab as string);
  const rest = e.clientX - d.startX;
  setActive(d.path);
  const landed = $$('#tabs [data-tab]').find(t => t.dataset.tab === d.path);
  if (landed && rest) landed.animate([{ transform: `translateX(${rest}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
$('#tabs').addEventListener('pointerdown', e => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>('[data-tab]');
  if (!el || e.button !== 0 || t.closest('[data-close-tab]')) return;
  tabDrag = { el, path: el.dataset.tab as string, startX: e.clientX, moved: false, stale: false };
  addEventListener('pointermove', dragTabMove);
  addEventListener('pointerup', dragTabEnd);
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
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dontSave">Don't Save</button><button class="btn btn-primary" id="doSave">Save</button></div>`, m => {
    $('#dontSave', m).onclick = () => { closeModal(); finish(); };
    $('#doSave', m).onclick = () => { closeModal(); background(saveFile(path).then(ok => { if (ok) finish(); })); };
  });
}
async function saveFile(path: string | null = active): Promise<boolean> {
  const b = path ? buffers.get(path) : undefined;
  if (b?.kind !== 'text') return false;
  const text = b.text;
  try { await api.fs.writeFile(b.path, b.eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text); }
  catch (e) { toast(`Couldn't save ${baseName(b.path)}: ${errMsg(e)}`); return false; }
  b.saved = text;
  renderTabs(); renderTree(); flushSession();
  if (running) void reloadPreview();
  return true;
}
async function saveAll(): Promise<void> {
  const dirty = [...buffers.values()].filter(isDirty);
  await Promise.all(dirty.map(b => saveFile(b.path)));
  if (dirty.length) toast(`Saved ${plural(dirty.length, 'file')}`);
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
  return b?.kind === 'text' && b.ta ? b as Buffer & { ta: HTMLTextAreaElement } : undefined;
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
void document.fonts?.ready.then(() => { charW = 0; renderCode(); });

const lineStart = (v: string, pos: number) => v.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (v: string, pos: number) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i; };
function lineAt(v: string, pos: number): number {
  let n = 0;
  for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1)) n++;
  return n;
}
function offsetOf(v: string, line: number, col: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) {
    const nl = v.indexOf('\n', off);
    if (nl === -1) return v.length;
    off = nl + 1;
  }
  return Math.min(off + col, lineEnd(v, off));
}
function visualCol(lineText: string, col: number): number {
  let v = 0;
  for (let i = 0; i < col; i++) v = lineText[i] === '\t' ? v + 4 - (v % 4) : v + 1;
  return v;
}

function editorNote(b: Buffer): string {
  if (b.kind === 'binary') return 'This file is binary, so Breeze can\'t show it as text.';
  if (b.kind === 'image') return 'Breeze couldn\'t load this image.';
  return `This file is too large to open (${(b.size / 1048576).toFixed(1)} MB).`;
}
function renderEditor(): void {
  hideSuggest();
  const b = activeBuf();
  for (const x of buffers.values()) x.ta?.classList.toggle('hidden', x !== b);
  const empty = $('#editorEmpty');
  if (b?.kind !== 'text') {
    empty.classList.remove('hidden');
    if (b?.kind === 'image' && b.url) showImage(empty, b);
    else {
      empty.classList.remove('img-mode');
      delete empty.dataset.img;
      empty.innerHTML = b ? fileNoteHtml(b.path, editorNote(b)) : welcomeHtml();
    }
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
const fileNoteHtml = (path: string, note: string) => `<div><h4>${esc(baseName(path))}</h4><div>${esc(note)}</div></div>`;
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  return n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
// Images open in a viewer: fitted to the editor, click to see them at actual size.
function showImage(el: HTMLElement, b: Buffer): void {
  el.classList.add('img-mode');
  if (el.dataset.img === b.url) return; // already showing it: keep its zoom and scroll
  el.dataset.img = b.url;
  el.innerHTML = `<div class="img-stage fit"><img src="${escAttr(b.url ?? '')}" alt="${escAttr(baseName(b.path))}" draggable="false"></div>
    <div class="img-meta"><span class="img-dims">Loading…</span><span>${fmtSize(b.size)}</span><span class="img-zoom hidden"></span></div>`;
  const stage = $('.img-stage', el), img = $<HTMLImageElement>('img', el), zoom = $('.img-zoom', el);
  const shrunk = () => img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1;
  const hint = () => {
    const fit = stage.classList.contains('fit');
    zoom.textContent = fit ? 'Fit to window · click to zoom' : 'Actual size · click to fit';
    zoom.classList.toggle('hidden', fit && !shrunk());
    stage.classList.toggle('zoomable', !fit || shrunk());
  };
  img.onload = () => { $('.img-dims', el).textContent = `${img.naturalWidth} × ${img.naturalHeight}`; hint(); };
  img.onmouseenter = hint; // panels may have been resized since it loaded
  img.onerror = () => { el.classList.remove('img-mode'); el.innerHTML = fileNoteHtml(b.path, 'Breeze couldn\'t load this image.'); };
  img.onclick = e => {
    const fit = stage.classList.contains('fit');
    if (fit && !shrunk()) return;
    // Zoom in around the clicked point.
    const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    stage.classList.toggle('fit');
    if (fit) {
      stage.scrollLeft = img.offsetLeft + fx * img.naturalWidth - (e.clientX - s.left);
      stage.scrollTop = img.offsetTop + fy * img.naturalHeight - (e.clientY - s.top);
    }
    hint();
  };
}
function welcomeHtml(): string {
  const k = (keys: string, what: string) => `<span>${what}</span><kbd>${keys}</kbd>`;
  const keys = rootInfo
    ? k('Ctrl+P', 'Go to file') + k('Ctrl+N', 'New file') + k('Ctrl+Shift+F', 'Search files') + k('Ctrl+`', 'Terminal')
    : k('Ctrl+O', 'Open folder') + k('Ctrl+B', 'Toggle side bar') + k('Ctrl+Alt+B', 'Toggle agents');
  return `<div><img src="Agent.png" alt=""><h4>${rootInfo ? 'No file open' : 'Open a folder to start'}</h4><div class="keys">${keys}</div></div>`;
}
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderCode(); });
}

// Overlay boxes (find hits, squiggles) are placed through the DOM, not style attributes.
function box(cls: string, top: number, left: number, width?: number): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  d.style.top = `${top}px`;
  d.style.left = `${left}px`;
  if (width != null) d.style.width = `${width}px`;
  return d;
}
function findBoxes(b: Buffer, cw: number): HTMLElement[] {
  if (!findOpen || !findLen) return [];
  const vis = findHits.length > 3000 ? findHits.slice(Math.max(0, findIdx - 1500), findIdx + 1500) : findHits;
  return vis.map(off => {
    const ln = lineAt(b.text, off), ls = lineStart(b.text, off);
    const lt = b.text.slice(ls, lineEnd(b.text, ls));
    const x = visualCol(lt, off - ls) * cw, w = (visualCol(lt, off - ls + findLen) * cw) - x;
    return box(off === findHits[findIdx] ? 'hit cur' : 'hit', ln * LINE_H, x, Math.max(w, 2));
  });
}
// Syntax errors: a red line, a squiggle under the mistake and the message after the code.
// While an edit has added or removed lines they wait for the next check instead of drifting.
function visibleDiags(b: Buffer, lineCount: number): Map<number, Diag> {
  const errAt = new Map<number, Diag>();
  if (!b.diags?.length || b.diagLines !== lineCount) return errAt;
  for (const d of b.diags) {
    const ln = Math.min(d.line, lineCount - 1);
    if (!errAt.has(ln)) errAt.set(ln, d);
  }
  return errAt;
}
function squiggles(b: Buffer, lineCount: number, cw: number): HTMLElement[] {
  if (!b.diags?.length || b.diagLines !== lineCount) return [];
  const raw = b.text.split('\n');
  return b.diags.map(d => {
    const ln = Math.min(d.line, raw.length - 1), lt = raw[ln];
    const from = Math.min(d.col, lt.length), to = Math.min(lt.length, d.col + d.len);
    const x = visualCol(lt, from) * cw;
    return box('squig', ln * LINE_H + 15, x, Math.max(visualCol(lt, to) * cw - x, cw));
  });
}
function lineHtml(h: string, i: number, add: Set<number> | undefined, d: Diag | undefined): string {
  const cls = ['ln', add?.has(i) ? 'added' : '', d ? 'err' : '', i === curLine ? 'cur-line' : ''].filter(Boolean).join(' ');
  const msg = d ? `<span class="diag-msg">${esc(d.msg)}</span>` : '';
  return `<div class="${cls}">${h}${msg}</div>`;
}
function gutterHtml(i: number, d: Diag | undefined): string {
  const cls = [i === curLine ? 'cur' : '', d ? 'err' : ''].filter(Boolean).join(' ');
  const attrs = (cls ? ` class="${cls}"` : '') + (d ? ` title="${escAttr(d.msg)}"` : '');
  return `<div${attrs}>${i + 1}</div>`;
}
function renderCode(): void {
  const b = activeText();
  if (!b) return;
  const lines = highlightLines(b.text, langOf(b.path)[0]);
  curLine = lineAt(b.text, b.ta.selectionStart);
  const cw = measureChar();
  const errAt = visibleDiags(b, lines.length);
  const add = added[b.path];
  hlInner.innerHTML = lines.map((h, i) => lineHtml(h, i, add, errAt.get(i))).join('');
  hlInner.append(...findBoxes(b, cw), ...squiggles(b, lines.length, cw));
  $('#gutter').style.width = `${Math.max(3, String(lines.length).length) * 8 + 32}px`;
  gutInner.innerHTML = lines.map((_, i) => gutterHtml(i, errAt.get(i))).join('');
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
  const tb = activeText();
  $('#sbPos').classList.toggle('hidden', !tb);
  $('#sbLang').textContent = b ? langOf(b.path)[1] : '';
  $('#sbLang').classList.toggle('hidden', !b);
  const eol = b?.eol === '\r\n' ? 'CRLF' : 'LF';
  $('#sbEol').textContent = b?.kind === 'text' ? `${eol} · UTF-8` : '';
  $('#sbEol').classList.toggle('hidden', b?.kind !== 'text');
  const problems = tb?.diags?.length ?? 0;
  $('#sbProblems').textContent = `⊗ ${plural(problems, 'problem')}`;
  $('#sbProblems').classList.toggle('hidden', !problems);
  if (!tb) return;
  const { selectionStart: s, selectionEnd: e } = tb.ta;
  const ls = lineStart(tb.text, s);
  const selected = e > s ? ` (${e - s} selected)` : '';
  $('#sbPos').textContent = `Ln ${lineAt(tb.text, s) + 1}, Col ${s - ls + 1}${selected}`;
}
// F8: move the caret to the next syntax error after it, wrapping around.
function nextProblem(): void {
  const b = activeText();
  if (!b?.diags?.length) { toast('No problems in this file'); return; }
  const offs = b.diags.map(d => offsetOf(b.text, d.line, d.col));
  const off = offs.find(o => o > b.ta.selectionStart) ?? offs[0];
  b.ta.focus();
  b.ta.setSelectionRange(off, off);
  revealOffset(b, off);
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

// Replaces a range as one undoable step.
function replaceRange(ta: HTMLTextAreaElement, start: number, end: number, text: string, selStart?: number, selEnd?: number): void {
  const b = textareaOwner.get(ta);
  if (b) remember(b, 'command');
  ta.focus();
  ta.setRangeText(text, start, end, 'end');
  if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
  ta.dispatchEvent(new Event('input'));
}
function selectedLines(ta: HTMLTextAreaElement): [number, number] {
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  return [lineStart(v, s), lineEnd(v, e > s && v[e - 1] === '\n' ? e - 1 : e)];
}
function indentKey(ta: HTMLTextAreaElement, outdent: boolean): void {
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  if (!outdent && !v.slice(s, en).includes('\n')) { replaceRange(ta, s, en, INDENT); return; }
  const [ls, le] = selectedLines(ta);
  const block = v.slice(ls, le);
  const lines = block.split('\n');
  const out = lines.map(l => (outdent ? l.replace(/^(?: {1,2}|\t)/, '') : INDENT + l)).join('\n');
  const firstDelta = out.split('\n')[0].length - lines[0].length;
  replaceRange(ta, ls, le, out, Math.max(ls, s + firstDelta), en + out.length - block.length);
}
// True when `before` ends with an opening tag such as <div class="x">.
function endsWithOpenTag(before: string): boolean {
  const lt = before.lastIndexOf('<');
  if (lt === -1 || !before.endsWith('>')) return false;
  const tag = before.slice(lt);
  return /^<[A-Za-z]/.test(tag) && !tag.endsWith('/>');
}
function enterKey(ta: HTMLTextAreaElement): void {
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  const before = v.slice(lineStart(v, s), s);
  const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
  const isPy = langOf(active ?? '')[0] === 'py';
  const opens = /[{[(]\s*$/.test(before) || (isPy && /:\s*$/.test(before)) || (endsWithOpenTag(before) && v.slice(en).startsWith('</'));
  const extra = opens ? INDENT : '';
  // Between a pair like {|} the closing half moves to its own line.
  if (opens && /^\s*[}\])<]/.test(v.slice(en, lineEnd(v, en)))) replaceRange(ta, s, en, `\n${indent}${extra}\n${indent}`, s + 1 + indent.length + extra.length);
  else replaceRange(ta, s, en, `\n${indent}${extra}`);
}
const plainKey = (e: KeyboardEvent) => !e.ctrlKey && !e.altKey && !e.metaKey;
function editorKeys(e: KeyboardEvent): void {
  const ta = e.target as HTMLTextAreaElement;
  const b = textareaOwner.get(ta);
  const k = e.key.toLowerCase();
  if (suggestKeys(e, ta)) return;
  if (b && e.ctrlKey && e.key === ' ') { e.preventDefault(); editorSuggest(b, true); return; }
  if (b && (e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
    e.preventDefault();
    stepHistory(b, k === 'z' && !e.shiftKey);
  } else if (e.key === 'Tab' && plainKey(e)) {
    e.preventDefault();
    indentKey(ta, e.shiftKey);
  } else if (e.key === 'Enter' && plainKey(e) && !e.shiftKey) {
    e.preventDefault();
    enterKey(ta);
  }
}
// Removes one comment marker pair from a line, keeping its indentation.
function uncommentLine(l: string, open: string, close: string): string {
  const indent = l.length - l.trimStart().length;
  let body = l.slice(indent);
  if (body.startsWith(open)) body = body.slice(open.length).replace(/^ /, '');
  const trimmed = body.trimEnd();
  if (close && trimmed.endsWith(close)) body = trimmed.slice(0, -close.length).replace(/ $/, '');
  return l.slice(0, indent) + body;
}
function toggleComment(): void {
  const b = activeText();
  if (!b) return;
  const c = COMMENT[langOf(b.path)[0]];
  if (!c) { toast('No comment syntax for this file type'); return; }
  const ta = b.ta;
  const [ls, le] = selectedLines(ta);
  const lines = ta.value.slice(ls, le).split('\n');
  const [open, close] = c;
  const [o, cl] = [open.trim(), close.trim()];
  const isCommented = (l: string) => !l.trim() || (l.trimStart().startsWith(o) && (!cl || l.trimEnd().endsWith(cl)));
  const uncomment = lines.every(isCommented) && lines.some(l => l.trim());
  const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length));
  const out = lines.map(l => {
    if (!l.trim()) return l;
    return uncomment ? uncommentLine(l, o, cl) : l.slice(0, minIndent) + open + l.slice(minIndent) + close;
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
  let text = '';
  if (findInput.value) text = findHits.length ? `${findIdx + 1} of ${findHits.length}` : 'No results';
  $('#findCount').textContent = text;
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
  openModal(`<input class="input w-full" id="lineIn" aria-label="Line number" placeholder="Go to line (1 – ${total})" inputmode="numeric">`, m => {
    const input = $<HTMLInputElement>('#lineIn', m);
    input.focus();
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const n = clamp(Number.parseInt(input.value, 10) || 1, 1, total);
      closeModal();
      const off = offsetOf(b.text, n - 1, 0);
      b.ta.focus(); b.ta.setSelectionRange(off, off);
      revealOffset(b, off);
    };
  }, undefined, 'top');
}
// How well a path matches a quick-open query: name prefix > name > path > letters in order.
function fileScore(p: string, q: string): number {
  const name = baseName(p).toLowerCase(), full = p.toLowerCase();
  if (!q) return 1;
  if (name.startsWith(q)) return 4;
  if (name.includes(q)) return 3;
  if (full.includes(q)) return 2;
  let i = 0;
  for (const ch of full) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}
async function quickOpen(): Promise<void> {
  if (!rootInfo) { toast('Open a folder first'); return; }
  let all: string[] = [];
  let sel = 0;
  let shown: string[] = [];
  openModal(`<input class="input w-full" id="qoIn" aria-label="Search files by name" placeholder="Search files by name" spellcheck="false"><div class="qo-list" id="qoList"><div class="side-note">Loading…</div></div>`, m => {
    const input = $<HTMLInputElement>('#qoIn', m);
    input.focus();
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.map(p => [p, fileScore(p, q)] as [string, number]).filter(x => x[1] > 0)
        .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 60).map(x => x[0]);
      sel = clamp(sel, 0, Math.max(0, shown.length - 1));
      const rows = shown.map((p, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${fileIcon(baseName(p))}&nbsp; ${esc(baseName(p))}</span><small>${esc(dirName(p))}</small></div>`);
      $('#qoList', m).innerHTML = rows.join('') || '<div class="side-note">No matching files.</div>';
      $$('[data-i]', m).forEach(el => el.onclick = () => { closeModal(); openFile(shown[Number(el.dataset.i)]); });
    };
    input.oninput = () => { sel = 0; render(); };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel += e.key === 'ArrowDown' ? 1 : -1; render(); $('.qo-item.on', m)?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter' && shown[sel]) { closeModal(); openFile(shown[sel]); }
    };
    api.fs.listFiles().then(list => { all = list; render(); }, (err: unknown) => { $('#qoList', m).innerHTML = `<div class="side-note">${esc(errMsg(err))}</div>`; });
  }, undefined, 'top');
}

/* ================= Search across files ================= */
let searchCase = false;
$('#searchCase').onclick = () => { searchCase = !searchCase; $('#searchCase').classList.toggle('on', searchCase); void runSearch(); };
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') void runSearch(); });
function hitLineHtml(h: SearchHit, i: number, qLen: number): string {
  const start = Math.max(0, h.col - 30);
  const pre = h.text.slice(start, h.col).trimStart(), hit = h.text.slice(h.col, h.col + qLen), post = h.text.slice(h.col + qLen, h.col + qLen + 80);
  return `<div class="result-line" data-p="${escAttr(h.path)}" data-i="${i}">${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`;
}
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
  const more = hits.length >= 500 ? '+' : '';
  const groups = [...byFile].map(([p, hs]) => `<div class="result-file">${fileIcon(baseName(p))} ${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>` + hs.map((h, i) => hitLineHtml(h, i, q.length)).join(''));
  out.innerHTML = `<p class="side-note pt-0">${hits.length}${more} results in ${plural(byFile.size, 'file')}</p>` + groups.join('');
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
  const htmlOpen = active && /\.html?$/i.test(active) ? active : null;
  const target = entry?.name ?? htmlOpen;
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

/* ================= Terminal ================= */
const term = { cwd: '', proc: null as number | null, history: [] as string[], hIdx: 0 };
const termOut = $('#termOut');
const termInput = $<HTMLInputElement>('#termInput');
// Colour codes and lone carriage returns don't render in the panel.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function renderPs(): void { $('#termPs').textContent = `${term.cwd || '~'}>`; }
function termWrite(text: string, cls = ''): void {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text.replaceAll(ANSI, '').replaceAll(/\r(?!\n)/g, '');
  termOut.appendChild(span);
  while (termOut.childNodes.length > 3000) termOut.firstChild?.remove();
  $('#termBody').scrollTop = $('#termBody').scrollHeight;
}
function killCommand(): void {
  if (term.proc == null) return;
  background(api.term.kill(term.proc));
  termWrite('^C\n');
}
async function runCommand(cmd: string): Promise<void> {
  if (term.proc != null) { termWrite(cmd + '\n'); toast('A command is still running — press Ctrl+C to stop it'); return; }
  termWrite(`${term.cwd}> `, 'ps'); termWrite(cmd + '\n', 'cmd');
  if (!cmd.trim()) return;
  term.history.push(cmd); term.hIdx = term.history.length;
  if (/^\s*(?:cls|clear)\s*$/i.test(cmd)) { termOut.innerHTML = ''; return; }
  const r = await api.term.run(cmd).catch((err: unknown) => ({ error: errMsg(err) }) as { id?: number; cwd?: string; error?: string });
  if (r.error) termWrite(r.error + '\n', 'err');
  if (r.cwd) { term.cwd = r.cwd; renderPs(); }
  if (r.id != null) { term.proc = r.id; $('#termPs').classList.add('busy'); }
}
termInput.addEventListener('keydown', e => {
  if (terminalAutofillKeys(e)) return;
  if (e.key === 'c' && e.ctrlKey && term.proc != null && termInput.selectionStart === termInput.selectionEnd) { e.preventDefault(); killCommand(); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    term.hIdx = clamp(term.hIdx + (e.key === 'ArrowUp' ? -1 : 1), 0, term.history.length);
    termInput.value = term.history[term.hIdx] ?? '';
    return;
  }
  if (e.key !== 'Enter') return;
  const cmd = termInput.value;
  termInput.value = '';
  termGhost.innerHTML = '';
  void runCommand(cmd);
});
api.term.onData((id, chunk) => { if (id === term.proc) termWrite(chunk); });
api.term.onExit((id, code) => {
  if (id !== term.proc) return;
  term.proc = null; $('#termPs').classList.remove('busy');
  if (code) termWrite(`exited with code ${code}\n`, 'err');
});
$('#termBody').addEventListener('mouseup', () => { if (!getSelection()?.toString()) termInput.focus(); });
$('#termToggle').addEventListener('click', e => { if (!(e.target as HTMLElement).closest('button')) run('term.toggle'); });

/* ================= Autofill ================= */
// One suggestion list, used by the code editor (words and keywords) and the terminal (files, commands, history).
interface Suggestion { text: string; hint?: string; }
interface SuggestState { owner: HTMLElement; items: Suggestion[]; sel: number; typed: number; accept: (s: Suggestion) => void; }
let suggest: SuggestState | null = null;
const suggestEl = document.createElement('div');
suggestEl.className = 'suggest hidden';
suggestEl.setAttribute('role', 'listbox');
document.body.append(suggestEl);
suggestEl.addEventListener('mousedown', e => e.preventDefault()); // keep focus where the user is typing
suggestEl.addEventListener('click', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-sg]');
  if (row && suggest) suggest.accept(suggest.items[Number(row.dataset.sg)]);
});
function renderSuggest(): void {
  if (!suggest) return;
  const { items, sel, typed } = suggest;
  suggestEl.innerHTML = items.map((s, i) => {
    const hint = s.hint ? `<small>${esc(s.hint)}</small>` : '';
    return `<div class="${i === sel ? 'on' : ''}" data-sg="${i}" role="option"><span><b>${esc(s.text.slice(0, typed))}</b>${esc(s.text.slice(typed))}</span>${hint}</div>`;
  }).join('');
  suggestEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
// Shows suggestions under (x, y), or above `above` when they don't fit below.
function showSuggest(state: SuggestState, x: number, y: number, above: number): void {
  if (!state.items.length) { hideSuggest(); return; }
  suggest = state;
  renderSuggest();
  suggestEl.classList.remove('hidden');
  const h = suggestEl.offsetHeight, w = suggestEl.offsetWidth;
  suggestEl.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  suggestEl.style.top = `${y + h > innerHeight - 8 ? Math.max(8, above - h) : y}px`;
}
function hideSuggest(): void {
  suggest = null;
  suggestEl.classList.add('hidden');
}
// Arrow keys move, Tab or Enter accepts, Escape closes. True when the key was used.
function suggestKeys(e: KeyboardEvent, owner: HTMLElement): boolean {
  if (suggest?.owner !== owner) return false;
  const s = suggest;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') s.sel = (s.sel + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length;
  else if (e.key === 'Tab' || e.key === 'Enter') s.accept(s.items[s.sel]);
  else if (e.key === 'Escape') hideSuggest();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  if (suggest) renderSuggest();
  return true;
}

/* ----- Code editor: words from the file plus the language's keywords ----- */
const CSS_PROPS = 'display position top right bottom left margin padding color background background-color border border-radius box-shadow font font-family font-size font-weight line-height letter-spacing text-align text-decoration width height min-width max-width min-height max-height flex flex-direction flex-wrap align-items justify-content gap grid grid-template-columns grid-template-rows place-items overflow opacity transform transition animation cursor z-index content outline visibility white-space inset aspect-ratio object-fit';
const HTML_TAGS = 'html head body title meta link script style div span section header footer main nav article aside button input label form select option textarea img picture video audio a ul ol li p h1 h2 h3 h4 h5 h6 strong em small code pre table thead tbody tr td th template iframe canvas svg';
const JS_EXTRA = 'console log document window querySelector querySelectorAll addEventListener removeEventListener getElementById createElement appendChild classList textContent innerHTML length forEach filter reduce includes startsWith endsWith JSON stringify parse Promise resolve setTimeout clearTimeout fetch Math Object keys values entries Array Number String Boolean Map Set';
const PY_EXTRA = 'print range len str int float list dict set tuple open enumerate zip isinstance sorted append extend items keys values format join split strip __init__ __name__ __main__';
const EDITOR_WORDS: Record<string, string[]> = {
  js: `${JS_KW} ${JS_EXTRA}`.split(' '),
  py: `${PY_KW} ${PY_EXTRA}`.split(' '),
  css: CSS_PROPS.split(' '),
  html: HTML_TAGS.split(' '),
  json: ['true', 'false', 'null'],
};
// Word counts per open file, refreshed at most every second and a half while typing.
const wordCache = new WeakMap<Buffer, { at: number; counts: Map<string, number> }>();
function fileWords(b: Buffer): Map<string, number> {
  const cached = wordCache.get(b);
  if (cached && Date.now() - cached.at < 1500) return cached.counts;
  const counts = new Map<string, number>();
  for (const m of b.text.slice(0, LINT_MAX).matchAll(/[A-Za-z_$][\w$-]{2,}/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  wordCache.set(b, { at: Date.now(), counts });
  return counts;
}
function editorCandidates(b: Buffer, prefix: string): Suggestion[] {
  const counts = fileWords(b);
  const lower = prefix.toLowerCase();
  const words = new Map<string, number>();
  for (const w of EDITOR_WORDS[langOf(b.path)[0]] ?? []) words.set(w, 1000);
  for (const [w, n] of counts) words.set(w, (words.get(w) ?? 0) + n);
  // The word being typed counts once in the file; it isn't a suggestion by itself.
  return [...words]
    .filter(([w, n]) => w.toLowerCase().startsWith(lower) && w !== prefix && !(n === 1 && counts.get(w) === 1 && w.startsWith(prefix)))
    .sort((a, b2) => Number(b2[0].startsWith(prefix)) - Number(a[0].startsWith(prefix)) || b2[1] - a[1] || a[0].length - b2[0].length)
    .slice(0, 8)
    .map(([w, n]) => ({ text: w, hint: n >= 1000 ? 'keyword' : '' }));
}
// The word (letters, digits, _ $ and -) that ends at the caret.
function wordBefore(ta: HTMLTextAreaElement): string {
  const v = ta.value, end = ta.selectionStart;
  let i = end;
  while (i > 0 && end - i < 60 && /[\w$-]/.test(v[i - 1])) i--;
  while (i < end && !/[A-Za-z_$]/.test(v[i])) i++; // words start with a letter, _ or $
  return v.slice(i, end);
}
function editorSuggest(b: Buffer, force = false): void {
  const ta = b.ta;
  if (!ta || ta.selectionStart !== ta.selectionEnd) { hideSuggest(); return; }
  const prefix = wordBefore(ta);
  if (prefix.length < (force ? 0 : 2)) { hideSuggest(); return; }
  const pos = ta.selectionStart, ls = lineStart(b.text, pos);
  const cw = measureChar();
  const r = ta.getBoundingClientRect();
  const x = r.left + 4 + visualCol(b.text.slice(ls, pos), pos - ls - prefix.length) * cw - ta.scrollLeft;
  const top = r.top + 10 + lineAt(b.text, pos) * LINE_H - ta.scrollTop;
  showSuggest({
    owner: ta, items: editorCandidates(b, prefix), sel: 0, typed: prefix.length,
    accept: s => { hideSuggest(); replaceRange(ta, pos - prefix.length, ta.selectionStart, s.text); },
  }, x - 8, top + LINE_H + 2, top - 2);
}

/* ----- Terminal: files and folders, commands, and your history ----- */
const COMMANDS = ['git', 'npm', 'npx', 'node', 'cd', 'dir', 'ls', 'cls', 'clear', 'mkdir', 'python', 'pip', 'echo', 'type', 'cat', 'code'];
const SUBCOMMANDS: Record<string, string[]> = {
  git: ['status', 'add', 'commit', 'push', 'pull', 'fetch', 'switch', 'checkout', 'branch', 'log', 'diff', 'init', 'clone', 'merge', 'stash', 'restore'],
  npm: ['install', 'run', 'start', 'test', 'init', 'uninstall', 'update'],
};
const termGhost = $('#termGhost');
// Greyed-out rest of the last matching command from history; → accepts it.
function historyMatch(value: string): string {
  if (!value) return '';
  return [...term.history].reverse().find(h => h.startsWith(value) && h !== value) ?? '';
}
function updateGhost(): void {
  const v = termInput.value, match = historyMatch(v);
  termGhost.innerHTML = match ? `<span class="typed">${esc(v)}</span>${esc(match.slice(v.length))}` : '';
}
// Width of text in an input's own font.
const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text: string, el: HTMLElement): number {
  if (!measureCtx) return text.length * 7;
  measureCtx.font = getComputedStyle(el).font;
  return measureCtx.measureText(text).width;
}
function commonPrefix(words: string[]): string {
  let shared = words[0] ?? '';
  for (const w of words) {
    let i = 0;
    while (i < shared.length && shared[i].toLowerCase() === w[i]?.toLowerCase()) i++;
    shared = shared.slice(0, i);
  }
  return shared;
}
async function terminalCandidates(line: string): Promise<{ token: string; items: Suggestion[] }> {
  const words = line.split(' ');
  const token = words.at(-1) ?? '';
  if (words.length === 1) {
    const known = [...new Set([...term.history.map(h => h.split(' ')[0]), ...COMMANDS])];
    const commands = known.filter(c => c.startsWith(token) && c !== token).map(c => ({ text: c, hint: 'command' }));
    const files = token ? await api.term.complete(token).catch(() => []) : [];
    return { token, items: [...commands, ...files.map(f => ({ text: f.text, hint: f.dir ? 'folder' : 'file' }))].slice(0, 40) };
  }
  const subs = words.length === 2 ? (SUBCOMMANDS[words[0]] ?? []).filter(c => c.startsWith(token) && c !== token).map(c => ({ text: c, hint: words[0] })) : [];
  const files = await api.term.complete(token).catch(() => []);
  return { token, items: [...subs, ...files.map(f => ({ text: f.text, hint: f.dir ? 'folder' : 'file' }))].slice(0, 40) };
}
// Tab completes the last word: one match fills in, several fill the shared start and list the rest.
async function completeTerminal(): Promise<void> {
  const line = termInput.value;
  const { token, items } = await terminalCandidates(line);
  if (termInput.value !== line || !items.length) return;
  const base = line.slice(0, line.length - token.length);
  const put = (text: string) => { termInput.value = base + text; updateGhost(); };
  if (items.length === 1) { put(items[0].text); hideSuggest(); return; }
  const shared = commonPrefix(items.map(i => i.text));
  if (shared.length > token.length) put(shared);
  const r = termInput.getBoundingClientRect();
  const x = r.left + textWidth(base, termInput);
  showSuggest({ owner: termInput, items, sel: 0, typed: termInput.value.length - base.length, accept: s => { put(s.text); hideSuggest(); termInput.focus(); } }, x, r.bottom + 4, r.top - 4);
}
// Keys the terminal's autofill handles before the normal ones; true when handled.
function terminalAutofillKeys(e: KeyboardEvent): boolean {
  if (suggestKeys(e, termInput)) return true;
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); void completeTerminal(); return true; }
  const atEnd = termInput.selectionStart === termInput.value.length;
  const match = historyMatch(termInput.value);
  if (e.key === 'ArrowRight' && atEnd && match) { e.preventDefault(); termInput.value = match; updateGhost(); return true; }
  return false;
}
termInput.addEventListener('input', () => { updateGhost(); if (suggest?.owner === termInput) hideSuggest(); });
termInput.addEventListener('blur', () => { termGhost.innerHTML = ''; hideSuggest(); });
termInput.addEventListener('focus', updateGhost);

/* ================= Layout: resizable, collapsible panels ================= */
interface Layout { side: number; agents: number; term: number; preview: number; sideOpen: boolean; agentsOpen: boolean; termOpen: boolean; previewOpen: boolean; view: string; }
type SashKind = 'side' | 'agents' | 'preview' | 'term';
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
// Dragging below a threshold collapses the panel; dragging back out reopens it.
const SASH_DRAG: Record<SashKind, (start: Layout, dx: number, dy: number) => void> = {
  side: (start, dx) => { const w = start.side + dx; layout.sideOpen = w >= 120; if (layout.sideOpen) layout.side = clamp(w, 170, 640); },
  agents: (start, dx) => { const w = start.agents - dx; layout.agentsOpen = w >= 180; if (layout.agentsOpen) layout.agents = clamp(w, 260, 720); },
  preview: (start, dx) => { const w = start.preview - dx; layout.previewOpen = w >= 140; if (layout.previewOpen) layout.preview = clamp(w, 220, $('#work').clientWidth - 220); },
  term: (start, _dx, dy) => { const h = start.term - dy; layout.termOpen = h >= 60; if (layout.termOpen) layout.term = clamp(h, 80, innerHeight - 220); },
};
function startSashDrag(sash: HTMLElement, kind: SashKind, e: PointerEvent): void {
  const sx = e.clientX, sy = e.clientY, start = { ...layout };
  if (kind === 'preview') start.preview = $('#previewPane').getBoundingClientRect().width;
  document.body.classList.add(kind === 'term' ? 'resizing-h' : 'resizing');
  sash.classList.add('active');
  const move = (ev: PointerEvent) => { SASH_DRAG[kind](start, ev.clientX - sx, ev.clientY - sy); applyLayout(); };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    document.body.classList.remove('resizing', 'resizing-h'); sash.classList.remove('active');
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}
$$<HTMLElement>('[data-sash]').forEach(sash => {
  const kind = sash.dataset.sash as SashKind;
  sash.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    startSashDrag(sash, kind, e);
  });
  sash.addEventListener('dblclick', () => { layout[kind] = DEFAULT_LAYOUT[kind]; applyLayout(); });
});
$('#tglSide').onclick = () => run('view.toggleSide');
$('#tglTerm').onclick = () => run('term.toggle');
$('#tglAgents').onclick = () => run('view.toggleAgents');

/* ================= Commands, menu bar & shortcuts ================= */
interface MenuItem {
  label?: string; act?: string; run?: () => void; key?: string; sep?: boolean; checked?: () => boolean; enabled?: () => boolean; native?: boolean;
  header?: User;              // a "who is signed in" row
  sub?: () => MenuItem[];     // opens a submenu on hover
}
const hasFile = () => !!activeText();
function searchSelection(): void {
  showView('search', true);
  const i = $<HTMLInputElement>('#searchInput');
  const b = activeText();
  const s = b ? b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd) : '';
  if (s && !s.includes('\n')) i.value = s;
  i.focus(); i.select();
}
function backToOnboarding(n: number): void {
  appState.onboarded = false; saveApp();
  $('#ide').classList.add('hidden'); $('#box').classList.add('hidden'); $('#onboard').classList.remove('hidden');
  goStep(n);
}
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
  'view.search': searchSelection,
  'view.git': () => showView('git', true),
  'view.toggleSide': () => { layout.sideOpen = !layout.sideOpen; applyLayout(); },
  'view.toggleAgents': () => { layout.agentsOpen = !layout.agentsOpen; applyLayout(); },
  'view.togglePreview': () => { layout.previewOpen = !layout.previewOpen; applyLayout(); },
  'view.resetLayout': () => { Object.assign(layout, DEFAULT_LAYOUT, { view: layout.view }); applyLayout(); },
  'win.reload': () => { flushSession(); return api.win.reload(); },
  'win.devtools': () => api.win.toggleDevTools(),
  'go.file': quickOpen,
  'go.line': goToLine,
  'go.nextProblem': nextProblem,
  'go.nextEditor': () => cycleTab(1),
  'go.prevEditor': () => cycleTab(-1),
  'run.start': () => (running ? reloadPreview() : startPreview()),
  'run.reload': reloadPreview,
  'run.stop': () => { stopPreview(); toast('Preview stopped'); },
  'term.toggle': () => { layout.termOpen = !layout.termOpen; applyLayout(); if (layout.termOpen) termInput.focus(); },
  'term.focus': () => { layout.termOpen = true; applyLayout(); termInput.focus(); },
  'term.clear': () => { termOut.innerHTML = ''; },
  'term.kill': () => { if (term.proc == null) toast('Nothing is running'); else killCommand(); },
  'explorer.refresh': refreshTree,
  'explorer.collapse': () => { expanded.clear(); renderTree(); saveSession(); },
  'help.welcome': () => setActive(null),
  'help.keys': showShortcuts,
  'help.setup': () => backToOnboarding(STEP.agent),
  'account.signIn': addAccount,
  'account.signOut': signOut,
  'mode.ide': () => enterMode('ide'),
  'mode.box': () => enterMode('box'),
  'help.about': showAbout,
};
function showAbout(): void {
  const where = isDesktop ? 'Desktop app' : 'Browser preview';
  const engine = /Electron\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
  openModal(`<h3>Breeze IDE</h3><p class="sub">Smooth as a breeze.</p><p class="sub fs-12">${where} · ${esc(engine)}</p><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
}
function run(act: string): void {
  const fn = commands[act];
  if (fn) Promise.resolve(fn()).catch((e: unknown) => toast(errMsg(e)));
}
// Undo and redo in the code editor use its own history; everything else goes to the focused field.
function editRole(role: string): void {
  const b = activeText();
  if (b && (role === 'undo' || role === 'redo')) { stepHistory(b, role === 'undo'); b.ta.focus(); return; }
  b?.ta.focus();
  background(api.win.edit(role));
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
  const rows = recent.map(r => `<div class="qo-item" data-r="${escAttr(r.path)}"><span>${esc(r.name)}</span><small>${esc(r.path)}</small></div>`);
  openModal(`<h3>Open recent</h3><div class="qo-list">${rows.join('')}</div>`,
    m => $$('[data-r]', m).forEach(el => el.onclick = () => { closeModal(); void openRecentFolder(el.dataset.r as string); }), undefined, 'top');
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
    const finish = settleOnce(res);
    openModal(`<h3>Save changes to ${plural(dirty.length, 'file')}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dDiscard">Don't Save</button><button class="btn btn-primary" id="dSave">Save All</button></div>`, m => {
      $('#dDiscard', m).onclick = () => {
        for (const b of dirty) { b.text = b.saved; if (b.ta) b.ta.value = b.saved; }
        finish(true); closeModal();
      };
      $('#dSave', m).onclick = () => background(saveAll().then(() => { finish(true); closeModal(); }));
    }, () => finish(false));
  });
}

interface Menu { name: string; items: MenuItem[]; }
const MENUS: Menu[] = [
  { name: 'File', items: [
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
  ] },
  { name: 'Edit', items: [
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
  ] },
  { name: 'Selection', items: [
    { label: 'Select All', act: 'edit.selectAll', key: 'Ctrl+A', native: true },
    { label: 'Select Line', act: 'sel.line', key: 'Ctrl+L', enabled: hasFile },
    { sep: true },
    { label: 'Copy Line Down', act: 'sel.dup', key: 'Shift+Alt+Down', enabled: hasFile },
    { label: 'Move Line Up', act: 'sel.up', key: 'Alt+Up', enabled: hasFile },
    { label: 'Move Line Down', act: 'sel.down', key: 'Alt+Down', enabled: hasFile },
  ] },
  { name: 'View', items: [
    { label: 'Explorer', act: 'view.files', key: 'Ctrl+Shift+E' },
    { label: 'Search', act: 'view.search', key: 'Ctrl+Shift+F' },
    { label: 'Checkpoints', act: 'view.git', key: 'Ctrl+Shift+G' },
    { sep: true },
    { label: 'Primary Side Bar', act: 'view.toggleSide', key: 'Ctrl+B', checked: () => layout.sideOpen },
    { label: 'Agents Panel', act: 'view.toggleAgents', key: 'Ctrl+Alt+B', checked: () => layout.agentsOpen },
    { label: 'Terminal', act: 'term.toggle', key: 'Ctrl+`', checked: () => layout.termOpen },
    { label: 'Preview', act: 'view.togglePreview', checked: () => layout.previewOpen },
    { label: 'Reset Layout', act: 'view.resetLayout' },
    { sep: true },
    { label: 'Reload Window', act: 'win.reload', key: 'Ctrl+R' },
    { label: 'Toggle Developer Tools', act: 'win.devtools', key: 'Ctrl+Shift+I' },
  ] },
  { name: 'Go', items: [
    { label: 'Go to File…', act: 'go.file', key: 'Ctrl+P' },
    { label: 'Go to Line…', act: 'go.line', key: 'Ctrl+G', enabled: hasFile },
    { label: 'Next Problem', act: 'go.nextProblem', key: 'F8', enabled: hasFile },
    { sep: true },
    { label: 'Next Editor', act: 'go.nextEditor', key: 'Ctrl+Tab' },
    { label: 'Previous Editor', act: 'go.prevEditor', key: 'Ctrl+Shift+Tab' },
  ] },
  { name: 'Run', items: [
    { label: 'Start Preview', act: 'run.start', key: 'F5' },
    { label: 'Reload Preview', act: 'run.reload', key: 'Ctrl+F5', enabled: () => running },
    { label: 'Stop Preview', act: 'run.stop', key: 'Shift+F5', enabled: () => running },
  ] },
  { name: 'Terminal', items: [
    { label: 'Focus Terminal', act: 'term.focus', key: 'Ctrl+Shift+`' },
    { label: 'Toggle Terminal', act: 'term.toggle', key: 'Ctrl+`' },
    { sep: true },
    { label: 'Clear Terminal', act: 'term.clear' },
    { label: 'Stop Running Command', act: 'term.kill', enabled: () => term.proc != null },
  ] },
  { name: 'Help', items: [
    { label: 'Welcome', act: 'help.welcome' },
    { label: 'Keyboard Shortcuts', act: 'help.keys' },
    { label: 'Run Setup Again', act: 'help.setup' },
    { label: 'Vibe Mode Feeds…', act: 'vibe.feeds' },
    { sep: true },
    { label: 'IDE', act: 'mode.ide', checked: () => appState.mode === 'ide' },
    { label: 'Breeze Box (chat only)', act: 'mode.box', checked: () => appState.mode === 'box' },
    { sep: true },
    { label: 'Add Account…', act: 'account.signIn' },
    { label: 'Sign Out', act: 'account.signOut', enabled: () => !!user },
    { sep: true },
    { label: 'About Breeze IDE', act: 'help.about' },
  ] },
];
// Go, Run and Help stay out of the menu bar; their shortcuts still work and Help lives under the gear button.
const BAR_MENUS = MENUS.filter(m => !['Go', 'Run', 'Help'].includes(m.name));
// Shortcuts handled by the editor itself or by keydown elsewhere, but listed for discoverability.
const EXTRA_KEYS: [string, string][] = [['F2', 'explorer.rename']];
commands['explorer.rename'] = () => { if (active) return renameEntry(active); };

const canonKey = (combo: string): string => {
  const parts = combo.split('+');
  const key = parts.pop() as string;
  const mods = new Set(parts);
  return ['Ctrl', 'Shift', 'Alt'].filter(m => mods.has(m)).concat(key.length === 1 ? key.toUpperCase() : key).join('+');
};
const keymap = new Map<string, string>();
for (const { items } of MENUS) for (const it of items) if (it.key && it.act && !it.native) keymap.set(canonKey(it.key), it.act);
for (const [k, act] of EXTRA_KEYS) keymap.set(canonKey(k), act);
const KEY_BY_CODE: Record<string, string> = { Backquote: '`', Slash: '/' };
function keyName(e: KeyboardEvent): string {
  if (KEY_BY_CODE[e.code]) return KEY_BY_CODE[e.code];
  if (e.key.startsWith('Arrow')) return e.key.slice(5);
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}
function comboOf(e: KeyboardEvent): string {
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', keyName(e)].filter(Boolean).join('+');
}
// Commands that only make sense while typing in the code editor.
const EDITOR_ONLY = new Set(['edit.comment', 'sel.line', 'sel.dup', 'sel.up', 'sel.down']);

/* ----- Menus: the bar opens on hover; the gear and right-clicks pop up ----- */
let openMenuIdx = -1;      // bar menu index, -2 for a popup, -1 when closed
let menuPinned = false;    // opened by a click or the keyboard: stays open when the pointer leaves
let menuCloseTimer: number | undefined;
let kbIdx = -1;
let menuItems: MenuItem[] = [];
let menuOnClose: (() => void) | null = null;
function cancelMenuClose(): void { clearTimeout(menuCloseTimer); }
// A menu opened by hovering closes shortly after the pointer leaves both the bar and the menu.
function scheduleMenuClose(): void {
  cancelMenuClose();
  menuCloseTimer = setTimeout(() => { if (openMenuIdx >= 0 && !menuPinned) closeMenu(); }, 350);
}
function buildMenubar(): void {
  $('#menubar').innerHTML = BAR_MENUS.map((m, i) => `<button class="menu-top" data-menu="${i}" aria-haspopup="menu">${esc(m.name)}</button>`).join('');
  $$('[data-menu]').forEach(b => {
    const i = Number(b.dataset.menu);
    b.onmouseenter = () => {
      cancelMenuClose();
      if (openMenuIdx !== i) openMenu(i, false, menuPinned && openMenuIdx >= 0);
    };
    b.onmouseleave = scheduleMenuClose;
    b.onmousedown = e => {
      e.preventDefault();
      // A click pins a hover-opened menu; clicking a pinned menu closes it.
      if (openMenuIdx === i && menuPinned) closeMenu();
      else openMenu(i, false, true);
    };
  });
}
function openMenu(i: number, viaKeyboard = false, pinned = viaKeyboard): void {
  const btn = $(`[data-menu="${i}"]`);
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, BAR_MENUS[i].items, viaKeyboard);
  openMenuIdx = i;
  menuPinned = pinned;
  $$('[data-menu]').forEach(b => b.classList.toggle('open', b === btn));
  const m = $('#menuRoot .menu');
  m.onmouseenter = cancelMenuClose;
  m.onmouseleave = scheduleMenuClose;
}
function popupMenu(x: number, y: number, items: MenuItem[], onClose?: () => void): void {
  showMenu(x, y, items, false);
  openMenuIdx = -2;
  menuPinned = true;
  menuOnClose = onClose ?? null;
}
// A non-clickable row showing who is signed in.
function menuHeaderHtml(u: User): string {
  const detail = [u.email ?? u.login, u.provider].filter(Boolean).join(' · ');
  return `<div class="menu-label">${avatarHtml(u, '')}<span class="who"><b>${esc(u.name)}</b><small>${esc(detail)}</small></span></div>`;
}
function menuItemHtml(it: MenuItem, i: number): string {
  if (it.sep) return '<div class="menu-sep"></div>';
  if (it.header) return menuHeaderHtml(it.header);
  const cls = ['menu-item', it.checked?.() ? 'checked' : '', it.sub ? 'has-sub' : '', i === kbIdx ? 'kb' : ''].filter(Boolean).join(' ');
  const disabled = it.enabled && !it.enabled() ? ' disabled' : '';
  const key = it.key ? `<span class="key">${esc(it.key)}</span>` : '';
  const popup = it.sub ? ' aria-haspopup="menu"' : '';
  return `<button class="${cls}" role="menuitem" data-mi="${i}"${disabled}${popup}><span>${esc(it.label ?? '')}</span>${key}</button>`;
}
// Builds a menu element at (x, y), kept inside the window.
function renderMenu(x: number, y: number, items: MenuItem[], cls = 'menu'): HTMLElement {
  const m = document.createElement('div');
  m.className = cls;
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map(menuItemHtml).join('');
  $('#menuRoot').append(m);
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8))}px`;
  $$('[data-mi]', m).forEach(b => {
    const it = items[Number(b.dataset.mi)];
    b.onmousedown = e => e.preventDefault(); // keep focus (and the selection) in the editor
    b.onclick = () => (it.sub ? openSubmenu(b, it) : activateMenuItem(it));
    if (cls === 'menu') b.onmouseenter = () => (it.sub ? openSubmenu(b, it) : closeSubmenu());
  });
  return m;
}
// Hovering an item with "›" opens its submenu beside it.
function openSubmenu(btn: HTMLElement, it: MenuItem): void {
  if (btn.classList.contains('sub-open')) return;
  closeSubmenu();
  btn.classList.add('sub-open');
  const r = btn.getBoundingClientRect();
  const sub = renderMenu(r.right + 4, r.top - 5, it.sub?.() ?? [], 'menu sub');
  if (sub.getBoundingClientRect().left < r.right) sub.style.left = `${Math.max(8, r.left - sub.offsetWidth - 4)}px`; // no room on the right
}
function closeSubmenu(): void {
  $$('#menuRoot .menu.sub').forEach(s => s.remove());
  $$('#menuRoot .sub-open').forEach(b => b.classList.remove('sub-open'));
}
function showMenu(x: number, y: number, items: MenuItem[], viaKeyboard: boolean): void {
  cancelMenuClose();
  menuItems = items;
  kbIdx = viaKeyboard ? items.findIndex(it => !it.sep && !it.header) : -1;
  $('#menuRoot').innerHTML = '';
  renderMenu(x, y, items);
}
function activateMenuItem(it: MenuItem): void {
  if (it.enabled && !it.enabled()) return;
  closeMenu();
  if (it.run) it.run(); else if (it.act) run(it.act);
}
function closeMenu(): void {
  cancelMenuClose();
  if (openMenuIdx === -1) return;
  openMenuIdx = -1; kbIdx = -1; menuPinned = false;
  $('#menuRoot').innerHTML = '';
  $$('[data-menu]').forEach(b => b.classList.remove('open'));
  const cb = menuOnClose; menuOnClose = null; cb?.();
}
document.addEventListener('mousedown', e => {
  if (openMenuIdx !== -1 && !(e.target as HTMLElement).closest('.menu, .menubar, #settingsBtn, #boxSettings, .avatars')) closeMenu();
});
window.addEventListener('blur', closeMenu);
function moveKbSelection(down: boolean): void {
  const usable = menuItems.map((it, i) => (!it.sep && !it.header && (!it.enabled || it.enabled()) ? i : -1)).filter(i => i !== -1);
  const pos = usable.indexOf(kbIdx);
  kbIdx = usable[(pos + (down ? 1 : -1) + usable.length) % usable.length] ?? -1;
  $$('[data-mi]').forEach(b => b.classList.toggle('kb', Number(b.dataset.mi) === kbIdx));
}
function menuKeys(e: KeyboardEvent): boolean {
  if (openMenuIdx === -1) return false;
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') moveKbSelection(e.key === 'ArrowDown');
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && openMenuIdx >= 0) {
    openMenu((openMenuIdx + (e.key === 'ArrowRight' ? 1 : -1) + BAR_MENUS.length) % BAR_MENUS.length, true);
  } else if (e.key === 'Enter' && kbIdx >= 0) activateMenuItem(menuItems[kbIdx]);
  else return false;
  e.preventDefault();
  return true;
}

const focused = () => document.activeElement as HTMLElement | null;
document.addEventListener('keydown', e => {
  if (menuKeys(e)) return;
  if (e.key === 'Escape') {
    if (vibeOn) { exitVibe(); return; }
    if (modalOpen()) { closeModal(); return; }
    if (findOpen) { closeFind(); activeText()?.ta.focus(); return; }
  }
  if (modalOpen() || vibeOn || $('#ide').classList.contains('hidden')) return;
  const act = keymap.get(comboOf(e));
  if (!act) return;
  if (EDITOR_ONLY.has(act) && !focused()?.classList.contains('ta')) return;
  if (act === 'explorer.rename' && focused()?.matches('input, textarea')) return;
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

// The gear turns while its menu is open and turns back when it closes (in the IDE and in Breeze Box).
function settingsMenu(gear: HTMLElement, place: (r: DOMRect) => [number, number]): void {
  if (gear.classList.contains('open')) { closeMenu(); return; }
  closeMenu();
  const [x, y] = place(gear.getBoundingClientRect());
  gear.classList.add('open');
  gear.setAttribute('aria-expanded', 'true');
  popupMenu(x, y, MENUS.find(m => m.name === 'Help')?.items ?? [], () => {
    gear.classList.remove('open');
    gear.setAttribute('aria-expanded', 'false');
  });
}
$('#settingsBtn').onclick = e => settingsMenu(e.currentTarget as HTMLElement, r => [r.right + 6, r.top]);
$('#boxSettings').onclick = e => settingsMenu(e.currentTarget as HTMLElement, r => [r.right - 260, r.bottom + 6]);

function showShortcuts(): void {
  const rows: string[] = [];
  for (const { name, items } of MENUS) for (const it of items) if (it.key) rows.push(`<span>${esc(name)} › ${esc(it.label ?? '')}</span><kbd>${it.key}</kbd>`);
  rows.push('<span>Editor › Indent / outdent</span><kbd>Tab / Shift+Tab</kbd>', '<span>Explorer › Rename file</span><kbd>F2</kbd>', '<span>Menu bar</span><kbd>Alt</kbd>', '<span>Tabs › Reorder</span><kbd>Drag a tab</kbd>');
  openModal(`<h3>Keyboard shortcuts</h3><p class="sub">Drag any panel edge to resize it; drag it closed to hide it.</p><div class="kbd-table">${rows.join('')}</div><div class="row end"><button class="btn btn-primary" data-close>Close</button></div>`);
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
      <div class="ava tint-${a.tint}">${a.letter}</div>
      <div><span class="name">${a.name}</span> <span class="fs-11 text-3">${esc(a.model)}</span></div>
      <div class="row gap-4"><span class="status ${a.status}">${statusLabel[a.status]}</span>
        ${a.status === 'working' ? '<button class="icon-btn" title="Stop" data-act="agent.stop">■</button>' : ''}</div>
      <div class="task">${esc(a.task)}</div>
      <div class="meter" title="${a.used} tool calls"><i class="tint-${a.tint}" data-used="${a.used}"></i></div>
    </div>`).join('');
  // The meter's fill is set through the DOM: the CSP allows no inline style attributes.
  for (const i of $$('[data-used]', $('#agentCards'))) i.style.width = `${Math.min(100, Number(i.dataset.used) * 4)}%`;
}
function setAgent(k: AgentKey, status: AgentStatus, task: string, used?: number): void {
  Object.assign(agentsDef[k], { status, task });
  if (used != null) agentsDef[k].used = used;
  renderAgents(); vibeTick();
}

/* ----- Chat surfaces: the IDE's agent panel and Breeze Box share one conversation engine ----- */
interface Surface { name: WorkMode; chat: HTMLElement; prompt: HTMLTextAreaElement; send: HTMLElement; mode: HTMLSelectElement; }
const SURFACES: Record<WorkMode, Surface> = {
  ide: { name: 'ide', chat: $('#chat'), prompt: $<HTMLTextAreaElement>('#prompt'), send: $('#send'), mode: $<HTMLSelectElement>('#agentMode') },
  box: { name: 'box', chat: $('#boxChat'), prompt: $<HTMLTextAreaElement>('#boxPrompt'), send: $('#boxSend'), mode: $<HTMLSelectElement>('#boxMode') },
};
let surface = SURFACES.ide;     // the one on screen
let msgSurface = surface;       // the one messages go to: a running agent keeps writing where it started
function useSurface(name: WorkMode): void {
  surface = SURFACES[name];
  if (!agentRun) msgSurface = surface;
}
function addMsg(html: string): HTMLElement {
  const chat = msgSurface.chat;
  const d = document.createElement('div'); d.innerHTML = html;
  const el = d.firstElementChild as HTMLElement;
  chat.appendChild(el);
  const scroller = msgSurface.name === 'box' ? $('.box-main') : chat;
  scroller.scrollTop = scroller.scrollHeight;
  saveChat();
  return el;
}
const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// In the IDE replies come from the Planner or Builder; in Breeze Box from the agent itself (Claude Code, Codex…).
function agentMsg(k: AgentKey, html: string): HTMLElement {
  let { name, letter, tint } = agentsDef[k];
  const chosen = selectedAgent();
  if (msgSurface.name === 'box' && chosen) {
    const st = AGENT_STYLE[chosen.id] ?? { letter: chosen.name[0], tint: 'default' };
    ({ name } = chosen);
    ({ letter, tint } = st);
  }
  return addMsg(`<div class="msg"><div class="meta"><span class="avatar mini tint-${tint}">${letter}</span><b>${esc(name)}</b> ${clockTime()}</div><div class="body">${html}</div></div>`);
}
function userMsg(text: string): void {
  addMsg(`<div class="msg user"><div class="meta"><b>${esc(user?.name ?? 'You')}</b> ${clockTime()}</div><div class="body">${esc(text)}</div></div>`);
}
function emptyChat(s: Surface = SURFACES.ide): void {
  if (s.name === 'box') {
    const agent = selectedAgent();
    const who = agent ? `Breeze Box talks to ${esc(agent.name)}. Pick another agent below.` : 'Pick an agent below to start.';
    s.chat.innerHTML = `<div class="empty"><div><img src="Agent.png" alt="" width="56" height="56"><h4>What can I help with?</h4><div>${who}</div></div></div>`;
    return;
  }
  s.chat.innerHTML = `<div class="empty"><div><img src="Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div>Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
}
// A small, safe subset of Markdown for agent replies: code blocks, inline code, bold and line breaks.
function md(text: string): string {
  return text.split(/```[\w-]*\n?/).map((part, i) => (i % 2
    ? `<pre>${esc(part.replace(/\n$/, ''))}</pre>`
    : esc(part).replaceAll(/`([^`\n]+)`/g, '<code>$1</code>').replaceAll(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replaceAll('\n', '<br>'))).join('');
}
const TOOL_ICON: Record<string, string> = { read: '◔', edit: '✎', run: '❯', search: '⌕', web: '◍', todo: '☑', agent: '◇', tool: '•', note: 'ℹ' };
function toolLine(kind: string, label: string): void {
  addMsg(`<div class="tool-line ${kind}"><span class="ti">${TOOL_ICON[kind] ?? '•'}</span><span class="tl">${esc(label)}</span></div>`);
}

// Chat history is kept per project folder (and once for Breeze Box) so a reload brings it back.
const chatKey = (s: Surface = msgSurface) => (s.name === 'box' ? 'breeze.chat:box' : `breeze.chat:${rootInfo?.root ?? ''}`);
const agentSessionKey = (s: Surface = msgSurface) => `breeze.agentSession:${s.name === 'box' ? 'box' : rootInfo?.root ?? ''}:${appState.agent ?? ''}`;
let chatTimer: number | undefined;
function saveChat(): void {
  clearTimeout(chatTimer);
  const s = msgSurface;
  chatTimer = setTimeout(() => {
    if (s.name === 'ide' && !rootInfo) return;
    const html = s.chat.querySelector('.empty') ? '' : s.chat.innerHTML;
    if (html && html.length < 400000) store.set(chatKey(s), html); else store.del(chatKey(s));
  }, 400);
}
function restoreChat(s: Surface = SURFACES.ide): void {
  const html = store.get<string>(chatKey(s), '');
  if (!html) { emptyChat(s); return; }
  s.chat.innerHTML = html;
  // Buttons from an earlier run have no handlers any more; show them as settled.
  $$('[data-live]', s.chat).forEach(el => { el.outerHTML = '<div class="resolved">Earlier session</div>'; });
  s.chat.scrollTop = s.chat.scrollHeight;
}

interface Run { id: number; agent: string; mode: AgentMode; uiMode: string; phase: AgentKey; tools: number; files: Set<string>; plan: string | null; lastText: string; lastMsg?: HTMLElement; }
let agentRun: Run | null = null;
let lastRunFiles: string[] = [];
for (const s of Object.values(SURFACES)) {
  s.send.onclick = () => (agentRun ? stopAgent() : void sendPrompt());
  s.prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendPrompt(); } });
}
function newChat(): void {
  if (agentRun) stopAgent();
  store.del(agentSessionKey(surface)); store.del(chatKey(surface));
  emptyChat(surface);
  setAgent('planner', 'idle', 'Waiting for a prompt', 0);
  setAgent('builder', 'idle', 'Waiting for a plan', 0);
  surface.prompt.focus();
}
$('#newChat').onclick = newChat;
commands['chat.new'] = newChat;
commands['agent.stop'] = () => stopAgent();

function setBusy(on: boolean): void {
  for (const { send } of Object.values(SURFACES)) {
    send.classList.toggle('stop', on);
    send.textContent = on ? '■ Stop' : 'Send ↵';
    send.title = on ? 'Stop the agent' : 'Send (Enter)';
  }
}
function stopAgent(): void {
  if (agentRun) background(api.agent.stop(agentRun.id));
}
const MODES: Record<string, AgentMode> = { build: 'build', ask: 'ask', plan: 'plan' };
async function sendPrompt(): Promise<void> {
  const text = surface.prompt.value.trim();
  if (!text || agentRun) return;
  const agent = selectedAgent();
  if (!agent) { openAgentPicker(); return; }
  if (surface.name === 'ide' && !rootInfo) { toast('Open a folder first, so the agent knows what to work on'); return; }
  msgSurface = surface;
  const uiMode = surface.mode.value;
  surface.prompt.value = '';
  if (surface.chat.querySelector('.empty')) surface.chat.innerHTML = '';
  userMsg(text);
  await startAgentRun(agent.id, MODES[uiMode] ?? 'plan', text, uiMode);
}

async function startAgentRun(agentId: string, mode: AgentMode, prompt: string, uiMode: string): Promise<void> {
  const phase: AgentKey = mode === 'build' ? 'builder' : 'planner';
  setAgent(phase, 'working', mode === 'build' ? 'Working on your request' : 'Reading the project', 0);
  if (phase === 'planner') setAgent('builder', 'idle', 'Waiting for a plan', 0);
  setBusy(true);
  try {
    const box = msgSurface.name === 'box';
    const id = await api.agent.run({ agent: agentId, mode, prompt, session: store.get<string | null>(agentSessionKey(), null), box });
    agentRun = { id, agent: agentId, mode, uiMode, phase, tools: 0, files: new Set(), plan: null, lastText: '' };
  } catch (e) {
    setBusy(false);
    setAgent(phase, 'idle', 'Could not start', 0);
    errorCard(errMsg(e));
  }
}

function errorCard(text: string, hint?: string, action?: string): void {
  const hintHtml = hint ? `<p>${esc(hint)}</p>` : '';
  const actionHtml = action === 'openApp' ? '<div class="row" data-live><button class="btn btn-sm btn-primary" data-openapp>Open project in Antigravity</button></div>' : '';
  const el = addMsg(`<div class="card error"><h5>⚠ The agent hit a problem</h5><pre>${esc(text)}</pre>${hintHtml}${actionHtml}</div>`);
  el.querySelector<HTMLElement>('[data-openapp]')?.addEventListener('click', () => background(api.agent.openApp(agentRun?.agent ?? appState.agent ?? '')));
}

function onAgentFile(r: Run, path: string): void {
  r.files.add(path);
  locks[path] = r.phase;
  renderTree(); renderTabs();
  queueGitRefresh();
}
function onAgentError(r: Run, ev: AgentEvent): void {
  // Some CLIs print the error as a reply too; show it once, in the error card.
  if (r.lastMsg && ev.text?.trim() === r.lastText.trim()) r.lastMsg.remove();
  errorCard(ev.text ?? 'Unknown error', ev.hint, ev.action);
}
const AGENT_EVENTS: Partial<Record<AgentEvent['t'], (r: Run, ev: AgentEvent) => void>> = {
  session: (_r, ev) => { if (ev.id) store.set(agentSessionKey(), ev.id); },
  text: (r, ev) => { if (ev.text) { r.lastText = ev.text; r.lastMsg = agentMsg(r.phase, md(ev.text)); } },
  tool: (r, ev) => { r.tools++; toolLine(ev.kind ?? 'tool', ev.label ?? ''); setAgent(r.phase, 'working', ev.label ?? 'Working', r.tools); },
  file: (r, ev) => { if (ev.path) onAgentFile(r, ev.path); },
  plan: (r, ev) => { r.plan = ev.text ?? ''; },
  note: (_r, ev) => { if (ev.text) toolLine('note', ev.text); },
  error: onAgentError,
  done: finishRun,
};
api.agent.onEvent((runId, ev) => {
  const r = agentRun;
  if (r?.id === runId) AGENT_EVENTS[ev.t]?.(r, ev);
});

function runSummary(r: Run, ev: AgentEvent): string[] {
  const time = ev.ms ? `${Math.max(1, Math.round(ev.ms / 1000))}s` : '';
  const files = r.files.size ? `${plural(r.files.size, 'file')} changed` : '';
  let usage = '';
  if (ev.cost) usage = `$${ev.cost.toFixed(2)}`;
  else if (ev.tokens) usage = `${ev.tokens.toLocaleString()} tokens`;
  return [time, files, usage].filter(Boolean);
}
function showPlan(r: Run): void {
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
      void startAgentRun(r.agent, 'build', 'The plan is approved. Implement it now, then summarize what you changed.', 'build');
    } else {
      setAgent('planner', 'idle', 'Waiting for your changes', r.tools);
      msgSurface.prompt.focus();
      msgSurface.prompt.placeholder = 'What should change in the plan?';
    }
  });
}
function finishRun(r: Run, ev: AgentEvent): void {
  agentRun = null;
  setBusy(false);
  for (const k of Object.keys(locks)) delete locks[k];
  renderTree(); renderTabs();
  lastRunFiles = [...r.files];
  vibeDone(!!ev.ok);
  queueGitRefresh();
  if (ev.stopped) { addMsg('<div class="handoff">Stopped by you</div>'); setAgent(r.phase, 'idle', 'Stopped', r.tools); return; }
  if (!ev.ok) { setAgent(r.phase, 'idle', 'Stopped with an error', r.tools); return; }
  if (r.uiMode === 'plan' && r.mode === 'plan') { showPlan(r); return; }
  const changed = r.files.size ? `Changed ${plural(r.files.size, 'file')}` : 'Answered';
  setAgent(r.phase, 'done', changed, r.tools);
  const bits = runSummary(r, ev);
  const summary = bits.length ? ' · ' + bits.join(' · ') : '';
  const review = r.files.size ? '<button class="btn btn-sm" data-live data-review>Review changes</button>' : '';
  const el = addMsg(`<div class="run-done"><span>✓ Done${summary}</span>${review}</div>`);
  el.querySelector<HTMLElement>('[data-review]')?.addEventListener('click', () => showView('git', true));
  msgSurface.prompt.placeholder = msgSurface.name === 'box' ? 'Ask Breeze anything…' : 'Describe what you want to build…';
  if (r.files.size && running) void reloadPreview();
}

/* ================= Source control (git) ================= */
let gitState: GitStatus = { repo: false };
let gitLog: { head: string | null; commits: GitCommit[] } = { head: null, commits: [] };
let gitBusy = false;
let openCommit: string | null = null;
const commitDetails = new Map<string, GitCommitDetail>();
const scmCollapsed = new Set<string>(store.get<string[]>('breeze.scmCollapsed', []));
let gitTimer: number | undefined;
function queueGitRefresh(): void { clearTimeout(gitTimer); gitTimer = setTimeout(() => void refreshGit(), 400); }
window.addEventListener('focus', () => { if (rootInfo) queueGitRefresh(); });

async function refreshGit(): Promise<void> {
  if (!rootInfo) { gitState = { repo: false }; renderScm(); renderBranch(); return; }
  try {
    gitState = await api.git.status();
    gitLog = gitState.repo && gitState.hasCommits ? await api.git.log() : { head: null, commits: [] };
  } catch {
    gitState = { repo: false }; // git missing or not a repository: show the "initialize" panel
  }
  renderScm(); renderBranch(); renderTree();
}
function renderBranch(): void {
  const s = gitState;
  const ahead = s.ahead ? ` ↑${s.ahead}` : '';
  const behind = s.behind ? ` ↓${s.behind}` : '';
  $('#sbBranch').textContent = s.repo ? `⎇ ${s.branch || 'main'}${ahead}${behind}` : '⎇ no repository';
  const n = s.files?.length ?? 0;
  const badge = $('.act-btn[data-view=git] .badge');
  badge.textContent = n > 99 ? '99+' : String(n || '');
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
const GIT_STATUS: Record<string, { letter: string; cls: string; title: string }> = {
  A: { letter: 'A', cls: 'git-a', title: 'Added' },
  D: { letter: 'D', cls: 'git-d', title: 'Deleted' },
  R: { letter: 'R', cls: 'git-m', title: 'Renamed' },
  U: { letter: '!', cls: 'git-d', title: 'Conflict' },
};
function statusOf(f: GitFile, staged = false): { letter: string; cls: string; title: string } {
  if (f.x === '?' || f.y === '?') return { letter: 'U', cls: 'git-u', title: 'Untracked' };
  let c = f.y;
  if (staged || f.y === ' ') c = f.x;
  return GIT_STATUS[c] ?? { letter: 'M', cls: 'git-m', title: 'Modified' };
}

function syncLabel(s: GitStatus): string {
  if (!s.hasRemote) return '';
  if (!s.upstream) return 'Publish Branch';
  const ahead = s.ahead ? ` ↑${s.ahead}` : '';
  if (s.behind) return `Sync ↓${s.behind}${ahead}`;
  return s.ahead ? `Push${ahead}` : '';
}
function scmRowHtml(f: GitFile, inStaged: boolean): string {
  const st = statusOf(f, inStaged);
  const enter = seenScm.has(f.path + inStaged) ? '' : ' enter';
  const discard = inStaged ? '' : '<button class="icon-btn" data-scm="discard" title="Discard Changes">↺</button>';
  const toggle = inStaged
    ? '<button class="icon-btn" data-scm="unstage" title="Unstage Changes">−</button>'
    : '<button class="icon-btn" data-scm="stage" title="Stage Changes">+</button>';
  return `<div class="scm-row ${st.cls}${enter}" data-file="${escAttr(f.path)}" data-staged="${inStaged ? 1 : ''}" title="${escAttr(f.path)} · ${st.title}">
    <span class="ico">${fileIcon(baseName(f.path))}</span><span class="nm">${esc(baseName(f.path))}</span><span class="dir">${esc(dirName(f.path))}</span>
    <span class="acts"><button class="icon-btn" data-scm="open" title="Open File">↗</button>${discard}${toggle}</span><span class="st">${st.letter}</span></div>`;
}
function scmSectionHtml(key: string, title: string, list: GitFile[], inStaged: boolean, acts: string): string {
  if (!list.length) return '';
  const rows = list.map(f => scmRowHtml(f, inStaged)).join('');
  return `<div class="scm-sec ${scmCollapsed.has(key) ? 'closed' : ''}" data-sec="${key}">
    <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">${title}</span><span class="acts">${acts}</span><span class="count">${list.length}</span></div>
    <div class="scm-list">${rows}</div></div>`;
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
  const commitLabel = (!staged.length && changes.length ? 'Commit All' : 'Commit') + (gitState.hasRemote ? ' & Push' : '');
  const sync = syncLabel(gitState);
  const syncBtn = sync ? `<button class="btn btn-sm commit-btn" data-act="git.sync">${sync}</button>` : '';
  const empty = files.length ? '' : '<p class="side-note">No changes. Everything is saved in a checkpoint.</p>';
  el.innerHTML = `
    <div class="commit-box">
      <textarea class="input" id="scmMsg" rows="2" aria-label="Commit message" placeholder="Message (Ctrl+Enter to commit on ‘${escAttr(gitState.branch || 'main')}’)"></textarea>
      <button class="btn btn-primary btn-sm commit-btn" data-act="git.commit" ${files.length ? '' : 'disabled'}>✓ ${commitLabel}</button>
      ${syncBtn}
    </div>
    ${scmSectionHtml('staged', 'Staged Changes', staged, true, '<button class="icon-btn" data-scm-all="unstage" title="Unstage All">−</button>')}
    ${scmSectionHtml('changes', 'Changes', changes, false, '<button class="icon-btn" data-scm-all="discard" title="Discard All Changes">↺</button><button class="icon-btn" data-scm-all="stage" title="Stage All Changes">+</button>')}
    ${empty}
    <div class="scm-sec graph ${scmCollapsed.has('graph') ? 'closed' : ''}" data-sec="graph">
      <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">Checkpoints</span><span class="count">${gitLog.commits.length}</span></div>
      <div class="scm-list">${renderGraphRows()}</div>
    </div>`;
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

function toggleScmSection(head: HTMLElement): void {
  const sec = head.parentElement as HTMLElement;
  const key = sec.dataset.sec as string;
  if (scmCollapsed.has(key)) scmCollapsed.delete(key); else scmCollapsed.add(key);
  sec.classList.toggle('closed');
  store.set('breeze.scmCollapsed', [...scmCollapsed]);
}
function scmAll(kind: string | undefined): void {
  const files = gitState.files ?? [];
  if (kind === 'stage') void gitOp(() => api.git.stage(files.filter(f => f.y !== ' ' || f.x === '?').map(f => f.path)));
  if (kind === 'unstage') void gitOp(() => api.git.unstage(files.filter(f => f.x !== ' ' && f.x !== '?').map(f => f.path), !!gitState.hasCommits));
  if (kind === 'discard') confirmDiscardChanges(files.filter(f => f.y !== ' ' || f.x === '?'));
}
function scmRowAction(t: HTMLElement, rowEl: HTMLElement): void {
  const path = rowEl.dataset.file as string;
  const f = (gitState.files ?? []).find(x => x.path === path);
  const act = t.closest<HTMLElement>('[data-scm]')?.dataset.scm;
  if (act === 'open') openFile(path);
  else if (act === 'stage') void gitOp(() => api.git.stage([path]));
  else if (act === 'unstage') void gitOp(() => api.git.unstage([path], !!gitState.hasCommits));
  else if (act === 'discard' && f) confirmDiscardChanges([f]);
  else if (f) void showDiff(f, !!rowEl.dataset.staged);
}
$('#scm').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const head = t.closest<HTMLElement>('.scm-head');
  if (head && !t.closest('button')) { toggleScmSection(head); return; }
  const all = t.closest<HTMLElement>('[data-scm-all]');
  if (all) { scmAll(all.dataset.scmAll); return; }
  const commitRow = t.closest<HTMLElement>('[data-commit]');
  if (commitRow) { void toggleCommit(commitRow.dataset.commit as string); return; }
  const rowEl = t.closest<HTMLElement>('.scm-row');
  if (rowEl) scmRowAction(t, rowEl);
});

async function gitOp(fn: () => Promise<unknown>, done?: string): Promise<boolean> {
  if (gitBusy) return false;
  gitBusy = true;
  $('#scm').classList.add('busy');
  try {
    await fn();
    if (done) toast(done);
    return true;
  } catch (e) {
    const m = errMsg(e);
    if (m.length > 90 || m.includes('\n')) openModal(`<h3>Git said no</h3><pre class="git-err">${esc(m)}</pre><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
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
  const what = files.length === 1 ? 'changes in ' + esc(baseName(files[0].path)) : plural(files.length, 'change');
  const goes = untracked > 1 ? 's go' : ' goes';
  const bin = untracked ? `${untracked} new file${goes} to the Recycle Bin. ` : '';
  openModal(`<h3>Discard ${what}?</h3>
    <p class="sub">${bin}Edits to tracked files go back to the last checkpoint. This can't be undone with Ctrl+Z.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="discardOk">Discard</button></div>`, m => {
    $('#discardOk', m).onclick = () => {
      closeModal();
      void gitOp(() => api.git.discard(files.map(f => ({ path: f.path, untracked: f.x === '?' }))));
    };
  });
}
function diffLineClass(l: string): string {
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+')) return 'add';
  return l.startsWith('-') ? 'del' : '';
}
async function showDiff(f: GitFile, staged: boolean): Promise<void> {
  let text = '';
  try {
    if (f.x === '?') {
      const r = await api.fs.readFile(f.path);
      text = (r.text ?? '(binary file)').split('\n').map(l => '+' + l).join('\n');
    } else text = await api.git.diff(f.path, staged);
  } catch (e) { toast(errMsg(e)); return; }
  const lines = text.split('\n').filter(l => !/^(?:diff --git|index |--- |\+\+\+ )/.test(l));
  const body = lines.map(l => `<div class="dl ${diffLineClass(l)}">${esc(l) || ' '}</div>`).join('') || '<div class="dl">No textual changes.</div>';
  openModal(`<div class="diff-head"><span class="ico">${fileIcon(baseName(f.path))}</span><b>${esc(f.path)}</b><span class="pill">${staged ? 'Staged' : statusOf(f).title}</span></div>
    <div class="diff">${body}</div>
    <div class="row end mt-12"><button class="btn" id="diffOpen">Open File</button><button class="btn btn-primary" id="diffStage">${staged ? 'Unstage' : 'Stage'}</button></div>`, m => {
    $('#diffOpen', m).onclick = () => { closeModal(); openFile(f.path); };
    $('#diffStage', m).onclick = () => { closeModal(); void gitOp(() => (staged ? api.git.unstage([f.path], !!gitState.hasCommits) : api.git.stage([f.path]))); };
  }, undefined, 'top');
}

/* ----- Commit graph ----- */
const LANE_COLORS = ['#7aa9ff', '#c4b5fd', '#86efac', '#fdba74', '#f9a8d4', '#7dd3fc'];
interface GraphRow { c: GitCommit; lane: number; before: (string | null)[]; after: (string | null)[]; merges: number[]; forks: number[]; }
// The first free lane (or a new one) for a commit.
function claimLane(lanes: (string | null)[], hash: string): number {
  let i = lanes.indexOf(hash);
  if (i !== -1) return i;
  i = lanes.indexOf(null);
  if (i === -1) i = lanes.length;
  lanes[i] = hash;
  return i;
}
function layoutGraph(commits: GitCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  return commits.map(c => {
    const lane = claimLane(lanes, c.hash);
    const before = lanes.slice();
    const merges = before.map((h, i) => (h === c.hash && i !== lane ? i : -1)).filter(i => i >= 0);
    merges.forEach(i => { lanes[i] = null; });
    lanes[lane] = c.parents[0] ?? null;
    const forks = c.parents.slice(1).map(p => claimLane(lanes, p));
    while (lanes.length && lanes.at(-1) == null) lanes.pop();
    return { c, lane, before, after: lanes.slice(), merges, forks };
  });
}
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
function graphSvg(r: GraphRow, H: number, X: (i: number) => number): string {
  const mid = H / 2;
  const paths = r.before.map((h, i) => {
    if (!h) return '';
    if (i === r.lane) return `<path d="M${X(i)} 0V${mid}" stroke="${laneColor(i)}"/>`;
    if (r.merges.includes(i)) return `<path d="M${X(i)} 0C${X(i)} ${mid} ${X(r.lane)} ${mid / 2} ${X(r.lane)} ${mid}" stroke="${laneColor(i)}"/>`;
    return `<path d="M${X(i)} 0V${H}" stroke="${laneColor(i)}"/>`;
  });
  if (r.after[r.lane]) paths.push(`<path d="M${X(r.lane)} ${mid}V${H}" stroke="${laneColor(r.lane)}"/>`);
  for (const f of r.forks) paths.push(`<path d="M${X(r.lane)} ${mid}C${X(r.lane)} ${H} ${X(f)} ${mid} ${X(f)} ${H}" stroke="${laneColor(f)}"/>`);
  const isHead = r.c.hash === gitLog.head;
  const fill = isHead ? laneColor(r.lane) : 'var(--bg-1)';
  paths.push(`<circle cx="${X(r.lane)}" cy="${mid}" r="${isHead ? 5 : 4}" fill="${fill}" stroke="${laneColor(r.lane)}" stroke-width="2"/>`);
  return paths.join('');
}
function refClass(ref: string): string {
  if (ref.startsWith('HEAD')) return 'head';
  if (ref.startsWith('tag: ')) return 'tag';
  return ref.includes('/') ? 'remote' : 'branch';
}
function renderGraphRows(): string {
  if (!gitLog.commits.length) return '<p class="side-note">No checkpoints yet. Commit your changes to save the first one.</p>';
  const rows = layoutGraph(gitLog.commits);
  const H = 30, X = (i: number) => 10 + i * 12;
  const width = Math.min(6, Math.max(...rows.map(r => Math.max(r.before.length, r.after.length, r.lane + 1)))) * 12 + 8;
  return rows.map(r => {
    const refs = r.c.refs.map(ref => `<span class="ref ${refClass(ref)}">${esc(ref.replace(/^HEAD -> /, '').replace(/^tag: /, ''))}</span>`).join('');
    const open = openCommit === r.c.hash;
    const detail = open ? commitDetailHtml(commitDetails.get(r.c.hash)) : '';
    return `<div class="commit ${open ? 'on' : ''}" data-commit="${r.c.hash}" title="${escAttr(r.c.subject)}">
      <svg width="${width}" height="${H}" fill="none" stroke-width="2">${graphSvg(r, H, X)}</svg>
      <div class="msgline"><div>${refs}${esc(r.c.subject)}</div><small>${esc(r.c.author)} · ${esc(r.c.when)}</small></div>
    </div>${detail}`;
  }).join('');
}
function commitDetailHtml(d?: GitCommitDetail): string {
  if (!d) return '<div class="commit-detail"><div class="side-note">Loading…</div></div>';
  const files = d.files.map(f => `<div class="file" data-open-file="${escAttr(f.path)}"><span class="ico">${fileIcon(baseName(f.path))}</span><span class="fp">${esc(f.path)}</span><span><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span></div>`);
  return `<div class="commit-detail">
    <div class="cd-msg">${esc(d.message)}</div>
    <div class="cd-meta">${esc(d.author)} · ${esc(d.when)} · <code>${d.hash.slice(0, 8)}</code></div>
    ${files.join('')}
    <div class="row mt-8"><button class="btn btn-sm" data-branch-from="${d.hash}">Branch from here</button><button class="btn btn-sm" data-copy-hash="${d.hash}">Copy id</button></div>
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
  if (b) { e.stopPropagation(); void newBranch(b.dataset.branchFrom); }
  const c = t.closest<HTMLElement>('[data-copy-hash]');
  if (c) { e.stopPropagation(); background(navigator.clipboard.writeText(c.dataset.copyHash ?? '').then(() => toast('Commit id copied'))); }
}, true);

async function commitNow(): Promise<void> {
  const msg = scmDraft.trim();
  if (!msg) { toast('Write a short message describing this checkpoint'); $('#scmMsg')?.focus(); return; }
  const files = gitState.files ?? [];
  if (!files.length) { toast('Nothing to commit'); return; }
  await saveAll();
  const all = !files.some(f => f.x !== ' ' && f.x !== '?');
  let hash = '';
  if (!(await gitOp(async () => { hash = await api.git.commit(msg, all); }))) return;
  scmDraft = '';
  renderScm();
  // A checkpoint is committed and pushed in one go (pulling first if the branch is behind).
  if (!gitState.hasRemote) { toast(`Checkpoint saved · ${hash} (no remote to push to yet)`); return; }
  toast(`Checkpoint saved · ${hash} — pushing…`);
  const behind = !!gitState.behind;
  await gitOp(async () => {
    if (behind) await api.git.sync('pull');
    await api.git.sync('push');
  }, `Checkpoint ${hash} saved and pushed`);
}
async function newBranch(from?: string): Promise<void> {
  const name = await askName(from ? 'New branch from this checkpoint' : 'New branch', '', 'Create');
  if (!name) return;
  await gitOp(() => api.git.switchTo(name, true, from), `Switched to new branch ${name}`);
}
function branchListHtml(branches: string[], q: string): string {
  const create = q && !branches.includes(q) ? `<div class="qo-item" data-new="1"><span>＋ Create branch “${esc(q)}”</span></div>` : '';
  const rows = branches.filter(b => b.toLowerCase().includes(q.toLowerCase())).map(b => {
    const current = b === gitState.branch;
    return `<div class="qo-item ${current ? 'on' : ''}" data-br="${escAttr(b)}"><span>⎇ ${esc(b)}</span>${current ? '<small>current</small>' : ''}</div>`;
  });
  return create + rows.join('');
}
async function pickBranch(): Promise<void> {
  if (!gitState.repo) { showView('git', true); return; }
  const branches = await api.git.branches().catch(() => [] as string[]);
  openModal(`<input class="input w-full" id="brIn" aria-label="Branch name" placeholder="Switch to a branch, or type a new name" spellcheck="false"><div class="qo-list" id="brList"></div>`, m => {
    const input = $<HTMLInputElement>('#brIn', m);
    input.focus();
    const switchTo = (name: string, create: boolean) => {
      closeModal();
      const msg = create ? `Switched to new branch ${name}` : `Switched to ${name}`;
      if (create || name !== gitState.branch) void gitOp(() => api.git.switchTo(name, create), msg);
    };
    const render = () => {
      const q = input.value.trim();
      $('#brList', m).innerHTML = branchListHtml(branches, q);
      $$('[data-br]', m).forEach(el => el.onclick = () => switchTo(el.dataset.br as string, false));
      $('[data-new]', m)?.addEventListener('click', () => switchTo(q, true));
    };
    input.oninput = render;
    input.onkeydown = e => { if (e.key === 'Enter') ($('[data-new], [data-br]', m) as HTMLElement | null)?.click(); };
    render();
  }, undefined, 'top');
}
$('#sbBranch').onclick = () => void pickBranch();
async function syncBranch(): Promise<boolean> {
  const s = gitState;
  if (!s.upstream) return gitOp(() => api.git.sync('push'), 'Branch published');
  if (!s.behind) return gitOp(() => api.git.sync('push'), 'Pushed');
  return gitOp(async () => {
    await api.git.sync('pull');
    if (s.ahead) await api.git.sync('push');
  }, 'In sync');
}
Object.assign(commands, {
  'git.refresh': refreshGit,
  'git.init': () => gitOp(() => api.git.init(), 'Repository created'),
  'git.commit': commitNow,
  'git.sync': syncBranch,
  'git.more': () => {
    const r = $('[data-act="git.more"]').getBoundingClientRect();
    popupMenu(r.left, r.bottom + 4, [
      { label: 'Pull', run: () => void gitOp(() => api.git.sync('pull'), 'Pulled') },
      { label: 'Push', run: () => void gitOp(() => api.git.sync('push'), 'Pushed') },
      { label: 'Fetch', run: () => void gitOp(() => api.git.sync('fetch'), 'Fetched') },
      { sep: true },
      { label: 'Switch Branch…', run: () => void pickBranch() },
      { label: 'Create Branch…', run: () => void newBranch() },
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
  if (v === 'git') void refreshGit();
}
// Clicking the active view's icon again collapses the side bar, like VS Code.
$$('.act-btn[data-view]').forEach(b => b.onclick = () => {
  const v = b.dataset.view as string;
  if (v === layout.view && layout.sideOpen) { layout.sideOpen = false; applyLayout(); } else showView(v, true);
});

/* ================= Breeze Box (chat only) ================= */
// The same agents and conversation as the IDE's agent panel, with nothing else on screen.
function enterMode(mode: WorkMode): void {
  appState.mode = mode;
  appState.onboarded = true;
  saveApp();
  closeMenu();
  if (mode === 'ide') { showIde(); return; }
  $('#onboard').classList.add('hidden'); $('#ide').classList.add('hidden'); $('#box').classList.remove('hidden');
  useSurface('box');
  renderUser(); renderAgentPill(); renderBoxFolder();
  // Box lists every agent Breeze found, so look for them if that hasn't happened yet.
  if (!appState.detect) detectTools().catch(() => toast('Could not look for agents on this computer'));
  if (!SURFACES.box.chat.children.length) restoreChat(SURFACES.box);
  SURFACES.box.prompt.focus();
}
function renderBoxFolder(): void {
  const chip = $('#boxFolder');
  chip.textContent = rootInfo ? `📁 ${rootInfo.name}` : '📁 Breeze Box folder';
  chip.title = rootInfo ? `Agents work in ${rootInfo.root}` : 'No project open: agents work in Documents/Breeze Box';
}
// Every agent Breeze found, to pick from without leaving the chat.
function boxAgentItems(): MenuItem[] {
  const agents = appState.detect?.agents ?? [];
  const items: MenuItem[] = agents.map(a => ({
    label: a.api && a.version ? `${a.name} · ${a.version}` : a.name,
    key: a.found ? undefined : 'not set up',
    checked: () => a.id === appState.agent,
    enabled: () => a.found,
    run: () => {
      appState.agent = a.id;
      saveApp();
      renderAgentPill();
      if (SURFACES.box.chat.querySelector('.empty')) emptyChat(SURFACES.box);
      toast(`Breeze Box now uses ${a.name}`);
    },
  }));
  return [...items, { sep: true }, { label: 'Manage agents…', run: openAgentPicker }];
}
$('#boxModel').onclick = e => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  popupMenu(r.left, r.top - 8, boxAgentItems());
  const m = $('#menuRoot .menu');
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`; // open upwards, above the composer
};
$('#boxFolder').onclick = e => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const choose = (create: boolean) => background(chooseProject(create).then(renderBoxFolder));
  popupMenu(r.left, r.top, [
    { label: 'Open Folder…', run: () => choose(false) },
    { label: 'Create New Project…', run: () => choose(true) },
    ...(rootInfo ? [{ sep: true }, { label: 'Close Folder', run: () => background(closeFolderCmd().then(renderBoxFolder)) }] : []),
  ]);
  const m = $('#menuRoot .menu');
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
};

/* ================= Vibe Mode ================= */
// While an agent works, the IDE fades and blurs away and the user's feed plays in a 9:16 frame.
// In the desktop app main.js lays the live site exactly over #vibeFrame; the browser preview shows a placeholder.
const VIBE_DELAY = 3000; // quick answers don't trigger it
let vibeOn = false;
let vibeTimer: number | undefined;
let vibeClock: number | undefined;
let vibeStarted = 0;
let vibeMuted = false;
let vibeSiteShown: string | null = null;
const vibeFrame = $('#vibeFrame');
const agentWorking = () => Object.values(agentsDef).some(a => a.status === 'working');
function setVibeArmed(on: boolean): void {
  appState.vibeArmed = on;
  saveApp();
  $('#vibeArm').textContent = on ? '◉ Vibe Mode on' : '◌ Vibe Mode off';
  $('#vibeArm').classList.toggle('armed', on);
}
$('#vibeArm').onclick = () => {
  if (appState.vibeArmed) { setVibeArmed(false); toast('Vibe Mode off'); return; }
  if (!connectedSites().length) { openFeedPicker(); return; }
  setVibeArmed(true);
  toast(`Vibe Mode on — ${siteById(appState.vibeSite)?.name ?? 'your feed'} plays while agents work`);
};
function openFeedPicker(): void {
  openModal(`<h3>Vibe Mode feeds</h3><p class="sub">Pick what plays while your agents work. Connecting opens the site so you can sign in.</p>
    <div class="social-grid" id="feedPick"></div><div class="row end"><button class="btn btn-primary" data-close>Done</button></div>`,
  m => void renderFeedChoices($('#feedPick', m)), () => { if (connectedSites().length && !appState.vibeArmed) setVibeArmed(true); });
}
commands['vibe.feeds'] = openFeedPicker;

function frameRect(): Rect {
  const r = vibeFrame.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}
function renderVibeSites(): void {
  $('#vibeSites').innerHTML = connectedSites().map(s =>
    `<button class="${s.id === vibeSiteShown ? 'on' : ''}" data-vibe-site="${s.id}"><span class="mark tint-${s.id}">${s.mark}</span>${esc(s.name)}</button>`).join('');
  $$('[data-vibe-site]').forEach(b => b.onclick = () => { appState.vibeSite = b.dataset.vibeSite ?? null; saveApp(); showFeed(); });
}
function showFeed(): void {
  const site = siteById(appState.vibeSite) ?? connectedSites()[0];
  vibeSiteShown = site?.id ?? null;
  renderVibeSites();
  const placeholder = $('#vibePlaceholder');
  placeholder.classList.toggle('hidden', isDesktop && !!site);
  placeholder.innerHTML = site
    ? `<div><span class="mark tint-${site.id} big-mark">${site.mark}</span><h4>${esc(site.name)}</h4><div>Your feed plays here in the Breeze desktop app.</div></div>`
    : '<div><h4>No feed connected</h4><div>Open Settings → Vibe Mode Feeds to connect one.</div></div>';
  if (site && isDesktop) background(api.vibe.show(site.id, frameRect()));
}
function tickVibeClock(): void {
  const s = Math.floor((Date.now() - vibeStarted) / 1000);
  $('#vibeClock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const a = Object.values(agentsDef).find(x => x.status === 'working');
  if (a) $('#vibeTask').textContent = `${a.name}: ${a.task}`;
}
function enterVibe(): void {
  if (vibeOn) return;
  vibeOn = true;
  closeMenu();
  vibeStarted = Date.now();
  $('#vibeReady').classList.add('hidden');
  $('#vibeStatus').classList.remove('hidden');
  $('#vibe').classList.remove('hidden');
  document.body.classList.add('vibing');
  tickVibeClock();
  vibeClock = setInterval(tickVibeClock, 1000);
  // Wait for the stage to settle before laying the live feed over it.
  setTimeout(() => { if (vibeOn) showFeed(); }, 450);
}
function exitVibe(): void {
  if (!vibeOn) return;
  vibeOn = false;
  clearInterval(vibeClock);
  if (isDesktop) background(api.vibe.hide());
  document.body.classList.remove('vibing');
  $('#vibe').classList.add('hidden');
}
// Called whenever an agent's status changes.
function vibeTick(): void {
  if (!appState.vibeArmed || !connectedSites().length || vibeOn || vibeTimer != null || !agentWorking()) return;
  vibeTimer = setTimeout(() => {
    vibeTimer = undefined;
    if (agentWorking()) enterVibe();
  }, VIBE_DELAY);
}
function vibeDone(ok: boolean): void {
  clearTimeout(vibeTimer);
  vibeTimer = undefined;
  if (!vibeOn) return;
  clearInterval(vibeClock);
  $('#vibeStatus').classList.add('hidden');
  $('#vibeReady').classList.remove('hidden');
  $('#vibeReady').classList.toggle('failed', !ok);
  $('#vibeReadyText').textContent = ok ? '✓ Your code is ready' : 'The agent stopped';
  $('#vibeBack').textContent = ok ? 'Show me' : 'Back to code';
}
$('#vibeClose').onclick = exitVibe;
$('#vibeBack').onclick = () => {
  exitVibe();
  const t = lastRunFiles[0];
  if (t) openFile(t);
};
$('#vibeMute').onclick = () => {
  vibeMuted = !vibeMuted;
  $('#vibeMute use').setAttribute('href', vibeMuted ? '#i-mute' : '#i-sound');
  $('#vibeMute').title = vibeMuted ? 'Unmute' : 'Mute';
  if (isDesktop) background(api.vibe.mute(vibeMuted));
};
// Keep the live feed glued to the frame when the window changes size.
new ResizeObserver(() => { if (vibeOn && vibeSiteShown && isDesktop) background(api.vibe.bounds(frameRect())); }).observe(vibeFrame);

/* ================= Discord ================= */
let discord = false;
$('#discord').onclick = () => {
  if (discord) { discord = false; $('#discord').textContent = 'Discord: off'; return; }
  const detail = [rootInfo?.name ?? 'No project', active ? baseName(active) : null, active ? langOf(active)[1] : null]
    .filter((s): s is string => !!s).map(esc).join(' · ');
  openModal(`<h3>Show what you're doing on Discord?</h3><p class="sub">Your friends will see:</p>
    <div class="setup-card mb-12"><b>Breeze IDE</b><div class="text-2">Vibe coding with agents</div><div class="text-2">${detail}</div><div class="text-3 fs-12">00:14 elapsed</div></div>
    <p class="sub fs-12">Project and file names can include client or employer names. You can hide details anytime from the status bar.</p>
    <div class="row end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="dOn">Turn on</button></div>`,
  m => { $('#dOn', m).onclick = () => { discord = true; $('#discord').textContent = 'Discord: on'; closeModal(); }; });
};

/* ================= Modal & misc ================= */
let modalOnClose: (() => void) | null = null;
const modalOpen = () => !!document.querySelector('#modalRoot .scrim:not(.closing)');
function openModal(html: string, bind?: (m: HTMLElement) => void, onClose?: () => void, place: 'center' | 'top' = 'center'): void {
  closeModal();
  $$('#modalRoot .scrim.closing').forEach(x => x.remove());
  const top = place === 'top';
  $('#modalRoot').insertAdjacentHTML('beforeend', `<div class="scrim ${top ? 'top' : ''}"><div class="modal ${top ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`);
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
  setVibeArmed(appState.vibeArmed);
  // The main process remembers who signed in; it wins over the renderer's copy.
  const signed = await api.auth.user().catch(() => null);
  if (signed || isDesktop) { user = signed; appState.user = signed; saveApp(); }
  await refreshAccounts();
  if (appState.onboarded) enterMode(appState.mode);
  else goStep(step);
  const info = await api.fs.restore().catch(() => null);
  if (info) await loadWorkspace(info);
  else { term.cwd = await api.term.cwd(); renderPs(); }
  renderTree();
  if (step === STEP.mode) renderModeChoice();
  renderBoxFolder();
  // Refresh the tool and agent status in the background; the cached result shows meanwhile.
  if (appState.onboarded) detectTools().catch(() => { /* shown in the setup card */ });
}
background(boot());
