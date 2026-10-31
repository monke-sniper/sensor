import { createStore, produce, reconcile } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { sensor, type Snapshot, type Tab, type Workspace } from './api';

export interface UIState {
  ready: boolean;
  snap: Snapshot;
  tabs: Record<string, Tab>;
  metrics: { cpu: number; memMB: number; processes: number; live: number; visible: number } | null;
  overlayOpen: boolean;
  recognized: Record<string, { kind: string; label: string; actions: { id: string; title: string; command: string; args: any }[] }>;
}

const empty: Snapshot = { platform: '', dataDir: '', workspaces: [], activeWorkspace: '', tabs: [], commands: [], shortcuts: [], settings: {}, profiles: [], unread: 0, api: null };

export const [state, setState] = createStore<UIState>({ ready: false, snap: empty, tabs: {}, metrics: null, overlayOpen: false, recognized: {} });
export const [eventTick, setEventTick] = createSignal(0);

let refreshTimer: any = null;
export async function refresh(): Promise<void> {
  const snap = await sensor.snapshot();
  const tabs: Record<string, Tab> = {};
  for (const t of snap.tabs) tabs[t.id] = t;
  setState('snap', reconcile(snap, { key: 'id' }));
  setState('tabs', reconcile(tabs));
  setState('ready', true);
}
export function scheduleRefresh(ms = 30): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

export function activeWorkspace(): Workspace | undefined {
  return state.snap.workspaces.find((w) => w.id === state.snap.activeWorkspace);
}

export function tabsOf(wsId: string): Tab[] {
  return Object.values(state.tabs)
    .filter((t) => t.workspaceId === wsId)
    .sort((a, b) => a.position - b.position);
}

type EventHandler = (e: { topic: string; data: any }) => void;
const handlers = new Set<EventHandler>();
export function onEvent(fn: EventHandler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function startStore(): void {
  sensor.on('event', (e: { topic: string; data: any }) => {
    const t = e.topic;
    if (t === 'tab.changed' || t === 'tab.opened') {
      const tab = e.data.tab as Tab;
      setState('tabs', tab.id, (prev) => ({ ...(prev ?? {}), ...tab, incognito: tab.profileId.startsWith('incognito') }));
      if (t === 'tab.opened') scheduleRefresh();
    } else if (t === 'tab.closed') {
      setState('tabs', produce((tabs) => { delete tabs[e.data.id]; }));
      scheduleRefresh();
    } else if (t.startsWith('workspace.') || t === 'tab.activated' || t === 'settings.changed' || t.startsWith('notification.') || t === 'profile.deleted') {
      scheduleRefresh();
    } else if (t === 'page.recognized') {
      setState('recognized', e.data.tabId, e.data);
    }
    setEventTick((n) => n + 1);
    for (const h of handlers) h(e);
  });
  sensor.on('metrics', (m) => setState('metrics', m));
  sensor.on('overlay', (o) => setState('overlayOpen', !!o.open));
  refresh();
}
