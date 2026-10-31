// JavaScript snippets executed inside web pages (main world) for reading
// content and driving elements deterministically.

/** Defines window.__sensor helpers once per document. */
export const PAGE_HELPERS = `
(() => {
  if (window.__sensor) return;
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const accName = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.value || '').trim();
  const ROLE_TAGS = { button: 'button,[role=button],input[type=button],input[type=submit]', link: 'a[href],[role=link]', textbox: 'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],textarea,[contenteditable=true],[contenteditable=""],[role=textbox]', checkbox: 'input[type=checkbox],[role=checkbox]', heading: 'h1,h2,h3,h4,h5,h6,[role=heading]' };
  const findOne = (sel) => {
    sel = String(sel).trim();
    let list = [];
    try {
      if (sel.startsWith('text=')) {
        const want = sel.slice(5).replace(/^"|"$/g, '').trim().toLowerCase();
        const all = document.querySelectorAll('a,button,[role=button],label,span,div,p,li,h1,h2,h3,h4,td,input[type=submit]');
        for (const el of all) {
          const t = (el.innerText || el.value || '').trim().toLowerCase();
          if (t === want) list.push(el);
        }
        if (!list.length) for (const el of all) { if ((el.innerText || '').trim().toLowerCase().includes(want) && el.children.length === 0) list.push(el); }
      } else if (sel.startsWith('role=')) {
        const m = /^role=([a-z]+)(?:\\[name=["']?(.*?)["']?\\])?$/.exec(sel);
        if (m) {
          const css = ROLE_TAGS[m[1]] || '[role=' + m[1] + ']';
          for (const el of document.querySelectorAll(css)) {
            if (!m[2] || accName(el).toLowerCase().includes(m[2].toLowerCase())) list.push(el);
          }
        }
      } else if (sel.startsWith('xpath=')) {
        const r = document.evaluate(sel.slice(6), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) list.push(r.snapshotItem(i));
      } else {
        list = Array.from(document.querySelectorAll(sel));
      }
    } catch (e) { return null; }
    return list.find(visible) || null;
  };
  const find = (sels) => { for (const s of sels) { const el = findOne(s); if (el) return { el, sel: s }; } return null; };
  const center = (sels) => {
    const f = find(sels);
    if (!f) return null;
    f.el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = f.el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sel: f.sel };
  };
  const focusEl = (sels, clear) => {
    const f = find(sels);
    if (!f) return null;
    const el = f.el;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (clear) {
      if ('value' in el && el.tagName !== 'DIV') { el.select && el.select(); }
      else { const range = document.createRange(); range.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
    } else if (el.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    }
    return f.sel;
  };
  const md = (root) => {
    const out = [];
    const esc = (s) => s.replace(/\\s+/g, ' ');
    const walk = (node, ctx) => {
      if (node.nodeType === 3) { out.push(esc(node.textContent)); return; }
      if (node.nodeType !== 1) return;
      const el = node; const tag = el.tagName.toLowerCase();
      if (['script','style','noscript','svg','nav','footer','iframe','button','form','header','aside'].includes(tag) && el !== root) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const kids = () => el.childNodes.forEach((c) => walk(c, ctx));
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          out.push('\\n\\n' + '#'.repeat(Number(tag[1])) + ' '); kids(); out.push('\\n\\n'); return;
        case 'p': case 'div': case 'section': case 'article': case 'main':
          out.push('\\n\\n'); kids(); out.push('\\n\\n'); return;
        case 'br': out.push('  \\n'); return;
        case 'hr': out.push('\\n\\n---\\n\\n'); return;
        case 'strong': case 'b': out.push('**'); kids(); out.push('**'); return;
        case 'em': case 'i': out.push('_'); kids(); out.push('_'); return;
        case 'code': if (ctx.pre) { kids(); return; } out.push('\`'); kids(); out.push('\`'); return;
        case 'pre': out.push('\\n\\n\`\`\`\\n' + el.innerText + '\\n\`\`\`\\n\\n'); return;
        case 'a': { const href = el.getAttribute('href'); if (!href || href.startsWith('javascript:')) { kids(); return; }
          out.push('['); kids(); out.push('](' + new URL(href, location.href).href + ')'); return; }
        case 'img': { const src = el.getAttribute('src'); if (src) out.push('![' + (el.alt || '') + '](' + new URL(src, location.href).href + ')'); return; }
        case 'ul': case 'ol': { out.push('\\n'); let i = 1; for (const li of el.children) { if (li.tagName !== 'LI') continue; out.push('\\n' + '  '.repeat(ctx.depth) + (tag === 'ol' ? (i++) + '. ' : '- ')); li.childNodes.forEach((c) => walk(c, { ...ctx, depth: ctx.depth + 1 })); } out.push('\\n\\n'); return; }
        case 'blockquote': out.push('\\n\\n> '); kids(); out.push('\\n\\n'); return;
        case 'table': { out.push('\\n\\n'); const rows = Array.from(el.querySelectorAll('tr')); rows.forEach((tr, ri) => { const cells = Array.from(tr.children).map((c) => esc(c.innerText).replace(/\\|/g, '\\\\|')); out.push('| ' + cells.join(' | ') + ' |\\n'); if (ri === 0) out.push('|' + cells.map(() => ' --- |').join('') + '\\n'); }); out.push('\\n'); return; }
        default: kids();
      }
    };
    walk(root, { depth: 0, pre: false });
    return out.join('').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  };
  const mainContent = () => document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]') || document.body;
  window.__sensor = { find, findOne, center, focusEl, md, mainContent, visible };
})();
`;

export function readPageScript(format: 'text' | 'markdown' | 'html'): string {
  if (format === 'html') return `({ url: location.href, title: document.title, content: document.documentElement.outerHTML })`;
  if (format === 'text') return `({ url: location.href, title: document.title, content: document.body ? document.body.innerText : '' })`;
  return `${PAGE_HELPERS}; ({ url: location.href, title: document.title, content: window.__sensor.md(window.__sensor.mainContent()) })`;
}

export function centerScript(selectors: string[]): string {
  return `${PAGE_HELPERS}; window.__sensor.center(${JSON.stringify(selectors)})`;
}

export function focusScript(selectors: string[], clear: boolean): string {
  return `${PAGE_HELPERS}; window.__sensor.focusEl(${JSON.stringify(selectors)}, ${clear})`;
}

export function existsScript(selectors: string[]): string {
  return `${PAGE_HELPERS}; (() => { const f = window.__sensor.find(${JSON.stringify(selectors)}); return f ? f.sel : null; })()`;
}
