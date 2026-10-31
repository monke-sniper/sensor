// The agentic development environment: projects, git status/diff, worktrees
// with protected branches, tasks with dependencies and validation, handoffs,
// decisions, coding-agent sessions in terminals, usage, and the Orca bridge.
//
// Agents run as their own CLIs (claude, codex, opencode, ...) inside Sensor
// terminals, with the user's own logins. Sensor never needs an API key here.
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Core, CoreModule } from '../core';
import { CommandError, type CommandDef } from '../commands';
import { now, uid } from '../db';
import { hasScope } from '../permissions';
import { exec, shell, stripAnsi, which } from '../proc';

// ------------------------------------------------------------------ git

export interface GitFile {
  path: string;
  orig?: string;
  index: string; // X
  worktree: string; // Y
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
}

export interface GitStatus {
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  clean: boolean;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): GitStatus {
  const st: GitStatus = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [], clean: true };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) st.oid = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) st.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        st.ahead = Number(m[1]);
        st.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ')) {
      const f = line.split(' ');
      st.files.push({ path: f.slice(8).join(' '), index: f[1][0], worktree: f[1][1], kind: 'changed' });
    } else if (line.startsWith('2 ')) {
      const f = line.split(' ');
      st.files.push({ path: f.slice(9).join(' '), orig: parts[++i], index: f[1][0], worktree: f[1][1], kind: 'renamed' });
    } else if (line.startsWith('u ')) {
      const f = line.split(' ');
      st.files.push({ path: f.slice(10).join(' '), index: f[1][0], worktree: f[1][1], kind: 'unmerged' });
    } else if (line.startsWith('? ')) st.files.push({ path: line.slice(2), index: '?', worktree: '?', kind: 'untracked' });
    else if (line.startsWith('! ')) st.files.push({ path: line.slice(2), index: '!', worktree: '!', kind: 'ignored' });
  }
  st.clean = st.files.every((f) => f.kind === 'ignored');
  return st;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, main: list.length === 0 };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return list;
}

export async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const r = await exec('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout, env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

export function slugify(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'task';
}

// ------------------------------------------------------------------ agents

export interface AgentAdapter {
  id: string;
  name: string;
  cmd: string;
  args?: string[];
  /** how the first prompt is delivered: as CLI args, typed into the terminal, or not at all */
  prompt: 'arg' | 'flag' | 'type' | 'none';
  promptFlag?: string;
  /** where the CLI keeps usage data we can read (best effort) */
  usage?: 'claude' | 'codex';
}

export const AGENT_ADAPTERS: AgentAdapter[] = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude', prompt: 'arg', usage: 'claude' },
  { id: 'codex', name: 'Codex CLI', cmd: 'codex', prompt: 'arg', usage: 'codex' },
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', prompt: 'type' },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', prompt: 'type' },
  { id: 'aider', name: 'Aider', cmd: 'aider', prompt: 'type' },
  { id: 'shell', name: 'Shell', cmd: '', prompt: 'none' },
];

export interface AgentSession {
  id: string;
  agent: string;
  terminal: string;
  cwd: string;
  projectId: string | null;
  taskId: string | null;
  title: string;
  startedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
}

// ------------------------------------------------------------------ usage

export interface UsageDay {
  day: string;
  agent: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

async function* jsonlFiles(root: string, sinceMs: number, depth = 0): AsyncGenerator<string> {
  if (depth > 6 || !existsSync(root)) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p, sinceMs, depth + 1);
    else if (e.name.endsWith('.jsonl')) {
      try {
        if (statSync(p).mtimeMs >= sinceMs) yield p;
      } catch {
        /* vanished */
      }
    }
  }
}

async function eachLine(file: string, fn: (o: any) => void) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length > 5_000_000) continue;
    try {
      fn(JSON.parse(line));
    } catch {
      /* partial line */
    }
  }
}

/**
 * Token usage from the agents' own local logs (no network, no keys):
 * Claude Code transcripts in ~/.claude/projects and Codex sessions in
 * ~/.codex/sessions. Formats are not public contracts, so this is best effort.
 */
export async function readUsage(days: number, roots = { claude: join(homedir(), '.claude', 'projects'), codex: join(homedir(), '.codex', 'sessions') }): Promise<UsageDay[]> {
  const since = Date.now() - days * 86_400_000;
  const acc = new Map<string, UsageDay>();
  const bucket = (agent: string, ts: any) => {
    const d = new Date(typeof ts === 'string' || typeof ts === 'number' ? ts : Date.now());
    if (Number.isNaN(d.getTime()) || d.getTime() < since) return null;
    const day = d.toISOString().slice(0, 10);
    const key = `${agent}:${day}`;
    let u = acc.get(key);
    if (!u) acc.set(key, (u = { day, agent, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }));
    return u;
  };
  const seen = new Set<string>();
  for await (const f of jsonlFiles(roots.claude, since)) {
    await eachLine(f, (o) => {
      const u = o?.message?.usage;
      if (o?.type !== 'assistant' || !u) return;
      const key = `${o.message.id ?? ''}:${o.requestId ?? ''}`;
      if (key !== ':' && seen.has(key)) return; // streamed blocks repeat the same usage
      seen.add(key);
      const b = bucket('claude', o.timestamp);
      if (!b) return;
      b.input += u.input_tokens ?? 0;
      b.output += u.output_tokens ?? 0;
      b.cacheRead += u.cache_read_input_tokens ?? 0;
      b.cacheWrite += u.cache_creation_input_tokens ?? 0;
      b.requests++;
    });
  }
  for await (const f of jsonlFiles(roots.codex, since)) {
    await eachLine(f, (o) => {
      const p = o?.payload;
      if (o?.type !== 'event_msg' || p?.type !== 'token_count') return;
      const u = p.info?.last_token_usage;
      if (!u) return;
      const b = bucket('codex', o.timestamp);
      if (!b) return;
      b.input += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
      b.cacheRead += u.cached_input_tokens ?? 0;
      b.output += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
      b.requests++;
    });
  }
  return [...acc.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent));
}

