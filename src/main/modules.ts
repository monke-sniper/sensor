// Modules that need Electron: the bridge to web-page preloads (recognition,
// annotations, macro recording), the clipboard watcher, the Chromium media
// host for image conversion, and Obsidian window embedding.
import { BrowserWindow, clipboard, ipcMain, type WebContents, type WebContentsView } from 'electron';
import type { CoreModule } from '../core/core';
import type { ElectronBrowserHost } from './browser';
import { annotationKey } from '../core/services/knowledge-extras';
import type { MediaHost } from '../core/services/documents';
import { obsidianModule } from './obsidian';
import { terminalsModule } from './terminals';

export interface MainRefs {
  win: BrowserWindow;
  browserHost: ElectronBrowserHost;
  overlay: WebContentsView;
}

export function mainModules(refs: () => MainRefs): CoreModule[] {
  return [webBridgeModule(refs), clipboardWatcherModule(refs), mediaHostModule(), obsidianModule(refs), terminalsModule(refs)];
}

function webBridgeModule(refs: () => MainRefs): CoreModule {
  return {
    name: 'web-bridge',
    init(core) {
      const tabOf = (wc: WebContents) => refs().browserHost?.tabIdFor(wc) ?? null;
      const pushAnnotations = (wc: WebContents, url: string) => {
        if (wc.isDestroyed()) return;
        const list = core.services.annotations?.list(url) ?? [];
        wc.send('web:annotations', list);
      };
      ipcMain.on('web:meta', (e, meta) => {
        const tabId = tabOf(e.sender);
        if (tabId) core.services.recognizer?.onMeta(tabId, meta);
      });
      ipcMain.on('web:ready', (e, { url }) => {
        const tabId = tabOf(e.sender);
        if (!tabId) return;
        pushAnnotations(e.sender, url);
        if (core.services.macros?.recording) e.sender.send('web:record', true);
      });
      ipcMain.on('web:annotationUpdate', (e, a) => {
        if (!tabOf(e.sender)) return;
        core.run('annotations.update', a).catch(() => {});
      });
      ipcMain.on('web:annotationDelete', (e, a) => {
        if (!tabOf(e.sender)) return;
        core.run('annotations.delete', { id: a.id }).catch(() => {});
      });
      ipcMain.on('web:recorded', (e, step) => {
        const tabId = tabOf(e.sender);
        if (tabId) core.services.macros?.recordStep(tabId, step);
      });
      core.events.on('annotation.changed', (ev) => {
        for (const t of core.workspaces.allTabs()) {
          if (annotationKey(t.url) !== ev.data.url) continue;
          const wc = refs().browserHost?.liveWebContents(t.id);
          if (wc) pushAnnotations(wc, t.url);
        }
      });
      core.events.on('macro.recording', (ev) => {
        for (const t of core.workspaces.allTabs()) refs().browserHost?.liveWebContents(t.id)?.send('web:record', !!ev.data.on);
      });
    },
  };
}

