// Resource registry: every addressable thing has a URI, and links between
// resources live in one table. Knowledge connections, project associations,
// search results and annotation anchors all use these URIs.
import type { Core } from '../core';
import type { CommandDef } from '../commands';
import { now } from '../db';

export type ResourceKind =
  | 'tab' | 'file' | 'note' | 'command' | 'macro' | 'workspace' | 'annotation' | 'feeditem'
  | 'project' | 'task' | 'download' | 'youtube' | 'chat' | 'web' | 'tag' | 'unknown';

export interface ParsedUri {
  kind: ResourceKind;
  id: string;
  query: Record<string, string>;
  raw: string;
}

export function parseUri(uri: string): ParsedUri {
  if (/^https?:/i.test(uri)) {
    const yt = youtubeId(uri);
    if (yt) {
      const t = new URL(uri).searchParams.get('t');
      return { kind: 'youtube', id: yt, query: t ? { t: String(parseTime(t)) } : {}, raw: uri };
    }
    return { kind: 'web', id: uri, query: {}, raw: uri };
  }
  if (uri.startsWith('tag:')) return { kind: 'tag', id: uri.slice(4), query: {}, raw: uri };
  const m = /^sensor:\/\/([a-z]+)\/(.*)$/i.exec(uri);
  if (!m) return { kind: 'unknown', id: uri, query: {}, raw: uri };
  const [path, qs] = m[2].split('?');
  const query: Record<string, string> = {};
  if (qs) for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  return { kind: m[1].toLowerCase() as ResourceKind, id: decodeURIComponent(path), query, raw: uri };
}

export function fileUri(path: string): string {
  return `sensor://file/${encodeURIComponent(path)}`;
}

export function noteUri(vault: string, path: string): string {
  return `sensor://note/${encodeURIComponent(vault)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const s = /^\/(shorts|embed|live)\/([\w-]+)/.exec(u.pathname);
      if (s) return s[2];
    }
  } catch {
    /* not a url */
  }
  return null;
}

/** "1h2m3s" | "93" | "1:33" -> seconds */
export function parseTime(t: string): number {
  if (/^\d+$/.test(t)) return Number(t);
  if (/^\d+(:\d+)+$/.test(t)) return t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(t);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function formatTime(sec: number): string {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function youtubeUrl(id: string, t?: number): string {
  return `https://youtu.be/${id}${t ? `?t=${Math.floor(t)}` : ''}`;
}

export class Resources {
  constructor(private core: Core) {}

  link(src: string, dst: string, kind = 'ref'): void {
    this.core.db.run('INSERT OR IGNORE INTO links (src, dst, kind, created_at) VALUES (?, ?, ?, ?)', src, dst, kind, now());
    this.core.events.emit('link.added', { src, dst, kind });
  }

  unlink(src: string, dst: string, kind?: string): number {
    const r = kind ? this.core.db.run('DELETE FROM links WHERE src = ? AND dst = ? AND kind = ?', src, dst, kind) : this.core.db.run('DELETE FROM links WHERE src = ? AND dst = ?', src, dst);
    return r.changes;
  }

  linksFrom(src: string) {
    return this.core.db.all('SELECT * FROM links WHERE src = ? ORDER BY created_at', src);
  }

  linksTo(dst: string) {
    return this.core.db.all('SELECT * FROM links WHERE dst = ? ORDER BY created_at', dst);
  }

  /** The command that "opens" a resource. */
  openAction(uri: string): { command: string; args: Record<string, any> } {
    const p = parseUri(uri);
    switch (p.kind) {
      case 'tab':
        return { command: 'tabs.activate', args: { id: p.id } };
      case 'web':
        return { command: 'tabs.open', args: { url: p.raw } };
      case 'youtube':
        return { command: 'tabs.open', args: { url: youtubeUrl(p.id, p.query.t ? Number(p.query.t) : undefined) } };
      case 'command':
        return { command: p.id, args: {} };
      case 'macro':
        return { command: 'macros.run', args: { id: p.id } };
      case 'workspace':
        return { command: 'workspaces.switch', args: { id: p.id } };
      case 'note': {
        const [vault, ...rest] = p.id.split('/');
        return { command: 'notes.open', args: { vault, path: rest.join('/') } };
      }
      case 'file':
        return { command: 'files.open', args: { path: p.id } };
      case 'annotation': {
        const a = this.core.db.get('SELECT url FROM annotations WHERE id = ?', p.id);
        if (!a) throw new Error('annotation not found');
        return { command: 'tabs.open', args: { url: a.url } };
      }
      case 'feeditem': {
        const it = this.core.db.get('SELECT url FROM feed_items WHERE id = ?', p.id);
        if (!it?.url) throw new Error('feed item not found');
        return { command: 'feeds.openItem', args: { id: p.id } };
      }
      case 'project':
        return { command: 'projects.open', args: { id: p.id } };
      default:
        throw new Error(`don't know how to open ${uri}`);
    }
  }
}

export function resourceCommands(core: Core): CommandDef[] {
  return [
    {
      id: 'resources.open', title: 'Open Resource', scopes: [], palette: false,
      params: { uri: { type: 'string', required: true, positional: 0 } },
      // No scope of its own: the command it resolves to is permission-checked.
      handler: (a, ctx) => {
        const act = core.resources.openAction(a.uri);
        return ctx.run(act.command, act.args);
      },
    },
    {
      id: 'resources.parse', title: 'Parse Resource URI', scopes: [], palette: false,
      params: { uri: { type: 'string', required: true, positional: 0 } },
      handler: (a) => parseUri(a.uri),
    },
    {
      id: 'links.add', title: 'Link Resources', scopes: ['notes:write'], palette: false,
      params: { src: { type: 'string', required: true, positional: 0 }, dst: { type: 'string', required: true, positional: 1 }, kind: { type: 'string', default: 'ref' } },
      handler: (a) => {
        core.resources.link(a.src, a.dst, a.kind);
        return { ok: true };
      },
    },
    {
      id: 'links.remove', title: 'Unlink Resources', scopes: ['notes:write'], palette: false,
      params: { src: { type: 'string', required: true, positional: 0 }, dst: { type: 'string', required: true, positional: 1 }, kind: { type: 'string' } },
      handler: (a) => ({ removed: core.resources.unlink(a.src, a.dst, a.kind) }),
    },
    {
      id: 'links.list', title: 'List Links', scopes: ['notes:read'], palette: false,
      params: { uri: { type: 'string', required: true, positional: 0 } },
      handler: (a) => ({ from: core.resources.linksFrom(a.uri), to: core.resources.linksTo(a.uri) }),
    },
  ];
}
