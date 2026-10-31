// Preload for Sensor's own UI (shell + overlay). Exposes a narrow API; the
// renderer never gets Node access.
import { contextBridge, ipcRenderer } from 'electron';

type Listener = (payload: any) => void;

const api = {
  async run(id: string, args?: Record<string, unknown>): Promise<any> {
    const r = await ipcRenderer.invoke('sensor:run', id, args ?? {});
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    return r.result;
  },
  snapshot: () => ipcRenderer.invoke('sensor:snapshot'),
  setRects: (rects: unknown[]) => ipcRenderer.send('sensor:rects', rects),
  setOverlay: (open: boolean) => ipcRenderer.send('sensor:overlay', open),
  on(channel: 'event' | 'metrics' | 'ui' | 'overlay' | 'terminal', fn: Listener): () => void {
    const ch = `sensor:${channel}`;
    const h = (_e: unknown, p: unknown) => fn(p);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
  send: (channel: string, payload: unknown) => {
    if (!/^sensor:(terminal-input|terminal-resize)$/.test(channel)) return;
    ipcRenderer.send(channel, payload);
  },
};

contextBridge.exposeInMainWorld('sensor', api);
export type SensorApi = typeof api;
