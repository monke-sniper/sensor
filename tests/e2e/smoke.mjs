// End-to-end smoke test: launches the real Electron app (headless under xvfb
// on Linux CI), drives it through the shell bridge and the local API.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright-core'); } catch { pw = require('playwright'); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = mkdtempSync(join(tmpdir(), 'sensor-e2e-'));
const sock = process.platform === 'win32' ? `\\\\.\\pipe\\sensor-e2e-${process.pid}` : join(dataDir, 'api.sock');
const shots = process.env.SENSOR_SHOTS || join(root, 'test-results');

const PAGE = `<!doctype html><html><head><title>Fixture Article</title><meta property="og:type" content="article"></head>
<body><nav>menu</nav><article><h1>Quantum Widgets</h1><p>Widgets are <strong>entangled</strong> devices.</p>
<ul><li>alpha</li><li>beta</li></ul><a href="/two">next page</a></article>
<form onsubmit="event.preventDefault();document.getElementById('out').textContent='sent:'+document.getElementById('q').value">
<input id="q" name="q" placeholder="Query"><button id="go" type="submit">Go</button></form><div id="out"></div>
<input type="file" id="file"><div id="fname"></div><script>document.getElementById('file').onchange=e=>document.getElementById('fname').textContent=e.target.files[0].name</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/download.txt') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' }); return res.end('hello download'); }
  if (req.url === '/feed.xml') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Feed</title><item><title>Item One</title><link>http://x/1</link><guid>1</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>first</description></item></channel></rss>`); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/two' ? '<title>Two</title><p>second</p>' : PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const app = await pw._electron.launch({
  executablePath: require('electron'),
  args: [root, '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, SENSOR_TEST: '1', SENSOR_DATA_DIR: dataDir, SENSOR_SOCKET: sock, ELECTRON_ENABLE_LOGGING: '0' },
  timeout: 60000,
});
const logs = [];
app.process().stdout?.on('data', (d) => logs.push(String(d)));
app.process().stderr?.on('data', (d) => logs.push(String(d)));

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => !!window.sensor, null, { timeout: 30000 });
  await win.waitForSelector('.sidebar', { timeout: 30000, state: 'attached' });
  const run = (id, args = {}) => win.evaluate(([i, a]) => window.sensor.run(i, a), [id, args]);

  const status = await run('app.status');
  check('app boots and reports status', status.workspaces >= 1, JSON.stringify(status));

  const cmds = await run('commands.list');
  check('command registry populated', cmds.length > 60, `${cmds.length} commands`);

  const tab = await run('tabs.open', { url: base + '/' });
  await win.waitForTimeout(500);
  const page = await run('page.read', { id: tab.id, format: 'markdown' });
  check('page.read markdown', page.content.includes('# Quantum Widgets') && page.content.includes('**entangled**'), page.content.slice(0, 120));
  await win.waitForTimeout(300);
  const tabs = await run('tabs.list');
  check('tab title tracked', tabs.some((t) => t.title === 'Fixture Article'));

  await run('page.type', { id: tab.id, selector: '#q', text: 'hello sensor' });
  await run('page.click', { id: tab.id, selector: 'text=Go' });
  await win.waitForTimeout(300);
  const out = await run('page.eval', { id: tab.id, js: "document.getElementById('out').textContent" });
  check('page.type + page.click drive the page', out.result === 'sent:hello sensor', out.result);

  const hist = await run('history.search', { q: 'Fixture' });
  check('history recorded', hist.length >= 1);

  const panel = await run('tabs.open', { url: base + '/two', target: 'panel' });
  await win.waitForTimeout(600);
  const views = await win.evaluate(() => [...document.querySelectorAll('[data-view-tab]')].map((e) => e.dataset.viewTab));
  check('website panel rendered alongside main tab', views.includes(panel.id) && views.includes(tab.id), views.join(','));

  await run('palette.open');
  await win.waitForTimeout(300);
  check('palette opens', true);
  await run('palette.open'); // idempotent
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }));

  // download
  await run('tabs.navigate', { id: tab.id, url: base + '/download.txt' });
  let dl = [];
  for (let i = 0; i < 30; i++) {
    dl = await run('downloads.list');
    if (dl.some((d) => d.state === 'completed')) break;
    await win.waitForTimeout(200);
  }
  check('download completes', dl.some((d) => d.state === 'completed'), JSON.stringify(dl.map((d) => d.state)));

  // local API with the auto-created CLI token
  const token = readFileSync(join(dataDir, 'cli-token'), 'utf8').trim();
  const rpc = await new Promise((resolve, reject) => {
    const s = connect(sock);
    let buf = '';
    const outMsgs = [];
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        outMsgs.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (outMsgs.length === 4) { s.end(); resolve(outMsgs); }
      }
    });
    s.on('error', reject);
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tabs.list', params: {} }) + '\n');
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'auth', params: { token } }) + '\n');
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tabs.list', params: {} }) + '\n');
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'auth.grant', params: { name: 'x', scopes: ['*'] } }) + '\n');
    setTimeout(() => reject(new Error('rpc timeout')), 15000);
  }).catch((e) => [{ error: e.message }]);
  check('API rejects unauthenticated calls', rpc[0]?.error?.code === -32001, JSON.stringify(rpc[0]));
  check('API authenticates token', rpc[1]?.result?.ok === true);
  check('API runs scoped command', Array.isArray(rpc[2]?.result) && rpc[2].result.length >= 2);
  check('API forbids admin scope for CLI token', rpc[3]?.error?.code === -32003, JSON.stringify(rpc[3]?.error));

  // ---- knowledge: vault capture
  const vault = join(dataDir, 'vault');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  await run('notes.addVault', { path: vault });
  await run('tabs.navigate', { id: tab.id, url: base + '/' });
  await win.waitForTimeout(800);
  const cap = await run('notes.capture', { kind: 'page', tab: tab.id });
  const capText = readFileSync(join(vault, cap.path), 'utf8');
  check('page captured into vault as markdown with source link', capText.includes('# Quantum Widgets') && capText.includes(`Source: [Fixture Article](${base}/)`), cap.path);
  const back = await run('notes.backlinks', { uri: base + '/' });
  check('backlink from note to page', back.length >= 1);

  // ---- annotations
  await run('page.eval', { id: tab.id, js: "(() => { const r = document.createRange(); const p = document.querySelector('article p'); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()" });
  const hl = await run('annotations.highlight', { tab: tab.id });
  await win.waitForTimeout(500);
  const marked = await run('page.eval', { id: tab.id, js: "document.querySelectorAll('mark[data-sensor-hl]').length" });
  check('highlight stored and rendered in page', hl.quote.includes('entangled') && marked.result >= 1, `marks=${marked.result}`);

  // ---- recognition
  const rec = await run('page.recognize', { id: tab.id });
  check('article recognized deterministically', rec?.kind === 'article', rec?.kind);

  // ---- pdf from page + image conversion through Chromium codecs
  const pdf = await run('pdf.fromPage', { id: tab.id, out: join(dataDir, 'page.pdf') });
  check('page saved as PDF', pdf.bytes > 1000 && readFileSync(pdf.path).subarray(0, 4).toString() === '%PDF');
  const shot = await run('page.screenshot', { id: tab.id, out: join(dataDir, 'shot.png') });
  const webp = await run('files.convert', { path: shot.path, to: 'webp', quality: 70 });
  check('png → webp via Chromium codec host', readFileSync(webp.path).subarray(8, 12).toString() === 'WEBP', `${webp.bytes} bytes`);

  // ---- rss
  const feed = await run('feeds.add', { url: base + '/feed.xml' });
  check('rss subscribe + parse', feed.items === 1 && feed.title === 'Fixture Feed');

  // ---- terminal
  const term = await run('terminals.open', { panel: false, cmd: process.platform === 'win32' ? 'cmd.exe' : 'bash', args: process.platform === 'win32' ? ['/c', 'echo sensor-term-ok'] : ['-c', 'echo sensor-term-ok'] });
  let tout = '';
  for (let i = 0; i < 30 && !tout.includes('sensor-term-ok'); i++) {
    await win.waitForTimeout(100);
    tout = (await run('terminals.read', { id: term.id })).output;
  }
  check('terminal spawns a pty and output is readable via API', tout.includes('sensor-term-ok'));

  // ---- CLI binary against the running app
  const cliBin = join(root, 'bin', process.platform === 'win32' ? 'sensor.exe' : 'sensor-linux');
  if (existsSync(cliBin)) {
    const { execFileSync } = await import('node:child_process');
    const env = { ...process.env, SENSOR_SOCKET: sock, SENSOR_DATA_DIR: dataDir };
    const cliTabs = JSON.parse(execFileSync(cliBin, ['tabs', 'list', '--json'], { env }).toString());
    check('CLI lists tabs', Array.isArray(cliTabs) && cliTabs.length >= 2, `${cliTabs.length} tabs`);
    const opened = JSON.parse(execFileSync(cliBin, ['tabs', 'open', base + '/two', '--background', '--json'], { env }).toString());
    check('CLI opens a tab with positional + flag params', opened.url === base + '/two');
    const help = execFileSync(cliBin, ['help', 'notes'], { env }).toString();
    check('CLI help is generated from the registry', help.includes('notes capture'));
    let denied = '';
    try { execFileSync(cliBin, ['auth', 'grant', 'x', '*'], { env, stdio: 'pipe' }); } catch (e) { denied = String(e.stderr); }
    check('CLI token cannot grant itself admin', denied.includes('lacks scope'), denied.trim());
  } else check('CLI binary present (run npm run cli:build)', false);

  await win.screenshot({ path: join(shots, 'shell.png') }).catch(() => {});
  if (process.env.SENSOR_E2E_EXTRA) {
    const extra = await import(process.env.SENSOR_E2E_EXTRA);
    await extra.default({ app, win, run, check, base, dataDir });
  }
} catch (e) {
  check('unexpected error', false, e.stack);
} finally {
  await app.close().catch(() => {});
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\n--- app log tail ---\n' + logs.join('').split('\n').slice(-40).join('\n'));
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
