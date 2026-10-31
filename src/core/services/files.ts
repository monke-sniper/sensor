// File environment: browse, search, organize, preview. Works on normal
// Windows folders; nothing is moved into a Sensor-specific store.
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import type { Core, CoreModule } from '../core';
import type { CommandDef } from '../commands';
import { fileUriOf, indexOne, indexRoots, TEXT_EXT } from './file-index';
import { parseUri } from './resources';

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  ext: string;
}

export function listDir(path: string, showHidden = false): Entry[] {
  const out: Entry[] = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (!showHidden && e.name.startsWith('.')) continue;
    const p = join(path, e.name);
    try {
      const st = statSync(p);
      out.push({ name: e.name, path: p, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ext: st.isDirectory() ? '' : extname(e.name).toLowerCase() });
    } catch {
      /* broken link / permission */
    }
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Expand a rename pattern. Tokens: {name} {ext} {n} {n:3} {date} {parent} */
export function renameTarget(path: string, pattern: string, index: number, find?: string, replace?: string): string {
  const ext = extname(path);
  let name = basename(path, ext);
  if (find) {
    let re: RegExp;
    try {
      re = new RegExp(find, 'g');
    } catch {
      re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    }
    name = name.replace(re, replace ?? '');
  }
  const st = (() => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  })();
  const d = st ? new Date(st.mtimeMs) : new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const out = (pattern || '{name}{ext}')
    .replace(/\{n(?::(\d+))?\}/g, (_m, w) => String(index + 1).padStart(Number(w ?? 0), '0'))
    .replace(/\{name\}/g, name)
    .replace(/\{ext\}/g, ext)
    .replace(/\{date\}/g, date)
    .replace(/\{parent\}/g, basename(dirname(path)));
  return join(dirname(path), out.replace(/[\\/:*?"<>|]/g, '_'));
}

async function hashFile(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha1');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

export async function findDuplicates(roots: string[], exclude: string[], minSize = 1): Promise<{ size: number; hash: string; paths: string[] }[]> {
  const bySize = new Map<number, string[]>();
  const excl = new Set(exclude.map((e) => e.toLowerCase()));
  const stack = [...roots];
  let seen = 0;
  while (stack.length && seen < 200_000) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || excl.has(e.name.toLowerCase())) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        seen++;
        try {
          const s = statSync(p).size;
          if (s >= minSize) bySize.set(s, [...(bySize.get(s) ?? []), p]);
        } catch {
          /* skip */
        }
      }
    }
  }
  const groups: { size: number; hash: string; paths: string[] }[] = [];
  for (const [size, paths] of bySize) {
    if (paths.length < 2) continue;
    const byHash = new Map<string, string[]>();
    for (const p of paths) {
      try {
        const h = await hashFile(p);
        byHash.set(h, [...(byHash.get(h) ?? []), p]);
      } catch {
        /* skip */
      }
    }
    for (const [hash, ps] of byHash) if (ps.length > 1) groups.push({ size, hash, paths: ps });
  }
  return groups.sort((a, b) => b.size * b.paths.length - a.size * a.paths.length);
}

export class Files {
  private worker: Worker | null = null;
  private watchers: FSWatcher[] = [];
  indexing: { done: number; current: string; running: boolean } = { done: 0, current: '', running: false };

  constructor(private core: Core, private workerPath: string | null) {}

  roots(): string[] {
    return (this.core.settings.get<string[]>('files.roots') ?? []).filter((r) => typeof r === 'string' && existsSync(r));
  }

