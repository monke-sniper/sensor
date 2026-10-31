// Preload for web content. Runs in an isolated world: page scripts cannot see
// anything here, and nothing is exposed to the page. Handles content metadata,
// annotation rendering and macro recording.
import { ipcRenderer } from 'electron';

// ---------- metadata for deterministic content recognition
function meta(name: string): string | null {
  const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`) as HTMLMetaElement | null;
  return el?.content ?? null;
}

function sendMeta() {
  ipcRenderer.send('web:meta', {
    url: location.href,
    title: document.title,
    ogType: meta('og:type'),
    ogTitle: meta('og:title'),
    ogSiteName: meta('og:site_name'),
    description: meta('description') ?? meta('og:description'),
    canonical: (document.querySelector('link[rel=canonical]') as HTMLLinkElement | null)?.href ?? null,
    author: meta('author'),
    hasArticle: !!document.querySelector('article'),
    hasVideo: !!document.querySelector('video'),
    lang: document.documentElement.lang || null,
  });
}

let lastUrl = '';
function onMaybeNavigated() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  setTimeout(sendMeta, 400);
  ipcRenderer.send('web:ready', { url: location.href });
}
window.addEventListener('DOMContentLoaded', onMaybeNavigated);
// SPA navigations
setInterval(onMaybeNavigated, 1000);

// ---------- annotations
interface Annotation {
  id: string;
  kind: 'highlight' | 'sticky' | 'note';
  quote?: string | null;
  note?: string | null;
  color?: string | null;
  anchor?: string | null; // JSON {prefix, suffix}
  x?: number | null;
  y?: number | null;
}

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

function ensureHost(): ShadowRoot {
  if (shadow && host?.isConnected) return shadow;
  host = document.createElement('div');
  host.setAttribute('data-sensor-annotations', '');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;';
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .sticky{position:absolute;width:220px;min-height:90px;background:#fff7b0;color:#222;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.35);font:12px/1.35 system-ui,sans-serif;display:flex;flex-direction:column;pointer-events:auto}
    .bar{display:flex;justify-content:space-between;align-items:center;padding:3px 6px;background:#f2e68a;border-radius:4px 4px 0 0;cursor:move;font-size:10px;color:#665}
    .bar button{border:0;background:none;cursor:pointer;color:#665;font-size:12px}
    textarea{flex:1;border:0;background:transparent;resize:vertical;min-height:70px;padding:6px;font:inherit;color:inherit;outline:none}
  `;
  shadow.appendChild(style);
  document.documentElement.appendChild(host);
  return shadow;
}

function clearRendered() {
  document.querySelectorAll('mark[data-sensor-hl]').forEach((m) => {
    const parent = m.parentNode!;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  if (shadow) shadow.querySelectorAll('.sticky').forEach((s) => s.remove());
}

function highlightQuote(a: Annotation) {
  if (!a.quote) return;
  const quote = a.quote.trim();
  if (!quote) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT'].includes(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  // Build a flat text index of text nodes so quotes spanning nodes can be found.
  const nodes: Text[] = [];
  let text = '';
  const starts: number[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    starts.push(text.length);
    nodes.push(n as Text);
    text += (n as Text).data;
  }
  let anchor: { prefix?: string; suffix?: string } = {};
  try {
    anchor = a.anchor ? JSON.parse(a.anchor) : {};
  } catch {}
  let idx = -1;
  if (anchor.prefix) {
    const p = text.indexOf(anchor.prefix + quote);
    if (p >= 0) idx = p + anchor.prefix.length;
  }
  if (idx < 0) idx = text.indexOf(quote);
  if (idx < 0) return;
  const end = idx + quote.length;
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i];
    const e = s + nodes[i].data.length;
    if (e <= idx || s >= end) continue;
    const from = Math.max(0, idx - s);
    const to = Math.min(nodes[i].data.length, end - s);
    const range = document.createRange();
    range.setStart(nodes[i], from);
    range.setEnd(nodes[i], to);
    const mark = document.createElement('mark');
    mark.setAttribute('data-sensor-hl', a.id);
    mark.style.cssText = `background:${a.color || '#ffe36e'};color:inherit;border-radius:2px;`;
    if (a.note) mark.title = a.note;
    try {
      range.surroundContents(mark);
    } catch {
      /* partial overlaps with element boundaries are skipped */
    }
  }
}

