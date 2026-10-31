// Electron main process: boots the core, the main window, the browser host,
// the shell/overlay renderers and the local API.
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, WebContentsView, screen, type Session, type WebContents } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { Core } from '../core/core';
import type { CommandDef } from '../core/commands';
import { allModules } from '../core/modules';
import { principalLabel } from '../core/permissions';
import { isIncognito } from '../core/services/workspaces';
import { ShortcutMap, type KeyInput } from './accelerators';
import { ElectronBrowserHost, WEB_PRELOAD, type ViewRect } from './browser';
import { electronPlatformHost } from './platform';
import { newTabPage, resourcePage } from './newtab';
import { startApiServer, type ApiServer } from '../core/api/server';
import { mainModules } from './modules';

protocol.registerSchemesAsPrivileged([{ scheme: 'sensor', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);

const isTest = !!process.env.SENSOR_TEST;
if (process.env.SENSOR_DATA_DIR) app.setPath('userData', join(process.env.SENSOR_DATA_DIR, 'electron'));
else app.setPath('userData', join(app.getPath('appData'), 'Sensor'));
// Must match defaultDataDir() in core/api/server.ts so the CLI finds its token.
const dataDir = process.env.SENSOR_DATA_DIR || join(app.getPath('userData'), 'data');

if (!isTest && !app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName('Sensor');
// Sites (notably Google sign-in) reject user agents that advertise Electron.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|sensor)\/\S+/gi, '');

let core: Core;
let win: BrowserWindow;
let overlay: WebContentsView;
let overlayOpen = false;
let browserHost: ElectronBrowserHost;
let api: ApiServer | null = null;
const shortcuts = new ShortcutMap();
const floating = new Map<string, BrowserWindow>(); // tabId -> window

const SHELL_PRELOAD = join(__dirname, '..', 'preload', 'shell.js');
const RENDERER_HTML = join(__dirname, '..', 'renderer', 'index.html');

function sendToShell(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  if (overlay && !overlay.webContents.isDestroyed()) overlay.webContents.send(channel, payload);
}

function rebuildShortcuts(): void {
  const overrides = core.settings.get<Record<string, string>>('shortcuts.overrides') ?? {};
  const map: Record<string, string> = {};
  for (const c of core.bus.list()) if (c.shortcut) map[c.id] = c.shortcut;
  Object.assign(map, overrides);
  shortcuts.set(map);
}

let shellFocusContext = 'none';

function handleShortcut(input: KeyInput, wc: WebContents): boolean {
  if (input.type !== 'keyDown') return false;
  // A focused terminal gets the keyboard, except Ctrl+Shift chords, Alt+arrows and F-keys.
  if (shellFocusContext === 'terminal' && win && wc === win.webContents) {
    const passthrough = (input.control && input.shift) || (input.alt && /^Arrow/.test(input.key)) || /^F\d+$/.test(input.key);
    if (!passthrough) return false;
  }
  // Ctrl+1..9 -> tab by index
  if ((process.platform === 'darwin' ? input.meta : input.control) && !input.alt && !input.shift && /^Digit[1-9]$/.test(input.code ?? '')) {
    core.run('tabs.activateIndex', { index: Number(input.code!.slice(5)) - 1 }).catch(() => {});
    return true;
  }
  if (input.key === 'Escape' && overlayOpen) {
    setOverlay(false);
    return true;
  }
  const cmd = shortcuts.match(input);
  if (!cmd) return false;
  core.run(cmd).catch((e) => core.notify('error', `Command failed: ${cmd}`, String(e.message ?? e)));
  return true;
}

function setOverlay(open: boolean): void {
  overlayOpen = open;
  if (!win || win.isDestroyed()) return;
  if (open) {
    const [w, h] = win.getContentSize();
    overlay.setBounds({ x: 0, y: 0, width: w, height: h });
    win.contentView.addChildView(overlay); // re-adding moves it to the top
    overlay.setVisible(true);
    overlay.webContents.focus();
  } else {
    overlay.setVisible(false);
    win.webContents.focus();
  }
  sendToShell('sensor:overlay', { open });
  core.events.emit('ui.overlay', { open });
}

function setupSession(ses: Session, profileId: string): void {
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|sensor)\/\S+/gi, ''));
  ses.protocol.handle('sensor', (req) => {
    const url = new URL(req.url);
    if (url.hostname === 'newtab') return new Response(newTabPage(core), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const uri = req.url;
    core.run('resources.open', { uri }).catch(() => {});
    return new Response(resourcePage(uri), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  ses.on('will-download', (_e, item) => {
    const id = 'dl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const dir = app.getPath('downloads');
    mkdirSync(dir, { recursive: true });
    let name = item.getFilename() || 'download';
    let target = join(dir, name);
    for (let i = 1; existsSync(target); i++) {
      const ext = extname(name);
      target = join(dir, `${basename(name, ext)} (${i})${ext}`);
    }
    item.setSavePath(target);
    core.browserData.downloadStarted({ id, url: item.getURL(), filename: basename(target), path: target, total: item.getTotalBytes(), profileId });
    let last = 0;
    item.on('updated', () => {
      if (Date.now() - last < 500) return;
      last = Date.now();
      core.browserData.downloadProgress(id, item.getReceivedBytes(), item.getTotalBytes(), item.getSavePath());
    });
    item.once('done', (_ev, state) => core.browserData.downloadDone(id, state, item.getSavePath()));
    downloadItems.set(id, item);
  });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const always = ['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'window-management'];
    if (always.includes(permission)) return callback(true);
    const origin = (() => {
      try {
        return new URL(details.requestingUrl || wc.getURL()).origin;
      } catch {
        return 'unknown';
      }
    })();
    const store = core.settings.get<Record<string, Record<string, boolean>>>('permissions.sites') ?? {};
    const saved = store[origin]?.[permission];
    if (saved !== undefined) return callback(saved);
    dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        message: `${origin} wants to use: ${permission}`,
        checkboxLabel: isIncognito(profileId) ? undefined : 'Remember this decision',
        checkboxChecked: true,
      })
      .then(({ response, checkboxChecked }) => {
        const allow = response === 0;
        if (checkboxChecked && !isIncognito(profileId)) {
          store[origin] = { ...(store[origin] ?? {}), [permission]: allow };
          core.settings.set('permissions.sites', store);
        }
        callback(allow);
      });
  });
  // Unpacked extensions configured for this profile.
  if (!isIncognito(profileId)) {
    const exts = core.settings.get<string[]>(`extensions.${profileId}`) ?? [];
    for (const p of exts) loadExtension(ses, p).catch((e) => core.notify('warning', 'Extension failed to load', `${p}: ${e.message}`, 'extensions'));
  }
}

const downloadItems = new Map<string, Electron.DownloadItem>();

async function loadExtension(ses: Session, path: string) {
  const api: any = (ses as any).extensions ?? ses;
  return api.loadExtension(path, { allowFileAccess: true });
}

function float(tabId: string): void {
  if (floating.has(tabId) || !core.workspaces.hasTab(tabId)) return;
  const tab = core.workspaces.tab(tabId);
  const w = core.workspaces.get(tab.workspaceId);
  let fp = w.layout.floating.find((f) => f.tabId === tabId);
  if (!fp) {
    const b = win.getBounds();
    fp = { id: 'f' + Date.now().toString(36), tabId, bounds: { x: b.x + b.width - 520, y: b.y + 80, width: 480, height: 640 } };
    // A floating tab leaves the main browser area.
    if (w.activeTab === tabId) {
      const rest = core.workspaces.tabsOf(w.id).filter((t) => t.id !== tabId && !core.workspaces.isPinnedInPanel(w, t.id));
      w.activeTab = rest.sort((a, b) => b.lastActive - a.lastActive)[0]?.id ?? null;
    }
    core.workspaces.setLayout(w.id, { ...w.layout, floating: [...w.layout.floating, fp] });
  }
  const fw = new BrowserWindow({
    ...fp.bounds,
    title: tab.title,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    alwaysOnTop: !!fp.alwaysOnTop,
    show: !isTest,
  });
  floating.set(tabId, fw);
  const fit = () => {
    const [cw, ch] = fw.getContentSize();
    browserHost.attachTo(tabId, fw, { x: 0, y: 0, width: cw, height: ch });
  };
  fit();
  fw.on('resize', fit);
  const saveBounds = () => {
    if (!core.workspaces.hasTab(tabId)) return;
    const ws = core.workspaces.get(core.workspaces.tab(tabId).workspaceId);
    core.workspaces.setLayout(ws.id, { ...ws.layout, floating: ws.layout.floating.map((f) => (f.tabId === tabId ? { ...f, bounds: fw.getBounds() } : f)) });
  };
  fw.on('moved', saveBounds);
  fw.on('resized', saveBounds);
  fw.on('closed', () => {
    floating.delete(tabId);
    browserHost.release(tabId);
    if (quitting || !core.workspaces.hasTab(tabId)) return;
    const ws = core.workspaces.get(core.workspaces.tab(tabId).workspaceId);
    core.workspaces.setLayout(ws.id, { ...ws.layout, floating: ws.layout.floating.filter((f) => f.tabId !== tabId) });
    core.workspaces.activateTab(tabId);
  });
}

function syncFloating(): void {
  const active = core.workspaces.active();
  const want = new Set(active.layout.floating.map((f) => f.tabId));
  for (const [tabId, fw] of floating) {
    if (!want.has(tabId)) fw.hide();
    else if (!fw.isVisible() && !isTest) fw.showInactive();
  }
  for (const f of active.layout.floating) if (!floating.has(f.tabId)) float(f.tabId);
}

let quitting = false;

function mainCommands(): CommandDef[] {
  return [
    { id: 'palette.open', title: 'Command Palette', scopes: [], shortcut: 'CmdOrCtrl+K', palette: false, handler: () => { setOverlay(true); sendToShell('sensor:ui', { action: 'palette', mode: 'all' }); } },
    { id: 'palette.commands', title: 'Run Command…', scopes: [], shortcut: 'CmdOrCtrl+Shift+P', palette: false, handler: () => { setOverlay(true); sendToShell('sensor:ui', { action: 'palette', mode: 'commands' }); } },
    {
      id: 'palette.prompt', title: 'Prompt For Command Parameters', scopes: [], palette: false,
      params: { command: { type: 'string', required: true, positional: 0 }, args: { type: 'object' } },
      handler: (a) => { setOverlay(true); sendToShell('sensor:ui', { action: 'palette', mode: 'command', command: a.command, args: a.args ?? {} }); },
    },
    { id: 'shell.focusAddress', title: 'Focus Address Bar', scopes: [], shortcut: 'CmdOrCtrl+L', handler: () => { win.webContents.focus(); sendToShell('sensor:ui', { action: 'focusAddress' }); } },
    { id: 'page.find', title: 'Find in Page', scopes: [], shortcut: 'CmdOrCtrl+F', handler: () => { win.webContents.focus(); sendToShell('sensor:ui', { action: 'find' }); } },
    {
      id: 'page.findText', title: 'Find Text', scopes: ['page:read'], palette: false,
      params: { text: { type: 'string', positional: 0 }, forward: { type: 'boolean', default: true }, id: { type: 'string' } },
      handler: (a) => {
        const id = a.id ?? core.workspaces.active().activeTab;
        const wc = id ? browserHost.liveWebContents(id) : null;
        if (!wc) return { ok: false };
        if (!a.text) wc.stopFindInPage('clearSelection');
        else wc.findInPage(a.text, { forward: a.forward, findNext: true });
        return { ok: true };
      },
    },
    {
      id: 'tabs.activateIndex', title: 'Activate Tab By Index', scopes: ['tabs:write'], palette: false,
      params: { index: { type: 'number', required: true, positional: 0 } },
      handler: (a) => {
        const w = core.workspaces.active();
        const list = core.workspaces.tabsOf(w.id).filter((t) => !core.workspaces.isPinnedInPanel(w, t.id));
        const t = a.index >= 8 ? list[list.length - 1] : list[a.index];
        return t ? core.workspaces.activateTab(t.id) : null;
      },
    },
    { id: 'zoom.in', title: 'Zoom In', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+=', handler: () => zoomBy(0.1) },
    { id: 'zoom.out', title: 'Zoom Out', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+-', handler: () => zoomBy(-0.1) },
    { id: 'zoom.reset', title: 'Reset Zoom', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+0', handler: () => zoomBy(0) },
    {
      id: 'shortcuts.list', title: 'List Keyboard Shortcuts', scopes: ['app:read'], palette: false,
      handler: () => ({ shortcuts: shortcuts.list(), conflicts: shortcuts.conflicts() }),
    },
    {
      id: 'shortcuts.set', title: 'Set Keyboard Shortcut', scopes: ['app:write'], palette: false,
      params: { command: { type: 'string', required: true, positional: 0 }, accelerator: { type: 'string', positional: 1, description: 'empty to disable' } },
      handler: (a) => {
        if (!core.bus.has(a.command)) throw new Error(`unknown command: ${a.command}`);
        const o = { ...(core.settings.get<Record<string, string>>('shortcuts.overrides') ?? {}) };
        o[a.command] = a.accelerator ?? '';
        core.settings.set('shortcuts.overrides', o);
        rebuildShortcuts();
        return { conflicts: shortcuts.conflicts() };
      },
    },
    {
      id: 'metrics.processes', title: 'Process Metrics', scopes: ['app:read'], palette: false,
      handler: () => processMetrics(true),
    },
    {
      id: 'extensions.load', title: 'Load Unpacked Extension', scopes: ['app:write'],
      params: { path: { type: 'string', positional: 0 }, profile: { type: 'string', default: 'default' } },
      handler: async (a) => {
        let path = a.path;
        if (!path) {
          const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select unpacked extension folder' });
          if (r.canceled || !r.filePaths[0]) return { ok: false };
          path = r.filePaths[0];
        }
        const ext = await loadExtension(browserHost.sessionFor(a.profile), path);
        const key = `extensions.${a.profile}`;
        const list = new Set(core.settings.get<string[]>(key) ?? []);
        list.add(path);
        core.settings.set(key, [...list]);
        return { id: ext.id, name: ext.name, version: ext.version };
      },
    },
    {
      id: 'extensions.list', title: 'List Extensions', scopes: ['app:read'], palette: false,
      params: { profile: { type: 'string', default: 'default' } },
      handler: (a) => {
        const ses: any = browserHost.sessionFor(a.profile);
        const api = ses.extensions ?? ses;
        return api.getAllExtensions().map((e: any) => ({ id: e.id, name: e.name, version: e.version, path: e.path }));
      },
    },
    {
      id: 'extensions.remove', title: 'Remove Extension', scopes: ['app:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, profile: { type: 'string', default: 'default' } },
      handler: (a) => {
        const ses: any = browserHost.sessionFor(a.profile);
        const api = ses.extensions ?? ses;
        const ext = api.getExtension(a.id);
        api.removeExtension(a.id);
        const key = `extensions.${a.profile}`;
        core.settings.set(key, (core.settings.get<string[]>(key) ?? []).filter((p) => p !== ext?.path));
        return { ok: true };
      },
    },
    {
      id: 'downloads.cancel', title: 'Cancel Download', scopes: ['downloads:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const item = downloadItems.get(a.id);
        if (!item) throw new Error('download not active');
        item.cancel();
        return { ok: true };
      },
    },
    { id: 'app.reloadShell', title: 'Reload Sensor UI', scopes: ['app:write'], handler: () => { win.webContents.reload(); overlay.webContents.reload(); } },
    { id: 'app.shellDevtools', title: 'Sensor UI Developer Tools', scopes: ['app:write'], handler: () => win.webContents.openDevTools({ mode: 'detach' }) },
    { id: 'app.quit', title: 'Quit Sensor', scopes: ['app:write'], shortcut: 'CmdOrCtrl+Q', handler: () => app.quit() },
    {
      id: 'app.newWindow', title: 'New Window (Detached Workspace View)', scopes: ['workspaces:write'], palette: false,
      handler: () => ({ note: 'Sensor is designed around one main window; use floating panels for extra windows.' }),
    },
  ];
}

function zoomBy(delta: number) {
  const id = core.workspaces.active().activeTab;
  const wc = id ? browserHost.liveWebContents(id) : null;
  if (!wc) return null;
  const f = delta === 0 ? 1 : Math.round((wc.getZoomFactor() + delta) * 10) / 10;
  wc.setZoomFactor(Math.max(0.3, Math.min(3, f)));
  return { zoom: wc.getZoomFactor() };
}

function processMetrics(detail = false) {
  const metrics = app.getAppMetrics();
  let cpu = 0;
  let memKB = 0;
  for (const m of metrics) {
    cpu += m.cpu.percentCPUUsage;
    memKB += m.memory.workingSetSize;
  }
  const out: any = { cpu: Math.round(cpu * 10) / 10, memMB: Math.round(memKB / 1024), processes: metrics.length, ...browserHost.stats() };
  if (detail) {
    const byPid = new Map<number, string>();
    for (const t of core.workspaces.allTabs()) {
      const pid = browserHost.pidOf(t.id);
      if (pid) byPid.set(pid, t.title || t.url);
    }
    out.detail = metrics.map((m) => ({ pid: m.pid, type: m.type, name: byPid.get(m.pid) ?? m.name ?? m.serviceName ?? m.type, cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10, memMB: Math.round(m.memory.workingSetSize / 1024) }));
  }
  return out;
}

function snapshot() {
  return {
    platform: process.platform,
    dataDir,
    workspaces: core.workspaces.list(),
    activeWorkspace: core.workspaces.activeId,
    tabs: core.workspaces.allTabs().map((t) => ({ ...t, incognito: isIncognito(t.profileId) })),
    commands: core.bus.list(),
    shortcuts: shortcuts.list(),
    settings: core.settings.all(),
    profiles: core.db.all('SELECT * FROM profiles'),
    unread: Number(core.db.get('SELECT count(*) AS n FROM notifications WHERE read = 0')?.n ?? 0),
    api: api ? { path: api.path } : null,
  };
}

async function createWindow(): Promise<void> {
  const display = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1600, display.width),
    height: Math.min(1000, display.height),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0f14',
    title: 'Sensor',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#0b0f14', symbolColor: '#8b98a5', height: 32 },
    webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  browserHost.win = win;
  overlay = new WebContentsView({ webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true } });
  overlay.setBackgroundColor('#00000000');
  overlay.setVisible(false);
  win.contentView.addChildView(overlay);
  browserHost.overlayOnTop = () => {
    if (overlayOpen) win.contentView.addChildView(overlay);
  };
  for (const wc of [win.webContents, overlay.webContents]) {
    wc.on('before-input-event', (event, input) => {
      if (handleShortcut(input as KeyInput, wc)) event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      core.run('tabs.open', { url }).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
  }
  win.on('resize', () => {
    if (overlayOpen) {
      const [w, h] = win.getContentSize();
      overlay.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('close', () => {
    quitting = true;
    for (const fw of floating.values()) if (!fw.isDestroyed()) fw.close();
  });
  await win.loadFile(RENDERER_HTML);
  await overlay.webContents.loadFile(RENDERER_HTML, { hash: 'overlay' });
  syncFloating();
}

async function boot(): Promise<void> {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  const platform = electronPlatformHost();
  core = new Core({ dataDir, platform });
  browserHost = new ElectronBrowserHost(core, WEB_PRELOAD, {
    onShortcut: handleShortcut,
    setupSession,
    contextMenuExtras: (tabId, p) => contextExtras(tabId, p),
    onViewCreated: (tabId, wc) => core.events.emit('page.viewCreated', { tabId, wcId: wc.id }),
  });
  core.browser = browserHost;
  core.settings.set('app.version', app.getVersion());
  // Default session too (used by popups opened via window.open).
  browserHost.sessionFor('default');

  core.bus.registerAll(mainCommands());
  for (const m of allModules({ indexerWorker: join(__dirname, 'indexer-worker.js') })) core.use(m);
  for (const m of mainModules(() => ({ win, browserHost, overlay }))) core.use(m);
  rebuildShortcuts();

  core.bus.approval = async (p, cmd, missing) => {
    if (!win || win.isDestroyed() || isTest) return false; // no human to ask in automated tests
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Allow once', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      message: `${principalLabel(p)} wants to run “${cmd.title}” (${cmd.id})`,
      detail: `It lacks the scope(s): ${missing.join(', ')}.${cmd.destructive ? '\n\nThis is a destructive action.' : ''}`,
    });
    return response === 0;
  };

  core.events.on('*', (e) => {
    if (e.topic === 'command.ran') return;
    sendToShell('sensor:event', e);
    if (e.topic === 'workspace.switched') syncFloating();
    if (e.topic === 'panel.float') float(e.data.tabId);
    if (e.topic === 'notification.posted' && !win?.isFocused()) core.platform.osNotify?.(e.data.title, e.data.body ?? '');
    if (e.topic === 'settings.changed' && e.data.key === 'shortcuts.overrides') rebuildShortcuts();
  });

  ipcMain.handle('sensor:run', async (_e, id: string, args: any) => {
    try {
      return { ok: true, result: await core.run(id, args ?? {}) };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err), code: err?.code ?? 'failed' };
    }
  });
  ipcMain.handle('sensor:snapshot', () => snapshot());
  ipcMain.on('sensor:rects', (_e, rects: ViewRect[]) => {
    if (win && !win.isDestroyed()) browserHost.layout(win, rects);
  });
  ipcMain.on('sensor:overlay', (_e, open: boolean) => setOverlay(!!open));
  ipcMain.on('sensor:focus-context', (_e, ctx: string) => (shellFocusContext = String(ctx)));

  await createWindow();

  let metricsTimer: NodeJS.Timeout | null = null;
  const startMetrics = () => {
    if (metricsTimer) clearInterval(metricsTimer);
    const ms = core.settings.get<number>('perf.statusIntervalMs') ?? 2000;
    metricsTimer = setInterval(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      sendToShell('sensor:metrics', processMetrics(false));
    }, Math.max(500, ms));
  };
  startMetrics();
  core.events.on('settings.changed', (e) => e.data.key === 'perf.statusIntervalMs' && startMetrics());

  if (core.settings.get('api.enabled') !== false) {
    try {
      api = await startApiServer(core, { dataDir });
      console.log(`[sensor] local API listening on ${api.path}`);
    } catch (e: any) {
      core.notify('error', 'Local API failed to start', e.message, 'api');
    }
  }
}

function contextExtras(tabId: string, p: Electron.ContextMenuParams): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  const run = (id: string, args: any = {}) => () => core.run(id, args).catch((e) => core.notify('error', `${id} failed`, String(e.message ?? e)));
  if (p.selectionText) {
    items.push({ label: 'Save Selection to Note', click: run('notes.capture', { kind: 'selection', tab: tabId }) });
    items.push({ label: 'Highlight Selection', click: run('annotations.highlight', { tab: tabId }) });
    const providers = core.bus.has('ai.providers') ? core.db.all('SELECT id, name FROM providers ORDER BY position') : [];
    if (providers.length) {
      items.push({ label: 'Send Selection to', submenu: providers.map((pr) => ({ label: pr.name, click: run('ai.send', { provider: pr.id, fromSelection: true, tab: tabId }) })) });
    }
  }
  if (core.bus.has('notes.capture')) {
    items.push({ label: 'Save Page to Note', click: run('notes.capture', { kind: 'page', tab: tabId }) });
    items.push({ label: 'Add Sticky Note Here', click: run('annotations.sticky', { tab: tabId, x: p.x, y: p.y }) });
  }
  return items;
}

app.whenReady().then(boot).catch((e) => {
  console.error('[sensor] boot failed', e);
  dialog.showErrorBox('Sensor failed to start', String(e?.stack ?? e));
  app.exit(1);
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  try {
    api?.close();
    browserHost?.dispose();
    core?.dispose();
  } catch (e) {
    console.error('[sensor] shutdown error', e);
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
