# Deliverable E — Implementation roadmap

## 1. Dependency order

```
Phase 0  recon + docs ───────────────────────────────┐
Phase 1  shell (window, layout, panels, workspaces,  │  spikes run alongside:
         palette, status bar, settings, notifs)      │   S1 Obsidian reparenting
   │                                                 │   S2 Electron vs WebView2 RAM
Phase 2  browser (tabs, profiles, history,           │   S3 extension must-work list
         bookmarks, downloads, extensions, panels)   │
   │  ── GATE: benchmarks + extension list ──        │
Phase 3  core services (command bus, registry,       │
         events, storage, search, files, CLI, API,   │
         permissions)                                │
   ├──────────────┬───────────────┬──────────────────┘
Phase 4        Phase 5         Phase 6
knowledge/docs automation      dev env + agents
   └──────────────┴───────┬───────┘
                       Phase 7  AI website workflows (needs browser + automation + knowledge)
                          │
                       Phase 8  scripting, sync, advanced customization
```

Deviation from PRD order, proposed: the **Command Bus and event bus skeleton move into Phase 1**. Shell features (palette, shortcuts, panels) are commands from the first commit; otherwise Phase 3 becomes a retrofit of every Phase 1–2 feature. Full CLI/API/permissions remain Phase 3.

## 2. Milestones

| ID | Milestone | Done when |
|---|---|---|
| M0 | Phase 0 complete | All five deliverables reviewed; Orca located or declared absent; spikes S1–S3 scheduled |
| M1 | Shell usable | App starts, restores last layout; split/dock/float panels; 2+ workspaces switchable; palette runs every registered command; status bar shows CPU/RAM of Sensor |
| M2 | Daily-driver browser | Can replace Chrome for a day: tabs, profiles, incognito, history, bookmarks, downloads, devtools, website panels, session restore, must-work extensions |
| M2-gate | Engine decision | Benchmark report vs Chrome on same workload; go/no-go on Electron |
| M3 | Controllable from outside | `sensor tabs list/open`, `page read`, `events watch` work from a separate terminal with a scoped token; universal search over tabs/history/bookmarks/files |
| M4 | Connected knowledge | Real Obsidian inside a panel; save page/YouTube timestamp/selection to a note with `sensor://` links; annotations persist; PDF tools; clipboard history |
| M5 | Macros | Record a DOM workflow, edit in visual editor, replay deterministically, trigger on download/file/schedule, run via CLI |
| M6 | Agentic dev | Projects, terminals, worktree-per-task, two agents in parallel on one repo, handoff + integration with approval |
| M7 | AI website workflows | "Send PDF to ChatGPT with prompt", "ask all providers", save conversation to note |
| M8 | Sync + scripting | Two machines share settings/macros over LAN; user scripts with scoped permissions |

## 3. Test strategy

| Layer | Tooling | What |
|---|---|---|
| Unit | Vitest | Services, command handlers, macro interpreter, converters registry, permission checks |
| Contract | JSON Schema per command | Every command's input/output validated in tests; CLI help and API docs generated from same schemas |
| Integration | Vitest + real SQLite + temp dirs | Storage, indexing, checkpoints (including kill-mid-write tests) |
| E2E | Playwright for Electron | Real app: open tabs, promote to panel, palette, workspaces, macros |
| CLI | Go tests + E2E harness | CLI against a running app instance |
| Conversion | Golden-file round trips | A conversion is exposed only if its test passes |
| Provider adapters | Scheduled live smoke tests (manual opt-in, user's logged-in profile) | Detect ChatGPT/Claude/Perplexity UI breakage |
| Security | Tests that unauthorized tokens fail every scoped command | |
| Performance | Benchmark harness in CI on Windows runner + manual runs on reference machines | See §4 |

CI: GitHub Actions `windows-latest` for build, unit, E2E; benchmarks recorded as artifacts and compared to previous run.

## 4. Performance targets and benchmark plan

**No numbers are invented here.** Targets are set relative to a measured baseline:

1. Build `bench/` harness in Phase 1: launches app, scripted workloads, samples per-process working set / private bytes (Windows PDH counters), CPU, and timing marks.
2. Baseline: same workloads in **Chrome stable** and **Edge stable** on the reference machine (RTX 4060 / 32 GB / i7) and one low-end machine (iGPU, 8 GB RAM).
3. Workloads:
   - Cold start (after reboot) and warm start to first interactive frame.
   - Idle 5 min with empty workspace.
   - 10 tabs (mixed: Gmail, YouTube playing, GitHub PR, docs site, ChatGPT, news) + 3 panels.
   - 30 tabs, 25 suspended.
   - Tab switch latency (p50/p95) across the 10-tab set.
   - Search latency over 100k indexed files + 5k notes.
   - Macro overhead: 50-step DOM macro, Sensor vs manual CDP.
4. Initial targets (to be revised after baseline exists):
   - RAM with the 10-tab workload: within a set margin of Chrome on the same workload (margin decided after S2 spike, written here).
   - Idle CPU: indistinguishable from Chrome's idle CPU.
   - Palette open → first result: perceived-instant (frame-budget measured).
   - Tab switch p95 no worse than Chrome.
5. Regression rule: any PR that worsens a tracked metric beyond noise threshold needs an explicit note.

## 5. Incremental deliverables

Each phase ends with something a user can actually use; nothing is listed as "implemented" in README until it passes its E2E test.

| Phase | User-visible deliverable |
|---|---|
| 1 | A fast, keyboard-driven layout shell with workspaces and palette (browser views can be basic) |
| 2 | A browser good enough to be the daily driver |
| 3 | `sensor` CLI + universal search |
| 4 | Obsidian inside Sensor; save-to-note from any page; PDF toolkit |
| 5 | Macro recorder |
| 6 | Multi-agent dev workspace |
| 7 | One-click AI website workflows |
| 8 | Sync and scripting |
