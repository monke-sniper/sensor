// Annotations (highlights, sticky notes), clipboard history store and the
// deterministic content recognizers.
import { createHash } from 'node:crypto';
import type { Core, CoreModule } from '../core';
import type { CommandDef } from '../commands';
import { now, uid } from '../db';
import { activeTabOrThrow } from './workspaces';
import { youtubeId } from './resources';

/** Normalize a URL for annotation matching: drop hash and tracking params. */
export function annotationKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|ref_src)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- annotations
export const annotationsModule: CoreModule = {
  name: 'annotations',
  init(core) {
    const list = (url: string) => core.db.all('SELECT * FROM annotations WHERE url = ? ORDER BY created_at', annotationKey(url));
    const changed = (url: string) => core.events.emit('annotation.changed', { url: annotationKey(url) });
    const index = (a: any) =>
      core.search.index({ uri: `sensor://annotation/${a.id}`, source: 'annotations', title: (a.note || a.quote || 'Annotation').slice(0, 120), body: `${a.quote ?? ''}\n${a.note ?? ''}\n${a.url}` });
    core.services.annotations = { list };
    const create = (a: any) => {
      const row = { id: uid('ann_'), url: annotationKey(a.url), kind: a.kind, quote: a.quote ?? null, note: a.note ?? null, color: a.color ?? null, anchor: a.anchor ?? null, x: a.x ?? null, y: a.y ?? null, created_at: now(), updated_at: now() };
      core.db.run(
        'INSERT INTO annotations (id, url, kind, quote, note, color, anchor, x, y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        row.id, row.url, row.kind, row.quote, row.note, row.color, row.anchor, row.x, row.y, row.created_at, row.updated_at,
      );
      index(row);
      changed(row.url);
      return row;
    };
    const defs: CommandDef[] = [
      {
        id: 'annotations.list', title: 'List Annotations', scopes: ['notes:read'], palette: false,
        params: { url: { type: 'string', positional: 0 }, all: { type: 'boolean', default: false } },
        handler: (a) => (a.all ? core.db.all('SELECT * FROM annotations ORDER BY updated_at DESC LIMIT 500') : list(a.url ?? activeTabOrThrow(core).url)),
      },
      {
        id: 'annotations.create', title: 'Create Annotation', scopes: ['notes:write'], palette: false,
        params: {
          url: { type: 'string', required: true }, kind: { type: 'string', enum: ['highlight', 'sticky', 'note'], default: 'note' },
          quote: { type: 'string' }, note: { type: 'string' }, color: { type: 'string' }, anchor: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
        },
        handler: (a) => create(a),
      },
      {
        id: 'annotations.update', title: 'Update Annotation', scopes: ['notes:write'], palette: false,
        params: { id: { type: 'string', required: true, positional: 0 }, note: { type: 'string' }, color: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
        handler: (a) => {
          const row = core.db.get('SELECT * FROM annotations WHERE id = ?', a.id);
          if (!row) throw new Error('annotation not found');
          const next: any = { ...row, ...Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== undefined && k !== 'id')), updated_at: now() };
          core.db.run('UPDATE annotations SET note = ?, color = ?, x = ?, y = ?, updated_at = ? WHERE id = ?', next.note, next.color, next.x, next.y, next.updated_at, a.id);
          index(next);
          return next;
        },
      },
      {
        id: 'annotations.delete', title: 'Delete Annotation', scopes: ['notes:write'], palette: false,
        params: { id: { type: 'string', required: true, positional: 0 } },
        handler: (a) => {
          const row = core.db.get('SELECT url FROM annotations WHERE id = ?', a.id);
          core.db.run('DELETE FROM annotations WHERE id = ?', a.id);
          core.search.remove(`sensor://annotation/${a.id}`);
          if (row) changed(row.url);
          return { ok: true };
        },
      },
      {
        id: 'annotations.highlight', title: 'Highlight Selection', scopes: ['notes:write', 'page:read'],
        params: { tab: { type: 'string' }, note: { type: 'string' }, color: { type: 'string', default: '#ffe36e' } },
        handler: async (a) => {
          const tab = a.tab ? core.workspaces.tab(a.tab) : activeTabOrThrow(core);
          const sel = await core.browser.exec(
            tab.id,
            `(() => { const s = getSelection(); if (!s || s.isCollapsed) return null; const quote = s.toString();
              const r = s.getRangeAt(0); const pre = document.createRange(); pre.setStart(document.body, 0); pre.setEnd(r.startContainer, r.startOffset);
              const before = pre.toString(); return { quote, prefix: before.slice(-32) }; })()`,
          );
          if (!sel?.quote) throw new Error('select some text first');
          return create({ url: tab.url, kind: 'highlight', quote: sel.quote, note: a.note, color: a.color, anchor: JSON.stringify({ prefix: sel.prefix }) });
        },
      },
      {
        id: 'annotations.sticky', title: 'Add Sticky Note To Page', scopes: ['notes:write'],
        params: { tab: { type: 'string' }, note: { type: 'string', default: '' }, x: { type: 'number' }, y: { type: 'number' } },
        handler: async (a) => {
          const tab = a.tab ? core.workspaces.tab(a.tab) : activeTabOrThrow(core);
          const scroll = await core.browser.exec(tab.id, '({x: scrollX, y: scrollY})').catch(() => ({ x: 0, y: 0 }));
          return create({ url: tab.url, kind: 'sticky', note: a.note, x: (a.x ?? 60) + scroll.x, y: (a.y ?? 80) + scroll.y });
        },
      },
      {
        id: 'annotations.toNote', title: 'Export Page Annotations To Note', scopes: ['notes:write', 'notes:read'],
        params: { url: { type: 'string', positional: 0 }, note: { type: 'string', description: 'append to this note' } },
        handler: async (a, ctx) => {
          const url = a.url ?? activeTabOrThrow(core).url;
          const anns = list(url);
          if (!anns.length) throw new Error('no annotations on this page');
          const title = core.workspaces.allTabs().find((t) => annotationKey(t.url) === annotationKey(url))?.title ?? url;
          const body = anns
            .map((x: any) => (x.kind === 'highlight' ? `> ${String(x.quote).replace(/\n/g, '\n> ')}${x.note ? `\n\n${x.note}` : ''}` : `- 📝 ${x.note ?? ''}`))
            .join('\n\n');
          const res = a.note
            ? await ctx.run('notes.append', { path: a.note, text: `## Annotations: [${title}](${url})\n\n${body}` })
            : await ctx.run('notes.create', { title: `Annotations — ${title}`, body: `Source: [${title}](${url})\n\n${body}`, refs: [url] });
          for (const x of anns) core.resources.link(res.uri, `sensor://annotation/${x.id}`, 'exported');
          return res;
        },
      },
      {
        id: 'annotations.panel', title: 'Annotations', scopes: ['workspaces:write'],
        handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'annotations' } }) }),
      },
    ];
    return defs;
  },
};

