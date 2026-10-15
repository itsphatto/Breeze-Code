# Built-in C/C++ compiler and Python — design

Date: 2026-10-16 · Status: approved in chat, awaiting spec review

## Goal

Someone learning to code opens `hello.c`, `main.cpp` or `app.py` in Breeze, presses **F5**, and sees their program
run in the terminal — with nothing else installed on Windows. Programs can read keyboard input. Compiler and Python
errors point back to the right line.

Out of scope for this version: multi-file C/C++ builds (beyond what `make` in the terminal already gives),
debugging UI (gdb is bundled but only usable from the terminal), a full terminal emulator (curses, colours),
bundled toolchains on macOS/Linux.

## Decisions

| Question | Decision |
|---|---|
| Where the tools come from | Bundled inside Breeze (Windows x64) |
| C/C++ compiler | **w64devkit** — portable GCC/g++, gdb, make (~110 MB unpacked) |
| Python | **python-build-standalone**, `install_only` build — full CPython with pip, venv, tkinter (~120 MB unpacked) |
| macOS / Linux | Use the system `cc`, `c++`, `python3`; nothing bundled |
| Program input | Text typed in the terminal line while a program runs goes to its stdin on Enter |
| Run key | F5 runs the active file when it is C, C++ or Python; otherwise F5 starts the preview as today |
| Compiled output | `build/<name>.exe` next to the source file |

## Components

### 1. Toolchain manifest and fetch script

- `toolchains.json` — for each tool: exact version, download URL, SHA-256, archive type, and the folder inside
  the archive that holds `bin/`. Versions are pinned when this is implemented and only change by editing this file.
- `scripts/fetch-toolchains.js` (`npm run fetch-toolchains`) — downloads each archive into a temp folder, verifies
  the SHA-256 (refuses to unpack on mismatch), unpacks into `vendor/w64devkit/` and `vendor/python/`, and writes
  `vendor/.versions.json`. Skips a tool whose installed version already matches. Windows only; on other platforms it
  prints that nothing is needed and exits 0.
- `vendor/` is added to `.gitignore`.

### 2. `toolchains.js` (main process, new module)

One small module with no Electron UI code, so it can be tested with `node --test`:

- `toolchainRoot()` — `process.resourcesPath/toolchains` when `app.isPackaged`, else `<repo>/vendor`.
- `toolPaths()` — `{ gcc, gxx, python, binDirs[] }`. On Windows these are the bundled files; on other platforms
  `cc`, `c++`, `python3` looked up with the existing `which()`. Missing tools are `null`.
- `toolEnv(baseEnv)` — copy of the environment with the bundled `bin` folders (w64devkit `bin`, Python root and
  `Scripts`) prepended to `PATH`. Unchanged on non-Windows.
- `runPlan(absFile)` — returns the steps to run a file, or `{ error }`:
  - `.c` → `gcc "<file>" -o "build/<name>.exe" -std=c17 -Wall -g`, then `"build/<name>.exe"`
  - `.cpp` `.cc` `.cxx` → same with `g++` and `-std=c++20`
  - `.py` → `python -u "<file>"` (`-u` so output appears as it is printed)
  - Each step is `{ display, file, args, cwd }`; `cwd` is the source file's folder. `display` is the command line
    shown in the terminal. On non-Windows the output is `build/<name>` with no `.exe`.

### 3. Main process changes (`main.js`)

- `term:run` spawns with `env: toolEnv(process.env)` so `gcc`, `g++`, `gdb`, `make`, `python`, `pip` typed in the
  terminal use the bundled tools. `pip install` installs into Breeze's own Python.
- Spawned processes keep `stdin` open (today it is unused). New handler `term:write(id, text)` writes to that
  child's stdin; ignored if the process is gone.
