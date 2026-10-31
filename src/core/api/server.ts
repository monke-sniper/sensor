// Local API: JSON-RPC 2.0, newline-delimited, over a Windows named pipe or a
// Unix domain socket. Methods are command ids. Every connection must
// authenticate with a token; every call is permission-checked and audited.
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Core } from '../core';
import { CommandError } from '../commands';
import { matches, scopeForTopic, type SensorEvent } from '../events';
import { hasScope, SCOPES, type Principal, type Scope } from '../permissions';

export interface ApiServer {
  path: string;
  tokenFile: string;
  close(): void;
}

export function defaultSocketPath(): string {
  if (process.env.SENSOR_SOCKET) return process.env.SENSOR_SOCKET;
  if (process.platform === 'win32') return `\\\\.\\pipe\\sensor-${userInfo().username}`;
  const base = process.env.XDG_RUNTIME_DIR || tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().username;
  return join(base, `sensor-${uid}.sock`);
}

export function defaultDataDir(): string {
  if (process.env.SENSOR_DATA_DIR) return process.env.SENSOR_DATA_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Sensor', 'data');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Sensor', 'data');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Sensor', 'data');
}

/** Scopes for the auto-created CLI token: everything except admin/destructive scopes, which prompt in the GUI. */
export const DEFAULT_CLI_SCOPES: Scope[] = (Object.keys(SCOPES) as Scope[]).filter(
  (s) => !['auth:admin', 'files:delete', 'git:destructive', 'forms:submit', 'scripts:exec', 'backup:write'].includes(s),
);

interface Conn {
  socket: Socket;
  principal: Principal | null;
  subs: { patterns: string[]; off: () => void } | null;
  buf: string;
}

export async function startApiServer(core: Core, opts: { dataDir: string; socketPath?: string }): Promise<ApiServer> {
  const path = opts.socketPath ?? defaultSocketPath();
  const tokenFile = join(opts.dataDir, 'cli-token');
  ensureCliToken(core, tokenFile);

  if (process.platform !== 'win32') {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        unlinkSync(path); // stale socket from a previous run (single-instance lock prevents a live one)
      } catch {
        /* ignore */
      }
    }
  }

  const conns = new Set<Conn>();
  const server: Server = createServer((socket) => {
    const c: Conn = { socket, principal: null, subs: null, buf: '' };
    conns.add(c);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      c.buf += chunk;
      if (c.buf.length > 16 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, nl).trim();
        c.buf = c.buf.slice(nl + 1);
        if (line) handleLine(core, c, line);
      }
    });
    const cleanup = () => {
      c.subs?.off();
      conns.delete(c);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
  }

  return {
    path,
    tokenFile,
    close() {
      for (const c of conns) c.socket.destroy();
      server.close();
      if (process.platform !== 'win32' && existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function ensureCliToken(core: Core, tokenFile: string): void {
  if (existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, 'utf8').trim();
    if (core.tokens.verify(t)) return;
  }
  core.tokens.revoke('local-cli');
  const { token } = core.tokens.create('local-cli', DEFAULT_CLI_SCOPES);
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
}

function send(c: Conn, msg: unknown): void {
  if (!c.socket.destroyed) c.socket.write(JSON.stringify(msg) + '\n');
}

function reply(c: Conn, id: unknown, result: unknown): void {
  if (id === undefined || id === null) return; // notification
  send(c, { jsonrpc: '2.0', id, result: result === undefined ? null : result });
}

function fail(c: Conn, id: unknown, code: number, message: string, data?: unknown): void {
  send(c, { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } });
}

const ERR = { parse: -32700, invalid: -32600, notFound: -32601, params: -32602, internal: -32603, unauthorized: -32001, forbidden: -32003 };

async function handleLine(core: Core, c: Conn, line: string): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(c, null, ERR.parse, 'parse error');
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(c, msg?.id, ERR.invalid, 'invalid request');
  const { id, method } = msg;
  const params = msg.params ?? {};

  if (method === 'auth') {
    const p = core.tokens.verify(String(params.token ?? ''));
    if (!p) return fail(c, id, ERR.unauthorized, 'invalid token');
    c.principal = p;
    return reply(c, id, { ok: true, name: p.kind === 'token' ? p.name : 'user', scopes: p.kind === 'token' ? p.scopes : ['*'] });
  }
  if (!c.principal) return fail(c, id, ERR.unauthorized, 'authenticate first: {"method":"auth","params":{"token":"..."}}');

  if (method === 'events.subscribe') {
    const topics: string[] = Array.isArray(params.topics) && params.topics.length ? params.topics.map(String) : ['*'];
    c.subs?.off();
    const principal = c.principal;
    const off = core.events.on('*', (e: SensorEvent) => {
      if (e.topic === 'command.ran') return;
      if (!topics.some((t) => matches(t, e.topic))) return;
      const need = scopeForTopic(e.topic);
      if (need && !hasScope(principal, need as Scope)) return;
      send(c, { jsonrpc: '2.0', method: 'event', params: e });
    });
    c.subs = { patterns: topics, off };
    return reply(c, id, { subscribed: topics });
  }
  if (method === 'events.unsubscribe') {
    c.subs?.off();
    c.subs = null;
    return reply(c, id, { ok: true });
  }

  try {
    const result = await core.bus.run(method, params, c.principal);
    reply(c, id, result);
  } catch (e: any) {
    if (e instanceof CommandError) {
      const code = e.code === 'not_found' ? ERR.notFound : e.code === 'invalid_params' ? ERR.params : e.code === 'forbidden' || e.code === 'denied' ? ERR.forbidden : ERR.internal;
      return fail(c, id, code, e.message);
    }
    fail(c, id, ERR.internal, String(e?.message ?? e));
  }
}
