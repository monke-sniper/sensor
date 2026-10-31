import type { Core } from '../core';
import type { CommandDef } from '../commands';
import { now, uid } from '../db';
import {
  defaultLayout,
  findLeafBy,
  findNode,
  insertPanel,
  leaves,
  removeNode,
  replacePanel,
  setSizes,
  visibleTabIds,
  type Layout,
  type Panel,
  type Side,
  type ToolKind,
} from '../layout';

export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  position: number;
  layout: Layout;
  activeTab: string | null;
}

export interface Tab {
  id: string;
  workspaceId: string;
  url: string;
  title: string;
  favicon: string | null;
  profileId: string; // "default", "<profile id>" or "incognito:<n>"
  position: number;
  pinned: boolean;
  group: string | null;
  lastActive: number;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  suspended?: boolean;
  audible?: boolean;
}

export const NEW_TAB_URL = 'sensor://newtab';

export function isIncognito(profileId: string): boolean {
  return profileId.startsWith('incognito');
}

const TOOL_KINDS: ToolKind[] = [
  'notes', 'files', 'downloads', 'history', 'bookmarks', 'rss', 'clipboard', 'macros', 'search', 'terminal',
  'agents', 'projects', 'obsidian', 'settings', 'notifications', 'annotations', 'documents', 'providers',
];

/** Turn user input from an address bar into a URL. */
export function normalizeUrl(input: string, searchTemplate = 'https://duckduckgo.com/?q=%s'): string {
  const s = input.trim();
  if (!s) return NEW_TAB_URL;
  if (/^(https?|file|sensor|about|data|chrome|devtools|view-source):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (/^[^\s]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s) && !s.includes(' ')) return 'https://' + s;
  return searchTemplate.replace('%s', encodeURIComponent(s));
}

export class Workspaces {
  private ws = new Map<string, Workspace>();
  private tabs = new Map<string, Tab>();
  activeId = '';
  private incognitoCounter = 0;

  constructor(private core: Core) {
    this.load();
  }

  private load(): void {
    const { db } = this.core;
    for (const r of db.all('SELECT * FROM workspaces ORDER BY position')) {
      let layout: Layout;
      try {
        layout = JSON.parse(r.layout);
      } catch {
        layout = defaultLayout();
      }
      this.ws.set(r.id, { id: r.id, name: r.name, icon: r.icon, position: r.position, layout, activeTab: r.active_tab });
    }
    for (const r of db.all('SELECT * FROM tabs ORDER BY position')) {
      this.tabs.set(r.id, {
        id: r.id, workspaceId: r.workspace_id, url: r.url, title: r.title ?? r.url, favicon: r.favicon, profileId: r.profile_id,
        position: r.position, pinned: !!r.pinned, group: r.group_name, lastActive: r.last_active, suspended: true,
      });
    }
    if (this.ws.size === 0) {
      const w = this.create('Main');
      this.openTab({ workspaceId: w.id, url: NEW_TAB_URL });
    }
    const saved = this.core.settings.get<string>('workspace.active');
    this.activeId = saved && this.ws.has(saved) ? saved : [...this.ws.keys()][0];
    // Drop layout references to tabs that no longer exist.
    for (const w of this.ws.values()) {
      if (w.activeTab && !this.tabs.has(w.activeTab)) w.activeTab = this.tabsOf(w.id)[0]?.id ?? null;
      for (const l of leaves(w.layout.root)) {
        if (l.panel.kind === 'web' && !this.tabs.has(l.panel.tabId)) w.layout.root = removeNode(w.layout.root, l.id);
      }
      w.layout.floating = w.layout.floating.filter((f) => this.tabs.has(f.tabId));
    }
  }

  // ---- persistence helpers
  private saveWs(w: Workspace): void {
    this.core.db.run(
      `INSERT INTO workspaces (id, name, icon, position, layout, active_tab, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, position=excluded.position, layout=excluded.layout, active_tab=excluded.active_tab`,
      w.id, w.name, w.icon, w.position, JSON.stringify(w.layout), w.activeTab, now(),
    );
    this.core.events.emit('workspace.changed', { id: w.id });
  }

