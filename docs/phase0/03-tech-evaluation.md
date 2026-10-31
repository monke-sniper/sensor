# Deliverable C — Technology evaluation

**Rule:** no performance numbers are claimed here. Every "lighter/heavier" below is a structural argument to be confirmed by the Phase 2 benchmark harness (05-roadmap.md §4).

## 1. Browser engine *(the decision that matters most)*

| Option | Extensions | RAM / startup (structural) | Integration effort | Maintenance | Licensing | Verdict |
|---|---|---|---|---|---|---|
| **Electron** (`WebContentsView`) | Partial: MV3 subset via `session.loadExtension` + `electron-chrome-extensions`. Popular extensions often work; some (sync-heavy, `chrome.identity`, side panels) do not. | One extra browser + Node runtime per app; per-tab renderers same as Chrome. Startup includes Node init. | Low. Full JS control of views, CDP via `webContents.debugger`, native IPC. | Electron major every 8 weeks tracking Chromium; manageable. | MIT + Chromium BSD | **Proposed for Phase 1–2** |
| **CEF** (C++ / CefSharp) | Weak: limited extension API surface, historically lagging. | Similar renderer cost to Electron, no Node. | High: UI shell must be built in native C++/C#; more glue for everything. | Tracks Chromium; native build complexity. | BSD | Worse extension story than Electron, more work. Reject. |
| **WebView2** (Edge runtime, Win32/WinUI host) | Limited: `AddBrowserExtensionAsync` exists but supports a subset; no Web Store install flow. | Shared evergreen runtime (already on Win11) means small install; per-view processes still Chromium. Potential RAM win from shared runtime, unproven. | Medium: native host (C#/C++/Rust), less control than Electron over sessions/CDP. | Microsoft maintains runtime. | Free to redistribute | **Benchmark candidate.** Strong if extensions bar is low. |
| **Tauri 2** (WebView2 under the hood) | Same limits as WebView2. | Small Rust host; multi-webview support still maturing. | Medium–high for multi-view browser UI. | Young multiwebview APIs. | MIT/Apache | Good for a tool shell, risky as a browser. Reject for now. |
| **Chromium fork** (ungoogled-chromium / Thorium / Supermium as base) | Full Chrome extension support incl. Web Store. | Best achievable: no extra runtime, native tab strip. | Very high: C++, ~tens of GB source, hours-long builds, rebase every Chromium milestone (~4 weeks). | Heavy, continuous. | BSD + per-fork terms | **Long-term option** if extensions are non-negotiable. Not where to start. |
| **Vivaldi** | Full | — | — | — | **UI is proprietary.** Only Vivaldi's Chromium patches are published; the UI (its React/JS layer) is not open source and cannot be forked. | **Not viable** to fork. Use only as design reference. |

**Recommendation:** Electron now, behind the Browser Service abstraction, with a hard gate at end of Phase 2: if (a) idle/with-tabs RAM is materially worse than Chrome on the benchmark workload, or (b) a required-extension list fails, evaluate the WebView2 backend and the Chromium-fork path with real numbers. Honest tradeoff: Electron gives the fastest path to a fully integrated product; it will never match a Chromium fork on extension fidelity.

## 2. Desktop framework (shell UI)

| Option | Pros | Cons |
|---|---|---|
| **Electron renderer + TypeScript + Solid or Svelte** | Same process model as browser; tiny runtime frameworks; easy theming via CSS (PRD 3.5) | Web UI must be kept disciplined to stay fast |
| Electron + React | Largest ecosystem, likely matches Orca | Heavier runtime, more re-render care |
| Native WinUI 3 / C# | Native feel | Poor fit with Electron views; CSS theming lost |

**Pick:** Electron + TypeScript + **SolidJS** (fine-grained reactivity, very small). Switch to React only if Orca is React and gets absorbed.

## 3. Database

| Option | Tradeoff |
|---|---|
| **SQLite (`better-sqlite3`, WAL)** | Synchronous, fast, single file, FTS5 built in, battle-tested. **Pick.** |
| LevelDB/RocksDB | No SQL, no FTS; more code for queries. |
| DuckDB | Analytics-oriented, not a fit for OLTP app state. |

## 4. Search indexing

| Option | Tradeoff |
|---|---|
| **SQLite FTS5** | Zero extra deps, good enough for notes/tabs/history/annotations at personal scale. **Start here.** |
| Tantivy (Rust, via napi) | Faster ranking, better at large file-content corpora. Move here if FTS5 latency fails the benchmark on big file indexes. |
| Windows Search (Indexer) | Already running on the machine, but slow query API and opaque control over scope. Use as optional source, not foundation. |
| Everything SDK | Instant filename search across NTFS. Optional accelerator if user has Everything installed; verify SDK redistribution terms. |

Incremental file indexing via `ReadDirectoryChangesW` (watched roots) + NTFS USN journal catch-up on startup.

## 5. PDF processing

| Need | Pick | Alternative | Note |
|---|---|---|---|
| View/annotate in app | PDF.js | PDFium in native | PDF.js is what Firefox ships; annotation layer available |
| Rasterize pages (PDF→images, thumbnails) | PDFium (BSD) | MuPDF | MuPDF is **AGPL**: unusable without commercial license |
| Merge/split/reorder/rotate/extract/metadata | qpdf + pdf-lib | PyPDF | qpdf is robust on broken PDFs |
| Compression | qpdf (object streams) + Ghostscript optional | — | Ghostscript is **AGPL**; only as user-installed optional tool |
| OCR | Windows.Media.Ocr | Tesseract | Built-in, no model bundle; Tesseract for languages Windows lacks |
| Webpage→PDF | `webContents.printToPDF` | — | Free from Chromium |
| Signatures | pdf-lib (visual signature) | — | Cryptographic signing is later/optional |

## 6. File conversion

Registry of converters, each declaring `(from, to, options schema, tool)`. Only conversions with a passing round-trip test are exposed (PRD 7.1 "do not claim support unless it works").

| Domain | Tool | License note |
|---|---|---|
| Images | libvips (sharp) | LGPL (dynamic) |
| Audio/video | FFmpeg, separate exe | Ship LGPL build; GPL build only if user supplies it |
| Docs (md/html/docx/odt/epub) | Pandoc, separate exe | GPL — fine as separate process, not linked |
| Office→PDF | LibreOffice headless, optional user install | MPL |
| CSV↔JSON, md↔html | in-process JS | — |
| Archives | 7-Zip (7za) | LGPL + unRAR clause |

## 7. Macro execution

| Layer | Mechanism | Reliability |
|---|---|---|
| Sensor actions | Command Bus (`tabs.open`, `files.convert`…) | Deterministic, best |
| Browser DOM | Recording via isolated-world content script capturing events + robust selectors (role/label/text/test-id, CSS fallback); playback via CDP `Input.*` + `Runtime.evaluate` | Good; breaks on site redesigns, mitigated by multi-selector fallback |
| Visual | Screenshot template match within a Sensor view only | Fallback when DOM fails |
| Raw mouse/keyboard | Within Sensor windows only | Last resort |

Macro format: versioned JSON step graph (actions, conditions, loops, variables, retries, checkpoints). The visual editor and the workflow builder edit the same format. Interpreter runs in the core; every step is logged. No AI in execution (PRD 9.7).

Playwright as a library was considered: excellent selector engine, but it wants to own the browser launch. Reuse its selector ideas (or its injected selector engine, Apache-2.0) over CDP rather than adopting the runner.

## 8. Obsidian embedding

| Option | Real Obsidian? | Feasibility | Pick |
|---|---|---|---|
| Win32 window reparenting (`SetParent`) of Obsidian.exe | Yes | Works for many Electron apps; focus/DPI/IME edge cases | **Primary, prototype first** |
| Managed adjacent window snapped to layout | Yes | Robust, less integrated | Fallback |
| Companion Obsidian plugin (`sensor-bridge`) | Yes (integration channel) | Officially supported plugin API | **Always** |
| Obsidian URI / Advanced URI plugin | Yes | One-way, limited | Supplementary |
| Load Obsidian's asar into Sensor | — | Closed source, license terms, breaks on updates | **Reject** |
| Custom Markdown editor | **No** | — | **Forbidden by PRD 5.1** |

## 9. Terminal integration

| Option | Pick |
|---|---|
| **xterm.js + node-pty (ConPTY)** | Yes. VS Code-proven, WebGL renderer, Windows-native PTY. |
| Embed Windows Terminal | No public embedding API; reparenting is fragile. |
| WezTerm/Alacritty embedding | Not designed for embedding. |

## 10. Synchronization

| Data | Approach |
|---|---|
| Settings, layouts, workspaces, macros, commands | CRDT documents (Automerge or Yjs), merged per-record. Transport: LAN discovery (mDNS) + direct encrypted connection (Noise/libsodium) first; optional relay that only sees ciphertext. |
| Obsidian vault | Do not reimplement file sync. Interop with what the user uses (Obsidian Sync, Syncthing, OneDrive). Optionally bundle-manage Syncthing. |
| Browser data | Out of scope initially; Chromium sync is Google-account-bound and not available to Electron. Export/import bookmarks between machines via Sensor sync. |
| Keys | Per-device keypair; pairing by QR/code; no account. |

## Proposed stack (summary)

- **Core + shell:** Electron, TypeScript, SolidJS, Vite.
- **Storage:** SQLite (better-sqlite3), FTS5.
- **CLI:** Go single binary, JSON-RPC over named pipe.
- **Native helpers:** small Rust/N-API module for Win32 bits (window reparenting, USN journal, DPAPI) where Node APIs fall short.
- **External tools as separate processes:** git, FFmpeg (LGPL), qpdf, Pandoc, 7za, PDFium-based rasterizer.
