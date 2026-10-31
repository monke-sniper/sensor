# SENSOR — PRODUCT REQUIREMENTS DOCUMENT
**Version:** 1.0  
**Status:** Product vision and requirements established; technical architecture requires validation  
**Target platform:** Windows 11 desktop  
**Project codename:** Sensor

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

---

# 2. PRODUCT SCOPE

## 2.1 Initial platform

Windows 11 desktop is the first target.

Other platforms may be considered later, but the initial implementation should not compromise Windows performance or stability to accommodate hypothetical cross-platform requirements.

## 2.2 Core product areas

Sensor consists of interconnected subsystems:

| Subsystem | Responsibility |
|---|---|
| Browser | Primary web browsing environment |
| Workspace manager | Workspaces, layouts, tabs, profiles and panels |
| Development environment | Terminals, projects, Git, worktrees and coding agents |
| Agent coordination | Multi-agent task management and integration |
| Obsidian integration | Actual Obsidian application integration |
| File environment | File access, organization, previews and operations |
| Document tools | PDF processing and file conversion |
| Knowledge system | Connected notes, annotations and saved content |
| Automation | Macro recording, execution and visual workflows |
| AI website integration | Workflows involving normal logged-in AI websites |
| Command center | Global status, notifications, commands and system information |
| CLI | Programmatic access to Sensor functionality |
| Local API | Integration with external applications and agents |
| Synchronization | Optional synchronization across computers |

These should not be developed as completely independent applications.

They should share a common underlying application architecture.

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

## 4.2 Browser engine selection

Performance is a primary selection criterion.

Investigate:
- Chromium Embedded Framework.
- Electron.
- CEF-based alternatives.
- Existing Chromium browser codebases.
- Vivaldi-related architecture where legally and technically appropriate.
- Other viable Windows-native Chromium integration options.

Do not assume that forking Vivaldi is automatically the best choice.

Evaluate actual architecture, licensing, extension support, memory overhead, startup time, maintainability, and integration capabilities.

The goal is:

**LOW RAM. FAST STARTUP. FAST BROWSING. LOW IDLE RESOURCE CONSUMPTION.**

The browser should be benchmarked against realistic workloads, not just empty-window startup.

## 4.3 Browser panels

Websites should be capable of being opened as:
- Normal tabs.
- Docked panels.
- Floating mini-windows.
- Persistent workspace components.

Support multiple instances of different websites within a workspace.

Maintain session and profile isolation according to the user's settings.

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

---

# 5. INTEGRATED OBSIDIAN

## 5.1 Core requirement

Sensor should embed the actual Obsidian application inside its interface.

Do not casually recreate Obsidian's functionality as a replacement.

The objective is to integrate the existing application and existing user vaults.

Users should be able to access their existing Obsidian notes and vaults without migration.

Investigate the technically viable embedding and integration mechanisms.

If embedding the actual application is not technically feasible in the selected architecture, document the limitation and propose the closest genuine integration. Do not silently substitute a custom Markdown editor and call it Obsidian integration.

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

---

# 6. FILE ENVIRONMENT

## 6.1 Philosophy

Sensor is an integrated application, not an attempt to replace Windows' underlying filesystem.

It should integrate with existing Windows folders and files.

Users should be able to access and manipulate their files without constantly leaving Sensor.

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

---

# 9. AUTOMATION AND MACRO RECORDER

## 9.1 Core requirement

A built-in macro recorder is a major Sensor feature.

The purpose is to eliminate repetitive computer and browser workflows.

Do not treat this as a basic keyboard recorder.

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

The initial macro engine is focused on Sensor and its supported browser environment.

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

---

# 14. CLI AND LOCAL API

## 14.1 Critical architectural requirement

Everything in Sensor should be accessible through the GUI and, wherever technically applicable, through the CLI.

The CLI is a first-class interface to the application.

It must not be an afterthought.

The objective is to allow external agents, developers, scripts, and users to control Sensor from completely separate terminals.

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

---

# 17. PERFORMANCE REQUIREMENTS

Performance is a core product requirement.

The application must not become a resource-heavy collection of embedded applications.

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
- Require a mobile companion application.
- Prioritize remote desktop control.
- Control arbitrary external Windows applications through the initial macro engine.
- Become a bloated collection of unrelated utilities.

Integration and shared context are the product.

---

# 19. IMPLEMENTATION STRATEGY

Do not begin by implementing every feature simultaneously.

Sensor is too broad for an uncontrolled implementation.

Build a coherent foundation first.

## Phase 0 — Existing project and technology reconnaissance

Before changing code:

1. Inspect all relevant existing repositories.
2. Inspect the existing Orca implementation and architecture if available.
3. Inspect available browser codebases and integration options.
4. Inspect existing ADE capabilities.
5. Identify reusable components.
6. Identify licensing restrictions.
7. Identify architectural incompatibilities.
8. Benchmark viable browser foundations.
9. Map the application architecture.
10. Produce an implementation proposal.

