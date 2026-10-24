// Agent teams: several agents build parts of one task at the same time without editing each other's files.
// The pure parts live here (claims, ownership, prompts, snapshots) with no Electron, so test/team.test.js can cover them.
// Paths are relative to the project, use "/", and folders end in "/".

const path = require('node:path');
const { blockedRel } = require('./guard');

/* ----- Claims and ownership ----- */
// `p` as a clean project-relative path, or null when it is empty, outside `root`, or off limits to agents.
function cleanRel(p, root) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim();
  const folder = /[\\/]$/.test(s); // path.relative would drop the trailing slash
  if (path.isAbsolute(s)) {
    if (!root) return null;
    s = path.relative(root, s);
    if (path.isAbsolute(s)) return null; // another drive
  }
  s =path.posix.normalize(s.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!s || s === '.' || s === '..' || s.startsWith('../')) return null;
  if (blockedRel(s)) return null;
  return folder ? `${s}/` : s;
}

// The paths in the last ```json block of an agent's reply. Anything malformed gives [].
function parseClaim(text) {
  const blocks = [...String(text ?? '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!blocks.length) return [];
  let data;
  try { data = JSON.parse(blocks.at(-1)[1]); } catch { return []; }
  if (!data || !Array.isArray(data.paths)) return [];
  return [...new Set(data.paths.map(p => cleanRel(p)).filter(Boolean))];
}

// `owned` is a path or a folder (ending in "/"); true when it is `rel` or holds it.
const covers = (owned, rel) => owned === rel || (owned.endsWith('/') && rel.startsWith(owned));

// Paths claimed by more than one agent, or inside another agent's folder. `path` is the more specific one.
function findClashes(claims) {
  const ids = Object.keys(claims);
  const found = new Map(); // path -> agent ids
  const add = (p, ...agents) => {
    if (!found.has(p)) found.set(p, new Set());
    agents.forEach(a => found.get(p).add(a));
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const a of claims[ids[i]]) {
        for (const b of claims[ids[j]]) {
          if (a === b || covers(b, a)) add(a, ids[i], ids[j]);
          else if (covers(a, b)) add(b, ids[i], ids[j]);
        }
      }
    }
  }
  return [...found].map(([p, agents]) => ({ path: p, agents: ids.filter(id => agents.has(id)) }));
}

// Who owns `rel`: the exact match, else the longest folder holding it.
function ownerOf(owners, rel) {
  if (Object.hasOwn(owners, rel)) return owners[rel];
  let best = null;
  for (const p of Object.keys(owners)) {
    if (p.endsWith('/') && rel.startsWith(p) && (best === null || p.length > best.length)) best = p;
  }
  return best === null ? null : owners[best];
}

// Files no one owns go to whoever edits them first. Returns the owner after the call.
function claimFirstTouch(owners, rel, agentId) {
  const owner = ownerOf(owners, rel);
  if (owner) return owner;
  owners[rel] = agentId;
  return agentId;
}

// Claude Code permission rules that stop `agentId` editing what a teammate owns.
function claudeDenyArgs(owners, agentId) {
  const args = [];
  for (const [p, owner] of Object.entries(owners)) {
    if (owner === agentId) continue;
    const pattern = p.endsWith('/') ? `${p}**` : p;
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) args.push(`${tool}(${pattern})`);
  }
  return args;
}

// What an agent asked of teammates: the text after a "For <name>:" line, up to the next one.
function notesFor(text, names) {
  const out = {};
  const head = new RegExp(`^\\s*For (${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):[ \\t]*(.*)$`, 'i');
  let current = null;
  const parts = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = names.length ? head.exec(line) : null;
    if (m) {
      current = names.find(n => n.toLowerCase() === m[1].toLowerCase());
      (parts[current] ??= []).push(m[2]);
    } else if (current) {
      parts[current].push(line);
    }
  }
  for (const [name, lines] of Object.entries(parts)) {
    const note = lines.join('\n').trim();
    if (note) out[name] = note;
  }
  return out;
}

module.exports = { cleanRel, parseClaim, covers, findClashes, ownerOf, claimFirstTouch, claudeDenyArgs, notesFor };