function clipboardWatcherModule(refs: () => MainRefs): CoreModule {
  let timer: NodeJS.Timeout | null = null;
  const OS = (f: string) => `electron application/osclipboard;format="${f}"`;
  // Windows: a cheap change counter, so we only read the clipboard when it changed.
  const seqFn = (() => {
    if (process.platform !== 'win32') return null;
    try {
      const koffi = require('koffi');
      const f = koffi.load('user32.dll').func('uint32_t __stdcall GetClipboardSequenceNumber()');
      return () => Number(f());
    } catch {
      return null;
    }
  })();
  const mod: CoreModule = {
    name: 'clipboard-watcher',
    init(core) {
      let lastText: string | null = null;
      let lastSeq = -1;
      let busy = false;
      let tickN = 0;
      const excluded = async () => {
        // Password managers mark secrets with these Windows clipboard formats.
        if (process.platform === 'win32') {
          if (await clipboard.has(OS('ExcludeClipboardContentFromMonitorProcessing')).catch(() => false)) return true;
          if (await clipboard.has(OS('Clipboard Viewer Ignore')).catch(() => false)) return true;
          if (await clipboard.has(OS('CanIncludeInClipboardHistory')).catch(() => false)) {
            try {
              const items = await clipboard.read();
              for (const it of items) {
                if (!it.types.includes(OS('CanIncludeInClipboardHistory'))) continue;
                const blob = (await it.getType(OS('CanIncludeInClipboardHistory'))) as Blob;
                const b = Buffer.from(await blob.arrayBuffer());
                if (b.length >= 4 && b.readUInt32LE(0) === 0) return true;
              }
            } catch {
              return true;
            }
          }
        }
        // Copies made while an incognito tab is focused are not recorded.
        const { win } = refs();
        if (win?.isFocused()) {
          const w = core.workspaces.active();
          if (w.activeTab && core.workspaces.hasTab(w.activeTab) && core.workspaces.tab(w.activeTab).profileId.startsWith('incognito')) return true;
        }
        return false;
      };
      const tick = async () => {
        if (busy || !core.settings.get('clipboard.enabled')) return;
        busy = true;
        tickN++;
        try {
          if (seqFn) {
            const s = seqFn();
            if (s === lastSeq) return;
            lastSeq = s;
          }
          const text = await clipboard.readText();
          if (lastText === null) {
            lastText = text; // don't record whatever was on the clipboard at startup
            return;
          }
          if (text && text !== lastText) {
            lastText = text;
            if (await excluded()) return;
            core.services.clipboard.add({ kind: /^https?:\/\/\S+$/.test(text.trim()) ? 'url' : 'text', text: text.slice(0, 200_000) });
            return;
          }
          // Images: checked on every change on Windows, every 5s elsewhere.
          if (!seqFn && tickN % 5 !== 0) return;
          if (!(await clipboard.has('image/png').catch(() => false))) return;
          const items = await clipboard.read();
          const it = items.find((i) => i.types.includes('image/png'));
          if (!it) return;
          const png = Buffer.from(await ((await it.getType('image/png')) as Blob).arrayBuffer());
          if (png.length > 8 * 1024 * 1024) return;
          if (await excluded()) return;
          const w = png.length > 24 ? png.readUInt32BE(16) : 0;
          const h = png.length > 24 ? png.readUInt32BE(20) : 0;
          core.services.clipboard.add({ kind: 'image', image: png, text: `Image ${w}×${h}` });
        } catch {
          /* clipboard busy */
        } finally {
          busy = false;
        }
      };
      timer = setInterval(tick, 1000);
    },
    dispose() {
      if (timer) clearInterval(timer);
    },
  };
  return mod;
}

/** A hidden window used as a codec host: decode any image Chromium supports, encode png/jpeg/webp via canvas. */
function mediaHostModule(): CoreModule {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  const ensure = () => {
    if (win && !win.isDestroyed()) return ready!;
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: false, sandbox: true, contextIsolation: true } });
    ready = win.loadURL('data:text/html,<meta charset=utf-8><title>media</title>').then(() => undefined);
    return ready;
  };
  const host: MediaHost = {
    async convertImage(input, mime, to, quality) {
      await ensure();
      const b64 = input.toString('base64');
      const out: string = await win!.webContents.executeJavaScript(`(async () => {
        const blob = await (await fetch('data:${mime};base64,${b64}')).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d');
        ${to === 'jpeg' ? "ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, bmp.width, bmp.height);" : ''}
        ctx.drawImage(bmp, 0, 0);
        const outBlob = await c.convertToBlob({ type: 'image/${to}', quality: ${quality} });
        const buf = new Uint8Array(await outBlob.arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return btoa(s);
      })()`);
      return Buffer.from(out, 'base64');
    },
  };
  return {
    name: 'media-host',
    init(core) {
      core.services.media = host;
    },
    dispose() {
      if (win && !win.isDestroyed()) win.destroy();
    },
  };
}
