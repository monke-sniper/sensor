// Electron implementation of the BrowserHost: one WebContentsView per live tab.
import { BrowserWindow, Menu, WebContentsView, clipboard, session, shell, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import type { Core } from '../core/core';
import type { BrowserHost, PageFormat } from '../core/host';
import { isIncognito, NEW_TAB_URL } from '../core/services/workspaces';
import { centerScript, existsScript, focusScript, readPageScript } from './page-scripts';
import type { KeyInput } from './accelerators';

export interface ViewRect {
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LiveTab {
  view: WebContentsView;
  host: BrowserWindow | null; // window it is attached to (null = detached/hidden)
  lastVisible: number;
  loaded: Promise<void>;
  resolveLoaded: () => void;
}

export interface BrowserHooks {
  onShortcut(input: KeyInput, wc: WebContents): boolean; // returns true if handled
  contextMenuExtras(tabId: string, params: Electron.ContextMenuParams): Electron.MenuItemConstructorOptions[];
  setupSession(ses: Session, profileId: string): void;
  onViewCreated?(tabId: string, wc: WebContents): void;
}

export class ElectronBrowserHost implements BrowserHost {
  private live = new Map<string, LiveTab>();
  private sessions = new Map<string, Session>();
  private visible = new Set<string>();
  win: BrowserWindow | null = null;
  overlayOnTop: (() => void) | null = null;
  private suspendTimer: NodeJS.Timeout;

  constructor(private core: Core, private preloadPath: string, private hooks: BrowserHooks) {
    this.suspendTimer = setInterval(() => this.autoSuspend(), 60_000);
  }

  dispose(): void {
    clearInterval(this.suspendTimer);
    for (const id of [...this.live.keys()]) this.destroy(id);
  }

  sessionFor(profileId: string): Session {
    let ses = this.sessions.get(profileId);
    if (ses) return ses;
    // Incognito: in-memory partition (no "persist:" prefix), nothing touches disk.
    ses = isIncognito(profileId) ? session.fromPartition(`sensor-${profileId.replace(':', '-')}`) : session.fromPartition(`persist:profile-${profileId}`);
    this.sessions.set(profileId, ses);
    this.hooks.setupSession(ses, profileId);
    return ses;
  }

  liveWebContents(tabId: string): WebContents | null {
    const l = this.live.get(tabId);
    return l && !l.view.webContents.isDestroyed() ? l.view.webContents : null;
  }

  tabIdFor(wc: WebContents): string | null {
    for (const [id, l] of this.live) if (l.view.webContents === wc) return id;
    return null;
  }

  isLive(tabId: string): boolean {
    return !!this.liveWebContents(tabId);
  }

  ensure(tabId: string): void {
    if (this.isLive(tabId)) return;
    const tab = this.core.workspaces.tab(tabId);
    const ses = this.sessionFor(tab.profileId);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#0b0f14');
    let resolveLoaded!: () => void;
    const loaded = new Promise<void>((r) => (resolveLoaded = r));
    const entry: LiveTab = { view, host: null, lastVisible: Date.now(), loaded, resolveLoaded };
    this.live.set(tabId, entry);
    this.wire(tabId, view.webContents, entry);
    this.hooks.onViewCreated?.(tabId, view.webContents);
    view.webContents.loadURL(tab.url || NEW_TAB_URL).catch(() => {});
    this.core.workspaces.updateTab(tabId, { suspended: false }, false);
  }

  private wire(tabId: string, wc: WebContents, entry: LiveTab): void {
    const W = this.core.workspaces;
    const safeUpdate = (patch: any, persist = false) => {
      if (W.hasTab(tabId)) W.updateTab(tabId, patch, persist);
    };
    wc.on('did-start-loading', () => {
      entry.loaded = new Promise<void>((r) => (entry.resolveLoaded = r));
      safeUpdate({ loading: true });
    });
    wc.on('did-stop-loading', () => {
      entry.resolveLoaded();
      safeUpdate({ loading: false, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() });
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3) {
        entry.resolveLoaded();
        safeUpdate({ loading: false });
        this.core.events.emit('page.loadFailed', { tabId, code, desc, url });
      }
    });
    const onNav = (url: string) => {
      if (!W.hasTab(tabId)) return;
      const tab = W.tab(tabId);
      safeUpdate({ url, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }, true);
      this.core.browserData.recordVisit(url, wc.getTitle() || url, tab.profileId);
      this.core.events.emit('page.navigated', { tabId, url });
    };
    wc.on('did-navigate', (_e, url) => onNav(url));
    wc.on('did-navigate-in-page', (_e, url, isMain) => isMain && onNav(url));
    wc.on('page-title-updated', (_e, title) => {
      if (!W.hasTab(tabId)) return;
      safeUpdate({ title }, true);
      this.core.browserData.updateTitle(wc.getURL(), title, W.tab(tabId).profileId);
    });
    wc.on('page-favicon-updated', (_e, favicons) => safeUpdate({ favicon: favicons[0] ?? null }, true));
    wc.on('audio-state-changed', (e: any) => safeUpdate({ audible: !!e.audible }));
    wc.on('render-process-gone', (_e, details) => {
      this.core.events.emit('page.crashed', { tabId, reason: details.reason });
      if (details.reason !== 'clean-exit') this.core.notify('warning', 'Tab crashed', `${W.hasTab(tabId) ? W.tab(tabId).title : tabId}: ${details.reason}`, 'browser');
      this.live.delete(tabId);
      safeUpdate({ suspended: true, loading: false });
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!W.hasTab(tabId)) return { action: 'deny' };
      const tab = W.tab(tabId);
      // popups for OAuth etc. keep window.opener semantics: allow as real windows
      if (disposition === 'new-window') {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { session: this.sessionFor(tab.profileId) } } };
      }
      W.openTab({
        url,
        workspaceId: tab.workspaceId,
        profileId: isIncognito(tab.profileId) ? tab.profileId : tab.profileId,
        background: disposition === 'background-tab',
      });
      return { action: 'deny' };
    });
    wc.on('before-input-event', (event, input) => {
      if (this.hooks.onShortcut(input as KeyInput, wc)) event.preventDefault();
    });
    wc.on('context-menu', (_e, params) => this.contextMenu(tabId, wc, params));
    wc.on('found-in-page', (_e, result) => this.core.events.emit('page.found', { tabId, ...result }));
  }

  private contextMenu(tabId: string, wc: WebContents, p: Electron.ContextMenuParams): void {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.core.run('tabs.open', { url: p.linkURL, background: true }) },
        { label: 'Open Link as Panel', click: () => this.core.run('tabs.open', { url: p.linkURL, target: 'panel' }) },
        { label: 'Open Link in Incognito Tab', click: () => this.core.run('tabs.incognito', { url: p.linkURL }) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.core.run('tabs.open', { url: p.srcURL, background: true }) },
        { label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    } else if (p.selectionText) {
      items.push(
        { role: 'copy' },
        { label: `Search for “${p.selectionText.slice(0, 30)}${p.selectionText.length > 30 ? '…' : ''}”`, click: () => this.core.run('tabs.open', { url: p.selectionText }) },
        { type: 'separator' },
      );
    }
    items.push(...this.hooks.contextMenuExtras(tabId, p));
    items.push(
      { type: 'separator' },
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Save Page as PDF', click: () => this.core.run('pdf.fromPage', { id: tabId }).catch((e) => this.core.notify('error', 'PDF failed', String(e.message))) },
      { label: 'View Page Source', click: () => this.core.run('tabs.open', { url: 'view-source:' + wc.getURL() }) },
      { label: 'Inspect', click: () => { wc.inspectElement(p.x, p.y); if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' }); } },
    );
    Menu.buildFromTemplate(items).popup();
  }

  /** Attach views for visible tabs at their rects; detach (but keep alive) the rest. */
  layout(win: BrowserWindow, rects: ViewRect[]): void {
    this.win = win;
    const want = new Map(rects.map((r) => [r.tabId, r]));
    for (const [id, l] of this.live) {
      if (!want.has(id) && l.host === win) {
        win.contentView.removeChildView(l.view);
        l.host = null;
      }
    }
    this.visible = new Set(want.keys());
    for (const r of rects) {
      if (!this.core.workspaces.hasTab(r.tabId)) continue;
      this.ensure(r.tabId);
      const l = this.live.get(r.tabId)!;
      if (l.host && l.host !== win) continue; // floating elsewhere
      if (l.host !== win) {
        win.contentView.addChildView(l.view);
        l.host = win;
      }
      l.view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) });
      l.lastVisible = Date.now();
    }
    this.overlayOnTop?.();
  }

  /** Move a tab's view into another window (floating panel). */
  attachTo(tabId: string, win: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    this.ensure(tabId);
    const l = this.live.get(tabId)!;
    if (l.host && l.host !== win && !l.host.isDestroyed()) l.host.contentView.removeChildView(l.view);
    if (l.host !== win) win.contentView.addChildView(l.view);
    l.host = win;
    l.view.setBounds(bounds);
  }

  release(tabId: string): void {
    const l = this.live.get(tabId);
    if (l?.host && !l.host.isDestroyed()) l.host.contentView.removeChildView(l.view);
    if (l) l.host = null;
  }

  private autoSuspend(): void {
    const mins = this.core.settings.get<number>('browser.suspendAfterMinutes') ?? 30;
    const perf = !!this.core.settings.get('perf.mode');
    const limit = perf ? 5 * 60_000 : mins * 60_000;
    if (!limit) return;
    for (const [id, l] of this.live) {
      if (this.visible.has(id) || l.host) continue;
      if (!this.core.workspaces.hasTab(id)) continue;
      if (this.core.workspaces.tab(id).audible) continue;
      if (Date.now() - l.lastVisible > limit) this.suspend(id);
    }
  }

  // ---- BrowserHost
  navigate(tabId: string, url: string): void {
    const wc = this.liveWebContents(tabId);
    if (wc) wc.loadURL(url).catch(() => {});
    // not live: the stored URL is used when the view is created
  }
  back(tabId: string): void {
    this.liveWebContents(tabId)?.navigationHistory.goBack();
  }
  forward(tabId: string): void {
    this.liveWebContents(tabId)?.navigationHistory.goForward();
  }
  reload(tabId: string): void {
    this.liveWebContents(tabId)?.reload();
  }
  stop(tabId: string): void {
    this.liveWebContents(tabId)?.stop();
  }
  destroy(tabId: string): void {
    const l = this.live.get(tabId);
    if (!l) return;
    this.live.delete(tabId);
    if (l.host && !l.host.isDestroyed()) l.host.contentView.removeChildView(l.view);
    if (!l.view.webContents.isDestroyed()) l.view.webContents.close();
  }
  suspend(tabId: string): void {
    this.destroy(tabId);
    if (this.core.workspaces.hasTab(tabId)) this.core.workspaces.updateTab(tabId, { suspended: true, loading: false }, false);
  }
  async waitForLoad(tabId: string, timeoutMs: number): Promise<void> {
    const l = this.live.get(tabId);
    if (!l) return;
    if (!l.view.webContents.isLoading()) return;
    await Promise.race([l.loaded, new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  private wcOrThrow(tabId: string): WebContents {
    this.ensure(tabId);
    const wc = this.liveWebContents(tabId);
    if (!wc) throw new Error(`tab not live: ${tabId}`);
    return wc;
  }
  async readPage(tabId: string, format: PageFormat) {
    const wc = this.wcOrThrow(tabId);
    if (wc.getURL().startsWith('sensor:')) return { url: wc.getURL(), title: wc.getTitle(), content: '' };
    return wc.executeJavaScript(readPageScript(format));
  }
  async selection(tabId: string): Promise<string> {
    const wc = this.liveWebContents(tabId);
    if (!wc) return '';
    return wc.executeJavaScript('String(getSelection() || "")');
  }
  async exec(tabId: string, js: string): Promise<any> {
    return this.wcOrThrow(tabId).executeJavaScript(js, true);
  }
  async click(tabId: string, selectors: string[]): Promise<void> {
    const wc = this.wcOrThrow(tabId);
    const c = await wc.executeJavaScript(centerScript(selectors));
    if (!c) throw new Error(`element not found: ${selectors.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 30)); // let scrollIntoView settle
    const c2 = (await wc.executeJavaScript(centerScript([c.sel]))) ?? c;
    wc.sendInputEvent({ type: 'mouseMove', x: c2.x, y: c2.y });
    wc.sendInputEvent({ type: 'mouseDown', x: c2.x, y: c2.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: c2.x, y: c2.y, button: 'left', clickCount: 1 });
  }
  async type(tabId: string, selectors: string[], text: string, opts?: { clear?: boolean }): Promise<void> {
    const wc = this.wcOrThrow(tabId);
    const ok = await wc.executeJavaScript(focusScript(selectors, !!opts?.clear));
    if (!ok) throw new Error(`element not found: ${selectors.join(' | ')}`);
    // insertText goes through the real input pipeline, so React/ProseMirror editors see it.
    await wc.insertText(text);
  }
  async press(tabId: string, key: string): Promise<void> {
    const wc = this.wcOrThrow(tabId);
    const parts = key.split('+');
    const k = parts.pop()!;
    const modifiers = parts.map((m) => m.toLowerCase()) as any[];
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers });
    if (k.length === 1) wc.sendInputEvent({ type: 'char', keyCode: k, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers });
  }
  async waitFor(tabId: string, selectors: string[], timeoutMs: number): Promise<string> {
    const wc = this.wcOrThrow(tabId);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const sel = await wc.executeJavaScript(existsScript(selectors)).catch(() => null);
      if (sel) return sel;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timed out waiting for: ${selectors.join(' | ')}`);
  }
  async setFiles(tabId: string, selector: string, files: string[]): Promise<void> {
    const wc = this.wcOrThrow(tabId);
    const dbg = wc.debugger;
    const attached = dbg.isAttached();
    if (!attached) dbg.attach('1.3');
    try {
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`file input not found: ${selector}`);
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files });
    } finally {
      if (!attached) dbg.detach();
    }
  }
  async capture(tabId: string): Promise<Buffer> {
    const img = await this.wcOrThrow(tabId).capturePage();
    return img.toPNG();
  }
  async printToPDF(tabId: string): Promise<Buffer> {
    const wc = this.wcOrThrow(tabId);
    await this.waitForLoad(tabId, 15000);
    return wc.printToPDF({ printBackground: true, preferCSSPageSize: true });
  }
  openDevTools(tabId: string): void {
    this.wcOrThrow(tabId).openDevTools({ mode: 'detach' });
  }
  zoom(tabId: string, factor: number): void {
    this.wcOrThrow(tabId).setZoomFactor(Math.max(0.25, Math.min(5, factor)));
  }

  openExternal(url: string): void {
    shell.openExternal(url);
  }

  stats(): { live: number; visible: number } {
    return { live: [...this.live.values()].filter((l) => !l.view.webContents.isDestroyed()).length, visible: this.visible.size };
  }

  pidOf(tabId: string): number | null {
    const wc = this.liveWebContents(tabId);
    return wc ? wc.getOSProcessId() : null;
  }
}

export const WEB_PRELOAD = join(__dirname, '..', 'preload', 'web.js');
