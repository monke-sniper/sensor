import { onCleanup, onMount, Show, createSignal } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { run, sensor } from '../../api';

export function TerminalTool(props: { leafId: string; state?: { id?: string } }) {
  const [id, setId] = createSignal<string | undefined>(props.state?.id);
  const [exited, setExited] = createSignal<number | null>(null);
  let host!: HTMLDivElement;

  const start = async () => {
    const r = await run<{ id: string }>('terminals.open', { panel: false });
    await run('panels.replace', { id: props.leafId, panel: { kind: 'tool', tool: 'terminal', state: { id: r.id } } });
    setId(r.id);
    attach(r.id);
  };

  let term: Terminal | null = null;
  let offData: (() => void) | null = null;
  let ro: ResizeObserver | null = null;

  const attach = async (tid: string) => {
    term?.dispose();
    term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: '#0b0f14', foreground: '#c9d1d9', cursor: '#4fd1c5', selectionBackground: '#264f78' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const doFit = () => {
      try {
        fit.fit();
        sensor.send('sensor:terminal-resize', { id: tid, cols: term!.cols, rows: term!.rows });
      } catch {
        /* not visible */
      }
    };
    requestAnimationFrame(doFit);
    ro?.disconnect();
    ro = new ResizeObserver(doFit);
    ro.observe(host);
    const buf = await run<any>('terminals.buffer', { id: tid });
    if (!buf) {
      term.write('\x1b[90m[terminal is no longer running]\x1b[0m\r\n');
      setExited(-1);
      return;
    }
    if (buf.buffer) term.write(buf.buffer);
    if (buf.exited) setExited(buf.exitCode);
    term.onData((data) => sensor.send('sensor:terminal-input', { id: tid, data }));
    term.textarea?.addEventListener('focus', () => sensor.send('sensor:focus-context', 'terminal'));
    term.textarea?.addEventListener('blur', () => sensor.send('sensor:focus-context', 'none'));
    offData?.();
    offData = sensor.on('terminal', (p) => {
      if (p.id !== tid) return;
      if (p.data) term!.write(p.data);
      if (p.exit !== undefined) {
        setExited(p.exit);
        term!.write(`\r\n\x1b[90m[process exited with code ${p.exit}]\x1b[0m\r\n`);
      }
    });
  };

  onMount(() => {
    if (id()) attach(id()!);
  });
  onCleanup(() => {
    offData?.();
    ro?.disconnect();
    term?.dispose();
    sensor.send('sensor:focus-context', 'none');
  });

  return (
    <div class="terminal-tool">
      <Show when={id()} fallback={<div class="empty"><button onClick={start}>Start terminal</button></div>}>
        <Show when={exited() !== null}>
          <div class="list-actions"><span class="muted">exited ({exited()})</span><button onClick={start}>Restart</button></div>
        </Show>
      </Show>
      <div class="xterm-host" ref={host} />
    </div>
  );
}
