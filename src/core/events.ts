// Typed in-process event bus. Every event gets a monotonic sequence number so
// external subscribers can detect gaps.

export interface SensorEvent<T = any> {
  seq: number;
  ts: number;
  topic: string; // e.g. "tab.changed", "download.completed"
  data: T;
}

type Listener = (e: SensorEvent) => void;

export class EventBus {
  private seq = 0;
  private listeners = new Set<{ pattern: string; fn: Listener }>();

  emit<T>(topic: string, data: T): SensorEvent<T> {
    const e: SensorEvent<T> = { seq: ++this.seq, ts: Date.now(), topic, data };
    for (const l of [...this.listeners]) {
      if (matches(l.pattern, topic)) {
        try {
          l.fn(e);
        } catch (err) {
          console.error(`[events] listener for ${l.pattern} threw`, err);
        }
      }
    }
    return e;
  }

  /** pattern: exact topic, "prefix.*", or "*" */
  on(pattern: string, fn: Listener): () => void {
    const entry = { pattern, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  once(pattern: string, fn: Listener): () => void {
    const off = this.on(pattern, (e) => {
      off();
      fn(e);
    });
    return off;
  }
}

export function matches(pattern: string, topic: string): boolean {
  if (pattern === '*' || pattern === topic) return true;
  if (pattern.endsWith('.*')) return topic.startsWith(pattern.slice(0, -1));
  return false;
}

/** The scope a subscriber needs to see a topic. Topics not listed need no scope. */
export function scopeForTopic(topic: string): string | null {
  const head = topic.split('.')[0];
  const map: Record<string, string> = {
    tab: 'tabs:read',
    page: 'page:read',
    download: 'downloads:read',
    workspace: 'workspaces:read',
    note: 'notes:read',
    file: 'files:read',
    macro: 'macros:read',
    agent: 'agents:read',
    task: 'agents:read',
    project: 'projects:read',
    clipboard: 'clipboard:read',
    feed: 'feeds:read',
    terminal: 'terminals:read',
  };
  return map[head] ?? null;
}
