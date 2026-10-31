import { createMemo, createSignal, For, Show } from 'solid-js';
import { run, type Tab } from '../api';
import { activeWorkspace, state, tabsOf } from '../store';
import { TOOLS } from './tools/index';

export function TabIcon(props: { tab: Tab }) {
  return (
    <span class="favicon">
      <Show when={props.tab.loading} fallback={<Show when={props.tab.favicon} fallback={<span class="dot" />}><img src={props.tab.favicon!} onError={(e) => (e.currentTarget.style.display = 'none')} /></Show>}>
        <span class="spinner" />
      </Show>
    </span>
  );
}

export function Sidebar() {
  const ws = () => activeWorkspace();
  const [dragId, setDragId] = createSignal<string | null>(null);
  const tabs = createMemo(() => (ws() ? tabsOf(ws()!.id) : []));
  const pinnedInPanels = createMemo(() => {
    const set = new Set<string>();
    const walk = (n: any) => {
      if (n.type === 'leaf') {
        if (n.panel.kind === 'web') set.add(n.panel.tabId);
      } else n.children.forEach(walk);
    };
    if (ws()) {
      walk(ws()!.layout.root);
      ws()!.layout.floating.forEach((f) => set.add(f.tabId));
    }
    return set;
  });
  const groups = createMemo(() => {
    const out: { name: string | null; tabs: Tab[] }[] = [];
    const pinned = tabs().filter((t) => t.pinned);
    if (pinned.length) out.push({ name: '★ Pinned', tabs: pinned });
    const byGroup = new Map<string | null, Tab[]>();
    for (const t of tabs().filter((t) => !t.pinned)) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t]);
    for (const [name, list] of byGroup) if (name) out.push({ name, tabs: list });
    if (byGroup.get(null)?.length) out.push({ name: null, tabs: byGroup.get(null)! });
    return out;
  });

  const onDrop = (target: Tab) => {
    const id = dragId();
    setDragId(null);
    if (!id || id === target.id) return;
    run('tabs.move', { id, position: target.position });
  };

  return (
    <aside class="sidebar">
      <div class="ws-strip">
        <For each={state.snap.workspaces}>
          {(w) => (
            <button
              class={'ws-btn' + (w.id === state.snap.activeWorkspace ? ' active' : '')}
              title={w.name}
              onClick={() => run('workspaces.switch', { id: w.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                run('palette.prompt', { command: 'workspaces.rename', args: { id: w.id } });
              }}
            >
              {w.icon || w.name.slice(0, 2).toUpperCase()}
            </button>
          )}
        </For>
        <button class="ws-btn add" title="New workspace" onClick={() => run('palette.prompt', { command: 'workspaces.create' })}>
          +
        </button>
      </div>
      <div class="tabs-head">
        <span>TABS</span>
        <span class="count">{tabs().length}</span>
        <button class="icon-btn" title="New tab (Ctrl+T)" onClick={() => run('tabs.open')}>＋</button>
      </div>
      <div class="tab-list">
        <For each={groups()}>
          {(g) => (
            <>
              <Show when={g.name}>
                <div class="tab-group">{g.name}</div>
              </Show>
              <For each={g.tabs}>
                {(t) => (
                  <div
                    class={
                      'tab-item' +
                      (t.id === ws()?.activeTab ? ' active' : '') +
                      (t.suspended ? ' suspended' : '') +
                      (t.incognito ? ' incognito' : '') +
                      (pinnedInPanels().has(t.id) ? ' in-panel' : '')
                    }
                    draggable={true}
                    onDragStart={() => setDragId(t.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDrop(t)}
                    onClick={() => run('tabs.activate', { id: t.id })}
                    onAuxClick={(e) => e.button === 1 && run('tabs.close', { id: t.id })}
                    title={`${t.title}\n${t.url}`}
                  >
                    <TabIcon tab={t} />
                    <span class="tab-title">{t.title || t.url}</span>
                    <Show when={t.audible}>
                      <span class="badge">♪</span>
                    </Show>
                    <Show when={t.incognito}>
                      <span class="badge inc">INC</span>
                    </Show>
                    <Show when={pinnedInPanels().has(t.id)}>
                      <span class="badge">PNL</span>
                    </Show>
                    <button
                      class="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        run('tabs.close', { id: t.id });
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
            </>
          )}
        </For>
      </div>
      <div class="tools-head">TOOLS</div>
      <div class="tool-grid">
        <For each={Object.entries(TOOLS).filter(([, t]) => t.sidebar !== false)}>
          {([id, t]) => (
            <button class="tool-btn" title={t.title} onClick={() => run('panels.open', { tool: id })}>
              <span class="glyph">{t.glyph}</span>
              <span>{t.short ?? t.title}</span>
            </button>
          )}
        </For>
      </div>
    </aside>
  );
}
