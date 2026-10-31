import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { run } from '../api';
import { activeWorkspace, onEvent, state, tabsOf } from '../store';

export function StatusBar() {
  const [downloads, setDownloads] = createSignal(0);
  const [agents, setAgents] = createSignal(0);
  const [macros, setMacros] = createSignal(0);
  const [lastMsg, setLastMsg] = createSignal('');
  onMount(() => {
    const active = new Set<string>();
    const runs = new Set<string>();
    const ag = new Set<string>();
    const off = onEvent((e) => {
      if (e.topic === 'download.started') active.add(e.data.id);
      if (/^download\.(completed|cancelled|interrupted)$/.test(e.topic)) active.delete(e.data?.id);
      if (e.topic === 'macro.started') runs.add(e.data.runId);
      if (e.topic === 'macro.completed' || e.topic === 'macro.failed') runs.delete(e.data.runId);
      if (e.topic === 'agent.started') ag.add(e.data.id);
      if (e.topic === 'agent.exited') ag.delete(e.data.id);
      if (e.topic === 'notification.posted') {
        setLastMsg(e.data.title);
        setTimeout(() => setLastMsg(''), 6000);
      }
      setDownloads(active.size);
      setMacros(runs.size);
      setAgents(ag.size);
    });
    onCleanup(off);
  });
  const ws = () => activeWorkspace();
  const perf = () => !!state.snap.settings['perf.mode'];
  return (
    <div class="statusbar">
      <span class="seg strong">{ws()?.name}</span>
      <span class="seg" title="Live / total tabs">
        TABS {state.metrics?.live ?? 0}/{ws() ? tabsOf(ws()!.id).length : 0}
      </span>
      <Show when={downloads() > 0}>
        <span class="seg accent" onClick={() => run('downloads.open')}>↓ {downloads()}</span>
      </Show>
      <Show when={agents() > 0}>
        <span class="seg accent" onClick={() => run('panels.open', { tool: 'agents' })}>AGENTS {agents()}</span>
      </Show>
      <Show when={macros() > 0}>
        <span class="seg accent">MACRO {macros()}</span>
      </Show>
      <Show when={lastMsg()}>
        <span class="seg msg">{lastMsg()}</span>
      </Show>
      <span class="spacer" />
      <span class={'seg click' + (perf() ? ' accent' : '')} title="Performance mode" onClick={() => run('perf.toggle')}>
        PERF {perf() ? 'ON' : 'OFF'}
      </span>
      <span class="seg" title="Sensor CPU (all processes)">CPU {state.metrics ? state.metrics.cpu.toFixed(1) : '–'}%</span>
      <span class="seg click" title="Sensor memory (working set, all processes)" onClick={() => run('panels.open', { tool: 'settings', }).catch(() => {})}>
        RAM {state.metrics?.memMB ?? '–'} MB
      </span>
      <span class="seg" title="Processes">PROC {state.metrics?.processes ?? '–'}</span>
      <span class="seg" title={state.snap.api ? `Local API: ${state.snap.api.path}` : 'Local API off'}>API {state.snap.api ? '●' : '○'}</span>
      <span class={'seg click' + (state.snap.unread ? ' accent' : '')} onClick={() => run('notifications.open')}>
        ◉ {state.snap.unread}
      </span>
    </div>
  );
}
