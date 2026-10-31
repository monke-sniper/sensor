// Universal search. Two kinds of sources:
//  - indexed documents in the FTS5 table (notes, files, annotations, feed items, captures)
//  - live sources queried on demand (tabs, history, bookmarks, commands, macros, ...)
// New sources register with `addSource` without touching the rest of the system.
import type { Core } from '../core';
import type { CommandDef } from '../commands';
import { now } from '../db';

export interface SearchHit {
  uri: string;
  source: string;
  title: string;
  snippet?: string;
  score: number; // higher is better
}

export interface SearchSource {
  name: string;
  search(q: string, limit: number): SearchHit[] | Promise<SearchHit[]>;
}

/** Build an FTS5 MATCH expression with prefix matching from free text. */
export function ftsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["*^:()]/g, '').trim())
    .filter(Boolean);
  return terms.map((t) => `"${t}"*`).join(' ');
}

/** Cheap fuzzy score for short strings (palette-style). 0 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx === 0) return 100 - Math.min(t.length, 50) / 10;
  if (idx > 0) return 80 - idx / 5;
  // subsequence match
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    gaps += found - ti;
    ti = found + 1;
  }
  return Math.max(1, 40 - gaps);
}

export class Search {
  private sources = new Map<string, SearchSource>();

  constructor(private core: Core) {}

  addSource(src: SearchSource): void {
    this.sources.set(src.name, src);
  }

  sourceNames(): string[] {
    return ['index', ...this.sources.keys()];
  }

  index(doc: { uri: string; source: string; title: string; body?: string }): void {
    this.core.db.tx(() => {
      this.core.db.run('DELETE FROM search_index WHERE uri = ?', doc.uri);
      this.core.db.run('INSERT INTO search_index (uri, source, title, body, updated) VALUES (?, ?, ?, ?, ?)', doc.uri, doc.source, doc.title, doc.body ?? '', now());
    });
  }

  remove(uri: string): void {
    this.core.db.run('DELETE FROM search_index WHERE uri = ?', uri);
  }

  removePrefix(prefix: string): void {
    this.core.db.run('DELETE FROM search_index WHERE uri >= ? AND uri < ?', prefix, prefix + '￿');
  }

  removeSource(source: string): void {
    this.core.db.run('DELETE FROM search_index WHERE source = ?', source);
  }

  indexed(source?: string): number {
    const r = source ? this.core.db.get('SELECT count(*) AS n FROM search_index WHERE source = ?', source) : this.core.db.get('SELECT count(*) AS n FROM search_index');
    return Number(r?.n ?? 0);
  }

  queryIndex(q: string, limit: number, sources?: string[]): SearchHit[] {
    const m = ftsQuery(q);
    if (!m) return [];
    const filter = sources?.length ? `AND source IN (${sources.map(() => '?').join(',')})` : '';
    const rows = this.core.db.all(
      `SELECT uri, source, title, snippet(search_index, 3, '[', ']', '…', 12) AS snip, bm25(search_index, 0, 0, 5.0, 1.0) AS rank
       FROM search_index WHERE search_index MATCH ? ${filter} ORDER BY rank LIMIT ?`,
      m, ...(sources ?? []), limit,
    );
    return rows.map((r) => ({ uri: r.uri, source: r.source, title: r.title, snippet: r.snip, score: 50 - Number(r.rank) }));
  }

  async query(q: string, opts: { limit?: number; sources?: string[] } = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 30;
    const want = opts.sources?.length ? new Set(opts.sources) : null;
    const hits: SearchHit[] = [];
    const indexSources = want ? [...want].filter((s) => !this.sources.has(s)) : undefined;
    if (!want || (indexSources && indexSources.length)) {
      try {
        hits.push(...this.queryIndex(q, limit, indexSources && indexSources.length ? indexSources : undefined));
      } catch (e) {
        console.warn('[search] fts query failed', e);
      }
    }
    for (const src of this.sources.values()) {
      if (want && !want.has(src.name)) continue;
      try {
        hits.push(...(await src.search(q, limit)));
      } catch (e) {
        console.warn(`[search] source ${src.name} failed`, e);
      }
    }
    // de-duplicate by uri, keep best
    const best = new Map<string, SearchHit>();
    for (const h of hits) {
      const prev = best.get(h.uri);
      if (!prev || prev.score < h.score) best.set(h.uri, h);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** Live sources backed by core state. */
