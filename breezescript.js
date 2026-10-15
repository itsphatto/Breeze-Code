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
const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
// IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message.
const errMsg = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('#toastRoot').replaceChildren(t);
    setTimeout(() => t.remove(), 2600);
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
function demoApi() {
    const files = new Map(Object.entries(DEMO_FILES));
    const binary = new Set(['assets/beans.jpg']);
    const dirs = new Set(['assets']);
    const info = { root: 'demo:/coffee-shop-landing', name: 'coffee-shop-landing' };
    const under = (p, rel) => (rel ? p.startsWith(rel + '/') : true);
    const exists = (p) => files.has(p) || dirs.has(p);
    const needOpen = () => { if (!store.get('breeze.demoOpen', false))
        throw new Error('No folder is open'); };
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
                return [...seen].map(([name, dir]) => ({ name, dir }))
                    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
            },
            async readFile(rel) {
                if (!files.has(rel))
                    throw new Error('File not found');
                return binary.has(rel) ? { binary: true, size: 48213 } : { text: files.get(rel), size: (files.get(rel) ?? '').length };
            },
            async writeFile(rel, text) { files.set(rel, text); },
            async createFile(rel) { if (exists(rel))
                throw new Error('A file with that name already exists'); files.set(rel, ''); },
            async createDir(rel) { if (exists(rel))
                throw new Error('A folder with that name already exists'); dirs.add(rel); },
            async rename(from, to) {
                if (exists(to))
                    throw new Error('Something with that name already exists');
                const move = (set) => {
                    for (const k of [...set.keys()]) {
                        if (k !== from && !k.startsWith(from + '/'))
                            continue;
                        const nk = to + k.slice(from.length);
                        if (set instanceof Map) {
                            set.set(nk, set.get(k));
                            set.delete(k);
                        }
                        else {
                            set.delete(k);
                            set.add(nk);
                        }
                    }
                };
                move(files);
                move(dirs);
                move(binary);
            },
            async trash(rel) {
                for (const set of [files, dirs, binary])
                    for (const k of [...set.keys()])
                        if (k === rel || k.startsWith(rel + '/'))
                            set.delete(k);
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
            async fileUrl() { return ''; },
            onChange() { return () => { }; },
        },
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
                return {
                    demo: true, platform: 'browser',
                    agents: [
                        { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', url: 'https://claude.com/product/claude-code', found: true, path: null, version: null },
                        { id: 'codex', name: 'Codex', vendor: 'OpenAI', url: 'https://developers.openai.com/codex/cli', found: false, path: null, version: null },
                        { id: 'antigravity', name: 'Antigravity', vendor: 'Google', url: 'https://antigravity.google', found: false, path: null, version: null },
                        { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', url: 'https://github.com/google-gemini/gemini-cli', found: false, path: null, version: null },
                    ],
                    tools: [{ id: 'git', name: 'Git', found: true, version: null }, { id: 'node', name: 'Node.js', found: true, version: null }],
                };
            },
            async openExternal(url) { window.open(url, '_blank', 'noopener'); },
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
const api = window.breeze ?? demoApi();
const appState = { onboarded: false, step: 0, user: null, agent: null, detect: null, ...store.get('breeze.app', {}) };
const saveApp = () => store.set('breeze.app', appState);
/* ================= Onboarding ================= */
let step = appState.step;
let user = appState.user;
function goStep(n) {
    step = n;
    appState.step = n;
    saveApp();
    $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
    $$('.ob-dots span').forEach((d, i) => d.classList.toggle('on', i === n));
    if (n === 2) {
        detectTools();
        renderProjectChoice();
    }
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));
function signedIn(provider) {
    user = { name: 'You', provider };
    appState.user = user;
    goStep(2);
}
let signinTimer;
$$('[data-signin]').forEach(b => b.onclick = () => {
    $('#signinChoices').classList.add('hidden');
    $('#signinWait').classList.remove('hidden');
    const provider = b.dataset.signin ?? 'GitHub';
    signinTimer = setTimeout(() => signedIn(provider), 1600);
});
$('#signinCancel').onclick = () => { clearTimeout(signinTimer); $('#signinWait').classList.add('hidden'); $('#signinChoices').classList.remove('hidden'); };
$('#signinRetry').onclick = () => { clearTimeout(signinTimer); signinTimer = setTimeout(() => signedIn('GitHub'), 1200); };
/* ----- AI agent detection ----- */
const AGENT_STYLE = {
    claude: { letter: 'C', color: '#d97757' },
    codex: { letter: 'Cx', color: '#e4e4e7' },
    antigravity: { letter: 'A', color: '#7aa9ff' },
    gemini: { letter: 'G', color: '#a78bfa' },
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
        $('#agentList').innerHTML = '<div class="row" style="color:var(--text-3)"><div class="spinner" style="width:16px;height:16px;border-width:2px"></div>Checking this computer…</div>';
    detecting = api.sys.detect().then(d => {
        appState.detect = d;
        const found = d.agents.filter(a => a.found);
        if (!appState.agent || !found.some(a => a.id === appState.agent))
            appState.agent = found[0]?.id ?? null;
        saveApp();
        renderDetection();
        return d;
    }).catch(e => {
        $('#aiPill').className = 'pill warn';
        $('#aiPill').textContent = 'Scan failed';
        $('#aiHint').textContent = errMsg(e);
        throw e;
    }).finally(() => { detecting = null; });
    return detecting;
}
function agentOptionsHtml(d) {
    return d.agents.map(a => {
        const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], color: '#a1a1aa' };
        const on = a.id === appState.agent;
        const sub = a.found
            ? [a.version ? `v${a.version}` : 'Installed', a.path ?? (d.demo ? 'browser preview' : '')].filter(Boolean).join(' · ')
            : `${a.vendor} · not installed`;
        const side = a.found
            ? `<span class="pill ${on ? 'blue' : 'ok'} side">${on ? 'Selected' : 'Detected'}</span>`
            : `<button class="get side" data-get="${escAttr(a.url)}">Get it ↗</button>`;
        return `<div class="agent-opt ${a.found ? '' : 'missing'} ${on ? 'on' : ''}" ${a.found ? `role="button" tabindex="0" data-agent="${a.id}"` : ''}>
      <span class="mark" style="background:${st.color}">${st.letter}</span><span class="nm">${esc(a.name)}</span>${side}
      <span class="sub" title="${escAttr(sub)}">${esc(sub)}</span></div>`;
    }).join('');
}
function bindAgentOptions(root, onPick) {
    $$('[data-agent]', root).forEach(el => {
        const pick = () => { appState.agent = el.dataset.agent ?? null; saveApp(); onPick(); };
        el.onclick = pick;
        el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
        } };
    });
    $$('[data-get]', root).forEach(b => b.onclick = e => { e.stopPropagation(); api.sys.openExternal(b.dataset.get ?? ''); });
}
function renderDetection() {
    const d = appState.detect;
    if (!d)
        return;
    const found = d.agents.filter(a => a.found);
    $('#agentList').innerHTML = agentOptionsHtml(d);
    bindAgentOptions($('#agentList'), renderDetection);
    $('#aiPill').className = found.length ? 'pill ok' : 'pill warn';
    $('#aiPill').textContent = found.length ? `${found.length} detected` : 'None found';
    $('#aiHint').textContent = found.length
        ? 'Pick the agent Breeze hands work to. It uses the agent\'s own sign-in, so there is no API key to paste.'
        : 'No coding agent found on this computer. Install one, then press rescan.';
    if (d.demo)
        $('#aiHint').textContent += ' (Browser preview: detection runs in the desktop app.)';
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
function selectedAgent() {
    return appState.detect?.agents.find(a => a.id === appState.agent && a.found) ?? null;
}
function renderAgentPill() {
    const a = selectedAgent();
    $('#agentPill').textContent = a ? `${a.name} · approve plan` : 'No agent · choose';
    agentsDef.planner.model = agentsDef.builder.model = a ? a.name : 'no agent';
    renderAgents();
}
$('#agentPill').onclick = openAgentPicker;
$('#agentPill').style.cursor = 'pointer';
$('#agentPill').title = 'Choose which AI agent to use';
function openAgentPicker() {
    openModal(`<h3>Choose your AI agent</h3><p class="sub">Breeze looks for coding agents installed on this computer.</p>
    <div class="agent-list" id="pickList"></div>
    <div class="row" style="justify-content:space-between;margin-top:16px"><button class="btn btn-sm btn-ghost" id="pickRescan">Scan again</button><button class="btn btn-primary" data-close>Done</button></div>`, m => {
        const render = () => {
            if (!appState.detect) {
                $('#pickList', m).innerHTML = '<div style="color:var(--text-3)">Scanning…</div>';
                return;
            }
            $('#pickList', m).innerHTML = agentOptionsHtml(appState.detect);
            bindAgentOptions($('#pickList', m), () => { render(); renderDetection(); });
        };
        render();
        $('#pickRescan', m).onclick = () => { $('#pickList', m).innerHTML = '<div style="color:var(--text-3)">Scanning…</div>'; detectTools().then(render, () => { }); };
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
$('#pickFolder').onclick = async () => {
    const r = await api.fs.openFolder();
    if (r) {
        await loadWorkspace(r);
        renderProjectChoice();
    }
};
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
    $('#userChip').textContent = `● Signed in with ${user?.provider ?? 'GitHub'}`;
    applyLayout();
    renderEditor();
}
/* ================= Agents (data) ================= */
const agentsDef = {
    planner: { name: 'Planner', letter: 'P', color: 'var(--c-planner)', model: 'no agent', status: 'idle', task: 'Waiting for a prompt', used: 0 },
    builder: { name: 'Builder', letter: 'B', color: 'var(--c-builder)', model: 'no agent', status: 'idle', task: 'Waiting for a plan', used: 0 },
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
};
function langOf(path) {
    const name = baseName(path).toLowerCase();
    if (name.startsWith('.env'))
        return ['py', 'Environment'];
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    return LANGS[ext] ?? ['', 'Plain Text'];
}
const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set type interface enum implements private public protected readonly declare as true false null undefined';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
const STR_RE = String.raw `"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?`;
const NUM_RE = String.raw `\b(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const words = (s) => s.split(' ').join('|');
const LEXERS = {
    js: new RegExp(String.raw `(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<str>${STR_RE}|\x60(?:\\[\s\S]|[^\x60\\])*\x60?)|(?<num>${NUM_RE})|(?<kw>\b(?:${words(JS_KW)})\b)|(?<prop>\b[A-Za-z_$][\w$]*(?=\())`, 'g'),
    css: new RegExp(String.raw `(?<com>\/\*[\s\S]*?(?:\*\/|$))|(?<str>${STR_RE})|(?<kw>@[\w-]+|!important)|(?<tag>[.#]?-?[A-Za-z_][\w-]*(?=[^{};]*\{))|(?<prop>--?[A-Za-z_][\w-]*(?=\s*:))|(?<num>#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)`, 'g'),
    json: new RegExp(String.raw `(?<prop>"(?:\\.|[^"\\\n])*"(?=\s*:))|(?<str>"(?:\\.|[^"\\\n])*"?)|(?<num>-?${NUM_RE})|(?<kw>\b(?:true|false|null)\b)`, 'g'),
    py: new RegExp(String.raw `(?<com>#[^\n]*)|(?<str>"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${STR_RE})|(?<num>${NUM_RE})|(?<kw>\b(?:${words(PY_KW)})\b)|(?<prop>\b[A-Za-z_]\w*(?=\())`, 'g'),
    md: new RegExp(String.raw `(?<kw>^#{1,6}[^\n]*)|(?<str>\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)|\x60[^\x60\n]*\x60)|(?<com>^>[^\n]*)|(?<attr>\*\*[^*\n]+\*\*|\[[^\]\n]*\]\([^)\n]*\))`, 'gm'),
    html: /(?<com><!--[\s\S]*?(?:-->|$))|(?<tagblock><[!/]?[A-Za-z][^>]*>?)/g,
};
const HTML_TAG = /(?<tag>^<[!/]?[\w:-]+|\/?>$)|(?<str>"[^"]*"?|'[^']*'?)|(?<attr>[^\s="'<>/]+)/g;
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
        const kind = Object.keys(m.groups ?? {}).find(k => m.groups[k] !== undefined) ?? null;
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
// Highlight a whole document and return one HTML string per line (tokens can span lines).
function highlightLines(text, lexer) {
    if (!LEXERS[lexer] || text.length > 400000)
        return text.split('\n').map(esc);
    const re = LEXERS[lexer];
    const toks = lex(text, re);
    const lines = [''];
    for (const [cls, t] of toks) {
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
function fileIcon(name) {
    const n = name.toLowerCase();
    if (n.startsWith('.env'))
        return '🔒';
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
    return { html: '◇', htm: '◇', css: '#', scss: '#', js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JS', ts: 'TS', tsx: 'TS', json: '{}', md: 'M↓', py: 'Py',
        png: '▣', jpg: '▣', jpeg: '▣', gif: '▣', svg: '▣', webp: '▣', ico: '▣' }[ext] ?? '·';
}
let rootInfo = null;
const dirCache = new Map();
const expanded = new Set();
const buffers = new Map();
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
    await loadDir('');
    for (const d of s.expanded) {
        expanded.add(d);
        await loadDir(d);
    }
    renderTree();
    for (const p of s.tabs) {
        const b = await loadBuffer(p);
        if (!b)
            continue;
        if (b.kind === 'text' && dirty[p] != null) {
            b.text = dirty[p];
            if (b.ta)
                b.ta.value = b.text;
        }
        if (b.ta && s.pos[p]) {
            b.ta.setSelectionRange(s.pos[p][0], s.pos[p][0]);
            b.ta.scrollTop = s.pos[p][1];
        }
        openTabs.push(p);
    }
    active = s.active && openTabs.includes(s.active) ? s.active : openTabs[0] ?? null;
    renderTabs();
    renderEditor();
    renderTree();
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
}
async function loadDir(rel) {
    try {
        dirCache.set(rel, await api.fs.readDir(rel));
    }
    catch {
        dirCache.delete(rel);
        expanded.delete(rel);
    }
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
        path, size: r.size,
        kind: r.binary ? 'binary' : r.tooLarge ? 'large' : 'text',
        eol: raw.includes('\r\n') ? '\r\n' : '\n',
        text: raw.replace(/\r\n/g, '\n'), saved: '', ta: null,
    };
    b.saved = b.text;
    if (b.kind === 'text')
        b.ta = createTextarea(b);
    buffers.set(path, b);
    return b;
}
// Each open file keeps its own textarea so undo history survives tab switches.
function createTextarea(b) {
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
        if (wasDirty !== isDirty(b)) {
            renderTabs();
            renderTree();
        }
        if (findOpen)
            runFind(false);
        queueRender();
        saveSession();
    });
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', editorKeys);
    for (const ev of ['keyup', 'mouseup', 'select', 'selectionchange', 'focus'])
        ta.addEventListener(ev, updateCaret);
    $('#editor .code').appendChild(ta);
    return ta;
}
/* ================= Explorer ================= */
function renderTree() {
    const el = $('#tree');
    if (!rootInfo) {
        el.innerHTML = `<div class="side-note">You have not opened a folder yet.<button class="btn btn-primary btn-sm" data-act="file.openFolder">Open Folder</button></div><div id="recentList"></div>`;
        renderRecent();
        return;
    }
    const rows = [];
    const walk = (rel, depth) => {
        for (const e of dirCache.get(rel) ?? []) {
            const p = joinPath(rel, e.name);
            const open = e.dir && expanded.has(p);
            const lock = locks[p];
            const lockTag = lock ? `<span class="lock" style="background:${agentsDef[lock].color};color:#000">${agentsDef[lock].name}</span>` : '';
            const cls = ['tree-item', p === active ? 'on' : '', isDirty(buffers.get(p)) ? 'dirty' : '', p === ctxPath ? 'ctx' : ''].filter(Boolean).join(' ');
            rows.push(`<div class="${cls}" style="padding-left:${8 + depth * 12}px" data-path="${escAttr(p)}" ${e.dir ? 'data-dir="1"' : ''} title="${escAttr(p)}">
        <span class="ico">${e.dir ? (open ? '▾' : '▸') : fileIcon(e.name)}</span><span class="nm">${esc(e.name)}</span>${lockTag}</div>`);
            if (open)
                walk(p, depth + 1);
        }
    };
    walk('', 0);
    el.innerHTML = rows.join('') || '<p class="side-note">This folder is empty.</p>';
}
async function renderRecent() {
    const recent = await api.fs.recent().catch(() => []);
    const el = document.getElementById('recentList');
    if (!el || !recent.length)
        return;
    el.innerHTML = `<div class="side-head" style="padding-left:8px">Recent</div>` +
        recent.map(r => `<div class="tree-item" data-recent="${escAttr(r.path)}" title="${escAttr(r.path)}"><span class="ico">▸</span><span class="nm">${esc(r.name)}</span></div>`).join('');
}
$('#tree').addEventListener('click', e => {
    const t = e.target.closest('[data-path],[data-recent],[data-act]');
    if (!t)
        return;
    if (t.dataset.act)
        return; // handled by the global data-act listener
    if (t.dataset.recent) {
        openRecentFolder(t.dataset.recent);
        return;
    }
    const p = t.dataset.path;
    if (t.dataset.dir)
        toggleDir(p);
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
    popupMenu(e.clientX, e.clientY, [
        { label: 'New File…', run: () => newEntry(dir, false) },
        { label: 'New Folder…', run: () => newEntry(dir, true) },
        ...(p ? [
            { sep: true },
            { label: 'Rename…', key: 'F2', run: () => renameEntry(p) },
            { label: 'Delete', key: 'Delete', run: () => deleteEntry(p, isDir) },
            { sep: true },
            { label: 'Copy Relative Path', run: () => { navigator.clipboard?.writeText(p).catch(() => { }); toast('Path copied'); } },
        ] : []),
    ], () => { ctxPath = null; renderTree(); });
});
async function toggleDir(p) {
    if (expanded.has(p))
        expanded.delete(p);
    else {
        expanded.add(p);
        if (!dirCache.has(p))
            await loadDir(p);
    }
    renderTree();
    saveSession();
}
async function refreshTree() {
    if (!rootInfo)
        return;
    await loadDir('');
    for (const d of [...expanded])
        await loadDir(d);
    renderTree();
}
// The folder new files go into: right-clicked folder, else the active file's folder, else the root.
const targetDir = () => (active ? dirName(active) : '');
function askName(title, initial, okLabel) {
    return new Promise(res => {
        let done = false;
        const finish = (v) => { if (!done) {
            done = true;
            res(v);
        } };
        openModal(`<h3>${esc(title)}</h3><input class="input" style="width:100%;margin:12px 0 14px" id="nameIn" spellcheck="false" value="${escAttr(initial)}">
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nameOk">${okLabel}</button></div>`, m => {
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
    const rel = joinPath(dir, name.replace(/\\/g, '/').replace(/^\/+/, ''));
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
    const move = (x) => (x === p ? to : x.startsWith(p + '/') ? to + x.slice(p.length) : x);
    for (const b of [...buffers.values()]) {
        const np = move(b.path);
        if (np !== b.path) {
            buffers.delete(b.path);
            b.path = np;
            buffers.set(np, b);
        }
    }
    openTabs = openTabs.map(move);
    if (active)
        active = move(active);
    for (const d of [...expanded]) {
        expanded.delete(d);
        expanded.add(move(d));
    }
    dirCache.clear();
    await refreshTree();
    renderTabs();
    renderEditor();
    saveSession();
}
function deleteEntry(p, isDir) {
    openModal(`<h3>Delete ${esc(baseName(p))}?</h3><p class="sub">${isDir ? 'The folder and everything in it' : 'The file'} will be moved to the ${isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'}, so you can restore it.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="delOk">Move to ${isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'}</button></div>`, m => {
        $('#delOk', m).onclick = async () => {
            closeModal();
            try {
                await api.fs.trash(p);
            }
            catch (e) {
                toast(errMsg(e));
                return;
            }
            for (const path of [...openTabs])
                if (path === p || path.startsWith(p + '/'))
                    dropTab(path);
            expanded.delete(p);
            await refreshTree();
            renderTabs();
            renderEditor();
            saveSession();
        };
    });
}
api.fs.onChange(async (paths) => {
    const dirs = new Set(paths.map(dirName));
    for (const d of dirs)
        if (dirCache.has(d))
            await loadDir(d);
    // The changed path may itself be a cached folder (e.g. created then filled).
    for (const p of paths)
        if (dirCache.has(p))
            await loadDir(p);
    renderTree();
    for (const p of paths) {
        const b = buffers.get(p);
        if (!b || b.kind !== 'text' || isDirty(b))
            continue;
        try {
            const r = await api.fs.readFile(p);
            const text = (r.text ?? '').replace(/\r\n/g, '\n');
            if (r.text == null || text === b.saved)
                continue;
            b.text = b.saved = text;
            if (b.ta) {
                const s = b.ta.selectionStart;
                b.ta.value = text;
                b.ta.setSelectionRange(s, s);
            }
            if (p === active)
                renderCode();
        }
        catch { /* deleted or unreadable — leave the buffer as it is */ }
    }
});
/* ================= Opening, tabs & saving ================= */
function openFile(path, at) {
    if (/^\.env/.test(baseName(path)) && !buffers.has(path)) {
        openModal(`<h3>This is a protected file</h3><p class="sub">${esc(baseName(path))} holds secrets. You can view it, but agents can't read it unless you allow it each time.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="openEnv">Open for me only</button></div>`, m => $('#openEnv', m).onclick = () => { closeModal(); actuallyOpen(path, at); });
        return;
    }
    actuallyOpen(path, at);
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
    active = path;
    renderTabs();
    renderEditor();
    renderTree();
    saveSession();
    if (running && path && /\.(html?|css|js)$/i.test(path))
        $('#urlText').title = path;
}
function renderTabs() {
    $('#tabs').innerHTML = openTabs.map(n => {
        const lock = locks[n];
        return `<div class="tab ${n === active ? 'on' : ''} ${isDirty(buffers.get(n)) ? 'dirty' : ''}" data-tab="${escAttr(n)}" title="${escAttr(n)}">${lock ? `<span class="dot" style="background:${agentsDef[lock].color}"></span>` : ''}${esc(baseName(n))}<span class="x" data-close-tab="1" title="Close (Ctrl+W)"><span>✕</span></span></div>`;
    }).join('');
}
$('#tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (!tab)
        return;
    const p = tab.dataset.tab;
    if (e.target.closest('[data-close-tab]'))
        closeTab(p);
    else
        setActive(p);
});
$('#tabs').addEventListener('auxclick', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab && e.button === 1)
        closeTab(tab.dataset.tab);
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
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn" id="dontSave">Don't Save</button><button class="btn btn-primary" id="doSave">Save</button></div>`, m => {
        $('#dontSave', m).onclick = () => { closeModal(); finish(); };
        $('#doSave', m).onclick = async () => { closeModal(); if (await saveFile(path))
            finish(); };
    });
}
async function saveFile(path = active) {
    const b = path ? buffers.get(path) : undefined;
    if (!b || b.kind !== 'text')
        return false;
    const text = b.text;
    try {
        await api.fs.writeFile(b.path, b.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
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
        reloadPreview();
    return true;
}
async function saveAll() {
    const dirty = [...buffers.values()].filter(isDirty);
    for (const b of dirty)
        await saveFile(b.path);
    if (dirty.length)
        toast(`Saved ${dirty.length} file${dirty.length > 1 ? 's' : ''}`);
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
    return b && b.kind === 'text' && b.ta ? b : undefined;
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
document.fonts?.ready.then(() => { charW = 0; renderCode(); });
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
function renderEditor() {
    const b = activeBuf();
    for (const x of buffers.values())
        x.ta?.classList.toggle('hidden', x !== b);
    const empty = $('#editorEmpty');
    if (!b || b.kind !== 'text') {
        empty.classList.remove('hidden');
        empty.innerHTML = !b ? welcomeHtml()
            : `<div><h4>${esc(baseName(b.path))}</h4><div>${b.kind === 'binary' ? 'This file is binary, so Breeze can\'t show it as text.' : `This file is too large to open (${(b.size / 1048576).toFixed(1)} MB).`}</div></div>`;
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
function welcomeHtml() {
    const k = (keys, what) => `<span>${what}</span><kbd>${keys}</kbd>`;
    return `<div><img src="Agent.png" alt=""><h4>${rootInfo ? 'No file open' : 'Open a folder to start'}</h4>
    <div class="keys">${rootInfo
        ? k('Ctrl+P', 'Go to file') + k('Ctrl+N', 'New file') + k('Ctrl+Shift+F', 'Search files') + k('Ctrl+`', 'Terminal')
        : k('Ctrl+O', 'Open folder') + k('Ctrl+B', 'Toggle side bar') + k('Ctrl+Alt+B', 'Toggle agents')}</div></div>`;
}
function queueRender() {
    if (renderQueued)
        return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderCode(); });
}
function renderCode() {
    const b = activeText();
    if (!b)
        return;
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
    const hasText = !!b && b.kind === 'text' && !!b.ta;
    $('#sbPos').classList.toggle('hidden', !hasText);
    $('#sbLang').textContent = b ? langOf(b.path)[1] : '';
    $('#sbLang').classList.toggle('hidden', !b);
    $('#sbEol').textContent = b?.kind === 'text' ? `${b.eol === '\r\n' ? 'CRLF' : 'LF'} · UTF-8` : '';
    $('#sbEol').classList.toggle('hidden', !b);
    if (!hasText || !b?.ta)
        return;
    const { selectionStart: s, selectionEnd: e } = b.ta;
    const ls = lineStart(b.text, s);
    $('#sbPos').textContent = `Ln ${lineAt(b.text, s) + 1}, Col ${s - ls + 1}${e > s ? ` (${e - s} selected)` : ''}`;
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
// Replace a range through the browser's editing pipeline so Ctrl+Z can undo it.
function replaceRange(ta, start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
        ta.setRangeText(text, start, end, 'end');
        ta.dispatchEvent(new Event('input'));
    }
    if (selStart != null)
        ta.setSelectionRange(selStart, selEnd ?? selStart);
}
function selectedLines(ta) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    return [lineStart(v, s), lineEnd(v, e > s && v[e - 1] === '\n' ? e - 1 : e)];
}
function editorKeys(e) {
    const ta = e.target;
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (!e.shiftKey && !v.slice(s, en).includes('\n')) {
            replaceRange(ta, s, en, INDENT);
            return;
        }
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
        }
        else {
            replaceRange(ta, s, en, `\n${indent}${extra}`);
        }
    }
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
    const block = ta.value.slice(ls, le);
    const lines = block.split('\n');
    const [open, close] = c;
    const isCommented = (l) => !l.trim() || (l.trimStart().startsWith(open.trim()) && (!close || l.trimEnd().endsWith(close.trim())));
    const uncomment = lines.every(isCommented) && lines.some(l => l.trim());
    const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => (/^\s*/.exec(l) ?? [''])[0].length));
    const out = lines.map(l => {
        if (!l.trim())
            return l;
        if (uncomment) {
            let r = l.replace(new RegExp(`^(\\s*)${open.trim().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ?`), '$1');
            if (close)
                r = r.replace(new RegExp(` ?${close.trim().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`), '');
            return r;
        }
        return l.slice(0, minIndent) + open + l.slice(minIndent) + close;
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
    $('#findCount').textContent = !findInput.value ? '' : findHits.length ? `${findIdx + 1} of ${findHits.length}` : 'No results';
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
    openModal(`<input class="input" style="width:100%" id="lineIn" placeholder="Go to line (1 – ${total})" inputmode="numeric">`, m => {
        const input = $('#lineIn', m);
        input.focus();
        input.onkeydown = e => {
            if (e.key !== 'Enter')
                return;
            const n = clamp(parseInt(input.value, 10) || 1, 1, total);
            closeModal();
            const off = offsetOf(b.text, n - 1, 0);
            b.ta.focus();
            b.ta.setSelectionRange(off, off);
            revealOffset(b, off);
        };
    }, undefined, 'top');
}
async function quickOpen() {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    let all = [];
    let sel = 0;
    let shown = [];
    openModal(`<input class="input" style="width:100%" id="qoIn" placeholder="Search files by name" spellcheck="false"><div class="qo-list" id="qoList"><div class="side-note">Loading…</div></div>`, m => {
        const input = $('#qoIn', m);
        input.focus();
        const score = (p, q) => {
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
        };
        const render = () => {
            const q = input.value.trim().toLowerCase();
            shown = all.map(p => [p, score(p, q)]).filter(x => x[1] > 0)
                .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 60).map(x => x[0]);
            sel = clamp(sel, 0, Math.max(0, shown.length - 1));
            $('#qoList', m).innerHTML = shown.map((p, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${fileIcon(baseName(p))}&nbsp; ${esc(baseName(p))}</span><small>${esc(dirName(p))}</small></div>`).join('')
                || '<div class="side-note">No matching files.</div>';
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
        api.fs.listFiles().then(list => { all = list; render(); }, err => { $('#qoList', m).innerHTML = `<div class="side-note">${esc(errMsg(err))}</div>`; });
    }, undefined, 'top');
}
/* ================= Search across files ================= */
let searchCase = false;
$('#searchCase').onclick = () => { searchCase = !searchCase; $('#searchCase').classList.toggle('on', searchCase); runSearch(); };
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter')
    runSearch(); });
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
    out.innerHTML = `<p class="side-note" style="padding-top:0">${hits.length}${hits.length >= 500 ? '+' : ''} results in ${byFile.size} files</p>` +
        [...byFile].map(([p, hs]) => `<div class="result-file">${fileIcon(baseName(p))} ${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>` +
            hs.map((h, i) => {
                const start = Math.max(0, h.col - 30);
                const pre = h.text.slice(start, h.col).trimStart(), hit = h.text.slice(h.col, h.col + q.length), post = h.text.slice(h.col + q.length, h.col + q.length + 80);
                return `<div class="result-line" data-p="${escAttr(p)}" data-i="${i}">${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`;
            }).join('')).join('');
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
    const target = entry?.name ?? (active && /\.html?$/i.test(active) ? active : null);
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
$('#runBtn').onclick = () => (running ? reloadPreview().then(() => toast('Preview reloaded — it also reloads every time you save')) : startPreview());
/* ================= Terminal ================= */
const term = { cwd: '', proc: null, history: [], hIdx: 0 };
const termOut = $('#termOut');
const termInput = $('#termInput');
function renderPs() { $('#termPs').textContent = `${term.cwd || '~'}>`; }
function termWrite(text, cls = '') {
    const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '');
    const span = document.createElement('span');
    if (cls)
        span.className = cls;
    span.textContent = clean;
    termOut.appendChild(span);
    while (termOut.childNodes.length > 3000)
        termOut.firstChild?.remove();
    $('#termBody').scrollTop = $('#termBody').scrollHeight;
}
termInput.addEventListener('keydown', async (e) => {
    if (e.key === 'c' && e.ctrlKey && term.proc != null && termInput.selectionStart === termInput.selectionEnd) {
        e.preventDefault();
        api.term.kill(term.proc);
        termWrite('^C\n');
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
    if (/^\s*(cls|clear)\s*$/i.test(cmd)) {
        termOut.innerHTML = '';
        return;
    }
    const r = await api.term.run(cmd).catch(err => ({ error: errMsg(err) }));
    if (r.error)
        termWrite(r.error + '\n', 'err');
    if (r.cwd) {
        term.cwd = r.cwd;
        renderPs();
    }
    if (r.id != null) {
        term.proc = r.id;
        $('#termPs').style.opacity = '.4';
    }
});
api.term.onData((id, chunk) => { if (id === term.proc)
    termWrite(chunk); });
api.term.onExit((id, code) => {
    if (id !== term.proc)
        return;
    term.proc = null;
    $('#termPs').style.opacity = '';
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
$$('[data-sash]').forEach(sash => {
    const kind = sash.dataset.sash;
    sash.addEventListener('pointerdown', e => {
        if (e.button !== 0)
            return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY, start = { ...layout };
        if (kind === 'preview')
            start.preview = $('#previewPane').getBoundingClientRect().width;
        document.body.classList.add(kind === 'term' ? 'resizing-h' : 'resizing');
        sash.classList.add('active');
        // Dragging below a threshold collapses the panel; dragging back out reopens it.
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (kind === 'side') {
                const w = start.side + dx;
                layout.sideOpen = w >= 120;
                if (layout.sideOpen)
                    layout.side = clamp(w, 170, 640);
            }
            if (kind === 'agents') {
                const w = start.agents - dx;
                layout.agentsOpen = w >= 180;
                if (layout.agentsOpen)
                    layout.agents = clamp(w, 260, 720);
            }
            if (kind === 'preview') {
                const w = start.preview - dx;
                layout.previewOpen = w >= 140;
                if (layout.previewOpen)
                    layout.preview = clamp(w, 220, $('#work').clientWidth - 220);
            }
            if (kind === 'term') {
                const h = start.term - dy;
                layout.termOpen = h >= 60;
                if (layout.termOpen)
                    layout.term = clamp(h, 80, innerHeight - 220);
            }
            applyLayout();
        };
        const up = () => {
            removeEventListener('pointermove', move);
            removeEventListener('pointerup', up);
            document.body.classList.remove('resizing', 'resizing-h');
            sash.classList.remove('active');
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
    });
    sash.addEventListener('dblclick', () => { layout[kind] = DEFAULT_LAYOUT[kind]; applyLayout(); });
});
$('#tglSide').onclick = () => run('view.toggleSide');
$('#tglTerm').onclick = () => run('term.toggle');
$('#tglAgents').onclick = () => run('view.toggleAgents');
const hasFile = () => !!activeText();
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
    'view.search': () => { showView('search', true); const i = $('#searchInput'); const b = activeText(); const s = b ? b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd) : ''; if (s && !s.includes('\n'))
        i.value = s; i.focus(); i.select(); },
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
    'term.toggle': () => { layout.termOpen = !layout.termOpen; applyLayout(); if (layout.termOpen)
        termInput.focus(); },
    'term.focus': () => { layout.termOpen = true; applyLayout(); termInput.focus(); },
    'term.clear': () => { termOut.innerHTML = ''; },
    'term.kill': () => { if (term.proc != null) {
        api.term.kill(term.proc);
        termWrite('^C\n');
    }
    else
        toast('Nothing is running'); },
    'explorer.refresh': refreshTree,
    'explorer.collapse': () => { expanded.clear(); renderTree(); saveSession(); },
    'help.welcome': () => setActive(null),
    'help.keys': showShortcuts,
    'help.setup': () => { appState.onboarded = false; saveApp(); $('#ide').classList.add('hidden'); $('#onboard').classList.remove('hidden'); goStep(2); },
    'help.about': () => openModal(`<h3>Breeze IDE</h3><p class="sub">Smooth as a breeze.</p><p class="sub" style="font-size:12px">${isDesktop ? 'Desktop app' : 'Browser preview'} · ${esc(navigator.userAgent.match(/Electron\/[\d.]+|Chrome\/[\d.]+/)?.[0] ?? '')}</p><div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-close>OK</button></div>`),
};
function run(act) {
    const fn = commands[act];
    if (fn)
        Promise.resolve(fn()).catch(e => toast(errMsg(e)));
}
function editRole(role) {
    activeText()?.ta.focus();
    api.win.edit(role);
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
    openModal(`<h3>Open recent</h3><div class="qo-list">${recent.map(r => `<div class="qo-item" data-r="${escAttr(r.path)}"><span>${esc(r.name)}</span><small>${esc(r.path)}</small></div>`).join('')}</div>`, m => $$('[data-r]', m).forEach(el => el.onclick = () => { closeModal(); openRecentFolder(el.dataset.r); }), undefined, 'top');
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
        let done = false;
        const finish = (v) => { if (!done) {
            done = true;
            res(v);
        } };
        openModal(`<h3>Save changes to ${dirty.length} file${dirty.length > 1 ? 's' : ''}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn" id="dDiscard">Don't Save</button><button class="btn btn-primary" id="dSave">Save All</button></div>`, m => {
            $('#dDiscard', m).onclick = () => {
                for (const b of dirty) {
                    b.text = b.saved;
                    if (b.ta)
                        b.ta.value = b.saved;
                }
                finish(true);
                closeModal();
            };
            $('#dSave', m).onclick = async () => { await saveAll(); finish(true); closeModal(); };
        }, () => finish(false));
    });
}
const MENUS = [
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
            { label: 'About Breeze IDE', act: 'help.about' },
        ]],
];
// Go, Run and Help stay out of the menu bar; their shortcuts still work and Help lives under the gear button.
const BAR_MENUS = MENUS.filter(([name]) => !['Go', 'Run', 'Help'].includes(name));
// Shortcuts handled by the editor itself or by keydown elsewhere, but listed for discoverability.
const EXTRA_KEYS = [['F2', 'explorer.rename']];
commands['explorer.rename'] = () => { if (active)
    renameEntry(active); };