  async index(roots = this.roots()): Promise<{ started: boolean; roots: string[] }> {
    if (this.indexing.running || !roots.length) return { started: false, roots };
    const opts = { roots, exclude: this.core.settings.get<string[]>('files.exclude') ?? [], contents: !!this.core.settings.get('files.indexContents') };
    this.indexing = { done: 0, current: '', running: true };
    this.core.events.emit('file.indexStarted', { roots });
    const finish = (done: number, error?: string) => {
      this.indexing = { done, current: '', running: false };
      this.worker = null;
      this.core.events.emit('file.indexed', { done, error });
      if (error) this.core.notify('error', 'File indexing failed', error, 'files');
      this.watch();
    };
    if (this.workerPath && existsSync(this.workerPath)) {
      this.worker = new Worker(this.workerPath, { workerData: { dbPath: join(this.core.dataDir, 'core.db'), opts } });
      this.worker.on('message', (m: any) => {
        if (m.type === 'progress') {
          this.indexing.done = m.done;
          this.indexing.current = m.current;
          this.core.events.emit('file.indexProgress', { done: m.done });
        } else if (m.type === 'done') finish(m.done);
        else if (m.type === 'error') finish(this.indexing.done, m.error);
      });
      this.worker.on('error', (e: any) => finish(this.indexing.done, String(e?.message ?? e)));
    } else {
      indexRoots(this.core.db, opts, (done, current) => {
        this.indexing.done = done;
        this.indexing.current = current;
      })
        .then((n) => finish(n))
        .catch((e: any) => finish(this.indexing.done, String(e?.message ?? e)));
    }
    return { started: true, roots };
  }

  watch(): void {
    this.unwatch();
    const contents = !!this.core.settings.get('files.indexContents');
    for (const r of this.roots()) {
      try {
        this.watchers.push(
          watch(r, { recursive: true }, (_ev, file) => {
            if (!file) return;
            const p = join(r, String(file));
            if (String(file).split(/[\\/]/).some((s) => s.startsWith('.') || s === 'node_modules')) return;
            indexOne(this.core.db, p, { contents });
            this.core.events.emit(existsSync(p) ? 'file.changed' : 'file.removed', { path: p });
          }),
        );
      } catch {
        /* recursive watch unsupported here */
      }
    }
  }

  unwatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  dispose(): void {
    this.unwatch();
    this.worker?.postMessage('stop');
  }

  recordRecent(path: string): void {
    const list = (this.core.settings.get<string[]>('files.recent') ?? []).filter((p) => p !== path);
    list.unshift(path);
    this.core.settings.set('files.recent', list.slice(0, 50));
  }
}

const VIEW_IN_TAB = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.txt', '.json', '.xml', '.html', '.htm', '.log', '.csv']);

export function filesModule(workerPath: string | null): CoreModule {
  const mod: CoreModule = {
    name: 'files',
    init(core) {
      const files = new Files(core, workerPath);
      core.services.files = files;
      mod.dispose = () => files.dispose();
      core.events.on('settings.changed', (e) => {
        if (e.data.key === 'files.roots') files.index().catch(() => {});
      });
      setTimeout(() => files.watch(), 2000);
      return filesCommands(core, files);
    },
  };
  return mod;
}

