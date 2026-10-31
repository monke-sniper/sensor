// Match Electron "before-input-event" inputs against accelerator strings so
// app shortcuts work no matter which web contents has focus.

export interface KeyInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

interface Parsed {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string; // normalized lower-case key name
}

const isMac = process.platform === 'darwin';

const KEY_ALIASES: Record<string, string> = {
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  esc: 'escape',
  return: 'enter',
  plus: '+',
  space: ' ',
  comma: ',',
  period: '.',
};

export function parseAccelerator(acc: string): Parsed | null {
  const parts = acc.split('+').map((p) => p.trim());
  // "CmdOrCtrl+Plus" vs "CmdOrCtrl++"
  if (acc.endsWith('++')) {
    parts.splice(parts.length - 2, 2, '+');
  }
  const out: Parsed = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'cmdorctrl' || p === 'commandorcontrol') {
      if (isMac) out.meta = true;
      else out.ctrl = true;
    } else if (p === 'ctrl' || p === 'control') out.ctrl = true;
    else if (p === 'cmd' || p === 'command' || p === 'super' || p === 'meta') out.meta = true;
    else if (p === 'alt' || p === 'option') out.alt = true;
    else if (p === 'shift') out.shift = true;
    else out.key = KEY_ALIASES[p] ?? p;
  }
  return out.key ? out : null;
}

function normKey(input: KeyInput): string {
  const k = input.key.toLowerCase();
  // With shift held, "Tab" is still "tab", digits may become symbols; prefer code for digits.
  if (input.code && /^Digit\d$/.test(input.code)) return input.code.slice(5);
  return k;
}

export class ShortcutMap {
  private entries: { parsed: Parsed; command: string; acc: string }[] = [];

  set(map: Record<string, string>): void {
    this.entries = [];
    for (const [command, acc] of Object.entries(map)) {
      if (!acc) continue;
      const parsed = parseAccelerator(acc);
      if (parsed) this.entries.push({ parsed, command, acc });
    }
  }

  match(input: KeyInput): string | null {
    if (input.type !== 'keyDown') return null;
    const key = normKey(input);
    for (const e of this.entries) {
      const p = e.parsed;
      if (p.key === key && p.ctrl === input.control && p.meta === input.meta && p.alt === input.alt && p.shift === input.shift) return e.command;
    }
    return null;
  }

  conflicts(): { acc: string; commands: string[] }[] {
    const byAcc = new Map<string, string[]>();
    for (const e of this.entries) {
      const k = JSON.stringify(e.parsed);
      byAcc.set(k, [...(byAcc.get(k) ?? []), e.command]);
    }
    return [...byAcc.entries()].filter(([, v]) => v.length > 1).map(([, commands]) => ({ acc: this.entries.find((e) => e.command === commands[0])!.acc, commands }));
  }

  list(): { command: string; accelerator: string }[] {
    return this.entries.map((e) => ({ command: e.command, accelerator: e.acc }));
  }
}