// ---------------------------------------------------------------- clipboard store
export interface ClipEntry {
  kind: 'text' | 'url' | 'image' | 'files';
  text?: string;
  image?: Buffer;
  source?: string;
}

export class ClipboardStore {
  constructor(private core: Core) {}

  add(e: ClipEntry): number | null {
    if (!this.core.settings.get('clipboard.enabled')) return null;
    const hash = createHash('sha1')
      .update(e.kind)
      .update(e.text ?? '')
      .update(e.image ?? Buffer.alloc(0))
      .digest('hex');
    const existing = this.core.db.get('SELECT id FROM clipboard WHERE hash = ?', hash);
    // strictly increasing timestamps keep ordering stable for rapid copies
    const ts = Math.max(now(), Number(this.core.db.get('SELECT max(created_at) AS m FROM clipboard')?.m ?? 0) + 1);
    if (existing) {
      this.core.db.run('UPDATE clipboard SET created_at = ? WHERE id = ?', ts, existing.id);
      this.core.events.emit('clipboard.added', { id: existing.id });
      return existing.id;
    }
    const r = this.core.db.run('INSERT INTO clipboard (kind, text, image, hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', e.kind, e.text ?? null, e.image ?? null, hash, e.source ?? null, ts);
    const max = this.core.settings.get<number>('clipboard.maxItems') ?? 500;
    this.core.db.run('DELETE FROM clipboard WHERE pinned = 0 AND id NOT IN (SELECT id FROM clipboard ORDER BY pinned DESC, created_at DESC LIMIT ?)', max);
    this.core.events.emit('clipboard.added', { id: r.lastInsertRowid, kind: e.kind });
    return r.lastInsertRowid;
  }
}

