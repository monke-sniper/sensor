# Deliverable A — Architecture

**Status:** proposal. Decisions marked *(gate)* are re-checked against benchmarks before they become final.

## 1. Shape of the system

One application, one core process that owns all state, many sandboxed renderers, a few isolated workers, and thin clients (GUI, CLI, external agents) that all talk to the core through the same command interface.

```
                         ┌──────────────────────────────────────────────┐
  sensor.exe (CLI) ──┐   │                 SENSOR CORE                  │
  external agent  ───┼──►│  (Electron main process, Node/TypeScript)    │
  scripts         ───┘   │                                              │
   named pipe +          │  Command Bus ── Permission Manager           │
   token auth            │      │                                       │
                         │  ┌───┴───────────── services ─────────────┐  │
                         │  │ Workspace  Panel   Browser   Resource  │  │
                         │  │ Manager    Manager Service   Registry  │  │
                         │  │ Search     File    Document  Automation│  │
                         │  │ Service    Service Service   Engine    │  │
                         │  │ Knowledge  Project Agent     Sync      │  │
                         │  │ Service    Service Coord.    Engine    │  │
                         │  └────────────────────────────────────────┘  │
                         │  Event Bus ─── Storage (SQLite, WAL)         │
                         └──────┬───────────────┬───────────────┬───────┘
                                │ IPC           │ IPC           │ child processes
                 ┌──────────────┴───┐  ┌────────┴────────┐  ┌───┴──────────────────┐
                 │ Shell UI renderer│  │ Web content     │  │ Workers:             │
                 │ (sidebar, palette│  │ renderers       │  │  indexer, converter  │
                 │  status bar,     │  │ (WebContentsView│  │  (ffmpeg/qpdf/pandoc)│
                 │  panel chrome)   │  │  per tab/panel) │  │  pty host, git       │
                 └──────────────────┘  └─────────────────┘  │  coding agents       │
                                                            └──────────────────────┘
                 ┌───────────────────────────────┐
                 │ Obsidian.exe (real app),      │◄── window reparented into a Sensor panel
                 │ + "sensor-bridge" plugin      │◄── talks to core over the local API
                 └───────────────────────────────┘
```

## 2. Core design rule: everything is a command

Every user-visible operation is a named command registered on the **Command Bus**:

```
tabs.open      { url, workspace?, target: "tab"|"panel"|"float" }
tabs.list      {}
page.read      { tabId, format: "text"|"markdown"|"html" }
files.convert  { src, to, options }
notes.create   { vault, path, body, refs[] }
macros.run     { id, inputs }
agents.list    {}
```

- GUI buttons, the command palette, keyboard shortcuts, macros, the CLI, the local API, and scripts all dispatch the **same** commands.
- Each command declares: input schema (JSON Schema), output schema, required permission scopes, whether it is destructive, and emitted events.
- The command registry is the source for: CLI help, API docs, palette entries, macro action list, and permission prompts. One definition, five surfaces. This is how "everything accessible from the CLI" stays true without a parallel implementation (PRD 14.3).

## 3. Process boundaries

| Process | Owns | Why separate |
|---|---|---|
| Core (Electron main) | All state, command bus, services, DB handles, local API server | Single writer to storage; one place to enforce permissions. Kept lean: no heavy CPU work. |
| Shell UI renderer | Sidebar, palette, status bar, panel chrome, settings, viewers | Normal UI; no Node access, talks to core only via a typed preload bridge. |
| Web content renderers | Websites (one per tab/panel, Chromium site isolation) | Chromium sandbox; crash isolation. |
| Indexer worker | File walking, content extraction, FTS writes | Keeps core responsive; can be paused by performance mode. |
| Converter worker(s) | FFmpeg, qpdf, Pandoc, libvips, OCR invocations | Licensing isolation (GPL/LGPL tools run as separate executables) and crash isolation. |
| PTY host | ConPTY sessions for terminals and agents | Matches VS Code; terminal crash ≠ app crash. |
| Coding agents | Claude Code / Codex / OpenCode processes | External programs; Sensor supervises, never embeds. |
| Obsidian.exe | User's real Obsidian | Closed-source; integrated, not embedded in-process. |
| `sensor` CLI | Argument parsing, output formatting | Separate tiny binary; startup must be near-instant. |

