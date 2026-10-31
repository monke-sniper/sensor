import * as electron from 'electron';
import { Notification, clipboard, net, shell } from 'electron';
import type { PlatformHost } from '../core/host';

export function electronPlatformHost(): PlatformHost {
  return {
    trash: (p) => shell.trashItem(p),
    async openPath(p) {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    },
    showInFolder: (p) => shell.showItemInFolder(p),
    openExternal: (u) => shell.openExternal(u),
    async fetchText(url) {
      // net.fetch uses Chromium's network stack (system proxy, certificates).
      const r = await net.fetch(url, { headers: { 'user-agent': 'Sensor/0.1 (+feed reader)' } });
      return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type') ?? '' };
    },
    clipboardWriteText: (t) => clipboard.writeText(t),
    clipboardWriteImage: (png) => {
      const Item = (electron as any).ClipboardItem;
      if (Item) clipboard.write([new Item({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    },
    osNotify(title, body) {
      if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    },
  };
}
