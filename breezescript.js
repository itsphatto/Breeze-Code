"use strict";
/* Breeze IDE — renderer logic.
   Files, search, terminal and agent detection are real in the desktop app (main.js + preload.js).
   Opened in a plain browser, a small in-memory demo project stands in for the disk.
   Agent conversations, checkpoints and collaboration are still simulated. */
/* ================= Helpers ================= */
function $(s, r = document) {
    return r.querySelector(s);
}
function $$(s, r = document) {
    return [...r.querySelectorAll(s)];
}
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replaceAll(/[&<>]/g, c => ESCAPES[c]);
const escAttr = (s) => esc(s).replaceAll('"', '&quot;');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message.
const errMsg = (e) => {
    const text = e instanceof Error ? e.message : String(e);
    return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};
// Folders first, then names A–Z.
const byDirThenName = (a, b) => {
    if (a.dir !== b.dir)
        return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};
function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('#toastRoot').replaceChildren(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 2600);
}
// Starts async work without waiting for it; a failure shows as a toast.
function background(work) {
    work.catch(e => toast(errMsg(e)));
}
const store = {
    get(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        }
        catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        }
        catch { /* storage blocked or full */ }
    },
    del(key) {
        try {
            localStorage.removeItem(key);
        }
        catch { /* storage blocked */ }
    },
};
/* ================= Platform (desktop bridge or in-browser demo) ================= */
const DEMO_FILES = {
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
const bean = ([x, y, r]) => `<g transform="translate(${x} ${y}) rotate(${r})"><ellipse rx="54" ry="36" fill="#6b4226"/><path d="M-46 0c24-16 68 16 92 0" fill="none" stroke="#2b1d12" stroke-width="7" stroke-linecap="round"/></g>`;
const DEMO_BEANS = [[190, 160, -30], [320, 225, 20], [450, 150, -10], [255, 300, 40], [470, 290, -40]].map(bean).join('');
const DEMO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4ece1"/>${DEMO_BEANS}</svg>`);
let demoRun = 0;
const agentListeners = [];
const authListeners = [];
// Browser preview: replays a short, canned agent run.
async function demoReplay(id, mode) {
    const steps = [
        [{ t: 'session', id: 'demo-session', model: 'demo' }, 100],
        [{ t: 'tool', kind: 'read', label: 'Read index.html' }, 600],
        [{ t: 'tool', kind: 'read', label: 'Read styles.css' }, 900],
    ];
    if (mode === 'build') {
        steps.push([{ t: 'tool', kind: 'edit', label: 'Edited styles.css' }, 2500], [{ t: 'tool', kind: 'run', label: '$ npx prettier --check styles.css' }, 3000], [{ t: 'text', text: 'Done — I warmed up the hero colours in styles.css. (Browser preview: no files were really changed.)' }, 2500]);
    }
    else if (mode === 'plan') {
        steps.push([{ t: 'text', text: 'I looked at the page and its styles.' }, 600], [{ t: 'plan', text: '1. Make the hero taller with a warm gradient\n2. Turn the menu into three cards\n3. Add a footer with opening hours' }, 500]);
    }
    else {
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
async function demoEdit(role) {
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
        return;
    const [s, e] = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
    if (role === 'selectAll')
        el.select();
    else if (role === 'copy' || role === 'cut') {
        await navigator.clipboard.writeText(el.value.slice(s, e));
        if (role === 'cut')
            el.setRangeText('', s, e, 'end');
    }
    else if (role === 'paste')
        el.setRangeText(await navigator.clipboard.readText(), s, e, 'end');
    el.dispatchEvent(new Event('input'));
}
function demoApi() {
    const files = new Map(Object.entries(DEMO_FILES));
    const binary = new Set(['assets/beans.jpg']);
    const dirs = new Set(['assets']);
    const info = { root: 'demo:/coffee-shop-landing', name: 'coffee-shop-landing' };
    const under = (p, rel) => (rel ? p.startsWith(rel + '/') : true);
    const exists = (p) => files.has(p) || dirs.has(p);
    const inside = (k, rel) => k === rel || k.startsWith(rel + '/');
    const needOpen = () => { if (!store.get('breeze.demoOpen', false))
        throw new Error('No folder is open'); };
    const feeds = () => store.get('breeze.demoVibe', {});
    return {
        fs: {
            async openFolder() { store.set('breeze.demoOpen', true); return info; },
            async restore() { return store.get('breeze.demoOpen', false) ? info : null; },
            async closeFolder() { store.del('breeze.demoOpen'); },
            async recent() { return [{ path: info.root, name: info.name }]; },
            async openRecent() { store.set('breeze.demoOpen', true); return info; },
            async readDir(rel) {
                needOpen();
                const seen = new Map();
                const depth = rel ? rel.split('/').length : 0;
                for (const d of dirs)
                    if (under(d, rel) && d.split('/').length === depth + 1)
                        seen.set(baseName(d), true);
                for (const f of files.keys())
                    if (under(f, rel) && f.split('/').length === depth + 1)
                        seen.set(baseName(f), false);
                return [...seen].map(([name, dir]) => ({ name, dir })).sort(byDirThenName);
            },
            async readFile(rel) {
                if (!files.has(rel))
                    throw new Error('File not found');
                if (binary.has(rel))
                    return IMAGE_FILE.test(rel) ? { image: true, size: 48213 } : { binary: true, size: 48213 };
                return { text: files.get(rel), size: (files.get(rel) ?? '').length };
            },
            async writeFile(rel, text) { files.set(rel, text); },
            async createFile(rel) {
                if (exists(rel))
                    throw new Error('A file with that name already exists');
                files.set(rel, '');
            },
            async createDir(rel) {
                if (exists(rel))
                    throw new Error('A folder with that name already exists');
                dirs.add(rel);
            },
            async rename(from, to) {
                if (exists(to))
                    throw new Error('Something with that name already exists');
                const renamed = (k) => to + k.slice(from.length);
                // Snapshot the keys first: the maps change while we go.
                const fileKeys = [...files.keys()].filter(k => inside(k, from));
                for (const k of fileKeys) {
                    files.set(renamed(k), files.get(k) ?? '');
                    files.delete(k);
                }
                for (const set of [dirs, binary]) {
                    const keys = [...set].filter(k => inside(k, from));
                    for (const k of keys) {
                        set.delete(k);
                        set.add(renamed(k));
                    }
                }
            },
            async trash(rel) {
                const gone = [...files.keys(), ...dirs, ...binary].filter(k => inside(k, rel));
                for (const k of gone) {
                    files.delete(k);
                    dirs.delete(k);
                    binary.delete(k);
                }
            },
            async listFiles() { return [...files.keys()]; },
            async search(query, matchCase) {
                const out = [];
                const needle = matchCase ? query : query.toLowerCase();
                for (const [path, text] of files) {
                    if (binary.has(path))
                        continue;
                    text.split('\n').forEach((line, i) => {
                        const col = (matchCase ? line : line.toLowerCase()).indexOf(needle);
                        if (col !== -1)
                            out.push({ path, line: i, col, text: line });
                    });
                }
                return out;
            },
            // No file URLs in the browser: images get a drawn stand-in, everything else ''.
            async fileUrl(rel) { return binary.has(rel) && IMAGE_FILE.test(rel) ? DEMO_IMAGE : ''; },
            onChange() { return () => { }; },
        },
        lint: { async check() { return null; } },
        term: {
            async cwd() { return 'coffee-shop-landing'; },
            async run() { return { error: 'The terminal runs commands only in the Breeze desktop app (npm start).' }; },
            async kill() { },
            onData() { return () => { }; },
            onExit() { return () => { }; },
        },
        sys: {
            async detect() {
                await wait(500);
                const demoKey = store.get('breeze.demoKey', false);
                return {
                    demo: true, platform: 'browser',
                    agents: [
                        { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', url: 'https://claude.com/product/claude-code', found: true, path: null, version: null },
                        { id: 'codex', name: 'Codex', vendor: 'OpenAI', url: 'https://developers.openai.com/codex/cli', found: false, path: null, version: null },
                        { id: 'antigravity', name: 'Antigravity', vendor: 'Google', url: 'https://antigravity.google', found: false, path: null, version: null },
                        { id: 'gemini', name: 'Gemini', vendor: 'Google', url: 'https://aistudio.google.com/apikey', api: true, found: demoKey, path: null, version: demoKey ? 'gemini-flash-latest' : null },
                    ],
                    tools: [{ id: 'git', name: 'Git', found: true, version: null }, { id: 'node', name: 'Node.js', found: true, version: null }],
                };
            },
            async openExternal(url) { window.open(url, '_blank', 'noopener'); },
        },
        // Browser preview only: canned answers so every panel can be tried without the desktop app.
        gemini: {
            async status() { return { hasKey: store.get('breeze.demoKey', false), model: 'gemini-flash-latest' }; },
            async setKey(key) {
                await wait(600);
                if (key.trim().length < 10)
                    throw new Error('API key not valid. Please pass a valid API key.');
                store.set('breeze.demoKey', true);
                return { model: 'gemini-flash-latest' };
            },
            async clearKey() { store.del('breeze.demoKey'); },
        },
        agent: {
            async run({ mode }) {
                const id = ++demoRun;
                background(demoReplay(id, mode));
                return id;
            },
            async stop() { },
            async openApp() { },
            onEvent(cb) { agentListeners.push(cb); return () => { }; },
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
            async discard() { },
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
            async cancel() { },
            async signOut() { },
            onEvent(cb) { authListeners.push(cb); return () => { }; },
        },
        // Browser preview: "connecting" opens the site in a new tab; the feed itself only plays in the desktop app.
        vibe: {
            async status() { return feeds(); },
            async connect(id) {
                const site = SOCIAL_SITES.find(s => s.id === id);
                if (site)
                    window.open(site.url, '_blank', 'noopener');
                store.set('breeze.demoVibe', { ...feeds(), [id]: true });
                return true;
            },
            async disconnect(id) { store.set('breeze.demoVibe', { ...feeds(), [id]: false }); },
            async show() { },
            async bounds() { },
            async mute() { },
            async hide() { },
        },
        win: {
            async reload() { location.reload(); },
            async toggleDevTools() { toast('Developer tools are available in the desktop app'); },
            async quit() { window.close(); },
            edit: demoEdit,
        },
    };
}
const SOCIAL_SITES = [
    { id: 'youtube', name: 'YouTube Shorts', mark: '▶', url: 'https://www.youtube.com/shorts' },
    { id: 'tiktok', name: 'TikTok', mark: '♪', url: 'https://www.tiktok.com/foryou' },
    { id: 'instagram', name: 'Instagram Reels', mark: '◎', url: 'https://www.instagram.com/reels/' },
    { id: 'facebook', name: 'Facebook Reels', mark: 'f', url: 'https://www.facebook.com/reel/' },
    { id: 'x', name: 'X', mark: '𝕏', url: 'https://x.com/home' },
];
const isDesktop = !!window.breeze;
const api = window.breeze ?? demoApi();
const appState = {
    onboarded: false, step: 0, user: null, agent: null, detect: null, vibeArmed: false, vibeSites: [], vibeSite: null,
    ...store.get('breeze.app', {}),
};
const saveApp = () => store.set('breeze.app', appState);
/* ================= Onboarding ================= */
const STEP = { welcome: 0, signIn: 1, feeds: 2, setup: 3 };
let step = appState.step;
let user = appState.user;
function goStep(n) {
    step = n;
    appState.step = n;
    saveApp();
    $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
    $$('.ob-dots span').forEach((d, i) => d.classList.toggle('on', i === n));
    if (n === STEP.feeds)
        void renderFeedChoices($('#socialList'));
    if (n === STEP.setup) {
        detectTools().catch(() => { });
        renderProjectChoice();
    }
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));
/* ----- Sign in (GitHub device flow / Google loopback, handled in main.js) ----- */
function setUser(u) {
    user = u;
    appState.user = u;
    saveApp();
    renderUser();
}
const initialsOf = (name) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
function renderUser() {
    const name = user?.name ?? 'You';
    const me = user?.avatar
        ? `<img class="avatar" src="${escAttr(user.avatar)}" alt="" title="${escAttr(name)} (host)">`
        : `<span class="avatar tint-host" title="${escAttr(name)} (host)">${esc(initialsOf(name))}</span>`;
    const others = guests.map(g => `<span class="avatar tint-${g.tint}" title="${g.name} (${g.role})">${g.name.slice(0, 2).toUpperCase()}</span>`);
    $('#avatars').innerHTML = me + others.join('');
    $('#userChip').textContent = user ? `● ${user.name} · ${user.provider}` : 'Not signed in';
}
function signinView(waiting) {
    $('#signinChoices').classList.toggle('hidden', waiting);
    $('#signinWait').classList.toggle('hidden', !waiting);
    if (waiting) {
        $('#signinError').classList.add('hidden');
        $('#signinCode').classList.add('hidden');
    }
}
function signinError(text) {
    signinView(false);
    $('#signinError').textContent = text;
    $('#signinError').classList.remove('hidden');
}
async function startSignIn(provider) {
    signinView(true);
    $('#signinMsg').textContent = `Opening ${provider} in your browser…`;
    const r = await api.auth.start(provider).catch(e => ({ error: errMsg(e) }));
    if (r.error === 'not-configured') {
        signinError(`Looks like ${provider} login isn't hooked up yet! Grab a Client ID, add it to breeze.config.json (there's an example config to help), and give Breeze a restart. Or, skip it for now and jump right in.`);
    }
    else if (r.error)
        signinError(r.error);
}
$$('[data-signin]').forEach(b => b.onclick = () => startSignIn(b.dataset.signin ?? 'GitHub'));
$('#signinCancel').onclick = () => { background(api.auth.cancel()); signinView(false); };
$('#signinSkip').onclick = () => goStep(STEP.feeds);
$('#copyCode').onclick = () => { navigator.clipboard?.writeText($('#codeText').textContent ?? '').catch(() => toast('Copy failed')); toast('Code copied'); };
api.auth.onEvent(ev => {
    if (ev.t === 'code') {
        $('#signinMsg').textContent = 'Enter this code on the GitHub page that just opened:';
        $('#codeText').textContent = ev.code ?? '';
        $('#signinCode').classList.remove('hidden');
        $('#openCodePage').onclick = () => background(api.sys.openExternal(ev.uri ?? 'https://github.com/login/device'));
    }
    else if (ev.t === 'waiting') {
        $('#signinMsg').textContent = `Finish signing in with ${ev.provider} in your browser…`;
    }
    else if (ev.t === 'done' && ev.user) {
        setUser(ev.user);
        signinView(false);
        toast(`Signed in as ${ev.user.name}`);
        if (!appState.onboarded && step === STEP.signIn)
            goStep(STEP.feeds);
    }
    else if (ev.t === 'error')
        signinError(ev.text ?? 'Sign-in failed');
});
/* ----- Vibe Mode feeds (onboarding step and picker) ----- */
// Sites the user connected live in appState.vibeSites; signedIn says which of them have a session cookie.
let signedIn = {};
const siteById = (id) => SOCIAL_SITES.find(s => s.id === id);
const connectedSites = () => SOCIAL_SITES.filter(s => appState.vibeSites.includes(s.id));
function feedCardHtml(s) {
    const connected = appState.vibeSites.includes(s.id);
    const cls = ['social-card', connected ? 'connected' : '', s.id === appState.vibeSite ? 'on' : ''].filter(Boolean).join(' ');
    let sub = 'Not connected';
    if (connected)
        sub = signedIn[s.id] ? 'Signed in' : 'Connected · not signed in';
    return `<div class="${cls}" data-site="${s.id}" role="button" tabindex="0">
    <span class="mark tint-${s.id}">${s.mark}</span><span class="nm">${esc(s.name)}</span><span class="sub">${sub}</span>
    <button class="btn btn-sm" data-connect="${s.id}">${connected ? 'Disconnect' : 'Connect ↗'}</button></div>`;
}
async function renderFeedChoices(root) {
    signedIn = await api.vibe.status().catch(() => ({}));
    const draw = () => {
        root.innerHTML = SOCIAL_SITES.map(feedCardHtml).join('');
        $$('[data-site]', root).forEach(card => {
            const id = card.dataset.site ?? '';
            const pick = (onButton) => {
                // A connected card's body makes it the feed Vibe Mode plays; the button connects or disconnects.
                if (!onButton && appState.vibeSites.includes(id)) {
                    appState.vibeSite = id;
                    saveApp();
                    draw();
                    return;
                }
                background(toggleFeed(id).then(draw));
            };
            card.onclick = e => pick(!!e.target.closest('[data-connect]'));
            card.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
                e.preventDefault();
                pick(false);
            } };
        });
    };
    draw();
}
async function toggleFeed(id) {
    const site = siteById(id);
    if (!site)
        return;
    if (appState.vibeSites.includes(id)) {
        await api.vibe.disconnect(id);
        appState.vibeSites = appState.vibeSites.filter(x => x !== id);
        signedIn[id] = false;
        if (appState.vibeSite === id)
            appState.vibeSite = appState.vibeSites[0] ?? null;
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
const AGENT_STYLE = {
    claude: { letter: 'C', tint: 'claude' },
    codex: { letter: 'Cx', tint: 'codex' },
    antigravity: { letter: 'A', tint: 'antigravity' },
    gemini: { letter: 'G', tint: 'gemini' },
};
let detecting = null;
function detectTools() {
    if (detecting)
        return detecting;
    $('#aiPill').className = 'pill';
    $('#aiPill').textContent = 'Scanning…';
    $('#toolsPill').className = 'pill';
    $('#toolsPill').textContent = 'Scanning…';
    if (!appState.detect)
        $('#agentList').innerHTML = '<div class="row text-3"><div class="spinner sm"></div>Checking this computer…</div>';
    detecting = api.sys.detect().then(d => {
        appState.detect = d;
        fixSelectedAgent();
        renderDetection();
        return d;
    }).catch((e) => {
        $('#aiPill').className = 'pill warn';
        $('#aiPill').textContent = 'Scan failed';
        $('#aiHint').textContent = errMsg(e);
        throw e;
    }).finally(() => { detecting = null; });
    return detecting;
}
// Keep the chosen agent if it is still usable, else fall back to the first one that is.
function fixSelectedAgent() {
    const found = appState.detect?.agents.filter(a => a.found) ?? [];
    if (!appState.agent || !found.some(a => a.id === appState.agent))
        appState.agent = found[0]?.id ?? null;
    saveApp();
}
const pillClass = (on) => (on ? 'blue' : 'ok');
function apiAgentHtml(a, on, mark) {
    const pill = `<span class="pill ${pillClass(on)}">${on ? 'Selected' : 'Ready'}</span>`;
    const side = a.found
        ? `<span class="side row gap-6">${pill}<button class="get" data-clearkey title="Remove the saved key">Remove</button></span>`
        : `<button class="get side" data-get="${escAttr(a.url)}">Get a key ↗</button>`;
    const model = a.version ? ' · ' + a.version : '';
    const sub = a.found ? 'API key saved securely' + model : 'Uses your own Google AI Studio API key';
    const keyRow = '<div class="key-row"><input class="input" type="password" aria-label="Gemini API key" placeholder="Paste your Gemini API key" autocomplete="off" spellcheck="false" data-key><button class="btn btn-sm" data-savekey>Save key</button></div><div class="key-err hidden"></div>';
    const attrs = a.found ? `role="button" tabindex="0" data-agent="${a.id}"` : '';
    return `<div class="agent-opt api ${a.found ? '' : 'missing'} ${on ? 'on' : ''}" ${attrs}>
    ${mark}<span class="nm">${esc(a.name)} <small>API</small></span>${side}
    <span class="sub">${esc(sub)}</span>${a.found ? '' : keyRow}</div>`;
}
function cliAgentHtml(a, on, mark, demo) {
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
function agentOptionsHtml(d) {
    return d.agents.map(a => {
        const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], tint: 'default' };
        const on = a.found && a.id === appState.agent;
        const mark = `<span class="mark tint-${st.tint}">${st.letter}</span>`;
        return a.api ? apiAgentHtml(a, on, mark) : cliAgentHtml(a, on, mark, !!d.demo);
    }).join('');
}
function bindGeminiKey(root, onChange) {
    const input = root.querySelector('[data-key]');
    const saveBtn = root.querySelector('[data-savekey]');
    const gemini = () => appState.detect?.agents.find(a => a.id === 'gemini');
    if (input && saveBtn) {
        const save = async () => {
            const err = root.querySelector('.key-err');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Checking…';
            try {
                const { model } = await api.gemini.setKey(input.value);
                const g = gemini();
                if (g) {
                    g.found = true;
                    g.version = model;
                }
                if (!selectedAgent())
                    appState.agent = 'gemini';
                saveApp();
                toast('Gemini key saved');
                onChange();
            }
            catch (e) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save key';
                if (err) {
                    err.textContent = errMsg(e);
                    err.classList.remove('hidden');
                }
            }
        };
        saveBtn.onclick = save;
        input.onkeydown = e => { if (e.key === 'Enter')
            void save(); };
    }
    root.querySelector('[data-clearkey]')?.addEventListener('click', e => {
        e.stopPropagation();
        background(api.gemini.clearKey().then(() => {
            const g = gemini();
            if (g) {
                g.found = false;
                g.version = null;
            }
            fixSelectedAgent();
            onChange();
        }));
    });
}
function bindAgentOptions(root, onChange) {
    $$('[data-agent]', root).forEach(el => {
        const pick = () => { appState.agent = el.dataset.agent ?? null; saveApp(); onChange(); };
        el.onclick = e => { if (!e.target.closest('button, input'))
            pick(); };
        el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
            e.preventDefault();
            pick();
        } };
    });
    $$('[data-get]', root).forEach(b => b.onclick = e => { e.stopPropagation(); background(api.sys.openExternal(b.dataset.get ?? '')); });
    bindGeminiKey(root, onChange);
}
const TOOL_DOWNLOADS = { git: 'https://git-scm.com/downloads', node: 'https://nodejs.org/en/download' };
function toolHtml(t) {
    if (!t.found)
        return `<span class="pill warn">${t.name} missing</span><button class="btn btn-sm" data-get="${TOOL_DOWNLOADS[t.id] ?? ''}">Get ${t.name} ↗</button>`;
    const version = t.version ? ' ' + esc(t.version) : '';
    return `<span class="pill ok">${t.name}${version} ready</span>`;
}
function renderDetection() {
    const d = appState.detect;
    if (!d)
        return;
    const found = d.agents.filter(a => a.found);
    $('#agentList').innerHTML = agentOptionsHtml(d);
    bindAgentOptions($('#agentList'), renderDetection);
    $('#aiPill').className = found.length ? 'pill ok' : 'pill warn';
    $('#aiPill').textContent = found.length ? `${found.length} ready` : 'None ready';
    $('#aiHint').textContent = found.length
        ? 'Pick the agent Breeze hands work to. Installed agents use their own sign-in; Gemini uses your API key.'
        : 'No coding agent found. Install one and rescan, or paste a Gemini API key.';
    if (d.demo)
        $('#aiHint').textContent += ' (Browser preview.)';
    $('#toolList').innerHTML = d.tools.map(toolHtml).join('');
    $$('[data-get]', $('#toolList')).forEach(b => b.onclick = () => background(api.sys.openExternal(b.dataset.get ?? '')));
    const missing = d.tools.filter(t => !t.found).map(t => t.name);
    $('#toolsPill').className = missing.length ? 'pill warn' : 'pill ok';
    $('#toolsPill').textContent = missing.length ? `${missing.join(' & ')} missing` : 'Ready';
    const summary = d.tools.map(t => `${t.name.replace('.js', '')} ${t.found ? 'ready' : 'missing'}`).join(' · ');
    $('#sbTools').innerHTML = `<span class="${missing.length ? 'dot-warn' : 'dot-ok'}"></span> ${summary}`;
    renderAgentPill();
}
$('#rescan').onclick = () => { detectTools().catch(() => { }); };
function selectedAgent() {
    return appState.detect?.agents.find(a => a.id === appState.agent && a.found) ?? null;
}
function modelLabel(a) {
    if (!a)
        return 'no agent';
    return a.api && a.version ? a.version : a.name;
}
function renderAgentPill() {
    const a = selectedAgent();
    $('#agentPill').textContent = a ? a.name : 'Choose an agent';
    agentsDef.planner.model = agentsDef.builder.model = modelLabel(a);
    renderAgents();
}
$('#agentPill').onclick = openAgentPicker;
function openAgentPicker() {
    openModal(`<h3>Choose your AI agent</h3><p class="sub">Installed coding agents are found automatically. Gemini works with an API key.</p>
    <div class="agent-list" id="pickList"></div>
    <div class="row between spaced"><button class="btn btn-sm btn-ghost" id="pickRescan">Scan again</button><button class="btn btn-primary" data-close>Done</button></div>`, m => {
        const scanning = '<div class="text-3">Scanning…</div>';
        const render = () => {
            if (!appState.detect) {
                $('#pickList', m).innerHTML = scanning;
                return;
            }
            $('#pickList', m).innerHTML = agentOptionsHtml(appState.detect);
            bindAgentOptions($('#pickList', m), () => { render(); renderDetection(); });
        };
        render();
        $('#pickRescan', m).onclick = () => { $('#pickList', m).innerHTML = scanning; detectTools().then(render, () => { }); };
    });
}
/* ----- Start a project ----- */
let projMode = 'describe';
function renderProjectChoice() {
    $$('[data-seg]').forEach(x => x.classList.toggle('on', x.dataset.seg === projMode));
    $('#projPrompt').classList.toggle('hidden', projMode !== 'describe');
    $('#projFolderRow').classList.toggle('hidden', projMode !== 'folder');
    $('#projFolder').textContent = rootInfo ? rootInfo.root : 'No folder chosen';
}
$$('[data-seg]').forEach(b => b.onclick = () => { projMode = b.dataset.seg ?? 'describe'; renderProjectChoice(); });
$('#pickFolder').onclick = () => background(api.fs.openFolder().then(async (r) => {
    if (!r)
        return;
    await loadWorkspace(r);
    renderProjectChoice();
}));
$('#startBuilding').onclick = () => {
    appState.onboarded = true;
    saveApp();
    showIde();
    const p = $('#projPrompt').value.trim();
    if (projMode === 'describe' && p)
        $('#prompt').value = p;
};
function showIde() {
    $('#onboard').classList.add('hidden');
    $('#ide').classList.remove('hidden');
    renderUser();
    applyLayout();
    renderEditor();
}
/* ================= Agents (data) ================= */
const agentsDef = {
    planner: { name: 'Planner', letter: 'P', tint: 'planner', model: 'no agent', status: 'idle', task: 'Waiting for a prompt', used: 0 },
    builder: { name: 'Builder', letter: 'B', tint: 'builder', model: 'no agent', status: 'idle', task: 'Waiting for a plan', used: 0 },
};
const statusLabel = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', done: 'Done' };
const LANGS = {
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
const extOf = (path) => { const n = baseName(path).toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''; };
function langOf(path) {
    if (baseName(path).toLowerCase().startsWith('.env'))
        return ['py', 'Environment'];
    return LANGS[extOf(path)] ?? ['', 'Plain Text'];
}
const either = (...patterns) => new RegExp(patterns.map(p => p.source).join('|'));
const lexer = (rules, flags = 'g') => new RegExp(rules.map(([kind, p]) => `(?<${kind}>${p.source})`).join('|'), flags);
const keywords = (list) => new RegExp(String.raw `\b(?:${list.replaceAll(' ', '|')})\b`);
const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set type interface enum implements private public protected readonly declare as true false null undefined';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
const LINE_COMMENT = /\/\/[^\n]*/;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/;
const QUOTED = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/;
const BACKTICKED = /`(?:\\[\s\S]|[^`\\])*`?/;
const NUMBER = either(/\b0[xX][\da-fA-F]+\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/);
const CALL = /\b[A-Za-z_$][\w$]*(?=\()/;
const LEXERS = {
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
function lex(text, re) {
    const out = [];
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!m[0]) {
            re.lastIndex++;
            continue;
        }
        if (m.index > last)
            out.push([null, text.slice(last, m.index)]);
        const groups = m.groups ?? {};
        const kind = Object.keys(groups).find(k => groups[k] !== undefined) ?? null;
        if (kind === 'tagblock')
            out.push(...lex(m[0], HTML_TAG)); // lex() resets lastIndex of the inner regex only
        else
            out.push([kind, m[0]]);
        last = m.index + m[0].length;
    }
    if (last < text.length)
        out.push([null, text.slice(last)]);
    return out;
}
// CSS: plain text outside any { } block is a selector.
function markSelectors(toks) {
    let depth = 0;
    const out = [];
    for (const [cls, text] of toks) {
        if (cls) {
            out.push([cls, text]);
            continue;
        }
        for (const part of text.split(/([{}])/)) {
            if (part === '{')
                depth++;
            else if (part === '}')
                depth = Math.max(0, depth - 1);
            const selector = depth === 0 && part !== '}' && part.trim() !== '';
            out.push([selector ? 'tag' : null, part]);
        }
    }
    return out;
}
// Highlight a whole document and return one HTML string per line (tokens can span lines).
function highlightLines(text, lexerName) {
    if (!LEXERS[lexerName] || text.length > 400000)
        return text.split('\n').map(esc);
    const lines = [''];
    const toks = lex(text, LEXERS[lexerName]);
    for (const [cls, t] of lexerName === 'css' ? markSelectors(toks) : toks) {
        t.split('\n').forEach((part, i) => {
            if (i > 0)
                lines.push('');
            if (part)
                lines[lines.length - 1] += cls ? `<span class="tk-${cls}">${esc(part)}</span>` : esc(part);
        });
    }
    return lines;
}
const COMMENT = { js: ['// ', ''], py: ['# ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };
const LINT_MAX = 400000;
const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = ')]}';
const SPACE = ' \n\t\r';
// A "/" starts a regex (not a division) after an operator, an opening bracket or one of these keywords.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof))\s*$/;
const JS_SCAN = { lineCom: '//', blockCom: true, quotes: `'"`, template: true, regex: true };
const CSS_SCAN = { blockCom: true, quotes: `'"` };
const PY_SCAN = { lineCom: '#', quotes: `'"`, triple: true };
const neverClosed = (s) => ({ at: s.at, len: 1, msg: s.tmpl == null ? `'${s.ch}' is never closed` : 'Template expression is never closed (missing })' });
// Finds unbalanced brackets and unclosed strings/comments. Also returns the text with comments and
// string contents blanked (same length), so later checks don't trip over them.
class CodeScanner {
    diags = [];
    out = [];
    stack = [];
    i = 0;
    last = 0;
    t;
    o;
    constructor(t, o) { this.t = t; this.o = o; }
    run() {
        while (this.i < this.t.length)
            this.step();
        for (const s of this.stack)
            this.diags.push(neverClosed(s));
        this.out.push(this.t.slice(this.last));
        return { diags: this.diags, masked: this.out.join('') };
    }
    // Python joins lines inside strings so a multi-line string reads as one logical line.
    mask(from, to) {
        this.out.push(this.t.slice(this.last, from), this.t.slice(from, to).replace(this.o.triple ? /[^]/g : /[^\n]/g, ' '));
        this.last = to;
    }
    step() {
        const c = this.t[this.i];
        if (SPACE.includes(c)) {
            this.i++;
            return;
        }
        if (this.comment(c) || this.quoted(c) || this.regex(c))
            return;
        if (PAIRS[c]) {
            this.stack.push({ ch: c, at: this.i });
            this.i++;
            return;
        }
        if (CLOSERS.includes(c)) {
            this.close(c);
            return;
        }
        this.i++;
    }
    comment(c) {
        const { t, o, i } = this;
        if (o.lineCom && t.startsWith(o.lineCom, i) && (o.regex || t[i - 1] !== ':')) {
            const e = lineEnd(t, i);
            this.mask(i, e);
            this.i = e;
            return true;
        }
        if (!o.blockCom || c !== '/' || t[i + 1] !== '*')
            return false;
        const e = t.indexOf('*/', i + 2);
        if (e === -1)
            this.unclosed(i, 2, 'Comment is never closed (missing */)');
        else {
            this.mask(i, e + 2);
            this.i = e + 2;
        }
        return true;
    }
    // The rest of the file was swallowed by something that never ends.
    unclosed(at, len, msg) {
        this.diags.push({ at, len, msg });
        this.mask(at + len, this.t.length);
        this.i = this.t.length;
    }
    quoted(c) {
        const { t, o, i } = this;
        if (o.triple && (t.startsWith('"""', i) || t.startsWith("'''", i))) {
            const q = t.slice(i, i + 3), e = t.indexOf(q, i + 3);
            if (e === -1)
                this.unclosed(i, 3, `String is never closed (missing ${q})`);
            else {
                this.mask(i + 3, e);
                this.i = e + 3;
            }
            return true;
        }
        if (o.template && c === '`') {
            this.i = this.template(i + 1, i);
            return true;
        }
        if (!o.quotes.includes(c))
            return false;
        let j = i + 1;
        while (j < t.length && t[j] !== c && t[j] !== '\n')
            j += t[j] === '\\' ? 2 : 1;
        if (t[j] === c) {
            this.mask(i + 1, j);
            this.i = j + 1;
            return true;
        }
        if (o.jsx) {
            this.i++;
            return true;
        } // JSX text can hold a lone apostrophe
        this.diags.push({ at: i, len: Math.max(1, j - i), msg: `String is never closed (missing ${c})` });
        this.mask(i + 1, j);
        this.i = j;
        return true;
    }
    // Continues a template literal from `from` (just after ` or after a ${…}); returns where code resumes.
    template(from, start) {
        const t = this.t;
        for (let j = from; j < t.length; j++) {
            if (t[j] === '\\')
                j++;
            else if (t[j] === '`') {
                this.mask(from, j);
                return j + 1;
            }
            else if (t[j] === '$' && t[j + 1] === '{') {
                this.mask(from, j);
                this.stack.push({ ch: '{', at: j + 1, tmpl: start });
                return j + 2;
            }
        }
        this.diags.push({ at: start, len: 1, msg: 'Template literal is never closed (missing `)' });
        this.mask(from, t.length);
        return t.length;
    }
    regex(c) {
        const { t, i } = this;
        if (!this.o.regex || c !== '/' || !REGEX_AFTER.test(t.slice(Math.max(0, i - 12), i)))
            return false;
        let j = i + 1, inClass = false;
        while (j < t.length && t[j] !== '\n' && (inClass || t[j] !== '/')) {
            if (t[j] === '\\')
                j++;
            else if (t[j] === '[')
                inClass = true;
            else if (t[j] === ']')
                inClass = false;
            j++;
        }
        if (t[j] !== '/')
            return false; // a division after all
        this.mask(i + 1, j);
        this.i = j + 1;
        return true;
    }
    close(c) {
        if (!this.stack.some(s => PAIRS[s.ch] === c)) {
            this.diags.push({ at: this.i, len: 1, msg: `Unexpected '${c}'` });
            this.i++;
            return;
        }
        // Anything opened after the matching bracket was left open.
        while (PAIRS[this.stack.at(-1)?.ch ?? ''] !== c)
            this.diags.push(neverClosed(this.stack.pop()));
        const open = this.stack.pop();
        this.i = open.tmpl == null ? this.i + 1 : this.template(this.i + 1, open.tmpl);
    }
}
const scanCode = (t, o) => new CodeScanner(t, o).run();
// A small JSON parser that reports where the first mistake is. `loose` allows comments and trailing commas (tsconfig etc.).
class JsonChecker {
    i = 0;
    t;
    loose;
    constructor(t, loose) { this.t = t; this.loose = loose; }
    check() {
        try {
            this.ws();
            if (this.i >= this.t.length)
                return [];
            this.value();
            this.ws();
            if (this.i < this.t.length)
                this.fail('Unexpected text after the end of the JSON');
            return [];
        }
        catch (e) {
            if (e instanceof JsonMistake)
                return [e.diag];
            throw e;
        }
    }
    fail(msg, at = this.i, len = 1) { throw new JsonMistake({ at, len, msg }); }
    get ended() { return this.i >= this.t.length; }
    ws() {
        const t = this.t;
        while (!this.ended) {
            if (SPACE.includes(t[this.i]))
                this.i++;
            else if (this.loose && t.startsWith('//', this.i))
                this.i = lineEnd(t, this.i);
            else if (this.loose && t.startsWith('/*', this.i))
                this.skipComment();
            else
                return;
        }
    }
    skipComment() {
        const e = this.t.indexOf('*/', this.i + 2);
        if (e === -1)
            this.fail('Comment is never closed (missing */)', this.i, 2);
        this.i = e + 2;
    }
    str() {
        const t = this.t, s = this.i++;
        while (!this.ended && t[this.i] !== '"' && t[this.i] !== '\n')
            this.i += t[this.i] === '\\' ? 2 : 1;
        if (t[this.i] !== '"')
            this.fail('String is never closed (missing ")', s, Math.max(1, this.i - s));
        this.i++;
    }
    // The items of an object or array, up to the closing bracket.
    list(close, item) {
        this.i++;
        this.ws();
        if (this.t[this.i] === close) {
            this.i++;
            return;
        }
        for (;;) {
            item();
            this.ws();
            if (this.t[this.i] === close) {
                this.i++;
                return;
            }
            if (this.t[this.i] !== ',')
                this.fail(this.ended ? `Expected '${close}' but the file ended` : `Expected ',' or '${close}'`);
            const comma = this.i++;
            this.ws();
            if (this.t[this.i] === close) {
                if (!this.loose)
                    this.fail('Trailing commas are not allowed in JSON', comma);
                this.i++;
                return;
            }
        }
    }
    member() {
        this.ws();
        const c = this.t[this.i];
        if (c !== '"') {
            if (this.ended)
                this.fail('Expected a property name but the file ended');
            this.fail(/['\w$]/.test(c) ? 'Property names need double quotes' : 'Expected a property name');
        }
        this.str();
        this.ws();
        if (this.t[this.i] !== ':')
            this.fail("Expected ':' after the property name");
        this.i++;
        this.value();
    }
    value() {
        this.ws();
        const c = this.t[this.i];
        if (c === '{') {
            this.list('}', () => this.member());
            return;
        }
        if (c === '[') {
            this.list(']', () => this.value());
            return;
        }
        if (c === '"') {
            this.str();
            return;
        }
        const word = ['true', 'false', 'null'].find(w => this.t.startsWith(w, this.i));
        if (word) {
            this.i += word.length;
            return;
        }
        const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
        num.lastIndex = this.i;
        const hit = num.exec(this.t);
        if (hit) {
            this.i += hit[0].length;
            return;
        }
        if (c === "'")
            this.fail('Strings need double quotes in JSON');
        this.fail(this.ended ? 'Expected a value but the file ended' : `Unexpected '${c}'`);
    }
}
class JsonMistake extends Error {
    diag;
    constructor(diag) { super(diag.msg); this.diag = diag; }
}
// CSS: every declaration inside a rule needs "property: value", and a ';' before the next one.
function cssDeclMistake(text, at) {
    if (!text.includes(':'))
        return { at, len: text.length, msg: "Expected ':' between the property and its value" };
    const rows = text.split('\n');
    const k = rows.findIndex((r, n) => n < rows.length - 1 && r.includes(':') && /^\s*[-\w]+\s*:/.test(rows[n + 1]));
    return k === -1 ? null : { at: at + rows.slice(0, k + 1).join('\n').length, len: 1, msg: "Missing ';' at the end of this line" };
}
function lintCssDecls(masked) {
    const out = [];
    let depth = 0, seg = 0;
    for (let i = 0; i < masked.length; i++) {
        const c = masked[i];
        if (c !== '{' && c !== '}' && c !== ';')
            continue;
        const text = masked.slice(seg, i), s = text.trim();
        const mistake = depth > 0 && c !== '{' && s && !s.startsWith('@') ? cssDeclMistake(s, seg + text.indexOf(s[0])) : null;
        if (mistake)
            out.push(mistake);
        depth = Math.max(0, depth + (c === '{' ? 1 : 0) - (c === '}' ? 1 : 0));
        seg = i + 1;
    }
    return out;
}
// Python: block statements end in ':' and indentation has to line up.
const PY_BLOCK = /^(?:async\s+)?(if|elif|else|for|while|def|class|try|except|finally|with)\b/;
const bracketDelta = (ln) => [...ln].reduce((d, ch) => d + Number('([{'.includes(ch)) - Number(')]}'.includes(ch)), 0);
// Joins lines that continue inside brackets or after a backslash.
function logicalLines(masked) {
    const lines = [];
    let cur = null;
    let off = 0, depth = 0;
    for (const ln of masked.split('\n')) {
        const at = off;
        off += ln.length + 1;
        if (!cur && !ln.trim())
            continue;
        if (cur)
            cur.text += '\n' + ln;
        else
            cur = { at, text: ln };
        depth = Math.max(0, depth + bracketDelta(ln));
        if (depth === 0 && !/\\\s*$/.test(ln)) {
            lines.push(cur);
            cur = null;
        }
    }
    if (cur)
        lines.push(cur);
    return lines;
}
// The block's ':' sits outside any brackets (and isn't a := walrus).
function hasBlockColon(body) {
    let d = 0;
    for (let k = 0; k < body.length; k++) {
        const ch = body[k];
        if ('([{'.includes(ch))
            d++;
        else if (')]}'.includes(ch))
            d--;
        else if (ch === ':' && d === 0 && body[k + 1] !== '=')
            return true;
    }
    return false;
}
class PythonChecker {
    out = [];
    indents = [0];
    opener = null; // the keyword of the previous line, if it ended with ':'
    line(L) {
        const lead = /^[ \t]*/.exec(L.text)?.[0] ?? '';
        const body = L.text.trim();
        this.indent(L, lead);
        const kw = PY_BLOCK.exec(body)?.[1] ?? null;
        if (kw && !hasBlockColon(body))
            this.out.push({ at: L.at + L.text.trimEnd().length, len: 1, msg: `Expected ':' after the '${kw}' line` });
        this.opener = /:\s*$/.test(body) ? kw ?? '' : null;
    }
    indent(L, lead) {
        const ind = lead.replaceAll('\t', '        ').length;
        const top = this.indents.at(-1) ?? 0;
        const span = Math.max(1, lead.length);
        if (this.opener !== null && ind <= top) {
            const after = this.opener ? ` after the '${this.opener}' line` : '';
            this.out.push({ at: L.at + lead.length, len: 1, msg: 'Expected an indented block' + after });
        }
        else if (ind > top) {
            if (this.opener === null)
                this.out.push({ at: L.at, len: span, msg: 'Unexpected indent' });
            else
                this.indents.push(ind);
        }
        else if (ind < top) {
            while (this.indents.length > 1 && (this.indents.at(-1) ?? 0) > ind)
                this.indents.pop();
            if (this.indents.at(-1) !== ind)
                this.out.push({ at: L.at, len: span, msg: 'This indent does not match any outer block' });
        }
    }
}
function lintPython(masked) {
    const checker = new PythonChecker();
    for (const L of logicalLines(masked))
        checker.line(L);
    return checker.out;
}
// HTML (and strict XML/SVG): every element that needs a closing tag gets one, in the right order.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp']);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const JS_TYPES = new Set(['module', 'text/javascript', 'application/javascript']);
const MARKUP = /<!--|<!\[CDATA\[|<[!?]|<\/?([A-Za-z][\w:.-]*)/g;
class MarkupChecker {
    out = [];
    stack = [];
    lower;
    re = new RegExp(MARKUP.source, 'g');
    t;
    xml;
    constructor(t, xml) {
        this.t = t;
        this.xml = xml;
        this.lower = xml ? t : t.toLowerCase();
    }
    run() {
        for (let m = this.re.exec(this.t); m; m = this.re.exec(this.t))
            if (!this.token(m))
                break;
        for (const s of this.stack)
            if (this.needsEnd(s.name))
                this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed` });
        return this.out;
    }
    needsEnd(name) { return this.xml || !OPTIONAL_END.has(name); }
    isVoid(name) { return !this.xml && VOID_TAGS.has(name); }
    // Handles one match; false stops the scan (the rest of the file is unreadable).
    token(m) {
        if (m[0] === '<!--')
            return this.skipTo(m, '-->', 'Comment');
        if (m[0] === '<![CDATA[')
            return this.skipTo(m, ']]>', 'CDATA section');
        if (!m[1])
            return this.skipTo(m, '>', 'Tag');
        const end = this.tagEnd(m);
        if (end === -1)
            return true;
        const name = this.xml ? m[1] : m[1].toLowerCase();
        const tag = { name, at: m.index, len: end + 1 - m.index };
        this.re.lastIndex = end + 1;
        if (m[0][1] === '/')
            this.closeTag(tag, m[1]);
        else
            this.openTag(tag, m[0].length, this.t.slice(m.index + m[0].length, end));
        return true;
    }
    skipTo(m, end, what) {
        const e = this.t.indexOf(end, m.index + m[0].length);
        if (e === -1) {
            this.out.push({ at: m.index, len: m[0].length, msg: `${what} is never closed (missing ${end})` });
            return false;
        }
        this.re.lastIndex = e + end.length;
        return true;
    }
    // Finds the tag's '>' while skipping quoted attribute values; -1 (and a problem) when there is none.
    tagEnd(m) {
        const t = this.t;
        let j = m.index + m[0].length, q = '';
        for (; j < t.length; j++) {
            const c = t[j];
            if (q) {
                if (c === q)
                    q = '';
            }
            else if (c === '"' || c === "'")
                q = c;
            else if (c === '>' || c === '<')
                break;
        }
        if (t[j] === '>')
            return j;
        const msg = q ? `Attribute value is never closed (missing ${q})` : `<${m[1]}> tag is never closed (missing >)`;
        this.out.push({ at: m.index, len: m[0].length, msg });
        this.re.lastIndex = j;
        return -1;
    }
    closeTag(tag, raw) {
        if (this.isVoid(tag.name)) {
            this.out.push({ ...tag, msg: `<${raw}> never takes a closing tag` });
            return;
        }
        const k = this.stack.map(s => s.name).lastIndexOf(tag.name);
        if (k < 0) {
            this.out.push({ ...tag, msg: `Unexpected </${raw}>: no <${raw}> is open here` });
            return;
        }
        for (const s of this.stack.splice(k).slice(1)) {
            if (this.needsEnd(s.name))
                this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed (expected </${s.name}> before </${raw}>)` });
        }
    }
    openTag(tag, nameLen, attrs) {
        if (attrs.endsWith('/') || this.isVoid(tag.name))
            return;
        this.stack.push({ name: tag.name, at: tag.at, len: nameLen });
        if (!this.xml && RAW_TAGS.has(tag.name))
            this.rawText(tag.name, attrs);
    }
    // <script>, <style>…: skip to the closing tag, checking the code inside on the way.
    rawText(name, attrs) {
        const from = this.re.lastIndex;
        const end = this.lower.indexOf(`</${name}`, from);
        if (end === -1) {
            this.re.lastIndex = this.t.length;
            return;
        } // reported as never closed
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1].toLowerCase();
        let opts = null;
        if (name === 'style')
            opts = CSS_SCAN;
        else if (name === 'script' && (!type || JS_TYPES.has(type)))
            opts = JS_SCAN;
        if (opts)
            for (const d of scanCode(this.t.slice(from, end), opts).diags)
                this.out.push({ ...d, at: d.at + from });
        this.re.lastIndex = end;
    }
}
const JS_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const V8_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']); // JSX/TSX need a JSX-aware parser
const looseJson = (path) => /^(?:tsconfig|jsconfig)\b/i.test(baseName(path)) || path.startsWith('.vscode/');
function lintCss(text, ext) {
    const r = scanCode(text, ext === 'css' ? CSS_SCAN : { ...CSS_SCAN, lineCom: '//' });
    return ext === 'css' && !r.diags.length ? lintCssDecls(r.masked) : r.diags;
}
function lintPy(text) {
    const r = scanCode(text, PY_SCAN);
    return r.diags.length ? r.diags : lintPython(r.masked);
}
// Which check runs for each file extension.
const LINTERS = {
    json: (t, p) => new JsonChecker(t, looseJson(p)).check(),
    jsonc: t => new JsonChecker(t, true).check(),
    css: t => lintCss(t, 'css'), scss: t => lintCss(t, 'scss'), less: t => lintCss(t, 'less'),
    html: t => new MarkupChecker(t, false).run(), htm: t => new MarkupChecker(t, false).run(), vue: t => new MarkupChecker(t, false).run(),
    xml: t => new MarkupChecker(t, true).run(), svg: t => new MarkupChecker(t, true).run(),
    py: lintPy,
};
for (const ext of JS_EXT)
    LINTERS[ext] = t => scanCode(t, { ...JS_SCAN, jsx: ext === 'jsx' || ext === 'tsx' }).diags;