// ------------------------------------------------------------------ service

export interface Project {
  id: string;
  name: string;
  path: string;
  protected: string[];
  created_at: number;
}

export class Dev {
  sessions = new Map<string, AgentSession>();

  constructor(private core: Core) {
    core.events.on('terminal.exited', (e) => {
      const sid = e.data?.meta?.agentSession;
      const s = sid && this.sessions.get(sid);
      if (!s) return;
      s.exitedAt = now();
      s.exitCode = e.data.exitCode ?? null;
      core.events.emit('agent.exited', { ...s });
      if (s.taskId) this.touchTask(s.taskId, { note: `${s.agent} exited (${s.exitCode})` });
    });
  }

  // ---- projects
  projects(): Project[] {
    return this.core.db.all('SELECT * FROM projects ORDER BY name').map(projectOf);
  }

  project(idOrNameOrPath: string): Project {
    const r = this.core.db.get('SELECT * FROM projects WHERE id = ? OR name = ? OR path = ?', idOrNameOrPath, idOrNameOrPath, resolve(idOrNameOrPath));
    if (!r) throw new CommandError('not_found', `project not found: ${idOrNameOrPath}`);
    return projectOf(r);
  }

  async addProject(path: string, name?: string): Promise<Project> {
    if (!existsSync(path)) throw new CommandError('invalid_params', `folder not found: ${path}`);
    const top = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
    const root = resolve(top);
    const existing = this.core.db.get('SELECT * FROM projects WHERE path = ?', root);
    if (existing) return projectOf(existing);
    const id = uid('prj_');
    let nm = name ?? basename(root);
    for (let n = 2; this.core.db.get('SELECT 1 FROM projects WHERE name = ?', nm); n++) nm = `${name ?? basename(root)}-${n}`;
    this.core.db.run('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)', id, nm, root, now());
    this.core.events.emit('project.added', { id, name: nm, path: root });
    return this.project(id);
  }

  /** Resolve a working directory from project / worktree path / task. */
  cwdFor(a: { project?: string; path?: string; task?: string }): { cwd: string; project: Project | null } {
    if (a.task) {
      const t = this.task(a.task);
      const p = this.project(t.project_id);
      return { cwd: t.worktree && existsSync(t.worktree) ? t.worktree : p.path, project: p };
    }
    if (a.path) {
      const abs = resolve(a.path);
      const p = this.projects().find((x) => abs === x.path || abs.startsWith(x.path + '/') || abs.startsWith(x.path + '\\') || abs.startsWith(this.worktreeRoot(x) + '/') || abs.startsWith(this.worktreeRoot(x) + '\\')) ?? null;
      return { cwd: abs, project: p };
    }
    if (a.project) {
      const p = this.project(a.project);
      return { cwd: p.path, project: p };
    }
    throw new CommandError('invalid_params', 'project, path or task is required');
  }

  /** Sensor puts worktrees next to the repo: <parent>/<name>.worktrees/<branch>. */
  worktreeRoot(p: Project): string {
    return join(dirname(p.path), `${basename(p.path)}.worktrees`);
  }

  isProtected(p: Project | null, branch: string | null): boolean {
    if (!p || !branch) return false;
    return p.protected.includes(branch);
  }

  async status(cwd: string): Promise<GitStatus> {
    return parseStatusV2(await git(cwd, ['status', '--porcelain=v2', '--branch', '-z']));
  }

  async worktrees(p: Project): Promise<Worktree[]> {
    return parseWorktrees(await git(p.path, ['worktree', 'list', '--porcelain']));
  }

