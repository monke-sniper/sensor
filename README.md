# Sensor

An integrated computer and internet environment for Windows 11. Sensor combines a Chromium browser, an agentic development environment, your real Obsidian app, files, documents, automation and AI-website workflows in one application. All of it can be driven from a first-class CLI and a local API.

> **Status: working foundation, pre-release.** Sensor builds, runs and is tested end to end on Linux (unit tests plus a full Electron E2E suite). CI also runs on Windows, and Windows-only parts are marked below. Expect rough edges.

## Quick start

Requirements: Node 22.13+ (for `node:sqlite`), Go 1.22+ (only to build the CLI), git.

```bash
npm ci
npm run dev                 # build and launch
npm run cli:build           # build the `sensor` CLI into bin/
npm test                    # unit tests
npm run test:e2e            # builds, launches the real app and drives it (use xvfb-run on headless Linux)
npm run dist:win            # Windows installer + portable zip into release/ (unsigned)
```

Every CI run on the default branch and pull requests uploads an unsigned Windows build as the `Sensor-windows` artifact.

### CLI

The `sensor` binary talks to the running app over a named pipe (`\\.\pipe\sensor-<user>`) or a unix socket. It uses a token that Sensor creates in its data folder. Commands come from the app's registry, so the CLI always matches the app.

```bash
sensor help                          # every command, grouped
sensor tabs open https://example.com
sensor page read --format markdown
sensor notes capture --kind page
sensor macros run "daily report" --inputs '{"day":"today"}' --wait
sensor tasks start tsk_123 --agent claude
sensor events watch 'download.*'
```

The default CLI token cannot do admin or destructive things: create tokens, delete files, write to protected git branches, submit forms on websites, run scripts or restore backups. Those either prompt in the app or need a token you grant on purpose: `sensor auth grant <name> <scopes>`.

## Feature status

**implemented** = works and is covered by tests · **implemented (Windows, untested)** = written against the Win32 APIs, runs only on Windows, not yet verified there · **partial** = useful but incomplete · **planned** = not built