- New handler `run:file(rel)`:
  1. Resolves `rel` with the existing `resolveIn()`; gets `runPlan()`.
  2. Creates `build/` if needed. If the project root has a `.gitignore` that doesn't ignore `build/`, appends
     `build/`. Never creates a `.gitignore`.
  3. Runs the steps in order with `spawn(file, args, { cwd, env: toolEnv(...) })` (no shell, so file names with
     spaces or `&` are safe). Before each step it sends the `display` line to the terminal as a command line.
  4. Uses the same `terms` map and `term:data` / `term:exit` events as `term:run`, under one id, so Ctrl+C,
     Shift+F5 and stdin work the same. A failing compile step ends the run with its exit code; the program step is
     skipped.
  5. When the last step ends, sends `exited with code N · 0.4s`.
  - Errors returned instead of running: tool missing (Windows dev: "Compilers aren't downloaded yet — run
    `npm run fetch-toolchains`"; macOS/Linux: "Install a C compiler (xcode-select --install / your package
    manager)" or the Python equivalent), unsupported file type, a run already in progress.
- `preload.js` exposes `term.write(id, text)` and `run.file(rel)`.

### 4. Renderer changes (`breezescript.ts`)

- **Run command** `run.file`: saves the active buffer if dirty, opens the terminal panel, calls `api.run.file`, and
  sets `term.proc` from the returned id like `runCommand` does.
- **F5**: `run.start` checks the active file's extension; C/C++/Python → `run.file`, otherwise the preview as
  today. Shift+F5 also stops a running program. The Run menu gets **Run File** (F5, enabled for those file types).
- **Run button**: a ▶ button at the right of the tab bar, shown only when the active file is C, C++ or Python.
- **Stdin**: while `term.proc` is set, Enter in the terminal line sends `value + '\n'` with `api.term.write`,
  echoes the text into the output, and clears the line. This replaces the "A command is still running" toast.
  History and autofill hints are off while a program runs.
- **Clickable errors**: terminal output is scanned for `path:line:col:` (GCC) and `File "path", line N` (Python).
  Matches inside the project render as links that open the file at that line.
- **Underlines**: after a compile step fails, GCC `error:` lines for the open file become editor underlines
  through the existing lint diagnostics; they clear on the next edit or the next successful run.
- Browser demo mode: `run.file` returns the same "only in the desktop app" error as `term.run`.

### 5. Packaging

- Add `electron-builder` as a dev dependency with an NSIS target for Windows x64.
- `extraResources`: `vendor/` → `toolchains/`, so `toolchainRoot()` finds it when packaged.
- `npm run dist` = `fetch-toolchains`, `tsc`, then `electron-builder --win`.
- Expected installer size: roughly 250–300 MB, mostly the toolchains.

## Data flow

```
F5 / ▶ → run.file (renderer) → save buffer → api.run.file(rel)
       → main: runPlan → spawn gcc → term:data … → exit 0 → spawn build/main.exe → term:data …
       ← term:exit(id, code) → "exited with code 0 · 0.4s"
typing while running → api.term.write(id, line) → child.stdin
```

## Error handling

- Toolchain missing or partly unpacked → clear message in the terminal, nothing spawned.
- Bad checksum in the fetch script → that tool is not unpacked; the script exits non-zero and names it.
- Compile error → output shown, links and underlines added, program not run.
- Program waiting on input with no text sent → keeps waiting; Ctrl+C / Shift+F5 stops it (whole process tree, as
  today).
- Writing to stdin after the program exits → ignored.

## Testing

- `node --test` unit tests for `toolchains.js`: `runPlan` for each extension, names with spaces, unsupported
  types, missing tools; `toolEnv` PATH ordering; `toolchainRoot` dev vs packaged.
- Fetch script: a test that a wrong SHA-256 refuses to unpack (using a small local fixture archive).
- Manual check in the Electron app: hello world in C, C++ and Python; a `scanf` / `cin` / `input()` program; a
  C compile error and a Python traceback (links jump to the line, underline shows; a path outside the project stays
  plain text); Ctrl+C on an endless loop; `gcc --version` and `pip --version` in the
  terminal show the bundled tools; a packaged build runs on a PC with no compiler or Python installed.
