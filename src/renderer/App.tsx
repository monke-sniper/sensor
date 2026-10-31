import { createEffect, onMount, Show } from 'solid-js';
import { Sidebar } from './components/Sidebar';
import { LayoutView } from './components/LayoutView';
import { StatusBar } from './components/StatusBar';
import { activeWorkspace, state } from './store';
import { forceRects, watchLayout } from './views';

export function App() {
  let main!: HTMLDivElement;
  onMount(() => watchLayout(document.body));
  createEffect(() => {
    // re-place views whenever the active workspace, its layout or active tab changes
    const w = activeWorkspace();
    void w?.activeTab;
    void JSON.stringify(w?.layout);
    queueMicrotask(forceRects);
  });
  createEffect(() => {
    const css = state.snap.settings['theme.customCss'];
    let el = document.getElementById('user-css');
    if (!el) {
      el = document.createElement('style');
      el.id = 'user-css';
      document.head.appendChild(el);
    }
    el.textContent = typeof css === 'string' ? css : '';
  });
  return (
    <div class="app">
      <div class="titlebar">
        <span class="brand">SENSOR</span>
        <span class="ws-name">{activeWorkspace()?.name}</span>
        <button class="title-search" onClick={() => window.sensor.run('palette.open')}>
          Search or run a command… <kbd>Ctrl K</kbd>
        </button>
      </div>
      <div class="body">
        <Show when={activeWorkspace()?.layout.sidebar.visible !== false}>
          <Sidebar />
        </Show>
        <div class="main" ref={main}>
          <Show when={state.ready && activeWorkspace()} fallback={<div class="empty">Loading…</div>}>
            <LayoutView node={activeWorkspace()!.layout.root} />
          </Show>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
