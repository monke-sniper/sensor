// Deterministic macros and workflows.
//
// A macro is a JSON document of steps. Steps run in order through the command
// bus, as a "macro" principal limited to the macro's declared scopes, so a
// macro can never do more than it says it does (and never more than whoever
// started it). No AI decides anything at run time: element targeting uses
// recorded selector lists with fallbacks, waits are explicit, and every step
// is logged.
//
// Recording: the web preload reports trusted clicks/typing/keys while
// recording is on; `recordStep` turns them into steps.
//
// Triggers start macros on a schedule, on events (e.g. download.completed),
// when files arrive in a folder, or at startup.
import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { Core, CoreModule } from '../core';
import { CommandError, type CommandDef } from '../commands';
import { now, uid } from '../db';
import { SCOPES, hasScope, type Principal, type Scope } from '../permissions';
import { evaluate, interpolate, truthy, type Vars } from './macro-lang';

export interface MacroInput {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
  default?: any;
  description?: string;
  required?: boolean;
  /** never logged or stored with run state */
  secret?: boolean;
}

export interface Step {
  op: string;
  /** target for `onError: "goto:<label>"` */
  label?: string;
  /** free-text description (recorded element text, notes) */
  desc?: string;
  /** skip the step unless this expression is true */
  when?: string;
  retry?: number;
  retryDelay?: number;
  onError?: 'stop' | 'continue' | string;
  timeout?: number;
  [k: string]: any;
}

export interface MacroDef {
  name: string;
  description?: string;
  inputs?: Record<string, MacroInput>;
  /** scopes the macro may use; inferred from the steps when omitted */
  scopes?: Scope[];
  steps: Step[];
}

export interface MacroRow {
  id: string;
  name: string;
  definition: MacroDef;
  scopes: Scope[];
  created_at: number;
  updated_at: number;
}

export type RunState = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

interface LogEntry {
  t: number;
  path: string;
  op: string;
  status: 'ok' | 'error' | 'skipped' | 'retry' | 'info';
  message?: string;
  ms?: number;
}

/** Ops and the scopes they need (beyond what the commands they call check). */
const OP_SCOPES: Record<string, Scope[]> = {
  open: ['tabs:write'],
  navigate: ['tabs:write'],
  click: ['page:interact'],
  type: ['page:interact'],
  select: ['page:interact'],
  press: ['page:interact'],
  upload: ['page:interact', 'files:read'],
  waitFor: ['page:read'],
  extract: ['page:read'],
  read: ['page:read'],
  screenshot: ['page:read'],
  call: ['macros:run'],
};

export const STEP_OPS: Record<string, { title: string; fields: string[] }> = {
  open: { title: 'Open tab', fields: ['url', 'incognito', 'target'] },
  navigate: { title: 'Go to URL', fields: ['url'] },
  click: { title: 'Click', fields: ['selectors'] },
  type: { title: 'Type text', fields: ['selectors', 'text', 'clear'] },
  select: { title: 'Choose option', fields: ['selectors', 'value'] },
  press: { title: 'Press key', fields: ['key'] },
  waitFor: { title: 'Wait for element', fields: ['selectors'] },
  wait: { title: 'Wait', fields: ['ms'] },
  extract: { title: 'Extract', fields: ['selectors', 'attr', 'all', 'format', 'save'] },
  read: { title: 'Read page', fields: ['format', 'save'] },
  upload: { title: 'Attach files', fields: ['files', 'selector'] },
  screenshot: { title: 'Screenshot', fields: ['path'] },
  command: { title: 'Run command', fields: ['command', 'args', 'save'] },
  set: { title: 'Set variable', fields: ['var', 'value'] },
  input: { title: 'Ask for input', fields: ['var', 'prompt', 'secret', 'default'] },
  if: { title: 'If', fields: ['cond', 'then', 'else'] },
  loop: { title: 'Loop', fields: ['over', 'times', 'while', 'as', 'steps'] },
  call: { title: 'Run macro', fields: ['macro', 'args', 'save'] },
  output: { title: 'Output', fields: ['name', 'value'] },
  checkpoint: { title: 'Checkpoint', fields: [] },
  log: { title: 'Log', fields: ['message'] },
  notify: { title: 'Notify', fields: ['title', 'body', 'level'] },
  assert: { title: 'Assert', fields: ['cond', 'message'] },
  fail: { title: 'Fail', fields: ['message'] },
  break: { title: 'Break loop', fields: [] },
  stop: { title: 'Stop macro', fields: [] },
};

class Stop {
  constructor(public kind: 'stop' | 'break') {}
}

export class MacroRun {
  readonly id = uid('run_');
  state: RunState = 'running';
  log: LogEntry[] = [];
  outputs: Record<string, any> = {};
  vars: Vars;
  tab: string | undefined;
  cancelled = false;
  error: string | null = null;
  startedAt = now();
  finishedAt: number | null = null;
  /** index into top-level steps after the last checkpoint */
  resumeAt = 0;
  waiting: { var: string; prompt: string; secret: boolean; resolve: (v: any) => void; reject: (e: Error) => void } | null = null;
  done!: Promise<MacroRun>;

  constructor(
    public macro: MacroRow,
    public principal: Principal,
    inputs: Record<string, any>,
    public secretNames: Set<string>,
    public depth: number,
    public trigger: string | null,
  ) {
    this.vars = { ...inputs, inputs: { ...inputs } };
  }

  summary() {
    return {
      id: this.id, macroId: this.macro.id, macro: this.macro.name, state: this.state, error: this.error,
      outputs: this.outputs, startedAt: this.startedAt, finishedAt: this.finishedAt, trigger: this.trigger,
      waiting: this.waiting ? { var: this.waiting.var, prompt: this.waiting.prompt, secret: this.waiting.secret } : null,
      steps: this.log.length,
    };
  }
}

export interface Recording {
  steps: Step[];
  lastUrl: string | null;
  startedAt: number;
}

export class Macros {
  runs = new Map<string, MacroRun>();
  recording: Recording | null = null;

  constructor(private core: Core) {}

  // ---------------------------------------------------------------- storage
  list(): MacroRow[] {
    return this.core.db.all('SELECT * FROM macros ORDER BY name').map(rowOf);
  }

  get(idOrName: string): MacroRow {
    const r = this.core.db.get('SELECT * FROM macros WHERE id = ? OR name = ?', idOrName, idOrName);
    if (!r) throw new CommandError('not_found', `macro not found: ${idOrName}`);
    return rowOf(r);
  }

