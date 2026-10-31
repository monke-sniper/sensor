import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { spawn as spawnProc, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCore, tempDir } from './helpers';
import { allModules } from '../../src/core/modules';
import { Core } from '../../src/core/core';
import { nullBrowserHost, type BrowserHost, type TerminalHost } from '../../src/core/host';
import { evaluate, interpolate, truthy } from '../../src/core/services/macro-lang';
import { scheduleDue, globToRegExp } from '../../src/core/services/macros';
import { parseStatusV2, parseWorktrees, readUsage } from '../../src/core/services/dev';
import { verifySlot } from '../../src/core/services/backup';
import type { Principal } from '../../src/core/permissions';

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

/** A scriptable browser: records calls, answers selectors from a fake DOM. */
function fakeBrowser(dom: Record<string, string> = {}) {
  const calls: any[] = [];
  const host: BrowserHost = {
    ...nullBrowserHost(),
    isLive: () => true,
    waitFor: async (_t, sels) => {
      const s = sels.find((x) => x in dom || x === 'body');
      if (!s) throw new Error(`timed out waiting for: ${sels.join(' | ')}`);
      return s;
    },
    click: async (t, sels) => void calls.push({ op: 'click', t, sel: sels[0] }),
    type: async (t, sels, text, opts) => void calls.push({ op: 'type', t, sel: sels[0], text, clear: !!opts?.clear }),
    press: async (t, key) => void calls.push({ op: 'press', t, key }),
    setFiles: async (t, sel, files) => void calls.push({ op: 'files', t, sel, files }),
    exec: async (_t, js) => {
      calls.push({ op: 'exec', js: js.slice(0, 80) });
      const m = /const sel = "([^"]+)"/.exec(js);
      if (m) return [dom[m[1]] ?? ''];
      if (js.includes('const A =')) return [{ role: 'user', text: 'What is 2+2?' }, { role: 'assistant', text: '4' }];
      if (js.includes('querySelector(s)')) return dom.__sendReady ? 'button[data-testid="send-button"]' : null;
      return null;
    },
    readPage: async (t) => ({ url: 'https://example.com/', title: 'Example', content: '# Example page' }),
    selection: async () => 'selected words',
  };
  return { host, calls };
}

function setup(opts: { browser?: BrowserHost; terminals?: TerminalHost } = {}) {
  const c = makeCore({ modules: allModules(), browser: opts.browser, terminals: opts.terminals ?? null });
  cleanups.push(c.cleanup);
  return c;
}

const token = (scopes: string[]): Principal => ({ kind: 'token', id: 't1', name: 'test', scopes: scopes as any });

describe('macro language', () => {
  it('evaluates expressions safely', () => {
    const v = { n: 3, title: 'Invoice #12', items: ['a', 'b'], user: { name: 'Sam' } };
    expect(evaluate('n > 2 && title contains "invoice"', v)).toBe(true);
    expect(evaluate('items.length == 2', v)).toBe(true);
    expect(evaluate('items[1] + "-" + user.name', v)).toBe('b-Sam');
    expect(evaluate('(n + 1) * 2', v)).toBe(8);
    expect(evaluate('missing.deep.path', v)).toBeUndefined();
    expect(evaluate('constructor', v)).toBeUndefined();
    expect(evaluate('title matches "#\\\\d+"', v)).toBe(true);
    expect(evaluate('items | join:"+" | upper', v)).toBe('A+B');
    expect(() => evaluate('a; b', v)).toThrow();
    expect(truthy('{{ items }}', v)).toBe(true);
    expect(truthy('not n', v)).toBe(false);
  });

  it('interpolates templates and keeps types for whole-value templates', () => {
    const v = { q: 'rust book', list: [1, 2], o: { a: 1 } };
    expect(interpolate('https://x.test/?q={{ q | urlencode }}', v)).toBe('https://x.test/?q=rust%20book');
    expect(interpolate('{{list}}', v)).toEqual([1, 2]);
    expect(interpolate({ a: ['{{o.a}}', 'n={{list | length}}'] }, v)).toEqual({ a: [1, 'n=2'] });
    expect(interpolate('{{nothing}}!', v)).toBe('!');
  });

  it('schedules and globs', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime(); // a Monday 09:00 local
    expect(scheduleDue({ every: 15 }, null, base)).toBe(true);
    expect(scheduleDue({ every: 15 }, base, base + 10 * 60_000)).toBe(false);
    expect(scheduleDue({ every: 15 }, base, base + 15 * 60_000)).toBe(true);
    expect(scheduleDue({ at: '08:30' }, null, base)).toBe(true);
    expect(scheduleDue({ at: '08:30' }, base - 60_000, base)).toBe(false);
    expect(scheduleDue({ at: '10:00' }, null, base)).toBe(false);
    expect(scheduleDue({ at: '08:30', days: [0, 6] }, null, base)).toBe(false);
    expect(globToRegExp('*.pdf;*.PNG').test('Report.pdf')).toBe(true);
    expect(globToRegExp('*.pdf').test('a.pdf.part')).toBe(false);
  });
});

