// History, bookmarks, downloads, profiles and notifications: browser data that
// lives in SQLite, separate from the live views managed by the Electron layer.
import type { Core } from '../core';
import type { CommandDef } from '../commands';
import { now, uid } from '../db';
import { isIncognito } from './workspaces';

export class BrowserData {
  constructor(private core: Core) {
    if (!core.db.get("SELECT id FROM profiles WHERE id = 'default'")) {
      core.db.run("INSERT INTO profiles (id, name, color, created_at) VALUES ('default', 'Default', '#4fd1c5', ?)", now());
    }
  }

  recordVisit(url: string, title: string, profileId: string): void {
    if (isIncognito(profileId)) return;
    if (!/^https?:|^file:/.test(url)) return;
    const last = this.core.db.get<{ id: number; url: string; visited_at: number }>('SELECT id, url, visited_at FROM history ORDER BY id DESC LIMIT 1');
    // Collapse redirects/reloads of the same URL within 30s into one entry.
    if (last && last.url === url && now() - last.visited_at < 30_000) {
      this.core.db.run('UPDATE history SET title = ?, visited_at = ? WHERE id = ?', title, now(), last.id);
      return;
    }
    this.core.db.run('INSERT INTO history (url, title, profile_id, visited_at) VALUES (?, ?, ?, ?)', url, title, profileId, now());
  }

  updateTitle(url: string, title: string, profileId: string): void {
    if (isIncognito(profileId)) return;
    this.core.db.run('UPDATE history SET title = ? WHERE id = (SELECT id FROM history WHERE url = ? ORDER BY id DESC LIMIT 1)', title, url);
  }

  history(q: string | undefined, limit: number, offset = 0) {
    if (q) {
      const like = `%${q}%`;
      return this.core.db.all('SELECT * FROM history WHERE url LIKE ? OR title LIKE ? ORDER BY visited_at DESC LIMIT ? OFFSET ?', like, like, limit, offset);
    }
    return this.core.db.all('SELECT * FROM history ORDER BY visited_at DESC LIMIT ? OFFSET ?', limit, offset);
  }

  addBookmark(url: string, title: string, folder = '') {
    const existing = this.core.db.get('SELECT * FROM bookmarks WHERE url = ?', url);
    if (existing) return existing;
    const b = { id: uid('bm_'), url, title, folder, created_at: now() };
    this.core.db.run('INSERT INTO bookmarks (id, url, title, folder, created_at) VALUES (?, ?, ?, ?, ?)', b.id, b.url, b.title, b.folder, b.created_at);
    this.core.events.emit('bookmark.added', b);
    return b;
  }

  // downloads
  downloadStarted(d: { id: string; url: string; filename: string; path: string; total: number; profileId: string }) {
    this.core.db.run(
      'INSERT INTO downloads (id, url, filename, path, state, received, total, profile_id, started_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      d.id, d.url, d.filename, d.path, 'progressing', d.total, isIncognito(d.profileId) ? 'incognito' : d.profileId, now(),
    );
    this.core.events.emit('download.started', d);
  }

  downloadProgress(id: string, received: number, total: number, path: string) {
    this.core.db.run('UPDATE downloads SET received = ?, total = ?, path = ? WHERE id = ?', received, total, path, id);
    this.core.events.emit('download.progress', { id, received, total });
  }

  downloadDone(id: string, state: 'completed' | 'cancelled' | 'interrupted', path: string) {
    this.core.db.run('UPDATE downloads SET state = ?, path = ?, finished_at = ? WHERE id = ?', state, path, now(), id);
    const row = this.core.db.get('SELECT * FROM downloads WHERE id = ?', id);
    this.core.events.emit(`download.${state}`, row);
    if (state === 'completed') this.core.notify('info', 'Download complete', row?.filename ?? path, 'downloads');
    if (row?.profile_id === 'incognito' && state !== 'completed') this.core.db.run('DELETE FROM downloads WHERE id = ?', id);
  }
}

