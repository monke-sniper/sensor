// Knowledge: works directly on the user's Obsidian vault folders (plain
// Markdown files). Sensor never migrates or rewrites the vault format; it adds
// notes, frontmatter and normal Markdown links that Obsidian understands.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Core, CoreModule } from '../core';
import type { CommandDef } from '../commands';
import { activeTabOrThrow } from './workspaces';
import { formatTime, noteUri, parseUri, youtubeId, youtubeUrl } from './resources';

export interface Vault {
  name: string;
  path: string;
}

export function slugTitle(s: string, max = 80): string {
  return (s || 'Untitled')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim() || 'Untitled';
}

export function frontmatter(data: Record<string, unknown>): string {
  const lines = ['---'];
  const emit = (k: string, v: unknown, indent = '') => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      lines.push(`${indent}${k}:`);
      for (const item of v) lines.push(`${indent}  - ${yamlScalar(item)}`);
    } else if (typeof v === 'object') {
      lines.push(`${indent}${k}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) emit(k2, v2, indent + '  ');
    } else lines.push(`${indent}${k}: ${yamlScalar(v)}`);
  };
  for (const [k, v] of Object.entries(data)) emit(k, v);
  lines.push('---', '');
  return lines.join('\n');
}

function yamlScalar(v: unknown): string {
  const s = String(v);
  if (/^[\w./@-]+$/.test(s) && !/^(true|false|null|yes|no|\d+)$/i.test(s)) return s;
  return JSON.stringify(s);
}

/** Markdown links + wikilinks found in a note. */
export function extractLinks(md: string): { urls: string[]; wikilinks: string[] } {
  const urls = new Set<string>();
  const wikilinks = new Set<string>();
  for (const m of md.matchAll(/\[[^\]]*\]\((<[^>]+>|[^)\s]+)/g)) urls.add(m[1].replace(/^<|>$/g, ''));
  for (const m of md.matchAll(/(?<![(<])\b(https?:\/\/[^\s)<>\]]+)/g)) urls.add(m[1]);
  for (const m of md.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) wikilinks.add(m[1].trim());
  return { urls: [...urls].filter((u) => /^(https?|sensor|file):/.test(u)), wikilinks: [...wikilinks] };
}

export class Notes {
  private watchers: FSWatcher[] = [];
  private reindexTimer: NodeJS.Timeout | null = null;

  constructor(private core: Core) {}

  vaults(): Vault[] {
    const list = this.core.settings.get<string[]>('notes.vaults') ?? [];
    return list.filter((p) => typeof p === 'string' && p).map((p) => ({ name: basename(p), path: p }));
  }

  vault(name?: string): Vault {
    const vs = this.vaults();
    if (!vs.length) throw new Error('No vault configured. Set notes.vaults to your Obsidian vault folder (Settings or `sensor notes add-vault <path>`).');
    const want = name ?? this.core.settings.get<string>('notes.defaultVault');
    const v = (want && vs.find((x) => x.name === want || x.path === want)) || vs[0];
    return v;
  }

  resolve(vaultName: string | undefined, path: string): { vault: Vault; abs: string; rel: string } {
    const vault = this.vault(vaultName);
    let rel = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!/\.(md|canvas)$/i.test(rel)) rel += '.md';
    const abs = join(vault.path, ...rel.split('/'));
    const back = relative(vault.path, abs);
    if (back.startsWith('..') || back.includes(`..${sep}`)) throw new Error('path escapes the vault');
    return { vault, abs, rel };
  }

  list(vaultName?: string, folder = ''): { path: string; name: string; mtime: number; size: number }[] {
    const vault = this.vault(vaultName);
    const out: { path: string; name: string; mtime: number; size: number }[] = [];
    const root = join(vault.path, folder);
    const walk = (dir: string, depth: number) => {
      if (depth > 12) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue; // .obsidian, .trash, .git
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith('.md')) {
          try {
            const st = statSync(p);
            out.push({ path: relative(vault.path, p).split(sep).join('/'), name: e.name.replace(/\.md$/, ''), mtime: st.mtimeMs, size: st.size });
          } catch {
            /* vanished */
          }
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  read(vaultName: string | undefined, path: string): { vault: string; path: string; content: string; mtime: number } {
    const { vault, abs, rel } = this.resolve(vaultName, path);
    const content = readFileSync(abs, 'utf8');
    return { vault: vault.name, path: rel, content, mtime: statSync(abs).mtimeMs };
  }

  write(vaultName: string | undefined, path: string, content: string, mode: 'create' | 'overwrite' | 'append' = 'create'): { vault: string; path: string; uri: string } {
    let { vault, abs, rel } = this.resolve(vaultName, path);
    mkdirSync(dirname(abs), { recursive: true });
    if (mode === 'create' && existsSync(abs)) {
      // never clobber an existing note: add a numeric suffix
      const base = rel.replace(/\.md$/, '');
      for (let i = 2; existsSync(abs); i++) ({ abs, rel } = this.resolve(vault.name, `${base} ${i}.md`));
    }
    if (mode === 'append' && existsSync(abs)) {
      const prev = readFileSync(abs, 'utf8');
      writeFileSync(abs, prev + (prev.endsWith('\n') ? '' : '\n') + '\n' + content, 'utf8');
    } else writeFileSync(abs, content, 'utf8');
    this.indexFile(vault, rel);
    const uri = noteUri(vault.name, rel);
    this.core.events.emit('note.saved', { vault: vault.name, path: rel, uri });
    return { vault: vault.name, path: rel, uri };
  }

  indexFile(vault: Vault, rel: string): void {
    const abs = join(vault.path, ...rel.split('/'));
    const uri = noteUri(vault.name, rel);
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      this.core.search.remove(uri);
      return;
    }
    const title = (/^#\s+(.+)$/m.exec(content)?.[1] ?? basename(rel, '.md')).trim();
    this.core.search.index({ uri, source: 'notes', title, body: content.slice(0, 200_000) });
    // Rebuild outgoing links for this note.
    this.core.db.run("DELETE FROM links WHERE src = ? AND kind = 'mentions'", uri);
    const { urls, wikilinks } = extractLinks(content);
    for (const u of urls) this.core.resources.link(uri, u, 'mentions');
    for (const w of wikilinks) this.core.resources.link(uri, noteUri(vault.name, w.endsWith('.md') ? w : w + '.md'), 'mentions');
  }

  reindexAll(): number {
    let n = 0;
    for (const v of this.vaults()) {
      if (!existsSync(v.path)) continue;
      this.core.search.removePrefix(`sensor://note/${encodeURIComponent(v.name)}/`);
      for (const f of this.list(v.name)) {
        this.indexFile(v, f.path);
        n++;
      }
    }
    return n;
  }

  startWatching(): void {
    this.stopWatching();
    for (const v of this.vaults()) {
      if (!existsSync(v.path)) continue;
      try {
        const w = watch(v.path, { recursive: true }, (_ev, file) => {
          if (!file || !String(file).endsWith('.md') || String(file).split(/[\\/]/).some((p) => p.startsWith('.'))) return;
          const rel = String(file).split(sep).join('/');
          this.indexFile(v, rel);
          this.core.events.emit('note.changed', { vault: v.name, path: rel });
        });
        this.watchers.push(w);
      } catch (e) {
        console.warn('[notes] cannot watch vault', v.path, e);
      }
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  scheduleReindex(): void {
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
    this.reindexTimer = setTimeout(() => {
      try {
        this.reindexAll();
        this.startWatching();
      } catch (e) {
        console.warn('[notes] reindex failed', e);
      }
    }, 500);
  }

  dispose(): void {
    this.stopWatching();
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
  }

  captureTarget(title: string): string {
    const folder = (this.core.settings.get<string>('notes.captureFolder') ?? 'Sensor').replace(/^\/+|\/+$/g, '');
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${folder ? folder + '/' : ''}${date} ${slugTitle(title)}.md`;
  }

  /** Build an obsidian:// URI that opens a note in the real Obsidian app. */
  obsidianUri(vault: string, path: string): string {
    return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/, ''))}`;
  }
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
}

export const notesModule: CoreModule = {
  name: 'notes',
  init(core) {
    const notes = new Notes(core);
    core.services.notes = notes;
    core.events.on('settings.changed', (e) => {
      if (e.data.key === 'notes.vaults') notes.scheduleReindex();
    });
    // initial index in the background
    setTimeout(() => notes.scheduleReindex(), 1500);
    notesModule.dispose = () => notes.dispose();
    return notesCommands(core, notes);
  },
};

function notesCommands(core: Core, N: Notes): CommandDef[] {
  return [
    {
      id: 'notes.vaults', title: 'List Vaults', scopes: ['notes:read'], palette: false,
      handler: () => N.vaults().map((v) => ({ ...v, exists: existsSync(v.path), default: v.name === (core.settings.get('notes.defaultVault') || N.vaults()[0]?.name) })),
    },
    {
      id: 'notes.addVault', title: 'Add Obsidian Vault', scopes: ['app:write'],
      params: { path: { type: 'string', required: true, positional: 0, description: 'vault folder' }, default: { type: 'boolean', default: false } },
      handler: (a) => {
        if (!existsSync(a.path) || !statSync(a.path).isDirectory()) throw new Error(`not a folder: ${a.path}`);
        const list = new Set(core.settings.get<string[]>('notes.vaults') ?? []);
        list.add(a.path);
        core.settings.set('notes.vaults', [...list]);
        if (a.default || list.size === 1) core.settings.set('notes.defaultVault', basename(a.path));
        return { vaults: [...list], isObsidianVault: existsSync(join(a.path, '.obsidian')) };
      },
    },
    {
      id: 'notes.list', title: 'List Notes', scopes: ['notes:read'], palette: false,
      params: { vault: { type: 'string' }, folder: { type: 'string', default: '' }, limit: { type: 'number', default: 200 } },
      handler: (a) => N.list(a.vault, a.folder).slice(0, a.limit),
    },
    {
      id: 'notes.read', title: 'Read Note', scopes: ['notes:read'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, vault: { type: 'string' } },
      handler: (a) => N.read(a.vault, a.path),
    },
    {
      id: 'notes.create', title: 'New Note', scopes: ['notes:write'],
      params: {
        title: { type: 'string', required: true, positional: 0 },
        body: { type: 'string', positional: 1, default: '' },
        path: { type: 'string', description: 'path inside the vault (default: capture folder)' },
        vault: { type: 'string' },
        refs: { type: 'array', description: 'URLs / sensor:// URIs to link from the note' },
        tags: { type: 'array' },
        open: { type: 'boolean', default: false },
      },
      handler: async (a, ctx) => {
        const refs: string[] = a.refs ?? [];
        const fm = frontmatter({ tags: a.tags?.length ? a.tags : undefined, sensor: refs.length ? { refs } : undefined });
        const refLines = refs.length ? '\n\n## References\n' + refs.map((r) => `- ${linkFor(core, r)}`).join('\n') + '\n' : '';
        const content = (fm.trim() === '---\n---' || fm === '---\n---\n' ? '' : fm) + `# ${a.title}\n\n${a.body}${refLines}`;
        const res = N.write(a.vault, a.path ?? N.captureTarget(a.title), content.replace(/^---\n---\n/, ''), 'create');
        for (const r of refs) core.resources.link(res.uri, r, 'ref');
        if (a.open) await ctx.run('notes.open', { vault: res.vault, path: res.path });
        return res;
      },
    },
    {
      id: 'notes.append', title: 'Append To Note', scopes: ['notes:write'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, text: { type: 'string', required: true, positional: 1 }, vault: { type: 'string' } },
      handler: (a) => N.write(a.vault, a.path, a.text, 'append'),
    },
    {
      id: 'notes.write', title: 'Overwrite Note', scopes: ['notes:write'], palette: false, destructive: true,
      params: { path: { type: 'string', required: true, positional: 0 }, content: { type: 'string', required: true, positional: 1 }, vault: { type: 'string' } },
      handler: (a) => N.write(a.vault, a.path, a.content, 'overwrite'),
    },
    {
      id: 'notes.search', title: 'Search Notes', scopes: ['notes:read'], palette: false,
      params: { q: { type: 'string', required: true, positional: 0 }, limit: { type: 'number', default: 30 } },
      handler: (a) => core.search.queryIndex(a.q, a.limit, ['notes']),
    },
    {
      id: 'notes.backlinks', title: 'Notes Linking To Resource', scopes: ['notes:read'], palette: false,
      params: { uri: { type: 'string', positional: 0, description: 'URL or sensor:// URI; default: active tab URL' } },
      handler: (a) => {
        const uri = a.uri ?? activeTabOrThrow(core).url;
        const variants = new Set([uri, uri.replace(/#.*$/, ''), uri.replace(/\/$/, '')]);
        const yt = youtubeId(uri);
        const rows = core.db.all(
          `SELECT DISTINCT src, kind FROM links WHERE src LIKE 'sensor://note/%' AND (dst IN (${[...variants].map(() => '?').join(',')}) ${yt ? "OR dst LIKE ? OR dst LIKE ?" : ''})`,
          ...variants, ...(yt ? [`%youtu.be/${yt}%`, `%v=${yt}%`] : []),
        );
        return rows.map((r) => ({ uri: r.src, kind: r.kind, ...noteParts(r.src) }));
      },
    },
    {
      id: 'notes.open', title: 'Open Note', scopes: ['notes:read'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, vault: { type: 'string' }, in: { type: 'string', enum: ['sensor', 'obsidian'], default: 'sensor' } },
      handler: async (a) => {
        const v = N.vault(a.vault);
        const { rel } = N.resolve(v.name, a.path);
        if (a.in === 'obsidian') {
          await core.platform.openExternal(N.obsidianUri(v.name, rel));
          return { opened: 'obsidian' };
        }
        const leaf = core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'notes' } });
        core.events.emit('note.open', { vault: v.name, path: rel, leaf });
        return { opened: 'sensor', vault: v.name, path: rel };
      },
    },
    {
      id: 'notes.panel', title: 'Notes', scopes: ['workspaces:write'],
      handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'notes' } }) }),
    },
    {
      id: 'notes.reindex', title: 'Reindex Vaults', scopes: ['notes:read'],
      handler: () => ({ indexed: N.reindexAll() }),
    },
    {
      id: 'notes.capture', title: 'Save Page to Note', scopes: ['notes:write', 'page:read'],
      description: 'Capture the page, selection, YouTube timestamp or AI conversation into the vault with links back to the source.',
      params: {
        kind: { type: 'string', enum: ['auto', 'page', 'selection', 'link', 'youtube'], default: 'auto' },
        tab: { type: 'string' },
        note: { type: 'string', description: 'append to this note instead of creating one' },
        vault: { type: 'string' },
        comment: { type: 'string', description: 'your annotation, added above the capture' },
        open: { type: 'boolean', default: false },
      },
      handler: async (a, ctx) => {
        const tab = a.tab ? core.workspaces.tab(a.tab) : activeTabOrThrow(core);
        const url = tab.url;
        let kind = a.kind;
        const selection = await core.browser.selection(tab.id).catch(() => '');
        const yt = youtubeId(url);
        if (kind === 'auto') kind = selection ? 'selection' : yt ? 'youtube' : 'page';
        const now = new Date().toISOString();
        let title = tab.title || url;
        let body = '';
        let source = url;
        if (kind === 'selection') {
          if (!selection) throw new Error('nothing selected');
          body = `${quote(selection)}\n\n— [${title}](${url})`;
        } else if (kind === 'youtube') {
          if (!yt) throw new Error('not a YouTube video');
          const t = Number(await core.browser.exec(tab.id, "(document.querySelector('video')||{}).currentTime||0").catch(() => 0));
          source = youtubeUrl(yt, t);
          title = title.replace(/ - YouTube$/, '');
          body = `[▶ ${formatTime(t)}](${source}) — ${title}`;
        } else if (kind === 'link') {
          body = `[${title}](${url})`;
        } else {
          const page = await core.browser.readPage(tab.id, 'markdown');
          title = page.title || title;
          body = `Source: [${title}](${url})\n\n${page.content}`;
        }
        if (a.comment) body = `${a.comment}\n\n${body}`;
        let res;
        if (a.note) {
          res = N.write(a.vault, a.note, `### ${title}\n_${now.slice(0, 16).replace('T', ' ')}_\n\n${body}\n`, 'append');
        } else {
          const content = frontmatter({ sensor: { source, kind, captured: now }, tags: ['sensor/capture'] }) + `# ${title}\n\n${body}\n`;
          res = N.write(a.vault, N.captureTarget(title), content, 'create');
        }
        core.resources.link(res.uri, source, 'capture');
        core.notify('success', 'Saved to note', `${res.vault}/${res.path}`, 'notes');
        if (a.open) await ctx.run('notes.open', { vault: res.vault, path: res.path });
        return res;
      },
    },
    {
      id: 'youtube.timestamp', title: 'Save YouTube Timestamp', scopes: ['notes:write', 'page:read'],
      params: { tab: { type: 'string' }, note: { type: 'string' }, comment: { type: 'string', positional: 0 } },
      handler: (a, ctx) => ctx.run('notes.capture', { kind: 'youtube', tab: a.tab, note: a.note, comment: a.comment }),
    },
    {
      id: 'obsidian.insert', title: 'Insert Text In Obsidian', scopes: ['notes:write'], palette: false,
      description: 'Inserts text at the cursor of the active Obsidian note (requires the sensor-bridge plugin).',
      params: { text: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        core.events.emit('note.obsidianInsert', { text: a.text });
        return { sent: true };
      },
    },
    {
      id: 'obsidian.insertActiveTabLink', title: 'Insert Link To Current Tab In Obsidian', scopes: ['notes:write', 'tabs:read'],
      handler: (a, ctx) => {
        const t = activeTabOrThrow(core);
        return ctx.run('obsidian.insert', { text: `[${t.title}](${t.url})` });
      },
    },
  ];
}

function noteParts(uri: string) {
  const p = parseUri(uri);
  const [vault, ...rest] = p.id.split('/');
  return { vault, path: rest.join('/') };
}

function linkFor(core: Core, uri: string): string {
  const p = parseUri(uri);
  if (p.kind === 'web') return `<${uri}>`;
  if (p.kind === 'youtube') return `[YouTube ${p.id}${p.query.t ? ' @ ' + formatTime(Number(p.query.t)) : ''}](${youtubeUrl(p.id, p.query.t ? Number(p.query.t) : undefined)})`;
  if (p.kind === 'note') {
    const [, ...rest] = p.id.split('/');
    return `[[${rest.join('/').replace(/\.md$/, '')}]]`;
  }
  if (p.kind === 'file') return `[${basename(p.id)}](<file:///${p.id.replace(/\\/g, '/').replace(/^\//, '')}>)`;
  if (p.kind === 'tab' && core.workspaces.hasTab(p.id)) {
    const t = core.workspaces.tab(p.id);
    return `[${t.title}](${t.url})`;
  }
  return `<${uri}>`;
}