function lintStructure(text, path) {
    return LINTERS[extOf(path)]?.(text, path) ?? [];
}
function toDiags(t, raw) {
    const starts = [0];
    for (let k = t.indexOf('\n'); k !== -1; k = t.indexOf('\n', k + 1))
        starts.push(k + 1);
    return raw.map(d => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= d.at)
                lo = mid;
            else
                hi = mid - 1;
        }
        return { line: lo, col: d.at - starts[lo], len: d.len, msg: d.msg };
    }).sort((a, b) => a.line - b.line || a.col - b.col);
}
/* ----- Colored file & folder icons (16×16 inline SVG) ----- */
const svg16 = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
const badge = (bg, fg, label, size = 6.4) => svg16(`<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/><text x="8" y="11.2" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="${size}" fill="${fg}">${label}</text>`);
const page = (color, inner = '') => svg16(`<path d="M3.5 1.5h6l3 3v10h-9z" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>${inner}`);
const ICONS = {
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
const EXT_ICON = {
    html: 'html', htm: 'html', xml: 'html', vue: 'html', css: 'css', less: 'css', scss: 'scss', sass: 'scss',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', tsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', json: 'json', jsonc: 'json', md: 'md', markdown: 'md',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image', svg: 'svg',
    py: 'py', sh: 'shell', bash: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell', yml: 'config', yaml: 'config', toml: 'config', ini: 'config',
    txt: 'text', log: 'text', csv: 'text', lock: 'lock',
};
function fileIcon(name) {
    const n = name.toLowerCase();
    if (n.startsWith('.env'))
        return ICONS.env;
    if (n.startsWith('.git'))
        return ICONS.git;
    if (n === 'package.json' || n === 'package-lock.json' || n === '.npmrc' || n === '.nvmrc')
        return ICONS.node;
    if (n.startsWith('license'))
        return ICONS.license;
    if (/^(tsconfig|jsconfig)[\w.-]*\.json$/.test(n))
        return ICONS.ts;
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
    return ICONS[EXT_ICON[ext] ?? 'file'];
}
// Folder colours follow what the folder usually holds.
const FOLDER_COLORS = [
    [/^(src|app|lib|source)$/, '#7aa9ff'], [/^(node_modules)$/, '#8cc84b'], [/^\.git$/, '#f05033'], [/^\.(claude|vscode|idea|github)$/, '#d97757'],
    [/^(assets|images?|img|public|static|media|icons?)$/, '#ffb74d'], [/^(tests?|__tests__|spec)$/, '#4db6ac'], [/^(dist|build|out|\.next)$/, '#9e9e9e'],
    [/^(components?|ui|views?|pages?)$/, '#c4b5fd'], [/^(styles?|css)$/, '#42a5f5'], [/^(docs?)$/, '#6aa8d8'],
];
function folderIcon(name, open) {
    const c = FOLDER_COLORS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? '#90a4c4';
    return open
        ? svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h5.7a1 1 0 0 1 1 1V7H4.2a1 1 0 0 0-.95.68L1.5 12.5z" fill="${c}" fill-opacity=".55"/><path d="M3.3 7.7A1 1 0 0 1 4.25 7h10.3l-1.9 5.8a1 1 0 0 1-.95.7H1.5z" fill="${c}"/>`)
        : svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h6.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="${c}"/><path d="M1.5 6h13" stroke="#000" stroke-opacity=".18"/>`);
}
const CHEV = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let rootInfo = null;
const dirCache = new Map();
const expanded = new Set();
const buffers = new Map();
const textareaOwner = new WeakMap();
let openTabs = [];
let active = null;
const locks = {};
const added = {};
let guestCursor = null;
let ctxPath = null;
const sessionKey = () => `breeze.session:${rootInfo?.root ?? ''}`;
const hotExitKey = () => `breeze.dirty:${rootInfo?.root ?? ''}`;
const isDirty = (b) => !!b && b.kind === 'text' && b.text !== b.saved;
let sessionTimer;
function saveSession() {
    if (!rootInfo)
        return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(flushSession, 300);
}
function flushSession() {
    if (!rootInfo)
        return;
    clearTimeout(sessionTimer);
    const pos = {};
    for (const b of buffers.values())
        if (b.ta)
            pos[b.path] = [b.ta.selectionStart, b.ta.scrollTop];
    store.set(sessionKey(), { tabs: openTabs, active, expanded: [...expanded], pos });
    // Hot exit: unsaved edits survive a reload or a crash.
    const dirty = {};
    for (const b of buffers.values())
        if (isDirty(b))
            dirty[b.path] = b.text;
    if (Object.keys(dirty).length)
        store.set(hotExitKey(), dirty);
    else
        store.del(hotExitKey());
}
window.addEventListener('beforeunload', flushSession);
// Puts back a tab's unsaved text and caret from the last session.
function restoreBuffer(b, s, dirty) {
    if (b.kind === 'text' && dirty[b.path] != null) {
        b.text = dirty[b.path];
        if (b.ta)
            b.ta.value = b.text;
    }
    const pos = s.pos[b.path];
    if (b.ta && pos) {
        b.ta.setSelectionRange(pos[0], pos[0]);
        b.ta.scrollTop = pos[1];
    }
}
async function loadWorkspace(info) {
    if (rootInfo) {
        flushSession();
        resetWorkspace();
    }
    rootInfo = info;
    $('#projectName').textContent = info.name;
    $('#projectName').title = info.root;
    document.title = `${info.name} — Breeze IDE`;
    const s = store.get(sessionKey(), { tabs: [], active: null, expanded: [], pos: {} });
    const dirty = store.get(hotExitKey(), {});
    expanded.clear();
    for (const d of s.expanded)
        expanded.add(d);
    await Promise.all(['', ...s.expanded].map(loadDir));
    renderTree();
    const loaded = await Promise.all(s.tabs.map(loadBuffer));
    for (const b of loaded) {
        if (!b)
            continue;
        restoreBuffer(b, s, dirty);
        openTabs.push(b.path);
    }
    active = s.active && openTabs.includes(s.active) ? s.active : openTabs[0] ?? null;
    renderTabs();
    renderEditor();
    renderTree();
    restoreChat();
    void refreshGit();
    term.cwd = await api.term.cwd();
    renderPs();
}
function resetWorkspace() {
    for (const b of buffers.values())
        b.ta?.remove();
    buffers.clear();
    dirCache.clear();
    expanded.clear();
    openTabs = [];
    active = null;
    rootInfo = null;
    stopPreview();
    $('#projectName').textContent = 'No folder';
    document.title = 'Breeze IDE';
    gitState = { repo: false };
    gitLog = { head: null, commits: [] };
    renderScm();
    renderBranch();
    emptyChat();
}
async function loadDir(rel) {
    try {
        dirCache.set(rel, await api.fs.readDir(rel));
    }
    catch {
        dirCache.delete(rel);
        expanded.delete(rel);
    } // gone or unreadable: show it collapsed
}
function kindOf(r) {
    if (r.image)
        return 'image';
    if (r.binary)
        return 'binary';
    return r.tooLarge ? 'large' : 'text';
}
async function loadBuffer(path) {
    const existing = buffers.get(path);
    if (existing)
        return existing;
    let r;
    try {
        r = await api.fs.readFile(path);
    }
    catch (e) {
        toast(`Couldn't open ${baseName(path)}: ${errMsg(e)}`);
        return null;
    }
    const raw = r.text ?? '';
    const b = {
        path, size: r.size, kind: kindOf(r),
        eol: raw.includes('\r\n') ? '\r\n' : '\n',
        text: raw.replaceAll('\r\n', '\n'), saved: '', ta: null,
        undo: [], redo: [], lastEdit: null,
    };
    b.saved = b.text;
    if (b.kind === 'image')
        b.url = await api.fs.fileUrl(path).catch(() => '');
    if (b.kind === 'text') {
        b.ta = createTextarea(b);
        scheduleLint(b, 0);
    }
    buffers.set(path, b);
    return b;
}
/* ----- Syntax errors for a buffer ----- */
function scheduleLint(b, delay = 450) {
    clearTimeout(b.lintTimer);
    b.lintTimer = setTimeout(() => void lintBuffer(b), delay);
}
// V8 has the final word on JavaScript/TypeScript: it is exact, and clean code clears any false alarm.
// When both find something, the structural messages win on shared lines (they say more).
function mergeSyntax(diags, r) {
    if (!r)
        return diags;
    if ('ok' in r)
        return [];
    if (diags.length && (r.eof || diags.some(d => d.line === r.line)))
        return diags;
    return [...diags, { line: r.line, col: r.col, len: r.len, msg: r.msg }].sort((x, y) => x.line - y.line);
}
async function lintBuffer(b) {
    if (b.kind !== 'text' || buffers.get(b.path) !== b)
        return;
    const seq = b.lintSeq = (b.lintSeq ?? 0) + 1;
    const text = b.text, ext = extOf(b.path);
    let diags = [];
    if (text.length <= LINT_MAX) {
        diags = toDiags(text, lintStructure(text, b.path));
        if (V8_EXT.has(ext)) {
            const r = await api.lint.check(text, ext).catch(() => null);
            if (seq !== b.lintSeq)
                return; // a newer check is on its way
            diags = mergeSyntax(diags, r);
        }
    }
    const had = !!b.diags?.length;
    b.diags = diags;
    b.diagLines = text.split('\n').length;
    if (had !== !!diags.length)
        renderTabs();
    if (b.path === active)
        renderCode();
}
// Each open file keeps its own textarea (and history) across tab switches.
function createTextarea(b) {
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
        if (wasDirty !== isDirty(b)) {
            renderTabs();
            renderTree();
        }
        if (findOpen)
            runFind(false);
        queueRender();
        saveSession();
        scheduleLint(b);
    });
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', editorKeys);
    for (const ev of ['keyup', 'mouseup', 'select', 'selectionchange', 'focus'])
        ta.addEventListener(ev, updateCaret);
    $('#editor .code').appendChild(ta);
    return ta;
}
/* ----- Undo & redo ----- */
// The editor records its own history, so edits made by commands (indent, comment, move line…) undo
// exactly like typing. Typing groups into words; a pause of a second starts a new step.
const GROUPED = new Set(['type', 'deleteContentBackward', 'deleteContentForward']);
function remember(b, kind) {
    const ta = b.ta;
    if (!ta)
        return;
    const now = Date.now();
    const grouped = GROUPED.has(kind) && b.lastEdit?.kind === kind && now - b.lastEdit.at < 1000;
    b.lastEdit = { kind, at: now };
    if (grouped)
        return;
    b.undo.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
    if (b.undo.length > 500)
        b.undo.shift();
    b.redo = [];
}
function beforeEdit(b, e) {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        stepHistory(b, e.inputType === 'historyUndo');
        return;
    }
    const word = e.inputType === 'insertText' && !!e.data && !/\s/.test(e.data);
    remember(b, word ? 'type' : e.inputType);
}
function stepHistory(b, back) {
    const ta = b.ta;
    const [from, to] = back ? [b.undo, b.redo] : [b.redo, b.undo];
    const snap = from.pop();
    if (!ta || !snap)
        return;
    to.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
    b.lastEdit = null;
    ta.value = snap.text;
    ta.setSelectionRange(snap.sel[0], snap.sel[1]);
    ta.dispatchEvent(new Event('input'));
    revealOffset(b, snap.sel[0]);
}
/* ================= Explorer ================= */
const GIT_LETTER = { 'git-m': 'M', 'git-u': 'U', 'git-a': 'A', 'git-d': 'D' };
function chevClass(e, open) {
    if (!e.dir)
        return 'none';
    return open ? 'open' : '';
}
function treeRow(e, p, depth, decor, enter) {
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
function renderTree() {
    const el = $('#tree');
    if (!rootInfo) {
        el.innerHTML = `<div class="side-note">You have not opened a folder yet.<button class="btn btn-primary btn-sm" data-act="file.openFolder">Open Folder</button></div><div id="recentList"></div>`;
        void renderRecent();
        return;
    }
    const rows = [];
    const decor = gitDecor();
    const walk = (rel, depth) => {
        for (const e of dirCache.get(rel) ?? []) {
            const p = joinPath(rel, e.name);
            rows.push(treeRow(e, p, depth, decor, !!rel && rel === justExpanded));
            if (e.dir && expanded.has(p))
                walk(p, depth + 1);
        }
    };
    walk('', 0);
    el.innerHTML = rows.join('') || '<p class="side-note">This folder is empty.</p>';
    // Indentation is set through the DOM: the CSP allows no inline style attributes.
    for (const row of $$('[data-depth]', el))
        row.style.paddingLeft = `${4 + Number(row.dataset.depth) * 12}px`;
    justExpanded = null;
}
// The folder whose children should animate in on the next render.
let justExpanded = null;
async function renderRecent() {
    const recent = await api.fs.recent().catch(() => []);
    const el = document.getElementById('recentList');
    if (!el || !recent.length)
        return;
    const rows = recent.map(r => `<div class="tree-item" data-recent="${escAttr(r.path)}" title="${escAttr(r.path)}"><span class="ico">▸</span><span class="nm">${esc(r.name)}</span></div>`);
    el.innerHTML = '<div class="side-head pl-8">Recent</div>' + rows.join('');
}
$('#tree').addEventListener('click', e => {
    const t = e.target.closest('[data-path],[data-recent],[data-act]');
    if (!t || t.dataset.act)
        return; // data-act buttons are handled by the global listener
    if (t.dataset.recent) {
        void openRecentFolder(t.dataset.recent);
        return;
    }
    const p = t.dataset.path;
    if (t.dataset.dir)
        void toggleDir(p);
    else
        openFile(p);
});
$('#tree').addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!rootInfo)
        return;
    const t = e.target.closest('[data-path]');
    const p = t?.dataset.path ?? '';
    const isDir = !t || !!t.dataset.dir;
    ctxPath = p || null;
    renderTree();
    const dir = isDir ? p : dirName(p);
    const fileItems = p ? [
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
async function toggleDir(p) {
    if (expanded.has(p))
        expanded.delete(p);
    else {
        expanded.add(p);
        if (!dirCache.has(p))
            await loadDir(p);
        justExpanded = p;
    }
    renderTree();
    saveSession();
}
async function refreshTree() {
    if (!rootInfo)
        return;
    await Promise.all(['', ...expanded].map(loadDir));
    renderTree();
}
// The folder new files go into: right-clicked folder, else the active file's folder, else the root.
const targetDir = () => (active ? dirName(active) : '');
// Wraps a promise's resolve so only the first answer counts (a dialog can be confirmed and then closed).
function settleOnce(resolve) {
    let done = false;
    return v => {
        if (done)
            return;
        done = true;
        resolve(v);
    };
}
function askName(title, initial, okLabel) {
    return new Promise(res => {
        const finish = settleOnce(res);
        openModal(`<h3>${esc(title)}</h3><input class="input name-input" id="nameIn" aria-label="${escAttr(title)}" spellcheck="false" value="${escAttr(initial)}">
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nameOk">${okLabel}</button></div>`, m => {
            const input = $('#nameIn', m);
            input.focus();
            const dot = initial.lastIndexOf('.');
            input.setSelectionRange(0, dot > 0 ? dot : initial.length);
            const ok = () => { const v = input.value.trim(); if (v) {
                finish(v);
                closeModal();
            } };
            $('#nameOk', m).onclick = ok;
            input.onkeydown = e => { if (e.key === 'Enter')
                ok(); };
        }, () => finish(null));
    });
}
async function newEntry(dir, folder) {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    const name = await askName(folder ? 'New folder' : 'New file', '', 'Create');
    if (!name)
        return;
    const rel = joinPath(dir, name.replaceAll('\\', '/').replace(/^\/+/, ''));
    try {
        if (folder)
            await api.fs.createDir(rel);
        else
            await api.fs.createFile(rel);
    }
    catch (e) {
        toast(errMsg(e));
        return;
    }
    for (let d = dirName(rel); d; d = dirName(d))
        expanded.add(d);
    if (folder)
        expanded.add(rel);
    await refreshTree();
    saveSession();
    if (!folder)
        openFile(rel);
}
async function renameEntry(p) {
    const name = await askName('Rename', baseName(p), 'Rename');
    if (!name || name === baseName(p))
        return;
    if (/[\\/]/.test(name)) {
        toast('Names cannot contain slashes');
        return;
    }
    const to = joinPath(dirName(p), name);
    try {
        await api.fs.rename(p, to);
    }
    catch (e) {
        toast(errMsg(e));
        return;
    }
    const move = (x) => {
        if (x === p)
            return to;
        return x.startsWith(p + '/') ? to + x.slice(p.length) : x;
    };
    const moved = [...buffers.values()].filter(b => move(b.path) !== b.path);
    for (const b of moved) {
        buffers.delete(b.path);
        b.path = move(b.path);
        buffers.set(b.path, b);
        scheduleLint(b, 0);
    }
    await Promise.all(moved.filter(b => b.kind === 'image').map(async (b) => { b.url = await api.fs.fileUrl(b.path).catch(() => ''); }));
    openTabs = openTabs.map(move);
    if (active)
        active = move(active);
    const dirs = [...expanded];
    expanded.clear();
    for (const d of dirs)
        expanded.add(move(d));
    dirCache.clear();
    await refreshTree();
    renderTabs();
    renderEditor();
    saveSession();
}
const binName = () => (isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash');
function deleteEntry(p, isDir) {
    const what = isDir ? 'The folder and everything in it' : 'The file';
    const bin = binName();
    openModal(`<h3>Delete ${esc(baseName(p))}?</h3><p class="sub">${what} will be moved to the ${bin}, so you can restore it.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="delOk">Move to ${bin}</button></div>`, m => {
        $('#delOk', m).onclick = () => background((async () => {
            closeModal();
            await api.fs.trash(p);
            for (const path of openTabs.filter(x => x === p || x.startsWith(p + '/')))
                dropTab(path);
            expanded.delete(p);
            await refreshTree();
            renderTabs();
            renderEditor();
            saveSession();
        })());
    });
}
// Files changed on disk (by an agent, git or another editor): reload what isn't being edited.
async function reloadImage(b) {
    // Same file URL, new query: the viewer reloads the picture.
    const url = b.url ?? '';
    const q = url.indexOf('?');
    b.url = `${q === -1 ? url : url.slice(0, q)}?v=${Date.now()}`;
    b.size = (await api.fs.readFile(b.path).catch(() => null))?.size ?? b.size;
    if (b.path === active)
        renderEditor();
}
async function reloadText(b) {
    const r = await api.fs.readFile(b.path).catch(() => null); // deleted or unreadable: keep the buffer
    if (r?.text == null)
        return;
    const text = r.text.replaceAll('\r\n', '\n');
    if (text === b.saved || isDirty(b))
        return;
    remember(b, 'reload');
    b.text = b.saved = text;
    if (b.ta) {
        const s = b.ta.selectionStart;
        b.ta.value = text;
        b.ta.setSelectionRange(s, s);
    }
    if (b.path === active)
        renderCode();
    scheduleLint(b, 0);
}
api.fs.onChange(paths => background((async () => {
    queueGitRefresh();
    // Reload changed folders, and changed paths that are themselves cached folders (e.g. created then filled).
    const dirs = new Set([...paths.map(dirName), ...paths].filter(d => dirCache.has(d)));
    await Promise.all([...dirs].map(loadDir));
    renderTree();
    const changed = paths.map(p => buffers.get(p)).filter((b) => !!b);
    await Promise.all(changed.map(b => {
        if (b.kind === 'image' && b.url?.startsWith('file:'))
            return reloadImage(b);
        return b.kind === 'text' && !isDirty(b) ? reloadText(b) : null;
    }));
})()));
function openFile(path, at) {
    if (baseName(path).startsWith('.env') && !buffers.has(path)) {
        openModal(`<h3>This is a protected file</h3><p class="sub">${esc(baseName(path))} holds secrets. You can view it, but agents can't read it unless you allow it each time.</p><div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="openEnv">Open for me only</button></div>`, m => { $('#openEnv', m).onclick = () => { closeModal(); void actuallyOpen(path, at); }; });
        return;
    }
    void actuallyOpen(path, at);
}
async function actuallyOpen(path, at) {
    const b = await loadBuffer(path);
    if (!b)
        return;
    if (!openTabs.includes(path))
        openTabs.push(path);
    setActive(path);
    if (at && b.ta) {
        const off = offsetOf(b.text, at.line, at.col);
        b.ta.focus();
        b.ta.setSelectionRange(off, off + (at.len ?? 0));
        revealOffset(b, off);
    }
}
function setActive(path) {
    const changed = active !== path;
    active = path;
    renderTabs();
    renderEditor();
    renderTree();
    saveSession();
    if (changed)
        for (const el of [$('#hl'), $('#gutter')])
            el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    if (running && path && /\.(html?|css|js)$/i.test(path))
        $('#urlText').title = path;
}
const seenTabs = new Set();
function tabHtml(n) {
    const lock = locks[n];
    const b = buffers.get(n);
    const cls = ['tab', n === active ? 'on' : '', isDirty(b) ? 'dirty' : '', b?.diags?.length ? 'has-err' : '', seenTabs.has(n) ? '' : 'enter'].filter(Boolean).join(' ');
    seenTabs.add(n);
    const dot = lock ? `<span class="dot tint-${lock}"></span>` : '';
    return `<div class="${cls}" data-tab="${escAttr(n)}" title="${escAttr(n)}">${dot}<span class="ico">${fileIcon(baseName(n))}</span>${esc(baseName(n))}<span class="x" data-close-tab="1" title="Close (Ctrl+W)"><span>✕</span></span></div>`;
}
function renderTabs() {
    // Re-rendering mid-drag would drop the tab being dragged; catch up when it lands.
    if (tabDrag?.moved) {
        tabDrag.stale = true;
        return;
    }
    $('#tabs').innerHTML = openTabs.map(tabHtml).join('');
}
$('#tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (!tab || justDragged)
        return;
    const p = tab.dataset.tab;
    if (e.target.closest('[data-close-tab]'))
        closeTab(p);
    else
        setActive(p);
});
$('#tabs').addEventListener('wheel', e => {
    const t = e.currentTarget;
    if (!e.deltaX && e.deltaY) {
        t.scrollLeft += e.deltaY;
        e.preventDefault();
    }
}, { passive: false });
$('#tabs').addEventListener('auxclick', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab && e.button === 1)
        closeTab(tab.dataset.tab);
});
let tabDrag = null;
let justDragged = false;
const middle = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
function slideFrom(el, fromLeft) {
    const dx = fromLeft - el.getBoundingClientRect().left;
    if (dx)
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
// Moves `other` to the far side of the dragged tab, keeping the dragged tab under the pointer.
function swapTab(d, other, clientX) {
    const before = d.el.offsetLeft, otherLeft = other.getBoundingClientRect().left;
    if (other === d.el.nextElementSibling)
        d.el.before(other);
    else
        d.el.after(other);
    d.startX += d.el.offsetLeft - before;
    d.el.style.transform = `translateX(${clientX - d.startX}px)`;
    slideFrom(other, otherLeft);
}
function dragTabMove(e) {
    const d = tabDrag;
    if (!d)
        return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 5)
        return;
    if (!d.moved) {
        d.moved = true;
        d.el.classList.add('dragging');
        $('#tabs').classList.add('drag-active');
    }
    d.el.style.transform = `translateX(${dx}px)`;
    const mid = middle(d.el);
    const next = d.el.nextElementSibling, prev = d.el.previousElementSibling;
    if (next && mid > middle(next))
        swapTab(d, next, e.clientX);
    else if (prev && mid < middle(prev))
        swapTab(d, prev, e.clientX);
}
function dragTabEnd(e) {
    removeEventListener('pointermove', dragTabMove);
    removeEventListener('pointerup', dragTabEnd);
    const d = tabDrag;
    tabDrag = null;
    if (!d?.moved)
        return;
    // The click that follows a drag must not activate or close anything.
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    $('#tabs').classList.remove('drag-active');
    openTabs = $$('#tabs [data-tab]').map(t => t.dataset.tab);
    const rest = e.clientX - d.startX;
    setActive(d.path);
    const landed = $$('#tabs [data-tab]').find(t => t.dataset.tab === d.path);
    if (landed && rest)
        landed.animate([{ transform: `translateX(${rest}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
$('#tabs').addEventListener('pointerdown', e => {
    const t = e.target;
    const el = t.closest('[data-tab]');
    if (!el || e.button !== 0 || t.closest('[data-close-tab]'))
        return;
    tabDrag = { el, path: el.dataset.tab, startX: e.clientX, moved: false, stale: false };
    addEventListener('pointermove', dragTabMove);
    addEventListener('pointerup', dragTabEnd);
});
function dropTab(path) {
    const i = openTabs.indexOf(path);
    if (i === -1)
        return;
    openTabs.splice(i, 1);
    buffers.get(path)?.ta?.remove();
    buffers.delete(path);
    if (active === path)
        active = openTabs[Math.min(i, openTabs.length - 1)] ?? null;
}
function closeTab(path) {
    const b = buffers.get(path);
    const finish = () => { dropTab(path); renderTabs(); renderEditor(); renderTree(); saveSession(); };
    if (!isDirty(b)) {
        finish();
        return;
    }
    openModal(`<h3>Save changes to ${esc(baseName(path))}?</h3><p class="sub">Your changes will be lost if you don't save them.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dontSave">Don't Save</button><button class="btn btn-primary" id="doSave">Save</button></div>`, m => {
        $('#dontSave', m).onclick = () => { closeModal(); finish(); };
        $('#doSave', m).onclick = () => { closeModal(); background(saveFile(path).then(ok => { if (ok)
            finish(); })); };
    });
}
async function saveFile(path = active) {
    const b = path ? buffers.get(path) : undefined;
    if (b?.kind !== 'text')
        return false;
    const text = b.text;
    try {
        await api.fs.writeFile(b.path, b.eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text);
    }
    catch (e) {
        toast(`Couldn't save ${baseName(b.path)}: ${errMsg(e)}`);
        return false;
    }
    b.saved = text;
    renderTabs();
    renderTree();
    flushSession();
    if (running)
        void reloadPreview();
    return true;
}
async function saveAll() {
    const dirty = [...buffers.values()].filter(isDirty);
    await Promise.all(dirty.map(b => saveFile(b.path)));
    if (dirty.length)
        toast(`Saved ${plural(dirty.length, 'file')}`);
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
const activeBuf = () => (active ? buffers.get(active) : undefined);
function activeText() {
    const b = activeBuf();
    return b?.kind === 'text' && b.ta ? b : undefined;
}
function measureChar() {
    if (charW)
        return charW;
    const s = document.createElement('span');
    s.textContent = 'x'.repeat(200);
    s.style.visibility = 'hidden';
    hlInner.appendChild(s);
    charW = s.getBoundingClientRect().width / 200 || 7.8;
    s.remove();
    return charW;
}
void document.fonts?.ready.then(() => { charW = 0; renderCode(); });
const lineStart = (v, pos) => v.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (v, pos) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i; };
function lineAt(v, pos) {
    let n = 0;
    for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1))
        n++;
    return n;
}
function offsetOf(v, line, col) {
    let off = 0;
    for (let i = 0; i < line; i++) {
        const nl = v.indexOf('\n', off);
        if (nl === -1)
            return v.length;
        off = nl + 1;
    }
    return Math.min(off + col, lineEnd(v, off));
}
function visualCol(lineText, col) {
    let v = 0;
    for (let i = 0; i < col; i++)
        v = lineText[i] === '\t' ? v + 4 - (v % 4) : v + 1;
    return v;
}
function editorNote(b) {
    if (b.kind === 'binary')
        return 'This file is binary, so Breeze can\'t show it as text.';
    if (b.kind === 'image')
        return 'Breeze couldn\'t load this image.';
    return `This file is too large to open (${(b.size / 1048576).toFixed(1)} MB).`;
}
function renderEditor() {
    const b = activeBuf();
    for (const x of buffers.values())
        x.ta?.classList.toggle('hidden', x !== b);
    const empty = $('#editorEmpty');
    if (b?.kind !== 'text') {
        empty.classList.remove('hidden');
        if (b?.kind === 'image' && b.url)
            showImage(empty, b);
        else {
            empty.classList.remove('img-mode');
            delete empty.dataset.img;
            empty.innerHTML = b ? fileNoteHtml(b.path, editorNote(b)) : welcomeHtml();
        }
        hlInner.innerHTML = '';
        gutInner.innerHTML = '';
        closeFind();
        updateStatus();
        return;
    }
    empty.classList.add('hidden');
    if (findOpen)
        runFind(false);
    renderCode();
    if (document.activeElement === document.body || document.activeElement?.classList.contains('ta'))
        b.ta?.focus({ preventScroll: true });
}
const fileNoteHtml = (path, note) => `<div><h4>${esc(baseName(path))}</h4><div>${esc(note)}</div></div>`;
function fmtSize(n) {
    if (n < 1024)
        return `${n} B`;
    return n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
// Images open in a viewer: fitted to the editor, click to see them at actual size.
function showImage(el, b) {
    el.classList.add('img-mode');
    if (el.dataset.img === b.url)
        return; // already showing it: keep its zoom and scroll
    el.dataset.img = b.url;
    el.innerHTML = `<div class="img-stage fit"><img src="${escAttr(b.url ?? '')}" alt="${escAttr(baseName(b.path))}" draggable="false"></div>
    <div class="img-meta"><span class="img-dims">Loading…</span><span>${fmtSize(b.size)}</span><span class="img-zoom hidden"></span></div>`;
    const stage = $('.img-stage', el), img = $('img', el), zoom = $('.img-zoom', el);
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
        if (fit && !shrunk())
            return;
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
function welcomeHtml() {
    const k = (keys, what) => `<span>${what}</span><kbd>${keys}</kbd>`;
    const keys = rootInfo
        ? k('Ctrl+P', 'Go to file') + k('Ctrl+N', 'New file') + k('Ctrl+Shift+F', 'Search files') + k('Ctrl+`', 'Terminal')
        : k('Ctrl+O', 'Open folder') + k('Ctrl+B', 'Toggle side bar') + k('Ctrl+Alt+B', 'Toggle agents');
    return `<div><img src="Agent.png" alt=""><h4>${rootInfo ? 'No file open' : 'Open a folder to start'}</h4><div class="keys">${keys}</div></div>`;
}
function queueRender() {
    if (renderQueued)
        return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderCode(); });
}
// Overlay boxes (find hits, squiggles, a guest's caret) are placed through the DOM, not style attributes.
function box(cls, top, left, width) {
    const d = document.createElement('div');
    d.className = cls;
    d.style.top = `${top}px`;
    d.style.left = `${left}px`;
    if (width != null)
        d.style.width = `${width}px`;
    return d;
}
function findBoxes(b, cw) {
    if (!findOpen || !findLen)
        return [];
    const vis = findHits.length > 3000 ? findHits.slice(Math.max(0, findIdx - 1500), findIdx + 1500) : findHits;
    return vis.map(off => {
        const ln = lineAt(b.text, off), ls = lineStart(b.text, off);
        const lt = b.text.slice(ls, lineEnd(b.text, ls));
        const x = visualCol(lt, off - ls) * cw, w = (visualCol(lt, off - ls + findLen) * cw) - x;
        return box(off === findHits[findIdx] ? 'hit cur' : 'hit', ln * LINE_H, x, Math.max(w, 2));
    });
}
function guestCaret(b, cw) {
    if (guestCursor?.file !== b.path)
        return [];
    const c = box(`cursor tint-${guestCursor.tint}`, guestCursor.line * LINE_H + 2, 4 * cw);
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = guestCursor.name;
    c.append(who);
    return [c];
}
// Syntax errors: a red line, a squiggle under the mistake and the message after the code.
// While an edit has added or removed lines they wait for the next check instead of drifting.
function visibleDiags(b, lineCount) {
    const errAt = new Map();
    if (!b.diags?.length || b.diagLines !== lineCount)
        return errAt;
    for (const d of b.diags) {
        const ln = Math.min(d.line, lineCount - 1);
        if (!errAt.has(ln))
            errAt.set(ln, d);
    }
    return errAt;
}
function squiggles(b, lineCount, cw) {
    if (!b.diags?.length || b.diagLines !== lineCount)
        return [];
    const raw = b.text.split('\n');
    return b.diags.map(d => {
        const ln = Math.min(d.line, raw.length - 1), lt = raw[ln];
        const from = Math.min(d.col, lt.length), to = Math.min(lt.length, d.col + d.len);
        const x = visualCol(lt, from) * cw;
        return box('squig', ln * LINE_H + 15, x, Math.max(visualCol(lt, to) * cw - x, cw));
    });
}
function lineHtml(h, i, add, d) {
    const cls = ['ln', add?.has(i) ? 'added' : '', d ? 'err' : '', i === curLine ? 'cur-line' : ''].filter(Boolean).join(' ');
    const msg = d ? `<span class="diag-msg">${esc(d.msg)}</span>` : '';
    return `<div class="${cls}">${h}${msg}</div>`;
}
function gutterHtml(i, d) {
    const cls = [i === curLine ? 'cur' : '', d ? 'err' : ''].filter(Boolean).join(' ');
    const attrs = (cls ? ` class="${cls}"` : '') + (d ? ` title="${escAttr(d.msg)}"` : '');
    return `<div${attrs}>${i + 1}</div>`;
}
function renderCode() {
    const b = activeText();
    if (!b)
        return;
    const lines = highlightLines(b.text, langOf(b.path)[0]);
    curLine = lineAt(b.text, b.ta.selectionStart);
    const cw = measureChar();
    const errAt = visibleDiags(b, lines.length);
    const add = added[b.path];
    hlInner.innerHTML = lines.map((h, i) => lineHtml(h, i, add, errAt.get(i))).join('');
    hlInner.append(...findBoxes(b, cw), ...squiggles(b, lines.length, cw), ...guestCaret(b, cw));
    $('#gutter').style.width = `${Math.max(3, String(lines.length).length) * 8 + 32}px`;
    gutInner.innerHTML = lines.map((_, i) => gutterHtml(i, errAt.get(i))).join('');
    syncScroll();
    updateStatus();
}
function syncScroll() {
    const b = activeText();
    if (!b)
        return;
    hlInner.style.transform = `translate(${-b.ta.scrollLeft}px, ${-b.ta.scrollTop}px)`;
    gutInner.style.transform = `translateY(${-b.ta.scrollTop}px)`;
}
function updateCaret() {
    const b = activeText();
    if (!b)
        return;
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
function updateStatus() {
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
    if (!tb)
        return;
    const { selectionStart: s, selectionEnd: e } = tb.ta;
    const ls = lineStart(tb.text, s);
    const selected = e > s ? ` (${e - s} selected)` : '';
    $('#sbPos').textContent = `Ln ${lineAt(tb.text, s) + 1}, Col ${s - ls + 1}${selected}`;
}
// F8: move the caret to the next syntax error after it, wrapping around.
function nextProblem() {
    const b = activeText();
    if (!b?.diags?.length) {
        toast('No problems in this file');
        return;
    }
    const offs = b.diags.map(d => offsetOf(b.text, d.line, d.col));
    const off = offs.find(o => o > b.ta.selectionStart) ?? offs[0];
    b.ta.focus();
    b.ta.setSelectionRange(off, off);
    revealOffset(b, off);
}
function revealOffset(b, off) {
    if (!b.ta)
        return;
    const top = lineAt(b.text, off) * LINE_H;
    const ta = b.ta;
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - LINE_H * 3)
        ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    const ls = lineStart(b.text, off);
    const x = visualCol(b.text.slice(ls, lineEnd(b.text, ls)), off - ls) * measureChar();
    if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 80)
        ta.scrollLeft = Math.max(0, x - ta.clientWidth / 2);
    syncScroll();
    updateCaret();
}
// Replaces a range as one undoable step.
function replaceRange(ta, start, end, text, selStart, selEnd) {
    const b = textareaOwner.get(ta);
    if (b)
        remember(b, 'command');
    ta.focus();
    ta.setRangeText(text, start, end, 'end');
    if (selStart != null)
        ta.setSelectionRange(selStart, selEnd ?? selStart);
    ta.dispatchEvent(new Event('input'));
}
function selectedLines(ta) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    return [lineStart(v, s), lineEnd(v, e > s && v[e - 1] === '\n' ? e - 1 : e)];
}
function indentKey(ta, outdent) {
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    if (!outdent && !v.slice(s, en).includes('\n')) {
        replaceRange(ta, s, en, INDENT);
        return;
    }
    const [ls, le] = selectedLines(ta);
    const block = v.slice(ls, le);
    const lines = block.split('\n');
    const out = lines.map(l => (outdent ? l.replace(/^(?: {1,2}|\t)/, '') : INDENT + l)).join('\n');
    const firstDelta = out.split('\n')[0].length - lines[0].length;
    replaceRange(ta, ls, le, out, Math.max(ls, s + firstDelta), en + out.length - block.length);
}
// True when `before` ends with an opening tag such as <div class="x">.
function endsWithOpenTag(before) {
    const lt = before.lastIndexOf('<');
    if (lt === -1 || !before.endsWith('>'))
        return false;
    const tag = before.slice(lt);
    return /^<[A-Za-z]/.test(tag) && !tag.endsWith('/>');
}
function enterKey(ta) {
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const before = v.slice(lineStart(v, s), s);
    const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
    const isPy = langOf(active ?? '')[0] === 'py';
    const opens = /[{[(]\s*$/.test(before) || (isPy && /:\s*$/.test(before)) || (endsWithOpenTag(before) && v.slice(en).startsWith('</'));
    const extra = opens ? INDENT : '';
    // Between a pair like {|} the closing half moves to its own line.
    if (opens && /^\s*[}\])<]/.test(v.slice(en, lineEnd(v, en))))
        replaceRange(ta, s, en, `\n${indent}${extra}\n${indent}`, s + 1 + indent.length + extra.length);
    else
        replaceRange(ta, s, en, `\n${indent}${extra}`);
}
const plainKey = (e) => !e.ctrlKey && !e.altKey && !e.metaKey;
function editorKeys(e) {
    const ta = e.target;
    const b = textareaOwner.get(ta);
    const k = e.key.toLowerCase();
    if (b && (e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
        e.preventDefault();
        stepHistory(b, k === 'z' && !e.shiftKey);
    }
    else if (e.key === 'Tab' && plainKey(e)) {
        e.preventDefault();
        indentKey(ta, e.shiftKey);
    }
    else if (e.key === 'Enter' && plainKey(e) && !e.shiftKey) {
        e.preventDefault();
        enterKey(ta);
    }
}
// Removes one comment marker pair from a line, keeping its indentation.
function uncommentLine(l, open, close) {
    const indent = l.length - l.trimStart().length;
    let body = l.slice(indent);
    if (body.startsWith(open))
        body = body.slice(open.length).replace(/^ /, '');
    const trimmed = body.trimEnd();
    if (close && trimmed.endsWith(close))
        body = trimmed.slice(0, -close.length).replace(/ $/, '');
    return l.slice(0, indent) + body;
}
function toggleComment() {
    const b = activeText();
    if (!b)
        return;
    const c = COMMENT[langOf(b.path)[0]];
    if (!c) {
        toast('No comment syntax for this file type');
        return;
    }
    const ta = b.ta;
    const [ls, le] = selectedLines(ta);
    const lines = ta.value.slice(ls, le).split('\n');
    const [open, close] = c;
    const [o, cl] = [open.trim(), close.trim()];
    const isCommented = (l) => !l.trim() || (l.trimStart().startsWith(o) && (!cl || l.trimEnd().endsWith(cl)));
    const uncomment = lines.every(isCommented) && lines.some(l => l.trim());
    const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length));
    const out = lines.map(l => {
        if (!l.trim())
            return l;
        return uncomment ? uncommentLine(l, o, cl) : l.slice(0, minIndent) + open + l.slice(minIndent) + close;
    }).join('\n');
    replaceRange(ta, ls, le, out, ls, ls + out.length);
}
function moveLines(dir) {
    const b = activeText();
    if (!b)
        return;
    const ta = b.ta, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const [ls, le] = selectedLines(ta);
    const block = v.slice(ls, le);
    if (dir < 0) {
        if (ls === 0)
            return;
        const pls = lineStart(v, ls - 1);
        const prev = v.slice(pls, ls - 1);
        replaceRange(ta, pls, le, `${block}\n${prev}`, s - prev.length - 1, en - prev.length - 1);
    }
    else {
        if (le >= v.length)
            return;
        const nle = lineEnd(v, le + 1);
        const next = v.slice(le + 1, nle);
        replaceRange(ta, ls, nle, `${next}\n${block}`, s + next.length + 1, en + next.length + 1);
    }
}
function duplicateLines() {
    const b = activeText();
    if (!b)
        return;
    const ta = b.ta, s = ta.selectionStart, en = ta.selectionEnd;
    const [ls, le] = selectedLines(ta);
    const block = ta.value.slice(ls, le);
    replaceRange(ta, le, le, `\n${block}`, s + block.length + 1, en + block.length + 1);
}
function selectLine() {
    const b = activeText();
    if (!b)
        return;
    const [ls, le] = selectedLines(b.ta);
    b.ta.focus();
    b.ta.setSelectionRange(ls, Math.min(le + 1, b.ta.value.length));
    updateCaret();
}
/* ----- Find in file ----- */
let findOpen = false;
let findHits = [];
let findIdx = -1;
let findLen = 0;
const findInput = $('#findInput');
function openFind() {
    const b = activeText();
    if (!b)
        return;
    const sel = b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd);
    if (sel && !sel.includes('\n'))
        findInput.value = sel;
    findOpen = true;
    $('#findbar').classList.remove('hidden');
    findInput.focus();
    findInput.select();
    runFind(true);
}
function closeFind() {
    if (!findOpen)
        return;
    findOpen = false;
    findHits = [];
    findLen = 0;
    $('#findbar').classList.add('hidden');
    renderCode();
}
function runFind(jump) {
    const b = activeText();
    const q = findInput.value;
    findHits = [];
    findLen = q.length;
    if (b && q) {
        const hay = b.text.toLowerCase(), n = q.toLowerCase();
        for (let i = hay.indexOf(n); i !== -1 && findHits.length < 20000; i = hay.indexOf(n, i + n.length))
            findHits.push(i);
    }
    const from = b ? b.ta.selectionStart : 0;
    findIdx = findHits.length ? Math.max(0, findHits.findIndex(h => h >= from)) : -1;
    if (findIdx === -1 && findHits.length)
        findIdx = 0;
    if (jump)
        selectHit();
    else {
        renderFindCount();
        queueRender();
    }
}
function renderFindCount() {
    let text = '';
    if (findInput.value)
        text = findHits.length ? `${findIdx + 1} of ${findHits.length}` : 'No results';
    $('#findCount').textContent = text;
}
function stepFind(d) {
    if (!findHits.length)
        return;
    findIdx = (findIdx + d + findHits.length) % findHits.length;
    selectHit();
}
function selectHit() {
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
    if (e.key === 'Enter') {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') {
        e.stopPropagation();
        closeFind();
        activeText()?.ta.focus();
    }
});
$('#findNext').onclick = () => stepFind(1);
$('#findPrev').onclick = () => stepFind(-1);
$('#findClose').onclick = () => { closeFind(); activeText()?.ta.focus(); };
/* ----- Go to line / file ----- */
function goToLine() {
    const b = activeText();
    if (!b) {
        toast('Open a file first');
        return;
    }
    const total = b.text.split('\n').length;
    openModal(`<input class="input w-full" id="lineIn" aria-label="Line number" placeholder="Go to line (1 – ${total})" inputmode="numeric">`, m => {
        const input = $('#lineIn', m);
        input.focus();
        input.onkeydown = e => {
            if (e.key !== 'Enter')
                return;
            const n = clamp(Number.parseInt(input.value, 10) || 1, 1, total);
            closeModal();
            const off = offsetOf(b.text, n - 1, 0);
            b.ta.focus();
            b.ta.setSelectionRange(off, off);
            revealOffset(b, off);
        };
    }, undefined, 'top');
}
// How well a path matches a quick-open query: name prefix > name > path > letters in order.
function fileScore(p, q) {
    const name = baseName(p).toLowerCase(), full = p.toLowerCase();
    if (!q)
        return 1;
    if (name.startsWith(q))
        return 4;
    if (name.includes(q))
        return 3;
    if (full.includes(q))
        return 2;
    let i = 0;
    for (const ch of full)
        if (ch === q[i])
            i++;
    return i === q.length ? 1 : 0;
}
async function quickOpen() {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    let all = [];
    let sel = 0;
    let shown = [];
    openModal(`<input class="input w-full" id="qoIn" aria-label="Search files by name" placeholder="Search files by name" spellcheck="false"><div class="qo-list" id="qoList"><div class="side-note">Loading…</div></div>`, m => {
        const input = $('#qoIn', m);
        input.focus();
        const render = () => {
            const q = input.value.trim().toLowerCase();
            shown = all.map(p => [p, fileScore(p, q)]).filter(x => x[1] > 0)
                .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 60).map(x => x[0]);
            sel = clamp(sel, 0, Math.max(0, shown.length - 1));
            const rows = shown.map((p, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${fileIcon(baseName(p))}&nbsp; ${esc(baseName(p))}</span><small>${esc(dirName(p))}</small></div>`);
            $('#qoList', m).innerHTML = rows.join('') || '<div class="side-note">No matching files.</div>';
            $$('[data-i]', m).forEach(el => el.onclick = () => { closeModal(); openFile(shown[Number(el.dataset.i)]); });
        };
        input.oninput = () => { sel = 0; render(); };
        input.onkeydown = e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                sel += e.key === 'ArrowDown' ? 1 : -1;
                render();
                $('.qo-item.on', m)?.scrollIntoView({ block: 'nearest' });
            }
            if (e.key === 'Enter' && shown[sel]) {
                closeModal();
                openFile(shown[sel]);
            }
        };
        api.fs.listFiles().then(list => { all = list; render(); }, (err) => { $('#qoList', m).innerHTML = `<div class="side-note">${esc(errMsg(err))}</div>`; });
    }, undefined, 'top');
}
/* ================= Search across files ================= */
let searchCase = false;
$('#searchCase').onclick = () => { searchCase = !searchCase; $('#searchCase').classList.toggle('on', searchCase); void runSearch(); };
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter')
    void runSearch(); });
function hitLineHtml(h, i, qLen) {
    const start = Math.max(0, h.col - 30);
    const pre = h.text.slice(start, h.col).trimStart(), hit = h.text.slice(h.col, h.col + qLen), post = h.text.slice(h.col + qLen, h.col + qLen + 80);
    return `<div class="result-line" data-p="${escAttr(h.path)}" data-i="${i}">${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`;
}
async function runSearch() {
    const q = $('#searchInput').value;
    const out = $('#searchResults');
    if (!rootInfo) {
        out.innerHTML = '<p class="side-note">Open a folder to search it.</p>';
        return;
    }
    if (!q) {
        out.innerHTML = '<p class="side-note">Type and press Enter to search across files.</p>';
        return;
    }
    out.innerHTML = '<p class="side-note">Searching…</p>';
    let hits;
    try {
        hits = await api.fs.search(q, searchCase);
    }
    catch (e) {
        out.innerHTML = `<p class="side-note">${esc(errMsg(e))}</p>`;
        return;
    }
    if (!hits.length) {
        out.innerHTML = '<p class="side-note">No results.</p>';
        return;
    }
    const byFile = new Map();
    for (const h of hits)
        byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
    const more = hits.length >= 500 ? '+' : '';
    const groups = [...byFile].map(([p, hs]) => `<div class="result-file">${fileIcon(baseName(p))} ${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>` + hs.map((h, i) => hitLineHtml(h, i, q.length)).join(''));
    out.innerHTML = `<p class="side-note pt-0">${hits.length}${more} results in ${plural(byFile.size, 'file')}</p>` + groups.join('');
    $$('.result-line', out).forEach(el => el.onclick = () => {
        const h = (byFile.get(el.dataset.p) ?? [])[Number(el.dataset.i)];
        if (h)
            openFile(h.path, { line: h.line, col: h.col, len: q.length });
    });
}
/* ================= Preview ================= */
let running = false;
let previewPath = null;
const frame = $('#previewFrame');
frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
function renderPreview() {
    $('#previewEmpty').classList.toggle('hidden', running);
    frame.classList.toggle('hidden', !running);
    $('#liveDot').classList.toggle('hidden', !running);
    if (!running) {
        $('#urlText').textContent = 'Not running';
        frame.removeAttribute('src');
        frame.removeAttribute('srcdoc');
    }
}
async function startPreview() {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    const entry = (dirCache.get('') ?? []).find(e => !e.dir && /^index\.html?$/i.test(e.name));
    const htmlOpen = active && /\.html?$/i.test(active) ? active : null;
    const target = entry?.name ?? htmlOpen;
    if (!target) {
        toast('Add an index.html (or open an .html file) to preview it');
        return;
    }
    previewPath = target;
    running = true;
    layout.previewOpen = true;
    applyLayout();
    renderPreview();
    await reloadPreview();
}
async function reloadPreview() {
    if (!running || !previewPath)
        return;
    const url = await api.fs.fileUrl(previewPath).catch(() => '');
    if (url) {
        $('#urlText').textContent = url.replace(/^file:\/\/\//, '');
        frame.removeAttribute('srcdoc');
        frame.src = `${url}?t=${Date.now()}`;
    }
    else {
        // Browser demo: no file URLs, so inline the saved HTML.
        const r = await api.fs.readFile(previewPath).catch(() => null);
        $('#urlText').textContent = previewPath;
        frame.srcdoc = r?.text ?? '';
    }
}
function stopPreview() { running = false; previewPath = null; renderPreview(); }
/* ================= Terminal ================= */
const term = { cwd: '', proc: null, history: [], hIdx: 0 };
const termOut = $('#termOut');
const termInput = $('#termInput');
// Colour codes and lone carriage returns don't render in the panel.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function renderPs() { $('#termPs').textContent = `${term.cwd || '~'}>`; }
function termWrite(text, cls = '') {
    const span = document.createElement('span');
    if (cls)
        span.className = cls;
    span.textContent = text.replaceAll(ANSI, '').replaceAll(/\r(?!\n)/g, '');
    termOut.appendChild(span);
    while (termOut.childNodes.length > 3000)
        termOut.firstChild?.remove();
    $('#termBody').scrollTop = $('#termBody').scrollHeight;
}
function killCommand() {
    if (term.proc == null)
        return;
    background(api.term.kill(term.proc));
    termWrite('^C\n');
}
async function runCommand(cmd) {
    if (term.proc != null) {
        termWrite(cmd + '\n');
        toast('A command is still running — press Ctrl+C to stop it');
        return;
    }
    termWrite(`${term.cwd}> `, 'ps');
    termWrite(cmd + '\n', 'cmd');
    if (!cmd.trim())
        return;
    term.history.push(cmd);
    term.hIdx = term.history.length;
    if (/^\s*(?:cls|clear)\s*$/i.test(cmd)) {
        termOut.innerHTML = '';
        return;
    }
    const r = await api.term.run(cmd).catch((err) => ({ error: errMsg(err) }));
    if (r.error)
        termWrite(r.error + '\n', 'err');
    if (r.cwd) {
        term.cwd = r.cwd;
        renderPs();
    }
    if (r.id != null) {
        term.proc = r.id;
        $('#termPs').classList.add('busy');
    }
}
termInput.addEventListener('keydown', e => {
    if (e.key === 'c' && e.ctrlKey && term.proc != null && termInput.selectionStart === termInput.selectionEnd) {
        e.preventDefault();
        killCommand();
        return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        term.hIdx = clamp(term.hIdx + (e.key === 'ArrowUp' ? -1 : 1), 0, term.history.length);
        termInput.value = term.history[term.hIdx] ?? '';
        return;
    }
    if (e.key !== 'Enter')
        return;
    const cmd = termInput.value;
    termInput.value = '';
    void runCommand(cmd);
});
api.term.onData((id, chunk) => { if (id === term.proc)
    termWrite(chunk); });
api.term.onExit((id, code) => {
    if (id !== term.proc)
        return;
    term.proc = null;
    $('#termPs').classList.remove('busy');
    if (code)
        termWrite(`exited with code ${code}\n`, 'err');
});
$('#termBody').addEventListener('mouseup', () => { if (!getSelection()?.toString())
    termInput.focus(); });
$('#termToggle').addEventListener('click', e => { if (!e.target.closest('button'))
    run('term.toggle'); });
const DEFAULT_LAYOUT = { side: 240, agents: 340, term: 200, preview: 460, sideOpen: true, agentsOpen: true, termOpen: false, previewOpen: true, view: 'files' };
const layout = { ...DEFAULT_LAYOUT, ...store.get('breeze.layout', {}) };
function applyLayout() {
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
    const icon = (id, sym, on) => $(`#${id} use`).setAttribute('href', `#i-${sym}${on ? '-on' : ''}`);
    icon('tglSide', 'left', layout.sideOpen);
    icon('tglTerm', 'bottom', layout.termOpen);
    icon('tglAgents', 'right', layout.agentsOpen);
    store.set('breeze.layout', layout);
    syncScroll();
}
window.addEventListener('resize', applyLayout);
// Dragging below a threshold collapses the panel; dragging back out reopens it.
const SASH_DRAG = {
    side: (start, dx) => { const w = start.side + dx; layout.sideOpen = w >= 120; if (layout.sideOpen)
        layout.side = clamp(w, 170, 640); },
    agents: (start, dx) => { const w = start.agents - dx; layout.agentsOpen = w >= 180; if (layout.agentsOpen)
        layout.agents = clamp(w, 260, 720); },
    preview: (start, dx) => { const w = start.preview - dx; layout.previewOpen = w >= 140; if (layout.previewOpen)
        layout.preview = clamp(w, 220, $('#work').clientWidth - 220); },
    term: (start, _dx, dy) => { const h = start.term - dy; layout.termOpen = h >= 60; if (layout.termOpen)
        layout.term = clamp(h, 80, innerHeight - 220); },
};
function startSashDrag(sash, kind, e) {
    const sx = e.clientX, sy = e.clientY, start = { ...layout };
    if (kind === 'preview')
        start.preview = $('#previewPane').getBoundingClientRect().width;
    document.body.classList.add(kind === 'term' ? 'resizing-h' : 'resizing');
    sash.classList.add('active');
    const move = (ev) => { SASH_DRAG[kind](start, ev.clientX - sx, ev.clientY - sy); applyLayout(); };
    const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        document.body.classList.remove('resizing', 'resizing-h');
        sash.classList.remove('active');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
}
$$('[data-sash]').forEach(sash => {
    const kind = sash.dataset.sash;
    sash.addEventListener('pointerdown', e => {
        if (e.button !== 0)
            return;
        e.preventDefault();
        startSashDrag(sash, kind, e);
    });
    sash.addEventListener('dblclick', () => { layout[kind] = DEFAULT_LAYOUT[kind]; applyLayout(); });
});
$('#tglSide').onclick = () => run('view.toggleSide');
$('#tglTerm').onclick = () => run('term.toggle');
$('#tglAgents').onclick = () => run('view.toggleAgents');
const hasFile = () => !!activeText();
function searchSelection() {
    showView('search', true);
    const i = $('#searchInput');
    const b = activeText();
    const s = b ? b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd) : '';
    if (s && !s.includes('\n'))
        i.value = s;
    i.focus();
    i.select();
}
function backToOnboarding(n) {
    appState.onboarded = false;
    saveApp();
    $('#ide').classList.add('hidden');
    $('#onboard').classList.remove('hidden');
    goStep(n);
}
const commands = {
    'file.newFile': () => newEntry(targetDir(), false),
    'file.newFolder': () => newEntry(targetDir(), true),
    'file.openFolder': openFolderCmd,
    'file.openRecent': openRecentPicker,
    'file.save': () => saveFile(),
    'file.saveAll': saveAll,
    'file.closeEditor': () => { if (active)
        closeTab(active); },
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
    'view.people': () => showView('people', true),
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
    'term.toggle': () => { layout.termOpen = !layout.termOpen; applyLayout(); if (layout.termOpen)
        termInput.focus(); },
    'term.focus': () => { layout.termOpen = true; applyLayout(); termInput.focus(); },
    'term.clear': () => { termOut.innerHTML = ''; },
    'term.kill': () => { if (term.proc == null)
        toast('Nothing is running');
    else
        killCommand(); },
    'explorer.refresh': refreshTree,
    'explorer.collapse': () => { expanded.clear(); renderTree(); saveSession(); },
    'help.welcome': () => setActive(null),
    'help.keys': showShortcuts,
    'help.setup': () => backToOnboarding(STEP.setup),
    'account.signIn': () => backToOnboarding(STEP.signIn),
    'account.signOut': async () => { await api.auth.signOut(); setUser(null); toast('Signed out'); },
    'help.about': showAbout,
};
function showAbout() {
    const where = isDesktop ? 'Desktop app' : 'Browser preview';
    const engine = /Electron\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
    openModal(`<h3>Breeze IDE</h3><p class="sub">Smooth as a breeze.</p><p class="sub fs-12">${where} · ${esc(engine)}</p><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
}
function run(act) {
    const fn = commands[act];
    if (fn)
        Promise.resolve(fn()).catch((e) => toast(errMsg(e)));
}
// Undo and redo in the code editor use its own history; everything else goes to the focused field.
function editRole(role) {
    const b = activeText();
    if (b && (role === 'undo' || role === 'redo')) {
        stepHistory(b, role === 'undo');
        b.ta.focus();
        return;
    }
    b?.ta.focus();
    background(api.win.edit(role));
}
function cycleTab(d) {
    if (!openTabs.length)
        return;
    const i = active ? openTabs.indexOf(active) : -1;
    setActive(openTabs[(i + d + openTabs.length) % openTabs.length]);
}
async function openFolderCmd() {
    if (!(await confirmDiscard()))
        return;
    const r = await api.fs.openFolder();
    if (r)
        await loadWorkspace(r);
}
async function openRecentFolder(dir) {
    if (!(await confirmDiscard()))
        return;
    try {
        await loadWorkspace(await api.fs.openRecent(dir));
    }
    catch (e) {
        toast(errMsg(e));
    }
}
async function openRecentPicker() {
    const recent = await api.fs.recent();
    if (!recent.length) {
        toast('No recent folders yet');
        return;
    }
    const rows = recent.map(r => `<div class="qo-item" data-r="${escAttr(r.path)}"><span>${esc(r.name)}</span><small>${esc(r.path)}</small></div>`);
    openModal(`<h3>Open recent</h3><div class="qo-list">${rows.join('')}</div>`, m => $$('[data-r]', m).forEach(el => el.onclick = () => { closeModal(); void openRecentFolder(el.dataset.r); }), undefined, 'top');
}
async function closeFolderCmd() {
    if (!rootInfo || !(await confirmDiscard()))
        return;
    store.del(hotExitKey());
    await api.fs.closeFolder();
    resetWorkspace();
    renderTree();
    renderTabs();
    renderEditor();
}
// Before leaving a folder: save, discard or cancel any unsaved files.
function confirmDiscard() {
    const dirty = [...buffers.values()].filter(isDirty);
    if (!dirty.length)
        return Promise.resolve(true);
    return new Promise(res => {
        const finish = settleOnce(res);
        openModal(`<h3>Save changes to ${plural(dirty.length, 'file')}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dDiscard">Don't Save</button><button class="btn btn-primary" id="dSave">Save All</button></div>`, m => {
            $('#dDiscard', m).onclick = () => {
                for (const b of dirty) {
                    b.text = b.saved;
                    if (b.ta)
                        b.ta.value = b.saved;
                }
                finish(true);
                closeModal();
            };
            $('#dSave', m).onclick = () => background(saveAll().then(() => { finish(true); closeModal(); }));
        }, () => finish(false));
    });
}
const MENUS = [
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
            { label: 'Sign In…', act: 'account.signIn', enabled: () => !user },
            { label: 'Sign Out', act: 'account.signOut', enabled: () => !!user },
            { sep: true },
            { label: 'About Breeze IDE', act: 'help.about' },
        ] },
];
// Go, Run and Help stay out of the menu bar; their shortcuts still work and Help lives under the gear button.
const BAR_MENUS = MENUS.filter(m => !['Go', 'Run', 'Help'].includes(m.name));
// Shortcuts handled by the editor itself or by keydown elsewhere, but listed for discoverability.
const EXTRA_KEYS = [['F2', 'explorer.rename']];
commands['explorer.rename'] = () => { if (active)
    return renameEntry(active); };
