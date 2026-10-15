"use strict";
/* Breeze IDE — frontend prototype logic. All backend behavior is simulated. */
/* ================= Helpers ================= */
function $(s, r = document) {
    return r.querySelector(s);
}
function $$(s, r = document) {
    return [...r.querySelectorAll(s)];
}
const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('#toastRoot').replaceChildren(t);
    setTimeout(() => t.remove(), 2600);
}
/* ================= Onboarding ================= */
let step = 0;
let user = null;
function goStep(n) {
    step = n;
    $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
    $$('.ob-dots span').forEach((d, i) => d.classList.toggle('on', i === n));
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));
let signinTimer;
$$('[data-signin]').forEach(b => b.onclick = () => {
    $('#signinChoices').classList.add('hidden');
    $('#signinWait').classList.remove('hidden');
    const provider = b.dataset.signin ?? 'GitHub';
    signinTimer = setTimeout(() => { user = { name: 'You', provider }; goStep(2); }, 1600);
});
$('#signinCancel').onclick = () => { clearTimeout(signinTimer); $('#signinWait').classList.add('hidden'); $('#signinChoices').classList.remove('hidden'); };
$('#signinRetry').onclick = () => { clearTimeout(signinTimer); signinTimer = setTimeout(() => { user = { name: 'You', provider: 'GitHub' }; goStep(2); }, 1200); };
$('#aiTest').onclick = () => {
    const pill = $('#aiPill');
    if (!$('#aiKey').value.trim()) {
        pill.className = 'pill warn';
        pill.textContent = 'Paste a key first';
        return;
    }
    pill.className = 'pill';
    pill.textContent = 'Testing…';
    setTimeout(() => {
        pill.className = 'pill ok';
        pill.textContent = 'Connected · Gemini';
        const sw = document.querySelector('#aiSwirl');
        sw.classList.remove('hidden', 'swirl');
        void sw.getBoundingClientRect();
        sw.classList.add('swirl');
    }, 900);
};
$('#nodeInstall').onclick = () => openModal(`
  <h3>Install Node.js?</h3>
  <p class="sub">Breeze will run this exact command with Windows Package Manager:</p>
  <div class="keybox">winget install --id OpenJS.NodeJS.LTS --source winget</div>
  <p class="sub" style="font-size:12px">Source: official winget repository · Publisher: OpenJS Foundation</p>
  <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="doInstall">Install</button></div>`, m => $('#doInstall', m).onclick = () => { closeModal(); $('#nodePill').className = 'pill ok'; $('#nodePill').textContent = 'Node 22 ready'; });