  find(idOrName: string): MacroRow | null {
    try {
      return this.get(idOrName);
    } catch {
      return null;
    }
  }

  save(def: MacroDef, id?: string): MacroRow {
    validateDef(def);
    const scopes = def.scopes ?? inferScopes(this.core, def.steps);
    const existing = id ? this.find(id) : this.find(def.name);
    const t = now();
    if (existing) {
      this.core.db.run('UPDATE macros SET name = ?, definition = ?, scopes = ?, updated_at = ? WHERE id = ?', def.name, JSON.stringify(def), JSON.stringify(scopes), t, existing.id);
      this.core.events.emit('macro.saved', { id: existing.id, name: def.name });
      return this.get(existing.id);
    }
    const nid = id ?? uid('mac_');
    this.core.db.run('INSERT INTO macros (id, name, definition, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', nid, def.name, JSON.stringify(def), JSON.stringify(scopes), t, t);
    this.core.events.emit('macro.saved', { id: nid, name: def.name });
    return this.get(nid);
  }

  remove(idOrName: string): boolean {
    const m = this.get(idOrName);
    this.core.db.tx(() => {
      this.core.db.run('DELETE FROM macros WHERE id = ?', m.id);
      this.core.db.run('DELETE FROM triggers WHERE macro_id = ?', m.id);
    });
    this.core.events.emit('macro.deleted', { id: m.id });
    return true;
  }

  // ---------------------------------------------------------------- running
  /**
   * Start a run. `caller` is whoever asked: a token/macro caller can only pass
   * on scopes it has itself, so macros never escalate privileges.
   */
  start(idOrName: string, inputs: Record<string, any> = {}, opts: { caller?: Principal; tab?: string; depth?: number; trigger?: string; resumeFrom?: { index: number; vars: Vars } } = {}): MacroRun {
    const m = this.get(idOrName);
    const depth = opts.depth ?? 0;
    if (depth > 8) throw new CommandError('failed', 'macro call depth exceeded (8)');
    const def = m.definition;
    const merged: Record<string, any> = {};
    const secrets = new Set<string>();
    for (const [name, spec] of Object.entries(def.inputs ?? {})) {
      if (spec.secret) secrets.add(name);
      if (inputs[name] !== undefined) merged[name] = inputs[name];
      else if (spec.default !== undefined) merged[name] = spec.default;
    }
    for (const [k, v] of Object.entries(inputs)) if (merged[k] === undefined) merged[k] = v;

    const caller = opts.caller ?? { kind: 'user' };
    let scopes: Scope[] = m.scopes;
    if (caller.kind !== 'user') {
      const has = new Set(caller.scopes);
      scopes = has.has('*') ? m.scopes : m.scopes.filter((s) => s === '*' ? false : has.has(s));
    }
    const principal: Principal = { kind: 'macro', id: m.id, name: m.name, scopes };
    const run = new MacroRun(m, principal, merged, secrets, depth, opts.trigger ?? null);
    if (opts.resumeFrom) {
      Object.assign(run.vars, opts.resumeFrom.vars);
      run.resumeAt = opts.resumeFrom.index;
    }
    run.tab = opts.tab;
    this.runs.set(run.id, run);
    this.persist(run, true);
    this.core.events.emit('macro.started', run.summary());
    run.done = this.execute(run, opts.resumeFrom?.index ?? 0);
    // bounded in-memory history
    if (this.runs.size > 200) {
      for (const [id, r] of this.runs) {
        if (r.state !== 'running' && r.state !== 'waiting') this.runs.delete(id);
        if (this.runs.size <= 150) break;
      }
    }
    return run;
  }

  async runToEnd(idOrName: string, inputs: Record<string, any> = {}, opts: Parameters<Macros['start']>[2] = {}): Promise<MacroRun> {
    return this.start(idOrName, inputs, opts).done;
  }

  cancel(runId: string): boolean {
    const r = this.runs.get(runId);
    if (!r || (r.state !== 'running' && r.state !== 'waiting')) return false;
    r.cancelled = true;
    r.waiting?.reject(new Error('cancelled'));
    return true;
  }

  answer(runId: string, value: any): boolean {
    const r = this.runs.get(runId);
    if (!r?.waiting) return false;
    r.waiting.resolve(value);
    return true;
  }

  private async execute(run: MacroRun, from: number): Promise<MacroRun> {
    const t0 = now();
    try {
      const steps = run.macro.definition.steps;
      await this.steps(run, steps.slice(from), '', from, true);
      if (run.cancelled) throw new Error('cancelled');
      run.state = 'completed';
    } catch (e: any) {
      if (e instanceof Stop) run.state = 'completed';
      else if (run.cancelled) {
        run.state = 'cancelled';
        run.error = 'cancelled';
      } else {
        run.state = 'failed';
        run.error = String(e?.message ?? e);
      }
    }
    run.finishedAt = now();
    run.waiting = null;
    this.persist(run, false);
    const ev = run.state === 'completed' ? 'macro.completed' : run.state === 'cancelled' ? 'macro.cancelled' : 'macro.failed';
    this.core.events.emit(ev, { ...run.summary(), ms: run.finishedAt - t0 });
    if (run.state === 'failed' && run.depth === 0) this.core.notify('error', `Macro failed: ${run.macro.name}`, run.error ?? '', 'macros');
    return run;
  }

