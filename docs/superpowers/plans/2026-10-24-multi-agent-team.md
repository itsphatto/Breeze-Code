# Multi-agent teams (@mentions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One prompt can hand parts of a task to several installed agents (`@Claude …` `@Codex …`), which build in
parallel in the open project without editing each other's files.

**Architecture:** Two Electron-free main-process modules hold all the logic and are unit-tested:
`src/main/mentions.js` (prompt → tasks) and `src/main/team.js` (claims, ownership, snapshots, and a
`TeamCoordinator` that drives a team through injected `startRun`/`stopRun`/`emit`). `main.js` wires them to IPC and
sees every agent event through one observer on `emit`. The renderer adds the agent bar, the `@` menu, the split
card and the per-agent labels, and routes events for several runs in one tab.

**Tech Stack:** Electron 44, Node `node:test`, plain CommonJS in `src/main`, TypeScript (`tsc`, strict) for
`src/renderer/breezescript.ts`, plain HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-10-24-multi-agent-team-design.md`

## Global Constraints

- IDE surface only. Breeze Box keeps one agent per run, and `sendPrompt` on the `box` surface never parses mentions.
- A prompt with no mention runs exactly as today. A prompt with one mention is a normal single run with that agent (no claim step).
- Agent ids are `claude`, `codex`, `antigravity`, `local`. Short names: `Claude`, `Codex`, `Antigravity`, `Local`.
- Paths in claims, ownership, events and IPC are relative to the project root, use `/`, and folders end in `/`.
- `.git/` and `.env*` paths are never claimable (reuse `blockedRel` from `src/main/guard.js`).
- Claim timeout is 60 s per agent. The crossing re-check is 300 ms after the first restore. Snapshots skip files over 2 MB. Team snapshots are dropped after 30 min, or when the tab starts another run.
- New IPC goes through `handle()` in `main.js` (the own-window guard) and is exposed in `preload.js` as `api.team.*`.
- User-facing copy (exact):
  - Crossing (restored): `<Name> tried to edit <path> (<Owner>'s). Breeze put it back.`
  - Crossing (blocked): `<Name> tried to edit <path> (<Owner>'s) and was stopped.`
  - Restore failed: `Breeze couldn't put it back: <reason>`
  - Failed claim: `Couldn't list its files. It will own files it touches first.`
  - Unknown mention toast: `<Name> isn't installed. Install it from Settings → Agents`
  - Local LLM refusal: `That file belongs to <Owner> on this team. Leave it and mention what you need in your final message.`
- Renderer naming: the renderer already has a `team`/`joinTeam`/`teamNeed` concept (the Planner/Builder phases). New renderer state and functions use `agentTeam` (`tab.agentTeam`, `startAgentTeam`, …) to avoid colliding with it.
- Spec adjustments made while planning (tell the reviewer):
  - The pill's existing menu switches agents. It doesn't hold model/effort settings; those live in the composer model select. So the chip's chevron opens "Make default" + "Manage agents".
  - A `<textarea>` can't underline a range of text. An unknown mention is shown in a one-line warning under the prompt instead of a red underline.

## Review Focus

1. **A crossing whose write lands after Breeze's first restore** (Codex reports `file_change` before the write finishes): the 300 ms re-check must restore again. Task 5 has `restores again after 300 ms`.
2. **A path under a folder a teammate owns** (`web/components/Button.tsx` when Claude owns `web/`): this must count as Claude's, and a sibling `webapp/` must not. Task 2 has `ownerOf: folder covers children, not prefix siblings`.
3. **Claim-pass events leaking into the chat**, or filling the renderer's 200-event `earlyEvents` buffer: the coordinator must hide claim-run events. Task 5 has `observe hides claim-phase events`.
4. **A member that fails or is stopped mid-build** must still count toward "all done", or `team-done` never fires and the tab stays busy forever. Task 5 has `team-done fires when a member fails`.
5. **An absolute or `\` path from an agent's file event** (Codex on Windows): the coordinator must normalise it before the ownership lookup. Task 5 has `normalises absolute and backslash paths`.

---

## File map

| File | Responsibility |
|---|---|
| `src/main/mentions.js` (new) | `parseMentions`, `shortName`, `mentionNames` |
| `src/main/team.js` (new) | claim parsing, ownership, prompts, Claude deny args, snapshots, `TeamCoordinator` |
| `test/mentions.test.js`, `test/team.test.js` (new) | unit tests |
| `src/main/main.js` | `emit` observer, `launchRun`/`stopRun` helpers, `team:*` IPC, Claude deny args, local-LLM ownership check, stop teams on folder change |
| `src/main/preload.js` | `api.team.*` |
| `src/renderer/breezescript.ts` | types, per-agent sessions, agent bar, `@` menu, team flow, labels, cards |
| `src/renderer/breeze.html`, `breeze.css` | `#agentBar`, mention menu, status strip, split/crossing/summary cards |

---

### Task 1: Mention parsing (`src/main/mentions.js`)

**Files:**
- Create: `src/main/mentions.js`
- Test: `test/mentions.test.js`

**Interfaces:**
- Produces:
  - `shortName({ id, name }) -> string` returns `Claude` / `Codex` / `Antigravity` / `Local` for the known ids, and `name` otherwise.
  - `mentionNames(agent) -> string[]` returns the lowercase names a mention may use: the short name, the full name, and the id (de-duplicated).
  - `parseMentions(text, agents) -> { shared: string, tasks: { agentId: string, text: string }[], unknown: string[] }`. `agents` is `{ id, name, found }[]` (the `sys:detect` shape). `unknown` holds the mention words that matched an agent that is not found, or no agent at all.

- [ ] **Step 1: Write the failing tests** in `test/mentions.test.js`, using this fixture:
```js
const agents = [
  { id: 'claude', name: 'Claude Code', found: true },
  { id: 'codex', name: 'Codex', found: true },
  { id: 'antigravity', name: 'Antigravity', found: false },
  { id: 'local', name: 'Ollama', found: true },
];
```
Tests and their assertions:
- `no mention gives no tasks`: `parseMentions('make a todo app', agents)` deep-equals `{ shared: 'make a todo app', tasks: [], unknown: [] }`.
- `splits tasks at each mention`: `'@Claude make a front end for it\n@Codex make backend'` gives `tasks` `[{agentId:'claude',text:'make a front end for it'},{agentId:'codex',text:'make backend'}]` and `shared` `''`.
- `text before the first mention is shared`: `'A todo app.\n@claude ui\n@codex api'` gives `shared` `'A todo app.'`.
- `matches case-insensitively and by full name`: `'@claude code do x @CODEX do y'` gives agent ids `['claude','codex']`, and the first task's text is `'do x'` (the longest name wins, so `code` is not left in the text).
- `matches @local and @ollama to the local agent`.
- `joins duplicate mentions`: `'@Claude a @Codex b @Claude c'` gives 2 tasks; Claude's text is `'a\n\nc'`; the order is Claude then Codex.
- `email addresses are not mentions`: `'mail me@codex.dev @Codex go'` gives one Codex task `'go'` and `shared` `'mail me@codex.dev'`.
- `unknown and not-installed mentions are reported`: `'@Antigravity x @Gemini y'` gives `unknown` `['Antigravity','Gemini']` and `tasks` `[]`.
- `shortName and mentionNames`: `shortName({id:'claude',name:'Claude Code'}) === 'Claude'`; `mentionNames({id:'local',name:'Ollama'})` deep-equals `['local','ollama']`.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `node --test test/mentions.test.js`
Expected: FAIL with `Cannot find module '../src/main/mentions'`

- [ ] **Step 3: Implement `src/main/mentions.js`**

A mention is `@` at the start of the text or after whitespace, followed by the longest known name (try multi-word names first, so `@Claude Code` beats `@Claude`), ending at whitespace, punctuation or the end of the text. An unmatched word after `@` (`/@([\w-]+)/`) counts as unknown. Trim each task's text. CommonJS `module.exports = { parseMentions, shortName, mentionNames }`, with a header comment in the style of `agentbrain.js`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test test/mentions.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**
```bash
git add src/main/mentions.js test/mentions.test.js
git commit -m "feat: parse @agent mentions into per-agent tasks"
```

---

### Task 2: Claims and ownership (`src/main/team.js`, pure part)

**Files:**
- Create: `src/main/team.js`
- Test: `test/team.test.js`

**Interfaces:**
- Consumes: `blockedRel(rel)` from `./guard`.
- Produces:
  - `cleanRel(p, root?) -> string | null`: makes `p` relative to `root` when it is absolute, uses `/`, drops a leading `./`, and returns `null` for anything outside the root, empty, or blocked by `blockedRel`. A trailing `/` is kept.
  - `parseClaim(text) -> string[]`: the last fenced ```` ```json ```` block's `paths`, run through `cleanRel` and de-duplicated. Anything malformed gives `[]`.
  - `covers(owned, rel) -> boolean`: equal, or `owned` ends in `/` and `rel` starts with it.
  - `findClashes(claims: Record<agentId, string[]>) -> { path: string, agents: string[] }[]`: one entry per path claimed by more than one agent, or covered by another agent's folder. `agents` is in claim order and `path` is the more specific path.
  - `ownerOf(owners: Record<string, agentId>, rel) -> agentId | null`: the exact match, else the longest covering folder.
  - `claimFirstTouch(owners, rel, agentId) -> agentId`: returns the existing owner, or records `agentId` and returns it.
  - `claudeDenyArgs(owners, agentId) -> string[]`: for every path owned by another agent, `Edit(p)`, `Write(p)`, `MultiEdit(p)` and `NotebookEdit(p)`, where a folder `p/` becomes `p/**`.
  - `notesFor(text, names: string[]) -> Record<name, string>`: the text after a line `For <name>:` up to the next `For <other>:` line or the end, trimmed.

- [ ] **Step 1: Write the failing tests** in `test/team.test.js`:
- `parseClaim reads the last json block`: given text with two fenced json blocks, the second `{"paths":["web/","web\\App.tsx","./README.md"]}`, it returns `['web/','web/App.tsx','README.md']`.
- `parseClaim drops blocked and outside paths`: `{"paths":["../x","/etc/passwd",".git/config",".env","src/a.js"]}` gives `['src/a.js']`.
- `parseClaim tolerates junk`: `'no block'`, a ```` ```json {oops ```` block, and `{"paths":"x"}` each give `[]`.
- `ownerOf: folder covers children, not prefix siblings`: with owners `{'web/':'claude','server/api.js':'codex'}`, `ownerOf(o,'web/components/Button.tsx')==='claude'`, `ownerOf(o,'webapp/x.js')===null`, and `ownerOf(o,'server/api.js')==='codex'`.
- `ownerOf picks the longest folder`: `{'web/':'claude','web/api/':'codex'}` gives `ownerOf(o,'web/api/x.ts')==='codex'`.
- `findClashes`: `{claude:['web/','package.json'],codex:['server/','package.json','web/api.ts']}` deep-equals `[{path:'package.json',agents:['claude','codex']},{path:'web/api.ts',agents:['claude','codex']}]`, in any order (sort by path before comparing).
- `claimFirstTouch`: on empty owners, `claimFirstTouch(o,'a.js','codex')==='codex'`, then `claimFirstTouch(o,'a.js','claude')==='codex'`.
- `claudeDenyArgs`: `{'web/':'claude','server/':'codex','x.js':'codex'}` for `'claude'` includes `'Edit(server/**)'`, `'Write(x.js)'` and `'NotebookEdit(server/**)'`, and nothing containing `web`.
- `notesFor`: `'Done.\nFor Codex: add /api/todos\nFor Claude:\nuse port 3001'` deep-equals `{Codex:'add /api/todos',Claude:'use port 3001'}`, and `notesFor('Done.',['Codex'])` deep-equals `{}`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/team.test.js`
Expected: FAIL with `Cannot find module '../src/main/team'`

- [ ] **Step 3: Implement these functions in `src/main/team.js`** (no Electron imports; `require('node:path')` and `require('./guard')` only).

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test test/team.test.js`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/main/team.js test/team.test.js
git commit -m "feat: team claims, ownership lookup and Claude deny rules"
```

---

### Task 3: Team prompts

**Files:**
- Modify: `src/main/team.js`
- Test: `test/team.test.js`

**Interfaces:**
- Consumes: `shortName` from Task 1.
- Produces:
  - `claimPrompt(member, team) -> string`, where `member = { agentId, name, task }` and `team = { shared, members }`.
  - `buildBrief(member, team, owners) -> string`.

- [ ] **Step 1: Write the failing tests**
- `claimPrompt asks for a json block and no edits`: the result contains the member's task, the shared text, each teammate's name and task, the literal ```` ```json ```` and `{"paths": [`, and `Do not change any files`.
- `buildBrief lists own and teammates' paths`: with owners `{'web/':'claude','server/':'codex'}`, Claude's brief contains `You own: web/`, `Do not edit: server/ (Codex)` and the line `For Codex:`. With no owned paths it says `You own: any file no teammate owns`.

- [ ] **Step 2: Run them to make sure they fail** — `node --test test/team.test.js`, expected FAIL with `claimPrompt is not a function`.

- [ ] **Step 3: Implement both functions.** The exact copy for `claimPrompt`:
```
You are on a team of coding agents working in this project at the same time.
Shared context: <shared or "none">
Your task: <task>
Teammates: <Name>: <task>; …
Before anyone starts, list the files and folders you expect to create or edit for YOUR task only.
Folders end with "/". Do not change any files now. Reply with only this block:
```json
{"paths": ["path/one", "folder/"]}
```
```
And for `buildBrief`:
```
You are on a team of coding agents working in this project at the same time.
Shared context: <shared or "none">
Your task: <task>
Teammates: <Name>: <task>; …
You own: <comma list, or "any file no teammate owns">
Do not edit: <path> (<Owner>), … (omit the line when empty)
Files no one owns belong to whoever edits them first.
If you need a change in a teammate's files, don't make it. At the end of your final message add a line "For <Name>:" followed by what you need.
```

- [ ] **Step 4: Run them to make sure they pass** — `node --test test/team.test.js`, expected PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat: claim and build prompts for agent teams"`

---

### Task 4: Snapshots

**Files:**
- Modify: `src/main/team.js`
- Test: `test/team.test.js`

**Interfaces:**
- Produces (all async, using `node:fs/promises`; `root` is absolute):
  - `snapshot(root, paths: string[]) -> Promise<{ files: Map<rel, Buffer | null>, skipped: string[] }>`. A folder path expands recursively to its files (skipping `.git` and `node_modules`). A missing path is stored as `null`. A file over `2 * 1024 * 1024` bytes goes to `skipped`.
  - `addToSnapshot(snap, root, rel) -> Promise<void>`: records `rel` the first time it is seen (used for first-touch files).
  - `restore(root, rel, snap) -> Promise<void>`: writes the Buffer back (creating parent folders), or `fs.rm`s the file when its entry is `null`. A missing entry is a no-op.
  - `changedSince(root, snap) -> Promise<string[]>`: the entries whose current content differs (or whose existence differs) from the snapshot.

- [ ] **Step 1: Write the failing tests** against `fs.mkdtempSync(path.join(os.tmpdir(),'breeze-team-'))`:
- `snapshot expands folders and records absent files`: create `web/a.js` (`'a'`) and `web/sub/b.js`. `snapshot(root,['web/','new.js'])` has keys `web/a.js`, `web/sub/b.js` and `new.js`, and `new.js` maps to `null`.
- `restore undoes a modify, a create and a delete`: after the snapshot, change `web/a.js`, create `new.js`, and delete `web/sub/b.js`. `changedSince` (sorted) deep-equals `['new.js','web/a.js','web/sub/b.js']`. After `restore` on each one, `changedSince` deep-equals `[]` and `new.js` doesn't exist.
- `snapshot skips large files`: a 2 MB + 1 byte file is in `skipped` and not in `files`.

- [ ] **Step 2: Run them to make sure they fail** — expected FAIL with `snapshot is not a function`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to make sure they pass** — `node --test test/team.test.js`, expected PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: snapshot and restore files for agent teams"`

---

### Task 5: `TeamCoordinator`

**Files:**
- Modify: `src/main/team.js`
- Test: `test/team.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces `class TeamCoordinator` with:
  - `constructor({ id, root, shared, members: { agentId, name, task, session }[], deps })`, where `deps = { startRun(opts) -> number, stopRun(runId), emit(runId, ev), setTimeout, clearTimeout }`. The `opts` passed to `startRun` are `{ agent, mode, prompt, session, team: { coordinator: this, agentId } }`.
  - `claim({ timeoutMs = 60000 }) -> Promise<{ claims: Record<agentId,string[]>, clashes, failed: agentId[], sessions: Record<agentId,string> }>`.
  - `start(owners: Record<rel, agentId>) -> Promise<Record<agentId, runId>>`: merges `owners` with the claims (`owners` decides clashes), snapshots all owned paths, then starts one `build` run per member with `buildBrief`.
  - `observe(runId, ev) -> boolean`: called by `main.js` for every emitted event. It returns `true` when the event must not reach the renderer (any event from a claim-phase run).
  - `owners: Record<rel, agentId>` (public; `main.js` reads it for `claudeDenyArgs`).
  - `foreignOwner(agentId, rel) -> Promise<agentId | null>`: does a first-touch claim, awaits `addToSnapshot`, then returns the owner when it is not `agentId`.
  - `undo(rel) -> Promise<void>` and `stop()`.
  - `hasRun(runId) -> boolean`.
- Events emitted through `deps.emit` on member run ids:
  - `{ t: 'crossing', path, agent, owner, blocked?: boolean, error?: string }`
  - `{ t: 'team-done', teamId, changed: string[], notes: Record<agentId, Record<name,string>>, skipped: string[] }`

Behaviour:
- In the claim phase, `text` events set that run's last text. `session` events record `sessions[agentId]`. `done` resolves that member's claim (`ok` → `parseClaim(lastText)`; otherwise the member goes in `failed`). The timeout calls `deps.stopRun` and marks the member failed.
- In the build phase, a `file` event normalises `ev.path` with `cleanRel(path, root)`, records it as reported for that agent, and calls `foreignOwner`. When the agent is the owner, the snapshot entry for that path is re-read from disk, so a later crossing restores the owner's latest version rather than the version from the start. When there's a foreign owner it restores now, schedules a second restore at 300 ms, and emits `crossing` (with `error` when `restore` throws).
- Every member's `done` (ok or not) counts. When all members are done, `team-done` goes to each member's run id. `changed` is `changedSince` minus paths that their owner reported and minus crossed paths. `notes` come from `notesFor(lastText, otherNames)`.

- [ ] **Step 1: Write the failing tests** using a fake `deps` (`startRun` returns increasing ids and records opts; `emit` pushes to an array; a manual timer whose `setTimeout` stores callbacks that the test fires) and a temp `root`:
- `observe hides claim-phase events`: after `claim()` starts, `observe(1,{t:'text',text:'x'})===true`. Once in the build phase, `observe(buildRunId,{t:'text'})===false`.
- `claim collects paths, sessions and failures`: member 1 sends `session` `s1`, `text` with a json block `{"paths":["web/"]}` and `done ok`; member 2 sends `done ok:false`. The result deep-equals `{claims:{claude:['web/'],codex:[]},clashes:[],failed:['codex'],sessions:{claude:'s1'}}`.
- `claim times out`: with `timeoutMs:10`, firing the timer calls `stopRun` with that run id, and the member is in `failed`.
- `start uses the brief and resumes the claim session`: the recorded opts for Claude have `mode:'build'`, `session:'s1'`, `team.agentId:'claude'`, and a prompt containing `You own: web/`.
- `restores a crossing and emits it`: Claude owns `web/a.js` (content `'orig'`). Codex's run writes `'hacked'` to it and then sends `{t:'file',path:'web/a.js'}`. The file is `'orig'` again, and `emit` got `{t:'crossing',path:'web/a.js',agent:'codex',owner:'claude'}`.
- `restores again after 300 ms`: after the crossing, write `'late'` to the file, fire the 300 ms timer, and the file is `'orig'`.
- `normalises absolute and backslash paths`: the `file` event with `path.join(root,'web','a.js')` is treated like `web/a.js`.
- `team-done fires when a member fails`: one `done ok:true` and one `done ok:false` give one `team-done` per member run id.
- `team-done lists untraced changes and notes`: Codex owns `server/x.js` but never reports it, and the file is changed on disk. Claude's last text has `For Codex: add a route`. `team-done.changed` deep-equals `['server/x.js']` and `notes.claude` deep-equals `{Codex:'add a route'}`.
- `first-touch file is claimed and snapshotted`: Codex reports the unowned `new.js`, then Claude reports `new.js`, and that is a crossing owned by `codex`.
- `owner edits refresh the snapshot`: Claude writes `'v2'` to its own `web/a.js` and reports it, then Codex writes `'hacked'` and reports it. After the restore, the file is `'v2'`.
- `undo after stop rejects`: after `stop()`, `undo('web/a.js')` rejects with `That team has finished.`

- [ ] **Step 2: Run them to make sure they fail** — expected FAIL with `TeamCoordinator is not a constructor`.
- [ ] **Step 3: Implement `TeamCoordinator`.** Keep the phase per run in `Map<runId, { agentId, phase: 'claim'|'build', lastText }>`, and have `hasRun` check that map.
- [ ] **Step 4: Run the whole suite** — `npm test`, expected all PASS (including the existing tests).
- [ ] **Step 5: Commit** — `git commit -am "feat: TeamCoordinator runs claim and build phases with enforcement"`

---

### Task 6: Main-process wiring

**Files:**
- Modify: `src/main/main.js` (`emit` ~1171, `agent:run`/`agent:stop` ~1180-1196, `cliArgs`/`claudeArgs` ~1285-1316, `startRun` ~1381, `agentPath` ~1514, `fs:closeFolder` ~484 and folder open ~291)
- Modify: `src/main/preload.js:73`

**Interfaces:**
- Consumes: `TeamCoordinator`, `claudeDenyArgs` (Task 5/2), and `parseMentions`, `shortName` (Task 1).
- Produces IPC (renderer-facing, used by Task 9):
  - `team:parse(text) -> { shared, tasks, unknown }`
  - `team:claim({ shared, members: { agentId, task, session }[] }) -> { teamId, claims, clashes, failed, sessions }`
  - `team:start({ teamId, owners }) -> Record<agentId, runId>`
  - `team:stop(teamId)` stops the members and deletes the team from `teams`. It is a no-op for an unknown id.
  - `team:undo({ teamId, path })` rejects with `That team has finished.` for an unknown id.
  - preload: `api.team = { parse, claim, start, stop, undo }`

- [ ] **Step 1: Route every event through teams.** Make `emit` check `for (const t of teams.values()) if (t.hasRun(runId) && t.observe(runId, ev)) return;` before `win.webContents.send`. The coordinator's own `deps.emit` must send directly, without going through `observe` again: use a `sendEvent(runId, ev)` that `emit` calls.
- [ ] **Step 2: Extract helpers.** Add `launchRun(opts) -> runId` (the body of `agent:run`) and `stopRun(runId)` (the body of `agent:stop`), and use them in both handlers.
- [ ] **Step 3: Pass team options through.** `startRun` keeps `opts.team` on `run.team`. `cliArgs(agent, mode, prompt, session, team)` passes it to `claudeArgs`, which adds `...claudeDenyArgs(team.coordinator.owners, team.agentId)` after `--disallowedTools` in build mode. That needs a `--disallowedTools` flag in build mode too, only when the deny list isn't empty. `runLocal` puts `team: run.team` on `ctx`.
- [ ] **Step 4: Check ownership for local writes.** Add `async function checkTeamWrite(ctx, rel)`. When `ctx.team` is set and `await ctx.team.coordinator.foreignOwner(ctx.team.agentId, rel)` returns an owner, it emits `{t:'crossing', path, agent, owner, blocked:true}` and throws with the Local LLM refusal copy from Global Constraints. `edit_file` and `write_file` in `LLM_TOOL_FNS` await it right after their `agentPath` call. `agentPath` itself stays synchronous and unchanged.
- [ ] **Step 5: Add the IPC handlers.** `const teams = new Map()`, with ids from `crypto.randomUUID()`. `team:claim` builds members with `name: shortName(detected agent)` from `agentBins`/detect state. It refuses with `Open a folder first` without `root`, and with `That agent was not found on this computer.` for a missing agent. A `setTimeout` deletes the team after 30 min. Folder change (the `root = dir` path ~291 and `fs:closeFolder` ~484) calls `stop()` on every team and clears `teams`.
- [ ] **Step 6: Expose the IPC in preload.js** as `team: { parse: t => invoke('team:parse', t), claim: o => invoke('team:claim', o), start: o => invoke('team:start', o), stop: id => invoke('team:stop', id), undo: o => invoke('team:undo', o) }`.
- [ ] **Step 7: Verify**

Run: `npm test`
Expected: the `node --check` of main.js and preload.js passes, and every test passes.

- [ ] **Step 8: Commit** — `git commit -am "feat: wire agent teams into the main process"`

---

### Task 7: Renderer types and per-agent sessions

**Files:**
- Modify: `src/renderer/breezescript.ts` (`AgentEvent` :24, `BreezeApi` :52, `demoApi` :542, `AgentTabState` :8687, tab creation :8744, chat archive/restore :9227 and :9268-9297, `startAgentRun` :9711, the `session` handler :9790)

**Interfaces:**
- Produces:
  - `AgentEvent.t` gains `'crossing' | 'team-done'`, plus the fields `agent?`, `owner?`, `blocked?`, `error?`, `teamId?`, `changed?: string[]`, `notes?: Record<string, Record<string,string>>` and `skipped?: string[]`.
  - `BreezeApi.team` matches the Task 6 IPC, and `demoApi` gets stubs: `parse` returns `{ shared: text, tasks: [], unknown: [] }`, and the others reject with `Teams need the desktop app`.
  - `AgentTabState.sessions: Record<string, string>` replaces `session` and `sessionAgent`. `ChatEntry` gains `sessions?`; an old entry's `{ session, agent }` turns into `{ [agent]: session }` when it is restored.
  - `AgentTabState.lastTeamId?: string`
  - `AgentTabState.agentTeam?: AgentTeamState` (the type is declared here; Task 9 uses it): `{ id: string; runs: Map<number, Run>; pending: number; names: Record<string,string>; stripEl: HTMLElement }`.
  - `findTabForRun(runId) -> { tab, run } | null`, which checks `tab.runId === runId` or `tab.agentTeam?.runs.get(runId)`. `api.agent.onEvent` uses it instead of its inline search.

- [ ] **Step 1: Make the type and session changes.** `startAgentRun` uses `tab.sessions[agentId] ?? null`. The `session` event handler sets `tab.sessions[r.agent] = ev.id`. `agentSessionKey` already includes the agent id, so it's unchanged.
- [ ] **Step 2: Build** — `npm run build`, expected exit 0 with no errors.
- [ ] **Step 3: Check that single runs still work.** `npm start`, open a folder, send a prompt with no mention to the default agent, then send a follow-up, and the reply carries on the conversation. Restore an old chat from history, and its session resumes.
- [ ] **Step 4: Commit** — `git commit -am "refactor: keep one agent session per agent in each chat tab"`

---

### Task 8: Agent bar and @ menu

**Files:**
- Modify: `src/renderer/breeze.html:470` (`#agentPill` → `<div id="agentBar" class="agent-bar"></div>`), `src/renderer/breeze.css` (the `#agentPill` rules ~7209-7505 move to `.agent-chip`), `src/renderer/breezescript.ts` (`renderAgentPill` :1729 and its 12 callers, `agentPillMenuItems` :1704)

**Interfaces:**
- Consumes: `api.team.parse`, `BRAND_ICONS`, `brandMark`, `popupMenu`, and `shortName` (rewritten in TS as `agentShortName(a: DetectedAgent): string` with the same mapping as Task 1).
- Produces:
  - `renderAgentBar(): void` replaces `renderAgentPill` (rename every caller). It keeps the side effects `renderAgentPill` has today (`#boxModel`, `agentsDef[*].model`, `renderAgents`, `updateComposerModelSelect`, `updateScmGenBtn`).
  - `insertMention(a: DetectedAgent): void` inserts `@<Short> ` at the caret of `SURFACES.ide.prompt` and focuses it.
  - `mentionWarning(s: Surface): void` shows or hides `.mention-warn` under the prompt.

- [ ] **Step 1: Render the chips.** Each chip is a `button.agent-chip[data-agent]` with the logo + short name, and `.on` for `appState.agent`. Click → `insertMention`. Its chevron `span.chip-more` → `popupMenu` with "Make default" (the current `run` body from `agentPillMenuItems`) and "Manage agents". A `ResizeObserver` on `#agentBar` moves chips that don't fit into a trailing `+N` chip, whose menu lists them; picking one calls `insertMention`. With no found agent, the bar shows one `Choose an agent` chip → `openAgentPicker`.
- [ ] **Step 2: Add the @ menu.** On `input` in the IDE prompt, when the text before the caret matches `/(^|\s)@([\w-]*)$/`, open `popupMenu` at the caret's line, listing found agents whose `mentionNames` start with the typed word. Enter or Tab picks the highlighted one (it replaces the `@word` with `@<Short> `), Escape closes. Reuse the popup menu's own keyboard handling. On `input`, call `mentionWarning`, which uses a local regex over all detected agents' names and shows `Unknown agent: @X` or `@X isn't installed` in `.mention-warn` (styled like the existing small hint text, in the error color).
- [ ] **Step 3: Build** — `npm run build`, expected exit 0.
- [ ] **Step 4: Check in the app** (`npm start`):
  - every installed agent shows as a chip
  - clicking one inserts `@Claude `
  - narrowing the agents panel to ~300px moves chips into `+N`
  - typing `@co` offers Codex
  - `@Gemini` shows the warning
  - the default chip's chevron → Make default switches the highlight
- [ ] **Step 5: Commit** — `git commit -am "feat: agent bar with every installed agent and an @ mention menu"`

---

### Task 9: Team flow in the chat

**Files:**
- Modify: `src/renderer/breezescript.ts` (`sendPrompt` :9653, `stopAgent` :9646, `addMsg` :9033, `handleAgentEvent` :9846, `finishRun`, `AGENT_EVENTS`, `locks` :2624), `src/renderer/breeze.css`

**Interfaces:**
- Consumes: `api.team.*` (Task 6), `AgentTeamState` and `findTabForRun` (Task 7), `agentShortName` (Task 8).
- Produces:
  - `startAgentTeam(tab, parsed): Promise<void>`
  - `splitCard(tab, claim): Promise<Record<string,string> | null>`, which resolves with `owners` on Start and `null` on Cancel.
  - `agentBadge(agentId): string`, the logo + name HTML.

- [ ] **Step 1: Branch in `sendPrompt`.** On the `ide` surface, call `api.team.parse(text)`. With `unknown.length`, toast the unknown-mention copy for the first one and return, leaving the prompt text in place. With 0 tasks, use the current path. With 1 task, call `startAgentRun(task.agentId, …)` with `shared` + `task.text` joined by a blank line. With 2 or more, call `startAgentTeam`. Attachment headers are added to `shared`.
- [ ] **Step 2: Claiming.**
  - `startAgentTeam` shows the user message and a `.team-claiming` line with each member's badge spinning, then sets `tab.runId = -1` so the tab is busy and Send is blocked.
  - It calls `api.team.claim` and passes each member's `tab.sessions[agentId]`, then stores the returned `sessions` into `tab.sessions`.
  - On a rejection it shows `errorCard` and clears the busy state.
- [ ] **Step 3: Show the split card.**
  - The card has one column per member: its badge, a one-line task, and its claimed paths (or the failed-claim copy and a Remove link).
  - Each clash is a row with a segmented control per agent, the first agent selected.
  - Start resolves with owners: every claimed path → its claimer, then the clash choices on top. Removed members are left out; if fewer than 2 remain, the remaining one runs as a single run.
  - Cancel calls `api.team.stop(teamId)`, clears the busy state, and marks the card resolved (`.resolved`, like `showPlan`).
- [ ] **Step 4: Build.**
  - Call `api.team.start`.
  - Create one `Run` per member (as `startAgentRun` does, `phase: 'builder'`).
  - Fill `tab.agentTeam` with `pending` = the member count.
  - Set `tab.runId`/`tab.run` to the first member, and add the `.team-strip` (one chip per member, `working`) at the top of `tab.panel`.
- [ ] **Step 5: Label each agent's lines.** In `handleAgentEvent`, when `tab.agentTeam` is set, set a module `let labelAgent: string | null` to `r.agent` around the dispatch. `addMsg` prepends `agentBadge(labelAgent)` to the new element's first child when it is set, and adds `data-agent`.
- [ ] **Step 6: Handle the new events.**
  - `crossing` → a `.card.crossing` with the exact copy from Global Constraints (`blocked` picks the copy; `error` adds the restore-failed line and an Undo button → `api.team.undo`).
  - `team-done` (handled once per team, by its `teamId`) → a `.card.team-summary`:
    - per member: its badge and the files from `run.files`, or `not finished` when its `done` had `ok:false`
    - the crossings count
    - each note, as `<Name> → <Name>: text`
    - each `changed` path with Undo (`api.team.undo`) / Keep (a no-op) buttons, which resolve to `✓ Undone` / `✓ Kept`
    - `skipped` paths listed as `Not protected (too large): …`
  - After the card, clear `tab.agentTeam`, `tab.runId` and `tab.run`, and refresh the busy state.
- [ ] **Step 7: Finish runs per member.** In `finishRun`, when the run belongs to `tab.agentTeam`: update that member's strip chip (`done`/`failed`), decrement `pending`, and only clear `tab.runId`/locks/thinking when `pending === 0`. Locks: change the `locks` value type to `{ phase: AgentKey; agent: string }`, and update the two readers (:4417, :4896) to use `.phase` and show the agent name in their tooltip.
- [ ] **Step 8: Stop and drop.** `stopAgent` calls `api.team.stop(tab.agentTeam.id)` when the tab has a team, otherwise the current path. When `team-done` clears `tab.agentTeam`, keep its id in `tab.lastTeamId`. The next `sendPrompt` in that tab calls `api.team.stop(tab.lastTeamId)` first (main deletes the team, so its snapshots are dropped), and the summary's Undo then shows the rejection text as a toast.
- [ ] **Step 9: Build** — `npm run build`, expected exit 0.
- [ ] **Step 10: Commit** — `git commit -am "feat: run @mentioned agents as a team in one chat"`

---

### Task 10: End-to-end check in the app

**Files:** none (fix forward in the task that owns any bug you find).

- [ ] **Step 1:** `npm test` passes, and `npm run build` exits 0.
- [ ] **Step 2:** `npm start`, then open a scratch folder (e.g. a new empty folder with `git init`).
- [ ] **Step 3:** Send `Make a tiny todo app.\n@Claude make the frontend in web/\n@Codex make an Express backend in server/`. Expect, in order:
  1. the claiming line, then the split card with a `package.json` clash row
  2. Start, and both strip chips show `working`
  3. labelled lines from both agents
  4. the summary card with each agent's files
- [ ] **Step 4:** In the same tab, send `@Codex edit web/index.html and add a footer`. That's a single run. Expect Codex to resume its session, and expect no crossing (single runs are not teams).
- [ ] **Step 5:** Send `@Claude add a README\n@Codex also change web/index.html title to Hacked`. Expect a crossing card saying `Codex tried to edit web/index.html (Claude's). Breeze put it back.` (or, if Codex claims it, a clash row on the split card), and the file's title unchanged.
- [ ] **Step 6:** Start another team and press Stop during the build. Both chips stop, and the tab is no longer busy.
- [ ] **Step 7:** A prompt with no mention behaves exactly as before, and Breeze Box ignores `@Codex` (sends it as text to the default agent).
- [ ] **Step 8:** Commit any fixes, with messages naming the task they belong to.
