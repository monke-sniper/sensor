// SQLite storage built on node:sqlite (bundled with Node/Electron) so there is
// no native module to rebuild per Electron version or per platform.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

// node:sqlite still prints an ExperimentalWarning; it is stable enough for our
// use and the warning is noise in the CLI and in tests.
const origEmit = process.emitWarning;
(process as any).emitWarning = function (warning: any, ...rest: any[]) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return (origEmit as any).call(process, warning, ...rest);
};

export type Row = Record<string, any>;

const MIGRATIONS: string[] = [
  // v1: core state
  `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, position INTEGER NOT NULL DEFAULT 0,
    layout TEXT NOT NULL, active_tab TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT,
    favicon TEXT, profile_id TEXT NOT NULL DEFAULT 'default', position INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0, group_name TEXT, last_active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT, profile_id TEXT NOT NULL,
    visited_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS history_visited ON history(visited_at DESC);
  CREATE INDEX IF NOT EXISTS history_url ON history(url);
  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, folder TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, filename TEXT NOT NULL, path TEXT, state TEXT NOT NULL,
    received INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, profile_id TEXT, started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, body TEXT, source TEXT,
    created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used INTEGER
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, principal TEXT NOT NULL, command TEXT NOT NULL,
    ok INTEGER NOT NULL, error TEXT
  );
  CREATE TABLE IF NOT EXISTS links (
    src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'ref', created_at INTEGER NOT NULL,
    PRIMARY KEY (src, dst, kind)
  );
  CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, kind TEXT NOT NULL, quote TEXT, note TEXT, color TEXT,
    anchor TEXT, x REAL, y REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS annotations_url ON annotations(url);
  CREATE TABLE IF NOT EXISTS clipboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT, image BLOB, hash TEXT NOT NULL,
    source TEXT, created_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS clipboard_hash ON clipboard(hash);
  CREATE TABLE IF NOT EXISTS feeds (
    id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT, folder TEXT NOT NULL DEFAULT '',
    last_fetched INTEGER, error TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feed_items (
    id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, guid TEXT NOT NULL, title TEXT, url TEXT, summary TEXT,
    published_at INTEGER, read INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0,
    UNIQUE(feed_id, guid)
  );
  CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS macros (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS macro_runs (
    id TEXT PRIMARY KEY, macro_id TEXT NOT NULL, state TEXT NOT NULL, log TEXT NOT NULL DEFAULT '[]',
    outputs TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY, macro_id TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    last_fired INTEGER
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, protected_branches TEXT NOT NULL DEFAULT '["main","master"]',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT, state TEXT NOT NULL,
    agent TEXT, worktree TEXT, branch TEXT, depends_on TEXT NOT NULL DEFAULT '[]', validation TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_agent TEXT, to_agent TEXT, message TEXT NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL, purpose TEXT,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    uri UNINDEXED, source UNINDEXED, title, body, updated UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  private migrate(): void {
    const current = (this.raw.prepare('PRAGMA user_version').get() as Row).user_version as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export function now(): number {
  return Date.now();
}

let counter = 0;
export function uid(prefix = ''): string {
  counter = (counter + 1) % 0xffff;
  return prefix + Date.now().toString(36) + counter.toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 7);
}
