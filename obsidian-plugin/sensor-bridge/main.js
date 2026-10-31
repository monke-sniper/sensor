// Sensor Bridge — an Obsidian plugin (plain CommonJS, no build step).
//
// It talks to Sensor's local API (JSON-RPC over a named pipe on Windows, a
// unix socket elsewhere) with the token Sensor writes to its data folder. It
// only listens for "insert at cursor" requests and runs commands you trigger
// from Obsidian's command palette. Nothing leaves your machine.
const { Plugin, Notice, MarkdownView, PluginSettingTab, Setting } = require('obsidian');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '0.1.0';

function defaultSocketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\sensor-${os.userInfo().username}`;
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  return path.join(base, `sensor-${uid}.sock`);
}

function defaultTokenPath() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Sensor', 'data', 'cli-token');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Sensor', 'data', 'cli-token');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Sensor', 'data', 'cli-token');
}

const DEFAULTS = { socketPath: '', tokenPath: '', token: '' };

class Client {
  constructor(plugin) {
    this.plugin = plugin;
    this.sock = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.retry = 1000;
    this.closed = false;
  }

  token() {
    const s = this.plugin.settings;
    if (s.token) return s.token.trim();
    try {
      return fs.readFileSync(s.tokenPath || defaultTokenPath(), 'utf8').trim();
    } catch {
      return '';
    }
  }

  connect() {
    if (this.closed) return;
    const p = this.plugin.settings.socketPath || defaultSocketPath();
    const sock = net.connect(p);
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('connect', async () => {
      try {
        const token = this.token();
        if (!token) throw new Error('no token: start Sensor once, or paste a token in the plugin settings');
        await this.call('auth', { token });
        await this.call('events.subscribe', { topics: ['note.obsidianInsert'] });
        this.connected = true;
        this.retry = 1000;
        this.hello();
        this.plugin.setStatus(true);
      } catch (e) {
        this.plugin.setStatus(false, String(e.message || e));
        sock.destroy();
      }
    });
    sock.on('data', (d) => this.onData(d));
    sock.on('error', () => {});
    sock.on('close', () => {
      this.connected = false;
      this.plugin.setStatus(false);
      for (const [, p] of this.pending) p.reject(new Error('disconnected'));
      this.pending.clear();
      if (!this.closed) {
        setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 30000);
      }
    });
  }

  hello() {
    if (!this.connected) return;
    this.call('obsidian.bridgeHello', { vault: this.plugin.app.vault.getName(), version: VERSION }).catch(() => {});
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === 'event') this.plugin.onEvent(msg.params);
      else if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('Sensor is not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('Sensor did not answer'));
        }
      }, 60000);
    });
  }

  close() {
    this.closed = true;
    this.sock?.destroy();
  }
}

module.exports = class SensorBridge extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.status = this.addStatusBarItem();
    this.setStatus(false);
    this.client = new Client(this);
    this.client.connect();
    this.registerInterval(window.setInterval(() => this.client.hello(), 30000));
    this.addSettingTab(new BridgeSettings(this.app, this));

    this.addCommand({
      id: 'insert-sensor-tab-link',
      name: "Insert link to Sensor's current tab",
      editorCallback: async (editor) => {
        const t = await this.run('tabs.get', {});
        if (t) editor.replaceSelection(`[${t.title || t.url}](${t.url})`);
      },
    });
    this.addCommand({
      id: 'insert-sensor-page',
      name: "Insert Sensor's current page as markdown",
      editorCallback: async (editor) => {
        const p = await this.run('page.read', { format: 'markdown' });
        if (p) editor.replaceSelection(`> Source: [${p.title}](${p.url})\n\n${p.content}\n`);
      },
    });
    this.addCommand({
      id: 'insert-sensor-selection',
      name: "Insert Sensor's selected text as a quote",
      editorCallback: async (editor) => {
        const t = await this.run('tabs.get', {});
        const s = await this.run('page.selection', {});
        if (s && s.text) editor.replaceSelection(s.text.split('\n').map((l) => `> ${l}`).join('\n') + `\n> — [${t?.title || 'source'}](${t?.url || ''})\n`);
        else new Notice('Nothing is selected in Sensor');
      },
    });
    this.addCommand({
      id: 'open-links-in-sensor',
      name: "Open this note's web links in Sensor",
      editorCallback: async (editor) => {
        const urls = [...new Set((editor.getValue().match(/https?:\/\/[^\s)\]>"']+/g) || []))].slice(0, 20);
        if (!urls.length) return new Notice('No web links in this note');
        for (const url of urls) await this.run('tabs.open', { url, background: true });
        new Notice(`Opened ${urls.length} link(s) in Sensor`);
      },
    });
    this.addCommand({
      id: 'search-sensor',
      name: 'Search Sensor for the selection',
      editorCallback: async (editor) => {
        const q = editor.getSelection() || editor.getLine(editor.getCursor().line);
        const hits = await this.run('search.query', { q, limit: 10 });
        if (!hits || !hits.length) return new Notice('No results in Sensor');
        editor.replaceSelection(`${q}\n\n` + hits.map((h) => `- ${h.title} — ${h.uri}`).join('\n') + '\n');
      },
    });
  }

  onunload() {
    this.client?.close();
  }

  async run(method, params) {
    try {
      return await this.client.call(method, params);
    } catch (e) {
      new Notice(`Sensor: ${e.message}`);
      return null;
    }
  }

  onEvent(e) {
    if (e.topic !== 'note.obsidianInsert') return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return new Notice('Sensor: open a note to insert into');
    view.editor.replaceSelection(String(e.data.text || ''));
  }

  setStatus(on, why) {
    if (!this.status) return;
    this.status.setText(on ? 'Sensor ●' : 'Sensor ○');
    this.status.setAttr('title', on ? 'Connected to Sensor' : `Not connected to Sensor${why ? `: ${why}` : ''}`);
  }
};

class BridgeSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const save = async () => {
      await this.plugin.saveData(this.plugin.settings);
      this.plugin.client.sock?.destroy(); // reconnect with new settings
    };
    new Setting(containerEl).setName('Socket / pipe path').setDesc(`Default: ${defaultSocketPath()}`).addText((t) => t.setValue(this.plugin.settings.socketPath).onChange(async (v) => { this.plugin.settings.socketPath = v.trim(); await save(); }));
    new Setting(containerEl).setName('Token file').setDesc(`Default: ${defaultTokenPath()}`).addText((t) => t.setValue(this.plugin.settings.tokenPath).onChange(async (v) => { this.plugin.settings.tokenPath = v.trim(); await save(); }));
    new Setting(containerEl).setName('Token').setDesc('Optional: a token from "sensor auth grant obsidian notes:read,notes:write,tabs:read,tabs:write,page:read,search:read". Overrides the token file.').addText((t) => t.setValue(this.plugin.settings.token).onChange(async (v) => { this.plugin.settings.token = v.trim(); await save(); }));
  }
}
