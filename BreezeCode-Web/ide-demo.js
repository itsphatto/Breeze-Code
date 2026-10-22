/* Breeze Code hero: a working copy of the editor window, built from the app's own UI (src/renderer). Everything runs
   in the browser. Files, the terminal, the preview and the agents are simulated in memory and nothing is sent anywhere. */
(() => {
  const root = document.getElementById('bzDemo');
  if (!root) return;
  const ASSETS = root.dataset.assets || 'assets/';
  const MIN_W = 1060; // narrower frames get the desktop layout scaled down, like the screenshot it replaces
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(r => setTimeout(r, calm ? Math.min(ms, 80) : ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const baseName = p => p.slice(p.lastIndexOf('/') + 1);
  const dirName = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const extOf = p => { const n = baseName(p).toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''; };

  /* ================= Icons (copied from breeze.html / breezescript.ts) ================= */
  const svg16 = body => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const badge = (bg, fg, label) => svg16(`<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/><text x="8" y="11.2" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="6.4" fill="${fg}">${label}</text>`);
  const page = (color, inner = '') => svg16(`<path d="M3.5 1.5h6l3 3v10h-9z" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>${inner}`);
  const FILE_ICONS = {
    html: svg16('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="#f16529" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 3.5-2 9" stroke="#f9a77d" stroke-width="1.4" stroke-linecap="round"/>'),
    css: svg16('<path d="M6.3 2.5 5 13.5M11 2.5 9.7 13.5M2.8 6h11M2.2 10h11" fill="none" stroke="#42a5f5" stroke-width="1.6" stroke-linecap="round"/>'),
    js: badge('#f1d33b', '#1e1e1e', 'JS'),
    ts: badge('#3178c6', '#ffffff', 'TS'),
    json: svg16('<path d="M6 2.5c-1.6 0-1.8.8-1.8 2v1.3c0 1-.5 1.7-1.7 1.9v.6c1.2.2 1.7.9 1.7 1.9v1.3c0 1.2.2 2 1.8 2M10 2.5c1.6 0 1.8.8 1.8 2v1.3c0 1 .5 1.7 1.7 1.9v.6c-1.2.2-1.7.9-1.7 1.9v1.3c0 1.2-.2 2-1.8 2" fill="none" stroke="#f5b942" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="#f5b942"/>'),
    md: svg16('<rect x="1" y="3.5" width="14" height="9" rx="2" fill="none" stroke="#6aa8d8" stroke-width="1.2"/><path d="M3.5 10.5v-4l1.8 2 1.8-2v4M11.2 6.3v4M9.6 8.9l1.6 1.6 1.6-1.6" fill="none" stroke="#6aa8d8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
    py: svg16('<path d="M8 1.5c-3 0-3 1.3-3 2.3V6h3.2v.6H3.6C2.3 6.6 1.5 7.6 1.5 9.4s.8 2.9 2 2.9H5V10.5c0-1.2 1-2.2 2.2-2.2h3.3c1 0 1.8-.8 1.8-1.8V3.8c0-1.2-1.2-2.3-4.3-2.3z" fill="#3776ab"/><path d="M8 14.5c3 0 3-1.3 3-2.3V10H7.8v-.6h4.6c1.3 0 2.1-1 2.1-2.8s-.8-2.9-2-2.9H11v1.8c0 1.2-1 2.2-2.2 2.2H5.5c-1 0-1.8.8-1.8 1.8v2.7c0 1.2 1.2 2.3 4.3 2.3z" fill="#ffd43b"/>'),
    image: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#b388ff" fill-opacity=".18" stroke="#b388ff" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.3" fill="#ffd166"/><path d="m2.5 12.5 4-4 2.5 2.5 1.8-1.8 3 3.3z" fill="#b388ff"/>'),
    git: svg16('<path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="#f05033"/><path d="M6.4 5.2v5.6M6.4 6.6 9.6 9.4" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><circle cx="6.4" cy="10.6" r="1" fill="#fff"/><circle cx="9.6" cy="9.4" r="1" fill="#fff"/><circle cx="6.4" cy="5" r="1" fill="#fff"/>'),
    text: page('#a1a1aa', '<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" stroke="#a1a1aa" stroke-width="1" stroke-linecap="round"/>'),
    file: page('#8b8b95'),
  };
  const EXT_ICON = { html: 'html', htm: 'html', css: 'css', js: 'js', mjs: 'js', ts: 'ts', json: 'json', md: 'md', py: 'py', png: 'image', jpg: 'image', svg: 'image', txt: 'text' };
  function fileIcon(name) {
    const n = name.toLowerCase();
    if (n.startsWith('.git')) return FILE_ICONS.git;
    return FILE_ICONS[EXT_ICON[extOf(n)] ?? 'file'];
  }
  const FOLDER_COLORS = [[/^\.git$/, '#f05033'], [/^\.(claude|vscode|github)$/, '#d97757'], [/^(assets|images?|img|public|icons?)$/, '#ffb74d'], [/^(src|app|lib)$/, '#7aa9ff'], [/^(styles?|css)$/, '#42a5f5']];
  function folderIcon(name, open) {
    const c = FOLDER_COLORS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? '#90a4c4';
    return open
      ? svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h5.7a1 1 0 0 1 1 1V7H4.2a1 1 0 0 0-.95.68L1.5 12.5z" fill="${c}" fill-opacity=".55"/><path d="M3.3 7.7A1 1 0 0 1 4.25 7h10.3l-1.9 5.8a1 1 0 0 1-.95.7H1.5z" fill="${c}"/>`)
      : svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h6.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="${c}"/><path d="M1.5 6h13" stroke="#000" stroke-opacity=".18"/>`);
  }
  const CHEV = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // 24×24 line icons: [stroke width, body]
  const LINE = {
    files: [1.7, '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5"/>'],
    search: [1.7, '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'],
    git: [1.7, '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>'],
    gear: [1.6, '<path d="M10.46 4.76L10.83 2.47A9.6 9.6 0 0 1 13.17 2.47L13.54 4.76A7.4 7.4 0 0 1 16.03 5.79L17.91 4.44A9.6 9.6 0 0 1 19.56 6.09L18.21 7.97A7.4 7.4 0 0 1 19.24 10.46L21.53 10.83A9.6 9.6 0 0 1 21.53 13.17L19.24 13.54A7.4 7.4 0 0 1 18.21 16.03L19.56 17.91A9.6 9.6 0 0 1 17.91 19.56L16.03 18.21A7.4 7.4 0 0 1 13.54 19.24L13.17 21.53A9.6 9.6 0 0 1 10.83 21.53L10.46 19.24A7.4 7.4 0 0 1 7.97 18.21L6.09 19.56A9.6 9.6 0 0 1 4.44 17.91L5.79 16.03A7.4 7.4 0 0 1 4.76 13.54L2.47 13.17A9.6 9.6 0 0 1 2.47 10.83L4.76 10.46A7.4 7.4 0 0 1 5.79 7.97L4.44 6.09A9.6 9.6 0 0 1 6.09 4.44L7.97 5.79A7.4 7.4 0 0 1 10.46 4.76Z"/><circle cx="12" cy="12" r="3.2"/>'],
    newfile: [1.6, '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z M13 3v6h6"/><path d="M12 12v6M9 15h6"/>'],
    newdir: [1.6, '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'],
    refresh: [1.6, '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>'],
    collapse: [1.6, '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12h8"/>'],
    chev: [1.8, '<path d="M15 6l-6 6 6 6"/>'],
    left: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'],
    leftOn: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><rect x="3.8" y="4.8" width="4.4" height="14.4" fill="currentColor" stroke="none"/>'],
    bottom: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>'],
    bottomOn: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/><rect x="3.8" y="14.8" width="16.4" height="4.4" fill="currentColor" stroke="none"/>'],
    right: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'],
    rightOn: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><rect x="15.8" y="4.8" width="4.4" height="14.4" fill="currentColor" stroke="none"/>'],
    history: [1.8, '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 7.5V12l3 2"/>'],
    x: [2, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'],
    chevronRight: [2, '<path d="m9 18 6-6-6-6"/>'],
    backspace: [2, '<path d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/>'],
    stop: [2, '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'],
    send: [2, '<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/>'],
    eye: [2, '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'],
    pencil: [2, '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'],
    todo: [2, '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'],
    gitBranch: [2, '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'],
    circle: [2, '<circle cx="12" cy="12" r="9"/>'],
    circleDot: [2, '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'],
    up: [2, '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'],
    down: [2, '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'],
    plus: [2, '<path d="M5 12h14"/><path d="M12 5v14"/>'],
    play: [2, '<path d="M6 3l14 9-14 9z" fill="currentColor"/>'],
    check: [2, '<path d="M20 6 9 17l-5-5"/>'],
    minimize: [1.4, '<path d="M5 12h14"/>'],
    maximize: [1.4, '<rect x="5" y="5" width="14" height="14" rx="1"/>'],
    close: [1.4, '<path d="M6 6l12 12M18 6 6 18"/>'],
  };
  const icon = (name, size = 16) => {
    const [w, body] = LINE[name];
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };

  /* ================= Project files (in memory) ================= */
  const LAUNCH = `{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "breeze-static",
      "runtimeExecutable": "python",
      "runtimeArgs": ["-m", "http.server", "5173", "--bind", "127.0.0.1", "--directory", "D:\\\\Project-B"],
      "port": 5173
    },
    {
      "name": "breeze-web",
      "runtimeExecutable": "python",
      "runtimeArgs": ["-m", "http.server", "5174", "--bind", "127.0.0.1", "--directory", "D:\\\\BreezeIDE-Web"],
      "port": 5174
    }
  ]
}
`;
  const INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Breeze Web</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="hero">
    <h1>Hello from <span>Breeze</span></h1>
    <p>Change anything here, then press F5 to see it live.</p>
    <button id="wave">Wave 👋</button>
    <p class="count" id="count">No waves yet</p>
  </main>
  <script src="site.js"></script>
</body>
</html>
`;
  const SITE = `// Count the waves and show the total under the button.
const button = document.querySelector('#wave');
const count = document.querySelector('#count');
let waves = 0;

button.addEventListener('click', () => {
  waves += 1;
  count.textContent = \`\${waves} wave\${waves === 1 ? '' : 's'} so far\`;
});
`;
  const STYLES = `:root {
  --accent: #005eff;
  --bg: #0b0b0d;
  --text: #f5f5f7;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, system-ui, sans-serif;
}

.hero {
  padding: 48px 24px;
  text-align: center;
}

.hero h1 {
  margin: 0 0 8px;
  font-size: 44px;
}

.hero h1 span {
  color: var(--accent);
}

button {
  margin-top: 16px;
  padding: 10px 20px;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.count {
  font-size: 14px;
  opacity: .6;
}
`;
  const files = new Map([
    ['.claude/launch.json', { text: LAUNCH }],
    ['.claude/settings.local.json', { text: '{\n  "permissions": {\n    "allow": ["Bash(python -m http.server:*)"]\n  }\n}\n' }],
    ['.git/HEAD', { text: 'ref: refs/heads/master\n' }],
    ['.git/config', { text: '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n' }],
    ['assets/icon.png', { image: `${ASSETS}brand/Icon.png` }],
    ['assets/city.png', { image: `${ASSETS}screens/pattayacityview.png` }],
    ['index.html', { text: INDEX }],
    ['site.js', { text: SITE }],
    ['styles.css', { text: STYLES }],
  ]);
  for (const f of files.values()) if ('text' in f) f.saved = f.text;
  const dirs = new Set(['.claude', '.git', 'assets']);
  const committed = new Map([['.git/HEAD', ''], ['.git/config', '']]); // checkpointed text, by path

  const isDirty = p => { const f = files.get(p); return !!f && 'text' in f && f.text !== f.saved; };
  function gitState(p) {
    if (p.startsWith('.git/')) return '';
    const f = files.get(p);
    if (!committed.has(p)) return 'U';
    return f.image || f.saved === committed.get(p) ? '' : 'M';
  }
  const changedFiles = () => [...files.keys()].filter(gitState).sort();

  /* ================= Highlighting (the app's lexers) ================= */
  const LANGS = { html: ['html', 'HTML'], css: ['css', 'CSS'], js: ['js', 'JavaScript'], mjs: ['js', 'JavaScript'], ts: ['js', 'TypeScript'], json: ['json', 'JSON'], md: ['md', 'Markdown'], py: ['py', 'Python'], png: ['', 'PNG Image'], jpg: ['', 'JPEG Image'] };
  const langOf = p => LANGS[extOf(p)] ?? ['', 'Plain Text'];
  const either = (...ps) => new RegExp(ps.map(p => p.source).join('|'));
  const lexer = rules => new RegExp(rules.map(([k, p]) => `(?<${k}>${p.source})`).join('|'), 'g');
  const keywords = list => new RegExp(String.raw`\b(?:${list.replaceAll(' ', '|')})\b`);
  const JS_KW = 'break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while yield async await static get set true false null undefined';
  const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
  const LINE_COMMENT = /\/\/[^\n]*/;
  const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/;
  const QUOTED = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/;
  const BACKTICKED = /`(?:\\[\s\S]|[^`\\])*`?/;
  const NUMBER = either(/\b0[xX][\da-fA-F]+\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/);
  const LEXERS = {
    js: lexer([['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['str', either(QUOTED, BACKTICKED)], ['num', NUMBER], ['kw', keywords(JS_KW)], ['prop', /\b[A-Za-z_$][\w$]*(?=\()/]]),
    css: lexer([['com', BLOCK_COMMENT], ['str', QUOTED], ['kw', /@[\w-]+|!important/], ['prop', /--?[A-Za-z_][\w-]*(?=\s*:)/], ['num', either(/#[\da-fA-F]{3,8}\b/, /-?\b\d+(?:\.\d+)?(?:%|[a-z]{1,3})?/)]]),
    json: lexer([['prop', /"(?:\\.|[^"\\\n])*"(?=\s*:)/], ['str', /"(?:\\.|[^"\\\n])*"?/], ['num', either(/-/, NUMBER)], ['kw', /\b(?:true|false|null)\b/]]),
    py: lexer([['com', /#[^\n]*/], ['str', either(/"""[\s\S]*?(?:"""|$)/, /'''[\s\S]*?(?:'''|$)/, QUOTED)], ['num', NUMBER], ['kw', keywords(PY_KW)], ['prop', /\b[A-Za-z_]\w*(?=\()/]]),
    md: lexer([['kw', /(?<=^|\n)#{1,6}[^\n]*/], ['str', either(/```[^`]*(?:```|$)/, /`[^`\n]*`/)], ['com', /(?<=^|\n)>[^\n]*/], ['attr', /\*\*[^*\n]+\*\*/]]),
    html: lexer([['com', /<!--[\s\S]*?(?:-->|$)/], ['tagblock', /<[!/]?[A-Za-z][^>]*>?/]]),
  };
  const HTML_TAG = lexer([['tag', /^<[!/]?[\w:-]+|\/?>$/], ['str', /"[^"]*"?|'[^']*'?/], ['attr', /[^\s="'<>/]+/]]);
  function lex(text, re) {
    const out = [];
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) out.push([null, text.slice(last, m.index)]);
      const kind = Object.keys(m.groups).find(k => m.groups[k] !== undefined) ?? null;
      if (kind === 'tagblock') out.push(...lex(m[0], HTML_TAG));
      else out.push([kind, m[0]]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push([null, text.slice(last)]);
    return out;
  }
  // CSS: plain text outside any { } block is a selector.
  function markSelectors(toks) {
    let depth = 0;
    const out = [];
    for (const [cls, text] of toks) {
      if (cls) { out.push([cls, text]); continue; }
      for (const part of text.split(/([{}])/)) {
        if (part === '{') depth++;
        else if (part === '}') depth = Math.max(0, depth - 1);
        out.push([depth === 0 && part !== '}' && part.trim() !== '' ? 'tag' : null, part]);
      }
    }
    return out;
  }
  function highlightLines(text, name) {
    if (!LEXERS[name]) return text.split('\n').map(esc);
    const lines = [''];
    const toks = lex(text, LEXERS[name]);
    for (const [cls, t] of name === 'css' ? markSelectors(toks) : toks) {
      t.split('\n').forEach((part, i) => {
        if (i > 0) lines.push('');
        if (part) lines[lines.length - 1] += cls ? `<span class="bz-tk-${cls}">${esc(part)}</span>` : esc(part);
      });
    }
    return lines;
  }
  const COMMENT = { js: ['// ', ''], py: ['# ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };

  /* ================= Window ================= */
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Interactive Breeze Code demo');
  root.innerHTML = `
  <div class="bz-ide" id="bzIde">
    <header class="bz-titlebar">
      <span class="bz-logo"><img src="${ASSETS}brand/BreezeCode.png" alt="Breeze Code" width="119" height="20"></span>
      <nav class="bz-menubar" aria-label="Application menu"></nav>
      <span class="bz-spacer"></span>
      <span class="bz-project">BreezeIDE-Web</span>
      <span class="bz-spacer"></span>
      <div class="bz-layout-btns">
        <button class="bz-icon-btn" data-act="view.toggleSide" title="Toggle Primary Side Bar (Ctrl+B)"></button>
        <button class="bz-icon-btn" data-act="term.toggle" title="Toggle Panel (Ctrl+\`)"></button>
        <button class="bz-icon-btn" data-act="view.toggleAgents" title="Toggle Agents (Ctrl+Alt+B)"></button>
      </div>
      <button class="bz-avatar" data-act="account" title="Account" aria-haspopup="menu">Y</button>
      <div class="bz-winbtns">
        <button class="bz-winbtn" data-act="win.min" title="Minimize">${icon('minimize', 14)}</button>
        <button class="bz-winbtn" data-act="win.max" title="Full screen">${icon('maximize', 13)}</button>
        <button class="bz-winbtn close" data-act="win.close" title="Close">${icon('close', 14)}</button>
      </div>
    </header>
    <div class="bz-main" id="bzMain">
      <nav class="bz-activity" aria-label="Views">
        <div class="bz-act-indicator"></div>
        <button class="bz-act-btn on" data-view="files" title="Explorer (Ctrl+Shift+E)">${icon('files', 20)}</button>
        <button class="bz-act-btn" data-view="search" title="Search (Ctrl+Shift+F)">${icon('search', 20)}</button>
        <button class="bz-act-btn" data-view="git" title="Checkpoints (Ctrl+Shift+G)">${icon('git', 20)}<span class="bz-badge"></span></button>
        <span class="bz-spacer"></span>
        <button class="bz-act-btn gear" data-act="settings" title="Settings" aria-haspopup="menu">${icon('gear', 20)}</button>
      </nav>
      <aside class="bz-sidebar" aria-label="Side bar">
        <div data-panel="files">
          <div class="bz-side-head"><span>Explorer</span><span class="bz-head-actions">
            <button class="bz-icon-btn" data-act="file.newFile" title="New File">${icon('newfile', 14)}</button>
            <button class="bz-icon-btn" data-act="file.newFolder" title="New Folder">${icon('newdir', 14)}</button>
            <button class="bz-icon-btn" data-act="explorer.refresh" title="Refresh">${icon('refresh', 14)}</button>
            <button class="bz-icon-btn" data-act="explorer.collapse" title="Collapse Folders">${icon('collapse', 14)}</button>
            <button class="bz-icon-btn" data-act="view.toggleSide" title="Hide Side Bar">${icon('chev', 14)}</button>
          </span></div>
        </div>
        <div data-panel="search" class="bz-hidden">
          <div class="bz-side-head"><span>Search</span><span class="bz-head-actions"><button class="bz-icon-btn" data-act="view.toggleSide" title="Hide Side Bar">${icon('chev', 14)}</button></span></div>
          <div class="bz-search-box"><input class="bz-input" id="bzSearch" aria-label="Find in project" placeholder="Find in project" spellcheck="false" autocomplete="off"></div>
        </div>
        <div data-panel="git" class="bz-hidden">
          <div class="bz-side-head"><span>Source Control</span><span class="bz-head-actions"><button class="bz-icon-btn" data-act="view.toggleSide" title="Hide Side Bar">${icon('chev', 14)}</button></span></div>
        </div>
        <div class="bz-side-body" id="bzSideBody" tabindex="-1"></div>
      </aside>
      <section class="bz-center">
        <div class="bz-work no-preview" id="bzWork">
          <div class="bz-pane">
            <div class="bz-tabs" id="bzTabs" role="tablist"></div>
            <div class="bz-editor" id="bzEditor">
              <div class="bz-gutter"><div></div></div>
              <div class="bz-code"><pre class="bz-hl" aria-hidden="true"><div></div></pre><textarea class="bz-ta" id="bzTa" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" aria-label="Code editor"></textarea></div>
              <div class="bz-findbar bz-hidden">
                <input class="bz-input" id="bzFind" aria-label="Find in file" placeholder="Find" spellcheck="false" autocomplete="off">
                <span class="bz-find-count"></span>
                <button class="bz-icon-btn" data-act="find.prev" title="Previous (Shift+Enter)">${icon('up', 14)}</button>
                <button class="bz-icon-btn" data-act="find.next" title="Next (Enter)">${icon('down', 14)}</button>
                <button class="bz-icon-btn" data-act="find.close" title="Close (Escape)">${icon('x', 14)}</button>
              </div>
            </div>
            <div class="bz-image bz-hidden"><img alt=""></div>
            <div class="bz-empty bz-hidden" id="bzEmpty"><img src="${ASSETS}brand/Agent.png" alt="" width="64" height="64"><h4>No file open</h4>
              <div>Pick a file in the Explorer, or press <kbd>F5</kbd> to preview the site.</div></div>
          </div>
          <div class="bz-pane preview">
            <div class="bz-preview-bar"><span class="bz-preview-label">Preview</span>
              <span class="bz-url"><span class="bz-live"></span>http://127.0.0.1:5173/index.html</span>
              <button class="bz-icon-btn" data-act="run.reload" title="Reload Preview">${icon('refresh', 13)}</button>
              <button class="bz-icon-btn" data-act="run.stop" title="Close Preview">${icon('x', 13)}</button></div>
            <iframe class="bz-preview-frame" title="Preview of index.html" sandbox="allow-scripts"></iframe>
          </div>
        </div>
        <div class="bz-terminal" id="bzTerm">
          <div class="bz-term-head" data-act="term.toggle">
            <span class="bz-term-title">${icon('chevronRight', 14)} Terminal</span><span class="bz-spacer"></span>
            <button class="bz-icon-btn" data-act="term.clear" title="Clear">${icon('backspace', 15)}</button>
            <button class="bz-icon-btn" data-act="term.kill" title="Stop running command">${icon('stop', 13)}</button>
            <span>Ctrl+\`</span>
          </div>
          <div class="bz-term-body" id="bzTermBody">
            <div class="bz-term-out" id="bzTermOut"></div>
            <div class="bz-term-line"><span class="bz-ps">PS D:\\BreezeIDE-Web&gt;</span><input id="bzTermIn" spellcheck="false" autocomplete="off" aria-label="Terminal input"></div>
          </div>
        </div>
      </section>
      <aside class="bz-agents" aria-label="Agents">
        <div class="bz-side-head"><span>Agents</span><span class="bz-head-actions" style="opacity:1">
          <button class="bz-pill blue" data-act="agent.pick" aria-haspopup="menu" id="bzAgentPill">Claude Code</button>
          <button class="bz-icon-btn" data-act="chat.new" title="New chat">${icon('plus', 14)}</button>
          <button class="bz-icon-btn flip" data-act="view.toggleAgents" title="Hide Agents">${icon('chev', 14)}</button>
        </span></div>
        <div class="bz-agent-cards bz-hidden" id="bzCards"></div>
        <div class="bz-chat" id="bzChat" aria-live="polite"></div>
        <div class="bz-composer"><div class="bz-composer-box">
          <textarea id="bzPrompt" rows="2" aria-label="Message to the agent" placeholder="Describe what you want to build…"></textarea>
          <div class="bz-row">
            <select class="bz-select" id="bzMode" aria-label="How the agent should work">
              <option value="plan">Plan, then build</option><option value="build">Build directly</option><option value="ask">Ask (read-only)</option>
            </select>
            <button class="bz-btn bz-btn-primary bz-send" data-act="agent.send" title="Send (Enter)" aria-label="Send">${icon('send', 14)}</button>
          </div>
        </div></div>
      </aside>
    </div>
    <footer class="bz-statusbar">
      <button class="bz-sb" data-act="branch" title="Branch">${icon('gitBranch', 14)}<span>master</span></button>
      <span class="bz-sb"><span class="bz-dot-ok"></span> Git ready · Node ready · Python ready</span>
      <span class="bz-spacer"></span>
      <button class="bz-sb" data-act="vibe" id="bzVibe" title="Vibe Mode: plays your feed while agents work">${icon('circle', 14)}<span>Vibe Mode off</span></button>
      <button class="bz-sb" data-act="discord" id="bzDiscord" title="Discord presence">Discord: off</button>
      <button class="bz-sb" data-act="editor.focus" id="bzPos">Ln 1, Col 1</button>
      <span class="bz-sb" id="bzLang">Plain Text</span>
      <span class="bz-sb">LF · UTF-8</span>
      <button class="bz-sb" data-act="account">Not signed in</button>
    </footer>
    <div class="bz-toasts" aria-live="polite"></div>
  </div>`;

  const $ = sel => root.querySelector(sel);
  const $$ = sel => [...root.querySelectorAll(sel)];
  const ide = $('#bzIde');
  const main = $('#bzMain');
  const work = $('#bzWork');
  const ta = $('#bzTa');
  const hlInner = $('.bz-hl > div');
  const gutterInner = $('.bz-gutter > div');
  const editorEl = $('#bzEditor');
  const imageView = $('.bz-image');
  const emptyView = $('#bzEmpty');
  const tabsEl = $('#bzTabs');
  const sideBody = $('#bzSideBody');
  const term = $('#bzTerm');
  const termOut = $('#bzTermOut');
  const termIn = $('#bzTermIn');
  const termBody = $('#bzTermBody');
  const chat = $('#bzChat');
  const promptEl = $('#bzPrompt');
  const frame = $('.bz-preview-frame');

  /* ----- fit the desktop-sized window into the frame ----- */
  let scale = 1;
  function fit() {
    const w = root.clientWidth, h = root.clientHeight;
    if (!w || !h) return;
    scale = Math.min(1, w / MIN_W);
    ide.style.width = `${w / scale}px`;
    ide.style.height = `${h / scale}px`;
    ide.style.transform = scale < 1 ? `scale(${scale})` : '';
  }
  fit();
  new ResizeObserver(fit).observe(root);
  // Screen position → window coordinates (the frame itself may also be scaled by the page).
  function toIde(x, y) {
    const r = ide.getBoundingClientRect();
    const k = r.width / ide.offsetWidth;
    return [(x - r.left) / k, (y - r.top) / k];
  }

  /* ================= State ================= */
  const layout = { side: true, agents: false, term: false, preview: false, view: 'files' };
  const openDirs = new Set();
  let selected = 'launch.json';
  let tabs = ['site.js', '.claude/launch.json'];
  let active = '.claude/launch.json';
  const views = new Map(); // path -> { sel, top, left }
  const added = new Map(); // path -> Set of line numbers the agent just wrote
  let pending = null; // inline name box in the explorer: { kind: 'file' | 'dir' | 'rename', parent, path }
  selected = '.claude/launch.json';
  views.set(active, { sel: [LAUNCH.length, LAUNCH.length], top: 0, left: 0 });

  /* ================= Toasts, menus, modal ================= */
  const toasts = $('.bz-toasts');
  function toast(html, ms = 3200) {
    const t = document.createElement('div');
    t.className = 'bz-toast';
    t.innerHTML = html;
    toasts.append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
  }
  const DOWNLOAD = 'https://github.com/itsphatto/BreezeCode/releases/latest';
  const desktopOnly = what => toast(`${what} works in the desktop app. <a href="${DOWNLOAD}" target="_blank" rel="noopener">Download Breeze Code</a>`, 4200);

  let menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.el.remove();
    menu.anchor?.classList.remove('open');
    menu = null;
  }
  // items: { label, key, run, checked, disabled, sep, href }
  function openMenu(items, anchor, at) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'bz-menu';
    el.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.sep) { el.insertAdjacentHTML('beforeend', '<div class="bz-menu-sep"></div>'); continue; }
      const b = document.createElement('button');
      b.className = `bz-menu-item${it.checked ? ' checked' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.disabled = !!it.disabled;
      b.innerHTML = `<span>${esc(it.label)}</span>${it.key ? `<span class="key">${esc(it.key)}</span>` : ''}`;
      b.addEventListener('click', () => {
        closeMenu();
        if (it.href) window.open(it.href, '_blank', 'noopener');
        else it.run?.();
      });
      el.append(b);
    }
    ide.append(el);
    let x, y;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      [x, y] = toIde(r.left, r.bottom + 4);
      anchor.classList.add('open');
      if (at === 'up') {
        [x, y] = toIde(r.right + 6, r.bottom);
        y -= el.offsetHeight;
      } else if (at === 'right') {
        const [rx] = toIde(r.right, 0);
        x = rx - el.offsetWidth;
      }
    } else [x, y] = at;
    x = Math.max(4, Math.min(x, ide.offsetWidth - el.offsetWidth - 4));
    y = Math.max(4, Math.min(y, ide.offsetHeight - el.offsetHeight - 4));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    menu = { el, anchor, items };
    el.querySelector('.bz-menu-item:not(:disabled)')?.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', e => {
    if (menu && !menu.el.contains(e.target) && !menu.anchor?.contains(e.target)) closeMenu();
  });

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'bz-modal-back';
    back.innerHTML = `<div class="bz-modal" role="dialog" aria-modal="true">${html}<button class="bz-btn bz-btn-primary" data-close>Got it</button></div>`;
    const close = () => back.remove();
    back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
    back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ide.append(back);
    back.querySelector('[data-close]').focus({ preventScroll: true });
  }
  const SHORTCUTS = [
    ['Save', 'Ctrl+S'], ['Find', 'Ctrl+F'], ['Toggle line comment', 'Ctrl+/'], ['Move line up / down', 'Alt+↑ / Alt+↓'],
    ['Copy line down', 'Shift+Alt+↓'], ['Select line', 'Ctrl+L'], ['Toggle side bar', 'Ctrl+B'], ['Toggle terminal', 'Ctrl+`'],
    ['Toggle agents', 'Ctrl+Alt+B'], ['Explorer / Search / Checkpoints', 'Ctrl+Shift+E / F / G'], ['Preview the site', 'F5'],
  ];

  /* ================= Menu bar ================= */
  const hasFile = () => !!active && 'text' in (files.get(active) ?? {});
  const MENUS = [
    ['File', () => [
      { label: 'New File…', run: () => cmd('file.newFile') },
      { label: 'New Folder…', run: () => cmd('file.newFolder') },
      { sep: true },
      { label: 'Open Folder…', key: 'Ctrl+O', run: () => desktopOnly('Opening folders') },
      { sep: true },
      { label: 'Save', key: 'Ctrl+S', run: () => cmd('file.save'), disabled: !hasFile() },
      { label: 'Save All', run: () => cmd('file.saveAll'), disabled: ![...files.keys()].some(isDirty) },
      { sep: true },
      { label: 'Close Editor', run: () => active && closeTab(active), disabled: !active },
      { sep: true },
      { label: 'Exit', run: () => cmd('win.close') },
    ]],
    ['Edit', () => [
      { label: 'Undo', key: 'Ctrl+Z', run: () => editCmd('undo'), disabled: !hasFile() },
      { label: 'Redo', key: 'Ctrl+Y', run: () => editCmd('redo'), disabled: !hasFile() },
      { sep: true },
      { label: 'Cut', key: 'Ctrl+X', run: () => editCmd('cut'), disabled: !hasFile() },
      { label: 'Copy', key: 'Ctrl+C', run: () => editCmd('copy'), disabled: !hasFile() },
      { label: 'Paste', key: 'Ctrl+V', run: () => editCmd('paste'), disabled: !hasFile() },
      { sep: true },
      { label: 'Find', key: 'Ctrl+F', run: () => cmd('edit.find'), disabled: !hasFile() },
      { label: 'Find in Files', key: 'Ctrl+Shift+F', run: () => cmd('view.search') },
      { sep: true },
      { label: 'Toggle Line Comment', key: 'Ctrl+/', run: () => cmd('edit.comment'), disabled: !hasFile() },
    ]],
    ['Selection', () => [
      { label: 'Select All', key: 'Ctrl+A', run: () => { focusEditor(); ta.select(); onCaret(); }, disabled: !hasFile() },
      { label: 'Select Line', key: 'Ctrl+L', run: () => cmd('sel.line'), disabled: !hasFile() },
      { sep: true },
      { label: 'Copy Line Down', key: 'Shift+Alt+Down', run: () => cmd('sel.dup'), disabled: !hasFile() },
      { label: 'Move Line Up', key: 'Alt+Up', run: () => cmd('sel.up'), disabled: !hasFile() },
      { label: 'Move Line Down', key: 'Alt+Down', run: () => cmd('sel.down'), disabled: !hasFile() },
    ]],
    ['View', () => [
      { label: 'Explorer', key: 'Ctrl+Shift+E', run: () => cmd('view.files') },
      { label: 'Search', key: 'Ctrl+Shift+F', run: () => cmd('view.search') },
      { label: 'Checkpoints', key: 'Ctrl+Shift+G', run: () => cmd('view.git') },
      { sep: true },
      { label: 'Primary Side Bar', key: 'Ctrl+B', checked: layout.side, run: () => cmd('view.toggleSide') },
      { label: 'Agents Panel', key: 'Ctrl+Alt+B', checked: layout.agents, run: () => cmd('view.toggleAgents') },
      { label: 'Terminal', key: 'Ctrl+`', checked: layout.term, run: () => cmd('term.toggle') },
      { label: 'Preview', key: 'F5', checked: layout.preview, run: () => cmd(layout.preview ? 'run.stop' : 'run.start') },
      { label: 'Reset Layout', run: () => cmd('view.reset') },
    ]],
    ['Terminal', () => [
      { label: 'Focus Terminal', run: () => cmd('term.focus') },
      { label: 'Toggle Terminal', key: 'Ctrl+`', run: () => cmd('term.toggle') },
      { sep: true },
      { label: 'Clear Terminal', run: () => cmd('term.clear') },
      { label: 'Run Preview Server', key: 'F5', run: () => cmd('run.start') },
      { label: 'Stop Preview Server', run: () => cmd('run.stop'), disabled: !layout.preview },
    ]],
  ];
  const menubar = $('.bz-menubar');
  for (const [name, build] of MENUS) {
    const b = document.createElement('button');
    b.className = 'bz-menu-top';
    b.textContent = name;
    b.setAttribute('aria-haspopup', 'menu');
    b.addEventListener('click', () => (menu?.anchor === b ? closeMenu() : openMenu(build(), b)));
    // With one menu open, sliding along the bar opens the next one.
    b.addEventListener('pointerenter', () => { if (menu && menu.anchor !== b && menu.anchor?.classList.contains('bz-menu-top')) openMenu(build(), b); });
    menubar.append(b);
  }

  /* ================= Layout ================= */
  function applyLayout() {
    main.classList.toggle('no-side', !layout.side);
    main.classList.toggle('no-agents', !layout.agents);
    work.classList.toggle('no-preview', !layout.preview);
    term.classList.toggle('open', layout.term);
    const [s, t, a] = $$('.bz-layout-btns button');
    s.innerHTML = icon(layout.side ? 'leftOn' : 'left');
    t.innerHTML = icon(layout.term ? 'bottomOn' : 'bottom');
    a.innerHTML = icon(layout.agents ? 'rightOn' : 'right');
    $$('.bz-act-btn[data-view]').forEach(b => b.classList.toggle('on', layout.side && b.dataset.view === layout.view));
    const on = $(`.bz-act-btn[data-view="${layout.view}"]`);
    const ind = $('.bz-act-indicator');
    ind.style.opacity = layout.side ? '1' : '0';
    ind.style.transform = `translateY(${on.offsetTop + 8}px)`;
    $$('[data-panel]').forEach(p => p.classList.toggle('bz-hidden', p.dataset.panel !== layout.view));
  }
  function showView(v) {
    if (layout.side && layout.view === v) { layout.side = false; applyLayout(); return; }
    layout.side = true;
    layout.view = v;
    applyLayout();
    renderSide();
    if (v === 'search') $('#bzSearch').focus({ preventScroll: true });
  }

  /* ================= Explorer ================= */
  function childrenOf(dir) {
    const pre = dir ? `${dir}/` : '';
    const subdirs = [...dirs].filter(d => d.startsWith(pre) && !d.slice(pre.length).includes('/'));
    const own = [...files.keys()].filter(p => p.startsWith(pre) && !p.slice(pre.length).includes('/'));
    const byName = (a, b) => baseName(a).localeCompare(baseName(b));
    return [...subdirs.sort(byName), ...own.sort(byName)];
  }
  const dirChanged = d => [...files.keys()].some(p => p.startsWith(`${d}/`) && gitState(p));
  function nameBox(depth, value) {
    return `<div class="bz-tree-item" style="padding-left:${8 + depth * 12}px"><span class="bz-chev none">${CHEV}</span><span class="bz-ico">${pending.kind === 'dir' ? folderIcon('', false) : fileIcon(value || 'file')}</span><input class="bz-tree-input" value="${esc(value)}" aria-label="Name" spellcheck="false" autocomplete="off"></div>`;
  }
  function treeHtml(dir, depth) {
    let html = '';
    if (pending && pending.kind !== 'rename' && pending.parent === dir) html += nameBox(depth, '');
    for (const p of childrenOf(dir)) {
      const isDir = dirs.has(p);
      if (pending?.kind === 'rename' && pending.path === p) { html += nameBox(depth, baseName(p)); continue; }
      const st = isDir ? '' : gitState(p);
      const cls = ['bz-tree-item', selected === p ? 'on' : '', st ? `bz-git-${st.toLowerCase()}` : '', isDir && dirChanged(p) ? 'bz-dot' : ''].join(' ');
      const open = openDirs.has(p);
      html += `<button class="${cls}" data-path="${esc(p)}" style="padding-left:${8 + depth * 12}px" ${isDir ? `aria-expanded="${open}"` : ''}>`
        + `<span class="bz-chev ${isDir ? (open ? 'open' : '') : 'none'}">${CHEV}</span>`
        + `<span class="bz-ico">${isDir ? folderIcon(baseName(p), open) : fileIcon(baseName(p))}</span>`
        + `<span class="bz-nm">${esc(baseName(p))}${isDirty(p) ? ' ●' : ''}</span>${st ? `<span class="bz-gst">${st}</span>` : ''}</button>`;
      if (isDir && open) html += treeHtml(p, depth + 1);
    }
    return html;
  }
  function renderTree() {
    sideBody.innerHTML = treeHtml('', 0);
    const box = sideBody.querySelector('.bz-tree-input');
    if (!box) return;
    box.focus({ preventScroll: true });
    if (pending.kind === 'rename') box.setSelectionRange(0, box.value.includes('.') ? box.value.lastIndexOf('.') : box.value.length);
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      const name = box.value.trim();
      const p = pending;
      pending = null;
      if (ok && name) {
        if (/[\\/:*?"<>|]/.test(name)) toast(`A name can't contain \\ / : * ? " < > |`);
        else if (p.kind === 'rename') renameEntry(p.path, name);
        else createEntry(p.kind, p.parent ? `${p.parent}/${name}` : name);
      }
      renderTree();
    };
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    box.addEventListener('blur', () => finish(true));
  }
  function createEntry(kind, path) {
    if (files.has(path) || dirs.has(path)) { toast(`<b>${esc(baseName(path))}</b> already exists here.`); return; }
    if (kind === 'dir') { dirs.add(path); openDirs.add(path); selected = path; return; }
    files.set(path, { text: '', saved: '' });
    selected = path;
    openFile(path, true);
    renderBadge();
  }
  function renameEntry(from, name) {
    const to = dirName(from) ? `${dirName(from)}/${name}` : name;
    if (to === from) return;
    if (files.has(to) || dirs.has(to)) { toast(`<b>${esc(name)}</b> already exists here.`); return; }
    const move = p => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    for (const [p, f] of [...files]) if (move(p) !== p) { files.delete(p); files.set(move(p), f); }
    for (const d of [...dirs]) if (move(d) !== d) { dirs.delete(d); dirs.add(move(d)); }
    for (const m of [views, added, committed]) for (const [p, v] of [...m]) if (move(p) !== p) { m.delete(p); m.set(move(p), v); }
    tabs = tabs.map(move);
    if (active) active = move(active);
    selected = move(selected);
    renderTabs();
    renderEditor();
    renderBadge();
  }
  function deleteEntry(path) {
    const gone = p => p === path || p.startsWith(`${path}/`);
    for (const p of [...files.keys()]) if (gone(p)) files.delete(p);
    for (const d of [...dirs]) if (gone(d)) dirs.delete(d);
    for (const p of tabs.filter(gone)) closeTab(p);
    renderTree();
    renderBadge();
    toast(`Deleted <b>${esc(baseName(path))}</b>`);
  }
  sideBody.addEventListener('click', e => {
    const item = e.target.closest('.bz-tree-item[data-path]');
    if (item) {
      const p = item.dataset.path;
      selected = p;
      if (dirs.has(p)) { openDirs.has(p) ? openDirs.delete(p) : openDirs.add(p); renderTree(); }
      else openFile(p);
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) openFile(open.dataset.open, false, open.dataset.at && JSON.parse(open.dataset.at));
  });
  sideBody.addEventListener('contextmenu', e => {
    const item = e.target.closest('.bz-tree-item[data-path]');
    if (!item || layout.view !== 'files') return;
    e.preventDefault();
    const p = item.dataset.path;
    selected = p;
    renderTree();
    const parent = dirs.has(p) ? p : dirName(p);
    openMenu([
      { label: 'New File…', run: () => { pending = { kind: 'file', parent }; openDirs.add(parent); renderTree(); } },
      { label: 'New Folder…', run: () => { pending = { kind: 'dir', parent }; openDirs.add(parent); renderTree(); } },
      { sep: true },
      { label: 'Rename…', key: 'F2', run: () => { pending = { kind: 'rename', path: p }; renderTree(); } },
      { label: 'Delete', key: 'Del', run: () => deleteEntry(p) },
    ], null, toIde(e.clientX, e.clientY));
  });

  /* ================= Search ================= */
  let searchTimer = 0;
  function renderSearch() {
    const q = $('#bzSearch').value;
    if (!q) { sideBody.innerHTML = '<p class="bz-side-note">Type to search across every file in the project.</p>'; return; }
    const lower = q.toLowerCase();
    let html = '', total = 0;
    for (const [p, f] of [...files].sort()) {
      if (!('text' in f) || p.startsWith('.git/')) continue;
      const hits = [];
      f.text.split('\n').forEach((line, i) => {
        const at = line.toLowerCase().indexOf(lower);
        if (at >= 0) hits.push([i, at, line]);
      });
      if (!hits.length) continue;
      total += hits.length;
      html += `<div class="bz-result-file"><span class="bz-ico">${fileIcon(baseName(p))}</span>${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>`;
      for (const [i, at, line] of hits.slice(0, 40)) {
        const from = Math.max(0, at - 18);
        html += `<button class="bz-hit" data-open="${esc(p)}" data-at="[${i},${at},${q.length}]">${from ? '…' : ''}${esc(line.slice(from, at).trimStart())}<mark>${esc(line.slice(at, at + q.length))}</mark>${esc(line.slice(at + q.length))}</button>`;
      }
    }
    sideBody.innerHTML = total ? `<p class="bz-side-note">${total} result${total === 1 ? '' : 's'}</p>${html}` : `<p class="bz-side-note">No results for “${esc(q)}”.</p>`;
  }
  $('#bzSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 120); });

  /* ================= Checkpoints (source control) ================= */
  let lastCheckpoint = null;
  function renderScm() {
    const list = changedFiles();
    const rows = list.map(p => {
      const st = gitState(p);
      return `<button class="bz-tree-item bz-git-${st.toLowerCase()}" data-open="${esc(p)}"><span class="bz-ico">${fileIcon(baseName(p))}</span><span class="bz-nm">${esc(baseName(p))}</span><small style="color:var(--text-3);overflow:hidden;text-overflow:ellipsis">${esc(dirName(p))}</small><span class="bz-gst">${st}</span></button>`;
    }).join('');
    sideBody.innerHTML = `<div class="bz-scm">
      <input class="bz-input" id="bzCommitMsg" placeholder="Message (Ctrl+Enter to save)" aria-label="Checkpoint message" spellcheck="false" autocomplete="off">
      <button class="bz-btn bz-btn-primary" data-act="git.commit" ${list.length ? '' : 'disabled'}>${icon('check', 14)} Save checkpoint</button>
      ${lastCheckpoint ? `<div class="bz-scm-done"><b>Checkpoint ${lastCheckpoint.hash} saved</b>${esc(lastCheckpoint.msg)}<span>${lastCheckpoint.count} file${lastCheckpoint.count === 1 ? '' : 's'} on master</span></div>` : ''}
      <div class="bz-scm-title">Changes · ${list.length}</div>
      ${list.length ? `<div>${rows}</div>` : '<p class="bz-side-note">No changes since the last checkpoint.</p>'}
    </div>`;
    $('#bzCommitMsg').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) cmd('git.commit'); });
  }
  function commit() {
    const list = changedFiles();
    if (!list.length) return;
    const msg = $('#bzCommitMsg')?.value.trim() || 'Update site';
    for (const p of list) committed.set(p, files.get(p).saved ?? '');
    lastCheckpoint = { msg, count: list.length, hash: Math.random().toString(16).slice(2, 9) };
    renderSide();
    renderBadge();
    renderTabs();
    toast(`${icon('check', 14)} Checkpoint saved · ${list.length} file${list.length === 1 ? '' : 's'}`);
  }

  function renderSide() {
    if (layout.view === 'files') renderTree();
    else if (layout.view === 'search') renderSearch();
    else renderScm();
  }
  function renderBadge() {
    const n = changedFiles().length;
    const b = $('.bz-badge');
    b.textContent = n;
    b.classList.toggle('bz-hidden', !n);
  }

  /* ================= Tabs & editor ================= */
  function renderTabs() {
    tabsEl.innerHTML = tabs.map(p => `<div class="bz-tab${p === active ? ' on' : ''}${isDirty(p) ? ' dirty' : ''}" role="tab" tabindex="0" aria-selected="${p === active}" data-tab="${esc(p)}" title="${esc(p)}"><span class="bz-ico">${fileIcon(baseName(p))}</span><span class="bz-nm">${esc(baseName(p))}</span><span class="bz-x" data-close="1" title="Close">${icon('x', 12)}</span></div>`).join('');
    tabsEl.querySelector('.bz-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  tabsEl.addEventListener('click', e => {
    const t = e.target.closest('.bz-tab');
    if (!t) return;
    if (e.target.closest('[data-close]')) closeTab(t.dataset.tab);
    else openFile(t.dataset.tab);
  });
  tabsEl.addEventListener('auxclick', e => { const t = e.target.closest('.bz-tab'); if (t && e.button === 1) closeTab(t.dataset.tab); });
  tabsEl.addEventListener('keydown', e => { const t = e.target.closest('.bz-tab'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFile(t.dataset.tab, true); } });

  function saveView() {
    if (active && hasFile()) views.set(active, { sel: [ta.selectionStart, ta.selectionEnd], top: ta.scrollTop, left: ta.scrollLeft });
  }
  function openFile(path, focus = false, at = null) {
    if (!files.has(path)) return;
    saveView();
    if (!tabs.includes(path)) {
      const i = tabs.indexOf(active);
      tabs.splice(i < 0 ? tabs.length : i + 1, 0, path);
    }
    active = path;
    selected = path;
    renderTabs();
    tabsEl.querySelector('.bz-tab.on')?.classList.add('enter');
    renderEditor();
    if (layout.view === 'files') renderTree();
    if (at) {
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < at[0]; i++) pos += lines[i].length + 1;
      focusEditor();
      ta.setSelectionRange(pos + at[1], pos + at[1] + at[2]);
      revealLine(at[0]);
      onCaret();
    } else if (focus) focusEditor();
  }
  function closeTab(path) {
    if (path === active) saveView();
    const i = tabs.indexOf(path);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (active === path) active = tabs[Math.min(i, tabs.length - 1)] ?? null;
    renderTabs();
    renderEditor();
  }
  const focusEditor = () => { if (hasFile()) ta.focus({ preventScroll: true }); };

  let charW = 7.8;
  function measure() {
    const probe = document.createElement('span');
    probe.textContent = 'x'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden';
    hlInner.append(probe);
    charW = probe.getBoundingClientRect().width / 100 / (ide.getBoundingClientRect().width / ide.offsetWidth || 1) || charW;
    probe.remove();
  }

  function renderEditor() {
    const f = active && files.get(active);
    const text = !!f && 'text' in f;
    editorEl.classList.toggle('bz-hidden', !text);
    imageView.classList.toggle('bz-hidden', !f?.image);
    emptyView.classList.toggle('bz-hidden', !!f);
    if (f?.image) imageView.querySelector('img').src = f.image;
    $('#bzLang').textContent = f ? langOf(active)[1] : 'Plain Text';
    if (!text) { $('#bzPos').textContent = 'Ln 1, Col 1'; closeFind(); return; }
    if (ta.value !== f.text) ta.value = f.text;
    const v = views.get(active) ?? { sel: [0, 0], top: 0, left: 0 };
    ta.setSelectionRange(...v.sel);
    ta.scrollTop = v.top;
    ta.scrollLeft = v.left;
    paint();
    syncScroll();
    if (findOpen) runFind(false);
  }
  const caretLine = () => ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
  function paint() {
    const lines = highlightLines(ta.value, langOf(active)[0]);
    const cur = caretLine();
    const marks = added.get(active);
    hlInner.innerHTML = lines.map((l, i) => `<div class="bz-ln${i === cur ? ' cur-line' : ''}${marks?.has(i) ? ' added' : ''}">${l || ' '}</div>`).join('') + hitsHtml();
    gutterInner.innerHTML = lines.map((_, i) => `<div${i === cur ? ' class="cur"' : ''}>${i + 1}</div>`).join('');
  }
  function onCaret() {
    const cur = caretLine();
    hlInner.querySelectorAll('.bz-ln').forEach((el, i) => el.classList.toggle('cur-line', i === cur));
    gutterInner.querySelectorAll('div').forEach((el, i) => el.classList.toggle('cur', i === cur));
    const col = ta.selectionStart - ta.value.lastIndexOf('\n', ta.selectionStart - 1);
    const n = ta.selectionEnd - ta.selectionStart;
    $('#bzPos').textContent = `Ln ${cur + 1}, Col ${col}${n ? ` (${n} selected)` : ''}`;
  }
  function syncScroll() {
    hlInner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }
  function revealLine(i) {
    const top = 10 + i * 21;
    if (top < ta.scrollTop + 21 || top > ta.scrollTop + ta.clientHeight - 42) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    syncScroll();
  }

  let previewTimer = 0;
  function onEdit() {
    const f = files.get(active);
    f.text = ta.value;
    added.delete(active);
    paint();
    onCaret();
    const tab = tabsEl.querySelector('.bz-tab.on');
    if (tab && tab.classList.contains('dirty') !== isDirty(active)) { renderTabs(); if (layout.view === 'files') renderTree(); }
    if (findOpen) runFind(false);
    if (layout.preview) { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 350); }
  }
  ta.addEventListener('input', onEdit);
  ta.addEventListener('scroll', syncScroll);
  ['keyup', 'pointerup', 'select', 'focus'].forEach(t => ta.addEventListener(t, onCaret));
  document.addEventListener('selectionchange', () => { if (document.activeElement === ta) onCaret(); });

  // Text changes go through insertText so the browser's own undo stack keeps working.
  function replaceRange(from, to, text, selFrom, selTo) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, text)) { ta.setRangeText(text, from, to, 'end'); onEdit(); }
    if (selFrom != null) ta.setSelectionRange(selFrom, selTo ?? selFrom);
    onCaret();
  }
  function lineSpan() {
    const v = ta.value;
    const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let e = v.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    if (e < 0) e = v.length;
    return [s, e];
  }
  function toggleComment() {
    const [open, close] = COMMENT[langOf(active)[0]] ?? COMMENT.js;
    const [s, e] = lineSpan();
    const lines = ta.value.slice(s, e).split('\n');
    const on = lines.every(l => !l.trim() || l.trimStart().startsWith(open.trim()));
    const out = lines.map(l => {
      if (!l.trim()) return l;
      if (on) return l.replace(open.trim() + ' ', '').replace(open.trim(), '').replace(close.trim() ? new RegExp(`\\s?${close.trim().replace(/[*]/g, '\\*')}$`) : /$^/, '');
      const ind = l.match(/^\s*/)[0];
      return ind + open + l.slice(ind.length) + close;
    }).join('\n');
    replaceRange(s, e, out, s, s + out.length);
  }
  function moveLine(dir) {
    const v = ta.value;
    const [s, e] = lineSpan();
    if (dir < 0 && s === 0) return;
    if (dir > 0 && e >= v.length) return;
    const block = v.slice(s, e);
    const off = ta.selectionStart - s, len = ta.selectionEnd - ta.selectionStart;
    if (dir < 0) {
      const ps = v.lastIndexOf('\n', s - 2) + 1;
      const prev = v.slice(ps, s - 1);
      replaceRange(ps, e, `${block}\n${prev}`, ps + off, ps + off + len);
    } else {
      let ne = v.indexOf('\n', e + 1);
      if (ne < 0) ne = v.length;
      const next = v.slice(e + 1, ne);
      const at = s + next.length + 1;
      replaceRange(s, ne, `${next}\n${block}`, at + off, at + off + len);
    }
  }
  function dupLine() {
    const [s, e] = lineSpan();
    const block = ta.value.slice(s, e);
    const off = ta.selectionStart - s;
    replaceRange(e, e, `\n${block}`, e + 1 + off);
  }
  ta.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      const [s, end] = lineSpan();
      if (e.shiftKey || ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) {
        const lines = ta.value.slice(s, end).split('\n');
        const out = lines.map(l => (e.shiftKey ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n');
        replaceRange(s, end, out, s, s + out.length);
      } else replaceRange(ta.selectionStart, ta.selectionEnd, '  ');
    } else if (e.key === 'Enter' && !mod && !e.shiftKey) {
      e.preventDefault();
      const before = ta.value.slice(ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1, ta.selectionStart);
      const ind = before.match(/^\s*/)[0];
      const opens = /[{[(]\s*$/.test(before) || /<(?!\/)[^>\/]*>\s*$/.test(before) && !/<(?:meta|link|br|img|input)\b/.test(before);
      const nextCh = ta.value[ta.selectionEnd];
      if (opens && /[}\])<]/.test(nextCh ?? '')) {
        const at = ta.selectionStart + 1 + ind.length + 2;
        replaceRange(ta.selectionStart, ta.selectionEnd, `\n${ind}  \n${ind}`, at);
      } else replaceRange(ta.selectionStart, ta.selectionEnd, `\n${ind}${opens ? '  ' : ''}`);
    } else if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.shiftKey) dupLine();
      else moveLine(e.key === 'ArrowUp' ? -1 : 1);
    } else if (!mod && !e.altKey && PAIRS[e.key] && ta.selectionStart !== ta.selectionEnd) {
      e.preventDefault(); // wrap the selection
      const s = ta.selectionStart, en = ta.selectionEnd;
      replaceRange(s, en, e.key + ta.value.slice(s, en) + PAIRS[e.key], s + 1, en + 1);
    }
  });
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  async function editCmd(what) {
    focusEditor();
    if (what === 'paste') {
      try { replaceRange(ta.selectionStart, ta.selectionEnd, await navigator.clipboard.readText()); }
      catch { toast('Press <b>Ctrl+V</b> to paste here.'); }
      return;
    }
    if (!document.execCommand(what)) toast(`Press <b>${{ undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C' }[what]}</b> instead.`);
  }

  /* ----- find in file ----- */
  let findOpen = false;
  let findHits = [];
  let findCur = -1;
  const findbar = $('.bz-findbar');
  const findIn = $('#bzFind');
  function openFind() {
    if (!hasFile()) return;
    findOpen = true;
    findbar.classList.remove('bz-hidden');
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n')) findIn.value = sel;
    findIn.focus({ preventScroll: true });
    findIn.select();
    runFind(false);
  }
  function closeFind() {
    if (!findOpen) return;
    findOpen = false;
    findHits = [];
    findbar.classList.add('bz-hidden');
    paint();
  }
  function hitsHtml() {
    if (!findOpen || !findHits.length) return '';
    if (!measured) { measure(); measured = true; }
    const lines = ta.value.split('\n');
    const starts = [];
    let pos = 0;
    for (const l of lines) { starts.push(pos); pos += l.length + 1; }
    const q = findIn.value.length;
    return findHits.map((at, k) => {
      let i = starts.length - 1;
      while (starts[i] > at) i--;
      const col = ta.value.slice(starts[i], at).replace(/\t/g, '    ').length;
      return `<i class="bz-hitbox${k === findCur ? ' cur' : ''}" style="top:${10 + i * 21}px;left:${4 + col * charW}px;width:${q * charW}px"></i>`;
    }).join('');
  }
  let measured = false;
  function runFind(step, back = false) {
    const q = findIn.value.toLowerCase();
    findHits = [];
    if (q) { const t = ta.value.toLowerCase(); for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) findHits.push(i); }
    if (!findHits.length) findCur = -1;
    else if (step) findCur = (findCur + (back ? -1 : 1) + findHits.length) % findHits.length;
    else findCur = Math.max(0, findHits.findIndex(h => h >= ta.selectionStart));
    $('.bz-find-count').textContent = q ? (findHits.length ? `${findCur + 1} of ${findHits.length}` : 'No results') : '';
    paint();
    if (findCur >= 0 && step) {
      ta.setSelectionRange(findHits[findCur], findHits[findCur] + q.length);
      revealLine(ta.value.slice(0, findHits[findCur]).split('\n').length - 1);
      paint();
      onCaret();
    }
  }
  findIn.addEventListener('input', () => runFind(false));
  findIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runFind(true, e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); focusEditor(); }
  });

  /* ================= Preview ================= */
  function buildPage() {
    const read = p => files.get(p)?.text ?? '';
    let html = read('index.html') || '<p style="font-family:sans-serif">index.html is missing.</p>';
    html = html.replace(/<link[^>]*href="([^"]+\.css)"[^>]*>/g, (m, href) => (files.has(href) ? `<style>${read(href)}</style>` : m));
    html = html.replace(/<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/g, (m, src) => (files.has(src) ? `<script>${read(src).replace(/<\/script/gi, '<\\/script')}<\/script>` : m));
    return html;
  }
  function refreshPreview() { frame.srcdoc = buildPage(); }
  function startPreview() {
    if (layout.preview) { refreshPreview(); return; }
    layout.preview = true;
    // Make room: the editor and the preview share the middle of the window.
    if (layout.agents && layout.side) layout.side = false;
    applyLayout();
    refreshPreview();
    termPrint('<span class="cmd">python -m http.server 5173 --bind 127.0.0.1</span>\nServing HTTP on 127.0.0.1 port 5173 (<span class="link">http://127.0.0.1:5173/</span>) ...\n');
  }
  function stopPreview() {
    if (!layout.preview) return;
    layout.preview = false;
    applyLayout();
    termPrint('Keyboard interrupt received, exiting.\n');
  }

  /* ================= Terminal ================= */
  const history = [];
  let histAt = 0;
  const termPrint = html => { termOut.insertAdjacentHTML('beforeend', html); termBody.scrollTop = termBody.scrollHeight; };
  const listing = dir => childrenOf(dir).map(p => (dirs.has(p) ? `<span class="link">${esc(baseName(p))}/</span>` : esc(baseName(p)))).join('   ');
  const resolve = arg => arg.replace(/^\.\//, '').replace(/\\/g, '/');
  const COMMANDS = {
    help: () => 'Try: ls, cat <file>, git status, git log, node -v, python --version, touch <file>, mkdir <dir>, rm <file>, echo, date, clear, or start to preview the site (F5).',
    ls: a => listing(resolve(a[0] ?? '').replace(/\/$/, '')),
    dir: a => COMMANDS.ls(a),
    pwd: () => 'D:\\BreezeIDE-Web',
    cat: a => {
      const p = resolve(a[0] ?? '');
      const f = files.get(p);
      if (!f) return `<span class="err">cat : Cannot find path 'D:\\BreezeIDE-Web\\${esc(a[0] ?? '')}' because it does not exist.</span>`;
      return f.image ? `<span class="err">${esc(p)} is an image. Open it from the Explorer.</span>` : esc(f.text);
    },
    type: a => COMMANDS.cat(a),
    echo: a => esc(a.join(' ')),
    date: () => new Date().toString(),
    whoami: () => 'breeze\\you',
    touch: a => { if (!a[0]) return '<span class="err">touch: missing file name</span>'; const p = resolve(a[0]); if (!files.has(p)) { files.set(p, { text: '', saved: '' }); renderSide(); renderBadge(); } return ''; },
    mkdir: a => { if (!a[0]) return '<span class="err">mkdir: missing folder name</span>'; dirs.add(resolve(a[0])); renderSide(); return ''; },
    rm: a => { const p = resolve(a[0] ?? ''); if (!files.has(p) && !dirs.has(p)) return `<span class="err">rm : Cannot find path '${esc(a[0] ?? '')}'.</span>`; deleteEntry(p); return ''; },
    node: a => (a[0] === '-v' || a[0] === '--version' ? 'v22.11.0' : a[0] ? `<span class="err">ReferenceError: document is not defined\n    at ${esc(a[0])}:2:16</span>\n(site.js runs in the page. Press F5 to preview it.)` : 'Welcome to Node.js v22.11.0.'),
    npm: a => (a[0] === '-v' || a[0] === '--version' ? '10.9.0' : `<span class="err">npm error Missing script: "${esc(a[1] ?? a[0] ?? '')}"</span>\n(This project is plain HTML. Press F5 to preview it.)`),
    python: a => {
      if (a[0] === '--version' || a[0] === '-V') return 'Python 3.13.1';
      if (a.join(' ').startsWith('-m http.server')) { setTimeout(startPreview); return ''; }
      return 'Python 3.13.1 (tags/v3.13.1) on win32';
    },
    py: a => COMMANDS.python(a),
    start: () => { setTimeout(startPreview); return ''; },
    git: a => {
      if (a[0] === 'status') {
        const list = changedFiles();
        if (!list.length) return 'On branch master\nnothing to commit, working tree clean';
        const un = list.filter(p => gitState(p) === 'U'), mod = list.filter(p => gitState(p) === 'M');
        return 'On branch master\n' + (mod.length ? `Changes not staged for commit:\n${mod.map(p => `\t<span class="err">modified:   ${esc(p)}</span>`).join('\n')}\n` : '') + (un.length ? `Untracked files:\n${un.map(p => `\t<span class="err">${esc(p)}</span>`).join('\n')}` : '');
      }
      if (a[0] === 'log') return lastCheckpoint ? `<span class="ok">commit ${lastCheckpoint.hash}</span> (HEAD -&gt; master)\n    ${esc(lastCheckpoint.msg)}` : 'fatal: your current branch \'master\' does not have any commits yet';
      if (a[0] === 'branch') return '* <span class="ok">master</span>';
      if (a[0] === 'add' || a[0] === 'commit') return 'Use Checkpoints in the side bar (Ctrl+Shift+G) to save your work.';
      return 'usage: git status | log | branch';
    },
    code: () => "You're already in it.",
    breeze: () => `Get the full app: <span class="link">${DOWNLOAD}</span>`,
    exit: () => { setTimeout(() => cmd('term.toggle')); return ''; },
  };
  function runTerm(line) {
    termPrint(`<span class="bz-ps">PS D:\\BreezeIDE-Web&gt;</span> <span class="cmd">${esc(line)}</span>\n`);
    const [name, ...args] = line.trim().split(/\s+/);
    if (!name) return;
    if (name === 'clear' || name === 'cls') { termOut.innerHTML = ''; return; }
    const fn = COMMANDS[name.toLowerCase()];
    const out = fn ? fn(args) : `<span class="err">${esc(name)} : The term '${esc(name)}' is not recognized as the name of a cmdlet, function, script file, or operable program.</span>\nType <span class="cmd">help</span> to see what this terminal can do.`;
    if (out) termPrint(`${out}\n`);
  }
  termIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = termIn.value;
      termIn.value = '';
      if (v.trim()) history.push(v);
      histAt = history.length;
      runTerm(v);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      histAt = Math.max(0, Math.min(history.length, histAt + (e.key === 'ArrowUp' ? -1 : 1)));
      termIn.value = history[histAt] ?? '';
    } else if (e.key === 'c' && e.ctrlKey && !termIn.value) {
      termPrint('^C\n');
    }
  });
  termBody.addEventListener('click', () => { if (!getSelection().toString()) termIn.focus({ preventScroll: true }); });
  termPrint('Breeze Code terminal · this one runs in your browser.\nType <span class="cmd">help</span> to see what it can do.\n');

  /* ================= Agents ================= */
  const AGENTS = ['Claude Code', 'Codex', 'Antigravity', 'Ollama · qwen2.5-coder'];
  let agentName = AGENTS[0];
  let busy = false;
  const cards = $('#bzCards');
  const roster = {};
  const ROLES = { planner: ['P', 'Planner'], builder: ['B', 'Builder'], assistant: ['A', 'Assistant'] };
  const STATUS = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', done: 'Done' };
  function setAgent(role, status, task) {
    roster[role] = { status, task };
    cards.classList.remove('bz-hidden');
    cards.innerHTML = Object.entries(roster).map(([r, a]) => `<div class="bz-agent ${a.status}"><span class="bz-ava ${r}">${ROLES[r][0]}</span><span class="name">${ROLES[r][1]}<small>${esc(agentName)}</small></span><span class="bz-status ${a.status}">${STATUS[a.status]}</span><span class="task">${esc(a.task)}</span></div>`).join('');
  }
  const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function addChat(html) {
    chat.querySelector('.bz-empty')?.remove();
    chat.insertAdjacentHTML('beforeend', html);
    chat.scrollTop = chat.scrollHeight;
    return chat.lastElementChild;
  }
  const say = (role, html) => addChat(`<div class="bz-msg"><span class="bz-meta"><span class="bz-ava-mini ${role}">${ROLES[role][0]}</span><b>${ROLES[role][1]}</b>${clock()}</span><div class="bz-body">${html}</div></div>`);
  const tool = (kind, ico, html) => addChat(`<div class="bz-tool-line ${kind}">${icon(ico, 14)}<span>${html}</span></div>`);
  async function typing(ms) {
    const el = addChat('<div class="bz-msg"><div class="bz-body bz-typing"><i></i><i></i><i></i></div></div>');
    await sleep(ms);
    el.remove();
  }
  function emptyChat() {
    chat.innerHTML = `<div class="bz-empty"><img src="${ASSETS}brand/Agent.png" alt="" width="44" height="44"><h4>What should we build?</h4><div>Ask for a change to this site, like<br><b>“make it purple and add a footer”</b>.</div></div>`;
    for (const k of Object.keys(roster)) delete roster[k];
    cards.classList.add('bz-hidden');
  }
  emptyChat();

  // The plan: each step is one real edit to the files, matched from the request.
  const COLORS = { red: '#ef4444', orange: '#f97316', yellow: '#eab308', gold: '#f59e0b', amber: '#f59e0b', green: '#22c55e', teal: '#14b8a6', cyan: '#06b6d4', blue: '#005eff', purple: '#8b5cf6', violet: '#8b5cf6', pink: '#ec4899', magenta: '#d946ef' };
  const STEP = {
    accent: c => ({ say: `Switch the accent color to ${c}`, file: 'styles.css', edit: t => t.replace(/--accent: [^;]+;/, `--accent: ${COLORS[c]};`) }),
    light: () => ({ say: 'Give the page a light background', file: 'styles.css', edit: t => t.replace(/--bg: [^;]+;/, '--bg: #f6f6f8;').replace(/--text: [^;]+;/, '--text: #121216;') }),
    heading: words => ({ say: `Change the heading to “${words}”`, file: 'index.html', edit: t => t.replace(/<h1>[\s\S]*?<\/h1>/, `<h1>${esc(words)}</h1>`) }),
    footer: () => ({
      say: 'Add a footer with a short credit line', file: 'index.html', also: 'styles.css',
      edit: t => (t.includes('class="footer"') ? t : t.replace('  <script', `  <footer class="footer">Made with Breeze Code · ${new Date().getFullYear()}</footer>\n  <script`)),
      alsoEdit: t => (t.includes('.footer {') ? t : `${t}\n.footer {\n  position: fixed;\n  bottom: 16px;\n  left: 0;\n  right: 0;\n  font-size: 13px;\n  text-align: center;\n  opacity: .5;\n}\n`),
    }),
    button: () => ({ say: 'Give the button a glow and a lift on hover', file: 'styles.css', edit: t => (t.includes('button:hover') ? t : `${t}\nbutton {\n  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 45%, transparent);\n  transition: transform .15s;\n}\n\nbutton:hover {\n  transform: translateY(-2px);\n}\n`) }),
    glow: () => ({ say: 'Light the hero with a soft glow in the accent color', file: 'styles.css', edit: t => (t.includes('radial-gradient') ? t : t.replace('.hero {\n', '.hero {\n  background: radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--accent) 28%, transparent), transparent 70%);\n  border-radius: 24px;\n')) }),
  };
  function planFor(prompt) {
    const p = prompt.toLowerCase();
    const steps = [];
    const color = Object.keys(COLORS).find(c => new RegExp(`\\b${c}\\b`).test(p));
    if (color) steps.push(STEP.accent(color));
    if (/\blight\b|white background|bright/.test(p)) steps.push(STEP.light());
    const quoted = prompt.match(/["“]([^"”]{2,60})["”]/);
    if (quoted || /\b(title|heading|headline)\b/.test(p)) steps.push(STEP.heading(quoted ? quoted[1] : 'Built with Breeze'));
    if (/footer|credit|copyright|contact|hours/.test(p)) steps.push(STEP.footer());
    if (/button|cta|click/.test(p)) steps.push(STEP.button());
    if (/glow|gradient|warm|hero|fancy|pretty|nicer|better|cool|beautiful|polish/.test(p)) steps.push(STEP.glow());
    if (!steps.length) steps.push(STEP.glow(), STEP.footer());
    return steps.slice(0, 3);
  }
  // Lines in `after` that weren't there before (one contiguous change).
  function changedLines(before, after) {
    const a = before.split('\n'), b = after.split('\n');
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const set = new Set();
    for (let i = s; i < b.length - e; i++) set.add(i);
    return [set, Math.max(0, a.length - s - e)];
  }
  function write(path, fn) {
    const f = files.get(path);
    if (!f) return null;
    saveView();
    const before = f.text;
    const after = fn(before);
    if (after === before) return { add: 0, del: 0 };
    f.text = f.saved = after;
    const [lines, del] = changedLines(before, after);
    added.set(path, lines);
    if (!tabs.includes(path)) tabs.push(path);
    if (document.activeElement !== ta) {
      active = path;
      const first = Math.min(...lines);
      views.set(path, { sel: [0, 0], top: Math.max(0, 10 + first * 21 - 80), left: 0 });
    }
    renderTabs();
    renderEditor();
    renderSide();
    renderBadge();
    if (layout.preview) refreshPreview();
    return { add: lines.size, del };
  }
  async function build(steps) {
    setAgent('builder', 'working', 'Building the plan');
    await sleep(500);
    for (const [i, st] of steps.entries()) {
      setAgent('builder', 'working', st.say);
      tool('', 'pencil', `Editing ${esc(st.file)}…`);
      await sleep(700);
      const edits = [[st.file, st.edit], ...(st.also ? [[st.also, st.alsoEdit]] : [])];
      for (const [file, fn] of edits) {
        const r = write(file, fn);
        if (!r) tool('', 'eye', `${esc(file)} is missing, skipped`);
        else if (!r.add && !r.del) tool('', 'check', `${esc(file)} already does this`);
        else tool('edit', 'pencil', `Edited ${esc(file)} <b>+${r.add}</b>${r.del ? ` −${r.del}` : ''}`);
        await sleep(350);
      }
      if (i < steps.length - 1) await sleep(300);
    }
    await typing(700);
    const msg = say('builder', `Done. ${steps.length === 1 ? 'The change is' : `All ${steps.length} changes are`} in, highlighted in green. Have a look:<div class="bz-row" style="display:flex;gap:6px;margin-top:8px"><button class="bz-btn bz-btn-primary" data-act="run.start">${icon('play', 12)} Open preview</button><button class="bz-btn" data-act="view.git">Save a checkpoint</button></div>`);
    setAgent('builder', 'done', `${steps.length} change${steps.length === 1 ? '' : 's'} made`);
    if (roster.planner) setAgent('planner', 'done', 'Plan approved and built');
    busy = false;
    return msg;
  }
  async function send() {
    const text = promptEl.value.trim();
    if (!text || busy) return;
    busy = true;
    promptEl.value = '';
    const mode = $('#bzMode').value;
    for (const k of Object.keys(roster)) delete roster[k];
    addChat(`<div class="bz-msg user"><span class="bz-meta"><b>You</b>${clock()}</span><div class="bz-body">${esc(text)}</div></div>`);
    await sleep(300);
    if (mode === 'ask') {
      setAgent('assistant', 'working', 'Reading the project');
      tool('', 'eye', 'Read index.html');
      await sleep(400);
      tool('', 'eye', 'Read styles.css');
      await sleep(300);
      tool('', 'eye', 'Read site.js');
      await typing(900);
      say('assistant', `This is a small static site. <code>index.html</code> holds the page, <code>styles.css</code> sets the colors through <code>--accent</code>, <code>--bg</code> and <code>--text</code>, and <code>site.js</code> counts clicks on the Wave button. Switch to <b>Plan, then build</b> and I'll make changes for you.`);
      setAgent('assistant', 'done', 'Answered');
      busy = false;
      return;
    }
    const steps = planFor(text);
    if (mode === 'build') {
      addChat('<div class="bz-handoff">The <b>Builder</b> works straight from your message</div>');
      await build(steps);
      return;
    }
    addChat('<div class="bz-handoff"><span>2 agents on this: <b>Planner</b> writes a plan, then <b>Builder</b> builds it once you approve</span></div>');
    setAgent('planner', 'working', 'Reading the project');
    await sleep(500);
    tool('', 'eye', 'Read index.html');
    await sleep(450);
    tool('', 'eye', 'Read styles.css');
    await typing(900);
    say('planner', 'I looked at the page and its styles. Here is what I would change.');
    await sleep(250);
    const card = addChat(`<div class="bz-plan"><h5>${icon('todo', 15)} Plan</h5><ol>${steps.map(s => `<li>${esc(s.say)}</li>`).join('')}</ol><div class="bz-row"><button class="bz-btn bz-btn-primary" data-plan="go">Approve &amp; build</button><button class="bz-btn" data-plan="change">Change something</button></div></div>`);
    setAgent('planner', 'waiting', 'Waiting for plan approval');
    card.addEventListener('click', async e => {
      const b = e.target.closest('[data-plan]');
      if (!b) return;
      card.querySelector('.bz-row').outerHTML = `<div class="bz-resolved">${b.dataset.plan === 'go' ? '✓ Approved' : 'Sent back to the Planner'}</div>`;
      if (b.dataset.plan === 'go') {
        setAgent('planner', 'done', 'Plan approved');
        addChat('<div class="bz-handoff"><span>Plan approved. <b>Builder</b> takes over</span></div>');
        await build(steps);
      } else {
        setAgent('planner', 'idle', 'Waiting for your changes');
        say('planner', 'Sure. Tell me what to do differently and I will write a new plan.');
        busy = false;
        promptEl.focus({ preventScroll: true });
      }
    });
  }
  promptEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  /* ================= Commands ================= */
  let vibe = false, discord = false;
  const commands = {
    'view.files': () => showView('files'),
    'view.search': () => showView('search'),
    'view.git': () => { if (!(layout.side && layout.view === 'git')) showView('git'); },
    'view.toggleSide': () => { layout.side = !layout.side; applyLayout(); },
    'view.toggleAgents': () => { layout.agents = !layout.agents; applyLayout(); if (layout.agents) setTimeout(() => promptEl.focus({ preventScroll: true }), 230); },
    'view.reset': () => { Object.assign(layout, { side: true, agents: false, term: false, preview: false, view: 'files' }); applyLayout(); renderSide(); },
    'term.toggle': () => { layout.term = !layout.term; applyLayout(); if (layout.term) setTimeout(() => termIn.focus({ preventScroll: true }), 230); },
    'term.focus': () => { layout.term = true; applyLayout(); setTimeout(() => termIn.focus({ preventScroll: true }), 230); },
    'term.clear': () => { termOut.innerHTML = ''; },
    'term.kill': () => { if (layout.preview) stopPreview(); else termPrint('^C\n'); },
    'run.start': () => startPreview(),
    'run.reload': () => refreshPreview(),
    'run.stop': () => stopPreview(),
    'file.newFile': () => { layout.side = true; layout.view = 'files'; applyLayout(); const parent = dirs.has(selected) ? selected : dirName(selected ?? ''); if (parent) openDirs.add(parent); pending = { kind: 'file', parent }; renderTree(); },
    'file.newFolder': () => { layout.side = true; layout.view = 'files'; applyLayout(); const parent = dirs.has(selected) ? selected : dirName(selected ?? ''); if (parent) openDirs.add(parent); pending = { kind: 'dir', parent }; renderTree(); },
    'file.save': () => { if (!hasFile()) return; const f = files.get(active); f.saved = f.text; renderTabs(); renderSide(); renderBadge(); if (layout.preview) refreshPreview(); },
    'file.saveAll': () => { for (const f of files.values()) if ('text' in f) f.saved = f.text; renderTabs(); renderSide(); renderBadge(); },
    'explorer.refresh': () => { const b = $('[data-act="explorer.refresh"] svg'); b.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 500 }); renderTree(); },
    'explorer.collapse': () => { openDirs.clear(); renderTree(); },
    'edit.find': () => openFind(),
    'edit.comment': () => { if (hasFile()) toggleComment(); },
    'sel.line': () => { if (!hasFile()) return; const [s, e] = lineSpan(); focusEditor(); ta.setSelectionRange(s, Math.min(ta.value.length, e + 1)); onCaret(); },
    'sel.dup': () => { if (hasFile()) dupLine(); },
    'sel.up': () => { if (hasFile()) moveLine(-1); },
    'sel.down': () => { if (hasFile()) moveLine(1); },
    'find.next': () => runFind(true),
    'find.prev': () => runFind(true, true),
    'find.close': () => { closeFind(); focusEditor(); },
    'editor.focus': () => focusEditor(),
    'git.commit': () => commit(),
    'agent.send': () => send(),
    'chat.new': () => { if (busy) return; emptyChat(); },
    'agent.pick': () => openMenu(AGENTS.map(a => ({ label: a, checked: a === agentName, run: () => { agentName = a; $('#bzAgentPill').textContent = a.split(' · ')[0]; for (const [r, v] of Object.entries(roster)) setAgent(r, v.status, v.task); } })), $('#bzAgentPill'), 'right'),
    settings: () => openMenu([
      { label: 'Keyboard Shortcuts', run: () => modal(`<h4>Keyboard shortcuts</h4><div class="bz-keys">${SHORTCUTS.map(([a, k]) => `<span>${a}</span><kbd>${k}</kbd>`).join('')}</div>`) },
      { sep: true },
      { label: 'Breeze Code', checked: true },
      { label: 'Breeze Box', run: () => desktopOnly('Breeze Box, the chat-only mode,') },
      { sep: true },
      { label: 'Download Breeze Code', href: DOWNLOAD },
    ], $('.bz-act-btn.gear'), 'up'),
    account: () => openMenu([{ label: 'Not signed in', disabled: true }, { sep: true }, { label: 'Sign in with GitHub…', run: () => desktopOnly('Signing in') }, { label: 'Sign in with Google…', run: () => desktopOnly('Signing in') }], $('.bz-avatar'), 'right'),
    branch: () => toast(`${icon('gitBranch', 14)} On branch <b>master</b>`),
    vibe: () => {
      vibe = !vibe;
      const b = $('#bzVibe');
      b.classList.toggle('armed', vibe);
      b.innerHTML = `${icon(vibe ? 'circleDot' : 'circle', 14)}<span>Vibe Mode ${vibe ? 'on' : 'off'}</span>`;
      if (vibe) toast('Vibe Mode plays your feed while agents work. The feed itself runs in the desktop app.');
    },
    discord: () => { discord = !discord; $('#bzDiscord').textContent = `Discord: ${discord ? 'on' : 'off'}`; $('#bzDiscord').classList.toggle('armed', discord); },
    'win.min': () => { root.classList.add('minimized'); setTimeout(() => root.classList.remove('minimized'), 700); },
    'win.max': () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else root.requestFullscreen?.().catch(() => toast('Full screen is not available here.'));
    },
    'win.close': () => toast(`This window is a live demo. <a href="${DOWNLOAD}" target="_blank" rel="noopener">Download Breeze Code</a> to keep going.`, 4500),
  };
  function cmd(name) { closeMenu(); commands[name]?.(); }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && root.contains(b)) {
      // The terminal header toggles, but its own buttons do their own thing.
      if (b.classList.contains('bz-term-head') && e.target.closest('button')) return;
      cmd(b.dataset.act);
      return;
    }
    const v = e.target.closest('.bz-act-btn[data-view]');
    if (v) cmd(`view.${v.dataset.view}`);
  });

  /* ----- keyboard: only while focus is inside the window, and never leaking out to the page ----- */
  root.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let run = null;
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...menu.el.querySelectorAll('.bz-menu-item:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (menu) { const a = menu.anchor; closeMenu(); a?.focus({ preventScroll: true }); }
      else if (findOpen) { closeFind(); focusEditor(); }
      else if (document.fullscreenElement === root) document.exitFullscreen?.();
    } else if (e.key === 'F5') run = e.shiftKey ? 'run.stop' : 'run.start';
    else if (e.key === 'F2' && layout.view === 'files' && selected && document.activeElement?.closest('.bz-sidebar')) { pending = { kind: 'rename', path: selected }; renderTree(); e.preventDefault(); }
    else if (e.key === 'Delete' && document.activeElement?.closest('.bz-tree-item[data-path]')) { deleteEntry(selected); e.preventDefault(); }
    else if (mod && e.shiftKey && k === 'e') run = 'view.files';
    else if (mod && e.shiftKey && k === 'f') run = 'view.search';
    else if (mod && e.shiftKey && k === 'g') run = 'view.git';
    else if (mod && e.altKey && k === 'b') run = 'view.toggleAgents';
    else if (mod && !e.shiftKey && k === 'b') run = 'view.toggleSide';
    else if (mod && (k === '`' || e.code === 'Backquote')) run = 'term.toggle';
    else if (mod && k === 's') run = e.altKey ? 'file.saveAll' : 'file.save';
    else if (mod && k === 'f' && hasFile()) run = 'edit.find';
    else if (mod && k === '/' && document.activeElement === ta) run = 'edit.comment';
    else if (mod && k === 'l' && document.activeElement === ta) run = 'sel.line';
    if (run) { e.preventDefault(); cmd(run); }
    e.stopPropagation(); // the page's own scroll-snap keys stay out of the editor
  });
  // Wheel and touch scrolling inside a panel stays in the panel instead of snapping the page.
  const scrollsInside = (el, dy) => {
    for (; el && el !== root; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
      }
    }
    return false;
  };
  root.addEventListener('wheel', e => { if (scrollsInside(e.target, e.deltaY)) e.stopPropagation(); }, { passive: true });
  let touchY = null;
  root.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; e.stopPropagation(); }, { passive: true });
  root.addEventListener('touchmove', e => { if (touchY != null && scrollsInside(e.target, touchY - e.touches[0].clientY)) e.stopPropagation(); }, { passive: true });

  /* ================= First paint: the same view as the old screenshot ================= */
  openDirs.clear();
  applyLayout();
  renderTabs();
  renderEditor();
  renderSide();
  renderBadge();
  onCaret();
  document.fonts?.ready.then(() => { measured = false; paint(); });
})();
