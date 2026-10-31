// Modules that need Electron (clipboard watcher, Obsidian window embedding, terminals, ...).
import type { BrowserWindow, WebContentsView } from 'electron';
import type { CoreModule } from '../core/core';
import type { ElectronBrowserHost } from './browser';

export interface MainRefs {
  win: BrowserWindow;
  browserHost: ElectronBrowserHost;
  overlay: WebContentsView;
}

export function mainModules(_refs: () => MainRefs): CoreModule[] {
  return [];
}
