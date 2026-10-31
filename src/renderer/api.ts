// Typed access to the preload bridge.
export interface SensorBridge {
  run<T = any>(id: string, args?: Record<string, unknown>): Promise<T>;
  snapshot(): Promise<Snapshot>;
  setRects(rects: { tabId: string; x: number; y: number; width: number; height: number }[]): void;
  setOverlay(open: boolean): void;
  on(channel: 'event' | 'metrics' | 'ui' | 'overlay' | 'terminal', fn: (p: any) => void): () => void;
  send(channel: string, payload: unknown): void;
  pathForFile(f: File): string;
}

export interface Tab {
  id: string; workspaceId: string; url: string; title: string; favicon: string | null; profileId: string; position: number;
  pinned: boolean; group: string | null; lastActive: number; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean;
  suspended?: boolean; audible?: boolean; incognito?: boolean;
}

export type Panel = { kind: 'browser' } | { kind: 'web'; tabId: string } | { kind: 'tool'; tool: string; state?: any };
export type LayoutNode =
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: LayoutNode[]; sizes: number[] }
  | { type: 'leaf'; id: string; panel: Panel };
export interface Workspace {
  id: string; name: string; icon: string | null; position: number; activeTab: string | null;
  layout: { root: LayoutNode; floating: { id: string; tabId: string }[]; sidebar: { visible: boolean; width: number } };
}
export interface CommandInfo {
  id: string; title: string; description?: string; category?: string; scopes: string[]; destructive: boolean;
  params: Record<string, { type: string; required?: boolean; description?: string; enum?: string[]; default?: unknown; positional?: number }>;
  palette: boolean; shortcut?: string;
}
export interface Snapshot {
  platform: string; dataDir: string; workspaces: Workspace[]; activeWorkspace: string; tabs: Tab[]; commands: CommandInfo[];
  shortcuts: { command: string; accelerator: string }[]; settings: Record<string, any>; profiles: any[]; unread: number;
  api: { path: string } | null;
}

declare global {
  interface Window {
    sensor: SensorBridge;
  }
}

export const sensor: SensorBridge = window.sensor;

export async function run<T = any>(id: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await sensor.run<T>(id, args);
  } catch (e: any) {
    console.error(`[sensor] ${id} failed:`, e.message);
    throw e;
  }
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
