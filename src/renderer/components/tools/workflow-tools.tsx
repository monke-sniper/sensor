// Panels for macros & triggers, projects & agents, AI website workflows and checkpoints.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { fmtBytes, fmtTime, run } from '../../api';
import { onEvent } from '../../store';
import { Empty, useCommand } from './common';

const errText = (e: any) => String(e?.message ?? e);

// ------------------------------------------------------------------ macros

const STEP_TEMPLATES: Record<string, any> = {
  open: { op: 'open', url: 'https://' },
  navigate: { op: 'navigate', url: 'https://' },
  click: { op: 'click', selectors: ['text=Button text'] },
  type: { op: 'type', selectors: ['input[name=q]'], text: '{{query}}', clear: true },
  select: { op: 'select', selectors: ['select'], value: '' },
  press: { op: 'press', key: 'Enter' },
  waitFor: { op: 'waitFor', selectors: ['.result'] },
  wait: { op: 'wait', ms: 1000 },
  extract: { op: 'extract', selectors: ['h1'], save: 'title' },
  read: { op: 'read', format: 'markdown', save: 'page' },
  upload: { op: 'upload', files: ['C:\\path\\file.pdf'] },
  screenshot: { op: 'screenshot', path: '' },
  command: { op: 'command', command: 'notes.create', args: { title: '{{title}}', body: '{{page.content}}' } },
  set: { op: 'set', var: 'x', value: '' },
  input: { op: 'input', var: 'query', prompt: 'Search for?' },
  if: { op: 'if', cond: 'x == "y"', then: [], else: [] },
  loop: { op: 'loop', over: '{{items}}', as: 'item', steps: [] },
  call: { op: 'call', macro: '', args: {} },
  output: { op: 'output', name: 'result', value: '{{last}}' },
  checkpoint: { op: 'checkpoint' },
  log: { op: 'log', message: '' },
  notify: { op: 'notify', title: 'Done', body: '' },
  assert: { op: 'assert', cond: '', message: '' },
  fail: { op: 'fail', message: '' },
  break: { op: 'break' },
  stop: { op: 'stop' },
};

function stepSummary(s: any): string {
  const sel = s.selectors?.[0] ?? s.selector;
  switch (s.op) {
    case 'open':
    case 'navigate':
      return s.url;
    case 'click':
      return s.desc ? `"${s.desc}"` : sel;
    case 'type':
      return `${sel} ← ${String(s.text ?? '').slice(0, 40)}`;
    case 'press':
      return s.key;
    case 'wait':
      return `${s.ms} ms`;
    case 'command':
      return s.command;
    case 'set':
      return `${s.var} = ${JSON.stringify(s.value ?? s.expr)}`;
    case 'if':
      return `${s.cond} (${s.then?.length ?? 0} / ${s.else?.length ?? 0} steps)`;
    case 'loop':
      return `${s.over ?? s.times ?? s.while} → ${s.as ?? 'item'} (${s.steps?.length ?? 0} steps)`;
    case 'output':
      return `${s.name} = ${s.value}`;
    default:
      return sel ?? s.message ?? s.macro ?? s.var ?? '';
  }
}