export const clipboardModule: CoreModule = {
  name: 'clipboard',
  init(core) {
    const store = new ClipboardStore(core);
    core.services.clipboard = store;
    core.search.addSource({
      name: 'clipboard',
      search: (q, limit) =>
        core.db
          .all("SELECT id, kind, text FROM clipboard WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?", `%${q}%`, limit)
          .map((r) => ({ uri: `sensor://clip/${r.id}`, source: 'clipboard', title: String(r.text).slice(0, 100), snippet: r.kind, score: 10 })),
    });
    const row = (r: any) => ({ id: r.id, kind: r.kind, text: r.text, hasImage: !!r.image, source: r.source, created_at: r.created_at, pinned: !!r.pinned, imageBase64: undefined as string | undefined });
    const defs: CommandDef[] = [
      {
        id: 'clipboard.list', title: 'Clipboard History', scopes: ['clipboard:read'], palette: false,
        params: { q: { type: 'string', positional: 0 }, limit: { type: 'number', default: 100 }, images: { type: 'boolean', default: false, description: 'include image data (base64 PNG)' } },
        handler: (a) => {
          const rows = a.q
            ? core.db.all('SELECT * FROM clipboard WHERE text LIKE ? ORDER BY pinned DESC, created_at DESC LIMIT ?', `%${a.q}%`, a.limit)
            : core.db.all('SELECT * FROM clipboard ORDER BY pinned DESC, created_at DESC LIMIT ?', a.limit);
          return rows.map((r) => {
            const o = row(r);
            if (a.images && r.image) o.imageBase64 = Buffer.from(r.image).toString('base64');
            return o;
          });
        },
      },
      {
        id: 'clipboard.copy', title: 'Copy Clipboard Entry', scopes: ['clipboard:write'], palette: false,
        params: { id: { type: 'number', required: true, positional: 0 } },
        handler: (a) => {
          const r = core.db.get('SELECT * FROM clipboard WHERE id = ?', a.id);
          if (!r) throw new Error('entry not found');
          if (r.kind === 'image' && r.image) core.platform.clipboardWriteImage?.(Buffer.from(r.image));
          else core.platform.clipboardWriteText(r.text ?? '');
          core.db.run('UPDATE clipboard SET created_at = ? WHERE id = ?', now(), a.id);
          return { ok: true };
        },
      },
      {
        id: 'clipboard.pin', title: 'Pin Clipboard Entry', scopes: ['clipboard:write'], palette: false,
        params: { id: { type: 'number', required: true, positional: 0 }, pinned: { type: 'boolean', default: true } },
        handler: (a) => ({ updated: core.db.run('UPDATE clipboard SET pinned = ? WHERE id = ?', a.pinned ? 1 : 0, a.id).changes }),
      },
      {
        id: 'clipboard.delete', title: 'Delete Clipboard Entry', scopes: ['clipboard:write'], palette: false,
        params: { id: { type: 'number', required: true, positional: 0 } },
        handler: (a) => ({ deleted: core.db.run('DELETE FROM clipboard WHERE id = ?', a.id).changes }),
      },
      {
        id: 'clipboard.clear', title: 'Clear Clipboard History', scopes: ['clipboard:write'], destructive: true,
        params: { keepPinned: { type: 'boolean', default: true } },
        handler: (a) => ({ deleted: core.db.run(a.keepPinned ? 'DELETE FROM clipboard WHERE pinned = 0' : 'DELETE FROM clipboard').changes }),
      },
      {
        id: 'clipboard.toggle', title: 'Toggle Clipboard History Recording', scopes: ['app:write'],
        handler: () => {
          const on = !core.settings.get('clipboard.enabled');
          core.settings.set('clipboard.enabled', on);
          return { enabled: on };
        },
      },
      {
        id: 'clipboard.panel', title: 'Clipboard', scopes: ['workspaces:write'], shortcut: 'CmdOrCtrl+Shift+V',
        handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'clipboard' } }) }),
      },
    ];
    return defs;
  },
};

// ---------------------------------------------------------------- recognizers
export interface PageMeta {
  url: string;
  title: string;
  ogType?: string | null;
  ogSiteName?: string | null;
  hasArticle?: boolean;
  hasVideo?: boolean;
}

export interface Recognized {
  tabId: string;
  kind: string;
  label: string;
  ids: Record<string, string>;
  actions: { id: string; title: string; command: string; args: Record<string, any> }[];
}

interface Recognizer {
  kind: string;
  label: string;
  match(u: URL, meta: PageMeta): Record<string, string> | null;
}