describe('macros', () => {
  it('runs browser steps, control flow and outputs through the command bus', async () => {
    const { host, calls } = fakeBrowser({ '#q': '', 'button.go': '', '.result': 'Top result' });
    const { core } = setup({ browser: host });
    await core.run('macros.save', {
      definition: {
        name: 'search',
        inputs: { term: { type: 'string', default: 'sensor' } },
        steps: [
          { op: 'open', url: 'https://search.test/' },
          { op: 'type', selectors: ['#missing', '#q'], text: '{{term}}', clear: true },
          { op: 'click', selector: 'button.go' },
          { op: 'extract', selector: '.result', save: 'top' },
          { op: 'if', cond: 'top contains "result"', then: [{ op: 'set', var: 'found', value: true }], else: [{ op: 'fail', message: 'no result' }] },
          { op: 'loop', over: ['a', 'b', 'c'], as: 'x', steps: [{ op: 'if', cond: 'x == "c"', then: [{ op: 'break' }] }, { op: 'set', var: 'last', value: '{{x}}' }] },
          { op: 'output', name: 'summary', value: '{{term}}: {{top}} ({{last}})' },
        ],
      },
    });
    const info = await core.run('macros.get', { id: 'search' });
    expect(info.scopes).toEqual(expect.arrayContaining(['tabs:write', 'page:interact', 'page:read']));
    const run = await core.run('macros.run', { id: 'search', inputs: { term: 'rust' }, wait: true });
    expect(run.state).toBe('completed');
    expect(run.outputs.summary).toBe('rust: Top result (b)');
    const typed = calls.find((c) => c.op === 'type');
    expect(typed).toMatchObject({ sel: '#q', text: 'rust', clear: true });
    expect(calls.find((c) => c.op === 'click').sel).toBe('button.go');
    const hist = await core.run('macros.runs', { macro: 'search' });
    expect(hist[0].state).toBe('completed');
  });

  it('retries, continues on error, and jumps to labels', async () => {
    const { host } = fakeBrowser({});
    const { core } = setup({ browser: host });
    await core.run('macros.save', {
      definition: {
        name: 'errs',
        steps: [
          { op: 'open', url: 'https://x.test/' },
          { op: 'click', selector: '#nope', timeout: 10, retry: 1, retryDelay: 5, onError: 'continue' },
          { op: 'click', selector: '#nope', timeout: 10, onError: 'goto:recover' },
          { op: 'output', name: 'skipped', value: 'should not run' },
          { op: 'output', label: 'recover', name: 'recovered', value: '{{lastError | default:"none"}}' },
        ],
      },
    });
    const run = await core.run('macros.run', { id: 'errs', wait: true });
    expect(run.state).toBe('completed');
    expect(run.outputs.skipped).toBeUndefined();
    expect(run.outputs.recovered).toContain('timed out');
    expect(run.log.some((l: any) => l.status === 'retry')).toBe(true);
  });

  it('never runs with more scopes than its caller', async () => {
    const { host } = fakeBrowser({ '#a': '' });
    const { core } = setup({ browser: host });
    await core.run('macros.save', { definition: { name: 'clicker', steps: [{ op: 'open', url: 'https://x.test/' }, { op: 'click', selector: '#a' }] } });
    const run = await core.bus.run('macros.run', { id: 'clicker', wait: true }, token(['macros:run', 'tabs:write']));
    expect(run.state).toBe('failed');
    expect(run.error).toMatch(/lacks scope\(s\): page:interact/);
    const ok = await core.bus.run('macros.run', { id: 'clicker', wait: true }, token(['macros:run', 'tabs:write', 'page:interact', 'page:read']));
    expect(ok.state).toBe('completed');
  });

  it('asks for input, keeps secrets out of storage, can be cancelled', async () => {
    const { host } = fakeBrowser({ '#pw': '' });
    const { core } = setup({ browser: host });
    await core.run('macros.save', {
      definition: {
        name: 'login',
        inputs: { password: { type: 'string', secret: true } },
        steps: [
          { op: 'open', url: 'https://x.test/' },
          { op: 'input', var: 'user', prompt: 'User name?' },
          { op: 'type', selector: '#pw', text: '{{password}}' },
          { op: 'log', message: 'typed {{password}} for {{user}}' },
        ],
      },
    });
    const waiting = new Promise<any>((r) => core.events.once('macro.waiting', (e) => r(e.data)));
    const started = await core.run('macros.run', { id: 'login', inputs: { password: 'hunter2' } });
    const w = await waiting;
    expect(w.prompt).toBe('User name?');
    await core.run('macros.answer', { run: started.id, value: 'sam' });
    const done = await core.services.macros.runs.get(started.id).done;
    expect(done.state).toBe('completed');
    const row = core.db.get('SELECT log, outputs FROM macro_runs WHERE id = ?', started.id)!;
    expect(row.log + row.outputs).not.toContain('hunter2');
    expect(row.log).toContain('typed ••• for sam');

    await core.run('macros.save', { definition: { name: 'slow', steps: [{ op: 'wait', ms: 5000 }] } });
    const slow = await core.run('macros.run', { id: 'slow' });
    await core.run('macros.cancel', { run: slow.id });
    expect((await core.services.macros.runs.get(slow.id).done).state).toBe('cancelled');
  });

  it('resumes from the last checkpoint and calls other macros', async () => {
    const { core } = setup();
    await core.run('macros.save', { definition: { name: 'child', inputs: { x: { type: 'number' } }, steps: [{ op: 'output', name: 'double', value: '{{x * 2}}' }] } });
    await core.run('macros.save', {
      definition: {
        name: 'parent',
        steps: [
          { op: 'call', macro: 'child', args: { x: 21 }, save: 'c' },
          { op: 'set', var: 'stage', value: 'one' },
          { op: 'checkpoint' },
          { op: 'assert', cond: 'ok == true', message: 'not ok yet' },
          { op: 'output', name: 'r', value: '{{c.double}}-{{stage}}' },
        ],
      },
    });
    const first = await core.run('macros.run', { id: 'parent', wait: true });
    expect(first.state).toBe('failed');
    expect(first.error).toContain('not ok yet');
    const resumed = await core.run('macros.resume', { run: first.id, inputs: { ok: true } });
    const done = await core.services.macros.runs.get(resumed.id).done;
    expect(done.state).toBe('completed');
    expect(done.outputs.r).toBe('42-one');
    // the child step ran once (before the checkpoint), not again on resume
    expect(done.log.find((l: any) => l.op === 'call')).toBeUndefined();
  });

  it('turns recorded actions into steps', async () => {
    const { core } = setup();
    core.workspaces.openTab({ url: 'https://shop.test/' });
    const tab = core.workspaces.active().activeTab!;
    await core.run('macros.record');
    const M = core.services.macros;
    M.recordStep(tab, { op: 'type', selectors: ['#q'], text: 'sh', url: 'https://shop.test/' });
    M.recordStep(tab, { op: 'type', selectors: ['#q'], text: 'shoes', url: 'https://shop.test/' });
    M.recordStep(tab, { op: 'press', key: 'Enter', url: 'https://shop.test/' });
    M.recordStep(tab, { op: 'click', selectors: ['text=Red shoes', 'a.item'], label: 'Red shoes', url: 'https://shop.test/search?q=shoes' });
    M.recordStep(tab, { op: 'type', selectors: ['#pw'], text: '{{password}}', url: 'https://shop.test/login' });
    M.recordStep(tab, { op: 'click', selectors: ['#orders'], url: 'https://shop.test/account' }); // typed URL, not caused by a click
    const saved = await core.run('macros.stopRecording', { name: 'buy shoes' });
    const ops = saved.definition.steps.map((s: any) => s.op);
    expect(ops).toEqual(['open', 'type', 'press', 'click', 'type', 'navigate', 'click']);
    expect(saved.definition.steps[1].text).toBe('shoes');
    expect(saved.definition.inputs.password.secret).toBe(true);
    const exported = await core.run('macros.export', { id: 'buy shoes' });
    const imported = await core.run('macros.import', { definition: exported });
    expect(imported.name).toBe('buy shoes (2)');
  });
});

