# Deliverable D — Risk register

Likelihood / impact: H / M / L.

| # | Risk | Category | L | I | Mitigation | Owner phase |
|---|---|---|---|---|---|---|
| R1 | Chrome extension compatibility in Electron is partial; users expect "Chrome extensions" to just work | Feasibility | H | H | Publish a tested compatibility list; define a must-work list before Phase 2; Browser Service abstraction keeps a Chromium-fork/WebView2 backend possible; decide at Phase 2 gate | 2 |
| R2 | Electron RAM overhead conflicts with "LOW RAM" goal | Performance | M | H | Benchmark harness from day one; tab suspension/discard; one shell renderer; lazy-load subsystems; no always-on workers; gate in Phase 2 | 1–2 |
| R3 | Obsidian window reparenting breaks on focus/DPI/IME/GPU compositing or on Obsidian updates | Integration | M | H | Prototype in Phase 1 spike; fallback to managed adjacent window; bridge plugin carries real integration either way | 1 spike, 4 |
| R4 | Obsidian terms or plugin policies restrict this kind of integration | Licensing | L | M | Review Obsidian ToS and plugin guidelines before shipping the bridge publicly; no modification of Obsidian binaries | 4 |
| R5 | AI website automation breaks when ChatGPT/Claude/Perplexity change their UI; CAPTCHAs; ToS against automation | Integration / legal | H | M | Per-provider adapters with versioned selectors and a health check; actions stop at "user reviews and submits"; no autonomous submission by default; clear "may break" labels | 7 |
| R6 | Local API becomes a privilege-escalation path (any local process controls browser with logged-in sessions) | Security | M | H | Named pipe ACL'd to user SID; per-client tokens with scopes; GUI confirmation to grant; audit log; `forms:submit` and delete scopes off by default | 3 |
| R7 | Macro/scripting executes untrusted shared code | Security | M | H | Imported macros/scripts start with zero scopes; show requested scopes on import; scripts run in a sandboxed context, not core | 5, 8 |
| R8 | Clipboard history captures passwords/secrets | Privacy | H | M | Honor `ExcludeClipboardContentFromMonitorProcessing` / `CanIncludeInClipboardHistory` formats (used by password managers); app exclusion list; DPAPI encryption at rest; incognito never recorded | 4 |
| R9 | Coding agents damage user repos (force push, overwrite, delete) | Security / data | M | H | Worktree per task; protected-branch list; git ops proxied through Sensor where possible; destructive ops require approval; checkpoint before integration | 6 |
| R10 | Licensing contamination: AGPL (MuPDF, Ghostscript), GPL (Pandoc, FFmpeg GPL builds) | Licensing | M | H | Only permissive libs linked in-process; GPL tools invoked as separate executables; LGPL FFmpeg build shipped; license manifest checked in CI | 4 |
| R11 | Scope: 14 subsystems built by a small team becomes a pile of half-features | Delivery | H | H | Strict phase gates; feature status table in README; rule: no placeholder UIs; each phase ships something usable end-to-end | all |
| R12 | Chromium/Electron update cadence (8-week majors) creates churn and security lag | Maintenance | H | M | Track Electron stable; automated upgrade branch + smoke/benchmark suite; never pin more than one major behind | ongoing |
| R13 | Window-level embedding and many native views cause GPU/compositor glitches on hybrid-GPU laptops | Performance | M | M | Test matrix includes iGPU-only machine, not just RTX 4060 desktop | 1–2 |
| R14 | File indexer hammers disk/CPU | Performance | M | M | Off by default except chosen roots; idle-priority worker; throttling; USN journal for incremental; pause in performance mode | 3–4 |
| R15 | Sync conflicts corrupt settings/macros | Data | M | M | CRDTs for structured data; never sync DB files raw; checkpoint before applying remote changes | 8 |
| R16 | Checkpoint created mid-write is inconsistent | Data | M | M | SQLite online backup API for DBs; manifest-last commit protocol; ignore manifest-less checkpoints | 3 |
| R17 | Orca codebase (if found) conflicts with chosen stack | Architecture | M | M | Reassess stack the moment Orca is located; prefer absorbing it over rewriting | 0 |
| R18 | Everything SDK / 7-Zip unRAR / other third-party redistribution terms | Licensing | M | L | Optional integrations detect user-installed tools instead of bundling where terms are unclear | 4 |