  private saveTab(t: Tab): void {
    if (isIncognito(t.profileId)) return; // never persisted
    this.core.db.run(
      `INSERT INTO tabs (id, workspace_id, url, title, favicon, profile_id, position, pinned, group_name, last_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, url=excluded.url, title=excluded.title, favicon=excluded.favicon,
       position=excluded.position, pinned=excluded.pinned, group_name=excluded.group_name, last_active=excluded.last_active`,
      t.id, t.workspaceId, t.url, t.title, t.favicon, t.profileId, t.position, t.pinned ? 1 : 0, t.group, t.lastActive, now(),
    );
  }

  // ---- workspaces
  list(): Workspace[] {
    return [...this.ws.values()].sort((a, b) => a.position - b.position);
  }

  get(id?: string): Workspace {
    const w = this.ws.get(id ?? this.activeId) ?? [...this.ws.values()].find((x) => x.name.toLowerCase() === (id ?? '').toLowerCase());
    if (!w) throw new Error(`workspace not found: ${id}`);
    return w;
  }

  active(): Workspace {
    return this.get(this.activeId);
  }

  create(name: string, icon: string | null = null): Workspace {
    const w: Workspace = { id: uid('ws_'), name, icon, position: this.ws.size, layout: defaultLayout(), activeTab: null };
    this.ws.set(w.id, w);
    this.saveWs(w);
    return w;
  }

  switchTo(id: string): Workspace {
    const w = this.get(id);
    this.activeId = w.id;
    this.core.settings.set('workspace.active', w.id);
    this.core.events.emit('workspace.switched', { id: w.id });
    return w;
  }

  rename(id: string, name: string): Workspace {
    const w = this.get(id);
    w.name = name;
    this.saveWs(w);
    return w;
  }

  remove(id: string): void {
    const w = this.get(id);
    if (this.ws.size <= 1) throw new Error('cannot delete the last workspace');
    for (const t of this.tabsOf(w.id)) this.closeTab(t.id);
    this.ws.delete(w.id);
    this.core.db.run('DELETE FROM workspaces WHERE id = ?', w.id);
    if (this.activeId === w.id) this.switchTo(this.list()[0].id);
    this.core.events.emit('workspace.changed', { id: w.id, removed: true });
  }

  setLayout(id: string, layout: Layout): void {
    const w = this.get(id);
    w.layout = layout;
    this.saveWs(w);
  }

  // ---- tabs
  tabsOf(workspaceId: string): Tab[] {
    return [...this.tabs.values()].filter((t) => t.workspaceId === workspaceId).sort((a, b) => a.position - b.position);
  }

  allTabs(): Tab[] {
    return [...this.tabs.values()];
  }

  tab(id: string): Tab {
    const t = this.tabs.get(id);
    if (!t) throw new Error(`tab not found: ${id}`);
    return t;
  }

  hasTab(id: string): boolean {
    return this.tabs.has(id);
  }

  newIncognitoProfile(): string {
    return `incognito:${++this.incognitoCounter}`;
  }

  openTab(opts: { url?: string; workspaceId?: string; profileId?: string; incognito?: boolean; activate?: boolean; background?: boolean }): Tab {
    const w = this.get(opts.workspaceId);
    const profileId = opts.incognito ? this.newIncognitoProfile() : opts.profileId ?? this.core.settings.get<string>('browser.defaultProfile') ?? 'default';
    const tabs = this.tabsOf(w.id);
    const t: Tab = {
      id: uid('tab_'), workspaceId: w.id, url: opts.url ? normalizeUrl(opts.url, this.searchTemplate()) : NEW_TAB_URL,
      title: opts.url ?? 'New Tab', favicon: null, profileId, position: tabs.length, pinned: false, group: null, lastActive: now(),
    };
    this.tabs.set(t.id, t);
    this.saveTab(t);
    this.core.events.emit('tab.opened', { tab: t });
    if (opts.activate !== false && !opts.background) this.activateTab(t.id);
    return t;
  }

  searchTemplate(): string {
    return this.core.settings.get<string>('browser.searchUrl') ?? 'https://duckduckgo.com/?q=%s';
  }

  activateTab(id: string): Tab {
    const t = this.tab(id);
    const w = this.get(t.workspaceId);
    w.activeTab = t.id;
    t.lastActive = now();
    t.suspended = false;
    this.saveTab(t);
    this.saveWs(w);
    this.core.events.emit('tab.activated', { id: t.id, workspaceId: w.id });
    return t;
  }

