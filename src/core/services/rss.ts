// RSS/Atom reader with reading lists (collections). Deterministic: no AI.
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import type { Core, CoreModule } from '../core';
import type { CommandDef } from '../commands';
import { now, uid } from '../db';

export interface FeedItem {
  guid: string;
  title: string;
  url: string | null;
  summary: string;
  published: number | null;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

const text = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text'] ?? v['@_href'] ?? '');
  return '';
};

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function parseFeed(xml: string): ParsedFeed {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: true, htmlEntities: true });
  const doc = p.parse(xml);
  const date = (s: string) => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  };
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    return {
      title: text(ch.title),
      items: asArray(ch.item).map((it: any) => {
        const link = text(it.link) || null;
        return { guid: text(it.guid) || link || text(it.title), title: stripHtml(text(it.title)), url: link, summary: stripHtml(text(it.description ?? it['content:encoded'])).slice(0, 1000), published: date(text(it.pubDate ?? it['dc:date'])) };
      }),
    };
  }
  if (doc.feed) {
    const f = doc.feed;
    return {
      title: stripHtml(text(f.title)),
      items: asArray(f.entry).map((e: any) => {
        const links = asArray(e.link);
        const alt = links.find((l: any) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
        const url = alt ? alt['@_href'] ?? text(alt) : null;
        return { guid: text(e.id) || url || text(e.title), title: stripHtml(text(e.title)), url, summary: stripHtml(text(e.summary ?? e.content)).slice(0, 1000), published: date(text(e.published ?? e.updated)) };
      }),
    };
  }
  if (doc['rdf:RDF']) {
    const r = doc['rdf:RDF'];
    return {
      title: text(r.channel?.title),
      items: asArray(r.item).map((it: any) => ({ guid: text(it['@_rdf:about']) || text(it.link), title: stripHtml(text(it.title)), url: text(it.link) || null, summary: stripHtml(text(it.description)).slice(0, 1000), published: date(text(it['dc:date'])) })),
    };
  }
  throw new Error('not an RSS/Atom feed');
}

/** Find feed URLs advertised by an HTML page. */
export function discoverFeeds(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) out.push(new URL(href, base).toString());
  }
  return out;
}

export class Feeds {
  private timer: NodeJS.Timeout | null = null;
  constructor(private core: Core) {}

