// Command palette, rendered in a transparent overlay view that sits above
// the web views.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { run, sensor, type CommandInfo } from '../api';
import { state } from '../store';

interface Item {
  key: string;
  title: string;
  sub?: string;
  source: string;
  shortcut?: string;
  act: () => Promise<void> | void;
}

function fuzzy(q: string, text: string): number {
  q = q.toLowerCase();
  text = text.toLowerCase();
  if (!q) return 1;
  const i = text.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 80 - i;
  let ti = 0;
  let gaps = 0;
  for (const c of q) {
    const f = text.indexOf(c, ti);
    if (f < 0) return 0;
    gaps += f - ti;
    ti = f + 1;
  }
  return Math.max(1, 40 - gaps);
}

export function Overlay() {
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<'all' | 'commands' | 'param'>('all');
  const [q, setQ] = createSignal('');
  const [hits, setHits] = createSignal<Item[]>([]);
  const [sel, setSel] = createSignal(0);
  const [error, setError] = createSignal('');
  // parameter prompting
  const [pending, setPending] = createSignal<{ cmd: CommandInfo; args: Record<string, any>; queue: string[] } | null>(null);
  let input!: HTMLInputElement;
  let seq = 0;

  const close = () => {
    setOpen(false);
    setPending(null);
    setQ('');
    setError('');
    sensor.setOverlay(false);
  };

  const runCommand = async (cmd: CommandInfo, args: Record<string, any> = {}) => {
    const missing = Object.entries(cmd.params)
      .filter(([k, p]) => p.required && args[k] === undefined)
      .sort((a, b) => (a[1].positional ?? 99) - (b[1].positional ?? 99))
      .map(([k]) => k);
    if (missing.length) {
      setPending({ cmd, args, queue: missing });
      setMode('param');
      setQ('');
      setSel(0);
      input?.focus();
      return;
    }
    close();
    try {
      await run(cmd.id, args);
    } catch (e: any) {
      run('notifications.push', { title: `${cmd.title} failed`, body: e.message, level: 'error' }).catch(() => {});
    }
  };

  const commandItems = (query: string): Item[] =>
    state.snap.commands
      .filter((c) => c.palette || Object.values(c.params).some((p) => p.required))
      .map((c) => ({ c, s: Math.max(fuzzy(query, c.title), fuzzy(query, c.id) * 0.7) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map(({ c }) => ({
        key: 'cmd:' + c.id,
        title: c.title,
        sub: c.id,
        source: c.category ?? 'command',
        shortcut: state.snap.shortcuts.find((s) => s.command === c.id)?.accelerator,
        act: () => runCommand(c),
      }));

  const paramItems = (): Item[] => {
    const p = pending();
    if (!p) return [];
    const name = p.queue[0];
    const spec = p.cmd.params[name];
    const accept = (value: any) => {
      const args = { ...p.args, [name]: value };
      const queue = p.queue.slice(1);
      if (queue.length) {
        setPending({ ...p, args, queue });
        setQ('');
      } else runCommand(p.cmd, args);
    };
    if (spec.enum) return spec.enum.filter((v) => fuzzy(q(), v) > 0).map((v) => ({ key: v, title: v, source: name, act: () => accept(v) }));
    if (name === 'id' && p.cmd.id.startsWith('workspaces.')) {
      return state.snap.workspaces.filter((w) => fuzzy(q(), w.name) > 0).map((w) => ({ key: w.id, title: w.name, source: 'workspace', act: () => accept(w.id) }));
    }
    return [{ key: 'value', title: q() ? `Use “${q()}”` : `Type a value for ${name}`, sub: spec.description, source: name, act: () => { if (q()) accept(q()); } }];
  };

  const refreshHits = async () => {
    const my = ++seq;
    const text = q();
    if (mode() === 'param') return setHits(paramItems());
    if (mode() === 'commands' || text.startsWith('>')) return setHits(commandItems(text.replace(/^>\s*/, '')));
    if (!text.trim()) {
      // recent tabs + common commands
      const tabs = Object.values(state.tabs)
        .sort((a, b) => b.lastActive - a.lastActive)
        .slice(0, 8)
        .map((t) => ({ key: 'tab:' + t.id, title: t.title || t.url, sub: t.url, source: 'tab', act: () => (close(), run('tabs.activate', { id: t.id })) }));
      return setHits([...tabs, ...commandItems('').slice(0, 12)]);
    }
    try {
      const res = await run<any[]>('search.query', { q: text, limit: 40 });
      if (my !== seq) return;
      const items: Item[] = res.map((h) => ({
        key: h.uri,
        title: h.title,
        sub: h.snippet ?? h.uri,
        source: h.source,
        act: async () => {
          close();
          if (h.uri.startsWith('sensor://command/')) {
            const cmd = state.snap.commands.find((c) => c.id === h.uri.slice('sensor://command/'.length));
            if (cmd) {
              setOpen(true);
              sensor.setOverlay(true);
              return runCommand(cmd);
            }
          }
          await run('resources.open', { uri: h.uri });
        },
      }));
      // Offer "open as URL / search" first
      items.unshift({ key: 'go', title: `Go to “${text}”`, sub: 'open in a new tab', source: 'web', act: () => (close(), run('tabs.open', { url: text })) });
      setHits(items);
    } catch (e: any) {
      setError(e.message);
    }
  };

  createEffect(() => {
    void q();
    void mode();
    void pending();
    setSel(0);
    const t = setTimeout(refreshHits, mode() === 'all' ? 60 : 0);
    onCleanup(() => clearTimeout(t));
  });

  onMount(() => {
    const off = sensor.on('ui', (u) => {
      if (u.action !== 'palette') return;
      setOpen(true);
      setError('');
      setQ('');
      if (u.mode === 'command') {
        const cmd = state.snap.commands.find((c) => c.id === u.command);
        if (cmd) {
          setMode('commands');
          runCommand(cmd, u.args ?? {});
        }
      } else {
        setPending(null);
        setMode(u.mode === 'commands' ? 'commands' : 'all');
      }
      requestAnimationFrame(() => input?.focus());
    });
    const offOv = sensor.on('overlay', (o) => {
      if (!o.open) {
        setOpen(false);
        setPending(null);
      }
    });
    onCleanup(() => {
      off();
      offOv();
    });
  });

  const placeholder = createMemo(() => {
    const p = pending();
    if (p) {
      const name = p.queue[0];
      return `${p.cmd.title} › ${name}${p.cmd.params[name].description ? ` (${p.cmd.params[name].description})` : ''}`;
    }
    return mode() === 'commands' ? 'Run a command…' : 'Search tabs, history, notes, files, commands…  (">" for commands)';
  });

  const onKey = (e: KeyboardEvent) => {
    const list = hits();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(list.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      list[sel()]?.act();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <Show when={open()}>
      <div class="ov-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="palette">
          <input ref={input} value={q()} placeholder={placeholder()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} spellcheck={false} />
          <Show when={error()}>
            <div class="pal-error">{error()}</div>
          </Show>
          <div class="pal-list">
            <For each={hits()}>
              {(h, i) => (
                <div class={'pal-item' + (i() === sel() ? ' sel' : '')} onMouseEnter={() => setSel(i())} onClick={() => h.act()}>
                  <span class="pal-src">{h.source}</span>
                  <span class="pal-title">{h.title}</span>
                  <Show when={h.sub}>
                    <span class="pal-sub">{h.sub}</span>
                  </Show>
                  <Show when={h.shortcut}>
                    <kbd>{h.shortcut!.replace('CmdOrCtrl', 'Ctrl')}</kbd>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
