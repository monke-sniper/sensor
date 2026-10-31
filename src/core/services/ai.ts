// AI website workflows. Sensor drives the AI sites you are already logged in
// to (ChatGPT, Claude, Perplexity, Gemini, ...) inside its own browser tabs:
// it inserts prompts, attaches files and reads responses with deterministic
// per-site selectors. No API keys, no MCP. Sending (pressing submit) is a
// separate permission (forms:submit) and is off by default.
//
// Site markup changes over time; every adapter can be overridden from the
// "ai.adapters" setting without a Sensor update.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Core, CoreModule } from '../core';
import { CommandError, type CommandDef } from '../commands';
import { now, uid } from '../db';
import { interpolate } from './macro-lang';

export interface SiteAdapter {
  /** composer: textarea / contenteditable */
  input: string[];
  /** send button */
  send: string[];
  /** file input for attachments */
  file: string;
  /** assistant messages (in document order) */
  assistant: string[];
  /** user messages (for conversation capture) */
  user: string[];
  /** present while a response is streaming */
  busy: string[];
  /** URL that starts a fresh conversation */
  newChat?: string;
}

export const ADAPTERS: Record<string, SiteAdapter> = {
  chatgpt: {
    input: ['#prompt-textarea', 'div[contenteditable="true"][id*="prompt"]', 'form textarea', 'div[contenteditable="true"]'],
    send: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send"]'],
    file: 'input[type=file]',
    assistant: ['[data-message-author-role="assistant"]'],
    user: ['[data-message-author-role="user"]'],
    busy: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
    newChat: 'https://chatgpt.com/',
  },
  claude: {
    input: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][aria-label]', 'fieldset div[contenteditable="true"]', 'div[contenteditable="true"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[aria-label*="Send"]'],
    file: 'input[type=file]',
    assistant: ['[data-testid="assistant-message"]', '.font-claude-response', '.font-claude-message', '[data-is-streaming]'],
    user: ['[data-testid="user-message"]'],
    busy: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]', '[data-is-streaming="true"]'],
    newChat: 'https://claude.ai/new',
  },
  perplexity: {
    input: ['#ask-input', 'div[contenteditable="true"]', 'textarea[placeholder]', 'textarea'],
    send: ['button[data-testid="submit-button"]', 'button[aria-label="Submit"]', 'button[aria-label*="Submit"]'],
    file: 'input[type=file]',
    assistant: ['[id^="markdown-content"]', '.prose'],
    user: ['h1[class*="query"]', '[data-testid="query-text"]'],
    busy: ['button[aria-label*="Stop"]'],
    newChat: 'https://www.perplexity.ai/',
  },
  gemini: {
    input: ['rich-textarea div[contenteditable="true"]', '.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]'],
    send: ['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label*="Send"]'],
    file: 'input[type=file]',
    assistant: ['message-content', '.model-response-text'],
    user: ['user-query', '.query-text'],
    busy: ['button[aria-label*="Stop"]'],
    newChat: 'https://gemini.google.com/app',
  },
  generic: {
    input: ['textarea', 'div[contenteditable="true"]', 'input[type=text]'],
    send: ['button[type=submit]', 'button[aria-label*="Send"]'],
    file: 'input[type=file]',
    assistant: ['[data-role="assistant"]', '.assistant', '.response'],
    user: ['[data-role="user"]', '.user'],
    busy: [],
  },
};

const DEFAULT_PROVIDERS = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/', kind: 'chatgpt', purpose: 'general' },
  { name: 'Claude', url: 'https://claude.ai/new', kind: 'claude', purpose: 'writing, code' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai/', kind: 'perplexity', purpose: 'research with sources' },
  { name: 'Gemini', url: 'https://gemini.google.com/app', kind: 'gemini', purpose: 'general' },
];

export interface Provider {
  id: string;
  name: string;
  url: string;
  kind: string;
  purpose: string | null;
  position: number;
}

export class AI {
  constructor(private core: Core) {}

  seed(): void {
    if (this.core.settings.get('ai.seeded')) return;
    if (!this.core.db.get('SELECT 1 FROM providers LIMIT 1')) {
      DEFAULT_PROVIDERS.forEach((p, i) => this.core.db.run('INSERT INTO providers (id, name, url, kind, purpose, position) VALUES (?, ?, ?, ?, ?, ?)', uid('prv_'), p.name, p.url, p.kind, p.purpose, i));
    }
    this.core.settings.set('ai.seeded', true);
  }