  async addWorktree(p: Project, branch: string, base?: string, path?: string): Promise<Worktree> {
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new CommandError('invalid_params', `invalid branch name: ${branch}`);
    if (this.isProtected(p, branch)) throw new CommandError('forbidden', `${branch} is protected; worktrees get their own branches`);
    const dest = path ? resolve(path) : join(this.worktreeRoot(p), branch.replace(/[\\/]/g, '-'));
    if (existsSync(dest)) throw new CommandError('failed', `already exists: ${dest}`);
    mkdirSync(dirname(dest), { recursive: true });
    const exists = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: p.path });
    if (exists.code === 0) await git(p.path, ['worktree', 'add', dest, branch]);
    else await git(p.path, ['worktree', 'add', '-b', branch, dest, ...(base ? [base] : [])]);
    const wt = (await this.worktrees(p)).find((w) => resolve(w.path) === resolve(dest));
    this.core.events.emit('worktree.created', { project: p.id, path: dest, branch });
    return wt ?? { path: dest, head: null, branch, detached: false, bare: false, locked: false, prunable: false, main: false };
  }

  // ---- tasks
  task(id: string): any {
    const t = this.core.db.get('SELECT * FROM tasks WHERE id = ?', id);
    if (!t) throw new CommandError('not_found', `task not found: ${id}`);
    return taskOf(t);
  }

  tasks(projectId?: string, state?: string): any[] {
    let sql = 'SELECT * FROM tasks';
    const where: string[] = [];
    const args: any[] = [];
    if (projectId) {
      where.push('project_id = ?');
      args.push(projectId);
    }
    if (state) {
      where.push('state = ?');
      args.push(state);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    return this.core.db.all(`${sql} ORDER BY created_at`, ...args).map(taskOf);
  }

  touchTask(id: string, patch: { state?: string; agent?: string | null; worktree?: string | null; branch?: string | null; note?: string; validation?: any }) {
    const t = this.task(id);
    const validation = patch.validation !== undefined ? patch.validation : t.validation;
    const log = [...(t.log ?? [])];
    if (patch.note) log.push({ t: now(), note: patch.note });
    this.core.db.run(
      'UPDATE tasks SET state = ?, agent = ?, worktree = ?, branch = ?, validation = ?, updated_at = ? WHERE id = ?',
      patch.state ?? t.state, patch.agent !== undefined ? patch.agent : t.agent, patch.worktree !== undefined ? patch.worktree : t.worktree,
      patch.branch !== undefined ? patch.branch : t.branch, JSON.stringify({ ...(validation ?? {}), log: log.slice(-100) }), now(), id,
    );
    const nt = this.task(id);
    this.core.events.emit('task.changed', nt);
    return nt;
  }

  blockedBy(t: any): string[] {
    return (t.depends_on as string[]).filter((d) => {
      const dep = this.core.db.get('SELECT state FROM tasks WHERE id = ?', d);
      return dep && dep.state !== 'done';
    });
  }

  // ---- agents
  adapters(): AgentAdapter[] {
    const custom = this.core.settings.get<AgentAdapter[]>('agents.custom') ?? [];
    return [...AGENT_ADAPTERS, ...(Array.isArray(custom) ? custom : [])];
  }

  adapter(id: string): AgentAdapter {
    const a = this.adapters().find((x) => x.id === id);
    if (!a) throw new CommandError('invalid_params', `unknown agent: ${id} (known: ${this.adapters().map((x) => x.id).join(', ')})`);
    return a;
  }

  startAgent(opts: { agent: string; cwd: string; prompt?: string; project: Project | null; taskId?: string | null; title?: string }): AgentSession {
    const T = this.core.terminals;
    if (!T || !T.available()) throw new CommandError('failed', 'terminals are not available');
    const ad = this.adapter(opts.agent);
    const id = uid('agt_');
    const terminal = uid('term_');
    let cmd: string | undefined = ad.cmd || undefined;
    let args = [...(ad.args ?? [])];
    if (cmd) {
      const resolved = which(cmd);
      if (!resolved) throw new CommandError('failed', `${ad.name} not found on PATH (${cmd}). Install it or set a custom agent in settings "agents.custom".`);
      cmd = resolved;
    }
    if (opts.prompt && ad.prompt === 'arg') args.push(opts.prompt);
    if (opts.prompt && ad.prompt === 'flag' && ad.promptFlag) args.push(ad.promptFlag, opts.prompt);
    const title = opts.title ?? `${ad.name}${opts.project ? ` · ${opts.project.name}` : ''}`;
    T.spawn({ id: terminal, cwd: opts.cwd, cmd, args: cmd ? args : undefined, title, meta: { agentSession: id, agent: ad.id }, env: { SENSOR_AGENT_SESSION: id } });
    if (opts.prompt && ad.prompt === 'type') {
      // TUIs need a moment before they accept input
      setTimeout(() => {
        try {
          T.write(terminal, opts.prompt!.replace(/\r?\n/g, ' ') + '\r');
        } catch {
          /* exited */
        }
      }, 2500);
    }
    const s: AgentSession = { id, agent: ad.id, terminal, cwd: opts.cwd, projectId: opts.project?.id ?? null, taskId: opts.taskId ?? null, title, startedAt: now(), exitedAt: null, exitCode: null };
    this.sessions.set(id, s);
    this.core.events.emit('agent.started', { ...s });
    return s;
  }

  session(id: string): AgentSession {
    const s = this.sessions.get(id);
    if (!s) throw new CommandError('not_found', `agent session not found: ${id}`);
    return s;
  }
}

function projectOf(r: any): Project {
  return { id: r.id, name: r.name, path: r.path, protected: JSON.parse(r.protected_branches ?? '[]'), created_at: r.created_at };
}

function taskOf(r: any) {
  const v = r.validation ? JSON.parse(r.validation) : {};
  const { log, ...validation } = v ?? {};
  return { ...r, depends_on: JSON.parse(r.depends_on ?? '[]'), validation: Object.keys(validation).length ? validation : null, log: log ?? [] };
}

const TASK_STATES = ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];

// ------------------------------------------------------------------ Orca

/** Orca's own CLI, found on PATH or via settings "orca.cliPath". */
async function orcaCli(core: Core, args: string[]): Promise<any> {
  const bin = core.settings.get<string>('orca.cliPath') || which('orca');
  if (!bin) throw new CommandError('failed', 'Orca CLI not found. Install Orca (github.com/stablyai/orca) and its "orca" command, or set orca.cliPath.');
  const r = await exec(bin, [...args, '--json'], { timeout: 120_000 });
  const text = r.stdout.trim();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (r.code !== 0) throw new CommandError('failed', `orca ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || text).trim().slice(0, 400)}`);
  return data;
}

// ------------------------------------------------------------------ module

export const devModule: CoreModule = {
  name: 'dev',
  init(core) {
    const D = new Dev(core);
    core.services.dev = D;
    core.search.addSource({
      name: 'projects',
      search: (q, limit) => {
        const ql = q.toLowerCase();
        return D.projects()
          .filter((p) => p.name.toLowerCase().includes(ql) || p.path.toLowerCase().includes(ql))
          .slice(0, limit)
          .map((p) => ({ uri: `sensor://project/${p.id}`, source: 'projects', title: `Project: ${p.name}`, snippet: p.path, score: p.name.toLowerCase().startsWith(ql) ? 0.9 : 0.6 }));
      },
    });
    return devCommands(core, D);
  },
};