const canonKey = (combo) => {
    const parts = combo.split('+');
    const key = parts.pop();
    const mods = new Set(parts);
    return ['Ctrl', 'Shift', 'Alt'].filter(m => mods.has(m)).concat(key.length === 1 ? key.toUpperCase() : key).join('+');
};
const keymap = new Map();
for (const [, items] of MENUS)
    for (const it of items)
        if (it.key && it.act && !it.native)
            keymap.set(canonKey(it.key), it.act);
for (const [k, act] of EXTRA_KEYS)
    keymap.set(canonKey(k), act);
function comboOf(e) {
    const keyName = e.code === 'Backquote' ? '`' : e.code === 'Slash' ? '/' : e.key.startsWith('Arrow') ? e.key.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', keyName].filter(Boolean).join('+');
}
// Commands that only make sense while typing in the code editor.
const EDITOR_ONLY = new Set(['edit.comment', 'sel.line', 'sel.dup', 'sel.up', 'sel.down']);
let openMenuIdx = -1;
let kbIdx = -1;
let menuItems = [];
let menuOnClose = null;
function buildMenubar() {
    $('#menubar').innerHTML = BAR_MENUS.map(([name], i) => `<button class="menu-top" data-menu="${i}">${name}</button>`).join('');
    $$('[data-menu]').forEach(b => {
        const i = Number(b.dataset.menu);
        b.onmousedown = e => { e.preventDefault(); if (openMenuIdx === i)
            closeMenu();
        else
            openMenu(i); };
        b.onmouseenter = () => { if (openMenuIdx !== -1 && openMenuIdx !== i)
            openMenu(i); };
    });
}
function openMenu(i, viaKeyboard = false) {
    const btn = $(`[data-menu="${i}"]`);
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, BAR_MENUS[i][1], viaKeyboard);
    openMenuIdx = i;
    $$('[data-menu]').forEach(b => b.classList.toggle('open', b === btn));
}
function popupMenu(x, y, items, onClose) {
    showMenu(x, y, items, false);
    openMenuIdx = -2;
    menuOnClose = onClose ?? null;
}
function showMenu(x, y, items, viaKeyboard) {
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
    if (openMenuIdx === -1)
        return;
    openMenuIdx = -1;
    kbIdx = -1;
    $('#menuRoot').innerHTML = '';
    $$('[data-menu]').forEach(b => b.classList.remove('open'));
    const cb = menuOnClose;
    menuOnClose = null;
    cb?.();
}
document.addEventListener('mousedown', e => {
    if (openMenuIdx !== -1 && !e.target.closest('.menu, .menubar'))
        closeMenu();
});
window.addEventListener('blur', closeMenu);
function menuKeys(e) {
    if (openMenuIdx === -1)
        return false;
    const usable = menuItems.map((it, i) => (!it.sep && (!it.enabled || it.enabled()) ? i : -1)).filter(i => i !== -1);
    if (e.key === 'Escape')
        closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const pos = usable.indexOf(kbIdx);
        kbIdx = usable[(pos + (e.key === 'ArrowDown' ? 1 : -1) + usable.length) % usable.length] ?? -1;
        $$('[data-mi]').forEach(b => b.classList.toggle('kb', Number(b.dataset.mi) === kbIdx));
    }
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
document.addEventListener('keydown', e => {
    if (menuKeys(e))
        return;
    if (e.key === 'Escape') {
        if ($('#modalRoot').childElementCount) {
            closeModal();
            return;
        }
        if (findOpen) {
            closeFind();
            activeText()?.ta.focus();
            return;
        }
    }
    if ($('#modalRoot').childElementCount || $('#ide').classList.contains('hidden'))
        return;
    const act = keymap.get(comboOf(e));
    if (!act)
        return;
    const inEditor = document.activeElement?.classList.contains('ta');
    if (EDITOR_ONLY.has(act) && !inEditor)
        return;
    if (act === 'explorer.rename' && document.activeElement?.matches('input, textarea'))
        return;
    e.preventDefault();
    run(act);
}, true);
// Alt alone (released without another key) opens the menu bar, like a native app.
let altAlone = false;
document.addEventListener('keydown', e => { altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey; }, true);
document.addEventListener('keyup', e => {
    if (e.key === 'Alt' && altAlone && !$('#ide').classList.contains('hidden') && !$('#modalRoot').childElementCount) {
        e.preventDefault();
        if (openMenuIdx === -1)
            openMenu(0, true);
        else
            closeMenu();
    }
    altAlone = false;
}, true);
$('#settingsBtn').onclick = () => {
    const r = $('#settingsBtn').getBoundingClientRect();
    popupMenu(r.right + 6, r.top, MENUS.find(([name]) => name === 'Help')?.[1] ?? []);
};
function showShortcuts() {
    const rows = [];
    for (const [menu, items] of MENUS)
        for (const it of items)
            if (it.key)
                rows.push(`<span>${menu} › ${esc(it.label ?? '')}</span><kbd>${it.key}</kbd>`);
    rows.push('<span>Editor › Indent / outdent</span><kbd>Tab / Shift+Tab</kbd>', '<span>Explorer › Rename file</span><kbd>F2</kbd>', '<span>Menu bar</span><kbd>Alt</kbd>');
    openModal(`<h3>Keyboard shortcuts</h3><p class="sub">Drag any panel edge to resize it; drag it closed to hide it.</p><div class="kbd-table">${rows.join('')}</div><div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-close>Close</button></div>`);
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
    <div class="agent">
      <div class="ava" style="background:${a.color}">${a.letter}</div>
      <div><span class="name">${a.name}</span> <span style="color:var(--text-3);font-size:11px">${esc(a.model)}</span></div>
      <div class="row" style="gap:4px"><span class="status ${a.status}">${statusLabel[a.status]}</span>
        ${a.status === 'working' ? `<button class="btn btn-ghost btn-sm" style="padding:0 4px" title="Pause" data-toast="${a.name} paused">❚❚</button><button class="btn btn-ghost btn-sm" style="padding:0 4px" title="Stop" data-toast="${a.name} stopped — no new tool calls">■</button>` : ''}</div>
      <div class="task">${esc(a.task)}</div>
      <div class="meter" title="${a.used} of 25 tool calls"><i style="width:${a.used * 4}%;background:${a.color}"></i></div>
    </div>`).join('');
    bindToasts($('#agentCards'));
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
    return el;
}
function agentMsg(k, text) {
    const a = agentsDef[k];
    return addMsg(`<div class="msg"><div class="meta"><span class="avatar" style="background:${a.color};width:16px;height:16px;font-size:9px;margin:0;border:none">${a.letter}</span><b>${a.name}</b> just now</div><div class="body">${text}</div></div>`);
}
function userMsg(text, who = 'You') {
    addMsg(`<div class="msg user"><div class="meta"><b>${who}</b> just now</div><div class="body">${esc(text)}</div></div>`);
}
function emptyChat() {
    chat.innerHTML = `<div class="empty"><div><img src="Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div>Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
}
let busy = false;
$('#send').onclick = sendPrompt;
$('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
} });
async function sendPrompt() {
    const promptBox = $('#prompt');
    const text = promptBox.value.trim();
    if (!text || busy)
        return;
    if (!selectedAgent()) {
        openAgentPicker();
        return;
    }
    busy = true;
    promptBox.value = '';
    if (chat.querySelector('.empty'))
        chat.innerHTML = '';
    userMsg(text);
    setAgent('planner', 'working', 'Reading your request', 2);
    await wait(900);
    // Ask, don't guess
    setAgent('planner', 'waiting', 'Asking you a question', 3);
    const answer = await askCard('Quick question before I plan', "What's the shop called, and what vibe should the page have?", ['Ember & Oak · cozy & warm', 'Ember & Oak · minimal & modern', 'Let me type it']);
    userMsg(answer);
    // The builder works on the project's index.html when there is one, else on the open file.
    const target = (dirCache.get('') ?? []).find(e => !e.dir && /^index\.html?$/i.test(e.name))?.name ?? active;
    setAgent('planner', 'working', 'Writing a plan', 5);
    await wait(900);
    const planEl = agentMsg('planner', `Here's the plan:<ol><li><b>Builder</b> → <code>${esc(target ?? 'index.html')}</code>: hero, menu, footer</li><li><b>Builder</b> → <code>styles.css</code>: warm palette</li><li>Start the preview</li></ol><div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-plan="ok">Approve plan</button><button class="btn btn-sm" data-plan="edit">Change something</button></div>`);
    setAgent('planner', 'waiting', 'Waiting for plan approval', 5);
    await new Promise(r => $$('[data-plan]', planEl).forEach(b => b.onclick = () => { $('.row', planEl).outerHTML = `<div class="resolved">✓ Approved by You</div>`; r(); }));
    setAgent('planner', 'done', 'Plan handed off', 6);
    addMsg(`<div class="handoff">Planner → Builder · checkpoint saved</div>`);
    pushCommit({ msg: 'Safety checkpoint before Builder', agent: null, auto: true });
    // Builder edits
    if (target) {
        locks[target] = 'builder';
        renderTree();
        renderTabs();
        setAgent('builder', 'working', `Editing ${baseName(target)}`, 4);
        await actuallyOpen(target);
        added[target] = new Set();
        const lines = buffers.get(target)?.text.split('\n').length ?? 0;
        for (const i of [8, 9, 10, 11, 12].filter(i => i < lines)) {
            added[target].add(i);
            renderCode();
            await wait(260);
        }
    }
    setAgent('builder', 'working', 'Editing styles.css', 9);
    await wait(700);
    // Approval card
    setAgent('builder', 'waiting', 'Needs approval to run a command', 10);
    const ok = await approvalCard('Builder wants to run a command', 'npx prettier --write index.html styles.css', 'Formats two files in this project. Nothing leaves your machine.');
    if (ok) {
        setAgent('builder', 'working', 'Running prettier', 11);
        await wait(700);
    }
    if (target)
        delete locks[target];
    renderTree();
    renderTabs();
    setAgent('builder', 'done', 'Edited 2 files', 12);
    agentMsg('builder', `Done! I changed <b>${esc(target ? baseName(target) : 'index.html')}</b> and <b>styles.css</b>. <div class="row" style="margin-top:8px"><button class="btn btn-sm" data-toast="Changes kept">Keep changes</button><button class="btn btn-sm btn-ghost" data-toast="Reverted to the last checkpoint">Undo</button></div>`);
    bindToasts(chat);
    pushCommit({ msg: 'Add coffee shop hero and menu', agent: 'builder' });
    if (rootInfo && !running)
        startPreview();
    busy = false;
    vibeDone();
}
function askCard(title, q, options) {
    return new Promise(res => {
        const el = addMsg(`<div class="card ask"><h5><svg width="14" height="14" style="color:var(--blue)"><use href="#i-swirl"/></svg>${title}</h5><p>${q}</p><div class="chips">${options.map(o => `<button class="chip">${esc(o)}</button>`).join('')}</div></div>`);
        $$('.chip', el).forEach(c => c.onclick = () => { $('.chips', el).outerHTML = `<div class="resolved">✓ Answered</div>`; res(c.textContent ?? ''); });
    });
}
function approvalCard(title, cmd, why) {
    return new Promise(res => {
        const el = addMsg(`<div class="card approve"><h5>⚠ ${title}</h5><pre>${esc(cmd)}</pre><p>${why}</p><div class="row"><button class="btn btn-primary btn-sm" data-a="1">Allow once</button><button class="btn btn-sm" data-a="0">Deny</button><span style="margin-left:auto;color:var(--text-3);font-size:11px">Only the host can approve</span></div></div>`);
        $$('[data-a]', el).forEach(b => b.onclick = () => {
            const allowed = b.dataset.a === '1';
            $('.row', el).outerHTML = `<div class="resolved">${allowed ? '✓ Allowed once' : '✕ Denied'}</div>`;
            res(allowed);
        });
    });
}
/* ================= Git graph ================= */
const commits = [
    { id: 'a91f3c2', msg: 'Start project', agent: null, time: '12 min ago', lane: 0, files: [['index.html', 16, 0]] },
    { id: 'b72e1d0', msg: 'Add base styles', agent: 'planner', time: '9 min ago', lane: 0, files: [['styles.css', 11, 0]] },
    { id: 'c3d5a8e', msg: 'Try dark menu', agent: 'builder', time: '6 min ago', lane: 1, files: [['styles.css', 4, 2]] },
    { id: 'd4f0b19', msg: 'Greeting script', agent: null, time: '3 min ago', lane: 0, files: [['script.js', 4, 0]] },
];
let selCommit = null;
function pushCommit({ msg, agent, auto = false }) {
    commits.push({ id: Math.random().toString(16).slice(2, 9), msg: (auto ? '⟲ ' : '') + msg, agent, time: 'just now', lane: 0, files: [['index.html', 5, 0], ['styles.css', 3, 1]] });
    renderGraph();
}
function renderGraph() {
    const list = [...commits].reverse();
    const rowH = 40;
    $('#graph').innerHTML = list.map((c, i) => {
        const x = 16 + c.lane * 18, cy = rowH / 2;
        const color = c.agent ? agentsDef[c.agent].color : '#7aa9ff';
        const head = i === 0;
        return `<div class="commit ${selCommit === c.id ? 'on' : ''}" data-c="${c.id}" style="height:${rowH}px">
      <svg width="60" height="${rowH}">
        ${i > 0 ? `<line x1="16" y1="0" x2="16" y2="${cy}" stroke="#3a3a42" stroke-width="2"/>` : ''}
        ${i < list.length - 1 ? `<line x1="16" y1="${cy}" x2="16" y2="${rowH}" stroke="#3a3a42" stroke-width="2"/>` : ''}
        ${c.lane ? `<path d="M16 0 C16 ${cy} ${x} 0 ${x} ${cy} M${x} ${cy} C${x} ${rowH} 16 ${cy} 16 ${rowH}" fill="none" stroke="var(--c-builder)" stroke-width="2" opacity=".6"/>` : ''}
        <circle cx="${x}" cy="${cy}" r="${head ? 6 : 5}" fill="${head ? 'var(--blue)' : 'var(--bg-1)'}" stroke="${color}" stroke-width="2"/>
      </svg>
      <div class="msgline"><div>${esc(c.msg)}</div><small>${c.agent ? `<span class="agent-badge" style="background:${color}">${agentsDef[c.agent].name}</span>` : '<span>You</span>'}${c.time}${head ? ' · <b style="color:#7aa9ff">HEAD</b>' : ''}</small></div>
    </div>`;
    }).join('');
    $$('[data-c]').forEach(el => el.onclick = () => { selCommit = el.dataset.c ?? null; renderGraph(); renderCommitDetail(); });
}
function renderCommitDetail() {
    const c = commits.find(x => x.id === selCommit);
    const d = $('#commitDetail');
    if (!c) {
        d.innerHTML = '<div style="color:var(--text-3);font-size:12px">Click a checkpoint to see what changed.</div>';
        return;
    }
    d.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${esc(c.msg)}</div>
    ${c.files.map(([f, a, r]) => `<div class="file"><span>${f}</span><span><span class="add">+${a}</span> <span class="del">−${r}</span></span></div>`).join('')}
    <button class="btn btn-sm" style="width:100%;margin-top:8px" id="goBack">Go back to this checkpoint</button>`;
    $('#goBack').onclick = () => openModal(`<h3>Go back to "${esc(c.msg)}"?</h3><p class="sub">Your current work is saved as a safety checkpoint first, so you can always come back.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="confirmBack">Go back</button></div>`, m => $('#confirmBack', m).onclick = () => { closeModal(); pushCommit({ msg: 'Safety checkpoint', agent: null, auto: true }); toast('Restored — safety checkpoint saved'); });
}
$('#saveCp').onclick = () => openModal(`<h3>Save a checkpoint</h3><p class="sub">A snapshot you can go back to anytime (a git commit).</p><input class="input" style="width:100%;margin-bottom:14px" id="cpMsg" value="Tweak menu prices"><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="cpSave">Save</button></div>`, m => $('#cpSave', m).onclick = () => { pushCommit({ msg: $('#cpMsg').value || 'Checkpoint', agent: null }); closeModal(); toast('Checkpoint saved'); });
/* ================= Views ================= */
function showView(v, reveal = false) {
    layout.view = v;
    if (reveal && !layout.sideOpen)
        layout.sideOpen = true;
    applyLayout();
    $$('.act-btn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== v));
    if (v === 'git') {
        document.querySelector('.act-btn[data-view=git] .badge')?.remove();
        renderGraph();
        renderCommitDetail();
    }
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
$$('[data-view-jump]').forEach(b => b.onclick = () => showView(b.dataset.viewJump, true));
/* ================= Collaboration ================= */
let sharing = false;
let shareKey = '';
let guests = [];
const share = { files: true, preview: true, terminal: false };
function newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const raw = [...bytes].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 26);
    return 'brz-' + (raw.match(/.{1,6}/g) ?? []).join('-');
}
$('#shareBtn').onclick = openShare;
function openShare() {
    if (!shareKey)
        shareKey = newKey();
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
        $('#copyKey', m).onclick = () => { navigator.clipboard?.writeText(shareKey).catch(() => { }); toast('Key copied'); };
        $('#regen', m).onclick = () => { shareKey = newKey(); $('#keyText', m).textContent = shareKey; toast('Old key revoked'); };
        $$('[data-sw]', m).forEach(s => s.onclick = () => {
            const k = s.dataset.sw;
            share[k] = !share[k];
            s.classList.toggle('on');
        });
        const end = m.querySelector('#endShare');
        if (end)
            end.onclick = () => { sharing = false; guests = []; guestCursor = null; shareKey = ''; closeModal(); updateShare(); renderCode(); toast('Session ended'); };
        if (!sharing) {
            sharing = true;
            updateShare();
            setTimeout(() => joinRequest(m), 2200);
        }
    });
}
function joinRequest(m) {
    const slot = m.querySelector('#joinSlot');
    if (!slot || !slot.isConnected || guests.length)
        return;
    let role = 'Viewer';
    slot.innerHTML = `<div class="join-req"><div style="font-weight:600;margin-bottom:6px">Sam wants to join</div>
    <div class="row" style="margin-bottom:10px"><span style="color:var(--text-2)">Role:</span><div class="seg" style="flex:1"><button class="on" data-role>Viewer</button><button data-role>Editor</button></div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-sm" id="denyJoin">Deny</button><button class="btn btn-sm btn-primary" id="allowJoin">Allow</button></div></div>`;
    $$('[data-role]', slot).forEach(b => b.onclick = () => { role = b.textContent; $$('[data-role]', slot).forEach(x => x.classList.toggle('on', x === b)); });
    $('#denyJoin', slot).onclick = () => { slot.innerHTML = '<p class="resolved" style="margin-top:10px">Request denied.</p>'; };
    $('#allowJoin', slot).onclick = () => {
        guests.push({ name: 'Sam', role, color: '#fb923c' });
        slot.innerHTML = `<p class="resolved" style="margin-top:10px">✓ Sam joined as ${role}.</p>`;
        updateShare();
        if (role === 'Editor' && active) {
            guestCursor = { file: active, line: Math.min(10, (activeBuf()?.text.split('\n').length ?? 1) - 1), name: 'Sam', color: '#fb923c' };
            renderCode();
        }
    };
}
function updateShare() {
    $('#sbShare').textContent = sharing ? `● Sharing · ${guests.length + 1} people` : 'Not sharing';
    $('#avatars').innerHTML = `<span class="avatar" style="background:#7aa9ff" title="You (host)">YO</span>` + guests.map(g => `<span class="avatar" style="background:${g.color}" title="${g.name} (${g.role})">${g.name.slice(0, 2).toUpperCase()}</span>`).join('');
    $('#termShare').textContent = share.terminal && sharing ? 'Shared' : 'Not shared';
    renderPeople();
}
function renderPeople() {
    const rows = [{ name: 'You', role: 'Host', color: '#7aa9ff' }, ...guests];
    $('#people').innerHTML = rows.map(p => `<div class="tree-item"><span class="avatar" style="background:${p.color};margin:0;width:20px;height:20px;font-size:9px">${p.name.slice(0, 2).toUpperCase()}</span>${p.name}<span class="pill" style="margin-left:auto">${p.role}</span></div>`).join('')
        + (sharing ? '' : `<p style="color:var(--text-3);padding:8px">Press <b>Share</b> to invite someone.</p>`);
}
/* ================= Vibe mode ================= */
let vibeArmed = false;
let vibeTimer = null;
$('#vibeArm').onclick = () => {
    vibeArmed = !vibeArmed;
    $('#vibeArm').textContent = vibeArmed ? '◉ Vibe Mode armed' : '◌ Vibe Mode off';
    $('#vibeArm').classList.toggle('armed', vibeArmed);
    if (!vibeArmed)
        $('#vibe').classList.add('hidden');
    toast(vibeArmed ? 'Vibe Mode armed — a Short plays if agents take longer than 5 s' : 'Vibe Mode off');
};
function vibeTick() {
    const working = Object.values(agentsDef).some(a => a.status === 'working' || a.status === 'waiting');
    if (vibeArmed && working && vibeTimer == null && $('#vibe').classList.contains('hidden')) {
        vibeTimer = setTimeout(() => { $('#vibeReady').classList.add('hidden'); $('#vibe').classList.remove('hidden'); }, 5000);
    }
}
function vibeDone() {
    if (vibeTimer != null)
        clearTimeout(vibeTimer);
    vibeTimer = null;
    if (!$('#vibe').classList.contains('hidden'))
        $('#vibeReady').classList.remove('hidden');
}
$('#vibeClose').onclick = () => $('#vibe').classList.add('hidden');
$('#vibeBack').onclick = () => { $('#vibe').classList.add('hidden'); const t = Object.keys(added)[0]; if (t)
    openFile(t); };
