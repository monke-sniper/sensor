// Integrated terminals: ConPTY on Windows / PTY elsewhere via node-pty
// (prebuilt N-API binaries), rendered with xterm.js in the shell.
import { ipcMain } from 'electron';
import { homedir } from 'node:os';
import type { Core, CoreModule } from '../core/core';
import type { CommandDef } from '../core/commands';
import type { TerminalHost } from '../core/host';
import { uid } from '../core/db';
import type { MainRefs } from './modules';

interface Term {
  id: string;
  title: string;
  cwd: string;
  cmd: string;
  args: string[];
  pty: any;
  buffer: string;
  exited: boolean;
  exitCode: number | null;
  startedAt: number;
  meta: Record<string, any>;
}

const MAX_BUFFER = 256 * 1024;

export function defaultShell(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd: process.env.SENSOR_SHELL || 'powershell.exe', args: ['-NoLogo'] };
  }
  return { cmd: process.env.SENSOR_SHELL || process.env.SHELL || 'bash', args: ['-l'] };
}

export class Terminals implements TerminalHost {
  terms = new Map<string, Term>();
  private pty: any = null;
  private loadError: string | null = null;

  constructor(private core: Core, private send: (payload: any) => void) {
    try {
      this.pty = require('@lydell/node-pty');
    } catch (e: any) {
      this.loadError = e.message;
    }
  }

  available(): boolean {
    return !!this.pty;
  }

  spawn(opts: { id: string; cwd: string; cmd?: string; args?: string[]; env?: Record<string, string>; cols?: number; rows?: number; title?: string; meta?: Record<string, any> }): void {
    if (!this.pty) throw new Error(`terminals unavailable: ${this.loadError}`);
    const sh = defaultShell();
    const cmd = opts.cmd ?? sh.cmd;
    const args = opts.args ?? (opts.cmd ? [] : sh.args);
    const p = this.pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, TERM_PROGRAM: 'Sensor', SENSOR_TERMINAL: opts.id },
      useConpty: true,
    });
    const t: Term = { id: opts.id, title: opts.title ?? cmd, cwd: opts.cwd, cmd, args, pty: p, buffer: '', exited: false, exitCode: null, startedAt: Date.now(), meta: opts.meta ?? {} };
    this.terms.set(t.id, t);
    p.onData((d: string) => {
      t.buffer += d;
      if (t.buffer.length > MAX_BUFFER) t.buffer = t.buffer.slice(-MAX_BUFFER);
      this.send({ id: t.id, data: d });
      this.core.events.emit('terminal.output', { id: t.id, bytes: d.length });
    });
    p.onExit((e: { exitCode: number }) => {
      t.exited = true;
      t.exitCode = e.exitCode;
      this.send({ id: t.id, exit: e.exitCode });
      this.core.events.emit('terminal.exited', { id: t.id, exitCode: e.exitCode, meta: t.meta });
    });
    this.core.events.emit('terminal.opened', { id: t.id, title: t.title, cwd: t.cwd });
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id);
    if (!t || t.exited) throw new Error(`terminal not running: ${id}`);
    t.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (t && !t.exited) t.pty.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
  }

  kill(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (!t.exited) t.pty.kill();
    this.terms.delete(id);
    this.core.events.emit('terminal.closed', { id });
  }

  info(t: Term) {
    return { id: t.id, title: t.title, cwd: t.cwd, cmd: t.cmd, args: t.args, exited: t.exited, exitCode: t.exitCode, startedAt: t.startedAt, meta: t.meta, pid: t.pty?.pid };
  }

  dispose(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

/** Strip ANSI escape sequences for API consumers. */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[()][A-Z0-9]|\u001b[=>]/g, '');
}

export function terminalsModule(refs: () => MainRefs): CoreModule {
  let T: Terminals;
  const mod: CoreModule = {
    name: 'terminals',
    init(core) {
      T = new Terminals(core, (payload) => {
        const { win } = refs();
        if (win && !win.isDestroyed()) win.webContents.send('sensor:terminal', payload);
      });
      core.terminals = T;
      core.services.terminals = T;
      ipcMain.on('sensor:terminal-input', (_e, { id, data }) => {
        try {
          T.write(id, data);
        } catch {
          /* exited */
        }
      });
      ipcMain.on('sensor:terminal-resize', (_e, { id, cols, rows }) => T.resize(id, cols, rows));
      return terminalCommands(core, T);
    },
    dispose() {
      T?.dispose();
    },
  };
  return mod;
}

function terminalCommands(core: Core, T: Terminals): CommandDef[] {
  return [
    {
      id: 'terminals.list', title: 'List Terminals', scopes: ['terminals:read'], palette: false,
      handler: () => [...T.terms.values()].map((t) => T.info(t)),
    },
    {
      id: 'terminals.open', title: 'New Terminal', scopes: ['terminals:write'], shortcut: 'CmdOrCtrl+`',
      params: {
        cwd: { type: 'string', positional: 0 },
        cmd: { type: 'string', description: 'program to run instead of the default shell' },
        args: { type: 'array' },
        title: { type: 'string' },
        panel: { type: 'boolean', default: true },
        side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], default: 'bottom' },
      },
      handler: (a) => {
        const id = uid('term_');
        const cwd = a.cwd ?? core.settings.get<string>('terminals.defaultCwd') ?? homedir();
        T.spawn({ id, cwd, cmd: a.cmd, args: a.args, title: a.title });
        let leaf: string | undefined;
        if (a.panel) leaf = core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'terminal', state: { id } }, side: a.side, size: 0.35 });
        return { id, leaf, cwd };
      },
    },
    {
      id: 'terminals.send', title: 'Send To Terminal', scopes: ['terminals:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, data: { type: 'string', required: true, positional: 1 }, enter: { type: 'boolean', default: false } },
      handler: (a) => {
        T.write(a.id, a.data + (a.enter ? '\r' : ''));
        return { ok: true };
      },
    },
    {
      id: 'terminals.read', title: 'Read Terminal Output', scopes: ['terminals:read'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, tail: { type: 'number', default: 8000 }, raw: { type: 'boolean', default: false } },
      handler: (a) => {
        const t = T.terms.get(a.id);
        if (!t) throw new Error('terminal not found');
        const out = t.buffer.slice(-a.tail);
        return { ...T.info(t), output: a.raw ? out : stripAnsi(out) };
      },
    },
    {
      id: 'terminals.buffer', title: 'Terminal Buffer', scopes: ['terminals:read'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const t = T.terms.get(a.id);
        return t ? { ...T.info(t), buffer: t.buffer } : null;
      },
    },
    {
      id: 'terminals.resize', title: 'Resize Terminal', scopes: ['terminals:write'], palette: false,
      params: { id: { type: 'string', required: true }, cols: { type: 'number', required: true }, rows: { type: 'number', required: true } },
      handler: (a) => T.resize(a.id, a.cols, a.rows),
    },
    {
      id: 'terminals.kill', title: 'Kill Terminal', scopes: ['terminals:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        T.kill(a.id);
        return { ok: true };
      },
    },
  ];
}
