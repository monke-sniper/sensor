import { createEffect, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { hostOf, run, type LayoutNode, type Panel } from '../api';
import { activeWorkspace, onEvent, state } from '../store';
import { requestRects } from '../views';
import { TabIcon } from './Sidebar';
import { TOOLS } from './tools/index';

export function LayoutView(props: { node: LayoutNode }) {
  return (
    <Switch>
      <Match when={props.node.type === 'leaf' && props.node}>{(leaf) => <Leaf id={leaf().id} panel={(leaf() as any).panel} />}</Match>
      <Match when={props.node.type === 'split' && props.node}>{(split) => <Split node={split() as any} />}</Match>
    </Switch>
  );
}

function Split(props: { node: Extract<LayoutNode, { type: 'split' }> }) {
  const [sizes, setSizes] = createSignal<number[]>(props.node.sizes);
  createEffect(() => setSizes(props.node.sizes));
  let el!: HTMLDivElement;
  const startDrag = (i: number, e: MouseEvent) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const total = props.node.dir === 'row' ? rect.width : rect.height;
    const start = props.node.dir === 'row' ? e.clientX : e.clientY;
    const init = [...sizes()];
    document.body.classList.add(props.node.dir === 'row' ? 'dragging-col' : 'dragging-row');
    const move = (ev: MouseEvent) => {
      const delta = ((props.node.dir === 'row' ? ev.clientX : ev.clientY) - start) / total;
      const s = [...init];
      const min = 0.08;
      const a = Math.max(min, Math.min(init[i] + init[i + 1] - min, init[i] + delta));
      s[i + 1] = init[i] + init[i + 1] - a;
      s[i] = a;
      setSizes(s);
      requestRects();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging-col', 'dragging-row');
      run('panels.resize', { id: props.node.id, sizes: sizes() });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  return (
    <div class={`split dir-${props.node.dir}`} ref={el}>
      <Index each={props.node.children}>
        {(child, i) => (
          <>
            <Show when={i > 0}>
              <div class="divider" onMouseDown={(e) => startDrag(i - 1, e)} />
            </Show>
            <div class="split-child" style={{ 'flex-grow': sizes()[i] ?? 1, 'flex-basis': 0 }}>
              <LayoutView node={child()} />
            </div>
          </>
        )}
      </Index>
    </div>
  );
}

function Leaf(props: { id: string; panel: Panel }) {
  return (
    <Switch>
      <Match when={props.panel.kind === 'browser'}>
        <BrowserLeaf leafId={props.id} />
      </Match>
      <Match when={props.panel.kind === 'web' && (props.panel as any).tabId}>{(tabId) => <WebLeaf leafId={props.id} tabId={tabId()} />}</Match>
      <Match when={props.panel.kind === 'tool' && (props.panel as any)}>{(p) => <ToolLeaf leafId={props.id} tool={p().tool} state={p().state} />}</Match>
    </Switch>
  );
}

function PanelHeader(props: { leafId: string; title: string; children?: any }) {
  return (
    <div class="panel-head">
      <span class="panel-title">{props.title}</span>
      <span class="spacer" />
      {props.children}
      <Show when={activeWorkspace()?.layout.root.id !== props.leafId}>
        <button class="icon-btn" title="Close panel" onClick={() => run('panels.close', { id: props.leafId })}>
          ×
        </button>
      </Show>
    </div>
  );
}

function ToolLeaf(props: { leafId: string; tool: string; state?: any }) {
  const def = () => TOOLS[props.tool];
  return (
    <div class="panel tool-panel">
      <PanelHeader leafId={props.leafId} title={def()?.title ?? props.tool} />
      <div class="panel-body">
        <Show when={def()} fallback={<div class="empty">The “{props.tool}” tool is not implemented yet.</div>}>
          <Dynamic component={def()!.component} leafId={props.leafId} state={props.state} />
        </Show>
      </div>
    </div>
  );
}

function WebLeaf(props: { leafId: string; tabId: string }) {
  const tab = () => state.tabs[props.tabId];
  return (
    <div class="panel web-panel">
      <PanelHeader leafId={props.leafId} title={tab()?.title || hostOf(tab()?.url ?? '')}>
        <button class="icon-btn" title="Back" disabled={!tab()?.canGoBack} onClick={() => run('tabs.back', { id: props.tabId })}>‹</button>
        <button class="icon-btn" title="Reload" onClick={() => run('tabs.reload', { id: props.tabId })}>↻</button>
        <button class="icon-btn" title="Float" onClick={() => run('panels.float', { id: props.tabId }).then(() => run('panels.close', { id: props.leafId }).catch(() => {}))}>⧉</button>
        <button
          class="icon-btn"
          title="Move to main browser"
          onClick={async () => {
            await run('panels.close', { id: props.leafId }).catch(() => {});
            await run('tabs.activate', { id: props.tabId });
          }}
        >
          ⇱
        </button>
      </PanelHeader>
      <div class="view-host" data-view-tab={props.tabId} />
    </div>
  );
}

function BrowserLeaf(props: { leafId: string }) {
  const ws = () => activeWorkspace();
  const tab = () => (ws()?.activeTab ? state.tabs[ws()!.activeTab!] : undefined);
  const [addr, setAddr] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [findOpen, setFindOpen] = createSignal(false);
  const [findText, setFindText] = createSignal('');
  const [findResult, setFindResult] = createSignal('');
  let input!: HTMLInputElement;
  let findInput!: HTMLInputElement;

  createEffect(() => {
    if (!editing()) setAddr(tab()?.url === 'sensor://newtab' ? '' : tab()?.url ?? '');
  });

  onMount(() => {
    const off = window.sensor.on('ui', (u) => {
      if (u.action === 'focusAddress') {
        input.focus();
        input.select();
      }
      if (u.action === 'find') {
        setFindOpen(true);
        requestAnimationFrame(() => {
          findInput.focus();
          findInput.select();
          requestRects();
        });
      }
    });
    const off2 = onEvent((e) => {
      if (e.topic === 'page.found' && e.data.finalUpdate) setFindResult(`${e.data.activeMatchOrdinal}/${e.data.matches}`);
    });
    onCleanup(() => {
      off();
      off2();
    });
  });

  const go = () => {
    const v = addr().trim();
    if (!v) return;
    if (tab()) run('tabs.navigate', { url: v, id: tab()!.id });
    else run('tabs.open', { url: v });
    setEditing(false);
    input.blur();
  };

  const recognized = () => (tab() ? state.recognized[tab()!.id] : undefined);
  const bookmarked = () => false;

  return (
    <div class="panel browser-panel">
      <div class="toolbar">
        <button class="icon-btn" title="Back (Alt+Left)" disabled={!tab()?.canGoBack} onClick={() => run('tabs.back')}>‹</button>
        <button class="icon-btn" title="Forward (Alt+Right)" disabled={!tab()?.canGoForward} onClick={() => run('tabs.forward')}>›</button>
        <Show when={tab()?.loading} fallback={<button class="icon-btn" title="Reload (Ctrl+R)" onClick={() => run('tabs.reload')}>↻</button>}>
          <button class="icon-btn" title="Stop" onClick={() => run('tabs.stop')}>✕</button>
        </Show>
        <div class={'address' + (tab()?.incognito ? ' incognito' : '')}>
          <Show when={tab()}>
            <TabIcon tab={tab()!} />
          </Show>
          <input
            ref={input}
            value={addr()}
            placeholder="Search or enter address"
            spellcheck={false}
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onInput={(e) => setAddr(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go();
              if (e.key === 'Escape') {
                setEditing(false);
                setAddr(tab()?.url ?? '');
                input.blur();
              }
            }}
          />
          <Show when={tab()?.incognito}>
            <span class="badge inc">INCOGNITO</span>
          </Show>
        </div>
        <Show when={recognized()}>
          <div class="context-actions">
            <span class="kind">{recognized()!.label}</span>
            <For each={recognized()!.actions}>
              {(a) => (
                <button class="chip" title={a.command} onClick={() => run(a.command, a.args)}>
                  {a.title}
                </button>
              )}
            </For>
          </div>
        </Show>
        <button class="icon-btn" title="Bookmark (Ctrl+D)" classList={{ on: bookmarked() }} onClick={() => run('bookmarks.add')}>☆</button>
        <button class="icon-btn" title="Open as panel" onClick={() => run('panels.promote')}>◫</button>
        <button class="icon-btn" title="Float" onClick={() => run('panels.float')}>⧉</button>
        <button class="icon-btn" title="Developer tools (F12)" onClick={() => run('tabs.devtools')}>{'</>'}</button>
      </div>
      <Show when={findOpen()}>
        <div class="findbar">
          <input
            ref={findInput}
            placeholder="Find in page"
            value={findText()}
            onInput={(e) => {
              setFindText(e.currentTarget.value);
              run('page.findText', { text: e.currentTarget.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run('page.findText', { text: findText(), forward: !e.shiftKey });
              if (e.key === 'Escape') {
                setFindOpen(false);
                run('page.findText', { text: '' });
                requestAnimationFrame(requestRects);
              }
            }}
          />
          <span class="muted">{findResult()}</span>
          <button
            class="icon-btn"
            onClick={() => {
              setFindOpen(false);
              run('page.findText', { text: '' });
              requestAnimationFrame(requestRects);
            }}
          >
            ×
          </button>
        </div>
      </Show>
      <Show when={tab()} fallback={<div class="empty">No tab. Press <kbd>Ctrl T</kbd> to open one.</div>}>
        <div class="view-host" data-view-tab={tab()!.id} />
      </Show>
    </div>
  );
}
