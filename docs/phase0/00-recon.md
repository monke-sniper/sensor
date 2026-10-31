# Phase 0 — Reconnaissance

**Date:** 2026-10-31
**Status:** first pass. Several items are blocked on access (see Open questions).

## 1. Repository inventory

| Item | Finding |
|---|---|
| Existing Sensor codebase | None found. This repository starts from zero. |
| Existing Orca implementation | **Not found** in the GitHub accounts accessible to this session (searched for `orca`, `sensor`). The PRD references "the existing Orca implementation"; until it is located, nothing here assumes its structure. |
| Existing ADE capabilities | Unknown for the same reason. |
| Browser codebases | None vendored. Evaluated from public information only (see 03-tech-evaluation.md). |

Because there is no existing code, rule 1 ("understand the existing codebase") reduces to: locate Orca, then reassess. If Orca turns out to be an Electron + TypeScript ADE (terminals, worktrees, agent sessions), it is a strong candidate to absorb as the Phase 6 base rather than rebuild, and its stack should bias the Phase 1 stack decision.

## 2. Reuse assessment (third-party)

Proven components we should integrate rather than build:

| Need | Reuse candidate | Notes |
|---|---|---|
| Web engine | Chromium via Electron (`WebContentsView`) | See browser comparison. |
| Chrome extension APIs | `electron-chrome-extensions`, Electron's built-in `session.loadExtension` | Partial coverage only. Biggest gap vs. a real Chromium fork. |
| Terminal | `xterm.js` + `node-pty` (ConPTY on Windows) | Same stack as VS Code's terminal. |
| Git | `git` CLI (spawned) + `simple-git` style wrapper | Shelling out to real git avoids libgit2 worktree gaps. |
| Database | SQLite (`better-sqlite3`) with WAL | Single local DB file per data domain. |
| Full-text search | SQLite FTS5 first; Tantivy later if needed | |
| Filename search | Voidtools Everything SDK (if installed) + own NTFS USN-journal indexer fallback | Everything licensing to verify. |
| PDF render/view | PDF.js (Apache-2.0) in-renderer; PDFium (BSD) for server-side rasterization | Avoid MuPDF (AGPL) unless licensed. |
| PDF manipulation | `qpdf` (Apache-2.0) CLI, `pdf-lib` (MIT) | merge/split/rotate/reorder/metadata. |
| OCR | `Windows.Media.Ocr` (built into Windows) first; Tesseract (Apache-2.0) fallback | Windows OCR needs no bundle. |
| Media conversion | FFmpeg (LGPL build) as external process | Ship LGPL build only, dynamically linked / separate exe. |
| Image conversion | `sharp`/libvips | |
| Document conversion | Pandoc (GPL, invoked as separate process), LibreOffice headless (MPL) optional | Do not link GPL code into the app. |
| Archives | 7-Zip (`7za`, LGPL + unRAR restriction) | |
| Obsidian | Actual Obsidian app + companion Obsidian plugin + vault files | See architecture section 7. |
| Sync | Automerge or Yjs (CRDT) for structured data; Syncthing interop for vaults | |

## 3. Open questions (blocking or near-blocking)

1. **Where is Orca?** Need repo URL or access. Decides whether Phase 6 is "integrate" or "build".
2. **Chrome extension support bar.** "Chrome extensions" with full fidelity effectively requires a Chromium fork. Which extensions must work on day one (e.g. uBlock Origin, Bitwarden, Dark Reader)? This list decides Electron vs fork. Default proposal: Electron with a published compatibility list, re-evaluated at the Phase 2 gate.
3. **Obsidian embedding acceptance.** Real embedding on Windows means reparenting the Obsidian window into Sensor's (Win32 `SetParent`). It is genuine but has focus/DPI/input edge cases. Acceptable as the primary mechanism?

None of these block Phase 1 work on the shell.

## Update: Orca located and decision

Orca is [stablyai/orca](https://github.com/stablyai/orca): an MIT-licensed Electron + React IDE for parallel agentic development, about 2.5M lines of TypeScript, with its own `orca` CLI (`orca repo add`, `orca worktree create --agent`, `orca agent launch`, `orca status`).

**Decision: integrate, don't absorb.**

- Forking Orca would make Sensor carry a second, much larger application with its own architecture and release cadence. It would also commit Sensor to React, against the PRD's performance priority.
- Instead, Sensor implements the dev-environment basics natively and leanly: projects, git, worktrees with protected branches, tasks, handoffs, decisions, agents in terminals and usage.
- Sensor bridges to Orca through Orca's public CLI: `orca.status`, `orca.addProject`, `orca.worktrees`, `orca.createWorktree`, `orca.launchAgent`. Users who want Orca's richer orchestration keep using it side by side.
- If specific Orca modules prove worth reusing later, the MIT license allows copying them with attribution.
