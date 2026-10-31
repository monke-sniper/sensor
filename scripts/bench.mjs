// Performance benchmark: launches the real app and measures startup, memory,
// tab load, suspension savings, search latency and API round-trips.
// Usage: node scripts/build.mjs && node scripts/bench.mjs [--out docs/benchmarks.json]
// (use xvfb-run on headless Linux)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright-core'); } catch { pw = require('playwright'); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const outFile = outArg > 0 ? process.argv[outArg + 1] : null;
const dataDir = mkdtempSync(join(tmpdir(), 'sensor-bench-'));
const sock = process.platform === 'win32' ? `\\\\.\\pipe\\sensor-bench-${process.pid}` : join(dataDir, 'api.sock');

// a mid-sized page: text, list, a few images as data URIs
const PAGE = (n) => `<!doctype html><title>Page ${n}</title><h1>Bench page ${n}</h1>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40)}</p><ul>${Array.from({ length: 200 }, (_, i) => `<li>item ${i}</li>`).join('')}</ul>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE(req.url));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const r1 = (n) => Math.round(n * 10) / 10;
const results = { when: new Date().toISOString(), machine: { platform: platform(), release: release(), cpus: cpus().length, cpu: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30) }, metrics: {} };
const M = results.metrics;

const t0 = performance.now();
const app = await pw._electron.launch({
  executablePath: require('electron'),
  args: [root, '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, SENSOR_TEST: '1', SENSOR_DATA_DIR: dataDir, SENSOR_SOCKET: sock },
  timeout: 60000,
});
try {
  await app.firstWindow();
  let win = null;
  while (!win) {
    win = app.windows().find((w) => /index\.html$/.test(w.url())) ?? null;
    if (!win) await new Promise((r) => setTimeout(r, 20));
  }
  await win.waitForSelector('.sidebar', { state: 'attached', timeout: 60000 });
  M.startupToShellMs = Math.round(performance.now() - t0);
  const run = (id, args = {}) => win.evaluate(([i, a]) => window.sensor.run(i, a), [id, args]);

  await new Promise((r) => setTimeout(r, 4000));
  const idle = await run('metrics.processes');
  M.idleMemMB = idle.memMB;
  M.idleProcesses = idle.processes;

  // tab load: open N tabs sequentially, time until each finished loading
  const N = 10;
  const loads = [];
  const ids = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const t = await run('tabs.open', { url: `${base}/p${i}` });
    ids.push(t.id);
    for (;;) {
      const tab = await run('tabs.get', { id: t.id });
      if (!tab.loading && tab.title === `Page /p${i}`) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    loads.push(performance.now() - s);
  }
  M.tabLoadMedianMs = Math.round(median(loads));
  M.tabLoadP95Ms = Math.round(p95(loads));
  await new Promise((r) => setTimeout(r, 2000));
  const withTabs = await run('metrics.processes');
  M.memWith10TabsMB = withTabs.memMB;
  M.processesWith10Tabs = withTabs.processes;
  const sus = await run('tabs.suspendInactive');
  await new Promise((r) => setTimeout(r, 2000));
  const afterSuspend = await run('metrics.processes');
  M.suspendedTabs = sus.suspended ?? sus.count ?? null;
  M.memAfterSuspendMB = afterSuspend.memMB;
  M.suspendSavedMB = withTabs.memMB - afterSuspend.memMB;

  // page read
  const reads = [];
  await run('tabs.activate', { id: ids[0] });
  for (let i = 0; i < 10; i++) { const s = performance.now(); await run('page.read', { id: ids[0], format: 'markdown' }); reads.push(performance.now() - s); }
  M.pageReadMarkdownMedianMs = r1(median(reads));

  // search: index 2000 text files, then query
  const docs = join(dataDir, 'docs');
  mkdirSync(docs);
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  for (let i = 0; i < 2000; i++) writeFileSync(join(docs, `note-${i}.md`), `# Note ${i}\n${words[i % 10]} ${words[(i * 7) % 10]} unique${i} ${'filler text '.repeat(30)}`);
  const si = performance.now();
  await run('files.addRoot', { path: docs });
  for (;;) {
    const st = await run('app.status');
    if (st.indexed >= 2000) break;
    if (performance.now() - si > 120000) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  M.index2000FilesMs = Math.round(performance.now() - si);
  const qs = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); await run('search.query', { q: `unique${i * 37} ${words[i % 10]}`, limit: 20 }); qs.push(performance.now() - s); }
  M.searchMedianMs = r1(median(qs));
  M.searchP95Ms = r1(p95(qs));

  // API round trip over the pipe/socket with the CLI token
  const token = readFileSync(join(dataDir, 'cli-token'), 'utf8').trim();
  const c = connect(sock);
  await new Promise((r) => c.once('connect', r));
  let buf = '';
  const waiters = new Map();
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiters.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((r) => { const n = ++id; waiters.set(n, r); c.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  await call('auth', { token });
  const rt = [];
  for (let i = 0; i < 300; i++) { const s = performance.now(); await call('app.status', {}); rt.push(performance.now() - s); }
  c.destroy();
  M.apiRoundTripMedianMs = r1(median(rt));
  M.apiRoundTripP95Ms = r1(p95(rt));

  const sw = [];
  for (let i = 0; i < 20; i++) { const s = performance.now(); await run('tabs.activate', { id: ids[i % N] }); sw.push(performance.now() - s); }
  M.tabSwitchMedianMs = r1(median(sw));
} finally {
  await app.close().catch(() => {});
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');