function devCommands(core: Core, D: Dev): CommandDef[] {
  const loc = { project: { type: 'string' as const, positional: 0 }, path: { type: 'string' as const, description: 'repo or worktree folder' }, task: { type: 'string' as const } };
  const needDestructive = (ctx: any, what: string) => {
    if (ctx.principal.kind !== 'user' && !hasScope(ctx.principal, 'git:destructive')) throw new CommandError('forbidden', `${what} needs git:destructive`);
  };
  return [
    // ---- projects
    {
      id: 'projects.list', title: 'List Projects', scopes: ['projects:read'], palette: false,
      handler: () => D.projects(),
    },
    {
      id: 'projects.add', title: 'Add Project', scopes: ['projects:write'],
      params: { path: { type: 'string', required: true, positional: 0 }, name: { type: 'string' } },
      handler: (a) => D.addProject(a.path, a.name),
    },
    {
      id: 'projects.remove', title: 'Remove Project', scopes: ['projects:write'], palette: false,
      description: 'Forget a project (files are not touched).',
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const p = D.project(a.id);
        core.db.run('DELETE FROM projects WHERE id = ?', p.id);
        return { removed: p.id };
      },
    },
    {
      id: 'projects.protect', title: 'Set Protected Branches', scopes: ['projects:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, branches: { type: 'array', required: true, positional: 1 } },
      handler: (a, ctx) => {
        const p = D.project(a.id);
        const removed = p.protected.filter((b) => !a.branches.includes(b));
        if (removed.length) needDestructive(ctx, `unprotecting ${removed.join(', ')}`);
        core.db.run('UPDATE projects SET protected_branches = ? WHERE id = ?', JSON.stringify(a.branches), p.id);
        return D.project(p.id);
      },
    },
    {
      id: 'projects.open', title: 'Open Project', scopes: ['projects:read'], palette: false,
      params: { id: { type: 'string', positional: 0 } },
      handler: (a) => ({ leaf: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'projects', state: a.id ? { project: D.project(a.id).id } : {} }, side: 'right', size: 0.45 }) }),
    },
    {
      id: 'projects.panel', title: 'Projects & Agents', scopes: ['projects:read'],
      handler: () => ({ leaf: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'projects' }, side: 'right', size: 0.45 }) }),
    },
    {
      id: 'projects.overview', title: 'Project Overview', scopes: ['projects:read'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: async (a) => {
        const p = D.project(a.id);
        const [status, worktrees] = await Promise.all([D.status(p.path).catch((e) => ({ error: e.message })), D.worktrees(p).catch(() => [])]);
        const wts = await Promise.all(
          worktrees.map(async (w) => ({ ...w, protected: D.isProtected(p, w.branch), status: existsSync(w.path) ? await D.status(w.path).catch(() => null) : null })),
        );
        return {
          project: p, status, worktrees: wts,
          tasks: D.tasks(p.id),
          decisions: core.db.all('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC', p.id),
          agents: [...D.sessions.values()].filter((s) => s.projectId === p.id),
        };
      },
    },
    // ---- git
    {
      id: 'git.status', title: 'Git Status', scopes: ['projects:read'], palette: false,
      params: loc,
      handler: async (a) => {
        const { cwd, project } = D.cwdFor(a);
        const st = await D.status(cwd);
        return { cwd, ...st, protected: D.isProtected(project, st.branch) };
      },
    },
    {
      id: 'git.diff', title: 'Git Diff', scopes: ['projects:read'], palette: false,
      params: { ...loc, staged: { type: 'boolean', default: false }, file: { type: 'string' }, stat: { type: 'boolean', default: false }, against: { type: 'string', description: 'compare against a ref, e.g. main' } },
      handler: async (a) => {
        const { cwd } = D.cwdFor(a);
        const args = ['diff', '--no-color', '--no-ext-diff'];
        if (a.staged) args.push('--cached');
        if (a.stat) args.push('--stat');
        if (a.against) args.push(`${a.against}...HEAD`);
        if (a.file) args.push('--', a.file);
        const out = await git(cwd, args);
        return { cwd, diff: out.length > 2_000_000 ? out.slice(0, 2_000_000) + '\n… (truncated)' : out };
      },
    },
    {
      id: 'git.log', title: 'Git Log', scopes: ['projects:read'], palette: false,
      params: { ...loc, limit: { type: 'number', default: 30 }, ref: { type: 'string' } },
      handler: async (a) => {
        const { cwd } = D.cwdFor(a);
        const out = await git(cwd, ['log', `-n${Math.min(a.limit, 500)}`, '--pretty=format:%H%x1f%an%x1f%at%x1f%s', ...(a.ref ? [a.ref] : [])]);
        return out.split('\n').filter(Boolean).map((l) => {
          const [hash, author, at, subject] = l.split('\x1f');
          return { hash, author, at: Number(at) * 1000, subject };
        });
      },
    },
    {
      id: 'git.branches', title: 'Git Branches', scopes: ['projects:read'], palette: false,
      params: loc,
      handler: async (a) => {
        const { cwd, project } = D.cwdFor(a);
        const out = await git(cwd, ['for-each-ref', '--format=%(refname:short)%x1f%(objectname:short)%x1f%(committerdate:unix)%x1f%(upstream:short)', 'refs/heads']);
        return out.split('\n').filter(Boolean).map((l) => {
          const [name, oid, at, upstream] = l.split('\x1f');
          return { name, oid, at: Number(at) * 1000, upstream: upstream || null, protected: D.isProtected(project, name) };
        });
      },
    },
    {
      id: 'git.worktrees', title: 'List Worktrees', scopes: ['projects:read'], palette: false,
      params: { project: { type: 'string', required: true, positional: 0 } },
      handler: async (a) => {
        const p = D.project(a.project);
        return (await D.worktrees(p)).map((w) => ({ ...w, protected: D.isProtected(p, w.branch) }));
      },
    },
    {
      id: 'git.worktreeAdd', title: 'Create Worktree', scopes: ['projects:write'], palette: false,
      params: { project: { type: 'string', required: true, positional: 0 }, branch: { type: 'string', required: true, positional: 1 }, base: { type: 'string' }, path: { type: 'string' } },
      handler: (a) => D.addWorktree(D.project(a.project), a.branch, a.base, a.path),
    },
    {
      id: 'git.worktreeRemove', title: 'Remove Worktree', scopes: ['projects:write', 'git:destructive'], destructive: true, palette: false,
      params: { project: { type: 'string', required: true, positional: 0 }, path: { type: 'string', required: true, positional: 1 }, force: { type: 'boolean', default: false }, deleteBranch: { type: 'boolean', default: false } },
      handler: async (a) => {
        const p = D.project(a.project);
        const wt = (await D.worktrees(p)).find((w) => resolve(w.path) === resolve(a.path));
        if (!wt) throw new CommandError('not_found', `not a worktree of ${p.name}: ${a.path}`);
        if (wt.main) throw new CommandError('forbidden', 'the main worktree cannot be removed');
        await git(p.path, ['worktree', 'remove', ...(a.force ? ['--force'] : []), wt.path]);
        if (a.deleteBranch && wt.branch && !D.isProtected(p, wt.branch)) await git(p.path, ['branch', a.force ? '-D' : '-d', wt.branch]);
        core.events.emit('worktree.removed', { project: p.id, path: wt.path, branch: wt.branch });
        return { removed: wt.path, branchDeleted: !!(a.deleteBranch && wt.branch) };
      },
    },
    {
      id: 'git.commit', title: 'Commit', scopes: ['projects:write'], palette: false,
      params: { ...loc, message: { type: 'string', required: true }, all: { type: 'boolean', default: true } },
      handler: async (a, ctx) => {
        const { cwd, project } = D.cwdFor(a);
        const st = await D.status(cwd);
        if (D.isProtected(project, st.branch)) needDestructive(ctx, `committing directly to protected branch ${st.branch}`);
        if (a.all) await git(cwd, ['add', '-A']);
        await git(cwd, ['commit', '-m', a.message]);
        const hash = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
        core.events.emit('git.committed', { cwd, branch: st.branch, hash });
        return { hash, branch: st.branch };
      },
    },
    {
      id: 'git.merge', title: 'Merge Branch', scopes: ['projects:write'], palette: false,
      description: 'Merge a branch into another (default: the main worktree branch). Merging into a protected branch needs git:destructive, which asks for approval.',
      params: { project: { type: 'string', required: true, positional: 0 }, branch: { type: 'string', required: true, positional: 1 }, into: { type: 'string' }, noFf: { type: 'boolean', default: true } },
      handler: async (a, ctx) => {
        const p = D.project(a.project);
        const wts = await D.worktrees(p);
        const into = a.into ?? wts.find((w) => w.main)?.branch;
        if (!into) throw new CommandError('failed', 'could not determine target branch');
        if (D.isProtected(p, into)) await ctx.run('git.approveProtected', { project: p.id, branch: into, action: `merge ${a.branch}` });
        const target = wts.find((w) => w.branch === into);
        if (!target) throw new CommandError('failed', `${into} is not checked out in any worktree`);
        const st = await D.status(target.path);
        if (!st.clean && st.files.some((f) => f.kind !== 'untracked')) throw new CommandError('failed', `${into} worktree has uncommitted changes`);
        const r = await exec('git', ['merge', ...(a.noFf ? ['--no-ff'] : []), '--no-edit', a.branch], { cwd: target.path, env: { GIT_TERMINAL_PROMPT: '0' } });
        if (r.code !== 0) {
          const conflicts = (await D.status(target.path)).files.filter((f) => f.kind === 'unmerged').map((f) => f.path);
          await exec('git', ['merge', '--abort'], { cwd: target.path });
          throw new CommandError('failed', conflicts.length ? `merge conflicts in: ${conflicts.join(', ')} (merge aborted)` : (r.stderr || r.stdout).trim());
        }
        const hash = (await git(target.path, ['rev-parse', 'HEAD'])).trim();
        core.events.emit('git.merged', { project: p.id, branch: a.branch, into, hash });
        return { merged: a.branch, into, hash };
      },
    },
    {
      id: 'git.approveProtected', title: 'Approve Protected Branch Change', scopes: ['git:destructive'], palette: false,
      description: 'Gate for writes to protected branches; callers without git:destructive are asked for approval.',
      params: { project: { type: 'string', required: true }, branch: { type: 'string', required: true }, action: { type: 'string', required: true } },
      handler: (a) => ({ approved: true, branch: a.branch, action: a.action }),
    },
    {
      id: 'git.push', title: 'Push Branch', scopes: ['projects:write'], palette: false,
      params: { ...loc, remote: { type: 'string', default: 'origin' }, branch: { type: 'string' }, setUpstream: { type: 'boolean', default: true } },
      handler: async (a, ctx) => {
        const { cwd, project } = D.cwdFor(a);
        const branch = a.branch ?? (await D.status(cwd)).branch;
        if (!branch) throw new CommandError('failed', 'detached HEAD: pass branch');
        if (D.isProtected(project, branch)) await ctx.run('git.approveProtected', { project: project!.id, branch, action: 'push' });
        await git(cwd, ['push', ...(a.setUpstream ? ['-u'] : []), a.remote, branch], 300_000);
        return { pushed: branch, remote: a.remote };
      },
    },
    // ---- tasks
    {
      id: 'tasks.list', title: 'List Tasks', scopes: ['projects:read'], palette: false,
      params: { project: { type: 'string', positional: 0 }, state: { type: 'string', enum: TASK_STATES } },
      handler: (a) => D.tasks(a.project ? D.project(a.project).id : undefined, a.state).map((t) => ({ ...t, blockedBy: D.blockedBy(t) })),
    },
    {
      id: 'tasks.create', title: 'Create Task', scopes: ['projects:write'], palette: false,
      params: {
        project: { type: 'string', required: true, positional: 0 }, title: { type: 'string', required: true, positional: 1 }, body: { type: 'string' },
        dependsOn: { type: 'array', default: [] }, validate: { type: 'string', description: 'command that must pass, e.g. "npm test"' }, agent: { type: 'string' },
      },
      handler: (a) => {
        const p = D.project(a.project);
        for (const d of a.dependsOn) D.task(d);
        const id = uid('tsk_');
        const t = now();
        core.db.run(
          'INSERT INTO tasks (id, project_id, title, body, state, agent, depends_on, validation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, p.id, a.title, a.body ?? null, 'todo', a.agent ?? null, JSON.stringify(a.dependsOn), JSON.stringify(a.validate ? { command: a.validate } : {}), t, t,
        );
        const task = D.task(id);
        core.events.emit('task.changed', task);
        return task;
      },
    },
    {
      id: 'tasks.update', title: 'Update Task', scopes: ['projects:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, title: { type: 'string' }, body: { type: 'string' }, state: { type: 'string', enum: TASK_STATES }, agent: { type: 'string' }, validate: { type: 'string' }, dependsOn: { type: 'array' }, note: { type: 'string' } },
      handler: (a) => {
        const t = D.task(a.id);
        if (a.title !== undefined || a.body !== undefined || a.dependsOn !== undefined) {
          for (const d of a.dependsOn ?? []) if (d === t.id) throw new CommandError('invalid_params', 'a task cannot depend on itself');
          core.db.run('UPDATE tasks SET title = ?, body = ?, depends_on = ? WHERE id = ?', a.title ?? t.title, a.body ?? t.body, JSON.stringify(a.dependsOn ?? t.depends_on), t.id);
        }
        return D.touchTask(t.id, { state: a.state, agent: a.agent, note: a.note, validation: a.validate !== undefined ? { ...(t.validation ?? {}), command: a.validate } : undefined });
      },
    },
    {
      id: 'tasks.delete', title: 'Delete Task', scopes: ['projects:write'], destructive: true, palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        D.task(a.id);
        core.db.run('DELETE FROM tasks WHERE id = ?', a.id);
        core.db.run('DELETE FROM handoffs WHERE task_id = ?', a.id);
        core.events.emit('task.deleted', { id: a.id });
        return { deleted: a.id };
      },
    },
    {
      id: 'tasks.start', title: 'Start Task', scopes: ['projects:write', 'agents:control', 'terminals:write'], palette: false,
      description: 'Create a worktree + branch for the task and launch an agent in it with the task as its prompt.',
      params: { id: { type: 'string', required: true, positional: 0 }, agent: { type: 'string' }, base: { type: 'string' }, worktree: { type: 'boolean', default: true }, panel: { type: 'boolean', default: true } },
      handler: async (a) => {
        const t = D.task(a.id);
        const blocked = D.blockedBy(t);
        if (blocked.length) throw new CommandError('failed', `blocked by unfinished task(s): ${blocked.join(', ')}`);
        const p = D.project(t.project_id);
        let cwd = t.worktree && existsSync(t.worktree) ? t.worktree : p.path;
        let branch = t.branch;
        if (a.worktree && !(t.worktree && existsSync(t.worktree))) {
          branch = `sensor/${slugify(t.title, 32)}-${t.id.slice(-4)}`;
          const wt = await D.addWorktree(p, branch, a.base);
          cwd = wt.path;
        }
        const agent = a.agent ?? t.agent ?? core.settings.get<string>('agents.default') ?? 'claude';
        const decisions = core.db.all('SELECT text FROM decisions WHERE project_id = ? ORDER BY created_at', p.id).map((d) => `- ${d.text}`);
        const prompt = [
          `Task: ${t.title}`,
          t.body ? `\n${t.body}` : '',
          t.validation?.command ? `\nDone means \`${t.validation.command}\` passes.` : '',
          decisions.length ? `\nProject decisions to respect:\n${decisions.join('\n')}` : '',
          branch ? `\nYou are on branch ${branch} in a dedicated worktree. Do not touch protected branches (${p.protected.join(', ')}).` : '',
        ].join('');
        const s = D.startAgent({ agent, cwd, prompt, project: p, taskId: t.id, title: `${agent} · ${t.title}` });
        if (a.panel) core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'terminal', state: { id: s.terminal } }, side: 'bottom', size: 0.4 });
        const task = D.touchTask(t.id, { state: 'in_progress', agent, worktree: cwd === p.path ? null : cwd, branch, note: `started ${agent} (${s.id})` });
        return { task, session: s };
      },
    },
    {
      id: 'tasks.validate', title: 'Validate Task', scopes: ['projects:write', 'scripts:exec'], palette: false,
      description: "Run the task's validation command in its worktree; passing moves it to review.",
      params: { id: { type: 'string', required: true, positional: 0 }, timeout: { type: 'number', default: 600_000 } },
      handler: async (a) => {
        const t = D.task(a.id);
        const cmd = t.validation?.command;
        if (!cmd) throw new CommandError('failed', 'task has no validation command');
        const cwd = t.worktree && existsSync(t.worktree) ? t.worktree : D.project(t.project_id).path;
        const started = now();
        const r = await shell(cmd, { cwd, timeout: a.timeout });
        const passed = r.code === 0;
        const result = { command: cmd, passed, code: r.code, ms: now() - started, at: now(), output: stripAnsi((r.stdout + '\n' + r.stderr).trim()).slice(-8000) };
        D.touchTask(t.id, { state: passed ? 'review' : t.state === 'todo' ? 'todo' : 'in_progress', validation: { ...t.validation, last: result }, note: `validation ${passed ? 'passed' : `failed (${r.code})`}` });
        core.events.emit('task.validated', { id: t.id, passed });
        return result;
      },
    },
    {
      id: 'tasks.complete', title: 'Complete Task', scopes: ['projects:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, merge: { type: 'boolean', default: false }, into: { type: 'string' } },
      handler: async (a, ctx) => {
        const t = D.task(a.id);
        let merged: any = null;
        if (a.merge) {
          if (!t.branch) throw new CommandError('failed', 'task has no branch to merge');
          merged = await ctx.run('git.merge', { project: t.project_id, branch: t.branch, into: a.into });
        }
        const task = D.touchTask(t.id, { state: 'done', note: merged ? `merged into ${merged.into}` : 'completed' });
        return { task, merged };
      },
    },
    // ---- handoffs & decisions
    {
      id: 'handoffs.create', title: 'Create Handoff', scopes: ['projects:write'], palette: false,
      params: { task: { type: 'string', required: true, positional: 0 }, message: { type: 'string', required: true, positional: 1 }, to: { type: 'string', description: 'agent id' }, from: { type: 'string' }, launch: { type: 'boolean', default: false } },
      handler: async (a, ctx) => {
        const t = D.task(a.task);
        const id = uid('hof_');
        core.db.run('INSERT INTO handoffs (id, task_id, from_agent, to_agent, message, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, t.id, a.from ?? t.agent, a.to ?? null, a.message, 'open', now());
        D.touchTask(t.id, { note: `handoff ${a.from ?? t.agent ?? '?'} → ${a.to ?? 'anyone'}` });
        const h = core.db.get('SELECT * FROM handoffs WHERE id = ?', id);
        core.events.emit('handoff.created', h);
        if (a.launch && a.to) return { handoff: h, accepted: await ctx.run('handoffs.accept', { id, launch: true }) };
        return h;
      },
    },
    {
      id: 'handoffs.list', title: 'List Handoffs', scopes: ['projects:read'], palette: false,
      params: { task: { type: 'string', positional: 0 }, state: { type: 'string', enum: ['open', 'accepted', 'closed'] } },
      handler: (a) => {
        const rows = core.db.all('SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 500');
        return rows.filter((h) => (!a.task || h.task_id === a.task) && (!a.state || h.state === a.state));
      },
    },
    {
      id: 'handoffs.accept', title: 'Accept Handoff', scopes: ['projects:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, launch: { type: 'boolean', default: false } },
      handler: async (a, ctx) => {
        const h = core.db.get('SELECT * FROM handoffs WHERE id = ?', a.id);
        if (!h) throw new CommandError('not_found', 'handoff not found');
        core.db.run("UPDATE handoffs SET state = 'accepted' WHERE id = ?", h.id);
        let session = null;
        if (a.launch && h.to_agent) {
          const t = D.task(h.task_id);
          const { cwd, project } = D.cwdFor({ task: t.id });
          await ctx.run('agents.start', { agent: h.to_agent, path: cwd, prompt: `Handoff from ${h.from_agent ?? 'previous agent'} on task "${t.title}":\n${h.message}`, task: t.id, project: project?.id });
          session = [...D.sessions.values()].pop() ?? null;
          D.touchTask(t.id, { agent: h.to_agent });
        }
        return { ...h, state: 'accepted', session };
      },
    },
    {
      id: 'decisions.add', title: 'Record Decision', scopes: ['projects:write'], palette: false,
      params: { project: { type: 'string', required: true, positional: 0 }, text: { type: 'string', required: true, positional: 1 } },
      handler: (a) => {
        const p = D.project(a.project);
        const id = uid('dec_');
        core.db.run('INSERT INTO decisions (id, project_id, text, created_at) VALUES (?, ?, ?, ?)', id, p.id, a.text, now());
        return core.db.get('SELECT * FROM decisions WHERE id = ?', id);
      },
    },
    {
      id: 'decisions.list', title: 'List Decisions', scopes: ['projects:read'], palette: false,
      params: { project: { type: 'string', required: true, positional: 0 } },
      handler: (a) => core.db.all('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC', D.project(a.project).id),
    },
    {
      id: 'decisions.remove', title: 'Remove Decision', scopes: ['projects:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => ({ removed: core.db.run('DELETE FROM decisions WHERE id = ?', a.id).changes > 0 }),
    },
    // ---- agents
    {
      id: 'agents.available', title: 'Available Agents', scopes: ['agents:read'], palette: false,
      handler: () => D.adapters().map((ad) => ({ id: ad.id, name: ad.name, cmd: ad.cmd, installed: ad.cmd ? !!which(ad.cmd) : true, prompt: ad.prompt, usage: !!ad.usage })),
    },
    {
      id: 'agents.start', title: 'Start Agent', scopes: ['agents:control', 'terminals:write'], palette: false,
      params: {
        agent: { type: 'string', positional: 0, description: 'claude, codex, opencode, gemini, aider, shell or a custom id' },
        project: { type: 'string' }, path: { type: 'string', description: 'working folder' }, task: { type: 'string' },
        prompt: { type: 'string' },
        panel: { type: 'boolean', default: true },
      },
      handler: (a) => {
        const { cwd, project } = a.project || a.path || a.task ? D.cwdFor(a) : { cwd: homedir(), project: null };
        const s = D.startAgent({ agent: a.agent ?? core.settings.get<string>('agents.default') ?? 'claude', cwd, prompt: a.prompt, project, taskId: a.task ?? null });
        if (a.panel) core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'terminal', state: { id: s.terminal } }, side: 'bottom', size: 0.4 });
        return s;
      },
    },
    {
      id: 'agents.list', title: 'Agent Sessions', scopes: ['agents:read'], palette: false,
      params: { project: { type: 'string', positional: 0 }, running: { type: 'boolean', default: false } },
      handler: (a) => {
        const pid = a.project ? D.project(a.project).id : null;
        return [...D.sessions.values()].filter((s) => (!pid || s.projectId === pid) && (!a.running || s.exitedAt === null));
      },
    },
    {
      id: 'agents.send', title: 'Send To Agent', scopes: ['agents:control'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, text: { type: 'string', required: true, positional: 1 }, enter: { type: 'boolean', default: true } },
      handler: (a) => {
        const s = D.session(a.id);
        core.terminals!.write(s.terminal, a.text + (a.enter ? '\r' : ''));
        return { ok: true };
      },
    },
    {
      id: 'agents.read', title: 'Read Agent Output', scopes: ['agents:read'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, tail: { type: 'number', default: 8000 } },
      handler: (a) => {
        const s = D.session(a.id);
        const out = core.terminals?.output(s.terminal);
        return { ...s, output: out ? stripAnsi(out.buffer.slice(-a.tail)) : '' };
      },
    },
    {
      id: 'agents.stop', title: 'Stop Agent', scopes: ['agents:control'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const s = D.session(a.id);
        core.terminals?.kill(s.terminal);
        if (s.exitedAt === null) {
          s.exitedAt = now();
          core.events.emit('agent.exited', { ...s });
        }
        return { stopped: s.id };
      },
    },
    {
      id: 'agents.usage', title: 'Agent Usage', scopes: ['agents:read'], palette: false,
      description: "Token usage read from the agents' own local logs (Claude Code, Codex). Best effort.",
      params: { days: { type: 'number', default: 7 } },
      handler: async (a) => {
        const rows = await readUsage(Math.min(a.days, 90));
        const totals: Record<string, any> = {};
        for (const r of rows) {
          const t = (totals[r.agent] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
          t.input += r.input;
          t.output += r.output;
          t.cacheRead += r.cacheRead;
          t.cacheWrite += r.cacheWrite;
          t.requests += r.requests;
        }
        return { days: a.days, totals, daily: rows };
      },
    },
    // ---- Orca bridge (external companion app)
    {
      id: 'orca.status', title: 'Orca Status', scopes: ['agents:read'], palette: false,
      handler: async () => {
        const bin = core.settings.get<string>('orca.cliPath') || which('orca');
        if (!bin) return { installed: false, note: 'Install Orca and its CLI to orchestrate agents there.' };
        try {
          return { installed: true, cli: bin, status: await orcaCli(core, ['status']) };
        } catch (e: any) {
          return { installed: true, cli: bin, error: e.message };
        }
      },
    },
    {
      id: 'orca.open', title: 'Open Orca', scopes: ['agents:control'],
      handler: () => orcaCli(core, ['open']),
    },
    {
      id: 'orca.addProject', title: 'Add Project To Orca', scopes: ['agents:control'], palette: false,
      params: { project: { type: 'string', required: true, positional: 0 } },
      handler: (a) => orcaCli(core, ['repo', 'add', '--path', D.project(a.project).path]),
    },
    {
      id: 'orca.worktrees', title: 'Orca Worktrees', scopes: ['agents:read'], palette: false,
      params: { project: { type: 'string', positional: 0 } },
      handler: (a) => orcaCli(core, ['worktree', 'list', ...(a.project ? ['--repo', `path:${D.project(a.project).path}`] : [])]),
    },
    {
      id: 'orca.createWorktree', title: 'Create Orca Worktree With Agent', scopes: ['agents:control', 'projects:write'], palette: false,
      params: { project: { type: 'string', required: true, positional: 0 }, name: { type: 'string', required: true, positional: 1 }, agent: { type: 'string' }, prompt: { type: 'string' }, base: { type: 'string' } },
      handler: (a) =>
        orcaCli(core, [
          'worktree', 'create', '--name', a.name, '--repo', `path:${D.project(a.project).path}`,
          ...(a.agent ? ['--agent', a.agent] : []), ...(a.prompt ? ['--prompt', a.prompt] : []), ...(a.base ? ['--base-branch', a.base] : []),
        ]),
    },
    {
      id: 'orca.launchAgent', title: 'Launch Agent In Orca', scopes: ['agents:control'], palette: false,
      params: { agent: { type: 'string', required: true, positional: 0 }, path: { type: 'string', required: true, positional: 1 }, prompt: { type: 'string' } },
      handler: (a) => orcaCli(core, ['agent', 'launch', '--agent', a.agent, '--worktree', `path:${resolve(a.path)}`, ...(a.prompt ? ['--prompt', a.prompt] : [])]),
    },
  ];
}
