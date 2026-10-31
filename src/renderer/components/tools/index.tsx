import type { Component } from 'solid-js';
import { BookmarksTool, DownloadsTool, HistoryTool, NotificationsTool, SearchTool, SettingsTool } from './core-tools';
import { AnnotationsTool, ClipboardTool, DocumentsTool, FilesTool, NotesTool, ObsidianTool, RssTool } from './knowledge-tools';
import { TerminalTool } from './terminal-tool';
import { AiTool, BackupsTool, MacrosTool, ProjectsTool } from './workflow-tools';

export interface ToolDef {
  title: string;
  short?: string;
  glyph: string;
  sidebar?: boolean;
  component: Component<{ leafId: string; state?: any }>;
}

// Only tools that are actually implemented are registered here.
export const TOOLS: Record<string, ToolDef> = {
  search: { title: 'Search', glyph: '⌕', component: SearchTool },
  notes: { title: 'Notes', glyph: '✎', component: NotesTool },
  obsidian: { title: 'Obsidian', glyph: '◆', component: ObsidianTool },
  files: { title: 'Files', glyph: '▤', component: FilesTool },
  documents: { title: 'PDF & Convert', short: 'Docs', glyph: '⎙', component: DocumentsTool },
  annotations: { title: 'Annotations', short: 'Annot.', glyph: '✦', component: AnnotationsTool },
  clipboard: { title: 'Clipboard', glyph: '⎘', component: ClipboardTool },
  rss: { title: 'RSS', glyph: '≋', component: RssTool },
  terminal: { title: 'Terminal', glyph: '›_', component: TerminalTool },
  projects: { title: 'Projects & Agents', short: 'Projects', glyph: '⑂', component: ProjectsTool },
  macros: { title: 'Macros', glyph: '↻', component: MacrosTool },
  ai: { title: 'AI Sites', short: 'AI', glyph: '✧', component: AiTool },
  downloads: { title: 'Downloads', glyph: '↓', component: DownloadsTool },
  history: { title: 'History', glyph: '◷', component: HistoryTool },
  bookmarks: { title: 'Bookmarks', glyph: '☆', component: BookmarksTool },
  notifications: { title: 'Notifications', short: 'Alerts', glyph: '◉', component: NotificationsTool },
  backups: { title: 'Checkpoints', short: 'Backups', glyph: '⟲', component: BackupsTool },
  settings: { title: 'Settings', glyph: '⚙', component: SettingsTool },
};
