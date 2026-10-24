# Multi-agent teams (@mentions) — design

Date: 2026-10-24 · Revision 1 · Status: approved in chat

## Goal

The agents header shows every installed agent. In one prompt the person can hand different parts of a task to
different agents:

```
@Claude make a front end for it
@Codex make backend
```

The agents work at the same time in the same project, and they do not edit each other's files. If one does
anyway, Breeze puts the file back and says so.

Out of scope (first version): Breeze Box (stays one agent at a time), git worktrees or merging, agents talking to
each other while they run, a lead agent that splits the task, the same agent running twice at once, and tracing a
shell-command edit to a specific agent.

## Decisions

| Question | Decision |
|---|---|
| How the agents run | In parallel, each in its own process, in the open project |
| Who owns which files | A read-only **claim** pass per agent lists the files/folders it will touch; the person settles clashes on a split card, then presses Start |
| Unclaimed files | Belong to the first agent that edits them |
| An agent edits a file another owns | Blocked up front where the agent allows it (Claude Code, Local LLM); otherwise restored from a snapshot right away and flagged in the chat (Codex, Antigravity) |
| Chat layout | One chat; each message and tool line has that agent's logo and name; a status strip at the top shows each agent's state |
| Where coordination lives | A new main-process module `src/main/team.js`; the renderer only shows things |
| Prompt with no mention | Unchanged: one run with the default agent |
| Prompt with one mention | A normal single run with that agent (no claim step) |

## User-facing behaviour

### Agent bar

- `#agentPill` is replaced by `#agentBar`: one chip for each agent that `appState.detect` reports as found, showing
  its brand logo (`BRAND_ICONS`) and short name (Claude, Codex, Antigravity, Local).
- The chip for the default agent (`appState.agent`) is highlighted. A chevron on each chip opens the model/effort
  menu that `agentPillMenuItems()` builds today, for that agent.
- Clicking a chip inserts `@<ShortName> ` at the caret in the prompt and focuses it.
- When the chips don't fit the panel width, the extra ones go into a `+N` overflow menu (`popupMenu`).
- With no agents found, the bar shows the existing "Choose an agent" button, which opens `openAgentPicker()`.

### Mentions

- Typing `@` in the prompt opens a menu of the installed agents, filtered as the person types. Up/Down move, Enter
  or Tab inserts `@<ShortName> `, and Escape closes it.
- Parsing (`src/main/mentions.js`, see below) splits the prompt into tasks. Each `@Name` starts a task that runs until
  the next mention. Any text before the first mention is shared context, added to every task.
- Names match with case ignored, by short name or full name (`@claude`, `@Claude Code`, `@codex`, `@antigravity`,
  `@local`).
- An agent mentioned twice gets one task: its parts joined with a blank line.
- A mention of an agent that isn't installed: Send shows a toast ("Codex isn't installed. Install it from Settings →
  Agents") and nothing runs. The mention is underlined in red while it is typed, using a regex over the known
  names in the renderer.
- Text like an email address (`a@b.com`) is not a mention: a mention must start the text or follow whitespace.

### Flow for two or more agents

1. **Claiming.** The chat shows the person's message, then a "Planning who does what" line with each agent's chip
   spinning. Each agent runs a read-only claim pass (at most 60 s).
2. **Split card.** One column per agent: its logo, its task (one line), and the paths it claimed. Each clash
   (a path claimed by more than one agent, or a path under a folder another agent claimed) is a row with a
   segmented control to pick its owner; the first-mentioned agent is selected by default. An agent whose claim
   failed shows "Couldn't list its files. It will own files it touches first." with a **Remove** link.
   Buttons: **Start** and **Cancel**.
3. **Building.** All members start at once. The status strip at the top of the chat shows a chip per member:
   `working` (spinner), `done` (check) or `failed` (red). Every message, tool line and card from a run carries that
   agent's logo and name.
4. **Crossing card.** "Codex tried to edit `web/App.tsx` (Claude's). Breeze put it back." For a blocked attempt by
   Claude Code or the Local LLM: "Claude tried to edit `server/api.js` (Codex's) and was stopped."
