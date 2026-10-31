// User scripts: plain JavaScript files in <data>/scripts that drive Sensor
// through the same command bus as everything else.
//
//   // @name Tidy downloads
//   // @scopes downloads:read, files:write
//   module.exports = async (sensor, args) => {
//     const list = await sensor.run('downloads.list');
//     ...
//     return { moved: n };
//   };
//
// A script runs in a worker thread as a "script:<name>" principal limited to
// its @scopes (and never more than whoever started it). Scripts are code you
// wrote or chose to install, like shell scripts: the worker itself has normal
// Node access, which is why running one needs the scripts:exec scope.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Core, CoreModule } from '../core';
import { CommandError, type CommandDef } from '../commands';
import { now, uid } from '../db';
import { SCOPES, type Principal, type Scope } from '../permissions';

export interface ScriptInfo {
  name: string;
  file: string;
  title: string;
  description: string;
  scopes: Scope[];
}

export function parseHeader(code: string, file: string): ScriptInfo {
  const tag = (t: string) => new RegExp(`^\\s*//\\s*@${t}\\s+(.+)$`, 'm').exec(code)?.[1].trim();
  const scopes = (tag('scopes') ?? '').split(/[\s,]+/).filter(Boolean) as Scope[];
  for (const s of scopes) if (s !== '*' && !(s in SCOPES)) throw new CommandError('invalid_params', `${file}: unknown scope ${s}`);
  const name = file.replace(/\.(c?js)$/, '');
  return { name, file, title: tag('name') ?? name, description: tag('description') ?? '', scopes };
}

