import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { marked } from 'marked';
import { fmtBytes, fmtTime, hostOf, run } from '../../api';
import { activeWorkspace, onEvent, state } from '../../store';
import { Empty, useCommand } from './common';

// ------------------------------------------------------------------ Notes
export function NotesTool() {
  const [vaults, refetchVaults] = useCommand<any[]>('notes.vaults', () => ({}), ['settings.changed']);
  const [vault, setVault] = createSignal<string | undefined>();
  const [filter, setFilter] = createSignal('');
  const [open, setOpen] = createSignal<{ vault: string; path: string } | null>(null);
  const [notes] = useCommand<any[]>('notes.list', () => ({ vault: vault(), limit: 500 }), ['note.saved', 'note.changed', 'settings.changed']);
  const [hits] = useCommand<any[]>('notes.search', () => ({ q: filter() || '∅', limit: 50 }));
  const [vaultPath, setVaultPath] = createSignal('');
  onMount(() => {
    const off = onEvent((e) => {
      if (e.topic === 'note.open') setOpen({ vault: e.data.vault, path: e.data.path });
    });
    onCleanup(off);
  });
  return (
    <div class="list">
      <Show
        when={vaults()?.length}
        fallback={
          <div class="setup">
            <p>Point Sensor at your Obsidian vault folder. Notes stay plain Markdown files in your vault.</p>
            <input placeholder="C:\Users\you\Documents\MyVault" value={vaultPath()} onInput={(e) => setVaultPath(e.currentTarget.value)} />
            <button onClick={() => run('notes.addVault', { path: vaultPath() }).then(refetchVaults).catch((e) => alert(e.message))}>Add vault</button>
          </div>
        }
      >
        <Show when={open()} fallback={
          <>
            <div class="list-actions">
              <select onChange={(e) => setVault(e.currentTarget.value || undefined)}>
                <For each={vaults()}>{(v) => <option value={v.name}>{v.name}</option>}</For>
              </select>
              <button onClick={() => run('palette.prompt', { command: 'notes.create' })}>New note</button>
              <button onClick={() => run('notes.capture', {})} disabled={!activeWorkspace()?.activeTab}>Capture tab</button>
              <button onClick={() => run('obsidian.launch', {})}>Open Obsidian</button>
            </div>
            <input class="filter" placeholder="Search notes (full text)" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
            <Show when={filter().trim()} fallback={
              <For each={notes()}>
                {(n) => (
                  <div class="row link" onClick={() => setOpen({ vault: vault() ?? vaults()![0].name, path: n.path })}>
                    <div class="row-main">
                      <div class="row-title">{n.name}</div>
                      <div class="row-sub">{n.path} · {fmtTime(n.mtime)}</div>
                    </div>
                  </div>
                )}
              </For>
            }>
              <For each={hits()}>
                {(h) => {
                  const parts = decodeURIComponent(h.uri.replace('sensor://note/', '')).split('/');
                  return (
                    <div class="row link" onClick={() => setOpen({ vault: parts[0], path: parts.slice(1).join('/') })}>
                      <div class="row-main">
                        <div class="row-title">{h.title}</div>
                        <div class="row-sub">{h.snippet}</div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </>
        }>
          <NoteView vault={open()!.vault} path={open()!.path} onBack={() => setOpen(null)} />
        </Show>
      </Show>
    </div>
  );
}

function NoteView(props: { vault: string; path: string; onBack: () => void }) {
  const [note, refetch] = useCommand<any>('notes.read', () => ({ vault: props.vault, path: props.path }), ['note.saved', 'note.changed']);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  let body!: HTMLDivElement;
  const html = () => {
    const src = (note()?.content ?? '').replace(/^---\n[\s\S]*?\n---\n/, '');
    // wikilinks -> clickable spans
    const withLinks = src.replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_m: string, target: string, alias?: string) => `<a href="#note:${encodeURIComponent(target)}">${alias || target}</a>`);
    return marked.parse(withLinks, { async: false }) as string;
  };
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#note:')) run('notes.open', { vault: props.vault, path: decodeURIComponent(href.slice(6)) });
    else if (href) run('resources.open', { uri: href }).catch(() => run('tabs.open', { url: href }));
  };
  return (
    <div class="note-view">
      <div class="list-actions">
        <button onClick={props.onBack}>‹ Back</button>
        <span class="muted ellipsis">{props.vault}/{props.path}</span>
        <span class="spacer" />
        <Show when={!editing()} fallback={
          <>
            <button onClick={() => run('notes.write', { vault: props.vault, path: props.path, content: draft() }).then(() => { setEditing(false); refetch(); })}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </>
        }>
          <button onClick={() => { setDraft(note()?.content ?? ''); setEditing(true); }}>Edit text</button>
        </Show>
        <button onClick={() => run('notes.open', { vault: props.vault, path: props.path, in: 'obsidian' })}>Open in Obsidian</button>
      </div>
      <div class="muted small-note">Markdown quick view. Full editing, backlinks graph and plugins are in Obsidian itself.</div>
      <Show when={!editing()} fallback={<textarea class="note-edit" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} />}>
        <div class="md" ref={body} innerHTML={html()} onClick={onClick} />
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ Files
export function FilesTool() {
  const [roots, refetchRoots] = useCommand<any>('files.roots', () => ({}), ['settings.changed', 'file.indexed']);
  const [cwd, setCwd] = createSignal<string | null>(null);
  const [q, setQ] = createSignal('');
  const [sel, setSel] = createSignal<Set<string>>(new Set());
  const [newRoot, setNewRoot] = createSignal('');
  const [list, refetchList] = useCommand<any[]>(() => (cwd() ? 'files.list' : 'files.recent'), () => (cwd() ? { path: cwd() } : {}), ['file.created', 'file.moved', 'file.removed']);
  const [hits] = useCommand<any[]>('files.search', () => ({ q: q() || '∅', limit: 100 }));
  onMount(() => {
    const off = onEvent((e) => e.topic === 'file.browse' && setCwd(e.data.path));
    onCleanup(off);
  });
  createEffect(() => {
    if (!cwd() && roots()?.roots?.[0]) setCwd(roots().roots[0]);
  });
  const toggle = (p: string) => setSel((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const selected = () => [...sel()];
  const parent = () => {
    const c = cwd();
    if (!c) return null;
    const i = Math.max(c.lastIndexOf('/'), c.lastIndexOf('\\'));
    return i > 0 ? c.slice(0, i) || '/' : null;
  };
  const act = async (fn: () => Promise<any>) => {
    try {
      const r = await fn();
      setSel(new Set<string>());
      refetchList();
      return r;
    } catch (e: any) {
      alert(e.message);
    }
  };
  return (
    <div class="list files">
      <div class="list-actions">
        <For each={roots()?.roots ?? []}>{(r: string) => <button class={'chip' + (cwd()?.startsWith(r) ? ' on' : '')} onClick={() => setCwd(r)} title={r}>{r.split(/[\\/]/).pop() || r}</button>}</For>
        <input placeholder="Add folder path…" value={newRoot()} onInput={(e) => setNewRoot(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && run('files.addRoot', { path: newRoot() }).then(() => { setNewRoot(''); refetchRoots(); }).catch((er) => alert(er.message))} />
        <Show when={roots()?.indexing?.running}><span class="muted">indexing {roots().indexing.done}…</span></Show>
      </div>
      <input class="filter" placeholder="Search file names and contents" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <Show when={selected().length}>
        <div class="list-actions">
          <span class="muted">{selected().length} selected</span>
          <button onClick={() => act(() => run('files.zip', { paths: selected() }))}>Zip</button>
          <button onClick={() => { const to = prompt('Convert to (e.g. webp, png, json, mp3):'); if (to) act(() => run('files.convertBatch', { paths: selected(), to })); }}>Convert</button>
          <button onClick={() => { const pattern = prompt('Rename pattern ({name} {ext} {n:2} {date} {parent})', '{name}{ext}'); if (pattern) act(async () => { const plan = await run<any>('files.batchRename', { paths: selected(), pattern }); if (confirm(plan.plan.map((p: any) => `${p.from.split(/[\\/]/).pop()} → ${p.to.split(/[\\/]/).pop()}`).join('\n'))) await run('files.batchRename', { paths: selected(), pattern, apply: true }); }); }}>Rename…</button>
          <button onClick={() => { const tag = prompt('Tag:'); if (tag) act(() => run('files.tag', { paths: selected(), tag })); }}>Tag</button>
          <Show when={selected().every((p) => p.toLowerCase().endsWith('.pdf')) && selected().length > 1}>
            <button onClick={() => { const out = prompt('Merged PDF path:', selected()[0].replace(/[^\\/]+$/, 'merged.pdf')); if (out) act(() => run('pdf.merge', { inputs: selected(), out })); }}>Merge PDFs</button>
          </Show>
          <button class="danger" onClick={() => confirm(`Move ${selected().length} item(s) to the Recycle Bin?`) && act(() => run('files.delete', { paths: selected() }))}>Delete</button>
        </div>
      </Show>
      <Show when={q().trim()} fallback={
        <>
          <Show when={cwd()}>
            <div class="crumbs">
              <Show when={parent()}><button class="icon-btn" onClick={() => setCwd(parent())}>↑</button></Show>
              <span class="ellipsis">{cwd()}</span>
              <span class="spacer" />
              <button class="icon-btn" title="Index this folder" onClick={() => run('files.index', { path: cwd() })}>⟳</button>
            </div>
          </Show>
          <Show when={list()?.length} fallback={<Empty>{cwd() ? 'Empty folder.' : 'No recent files. Add a folder above.'}</Empty>}>
            <For each={list()}>
              {(f: any) => {
                const path = typeof f === 'string' ? f : f.path;
                const name = typeof f === 'string' ? f.split(/[\\/]/).pop() : f.name;
                return (
                  <div class={'row link' + (sel().has(path) ? ' selected' : '')} onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? toggle(path) : f.dir ? setCwd(path) : run('files.open', { path }))}>
                    <input type="checkbox" checked={sel().has(path)} onClick={(e) => { e.stopPropagation(); toggle(path); }} />
                    <span class="glyph">{f.dir ? '▸' : '·'}</span>
                    <div class="row-main">
                      <div class="row-title">{name}</div>
                      <Show when={typeof f !== 'string'}><div class="row-sub">{f.dir ? 'folder' : fmtBytes(f.size)} · {fmtTime(f.mtime)}</div></Show>
                    </div>
                    <button class="icon-btn" title="Show in Explorer" onClick={(e) => { e.stopPropagation(); run('files.reveal', { path }); }}>⧉</button>
                  </div>
                );
              }}
            </For>
          </Show>
        </>
      }>
        <For each={hits()}>
          {(h) => (
            <div class="row link" onClick={() => run('files.open', { path: h.path })}>
              <div class="row-main">
                <div class="row-title">{h.title}</div>
                <div class="row-sub">{h.path}</div>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ Clipboard
export function ClipboardTool() {
  const [q, setQ] = createSignal('');
  const [list, refetch] = useCommand<any[]>('clipboard.list', () => ({ q: q() || undefined, limit: 200, images: true }), ['clipboard.added']);
  return (
    <div class="list">
      <input class="filter" placeholder="Search clipboard history" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="list-actions">
        <button onClick={() => run('clipboard.toggle').then(refetch)}>{state.snap.settings['clipboard.enabled'] ? 'Pause recording' : 'Resume recording'}</button>
        <button onClick={() => confirm('Clear clipboard history (keeps pinned)?') && run('clipboard.clear').then(refetch)}>Clear</button>
      </div>
      <Show when={list()?.length} fallback={<Empty>Nothing copied yet. History is stored locally only; password-manager copies are skipped.</Empty>}>
        <For each={list()}>
          {(c) => (
            <div class="row link clip" onClick={() => run('clipboard.copy', { id: c.id })} title="Click to copy">
              <Show when={c.imageBase64} fallback={<div class="row-main"><div class="row-title pre-1">{c.text}</div><div class="row-sub">{c.kind} · {fmtTime(c.created_at)}</div></div>}>
                <img class="clip-img" src={`data:image/png;base64,${c.imageBase64}`} />
                <div class="row-main"><div class="row-sub">{c.text} · {fmtTime(c.created_at)}</div></div>
              </Show>
              <button class="icon-btn" title={c.pinned ? 'Unpin' : 'Pin'} onClick={(e) => { e.stopPropagation(); run('clipboard.pin', { id: c.id, pinned: !c.pinned }).then(refetch); }}>{c.pinned ? '★' : '☆'}</button>
              <button class="icon-btn" onClick={(e) => { e.stopPropagation(); run('clipboard.delete', { id: c.id }).then(refetch); }}>×</button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ RSS
export function RssTool() {
  const [feeds, refetchFeeds] = useCommand<any[]>('feeds.list', () => ({}), ['feed.updated']);
  const [feed, setFeed] = createSignal<string | undefined>();
  const [unread, setUnread] = createSignal(true);
  const [items, refetchItems] = useCommand<any[]>('feeds.items', () => ({ feed: feed(), unread: unread(), limit: 200 }), ['feed.updated']);
  const [url, setUrl] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  return (
    <div class="list">
      <div class="list-actions">
        <input placeholder="Feed or site URL" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && run('feeds.add', { url: url() }).then(() => { setUrl(''); refetchFeeds(); }).catch((er) => alert(er.message))} />
        <button disabled={busy()} onClick={() => { setBusy(true); run('feeds.refresh').finally(() => { setBusy(false); refetchItems(); }); }}>{busy() ? 'Refreshing…' : 'Refresh'}</button>
        <label class="toggle"><input type="checkbox" checked={unread()} onChange={(e) => setUnread(e.currentTarget.checked)} /> unread</label>
      </div>
      <div class="chips">
        <button class={'chip' + (!feed() ? ' on' : '')} onClick={() => setFeed(undefined)}>All</button>
        <For each={feeds()}>{(f) => <button class={'chip' + (feed() === f.id ? ' on' : '')} title={f.error ?? f.url} onClick={() => setFeed(f.id)}>{f.title} {f.unread ? `(${f.unread})` : ''}{f.error ? ' ⚠' : ''}</button>}</For>
      </div>
      <Show when={items()?.length} fallback={<Empty>{feeds()?.length ? 'No items.' : 'No feeds yet. Paste a feed or website URL above.'}</Empty>}>
        <div class="list-actions"><button onClick={() => run('feeds.markRead', { feed: feed() }).then(refetchItems)}>Mark all read</button></div>
        <For each={items()}>
          {(it) => (
            <div class={'row link' + (it.read ? '' : ' unread')} onClick={() => run('feeds.openItem', { id: it.id })}>
              <div class="row-main">
                <div class="row-title">{it.title}</div>
                <div class="row-sub">{it.feed_title} · {it.published_at ? fmtTime(it.published_at) : ''} · {it.summary?.slice(0, 140)}</div>
              </div>
              <button class="icon-btn" title={it.saved ? 'Unsave' : 'Save'} onClick={(e) => { e.stopPropagation(); run('feeds.save', { id: it.id, saved: !it.saved }).then(refetchItems); }}>{it.saved ? '★' : '☆'}</button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ Annotations
export function AnnotationsTool() {
  const [all, setAll] = createSignal(false);
  const tabUrl = () => (activeWorkspace()?.activeTab ? state.tabs[activeWorkspace()!.activeTab!]?.url : undefined);
  const [list, refetch] = useCommand<any[]>('annotations.list', () => (all() ? { all: true } : { url: tabUrl() ?? 'about:blank' }), ['annotation.changed']);
  const [backlinks] = useCommand<any[]>('notes.backlinks', () => ({ uri: tabUrl() ?? 'about:blank' }), ['note.saved']);
  return (
    <div class="list">
      <div class="list-actions">
        <label class="toggle"><input type="checkbox" checked={all()} onChange={(e) => setAll(e.currentTarget.checked)} /> all pages</label>
        <button onClick={() => run('annotations.highlight', {}).catch((e) => alert(e.message))}>Highlight selection</button>
        <button onClick={() => run('annotations.sticky', {})}>Sticky note</button>
        <button onClick={() => run('annotations.toNote', {}).catch((e) => alert(e.message))}>Export to note</button>
      </div>
      <Show when={list()?.length} fallback={<Empty>No annotations {all() ? 'yet' : 'on this page'}. Select text and use “Highlight selection”, or right-click the page.</Empty>}>
        <For each={list()}>
          {(a) => (
            <div class="row">
              <div class="row-main">
                <div class="row-title">{a.kind === 'highlight' ? `“${a.quote}”` : a.note || '(empty sticky note)'}</div>
                <div class="row-sub">{a.kind}{a.note && a.kind === 'highlight' ? ` · ${a.note}` : ''} · {hostOf(a.url)} · {fmtTime(a.updated_at)}</div>
              </div>
              <Show when={all()}><button class="icon-btn" onClick={() => run('tabs.open', { url: a.url })}>↗</button></Show>
              <button class="icon-btn" onClick={() => run('annotations.delete', { id: a.id }).then(refetch)}>×</button>
            </div>
          )}
        </For>
      </Show>
      <Show when={!all() && backlinks()?.length}>
        <h3 class="sub">Notes linking here</h3>
        <For each={backlinks()}>{(b) => <div class="row link" onClick={() => run('notes.open', { vault: b.vault, path: b.path })}><div class="row-main"><div class="row-title">{b.path}</div><div class="row-sub">{b.vault} · {b.kind}</div></div></div>}</For>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ Documents
export function DocumentsTool() {
  const [formats] = useCommand<any[]>('convert.formats');
  const [op, setOp] = createSignal('merge');
  const [inputs, setInputs] = createSignal('');
  const [arg, setArg] = createSignal('');
  const [out, setOut] = createSignal('');
  const [result, setResult] = createSignal<any>(null);
  const [err, setErr] = createSignal('');
  const lines = () => inputs().split('\n').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const OPS: Record<string, { label: string; arg?: string; run: () => Promise<any> }> = {
    merge: { label: 'Merge PDFs', run: () => run('pdf.merge', { inputs: lines(), out: out() }) },
    split: { label: 'Split PDF (one file per page)', run: () => run('pdf.split', { path: lines()[0] }) },
    extract: { label: 'Extract pages', arg: 'pages, e.g. 1-3,7', run: () => run('pdf.extract', { path: lines()[0], pages: arg(), out: out() || undefined }) },
    reorder: { label: 'Reorder pages', arg: 'new order, e.g. 3,1,2', run: () => run('pdf.reorder', { path: lines()[0], order: arg(), out: out() || undefined }) },
    rotate: { label: 'Rotate pages', arg: 'degrees (90/180/270)', run: () => run('pdf.rotate', { path: lines()[0], degrees: Number(arg() || 90), out: out() || undefined }) },
    compress: { label: 'Compress PDF', run: () => run('pdf.compress', { path: lines()[0], out: out() || undefined }) },
    info: { label: 'PDF info', run: () => run('pdf.info', { path: lines()[0] }) },
    images: { label: 'Images → PDF', run: () => run('pdf.fromImages', { inputs: lines(), out: out() }) },
    page: { label: 'Current page → PDF', run: () => run('pdf.fromPage', { out: out() || undefined }) },
    convert: { label: 'Convert files', arg: 'target format (webp, png, json, mp3…)', run: () => run('files.convertBatch', { paths: lines(), to: arg() }) },
  };
  return (
    <div class="list documents">
      <div class="list-actions">
        <select value={op()} onChange={(e) => { setOp(e.currentTarget.value); setResult(null); setErr(''); }}>
          <For each={Object.entries(OPS)}>{([k, o]) => <option value={k}>{o.label}</option>}</For>
        </select>
      </div>
      <Show when={op() !== 'page'}>
        <textarea rows={4} placeholder="Input file path(s), one per line (drag files from Explorer here)" value={inputs()} onInput={(e) => setInputs(e.currentTarget.value)}
          onDrop={(e) => { e.preventDefault(); const files = [...(e.dataTransfer?.files ?? [])].map((f) => window.sensor.pathForFile(f)).filter(Boolean); if (files.length) setInputs((inputs() ? inputs() + '\n' : '') + files.join('\n')); }} onDragOver={(e) => e.preventDefault()} />
      </Show>
      <Show when={OPS[op()].arg}><input placeholder={OPS[op()].arg} value={arg()} onInput={(e) => setArg(e.currentTarget.value)} /></Show>
      <Show when={['merge', 'images', 'extract', 'reorder', 'rotate', 'compress', 'page'].includes(op())}><input placeholder="Output path (optional where a default exists)" value={out()} onInput={(e) => setOut(e.currentTarget.value)} /></Show>
      <div class="list-actions"><button onClick={() => { setErr(''); setResult(null); OPS[op()].run().then(setResult).catch((e) => setErr(e.message)); }}>Run</button></div>
      <Show when={err()}><div class="error-text">{err()}</div></Show>
      <Show when={result()}><pre class="result">{JSON.stringify(result(), null, 2)}</pre></Show>
      <h3 class="sub">Available conversions</h3>
      <div class="row-sub pre">{formats()?.map((f) => `${f.from} → ${f.to.join(', ')}  (${f.via})`).join('\n')}</div>
      <div class="muted small-note">Audio/video needs ffmpeg and office formats need pandoc on PATH; they are only listed when found.</div>
    </div>
  );
}

// ------------------------------------------------------------------ Obsidian
export function ObsidianTool() {
  const [status, refetch] = useCommand<any>('obsidian.status', () => ({}), ['obsidian.embedded']);
  const [busy, setBusy] = createSignal(false);
  return (
    <div class="obsidian-panel">
      <Show when={status()?.embedded} fallback={
        <div class="list">
          <p class="muted">Sensor runs your real Obsidian app with your vaults and plugins. On Windows its window is docked into this panel; on other systems it opens alongside.</p>
          <div class="row-sub">Obsidian: {status()?.exe ?? 'not found (set obsidian.exePath in Settings)'}</div>
          <div class="row-sub">{status()?.note}</div>
          <div class="list-actions">
            <button disabled={busy()} onClick={() => { setBusy(true); run('obsidian.launch', {}).then((r) => { if (!r.embedded && r.reason) alert(r.reason); }).finally(() => { setBusy(false); refetch(); }); }}>{busy() ? 'Starting…' : 'Launch Obsidian'}</button>
            <button onClick={() => run('panels.open', { tool: 'notes' })}>Notes quick view</button>
          </div>
          <p class="muted small-note">Install the sensor-bridge plugin (obsidian-plugin/sensor-bridge) to insert tab links and captures at your cursor from Sensor.</p>
        </div>
      }>
        <div class="list-actions"><button onClick={() => run('obsidian.detach').then(refetch)}>Detach window</button></div>
      </Show>
      <div class="view-host native" data-view-tab={status()?.embedded ? 'native:obsidian' : ''} />
    </div>
  );
}
