import type { Component } from 'solid-js';
import { BookmarksTool, DownloadsTool, HistoryTool, NotificationsTool, SearchTool, SettingsTool } from './core-tools';

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
  downloads: { title: 'Downloads', glyph: '↓', component: DownloadsTool },
  history: { title: 'History', glyph: '◷', component: HistoryTool },
  bookmarks: { title: 'Bookmarks', glyph: '☆', component: BookmarksTool },
  notifications: { title: 'Notifications', short: 'Alerts', glyph: '◉', component: NotificationsTool },
  settings: { title: 'Settings', glyph: '⚙', component: SettingsTool },
};
