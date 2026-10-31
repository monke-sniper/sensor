// Obsidian integration.
//
// Obsidian is closed-source, so it cannot run inside Sensor's process. On
// Windows, Sensor embeds the *real* Obsidian window: it launches Obsidian (or
// finds the running instance) and re-parents its top-level window into the
// Obsidian panel with Win32 SetParent. Elsewhere, Obsidian runs as its own
// window and Sensor drives it through obsidian:// URIs and the sensor-bridge
// plugin. Sensor never substitutes its own editor for Obsidian.
import { BrowserWindow, screen, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreModule } from '../core/core';
import type { CommandDef } from '../core/commands';
import type { MainRefs } from './modules';
import type { ViewRect } from './browser';

const NATIVE_ID = 'native:obsidian';

interface Win32 {
  findWindow(pid: number | null): bigint | null;
  embed(child: bigint, parent: bigint): void;
  detach(child: bigint): void;
  place(child: bigint, x: number, y: number, w: number, h: number): void;
  show(child: bigint, visible: boolean): void;
  isWindow(child: bigint): boolean;
}

function loadWin32(): Win32 | null {
  if (process.platform !== 'win32') return null;
  let koffi: any;
  try {
    koffi = require('koffi');
  } catch {
    return null;
  }
  const user32 = koffi.load('user32.dll');
  const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
  const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *buf, int max)');
  const SetParent = user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)');
  const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int idx)');
  const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int idx, intptr_t val)');
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');

  const GWL_STYLE = -16;
  const WS_CHILD = 0x40000000n;
  const WS_POPUP = 0x80000000n;
  const WS_CAPTION = 0x00c00000n;
  const WS_THICKFRAME = 0x00040000n;
  const WS_SYSMENU = 0x00080000n;
  const WS_MINMAX = 0x00030000n;
  const SWP_NOACTIVATE = 0x10;
  const SWP_FRAMECHANGED = 0x20;
  const SWP_SHOWWINDOW = 0x40;
  const originalStyles = new Map<bigint, bigint>();

  const title = (h: bigint) => {
    const buf = Buffer.alloc(1024);
    const n = GetWindowTextW(h, buf, 511);
    return buf.toString('utf16le', 0, n * 2);
  };

  return {
    findWindow(pid) {
      let found: bigint | null = null;
      EnumWindows((h: number | bigint, _l: number) => {
        const hwnd = BigInt(h);
        if (!IsWindowVisible(hwnd)) return true;
        const out = [0];
        GetWindowThreadProcessId(hwnd, out);
        const t = title(hwnd);
        if ((pid && out[0] === pid && t) || /(^|\s-\s)Obsidian( v[\d.]+)?$/.test(t)) {
          found = hwnd;
          return false;
        }
        return true;
      }, 0);
      return found;
    },
    embed(child, parent) {
      const style = BigInt(GetWindowLongPtrW(child, GWL_STYLE));
      if (!originalStyles.has(child)) originalStyles.set(child, style);
      const next = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINMAX)) | WS_CHILD;
      SetWindowLongPtrW(child, GWL_STYLE, next);
      SetParent(child, parent);
      SetWindowPos(child, 0, 0, 0, 100, 100, SWP_FRAMECHANGED | SWP_NOACTIVATE);
    },
    detach(child) {
      SetParent(child, 0);
      const style = originalStyles.get(child);
      if (style !== undefined) SetWindowLongPtrW(child, GWL_STYLE, style);
      originalStyles.delete(child);
      SetWindowPos(child, 0, 100, 100, 1200, 800, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    },
    place(child, x, y, w, h) {
      SetWindowPos(child, 0, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    },
    show(child, visible) {
      ShowWindow(child, visible ? 8 /* SW_SHOWNA */ : 0 /* SW_HIDE */);
    },
    isWindow: (child) => !!IsWindow(child),
  };
}

