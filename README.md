# Breeze IDE

A lightweight desktop IDE built with Electron, with a built-in terminal, Git, AI coding agents and a few things to keep you in the flow.

## Features

- **Editor and file explorer** with syntax checking for JavaScript and TypeScript
- **Integrated terminal** and automatic detection of installed compilers and toolchains
- **AI agents** that stream plans, tool calls and file edits into the IDE
- **Local LLM support** for Ollama, LM Studio or any OpenAI-compatible server
- **Git** panel with sync (pull and push)
- **Sign in with GitHub or Google**, with multiple accounts
- **Vibe Mode** plays a social feed while agents work
- **Discord Rich Presence** shows what you're working on
- API keys are encrypted with the OS keychain

## Getting started

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm start
```

`npm start` compiles `breezescript.ts` and launches the app.

| Script | What it does |
| --- | --- |
| `npm start` | Compile and run the app |
| `npm run build` | Compile TypeScript only |
| `npm run watch` | Compile on change |
| `npm test` | Syntax-check the main process and run the tests |
| `npm run dist` | Build the Windows installer into `dist/` |

## Configuration

Sign-in and Discord presence need client ids. Copy the example file and fill in your own:

```bash
cp breeze.config.example.json breeze.config.json
```

Or put them in a `.env` file next to `main.js`:

```
BREEZE_GITHUB_CLIENT_ID=
BREEZE_GOOGLE_CLIENT_ID=
BREEZE_GOOGLE_CLIENT_SECRET=
BREEZE_DISCORD_CLIENT_ID=
```

Environment variables override the config file. Both `breeze.config.json` and `.env` are gitignored; never commit them.

- **GitHub:** create an OAuth App and enable *Device Flow* (no secret needed).
- **Google:** create a *Desktop app* OAuth client.
- **Discord:** create an application and use its Application ID.

## Building the installer

```bash
npm run dist
```

This runs `scripts/write-config.js`, which writes `breeze.config.json` from your `.env` so the packaged app has its client ids, then builds `dist/Breeze IDE Setup <version>.exe` with electron-builder.

The installer is unsigned, so Windows SmartScreen may warn on other machines. Values bundled into an installer can be extracted by anyone who has it, so only put public client ids (and Google's desktop-app secret, which is not confidential) in `.env` when building.

## Project layout

| Path | Purpose |
| --- | --- |
| `main.js` | Electron main process: files, terminal, agents, Git, auth |
| `preload.js` | Bridge between the main process and the UI |
| `breeze.html`, `breeze.css` | UI |
| `breezescript.ts` | Renderer logic (compiled to `breezescript.js`) |
| `toolchains.js` | Compiler and tool detection |
| `discord.js` | Discord Rich Presence client |
| `runtime/` | C runtime helpers |
| `test/` | Tests |