  start(): void {
    this.stop();
    const mins = Math.max(5, this.core.settings.get<number>('rss.refreshMinutes') ?? 60);
    this.timer = setInterval(() => this.refreshAll().catch(() => {}), mins * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async add(url: string, folder = ''): Promise<{ id: string; title: string; items: number }> {
    let res = await this.core.platform.fetchText(url);
    let feedUrl = url;
    if (/html/i.test(res.contentType) || /^\s*<!doctype html|<html/i.test(res.text)) {
      const found = discoverFeeds(res.text, url);
      if (!found.length) throw new Error('no feed found on that page');
      feedUrl = found[0];
      res = await this.core.platform.fetchText(feedUrl);
    }
    const parsed = parseFeed(res.text);
    const existing = this.core.db.get('SELECT id FROM feeds WHERE url = ?', feedUrl);
    const id = existing?.id ?? uid('feed_');
    if (!existing) this.core.db.run('INSERT INTO feeds (id, url, title, folder, created_at) VALUES (?, ?, ?, ?, ?)', id, feedUrl, parsed.title || feedUrl, folder, now());
    const n = this.store(id, parsed, false);
    return { id, title: parsed.title, items: n };
  }

  private store(feedId: string, parsed: ParsedFeed, notifyNew: boolean): number {
    let added = 0;
    this.core.db.tx(() => {
      for (const it of parsed.items) {
        const id = 'fi_' + createHash('sha1').update(feedId + '\0' + it.guid).digest('hex').slice(0, 16);
        const r = this.core.db.run(
          'INSERT OR IGNORE INTO feed_items (id, feed_id, guid, title, url, summary, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, feedId, it.guid, it.title, it.url, it.summary, it.published ?? now(),
        );
        if (r.changes) {
          added++;
          this.core.search.index({ uri: `sensor://feeditem/${id}`, source: 'feeds', title: it.title, body: it.summary });
        }
      }
      this.core.db.run('UPDATE feeds SET last_fetched = ?, error = NULL, title = COALESCE(NULLIF(title, url), ?) WHERE id = ?', now(), parsed.title, feedId);
    });
    if (added && notifyNew) {
      const f = this.core.db.get('SELECT title FROM feeds WHERE id = ?', feedId);
      this.core.notify('info', `${added} new in ${f?.title ?? 'feed'}`, '', 'rss');
    }
    if (added) this.core.events.emit('feed.updated', { id: feedId, added });
    return added;
  }

  async refresh(feedId: string): Promise<number> {
    const f = this.core.db.get('SELECT * FROM feeds WHERE id = ?', feedId);
    if (!f) throw new Error('feed not found');
    try {
      const res = await this.core.platform.fetchText(f.url);
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return this.store(feedId, parseFeed(res.text), true);
    } catch (e: any) {
      this.core.db.run('UPDATE feeds SET error = ?, last_fetched = ? WHERE id = ?', String(e.message), now(), feedId);
      throw e;
    }
  }

  async refreshAll(): Promise<{ added: number; errors: number }> {
    let added = 0;
    let errors = 0;
    for (const f of this.core.db.all('SELECT id FROM feeds')) {
      try {
        added += await this.refresh(f.id);
      } catch {
        errors++;
      }
    }
    return { added, errors };
  }
}

export const rssModule: CoreModule = {
  name: 'rss',
  init(core) {
    const feeds = new Feeds(core);
    core.services.feeds = feeds;
    feeds.start();
    rssModule.dispose = () => feeds.stop();
    core.events.on('settings.changed', (e) => e.data.key === 'rss.refreshMinutes' && feeds.start());
    const defs: CommandDef[] = [
      {
        id: 'feeds.list', title: 'List Feeds', scopes: ['feeds:read'], palette: false,
        handler: () => core.db.all('SELECT f.*, (SELECT count(*) FROM feed_items i WHERE i.feed_id = f.id AND i.read = 0) AS unread FROM feeds f ORDER BY folder, title'),
      },
      {
        id: 'feeds.add', title: 'Subscribe To Feed', scopes: ['feeds:write'],
        params: { url: { type: 'string', required: true, positional: 0, description: 'feed URL or a page that links one' }, folder: { type: 'string', default: '' } },
        handler: (a) => feeds.add(a.url, a.folder),
      },
      {
        id: 'feeds.subscribeCurrent', title: 'Subscribe To Current Site', scopes: ['feeds:write', 'tabs:read'],
        handler: () => {
          const w = core.workspaces.active();
          if (!w.activeTab) throw new Error('no active tab');
          return feeds.add(core.workspaces.tab(w.activeTab).url);
        },
      },
      {
        id: 'feeds.remove', title: 'Unsubscribe Feed', scopes: ['feeds:write'], palette: false, destructive: true,
        params: { id: { type: 'string', required: true, positional: 0 } },
        handler: (a) => {
          for (const it of core.db.all('SELECT id FROM feed_items WHERE feed_id = ? AND saved = 0', a.id)) core.search.remove(`sensor://feeditem/${it.id}`);
          core.db.run('DELETE FROM feed_items WHERE feed_id = ? AND saved = 0', a.id);
          return { deleted: core.db.run('DELETE FROM feeds WHERE id = ?', a.id).changes };
        },
      },
      {
        id: 'feeds.refresh', title: 'Refresh Feeds', scopes: ['feeds:write'],
        params: { id: { type: 'string', positional: 0 } },
        handler: async (a) => (a.id ? { added: await feeds.refresh(a.id) } : feeds.refreshAll()),
      },
      {
        id: 'feeds.items', title: 'Feed Items', scopes: ['feeds:read'], palette: false,
        params: { feed: { type: 'string' }, unread: { type: 'boolean', default: false }, saved: { type: 'boolean', default: false }, q: { type: 'string' }, limit: { type: 'number', default: 100 } },
        handler: (a) => {
          const where: string[] = [];
          const params: any[] = [];
          if (a.feed) (where.push('i.feed_id = ?'), params.push(a.feed));
          if (a.unread) where.push('i.read = 0');
          if (a.saved) where.push('i.saved = 1');
          if (a.q) (where.push('(i.title LIKE ? OR i.summary LIKE ?)'), params.push(`%${a.q}%`, `%${a.q}%`));
          return core.db.all(
            `SELECT i.*, f.title AS feed_title FROM feed_items i JOIN feeds f ON f.id = i.feed_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.published_at DESC LIMIT ?`,
            ...params, a.limit,
          );
        },
      },
      {
        id: 'feeds.markRead', title: 'Mark Feed Items Read', scopes: ['feeds:write'], palette: false,
        params: { id: { type: 'string', positional: 0, description: 'item id' }, feed: { type: 'string' }, read: { type: 'boolean', default: true } },
        handler: (a) => {
          const v = a.read ? 1 : 0;
          const r = a.id ? core.db.run('UPDATE feed_items SET read = ? WHERE id = ?', v, a.id) : a.feed ? core.db.run('UPDATE feed_items SET read = ? WHERE feed_id = ?', v, a.feed) : core.db.run('UPDATE feed_items SET read = ?', v);
          core.events.emit('feed.updated', {});
          return { updated: r.changes };
        },
      },
      {
        id: 'feeds.save', title: 'Save Feed Item', scopes: ['feeds:write'], palette: false,
        params: { id: { type: 'string', required: true, positional: 0 }, saved: { type: 'boolean', default: true }, collection: { type: 'string' } },
        handler: (a) => {
          core.db.run('UPDATE feed_items SET saved = ? WHERE id = ?', a.saved ? 1 : 0, a.id);
          if (a.collection) core.resources.link(`sensor://collection/${a.collection}`, `sensor://feeditem/${a.id}`, 'collection');
          core.events.emit('feed.updated', {});
          return { ok: true };
        },
      },
      {
        id: 'feeds.openItem', title: 'Open Feed Item', scopes: ['feeds:read', 'tabs:write'], palette: false,
        params: { id: { type: 'string', required: true, positional: 0 } },
        handler: async (a, ctx) => {
          const it = core.db.get('SELECT * FROM feed_items WHERE id = ?', a.id);
          if (!it?.url) throw new Error('item has no link');
          core.db.run('UPDATE feed_items SET read = 1 WHERE id = ?', a.id);
          core.events.emit('feed.updated', {});
          return ctx.run('tabs.open', { url: it.url });
        },
      },
      {
        id: 'collections.list', title: 'List Collections', scopes: ['feeds:read'], palette: false,
        handler: () => core.db.all('SELECT c.*, (SELECT count(*) FROM links l WHERE l.src = \'sensor://collection/\' || c.id) AS items FROM collections c ORDER BY name'),
      },
      {
        id: 'collections.create', title: 'New Reading List', scopes: ['feeds:write'],
        params: { name: { type: 'string', required: true, positional: 0 } },
        handler: (a) => {
          const id = uid('col_');
          core.db.run('INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)', id, a.name, now());
          return { id, name: a.name };
        },
      },
      {
        id: 'collections.add', title: 'Add To Reading List', scopes: ['feeds:write'], palette: false,
        params: { collection: { type: 'string', required: true, positional: 0 }, uri: { type: 'string', positional: 1, description: 'URL, note, file or other resource; default: active tab' } },
        handler: (a) => {
          const col = core.db.get('SELECT * FROM collections WHERE id = ? OR name = ?', a.collection, a.collection);
          if (!col) throw new Error('collection not found');
          let uri = a.uri;
          if (!uri) {
            const w = core.workspaces.active();
            if (!w.activeTab) throw new Error('no active tab');
            uri = core.workspaces.tab(w.activeTab).url;
          }
          core.resources.link(`sensor://collection/${col.id}`, uri, 'collection');
          return { ok: true, collection: col.name, uri };
        },
      },
      {
        id: 'collections.items', title: 'Reading List Items', scopes: ['feeds:read'], palette: false,
        params: { collection: { type: 'string', required: true, positional: 0 } },
        handler: (a) => {
          const col = core.db.get('SELECT * FROM collections WHERE id = ? OR name = ?', a.collection, a.collection);
          if (!col) throw new Error('collection not found');
          return core.resources.linksFrom(`sensor://collection/${col.id}`);
        },
      },
      {
        id: 'feeds.panel', title: 'RSS Reader', scopes: ['workspaces:write'],
        handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'rss' } }) }),
      },
    ];
    return defs;
  },
};