function renderSticky(a: Annotation) {
  const root = ensureHost();
  const el = document.createElement('div');
  el.className = 'sticky';
  el.style.left = `${a.x ?? 40}px`;
  el.style.top = `${a.y ?? 40}px`;
  el.innerHTML = `<div class="bar"><span>Sensor note</span><button title="Delete">✕</button></div><textarea></textarea>`;
  const ta = el.querySelector('textarea')!;
  ta.value = a.note ?? '';
  let t: any;
  ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => ipcRenderer.send('web:annotationUpdate', { id: a.id, note: ta.value }), 400);
  });
  el.querySelector('button')!.addEventListener('click', () => ipcRenderer.send('web:annotationDelete', { id: a.id }));
  const bar = el.querySelector('.bar') as HTMLElement;
  bar.addEventListener('mousedown', (e) => {
    const sx = e.pageX - el.offsetLeft;
    const sy = e.pageY - el.offsetTop;
    const move = (ev: MouseEvent) => {
      el.style.left = `${ev.pageX - sx}px`;
      el.style.top = `${ev.pageY - sy}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      ipcRenderer.send('web:annotationUpdate', { id: a.id, x: el.offsetLeft, y: el.offsetTop });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  root.appendChild(el);
  if (!a.note) setTimeout(() => ta.focus(), 50);
}

ipcRenderer.on('web:annotations', (_e, list: Annotation[]) => {
  const apply = () => {
    clearRendered();
    for (const a of list) {
      if (a.kind === 'highlight') highlightQuote(a);
      else if (a.kind === 'sticky') renderSticky(a);
    }
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
});

// ---------- macro recording
let recording = false;

function cssEscape(s: string) {
  return (window as any).CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&');
}

function looksGenerated(s: string) {
  return /\d{3,}|[a-f0-9]{8,}|^(css|sc|jsx|ember|react)-/i.test(s);
}

function selectorsFor(el: Element): string[] {
  const out: string[] = [];
  const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
  if (testid) out.push(`[data-testid="${testid}"]`);
  if (el.id && !looksGenerated(el.id)) out.push(`#${cssEscape(el.id)}`);
  const name = el.getAttribute('name');
  if (name) out.push(`${el.tagName.toLowerCase()}[name="${name}"]`);
  const aria = el.getAttribute('aria-label');
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'textarea' || (tag === 'input' && ['text', 'search', 'email', 'url', ''].includes((el as HTMLInputElement).type)) ? 'textbox' : null);
  if (role && aria) out.push(`role=${role}[name="${aria}"]`);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) out.push(`${tag}[placeholder="${placeholder}"]`);
  const txt = (el as HTMLElement).innerText?.trim();
  if ((tag === 'button' || tag === 'a' || role === 'button') && txt && txt.length < 40) out.push(`text=${txt}`);
  // structural fallback
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && !looksGenerated(cur.id)) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  out.push(parts.join(' > '));
  return [...new Set(out)];
}

const pendingInput = new Map<Element, any>();

function interesting(el: Element | null): Element | null {
  if (!el) return null;
  return el.closest('a,button,[role=button],input,select,textarea,label,[contenteditable],[onclick],summary') ?? el;
}

document.addEventListener(
  'click',
  (e) => {
    if (!recording || !e.isTrusted) return;
    const el = interesting(e.target as Element);
    if (!el) return;
    if (el.matches('input[type=text],input[type=search],input[type=email],input:not([type]),textarea,[contenteditable]')) return; // focusing a field, not an action
    ipcRenderer.send('web:recorded', { op: 'click', selectors: selectorsFor(el), label: ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 60), url: location.href });
  },
  true,
);

document.addEventListener(
  'input',
  (e) => {
    if (!recording || !e.isTrusted) return;
    const el = e.target as HTMLInputElement;
    const value = el.isContentEditable ? (el as HTMLElement).innerText : el.value;
    if (el.type === 'password') {
      pendingInput.set(el, { op: 'type', selectors: selectorsFor(el), text: '{{password}}', clear: true, url: location.href, note: 'password replaced with a variable' });
      return;
    }
    pendingInput.set(el, { op: 'type', selectors: selectorsFor(el), text: value, clear: true, url: location.href });
  },
  true,
);

function flushInput(el: Element) {
  const step = pendingInput.get(el);
  if (step) {
    pendingInput.delete(el);
    ipcRenderer.send('web:recorded', step);
  }
}

document.addEventListener('blur', (e) => recording && flushInput(e.target as Element), true);
document.addEventListener(
  'change',
  (e) => {
    if (!recording || !e.isTrusted) return;
    const el = e.target as HTMLSelectElement;
    if (el.tagName === 'SELECT') {
      ipcRenderer.send('web:recorded', { op: 'select', selectors: selectorsFor(el), value: el.value, url: location.href });
    } else flushInput(el);
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (!recording || !e.isTrusted) return;
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
      flushInput(e.target as Element);
      ipcRenderer.send('web:recorded', { op: 'press', key: e.key, url: location.href });
    }
  },
  true,
);

ipcRenderer.on('web:record', (_e, on: boolean) => {
  recording = on;
  if (!on) for (const el of [...pendingInput.keys()]) flushInput(el);
});
ipcRenderer.send('web:hello', {});
