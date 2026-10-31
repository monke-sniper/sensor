// Document toolkit: PDF operations (pdf-lib) and a converter registry that only
// advertises conversions whose tool is actually available.
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { degrees, PDFDocument } from 'pdf-lib';
import { marked } from 'marked';
import TurndownService from 'turndown';
import type { Core, CoreModule } from '../core';
import type { CommandDef } from '../commands';
import { activeTabOrThrow } from './workspaces';
import { slugTitle } from './notes';

const run = promisify(execFile);

/** "1-3,5,8-" -> zero-based indices within [0, count) */
export function parseRanges(spec: string | undefined, count: number): number[] {
  if (!spec || spec === 'all') return [...Array(count).keys()];
  const out: number[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : count;
      for (let i = a; i <= b; i++) if (i >= 1 && i <= count) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= count) out.push(n - 1);
    } else throw new Error(`bad page range: ${part}`);
  }
  return out;
}

export function csvToJson(csv: string, delimiter = ','): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && csv[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export function jsonToCsv(data: unknown): string {
  const arr = Array.isArray(data) ? data : [data];
  const cols = [...new Set(arr.flatMap((o: any) => (o && typeof o === 'object' ? Object.keys(o) : [])))];
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...arr.map((o: any) => cols.map((c) => esc(o?.[c])).join(','))].join('\n') + '\n';
}

export interface MediaHost {
  /** Decode with Chromium and re-encode. to: png | jpeg | webp */
  convertImage(input: Buffer, mime: string, to: 'png' | 'jpeg' | 'webp', quality: number): Promise<Buffer>;
  /** Render PDF pages to PNG. */
  pdfToImages?(pdf: Buffer, pages: number[], scale: number): Promise<Buffer[]>;
}

const IMAGE_IN = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico'];
const IMAGE_OUT = ['png', 'jpg', 'jpeg', 'webp'];
const AV_IN = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'gif'];
const AV_OUT = ['mp4', 'webm', 'mkv', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'opus', 'gif'];
const PANDOC_IN = ['md', 'markdown', 'html', 'htm', 'docx', 'odt', 'epub', 'rtf', 'rst', 'tex', 'org'];
const PANDOC_OUT = ['md', 'html', 'docx', 'odt', 'epub', 'rtf', 'rst', 'tex', 'org', 'txt'];
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon' };

function which(cmd: string): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0]?.trim() || null;
}

export class Documents {
  private toolCache = new Map<string, string | null>();
  constructor(private core: Core) {}

  tool(name: 'ffmpeg' | 'pandoc' | 'qpdf'): string | null {
    const configured = this.core.settings.get<string>(`tools.${name}`);
    if (configured && existsSync(configured)) return configured;
    if (!this.toolCache.has(name)) this.toolCache.set(name, which(name));
    return this.toolCache.get(name)!;
  }

  media(): MediaHost | null {
    return (this.core.services.media as MediaHost) ?? null;
  }

  formats(): { from: string; to: string[]; via: string }[] {
    const out: { from: string; to: string[]; via: string }[] = [
      { from: 'csv', to: ['json'], via: 'built-in' },
      { from: 'tsv', to: ['json'], via: 'built-in' },
      { from: 'json', to: ['csv'], via: 'built-in' },
      { from: 'md', to: ['html'], via: 'built-in' },
      { from: 'html', to: ['md'], via: 'built-in' },
      { from: '*', to: ['gz'], via: 'built-in' },
      { from: 'gz', to: ['(original)'], via: 'built-in' },
      { from: 'png', to: ['pdf'], via: 'pdf-lib' },
      { from: 'jpg', to: ['pdf'], via: 'pdf-lib' },
    ];
    if (this.media()) {
      for (const f of IMAGE_IN) out.push({ from: f, to: IMAGE_OUT.filter((t) => t !== f), via: 'chromium' });
      if (this.media()!.pdfToImages) out.push({ from: 'pdf', to: ['png'], via: 'chromium' });
    }
    if (this.tool('ffmpeg')) for (const f of AV_IN) out.push({ from: f, to: AV_OUT.filter((t) => t !== f), via: 'ffmpeg' });
    if (this.tool('pandoc')) for (const f of PANDOC_IN) out.push({ from: f, to: PANDOC_OUT.filter((t) => t !== f), via: 'pandoc' });
    return out;
  }