const RECOGNIZERS: Recognizer[] = [
  { kind: 'youtube.video', label: 'YouTube', match: (u) => (youtubeId(u.href) ? { video: youtubeId(u.href)! } : null) },
  { kind: 'chatgpt.conversation', label: 'ChatGPT', match: (u) => (/^(chatgpt\.com|chat\.openai\.com)$/.test(u.hostname) ? { conversation: /\/c\/([\w-]+)/.exec(u.pathname)?.[1] ?? '' } : null) },
  { kind: 'claude.conversation', label: 'Claude', match: (u) => (u.hostname === 'claude.ai' ? { conversation: /\/chat\/([\w-]+)/.exec(u.pathname)?.[1] ?? '' } : null) },
  { kind: 'perplexity.thread', label: 'Perplexity', match: (u) => (/perplexity\.ai$/.test(u.hostname) ? { thread: /\/search\/([\w.-]+)/.exec(u.pathname)?.[1] ?? '' } : null) },
  { kind: 'gemini.conversation', label: 'Gemini', match: (u) => (u.hostname === 'gemini.google.com' ? { conversation: /\/app\/([\w-]+)/.exec(u.pathname)?.[1] ?? '' } : null) },
  {
    kind: 'github',
    label: 'GitHub',
    match: (u) => {
      if (u.hostname !== 'github.com') return null;
      const [owner, repo, type, num] = u.pathname.split('/').filter(Boolean);
      if (!owner || !repo) return null;
      return { owner, repo, type: type === 'pull' ? 'pr' : type === 'issues' ? 'issue' : 'repo', number: num ?? '' };
    },
  },
  { kind: 'gdrive.doc', label: 'Google Docs', match: (u) => (u.hostname === 'docs.google.com' ? { doc: /\/d\/([\w-]+)/.exec(u.pathname)?.[1] ?? '', app: u.pathname.split('/')[1] ?? '' } : null) },
  { kind: 'pdf', label: 'PDF', match: (u) => (/\.pdf$/i.test(u.pathname) ? { file: u.href } : null) },
  { kind: 'image', label: 'Image', match: (u) => (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(u.pathname) ? { file: u.href } : null) },
  { kind: 'article', label: 'Article', match: (_u, m) => (m.ogType === 'article' || m.hasArticle ? {} : null) },
];

export function recognize(tabId: string, meta: PageMeta, hasProviders = false): Recognized | null {
  let u: URL;
  try {
    u = new URL(meta.url);
  } catch {
    return null;
  }
  if (!/^(https?|file):$/.test(u.protocol)) return null;
  for (const r of RECOGNIZERS) {
    const ids = r.match(u, meta);
    if (!ids) continue;
    const actions: Recognized['actions'] = [];
    const add = (id: string, title: string, command: string, args: Record<string, any> = {}) => actions.push({ id, title, command, args: { ...args } });
    switch (r.kind) {
      case 'youtube.video':
        add('timestamp', 'Save timestamp', 'youtube.timestamp', { tab: tabId });
        add('note', 'Note', 'notes.capture', { kind: 'youtube', tab: tabId, open: true });
        break;
      case 'chatgpt.conversation':
      case 'claude.conversation':
      case 'perplexity.thread':
      case 'gemini.conversation':
        add('capture', 'Save conversation', 'ai.capture', { tab: tabId });
        break;
      case 'pdf':
        add('note', 'Link in note', 'notes.capture', { kind: 'link', tab: tabId });
        if (hasProviders) add('send', 'Send to AI', 'palette.prompt', { command: 'ai.send', args: { url: meta.url } });
        break;
      case 'article':
        add('save', 'Save to note', 'notes.capture', { kind: 'page', tab: tabId });
        add('pdf', 'PDF', 'pdf.fromPage', { id: tabId });
        break;
      case 'github':
        add('link', 'Link in note', 'notes.capture', { kind: 'link', tab: tabId });
        break;
      default:
        add('link', 'Link in note', 'notes.capture', { kind: 'link', tab: tabId });
    }
    return { tabId, kind: r.kind, label: r.label, ids, actions };
  }
  return null;
}

export const recognizerModule: CoreModule = {
  name: 'recognizer',
  init(core) {
    const last = new Map<string, Recognized | null>();
    core.services.recognizer = {
      onMeta(tabId: string, meta: PageMeta) {
        const hasProviders = !!core.db.get('SELECT 1 AS x FROM providers LIMIT 1');
        const r = recognize(tabId, meta, hasProviders);
        last.set(tabId, r);
        core.events.emit('page.recognized', r ?? { tabId, kind: 'none', label: '', ids: {}, actions: [] });
      },
    };
    core.events.on('tab.closed', (e) => last.delete(e.data.id));
    return [
      {
        id: 'page.recognize', title: 'Recognize Page', scopes: ['page:read'], palette: false,
        params: { id: { type: 'string', positional: 0 } },
        handler: (a) => {
          const t = a.id ? core.workspaces.tab(a.id) : activeTabOrThrow(core);
          return last.get(t.id) ?? recognize(t.id, { url: t.url, title: t.title });
        },
      },
    ];
  },
};
