import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { makeCore, tempDir } from './helpers';
import { allModules } from '../../src/core/modules';
import { parseFeed, discoverFeeds } from '../../src/core/services/rss';
import { csvToJson, jsonToCsv, parseRanges } from '../../src/core/services/documents';
import { recognize, annotationKey } from '../../src/core/services/knowledge-extras';
import { extractLinks, frontmatter } from '../../src/core/services/notes';
import { renameTarget } from '../../src/core/services/files';

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});
function setup() {
  const c = makeCore({ modules: allModules() });
  cleanups.push(c.cleanup);
  return c;
}

describe('notes', () => {
  it('creates notes in a vault, indexes them, finds backlinks', async () => {
    const { core } = setup();
    const vault = tempDir('vault-');
    mkdirSync(join(vault, '.obsidian'));
    await core.run('notes.addVault', { path: vault });
    const res = await core.run('notes.create', { title: 'Research: Rust', body: 'Ownership and borrowing.', refs: ['https://doc.rust-lang.org/book/', 'https://youtu.be/abc?t=93'] });
    const text = readFileSync(join(vault, res.path), 'utf8');
    expect(text).toContain('# Research: Rust');
    expect(text).toContain('https://doc.rust-lang.org/book/');
    expect(text).toContain('[YouTube abc @ 1:33](https://youtu.be/abc?t=93)');
    const again = await core.run('notes.create', { title: 'Research: Rust', body: 'x' });
    expect(again.path).not.toBe(res.path); // never clobbers
    const hits = await core.run('notes.search', { q: 'borrowing' });
    expect(hits[0].uri).toBe(res.uri);
    const back = await core.run('notes.backlinks', { uri: 'https://doc.rust-lang.org/book/' });
    expect(back.map((b: any) => b.uri)).toContain(res.uri);
    await core.run('notes.append', { path: res.path, text: 'More.' });
    expect(readFileSync(join(vault, res.path), 'utf8')).toMatch(/More\.\n?$/);
    await expect(core.run('notes.read', { path: '../../etc/passwd' })).rejects.toThrow(/escapes/);
  });
  it('extractLinks + frontmatter', () => {
    const l = extractLinks('see [a](https://a.com) and https://b.com/x and [[Other Note|alias]] and [f](sensor://file/x)');
    expect(l.urls).toEqual(expect.arrayContaining(['https://a.com', 'https://b.com/x', 'sensor://file/x']));
    expect(l.wikilinks).toEqual(['Other Note']);
    expect(frontmatter({ tags: ['a', 'b c'], sensor: { source: 'https://x.y/z?q=1' } })).toContain('source: "https://x.y/z?q=1"');
  });
});