Do not assume the current repository is structured as expected.

Do not overwrite or discard existing work.

Produce:
- Repository inventory.
- Architecture diagrams.
- Dependency map.
- Reuse assessment.
- Browser foundation comparison.
- Risk assessment.
- Proposed technical stack.
- Phased implementation plan.

## Phase 1 — Core Sensor shell

Build:
- Application shell.
- Window management.
- Command center layout.
- Sidebar.
- Panels.
- Workspace system.
- Persistent settings.
- Status bar.
- Command palette.
- Basic notifications.

## Phase 2 — Browser foundation

Build:
- Browser engine integration.
- Tabs.
- Profiles.
- Navigation.
- Bookmarks.
- History.
- Downloads.
- Extensions.
- Website panels.
- Session persistence.

Establish performance benchmarks early.

## Phase 3 — Shared application services

Build:
- Internal resource registry.
- Search infrastructure.
- Event system.
- File integration.
- Local storage.
- CLI.
- Local API.
- Permissions.

This phase is architecturally critical.

The browser and other components must not implement incompatible, isolated versions of the same functionality.

## Phase 4 — Knowledge and document integration

Build:
- Obsidian embedding/integration.
- Existing vault access.
- Browser annotations.
- Sticky notes.
- Content capture.
- PDF tools.
- Universal file previews.
- Conversion system.
- Clipboard history.
- RSS.

## Phase 5 — Automation

Build:
- Macro recorder.
- Macro editor.
- Deterministic execution engine.
- Variables.
- Conditions.
- Loops.
- Error handling.
- Visual workflow builder.
- Triggers.
- Import/export.
- CLI access.

## Phase 6 — Development environment

Build:
- Project management.
- Terminals.
- Git.
- Worktrees.
- Agent adapters.
- Usage tracking.
- Skills.
- Project context.
- Agent coordination.
- Integration workflow.

## Phase 7 — AI website workflows

Build:
- Provider configuration.
- Website recognition.
- Predefined prompts.
- File attachment workflows.
- Cross-provider content transfer.
- Multi-model research workspace.
- Conversation capture.

## Phase 8 — Advanced integration

Build:
- Advanced scripting.
- Custom panels.
- Custom commands.
- Custom buttons.
- Advanced synchronization.
- Performance optimization.
- Advanced workspace customization.

Later possibilities:
- Community layouts.
- Extension ecosystem.
- Marketplace.
- Additional platform support.

---

# 20. ARCHITECTURAL REQUIREMENTS

The implementation should favor a modular architecture.

Potential architectural concepts to investigate:

- Shared application core.
- Browser engine abstraction.
- Workspace manager.
- Panel manager.
- Resource registry.
- Event bus.
- Local database.
- File service.
- Search/indexing service.
- Document processing service.
- Automation engine.
- CLI client.
- Local API server.
- Agent runtime adapters.
- Permission manager.
- Synchronization engine.

These are architectural requirements and concepts, not an instruction to blindly adopt a specific framework.

The technology stack must be chosen after repository reconnaissance.

Favor existing, proven libraries and components.

Avoid unnecessary dependencies and duplicated functionality.

Avoid designing a monolith where every feature depends on every other feature.

---

# 21. REQUIRED DELIVERABLES BEFORE IMPLEMENTATION

Before making significant modifications, produce the following.

### A. Architecture document

Explain:
- Application structure.
- Process boundaries.
- Browser architecture.
- Data flow.
- Storage.
- Event system.
- CLI/API.
- Permissions.
- Agent integration.

### B. Feature-to-component mapping

Every major feature must map to:
- A subsystem.
- Required dependencies.
- User-facing interface.
- CLI/API capability.
- Data requirements.
- Implementation phase.

### C. Technology evaluation

Compare relevant options for:
- Browser engine.
- Desktop framework.
- Database.
- Search indexing.
- PDF processing.
- File conversion.
- Macro execution.
- Obsidian embedding.
- Terminal integration.
- Synchronization.

Include actual tradeoffs.

### D. Risk register

Identify:
- High-risk integrations.
- Licensing concerns.
- Performance risks.
- Security concerns.
- Uncertain technical feasibility.
- Long-term maintenance problems.

### E. Implementation roadmap

Provide:
- Dependency order.
- Milestones.
- Test strategy.
- Performance targets.
- Incremental deliverables.

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

Your first responsibility is to understand the existing codebase and determine the best way to realize this product.

Do not immediately begin implementing the entire PRD.

Start with Phase 0.

Inspect the repository, identify existing functionality, investigate reusable projects, evaluate architecture, and produce the required deliverables.

Preserve existing work.

Be critical. Challenge technical assumptions when necessary, but do not casually discard product requirements.

Where details are unspecified, make reasonable engineering proposals and clearly document them.

Do not repeatedly ask the user obvious product questions already answered in this document.

The goal is to turn this specification into a technically sound implementation plan, then build Sensor incrementally.

**The product vision is established. Your job is to engineer it without losing that vision.**
