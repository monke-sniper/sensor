import { afterEach, describe, expect, it } from 'vitest';
import { makeCore } from './helpers';
import { Core } from '../../src/core/core';
import { normalizeUrl } from '../../src/core/services/workspaces';
import { insertPanel, removeNode, leaves, defaultLayout, setSizes } from '../../src/core/layout';
import { ftsQuery, fuzzyScore } from '../../src/core/services/search';
import { parseUri, youtubeId, parseTime } from '../../src/core/services/resources';

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});
function core() {
  const c = makeCore();
  cleanups.push(c.cleanup);
  return c;
}

describe('command bus', () => {
  it('lists commands and runs as user', async () => {
    const { core: c } = core();
    expect(c.bus.list().length).toBeGreaterThan(30);
    const ws = await c.run('workspaces.list');
    expect(ws).toHaveLength(1);
    expect(ws[0].name).toBe('Main');
  });

  it('validates params', async () => {
    const { core: c } = core();
    await expect(c.run('workspaces.switch', {})).rejects.toThrow(/missing required/);
    await expect(c.run('workspaces.list', { bogus: 1 })).rejects.toThrow(/unknown param/);
    await expect(c.run('tabs.open', { target: 'nope' })).rejects.toThrow(/must be one of/);
  });

  it('enforces token scopes and audits', async () => {
    const { core: c } = core();
    const { token } = c.tokens.create('agent', ['tabs:read']);
    const p = c.tokens.verify(token)!;
    expect(p.kind).toBe('token');
    await expect(c.bus.run('tabs.list', {}, p)).resolves.toBeInstanceOf(Array);
    await expect(c.bus.run('tabs.open', { url: 'example.com' }, p)).rejects.toThrow(/lacks scope/);
    const audit = c.audit.recent();
    expect(audit.map((r: any) => r.ok)).toEqual([0, 1]);
    expect(c.tokens.verify('snsr_wrong')).toBeNull();
  });

  it('approval handler can allow a missing scope once', async () => {
    const { core: c } = core();
    const { token } = c.tokens.create('agent', []);
    const p = c.tokens.verify(token)!;
    c.bus.approval = async () => true;
    await expect(c.bus.run('tabs.list', {}, p)).resolves.toBeInstanceOf(Array);
  });
});

describe('workspaces and tabs', () => {
  it('opens, activates, closes tabs and persists them', async () => {
    const { core: c, dir } = core();
    const t1 = await c.run('tabs.open', { url: 'example.com' });
    expect(t1.url).toBe('https://example.com');
    const t2 = await c.run('tabs.open', { url: 'hello world' });
    expect(t2.url).toContain('duckduckgo.com/?q=hello%20world');
    expect(c.workspaces.active().activeTab).toBe(t2.id);
    await c.run('tabs.close', { id: t2.id });
    expect(c.workspaces.active().activeTab).not.toBe(t2.id);
    const inc = await c.run('tabs.incognito', { url: 'secret.example' });
    expect(inc.incognito).toBe(true);
    c.dispose();
    const c2 = new Core({ dataDir: dir });
    const urls = c2.workspaces.allTabs().map((t) => t.url);
    expect(urls).toContain('https://example.com');
    expect(urls.some((u) => u.includes('secret'))).toBe(false);
    cleanups = [() => c2.dispose()];
  });

  it('website panels and layouts', async () => {
    const { core: c } = core();
    const t = await c.run('tabs.open', { url: 'chatgpt.com', target: 'panel' });
    const panels = await c.run('panels.list');
    expect(panels.panels.some((p: any) => p.panel.kind === 'web' && p.panel.tabId === t.id)).toBe(true);
    expect(c.workspaces.visibleTabs()).toContain(t.id);
    await c.run('layouts.save', { name: 'research' });
    const leaf = panels.panels.find((p: any) => p.panel.kind === 'web');
    await c.run('panels.close', { id: leaf.id });
    expect((await c.run('panels.list')).panels).toHaveLength(1);
    await c.run('layouts.restore', { name: 'research' });
    expect((await c.run('panels.list')).panels).toHaveLength(2);
  });

  it('workspace create/switch/delete', async () => {
    const { core: c } = core();
    const w = await c.run('workspaces.create', { name: 'Research' });
    expect(c.workspaces.activeId).toBe(w.id);
    await c.run('workspaces.switch', { id: 'main' });
    expect(c.workspaces.active().name).toBe('Main');
    await c.run('workspaces.delete', { id: w.id });
    expect(c.workspaces.list()).toHaveLength(1);
    await expect(c.run('workspaces.delete', { id: 'Main' })).rejects.toThrow(/last workspace/);
  });
});

describe('history, bookmarks, search', () => {
  it('records visits (not incognito) and searches across sources', async () => {
    const { core: c } = core();
    c.browserData.recordVisit('https://news.example.com/a', 'Interesting Article', 'default');
    c.browserData.recordVisit('https://private.example.com', 'Private', 'incognito:1');
    await c.run('bookmarks.add', { url: 'https://docs.example.com', title: 'Example Docs' });
    c.search.index({ uri: 'sensor://note/v/a.md', source: 'notes', title: 'Quantum notes', body: 'entanglement and superposition' });
    expect(await c.run('history.search', { q: 'private' })).toHaveLength(0);
    const hits = await c.run('search.query', { q: 'interesting' });
    expect(hits[0].uri).toBe('https://news.example.com/a');
    const notes = await c.run('search.query', { q: 'entangle' });
    expect(notes[0].source).toBe('notes');
    const docs = await c.run('search.query', { q: 'example docs', sources: ['bookmarks'] });
    expect(docs[0].source).toBe('bookmarks');
    const cmds = await c.run('search.query', { q: 'new tab', sources: ['commands'] });
    expect(cmds[0].uri).toBe('sensor://command/tabs.open');
  });
});

describe('pure helpers', () => {
  it('normalizeUrl', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('github.com/x/y')).toBe('https://github.com/x/y');
    expect(normalizeUrl('file:///C:/a.pdf')).toBe('file:///C:/a.pdf');
    expect(normalizeUrl('what is rust')).toContain('q=what%20is%20rust');
  });
  it('layout insert/remove/sizes', () => {
    const l = defaultLayout();
    const a = insertPanel(l.root, { kind: 'tool', tool: 'notes' }, 'right');
    const b = insertPanel(a.root, { kind: 'tool', tool: 'files' }, 'right', a.leafId);
    expect(leaves(b.root)).toHaveLength(3);
    expect(b.root.type === 'split' && b.root.children.length).toBe(3); // same-direction siblings are flattened
    const c = removeNode(b.root, a.leafId);
    expect(leaves(c)).toHaveLength(2);
    const d = setSizes(c, c.id, [3, 1]);
    expect(d.type === 'split' && d.sizes).toEqual([0.75, 0.25]);
  });
  it('fts and fuzzy', () => {
    expect(ftsQuery('foo "bar*')).toBe('"foo"* "bar"*');
    expect(fuzzyScore('nt', 'New Tab')).toBeGreaterThan(0);
    expect(fuzzyScore('zz', 'New Tab')).toBe(0);
  });
  it('uris', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=abc123&t=1m3s')).toBe('abc123');
    expect(youtubeId('https://youtu.be/xyz')).toBe('xyz');
    expect(parseTime('1m3s')).toBe(63);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseUri('https://youtu.be/xyz?t=93')).toMatchObject({ kind: 'youtube', id: 'xyz', query: { t: '93' } });
    expect(parseUri('sensor://note/My%20Vault/a/b.md')).toMatchObject({ kind: 'note', id: 'My Vault/a/b.md' });
  });
});