  async convert(src: string, to: string, out?: string, opts: { quality?: number; options?: Record<string, any> } = {}): Promise<{ path: string; via: string; bytes: number }> {
    to = to.toLowerCase().replace(/^\./, '');
    const from = extname(src).slice(1).toLowerCase();
    const target = out ?? join(dirname(src), `${basename(src, extname(src))}.${to === 'jpeg' ? 'jpg' : to}`);
    if (resolve(target) === resolve(src)) throw new Error('output would overwrite the input');
    mkdirSync(dirname(target), { recursive: true });
    const done = (via: string) => ({ path: target, via, bytes: statSync(target).size });
    const quality = Math.max(1, Math.min(100, opts.quality ?? 90));

    if ((from === 'csv' || from === 'tsv') && to === 'json') {
      writeFileSync(target, JSON.stringify(csvToJson(readFileSync(src, 'utf8'), from === 'tsv' ? '\t' : ','), null, 2));
      return done('built-in');
    }
    if (from === 'json' && to === 'csv') {
      writeFileSync(target, jsonToCsv(JSON.parse(readFileSync(src, 'utf8'))));
      return done('built-in');
    }
    if ((from === 'md' || from === 'markdown') && to === 'html' && !opts.options?.pandoc) {
      const body = await marked.parse(readFileSync(src, 'utf8'));
      writeFileSync(target, `<!doctype html><meta charset="utf-8"><title>${basename(src)}</title>\n${body}`);
      return done('built-in');
    }
    if ((from === 'html' || from === 'htm') && to === 'md' && !opts.options?.pandoc) {
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      writeFileSync(target, td.turndown(readFileSync(src, 'utf8')));
      return done('built-in');
    }
    if (to === 'gz') {
      writeFileSync(target.endsWith('.gz') ? target : `${src}.gz`, gzipSync(readFileSync(src)));
      return { path: target.endsWith('.gz') ? target : `${src}.gz`, via: 'built-in', bytes: statSync(target.endsWith('.gz') ? target : `${src}.gz`).size };
    }
    if (from === 'gz') {
      const t = out ?? src.replace(/\.gz$/i, '');
      writeFileSync(t, gunzipSync(readFileSync(src)));
      return { path: t, via: 'built-in', bytes: statSync(t).size };
    }
    if (to === 'pdf' && IMAGE_IN.includes(from)) {
      const r = await this.imagesToPdf([src], target);
      return { path: r.path, via: 'pdf-lib', bytes: statSync(r.path).size };
    }
    if (IMAGE_IN.includes(from) && IMAGE_OUT.includes(to)) {
      const m = this.media();
      if (!m) throw new Error('image conversion needs the Sensor app (Chromium codec host)');
      const buf = await m.convertImage(readFileSync(src), MIME[from], to === 'jpg' ? 'jpeg' : (to as any), quality / 100);
      writeFileSync(target, buf);
      return done('chromium');
    }
    if (from === 'pdf' && to === 'png') {
      const m = this.media();
      if (!m?.pdfToImages) throw new Error('PDF rendering needs the Sensor app');
      const pdf = readFileSync(src);
      const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
      const pages = parseRanges(opts.options?.pages, doc.getPageCount());
      const images = await m.pdfToImages(pdf, pages, Number(opts.options?.scale ?? 2));
      const dir = out ?? join(dirname(src), basename(src, '.pdf') + '-pages');
      mkdirSync(dir, { recursive: true });
      images.forEach((img, i) => writeFileSync(join(dir, `page-${String(pages[i] + 1).padStart(3, '0')}.png`), img));
      return { path: dir, via: 'chromium', bytes: images.reduce((a, b) => a + b.length, 0) };
    }
    if (AV_IN.includes(from) && AV_OUT.includes(to)) {
      const ff = this.tool('ffmpeg');
      if (!ff) throw new Error('audio/video conversion needs ffmpeg (install it or set tools.ffmpeg)');
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', src];
      if (opts.options?.bitrate) args.push('-b:a', String(opts.options.bitrate));
      if (opts.options?.crf) args.push('-crf', String(opts.options.crf));
      if (to === 'gif') args.push('-vf', `fps=${opts.options?.fps ?? 12},scale=${opts.options?.width ?? 640}:-1:flags=lanczos`);
      args.push(target);
      await run(ff, args, { maxBuffer: 16 * 1024 * 1024 });
      return done('ffmpeg');
    }
    if (PANDOC_IN.includes(from) && PANDOC_OUT.includes(to)) {
      const pd = this.tool('pandoc');
      if (!pd) throw new Error('document conversion needs pandoc (install it or set tools.pandoc)');
      await run(pd, [src, '-o', target, ...(to === 'txt' ? ['-t', 'plain'] : [])]);
      return done('pandoc');
    }
    throw new Error(`no converter for ${from} → ${to}. See \`sensor convert formats\`.`);
  }

