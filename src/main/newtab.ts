import type { Core } from '../core/core';

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** sensor://newtab: search box, bookmarks, frequently visited. Rendered server-side, no page privileges. */
export function newTabPage(core: Core): string {
  const tpl = core.settings.get<string>('browser.searchUrl') ?? 'https://duckduckgo.com/?q=%s';
  const bookmarks = core.db.all('SELECT url, title FROM bookmarks ORDER BY created_at DESC LIMIT 16');
  const frequent = core.db.all(
    `SELECT url, max(title) AS title, count(*) AS n FROM history WHERE visited_at > ? GROUP BY url ORDER BY n DESC LIMIT 12`,
    Date.now() - 30 * 86400_000,
  );
  const tile = (r: any) => {
    let host = r.url;
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
    return `<a class="tile" href="${esc(r.url)}"><span class="t">${esc(r.title || host)}</span><span class="h">${esc(host)}</span></a>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>New Tab</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src * data:">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0f14;color:#c9d1d9;font:13px/1.4 "Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding-top:14vh}
h1{font:600 12px/1 ui-monospace,Consolas,monospace;letter-spacing:.4em;color:#4fd1c5;margin:0 0 18px}
form{width:min(640px,90vw)}input{width:100%;padding:12px 14px;border-radius:6px;border:1px solid #1e2630;background:#11161d;color:#e6edf3;font-size:15px;outline:none}
input:focus{border-color:#4fd1c5}
section{width:min(900px,92vw);margin-top:28px}h2{font:600 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.15em;color:#6e7b88;text-transform:uppercase;margin:0 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px}
.tile{display:flex;flex-direction:column;padding:8px 10px;border:1px solid #1e2630;border-radius:5px;background:#0f141a;color:inherit;text-decoration:none;overflow:hidden}
.tile:hover{border-color:#2f3b48;background:#131a22}.t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.h{color:#6e7b88;font-size:11px}
.hint{margin-top:12px;color:#55606b;font-size:11px}kbd{border:1px solid #2a333d;border-radius:3px;padding:0 4px;font-family:inherit}
</style></head><body>
<h1>SENSOR</h1>
<form id="f"><input id="q" autofocus placeholder="Search or enter address"></form>
<div class="hint"><kbd>Ctrl</kbd>+<kbd>K</kbd> command palette · <kbd>Ctrl</kbd>+<kbd>L</kbd> address bar</div>
${bookmarks.length ? `<section><h2>Bookmarks</h2><div class="grid">${bookmarks.map(tile).join('')}</div></section>` : ''}
${frequent.length ? `<section><h2>Frequently visited</h2><div class="grid">${frequent.map(tile).join('')}</div></section>` : ''}
<script>
const tpl=${JSON.stringify(tpl)};
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();const q=document.getElementById('q').value.trim();if(!q)return;
const looksUrl=/^(https?:|file:)/i.test(q)||(/^[^\\s]+\\.[a-z]{2,}(\\/\\S*)?$/i.test(q));location.href=looksUrl?(/^[a-z]+:/i.test(q)?q:'https://'+q):tpl.replace('%s',encodeURIComponent(q));});
</script></body></html>`;
}

export function resourcePage(uri: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Opened in Sensor</title><style>body{background:#0b0f14;color:#8b98a5;font:13px system-ui;display:grid;place-items:center;height:100vh;margin:0}</style></head><body>Opened <code>${esc(uri)}</code> in Sensor.</body></html>`;
}
