// The macro language's expression evaluator and {{template}} interpolation.
// Deliberately tiny and side-effect free: no eval, no property calls, no
// access to anything outside the variables a run was given.

export type Vars = Record<string, any>;

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'punc'; v: any };

const OPS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const prev = out[out.length - 1];
    const afterValue = prev && (prev.t === 'id' || (prev.t === 'punc' && (prev.v === ']' || prev.v === ')')));
    if (/[0-9]/.test(c) || (c === '.' && !afterValue && /[0-9]/.test(src[i + 1] ?? ''))) {
      const member = prev && prev.t === 'punc' && prev.v === '.'; // a.0.b: integer index, not 0.5
      const m = (member ? /^\d+/ : /^\d*\.?\d+(e[+-]?\d+)?/i).exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[++j];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new Error(`unterminated string in: ${src}`);
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if ('()[].,:|'.includes(c)) {
      out.push({ t: 'punc', v: c });
      i++;
      continue;
    }
    throw new Error(`unexpected '${c}' in: ${src}`);
  }
  return out;
}

/** Look up a dotted path in vars. Unknown paths are undefined, never an error. */
export function getPath(vars: Vars, path: (string | number)[]): any {
  let cur: any = vars;
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof k === 'string' && (k === '__proto__' || k === 'constructor' || k === 'prototype')) return undefined;
    cur = cur[k as any];
  }
  return cur;
}

