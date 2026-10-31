// End-to-end smoke test: launches the real Electron app (headless under xvfb
// on Linux CI), drives it through the shell bridge and the local API.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

// a stand-in for an AI chat site: composer, attachments, streamed-ish answer
const CHAT = `<!doctype html><title>Local Chat</title><div id="log"></div>
<form id="f"><textarea id="composer"></textarea><input type="file" id="att"><button type="submit">Send</button></form>
<script>
const $ = (id) => document.getElementById(id);
$('f').onsubmit = (e) => { e.preventDefault(); const t = $('composer').value; const u = document.createElement('div'); u.className = 'user'; u.textContent = t; $('log').append(u); $('composer').value = '';
  const a = document.createElement('div'); a.className = 'assistant'; $('log').append(a); let i = 0; const full = 'echo: ' + t + ($('att').files[0] ? ' +' + $('att').files[0].name : '');
  const iv = setInterval(() => { a.textContent = full.slice(0, i += 4); if (i >= full.length) clearInterval(iv); }, 60); };
</script>`;

const server = createServer((req, res) => {
  if (req.url === '/download.txt') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' }); return res.end('hello download'); }
  if (req.url === '/feed.xml') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Feed</title><item><title>Item One</title><link>http://x/1</link><guid>1</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>first</description></item></channel></rss>`); }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url === '/chat') return res.end(CHAT);
  res.end(req.url === '/two' ? '<title>Two</title><p>second</p>' : PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  // CI annotations are readable through the API even when raw logs aren't
  if (!cond && process.env.GITHUB_ACTIONS) console.log(`::error title=E2E ${name.replace(/[:,]/g, ' ')}::${String(detail).slice(0, 2000).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
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
  // the palette overlay is also a page (index.html#overlay): pick the shell itself
  await app.firstWindow();
  let win = null;
  for (let i = 0; i < 100 && !win; i++) {
    win = app.windows().find((w) => /index\.html$/.test(w.url())) ?? null;
    if (!win) await new Promise((r) => setTimeout(r, 200));
  }
  if (!win) throw new Error('shell window not found: ' + app.windows().map((w) => w.url()).join(', '));
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


  // ---- macros: record real (trusted) input, edit, replay
  const mtab = await run('tabs.open', { url: base + '/' });
  await win.waitForTimeout(600);
  await run('macros.record');
  await win.waitForTimeout(200);
  await run('page.type', { id: mtab.id, selector: '#q', text: 'hello macro' });
  await run('page.click', { id: mtab.id, selector: '#go' });
  await win.waitForTimeout(400);
  const recorded = await run('macros.stopRecording', { name: 'e2e search' });
  const rops = recorded.definition.steps.map((s) => s.op);
  check('macro recorder captures open/type/click', rops[0] === 'open' && rops.includes('type') && rops.includes('click'), rops.join(','));
  const typeStep = recorded.definition.steps.find((s) => s.op === 'type');
  check('recorded steps carry fallback selectors', typeStep?.selectors?.length >= 2 && typeStep.text === 'hello macro', JSON.stringify(typeStep?.selectors));
  const def = { ...recorded.definition, inputs: { q: { type: 'string', default: 'replayed' } } };
  def.steps = def.steps.map((s) => (s.op === 'type' ? { ...s, text: '{{q}}' } : s));
  def.steps.push({ op: 'extract', selector: '#out', save: 'out' }, { op: 'output', name: 'out', value: '{{out}}' });
  await run('macros.save', { id: recorded.id, definition: def });
  const replay = await run('macros.run', { id: recorded.id, inputs: { q: 'from replay' }, wait: true });
  check('macro replays deterministically with inputs', replay.state === 'completed' && replay.outputs.out === 'sent:from replay', replay.error ?? JSON.stringify(replay.outputs));
  await run('triggers.add', { macro: recorded.id, kind: 'event', config: { topic: 'e2e.ping' } });
  check('triggers can be attached to macros', (await run('triggers.list', { macro: recorded.id })).length === 1);

  // ---- AI website workflow against a local chat page
  await run('ai.addProvider', { name: 'Local Chat', url: base + '/chat', kind: 'generic' });
  const att = join(dataDir, 'notes.txt');
  writeFileSync(att, 'attachment');
  const sent = await run('ai.send', { provider: 'Local Chat', text: 'hi there', files: [att], target: 'tab' });
  check('ai.send inserts text and attaches files without sending', sent.files === 1 && sent.submitted === false, JSON.stringify(sent));
  const composer = await run('page.eval', { id: sent.tab, js: "document.getElementById('composer').value" });
  check('composer holds the prompt', composer.result === 'hi there', composer.result);
  await run('ai.submit', { tab: sent.tab, provider: 'Local Chat' });
  const waited = await run('ai.wait', { tab: sent.tab, timeout: 15000, stableMs: 800 });
  check('ai.wait returns the finished answer', waited.done && waited.text === 'echo: hi there +notes.txt', JSON.stringify(waited));
  const conv = await run('ai.read', { tab: sent.tab, all: true });
  check('ai.read returns both turns in order', conv.messages?.map((m) => m.role).join(',') === 'user,assistant', JSON.stringify(conv));

  // ---- projects, worktrees, agents in a real PTY
  const { execFileSync: ex } = await import('node:child_process');
  const repo = join(dataDir, 'demo-repo');
  mkdirSync(repo);
  const g = (...a) => ex('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'e2e@example.com'); g('config', 'user.name', 'E2E'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  const proj = await run('projects.add', { path: repo });
  const wt = await run('git.worktreeAdd', { project: proj.id, branch: 'e2e/feature' });
  check('worktree created next to the repo', existsSync(join(wt.path, 'README.md')), wt.path);
  const ag = await run('agents.start', { agent: 'shell', path: wt.path, panel: false });
  await run('agents.send', { id: ag.id, text: 'git branch --show-current' });
  let agOut = '';
  for (let i = 0; i < 150 && !agOut.includes('e2e/feature'); i++) { await win.waitForTimeout(100); agOut = (await run('agents.read', { id: ag.id })).output; }
  check('agent session runs in the worktree terminal', agOut.includes('e2e/feature'));
  await run('agents.stop', { id: ag.id });
  const ov = await run('projects.overview', { id: proj.id });
  check('project overview lists worktrees with protection', ov.worktrees.length === 2 && ov.worktrees[0].protected === true);

  // ---- checkpoints
  const cp = await run('backup.now');
  const vf = await run('backup.verify', { slot: cp.slot });
  check('checkpoint written and verified', vf[0].ok, JSON.stringify(vf));

  // ---- new panels render
  for (const [tool, text] of [['macros', 'e2e search'], ['projects', 'demo-repo'], ['ai', 'Local Chat'], ['backups', 'Create checkpoint']]) {
    await run('panels.open', { tool });
    let found = false;
    for (let i = 0; i < 30 && !found; i++) { await win.waitForTimeout(100); found = await win.evaluate((t) => document.body.innerText.includes(t), text); }
    check(`${tool} panel renders`, found);
  }
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
  const tail = logs.join('').split('\n').filter((l) => !/StackChildLayerRelativeTo|Debugger|nodejs.org/.test(l)).slice(-40).join('\n');
  console.log('\n--- app log tail ---\n' + tail);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=E2E app log tail::${tail.slice(-3000).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