describe('triggers', () => {
  /** On CI, print state as an annotation if a trigger test stalls (raw CI logs aren't always readable). */
  function watchdog(core: Core, label: string, extra: () => any = () => ({})) {
    const t = setTimeout(() => {
      if (!process.env.GITHUB_ACTIONS) return;
      const runs = [...core.services.macros.runs.values()].map((r: any) => ({ macro: r.macro.name, state: r.state, error: r.error, trigger: r.trigger }));
      const info = JSON.stringify({ runs, triggers: core.services.triggers.list().map((x: any) => ({ kind: x.kind, last: x.last_fired })), ...extra() });
      process.stdout.write(`\n::warning title=${label} stalled::${info.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}\n`);
    }, 8000);
    cleanups.push(() => clearTimeout(t));
  }

  it('fires on matching events only', async () => {
    const { core } = setup();
    watchdog(core, 'event trigger');
    await core.run('macros.save', { definition: { name: 'echo', steps: [{ op: 'output', name: 'got', value: '{{path | default:topic}}' }] } });
    await core.run('triggers.add', { macro: 'echo', kind: 'event', config: { topic: 'download.completed', where: 'event.path endsWith ".pdf"' } });
    const done = new Promise<any>((r) => core.events.once('macro.completed', (e) => r(e.data)));
    core.events.emit('download.completed', { path: '/tmp/a.txt' }); // filtered out
    core.events.emit('download.completed', { path: '/tmp/b.pdf' });
    expect((await done).outputs.got).toBe('/tmp/b.pdf');
    await expect(core.run('triggers.add', { macro: 'echo', kind: 'event', config: { topic: 'macro.step' } })).rejects.toThrow(/can't trigger/);
  }, 20000);

  it('fires on schedule', async () => {
    const { core } = setup();
    await core.run('macros.save', { definition: { name: 'tick', steps: [] } });
    const sched = await core.run('triggers.add', { macro: 'tick', kind: 'schedule', config: { every: 60 } });
    const fired = core.services.triggers.tick(Date.now());
    expect(fired).toContain(sched.id);
    expect(core.services.triggers.tick(Date.now() + 1000)).not.toContain(sched.id);
  });

  it('fires once per new file, queueing arrivals during a run', async () => {
    const { core } = setup();
    const inbox = tempDir('inbox-');
    writeFileSync(join(inbox, 'already.csv'), 'old'); // present before the trigger: never fires
    const files: string[] = [];
    watchdog(core, 'file trigger', () => ({ inbox, listing: require('node:fs').readdirSync(inbox), files }));
    await core.run('macros.save', { definition: { name: 'slowfile', steps: [{ op: 'wait', ms: 150 }, { op: 'output', name: 'file', value: '{{name}}' }] } });
    await core.run('triggers.add', { macro: 'slowfile', kind: 'file', config: { dir: inbox, pattern: '*.csv', settleMs: 50, pollMs: 200 } });
    const allDone = new Promise<void>((r) => core.events.on('macro.completed', (e) => {
      if (e.data.macro !== 'slowfile') return;
      files.push(e.data.outputs.file);
      if (files.length === 2) r();
    }));
    writeFileSync(join(inbox, 'ignore.txt'), 'x');
    writeFileSync(join(inbox, 'data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(inbox, 'more.csv'), 'a,b\n3,4\n'); // arrives while the first run is busy: queued, not dropped
    await allDone;
    expect(files.sort()).toEqual(['data.csv', 'more.csv']);
  }, 20000);
});

// ------------------------------------------------------------------ dev env

function gitRepo(): string {
  const dir = tempDir('repo-');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return dir;
}

/** Terminal host on plain child processes (no PTY needed for tests). */
function fakeTerminals(): TerminalHost & { started: any[] } {
  const procs = new Map<string, any>();
  const started: any[] = [];
  return {
    started,
    available: () => true,
    spawn(opts) {
      started.push(opts);
      const p = spawnProc(process.execPath, ['-e', 'process.stdin.on("data", d => process.stdout.write("echo:" + d))'], { cwd: opts.cwd });
      const st = { p, buffer: '', exited: false, exitCode: null as number | null };
      p.stdout.on('data', (d) => (st.buffer += d));
      procs.set(opts.id, st);
    },
    write(id, data) {
      procs.get(id).p.stdin.write(data);
    },
    resize() {},
    kill(id) {
      procs.get(id)?.p.kill();
    },
    output(id) {
      const s = procs.get(id);
      return s ? { buffer: s.buffer, exited: s.exited, exitCode: s.exitCode } : null;
    },
  };
}

describe('dev environment', () => {
  it('parses git porcelain output', () => {
    const st = parseStatusV2(
      ['# branch.oid abc', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b src/x.ts', '2 R. N... 100644 100644 100644 a b R100 new name.ts', 'old.ts', '? notes.txt', ''].join('\0'),
    );
    expect(st).toMatchObject({ branch: 'feat', ahead: 2, behind: 1, clean: false });
    expect(st.files.map((f) => f.path)).toEqual(['src/x.ts', 'new name.ts', 'notes.txt']);
    expect(st.files[1].orig).toBe('old.ts');
    const wts = parseWorktrees('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r.worktrees/x\nHEAD 2\nbranch refs/heads/x\nlocked\n');
    expect(wts[0]).toMatchObject({ main: true, branch: 'main' });
    expect(wts[1]).toMatchObject({ main: false, branch: 'x', locked: true });
  });

  it('manages projects, worktrees, protected merges and tasks', async () => {
    const repo = gitRepo();
    const terms = fakeTerminals();
    const { core } = setup({ terminals: terms });
    const p = await core.run('projects.add', { path: repo });
    expect(p.protected).toEqual(['main', 'master']);
    const st = await core.run('git.status', { project: p.id });
    expect(st).toMatchObject({ branch: 'main', clean: true, protected: true });

    await expect(core.run('git.worktreeAdd', { project: p.id, branch: 'main' })).rejects.toThrow(/protected/);
    const wt = await core.run('git.worktreeAdd', { project: p.id, branch: 'feat/a' });
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
    writeFileSync(join(wt.path, 'a.txt'), 'hello\n');
    const commit = await core.run('git.commit', { path: wt.path, message: 'add a' });
    expect(commit.branch).toBe('feat/a');
    const diff = await core.run('git.diff', { path: wt.path, against: 'main', stat: true });
    expect(diff.diff).toContain('a.txt');

    // an API token without git:destructive can't merge into main (no approval in tests)
    await expect(core.bus.run('git.merge', { project: p.id, branch: 'feat/a' }, token(['projects:write', 'projects:read']))).rejects.toThrow(/git:destructive/);
    const merged = await core.run('git.merge', { project: p.id, branch: 'feat/a' });
    expect(merged.into).toBe('main');
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);

    const t1 = await core.run('tasks.create', { project: p.id, title: 'Write parser', validate: 'node -e "process.exit(0)"' });
    const t2 = await core.run('tasks.create', { project: p.id, title: 'Use parser', dependsOn: [t1.id] });
    await expect(core.run('tasks.start', { id: t2.id, agent: 'shell', panel: false })).rejects.toThrow(/blocked/);
    const started = await core.run('tasks.start', { id: t1.id, agent: 'shell', panel: false });
    expect(started.task.state).toBe('in_progress');
    expect(started.task.branch).toMatch(/^sensor\/write-parser-/);
    expect(existsSync(started.task.worktree)).toBe(true);
    expect(terms.started[0].cwd).toBe(started.task.worktree);

    await core.run('agents.send', { id: started.session.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 300));
    const out = await core.run('agents.read', { id: started.session.id });
    expect(out.output).toContain('echo:hi');

    const v = await core.run('tasks.validate', { id: t1.id });
    expect(v.passed).toBe(true);
    expect((await core.run('tasks.list', { project: p.id })).find((t: any) => t.id === t1.id).state).toBe('review');
    await core.run('tasks.complete', { id: t1.id });
    const list = await core.run('tasks.list', { project: p.id });
    expect(list.find((t: any) => t.id === t2.id).blockedBy).toEqual([]);

    await core.run('decisions.add', { project: p.id, text: 'Use node:sqlite, no native modules' });
    const h = await core.run('handoffs.create', { task: t2.id, message: 'parser API is in src/parse.ts', to: 'codex' });
    expect(h.state).toBe('open');
    const overview = await core.run('projects.overview', { id: p.id });
    expect(overview.worktrees.length).toBe(3);
    expect(overview.decisions[0].text).toContain('node:sqlite');
    await core.run('agents.stop', { id: started.session.id });
  });

  it('reads agent usage from local logs', async () => {
    const root = tempDir('usage-');
    const claude = join(root, 'claude', 'proj');
    const codex = join(root, 'codex', '2026', '10');
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    const ts = new Date().toISOString();
    const msg = { type: 'assistant', timestamp: ts, requestId: 'r1', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } };
    writeFileSync(join(claude, 's.jsonl'), [msg, msg, { type: 'user', timestamp: ts }].map((o) => JSON.stringify(o)).join('\n'));
    writeFileSync(join(codex, 'rollout.jsonl'), JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 9, reasoning_output_tokens: 1 } } } }));
    const rows = await readUsage(2, { claude: join(root, 'claude'), codex: join(root, 'codex') });
    const c = rows.find((r) => r.agent === 'claude')!;
    expect(c).toMatchObject({ input: 10, output: 5, cacheRead: 100, cacheWrite: 7, requests: 1 });
    const x = rows.find((r) => r.agent === 'codex')!;
    expect(x).toMatchObject({ input: 30, cacheRead: 20, output: 10 });
  });
});