export function registerCoreSearchSources(core: Core): void {
  const S = core.search;
  S.addSource({
    name: 'tabs',
    search: (q, limit) =>
      core.workspaces
        .allTabs()
        .map((t) => ({ t, s: Math.max(fuzzyScore(q, t.title ?? ''), fuzzyScore(q, t.url) * 0.8) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(({ t, s }) => ({ uri: `sensor://tab/${t.id}`, source: 'tabs', title: t.title || t.url, snippet: t.url, score: s + 20 })),
  });
  S.addSource({
    name: 'history',
    search: (q, limit) => {
      const like = `%${q}%`;
      const rows = core.db.all(
        `SELECT url, title, max(visited_at) AS last, count(*) AS visits FROM history WHERE url LIKE ? OR title LIKE ?
         GROUP BY url ORDER BY visits DESC, last DESC LIMIT ?`,
        like, like, limit,
      );
      return rows.map((r) => ({ uri: r.url, source: 'history', title: r.title || r.url, snippet: r.url, score: Math.max(fuzzyScore(q, r.title ?? ''), fuzzyScore(q, r.url) * 0.7) + Math.min(10, Number(r.visits)) }));
    },
  });
  S.addSource({
    name: 'bookmarks',
    search: (q, limit) => {
      const like = `%${q}%`;
      return core.db
        .all('SELECT * FROM bookmarks WHERE url LIKE ? OR title LIKE ? OR folder LIKE ? LIMIT ?', like, like, like, limit)
        .map((r) => ({ uri: r.url, source: 'bookmarks', title: r.title || r.url, snippet: r.url, score: Math.max(fuzzyScore(q, r.title ?? ''), fuzzyScore(q, r.url) * 0.7) + 15 }));
    },
  });
  S.addSource({
    name: 'commands',
    search: (q, limit) =>
      core.bus
        .list()
        .filter((c) => c.palette)
        .map((c) => ({ c, s: Math.max(fuzzyScore(q, c.title), fuzzyScore(q, c.id) * 0.6) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(({ c, s }) => ({ uri: `sensor://command/${c.id}`, source: 'commands', title: c.title, snippet: c.id, score: s })),
  });
  S.addSource({
    name: 'downloads',
    search: (q, limit) => {
      const like = `%${q}%`;
      return core.db
        .all("SELECT * FROM downloads WHERE (filename LIKE ? OR url LIKE ?) AND profile_id != 'incognito' ORDER BY started_at DESC LIMIT ?", like, like, limit)
        .map((r) => ({ uri: r.path ? `sensor://file/${encodeURIComponent(r.path)}` : r.url, source: 'downloads', title: r.filename, snippet: r.path ?? r.url, score: fuzzyScore(q, r.filename) }));
    },
  });
  S.addSource({
    name: 'macros',
    search: (q, limit) =>
      core.db
        .all('SELECT id, name FROM macros')
        .map((r) => ({ r, s: fuzzyScore(q, r.name) }))
        .filter((x) => x.s > 0)
        .slice(0, limit)
        .map(({ r, s }) => ({ uri: `sensor://macro/${r.id}`, source: 'macros', title: `Run macro: ${r.name}`, score: s })),
  });
  S.addSource({
    name: 'workspaces',
    search: (q, limit) =>
      core.workspaces
        .list()
        .map((w) => ({ w, s: fuzzyScore(q, w.name) }))
        .filter((x) => x.s > 0)
        .slice(0, limit)
        .map(({ w, s }) => ({ uri: `sensor://workspace/${w.id}`, source: 'workspaces', title: `Workspace: ${w.name}`, score: s })),
  });
}

export function searchCommands(core: Core): CommandDef[] {
  return [
    {
      id: 'search.query', title: 'Search Everything', scopes: ['search:read'], palette: false,
      params: {
        q: { type: 'string', required: true, positional: 0 },
        sources: { type: 'array', description: `subset of sources, e.g. notes,files,tabs` },
        limit: { type: 'number', default: 30 },
      },
      handler: async (a, ctx) => {
        let hits = await core.search.query(a.q, { limit: a.limit, sources: a.sources });
        // Filter results a token is not allowed to see.
        if (ctx.principal.kind !== 'user') {
          const scopes = (ctx.principal as any).scopes as string[];
          const can = (s: string) => scopes.includes('*') || scopes.includes(s);
          const need: Record<string, string> = { tabs: 'tabs:read', history: 'history:read', bookmarks: 'history:read', notes: 'notes:read', files: 'files:read', annotations: 'notes:read', downloads: 'downloads:read', clipboard: 'clipboard:read', feeds: 'feeds:read', macros: 'macros:read' };
          hits = hits.filter((h) => !need[h.source] || can(need[h.source]));
        }
        return hits;
      },
    },
    {
      id: 'search.sources', title: 'List Search Sources', scopes: ['search:read'], palette: false,
      handler: () => core.search.sourceNames(),
    },
    {
      id: 'search.open', title: 'Search Panel', scopes: ['workspaces:write'], shortcut: 'CmdOrCtrl+Shift+F',
      handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'search' } }) }),
    },
  ];
}
