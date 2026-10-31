# SENSOR — PRODUCT REQUIREMENTS DOCUMENT
**Version:** 2.0 (Orca-based)  
**Status:** Product vision established. Foundation decided: Sensor is a fork of [stablyai/orca](https://github.com/stablyai/orca) (MIT). Engineering plan in [PORT-PLAN.md](./PORT-PLAN.md).  
**Target platform:** Windows 11 desktop first (Orca's macOS/Linux support is inherited and must keep working)  
**Project codename:** Sensor

> **What changed from 1.0.** Version 1.0 left the foundation open, and the first implementation built a separate SolidJS application that only talked to Orca through its CLI. That duplicated the shell, terminals, agents, worktrees, git, browser core, CLI and automations that Orca already provides, at lower quality. Version 2.0 makes Orca the foundation. Sensor is Orca plus the integration layer described here: knowledge, browsing power features, files and documents, universal search, macros and AI-website workflows. Each section below marks what Orca already provides, what Sensor extends, and what Sensor adds.

---

# 1. EXECUTIVE SUMMARY

## 1.1 What is Sensor?

Sensor is an integrated computer and internet environment.

It combines a powerful browser, agentic development environment, productivity environment, file and document tools, knowledge management, communication access, automation, and system utilities into one cohesive application.

Sensor is not simply:
- An AI browser.
- An agentic development environment.
- A browser with a terminal attached.
- A collection of existing applications inside one window.
- An attempt to recreate every existing website or application.

Sensor is an integration layer that makes the user's entire digital workflow accessible from one place.

The fundamental idea:

**Everything should be accessible, connected, and immediately usable without constantly switching between applications, copying information, manually organizing content, or repeating tedious operations.**

A user should be able to browse a website, save its contents into their knowledge system, attach a related PDF to an AI website, associate the resulting conversation with a project, and continue working in their development environment without manually transferring context between five different applications.

Sensor should make these workflows feel native.

## 1.2 Product philosophy

Sensor follows five principles:

1. **Integration over reinvention.** Integrate existing applications and services where possible. Do not rebuild Obsidian, YouTube, Discord, Google Docs, or Windows functionality unnecessarily.
2. **Useful before impressive.** Features must solve real problems. Avoid gimmicks and unnecessary complexity.
3. **Performance is fundamental.** Low RAM usage, fast startup, responsive interactions, and efficient background processes are essential.
4. **Deterministic by default.** Ordinary operations should work predictably without requiring AI. AI and agents are explicitly invoked when useful.
5. **One environment, shared context.** Browser, files, notes, development projects, automation, and other components should work together rather than behaving like unrelated applications.

## 1.3 The defining experience

Sensor should make the following workflows straightforward:

- Find a PDF, attach it to ChatGPT, and use a predefined prompt.
- Move information between Perplexity, ChatGPT, Claude, and other supported AI websites.
- Save a webpage, YouTube video, AI conversation, timestamp, selected text, and personal annotations into a connected knowledge system.
- Access development projects, terminals, coding agents, browser tabs, and project files in one workspace.
- Record a repetitive workflow as a macro and replay it later.
- Search across files, notes, browser history, downloads, tabs, projects, and other indexed content.
- Execute Sensor operations through the GUI or CLI.
- Let external development agents interact with Sensor through its local interfaces.
- Access small utilities, scripts, document tools, and custom actions without searching for another application.

The user should not need to leave Sensor for ordinary computer and internet workflows.

## 1.4 Foundation: Orca

Sensor is built as a fork of Orca, an MIT-licensed Electron + React desktop IDE for running fleets of coding agents in parallel worktrees. Orca already supplies most of the development half of Sensor and much of the application shell. Sensor's job is to turn that agent IDE into the integrated computer and internet environment this document describes, without rebuilding what Orca already does well.

Labels used throughout this document:

| Label | Meaning |
|---|---|
| **Orca** | Orca already provides it. Sensor inherits it and does not rebuild it. Sensor may restyle or re-label it. |
| **Extend** | Orca has a foundation for it, but Sensor's requirement goes further. Sensor builds on Orca's existing code. |
| **New** | Orca has nothing comparable. Sensor adds it as native Orca modules, following Orca's architecture and conventions. |

What Orca provides today (verified against Orca `main`, commit `94835244a2`):

- Electron main process, React renderer, preload bridge, and a typed runtime RPC layer (`defineMethod` + `src/shared/rpc-contract`).
- The `orca` CLI, built from handler groups, talking to the running app.
- Workspaces built on repositories, git worktrees and plain folders. Split panes containing terminal, editor, markdown, browser and agent-session tabs.
- Terminals (node-pty), git, plus GitHub, GitLab, Bitbucket, Gitea, Azure DevOps, Jira and Linear integrations.
- Adapters for dozens of coding agents (Claude Code, Codex, OpenCode, Gemini, Cursor, Copilot, Devin, Amp, Qwen Code and more), with account switching, usage and rate-limit tracking, and agent session history (`ai-vault`).
- A Chromium browser pane with profiles, cookie import, extensions, devtools, downloads, screencasting and agent-driven browser automation.
- Cron-scheduled automations that dispatch agent runs.
- A plugin system (manifest v2, sandboxed panels and trusted workers, capability-checked host API).
- Notifications, keybindings, the worktree jump palette, process memory metrics, `node:sqlite` storage, crash reporting, opt-in PostHog telemetry, and remote and mobile runtimes.

Sensor keeps Orca's architecture, coding conventions (`AGENTS.md`, `docs/STYLEGUIDE.md`) and test infrastructure. Sensor-specific code is kept in clearly named modules so that upstream Orca changes can keep being merged in (see §20 and §22).

---

# 2. PRODUCT SCOPE

## 2.1 Initial platform

Windows 11 desktop is the first target.

Orca already runs on Windows, macOS and Linux and has remote and mobile runtimes. Sensor inherits all of that and must not break it, because breaking it would make upstream merges expensive. Sensor-specific features are designed, tested and benchmarked on Windows first. A Sensor feature that relies on Windows-only APIs (for example Win32 window re-parenting) must detect the platform at runtime and degrade gracefully elsewhere.

## 2.2 Core product areas

Sensor consists of interconnected subsystems:

| Subsystem | Responsibility | Base |
|---|---|---|
| Browser | Primary web browsing environment | **Extend.** Orca's browser pane becomes a full general-purpose browser |
| Workspace manager | Workspaces, layouts, tabs, profiles and panels | **Extend.** Orca workspaces are repo, worktree or folder based; Sensor adds non-project workspaces and website panels |
| Development environment | Terminals, projects, Git, worktrees and coding agents | **Orca** |
| Agent coordination | Multi-agent task management and integration | **Orca**, extended with Sensor tasks, handoffs and decisions only where Orca lacks them |
| Obsidian integration | Actual Obsidian application integration | **New** |
| File environment | File access, organization, previews and operations | **Extend.** Orca's file explorer and editor, plus Sensor file tools |
| Document tools | PDF processing and file conversion | **New** |
| Knowledge system | Connected notes, annotations and saved content | **New.** Builds on Orca's browser annotation overlay |
| Automation | Macro recording, execution and visual workflows | **Extend.** Reuses Orca's automation scheduler; the macro engine is new |
| AI website integration | Workflows involving normal logged-in AI websites | **New.** Built on Orca's browser automation bridge |
| Command center | Global status, notifications, commands and system information | **Extend** |
| CLI | Programmatic access to Sensor functionality | **Extend.** New handler groups in Orca's CLI |
| Local API | Integration with external applications and agents | **Extend.** New methods in Orca's runtime RPC |
| Synchronization | Optional synchronization across computers | **Extend** (later phase) |

These should not be developed as completely independent applications.

They share Orca's application architecture: one main process, one runtime RPC surface, one CLI, one renderer store.

---

# 3. APPLICATION ARCHITECTURE AND DESIGN

## 3.1 Application identity

Sensor should have a futuristic command-center aesthetic.

The visual direction is inspired by advanced desktop environments and the functional density of power-user applications.

The interface should feel:
- Dense but organized.
- Minimal but information-rich.
- Responsive.
- Customizable.
- Consistent across subsystems.
- Designed for keyboard-driven workflows.

Avoid excessive decoration, unnecessary animations, large empty spaces, and generic dashboard designs.

The interface should prioritize functionality.

**Orca base.** Sensor uses Orca's design system: the tokens in `src/renderer/src/assets/main.css`, the shadcn primitives in `src/renderer/src/components/ui/`, and `docs/STYLEGUIDE.md`. The command-center identity is delivered as a Sensor theme through those tokens, not by inventing parallel styles. New Sensor UI must pass Orca's design-system lint.

## 3.2 Main application layout

The application should support:

- Main browser workspace.
- Configurable sidebar.
- Website panels.
- Terminal panels.
- Project navigation.
- Notes and knowledge panels.
- Downloads and file panels.
- Bottom status bar.
- Command palette.
- Notifications.
- Floating and detachable panels.
- Resizable split views.

The layout should be modular.

A user should be able to arrange panels and windows according to their workflow.

**Orca base (Extend).** Orca already has split panes, tab types (terminal, editor, markdown, browser, agent session), pop-out windows, a sidebar and notification cards. Sensor adds new tab and pane types for its tools (notes, files, documents, clipboard, RSS, macros, search), a persistent status bar, and website panels. It does not build a second layout engine.

## 3.3 Panels and mini-windows

Websites should be capable of becoming persistent panels.

For example:
- ChatGPT as a side panel.
- Discord as a panel.
- YouTube as a panel.
- Gmail as a panel.
- A terminal as a panel.
- A note as a panel.

These are not simply separate browser tabs.

A panel should be capable of behaving like a small, persistent application window inside Sensor.

Support:
- Resizing.
- Moving.
- Docking.
- Splitting.
- Detaching where appropriate.
- Saving panel arrangements.
- Restoring layouts.

## 3.4 Workspaces

Workspaces should allow users to switch between different working environments.

Examples:
- Development.
- Research.
- School.
- General browsing.
- Personal.
- Administration.

Workspaces should have configurable:
- Tabs.
- Panels.
- Layouts.
- Pinned websites.
- Project associations.
- Tool arrangements.
- Shortcuts.

Browser profiles and workspaces must remain conceptually distinct.

Profiles control browser identity and session isolation. Workspaces organize working environments.

Users should be able to use multiple application windows, although Sensor is primarily designed around one main application window.

**Orca base (Extend).** An Orca workspace is a repository, a git worktree or a folder, and Orca already requires every feature to work with folder workspaces. Sensor's non-development workspaces (Research, School, Personal) build on folder workspaces, or on a new workspace kind that is not tied to a directory, if the investigation in PORT-PLAN Phase 0 shows that folder workspaces can't carry them cleanly. Orca's browser profiles already exist and stay separate from workspaces.

## 3.5 Customization

Users should be able to customize:
- Layouts.
- Panels.
- Colors.
- Themes.
- Toolbars.
- Menus.
- Keyboard shortcuts.
- Commands.
- Buttons.
- Scripts.
- Personal workflows.

CSS-level theme customization should be considered.

Community layouts and sharing may be implemented in a later phase.

**Orca base.** Orca already has keybindings, plugin themes (`docs/reference/plugin-themes.md`) and theme tokens. Sensor customization uses those mechanisms.

---

# 4. BROWSER ENVIRONMENT

## 4.1 Requirements

The browser is a fundamental component of Sensor.

It must support:
- Modern web standards.
- Chromium-compatible websites.
- Chrome extensions.
- Normal browsing.
- Tab management.
- Bookmarks.
- History.
- Downloads.
- Browser profiles.
- Incognito mode.
- Session persistence.
- Website permissions.
- Developer tools.
- Custom search engines.
- Keyboard shortcuts.
- Tab grouping and organization.
- Picture-in-picture where supported.

Do not build a browser engine from scratch.

**Orca base (Extend).** Orca's browser pane (`src/main/browser`, `src/renderer/src/components/browser-pane`) already provides Chromium tabs inside workspaces, browser profiles, cookie import, unpacked and installed extensions, devtools, downloads, find-in-page, zoom, screencasting and a full agent automation bridge. It was built for previewing apps and letting agents drive pages, so it treats the browser as a tool inside a dev workspace. Sensor promotes it to the primary browser by adding the missing pieces:

- Bookmarks (Orca has none).
- Global browsing history with search, not only per-tab navigation.
- A first-class downloads manager UI.
- Incognito windows whose activity is never recorded (verify Orca's in-memory partitions meet this bar).
- Custom search engines and an omnibox.
- Tab groups and tab suspension tuned for general browsing.
- Browser tabs that exist outside any project workspace.

Sensor extends Orca's browser code. It does not add a second browser stack.

## 4.2 Browser engine selection

**Decided: Electron's Chromium, as used by Orca.** The 1.0 investigation (CEF, Vivaldi, other Chromium codebases) is closed by the decision to build on Orca. Extension fidelity remains limited to what Electron supports. Publish a compatibility list rather than promising full Chrome Web Store parity.

The goal remains:

**LOW RAM. FAST STARTUP. FAST BROWSING. LOW IDLE RESOURCE CONSUMPTION.**

The browser should be benchmarked against realistic workloads, not just empty-window startup. Benchmarks compare Sensor against stock Orca on the same machine, so Sensor's additions are measured, not assumed.

## 4.3 Browser panels

Websites should be capable of being opened as:
- Normal tabs.
- Docked panels.
- Floating mini-windows.
- Persistent workspace components.

Support multiple instances of different websites within a workspace.

Maintain session and profile isolation according to the user's settings.

**Orca base (Extend).** Orca browser tabs already live in split panes and can pop out. Sensor adds "pin as panel": a website kept as a persistent workspace component (ChatGPT side panel, Discord, Gmail) with its own profile binding.

## 4.4 Browser context recognition

Sensor should recognize supported content and websites.

Examples:
- PDF documents.
- YouTube videos.
- ChatGPT conversations.
- Claude conversations.
- Perplexity conversations.
- Google Drive documents.
- GitHub repositories.
- Articles.
- Images.
- Downloaded files.

Recognition should enable useful contextual actions.

For example, opening a YouTube video could expose actions to:
- Save the video to a collection.
- Create a note linked to the video.
- Record a timestamp.
- Save a transcript where available.
- Associate it with a project.

Website recognition should not require an AI agent to analyze every page.

Use deterministic URL patterns, metadata, DOM inspection, and other appropriate mechanisms.

**New.** Ported from Sensor 1.0's rule-based recognizer (`src/preload/web.ts` on `main`). It runs through Orca's existing page-script injection rather than a separate preload.

---

# 5. INTEGRATED OBSIDIAN

## 5.1 Core requirement

Sensor should embed the actual Obsidian application inside its interface.

Do not casually recreate Obsidian's functionality as a replacement.

The objective is to integrate the existing application and existing user vaults.

Users should be able to access their existing Obsidian notes and vaults without migration.

Investigate the technically viable embedding and integration mechanisms.

If embedding the actual application is not technically feasible in the selected architecture, document the limitation and propose the closest genuine integration. Do not silently substitute a custom Markdown editor and call it Obsidian integration.

**New.** Orca has no Obsidian integration. Port Sensor 1.0's pieces:

- Vault notes and captures (`src/core/services/notes.ts`).
- Win32 `SetParent` docking (`src/main/obsidian.ts`), shown as a Sensor pane type.
- The `sensor-bridge` Obsidian plugin.

Orca's editor and markdown tabs may preview vault files, but Obsidian remains the editor of record.

## 5.2 Connected knowledge

Sensor should connect other parts of the application to Obsidian.

A note or annotation should be capable of referencing:
- Websites.
- Selected webpage text.
- Images.
- PDFs.
- YouTube videos.
- Video timestamps.
- AI conversations.
- Browser tabs.
- Projects.
- Files.
- Other notes.
- Sticky notes and annotations.

A note should be able to contain many different types of references.

Example:

A research note could contain:
- A link to an article.
- A PDF attachment.
- A timestamp from a YouTube video.
- A ChatGPT conversation.
- A Perplexity conversation.
- Personal annotations.
- Relevant project files.

The connections should be persistent and navigable.

## 5.3 Knowledge features

Integrate or expose useful Obsidian functionality:
- Markdown notes.
- Backlinks.
- Tags.
- Folders.
- Search.
- Note linking.
- Existing vault compatibility.
- Attachments.
- Graph view where provided by Obsidian.

Do not prioritize rebuilding Obsidian's graph engine.

## 5.4 Browser annotations

Provide:
- Sticky notes attached to URLs.
- Text-selection annotations.
- Highlighting.
- Saved excerpts.
- Persistent notes.
- Screenshot annotations.
- Arrows and shapes where useful.
- Links between annotations and Obsidian notes.

Annotations should survive browser restarts and be associated with the correct page or content.

**Orca base (Extend).** Orca's browser has an annotate mode (`browser-pane/annotate/`: markup overlay, page annotation tray, viewport bridge), built to mark up a page and send it to an agent. Its annotations are transient. Sensor reuses that overlay and adds:

- Persistent per-URL storage.
- Text-anchored highlights that re-attach on reload.
- Sticky notes.
- Links to Obsidian notes.

Annotations created for agents keep working as they do in Orca.

---

# 6. FILE ENVIRONMENT

## 6.1 Philosophy

Sensor is an integrated application, not an attempt to replace Windows' underlying filesystem.

It should integrate with existing Windows folders and files.

Users should be able to access and manipulate their files without constantly leaving Sensor.

**Orca base (Extend).** Orca already has a workspace file explorer, file read/write/mutation RPC, file watching, ripgrep search and an editor. Those are scoped to workspaces. Sensor adds file access anywhere on disk (subject to permissions) and the file tools below: batch rename, duplicates, tags, zip and unzip, recent files, and a content index. These are ported from Sensor 1.0 (`src/core/services/files.ts`, `file-index.ts`, plus the indexer worker).

## 6.2 File operations

Provide a unified file environment with:
- File browsing.
- Search.
- Preview.
- Metadata.
- Batch renaming.
- Batch conversion.
- Compression and extraction.
- Duplicate detection.
- File tagging where appropriate.
- File organization.
- File movement and copying.
- Useful file properties.
- Recent files.
- Project-associated files.

## 6.3 Universal file viewer

Support previews and appropriate editing capabilities for:
- PDF.
- Images.
- Video.
- Audio.
- Markdown.
- JSON.
- CSV.
- DOCX.
- Source code.
- Plain text.
- Other common document formats.

Avoid implementing complex editing capabilities unnecessarily when an existing integrated application is more appropriate.

## 6.4 File indexing

Support optional local indexing for:
- File names.
- File contents.
- Metadata.
- Documents.
- PDFs.
- Code.
- Notes.

Search should be fast and incremental.

Users should be able to control indexing and excluded directories.

## 6.5 CLI access

Files should be accessible through Sensor's CLI and local API.

An authorized agent should be able to inspect, search, convert, organize, and otherwise operate on files using documented commands.

Destructive operations require appropriate permissions.

---

# 7. DOCUMENT AND PDF SYSTEM

Sensor should include a genuinely useful document toolkit.

PDF functionality should include:

- Webpage to PDF.
- Selected content to PDF.
- Images to PDF.
- PDF to images.
- PDF merging.
- PDF splitting.
- Page extraction.
- Page reordering.
- Compression.
- OCR.
- Text extraction.
- Annotation.
- Highlighting.
- Signatures where appropriate.
- Page rotation.
- Document metadata.
- Exporting selected pages.
- Document previews.
- Batch processing.

The goal is a convenient, integrated document environment.

**New.** Orca has no PDF toolkit. Port Sensor 1.0's `documents.ts`: pdf-lib operations, Chromium page-to-PDF, image-to-PDF, and `qpdf` compression when installed. OCR and signatures remain planned until a working local implementation is chosen.

## 7.1 Universal conversion

Investigate a broad file conversion system.

The user should be able to convert between common formats without finding a separate utility.

Examples:
- Images between common image formats.
- Audio between supported audio formats.
- Video between supported video formats.
- Documents between compatible formats.
- PDFs and images.
- CSV and JSON.
- Markdown and HTML.
- Archive formats.

Preserve quality where possible.

Expose conversion settings where they materially affect output quality, compression, or compatibility.

Do not claim support for a conversion unless it actually works.

---

# 8. UNIVERSAL SEARCH AND CLIPBOARD

## 8.1 Universal search

Sensor should provide a global search system.

Searchable sources should include:
- Open tabs.
- Browser history.
- Bookmarks.
- Website content where indexed.
- Files.
- Folders.
- Downloads.
- Obsidian notes.
- Projects.
- Code.
- Macros.
- RSS articles.
- Saved annotations.
- Other registered Sensor resources.

Search results should identify their source and allow direct navigation.

The search architecture should support adding new searchable sources without redesigning the entire system.

**Extend.** Orca has palette search over worktrees, tabs and tasks, ripgrep content search, and agent session search. Sensor adds one FTS5 index (Sensor 1.0's `search.ts`, on the same `node:sqlite` Orca already uses) with pluggable sources. It is surfaced through Orca's palette rather than a second palette.

## 8.2 Universal clipboard

Provide a searchable clipboard history.

Support:
- Text.
- URLs.
- Images.
- Screenshots.
- Files where technically supported.

Clipboard history should be local.

Users should be able to search, reuse, and manage previous clipboard entries.

Provide privacy controls and exclusions for sensitive applications or content.

**New.** Orca's clipboard support covers image uploads and paste only. Port Sensor 1.0's clipboard watcher and history, including skipping password-manager copies via Windows clipboard format flags.

---

# 9. AUTOMATION AND MACRO RECORDER

## 9.1 Core requirement

A built-in macro recorder is a major Sensor feature.

The purpose is to eliminate repetitive computer and browser workflows.

Do not treat this as a basic keyboard recorder.

**Orca base (Extend).** Orca's automations are cron-scheduled agent runs: a prompt dispatched to a coding agent in a workspace. Its browser automation bridge drives pages for agents (snapshot, click, type, wait, tabs). Sensor's macros are a different thing: deterministic, recorded, inspectable step programs. Sensor ports its macro language and runner (`macro-lang.ts`, `macros.ts`, and the recorder in the web preload) and executes browser steps through Orca's browser automation bridge, not a parallel implementation. Macro schedules reuse Orca's cron parsing and scheduler. A macro can launch an Orca agent automation as a step, and an Orca automation can run a macro.

## 9.2 Recording modes

Support a combination of:
- Mouse and keyboard recording.
- Browser DOM and element-based recording.
- Visual/screenshot-based recording.
- Application-level Sensor actions.

Different approaches should be used according to reliability.

Prefer semantic DOM actions over fragile screen coordinates when possible.

## 9.3 Macro functionality

Macros should support:
- Variables.
- User inputs.
- Conditions.
- Loops.
- Delays.
- Error handling.
- Retry behavior.
- Checkpoints.
- Output values.
- Reusable subroutines.
- Export and import.
- Sharing.

## 9.4 Visual editor

Provide a no-code visual macro editor.

Users should be able to inspect, edit, rearrange, and configure recorded actions.

## 9.5 Automation builder

Provide a visual workflow builder using connected actions and decision nodes.

Actions should be capable of:
- Opening websites.
- Navigating tabs.
- Reading supported page content.
- Downloading files.
- Processing documents.
- Creating notes.
- Moving content between supported destinations.
- Running scripts.
- Calling CLI commands.
- Invoking other macros.
- Interacting with Sensor's own subsystems.

## 9.6 Triggers

Support triggers such as:
- Scheduled execution.
- Keyboard shortcuts.
- Download completion.
- File arrival in a folder.
- Website changes where supported.
- Agent task completion.
- Other Sensor events.

## 9.7 Boundaries

Macros should not be designed to control arbitrary external Windows applications.

The initial macro engine is focused on Sensor and its supported browser environment. Orca's `computer` (desktop computer-use) subsystem exists but is not a macro target in this phase.

AI may assist users in creating or editing macros, but macro execution must remain deterministic and inspectable.

Users should be able to toggle script/API execution capabilities and control permissions.

---

# 10. AI WEBSITE INTEGRATION

## 10.1 Important distinction

Sensor is NOT a Comet-style autonomous AI browser.

The browser should remain excellent without AI.

Sensor does not automatically turn ordinary browsing into agentic research.

AI functionality is explicitly invoked through user actions and predefined workflows.

## 10.2 Website-based AI providers

Support workflows involving normal websites such as:
- ChatGPT.
- Claude.
- Perplexity.
- Other user-configured AI services.

Use the user's normal logged-in browser sessions.

Do not require API keys for these website workflows.

Do not make API integration the foundation of the system.

**New.** Orca's AI features drive coding-agent CLIs and native chat, not chat websites. Port Sensor 1.0's `ai.ts` (send, attach, wait, read, multi-ask, per-site selector overrides). Its page operations run through Orca's browser automation bridge, with `forms:submit` kept as a separate, off-by-default permission.

## 10.3 Deterministic cross-website actions

Example: Send a PDF to ChatGPT.

1. User selects a PDF.
2. User clicks a Sensor action.
3. Sensor identifies the configured destination.
4. Sensor focuses or opens the ChatGPT tab.
5. Sensor attaches the PDF through the supported website interface.
6. Sensor optionally enters a predefined prompt.
7. User reviews and submits.

This is a browser workflow, not an AI agent autonomously deciding what to do.

The same architecture should support:
- Moving Perplexity notes into ChatGPT.
- Sending selected webpage content to Claude.
- Attaching documents to supported AI websites.
- Reusing predefined prompts.
- Opening configured AI destinations.
- Saving resulting conversations into the knowledge system.

Website automation must account for changing interfaces, login requirements, upload limitations, CAPTCHAs, and service restrictions.

Do not promise reliable automation where a provider's interface does not support it.

## 10.4 Provider configuration

Users should be able to define destinations.

Example:

| Destination | Intended use |
|---|---|
| ChatGPT | General reasoning |
| Claude | Coding and analysis |
| Perplexity | Web research |

These are examples, not enforced roles.

Allow custom providers and custom workflows.

Support account switching workflows, but do not prioritize simultaneous multiple accounts for the same provider.

## 10.5 Multi-model workflow

Provide a convenient workflow for sending a question to multiple AI websites.

The purpose is to make using several providers easier.

This does not require building an autonomous multi-agent debate engine or an API-powered consensus system.

The user should be able to open the same question across configured providers and conveniently compare their responses.

Support a dedicated research workspace where multiple AI websites can be visible simultaneously.

---

# 11. DEVELOPMENT ENVIRONMENT

## 11.1 Purpose

Sensor should incorporate a powerful agentic development environment.

It should provide the capabilities expected from modern development environments, including:
- Integrated terminals.
- Project management.
- Git integration.
- Git worktrees.
- Coding agent sessions.
- Agent usage tracking where available.
- Skills and project instructions.
- Browser access.
- Project files.
- Diff inspection.
- Testing.
- Agent orchestration.

The development environment should be integrated with the browser and other Sensor components.

**Orca.** This entire section is Orca's core product: terminals, projects, git, worktrees, agent sessions, usage tracking, skills, diff review, browser access and orchestration. Sensor does not rebuild any of it. Sensor 1.0's `dev.ts`, terminals, agent adapters and Orca CLI bridge are **discarded**. Sensor's work here is limited to connecting the development environment to the rest of Sensor: links from notes and research items to workspaces and agent sessions, macros that start agent runs, and universal search over projects.

## 11.2 Agent support

Investigate support for different coding agents and CLI-based tools.

Potential integrations include:
- Claude Code.
- OpenCode.
- Codex.
- Other compatible command-line agents.

Do not assume all agents support identical capabilities.

Use adapters to normalize available operations while preserving runtime-specific behavior.

## 11.3 Agent coordination

Sensor should support coordinated multi-agent development.

The intended workflow:

1. User defines a task.
2. Sensor assigns work to suitable agents.
3. Agents work independently, preferably in separate Git worktrees.
4. Agents can communicate relevant information and request handoffs.
5. Sensor tracks task dependencies and completion.
6. An integration agent reviews and combines completed work.
7. Tests and validation run.
8. Risky merges and destructive operations require appropriate approval.

The system should be mostly automatic, with explicit agent-requested handoffs where needed.

Agents should not directly overwrite one another's work.

## 11.4 Shared project context

Sensor should maintain structured project state.

Potential information:
- Active tasks.
- Assigned agents.
- Worktree ownership.
- Dependencies.
- Shared interfaces.
- Relevant decisions.
- Pending handoffs.
- Completed work.
- Validation status.
- Integration status.

Avoid relying exclusively on agents remembering context through conversation history.

Before adding anything here, check Orca's existing task, handoff and agent-session state. Sensor 1.0's tasks, handoffs and decisions are ported only where Orca has no equivalent, and then as extensions of Orca's models.

## 11.5 Safety

Protect:
- Main branches.
- Existing user files.
- Uncommitted changes.
- Project configuration.
- Credentials.
- Destructive operations.

Use isolated worktrees and controlled integration.

Provide transparent approval requirements.

---

# 12. COMMAND CENTER

## 12.1 Status bar

Provide a persistent configurable status area.

Potential indicators:
- Agent activity.
- CPU usage.
- RAM usage.
- Browser memory consumption.
- Disk activity.
- Network activity.
- Downloads.
- Active automations.
- Notifications.
- Other relevant Sensor state.

Avoid displaying unnecessary information constantly.

**Extend.** Orca already collects per-process memory (`src/main/memory`) and agent status. Sensor adds a persistent status bar that surfaces those values together with Sensor's own indicators (downloads, macros, indexing).

## 12.2 Command palette

A universal command palette should expose Sensor functionality.

Users should be able to:
- Open tabs.
- Switch workspaces.
- Search files.
- Search notes.
- Launch projects.
- Run macros.
- Execute commands.
- Open panels.
- Access utilities.
- Invoke configured workflows.

The command palette should be fast and keyboard-friendly.

**Extend.** Orca's jump palette (`WorktreeJumpPalette`) is the one palette. Sensor contributes its commands and search sources to it, and does not add a second palette.

## 12.3 Keyboard shortcuts

Provide customizable shortcuts for important operations.

Do not force every tiny feature to have its own shortcut.

Avoid shortcut conflicts.

## 12.4 Notifications

Provide a unified notification center for:
- Agent task completion.
- Agent errors.
- Macro failures.
- Downloads.
- RSS updates.
- Automation events.
- Other important application events.

Users should be able to configure notification behavior.

**Orca base.** Orca's notification system and card stack are used. Sensor adds event types for its own subsystems.

---

# 13. RSS AND RESEARCH

Provide a built-in RSS reader.

Support:
- Feed subscriptions.
- Folders.
- Unread tracking.
- Search.
- Filtering.
- Notifications.
- Saved articles.
- Links to notes and collections.

Provide reading lists and research collections.

Research items should be capable of linking to:
- Notes.
- PDFs.
- Websites.
- AI conversations.
- Projects.
- Other files.

Do not turn the RSS reader into an autonomous AI research agent.

**New.** Port Sensor 1.0's `rss.ts` (fast-xml-parser, feed discovery, collections) as a Sensor pane.

---

# 14. CLI AND LOCAL API

## 14.1 Critical architectural requirement

Everything in Sensor should be accessible through the GUI and, wherever technically applicable, through the CLI.

The CLI is a first-class interface to the application.

It must not be an afterthought.

The objective is to allow external agents, developers, scripts, and users to control Sensor from completely separate terminals.

**Orca base (Extend).** Orca already satisfies the architectural core of this requirement. Its runtime RPC (`src/main/runtime/rpc`, `defineMethod`, typed contracts in `src/shared/rpc-contract`) is the local API. The `orca` CLI (`src/cli`, handler groups) is a client of it, and the same RPC also serves the renderer, remote runtimes and mobile. Sensor adds RPC methods and CLI handler groups for each Sensor subsystem (`notes`, `annotations`, `files`, `docs`, `clipboard`, `rss`, `search`, `macros`, `ai`, `checkpoints`, `bookmarks`, `history`). Sensor 1.0's separate command bus, named-pipe server and Go CLI are **discarded**. The shipped binary keeps Orca's CLI; whether Sensor also installs a `sensor` alias is decided in PORT-PLAN Phase 0.

## 14.2 CLI functionality

The CLI should expose operations for:
- Listing and switching workspaces.
- Listing, opening, closing, and inspecting tabs.
- Reading supported page content.
- Accessing selected text.
- Managing panels.
- Searching Sensor resources.
- Accessing files.
- Processing documents.
- Creating and accessing notes.
- Managing downloads.
- Running macros.
- Managing automations.
- Inspecting agent activity.
- Managing projects.
- Reading application state.
- Monitoring events.
- Other supported Sensor functionality.

The exact command structure should be designed during architecture development.

## 14.3 Local API

Provide a documented local API for external applications.

It should expose the same underlying capabilities as the CLI where appropriate.

The CLI should be a convenient client of the underlying application interfaces rather than a completely separate implementation.

## 14.4 Events and subscriptions

Support event-driven interaction.

Examples:
- Tab changed.
- Download completed.
- File created.
- Macro completed.
- Macro failed.
- Agent finished.
- Workspace changed.
- Project updated.

An external process should be able to subscribe to relevant events.

## 14.5 Permissions

Provide granular permissions.

Examples:
- Read browser tabs.
- Read page content.
- Read notes.
- Access project files.
- Create notes.
- Execute macros.
- Download files.
- Move files.
- Delete files.
- Submit website forms.

Permissions should be explicit, inspectable, and configurable.

Do not expose an unrestricted local control interface without authentication or access controls.

**Extend.** Orca's RPC already authenticates callers (device keys, E2EE channels for remote and mobile) and its plugin host checks capabilities and writes an audit log. Sensor's granular scopes (`files:delete`, `forms:submit`, `scripts:exec`, `notes:write`, and so on) are enforced on Sensor's RPC methods using Orca's caller identity and audit log. They are not enforced by a parallel permission system. Destructive Sensor operations prompt in the app unless the caller holds the scope.

## 14.6 MCP

MCP is not a required architectural foundation.

Sensor should have its own CLI and local API.

Optional compatibility adapters may be considered in the future, but should not dictate the core design.

## 14.7 Scripting and extensions

Users should be able to create:
- Custom commands.
- Custom buttons.
- Scripts.
- Personal workflows.
- Custom panels.
- Integrations.

The scripting environment should be documented and permission-controlled.

**Orca base (Extend).** Orca's plugin system (manifest v2: data, declarative, sandboxed-UI panels, trusted workers; capability-checked host API; catalog; audit log) is Sensor's extension mechanism. Custom commands, buttons, panels and integrations are Orca plugins. Sensor extends the plugin host API with Sensor methods (for example `notes.capture` and `macros.run`) so plugins can reach Sensor features. Sensor 1.0's worker-thread user scripts are reimplemented as trusted-worker plugins, or not at all.

---

# 15. SYNCHRONIZATION AND STORAGE

## 15.1 Local-first

Sensor should store user data locally by default.

It should work offline wherever possible.

Avoid mandatory cloud accounts and unnecessary external dependencies.

## 15.2 Multi-computer synchronization

Support optional synchronization between a user's computers.

Potential synchronized information:
- Workspaces.
- Settings.
- Notes and relevant Obsidian data.
- Macros.
- Custom commands.
- Layouts.
- Other user-selected configuration.

The underlying Obsidian vault should remain compatible with existing storage.

## 15.3 Sync architecture

The exact transport is unresolved.

Investigate:
- Peer-to-peer synchronization.
- Local-network synchronization.
- Optional encrypted cloud relay.
- Conflict resolution.
- Offline synchronization.
- Selective synchronization.

No mandatory cloud dependency.

Encryption and privacy must be considered from the beginning.

Orca's remote runtime, SSH hosts and cloud services are inherited and optional. They must never be required for Sensor features to work locally. Sensor sync is a later phase. Evaluate Orca's remote runtime protocol as the transport before designing anything new.

## 15.4 Backup system

Implement lightweight automatic rolling checkpoints.

The user's requested behavior:

- Maintain the current checkpoint.
- Maintain one previous checkpoint.
- When a new checkpoint is created, delete the older previous checkpoint.
- Maximum of two checkpoints at any time.

Backups should be incremental or otherwise storage-efficient where possible.

Avoid unnecessarily duplicating large files.

The user should be able to restore the previous checkpoint.

Protect against interrupted or incomplete checkpoint creation.

**New.** Port Sensor 1.0's `backup.ts` (two verified rolling slots, staged restore). It covers Sensor data and Orca's settings and state databases. It uses Orca's durable-file-write helpers rather than its own.

---

# 16. PRIVACY AND SECURITY

Requirements:
- Local-first storage.
- Offline functionality wherever possible.
- Optional synchronization.
- Explicit permissions.
- Browser profile isolation.
- Incognito mode.
- Sensitive clipboard exclusions.
- Protected credentials.
- Safe local API access.
- Transparent automation permissions.
- Controlled file operations.
- Protected Git worktrees and branches.

Incognito mode should not retain the browsing activity it is intended to keep private.

Do not silently upload user data to external services.

Website-based AI workflows must clearly use the user's logged-in sessions.

**Inherited from Orca, with Sensor defaults:**
- Orca ships opt-in PostHog telemetry behind a consent banner, plus crash reporting. Sensor builds default telemetry to **off**, show no consent banner pressuring an opt-in, and point any reporting endpoints at nothing unless the user configures one. The PostHog key is removed from Sensor builds.
- Orca's cloud features (artifact sharing, connector cloud, cloud runtimes, mobile pairing) stay available but disabled until the user turns them on. Sensor never uploads user data as a side effect of a Sensor feature.
- Orca's update channel is replaced with Sensor's own, or disabled. A Sensor build must never auto-update itself into stock Orca.

---

# 17. PERFORMANCE REQUIREMENTS

Performance is a core product requirement.

The application must not become a resource-heavy collection of embedded applications.

**Orca base.** Orca is large: tens of thousands of TypeScript files, React, a daemon and many agent integrations. Sensor accepts that baseline in exchange for not rebuilding it, and measures everything against it. Orca already has performance contract tests, benchmarks (`test:perf:*`), lint audits and memory collectors. Sensor reuses them. Sensor 1.0's `bench.mjs` scenarios (startup, idle RAM, tab, search, API latency) are ported into Orca's benchmark harness. Every Sensor subsystem must be lazy: zero cost until first used, with no background work while disabled.

## 17.1 Primary objectives

- Low idle RAM usage.
- Fast startup.
- Fast tab switching.
- Responsive interface.
- Efficient background processing.
- Efficient search indexing.
- Controlled CPU usage.
- Minimal unnecessary background services.
- Efficient panel rendering.
- Intelligent suspension of inactive content.

## 17.2 Performance mode

Provide a performance mode that can:
- Suspend inactive tabs.
- Reduce background activity.
- Limit unnecessary processes.
- Control background refresh.
- Reduce resource consumption.
- Preserve active work.

Do not break user workflows silently.

## 17.3 Resource monitoring

Expose resource usage for:
- Sensor itself.
- Browser processes.
- Tabs where measurable.
- Panels.
- Background indexing.
- Automations.
- Other major subsystems.

## 17.4 Benchmarking

Establish measurable benchmarks.

At minimum:
- Cold startup time.
- Warm startup time.
- Idle RAM usage.
- RAM usage with multiple tabs.
- RAM usage with multiple panels.
- CPU usage at idle.
- Tab switching latency.
- Search latency.
- File indexing performance.
- Macro execution overhead.

Compare viable browser architectures under the same workload.

Do not invent performance numbers.

The user's primary machine has an RTX 4060 with 8 GB VRAM, 32 GB DDR5 RAM, and an Intel i7-class CPU. The application should also be designed efficiently enough to avoid requiring high-end hardware for ordinary browsing and productivity.

---

# 18. NON-GOALS AND BOUNDARIES

Sensor should not:
- Become a Comet-style autonomous browsing agent.
- Require AI for normal browsing.
- Require API keys for website-based AI workflows.
- Rebuild Obsidian unnecessarily.
- Rebuild YouTube.
- Rebuild Discord.
- Rebuild Google Docs.
- Replace Windows' filesystem.
- Require MCP as its core integration system.
- Require a cloud account.
- Require a mobile companion application. (Orca's mobile app is inherited and optional. Sensor features need not reach mobile in early phases.)
- Prioritize remote desktop control.
- Rebuild anything Orca already provides.
- Diverge from Orca so far that upstream Orca releases can no longer be merged.
- Control arbitrary external Windows applications through the initial macro engine.
- Become a bloated collection of unrelated utilities.

Integration and shared context are the product.

---

# 19. IMPLEMENTATION STRATEGY

Do not begin by implementing every feature simultaneously.

Sensor is too broad for an uncontrolled implementation. The foundation already exists: it is Orca. Every phase below adds Sensor capability on top of a working, releasable Orca fork. The detailed engineering plan, file locations and acceptance tests are in [PORT-PLAN.md](./PORT-PLAN.md).

Sensor 1.0 (the SolidJS app on the `main` branch) is a **parts bin**, not a base. Its Electron-free services in `src/core/services/` are ported where Orca lacks the feature. Its shell, renderer, command bus, Go CLI, terminals and dev environment are discarded.

## Phase 0 — Fork baseline

1. Fork Orca at a pinned upstream commit onto the `orca-base` branch, keeping Orca's git history so upstream merges stay possible.
2. Build, typecheck and run Orca's own test suite on Windows 11 unchanged. Record the results and any Windows-specific failures.
3. Rebrand the minimum required to ship separately: app id, product name, icons, data directory, update channel. Do it in one isolated commit so upstream merges stay easy.
4. Apply Sensor's privacy defaults (§16): telemetry off, no consent banner, cloud features off by default.
5. Decide the open structural questions, record each as a decision in PORT-PLAN, and update this PRD:
   - Where Sensor modules live in Orca's tree.
   - How Sensor scopes sit on Orca's RPC caller identity.
   - Whether non-project workspaces are folder workspaces or a new workspace kind.
   - The CLI binary name.
6. Capture baseline benchmarks of unmodified Orca on the user's machine.

Exit: a Sensor-branded Orca build that passes Orca's tests on Windows, with telemetry off and baseline numbers recorded.

## Phase 1 — Sensor foundation inside Orca

Build the shared pieces every later phase needs, as native Orca modules:

- Sensor storage: one `node:sqlite` database under Orca's data directory, with migrations.
- Sensor scopes and permission prompts on top of Orca's RPC caller identity and audit log.
- The universal search index (FTS5) with a source-registration interface. It is surfaced in Orca's palette.
- Sensor pane and tab types registered with Orca's layout.
- The Sensor status bar.
- CLI handler-group and RPC-contract scaffolding for Sensor subsystems.

Exit: an empty Sensor pane opens from the palette, a Sensor RPC method is callable from the `orca` CLI with scope enforcement, and search returns results from one real source (open tabs).

## Phase 2 — Knowledge: Obsidian, notes, highlights

- Vault discovery, notes and captures (page, selection, link, YouTube timestamp), and backlinks.
- Obsidian window docking pane (Windows); open-in-Obsidian elsewhere.
- The `sensor-bridge` Obsidian plugin, updated to talk to Orca's RPC.
- Persistent highlights and sticky notes built on Orca's annotate overlay.
- Search sources: notes and annotations.

## Phase 3 — Browser power features

- Bookmarks, global history, downloads manager, incognito verification, custom search engines, tab groups, browser tabs outside project workspaces, and website panels.
- Deterministic page recognition and context actions.
- AI-website workflows (send, attach, wait, read, multi-ask, prompt templates, conversation capture) on Orca's browser automation bridge.
- The macro recorder, language, runner and editor, with browser steps executed through Orca's bridge and schedules on Orca's cron scheduler.
- Search sources: bookmarks, history, macros.

## Phase 4 — Files and documents

- File tools beyond workspaces: batch rename, duplicates, tags, zip and unzip, recent files, and a worker-thread content index.
- The PDF toolkit and conversions (images via Chromium; ffmpeg, pandoc and qpdf only when found).
- Clipboard history with sensitive-content exclusion.
- The RSS reader and research collections.
- Search sources: files, clipboard, RSS.

## Phase 5 — Checkpoints and polish

- Rolling two-slot checkpoints covering Sensor and Orca state.
- Notifications for Sensor events.
- Benchmarks of every Sensor subsystem against the Phase 0 baseline.
- An upstream merge rehearsal: merge the latest Orca `main` into `orca-base` and record the conflict surface.

## Phase 6 — Advanced integration

- The plugin host API extended with Sensor methods.
- Custom commands, buttons and panels as plugins.
- Visual macro and workflow builder.
- Sync (evaluate Orca's remote runtime first).
- Performance mode.
- Advanced workspace customization.

Later possibilities: community layouts, Sensor plugins in Orca's catalog, additional platform polish.

---

# 20. ARCHITECTURAL REQUIREMENTS

Sensor adopts Orca's architecture. It does not introduce a second one.

| PRD concept | Where it lives in Sensor |
|---|---|
| Shared application core | Orca main process (`src/main`) |
| Browser engine abstraction | Orca browser (`src/main/browser`, `browser-pane`), extended |
| Workspace manager, panel manager | Orca workspaces, split layout and renderer store slices, extended with Sensor pane types |
| Resource registry, search/indexing | New Sensor search module with pluggable sources, on `node:sqlite` |
| Event bus | Orca runtime events and client events, plus Sensor event types |
| Local database | Orca's `node:sqlite` helpers plus a Sensor database |
| File service | Orca file RPC, extended with Sensor file tools |
| Document processing | New Sensor documents module |
| Automation engine | New Sensor macro engine; scheduling via Orca automations |
| CLI client | Orca CLI (`src/cli`) with Sensor handler groups |
| Local API server | Orca runtime RPC with Sensor methods and contracts |
| Agent runtime adapters | Orca, unchanged |
| Permission manager | Sensor scopes on Orca's caller identity, audit log and approval prompts |
| Synchronization engine | Later phase; Orca remote runtime evaluated first |
| Extensions | Orca plugin system, with Sensor host methods |

Fork-hygiene requirements:

- **Isolation.** Sensor code goes in clearly named Sensor modules (proposed: `src/main/sensor/<subsystem>/`, `src/shared/sensor/`, `src/renderer/src/sensor/`, `src/cli/sensor-*`). Edits to Orca files are limited to registration points: method lists, handler-group manifests, pane-type registries and settings schemas. Each such edit is kept small and listed in PORT-PLAN.
- **Conventions.** Sensor code follows Orca's `AGENTS.md`: no vague file names, checked types instead of assertions, minimal comments, cross-platform guards, folder-workspace awareness, and design-system tokens.
- **Upstream merges.** `orca-base` regularly merges upstream Orca `main`. A Sensor change that makes those merges substantially harder needs a written reason in PORT-PLAN.
- **Dependencies.** Prefer Orca's existing dependencies. New dependencies (for example pdf-lib, fast-xml-parser, turndown or fflate, carried over from Sensor 1.0) must pass Orca's dependency security check.

---

# 21. REQUIRED DELIVERABLES

Sensor 1.0's Phase 0 documents (`docs/phase0/` on `main`) assumed a from-scratch build and are superseded. The deliverables for the Orca-based Sensor are:

### A. Port plan — [PORT-PLAN.md](./PORT-PLAN.md)
Feature-by-feature map: for every PRD feature, whether Orca has it, Sensor extends it, or Sensor adds it; the source in Sensor 1.0 being ported; the target location in Orca's tree; the RPC/CLI surface; and the acceptance test.

### B. Decision log
Kept in PORT-PLAN. One entry per structural decision made during Phase 0 and after, with the alternatives considered.

### C. Orca touch-point list
Every Orca file Sensor modifies, and why. It is reviewed at each upstream merge.

### D. Risk register
Kept in PORT-PLAN. It covers upstream divergence, Electron extension limits, Win32 Obsidian embedding, AI-site selector churn, Orca telemetry and cloud defaults, license obligations (MIT attribution for Orca), and performance of the combined app.

### E. Benchmarks
Stock Orca baseline (Phase 0) and Sensor deltas per phase, recorded on the user's machine. No invented numbers.

---

# 22. DEVELOPMENT RULES

These rules apply throughout implementation.

1. Do not blindly start coding before understanding the existing codebase.
2. Do not rewrite working components without a concrete reason.
3. Prefer integrating proven software over reinventing it.
4. Do not create placeholder features and pretend they are functional.
5. Do not sacrifice performance for unnecessary abstraction.
6. Do not sacrifice maintainability for short-term implementation speed.
7. Keep subsystems modular.
8. Document public CLI and API interfaces.
9. Test functionality, not just whether the application compiles.
10. Test resource usage throughout development.
11. Protect existing user data.
12. Use version control and isolated worktrees where appropriate.
13. Keep implementation decisions documented.
14. Clearly distinguish implemented, partially implemented, planned, and unsupported features.
15. When a technical requirement is infeasible, explain why and propose alternatives rather than silently changing the product vision.
16. Do not assume a feature requires AI just because AI could technically perform it.
17. Do not introduce mandatory cloud services or API keys.
18. Do not treat every subsystem as a separate application.
19. **Orca first.** Before writing anything, check whether Orca already does it. Extend Orca's implementation rather than building a parallel one (this is also Orca's own "Reuse Before Reimplementing" rule).
20. **Follow Orca's rules.** Orca's `AGENTS.md`, `docs/STYLEGUIDE.md`, lint, ratchets and test conventions apply to Sensor code. Run apps and tests in the background (`ORCA_BACKGROUND_LAUNCH=1`) as Orca requires.
21. **Keep the fork mergeable.** Sensor code lives in Sensor modules, and Orca files are touched only at registration points (§20). Every Orca touch point is listed in PORT-PLAN.
22. **Port, don't transliterate.** When lifting Sensor 1.0 code, keep its tested logic but rewrite its seams to Orca's APIs (RPC contracts, store slices, browser bridge, scheduler). Bring its unit tests along and convert them to Orca's test setup.
23. **Keep Orca green on Windows.** A Sensor change must not regress Orca's own tests on Windows 11.

---

# 23. FINAL PRODUCT DEFINITION

Sensor should become the application people use to interact with their computer and the internet.

It should bring together:
- Browsing.
- Development.
- Agentic coding.
- Files.
- Documents.
- Notes.
- Research.
- Communication.
- Automation.
- AI websites.
- Utilities.
- Custom tools.
- System information.

The individual services remain themselves.

Obsidian remains Obsidian. YouTube remains YouTube. Discord remains Discord. ChatGPT remains ChatGPT.

Sensor makes them accessible, connected, and useful together.

The user should not have to constantly switch applications, manually transfer context, or hunt for tiny utilities.

The defining experience is:

**Everything at your fingertips. One integrated environment. No unnecessary friction.**

Sensor should feel less like another application and more like a better way to use a computer.

---

# INSTRUCTIONS TO THE IMPLEMENTING AGENT

You are being given this PRD as the product specification for Sensor.

The foundation is decided: **Sensor is a fork of Orca.** Do not re-open that decision, and do not build Sensor features as a separate application beside Orca.

Your first responsibility is to understand the part of Orca you are about to touch, then add Sensor capability to it in Orca's own style.

Do not immediately begin implementing the entire PRD.

Start with Phase 0 in [PORT-PLAN.md](./PORT-PLAN.md): get the fork building and green on Windows, apply the privacy defaults, record baselines, and settle the open decisions.

Use Sensor 1.0 (branch `main`) as a source of tested logic to port, not as a structure to copy.

Preserve existing work: the user's data, Orca's behavior, and Sensor 1.0's history on `main`.

Be critical. Challenge technical assumptions when necessary, but do not casually discard product requirements.

Where details are unspecified, make reasonable engineering proposals and clearly document them.

Do not repeatedly ask the user obvious product questions already answered in this document.

The goal is to turn this specification into a technically sound implementation plan, then build Sensor incrementally.

**The product vision is established. Your job is to engineer it without losing that vision.**