export function browserDataCommands(core: Core): CommandDef[] {
  const B = () => core.browserData;
  return [
    {
      id: 'history.search', title: 'Search History', scopes: ['history:read'], palette: false,
      params: { q: { type: 'string', positional: 0 }, limit: { type: 'number', default: 50 }, offset: { type: 'number', default: 0 } },
      handler: (a) => B().history(a.q, a.limit, a.offset),
    },
    {
      id: 'history.delete', title: 'Delete History Entry', scopes: ['history:write'], destructive: true, palette: false,
      params: { id: { type: 'number' }, url: { type: 'string' } },
      handler: (a) => {
        if (a.id) return { deleted: core.db.run('DELETE FROM history WHERE id = ?', a.id).changes };
        if (a.url) return { deleted: core.db.run('DELETE FROM history WHERE url = ?', a.url).changes };
        throw new Error('id or url required');
      },
    },
    {
      id: 'history.clear', title: 'Clear Browsing History', scopes: ['history:write'], destructive: true,
      params: { sinceMinutes: { type: 'number', description: 'only clear the last N minutes' } },
      handler: (a) => {
        const r = a.sinceMinutes ? core.db.run('DELETE FROM history WHERE visited_at >= ?', now() - a.sinceMinutes * 60_000) : core.db.run('DELETE FROM history');
        core.search.removeSource('history');
        return { deleted: r.changes };
      },
    },
    { id: 'history.open', title: 'Show History', scopes: ['workspaces:write'], shortcut: 'CmdOrCtrl+H', handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'history' } }) }) },
    {
      id: 'bookmarks.list', title: 'List Bookmarks', scopes: ['history:read'], palette: false,
      params: { folder: { type: 'string' } },
      handler: (a) => (a.folder !== undefined ? core.db.all('SELECT * FROM bookmarks WHERE folder = ? ORDER BY created_at', a.folder) : core.db.all('SELECT * FROM bookmarks ORDER BY folder, created_at')),
    },
    {
      id: 'bookmarks.add', title: 'Bookmark Current Tab', scopes: ['history:write'], shortcut: 'CmdOrCtrl+D',
      params: { url: { type: 'string', positional: 0 }, title: { type: 'string' }, folder: { type: 'string', default: '' } },
      handler: (a) => {
        if (a.url) return B().addBookmark(a.url, a.title ?? a.url, a.folder);
        const w = core.workspaces.active();
        if (!w.activeTab) throw new Error('no active tab');
        const t = core.workspaces.tab(w.activeTab);
        return B().addBookmark(t.url, a.title ?? t.title, a.folder);
      },
    },
    {
      id: 'bookmarks.remove', title: 'Remove Bookmark', scopes: ['history:write'], palette: false,
      params: { id: { type: 'string', positional: 0 }, url: { type: 'string' } },
      handler: (a) => ({ deleted: core.db.run('DELETE FROM bookmarks WHERE id = ? OR url = ?', a.id ?? '', a.url ?? '').changes }),
    },
    { id: 'bookmarks.open', title: 'Show Bookmarks', scopes: ['workspaces:write'], handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'bookmarks' } }) }) },
    {
      id: 'downloads.list', title: 'List Downloads', scopes: ['downloads:read'], palette: false,
      params: { limit: { type: 'number', default: 100 } },
      handler: (a) => core.db.all("SELECT * FROM downloads WHERE profile_id != 'incognito' OR state = 'progressing' ORDER BY started_at DESC LIMIT ?", a.limit),
    },
    { id: 'downloads.open', title: 'Show Downloads', scopes: ['workspaces:write'], shortcut: 'CmdOrCtrl+J', handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'downloads' } }) }) },
    {
      id: 'downloads.openFile', title: 'Open Downloaded File', scopes: ['downloads:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, reveal: { type: 'boolean', default: false } },
      handler: async (a) => {
        const d = core.db.get('SELECT * FROM downloads WHERE id = ?', a.id);
        if (!d?.path) throw new Error('download not found');
        if (a.reveal) core.platform.showInFolder(d.path);
        else await core.platform.openPath(d.path);
        return { path: d.path };
      },
    },
    {
      id: 'downloads.clear', title: 'Clear Download List', scopes: ['downloads:write'],
      handler: () => ({ deleted: core.db.run("DELETE FROM downloads WHERE state != 'progressing'").changes }),
    },
    {
      id: 'profiles.list', title: 'List Profiles', scopes: ['app:read'], palette: false,
      handler: () => core.db.all('SELECT * FROM profiles ORDER BY created_at'),
    },
    {
      id: 'profiles.create', title: 'New Browser Profile', scopes: ['app:write'],
      params: { name: { type: 'string', required: true, positional: 0 }, color: { type: 'string' } },
      handler: (a) => {
        const id = uid('prof_');
        core.db.run('INSERT INTO profiles (id, name, color, created_at) VALUES (?, ?, ?, ?)', id, a.name, a.color ?? null, now());
        return { id, name: a.name };
      },
    },
    {
      id: 'profiles.delete', title: 'Delete Browser Profile', scopes: ['app:write'], destructive: true, palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        if (a.id === 'default') throw new Error('cannot delete the default profile');
        if (core.workspaces.allTabs().some((t) => t.profileId === a.id)) throw new Error('profile has open tabs');
        core.db.run('DELETE FROM profiles WHERE id = ?', a.id);
        core.events.emit('profile.deleted', { id: a.id });
        return { ok: true };
      },
    },
    // notifications
    {
      id: 'notifications.list', title: 'List Notifications', scopes: ['app:read'], palette: false,
      params: { unread: { type: 'boolean', default: false }, limit: { type: 'number', default: 100 } },
      handler: (a) => core.db.all(`SELECT * FROM notifications ${a.unread ? 'WHERE read = 0' : ''} ORDER BY created_at DESC LIMIT ?`, a.limit),
    },
    {
      id: 'notifications.markRead', title: 'Mark Notifications Read', scopes: ['app:write'],
      params: { id: { type: 'string', positional: 0 } },
      handler: (a) => {
        const r = a.id ? core.db.run('UPDATE notifications SET read = 1 WHERE id = ?', a.id) : core.db.run('UPDATE notifications SET read = 1');
        core.events.emit('notification.read', { id: a.id ?? null });
        return { updated: r.changes };
      },
    },
    {
      id: 'notifications.clear', title: 'Clear Notifications', scopes: ['app:write'],
      handler: () => {
        const r = core.db.run('DELETE FROM notifications');
        core.events.emit('notification.read', { id: null });
        return { deleted: r.changes };
      },
    },
    {
      id: 'notifications.push', title: 'Post Notification', scopes: ['app:write'], palette: false,
      params: { title: { type: 'string', required: true, positional: 0 }, body: { type: 'string', positional: 1 }, level: { type: 'string', enum: ['info', 'success', 'warning', 'error'], default: 'info' } },
      handler: (a, ctx) => core.notify(a.level, a.title, a.body ?? '', ctx.principal.kind === 'user' ? 'user' : ctx.principal.name),
    },
    { id: 'notifications.open', title: 'Show Notifications', scopes: ['workspaces:write'], handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'notifications' } }) }) },
  ];
}