  private async steps(run: MacroRun, steps: Step[], prefix: string, offset: number, top: boolean): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      if (run.cancelled) throw new Error('cancelled');
      const step = steps[i];
      const path = `${prefix}${i + offset}`;
      const r = await this.step(run, step, path, top ? i + offset : -1);
      if (r && r.startsWith('goto:')) {
        const label = r.slice(5);
        const j = steps.findIndex((s) => s.label === label);
        if (j < 0) throw new Error(`no step labelled "${label}"`);
        i = j - 1;
      }
    }
  }

  /** Runs one step with retries; returns a control signal ("goto:label") or null. */
  private async step(run: MacroRun, step: Step, path: string, topIndex: number): Promise<string | null> {
    if (step.when !== undefined && !truthy(step.when, run.vars)) {
      this.logStep(run, path, step.op, 'skipped');
      return null;
    }
    const attempts = Math.max(1, (step.retry ?? 0) + 1);
    for (let attempt = 1; ; attempt++) {
      const t = now();
      try {
        const result = await this.op(run, step, path);
        if (step.op === 'checkpoint' && topIndex >= 0) {
          run.resumeAt = topIndex + 1;
          this.persist(run, false);
        }
        this.logStep(run, path, step.op, 'ok', resultNote(step, result), now() - t);
        this.core.events.emit('macro.step', { run: run.id, path, op: step.op, status: 'ok' });
        return null;
      } catch (e: any) {
        if (e instanceof Stop || run.cancelled) throw e;
        const msg = String(e?.message ?? e);
        if (attempt < attempts) {
          this.logStep(run, path, step.op, 'retry', msg, now() - t);
          await sleep(step.retryDelay ?? 1000);
          continue;
        }
        this.logStep(run, path, step.op, 'error', msg, now() - t);
        this.core.events.emit('macro.step', { run: run.id, path, op: step.op, status: 'error', message: msg });
        const onError = step.onError ?? 'stop';
        if (onError === 'continue') {
          run.vars.lastError = msg;
          return null;
        }
        if (onError.startsWith('goto:')) {
          run.vars.lastError = msg;
          return onError;
        }
        throw new Error(`step ${path} (${step.op}${step.desc ? `: ${step.desc}` : ''}) failed: ${msg}`);
      }
    }
  }

  private tabFor(run: MacroRun, step: Step): string | undefined {
    if (step.tab) return interpolate(step.tab, run.vars);
    return run.tab;
  }

  private call(run: MacroRun, id: string, args: Record<string, any>) {
    return this.core.bus.run(id, args, run.principal);
  }

  private selectors(run: MacroRun, step: Step): string[] {
    const s = interpolate(step.selectors ?? (step.selector ? [step.selector] : []), run.vars);
    const list = (Array.isArray(s) ? s : [s]).map(String).filter(Boolean);
    if (!list.length) throw new Error('step needs selectors');
    return list;
  }

  private async op(run: MacroRun, step: Step, path: string): Promise<any> {
    const V = run.vars;
    const I = <T>(v: T): T => interpolate(v, V);
    const timeout = step.timeout ?? 15000;
    const save = (v: any) => {
      V.last = v;
      if (step.save) V[step.save] = v;
      return v;
    };
    const ensureTab = () => {
      if (!run.tab) {
        const w = this.core.workspaces.active();
        if (!w.activeTab) throw new Error('no tab: add an "open" step first');
        run.tab = w.activeTab;
      }
      return run.tab;
    };
    switch (step.op) {
      case 'open': {
        const t = await this.call(run, 'tabs.open', { url: I(step.url), incognito: !!step.incognito, target: step.target ?? 'tab', background: !!step.background });
        run.tab = t.id;
        this.core.browser.ensure(t.id);
        await sleep(50);
        await this.core.browser.waitForLoad(t.id, timeout);
        return save(t.id);
      }
      case 'navigate': {
        const id = this.tabFor(run, step) ?? ensureTab();
        await this.call(run, 'tabs.navigate', { id, url: I(step.url) });
        await sleep(100);
        await this.core.browser.waitForLoad(id, timeout);
        return null;
      }
      case 'useTab': {
        run.tab = I(step.id) ?? this.core.workspaces.active().activeTab ?? undefined;
        return run.tab;
      }
      case 'click':
        return this.call(run, 'page.click', { id: this.tabFor(run, step) ?? ensureTab(), selectors: this.selectors(run, step), timeout });
      case 'type':
        return this.call(run, 'page.type', { id: this.tabFor(run, step) ?? ensureTab(), selectors: this.selectors(run, step), text: String(I(step.text) ?? ''), clear: step.clear ?? false, timeout });
      case 'select':
        return this.call(run, 'page.select', { id: this.tabFor(run, step) ?? ensureTab(), selectors: this.selectors(run, step), value: String(I(step.value)), timeout });
      case 'press':
        await this.call(run, 'page.press', { id: this.tabFor(run, step) ?? ensureTab(), key: I(step.key) });
        await sleep(step.settle ?? 150);
        return null;
      case 'waitFor':
        return save((await this.call(run, 'page.waitFor', { id: this.tabFor(run, step) ?? ensureTab(), selectors: this.selectors(run, step), timeout })).selector);
      case 'wait':
        await sleep(Math.min(Number(I(step.ms) ?? 1000), 10 * 60_000), () => run.cancelled);
        return null;
      case 'extract': {
        const r = await this.call(run, 'page.extract', { id: this.tabFor(run, step) ?? ensureTab(), selectors: this.selectors(run, step), attr: step.attr, all: !!step.all, format: step.format ?? 'text', timeout });
        return save(r.value);
      }
      case 'read': {
        const r = await this.call(run, 'page.read', { id: this.tabFor(run, step) ?? ensureTab(), format: step.format ?? 'markdown' });
        return save(r);
      }
      case 'upload':
        return this.call(run, 'page.upload', { id: this.tabFor(run, step) ?? ensureTab(), files: I(step.files), selector: step.selector ?? 'input[type=file]' });
      case 'screenshot':
        return save(await this.call(run, 'page.screenshot', { id: this.tabFor(run, step) ?? ensureTab(), out: I(step.path) }));
      case 'command': {
        if (!step.command) throw new Error('command step needs "command"');
        return save(await this.call(run, I(step.command), I(step.args ?? {})));
      }
      case 'set': {
        if (step.vars) for (const [k, v] of Object.entries(step.vars)) V[k] = I(v);
        if (step.var) V[step.var] = step.expr !== undefined ? evaluate(String(step.expr), V) : I(step.value);
        return null;
      }
      case 'input': {
        const name = step.var;
        if (!name) throw new Error('input step needs "var"');
        if (V[name] !== undefined && V[name] !== '') return null;
        if (step.secret) run.secretNames.add(name);
        const value = await new Promise<any>((resolve, reject) => {
          run.waiting = { var: name, prompt: I(step.prompt ?? name), secret: !!step.secret, resolve, reject };
          run.state = 'waiting';
          this.core.events.emit('macro.waiting', { run: run.id, macro: run.macro.name, var: name, prompt: run.waiting.prompt, secret: !!step.secret });
          if (step.timeout) setTimeout(() => (step.default !== undefined ? resolve(step.default) : reject(new Error(`no answer for "${name}"`))), step.timeout);
        });
        run.waiting = null;
        run.state = 'running';
        V[name] = value;
        return null;
      }
      case 'if': {
        const branch = truthy(step.cond, V) ? step.then : step.else;
        if (Array.isArray(branch)) await this.steps(run, branch, `${path}.${branch === step.then ? 'then' : 'else'}.`, 0, false);
        return null;
      }
      case 'loop': {
        const body: Step[] = step.steps ?? [];
        const as = step.as ?? 'item';
        const max = Math.min(step.max ?? 10_000, 100_000);
        let n = 0;
        const iterate = async (item: any, index: number) => {
          V[as] = item;
          V[step.index ?? 'index'] = index;
          try {
            await this.steps(run, body, `${path}.${index}.`, 0, false);
          } catch (e) {
            if (e instanceof Stop && e.kind === 'break') return false;
            throw e;
          }
          return true;
        };
        if (step.over !== undefined) {
          const list = I(step.over);
          const arr = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.entries(list).map(([key, value]) => ({ key, value })) : String(list ?? '').split(/\r?\n/).filter(Boolean);
          for (const item of arr) {
            if (n >= max) break;
            if (!(await iterate(item, n++))) break;
          }
        } else if (step.times !== undefined) {
          const times = Math.min(Number(I(step.times)), max);
          for (let k = 0; k < times; k++) if (!(await iterate(k, n++))) break;
        } else if (step.while !== undefined) {
          while (truthy(step.while, V)) {
            if (n >= max) throw new Error(`loop exceeded ${max} iterations`);
            if (!(await iterate(n, n++))) break;
          }
        } else throw new Error('loop needs "over", "times" or "while"');
        return n;
      }
      case 'call': {
        const child = this.start(I(step.macro), I(step.args ?? {}), { caller: run.principal, tab: run.tab, depth: run.depth + 1 });
        const done = await child.done;
        if (done.state !== 'completed') throw new Error(`macro "${done.macro.name}" ${done.state}: ${done.error ?? ''}`);
        if (done.tab) run.tab = done.tab;
        return save(done.outputs);
      }
      case 'output': {
        const v = I(step.value);
        run.outputs[step.name ?? 'result'] = v;
        return v;
      }
      case 'checkpoint':
        return null;
      case 'log':
        this.logStep(run, path, 'log', 'info', String(I(step.message) ?? ''));
        return null;
      case 'notify':
        this.core.notify(step.level ?? 'info', String(I(step.title) ?? run.macro.name), String(I(step.body) ?? ''), 'macros');
        return null;
      case 'assert':
        if (!truthy(step.cond, V)) throw new Error(I(step.message) ?? `assertion failed: ${step.cond}`);
        return null;
      case 'fail':
        throw new Error(String(I(step.message) ?? 'failed'));
      case 'break':
        throw new Stop('break');
      case 'stop':
        throw new Stop('stop');
      default:
        throw new Error(`unknown step op: ${step.op}`);
    }
  }

  private logStep(run: MacroRun, path: string, op: string, status: LogEntry['status'], message?: string, ms?: number) {
    let msg = message;
    if (msg) for (const s of run.secretNames) if (run.vars[s]) msg = msg.split(String(run.vars[s])).join('•••');
    run.log.push({ t: now(), path, op, status, message: msg?.slice(0, 500), ms });
    if (run.log.length > 2000) run.log.splice(0, run.log.length - 2000);
  }

  /** Persist run state; secret variables are never written. */
  private persist(run: MacroRun, insert: boolean) {
    const safeVars: Vars = {};
    for (const [k, v] of Object.entries(run.vars)) {
      if (run.secretNames.has(k) || k === 'inputs') continue;
      try {
        const s = JSON.stringify(v);
        if (s && s.length < 100_000) safeVars[k] = v;
      } catch {
        /* unserialisable */
      }
    }
    const outputs = JSON.stringify({ outputs: run.outputs, error: run.error, resumeAt: run.resumeAt, vars: safeVars, trigger: run.trigger });
    if (insert) {
      this.core.db.run('INSERT INTO macro_runs (id, macro_id, state, log, outputs, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)', run.id, run.macro.id, run.state, '[]', outputs, run.startedAt, null);
      this.core.db.run('DELETE FROM macro_runs WHERE id IN (SELECT id FROM macro_runs ORDER BY started_at DESC LIMIT -1 OFFSET 1000)');
    } else {
      this.core.db.run('UPDATE macro_runs SET state = ?, log = ?, outputs = ?, finished_at = ? WHERE id = ?', run.state, JSON.stringify(run.log.slice(-500)), outputs, run.finishedAt, run.id);
    }
  }

  history(macroId?: string, limit = 50) {
    const rows = macroId
      ? this.core.db.all('SELECT r.*, m.name FROM macro_runs r LEFT JOIN macros m ON m.id = r.macro_id WHERE r.macro_id = ? ORDER BY r.started_at DESC LIMIT ?', macroId, limit)
      : this.core.db.all('SELECT r.*, m.name FROM macro_runs r LEFT JOIN macros m ON m.id = r.macro_id ORDER BY r.started_at DESC LIMIT ?', limit);
    return rows.map((r) => {
      const live = this.runs.get(r.id);
      if (live) return { ...live.summary(), log: live.log };
      const o = JSON.parse(r.outputs ?? '{}');
      return { id: r.id, macroId: r.macro_id, macro: r.name, state: r.state, error: o.error ?? null, outputs: o.outputs ?? {}, startedAt: r.started_at, finishedAt: r.finished_at, trigger: o.trigger ?? null, resumeAt: o.resumeAt ?? 0, log: JSON.parse(r.log ?? '[]') };
    });
  }

  /** Re-run a failed run from its last checkpoint, with the saved variables. */
  resume(runId: string, inputs: Record<string, any> = {}, caller?: Principal): MacroRun {
    const r = this.core.db.get('SELECT * FROM macro_runs WHERE id = ?', runId);
    if (!r) throw new CommandError('not_found', `run not found: ${runId}`);
    if (r.state === 'running' || r.state === 'waiting') throw new CommandError('failed', 'run is still active');
    const o = JSON.parse(r.outputs ?? '{}');
    return this.start(r.macro_id, inputs, { caller, resumeFrom: { index: o.resumeAt ?? 0, vars: o.vars ?? {} } });
  }

  // ---------------------------------------------------------------- recording
  startRecording(): Recording {
    const rec: Recording = { steps: [], lastUrl: null, startedAt: now() };
    const w = this.core.workspaces.active();
    if (w.activeTab && this.core.workspaces.hasTab(w.activeTab)) {
      const url = this.core.workspaces.tab(w.activeTab).url;
      if (/^https?:|^file:/.test(url)) {
        rec.steps.push({ op: 'open', url });
        rec.lastUrl = url;
      }
    }
    this.recording = rec;
    this.core.events.emit('macro.recording', { on: true });
    return rec;
  }

  /** Called by the web bridge for each trusted user action while recording. */
  recordStep(tabId: string, raw: any): void {
    const rec = this.recording;
    if (!rec || !raw || typeof raw.op !== 'string') return;
    if (this.core.workspaces.hasTab(tabId) && this.core.workspaces.tab(tabId).profileId.startsWith('incognito')) return;
    const prev = rec.steps[rec.steps.length - 1];
    const url = typeof raw.url === 'string' ? raw.url : null;
    if (url && url !== rec.lastUrl) {
      const causedByUs = prev && (prev.op === 'click' || prev.op === 'press');
      if (!rec.steps.length) rec.steps.push({ op: 'open', url });
      else if (!causedByUs) rec.steps.push({ op: 'navigate', url });
      rec.lastUrl = url;
    }
    const selectors = Array.isArray(raw.selectors) ? raw.selectors.filter((s: any) => typeof s === 'string').slice(0, 6) : undefined;
    let step: Step | null = null;
    switch (raw.op) {
      case 'click':
        step = { op: 'click', selectors, desc: raw.label ? String(raw.label).slice(0, 60) : undefined };
        break;
      case 'type': {
        const last = rec.steps[rec.steps.length - 1];
        if (last?.op === 'type' && selectors && last.selectors?.[0] === selectors[0]) {
          last.text = String(raw.text ?? '');
          this.core.events.emit('macro.recordedStep', { index: rec.steps.length - 1, step: last });
          return;
        }
        step = { op: 'type', selectors, text: String(raw.text ?? ''), clear: true };
        if (raw.note) step.desc = String(raw.note);
        break;
      }
      case 'select':
        step = { op: 'select', selectors, value: String(raw.value ?? '') };
        break;
      case 'press':
        if (!['Enter', 'Escape', 'Tab'].includes(raw.key)) return;
        step = { op: 'press', key: raw.key };
        break;
      default:
        return;
    }
    rec.steps.push(step);
    this.core.events.emit('macro.recordedStep', { index: rec.steps.length - 1, step });
  }

  stopRecording(): Step[] {
    const rec = this.recording;
    this.recording = null;
    this.core.events.emit('macro.recording', { on: false });
    return rec?.steps ?? [];
  }
}