| Area | Status | Notes |
|---|---|---|
| Shell: workspaces, split panels, floating panels, saved layouts, command palette, status bar, shortcuts | implemented | Panels can hold websites, the main browser, or tools |
| Browser: tabs, profiles (separate cookies), incognito (in-memory, nothing recorded), history, bookmarks, downloads, find, zoom, devtools, tab suspension | implemented | Chromium via Electron 45 |
| Browser extensions | partial | Unpacked extensions load per profile; no Chrome Web Store install |
| Command registry, events, permissions, audit log | implemented | 300+ commands; GUI, CLI, API, shortcuts and macros all use the same commands |
| Local API (JSON-RPC over pipe/socket) and Go CLI | implemented | Named pipe on Windows is exercised in Windows CI |
| Universal search (tabs, history, bookmarks, notes, files, feeds, clipboard, commands, macros, projects) | implemented | SQLite FTS5 |
| Obsidian: vault notes, captures (page / selection / link / YouTube timestamp), backlinks, open in Obsidian | implemented | Sensor writes plain markdown into your vault |
| Obsidian window docked inside a Sensor panel | implemented (Windows, untested) | Re-parents the real Obsidian window (Win32 `SetParent`); elsewhere Obsidian opens alongside |
| Obsidian bridge plugin (insert at cursor, pull the current page, open a note's links) | implemented | `obsidian-plugin/sensor-bridge`, tested against the real API |
| Annotations: highlights and sticky notes on web pages | implemented | |
| Files: browse, search contents, batch rename, duplicates, tags, zip/unzip, recent | implemented | Indexing runs in a worker thread |
| PDF tools: merge, split, extract, reorder, rotate, metadata, compress, images ↔ PDF, page → PDF | implemented | pdf-lib; `qpdf` improves compression when installed |
| Conversions: images via Chromium; audio/video via ffmpeg; documents via pandoc; CSV ↔ JSON, Markdown ↔ HTML | implemented | External tools are only offered when found |
| Clipboard history (text, links, images), pinning, incognito exclusion | implemented | Skipping password-manager copies uses Windows clipboard flags (Windows, untested) |
| RSS/Atom reader with discovery, collections | implemented | |
| Deterministic page recognition (YouTube, AI chats, GitHub, Docs, PDFs, articles) and context actions | implemented | Rule-based, no AI |
| Terminals | implemented | node-pty (ConPTY on Windows) + xterm.js |
| Macro recorder and workflow engine | implemented | Records trusted clicks and typing with fallback selectors; steps, conditions, loops, variables, retries, error jumps, input prompts, nested macros, checkpoint resume. See [docs/macros.md](docs/macros.md) |
| Triggers: schedule, events (e.g. `download.completed`), new files in a folder, startup | implemented | Loop guards built in |
| Dev environment: projects, git status/diff/log, worktrees, protected branches | implemented | Merges, pushes or commits to protected branches need `git:destructive` (prompts) |
| Tasks with dependencies and validation commands, handoffs, decisions | implemented | |
| Coding agents in terminals (Claude Code, Codex, OpenCode, Gemini CLI, Aider, custom) | implemented | Uses each CLI with your own login. No API keys |
| Agent usage | partial | Read from local Claude Code and Codex logs (best effort; the formats aren't public contracts) |
| Orca integration | partial | Through Orca's own `orca` CLI (add repo, worktrees, launch agents). Not tested against a live Orca |
| AI website workflows: send text/files to ChatGPT, Claude, Perplexity, Gemini or any chat site you're logged in to; read and wait for answers; ask several at once; save conversations to notes; prompt templates | implemented | Pressing send is a separate permission (`forms:submit`), off by default. Site selectors can be overridden in settings when sites change |
| Checkpoints: two rolling slots, verified, staged restore | implemented | Point `backup.dir` at a synced folder for an off-machine copy |
| Sync between machines | planned | Only the synced-folder checkpoint approach above for now |
| User scripting (`scripts:exec`) | planned | The scope exists; only task validation commands run today |
| Themes | partial | Custom CSS setting |
| Code signing, auto-update | planned | CI builds are unsigned |
| Performance benchmarks | planned | Live CPU/RAM/process metrics are in the status bar |

## Design in one paragraph

Everything is a command in a single registry. Each command has a parameter schema, required scopes and a destructive flag. The GUI, palette, shortcuts, macros, the local API and the CLI all dispatch through it, so every path gets the same permission check and audit trail. The core (state, SQLite storage, events, services) runs in the Electron main process and has no Electron dependency, so it is unit-tested in plain Node. Electron-specific pieces (browser views, terminals, clipboard, Obsidian embedding) plug in through small host interfaces. Macros run as their own principal, limited to their declared scopes and never more than the caller's. More detail is in [docs/phase0/01-architecture.md](docs/phase0/01-architecture.md) and [docs/api.md](docs/api.md).

## Repository map

| Path | What |
|---|---|
| `src/core/` | Command bus, events, permissions, SQLite, all services (no Electron) |
| `src/core/services/` | workspaces, browser data, search, notes, files, documents, clipboard, RSS, macros, dev, ai, backup |
| `src/main/` | Electron main: browser views, shell window, terminals, Obsidian embedding, clipboard watcher |
| `src/preload/` | Shell bridge and web-page preload (recognition, annotations, macro recording) |
| `src/renderer/` | Solid.js shell UI and tool panels |
| `cli/` | Go CLI (no dependencies) |
| `obsidian-plugin/sensor-bridge/` | Obsidian plugin |
| `tests/unit/`, `tests/e2e/` | Vitest unit tests, Electron E2E |
| `docs/` | PRD, phase 0 architecture docs, API and macro references |

## Principles

1. Integration over reinvention: Sensor uses the real Obsidian, the real agent CLIs and your logged-in AI sites.
2. Useful before impressive.
3. Performance is fundamental.
4. Deterministic by default; AI only runs when you ask.
5. One environment, shared context.
6. Local-first: no cloud account, no API keys, nothing uploaded on your behalf.

## License

Not yet chosen. Dependency licenses (Chromium, Electron, FFmpeg when installed, etc.) constrain the choice; see the risk register.