function abs(p: string): string {
  if (p.startsWith('sensor://file/')) return parseUri(p).id;
  if (p.startsWith('file://')) return decodeURIComponent(new URL(p).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return resolve(p);
}

function fileCommands(core: Core, F: Files): CommandDef[] {
  return [
    {
      id: 'files.roots', title: 'List File Roots', scopes: ['files:read'], palette: false,
      handler: () => ({ roots: core.settings.get<string[]>('files.roots') ?? [], indexing: F.indexing }),
    },
    {
      id: 'files.addRoot', title: 'Add Folder To Files', scopes: ['app:write'],
      params: { path: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const p = abs(a.path);
        if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`not a folder: ${p}`);
        const roots = new Set(core.settings.get<string[]>('files.roots') ?? []);
        roots.add(p);
        core.settings.set('files.roots', [...roots]);
        return { roots: [...roots] };
      },
    },
    {
      id: 'files.removeRoot', title: 'Remove Folder From Files', scopes: ['app:write'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const roots = (core.settings.get<string[]>('files.roots') ?? []).filter((r) => r !== a.path && r !== abs(a.path));
        core.settings.set('files.roots', roots);
        return { roots };
      },
    },
    {
      id: 'files.list', title: 'List Folder', scopes: ['files:read'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, hidden: { type: 'boolean', default: false } },
      handler: (a) => listDir(abs(a.path), a.hidden),
    },
    {
      id: 'files.stat', title: 'File Info', scopes: ['files:read'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, hash: { type: 'boolean', default: false } },
      handler: async (a) => {
        const p = abs(a.path);
        const st = statSync(p);
        return {
          path: p, name: basename(p), dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, ext: extname(p).toLowerCase(),
          sha1: a.hash && st.isFile() ? await hashFile(p) : undefined,
          tags: core.resources.linksFrom(fileUriOf(p)).filter((l: any) => l.kind === 'tag').map((l: any) => String(l.dst).slice(4)),
        };
      },
    },
    {
      id: 'files.read', title: 'Read Text File', scopes: ['files:read'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, maxBytes: { type: 'number', default: 1_000_000 } },
      handler: (a) => {
        const p = abs(a.path);
        const st = statSync(p);
        const buf = readFileSync(p).subarray(0, a.maxBytes);
        if (buf.includes(0)) throw new Error('binary file');
        return { path: p, size: st.size, truncated: st.size > a.maxBytes, content: buf.toString('utf8') };
      },
    },
    {
      id: 'files.write', title: 'Write Text File', scopes: ['files:write'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, content: { type: 'string', required: true, positional: 1 }, overwrite: { type: 'boolean', default: false } },
      handler: (a) => {
        const p = abs(a.path);
        if (existsSync(p) && !a.overwrite) throw new Error('file exists (pass overwrite=true)');
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, a.content, 'utf8');
        core.events.emit('file.created', { path: p });
        return { path: p };
      },
    },
    {
      id: 'files.mkdir', title: 'New Folder', scopes: ['files:write'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        mkdirSync(abs(a.path), { recursive: true });
        return { path: abs(a.path) };
      },
    },
    {
      id: 'files.copy', title: 'Copy Files', scopes: ['files:write'], palette: false,
      params: { paths: { type: 'array', required: true, positional: 0 }, dest: { type: 'string', required: true, positional: 1 }, overwrite: { type: 'boolean', default: false } },
      handler: (a) => {
        const dest = abs(a.dest);
        mkdirSync(dest, { recursive: true });
        const out: string[] = [];
        for (const src of a.paths.map(abs)) {
          const target = join(dest, basename(src));
          if (existsSync(target) && !a.overwrite) throw new Error(`exists: ${target}`);
          if (statSync(src).isDirectory()) cpSync(src, target, { recursive: true, force: a.overwrite });
          else copyFileSync(src, target);
          out.push(target);
          core.events.emit('file.created', { path: target });
        }
        return { copied: out };
      },
    },
    {
      id: 'files.move', title: 'Move Files', scopes: ['files:write'], palette: false,
      params: { paths: { type: 'array', required: true, positional: 0 }, dest: { type: 'string', required: true, positional: 1 }, overwrite: { type: 'boolean', default: false } },
      handler: (a) => {
        const dest = abs(a.dest);
        mkdirSync(dest, { recursive: true });
        const out: string[] = [];
        for (const src of a.paths.map(abs)) {
          const target = join(dest, basename(src));
          if (existsSync(target) && !a.overwrite) throw new Error(`exists: ${target}`);
          try {
            renameSync(src, target);
          } catch (e: any) {
            if (e?.code !== 'EXDEV') throw e;
            cpSync(src, target, { recursive: true });
            core.platform.trash(src);
          }
          out.push(target);
          core.events.emit('file.moved', { from: src, to: target });
        }
        return { moved: out };
      },
    },
    {
      id: 'files.rename', title: 'Rename File', scopes: ['files:write'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, name: { type: 'string', required: true, positional: 1 } },
      handler: (a) => {
        const src = abs(a.path);
        const target = join(dirname(src), basename(a.name));
        if (existsSync(target)) throw new Error(`exists: ${target}`);
        renameSync(src, target);
        core.events.emit('file.moved', { from: src, to: target });
        return { path: target };
      },
    },
    {
      id: 'files.batchRename', title: 'Batch Rename', scopes: ['files:write'], palette: false,
      description: 'Pattern tokens: {name} {ext} {n} {n:3} {date} {parent}. Dry run by default.',
      params: {
        paths: { type: 'array', required: true, positional: 0 },
        pattern: { type: 'string', default: '{name}{ext}' },
        find: { type: 'string', description: 'regex applied to the name' },
        replace: { type: 'string', default: '' },
        apply: { type: 'boolean', default: false },
      },
      handler: (a) => {
        const plan = a.paths.map((p: string, i: number) => ({ from: abs(p), to: renameTarget(abs(p), a.pattern, i, a.find, a.replace) }));
        const targets = new Set<string>();
        for (const s of plan) {
          if (targets.has(s.to)) throw new Error(`two files would be named ${basename(s.to)}`);
          targets.add(s.to);
          if (s.to !== s.from && existsSync(s.to) && !plan.some((o: any) => o.from === s.to)) throw new Error(`exists: ${s.to}`);
        }
        if (!a.apply) return { dryRun: true, plan };
        // two-phase rename to allow swaps
        const temp = plan.map((s: any, i: number) => ({ ...s, tmp: `${s.from}.sensor-tmp-${i}` }));
        for (const s of temp) if (s.from !== s.to) renameSync(s.from, s.tmp);
        for (const s of temp) if (s.from !== s.to) renameSync(s.tmp, s.to);
        return { dryRun: false, renamed: plan.filter((s: any) => s.from !== s.to).length, plan };
      },
    },
    {
      id: 'files.delete', title: 'Move Files To Recycle Bin', scopes: ['files:delete'], destructive: true, palette: false,
      params: { paths: { type: 'array', required: true, positional: 0 } },
      handler: async (a) => {
        const out: string[] = [];
        for (const p of a.paths.map(abs)) {
          await core.platform.trash(p);
          core.search.remove(fileUriOf(p));
          core.events.emit('file.removed', { path: p });
          out.push(p);
        }
        return { trashed: out };
      },
    },
    {
      id: 'files.search', title: 'Search Files', scopes: ['files:read'], palette: false,
      params: { q: { type: 'string', required: true, positional: 0 }, limit: { type: 'number', default: 50 } },
      handler: (a) => core.search.queryIndex(a.q, a.limit, ['files']).map((h) => ({ ...h, path: parseUri(h.uri).id })),
    },
    {
      id: 'files.index', title: 'Index Files Now', scopes: ['files:read'],
      params: { path: { type: 'string', positional: 0, description: 'index only this folder' } },
      handler: (a) => F.index(a.path ? [abs(a.path)] : undefined),
    },
    {
      id: 'files.dupes', title: 'Find Duplicate Files', scopes: ['files:read'], palette: false,
      params: { path: { type: 'string', positional: 0 }, minSize: { type: 'number', default: 1024 } },
      handler: (a) => findDuplicates(a.path ? [abs(a.path)] : F.roots(), core.settings.get<string[]>('files.exclude') ?? [], a.minSize),
    },
    {
      id: 'files.tag', title: 'Tag Files', scopes: ['files:write'], palette: false,
      params: { paths: { type: 'array', required: true, positional: 0 }, tag: { type: 'string', required: true, positional: 1 }, remove: { type: 'boolean', default: false } },
      handler: (a) => {
        for (const p of a.paths.map(abs)) {
          if (a.remove) core.resources.unlink(fileUriOf(p), `tag:${a.tag}`, 'tag');
          else core.resources.link(fileUriOf(p), `tag:${a.tag}`, 'tag');
        }
        return { ok: true };
      },
    },
    {
      id: 'files.tagged', title: 'Files With Tag', scopes: ['files:read'], palette: false,
      params: { tag: { type: 'string', required: true, positional: 0 } },
      handler: (a) => core.resources.linksTo(`tag:${a.tag}`).map((l: any) => parseUri(l.src).id),
    },
    {
      id: 'files.recent', title: 'Recent Files', scopes: ['files:read'], palette: false,
      handler: () => {
        const opened = core.settings.get<string[]>('files.recent') ?? [];
        const dl = core.db.all("SELECT path FROM downloads WHERE state = 'completed' AND path IS NOT NULL ORDER BY finished_at DESC LIMIT 20").map((r) => r.path as string);
        return [...new Set([...opened, ...dl])].filter((p) => existsSync(p)).slice(0, 50);
      },
    },
    {
      id: 'files.open', title: 'Open File', scopes: ['files:read'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, external: { type: 'boolean', default: false }, target: { type: 'string', enum: ['tab', 'panel'], default: 'tab' } },
      handler: async (a, ctx) => {
        const p = abs(a.path);
        F.recordRecent(p);
        const ext = extname(p).toLowerCase();
        if (a.external) {
          await core.platform.openPath(p);
          return { opened: 'external' };
        }
        if (statSync(p).isDirectory()) {
          core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'files' } });
          core.events.emit('file.browse', { path: p });
          return { opened: 'files' };
        }
        if (ext === '.md') {
          for (const v of core.services.notes?.vaults() ?? []) {
            if (p.startsWith(v.path)) return ctx.run('notes.open', { vault: v.name, path: p.slice(v.path.length + 1).replace(/\\/g, '/') });
          }
        }
        if (VIEW_IN_TAB.has(ext) || ext === '.md' || TEXT_EXT.has(ext)) {
          const url = 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
          return ctx.run('tabs.open', { url, target: a.target });
        }
        await core.platform.openPath(p);
        return { opened: 'external' };
      },
    },
    {
      id: 'files.reveal', title: 'Show In Explorer', scopes: ['files:read'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 } },
      handler: (a) => core.platform.showInFolder(abs(a.path)),
    },
    {
      id: 'files.zip', title: 'Compress To Zip', scopes: ['files:write'], palette: false,
      params: { paths: { type: 'array', required: true, positional: 0 }, out: { type: 'string', positional: 1 } },
      handler: (a) => {
        const paths: string[] = a.paths.map(abs);
        const entries: Record<string, Uint8Array> = {};
        const add = (p: string, prefix: string) => {
          const st = statSync(p);
          if (st.isDirectory()) for (const e of readdirSync(p)) add(join(p, e), `${prefix}${basename(p)}/`);
          else entries[`${prefix}${basename(p)}`] = readFileSync(p);
        };
        for (const p of paths) add(p, '');
        const out = a.out ? abs(a.out) : join(dirname(paths[0]), `${paths.length === 1 ? basename(paths[0], extname(paths[0])) : 'archive'}.zip`);
        writeFileSync(out, zipSync(entries, { level: 6 }));
        core.events.emit('file.created', { path: out });
        return { path: out, entries: Object.keys(entries).length };
      },
    },
    {
      id: 'files.unzip', title: 'Extract Zip', scopes: ['files:write'], palette: false,
      params: { path: { type: 'string', required: true, positional: 0 }, dest: { type: 'string', positional: 1 } },
      handler: (a) => {
        const src = abs(a.path);
        const dest = a.dest ? abs(a.dest) : join(dirname(src), basename(src, extname(src)));
        const files = unzipSync(readFileSync(src));
        let n = 0;
        for (const [name, data] of Object.entries(files)) {
          const target = resolve(dest, name);
          if (!target.startsWith(resolve(dest))) throw new Error(`unsafe path in archive: ${name}`); // zip-slip
          if (name.endsWith('/')) {
            mkdirSync(target, { recursive: true });
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
          n++;
        }
        core.events.emit('file.created', { path: dest });
        return { dest, files: n };
      },
    },
    {
      id: 'files.panel', title: 'Files', scopes: ['workspaces:write'], shortcut: 'CmdOrCtrl+Shift+E',
      handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'files' } }) }),
    },
  ];
}

const filesCommands = fileCommands;
export { strToU8 };