function rowOf(r: any): MacroRow {
  return { id: r.id, name: r.name, definition: JSON.parse(r.definition), scopes: JSON.parse(r.scopes), created_at: r.created_at, updated_at: r.updated_at };
}

function resultNote(step: Step, result: any): string | undefined {
  if (step.op === 'output' || step.op === 'extract' || step.op === 'set') {
    try {
      const s = typeof result === 'string' ? result : JSON.stringify(result);
      return s?.slice(0, 200);
    } catch {
      return undefined;
    }
  }
  if (step.op === 'click' || step.op === 'type') return result?.selector;
  return undefined;
}

export function validateDef(def: MacroDef): void {
  if (!def || typeof def !== 'object') throw new CommandError('invalid_params', 'macro definition must be an object');
  if (!def.name || typeof def.name !== 'string') throw new CommandError('invalid_params', 'macro needs a name');
  if (!Array.isArray(def.steps)) throw new CommandError('invalid_params', 'macro needs a steps array');
  const walk = (steps: Step[], where: string) => {
    steps.forEach((s, i) => {
      if (!s || typeof s.op !== 'string') throw new CommandError('invalid_params', `${where}${i}: step needs an op`);
      if (!STEP_OPS[s.op] && s.op !== 'useTab') throw new CommandError('invalid_params', `${where}${i}: unknown op "${s.op}"`);
      if (s.op === 'if') {
        if (s.then) walk(s.then, `${where}${i}.then.`);
        if (s.else) walk(s.else, `${where}${i}.else.`);
      }
      if (s.op === 'loop') walk(s.steps ?? [], `${where}${i}.`);
    });
  };
  walk(def.steps, '');
  if (def.scopes) for (const s of def.scopes) if (s !== '*' && !(s in SCOPES)) throw new CommandError('invalid_params', `unknown scope: ${s}`);
}