const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
let seq = 0;
const waiting = new Map();
parentPort.on('message', (m) => {
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  m.error ? w.reject(new Error(m.error)) : w.resolve(m.result);
});
const sensor = {
  run: (id, args = {}) => new Promise((resolve, reject) => { const n = ++seq; waiting.set(n, { resolve, reject }); parentPort.postMessage({ type: 'run', id: n, command: id, args }); }),
  log: (...a) => parentPort.postMessage({ type: 'log', text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }),
};
console.log = sensor.log;
console.error = sensor.log;
globalThis.sensor = sensor;
(async () => {
  try {
    const mod = require(workerData.file);
    const fn = typeof mod === 'function' ? mod : typeof mod?.default === 'function' ? mod.default : null;
    const result = fn ? await fn(sensor, workerData.args) : undefined;
    parentPort.postMessage({ type: 'done', result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
  } catch (e) {
    parentPort.postMessage({ type: 'fail', error: String(e && e.stack || e) });
  }
})();
`;

export class Scripts {
  running = new Map<string, { worker: Worker; name: string; startedAt: number }>();

  constructor(private core: Core) {}

  dir(): string {
    const d = this.core.settings.get<string>('scripts.dir') || join(this.core.dataDir, 'scripts');
    mkdirSync(d, { recursive: true });
    return d;
  }

  list(): ScriptInfo[] {
    return readdirSync(this.dir())
      .filter((f) => /\.c?js$/.test(f))
      .map((f) => {
        try {
          return parseHeader(readFileSync(join(this.dir(), f), 'utf8'), f);
        } catch (e: any) {
          return { name: f.replace(/\.c?js$/, ''), file: f, title: f, description: `invalid: ${e.message}`, scopes: [] };
        }
      });
  }

  find(name: string): ScriptInfo {
    const s = this.list().find((x) => x.name === name || x.file === name || x.title === name);
    if (!s) throw new CommandError('not_found', `script not found: ${name}`);
    return s;
  }

  run(name: string, args: any, caller: Principal, timeoutMs: number): Promise<{ id: string; result: any; logs: string[]; ms: number }> {
    const s = this.find(name);
    let scopes = s.scopes;
    if (caller.kind !== 'user') {
      const has = new Set(caller.scopes);
      scopes = has.has('*') ? s.scopes : s.scopes.filter((x) => x !== '*' && has.has(x));
    }
    const principal: Principal = { kind: 'script', id: s.name, name: s.name, scopes };
    const id = uid('scr_');
    const logs: string[] = [];
    const started = now();
    const file = join(this.dir(), s.file);
    // each worker has its own module cache, so edits apply on the next run
    const worker = new Worker(BOOT, { eval: true, workerData: { file, args: args ?? {} }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    this.running.set(id, { worker, name: s.name, startedAt: started });
    this.core.events.emit('script.started', { id, name: s.name });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | null, result?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(id);
        worker.terminate().catch(() => {});
        const ms = now() - started;
        this.core.events.emit(err ? 'script.failed' : 'script.completed', { id, name: s.name, ms, error: err?.message });
        if (err) reject(new CommandError('failed', `${s.name}: ${err.message.split('\n').slice(0, 4).join(' ')}`));
        else resolve({ id, result, logs, ms });
      };
      const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      worker.on('message', async (m: any) => {
        if (m.type === 'log') {
          if (logs.length < 1000) logs.push(String(m.text).slice(0, 2000));
        } else if (m.type === 'run') {
          try {
            const result = await this.core.bus.run(m.command, m.args ?? {}, principal);
            worker.postMessage({ id: m.id, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
          } catch (e: any) {
            worker.postMessage({ id: m.id, error: String(e?.message ?? e) });
          }
        } else if (m.type === 'done') finish(null, m.result);
        else if (m.type === 'fail') finish(new Error(m.error));
      });
      worker.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
      worker.on('exit', (code) => finish(code === 0 ? null : new Error(`exited with code ${code}`)));
    });
  }
}

export function scriptsModule(): CoreModule {
  let S: Scripts | null = null;
  return {
    name: 'scripts',
    init(core) {
      S = new Scripts(core);
      core.services.scripts = S;
      return scriptCommands(core, S);
    },
    dispose() {
      for (const r of S?.running.values() ?? []) r.worker.terminate().catch(() => {});
    },
  };
}

function scriptCommands(core: Core, S: Scripts): CommandDef[] {
  return [
    {
      id: 'scripts.list', title: 'List Scripts', scopes: ['app:read'], palette: false,
      handler: () => ({ dir: S.dir(), scripts: S.list(), running: [...S.running.entries()].map(([id, r]) => ({ id, name: r.name, startedAt: r.startedAt })) }),
    },
    {
      id: 'scripts.run', title: 'Run Script', scopes: ['scripts:exec'], palette: false,
      params: { name: { type: 'string', required: true, positional: 0 }, args: { type: 'object', default: {} }, timeout: { type: 'number', default: 600_000 } },
      handler: (a, ctx) => S.run(a.name, a.args, ctx.principal, Math.min(a.timeout, 24 * 3_600_000)),
    },
    {
      id: 'scripts.save', title: 'Save Script', scopes: ['scripts:exec'], palette: false,
      description: 'Write a script file. Header comments: // @name, // @description, // @scopes a:b, c:d',
      params: { name: { type: 'string', required: true, positional: 0 }, code: { type: 'string', required: true, positional: 1 } },
      handler: (a) => {
        if (!/^[\w .-]+$/.test(a.name)) throw new CommandError('invalid_params', 'script names may use letters, digits, space, dot, dash and underscore');
        const file = a.name.endsWith('.js') ? a.name : `${a.name}.js`;
        const info = parseHeader(a.code, file);
        writeFileSync(join(S.dir(), file), a.code);
        core.events.emit('script.saved', { name: info.name });
        return info;
      },
    },
    {
      id: 'scripts.delete', title: 'Delete Script', scopes: ['scripts:exec'], destructive: true, palette: false,
      params: { name: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const s = S.find(a.name);
        rmSync(join(S.dir(), s.file));
        return { deleted: s.file };
      },
    },
    {
      id: 'scripts.stop', title: 'Stop Script', scopes: ['scripts:exec'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => {
        const r = S.running.get(a.id);
        if (!r) return { stopped: false };
        r.worker.terminate().catch(() => {});
        return { stopped: true };
      },
    },
    {
      id: 'scripts.openFolder', title: 'Open Scripts Folder', scopes: ['scripts:exec'],
      handler: async () => {
        const d = S.dir();
        if (!existsSync(join(d, 'example.js'))) {
          writeFileSync(join(d, 'example.js'), `// @name Example: list tabs\n// @description Logs the open tabs and returns how many there are.\n// @scopes tabs:read\nmodule.exports = async (sensor, args) => {\n  const tabs = await sensor.run('tabs.list');\n  for (const t of tabs) console.log(t.title, t.url);\n  return { tabs: tabs.length };\n};\n`);
        }
        await core.platform.openPath(d);
        return { dir: d };
      },
    },
  ];
}