describe('AI website workflows', () => {
  it('seeds providers, inserts text and files, and gates submit behind forms:submit', async () => {
    const { host, calls } = fakeBrowser({ '#prompt-textarea': '', 'button[data-testid="send-button"]': '', __sendReady: '1' });
    const { core } = setup({ browser: host });
    const providers = await core.run('ai.providers');
    expect(providers.map((p: any) => p.name)).toEqual(['ChatGPT', 'Claude', 'Perplexity', 'Gemini']);
    const file = join(tempDir('att-'), 'doc.pdf');
    writeFileSync(file, '%PDF-1.4');
    const r = await core.run('ai.send', { provider: 'chatgpt', text: 'Summarise this', files: [file], target: 'tab' });
    expect(r).toMatchObject({ provider: 'ChatGPT', files: 1, submitted: false });
    expect(calls.find((c) => c.op === 'files')).toMatchObject({ sel: 'input[type=file]', files: [file] });
    expect(calls.find((c) => c.op === 'type')).toMatchObject({ sel: '#prompt-textarea', text: 'Summarise this' });
    expect(calls.some((c) => c.op === 'click')).toBe(false); // never sends unless asked

    const scopes = ['ai:send', 'tabs:write', 'page:interact', 'page:read', 'files:read'];
    await expect(core.bus.run('ai.send', { provider: 'chatgpt', text: 'x', submit: true }, token(scopes))).rejects.toThrow(/forms:submit/);
    const sent = await core.bus.run('ai.send', { provider: 'chatgpt', text: 'x', submit: true }, token([...scopes, 'forms:submit']));
    expect(sent.submitted).toBe(true);
    expect(calls.filter((c) => c.op === 'click').pop().sel).toBe('button[data-testid="send-button"]');

    await core.run('prompts.save', { name: 'tldr', body: 'TL;DR in 3 bullets:\n\n{{text}}' });
    await core.run('ai.send', { provider: 'claude', fromSelection: true, prompt: 'tldr', target: 'tab' }).catch(() => {});
    // claude's composer isn't in the fake DOM: the error explains the likely cause
    await expect(core.run('ai.send', { provider: 'claude', text: 'x', timeout: 50 })).rejects.toThrow(/logged in/);
  });

  it('captures a conversation into a note', async () => {
    const { host } = fakeBrowser({});
    const { core } = setup({ browser: host });
    const vault = tempDir('vault-');
    mkdirSync(join(vault, '.obsidian'));
    await core.run('notes.addVault', { path: vault });
    core.workspaces.openTab({ url: 'https://chatgpt.com/c/123' });
    core.workspaces.updateTab(core.workspaces.active().activeTab!, { title: 'Math help - ChatGPT' }, false);
    const note = await core.run('ai.capture', {});
    expect(note.turns).toBe(2);
    const text = readFileSync(join(vault, note.path), 'utf8');
    expect(text).toContain('### You\n\nWhat is 2+2?');
    expect(text).toContain('### ChatGPT\n\n4');
    expect(text).toContain('https://chatgpt.com/c/123');
  });
});

