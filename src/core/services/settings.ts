import type { Core } from '../core';
import type { CommandDef } from '../commands';
import type { Db } from '../db';

/** Defaults are documented here so `sensor settings list` is self-describing. */
export const SETTING_DEFAULTS: Record<string, { value: unknown; description: string }> = {
  'browser.searchUrl': { value: 'https://duckduckgo.com/?q=%s', description: 'Search engine URL template (%s = query)' },
  'browser.defaultProfile': { value: 'default', description: 'Profile used for new tabs' },
  'browser.suspendAfterMinutes': { value: 30, description: 'Suspend background tabs after N minutes (0 = never)' },
  'browser.homepage': { value: 'sensor://newtab', description: 'URL for new tabs' },
  'perf.mode': { value: false, description: 'Performance mode: aggressive suspension, reduced background work' },
  'perf.statusIntervalMs': { value: 2000, description: 'Status bar metrics refresh interval' },
  'notes.vaults': { value: [], description: 'Obsidian vault folders' },
  'notes.defaultVault': { value: '', description: 'Vault used for captures' },
  'notes.captureFolder': { value: 'Sensor', description: 'Folder inside the vault for captured notes' },
  'obsidian.exePath': { value: '', description: 'Path to Obsidian.exe (auto-detected when empty)' },
  'obsidian.embed': { value: true, description: 'Embed the Obsidian window inside the Obsidian panel (Windows)' },
  'files.roots': { value: [], description: 'Folders shown in the file panel and indexed for search' },
  'files.indexContents': { value: true, description: 'Index text contents of files under files.roots' },
  'files.exclude': { value: ['node_modules', '.git', '$RECYCLE.BIN', 'AppData'], description: 'Folder names skipped when indexing' },
  'clipboard.enabled': { value: true, description: 'Record clipboard history' },
  'clipboard.maxItems': { value: 500, description: 'Clipboard history size' },
  'clipboard.excludeApps': { value: ['KeePass', '1Password', 'Bitwarden'], description: 'Window titles/apps never recorded (best effort)' },
  'rss.refreshMinutes': { value: 60, description: 'Feed refresh interval' },
  'api.enabled': { value: true, description: 'Enable the local API (named pipe / unix socket)' },
  'theme.name': { value: 'sensor-dark', description: 'Theme name' },
  'theme.customCss': { value: '', description: 'User CSS appended to the shell' },
  'backup.intervalHours': { value: 6, description: 'Automatic checkpoint interval (0 = off)' },
  'agents.default': { value: 'claude', description: 'Default coding agent adapter' },
  'shortcuts.overrides': { value: {}, description: 'Command id -> accelerator overrides' },
};

export class Settings {
  private cache = new Map<string, unknown>();

  constructor(private db: Db, private onChange?: (key: string, value: unknown) => void) {
    for (const r of db.all('SELECT key, value FROM settings')) {
      try {
        this.cache.set(r.key, JSON.parse(r.value));
      } catch {
        /* ignore corrupt values */
      }
    }
  }

  get<T>(key: string): T | undefined {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    return SETTING_DEFAULTS[key]?.value as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.cache.set(key, value);
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    this.onChange?.(key, value);
  }

  reset(key: string): void {
    this.cache.delete(key);
    this.db.run('DELETE FROM settings WHERE key = ?', key);
    this.onChange?.(key, this.get(key));
  }

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(SETTING_DEFAULTS)) out[k] = d.value;
    for (const [k, v] of this.cache) out[k] = v;
    return out;
  }
}

const INTERNAL = /^(workspace\.active|layouts\.saved)$/;

export function settingsCommands(core: Core): CommandDef[] {
  return [
    {
      id: 'settings.list', title: 'List Settings', scopes: ['app:read'], palette: false,
      handler: () => {
        const all = core.settings.all();
        return Object.entries(all)
          .filter(([k]) => !INTERNAL.test(k))
          .map(([key, value]) => ({ key, value, description: SETTING_DEFAULTS[key]?.description ?? '' }));
      },
    },
    {
      id: 'settings.get', title: 'Get Setting', scopes: ['app:read'], palette: false,
      params: { key: { type: 'string', required: true, positional: 0 } },
      handler: (a) => ({ key: a.key, value: core.settings.get(a.key) }),
    },
    {
      id: 'settings.set', title: 'Change Setting', scopes: ['app:write'], palette: false,
      params: { key: { type: 'string', required: true, positional: 0 }, value: { type: 'any', required: true, positional: 1 } },
      handler: (a) => {
        let v = a.value;
        const def = SETTING_DEFAULTS[a.key]?.value;
        if (typeof v === 'string' && def !== undefined && typeof def !== 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            throw new Error(`${a.key} expects ${Array.isArray(def) ? 'a JSON array' : typeof def}`);
          }
        }
        core.settings.set(a.key, v);
        return { key: a.key, value: v };
      },
    },
    {
      id: 'settings.reset', title: 'Reset Setting', scopes: ['app:write'], palette: false,
      params: { key: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        core.settings.reset(a.key);
        return { key: a.key, value: core.settings.get(a.key) };
      },
    },
    {
      id: 'settings.open', title: 'Open Settings', scopes: ['app:write'], shortcut: 'CmdOrCtrl+,',
      handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'settings' } }) }),
    },
    {
      id: 'perf.toggle', title: 'Toggle Performance Mode', scopes: ['app:write'],
      handler: async (_a, ctx) => {
        const on = !core.settings.get<boolean>('perf.mode');
        core.settings.set('perf.mode', on);
        if (on) await ctx.run('tabs.suspendInactive');
        return { perfMode: on };
      },
    },
  ];
}