/** Scopes a macro needs, from its ops and the commands it calls. */
export function inferScopes(core: Core, steps: Step[]): Scope[] {
  const out = new Set<Scope>();
  const walk = (list: Step[]) => {
    for (const s of list) {
      for (const sc of OP_SCOPES[s.op] ?? []) out.add(sc);
      if (s.op === 'command' && typeof s.command === 'string' && !s.command.includes('{{')) {
        for (const sc of core.bus.info(s.command)?.scopes ?? []) out.add(sc);
      }
      if (s.op === 'call' && typeof s.macro === 'string') {
        const callee = core.db.get('SELECT scopes FROM macros WHERE id = ? OR name = ?', s.macro, s.macro);
        if (callee) for (const sc of JSON.parse(callee.scopes)) out.add(sc);
      }
      if (s.op === 'if') {
        walk(s.then ?? []);
        walk(s.else ?? []);
      }
      if (s.op === 'loop') walk(s.steps ?? []);
    }
  };
  walk(steps);
  return [...out].sort();
}

function sleep(ms: number, cancelled?: () => boolean): Promise<void> {
  if (!cancelled) return new Promise((r) => setTimeout(r, ms));
  return new Promise((r) => {
    const end = Date.now() + ms;
    const tick = () => (Date.now() >= end || cancelled() ? r() : setTimeout(tick, Math.min(250, end - Date.now())));
    tick();
  });
}

// ------------------------------------------------------------------ triggers

export interface TriggerRow {
  id: string;
  macro_id: string;
  kind: 'schedule' | 'event' | 'file' | 'startup';
  config: any;
  enabled: boolean;
  last_fired: number | null;
}

/** Topics that can never trigger macros (prevents feedback loops). */
const NEVER_TRIGGER = /^(macro\.(step|started|recordedStep|waiting|recording|saved)|command\.ran|terminal\.output|download\.progress|ui\.|metrics\.)/;

export class Triggers {
  private unsubs = new Map<string, () => void>();
  private watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private lastFire = new Map<string, number>();
  private seen = new Map<string, Set<string>>();
  private polls = new Map<string, NodeJS.Timeout>();
  /** file arrivals waiting for the trigger's current run to finish */
  private queue = new Map<string, Record<string, any>[]>();

  constructor(private core: Core, private macros: Macros) {}

  list(): TriggerRow[] {
    return this.core.db.all('SELECT * FROM triggers ORDER BY id').map((r) => ({ ...r, config: JSON.parse(r.config), enabled: !!r.enabled }) as TriggerRow);
  }