## 4. Browser architecture *(gate)*

- Each tab/panel = one `WebContentsView` attached to the window; the shell UI is its own view layered around them. Panels and floating mini-windows are the same object with a different layout slot, so "promote tab to panel" is a re-parent, not a reload.
- **Profiles** = Electron `session` partitions (`persist:profile-<id>`), each with its own cookie jar, storage, extensions, permissions. **Incognito** = in-memory partition (no `persist:` prefix); nothing written to disk; history writes suppressed at the Browser Service level, not just the UI.
- **Workspaces** reference tabs and panels; they do not own browser identity. A workspace can hold tabs from several profiles.
- **Tab suspension**: inactive views are detached and, past a threshold, destroyed with URL + scroll + form-state snapshot retained; restored on focus. This is the main RAM lever.
- **Content recognition**: deterministic recognizers (URL pattern + `<meta>`/OpenGraph + small DOM probes in an isolated-world preload) emit `page.recognized { kind: "youtube.video", ids… }`. Contextual actions subscribe to kinds. No AI involved.
- **Engine abstraction**: Browser Service exposes `createView / navigate / exec / capture / onEvent`. Electron is the first backend. Keeping this narrow keeps a later move to a Chromium-fork or WebView2 backend possible if Phase 2 benchmarks or extension coverage fail.

## 5. Data and storage

```
%APPDATA%/Sensor/
  core.db          SQLite: workspaces, layouts, settings, commands, permissions, macros, projects
  browser.db       history, bookmarks, downloads, annotations (per profile tables)
  index.db         FTS5 search index (rebuildable — never backed up)
  clipboard.db     clipboard history (encrypted at rest with DPAPI)
  profiles/<id>/   Chromium session data (managed by Electron)
  blobs/           content-addressed captures (screenshots, saved pages) sha256/xx/xxxx
  checkpoints/     current/ + previous/ (see 8)
```

- SQLite with WAL; only the core writes (workers send results back over IPC or write to their own DB, e.g. index.db).
- Resource Registry: every addressable thing gets a URI: `sensor://tab/123`, `sensor://file/C:/x.pdf`, `sensor://note/<vault>/<path>`, `sensor://yt/<id>?t=93`, `sensor://chat/chatgpt/<id>`. Links between resources are rows in one `links` table (src, dst, kind, created). Knowledge connections, search results, project associations and annotation anchors all use these URIs.
- Notes stay in the Obsidian vault as Markdown. References to Sensor resources are written as normal Markdown links using `sensor://` URIs (clickable from Obsidian via a registered protocol handler) plus frontmatter `sensor:` fields. Vault stays valid without Sensor.

## 6. Event system

- In-process typed event bus in the core. Every command emits events; services emit domain events (`download.completed`, `file.created`, `macro.failed`, `agent.finished`, `workspace.changed`, `tab.changed`).
- Events carry the resource URI and a monotonic sequence number.
- External subscribers: `events.subscribe { topics[] }` on the local API returns a stream (newline-delimited JSON over the pipe). Permission-filtered: a client without `tabs:read` never sees tab events.
- Triggers (automation) and notifications are just event subscribers.

## 7. Obsidian integration

Constraint: Obsidian is a closed-source Electron app. Its UI cannot be loaded inside Sensor's process. "Embed the actual application" is therefore done at the window level:

1. **Window embedding (primary):** Sensor launches or finds `Obsidian.exe`, then reparents its top-level HWND into a Sensor panel host window (`SetParent` + style changes + resize sync). The user sees and uses real Obsidian, with their plugins and vaults, inside the Sensor layout. Known issues to prototype early: keyboard focus handoff, DPI scaling, GPU compositing with Chromium children, Obsidian's own frameless title bar, multi-window Obsidian.
2. **sensor-bridge Obsidian plugin (integration channel):** a community-style plugin installed into the user's vault that connects to Sensor's local API. It lets Sensor open a note, insert links/blocks at the cursor, read the active file, and lets Obsidian resolve `sensor://` links. This is the supported, durable integration path.
3. **Direct vault access (indexing):** Sensor reads vault files directly for search and backlink resolution. Writes go through the bridge when Obsidian is running (to avoid edit conflicts), directly to disk otherwise.

