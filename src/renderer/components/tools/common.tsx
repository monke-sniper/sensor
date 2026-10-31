import { createResource, onCleanup, type Resource } from 'solid-js';
import { run } from '../../api';
import { onEvent } from '../../store';

/** Fetch a command result and refetch when matching events arrive. */
export function useCommand<T>(id: string | (() => string), args: () => Record<string, any> = () => ({}), topics: string[] = []): [Resource<T | undefined>, () => void] {
  const key = () => ({ id: typeof id === 'function' ? id() : id, args: args() });
  const [res, { refetch }] = createResource(key, (k) => run<T>(k.id, k.args).catch((e) => { console.warn(e); return undefined as any; }));
  if (topics.length) {
    let t: any;
    const off = onEvent((e) => {
      if (topics.some((p) => (p.endsWith('.*') ? e.topic.startsWith(p.slice(0, -1)) : p === e.topic))) {
        clearTimeout(t);
        t = setTimeout(refetch, 120);
      }
    });
    onCleanup(off);
  }
  return [res, refetch];
}

export function Empty(props: { children: any }) {
  return <div class="empty small">{props.children}</div>;
}