  get(id: string): TriggerRow {
    const t = this.list().find((x) => x.id === id);
    if (!t) throw new CommandError('not_found', `trigger not found: ${id}`);
    return t;
  }

  add(macro: string, kind: TriggerRow['kind'], config: any): TriggerRow {
    const m = this.macros.get(macro);
    validateTrigger(kind, config);
    const id = uid('trg_');
    this.core.db.run('INSERT INTO triggers (id, macro_id, kind, config, enabled) VALUES (?, ?, ?, ?, 1)', id, m.id, kind, JSON.stringify(config ?? {}));
    const t = this.get(id);
    this.arm(t);
    return t;
  }

  remove(id: string): void {
    this.disarm(id);
    this.core.db.run('DELETE FROM triggers WHERE id = ?', id);
  }

  setEnabled(id: string, on: boolean): TriggerRow {
    this.core.db.run('UPDATE triggers SET enabled = ? WHERE id = ?', on ? 1 : 0, id);
    const t = this.get(id);
    if (on) this.arm(t);
    else this.disarm(id);
    return t;
  }

  start(): void {
    for (const t of this.list()) {
      if (!t.enabled) continue;
      // triggers added before start() are already live; re-arming would reset their state
      if (!this.armed(t.id)) this.arm(t);
      if (t.kind === 'startup') this.fire(t, {});
    }
    this.timer = setInterval(() => this.tick(Date.now()), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const id of [...this.unsubs.keys(), ...this.watchers.keys()]) this.disarm(id);
  }

  /** Check schedule triggers; public so tests can drive time. */
  tick(nowMs: number): string[] {
    const fired: string[] = [];
    for (const t of this.list()) {
      if (!t.enabled || t.kind !== 'schedule') continue;
      if (scheduleDue(t.config, t.last_fired, nowMs)) {
        this.fire(t, { scheduledAt: nowMs }, nowMs);
        fired.push(t.id);
      }
    }
    return fired;
  }

  fire(t: TriggerRow, data: Record<string, any>, at = Date.now(), queue = false): MacroRun | null {
    const last = this.lastFire.get(t.id) ?? 0;
    if (!queue && t.kind !== 'schedule' && at - last < 1000) return null; // debounce event bursts
    // one active run per trigger; queued triggers (file arrivals) wait their turn instead of being dropped
    for (const r of this.macros.runs.values()) {
      if (r.trigger === t.id && (r.state === 'running' || r.state === 'waiting')) {
        if (queue) {
          const q = this.queue.get(t.id) ?? [];
          if (!this.queue.has(t.id)) this.queue.set(t.id, q);
          if (q.length < 1000) q.push(data);
          r.done.then(() => this.drain(t));
        }
        return null;
      }
    }
    this.lastFire.set(t.id, at);
    this.core.db.run('UPDATE triggers SET last_fired = ? WHERE id = ?', at, t.id);
    const ctx = { event: data, trigger: { id: t.id, kind: t.kind } };
    const inputs = { ...data, ...(t.config.inputs ? interpolate(t.config.inputs, ctx) : {}) };
    try {
      const run = this.macros.start(t.macro_id, inputs, { trigger: t.id });
      this.core.events.emit('trigger.fired', { id: t.id, macroId: t.macro_id, run: run.id, kind: t.kind });
      return run;
    } catch (e: any) {
      this.core.notify('error', 'Trigger failed', String(e?.message ?? e), 'macros');
      return null;
    }
  }

  private armed(id: string): boolean {
    return this.unsubs.has(id) || this.watchers.has(id) || this.polls.has(id);
  }

  private drain(t: TriggerRow) {
    const q = this.queue.get(t.id);
    const next = q?.shift();
    if (next) this.fire(t, next, Date.now(), true);
  }

  private arm(t: TriggerRow) {
    this.disarm(t.id);
    if (!t.enabled) return;
    if (t.kind === 'event') {
      const off = this.core.events.on(t.config.topic, (ev) => {
        if (NEVER_TRIGGER.test(ev.topic)) return;
        if (ev.topic.startsWith('macro.') && ev.data?.macroId === t.macro_id) return; // a macro can't trigger itself
        if (t.config.where && !safeTruthy(t.config.where, { event: ev.data, topic: ev.topic })) return;
        this.fire(t, { ...(ev.data && typeof ev.data === 'object' ? ev.data : { value: ev.data }), topic: ev.topic });
      });
      this.unsubs.set(t.id, off);
    } else if (t.kind === 'file') {
      const dir = t.config.dir;
      if (!dir || !existsSync(dir)) return;
      const re = globToRegExp(t.config.pattern ?? '*');
      const recursive = !!t.config.recursive;
      const settle = Number(t.config.settleMs ?? 800);
      const seen = new Set<string>();
      this.seen.set(t.id, seen);
      const pendingCheck = new Set<string>();
      const list = (d: string, depth = 0): string[] => {
        const out: string[] = [];
        try {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isFile() && re.test(e.name)) out.push(p);
            else if (recursive && e.isDirectory() && depth < 6) out.push(...list(p, depth + 1));
          }
        } catch {
          /* unreadable */
        }
        return out;
      };
      const keyOf = (full: string) => {
        const st = statSync(full);
        return st.isFile() ? `${full}:${st.size}` : null;
      };
      // files already there don't fire
      for (const f of list(dir)) {
        try {
          const k = keyOf(f);
          if (k) seen.add(k);
        } catch {
          /* vanished */
        }
      }
      // a file fires once its size stops changing (downloads, copies in progress)
      const consider = (full: string) => {
        if (pendingCheck.has(full) || !re.test(basename(full))) return;
        let before: string | null;
        try {
          before = existsSync(full) ? keyOf(full) : null;
        } catch {
          return;
        }
        if (!before || seen.has(before)) return;
        pendingCheck.add(full);
        setTimeout(() => {
          pendingCheck.delete(full);
          try {
            const now2 = existsSync(full) ? keyOf(full) : null;
            if (!now2) return;
            if (now2 !== before) return consider(full); // still growing
            if (seen.has(now2)) return;
            seen.add(now2);
            if (seen.size > 20_000) seen.clear();
            this.fire({ ...t, last_fired: null }, { path: full, name: basename(full) }, Date.now(), true);
          } catch {
            /* vanished */
          }
        }, settle);
      };
      try {
        const w = watch(dir, { recursive }, (_ev, name) => {
          if (name) consider(join(dir, String(name)));
        });
        w.on('error', () => {});
        this.watchers.set(t.id, w);
      } catch {
        /* unwatchable: polling below still works */
      }
      // fs.watch misses events on some drives (network shares, some Windows setups): poll as well
      const poll = setInterval(() => list(dir).forEach(consider), Math.max(200, Number(t.config.pollMs ?? 5000)));
      poll.unref?.();
      this.polls.set(t.id, poll);
    }
  }

  private disarm(id: string) {
    this.unsubs.get(id)?.();
    this.unsubs.delete(id);
    const poll = this.polls.get(id);
    if (poll) clearInterval(poll);
    this.polls.delete(id);
    this.queue.delete(id);
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.seen.delete(id);
  }
}

