// The sensor-bridge Obsidian plugin against a real Sensor API server,
// with Obsidian's API stubbed.
import { afterEach, describe, expect, it } from 'vitest';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCore } from './helpers';
import { allModules } from '../../src/core/modules';
import { startApiServer } from '../../src/core/api/server';

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function fakeObsidian(inserted: string[], notices: string[]) {
  class Plugin {
    app: any;
    data: any;
    constructor(app: any, data: any) {
      this.app = app;
      this.data = data;
    }
    loadData() {
      return Promise.resolve(this.data);
    }
    saveData() {
      return Promise.resolve();
    }
    addStatusBarItem() {
      return { text: '', setText(t: string) { this.text = t; }, setAttr() {} };
    }
    registerInterval() {}
    addSettingTab() {}
    addCommand(c: any) {
      (this as any).commands = [...((this as any).commands ?? []), c];
    }
  }
  return {
    Plugin,
    Notice: class { constructor(m: string) { notices.push(m); } },
    MarkdownView: class {},
    PluginSettingTab: class {},
    Setting: class {},
    __editor: { replaceSelection: (t: string) => inserted.push(t), getValue: () => 'see https://example.com/a and https://example.com/b', getSelection: () => '', getLine: () => '', getCursor: () => ({ line: 0 }) },
  };
}

describe('sensor-bridge Obsidian plugin', () => {
  it('connects with the CLI token, receives inserts and runs commands', async () => {
    const { core, dir } = makeCore({ modules: allModules() });
    cleanups.push(() => core.dispose());
    const sock = join(dir, 'api.sock');
    const server = await startApiServer(core, { dataDir: dir, socketPath: sock });
    cleanups.push(() => server.close());

    const inserted: string[] = [];
    const notices: string[] = [];
    const obs = fakeObsidian(inserted, notices);
    const origLoad = (Module as any)._load;
    (Module as any)._load = function (req: string, ...rest: any[]) {
      if (req === 'obsidian') return obs;
      return origLoad.call(this, req, ...rest);
    };
    cleanups.push(() => void ((Module as any)._load = origLoad));
    (globalThis as any).window ??= globalThis;

    const Bridge = createRequire(import.meta.url)('../../obsidian-plugin/sensor-bridge/main.js');
    const app = {
      vault: { getName: () => 'Test Vault' },
      workspace: { getActiveViewOfType: () => ({ editor: obs.__editor }) },
    };
    const plugin = new Bridge(app, { socketPath: sock, tokenPath: join(dir, 'cli-token') });
    await plugin.onload();
    cleanups.push(() => plugin.onunload());

    for (let i = 0; i < 50 && !core.services.obsidianBridge; i++) await new Promise((r) => setTimeout(r, 50));
    expect(core.services.obsidianBridge.vault).toBe('Test Vault');
    expect(plugin.status.text).toBe('Sensor ●');

    await core.run('obsidian.insert', { text: 'hello from Sensor' });
    for (let i = 0; i < 40 && !inserted.length; i++) await new Promise((r) => setTimeout(r, 25));
    expect(inserted).toEqual(['hello from Sensor']);

    core.workspaces.openTab({ url: 'https://example.com/page' });
    const link = plugin.commands.find((c: any) => c.id === 'insert-sensor-tab-link');
    await link.editorCallback(obs.__editor);
    expect(inserted[1]).toMatch(/^\[.*\]\(https:\/\/example\.com\/page\)$/);

    const open = plugin.commands.find((c: any) => c.id === 'open-links-in-sensor');
    await open.editorCallback(obs.__editor);
    const urls = core.workspaces.allTabs().map((t) => t.url);
    expect(urls).toEqual(expect.arrayContaining(['https://example.com/a', 'https://example.com/b']));

    // the token on disk is the one Sensor created; the plugin never writes it
    expect(readFileSync(join(dir, 'cli-token'), 'utf8')).toMatch(/^snsr_/);
  });

  it('reports a clear error when the bridge is not connected', async () => {
    const { core, cleanup } = makeCore({ modules: allModules() });
    cleanups.push(cleanup);
    await expect(core.run('obsidian.insert', { text: 'x' })).rejects.toThrow(/sensor-bridge plugin is not connected/);
  });
});