  updateTab(id: string, patch: Partial<Tab>, persist = true): Tab {
    const t = this.tab(id);
    Object.assign(t, patch);
    if (persist) this.saveTab(t);
    this.core.events.emit('tab.changed', { tab: t });
    return t;
  }

  closeTab(id: string): void {
    const t = this.tabs.get(id);
    if (!t) return;
    const w = this.ws.get(t.workspaceId);
    this.tabs.delete(id);
    this.core.db.run('DELETE FROM tabs WHERE id = ?', id);
    this.core.browser.destroy(id);
    if (w) {
      // remove panels that pinned this tab
      for (const l of leaves(w.layout.root)) {
        if (l.panel.kind === 'web' && l.panel.tabId === id) w.layout.root = removeNode(w.layout.root, l.id);
      }
      w.layout.floating = w.layout.floating.filter((f) => f.tabId !== id);
      if (w.activeTab === id) {
        const rest = this.tabsOf(w.id).filter((x) => !this.isPinnedInPanel(w, x.id));
        const next = rest.sort((a, b) => b.lastActive - a.lastActive)[0];
        w.activeTab = next?.id ?? null;
      }
      this.saveWs(w);
    }
    this.core.events.emit('tab.closed', { id, workspaceId: t.workspaceId });
  }

  moveTab(id: string, position: number, workspaceId?: string): Tab {
    const t = this.tab(id);
    if (workspaceId && workspaceId !== t.workspaceId) {
      const from = this.get(t.workspaceId);
      if (from.activeTab === t.id) from.activeTab = null;
      t.workspaceId = this.get(workspaceId).id;
      this.saveWs(from);
    }
    const list = this.tabsOf(t.workspaceId).filter((x) => x.id !== id);
    list.splice(Math.max(0, Math.min(position, list.length)), 0, t);
    list.forEach((x, i) => {
      x.position = i;
      this.saveTab(x);
    });
    this.core.events.emit('tab.changed', { tab: t });
    return t;
  }

  isPinnedInPanel(w: Workspace, tabId: string): boolean {
    return leaves(w.layout.root).some((l) => l.panel.kind === 'web' && l.panel.tabId === tabId) || w.layout.floating.some((f) => f.tabId === tabId);
  }

  visibleTabs(): string[] {
    const w = this.active();
    return visibleTabIds(w.layout, w.activeTab);
  }

  // ---- panels
  openPanel(opts: { workspaceId?: string; panel: Panel; side?: Side; target?: string; size?: number }): string {
    const w = this.get(opts.workspaceId);
    // A tool panel that is already open just gets focus.
    if (opts.panel.kind === 'tool') {
      const tool = opts.panel.tool;
      const existing = findLeafBy(w.layout.root, (p) => p.kind === 'tool' && p.tool === tool && tool !== 'terminal');
      if (existing) return existing.id;
    }
    const { root, leafId } = insertPanel(w.layout.root, opts.panel, opts.side ?? 'right', opts.target, opts.size ?? 0.33);
    w.layout.root = root;
    this.saveWs(w);
    return leafId;
  }

  closePanel(leafId: string, workspaceId?: string): void {
    const w = this.get(workspaceId);
    const node = findNode(w.layout.root, leafId);
    if (!node) throw new Error(`panel not found: ${leafId}`);
    if (node === w.layout.root) throw new Error('cannot close the only panel');
    w.layout.root = removeNode(w.layout.root, leafId);
    this.saveWs(w);
  }
}