function safeTruthy(cond: string, vars: Vars): boolean {
  try {
    return truthy(cond, vars);
  } catch {
    return false;
  }
}

function validateTrigger(kind: string, config: any) {
  const c = config ?? {};
  switch (kind) {
    case 'schedule':
      if (!(Number(c.every) > 0) && !/^\d{1,2}:\d{2}$/.test(c.at ?? '')) throw new CommandError('invalid_params', 'schedule needs {every: minutes} or {at: "HH:MM", days?: [0-6]}');
      break;
    case 'event':
      if (!c.topic || typeof c.topic !== 'string') throw new CommandError('invalid_params', 'event trigger needs {topic}');
      if (NEVER_TRIGGER.test(c.topic.replace(/\*$/, 'x'))) throw new CommandError('invalid_params', `topic ${c.topic} can't trigger macros`);
      break;
    case 'file':
      if (!c.dir) throw new CommandError('invalid_params', 'file trigger needs {dir, pattern?}');
      if (!existsSync(c.dir)) throw new CommandError('invalid_params', `folder not found: ${c.dir}`);
      break;
    case 'startup':
      break;
    default:
      throw new CommandError('invalid_params', `unknown trigger kind: ${kind}`);
  }
}

/** Is a schedule due? `every` minutes since last fire, or daily `at` HH:MM (local) on `days`. */
export function scheduleDue(config: any, lastFired: number | null, nowMs: number): boolean {
  if (Number(config.every) > 0) {
    const period = Number(config.every) * 60_000;
    return lastFired === null ? true : nowMs - lastFired >= period;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(config.at ?? '');
  if (!m) return false;
  const d = new Date(nowMs);
  if (Array.isArray(config.days) && config.days.length && !config.days.includes(d.getDay())) return false;
  const due = new Date(d);
  due.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (nowMs < due.getTime()) return false;
  return lastFired === null || lastFired < due.getTime();
}

export function globToRegExp(glob: string): RegExp {
  const re = glob.split(/[;,]/).map((g) => g.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('|');
  return new RegExp(`^(${re})$`, 'i');
}

// ------------------------------------------------------------------ module

export function macrosModule(): CoreModule {
  let T: Triggers | null = null;
  let boot: NodeJS.Timeout | null = null;
  return {
    name: 'macros',
    init(core) {
      const M = new Macros(core);
      T = new Triggers(core, M);
      core.services.macros = M;
      core.services.triggers = T;
      // armed after every module registered its commands
      boot = setTimeout(() => T?.start(), 0);
      return macroCommands(core, M, T);
    },
    dispose() {
      if (boot) clearTimeout(boot);
      T?.stop();
      T = null;
    },
  };
}

function macroCommands(core: Core, M: Macros, T: Triggers): CommandDef[] {
  const view = (m: MacroRow) => ({ id: m.id, name: m.name, description: m.definition.description ?? '', steps: m.definition.steps.length, inputs: m.definition.inputs ?? {}, scopes: m.scopes, updatedAt: m.updated_at, triggers: T.list().filter((t) => t.macro_id === m.id).length });
  return [
    {
      id: 'macros.list', title: 'List Macros', scopes: ['macros:read'], palette: false,
      handler: () => M.list().map(view),
    },
    {
      id: 'macros.get', title: 'Get Macro', scopes: ['macros:read'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const m = M.get(a.id);
        return { ...view(m), definition: m.definition };
      },
    },
    {
      id: 'macros.save', title: 'Save Macro', scopes: ['macros:write'], palette: false,
      description: 'Create or replace a macro from a definition {name, description?, inputs?, scopes?, steps}.',
      params: { definition: { type: 'object', required: true, positional: 0 }, id: { type: 'string' } },
      handler: (a) => view(M.save(a.definition, a.id)),
    },
    {
      id: 'macros.delete', title: 'Delete Macro', scopes: ['macros:write'], destructive: true, palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => ({ deleted: M.remove(a.id) }),
    },
    {
      id: 'macros.duplicate', title: 'Duplicate Macro', scopes: ['macros:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, name: { type: 'string' } },
      handler: (a) => {
        const m = M.get(a.id);
        let name = a.name ?? `${m.name} copy`;
        for (let n = 2; !a.name && M.find(name); n++) name = `${m.name} copy ${n}`;
        return view(M.save({ ...m.definition, name }));
      },
    },
    {
      id: 'macros.run', title: 'Run Macro', scopes: ['macros:run'], palette: false,
      params: {
        id: { type: 'string', required: true, positional: 0 },
        inputs: { type: 'object', default: {} },
        wait: { type: 'boolean', default: false, description: 'wait for the run to finish and return its result' },
        tab: { type: 'string', description: 'tab to start in (default: the active tab)' },
      },
      handler: async (a, ctx) => {
        const run = M.start(a.id, a.inputs, { caller: ctx.principal, tab: a.tab });
        if (!a.wait) return run.summary();
        await run.done;
        return { ...run.summary(), log: run.log };
      },
    },
    {
      id: 'macros.runs', title: 'Macro Runs', scopes: ['macros:read'], palette: false,
      params: { macro: { type: 'string', positional: 0 }, limit: { type: 'number', default: 50 } },
      handler: (a) => M.history(a.macro ? M.get(a.macro).id : undefined, a.limit),
    },
    {
      id: 'macros.cancel', title: 'Cancel Macro Run', scopes: ['macros:run'], palette: false,
      params: { run: { type: 'string', positional: 0, description: 'run id; omit to cancel all active runs' } },
      handler: (a) => {
        if (a.run) return { cancelled: M.cancel(a.run) ? 1 : 0 };
        let n = 0;
        for (const r of M.runs.values()) if (M.cancel(r.id)) n++;
        return { cancelled: n };
      },
    },
    {
      id: 'macros.cancelAll', title: 'Stop All Running Macros', scopes: ['macros:run'], shortcut: 'CmdOrCtrl+Shift+Escape',
      handler: () => {
        let n = 0;
        for (const r of M.runs.values()) if (M.cancel(r.id)) n++;
        return { cancelled: n };
      },
    },
    {
      id: 'macros.answer', title: 'Answer Macro Prompt', scopes: ['macros:run'], palette: false,
      params: { run: { type: 'string', required: true, positional: 0 }, value: { type: 'any', required: true, positional: 1 } },
      handler: (a) => ({ ok: M.answer(a.run, a.value) }),
    },
    {
      id: 'macros.resume', title: 'Resume Macro From Checkpoint', scopes: ['macros:run'], palette: false,
      params: { run: { type: 'string', required: true, positional: 0 }, inputs: { type: 'object', default: {} } },
      handler: (a, ctx) => M.resume(a.run, a.inputs, ctx.principal).summary(),
    },
    {
      id: 'macros.record', title: 'Start Recording Macro', scopes: ['macros:write'], shortcut: 'CmdOrCtrl+Shift+R',
      handler: () => {
        if (M.recording) return { recording: true, steps: M.recording.steps.length };
        const rec = M.startRecording();
        core.notify('info', 'Recording macro', 'Click and type in pages. Run "Stop Recording" to finish.', 'macros');
        return { recording: true, steps: rec.steps.length };
      },
    },
    {
      id: 'macros.recordStatus', title: 'Recording Status', scopes: ['macros:read'], palette: false,
      handler: () => ({ recording: !!M.recording, steps: M.recording?.steps ?? [] }),
    },
    {
      id: 'macros.stopRecording', title: 'Stop Recording Macro', scopes: ['macros:write'],
      params: { name: { type: 'string', positional: 0, description: 'save under this name (default: "Recorded <time>")' }, save: { type: 'boolean', default: true } },
      handler: (a) => {
        if (!M.recording) throw new CommandError('failed', 'not recording');
        const steps = M.stopRecording();
        const usesPassword = JSON.stringify(steps).includes('{{password}}');
        const def: MacroDef = {
          name: a.name ?? `Recorded ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          inputs: usesPassword ? { password: { type: 'string', secret: true, required: true, description: 'replaces the password typed while recording' } } : undefined,
          steps,
        };
        if (!a.save) return { definition: def };
        const m = M.save(def);
        return { ...view(m), definition: m.definition };
      },
    },
    {
      id: 'macros.export', title: 'Export Macro', scopes: ['macros:read'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, path: { type: 'string', positional: 1, description: 'write JSON to this file' } },
      handler: async (a, ctx) => {
        const m = M.get(a.id);
        const doc = { sensorMacro: 1, ...m.definition, scopes: m.scopes, triggers: T.list().filter((t) => t.macro_id === m.id).map((t) => ({ kind: t.kind, config: t.config })) };
        if (a.path) {
          if (!hasScope(ctx.principal, 'files:write')) throw new CommandError('forbidden', 'writing an export file needs files:write');
          writeFileSync(a.path, JSON.stringify(doc, null, 2));
          return { path: a.path };
        }
        return doc;
      },
    },
    {
      id: 'macros.import', title: 'Import Macro', scopes: ['macros:write'], palette: false,
      description: 'Import a macro from a JSON file or object. Imported scopes are kept, so review them; triggers are imported disabled.',
      params: { path: { type: 'string', positional: 0 }, definition: { type: 'object' }, rename: { type: 'string' } },
      handler: (a, ctx) => {
        if (a.path && !hasScope(ctx.principal, 'files:read')) throw new CommandError('forbidden', 'reading an import file needs files:read');
        const doc = a.definition ?? (a.path ? JSON.parse(readFileSync(a.path, 'utf8')) : null);
        if (!doc) throw new CommandError('invalid_params', 'path or definition required');
        const { triggers, sensorMacro: _v, ...def } = doc;
        if (a.rename) def.name = a.rename;
        else for (let n = 2, base = def.name; M.find(def.name); n++) def.name = `${base} (${n})`;
        const m = M.save(def);
        for (const t of Array.isArray(triggers) ? triggers : []) {
          try {
            const row = T.add(m.id, t.kind, t.config);
            T.setEnabled(row.id, false);
          } catch {
            /* skip invalid trigger */
          }
        }
        return view(m);
      },
    },
    {
      id: 'macros.ops', title: 'Macro Step Types', scopes: [], palette: false,
      handler: () => Object.entries(STEP_OPS).map(([op, v]) => ({ op, ...v, scopes: OP_SCOPES[op] ?? [] })),
    },
    {
      id: 'macros.panel', title: 'Macros', scopes: ['macros:read'],
      handler: () => ({ leaf: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'macros' }, side: 'right', size: 0.4 }) }),
    },
    // ---- triggers
    {
      id: 'triggers.list', title: 'List Triggers', scopes: ['macros:read'], palette: false,
      params: { macro: { type: 'string', positional: 0 } },
      handler: (a) => {
        const list = T.list();
        const mid = a.macro ? M.get(a.macro).id : null;
        return (mid ? list.filter((t) => t.macro_id === mid) : list).map((t) => ({ ...t, macro: M.find(t.macro_id)?.name ?? null }));
      },
    },
    {
      id: 'triggers.add', title: 'Add Trigger', scopes: ['macros:write'], palette: false,
      description: 'kind=schedule {every|at,days}, event {topic, where?}, file {dir, pattern?, recursive?}, startup. config.inputs maps macro inputs from {{event.*}}.',
      params: {
        macro: { type: 'string', required: true, positional: 0 },
        kind: { type: 'string', required: true, enum: ['schedule', 'event', 'file', 'startup'], positional: 1 },
        config: { type: 'object', default: {} },
      },
      handler: (a) => T.add(a.macro, a.kind, a.config),
    },
    {
      id: 'triggers.remove', title: 'Remove Trigger', scopes: ['macros:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        T.remove(a.id);
        return { ok: true };
      },
    },
    {
      id: 'triggers.enable', title: 'Enable Trigger', scopes: ['macros:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, enabled: { type: 'boolean', default: true } },
      handler: (a) => T.setEnabled(a.id, a.enabled),
    },
    {
      id: 'triggers.fire', title: 'Fire Trigger Now', scopes: ['macros:run'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, data: { type: 'object', default: {} } },
      handler: (a) => {
        const run = T.fire(T.get(a.id), a.data);
        return run ? run.summary() : { skipped: true };
      },
    },
  ];
}