describe('files', () => {
  it('lists, batch renames (dry run then apply), zips, unzips, finds dupes, indexes', async () => {
    const { core } = setup();
    const dir = tempDir('files-');
    writeFileSync(join(dir, 'a.txt'), 'alpha unique-token-xyz');
    writeFileSync(join(dir, 'b.txt'), 'same content');
    writeFileSync(join(dir, 'c.txt'), 'same content');
    const list = await core.run('files.list', { path: dir });
    expect(list.map((e: any) => e.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    const plan = await core.run('files.batchRename', { paths: [join(dir, 'b.txt'), join(dir, 'c.txt')], pattern: 'doc-{n:2}{ext}' });
    expect(plan.dryRun).toBe(true);
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);
    await core.run('files.batchRename', { paths: [join(dir, 'b.txt'), join(dir, 'c.txt')], pattern: 'doc-{n:2}{ext}', apply: true });
    expect(readdirSync(dir).sort()).toEqual(['a.txt', 'doc-01.txt', 'doc-02.txt']);
    const dupes = await core.run('files.dupes', { path: dir, minSize: 1 });
    expect(dupes[0].paths).toHaveLength(2);
    const z = await core.run('files.zip', { paths: [join(dir, 'a.txt')], out: join(dir, 'out.zip') });
    expect(z.entries).toBe(1);
    const u = await core.run('files.unzip', { path: join(dir, 'out.zip'), dest: join(dir, 'x') });
    expect(readFileSync(join(u.dest, 'a.txt'), 'utf8')).toContain('alpha');
    await core.run('files.addRoot', { path: dir });
    await core.run('files.index', { path: dir });
    for (let i = 0; i < 50 && core.services.files.indexing.running; i++) await new Promise((r) => setTimeout(r, 20));
    const found = await core.run('files.search', { q: 'unique-token-xyz' });
    expect(found[0]?.path).toBe(join(dir, 'a.txt'));
  });
  it('renameTarget tokens', () => {
    expect(renameTarget('/x/photo.JPG', '{parent}-{n:3}{ext}', 4)).toBe('/x/x-005.JPG');
    expect(renameTarget('/x/IMG_001 copy.png', '{name}{ext}', 0, ' copy$', '')).toBe('/x/IMG_001.png');
  });
});

describe('documents', () => {
  it('csv/json and ranges', () => {
    const rows = csvToJson('a,b\n1,"x, ""y"""\n2,z\n');
    expect(rows).toEqual([{ a: '1', b: 'x, "y"' }, { a: '2', b: 'z' }]);
    expect(jsonToCsv(rows)).toBe('a,b\n1,"x, ""y"""\n2,z\n');
    expect(parseRanges('1-3,5,9-', 10)).toEqual([0, 1, 2, 4, 8, 9]);
    expect(() => parseRanges('a', 3)).toThrow();
  });
  it('pdf merge, extract, rotate, info; converts csv and md', async () => {
    const { core } = setup();
    const dir = tempDir('pdf-');
    for (const [name, n] of [['one.pdf', 2], ['two.pdf', 3]] as const) {
      const d = await PDFDocument.create();
      for (let i = 0; i < n; i++) d.addPage([200, 200]);
      writeFileSync(join(dir, name), await d.save());
    }
    const m = await core.run('pdf.merge', { inputs: [join(dir, 'one.pdf'), join(dir, 'two.pdf')], out: join(dir, 'all.pdf') });
    expect(m.pages).toBe(5);
    const e = await core.run('pdf.extract', { path: join(dir, 'all.pdf'), pages: '2-3' });
    expect(e.pages).toBe(2);
    await core.run('pdf.rotate', { path: e.path, degrees: 90, out: join(dir, 'rot.pdf') });
    const doc = await PDFDocument.load(readFileSync(join(dir, 'rot.pdf')));
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    const split = await core.run('pdf.split', { path: join(dir, 'all.pdf') });
    expect(split.files).toHaveLength(5);
    await core.run('pdf.setMeta', { path: join(dir, 'all.pdf'), title: 'Merged', author: 'Sensor' });
    expect((await core.run('pdf.info', { path: join(dir, 'all.pdf') })).title).toBe('Merged');
    writeFileSync(join(dir, 't.csv'), 'k,v\na,1\n');
    const c = await core.run('files.convert', { path: join(dir, 't.csv'), to: 'json' });
    expect(JSON.parse(readFileSync(c.path, 'utf8'))).toEqual([{ k: 'a', v: '1' }]);
    writeFileSync(join(dir, 'r.md'), '# Hi\n\n**bold**');
    const h = await core.run('files.convert', { path: join(dir, 'r.md'), to: 'html' });
    expect(readFileSync(h.path, 'utf8')).toContain('<strong>bold</strong>');
    await expect(core.run('files.convert', { path: join(dir, 'r.md'), to: 'xyz' })).rejects.toThrow(/no converter/);
  });
});

describe('rss', () => {
  it('parses RSS and Atom, discovers feeds', () => {
    const rss = parseFeed('<rss version="2.0"><channel><title>T</title><item><title>A &amp; B</title><link>http://x/1</link><guid>g1</guid><description>&lt;p&gt;hi&lt;/p&gt;</description></item></channel></rss>');
    expect(rss.title).toBe('T');
    expect(rss.items[0]).toMatchObject({ guid: 'g1', title: 'A & B', url: 'http://x/1', summary: 'hi' });
    const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><id>e1</id><title>E</title><link href="http://y/1"/><updated>2024-01-01T00:00:00Z</updated></entry></feed>');
    expect(atom.items[0]).toMatchObject({ guid: 'e1', url: 'http://y/1' });
    expect(discoverFeeds('<link rel="alternate" type="application/rss+xml" href="/feed.xml">', 'https://site.com/blog')).toEqual(['https://site.com/feed.xml']);
  });
  it('subscribes via platform fetch and stores items', async () => {
    const { core } = setup();
    core.platform.fetchText = async () => ({ status: 200, contentType: 'application/rss+xml', text: '<rss><channel><title>Feed</title><item><title>One</title><link>http://a/1</link><guid>1</guid></item></channel></rss>' });
    const f = await core.run('feeds.add', { url: 'http://a/feed' });
    expect(f.items).toBe(1);
    const items = await core.run('feeds.items', { unread: true });
    expect(items[0].title).toBe('One');
    const hits = await core.run('search.query', { q: 'One', sources: ['feeds'] });
    expect(hits[0].uri).toMatch(/^sensor:\/\/feeditem\//);
  });
});

describe('recognition and annotations', () => {
  it('recognizes common sites deterministically', () => {
    expect(recognize('t', { url: 'https://www.youtube.com/watch?v=abc', title: '' })?.kind).toBe('youtube.video');
    expect(recognize('t', { url: 'https://chatgpt.com/c/123-abc', title: '' })?.ids.conversation).toBe('123-abc');
    expect(recognize('t', { url: 'https://github.com/a/b/pull/7', title: '' })?.ids).toMatchObject({ owner: 'a', repo: 'b', type: 'pr', number: '7' });
    expect(recognize('t', { url: 'https://x.com/doc.pdf', title: '' })?.kind).toBe('pdf');
    expect(recognize('t', { url: 'https://blog.com/post', title: '', ogType: 'article' })?.kind).toBe('article');
    expect(recognize('t', { url: 'sensor://newtab', title: '' })).toBeNull();
  });
  it('stores annotations per normalized url', async () => {
    const { core } = setup();
    expect(annotationKey('https://a.com/p?utm_source=x&id=2#frag')).toBe('https://a.com/p?id=2');
    await core.run('annotations.create', { url: 'https://a.com/p?utm_source=x', kind: 'highlight', quote: 'important bit' });
    const list = await core.run('annotations.list', { url: 'https://a.com/p#top' });
    expect(list).toHaveLength(1);
    const hits = await core.run('search.query', { q: 'important', sources: ['annotations'] });
    expect(hits).toHaveLength(1);
  });
  it('clipboard store dedupes and prunes', async () => {
    const { core } = setup();
    core.settings.set('clipboard.maxItems', 2);
    core.services.clipboard.add({ kind: 'text', text: 'one' });
    core.services.clipboard.add({ kind: 'text', text: 'two' });
    core.services.clipboard.add({ kind: 'text', text: 'one' });
    core.services.clipboard.add({ kind: 'text', text: 'three' });
    const list = await core.run('clipboard.list');
    expect(list.map((x: any) => x.text)).toEqual(['three', 'one']);
  });
});