If (1) proves unreliable, the fallback is Obsidian as an adjacent, Sensor-managed window snapped to the layout, still driven via (2). Sensor never substitutes its own Markdown editor and calls it Obsidian.

## 8. Backup checkpoints

- Exactly two slots: `checkpoints/current` and `checkpoints/previous`.
- Create: write new checkpoint into `checkpoints/.incoming-<ts>` → fsync → write `MANIFEST.json` last (with hashes) → rename `previous` to `.trash`, `current` to `previous`, `.incoming` to `current` → delete `.trash`. A checkpoint without a valid manifest is ignored and cleaned at next start, so an interrupted run never replaces a good checkpoint.
- Storage efficiency: files are stored content-addressed; unchanged files between checkpoints are NTFS hardlinks to the same blob, so a new checkpoint only costs changed files. `index.db` and Chromium caches are excluded.
- Restore = stop services, swap `previous` into place, restart.

## 9. CLI and local API

- **Transport:** Windows named pipe `\\.\pipe\sensor-<user-sid>` (ACL'd to the current user). Optional localhost HTTP on an opt-in basis for tools that cannot use pipes.
- **Protocol:** JSON-RPC 2.0. Methods are the command names. Notifications carry events.
- **Auth:** every client presents a token. Tokens are created in the GUI or via `sensor auth grant` (which itself requires GUI confirmation), each bound to a client name and a scope set. Stored hashed.
- **CLI:** `sensor <noun> <verb> [args] [--json]`, generated from the command registry:
  ```
  sensor tabs list --json
  sensor tabs open https://example.com --panel
  sensor page read --tab 12 --format markdown
  sensor files convert in.png --to webp
  sensor notes create "Research/x.md" --link sensor://yt/abc?t=93
  sensor macros run download-invoices --input month=10
  sensor events watch download.completed agent.finished
  ```
  The CLI is a small native binary (Go proposed) so `sensor tabs list` is not paying Node startup cost on every call.
- **MCP:** not core. An optional adapter can map registry commands to MCP tools later.

## 10. Permissions

- Scopes: `tabs:read`, `page:read`, `page:interact`, `forms:submit`, `notes:read`, `notes:write`, `files:read:<root>`, `files:write:<root>`, `files:delete`, `downloads:manage`, `macros:run`, `macros:edit`, `agents:read`, `agents:control`, `projects:<id>`, `scripts:exec`, `clipboard:read`.
- Every command declares required scopes; the Permission Manager checks before dispatch. Destructive commands additionally require either a pre-granted `…:delete`/`forms:submit` scope or interactive confirmation.
- Grants are inspectable (`sensor auth list`, settings UI) and revocable. Every API/CLI call is logged to an audit table.
- GUI-originated commands run as the "user" principal with all scopes; macros run with the scopes granted to that macro.

## 11. Agent integration

- **Agent Runtime Adapters:** one adapter per agent CLI (Claude Code, Codex, OpenCode, generic). An adapter knows how to start a session in a directory, send a prompt, detect idle/finished/waiting-for-approval, read usage where the tool reports it, and stop. Capability flags per adapter; no pretending all agents are equal.
- **Project Service:** projects, worktrees (`git worktree add` per agent task on a `sensor/<task>` branch), ownership table (worktree → agent), protected branches list.
- **Coordination store:** tasks, dependencies, handoff requests, decisions, validation status live in `core.db`, not in agent chat history. Agents read/write it through the CLI (`sensor tasks …`, `sensor handoff request …`), which works for any agent that can run shell commands.
- **Integration flow:** completed task → integration agent gets a merge worktree → runs tests → proposes merge; merges into protected branches and destructive git operations require user approval.