describe('checkpoints', () => {
  it('rotates two slots, verifies them, and restores at next start', async () => {
    const dir = tempDir('data-');
    const extra = tempDir('extra-');
    writeFileSync(join(extra, 'config.json'), '{"a":1}');
    let core = new Core({ dataDir: dir, modules: allModules() });
    await core.run('settings.set', { key: 'backup.include', value: [extra] });
    await core.run('bookmarks.add', { url: 'https://before.test/', title: 'Before' });
    const a = await core.run('backup.now');
    const b = await core.run('backup.now');
    expect(new Set([a.slot, b.slot]).size).toBe(2);
    const c = await core.run('backup.now');
    expect(c.slot).toBe(a.slot); // oldest slot reused
    const list = await core.run('backup.list');
    expect(list.slots.every((s: any) => s.valid)).toBe(true);
    const ver = await core.run('backup.verify');
    expect(ver.every((v: any) => v.ok)).toBe(true);

    // corrupting a slot makes it fail verification and blocks restoring it
    const slotB = list.slots.find((s: any) => s.slot === b.slot).dir;
    writeFileSync(join(slotB, 'core.db'), 'garbage');
    expect(verifySlot(slotB).ok).toBe(false);
    await expect(core.run('backup.restore', { slot: b.slot })).rejects.toThrow(/verification/);

    await core.run('bookmarks.add', { url: 'https://after.test/', title: 'After' });
    writeFileSync(join(extra, 'config.json'), '{"a":2}');
    const staged = await core.run('backup.restore', { slot: c.slot });
    expect(staged.restartRequired).toBe(true);
    core.dispose();

    core = new Core({ dataDir: dir, modules: allModules() });
    const urls = (await core.run('bookmarks.list')).map((x: any) => x.url);
    expect(urls).toContain('https://before.test/');
    expect(urls).not.toContain('https://after.test/');
    expect(readFileSync(join(extra, 'config.json'), 'utf8')).toBe('{"a":1}');
    expect(existsSync(join(dir, 'core.db.before-restore'))).toBe(true);
    core.dispose();
  });
});

