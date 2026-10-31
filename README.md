# Sensor

An integrated computer and internet environment for Windows 11: browser, agentic development environment, Obsidian, files, documents, automation, and AI-website workflows in one application, all controllable through a first-class CLI and local API.

> **Status: Phase 0 (reconnaissance and architecture). No application code yet.**
> Nothing described below is implemented. See [Feature status](#feature-status).

## Documents

| Doc | What it is |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements (the source of truth for the product vision) |
| [docs/phase0/00-recon.md](docs/phase0/00-recon.md) | Repository inventory, reuse assessment, open questions |
| [docs/phase0/01-architecture.md](docs/phase0/01-architecture.md) | Deliverable A: architecture, process boundaries, data flow, CLI/API, permissions |
| [docs/phase0/02-feature-map.md](docs/phase0/02-feature-map.md) | Deliverable B: feature-to-component mapping |
| [docs/phase0/03-tech-evaluation.md](docs/phase0/03-tech-evaluation.md) | Deliverable C: technology evaluation with tradeoffs |
| [docs/phase0/04-risk-register.md](docs/phase0/04-risk-register.md) | Deliverable D: risk register |
| [docs/phase0/05-roadmap.md](docs/phase0/05-roadmap.md) | Deliverable E: roadmap, milestones, test strategy, benchmark plan |

## Principles

1. Integration over reinvention.
2. Useful before impressive.
3. Performance is fundamental.
4. Deterministic by default; AI is explicitly invoked.
5. One environment, shared context.

## Feature status

Legend: **implemented** / **partial** / **planned** / **unsupported**

| Area | Status |
|---|---|
| Shell, workspaces, panels, command palette | planned (Phase 1) |
| Browser foundation | planned (Phase 2) |
| Core services: registry, events, search, CLI, local API, permissions | planned (Phase 3) |
| Obsidian integration, annotations, PDF/docs, conversion, clipboard, RSS | planned (Phase 4) |
| Macro recorder and workflow builder | planned (Phase 5) |
| Development environment and agent coordination | planned (Phase 6) |
| AI website workflows | planned (Phase 7) |
| Scripting, sync, advanced customization | planned (Phase 8) |

## License

Not yet chosen. Dependency licenses (Chromium, Electron, PDFium, FFmpeg, etc.) constrain the choice; see the risk register.
