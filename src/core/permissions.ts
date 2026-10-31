import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db';
import { now, uid } from './db';

/** Every scope a command can require. Grants are explicit; nothing is implied except "*". */
export const SCOPES = {
  'app:read': 'Read application state, settings, metrics',
  'app:write': 'Change settings, layouts, themes',
  'workspaces:read': 'List workspaces',
  'workspaces:write': 'Create, switch, modify workspaces and panels',
  'tabs:read': 'List tabs and their URLs/titles',
  'tabs:write': 'Open, close, navigate tabs',
  'page:read': 'Read page content and selected text',
  'page:interact': 'Click, type and run scripts in pages',
  'forms:submit': 'Submit forms / send messages on websites',
  'history:read': 'Read browsing history and bookmarks',
  'history:write': 'Modify history and bookmarks',
  'downloads:read': 'List downloads',
  'downloads:write': 'Start, cancel, open downloads',
  'search:read': 'Query the universal search index',
  'notes:read': 'Read notes and annotations',
  'notes:write': 'Create or modify notes and annotations',
  'files:read': 'Read files and directories',
  'files:write': 'Create, copy, move, rename, convert files',
  'files:delete': 'Delete files',
  'clipboard:read': 'Read clipboard history',
  'clipboard:write': 'Write to clipboard / manage history',
  'feeds:read': 'Read RSS feeds and items',
  'feeds:write': 'Manage feeds and collections',
  'macros:read': 'List macros and runs',
  'macros:run': 'Run macros',
  'macros:write': 'Create, edit, import macros and triggers',
  'projects:read': 'Read projects, git status, tasks',
  'projects:write': 'Create worktrees, tasks, handoffs',
  'git:destructive': 'Merge into protected branches, delete worktrees/branches',
  'agents:read': 'Read agent sessions and usage',
  'agents:control': 'Start, prompt, stop agents',
  'terminals:read': 'Read terminal output',
  'terminals:write': 'Open terminals and send input',
  'ai:send': 'Send content to configured AI websites',
  'auth:admin': 'Create and revoke API tokens',
  'backup:write': 'Create and restore checkpoints',
  'scripts:exec': 'Run user scripts',
} as const;

export type Scope = keyof typeof SCOPES | '*';

export type Principal =
  | { kind: 'user' }
  | { kind: 'token'; id: string; name: string; scopes: Scope[] }
  | { kind: 'macro'; id: string; name: string; scopes: Scope[] };

export function principalLabel(p: Principal): string {
  return p.kind === 'user' ? 'user' : `${p.kind}:${p.name}`;
}

export function hasScope(p: Principal, scope: Scope): boolean {
  if (p.kind === 'user') return true;
  return p.scopes.includes('*') || p.scopes.includes(scope);
}

export function missingScopes(p: Principal, required: Scope[]): Scope[] {
  return required.filter((s) => !hasScope(p, s));
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class TokenStore {
  constructor(private db: Db) {}

  /** Returns the plaintext token exactly once. Only the hash is stored. */
  create(name: string, scopes: Scope[]): { id: string; token: string } {
    for (const s of scopes) {
      if (s !== '*' && !(s in SCOPES)) throw new Error(`unknown scope: ${s}`);
    }
    const token = 'snsr_' + randomBytes(24).toString('base64url');
    const id = uid('tok_');
    this.db.run('INSERT INTO tokens (id, name, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)', id, name, hashToken(token), JSON.stringify(scopes), now());
    return { id, token };
  }

  verify(token: string): Principal | null {
    if (!token) return null;
    const row = this.db.get('SELECT * FROM tokens WHERE hash = ?', hashToken(token));
    if (!row) return null;
    this.db.run('UPDATE tokens SET last_used = ? WHERE id = ?', now(), row.id);
    return { kind: 'token', id: row.id, name: row.name, scopes: JSON.parse(row.scopes) };
  }

  list(): { id: string; name: string; scopes: Scope[]; created_at: number; last_used: number | null }[] {
    return this.db.all('SELECT id, name, scopes, created_at, last_used FROM tokens ORDER BY created_at').map((r) => ({ ...r, scopes: JSON.parse(r.scopes) })) as any;
  }

  revoke(id: string): boolean {
    return this.db.run('DELETE FROM tokens WHERE id = ? OR name = ?', id, id).changes > 0;
  }
}

export class AuditLog {
  constructor(private db: Db) {}
  record(p: Principal, command: string, ok: boolean, error?: string): void {
    if (p.kind === 'user') return; // GUI actions by the user are not audited; external access is.
    this.db.run('INSERT INTO audit (ts, principal, command, ok, error) VALUES (?, ?, ?, ?, ?)', now(), principalLabel(p), command, ok ? 1 : 0, error ?? null);
  }
  recent(limit = 100) {
    return this.db.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', limit);
  }
}