  async imagesToPdf(inputs: string[], out: string): Promise<{ path: string; pages: number }> {
    const pdf = await PDFDocument.create();
    for (const p of inputs) {
      const ext = extname(p).slice(1).toLowerCase();
      let bytes: Buffer = readFileSync(p);
      let kind = ext;
      if (!['png', 'jpg', 'jpeg'].includes(ext)) {
        const m = this.media();
        if (!m) throw new Error(`${ext} images need the Sensor app to convert`);
        bytes = await m.convertImage(bytes, MIME[ext] ?? 'application/octet-stream', 'png', 1);
        kind = 'png';
      }
      const img = kind === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    writeFileSync(out, await pdf.save());
    return { path: out, pages: inputs.length };
  }
}

async function loadPdf(path: string): Promise<PDFDocument> {
  return PDFDocument.load(readFileSync(path), { ignoreEncryption: true });
}

function outPath(input: string, suffix: string, out?: string): string {
  return out ? resolve(out) : join(dirname(input), `${basename(input, extname(input))}${suffix}.pdf`);
}

export const documentsModule: CoreModule = {
  name: 'documents',
  init(core) {
    const D = new Documents(core);
    core.services.documents = D;
    const defs: CommandDef[] = [
      {
        id: 'pdf.info', title: 'PDF Info', scopes: ['files:read'], palette: false,
        params: { path: { type: 'string', required: true, positional: 0 } },
        handler: async (a) => {
          const doc = await loadPdf(a.path);
          return {
            path: a.path, pages: doc.getPageCount(), title: doc.getTitle() ?? null, author: doc.getAuthor() ?? null, subject: doc.getSubject() ?? null,
            keywords: doc.getKeywords() ?? null, creator: doc.getCreator() ?? null, producer: doc.getProducer() ?? null,
            created: doc.getCreationDate()?.toISOString() ?? null, modified: doc.getModificationDate()?.toISOString() ?? null,
            sizes: doc.getPages().slice(0, 5).map((p) => p.getSize()),
          };
        },
      },
      {
        id: 'pdf.merge', title: 'Merge PDFs', scopes: ['files:read', 'files:write'], palette: false,
        params: { inputs: { type: 'array', required: true, positional: 0 }, out: { type: 'string', required: true, positional: 1 } },
        handler: async (a) => {
          const merged = await PDFDocument.create();
          for (const p of a.inputs) {
            const src = await loadPdf(p);
            for (const page of await merged.copyPages(src, src.getPageIndices())) merged.addPage(page);
          }
          writeFileSync(a.out, await merged.save());
          core.events.emit('file.created', { path: a.out });
          return { path: a.out, pages: merged.getPageCount() };
        },
      },
      {
        id: 'pdf.split', title: 'Split PDF', scopes: ['files:read', 'files:write'], palette: false,
        params: { path: { type: 'string', required: true, positional: 0 }, outDir: { type: 'string' }, every: { type: 'number', default: 1, description: 'pages per output file' } },
        handler: async (a) => {
          const src = await loadPdf(a.path);
          const n = src.getPageCount();
          const dir = a.outDir ?? join(dirname(a.path), basename(a.path, '.pdf') + '-split');
          mkdirSync(dir, { recursive: true });
          const outs: string[] = [];
          for (let i = 0; i < n; i += a.every) {
            const part = await PDFDocument.create();
            const idx = [...Array(Math.min(a.every, n - i)).keys()].map((k) => i + k);
            for (const pg of await part.copyPages(src, idx)) part.addPage(pg);
            const file = join(dir, `${basename(a.path, '.pdf')}-${String(i + 1).padStart(3, '0')}.pdf`);
            writeFileSync(file, await part.save());
            outs.push(file);
          }
          return { files: outs };
        },
      },
      {
        id: 'pdf.extract', title: 'Extract PDF Pages', scopes: ['files:read', 'files:write'], palette: false,
        params: { path: { type: 'string', required: true, positional: 0 }, pages: { type: 'string', required: true, positional: 1, description: 'e.g. 1-3,7' }, out: { type: 'string' } },
        handler: async (a) => {
          const src = await loadPdf(a.path);
          const idx = parseRanges(a.pages, src.getPageCount());
          if (!idx.length) throw new Error('no pages selected');
          const doc = await PDFDocument.create();
          for (const pg of await doc.copyPages(src, idx)) doc.addPage(pg);
          const out = outPath(a.path, `-p${a.pages.replace(/[^\d,-]/g, '')}`, a.out);
          writeFileSync(out, await doc.save());
          return { path: out, pages: idx.length };
        },
      },
      {
        id: 'pdf.reorder', title: 'Reorder PDF Pages', scopes: ['files:read', 'files:write'], palette: false,
        params: { path: { type: 'string', required: true, positional: 0 }, order: { type: 'string', required: true, positional: 1, description: 'new order, e.g. 3,1,2 (pages can repeat or be dropped)' }, out: { type: 'string' } },
        handler: async (a) => {
          const src = await loadPdf(a.path);
          const idx = parseRanges(a.order, src.getPageCount());
          const doc = await PDFDocument.create();
          for (const pg of await doc.copyPages(src, idx)) doc.addPage(pg);
          const out = outPath(a.path, '-reordered', a.out);
          writeFileSync(out, await doc.save());
          return { path: out, pages: idx.length };
        },
      },
      {
        id: 'pdf.rotate', title: 'Rotate PDF Pages', scopes: ['files:read', 'files:write'], palette: false,
        params: { path: { type: 'string', required: true, positional: 0 }, degrees: { type: 'number', default: 90 }, pages: { type: 'string', description: 'default all' }, out: { type: 'string' } },
        handler: async (a) => {
          if (a.degrees % 90 !== 0) throw new Error('degrees must be a multiple of 90');
          const doc = await loadPdf(a.path);
          for (const i of parseRanges(a.pages, doc.getPageCount())) {
            const p = doc.getPage(i);
            p.setRotation(degrees((p.getRotation().angle + a.degrees + 360) % 360));
          }
          const out = outPath(a.path, '-rotated', a.out);
          writeFileSync(out, await doc.save());
          return { path: out };
        },
      },
      {
        id: 'pdf.setMeta', title: 'Edit PDF Metadata', scopes: ['files:write'], palette: false,
        params: { path: { type: 'string', required: true, positional: 0 }, title: { type: 'string' }, author: { type: 'string' }, subject: { type: 'string' }, keywords: { type: 'array' }, out: { type: 'string' } },
        handler: async (a) => {
          const doc = await loadPdf(a.path);
          if (a.title !== undefined) doc.setTitle(a.title);
          if (a.author !== undefined) doc.setAuthor(a.author);
          if (a.subject !== undefined) doc.setSubject(a.subject);
          if (a.keywords) doc.setKeywords(a.keywords);
          doc.setModificationDate(new Date());
          const out = a.out ?? a.path;
          writeFileSync(out, await doc.save());
          return { path: out };
        },
      },
      {
        id: 'pdf.compress', title: 'Compress PDF', scopes: ['files:read', 'files:write'], palette: false,
        description: 'Uses qpdf when installed; otherwise re-saves with object streams (smaller gains, never touches image quality).',
        params: { path: { type: 'string', required: true, positional: 0 }, out: { type: 'string' } },
        handler: async (a) => {
          const out = outPath(a.path, '-compressed', a.out);
          const before = statSync(a.path).size;
          const qpdf = D.tool('qpdf');
          let via = 'pdf-lib';
          if (qpdf) {
            await run(qpdf, ['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', a.path, out]);
            via = 'qpdf';
          } else {
            const doc = await loadPdf(a.path);
            writeFileSync(out, await doc.save({ useObjectStreams: true }));
          }
          const after = statSync(out).size;
          return { path: out, via, before, after, saved: before - after, ratio: Math.round((after / before) * 1000) / 1000 };
        },
      },
      {
        id: 'pdf.fromImages', title: 'Images To PDF', scopes: ['files:read', 'files:write'], palette: false,
        params: { inputs: { type: 'array', required: true, positional: 0 }, out: { type: 'string', required: true, positional: 1 } },
        handler: (a) => D.imagesToPdf(a.inputs, a.out),
      },
      {
        id: 'pdf.toImages', title: 'PDF To Images', scopes: ['files:read', 'files:write'], palette: false,
        params: { path: { type: 'string', required: true, positional: 0 }, pages: { type: 'string' }, scale: { type: 'number', default: 2 }, outDir: { type: 'string' } },
        handler: (a) => D.convert(a.path, 'png', a.outDir, { options: { pages: a.pages, scale: a.scale } }),
      },
      {
        id: 'pdf.fromPage', title: 'Save Page as PDF', scopes: ['page:read', 'files:write'],
        params: { id: { type: 'string', description: 'tab id' }, out: { type: 'string', positional: 0 } },
        handler: async (a) => {
          const tab = a.id ? core.workspaces.tab(a.id) : activeTabOrThrow(core);
          const pdf = await core.browser.printToPDF(tab.id);
          const dir = (core.settings.get<string>('downloads.dir') as string) || join(homedir(), 'Downloads');
          const out = a.out ?? join(dir, `${slugTitle(tab.title || 'page')}.pdf`);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, pdf);
          core.events.emit('file.created', { path: out });
          core.notify('success', 'Saved PDF', out, 'documents');
          return { path: out, bytes: pdf.length };
        },
      },
      {
        id: 'pdf.fromSelection', title: 'Save Selection as PDF', scopes: ['page:read', 'files:write'],
        params: { tab: { type: 'string' }, out: { type: 'string', positional: 0 } },
        handler: async (a, ctx) => {
          const tab = a.tab ? core.workspaces.tab(a.tab) : activeTabOrThrow(core);
          const html = await core.browser.exec(tab.id, `(() => { const s = getSelection(); if (!s || s.isCollapsed) return null; const d = document.createElement('div'); for (let i = 0; i < s.rangeCount; i++) d.appendChild(s.getRangeAt(i).cloneContents()); return d.innerHTML; })()`);
          if (!html) throw new Error('select some content first');
          const doc = `<!doctype html><meta charset="utf-8"><base href="${tab.url}"><title>${tab.title}</title><style>body{font:14px/1.5 system-ui;margin:40px}</style>${html}<hr><small>${tab.url}</small>`;
          const tmp = core.workspaces.openTab({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(doc), workspaceId: tab.workspaceId, background: true, incognito: true });
          try {
            core.browser.ensure(tmp.id);
            await core.browser.waitForLoad(tmp.id, 10000);
            await new Promise((r) => setTimeout(r, 300));
            return await ctx.run('pdf.fromPage', { id: tmp.id, out: a.out ?? undefined });
          } finally {
            core.workspaces.closeTab(tmp.id);
          }
        },
      },
      {
        id: 'files.convert', title: 'Convert File', scopes: ['files:read', 'files:write'], palette: false,
        params: {
          path: { type: 'string', required: true, positional: 0 },
          to: { type: 'string', required: true, positional: 1, description: 'target format, e.g. webp, mp3, json, pdf' },
          out: { type: 'string' },
          quality: { type: 'number', description: '1-100 for lossy formats' },
          options: { type: 'object', description: 'converter-specific: bitrate, crf, fps, width, pages, scale' },
        },
        handler: async (a) => {
          const r = await D.convert(resolve(a.path), a.to, a.out ? resolve(a.out) : undefined, { quality: a.quality, options: a.options });
          core.events.emit('file.created', { path: r.path });
          return r;
        },
      },
      {
        id: 'files.convertBatch', title: 'Batch Convert Files', scopes: ['files:read', 'files:write'], palette: false,
        params: { paths: { type: 'array', required: true, positional: 0 }, to: { type: 'string', required: true, positional: 1 }, quality: { type: 'number' } },
        handler: async (a) => {
          const results: any[] = [];
          for (const p of a.paths) {
            try {
              results.push({ src: p, ...(await D.convert(resolve(p), a.to, undefined, { quality: a.quality })) });
            } catch (e: any) {
              results.push({ src: p, error: e.message });
            }
          }
          return results;
        },
      },
      {
        id: 'convert.formats', title: 'List Supported Conversions', scopes: [], palette: false,
        params: { from: { type: 'string', positional: 0 } },
        handler: (a) => D.formats().filter((f) => !a.from || f.from === a.from.toLowerCase().replace(/^\./, '')),
      },
      {
        id: 'documents.panel', title: 'Documents & PDF Tools', scopes: ['workspaces:write'],
        handler: () => ({ id: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'documents' } }) }),
      },
    ];
    return defs;
  },
};