const FILTERS: Record<string, (v: any, arg?: any) => any> = {
  json: (v) => JSON.stringify(v),
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  trim: (v) => String(v ?? '').trim(),
  length: (v) => (v == null ? 0 : Array.isArray(v) || typeof v === 'string' ? v.length : typeof v === 'object' ? Object.keys(v).length : String(v).length),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  urlencode: (v) => encodeURIComponent(String(v ?? '')),
  lines: (v) => String(v ?? '').split(/\r?\n/).filter((l) => l.trim() !== ''),
  number: (v) => Number(v),
  string: (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  default: (v, d) => (v === undefined || v === null || v === '' ? d : v),
  join: (v, sep = ', ') => (Array.isArray(v) ? v.join(sep) : v),
  split: (v, sep = ',') => String(v ?? '').split(sep),
  slice: (v, n) => (Array.isArray(v) || typeof v === 'string' ? v.slice(0, Number(n)) : v),
  keys: (v) => (v && typeof v === 'object' ? Object.keys(v) : []),
  basename: (v) => String(v ?? '').split(/[\\/]/).pop(),
};

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private vars: Vars, private src: string) {}

  parse(): any {
    const v = this.filtered();
    if (this.i < this.toks.length) throw new Error(`unexpected '${this.toks[this.i].v}' in: ${this.src}`);
    return v;
  }
  private peek(v?: string): Tok | undefined {
    const t = this.toks[this.i];
    if (v === undefined) return t;
    return t && (t.t === 'op' || t.t === 'punc' || t.t === 'id') && t.v === v ? t : undefined;
  }
  private eat(v: string): boolean {
    if (this.peek(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(v: string) {
    if (!this.eat(v)) throw new Error(`expected '${v}' in: ${this.src}`);
  }
  private filtered(): any {
    let v = this.or();
    while (this.eat('|')) {
      const name = this.toks[this.i++];
      if (!name || name.t !== 'id' || !FILTERS[name.v]) throw new Error(`unknown filter${name ? ` '${name.v}'` : ''} in: ${this.src}`);
      let arg: any;
      if (this.eat(':')) arg = this.unary();
      v = FILTERS[name.v](v, arg);
    }
    return v;
  }
  private or(): any {
    let l = this.and();
    while (this.eat('||')) {
      const r = this.and();
      l = l || r;
    }
    return l;
  }
  private and(): any {
    let l = this.eq();
    while (this.eat('&&')) {
      const r = this.eq();
      l = l && r;
    }
    return l;
  }
  private eq(): any {
    let l = this.rel();
    for (;;) {
      if (this.eat('==')) l = looseEq(l, this.rel());
      else if (this.eat('!=')) l = !looseEq(l, this.rel());
      else return l;
    }
  }
  private rel(): any {
    let l = this.add();
    for (;;) {
      if (this.eat('<=')) l = l <= this.add();
      else if (this.eat('>=')) l = l >= this.add();
      else if (this.eat('<')) l = l < this.add();
      else if (this.eat('>')) l = l > this.add();
      else if (this.eat('contains')) {
        const r = this.add();
        l = Array.isArray(l) ? l.some((x) => looseEq(x, r)) : String(l ?? '').toLowerCase().includes(String(r ?? '').toLowerCase());
      } else if (this.eat('matches')) {
        const r = this.add();
        l = new RegExp(String(r), 'i').test(String(l ?? ''));
      } else if (this.eat('startsWith')) l = String(l ?? '').startsWith(String(this.add() ?? ''));
      else if (this.eat('endsWith')) l = String(l ?? '').endsWith(String(this.add() ?? ''));
      else return l;
    }
  }
  private add(): any {
    let l = this.mul();
    for (;;) {
      if (this.eat('+')) {
        const r = this.mul();
        l = typeof l === 'number' && typeof r === 'number' ? l + r : `${l ?? ''}${r ?? ''}`;
      } else if (this.eat('-')) l = Number(l) - Number(this.mul());
      else return l;
    }
  }
  private mul(): any {
    let l = this.unary();
    for (;;) {
      if (this.eat('*')) l = Number(l) * Number(this.unary());
      else if (this.eat('/')) l = Number(l) / Number(this.unary());
      else if (this.eat('%')) l = Number(l) % Number(this.unary());
      else return l;
    }
  }
  private unary(): any {
    if (this.eat('!') || this.eat('not')) return !this.unary();
    if (this.eat('-')) return -Number(this.unary());
    return this.primary();
  }
  private primary(): any {
    const t = this.toks[this.i++];
    if (!t) throw new Error(`unexpected end of: ${this.src}`);
    if (t.t === 'num' || t.t === 'str') return this.postfix(t.v, null);
    if (t.t === 'punc' && t.v === '(') {
      const v = this.filtered();
      this.expect(')');
      return this.postfix(v, null);
    }
    if (t.t === 'punc' && t.v === '[') {
      const arr: any[] = [];
      if (!this.eat(']')) {
        do arr.push(this.filtered());
        while (this.eat(','));
        this.expect(']');
      }
      return arr;
    }
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      if (t.v === 'undefined') return undefined;
      return this.postfix(undefined, [t.v]);
    }
    throw new Error(`unexpected '${t.v}' in: ${this.src}`);
  }
  /** Member access: a.b, a[0], a['k']. Paths resolve against vars. */
  private postfix(base: any, path: (string | number)[] | null): any {
    let value = path ? getPath(this.vars, path) : base;
    for (;;) {
      if (this.eat('.')) {
        const n = this.toks[this.i++];
        if (!n || (n.t !== 'id' && n.t !== 'num')) throw new Error(`bad member access in: ${this.src}`);
        value = getPath({ v: value }, ['v', n.v]);
      } else if (this.peek('[')) {
        this.i++;
        const k = this.filtered();
        this.expect(']');
        value = getPath({ v: value }, ['v', k]);
      } else return value;
    }
  }
}

function looseEq(a: any, b: any): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    return Number(a) === Number(b);
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Evaluate an expression like `count > 3 && title contains 'invoice'`. */
export function evaluate(expr: string, vars: Vars): any {
  const src = expr.trim();
  if (!src) return undefined;
  return new Parser(tokenize(src), vars, src).parse();
}

/** Truthiness for conditions; accepts expressions or already-evaluated values. */
export function truthy(cond: any, vars: Vars): boolean {
  if (typeof cond === 'boolean') return cond;
  if (typeof cond === 'string') {
    const m = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(cond);
    const v = evaluate(m ? m[1] : cond, vars);
    return Array.isArray(v) ? v.length > 0 : !!v;
  }
  return !!cond;
}

const TPL = /\{\{([\s\S]*?)\}\}/g;

/**
 * Interpolate {{expr}} templates. A string that is exactly one template keeps
 * the value's type (so `{{items}}` stays an array); mixed strings stringify.
 */
export function interpolate<T = any>(value: T, vars: Vars): T {
  if (typeof value === 'string') {
    const whole = /^\{\{([\s\S]*?)\}\}$/.exec(value);
    if (whole && !whole[1].includes('}}')) return evaluate(whole[1], vars);
    return value.replace(TPL, (_m, e) => {
      const v = evaluate(e, vars);
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }) as any;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars)) as any;
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, vars);
    return out;
  }
  return value;
}

/** Names of variables a template refers to at the top level (for input discovery). */
export function referencedVars(value: any, acc = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TPL)) {
      try {
        for (const t of tokenize(m[1])) if (t.t === 'id') {
          acc.add(t.v);
          break;
        }
      } catch {
        /* ignore malformed */
      }
    }
  } else if (Array.isArray(value)) value.forEach((v) => referencedVars(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => referencedVars(v, acc));
  return acc;
}
