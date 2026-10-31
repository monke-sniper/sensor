// Interfaces the Electron layer implements. Core services only talk to these,
// which keeps core testable in plain Node and keeps the browser engine
// swappable (the "browser engine abstraction" in docs/phase0/01-architecture.md).

export type PageFormat = 'text' | 'markdown' | 'html';

export interface PageContent {
  url: string;
  title: string;
  content: string;
}

export interface BrowserHost {
  /** Make sure the tab's live view exists (recreating a suspended one). */
  ensure(tabId: string): void;
  navigate(tabId: string, url: string): void;
  back(tabId: string): void;
  forward(tabId: string): void;
  reload(tabId: string): void;
  stop(tabId: string): void;
  destroy(tabId: string): void;
  suspend(tabId: string): void;
  isLive(tabId: string): boolean;
  waitForLoad(tabId: string, timeoutMs: number): Promise<void>;
  readPage(tabId: string, format: PageFormat): Promise<PageContent>;
  selection(tabId: string): Promise<string>;
  exec(tabId: string, js: string): Promise<any>;
  click(tabId: string, selectors: string[]): Promise<void>;
  type(tabId: string, selectors: string[], text: string, opts?: { clear?: boolean }): Promise<void>;
  press(tabId: string, key: string): Promise<void>;
  waitFor(tabId: string, selectors: string[], timeoutMs: number): Promise<string>;
  setFiles(tabId: string, selector: string, files: string[]): Promise<void>;
  capture(tabId: string): Promise<Buffer>;
  printToPDF(tabId: string): Promise<Buffer>;
  openDevTools(tabId: string): void;
  zoom(tabId: string, factor: number): void;
}

export interface PlatformHost {
  trash(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  showInFolder(path: string): void;
  openExternal(url: string): Promise<void>;
  fetchText(url: string): Promise<{ status: number; text: string; contentType: string }>;
  clipboardWriteText(text: string): void;
  clipboardWriteImage?(png: Buffer): void;
  osNotify?(title: string, body: string): void;
}

export interface TerminalHost {
  spawn(opts: { id: string; cwd: string; cmd?: string; args?: string[]; env?: Record<string, string>; cols?: number; rows?: number; title?: string; meta?: Record<string, any> }): void;
  /** Recent output (raw, with ANSI) and exit state, or null if unknown. */
  output(id: string): { buffer: string; exited: boolean; exitCode: number | null; pid?: number } | null;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  available(): boolean;
}

/** Fallbacks used in tests and before the Electron layer attaches. */
export function nullBrowserHost(): BrowserHost {
  const fail = async () => {
    throw new Error('browser not available');
  };
  return {
    ensure() {},
    navigate() {},
    back() {},
    forward() {},
    reload() {},
    stop() {},
    destroy() {},
    suspend() {},
    isLive: () => false,
    waitForLoad: async () => {},
    readPage: fail as any,
    selection: async () => '',
    exec: fail,
    click: fail,
    type: fail,
    press: fail,
    waitFor: fail as any,
    setFiles: fail,
    capture: fail as any,
    printToPDF: fail as any,
    openDevTools() {},
    zoom() {},
  };
}