$$('[data-seg]').forEach(b => b.onclick = () => { $$('[data-seg]').forEach(x => x.classList.toggle('on', x === b)); });
$('#startBuilding').onclick = () => {
    $('#onboard').classList.add('hidden');
    $('#ide').classList.remove('hidden');
    $('#userChip').textContent = `● Signed in with ${user?.provider ?? 'GitHub'}`;
    const p = $('#projPrompt').value.trim();
    if (p)
        $('#prompt').value = p;
};
/* ================= Agents (data) ================= */
const agentsDef = {
    planner: { name: 'Planner', letter: 'P', color: 'var(--c-planner)', model: 'gemini-flash', status: 'idle', task: 'Waiting for a prompt', used: 0 },
    builder: { name: 'Builder', letter: 'B', color: 'var(--c-builder)', model: 'gemini-pro', status: 'idle', task: 'Waiting for a plan', used: 0 },
};
const statusLabel = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', done: 'Done' };
/* ================= Files & editor ================= */
const files = {
    'index.html': [
        '<span class="tk-com">&lt;!-- Brewed by Breeze --&gt;</span>',
        '<span class="tk-tag">&lt;!doctype html&gt;</span>',
        '<span class="tk-tag">&lt;html</span> <span class="tk-attr">lang</span>=<span class="tk-str">"en"</span><span class="tk-tag">&gt;</span>',
        '<span class="tk-tag">&lt;head&gt;</span>',
        '  <span class="tk-tag">&lt;title&gt;</span>Ember &amp; Oak Coffee<span class="tk-tag">&lt;/title&gt;</span>',
        '  <span class="tk-tag">&lt;link</span> <span class="tk-attr">rel</span>=<span class="tk-str">"stylesheet"</span> <span class="tk-attr">href</span>=<span class="tk-str">"styles.css"</span><span class="tk-tag">&gt;</span>',
        '<span class="tk-tag">&lt;/head&gt;</span>',
        '<span class="tk-tag">&lt;body&gt;</span>',
        '  <span class="tk-tag">&lt;header</span> <span class="tk-attr">class</span>=<span class="tk-str">"hero"</span><span class="tk-tag">&gt;</span>',
        '    <span class="tk-tag">&lt;h1&gt;</span>Ember &amp; Oak<span class="tk-tag">&lt;/h1&gt;</span>',
        '    <span class="tk-tag">&lt;p&gt;</span>Slow coffee for fast mornings.<span class="tk-tag">&lt;/p&gt;</span>',
        '    <span class="tk-tag">&lt;a</span> <span class="tk-attr">href</span>=<span class="tk-str">"#menu"</span> <span class="tk-attr">class</span>=<span class="tk-str">"cta"</span><span class="tk-tag">&gt;</span>See the menu<span class="tk-tag">&lt;/a&gt;</span>',
        '  <span class="tk-tag">&lt;/header&gt;</span>',
        '  <span class="tk-tag">&lt;section</span> <span class="tk-attr">id</span>=<span class="tk-str">"menu"</span><span class="tk-tag">&gt;</span> ... <span class="tk-tag">&lt;/section&gt;</span>',
        '<span class="tk-tag">&lt;/body&gt;</span>',
        '<span class="tk-tag">&lt;/html&gt;</span>',
    ],
    'styles.css': [
        '<span class="tk-com">/* Cozy, warm palette */</span>',
        '<span class="tk-tag">:root</span> {',
        '  <span class="tk-prop">--bean</span>: <span class="tk-str">#2b1d12</span>;',
        '  <span class="tk-prop">--cream</span>: <span class="tk-str">#f4ece1</span>;',
        '  <span class="tk-prop">--ember</span>: <span class="tk-str">#c2410c</span>;',
        '}',
        '<span class="tk-tag">.hero</span> {',
        '  <span class="tk-prop">padding</span>: <span class="tk-str">96px 24px</span>;',
        '  <span class="tk-prop">text-align</span>: <span class="tk-str">center</span>;',
        '}',
        '<span class="tk-tag">.cta</span> { <span class="tk-prop">background</span>: <span class="tk-kw">var</span>(--ember); }',
    ],
    'script.js': [
        '<span class="tk-com">// Small touch: greet by time of day</span>',
        '<span class="tk-kw">const</span> h = <span class="tk-kw">new</span> Date().getHours();',
        '<span class="tk-kw">const</span> hello = h &lt; <span class="tk-str">12</span> ? <span class="tk-str">"Good morning"</span> : <span class="tk-str">"Hey there"</span>;',
        'document.querySelector(<span class="tk-str">".hero p"</span>).prepend(hello + <span class="tk-str">". "</span>);',
    ],
    '.env': ['<span class="tk-com"># Protected — agents can\'t read this without your OK</span>', 'MAPS_KEY=••••••••••••'],
};
const tree = [
    { name: 'coffee-shop-landing', dir: true },
    { name: 'assets', dir: true, depth: 1 },
    { name: 'beans.jpg', depth: 2, icon: '▣' },
    { name: 'index.html', depth: 1, icon: '◇' },
    { name: 'styles.css', depth: 1, icon: '#' },
    { name: 'script.js', depth: 1, icon: 'JS' },
    { name: '.env', depth: 1, icon: '🔒' },
];
let openTabs = ['index.html', 'styles.css'];
let active = 'index.html';
const locks = {};
const added = {};
let guestCursor = null;
function renderTree() {
    $('#tree').innerHTML = tree.map(f => {
        const lock = locks[f.name];
        const lockTag = lock ? `<span class="lock" style="background:${agentsDef[lock].color};color:#000">${agentsDef[lock].name}</span>` : '';
        return `<div class="tree-item ${f.name === active ? 'on' : ''}" style="padding-left:${8 + (f.depth ?? 0) * 12}px" data-file="${f.dir ? '' : f.name}">
      <span class="ico">${f.dir ? '▾' : f.icon}</span>${esc(f.name)}${lockTag}</div>`;
    }).join('');
    $$('#tree [data-file]').forEach(el => { if (el.dataset.file)
        el.onclick = () => openFile(el.dataset.file); });
}
function openFile(name) {
    if (!files[name]) {
        toast('Preview images in the Preview pane');
        return;
    }
    if (name === '.env') {
        openModal(`<h3>This is a protected file</h3><p class="sub">.env holds secrets. You can view it, but agents can't read it unless you allow it each time.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="openEnv">Open for me only</button></div>`, m => $('#openEnv', m).onclick = () => { closeModal(); actuallyOpen(name); });
        return;
    }
    actuallyOpen(name);
}
function actuallyOpen(name) {
    if (!openTabs.includes(name))
        openTabs.push(name);
    active = name;
    renderTabs();
    renderEditor();
    renderTree();
}
function renderTabs() {
    $('#tabs').innerHTML = openTabs.map(n => `<div class="tab ${n === active ? 'on' : ''}" data-tab="${n}">${locks[n] ? `<span class="dot" style="background:${agentsDef[locks[n]].color}"></span>` : ''}${esc(n)}<span class="x" data-close-tab="${n}">✕</span></div>`).join('');
    $$('[data-tab]').forEach(t => t.onclick = e => {
        const tab = t.dataset.tab;
        if (e.target.dataset.closeTab) {
            openTabs = openTabs.filter(x => x !== tab);
            if (active === tab)
                active = openTabs[0] ?? null;
        }
        else
            active = tab;
        renderTabs();
        renderEditor();
        renderTree();
    });
}
function renderEditor() {
    if (!active) {
        $('#editor').innerHTML = '<div class="empty" style="height:100%"><div>Open a file from the left</div></div>';
        return;
    }
    const set = added[active] ?? new Set();
    $('#editor').innerHTML = files[active].map((l, i) => {
        let html = l;
        if (guestCursor && guestCursor.file === active && guestCursor.line === i)
            html += `<span class="cursor" style="background:${guestCursor.color}"><span class="who" style="background:${guestCursor.color}">${guestCursor.name}</span></span>`;
        return `<div class="line ${set.has(i) ? 'added' : ''}"><code>${html || ' '}</code></div>`;
    }).join('');
}
/* ================= Preview ================= */
let running = false;
function renderPreview() {
    $('#previewEmpty').classList.toggle('hidden', running);
    $('#previewFrame').classList.toggle('hidden', !running);
    $('#liveDot').classList.toggle('hidden', !running);
    $('#urlText').textContent = running ? 'http://127.0.0.1:51327' : 'Not running';
    if (!running)
        return;
    const menu = [['Flat white', '4.20'], ['Oat cortado', '4.50'], ['Ember cold brew', '5.00']];
    $('#previewFrame').innerHTML = `
    <div style="font-family:Georgia,serif">
      <div style="padding:64px 24px;text-align:center;background:linear-gradient(#3b2416,#2b1d12);color:#f4ece1">
        <div style="letter-spacing:.3em;font-size:11px;opacity:.7">EST. 2026</div>
        <h1 style="font-size:40px;margin:8px 0">Ember &amp; Oak</h1>
        <p style="opacity:.8;margin:0 0 20px">Slow coffee for fast mornings.</p>
        <span style="background:#c2410c;color:#fff;padding:10px 18px;border-radius:999px;font:600 13px Inter,sans-serif">See the menu</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:24px">
        ${menu.map(([n, p]) => `<div style="background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><div style="font-weight:700">${n}</div><div style="color:#c2410c;font-family:Inter,sans-serif;font-size:12px">£${p}</div></div>`).join('')}
      </div>
    </div>`;
}
$('#runBtn').onclick = () => {
    if (running) {
        toast('Live reload is on — preview updates when you save');
        return;
    }
    running = true;
    renderPreview();
    $('#work').classList.remove('no-preview');
    toast('Live server started on 127.0.0.1 (your machine only)');
};
/* ================= Terminal ================= */
$('#termToggle').onclick = () => {
    const b = $('#termBody');
    b.classList.toggle('hidden');
    $('#termToggle span').textContent = (b.classList.contains('hidden') ? '▸' : '▾') + ' Terminal';
};
/* ================= Agents (UI) ================= */
function renderAgents() {
    $('#agentCards').innerHTML = Object.values(agentsDef).map(a => `
    <div class="agent">
      <div class="ava" style="background:${a.color}">${a.letter}</div>
      <div><span class="name">${a.name}</span> <span style="color:var(--text-3);font-size:11px">${a.model}</span></div>
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
    chat.innerHTML = `<div class="empty"><div><svg width="40" height="40" style="color:var(--blue)"><use href="#i-swirl"/></svg><h4>Your agents are ready</h4><div>Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
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
    setAgent('planner', 'working', 'Writing a plan', 5);
    await wait(900);
    const planEl = agentMsg('planner', `Here's the plan:<ol><li><b>Builder</b> → <code>index.html</code>: hero, menu, footer</li><li><b>Builder</b> → <code>styles.css</code>: warm palette</li><li>Start the preview</li></ol><div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-plan="ok">Approve plan</button><button class="btn btn-sm" data-plan="edit">Change something</button></div>`);
    setAgent('planner', 'waiting', 'Waiting for plan approval', 5);
    await new Promise(r => $$('[data-plan]', planEl).forEach(b => b.onclick = () => { $('.row', planEl).outerHTML = `<div class="resolved">✓ Approved by You</div>`; r(); }));
    setAgent('planner', 'done', 'Plan handed off', 6);
    addMsg(`<div class="handoff">Planner → Builder · checkpoint saved</div>`);
    pushCommit({ msg: 'Safety checkpoint before Builder', agent: null, auto: true });
    // Builder edits
    locks['index.html'] = 'builder';
    locks['styles.css'] = 'builder';
    renderTree();
    renderTabs();
    setAgent('builder', 'working', 'Editing index.html', 4);
    actuallyOpen('index.html');
    added['index.html'] = new Set();
    for (const i of [8, 9, 10, 11, 12]) {
        added['index.html'].add(i);
        renderEditor();
        await wait(260);
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
    delete locks['index.html'];
    delete locks['styles.css'];
    renderTree();
    renderTabs();
    setAgent('builder', 'done', 'Edited 2 files', 12);
    agentMsg('builder', `Done! I changed <b>index.html</b> and <b>styles.css</b>. <div class="row" style="margin-top:8px"><button class="btn btn-sm" data-toast="Changes kept">Keep changes</button><button class="btn btn-sm btn-ghost" data-toast="Reverted to the last checkpoint">Undo</button></div>`);
    bindToasts(chat);
    pushCommit({ msg: 'Add coffee shop hero and menu', agent: 'builder' });
    running = true;
    renderPreview();
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
function showView(v) {
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
$$('.act-btn[data-view]').forEach(b => b.onclick = () => showView(b.dataset.view));
$$('[data-view-jump]').forEach(b => b.onclick = () => showView(b.dataset.viewJump));
/* ================= Collaboration ================= */
let sharing = false;
let sessionKey = '';
let guests = [];
const share = { files: true, preview: true, terminal: false };
function newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const raw = [...bytes].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 26);
    return 'brz-' + (raw.match(/.{1,6}/g) ?? []).join('-');
}
$('#shareBtn').onclick = openShare;
function openShare() {
    if (!sessionKey)
        sessionKey = newKey();
    openModal(`
    <h3>Share this project</h3>
    <p class="sub">Send this key to a friend. They'll wait until you let them in.</p>
    <div class="keybox"><span style="flex:1" id="keyText">${sessionKey}</span><button class="btn btn-sm" id="copyKey">Copy</button></div>
    <div class="toggle-row"><span>Share files</span><button class="switch ${share.files ? 'on' : ''}" data-sw="files" aria-label="Share files"></button></div>
    <div class="toggle-row"><span>Share preview</span><button class="switch ${share.preview ? 'on' : ''}" data-sw="preview" aria-label="Share preview"></button></div>
    <div class="toggle-row"><span>Share terminal <small style="color:var(--text-3)">(they could see command output)</small></span><button class="switch ${share.terminal ? 'on' : ''}" data-sw="terminal" aria-label="Share terminal"></button></div>
    <p style="color:var(--text-3);font-size:12px;margin:10px 0 0">Relay runs on <b style="color:var(--text-2)">ALEX-LAPTOP</b> (LAN, tunnel backup). It can see shared code. Key expires in 4 hours.</p>
    <div id="joinSlot"></div>
    <div class="row" style="justify-content:space-between;margin-top:16px">
      <div class="row"><button class="btn btn-sm btn-ghost" id="regen">New key</button>${sharing ? '<button class="btn btn-sm btn-ghost" id="endShare" style="color:var(--err)">End session</button>' : ''}</div>
      <button class="btn btn-primary" data-close>${sharing ? 'Done' : 'Start sharing'}</button>
    </div>`, m => {
        $('#copyKey', m).onclick = () => { navigator.clipboard?.writeText(sessionKey).catch(() => { }); toast('Key copied'); };
        $('#regen', m).onclick = () => { sessionKey = newKey(); $('#keyText', m).textContent = sessionKey; toast('Old key revoked'); };
        $$('[data-sw]', m).forEach(s => s.onclick = () => {
            const k = s.dataset.sw;
            share[k] = !share[k];
            s.classList.toggle('on');
        });
        const end = m.querySelector('#endShare');
        if (end)
            end.onclick = () => { sharing = false; guests = []; guestCursor = null; sessionKey = ''; closeModal(); updateShare(); renderEditor(); toast('Session ended'); };
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
        if (role === 'Editor') {
            guestCursor = { file: 'index.html', line: 10, name: 'Sam', color: '#fb923c' };
            renderEditor();
        }
    };
}
function updateShare() {
    $('#sbShare').textContent = sharing ? `● Sharing · ${guests.length + 1} people` : 'Not sharing';
    $('#avatars').innerHTML = `<span class="avatar" style="background:#7aa9ff" title="You (host)">YO</span>` + guests.map(g => `<span class="avatar" style="background:${g.color}" title="${g.name} (${g.role})">${g.name.slice(0, 2).toUpperCase()}</span>`).join('');
    $('.term-head span:nth-child(2)').textContent = share.terminal && sharing ? 'Shared' : 'Not shared';
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
$('#vibeBack').onclick = () => { $('#vibe').classList.add('hidden'); actuallyOpen('index.html'); };
/* ================= Discord ================= */
let discord = false;
$('#discord').onclick = () => {
    if (discord) {
        discord = false;
        $('#discord').textContent = 'Discord: off';
        return;
    }
    openModal(`<h3>Show what you're doing on Discord?</h3><p class="sub">Your friends will see:</p>
    <div class="setup-card" style="margin-bottom:12px"><b>Breeze IDE</b><div style="color:var(--text-2)">Vibe coding with agents</div><div style="color:var(--text-2)">coffee-shop-landing · index.html · HTML</div><div style="color:var(--text-3);font-size:12px">00:14 elapsed</div></div>
    <p class="sub" style="font-size:12px">Project and file names can include client or employer names. You can hide details anytime from the status bar.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="dOn">Turn on</button></div>`, m => $('#dOn', m).onclick = () => { discord = true; $('#discord').textContent = 'Discord: on'; closeModal(); });
};
/* ================= Modal & misc ================= */
function openModal(html, bind) {
    $('#modalRoot').innerHTML = `<div class="scrim"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const m = $('#modalRoot .modal');
    $('#modalRoot .scrim').onclick = e => { if (e.target.classList.contains('scrim'))
        closeModal(); };
    $$('[data-close]', m).forEach(b => b.onclick = closeModal);
    bind?.(m);
}
function closeModal() { $('#modalRoot').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape')
    closeModal(); });
function bindToasts(root = document) {
    $$('[data-toast]', root).forEach(b => b.onclick = () => toast(b.dataset.toast ?? ''));
}
/* ================= Init ================= */
renderTree();
renderTabs();
renderEditor();
renderAgents();
renderPreview();
emptyChat();
renderGraph();
bindToasts();