export function workspaceCommands(core: Core): CommandDef[] {
  const W = () => core.workspaces;
  const tabView = (t: Tab) => ({ ...t, incognito: isIncognito(t.profileId) });
  return [
    {
      id: 'workspaces.list', title: 'List Workspaces', scopes: ['workspaces:read'], palette: false,
      handler: () => W().list().map((w) => ({ id: w.id, name: w.name, icon: w.icon, active: w.id === W().activeId, tabs: W().tabsOf(w.id).length })),
    },
    {
      id: 'workspaces.get', title: 'Get Workspace', scopes: ['workspaces:read'], palette: false,
      params: { id: { type: 'string', positional: 0 } },
      handler: (a) => {
        const w = W().get(a.id);
        return { ...w, active: w.id === W().activeId, tabs: W().tabsOf(w.id).map(tabView) };
      },
    },
    {
      id: 'workspaces.switch', title: 'Switch Workspace', scopes: ['workspaces:write'],
      params: { id: { type: 'string', required: true, positional: 0, description: 'workspace id or name' } },
      handler: (a) => W().switchTo(W().get(a.id).id),
    },
    {
      id: 'workspaces.create', title: 'New Workspace', scopes: ['workspaces:write'],
      params: { name: { type: 'string', required: true, positional: 0 }, icon: { type: 'string' }, switch: { type: 'boolean', default: true } },
      handler: (a) => {
        const w = W().create(a.name, a.icon ?? null);
        W().openTab({ workspaceId: w.id, url: NEW_TAB_URL });
        if (a.switch) W().switchTo(w.id);
        return w;
      },
    },
    {
      id: 'workspaces.rename', title: 'Rename Workspace', scopes: ['workspaces:write'],
      params: { id: { type: 'string', required: true, positional: 0 }, name: { type: 'string', required: true, positional: 1 } },
      handler: (a) => W().rename(a.id, a.name),
    },
    {
      id: 'workspaces.delete', title: 'Delete Workspace', scopes: ['workspaces:write'], destructive: true,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        W().remove(W().get(a.id).id);
        return { ok: true };
      },
    },
    {
      id: 'workspaces.next', title: 'Next Workspace', scopes: ['workspaces:write'], shortcut: 'CmdOrCtrl+Alt+Down',
      handler: () => {
        const l = W().list();
        const i = l.findIndex((w) => w.id === W().activeId);
        return W().switchTo(l[(i + 1) % l.length].id);
      },
    },
    {
      id: 'workspaces.prev', title: 'Previous Workspace', scopes: ['workspaces:write'], shortcut: 'CmdOrCtrl+Alt+Up',
      handler: () => {
        const l = W().list();
        const i = l.findIndex((w) => w.id === W().activeId);
        return W().switchTo(l[(i - 1 + l.length) % l.length].id);
      },
    },
    // ---- tabs
    {
      id: 'tabs.list', title: 'List Tabs', scopes: ['tabs:read'], palette: false,
      params: { workspace: { type: 'string', description: 'workspace id/name; "all" for every workspace' } },
      handler: (a) => (a.workspace === 'all' ? W().allTabs() : W().tabsOf(W().get(a.workspace).id)).map(tabView),
    },
    {
      id: 'tabs.get', title: 'Inspect Tab', scopes: ['tabs:read'], palette: false,
      params: { id: { type: 'string', positional: 0 } },
      handler: (a) => tabView(a.id ? W().tab(a.id) : activeTabOrThrow(core)),
    },
    {
      id: 'tabs.open', title: 'New Tab', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+T',
      params: {
        url: { type: 'string', positional: 0 },
        workspace: { type: 'string' },
        profile: { type: 'string' },
        incognito: { type: 'boolean', default: false },
        background: { type: 'boolean', default: false },
        target: { type: 'string', enum: ['tab', 'panel', 'float'], default: 'tab' },
        side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], default: 'right' },
      },
      handler: (a) => {
        const t = W().openTab({ url: a.url, workspaceId: a.workspace, profileId: a.profile, incognito: a.incognito, background: a.background || a.target !== 'tab' });
        if (a.target === 'panel') W().openPanel({ workspaceId: t.workspaceId, panel: { kind: 'web', tabId: t.id }, side: a.side });
        if (a.target === 'float') core.events.emit('panel.float', { tabId: t.id });
        return tabView(t);
      },
    },
    {
      id: 'tabs.incognito', title: 'New Incognito Tab', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+Shift+N',
      params: { url: { type: 'string', positional: 0 } },
      handler: (a) => tabView(W().openTab({ url: a.url, incognito: true })),
    },
    {
      id: 'tabs.close', title: 'Close Tab', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+W',
      params: { id: { type: 'string', positional: 0 } },
      handler: (a) => {
        const id = a.id ?? activeTabOrThrow(core).id;
        W().closeTab(id);
        return { ok: true, id };
      },
    },
    {
      id: 'tabs.activate', title: 'Activate Tab', scopes: ['tabs:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const t = W().tab(a.id);
        if (t.workspaceId !== W().activeId) W().switchTo(t.workspaceId);
        return tabView(W().activateTab(t.id));
      },
    },
    {
      id: 'tabs.next', title: 'Next Tab', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+Tab',
      handler: () => cycleTab(core, 1),
    },
    {
      id: 'tabs.prev', title: 'Previous Tab', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+Shift+Tab',
      handler: () => cycleTab(core, -1),
    },
    {
      id: 'tabs.navigate', title: 'Navigate', scopes: ['tabs:write'], palette: false,
      params: { url: { type: 'string', required: true, positional: 0 }, id: { type: 'string' } },
      handler: (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        const url = normalizeUrl(a.url, W().searchTemplate());
        W().updateTab(t.id, { url });
        core.browser.navigate(t.id, url);
        return tabView(t);
      },
    },
    { id: 'tabs.back', title: 'Back', scopes: ['tabs:write'], shortcut: 'Alt+Left', params: { id: { type: 'string' } }, handler: (a) => core.browser.back(a.id ?? activeTabOrThrow(core).id) },
    { id: 'tabs.forward', title: 'Forward', scopes: ['tabs:write'], shortcut: 'Alt+Right', params: { id: { type: 'string' } }, handler: (a) => core.browser.forward(a.id ?? activeTabOrThrow(core).id) },
    { id: 'tabs.reload', title: 'Reload', scopes: ['tabs:write'], shortcut: 'CmdOrCtrl+R', params: { id: { type: 'string' } }, handler: (a) => core.browser.reload(a.id ?? activeTabOrThrow(core).id) },
    { id: 'tabs.stop', title: 'Stop Loading', scopes: ['tabs:write'], palette: false, params: { id: { type: 'string' } }, handler: (a) => core.browser.stop(a.id ?? activeTabOrThrow(core).id) },
    {
      id: 'tabs.duplicate', title: 'Duplicate Tab', scopes: ['tabs:write'],
      params: { id: { type: 'string' } },
      handler: (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        return tabView(W().openTab({ url: t.url, workspaceId: t.workspaceId, profileId: isIncognito(t.profileId) ? undefined : t.profileId, incognito: isIncognito(t.profileId) }));
      },
    },
    {
      id: 'tabs.pin', title: 'Pin/Unpin Tab', scopes: ['tabs:write'],
      params: { id: { type: 'string' }, pinned: { type: 'boolean' } },
      handler: (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        return tabView(W().updateTab(t.id, { pinned: a.pinned ?? !t.pinned }));
      },
    },
    {
      id: 'tabs.group', title: 'Set Tab Group', scopes: ['tabs:write'], palette: false,
      params: { id: { type: 'string' }, group: { type: 'string', positional: 0 } },
      handler: (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        return tabView(W().updateTab(t.id, { group: a.group || null }));
      },
    },
    {
      id: 'tabs.move', title: 'Move Tab', scopes: ['tabs:write'], palette: false,
      params: { id: { type: 'string', required: true }, position: { type: 'number', required: true }, workspace: { type: 'string' } },
      handler: (a) => tabView(W().moveTab(a.id, a.position, a.workspace ? W().get(a.workspace).id : undefined)),
    },
    {
      id: 'tabs.suspend', title: 'Suspend Tab', scopes: ['tabs:write'],
      params: { id: { type: 'string' } },
      handler: (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        core.browser.suspend(t.id);
        return tabView(W().updateTab(t.id, { suspended: true }, false));
      },
    },
    {
      id: 'tabs.suspendInactive', title: 'Suspend All Background Tabs', scopes: ['tabs:write'],
      handler: () => {
        const visible = new Set(W().visibleTabs());
        let n = 0;
        for (const t of W().allTabs()) {
          if (!visible.has(t.id) && core.browser.isLive(t.id)) {
            core.browser.suspend(t.id);
            W().updateTab(t.id, { suspended: true }, false);
            n++;
          }
        }
        return { suspended: n };
      },
    },
    { id: 'tabs.devtools', title: 'Developer Tools', scopes: ['page:interact'], shortcut: 'F12', params: { id: { type: 'string' } }, handler: (a) => core.browser.openDevTools(a.id ?? activeTabOrThrow(core).id) },
    {
      id: 'tabs.zoom', title: 'Zoom', scopes: ['tabs:write'], palette: false,
      params: { factor: { type: 'number', required: true, positional: 0 }, id: { type: 'string' } },
      handler: (a) => core.browser.zoom(a.id ?? activeTabOrThrow(core).id, a.factor),
    },
    // ---- page content
    {
      id: 'page.read', title: 'Read Page Content', scopes: ['page:read'], palette: false,
      params: { id: { type: 'string', positional: 0 }, format: { type: 'string', enum: ['text', 'markdown', 'html'], default: 'markdown' } },
      handler: async (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        core.browser.ensure(t.id);
        await core.browser.waitForLoad(t.id, 15000);
        return core.browser.readPage(t.id, a.format);
      },
    },
    {
      id: 'page.selection', title: 'Get Selected Text', scopes: ['page:read'], palette: false,
      params: { id: { type: 'string', positional: 0 } },
      handler: async (a) => ({ text: await core.browser.selection(a.id ?? activeTabOrThrow(core).id) }),
    },
    {
      id: 'page.eval', title: 'Run Script In Page', scopes: ['page:interact'], palette: false,
      params: { js: { type: 'string', required: true, positional: 0 }, id: { type: 'string' } },
      handler: async (a) => ({ result: await core.browser.exec(a.id ?? activeTabOrThrow(core).id, a.js) }),
    },
    {
      id: 'page.click', title: 'Click Element', scopes: ['page:interact'], palette: false,
      params: { selector: { type: 'string', required: true, positional: 0 }, id: { type: 'string' } },
      handler: async (a) => core.browser.click(a.id ?? activeTabOrThrow(core).id, [a.selector]),
    },
    {
      id: 'page.type', title: 'Type Into Element', scopes: ['page:interact'], palette: false,
      params: { selector: { type: 'string', required: true, positional: 0 }, text: { type: 'string', required: true, positional: 1 }, id: { type: 'string' } },
      handler: async (a) => core.browser.type(a.id ?? activeTabOrThrow(core).id, [a.selector], a.text),
    },
    {
      id: 'page.screenshot', title: 'Screenshot Page', scopes: ['page:read'], palette: false,
      params: { id: { type: 'string' }, out: { type: 'string', positional: 0, description: 'file path to write PNG' } },
      handler: async (a) => {
        const png = await core.browser.capture(a.id ?? activeTabOrThrow(core).id);
        if (a.out) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(a.out, png);
          return { path: a.out, bytes: png.length };
        }
        return { base64: png.toString('base64') };
      },
    },
    // ---- panels & layout
    {
      id: 'panels.list', title: 'List Panels', scopes: ['workspaces:read'], palette: false,
      params: { workspace: { type: 'string' } },
      handler: (a) => {
        const w = W().get(a.workspace);
        return { panels: leaves(w.layout.root).map((l) => ({ id: l.id, panel: l.panel })), floating: w.layout.floating };
      },
    },
    {
      id: 'panels.open', title: 'Open Panel', scopes: ['workspaces:write'], palette: false,
      params: {
        tool: { type: 'string', enum: TOOL_KINDS as string[], positional: 0 },
        tab: { type: 'string', description: 'tab id to show as a website panel' },
        url: { type: 'string', description: 'open a new website panel at this URL' },
        side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], default: 'right' },
        target: { type: 'string', description: 'layout node to split' },
        size: { type: 'number', default: 0.33 },
        workspace: { type: 'string' },
      },
      handler: (a) => {
        let panel: Panel;
        if (a.tool) panel = { kind: 'tool', tool: a.tool };
        else if (a.tab) panel = { kind: 'web', tabId: W().tab(a.tab).id };
        else if (a.url) panel = { kind: 'web', tabId: W().openTab({ url: a.url, workspaceId: a.workspace, background: true }).id };
        else throw new Error('one of tool, tab or url is required');
        return { id: W().openPanel({ workspaceId: a.workspace, panel, side: a.side, target: a.target, size: a.size }) };
      },
    },
    {
      id: 'panels.close', title: 'Close Panel', scopes: ['workspaces:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, workspace: { type: 'string' } },
      handler: (a) => {
        W().closePanel(a.id, a.workspace);
        return { ok: true };
      },
    },
    {
      id: 'panels.resize', title: 'Resize Split', scopes: ['workspaces:write'], palette: false,
      params: { id: { type: 'string', required: true }, sizes: { type: 'array', required: true }, workspace: { type: 'string' } },
      handler: (a) => {
        const w = W().get(a.workspace);
        W().setLayout(w.id, { ...w.layout, root: setSizes(w.layout.root, a.id, a.sizes.map(Number)) });
        return { ok: true };
      },
    },
    {
      id: 'panels.replace', title: 'Replace Panel Content', scopes: ['workspaces:write'], palette: false,
      params: { id: { type: 'string', required: true }, panel: { type: 'object', required: true }, workspace: { type: 'string' } },
      handler: (a) => {
        const w = W().get(a.workspace);
        W().setLayout(w.id, { ...w.layout, root: replacePanel(w.layout.root, a.id, a.panel as Panel) });
        return { ok: true };
      },
    },
    {
      id: 'panels.promote', title: 'Open Current Tab As Panel', scopes: ['workspaces:write'],
      params: { id: { type: 'string', description: 'tab id' }, side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], default: 'right' } },
      handler: (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        const w = W().get(t.workspaceId);
        if (w.activeTab === t.id) {
          const others = W().tabsOf(w.id).filter((x) => x.id !== t.id && !W().isPinnedInPanel(w, x.id));
          w.activeTab = others.sort((x, y) => y.lastActive - x.lastActive)[0]?.id ?? null;
        }
        return { id: W().openPanel({ workspaceId: w.id, panel: { kind: 'web', tabId: t.id }, side: a.side }) };
      },
    },
    {
      id: 'panels.float', title: 'Float Current Tab', scopes: ['workspaces:write'],
      params: { id: { type: 'string', description: 'tab id' } },
      handler: (a) => {
        const t = a.id ? W().tab(a.id) : activeTabOrThrow(core);
        core.events.emit('panel.float', { tabId: t.id });
        return { ok: true };
      },
    },
    {
      id: 'layouts.save', title: 'Save Layout', scopes: ['app:write'],
      params: { name: { type: 'string', required: true, positional: 0 }, workspace: { type: 'string' } },
      handler: (a) => {
        const w = W().get(a.workspace);
        const saved = core.settings.get<Record<string, any>>('layouts.saved') ?? {};
        saved[a.name] = JSON.parse(JSON.stringify(w.layout));
        core.settings.set('layouts.saved', saved);
        return { ok: true, name: a.name };
      },
    },
    {
      id: 'layouts.restore', title: 'Restore Layout', scopes: ['workspaces:write'],
      params: { name: { type: 'string', required: true, positional: 0 }, workspace: { type: 'string' } },
      handler: (a) => {
        const saved = core.settings.get<Record<string, Layout>>('layouts.saved') ?? {};
        const l = saved[a.name];
        if (!l) throw new Error(`no saved layout: ${a.name}`);
        const w = W().get(a.workspace);
        const clean: Layout = JSON.parse(JSON.stringify(l));
        for (const leaf of leaves(clean.root)) {
          if (leaf.panel.kind === 'web' && !W().hasTab(leaf.panel.tabId)) clean.root = removeNode(clean.root, leaf.id);
        }
        clean.floating = clean.floating.filter((f) => W().hasTab(f.tabId));
        W().setLayout(w.id, clean);
        return { ok: true };
      },
    },
    {
      id: 'layouts.list', title: 'List Saved Layouts', scopes: ['app:read'], palette: false,
      handler: () => Object.keys(core.settings.get<Record<string, any>>('layouts.saved') ?? {}),
    },
    {
      id: 'layout.toggleSidebar', title: 'Toggle Sidebar', scopes: ['app:write'], shortcut: 'CmdOrCtrl+B',
      handler: () => {
        const w = W().active();
        W().setLayout(w.id, { ...w.layout, sidebar: { ...w.layout.sidebar, visible: !w.layout.sidebar.visible } });
        return { visible: w.layout.sidebar.visible };
      },
    },
  ];
}

export function activeTabOrThrow(core: Core): Tab {
  const w = core.workspaces.active();
  if (!w.activeTab) throw new Error('no active tab');
  return core.workspaces.tab(w.activeTab);
}

function cycleTab(core: Core, dir: 1 | -1) {
  const W = core.workspaces;
  const w = W.active();
  const list = W.tabsOf(w.id).filter((t) => !W.isPinnedInPanel(w, t.id));
  if (!list.length) return null;
  const i = list.findIndex((t) => t.id === w.activeTab);
  return W.activateTab(list[(i + dir + list.length) % list.length].id);
}
