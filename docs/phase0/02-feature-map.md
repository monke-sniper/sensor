# Deliverable B — Feature-to-component mapping

Columns: subsystem (service in core), dependencies, user-facing surface, CLI/API commands, data, phase.

| Feature | Subsystem | Depends on | UI | CLI / API | Data | Phase |
|---|---|---|---|---|---|---|
| Workspaces | Workspace Manager | Command Bus, Storage | sidebar switcher, palette | `workspaces.list/switch/create/delete` | `core.db: workspaces, layouts` | 1 |
| Panels, split, float, detach | Panel Manager | Workspace Manager, Browser Service | drag/dock chrome | `panels.list/open/move/close`, `layouts.save/restore` | `core.db: layouts` | 1 |
| Command palette | Command Bus | Command registry, Search | Ctrl+K palette | (is the registry) `commands.list/run` | registry in memory | 1 |
| Shortcuts | Command Bus | Settings | settings page | `shortcuts.list/set` | `core.db: shortcuts` | 1 |
| Status bar / resource monitor | Command Center | Process metrics | bottom bar | `status.get`, `metrics.processes` | in memory | 1 |
| Notifications | Notification Center | Event Bus | toast + center | `notifications.list/dismiss` | `core.db: notifications` | 1 |
| Themes / CSS | Shell UI | Settings | settings, user CSS file | `themes.list/apply` | `%APPDATA%/Sensor/themes/` | 1, 8 |
| Tabs, navigation | Browser Service | Electron views | tab strip, address bar | `tabs.list/open/close/activate/inspect`, `nav.go/back/reload` | `browser.db: sessions` | 2 |
| Profiles, incognito | Browser Service | Session partitions | profile picker | `profiles.list/create`, `tabs.open --profile/--incognito` | `profiles/<id>/` | 2 |
| History, bookmarks | Browser Service | Storage, Search | history/bookmark panels | `history.search`, `bookmarks.list/add/remove` | `browser.db` | 2 |
| Downloads | Browser Service | Event Bus, File Service | downloads panel | `downloads.list/open/cancel`, event `download.completed` | `browser.db: downloads` | 2 |
| Extensions | Browser Service | electron-chrome-extensions | extensions page | `extensions.list/install/enable` | profile dir | 2 |
| Website panels | Panel Manager + Browser Service | — | "open as panel" | `tabs.open --panel/--float` | `core.db: layouts` | 2 |
| Tab suspension / performance mode | Browser Service + Perf Governor | Metrics | toggle in status bar | `perf.mode set`, `tabs.suspend` | settings | 2, 8 |
| Content recognition | Recognizer registry | Browser preload | contextual action bar | `page.recognize --tab`, event `page.recognized` | none (stateless) | 2–3 |
| Resource registry / `sensor://` | Resource Registry | Storage | link handling everywhere | `resources.resolve/link/unlink/links` | `core.db: resources, links` | 3 |
| Event subscriptions | Event Bus | Permission Manager | — | `events.subscribe` (stream), `sensor events watch` | none | 3 |
| Universal search | Search Service | Registry, index worker | palette + search panel | `search.query {q, sources[]}` | `index.db` | 3 |
| Permissions / tokens | Permission Manager | Storage | permissions settings, grant dialogs | `auth.grant/list/revoke` | `core.db: tokens, audit` | 3 |
| File environment | File Service | Indexer, Converter | file panel, previews | `files.list/stat/search/copy/move/rename/delete/tag` | `core.db: tags`, `index.db` | 3–4 |
| Duplicate detection, batch rename | File Service | Hashing worker | file panel actions | `files.dupes`, `files.rename --pattern` | temp | 4 |
| Universal viewer | Shell viewers | PDF.js, media, code viewer | preview pane | `files.preview` (opens) | — | 4 |
| Obsidian embedding | Knowledge Service | Native helper (SetParent) | Obsidian panel | `obsidian.open/focus`, `notes.open` | vault (user's) | 4 |
| Notes + refs | Knowledge Service | sensor-bridge plugin, Registry | save-to-note, link pickers | `notes.create/read/append/search/link` | vault md + `links` | 4 |
| Annotations, sticky notes, highlights | Annotation Service | Browser preload, Registry | in-page overlay | `annotations.list/create/delete` | `browser.db: annotations`, blobs | 4 |
| Screenshot annotation | Annotation Service | `capturePage` | capture tool | `capture.screenshot`, `annotations.create --image` | blobs | 4 |
| PDF toolkit | Document Service | qpdf, pdf-lib, PDFium, OCR | PDF viewer actions | `pdf.merge/split/extract/rotate/reorder/compress/ocr/text/meta/topdf` | temp + output files | 4 |
| Conversion | Document Service (converter registry) | FFmpeg, libvips, Pandoc, 7za | right-click convert, dialog | `files.convert {src,to,options}`, `convert.formats` | — | 4 |
| Clipboard history | Clipboard Service | Win32 clipboard listener, DPAPI | clipboard panel, palette | `clipboard.list/search/paste/delete/exclude` | `clipboard.db` | 4 |
| RSS + reading lists | Feed Service | Scheduler, Search | RSS panel | `feeds.list/add/refresh`, `items.list/mark`, `collections.*` | `core.db: feeds, items, collections` | 4 |
| Macro recorder + editor | Automation Engine | Browser preload, CDP, Command Bus | recorder bar, visual editor | `macros.list/record/run/export/import` | `core.db: macros` (JSON) | 5 |
| Workflow builder + triggers | Automation Engine | Event Bus, Scheduler | node graph editor | `automations.list/enable/run`, `triggers.*` | `core.db: automations` | 5 |
| Projects | Project Service | git, File Service | project sidebar | `projects.list/open/add` | `core.db: projects` | 6 |
| Terminals | Terminal Service | PTY host | terminal panels | `terminals.list/open/send/read` | scrollback in memory | 6 |
| Git + worktrees | Project Service | git CLI | git panel, diff viewer | `git.status/diff/worktree.add/remove/merge` | repo | 6 |
| Agent sessions + usage | Agent Coordinator | Adapters, PTY host | agent panel, status bar | `agents.list/start/send/stop/usage` | `core.db: agent_sessions` | 6 |
| Multi-agent coordination | Agent Coordinator | Project Service, Event Bus | task board | `tasks.*`, `handoff.request/accept`, `integrate.run` | `core.db: tasks, handoffs, decisions` | 6 |
| AI provider config | AI Web Service | Browser Service | settings | `providers.list/add/edit` | `core.db: providers, prompts` | 7 |
| Send to provider (attach + prompt) | AI Web Service | Provider adapters, Automation Engine | context action | `ai.send {provider, files[], text, prompt}` | — | 7 |
| Ask all providers / research workspace | AI Web Service | Workspace Manager | research workspace template | `ai.ask-all {q, providers[]}` | — | 7 |
| Conversation capture | AI Web Service + Knowledge | Recognizers | "save conversation" | `ai.capture --tab`, `notes.create` | vault + blobs | 7 |
| Scripting, custom commands/buttons/panels | Script Host | Command Bus, Permissions | script editor, toolbar config | `scripts.list/run`, `commands.register` | `%APPDATA%/Sensor/scripts/` | 8 |
| Sync | Sync Engine | CRDT lib, crypto | sync settings, pairing | `sync.status/pair/now` | CRDT docs | 8 |
| Checkpoints | Backup Service | Storage | settings | `backup.now/list/restore` | `checkpoints/` | 3 |