/* ================= Discord ================= */
let discord = false;
$('#discord').onclick = () => {
    if (discord) {
        discord = false;
        $('#discord').textContent = 'Discord: off';
        return;
    }
    const detail = [rootInfo?.name ?? 'No project', active ? baseName(active) : null, active ? langOf(active)[1] : null].filter(Boolean).map(s => esc(s)).join(' · ');
    openModal(`<h3>Show what you're doing on Discord?</h3><p class="sub">Your friends will see:</p>
    <div class="setup-card" style="margin-bottom:12px"><b>Breeze IDE</b><div style="color:var(--text-2)">Vibe coding with agents</div><div style="color:var(--text-2)">${detail}</div><div style="color:var(--text-3);font-size:12px">00:14 elapsed</div></div>
    <p class="sub" style="font-size:12px">Project and file names can include client or employer names. You can hide details anytime from the status bar.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="dOn">Turn on</button></div>`, m => $('#dOn', m).onclick = () => { discord = true; $('#discord').textContent = 'Discord: on'; closeModal(); });
};
/* ================= Modal & misc ================= */
let modalOnClose = null;
function openModal(html, bind, onClose, place = 'center') {
    closeModal();
    $('#modalRoot').innerHTML = `<div class="scrim ${place === 'top' ? 'top' : ''}"><div class="modal ${place === 'top' ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    const m = $('#modalRoot .modal');
    modalOnClose = onClose ?? null;
    $('#modalRoot .scrim').onmousedown = e => { if (e.target.classList.contains('scrim'))
        closeModal(); };
    $$('[data-close]', m).forEach(b => b.onclick = closeModal);
    bind?.(m);
}
function closeModal() {
    if (!$('#modalRoot').childElementCount)
        return;
    $('#modalRoot').innerHTML = '';
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
    renderGraph();
    bindToasts();
    renderDetection();
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
    if (step === 2)
        renderProjectChoice();
    // Refresh the tool and agent status in the background; the cached result shows meanwhile.
    if (appState.onboarded)
        detectTools().catch(() => { });
}
boot();
