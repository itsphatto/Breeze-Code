# Run C, C++ and Python files — design

Date: 2026-10-16 · Revision 2 (uses the PC's installed tools; revision 1 bundled them) · Status: approved in chat

## Goal

Someone learning to code opens `hello.c`, `main.cpp` or `app.py` in Breeze, presses **F5**, and sees their program
run in the terminal using the compiler and Python already on their PC. Programs can read keyboard input. Compiler
and Python errors point back to the right line. When a tool is missing, Breeze says exactly how to install it.

Out of scope: bundling or downloading compilers/Python, MSVC (`cl.exe`), multi-file C/C++ builds (beyond `make`
in the terminal), a debugging UI, a full terminal emulator (curses, colours), packaging an installer.

## Decisions

| Question | Decision |
|---|---|
| Where the tools come from | Already installed on the PC; nothing bundled or downloaded |
| C/C++ compiler | `gcc`/`g++` first, then `clang`/`clang++` (macOS/Linux also `cc`/`c++`); C++ comes from the same folder as C |
| Python | Windows: `py -3` launcher, then `python`; macOS/Linux: `python3` |
| Program input | Text typed in the terminal line while a program runs goes to its stdin on Enter |
| Run key | F5 runs the active file when it is C, C++ or Python; otherwise F5 starts the preview as today |
| Compiled output | `build/<name>.exe` next to the source file |

## Components

### 1. `toolchains.js` (main process module, no Electron imports)

- `findTools(o)` — finds `{ cc, cxx, python, binDirs }` (each `{ path, name, version } | null`):
  - Candidates come from the PATH, and on Windows also these folders when they exist:
    `C:\msys64\{ucrt64,mingw64,clang64}\bin`, `C:\MinGW\bin`, `C:\mingw64\bin`,
    `C:\ProgramData\mingw64\mingw64\bin`, and `%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs*\mingw64\bin`.
  - Every candidate is test-run (`--version`, 4 s limit) and only counts if it exits 0. This rejects the Microsoft
    Store `WindowsApps\python.exe` shortcut when no Python is behind it. For Python, the real interpreter path comes
    from `-c "import sys; print(sys.executable)"`.
  - `binDirs` are the folders of the found tools that aren't already on the PATH.
- `freshPath(platform)` — on Windows, the current machine + user `Path` read from Windows (so tools installed while
  Breeze is open are found); elsewhere `process.env.PATH`.
- `toolEnv(baseEnv, binDirs, platform, pathValue)` — the env with `PATH` = `binDirs` + `pathValue`.
- `runPlan(absFile, tools, platform, stdioHeader)` — the steps to run a file, or `{ error }`:
  - `.c` → `<cc> "<file>" -o "build/<name>.exe" -std=c17 -Wall -g`, then `"build/<name>.exe"`
  - `.cpp` `.cc` `.cxx` → same with `<cxx>` and `-std=c++20`
  - `.py` → `<python> -u "<file>"`
  - The shown command uses the tool's name (`gcc`, `clang`, `python`, `py`); C/C++ also get a hidden
    `-include runtime/breeze_stdio.h`, which turns off stdout buffering so prompts show before input is read.
  - Missing tool → `{ error, hint }` with an install command (see Error handling).
- `runSteps(steps, …)` and `ensureBuildIgnored(root)` — unchanged from revision 1.

### 2. Main process (`main.js`)

- Tools are found once in the background at startup and found again on a Run while one is missing.
- `term:run` spawns with `toolEnv(...)`, so `gcc`, `g++`, `python`, `pip` typed in the terminal use the same tools
  a Run uses. Spawned processes keep `stdin` open; `term:write(id, text)` writes to it.
- `run:file(rel)` refuses while a program runs, creates `build/` for C/C++, calls `ensureBuildIgnored`, then runs
  the steps through `runSteps` under one terminal id (Ctrl+C, Shift+F5 and input work the same as for commands) and
  ends with `exited with code N · 0.4s`.
- `sys:detect` also reports `C/C++` and `Python` (found, version). They are optional: missing ones don't turn the
  tools pill or status bar dot yellow, and the status bar only names them when found ("Git ready · Node ready ·
  C ready · Python ready").

### 3. Renderer (`breezescript.ts`) — unchanged from revision 1

Run command, F5 dispatch, ▶ Run button, Run File menu item, typing into a running program, clickable
`file:line:col` / `File "…", line N` links, and red underlines from compile errors.

## Error handling

- No C compiler — Windows: `No C/C++ compiler found. Install one with: winget install BrechtSanders.WinLibs.POSIX.UCRT`;
  macOS: `… Install one with: xcode-select --install`; Linux: `… Install gcc with your package manager (e.g. sudo apt install build-essential)`.
- No Python — Windows: `Python wasn't found. Install it with: winget install Python.Python.3.13`; macOS:
  `… Install it with: xcode-select --install`; Linux: `… Install python3 with your package manager`.
- The install command is shown on its own line so it can be copied and run in Breeze's terminal.
- Compile error → output shown, links and underlines added, program not run.
- Writing to stdin after the program exits → ignored. Ctrl+C / Shift+F5 stop the whole process tree.

## Testing

- `node --test` for `toolchains.js`: `findTools` with fake `exists`/`run` (PATH hit, MSYS2 folder hit, clang
  fallback, Store-shortcut Python rejected, `py` launcher preferred), `runPlan` for each type and missing tools,
  `toolEnv`, `runSteps`, `ensureBuildIgnored`.
- Manual check in the Electron app on this PC (Python 3.11 from the Store, no C compiler): F5 on `app.py` runs;
  F5 on `hello.c` prints the winget command; after running it in Breeze's terminal, F5 on `hello.c` works without
  restarting Breeze.