export function findObsidianExe(configured?: string): string | null {
  if (configured && existsSync(configured)) return configured;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    candidates.push(join(local, 'Programs', 'Obsidian', 'Obsidian.exe'), join(local, 'Obsidian', 'Obsidian.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Obsidian', 'Obsidian.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Obsidian.app/Contents/MacOS/Obsidian');
  } else {
    candidates.push('/usr/bin/obsidian', '/opt/Obsidian/obsidian', '/var/lib/flatpak/exports/bin/md.obsidian.Obsidian', `${process.env.HOME}/.local/bin/obsidian`);
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function obsidianModule(refs: () => MainRefs): CoreModule {
  let hwnd: bigint | null = null;
  let win32: Win32 | null = null;
  let lastRect: ViewRect | null = null;
  let overlayOpen = false;
  let pid: number | null = null;

  const parentHandle = (w: BrowserWindow): bigint => {
    const b = w.getNativeWindowHandle();
    return b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
  };

  const applyLayout = () => {
    if (!win32 || !hwnd) return;
    if (!win32.isWindow(hwnd)) {
      hwnd = null;
      return;
    }
    const { win } = refs();
    if (!lastRect || overlayOpen || !win || win.isMinimized()) {
      win32.show(hwnd, false);
      return;
    }
    const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
    win32.place(hwnd, Math.round(lastRect.x * scale), Math.round(lastRect.y * scale), Math.round(lastRect.width * scale), Math.round(lastRect.height * scale));
  };

  const mod: CoreModule = {
    name: 'obsidian',
    init(core) {
      win32 = loadWin32();
      const { browserHost } = refs();
      if (browserHost) {
        browserHost.nativeLayout = (rects) => {
          lastRect = rects.find((r) => r.tabId === NATIVE_ID) ?? null;
          applyLayout();
        };
      }
      core.events.on('ui.overlay', (e) => {
        overlayOpen = !!e.data.open;
        applyLayout();
      });
      const exe = () => findObsidianExe(core.settings.get<string>('obsidian.exePath'));
      const vaultUri = (vault?: string) => {
        const v = vault ?? core.settings.get<string>('notes.defaultVault') ?? '';
        return v ? `obsidian://open?vault=${encodeURIComponent(v)}` : 'obsidian://open';
      };

      const defs: CommandDef[] = [
        {
          id: 'obsidian.status', title: 'Obsidian Status', scopes: ['notes:read'], palette: false,
          handler: () => ({
            exe: exe(),
            embedSupported: !!win32,
            embedded: !!hwnd && !!win32?.isWindow(hwnd),
            platform: process.platform,
            note: win32 ? 'Embedding uses Win32 window re-parenting of the real Obsidian app.' : 'Window embedding is Windows-only; Obsidian opens as its own window here.',
          }),
        },
        {
          id: 'obsidian.launch', title: 'Open Obsidian', scopes: ['notes:read'],
          params: { vault: { type: 'string', positional: 0 }, embed: { type: 'boolean' } },
          handler: async (a) => {
            const path = exe();
            const uri = vaultUri(a.vault);
            const embed = a.embed ?? core.settings.get<boolean>('obsidian.embed') !== false;
            core.workspaces.openPanel({ panel: { kind: 'tool', tool: 'obsidian' } });
            if (path) {
              const child = spawn(path, [uri], { detached: true, stdio: 'ignore' });
              child.unref();
              pid = child.pid ?? null;
            } else {
              await shell.openExternal(uri); // protocol handler, if Obsidian is installed elsewhere
            }
            if (!embed || !win32) return { launched: true, embedded: false, reason: win32 ? 'embedding disabled' : 'embedding is Windows-only' };
            // Wait for the window (Obsidian may be single-instance: match by title too).
            for (let i = 0; i < 60 && !hwnd; i++) {
              await new Promise((r) => setTimeout(r, 250));
              hwnd = win32.findWindow(pid);
            }
            if (!hwnd) return { launched: true, embedded: false, reason: 'Obsidian window not found' };
            win32.embed(hwnd, parentHandle(refs().win));
            applyLayout();
            core.events.emit('obsidian.embedded', {});
            return { launched: true, embedded: true };
          },
        },
        {
          id: 'obsidian.detach', title: 'Detach Obsidian Window', scopes: ['notes:read'],
          handler: () => {
            if (win32 && hwnd) win32.detach(hwnd);
            hwnd = null;
            return { ok: true };
          },
        },
        {
          id: 'obsidian.openVault', title: 'Open Vault In Obsidian', scopes: ['notes:read'], palette: false,
          params: { vault: { type: 'string', positional: 0 } },
          handler: async (a) => {
            await shell.openExternal(vaultUri(a.vault));
            return { ok: true };
          },
        },
      ];
      return defs;
    },
    dispose() {
      if (win32 && hwnd) {
        try {
          win32.detach(hwnd); // give the user their Obsidian window back
        } catch {
          /* window gone */
        }
      }
    },
  };
  return mod;
}