  providers(): Provider[] {
    return this.core.db.all('SELECT * FROM providers ORDER BY position, name') as Provider[];
  }

  provider(ref: string): Provider {
    const r = this.core.db.get('SELECT * FROM providers WHERE id = ? OR lower(name) = lower(?) OR kind = ? ORDER BY position LIMIT 1', ref, ref, ref);
    if (!r) throw new CommandError('not_found', `AI provider not found: ${ref}`);
    return r as Provider;
  }

  adapter(kind: string): SiteAdapter {
    const base = ADAPTERS[kind] ?? ADAPTERS.generic;
    const over = (this.core.settings.get<Record<string, Partial<SiteAdapter>>>('ai.adapters') ?? {})[kind] ?? {};
    return { ...base, ...over };
  }

  /** An existing, non-incognito tab on the provider's site in the active workspace. */
  findTab(p: Provider): string | null {
    const host = safeHost(p.url);
    const w = this.core.workspaces.active();
    const tabs = this.core.workspaces.allTabs().filter((t) => t.workspaceId === w.id && !t.profileId.startsWith('incognito') && sameSite(safeHost(t.url), host));
    if (!tabs.length) return null;
    return (tabs.find((t) => t.id === w.activeTab) ?? tabs[0]).id;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sameSite(a: string, b: string): boolean {
  return !!a && !!b && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const aiModule: CoreModule = {
  name: 'ai',
  init(core) {
    const A = new AI(core);
    core.services.ai = A;
    A.seed();
    return aiCommands(core, A);
  },
};

function aiCommands(core: Core, A: AI): CommandDef[] {
  /** Text for a send: explicit, a prompt template, the source tab's selection or page. */
  const composeText = async (a: any, ctx: any): Promise<{ text: string; refs: string[] }> => {
    const refs: string[] = [];
    let text = a.text ?? '';
    const source = a.tab ?? core.workspaces.active().activeTab ?? undefined;
    if (a.fromSelection && source) {
      const sel = (await ctx.run('page.selection', { id: source })).text;
      if (!sel) throw new CommandError('failed', 'nothing is selected');
      const t = core.workspaces.tab(source);
      text = text ? `${text}\n\n${sel}` : sel;
      refs.push(t.url);
    }
    if (a.fromPage && source) {
      const page = await ctx.run('page.read', { id: source, format: 'markdown' });
      text = `${text ? text + '\n\n' : ''}Source: ${page.title} (${page.url})\n\n${page.content.slice(0, 100_000)}`;
      refs.push(page.url);
    }
    if (a.url && /^https?:/.test(a.url)) {
      text = text ? `${text}\n\n${a.url}` : a.url;
      refs.push(a.url);
    }
    if (a.prompt) {
      const pr = core.db.get('SELECT * FROM prompts WHERE id = ? OR name = ?', a.prompt, a.prompt);
      if (!pr) throw new CommandError('not_found', `prompt not found: ${a.prompt}`);
      const vars: Record<string, any> = { text, input: text, url: refs[0] ?? '', date: new Date().toISOString().slice(0, 10) };
      text = pr.body.includes('{{') ? interpolate(pr.body, vars) : `${pr.body}\n\n${text}`;
    }
    return { text, refs };
  };

  const files = (a: any): string[] => {
    const list: string[] = [...(a.files ?? [])];
    if (a.url && a.url.startsWith('file:')) list.push(fileURLToPath(a.url));
    for (const f of list) if (!existsSync(f)) throw new CommandError('invalid_params', `file not found: ${f}`);
    return list;
  };

  return [
    {
      id: 'ai.providers', title: 'AI Providers', scopes: ['ai:send'], palette: false,
      handler: () => A.providers().map((p) => ({ ...p, open: !!A.findTab(p) })),
    },
    {
      id: 'ai.addProvider', title: 'Add AI Provider', scopes: ['app:write'], palette: false,
      params: { name: { type: 'string', required: true, positional: 0 }, url: { type: 'string', required: true, positional: 1 }, kind: { type: 'string', default: 'generic', description: `adapter: ${Object.keys(ADAPTERS).join(', ')}` }, purpose: { type: 'string' } },
      handler: (a) => {
        if (!/^https:\/\//.test(a.url)) throw new CommandError('invalid_params', 'provider URL must be https');
        const id = uid('prv_');
        const pos = (core.db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM providers')?.p as number) ?? 0;
        core.db.run('INSERT INTO providers (id, name, url, kind, purpose, position) VALUES (?, ?, ?, ?, ?, ?)', id, a.name, a.url, a.kind, a.purpose ?? null, pos);
        return A.provider(id);
      },
    },
    {
      id: 'ai.updateProvider', title: 'Update AI Provider', scopes: ['app:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 }, name: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string' }, purpose: { type: 'string' }, position: { type: 'number' } },
      handler: (a) => {
        const p = A.provider(a.id);
        if (a.url && !/^https:\/\//.test(a.url)) throw new CommandError('invalid_params', 'provider URL must be https');
        core.db.run('UPDATE providers SET name = ?, url = ?, kind = ?, purpose = ?, position = ? WHERE id = ?', a.name ?? p.name, a.url ?? p.url, a.kind ?? p.kind, a.purpose ?? p.purpose, a.position ?? p.position, p.id);
        return A.provider(p.id);
      },
    },
    {
      id: 'ai.removeProvider', title: 'Remove AI Provider', scopes: ['app:write'], palette: false,
      params: { id: { type: 'string', required: true, positional: 0 } },
      handler: (a) => ({ removed: core.db.run('DELETE FROM providers WHERE id = ?', A.provider(a.id).id).changes > 0 }),
    },
    {
      id: 'ai.adapters', title: 'AI Site Adapters', scopes: ['ai:send'], palette: false,
      handler: () => Object.fromEntries(Object.keys(ADAPTERS).map((k) => [k, A.adapter(k)])),
    },
    {
      id: 'ai.open', title: 'Open AI Provider', scopes: ['tabs:write'], palette: false,
      params: { provider: { type: 'string', required: true, positional: 0 }, target: { type: 'string', enum: ['tab', 'panel'], default: 'panel' }, newChat: { type: 'boolean', default: false } },
      handler: async (a, ctx) => {
        const p = A.provider(a.provider);
        const existing = A.findTab(p);
        if (existing && !a.newChat) {
          await ctx.run('tabs.activate', { id: existing });
          return { tab: existing, reused: true };
        }
        const t = await ctx.run('tabs.open', { url: A.adapter(p.kind).newChat ?? p.url, target: a.target });
        return { tab: t.id, reused: false };
      },
    },
    {
      id: 'ai.send', title: 'Send To AI', scopes: ['ai:send', 'tabs:write', 'page:interact'], palette: false,
      description: 'Insert text (and attach files) into an AI site you are logged in to. Does not press send unless submit=true (needs forms:submit).',
      params: {
        provider: { type: 'string', required: true, positional: 0 },
        text: { type: 'string', positional: 1 },
        files: { type: 'array', description: 'local files to attach' },
        url: { type: 'string', description: 'file:// to attach, or a web URL to include' },
        prompt: { type: 'string', description: 'saved prompt name; {{text}} is replaced by the content' },
        fromSelection: { type: 'boolean', default: false },
        fromPage: { type: 'boolean', default: false },
        tab: { type: 'string', description: 'source tab for selection/page (default: active)' },
        target: { type: 'string', enum: ['tab', 'panel'], default: 'panel' },
        newChat: { type: 'boolean', default: false },
        submit: { type: 'boolean', description: 'press send (default: setting ai.autoSubmit, off)' },
        timeout: { type: 'number', default: 20000 },
      },
      handler: async (a, ctx) => {
        const p = A.provider(a.provider);
        const ad = A.adapter(p.kind);
        const { text, refs } = await composeText(a, ctx);
        const attach = files(a);
        if (!text && !attach.length) throw new CommandError('invalid_params', 'nothing to send: give text, files, fromSelection or fromPage');
        let tab = a.newChat ? null : A.findTab(p);
        if (tab && a.newChat === false) await ctx.run('tabs.activate', { id: tab }).catch(() => {});
        if (!tab) tab = (await ctx.run('tabs.open', { url: ad.newChat ?? p.url, target: a.target })).id as string;
        core.browser.ensure(tab);
        await sleep(100);
        await core.browser.waitForLoad(tab, a.timeout);
        let inputSel: string;
        try {
          inputSel = await core.browser.waitFor(tab, ad.input, a.timeout);
        } catch {
          throw new CommandError('failed', `couldn't find the ${p.name} message box. Are you logged in there? (tab ${tab})`);
        }
        if (attach.length) {
          await ctx.run('page.upload', { id: tab, files: attach, selector: ad.file });
          await sleep(800 + 400 * attach.length);
        }
        if (text) await ctx.run('page.type', { id: tab, selectors: [inputSel, ...ad.input], text });
        const submit = a.submit ?? !!core.settings.get('ai.autoSubmit');
        let submitted = false;
        if (submit) {
          await ctx.run('ai.submit', { tab, provider: p.id });
          submitted = true;
        }
        core.events.emit('ai.sent', { provider: p.id, tab, chars: text.length, files: attach.length, submitted, refs });
        return { provider: p.name, tab, chars: text.length, files: attach.length, submitted };
      },
    },
    {
      id: 'ai.submit', title: 'Submit AI Prompt', scopes: ['forms:submit', 'page:interact'], palette: false,
      params: { tab: { type: 'string', positional: 0 }, provider: { type: 'string' }, timeout: { type: 'number', default: 15000 } },
      handler: async (a, ctx) => {
        const tab = a.tab ?? core.workspaces.active().activeTab;
        if (!tab) throw new CommandError('failed', 'no tab');
        const kind = a.provider ? A.provider(a.provider).kind : (A.providers().find((p) => sameSite(safeHost(p.url), safeHost(core.workspaces.tab(tab).url)))?.kind ?? 'generic');
        const ad = A.adapter(kind);
        // the send button is often disabled until attachments finish uploading
        const end = Date.now() + a.timeout;
        while (Date.now() < end) {
          const ready = await core.browser.exec(tab, `(() => { for (const s of ${JSON.stringify(ad.send)}) { const b = document.querySelector(s); if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return s; } return null; })()`).catch(() => null);
          if (ready) {
            await ctx.run('page.click', { id: tab, selector: ready, timeout: 2000 });
            core.events.emit('ai.submitted', { tab, kind });
            return { submitted: true, via: 'button' };
          }
          await sleep(300);
        }
        await ctx.run('page.type', { id: tab, selectors: ad.input, text: '' });
        await ctx.run('page.press', { id: tab, key: 'Enter' });
        core.events.emit('ai.submitted', { tab, kind });
        return { submitted: true, via: 'enter' };
      },
    },
    {
      id: 'ai.read', title: 'Read AI Response', scopes: ['page:read'], palette: false,
      params: { tab: { type: 'string', positional: 0 }, all: { type: 'boolean', default: false }, format: { type: 'string', enum: ['text', 'markdown'], default: 'markdown' } },
      handler: async (a) => {
        const tab = a.tab ?? core.workspaces.active().activeTab;
        if (!tab) throw new CommandError('failed', 'no tab');
        const kind = A.providers().find((p) => sameSite(safeHost(p.url), safeHost(core.workspaces.tab(tab).url)))?.kind ?? 'generic';
        const msgs = await readTurns(core, tab, A.adapter(kind), a.format);
        const answers = msgs.filter((m) => m.role === 'assistant').map((m) => m.text);
        return a.all ? { messages: msgs } : { text: answers[answers.length - 1] ?? null, count: answers.length };
      },
    },
    {
      id: 'ai.wait', title: 'Wait For AI Response', scopes: ['page:read'], palette: false,
      description: 'Wait until the latest response stops changing (and the stop button is gone).',
      params: { tab: { type: 'string', positional: 0 }, timeout: { type: 'number', default: 180000 }, stableMs: { type: 'number', default: 2500 } },
      handler: async (a) => {
        const tab = a.tab ?? core.workspaces.active().activeTab;
        if (!tab) throw new CommandError('failed', 'no tab');
        const kind = A.providers().find((p) => sameSite(safeHost(p.url), safeHost(core.workspaces.tab(tab).url)))?.kind ?? 'generic';
        const ad = A.adapter(kind);
        const end = Date.now() + a.timeout;
        let last = '';
        let since = Date.now();
        await sleep(1000);
        while (Date.now() < end) {
          const state = await core.browser
            .exec(tab, `(() => { const busy = ${JSON.stringify(ad.busy)}.some((s) => document.querySelector(s)); let els = []; for (const s of ${JSON.stringify(ad.assistant)}) { els = document.querySelectorAll(s); if (els.length) break; } const l = els[els.length - 1]; return { busy, text: l ? l.innerText : '', n: els.length }; })()`)
            .catch(() => ({ busy: true, text: '', n: 0 }));
          if (state.text !== last) {
            last = state.text;
            since = Date.now();
          } else if (!state.busy && state.text && Date.now() - since >= a.stableMs) {
            return { done: true, text: state.text, responses: state.n };
          }
          await sleep(500);
        }
        return { done: false, text: last };
      },
    },
    {
      id: 'ai.ask', title: 'Ask AI And Wait', scopes: ['ai:send', 'tabs:write', 'page:interact', 'forms:submit', 'page:read'], palette: false,
      description: 'Send, submit, wait for the answer and return it. For macros.',
      params: { provider: { type: 'string', required: true, positional: 0 }, text: { type: 'string', required: true, positional: 1 }, files: { type: 'array' }, newChat: { type: 'boolean', default: true }, timeout: { type: 'number', default: 180000 } },
      handler: async (a, ctx) => {
        const sent = await ctx.run('ai.send', { provider: a.provider, text: a.text, files: a.files, newChat: a.newChat, submit: true, target: 'tab' });
        const r = await ctx.run('ai.wait', { tab: sent.tab, timeout: a.timeout });
        const md = await ctx.run('ai.read', { tab: sent.tab });
        return { tab: sent.tab, done: r.done, text: md.text ?? r.text };
      },
    },
    {
      id: 'ai.askAll', title: 'Ask Several AIs', scopes: ['ai:send', 'tabs:write', 'page:interact', 'workspaces:write'],
      description: 'Open a research workspace with one panel per provider and insert the same prompt in each.',
      params: { text: { type: 'string', required: true, positional: 0 }, providers: { type: 'array', description: 'default: all' }, submit: { type: 'boolean' }, workspace: { type: 'string' } },
      handler: async (a, ctx) => {
        const list = (a.providers?.length ? a.providers.map((r: string) => A.provider(r)) : A.providers()) as Provider[];
        if (!list.length) throw new CommandError('failed', 'no AI providers configured');
        const name = a.workspace ?? `Ask: ${a.text.slice(0, 30)}${a.text.length > 30 ? '…' : ''}`;
        const w = await ctx.run('workspaces.create', { name });
        const first = core.workspaces.get(w.id).activeTab;
        const results: any[] = [];
        for (const [i, p] of list.entries()) {
          const ad = A.adapter(p.kind);
          let tab: string;
          if (i === 0 && first) {
            await ctx.run('tabs.navigate', { id: first, url: ad.newChat ?? p.url });
            tab = first;
          } else {
            tab = (await ctx.run('tabs.open', { url: ad.newChat ?? p.url, workspace: w.id, target: 'panel', side: 'right' })).id;
          }
          results.push({ provider: p.name, tab });
        }
        // fill all composers in parallel; one failing site doesn't block the rest
        await Promise.all(
          results.map(async (r, i) => {
            try {
              const p = list[i];
              const ad = A.adapter(p.kind);
              core.browser.ensure(r.tab);
              await sleep(150);
              await core.browser.waitForLoad(r.tab, 20000);
              const sel = await core.browser.waitFor(r.tab, ad.input, 20000);
              await ctx.run('page.type', { id: r.tab, selectors: [sel], text: a.text });
              if (a.submit ?? !!core.settings.get('ai.autoSubmit')) await ctx.run('ai.submit', { tab: r.tab, provider: p.id });
              r.ok = true;
            } catch (e: any) {
              r.ok = false;
              r.error = e.message;
            }
          }),
        );
        return { workspace: w.id, results };
      },
    },
    {
      id: 'ai.capture', title: 'Save AI Conversation To Note', scopes: ['page:read', 'notes:write'],
      params: { tab: { type: 'string', positional: 0 }, title: { type: 'string' }, open: { type: 'boolean', default: false } },
      handler: async (a, ctx) => {
        const tab = a.tab ?? core.workspaces.active().activeTab;
        if (!tab) throw new CommandError('failed', 'no tab');
        const t = core.workspaces.tab(tab);
        const prov = A.providers().find((p) => sameSite(safeHost(p.url), safeHost(t.url)));
        let turns = await readTurns(core, tab, A.adapter(prov?.kind ?? 'generic'), 'markdown');
        let body: string;
        if (turns.length) {
          body = turns.map((m) => `### ${m.role === 'user' ? 'You' : prov?.name ?? 'AI'}\n\n${m.text.trim()}`).join('\n\n');
        } else {
          const page = await ctx.run('page.read', { id: tab, format: 'markdown' });
          body = page.content;
          turns = [];
        }
        const title = a.title ?? `${prov?.name ?? 'AI'} – ${(t.title || 'conversation').replace(/\s*[-|–]\s*(ChatGPT|Claude|Perplexity|Gemini).*$/i, '').slice(0, 60)}`;
        const note = await ctx.run('notes.create', { title, body: `Captured ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from ${t.url}\n\n${body}`, refs: [t.url], tags: ['ai-capture'], open: a.open });
        core.events.emit('ai.captured', { tab, note: note.uri, turns: turns.length });
        return { ...note, turns: turns.length };
      },
    },
    {
      id: 'ai.panel', title: 'AI Workflows', scopes: ['ai:send'],
      handler: () => ({ leaf: core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'ai' }, side: 'right', size: 0.35 }) }),
    },
    // ---- prompt library
    {
      id: 'prompts.list', title: 'List Prompts', scopes: ['ai:send'], palette: false,
      handler: () => core.db.all('SELECT * FROM prompts ORDER BY name'),
    },
    {
      id: 'prompts.save', title: 'Save Prompt', scopes: ['ai:send'], palette: false,
      description: 'Use {{text}} where the selection/page/input goes; otherwise the content is appended.',
      params: { name: { type: 'string', required: true, positional: 0 }, body: { type: 'string', required: true, positional: 1 } },
      handler: (a) => {
        const ex = core.db.get('SELECT id FROM prompts WHERE name = ?', a.name);
        if (ex) core.db.run('UPDATE prompts SET body = ? WHERE id = ?', a.body, ex.id);
        else core.db.run('INSERT INTO prompts (id, name, body, created_at) VALUES (?, ?, ?, ?)', uid('prm_'), a.name, a.body, now());
        return core.db.get('SELECT * FROM prompts WHERE name = ?', a.name);
      },
    },
    {
      id: 'prompts.delete', title: 'Delete Prompt', scopes: ['ai:send'], palette: false,
      params: { name: { type: 'string', required: true, positional: 0 } },
      handler: (a) => ({ deleted: core.db.run('DELETE FROM prompts WHERE id = ? OR name = ?', a.name, a.name).changes > 0 }),
    },
  ];
}

/** User and assistant turns in document order. */
async function readTurns(core: Core, tab: string, ad: SiteAdapter, format: 'text' | 'markdown'): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
  // waitFor installs the page helpers (markdown conversion) in the main world
  await core.browser.waitFor(tab, ['body'], 5000).catch(() => {});
  return core.browser
    .exec(
      tab,
      `(() => {
        const A = ${JSON.stringify(ad.assistant)}, U = ${JSON.stringify(ad.user)};
        const pick = (list) => { for (const s of list) { const els = document.querySelectorAll(s); if (els.length) return s; } return null; };
        const a = pick(A), u = pick(U);
        if (!a) return [];
        const sel = u ? a + ',' + u : a;
        const out = [];
        let prev = null;
        for (const el of document.querySelectorAll(sel)) {
          if (prev && prev.contains(el)) continue;
          prev = el;
          const role = el.matches(a) ? 'assistant' : 'user';
          const text = ${format === 'markdown' ? "window.__sensor ? window.__sensor.md(el) : el.innerText" : 'el.innerText'};
          if (text && text.trim()) out.push({ role, text });
        }
        return out;
      })()`,
    )
    .catch(() => []);
}