export function MacrosTool(props: { state?: { id?: string } }) {
  const [list, refetch] = useCommand<any[]>('macros.list', () => ({}), ['macro.saved', 'macro.deleted']);
  const [rec, refetchRec] = useCommand<any>('macros.recordStatus', () => ({}), ['macro.recording', 'macro.recordedStep']);
  const [sel, setSel] = createSignal<string | undefined>(props.state?.id);
  const [waiting, setWaiting] = createSignal<any[]>([]);
  const off = onEvent((e) => {
    if (e.topic === 'macro.waiting') setWaiting((w) => [...w.filter((x) => x.run !== e.data.run), e.data]);
    if (['macro.completed', 'macro.failed', 'macro.cancelled'].includes(e.topic)) setWaiting((w) => w.filter((x) => x.run !== e.data.id));
  });
  onCleanup(off);
  const stop = async () => {
    const name = prompt('Save recorded macro as:', `Recorded ${new Date().toLocaleString()}`);
    if (name === null) return;
    const m = await run<any>('macros.stopRecording', { name: name || undefined });
    refetchRec();
    refetch();
    setSel(m.id);
  };
  const create = async () => {
    const name = prompt('New macro name:');
    if (!name) return;
    const m = await run<any>('macros.save', { definition: { name, steps: [] } }).catch((e) => alert(errText(e)));
    if (m) setSel(m.id);
  };
  const importOne = async () => {
    const path = prompt('Import macro from JSON file path:');
    if (!path) return;
    const m = await run<any>('macros.import', { path }).catch((e) => alert(errText(e)));
    if (m) setSel(m.id);
  };
  return (
    <div class="list macros">
      <For each={waiting()}>
        {(w) => <PromptBanner w={w} onDone={() => setWaiting((l) => l.filter((x) => x.run !== w.run))} />}
      </For>
      <div class="list-actions">
        <Show when={rec()?.recording} fallback={<button onClick={() => run('macros.record').then(refetchRec)}>● Record</button>}>
          <button class="danger" onClick={stop}>■ Stop ({rec()?.steps?.length ?? 0} steps)</button>
        </Show>
        <button onClick={create}>New</button>
        <button onClick={importOne}>Import</button>
        <button onClick={() => run('macros.cancelAll')}>Stop all runs</button>
      </div>
      <Show when={rec()?.recording}>
        <div class="row-sub pre">{(rec()?.steps ?? []).map((s: any, i: number) => `${i + 1}. ${s.op} ${stepSummary(s)}`).join('\n')}</div>
      </Show>
      <Show when={!sel()} fallback={<MacroEditor id={sel()!} onBack={() => { setSel(undefined); refetch(); }} />}>
        <Show when={list()?.length} fallback={<Empty>No macros yet. Record one, or create it step by step.</Empty>}>
          <For each={list()}>
            {(m) => (
              <div class="row link" onClick={() => setSel(m.id)}>
                <div class="row-main">
                  <div class="row-title">{m.name}</div>
                  <div class="row-sub">{m.steps} steps{m.triggers ? ` · ${m.triggers} trigger(s)` : ''} · {m.scopes.join(', ') || 'no permissions'}</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); run('macros.run', { id: m.id }).catch((er) => alert(errText(er))); }}>Run</button>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function PromptBanner(props: { w: any; onDone: () => void }) {
  const [v, setV] = createSignal('');
  const send = () => run('macros.answer', { run: props.w.run, value: v() }).then(props.onDone);
  return (
    <div class="row selected">
      <div class="row-main">
        <div class="row-title">{props.w.macro}: {props.w.prompt}</div>
        <input type={props.w.secret ? 'password' : 'text'} value={v()} onInput={(e) => setV(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
      </div>
      <button onClick={send}>OK</button>
      <button onClick={() => run('macros.cancel', { run: props.w.run }).then(props.onDone)}>Cancel</button>
    </div>
  );
}

function MacroEditor(props: { id: string; onBack: () => void }) {
  const [m, refetch] = useCommand<any>('macros.get', () => ({ id: props.id }), ['macro.saved']);
  const [runs] = useCommand<any[]>('macros.runs', () => ({ macro: props.id, limit: 15 }), ['macro.completed', 'macro.failed', 'macro.cancelled', 'macro.started']);
  const [triggers, refetchTriggers] = useCommand<any[]>('triggers.list', () => ({ macro: props.id }), []);
  const [def, setDef] = createSignal<any>(null);
  const [editing, setEditing] = createSignal<number | null>(null);
  const [stepText, setStepText] = createSignal('');
  const [raw, setRaw] = createSignal(false);
  const [rawText, setRawText] = createSignal('');
  const [inputs, setInputs] = createSignal<Record<string, string>>({});
  const [err, setErr] = createSignal('');
  const [dirty, setDirty] = createSignal(false);
  const [openRun, setOpenRun] = createSignal<string | null>(null);
  createEffect(() => {
    const d = m()?.definition;
    if (d && !dirty()) setDef(structuredClone(d));
  });
  const update = (fn: (d: any) => void) => {
    const d = structuredClone(def());
    fn(d);
    setDef(d);
    setDirty(true);
  };
  const save = async () => {
    setErr('');
    try {
      const d = raw() ? JSON.parse(rawText()) : def();
      await run('macros.save', { id: props.id, definition: d });
      setDirty(false);
      setRaw(false);
      refetch();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const runIt = async () => {
    setErr('');
    if (dirty()) await save();
    const vals: Record<string, any> = {};
    for (const [k, v] of Object.entries(inputs())) if (v !== '') vals[k] = v;
    run('macros.run', { id: props.id, inputs: vals }).catch((e) => setErr(errText(e)));
  };
  const addTrigger = async () => {
    const kind = prompt('Trigger kind: schedule, event, file or startup', 'schedule');
    if (!kind) return;
    const example: Record<string, string> = { schedule: '{"every": 60}', event: '{"topic": "download.completed", "where": "event.path endsWith \\".pdf\\""}', file: '{"dir": "C:\\\\Users\\\\me\\\\Downloads", "pattern": "*.pdf"}', startup: '{}' };
    const cfg = prompt('Config (JSON):', example[kind] ?? '{}');
    if (cfg === null) return;
    try {
      await run('triggers.add', { macro: props.id, kind, config: JSON.parse(cfg) });
      refetchTriggers();
    } catch (e) {
      alert(errText(e));
    }
  };
  const inputNames = createMemo(() => Object.keys(def()?.inputs ?? {}));
  return (
    <Show when={def()} fallback={<Empty>Loading…</Empty>}>
      <div class="list-actions">
        <button onClick={props.onBack}>‹ All macros</button>
        <span class="spacer" />
        <button onClick={runIt}>▶ Run</button>
        <button disabled={!dirty() && !raw()} onClick={save}>Save</button>
        <button onClick={() => { setRaw(!raw()); setRawText(JSON.stringify(def(), null, 2)); }}>{raw() ? 'Steps' : 'JSON'}</button>
        <button onClick={() => run('macros.duplicate', { id: props.id })}>Duplicate</button>
        <button onClick={() => { const p = prompt('Export to file path (empty = copy JSON to clipboard):', ''); if (p === null) return; (p ? run('macros.export', { id: props.id, path: p }) : run('macros.export', { id: props.id }).then((d) => navigator.clipboard.writeText(JSON.stringify(d, null, 2)))).catch((e) => alert(errText(e))); }}>Export</button>
        <button class="danger" onClick={() => confirm(`Delete macro "${def().name}"?`) && run('macros.delete', { id: props.id }).then(props.onBack)}>Delete</button>
      </div>
      <Show when={err()}><div class="error-text">{err()}</div></Show>
      <input class="filter" value={def().name} onInput={(e) => update((d) => (d.name = e.currentTarget.value))} />
      <input class="filter" placeholder="Description" value={def().description ?? ''} onInput={(e) => update((d) => (d.description = e.currentTarget.value))} />
      <div class="row-sub">Permissions: {(m()?.scopes ?? []).join(', ') || 'none'} <span class="muted">(inferred from steps; a macro never gets more than whoever runs it)</span></div>
      <Show when={inputNames().length}>
        <h3 class="sub">Inputs</h3>
        <For each={inputNames()}>
          {(k) => (
            <input class="filter" type={def().inputs[k].secret ? 'password' : 'text'} placeholder={`${k}${def().inputs[k].default !== undefined ? ` (default ${def().inputs[k].default})` : ''}`} value={inputs()[k] ?? ''} onInput={(e) => setInputs({ ...inputs(), [k]: e.currentTarget.value })} />
          )}
        </For>
      </Show>
      <Show when={!raw()} fallback={<textarea class="note-edit" value={rawText()} onInput={(e) => setRawText(e.currentTarget.value)} />}>
        <h3 class="sub">Steps</h3>
        <For each={def().steps}>
          {(s: any, i) => (
            <Show when={editing() === i()} fallback={
              <div class="row link" onClick={() => { setEditing(i()); setStepText(JSON.stringify(s, null, 2)); }}>
                <div class="row-main">
                  <div class="row-title">{i() + 1}. {s.op}{s.label ? ` [${s.label}]` : ''}</div>
                  <div class="row-sub ellipsis">{stepSummary(s)}</div>
                </div>
                <button class="icon-btn" title="Move up" disabled={i() === 0} onClick={(e) => { e.stopPropagation(); update((d) => d.steps.splice(i() - 1, 0, d.steps.splice(i(), 1)[0])); }}>↑</button>
                <button class="icon-btn" title="Move down" onClick={(e) => { e.stopPropagation(); update((d) => i() < d.steps.length - 1 && d.steps.splice(i() + 1, 0, d.steps.splice(i(), 1)[0])); }}>↓</button>
                <button class="icon-btn" title="Remove" onClick={(e) => { e.stopPropagation(); update((d) => d.steps.splice(i(), 1)); }}>×</button>
              </div>
            }>
              <div class="row selected">
                <div class="row-main">
                  <textarea rows={8} style={{ width: '100%' }} value={stepText()} onInput={(e) => setStepText(e.currentTarget.value)} />
                  <div class="list-actions">
                    <button onClick={() => { try { const v = JSON.parse(stepText()); update((d) => (d.steps[i()] = v)); setEditing(null); } catch (e) { alert(errText(e)); } }}>Apply</button>
                    <button onClick={() => setEditing(null)}>Close</button>
                    <span class="muted small-note">Common fields: label, when, retry, retryDelay, onError (stop | continue | goto:label), timeout, save</span>
                  </div>
                </div>
              </div>
            </Show>
          )}
        </For>
        <div class="list-actions">
          <select onChange={(e) => { const op = e.currentTarget.value; if (op) update((d) => d.steps.push(structuredClone(STEP_TEMPLATES[op]))); e.currentTarget.value = ''; }}>
            <option value="">+ Add step…</option>
            <For each={Object.keys(STEP_TEMPLATES)}>{(op) => <option value={op}>{op}</option>}</For>
          </select>
        </div>
      </Show>
      <h3 class="sub">Triggers</h3>
      <For each={triggers()}>
        {(t) => (
          <div class="row">
            <div class="row-main">
              <div class="row-title">{t.kind}{t.enabled ? '' : ' (off)'}</div>
              <div class="row-sub ellipsis">{JSON.stringify(t.config)}{t.last_fired ? ` · last ${fmtTime(t.last_fired)}` : ''}</div>
            </div>
            <button onClick={() => run('triggers.enable', { id: t.id, enabled: !t.enabled }).then(refetchTriggers)}>{t.enabled ? 'Disable' : 'Enable'}</button>
            <button class="icon-btn" onClick={() => run('triggers.remove', { id: t.id }).then(refetchTriggers)}>×</button>
          </div>
        )}
      </For>
      <div class="list-actions"><button onClick={addTrigger}>+ Add trigger</button></div>
      <h3 class="sub">Recent runs</h3>
      <For each={runs()}>
        {(r) => (
          <div class="row link" onClick={() => setOpenRun(openRun() === r.id ? null : r.id)}>
            <div class="row-main">
              <div class="row-title">{r.state}{r.trigger ? ' · trigger' : ''} · {fmtTime(r.startedAt)}</div>
              <Show when={r.error}><div class="row-sub error-text">{r.error}</div></Show>
              <Show when={Object.keys(r.outputs ?? {}).length}><div class="row-sub ellipsis">{JSON.stringify(r.outputs)}</div></Show>
              <Show when={openRun() === r.id}>
                <pre class="result">{(r.log ?? []).map((l: any) => `${l.path.padEnd(6)} ${l.op.padEnd(9)} ${l.status}${l.ms !== undefined ? ` ${l.ms}ms` : ''}${l.message ? `  ${l.message}` : ''}`).join('\n')}</pre>
              </Show>
            </div>
            <Show when={r.state === 'failed'}>
              <button onClick={(e) => { e.stopPropagation(); run('macros.resume', { run: r.id }).catch((er) => alert(errText(er))); }}>Resume</button>
            </Show>
            <Show when={r.state === 'running' || r.state === 'waiting'}>
              <button onClick={(e) => { e.stopPropagation(); run('macros.cancel', { run: r.id }); }}>Stop</button>
            </Show>
          </div>
        )}
      </For>
    </Show>
  );
}

// ------------------------------------------------------------------ projects & agents

export function ProjectsTool(props: { state?: { project?: string } }) {
  const [projects, refetch] = useCommand<any[]>('projects.list', () => ({}), ['project.added']);
  const [sel, setSel] = createSignal<string | undefined>(props.state?.project);
  const [path, setPath] = createSignal('');
  const [err, setErr] = createSignal('');
  const add = () =>
    run<any>('projects.add', { path: path() })
      .then((p) => { setPath(''); refetch(); setSel(p.id); })
      .catch((e) => setErr(errText(e)));
  return (
    <div class="list projects">
      <Show when={!sel()} fallback={<ProjectView id={sel()!} onBack={() => setSel(undefined)} />}>
        <div class="list-actions">
          <input class="filter" placeholder="Path to a git repository" value={path()} onInput={(e) => setPath(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && add()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) setPath(window.sensor.pathForFile(f)); }} onDragOver={(e) => e.preventDefault()} />
          <button onClick={add}>Add</button>
        </div>
        <Show when={err()}><div class="error-text">{err()}</div></Show>
        <Show when={projects()?.length} fallback={<Empty>No projects. Add a git repository to manage worktrees, tasks and agents.</Empty>}>
          <For each={projects()}>
            {(p) => (
              <div class="row link" onClick={() => setSel(p.id)}>
                <div class="row-main">
                  <div class="row-title">{p.name}</div>
                  <div class="row-sub ellipsis">{p.path}</div>
                </div>
              </div>
            )}
          </For>
        </Show>
        <AgentsSection />
      </Show>
    </div>
  );
}

function AgentPicker(props: { value: string; onChange: (v: string) => void }) {
  const [agents] = useCommand<any[]>('agents.available');
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
      <For each={agents()}>{(a) => <option value={a.id} disabled={!a.installed}>{a.name}{a.installed ? '' : ' (not installed)'}</option>}</For>
    </select>
  );
}

function ProjectView(props: { id: string; onBack: () => void }) {
  const [o, refetch] = useCommand<any>('projects.overview', () => ({ id: props.id }), ['task.changed', 'task.deleted', 'worktree.created', 'worktree.removed', 'git.committed', 'git.merged', 'agent.started', 'agent.exited']);
  const [agent, setAgent] = createSignal('claude');
  const [title, setTitle] = createSignal('');
  const [validate, setValidate] = createSignal('');
  const [decision, setDecision] = createSignal('');
  const [diff, setDiff] = createSignal<string | null>(null);
  const [err, setErr] = createSignal('');
  const act = (p: Promise<any>) => p.then(refetch).catch((e) => setErr(errText(e)));
  const showDiff = (path: string) => run<any>('git.diff', { path }).then((r) => setDiff(r.diff || '(no changes)')).catch((e) => setErr(errText(e)));
  const newWorktree = () => {
    const branch = prompt('Branch name for the new worktree:');
    if (branch) act(run('git.worktreeAdd', { project: props.id, branch }));
  };
  return (
    <Show when={o()} fallback={<Empty>Loading…</Empty>}>
      <div class="list-actions">
        <button onClick={props.onBack}>‹ Projects</button>
        <span class="spacer" />
        <AgentPicker value={agent()} onChange={setAgent} />
        <button onClick={() => act(run('agents.start', { agent: agent(), project: props.id }))}>Start agent</button>
        <button onClick={() => act(run('terminals.open', { cwd: o().project.path }))}>Terminal</button>
      </div>
      <Show when={err()}><div class="error-text" onClick={() => setErr('')}>{err()}</div></Show>
      <div class="row-title">{o().project.name}</div>
      <div class="row-sub ellipsis">{o().project.path} · protected: {o().project.protected.join(', ')}</div>

      <h3 class="sub">Worktrees</h3>
      <For each={o().worktrees}>
        {(w: any) => (
          <div class="row">
            <div class="row-main">
              <div class="row-title">{w.branch ?? '(detached)'} {w.protected ? <span class="badge">protected</span> : null} {w.main ? <span class="badge">main</span> : null}</div>
              <div class="row-sub ellipsis">{w.path}{w.status ? ` · ${w.status.files.filter((f: any) => f.kind !== 'ignored').length} changed${w.status.ahead ? ` · ↑${w.status.ahead}` : ''}${w.status.behind ? ` · ↓${w.status.behind}` : ''}` : ''}</div>
            </div>
            <button onClick={() => showDiff(w.path)}>Diff</button>
            <button onClick={() => act(run('agents.start', { agent: agent(), path: w.path }))}>Agent</button>
            <button onClick={() => act(run('terminals.open', { cwd: w.path }))}>›_</button>
            <Show when={!w.main && !w.protected}>
              <button onClick={() => confirm(`Merge ${w.branch} into ${o().worktrees.find((x: any) => x.main)?.branch}?`) && act(run('git.merge', { project: props.id, branch: w.branch }))}>Merge</button>
              <button class="icon-btn" title="Remove worktree" onClick={() => confirm(`Remove worktree ${w.path}?`) && act(run('git.worktreeRemove', { project: props.id, path: w.path }))}>×</button>
            </Show>
          </div>
        )}
      </For>
      <div class="list-actions"><button onClick={newWorktree}>+ Worktree</button><button onClick={() => act(run('orca.addProject', { project: props.id }))}>Add to Orca</button></div>
      <Show when={diff() !== null}>
        <div class="list-actions"><button onClick={() => setDiff(null)}>Close diff</button></div>
        <pre class="result diff">{diff()}</pre>
      </Show>

      <h3 class="sub">Tasks</h3>
      <div class="list-actions">
        <input class="filter" placeholder="New task title" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
        <input class="filter" placeholder="Done when (command, e.g. npm test)" value={validate()} onInput={(e) => setValidate(e.currentTarget.value)} />
        <button disabled={!title()} onClick={() => act(run('tasks.create', { project: props.id, title: title(), validate: validate() || undefined }).then(() => { setTitle(''); setValidate(''); }))}>Add</button>
      </div>
      <For each={o().tasks}>
        {(t: any) => (
          <div class="row">
            <div class="row-main">
              <div class="row-title">{t.title} <span class="badge">{t.state}</span></div>
              <div class="row-sub ellipsis">{[t.agent, t.branch, t.validation?.last ? (t.validation.last.passed ? 'validation passed' : 'validation failed') : null].filter(Boolean).join(' · ')}</div>
            </div>
            <Show when={t.state === 'todo'}><button onClick={() => act(run('tasks.start', { id: t.id, agent: agent() }))}>Start</button></Show>
            <Show when={t.validation?.command && t.state !== 'done'}><button onClick={() => act(run('tasks.validate', { id: t.id }))}>Validate</button></Show>
            <Show when={t.state === 'review' || t.state === 'in_progress'}>
              <button onClick={() => act(run('tasks.complete', { id: t.id, merge: !!t.branch }))}>{t.branch ? 'Merge & done' : 'Done'}</button>
            </Show>
            <button class="icon-btn" onClick={() => confirm('Delete task?') && act(run('tasks.delete', { id: t.id }))}>×</button>
          </div>
        )}
      </For>

      <h3 class="sub">Running agents</h3>
      <For each={o().agents.filter((s: any) => s.exitedAt === null)} fallback={<div class="muted small-note">None.</div>}>
        {(s: any) => (
          <div class="row">
            <div class="row-main"><div class="row-title">{s.title}</div><div class="row-sub ellipsis">{s.cwd} · {fmtTime(s.startedAt)}</div></div>
            <button onClick={() => run('panels.open', { tool: 'terminal', side: 'bottom', size: 0.4, state: { id: s.terminal } })}>Show</button>
            <button onClick={() => act(run('agents.stop', { id: s.id }))}>Stop</button>
          </div>
        )}
      </For>

      <h3 class="sub">Decisions</h3>
      <div class="list-actions">
        <input class="filter" placeholder="Record a decision agents should respect" value={decision()} onInput={(e) => setDecision(e.currentTarget.value)} />
        <button disabled={!decision()} onClick={() => act(run('decisions.add', { project: props.id, text: decision() }).then(() => setDecision('')))}>Add</button>
      </div>
      <For each={o().decisions}>
        {(d: any) => (
          <div class="row">
            <div class="row-main"><div class="row-title">{d.text}</div><div class="row-sub">{fmtTime(d.created_at)}</div></div>
            <button class="icon-btn" onClick={() => act(run('decisions.remove', { id: d.id }))}>×</button>
          </div>
        )}
      </For>
    </Show>
  );
}

function AgentsSection() {
  const [sessions] = useCommand<any[]>('agents.list', () => ({ running: true }), ['agent.started', 'agent.exited']);
  const [usage] = useCommand<any>('agents.usage', () => ({ days: 7 }));
  const [orca] = useCommand<any>('orca.status');
  const fmtN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  return (
    <>
      <h3 class="sub">Agent sessions</h3>
      <For each={sessions()} fallback={<div class="muted small-note">No agents running.</div>}>
        {(s) => (
          <div class="row">
            <div class="row-main"><div class="row-title">{s.title}</div><div class="row-sub ellipsis">{s.cwd}</div></div>
            <button onClick={() => run('panels.open', { tool: 'terminal', side: 'bottom', size: 0.4, state: { id: s.terminal } })}>Show</button>
            <button onClick={() => run('agents.stop', { id: s.id })}>Stop</button>
          </div>
        )}
      </For>
      <h3 class="sub">Usage, last 7 days</h3>
      <Show when={usage() && Object.keys(usage().totals).length} fallback={<div class="muted small-note">No local usage logs found (Claude Code and Codex are read when present).</div>}>
        <For each={Object.entries(usage().totals) as [string, any][]}>
          {([agent, t]) => <div class="row-sub">{agent}: {fmtN(t.input)} in · {fmtN(t.output)} out · {fmtN(t.cacheRead)} cached · {t.requests} requests</div>}
        </For>
      </Show>
      <h3 class="sub">Orca</h3>
      <div class="row-sub">{orca()?.installed ? `CLI: ${orca().cli}${orca().error ? ` · ${orca().error}` : ''}` : 'Orca not installed. Sensor works without it; with it, "Add to Orca" and Orca worktrees are available.'}</div>
    </>
  );
}

// ------------------------------------------------------------------ AI workflows

export function AiTool() {
  const [providers, refetchProviders] = useCommand<any[]>('ai.providers', () => ({}), ['tab.opened', 'tab.closed']);
  const [prompts, refetchPrompts] = useCommand<any[]>('prompts.list');
  const [text, setText] = createSignal('');
  const [files, setFiles] = createSignal<string[]>([]);
  const [target, setTarget] = createSignal('');
  const [submit, setSubmit] = createSignal(false);
  const [promptName, setPromptName] = createSignal('');
  const [msg, setMsg] = createSignal('');
  const [err, setErr] = createSignal('');
  createEffect(() => { if (!target() && providers()?.length) setTarget(providers()![0].id); });
  const send = async () => {
    setErr(''); setMsg('');
    try {
      if (target() === '*') {
        const r = await run<any>('ai.askAll', { text: text(), submit: submit() || undefined });
        setMsg(r.results.map((x: any) => `${x.provider}: ${x.ok ? 'ready' : x.error}`).join('\n'));
      } else {
        const r = await run<any>('ai.send', { provider: target(), text: text() || undefined, files: files().length ? files() : undefined, prompt: promptName() || undefined, submit: submit() || undefined });
        setMsg(`${r.provider}: inserted ${r.chars} chars${r.files ? ` and ${r.files} file(s)` : ''}${r.submitted ? ', sent' : ' — review and press send'}`);
      }
    } catch (e) {
      setErr(errText(e));
    }
  };
  const fromSelection = () => run<any>('ai.send', { provider: target(), fromSelection: true, prompt: promptName() || undefined, submit: submit() || undefined }).then((r) => setMsg(`${r.provider}: inserted selection`)).catch((e) => setErr(errText(e)));
  const fromPage = () => run<any>('ai.send', { provider: target(), fromPage: true, prompt: promptName() || undefined, submit: submit() || undefined }).then((r) => setMsg(`${r.provider}: inserted page (${r.chars} chars)`)).catch((e) => setErr(errText(e)));
  const addProvider = async () => {
    const name = prompt('Provider name:');
    if (!name) return;
    const url = prompt('URL (https://…):');
    if (!url) return;
    const kind = prompt('Adapter (chatgpt, claude, perplexity, gemini, generic):', 'generic') || 'generic';
    await run('ai.addProvider', { name, url, kind }).catch((e) => alert(errText(e)));
    refetchProviders();
  };
  const savePrompt = async () => {
    const name = prompt('Prompt name:');
    if (!name) return;
    const body = prompt('Prompt text ({{text}} = selection/page/input):', '{{text}}');
    if (!body) return;
    await run('prompts.save', { name, body });
    refetchPrompts();
  };
  return (
    <div class="list documents ai">
      <div class="list-actions">
        <select value={target()} onChange={(e) => setTarget(e.currentTarget.value)}>
          <For each={providers()}>{(p) => <option value={p.id}>{p.name}{p.open ? ' •' : ''}</option>}</For>
          <option value="*">All providers (research workspace)</option>
        </select>
        <select value={promptName()} onChange={(e) => setPromptName(e.currentTarget.value)}>
          <option value="">No prompt template</option>
          <For each={prompts()}>{(p) => <option value={p.name}>{p.name}</option>}</For>
        </select>
      </div>
      <textarea rows={6} placeholder="Prompt. Drop files here to attach." value={text()} onInput={(e) => setText(e.currentTarget.value)}
        onDrop={(e) => { e.preventDefault(); const fs = [...(e.dataTransfer?.files ?? [])].map((f) => window.sensor.pathForFile(f)).filter(Boolean); setFiles([...files(), ...fs]); }} onDragOver={(e) => e.preventDefault()} />
      <Show when={files().length}>
        <div class="chips"><For each={files()}>{(f) => <span class="chip" onClick={() => setFiles(files().filter((x) => x !== f))}>{f.split(/[\\/]/).pop()} ×</span>}</For></div>
      </Show>
      <div class="list-actions">
        <button onClick={send}>Insert</button>
        <button onClick={fromSelection}>Use selection</button>
        <button onClick={fromPage}>Use page</button>
        <label class="toggle"><input type="checkbox" checked={submit()} onChange={(e) => setSubmit(e.currentTarget.checked)} /> press send</label>
      </div>
      <Show when={msg()}><div class="row-sub pre">{msg()}</div></Show>
      <Show when={err()}><div class="error-text">{err()}</div></Show>
      <div class="list-actions">
        <button onClick={() => run<any>('ai.capture', {}).then((n) => setMsg(`Saved to ${n.path} (${n.turns} messages)`)).catch((e) => setErr(errText(e)))}>Save this conversation to a note</button>
      </div>
      <h3 class="sub">Providers</h3>
      <For each={providers()}>
        {(p) => (
          <div class="row">
            <div class="row-main"><div class="row-title">{p.name}</div><div class="row-sub ellipsis">{p.url} · {p.kind}{p.purpose ? ` · ${p.purpose}` : ''}</div></div>
            <button onClick={() => run('ai.open', { provider: p.id })}>Open</button>
            <button class="icon-btn" onClick={() => confirm(`Remove ${p.name}?`) && run('ai.removeProvider', { id: p.id }).then(refetchProviders)}>×</button>
          </div>
        )}
      </For>
      <div class="list-actions"><button onClick={addProvider}>+ Provider</button></div>
      <h3 class="sub">Prompt templates</h3>
      <For each={prompts()} fallback={<div class="muted small-note">None yet.</div>}>
        {(p) => (
          <div class="row">
            <div class="row-main"><div class="row-title">{p.name}</div><div class="row-sub ellipsis">{p.body}</div></div>
            <button class="icon-btn" onClick={() => run('prompts.delete', { name: p.name }).then(refetchPrompts)}>×</button>
          </div>
        )}
      </For>
      <div class="list-actions"><button onClick={savePrompt}>+ Prompt</button></div>
      <p class="muted small-note">Sensor uses the sites you're logged in to in its own tabs. Nothing is sent without "press send" (or the forms:submit permission for scripts). Site layouts change; selectors can be overridden in the ai.adapters setting.</p>
    </div>
  );
}

// ------------------------------------------------------------------ checkpoints

export function BackupsTool() {
  const [info, refetch] = useCommand<any>('backup.list', () => ({}), ['backup.created', 'backup.restorePending']);
  const [msg, setMsg] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const now = () => {
    setBusy(true);
    run<any>('backup.now').then((r) => setMsg(`Saved to ${r.slot} (${fmtBytes(r.bytes)})`)).catch((e) => setMsg(errText(e))).finally(() => { setBusy(false); refetch(); });
  };
  return (
    <div class="list">
      <div class="list-actions">
        <button disabled={busy()} onClick={now}>{busy() ? 'Saving…' : 'Create checkpoint'}</button>
        <button onClick={() => run<any[]>('backup.verify').then((r) => setMsg(r.map((v) => `${v.slot}: ${v.ok ? 'ok' : v.problems.join('; ')}`).join('\n')))}>Verify</button>
      </div>
      <Show when={msg()}><div class="row-sub pre">{msg()}</div></Show>
      <For each={info()?.slots}>
        {(s: any) => (
          <div class="row">
            <div class="row-main">
              <div class="row-title">{s.slot} {s.valid ? '' : <span class="badge">empty / invalid</span>}</div>
              <div class="row-sub">{s.valid ? `${fmtTime(s.createdAt)} · ${s.reason} · ${s.files} files · ${fmtBytes(s.bytes)}` : '—'}</div>
            </div>
            <Show when={s.valid}>
              <button onClick={() => confirm(`Restore ${s.slot} from ${new Date(s.createdAt).toLocaleString()}? Sensor restarts with that state; the current database is kept as core.db.before-restore.`) && run('backup.restore', { slot: s.slot }).then(() => setMsg('Restore staged: restart Sensor to apply.'))}>Restore</button>
            </Show>
          </div>
        )}
      </For>
      <div class="row-sub">Folder: {info()?.root}</div>
      <div class="row-sub">Every {info()?.intervalHours || 'off'} h · extra folders: {(info()?.includes ?? []).join(', ') || 'none'} (Settings: backup.*)</div>
      <p class="muted small-note">Two slots rotate; a checkpoint is only valid once its manifest is written, so an interrupted save never damages the other slot. Point backup.dir at a synced folder for an off-machine copy.</p>
    </div>
  );
}