describe('user scripts', () => {
  it('run in a worker through the command bus, limited to their scopes', async () => {
    const { core } = setup();
    await core.run('scripts.save', {
      name: 'count-tabs',
      code: `// @name Count tabs\n// @scopes tabs:read, tabs:write\nmodule.exports = async (sensor, args) => {\n  await sensor.run('tabs.open', { url: 'https://example.com/' + args.n });\n  const tabs = await sensor.run('tabs.list');\n  console.log('tabs', tabs.length);\n  return { tabs: tabs.length };\n};\n`,
    });
    const list = await core.run('scripts.list');
    expect(list.scripts[0]).toMatchObject({ name: 'count-tabs', title: 'Count tabs', scopes: ['tabs:read', 'tabs:write'] });
    const r = await core.run('scripts.run', { name: 'count-tabs', args: { n: 7 } });
    expect(r.result.tabs).toBeGreaterThanOrEqual(1);
    expect(r.logs[0]).toMatch(/^tabs \d+/);
    expect(core.workspaces.allTabs().some((t) => t.url === 'https://example.com/7')).toBe(true);

    // beyond its declared scopes it is refused (no approval in tests)
    await core.run('scripts.save', { name: 'sneaky', code: `// @scopes tabs:read\nmodule.exports = async (sensor) => sensor.run('history.clear');\n` });
    await expect(core.run('scripts.run', { name: 'sneaky' })).rejects.toThrow(/lacks scope\(s\): history:write/);
    // an API token needs scripts:exec, and passes on only what it has
    await expect(core.bus.run('scripts.run', { name: 'count-tabs' }, token(['tabs:read', 'tabs:write']))).rejects.toThrow(/scripts:exec/);
    await expect(core.bus.run('scripts.run', { name: 'count-tabs', args: { n: 1 } }, token(['scripts:exec', 'tabs:read']))).rejects.toThrow(/tabs:write/);
    // runaway scripts are stopped
    await core.run('scripts.save', { name: 'loop', code: `module.exports = () => new Promise(() => {});\n` });
    await expect(core.run('scripts.run', { name: 'loop', timeout: 300 })).rejects.toThrow(/timed out/);
  });
});