5. **Summary card** when all members are done: the files each agent changed; any crossings; each agent's
   "For <name>:" notes; and, from the end-of-run check, any other-owned file that changed without a crossing event,
   with **Undo** (restore the snapshot) and **Keep** buttons.

### Follow-ups

- A tab keeps one session per agent: `tab.sessions: Record<agentId, string>` replaces the single `tab.session` /
  `tab.sessionAgent` pair (an old tab's saved session moves to `sessions[sessionAgent]`).
- A later `@Codex add auth` in the same tab resumes Codex's session. A later team prompt resumes each member's
  session for both its claim and its build.

## Components

### 1. `src/main/mentions.js` (no Electron imports)

- `parseMentions(text, agents)` — `agents` is `[{ id, name, short }]`. It returns
  `{ shared: string, tasks: [{ agentId, text }], unknown: string[] }`. Tasks are in first-mention order, and
  duplicates are joined.
- `shortName(agent)` — `Claude Code` → `Claude`; other names are kept as they are.
- Used by main (`team:parse`, below), so the renderer and the tests share one parser.

### 2. `src/main/team.js` (no Electron imports; side effects come in through a `deps` object for tests)

- `claimPrompt(task, teammates)` — the read-only prompt. It asks for the files and folders the agent will create or
  edit, as a fenced ```json block `{"paths": ["web/", "web/App.tsx"]}`, and says not to change any files.
- `parseClaim(text)` — the last fenced JSON block → a list of clean relative paths. Paths are made relative, use `/`,
  have folders end in `/`, and anything outside the root, `.git/` or `.env*` is dropped. A reply without one gives `[]`.
- `findClashes(claims)` → `[{ path, agents }]`. Two paths clash when they are equal or one is a folder that contains
  the other.
- `ownerOf(owners, rel)` — the exact path's owner, else the longest owned folder that contains it, else `null`.
- `claim(owners, rel, agentId)` — first-touch: if `rel` has no owner, record `agentId` as its owner.
- `buildBrief(member, team)` — the build prompt: the shared context, this agent's task, its teammates and their
  tasks, "You own: …", "Do not edit: …", and "If you need a change in a teammate's files, don't make it. Say so at
  the end of your final message under a line 'For <name>:'".
- `claudeDenyArgs(owners, agentId)` → `['Edit(<p>)', 'Write(<p>)', 'MultiEdit(<p>)', 'NotebookEdit(<p>)', …]` for
  every path another member owns (a folder `p/` becomes `p/**`). These are added to `--disallowedTools`.
- `snapshot(root, paths, fsDeps)` → `Map<rel, Buffer | null>`. `null` means the file didn't exist. Folders are
  expanded to their files. Files over 2 MB are left out and listed in `skipped`.
- `restore(root, rel, snap, fsDeps)` — writes the saved content back, or deletes the file when it was `null`.
- `changedSince(root, snap, fsDeps)` → the snapshotted paths whose content no longer matches.
- `notesFor(text, names)` — pulls the "For <name>:" sections out of an agent's final message.

### 3. Main process wiring (`src/main/main.js`)

- `team:parse(text)` → `parseMentions(text, foundAgents)`.
- `team:claim({ members: [{ agentId, task }], shared })` — creates a team (`teams: Map<teamId, Team>`) and starts one
  `ask`-mode run per member through the existing `startRun`, with the claim prompt and the member's session for
  this tab. It collects each run's final text (a new `onFinal` hook on the run; events still go to the renderer) and
  resolves with `{ teamId, claims, clashes, failed: agentId[] }`. Each claim has a 60 s timeout, after which that run
  is stopped and marked failed.
- `team:start({ teamId, owners: Record<path, agentId> })` — sets the ownership map, snapshots every owned path, and
  starts one `build` run per member with `buildBrief`. It returns `{ [agentId]: runId }`. The run options get a new
  `team: { teamId, agentId }` field:
  - `claudeArgs` adds `claudeDenyArgs(...)` to `--disallowedTools`.
  - `runLocal`'s `agentPath` check also refuses a path whose owner is another member, with the message "That file
    belongs to <name> on this team. Leave it and mention what you need in your final message.", and emits
    `{ t: 'crossing', path, owner, blocked: true }`.
  - Every `file` event from a team run first calls `claim(...)`. If the path's owner is another member, Breeze
    restores it now and again 300 ms later, and emits `{ t: 'crossing', path, owner }`.
  - When the last member's `done` arrives, Breeze runs `changedSince` over the snapshot. It flags a changed path
    only if its owner never reported a `file` event for it and it wasn't already a crossing — an edit nobody can be
    tied to, such as one made by a shell command — and emits
    `{ t: 'team-done', teamId, changed: string[], notes }` on each member's run id.
- `team:stop(teamId)` — stops every member run through the existing `agent:stop` logic. It restores nothing.
- `team:undo({ teamId, path })` — restores one file from the team's snapshot (for the summary card's **Undo**
  button). A team's snapshots are dropped when its tab starts another run, or after 30 minutes.
- `preload.js` exposes `api.team.{ parse, claim, start, stop, undo }`.

### 4. Renderer (`src/renderer/breezescript.ts`, `breeze.html`, `breeze.css`)

- `renderAgentBar()` replaces `renderAgentPill()`; every caller is updated. The composer model select and `#boxModel`
  keep working as before.
- The mention menu works on `s.prompt` (`input`/`keydown` handlers), reusing the existing popup menu styles.
- `sendPrompt()` calls `api.team.parse`. Zero tasks or one task → the current `startAgentRun` path (with that
  agent). Two or more → `startTeam(tab, parsed)`.
- `startTeam` renders the claiming line, calls `api.team.claim`, shows the split card, and on Start calls
  `api.team.start`. Then it creates one `Run` per member in a new `tab.runs: Map<runId, Run>`. `tab.runId`/`tab.run`
  are still set to the first member, so the existing busy/stop UI keeps working; `stopAgent` calls `api.team.stop`
  when the tab has a team.
- `handleAgentEvent` already routes by run id. It gains an `agent` label (logo + name) on messages and tool lines
  when the tab has a team, and handlers for `crossing` and `team-done`.
- `locks[path]` stores the agent id as well as the phase, so the explorer and tabs show which agent holds a file.

## Errors

- Claim pass fails or times out → shown on the split card as above; Start still works.
- One member fails mid-build → the others keep going; its strip chip turns red, its error card is shown, and the
  summary marks its part "not finished".
- Stop → stops every member; files stay as they are.
- `restore` fails (file locked, permissions) → a crossing card with "Breeze couldn't put it back: <reason>" and an
  **Undo** button to retry.
- The person edits an owned file in the editor during a team run → not a crossing (only agent `file` events are
  enforced). The end-of-run check may list it as an untraced change; **Keep** is the right answer and nothing is
  undone without a click.
- The open folder changes during a team run → the team is stopped, as single runs are today.

## Testing

`test/mentions.test.js` and `test/team.test.js` (node:test, like the existing tests):

- `parseMentions`: shared prefix, case, a full multi-word name, unknown agents, duplicate mentions joined, `a@b.com`
  not a mention, a prompt with no mention.
- `parseClaim`: valid block, last block wins, no block, junk JSON, paths outside the root / `.git` / `.env` dropped,
  `\` paths turned into `/`.
- `findClashes` and `ownerOf`: equal paths, a folder containing a file, sibling folders that share a prefix
  (`web/` vs `webapp/`), first-touch `claim`.
- `claudeDenyArgs`: a file path, a folder path → `/**`, own paths left out.
- `snapshot` / `restore` / `changedSince` against a temp folder: modified, created (restore deletes it), deleted
  (restore recreates it), and the >2 MB skip.
- `notesFor`: one note, notes to two agents, no notes.

Manual check in the running app (IDE):
1. The agent bar shows every installed agent, and chips that don't fit go into `+N` in a narrow panel.
2. A prompt with no mention behaves as before.
3. `@Claude … @Codex …` → claiming → split card → both build → labelled chat → summary.
4. A forced crossing (tell Codex to edit Claude's file) → restored and flagged.
5. Stop during a team run stops both.
