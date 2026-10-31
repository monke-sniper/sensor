// Sensor core: owns all state and services. Runs inside the Electron main
// process in the app, and in plain Node for tests.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CommandBus, type CommandDef } from './commands';
import { Db, now, uid } from './db';
import { EventBus } from './events';
import { nullBrowserHost, type BrowserHost, type PlatformHost, type TerminalHost } from './host';
import { AuditLog, SCOPES, TokenStore, type Scope } from './permissions';
import { BrowserData, browserDataCommands } from './services/browserdata';
import { Resources, resourceCommands } from './services/resources';
import { Search, registerCoreSearchSources, searchCommands } from './services/search';
import { Settings, settingsCommands } from './services/settings';
import { Workspaces, workspaceCommands } from './services/workspaces';

export interface CoreOptions {
  dataDir: string;
  browser?: BrowserHost;
  platform?: PlatformHost;
  terminals?: TerminalHost | null;
  /** Extra service modules (notes, files, macros, ...) registered after the base. */
  modules?: CoreModule[];
}

export interface CoreModule {
  name: string;
  init(core: Core): void | CommandDef[];
  dispose?(): void;
}

export class Core {
  readonly dataDir: string;
  readonly db: Db;
  readonly events = new EventBus();
  readonly audit: AuditLog;
  readonly tokens: TokenStore;
  readonly bus: CommandBus;
  readonly settings: Settings;
  readonly browserData: BrowserData;
  readonly resources: Resources;
  readonly search: Search;
  readonly workspaces: Workspaces;
  browser: BrowserHost;
  platform: PlatformHost;
  terminals: TerminalHost | null;
  private modules: CoreModule[] = [];
  /** Module instances by name, for cross-module access. */
  readonly services: Record<string, any> = {};
  readonly startedAt = now();

  constructor(opts: CoreOptions) {
    this.dataDir = opts.dataDir;
    mkdirSync(opts.dataDir, { recursive: true });
    this.db = new Db(join(opts.dataDir, 'core.db'));
    this.audit = new AuditLog(this.db);
    this.tokens = new TokenStore(this.db);
    this.bus = new CommandBus(this.events, this.audit);
    this.settings = new Settings(this.db, (key, value) => this.events.emit('settings.changed', { key, value }));
    this.browser = opts.browser ?? nullBrowserHost();
    this.platform = opts.platform ?? nodePlatformHost();
    this.terminals = opts.terminals ?? null;
    this.browserData = new BrowserData(this);
    this.resources = new Resources(this);
    this.search = new Search(this);
    this.workspaces = new Workspaces(this);

    this.bus.registerAll([
      ...appCommands(this),
      ...settingsCommands(this),
      ...workspaceCommands(this),
      ...browserDataCommands(this),
      ...resourceCommands(this),
      ...searchCommands(this),
    ]);
    registerCoreSearchSources(this);

    for (const m of opts.modules ?? []) this.use(m);
  }

  use(m: CoreModule): void {
    const defs = m.init(this);
    if (defs) this.bus.registerAll(defs);
    this.modules.push(m);
  }

  /** Run a command as the GUI user. */
  run<T = any>(id: string, args?: Record<string, any>): Promise<T> {
    return this.bus.run<T>(id, args, { kind: 'user' });
  }

  notify(level: 'info' | 'success' | 'warning' | 'error', title: string, body = '', source = 'sensor') {
    const n = { id: uid('ntf_'), level, title, body, source, created_at: now(), read: 0 };
    this.db.run('INSERT INTO notifications (id, level, title, body, source, created_at, read) VALUES (?, ?, ?, ?, ?, ?, 0)', n.id, level, title, body, source, n.created_at);
    // keep the table bounded
    this.db.run('DELETE FROM notifications WHERE id IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT -1 OFFSET 500)');
    this.events.emit('notification.posted', n);
    return n;
  }

  dispose(): void {
    for (const m of [...this.modules].reverse()) {
      try {
        m.dispose?.();
      } catch (e) {
        console.error(`[core] dispose ${m.name} failed`, e);
      }
    }
    this.db.close();
  }
}

function appCommands(core: Core): CommandDef[] {
  return [
    {
      id: 'commands.list', title: 'List Commands', scopes: [], palette: false,
      handler: () => core.bus.list(),
    },
    {
      id: 'commands.describe', title: 'Describe Command', scopes: [], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const info = core.bus.info(a.id);
        if (!info) throw new Error(`unknown command: ${a.id}`);
        return info;
      },
    },
    {
      id: 'app.status', title: 'Application Status', scopes: ['app:read'], palette: false,
      handler: () => ({
        version: core.settings.get('app.version') ?? 'dev',
        uptimeMs: now() - core.startedAt,
        workspace: core.workspaces.active().name,
        workspaces: core.workspaces.list().length,
        tabs: core.workspaces.allTabs().length,
        liveTabs: core.workspaces.allTabs().filter((t) => core.browser.isLive(t.id)).length,
        indexed: core.search.indexed(),
        perfMode: !!core.settings.get('perf.mode'),
      }),
    },
    {
      id: 'auth.scopes', title: 'List Permission Scopes', scopes: [], palette: false,
      handler: () => Object.entries(SCOPES).map(([scope, description]) => ({ scope, description })),
    },
    {
      id: 'auth.list', title: 'List API Tokens', scopes: ['auth:admin'], palette: false,
      handler: () => core.tokens.list(),
    },
    {
      id: 'auth.grant', title: 'Create API Token', scopes: ['auth:admin'], palette: false,
      params: { name: { type: 'string', required: true, positional: 0 }, scopes: { type: 'array', required: true, positional: 1 } },
      handler: (a) => {
        const { id, token } = core.tokens.create(a.name, a.scopes as Scope[]);
        return { id, name: a.name, scopes: a.scopes, token, note: 'Shown once. Store it securely.' };
      },
    },
    {
      id: 'auth.revoke', title: 'Revoke API Token', scopes: ['auth:admin'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0, description: 'token id or name' } },
      handler: (a) => ({ revoked: core.tokens.revoke(a.id) }),
    },
    {
      id: 'auth.audit', title: 'API Audit Log', scopes: ['auth:admin'], palette: false,
      params: { limit: { type: 'number', default: 100 } },
      handler: (a) => core.audit.recent(a.limit),
    },
  ];
}

/** Platform host for plain Node (tests, headless). The Electron layer replaces it. */
export function nodePlatformHost(): PlatformHost {
  return {
    async trash(path) {
      const { rmSync } = await import('node:fs');
      rmSync(path, { recursive: true, force: true });
    },
    async openPath() {},
    showInFolder() {},
    async openExternal() {},
    async fetchText(url) {
      const r = await fetch(url);
      return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type') ?? '' };
    },
    clipboardWriteText() {},
  };
}
