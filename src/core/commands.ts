// The command bus. Every operation in Sensor is a command: the GUI, palette,
// shortcuts, macros, the local API and the CLI all dispatch through here, so
// they share one implementation, one permission check and one audit trail.
import type { EventBus } from './events';
import { AuditLog, missingScopes, principalLabel, type Principal, type Scope } from './permissions';

export type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';

export interface ParamSpec {
  type: ParamType;
  required?: boolean;
  description?: string;
  enum?: string[];
  default?: unknown;
  /** position for CLI positional arguments */
  positional?: number;
}

export interface CommandContext {
  principal: Principal;
  bus: CommandBus;
  /** Run another command as the same principal. */
  run<T = any>(id: string, args?: Record<string, any>): Promise<T>;
}

export interface CommandDef<A = any, R = any> {
  id: string; // "tabs.open"
  title: string; // "Open Tab"
  description?: string;
  category?: string;
  scopes: Scope[];
  destructive?: boolean;
  params?: Record<string, ParamSpec>;
  /** Show in the command palette (default: true when it has no required params). */
  palette?: boolean;
  /** Default keyboard accelerator, Electron syntax, e.g. "CmdOrCtrl+T". */
  shortcut?: string;
  handler: (args: A, ctx: CommandContext) => R | Promise<R>;
}

export interface CommandInfo {
  id: string;
  title: string;
  description?: string;
  category?: string;
  scopes: Scope[];
  destructive: boolean;
  params: Record<string, ParamSpec>;
  palette: boolean;
  shortcut?: string;
}

export class CommandError extends Error {
  constructor(public code: 'not_found' | 'invalid_params' | 'forbidden' | 'denied' | 'failed', message: string) {
    super(message);
  }
}

/** Asked when an external principal lacks a scope; lets the user approve once. */
export type ApprovalHandler = (p: Principal, cmd: CommandInfo, missing: Scope[], args: any) => Promise<boolean>;

export class CommandBus {
  private defs = new Map<string, CommandDef>();
  approval: ApprovalHandler | null = null;

  constructor(private events: EventBus, private audit: AuditLog | null) {}

  register<A = any, R = any>(def: CommandDef<A, R>): void {
    if (this.defs.has(def.id)) throw new Error(`command already registered: ${def.id}`);
    this.defs.set(def.id, def as CommandDef);
  }

  registerAll(defs: CommandDef[]): void {
    for (const d of defs) this.register(d);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  info(id: string): CommandInfo | undefined {
    const d = this.defs.get(id);
    return d ? toInfo(d) : undefined;
  }

  list(): CommandInfo[] {
    return [...this.defs.values()].map(toInfo).sort((a, b) => a.id.localeCompare(b.id));
  }

  async run<T = any>(id: string, args: Record<string, any> | undefined, principal: Principal): Promise<T> {
    const def = this.defs.get(id);
    if (!def) throw new CommandError('not_found', `unknown command: ${id}`);
    const info = toInfo(def);
    const missing = missingScopes(principal, def.scopes);
    if (missing.length) {
      const approved = principal.kind !== 'user' && this.approval ? await this.approval(principal, info, missing, args) : false;
      if (!approved) {
        this.audit?.record(principal, id, false, `forbidden: missing ${missing.join(',')}`);
        throw new CommandError('forbidden', `${principalLabel(principal)} lacks scope(s): ${missing.join(', ')}`);
      }
    }
    let clean: Record<string, any>;
    try {
      clean = validate(def.params ?? {}, args ?? {});
    } catch (e: any) {
      this.audit?.record(principal, id, false, e.message);
      throw e;
    }
    const ctx: CommandContext = {
      principal,
      bus: this,
      run: (cid, cargs) => this.run(cid, cargs, principal),
    };
    try {
      const result = await def.handler(clean, ctx);
      this.audit?.record(principal, id, true);
      this.events.emit('command.ran', { id, principal: principalLabel(principal) });
      return result as T;
    } catch (e: any) {
      this.audit?.record(principal, id, false, String(e?.message ?? e));
      if (e instanceof CommandError) throw e;
      throw new CommandError('failed', String(e?.message ?? e));
    }
  }
}

function toInfo(d: CommandDef): CommandInfo {
  const params = d.params ?? {};
  const hasRequired = Object.values(params).some((p) => p.required);
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category ?? d.id.split('.')[0],
    scopes: d.scopes,
    destructive: !!d.destructive,
    params,
    palette: d.palette ?? !hasRequired,
    shortcut: d.shortcut,
  };
}

export function validate(spec: Record<string, ParamSpec>, args: Record<string, any>): Record<string, any> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new CommandError('invalid_params', 'params must be an object');
  }
  const out: Record<string, any> = {};
  for (const [name, p] of Object.entries(spec)) {
    let v = args[name];
    if (v === undefined || v === null) {
      if (p.required) throw new CommandError('invalid_params', `missing required param: ${name}`);
      if (p.default !== undefined) out[name] = p.default;
      continue;
    }
    v = coerce(name, p, v);
    if (p.enum && !p.enum.includes(v)) throw new CommandError('invalid_params', `${name} must be one of: ${p.enum.join(', ')}`);
    out[name] = v;
  }
  for (const k of Object.keys(args)) {
    if (!(k in spec)) throw new CommandError('invalid_params', `unknown param: ${k}`);
  }
  return out;
}

function coerce(name: string, p: ParamSpec, v: any): any {
  switch (p.type) {
    case 'any':
      return v;
    case 'string':
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (typeof v !== 'string') throw new CommandError('invalid_params', `${name} must be a string`);
      return v;
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || Number.isNaN(n)) throw new CommandError('invalid_params', `${name} must be a number`);
      return n;
    }
    case 'boolean':
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      if (typeof v !== 'boolean') throw new CommandError('invalid_params', `${name} must be a boolean`);
      return v;
    case 'array':
      if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!Array.isArray(v)) throw new CommandError('invalid_params', `${name} must be an array`);
      return v;
    case 'object':
      if (typeof v === 'string') {
        try {
          return JSON.parse(v);
        } catch {
          throw new CommandError('invalid_params', `${name} must be a JSON object`);
        }
      }
      if (typeof v !== 'object' || Array.isArray(v)) throw new CommandError('invalid_params', `${name} must be an object`);
      return v;
  }
}