const canonKey = (combo) => {
    const parts = combo.split('+');
    const key = parts.pop();
    const mods = new Set(parts);
    return ['Ctrl', 'Shift', 'Alt'].filter(m => mods.has(m)).concat(key.length === 1 ? key.toUpperCase() : key).join('+');
};
const keymap = new Map();
for (const { items } of MENUS)
    for (const it of items)
        if (it.key && it.act && !it.native)
            keymap.set(canonKey(it.key), it.act);
for (const [k, act] of EXTRA_KEYS)
    keymap.set(canonKey(k), act);
const KEY_BY_CODE = { Backquote: '`', Slash: '/' };
function keyName(e) {
    if (KEY_BY_CODE[e.code])
        return KEY_BY_CODE[e.code];
    if (e.key.startsWith('Arrow'))
        return e.key.slice(5);
    return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}
function comboOf(e) {
    return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', keyName(e)].filter(Boolean).join('+');
}
// Commands that only make sense while typing in the code editor.
const EDITOR_ONLY = new Set(['edit.comment', 'sel.line', 'sel.dup', 'sel.up', 'sel.down']);
/* ----- Menus: the bar opens on hover; the gear and right-clicks pop up ----- */
let openMenuIdx = -1; // bar menu index, -2 for a popup, -1 when closed
let menuPinned = false; // opened by a click or the keyboard: stays open when the pointer leaves
let menuCloseTimer;
let kbIdx = -1;
let menuItems = [];
let menuOnClose = null;
function cancelMenuClose() { clearTimeout(menuCloseTimer); }
// A menu opened by hovering closes shortly after the pointer leaves both the bar and the menu.
function scheduleMenuClose() {
    cancelMenuClose();
    menuCloseTimer = setTimeout(() => { if (openMenuIdx >= 0 && !menuPinned)
        closeMenu(); }, 350);
}
function buildMenubar() {
    $('#menubar').innerHTML = BAR_MENUS.map((m, i) => `<button class="menu-top" data-menu="${i}" aria-haspopup="menu">${esc(m.name)}</button>`).join('');
    $$('[data-menu]').forEach(b => {
        const i = Number(b.dataset.menu);
        b.onmouseenter = () => {
            cancelMenuClose();
            if (openMenuIdx !== i)
                openMenu(i, false, menuPinned && openMenuIdx >= 0);
        };
        b.onmouseleave = scheduleMenuClose;
        b.onmousedown = e => {
            e.preventDefault();
            // A click pins a hover-opened menu; clicking a pinned menu closes it.
            if (openMenuIdx === i && menuPinned)
                closeMenu();
            else
                openMenu(i, false, true);
        };
    });
}
function openMenu(i, viaKeyboard = false, pinned = viaKeyboard) {
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
function popupMenu(x, y, items, onClose) {
    showMenu(x, y, items, false);
    openMenuIdx = -2;
    menuPinned = true;
    menuOnClose = onClose ?? null;
}
function menuItemHtml(it, i) {
    if (it.sep)
        return '<div class="menu-sep"></div>';
    const cls = ['menu-item', it.checked?.() ? 'checked' : '', i === kbIdx ? 'kb' : ''].filter(Boolean).join(' ');
    const disabled = it.enabled && !it.enabled() ? ' disabled' : '';
    const key = it.key ? `<span class="key">${it.key}</span>` : '';
    return `<button class="${cls}" role="menuitem" data-mi="${i}"${disabled}><span>${esc(it.label ?? '')}</span>${key}</button>`;
}
function showMenu(x, y, items, viaKeyboard) {
    cancelMenuClose();
    menuItems = items;
    kbIdx = viaKeyboard ? items.findIndex(it => !it.sep) : -1;
    const root = $('#menuRoot');
    root.innerHTML = `<div class="menu" role="menu">${items.map(menuItemHtml).join('')}</div>`;
    const m = $('.menu', root);
    m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
    m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
    $$('[data-mi]', m).forEach(b => {
        b.onmousedown = e => e.preventDefault(); // keep focus (and the selection) in the editor
        b.onclick = () => activateMenuItem(items[Number(b.dataset.mi)]);
    });
}
function activateMenuItem(it) {
    if (it.enabled && !it.enabled())
        return;
    closeMenu();
    if (it.run)
        it.run();
    else if (it.act)
        run(it.act);
}
function closeMenu() {
    cancelMenuClose();
    if (openMenuIdx === -1)
        return;
    openMenuIdx = -1;
    kbIdx = -1;
    menuPinned = false;
    $('#menuRoot').innerHTML = '';
    $$('[data-menu]').forEach(b => b.classList.remove('open'));
    const cb = menuOnClose;
    menuOnClose = null;
    cb?.();
}
document.addEventListener('mousedown', e => {
    if (openMenuIdx !== -1 && !e.target.closest('.menu, .menubar, #settingsBtn'))
        closeMenu();
});
window.addEventListener('blur', closeMenu);
function moveKbSelection(down) {
    const usable = menuItems.map((it, i) => (!it.sep && (!it.enabled || it.enabled()) ? i : -1)).filter(i => i !== -1);
    const pos = usable.indexOf(kbIdx);
    kbIdx = usable[(pos + (down ? 1 : -1) + usable.length) % usable.length] ?? -1;
    $$('[data-mi]').forEach(b => b.classList.toggle('kb', Number(b.dataset.mi) === kbIdx));
}
function menuKeys(e) {
    if (openMenuIdx === -1)
        return false;
    if (e.key === 'Escape')
        closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        moveKbSelection(e.key === 'ArrowDown');
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && openMenuIdx >= 0) {
        openMenu((openMenuIdx + (e.key === 'ArrowRight' ? 1 : -1) + BAR_MENUS.length) % BAR_MENUS.length, true);
    }
    else if (e.key === 'Enter' && kbIdx >= 0)
        activateMenuItem(menuItems[kbIdx]);
    else
        return false;
    e.preventDefault();
    return true;
}
const focused = () => document.activeElement;
document.addEventListener('keydown', e => {
    if (menuKeys(e))
        return;
    if (e.key === 'Escape') {
        if (vibeOn) {
            exitVibe();
            return;
        }
        if (modalOpen()) {
            closeModal();
            return;
        }
        if (findOpen) {
            closeFind();
            activeText()?.ta.focus();
            return;
        }
    }
    if (modalOpen() || vibeOn || $('#ide').classList.contains('hidden'))
        return;
    const act = keymap.get(comboOf(e));
    if (!act)
        return;
    if (EDITOR_ONLY.has(act) && !focused()?.classList.contains('ta'))
        return;
    if (act === 'explorer.rename' && focused()?.matches('input, textarea'))
        return;
    e.preventDefault();
    run(act);
}, true);
// Alt alone (released without another key) opens the menu bar, like a native app.
let altAlone = false;
document.addEventListener('keydown', e => { altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey; }, true);
document.addEventListener('keyup', e => {
    if (e.key === 'Alt' && altAlone && !$('#ide').classList.contains('hidden') && !modalOpen()) {
        e.preventDefault();
        if (openMenuIdx === -1)
            openMenu(0, true);
        else
            closeMenu();
    }
    altAlone = false;
}, true);
// The gear turns while its menu is open and turns back when it closes.
const settingsBtn = $('#settingsBtn');
settingsBtn.onclick = () => {
    if (settingsBtn.classList.contains('open')) {
        closeMenu();
        return;
    }
    closeMenu();
    const r = settingsBtn.getBoundingClientRect();
    settingsBtn.classList.add('open');
    settingsBtn.setAttribute('aria-expanded', 'true');
    popupMenu(r.right + 6, r.top, MENUS.find(m => m.name === 'Help')?.items ?? [], () => {
        settingsBtn.classList.remove('open');
        settingsBtn.setAttribute('aria-expanded', 'false');
    });
};
function showShortcuts() {
    const rows = [];
    for (const { name, items } of MENUS)
        for (const it of items)
            if (it.key)
                rows.push(`<span>${esc(name)} › ${esc(it.label ?? '')}</span><kbd>${it.key}</kbd>`);
    rows.push('<span>Editor › Indent / outdent</span><kbd>Tab / Shift+Tab</kbd>', '<span>Explorer › Rename file</span><kbd>F2</kbd>', '<span>Menu bar</span><kbd>Alt</kbd>', '<span>Tabs › Reorder</span><kbd>Drag a tab</kbd>');
    openModal(`<h3>Keyboard shortcuts</h3><p class="sub">Drag any panel edge to resize it; drag it closed to hide it.</p><div class="kbd-table">${rows.join('')}</div><div class="row end"><button class="btn btn-primary" data-close>Close</button></div>`);
}
// Buttons with data-act anywhere in the page run the matching command.
document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && !b.closest('.menu')) {
        e.stopPropagation();
        run(b.dataset.act);
    }
});
/* ================= Agents (UI) ================= */
function renderAgents() {
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
    for (const i of $$('[data-used]', $('#agentCards')))
        i.style.width = `${Math.min(100, Number(i.dataset.used) * 4)}%`;
}
function setAgent(k, status, task, used) {
    Object.assign(agentsDef[k], { status, task });
    if (used != null)
        agentsDef[k].used = used;
    renderAgents();
    vibeTick();
}
const chat = $('#chat');
function addMsg(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    const el = d.firstElementChild;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    saveChat();
    return el;
}
const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function agentMsg(k, html) {
    const a = agentsDef[k];
    return addMsg(`<div class="msg"><div class="meta"><span class="avatar mini tint-${a.tint}">${a.letter}</span><b>${a.name}</b> ${clockTime()}</div><div class="body">${html}</div></div>`);
}
function userMsg(text) {
    addMsg(`<div class="msg user"><div class="meta"><b>${esc(user?.name ?? 'You')}</b> ${clockTime()}</div><div class="body">${esc(text)}</div></div>`);
}
function emptyChat() {
    chat.innerHTML = `<div class="empty"><div><img src="Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div>Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
}
// A small, safe subset of Markdown for agent replies: code blocks, inline code, bold and line breaks.
function md(text) {
    return text.split(/```[\w-]*\n?/).map((part, i) => (i % 2
        ? `<pre>${esc(part.replace(/\n$/, ''))}</pre>`
        : esc(part).replaceAll(/`([^`\n]+)`/g, '<code>$1</code>').replaceAll(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replaceAll('\n', '<br>'))).join('');
}
const TOOL_ICON = { read: '◔', edit: '✎', run: '❯', search: '⌕', web: '◍', todo: '☑', agent: '◇', tool: '•', note: 'ℹ' };
function toolLine(kind, label) {
    addMsg(`<div class="tool-line ${kind}"><span class="ti">${TOOL_ICON[kind] ?? '•'}</span><span class="tl">${esc(label)}</span></div>`);
}
// Chat history is kept per project folder so a reload brings it back.
const chatKey = () => `breeze.chat:${rootInfo?.root ?? ''}`;
const agentSessionKey = () => `breeze.agentSession:${rootInfo?.root ?? ''}:${appState.agent ?? ''}`;
let chatTimer;
function saveChat() {
    clearTimeout(chatTimer);
    chatTimer = setTimeout(() => {
        if (!rootInfo)
            return;
        const html = chat.querySelector('.empty') ? '' : chat.innerHTML;
        if (html && html.length < 400000)
            store.set(chatKey(), html);
        else
            store.del(chatKey());
    }, 400);
}
function restoreChat() {
    const html = store.get(chatKey(), '');
    if (!html) {
        emptyChat();
        return;
    }
    chat.innerHTML = html;
    // Buttons from an earlier run have no handlers any more; show them as settled.
    $$('[data-live]', chat).forEach(el => { el.outerHTML = '<div class="resolved">Earlier session</div>'; });
    chat.scrollTop = chat.scrollHeight;
}
let agentRun = null;
let lastRunFiles = [];
const promptBox = $('#prompt');
$('#send').onclick = () => (agentRun ? stopAgent() : void sendPrompt());
promptBox.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendPrompt();
} });
$('#newChat').onclick = () => {
    if (agentRun)
        stopAgent();
    store.del(agentSessionKey());
    store.del(chatKey());
    emptyChat();
    setAgent('planner', 'idle', 'Waiting for a prompt', 0);
    setAgent('builder', 'idle', 'Waiting for a plan', 0);
    promptBox.focus();
};
commands['agent.stop'] = () => stopAgent();
function setBusy(on) {
    const b = $('#send');
    b.classList.toggle('stop', on);
    b.textContent = on ? '■ Stop' : 'Send ↵';
    b.title = on ? 'Stop the agent' : 'Send (Enter)';
}
function stopAgent() {
    if (agentRun)
        background(api.agent.stop(agentRun.id));
}
const MODES = { build: 'build', ask: 'ask', plan: 'plan' };
async function sendPrompt() {
    const text = promptBox.value.trim();
    if (!text || agentRun)
        return;
    const agent = selectedAgent();
    if (!agent) {
        openAgentPicker();
        return;
    }
    if (!rootInfo) {
        toast('Open a folder first, so the agent knows what to work on');
        return;
    }
    const uiMode = $('#agentMode').value;
    promptBox.value = '';
    if (chat.querySelector('.empty'))
        chat.innerHTML = '';
    userMsg(text);
    await startAgentRun(agent.id, MODES[uiMode] ?? 'plan', text, uiMode);
}
async function startAgentRun(agentId, mode, prompt, uiMode) {
    const phase = mode === 'build' ? 'builder' : 'planner';
    setAgent(phase, 'working', mode === 'build' ? 'Working on your request' : 'Reading the project', 0);
    if (phase === 'planner')
        setAgent('builder', 'idle', 'Waiting for a plan', 0);
    setBusy(true);
    try {
        const id = await api.agent.run({ agent: agentId, mode, prompt, session: store.get(agentSessionKey(), null) });
        agentRun = { id, agent: agentId, mode, uiMode, phase, tools: 0, files: new Set(), plan: null, lastText: '' };
    }
    catch (e) {
        setBusy(false);
        setAgent(phase, 'idle', 'Could not start', 0);
        errorCard(errMsg(e));
    }
}
function errorCard(text, hint, action) {
    const hintHtml = hint ? `<p>${esc(hint)}</p>` : '';
    const actionHtml = action === 'openApp' ? '<div class="row" data-live><button class="btn btn-sm btn-primary" data-openapp>Open project in Antigravity</button></div>' : '';
    const el = addMsg(`<div class="card error"><h5>⚠ The agent hit a problem</h5><pre>${esc(text)}</pre>${hintHtml}${actionHtml}</div>`);
    el.querySelector('[data-openapp]')?.addEventListener('click', () => background(api.agent.openApp(agentRun?.agent ?? appState.agent ?? '')));
}
function onAgentFile(r, path) {
    r.files.add(path);
    locks[path] = r.phase;
    renderTree();
    renderTabs();
    queueGitRefresh();
}
function onAgentError(r, ev) {
    // Some CLIs print the error as a reply too; show it once, in the error card.
    if (r.lastMsg && ev.text?.trim() === r.lastText.trim())
        r.lastMsg.remove();
    errorCard(ev.text ?? 'Unknown error', ev.hint, ev.action);
}
const AGENT_EVENTS = {
    session: (_r, ev) => { if (ev.id)
        store.set(agentSessionKey(), ev.id); },
    text: (r, ev) => { if (ev.text) {
        r.lastText = ev.text;
        r.lastMsg = agentMsg(r.phase, md(ev.text));
    } },
    tool: (r, ev) => { r.tools++; toolLine(ev.kind ?? 'tool', ev.label ?? ''); setAgent(r.phase, 'working', ev.label ?? 'Working', r.tools); },
    file: (r, ev) => { if (ev.path)
        onAgentFile(r, ev.path); },
    plan: (r, ev) => { r.plan = ev.text ?? ''; },
    note: (_r, ev) => { if (ev.text)
        toolLine('note', ev.text); },
    error: onAgentError,
    done: finishRun,
};
api.agent.onEvent((runId, ev) => {
    const r = agentRun;
    if (r?.id === runId)
        AGENT_EVENTS[ev.t]?.(r, ev);
});
function runSummary(r, ev) {
    const time = ev.ms ? `${Math.max(1, Math.round(ev.ms / 1000))}s` : '';
    const files = r.files.size ? `${plural(r.files.size, 'file')} changed` : '';
    let usage = '';
    if (ev.cost)
        usage = `$${ev.cost.toFixed(2)}`;
    else if (ev.tokens)
        usage = `${ev.tokens.toLocaleString()} tokens`;
    return [time, files, usage].filter(Boolean);
}
function showPlan(r) {
    const plan = (r.plan || r.lastText).trim();
    if (!plan) {
        setAgent('planner', 'done', 'Answered', r.tools);
        return;
    }
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
        }
        else {
            setAgent('planner', 'idle', 'Waiting for your changes', r.tools);
            promptBox.focus();
            promptBox.placeholder = 'What should change in the plan?';
        }
    });
}
function finishRun(r, ev) {
    agentRun = null;
    setBusy(false);
    for (const k of Object.keys(locks))
        delete locks[k];
    renderTree();
    renderTabs();
    lastRunFiles = [...r.files];
    vibeDone(!!ev.ok);
    queueGitRefresh();
    if (ev.stopped) {
        addMsg('<div class="handoff">Stopped by you</div>');
        setAgent(r.phase, 'idle', 'Stopped', r.tools);
        return;
    }
    if (!ev.ok) {
        setAgent(r.phase, 'idle', 'Stopped with an error', r.tools);
        return;
    }
    if (r.uiMode === 'plan' && r.mode === 'plan') {
        showPlan(r);
        return;
    }
    const changed = r.files.size ? `Changed ${plural(r.files.size, 'file')}` : 'Answered';
    setAgent(r.phase, 'done', changed, r.tools);
    const bits = runSummary(r, ev);
    const summary = bits.length ? ' · ' + bits.join(' · ') : '';
    const review = r.files.size ? '<button class="btn btn-sm" data-live data-review>Review changes</button>' : '';
    const el = addMsg(`<div class="run-done"><span>✓ Done${summary}</span>${review}</div>`);
    el.querySelector('[data-review]')?.addEventListener('click', () => showView('git', true));
    promptBox.placeholder = 'Describe what you want to build…';
    if (r.files.size && running)
        void reloadPreview();
}
/* ================= Source control (git) ================= */
let gitState = { repo: false };
let gitLog = { head: null, commits: [] };
let gitBusy = false;
let openCommit = null;
const commitDetails = new Map();
const scmCollapsed = new Set(store.get('breeze.scmCollapsed', []));
let gitTimer;
function queueGitRefresh() { clearTimeout(gitTimer); gitTimer = setTimeout(() => void refreshGit(), 400); }
window.addEventListener('focus', () => { if (rootInfo)
    queueGitRefresh(); });
async function refreshGit() {
    if (!rootInfo) {
        gitState = { repo: false };
        renderScm();
        renderBranch();
        return;
    }
    try {
        gitState = await api.git.status();
        gitLog = gitState.repo && gitState.hasCommits ? await api.git.log() : { head: null, commits: [] };
    }
    catch {
        gitState = { repo: false }; // git missing or not a repository: show the "initialize" panel
    }
    renderScm();
    renderBranch();
    renderTree();
}
function renderBranch() {
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
function gitDecor() {
    const files = new Map(), dirs = new Set();
    for (const f of gitState.files ?? []) {
        files.set(f.path, statusOf(f).cls);
        for (let d = dirName(f.path); d; d = dirName(d))
            dirs.add(d);
    }
    return { files, dirs };
}
const GIT_STATUS = {
    A: { letter: 'A', cls: 'git-a', title: 'Added' },
    D: { letter: 'D', cls: 'git-d', title: 'Deleted' },
    R: { letter: 'R', cls: 'git-m', title: 'Renamed' },
    U: { letter: '!', cls: 'git-d', title: 'Conflict' },
};
function statusOf(f, staged = false) {
    if (f.x === '?' || f.y === '?')
        return { letter: 'U', cls: 'git-u', title: 'Untracked' };
    let c = f.y;
    if (staged || f.y === ' ')
        c = f.x;
    return GIT_STATUS[c] ?? { letter: 'M', cls: 'git-m', title: 'Modified' };
}
function syncLabel(s) {
    if (!s.hasRemote)
        return '';
    if (!s.upstream)
        return 'Publish Branch';
    const ahead = s.ahead ? ` ↑${s.ahead}` : '';
    if (s.behind)
        return `Sync ↓${s.behind}${ahead}`;
    return s.ahead ? `Push${ahead}` : '';
}
function scmRowHtml(f, inStaged) {
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
function scmSectionHtml(key, title, list, inStaged, acts) {
    if (!list.length)
        return '';
    const rows = list.map(f => scmRowHtml(f, inStaged)).join('');
    return `<div class="scm-sec ${scmCollapsed.has(key) ? 'closed' : ''}" data-sec="${key}">
    <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">${title}</span><span class="acts">${acts}</span><span class="count">${list.length}</span></div>
    <div class="scm-list">${rows}</div></div>`;
}
function renderScm() {
    const el = $('#scm');
    if (!rootInfo) {
        el.innerHTML = '<p class="side-note">Open a folder to use source control.</p>';
        return;
    }
    if (!gitState.repo) {
        el.innerHTML = `<div class="side-note">This folder isn't a git repository yet. Turn it on to save checkpoints you can always go back to.<button class="btn btn-primary btn-sm" data-act="git.init">Initialize Repository</button></div>`;
        return;
    }
    const files = gitState.files ?? [];
    const staged = files.filter(f => f.x !== ' ' && f.x !== '?');
    const changes = files.filter(f => f.y !== ' ' || f.x === '?');
    const commitLabel = !staged.length && changes.length ? 'Commit All' : 'Commit';
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
    for (const f of staged)
        seenScm.add(f.path + true);
    for (const f of changes)
        seenScm.add(f.path + false);
    const msg = $('#scmMsg', el);
    msg.value = scmDraft;
    msg.oninput = () => { scmDraft = msg.value; };
    msg.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        run('git.commit');
    } };
}
let scmDraft = '';
const seenScm = new Set();
function toggleScmSection(head) {
    const sec = head.parentElement;
    const key = sec.dataset.sec;
    if (scmCollapsed.has(key))
        scmCollapsed.delete(key);
    else
        scmCollapsed.add(key);
    sec.classList.toggle('closed');
    store.set('breeze.scmCollapsed', [...scmCollapsed]);
}
function scmAll(kind) {
    const files = gitState.files ?? [];
    if (kind === 'stage')
        void gitOp(() => api.git.stage(files.filter(f => f.y !== ' ' || f.x === '?').map(f => f.path)));
    if (kind === 'unstage')
        void gitOp(() => api.git.unstage(files.filter(f => f.x !== ' ' && f.x !== '?').map(f => f.path), !!gitState.hasCommits));
    if (kind === 'discard')
        confirmDiscardChanges(files.filter(f => f.y !== ' ' || f.x === '?'));
}
function scmRowAction(t, rowEl) {
    const path = rowEl.dataset.file;
    const f = (gitState.files ?? []).find(x => x.path === path);
    const act = t.closest('[data-scm]')?.dataset.scm;
    if (act === 'open')
        openFile(path);
    else if (act === 'stage')
        void gitOp(() => api.git.stage([path]));
    else if (act === 'unstage')
        void gitOp(() => api.git.unstage([path], !!gitState.hasCommits));
    else if (act === 'discard' && f)
        confirmDiscardChanges([f]);
    else if (f)
        void showDiff(f, !!rowEl.dataset.staged);
}
$('#scm').addEventListener('click', e => {
    const t = e.target;
    const head = t.closest('.scm-head');
    if (head && !t.closest('button')) {
        toggleScmSection(head);
        return;
    }
    const all = t.closest('[data-scm-all]');
    if (all) {
        scmAll(all.dataset.scmAll);
        return;
    }
    const commitRow = t.closest('[data-commit]');
    if (commitRow) {
        void toggleCommit(commitRow.dataset.commit);
        return;
    }
    const rowEl = t.closest('.scm-row');
    if (rowEl)
        scmRowAction(t, rowEl);
});
async function gitOp(fn, done) {
    if (gitBusy)
        return false;
    gitBusy = true;
    $('#scm').classList.add('busy');
    try {
        await fn();
        if (done)
            toast(done);
        return true;
    }
    catch (e) {
        const m = errMsg(e);
        if (m.length > 90 || m.includes('\n'))
            openModal(`<h3>Git said no</h3><pre class="git-err">${esc(m)}</pre><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
        else
            toast(m);
        return false;
    }
    finally {
        gitBusy = false;
        $('#scm').classList.remove('busy');
        await refreshGit();
    }
}
function confirmDiscardChanges(files) {
    if (!files.length)
        return;
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
function diffLineClass(l) {
    if (l.startsWith('@@'))
        return 'hunk';
    if (l.startsWith('+'))
        return 'add';
    return l.startsWith('-') ? 'del' : '';
}
async function showDiff(f, staged) {
    let text = '';
    try {
        if (f.x === '?') {
            const r = await api.fs.readFile(f.path);
            text = (r.text ?? '(binary file)').split('\n').map(l => '+' + l).join('\n');
        }
        else
            text = await api.git.diff(f.path, staged);
    }
    catch (e) {
        toast(errMsg(e));
        return;
    }
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
// The first free lane (or a new one) for a commit.
function claimLane(lanes, hash) {
    let i = lanes.indexOf(hash);
    if (i !== -1)
        return i;
    i = lanes.indexOf(null);
    if (i === -1)
        i = lanes.length;
    lanes[i] = hash;
    return i;
}
function layoutGraph(commits) {
    const lanes = [];
    return commits.map(c => {
        const lane = claimLane(lanes, c.hash);
        const before = lanes.slice();
        const merges = before.map((h, i) => (h === c.hash && i !== lane ? i : -1)).filter(i => i >= 0);
        merges.forEach(i => { lanes[i] = null; });
        lanes[lane] = c.parents[0] ?? null;
        const forks = c.parents.slice(1).map(p => claimLane(lanes, p));
        while (lanes.length && lanes.at(-1) == null)
            lanes.pop();
        return { c, lane, before, after: lanes.slice(), merges, forks };
    });
}
const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];
function graphSvg(r, H, X) {
    const mid = H / 2;
    const paths = r.before.map((h, i) => {
        if (!h)
            return '';
        if (i === r.lane)
            return `<path d="M${X(i)} 0V${mid}" stroke="${laneColor(i)}"/>`;
        if (r.merges.includes(i))
            return `<path d="M${X(i)} 0C${X(i)} ${mid} ${X(r.lane)} ${mid / 2} ${X(r.lane)} ${mid}" stroke="${laneColor(i)}"/>`;
        return `<path d="M${X(i)} 0V${H}" stroke="${laneColor(i)}"/>`;
    });
    if (r.after[r.lane])
        paths.push(`<path d="M${X(r.lane)} ${mid}V${H}" stroke="${laneColor(r.lane)}"/>`);
    for (const f of r.forks)
        paths.push(`<path d="M${X(r.lane)} ${mid}C${X(r.lane)} ${H} ${X(f)} ${mid} ${X(f)} ${H}" stroke="${laneColor(f)}"/>`);
    const isHead = r.c.hash === gitLog.head;
    const fill = isHead ? laneColor(r.lane) : 'var(--bg-1)';
    paths.push(`<circle cx="${X(r.lane)}" cy="${mid}" r="${isHead ? 5 : 4}" fill="${fill}" stroke="${laneColor(r.lane)}" stroke-width="2"/>`);
    return paths.join('');
}
function refClass(ref) {
    if (ref.startsWith('HEAD'))
        return 'head';
    if (ref.startsWith('tag: '))
        return 'tag';
    return ref.includes('/') ? 'remote' : 'branch';
}
function renderGraphRows() {
    if (!gitLog.commits.length)
        return '<p class="side-note">No checkpoints yet. Commit your changes to save the first one.</p>';
    const rows = layoutGraph(gitLog.commits);
    const H = 30, X = (i) => 10 + i * 12;
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
function commitDetailHtml(d) {
    if (!d)
        return '<div class="commit-detail"><div class="side-note">Loading…</div></div>';
    const files = d.files.map(f => `<div class="file" data-open-file="${escAttr(f.path)}"><span class="ico">${fileIcon(baseName(f.path))}</span><span class="fp">${esc(f.path)}</span><span><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span></div>`);
    return `<div class="commit-detail">
    <div class="cd-msg">${esc(d.message)}</div>
    <div class="cd-meta">${esc(d.author)} · ${esc(d.when)} · <code>${d.hash.slice(0, 8)}</code></div>
    ${files.join('')}
    <div class="row mt-8"><button class="btn btn-sm" data-branch-from="${d.hash}">Branch from here</button><button class="btn btn-sm" data-copy-hash="${d.hash}">Copy id</button></div>
  </div>`;
}
async function toggleCommit(hash) {
    openCommit = openCommit === hash ? null : hash;
    renderScm();
    if (openCommit && !commitDetails.has(hash)) {
        try {
            commitDetails.set(hash, await api.git.show(hash));
        }
        catch (e) {
            toast(errMsg(e));
            openCommit = null;
        }
        renderScm();
    }
}
$('#scm').addEventListener('click', e => {
    const t = e.target;
    const f = t.closest('[data-open-file]');
    if (f) {
        e.stopPropagation();
        openFile(f.dataset.openFile);
    }
    const b = t.closest('[data-branch-from]');
    if (b) {
        e.stopPropagation();
        void newBranch(b.dataset.branchFrom);
    }
    const c = t.closest('[data-copy-hash]');
    if (c) {
        e.stopPropagation();
        background(navigator.clipboard.writeText(c.dataset.copyHash ?? '').then(() => toast('Commit id copied')));
    }
}, true);
async function commitNow() {
    const msg = scmDraft.trim();
    if (!msg) {
        toast('Write a short message describing this checkpoint');
        $('#scmMsg')?.focus();
        return;
    }
    const files = gitState.files ?? [];
    if (!files.length) {
        toast('Nothing to commit');
        return;
    }
    await saveAll();
    const all = !files.some(f => f.x !== ' ' && f.x !== '?');
    let hash = '';
    if (await gitOp(async () => { hash = await api.git.commit(msg, all); })) {
        scmDraft = '';
        renderScm();
        toast(`Checkpoint saved · ${hash}`);
    }
}
async function newBranch(from) {
    const name = await askName(from ? 'New branch from this checkpoint' : 'New branch', '', 'Create');
    if (!name)
        return;
    await gitOp(() => api.git.switchTo(name, true, from), `Switched to new branch ${name}`);
}
function branchListHtml(branches, q) {
    const create = q && !branches.includes(q) ? `<div class="qo-item" data-new="1"><span>＋ Create branch “${esc(q)}”</span></div>` : '';
    const rows = branches.filter(b => b.toLowerCase().includes(q.toLowerCase())).map(b => {
        const current = b === gitState.branch;
        return `<div class="qo-item ${current ? 'on' : ''}" data-br="${escAttr(b)}"><span>⎇ ${esc(b)}</span>${current ? '<small>current</small>' : ''}</div>`;
    });
    return create + rows.join('');
}
async function pickBranch() {
    if (!gitState.repo) {
        showView('git', true);
        return;
    }
    const branches = await api.git.branches().catch(() => []);
    openModal(`<input class="input w-full" id="brIn" aria-label="Branch name" placeholder="Switch to a branch, or type a new name" spellcheck="false"><div class="qo-list" id="brList"></div>`, m => {
        const input = $('#brIn', m);
        input.focus();
        const switchTo = (name, create) => {
            closeModal();
            const msg = create ? `Switched to new branch ${name}` : `Switched to ${name}`;
            if (create || name !== gitState.branch)
                void gitOp(() => api.git.switchTo(name, create), msg);
        };
        const render = () => {
            const q = input.value.trim();
            $('#brList', m).innerHTML = branchListHtml(branches, q);
            $$('[data-br]', m).forEach(el => el.onclick = () => switchTo(el.dataset.br, false));
            $('[data-new]', m)?.addEventListener('click', () => switchTo(q, true));
        };
        input.oninput = render;
        input.onkeydown = e => { if (e.key === 'Enter')
            $('[data-new], [data-br]', m)?.click(); };
        render();
    }, undefined, 'top');
}
$('#sbBranch').onclick = () => void pickBranch();
async function syncBranch() {
    const s = gitState;
    if (!s.upstream)
        return gitOp(() => api.git.sync('push'), 'Branch published');
    if (!s.behind)
        return gitOp(() => api.git.sync('push'), 'Pushed');
    return gitOp(async () => {
        await api.git.sync('pull');
        if (s.ahead)
            await api.git.sync('push');
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
function showView(v, reveal = false) {
    layout.view = v;
    if (reveal && !layout.sideOpen)
        layout.sideOpen = true;
    applyLayout();
    $$('.act-btn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== v));
    if (v === 'git')
        void refreshGit();
    if (v === 'people')
        renderPeople();
}
// Clicking the active view's icon again collapses the side bar, like VS Code.
$$('.act-btn[data-view]').forEach(b => b.onclick = () => {
    const v = b.dataset.view;
    if (v === layout.view && layout.sideOpen) {
        layout.sideOpen = false;
        applyLayout();
    }
    else
        showView(v, true);
});
/* ================= Collaboration ================= */
let sharing = false;
let shareKey = '';
let guests = [];
const share = { files: true, preview: true, terminal: false };
function newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const raw = [...bytes].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 26);
    const groups = raw.match(/.{1,6}/g) ?? [];
    return 'brz-' + groups.join('-');
}
$('#shareBtn').onclick = openShare;
const switchHtml = (key, label, note = '') => `<div class="toggle-row"><span>${label}${note}</span><button class="switch ${share[key] ? 'on' : ''}" data-sw="${key}" aria-label="${label}"></button></div>`;
function endSharing() {
    sharing = false;
    guests = [];
    guestCursor = null;
    shareKey = '';
    closeModal();
    updateShare();
    renderCode();
    toast('Session ended');
}
function openShare() {
    if (!shareKey)
        shareKey = newKey();
    const end = sharing ? '<button class="btn btn-sm btn-ghost text-err" id="endShare">End session</button>' : '';
    openModal(`
    <h3>Share this project</h3>
    <p class="sub">Send this key to a friend. They'll wait until you let them in.</p>
    <div class="keybox"><span class="flex-1" id="keyText">${shareKey}</span><button class="btn btn-sm" id="copyKey">Copy</button></div>
    ${switchHtml('files', 'Share files')}${switchHtml('preview', 'Share preview')}${switchHtml('terminal', 'Share terminal', ' <small class="text-3">(they could see command output)</small>')}
    <p class="share-note">Relay runs on <b>ALEX-LAPTOP</b> (LAN, tunnel backup). It can see shared code. Key expires in 4 hours.</p>
    <div id="joinSlot"></div>
    <div class="row between spaced">
      <div class="row"><button class="btn btn-sm btn-ghost" id="regen">New key</button>${end}</div>
      <button class="btn btn-primary" data-close>${sharing ? 'Done' : 'Start sharing'}</button>
    </div>`, m => {
        $('#copyKey', m).onclick = () => background(navigator.clipboard.writeText(shareKey).then(() => toast('Key copied')));
        $('#regen', m).onclick = () => { shareKey = newKey(); $('#keyText', m).textContent = shareKey; toast('Old key revoked'); };
        $$('[data-sw]', m).forEach(s => s.onclick = () => {
            const k = s.dataset.sw;
            share[k] = !share[k];
            s.classList.toggle('on');
        });
        const endBtn = m.querySelector('#endShare');
        if (endBtn)
            endBtn.onclick = endSharing;
        if (!sharing) {
            sharing = true;
            updateShare();
            setTimeout(() => joinRequest(m), 2200);
        }
    });
}
function joinRequest(m) {
    const slot = m.querySelector('#joinSlot');
    if (!slot?.isConnected || guests.length)
        return;
    let role = 'Viewer';
    slot.innerHTML = `<div class="join-req"><div class="fw-600 mb-6">Sam wants to join</div>
    <div class="row mb-10"><span class="text-2">Role:</span><div class="seg flex-1"><button class="on" data-role>Viewer</button><button data-role>Editor</button></div></div>
    <div class="row end"><button class="btn btn-sm" id="denyJoin">Deny</button><button class="btn btn-sm btn-primary" id="allowJoin">Allow</button></div></div>`;
    $$('[data-role]', slot).forEach(b => b.onclick = () => { role = b.textContent; $$('[data-role]', slot).forEach(x => x.classList.toggle('on', x === b)); });
    $('#denyJoin', slot).onclick = () => { slot.innerHTML = '<p class="resolved mt-10">Request denied.</p>'; };
    $('#allowJoin', slot).onclick = () => {
        guests.push({ name: 'Sam', role, tint: 'guest' });
        slot.innerHTML = `<p class="resolved mt-10">✓ Sam joined as ${role}.</p>`;
        updateShare();
        if (role === 'Editor' && active) {
            guestCursor = { file: active, line: Math.min(10, (activeBuf()?.text.split('\n').length ?? 1) - 1), name: 'Sam', tint: 'guest' };
            renderCode();
        }
    };
}
function updateShare() {
    $('#sbShare').textContent = sharing ? `● Sharing · ${guests.length + 1} people` : 'Not sharing';
    renderUser();
    $('#termShare').textContent = share.terminal && sharing ? 'Shared' : 'Not shared';
    renderPeople();
}
function renderPeople() {
    const rows = [{ name: 'You', role: 'Host', tint: 'host' }, ...guests];
    const people = rows.map(p => `<div class="tree-item"><span class="avatar small tint-${p.tint}">${p.name.slice(0, 2).toUpperCase()}</span>${p.name}<span class="pill ml-auto">${p.role}</span></div>`);
    const invite = sharing ? '' : '<p class="people-note">Press <b>Share</b> to invite someone.</p>';
    $('#people').innerHTML = people.join('') + invite;
}
/* ================= Vibe Mode ================= */
// While an agent works, the IDE fades and blurs away and the user's feed plays in a 9:16 frame.
// In the desktop app main.js lays the live site exactly over #vibeFrame; the browser preview shows a placeholder.
const VIBE_DELAY = 3000; // quick answers don't trigger it
let vibeOn = false;
let vibeTimer;
let vibeClock;
let vibeStarted = 0;
let vibeMuted = false;
let vibeSiteShown = null;
const vibeFrame = $('#vibeFrame');
const agentWorking = () => Object.values(agentsDef).some(a => a.status === 'working');
function setVibeArmed(on) {
    appState.vibeArmed = on;
    saveApp();
    $('#vibeArm').textContent = on ? '◉ Vibe Mode on' : '◌ Vibe Mode off';
    $('#vibeArm').classList.toggle('armed', on);
}
$('#vibeArm').onclick = () => {
    if (appState.vibeArmed) {
        setVibeArmed(false);
        toast('Vibe Mode off');
        return;
    }
    if (!connectedSites().length) {
        openFeedPicker();
        return;
    }
    setVibeArmed(true);
    toast(`Vibe Mode on — ${siteById(appState.vibeSite)?.name ?? 'your feed'} plays while agents work`);
};
function openFeedPicker() {
    openModal(`<h3>Vibe Mode feeds</h3><p class="sub">Pick what plays while your agents work. Connecting opens the site so you can sign in.</p>
    <div class="social-grid" id="feedPick"></div><div class="row end"><button class="btn btn-primary" data-close>Done</button></div>`, m => void renderFeedChoices($('#feedPick', m)), () => { if (connectedSites().length && !appState.vibeArmed)
        setVibeArmed(true); });
}
commands['vibe.feeds'] = openFeedPicker;
function frameRect() {
    const r = vibeFrame.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}
function renderVibeSites() {
    $('#vibeSites').innerHTML = connectedSites().map(s => `<button class="${s.id === vibeSiteShown ? 'on' : ''}" data-vibe-site="${s.id}"><span class="mark tint-${s.id}">${s.mark}</span>${esc(s.name)}</button>`).join('');
    $$('[data-vibe-site]').forEach(b => b.onclick = () => { appState.vibeSite = b.dataset.vibeSite ?? null; saveApp(); showFeed(); });
}
function showFeed() {
    const site = siteById(appState.vibeSite) ?? connectedSites()[0];
    vibeSiteShown = site?.id ?? null;
    renderVibeSites();
    const placeholder = $('#vibePlaceholder');
    placeholder.classList.toggle('hidden', isDesktop && !!site);
    placeholder.innerHTML = site
        ? `<div><span class="mark tint-${site.id} big-mark">${site.mark}</span><h4>${esc(site.name)}</h4><div>Your feed plays here in the Breeze desktop app.</div></div>`
        : '<div><h4>No feed connected</h4><div>Open Settings → Vibe Mode Feeds to connect one.</div></div>';
    if (site && isDesktop)
        background(api.vibe.show(site.id, frameRect()));
}
function tickVibeClock() {
    const s = Math.floor((Date.now() - vibeStarted) / 1000);
    $('#vibeClock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const a = Object.values(agentsDef).find(x => x.status === 'working');
    if (a)
        $('#vibeTask').textContent = `${a.name}: ${a.task}`;
}
function enterVibe() {
    if (vibeOn)
        return;
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
    setTimeout(() => { if (vibeOn)
        showFeed(); }, 450);
}
function exitVibe() {
    if (!vibeOn)
        return;
    vibeOn = false;
    clearInterval(vibeClock);
    if (isDesktop)
        background(api.vibe.hide());
    document.body.classList.remove('vibing');
    $('#vibe').classList.add('hidden');
}
// Called whenever an agent's status changes.
function vibeTick() {
    if (!appState.vibeArmed || !connectedSites().length || vibeOn || vibeTimer != null || !agentWorking())
        return;
    vibeTimer = setTimeout(() => {
        vibeTimer = undefined;
        if (agentWorking())
            enterVibe();
    }, VIBE_DELAY);
}
function vibeDone(ok) {
    clearTimeout(vibeTimer);
    vibeTimer = undefined;
    if (!vibeOn)
        return;
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
    if (t)
        openFile(t);
};
$('#vibeMute').onclick = () => {
    vibeMuted = !vibeMuted;
    $('#vibeMute use').setAttribute('href', vibeMuted ? '#i-mute' : '#i-sound');
    $('#vibeMute').title = vibeMuted ? 'Unmute' : 'Mute';
    if (isDesktop)
        background(api.vibe.mute(vibeMuted));
};
// Keep the live feed glued to the frame when the window changes size.
new ResizeObserver(() => { if (vibeOn && vibeSiteShown && isDesktop)
    background(api.vibe.bounds(frameRect())); }).observe(vibeFrame);
/* ================= Discord ================= */
let discord = false;
$('#discord').onclick = () => {
    if (discord) {
        discord = false;
        $('#discord').textContent = 'Discord: off';
        return;
    }
    const detail = [rootInfo?.name ?? 'No project', active ? baseName(active) : null, active ? langOf(active)[1] : null]
        .filter((s) => !!s).map(esc).join(' · ');
    openModal(`<h3>Show what you're doing on Discord?</h3><p class="sub">Your friends will see:</p>
    <div class="setup-card mb-12"><b>Breeze IDE</b><div class="text-2">Vibe coding with agents</div><div class="text-2">${detail}</div><div class="text-3 fs-12">00:14 elapsed</div></div>
    <p class="sub fs-12">Project and file names can include client or employer names. You can hide details anytime from the status bar.</p>
    <div class="row end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="dOn">Turn on</button></div>`, m => { $('#dOn', m).onclick = () => { discord = true; $('#discord').textContent = 'Discord: on'; closeModal(); }; });
};
/* ================= Modal & misc ================= */
let modalOnClose = null;
const modalOpen = () => !!document.querySelector('#modalRoot .scrim:not(.closing)');
function openModal(html, bind, onClose, place = 'center') {
    closeModal();
    $$('#modalRoot .scrim.closing').forEach(x => x.remove());
    const top = place === 'top';
    $('#modalRoot').insertAdjacentHTML('beforeend', `<div class="scrim ${top ? 'top' : ''}"><div class="modal ${top ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`);
    const m = $('#modalRoot .scrim:not(.closing) .modal');
    modalOnClose = onClose ?? null;
    $('#modalRoot .scrim:not(.closing)').onmousedown = e => { if (e.target.classList.contains('scrim'))
        closeModal(); };
    $$('[data-close]', m).forEach(b => b.onclick = closeModal);
    bind?.(m);
}
function closeModal() {
    const scrim = $('#modalRoot .scrim:not(.closing)');
    if (!scrim)
        return;
    // Play the closing animation on a detached copy so a new modal can open immediately.
    scrim.classList.add('closing');
    setTimeout(() => scrim.remove(), 150);
    const cb = modalOnClose;
    modalOnClose = null;
    cb?.();
}
function bindToasts(root = document) {
    $$('[data-toast]', root).forEach(b => b.onclick = () => toast(b.dataset.toast ?? ''));
}
/* ================= Init ================= */
async function boot() {
    buildMenubar();
    applyLayout();
    showView(layout.view);
    renderTree();
    renderTabs();
    renderEditor();
    renderAgents();
    renderPreview();
    emptyChat();
    renderScm();
    renderBranch();
    bindToasts();
    renderDetection();
    setVibeArmed(appState.vibeArmed);
    // The main process remembers who signed in; it wins over the renderer's copy.
    const signed = await api.auth.user().catch(() => null);
    if (signed || isDesktop) {
        user = signed;
        appState.user = signed;
        saveApp();
    }
    if (appState.onboarded)
        showIde();
    else
        goStep(step);
    const info = await api.fs.restore().catch(() => null);
    if (info)
        await loadWorkspace(info);
    else {
        term.cwd = await api.term.cwd();
        renderPs();
    }
    renderTree();
    if (step === STEP.setup)
        renderProjectChoice();
    // Refresh the tool and agent status in the background; the cached result shows meanwhile.
    if (appState.onboarded)
        detectTools().catch(() => { });
}
background(boot());
