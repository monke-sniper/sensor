import { createSignal, For, Show } from 'solid-js';
import { fmtBytes, fmtTime, hostOf, run } from '../../api';
import { state } from '../../store';
import { Empty, useCommand } from './common';

export function DownloadsTool() {
  const [list] = useCommand<any[]>('downloads.list', () => ({}), ['download.*']);
  return (
    <div class="list">
      <div class="list-actions">
        <button onClick={() => run('downloads.clear')}>Clear finished</button>
      </div>
      <Show when={list()?.length} fallback={<Empty>No downloads yet.</Empty>}>
        <For each={list()}>
          {(d) => (
            <div class="row">
              <div class="row-main">
                <div class="row-title">{d.filename}</div>
                <div class="row-sub">
                  {d.state === 'progressing' ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)}` : `${d.state} · ${fmtBytes(d.total || d.received)}`} · {fmtTime(d.started_at)}
                </div>
                <Show when={d.state === 'progressing' && d.total}>
                  <div class="progress"><div style={{ width: `${Math.round((d.received / d.total) * 100)}%` }} /></div>
                </Show>
              </div>
              <Show when={d.state === 'completed'}>
                <button onClick={() => run('downloads.openFile', { id: d.id })}>Open</button>
                <button onClick={() => run('downloads.openFile', { id: d.id, reveal: true })}>Show</button>
              </Show>
              <Show when={d.state === 'progressing'}>
                <button onClick={() => run('downloads.cancel', { id: d.id })}>Cancel</button>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

export function HistoryTool() {
  const [q, setQ] = createSignal('');
  const [list] = useCommand<any[]>('history.search', () => ({ q: q() || undefined, limit: 200 }), ['page.navigated']);
  return (
    <div class="list">
      <input class="filter" placeholder="Filter history" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="list-actions">
        <button onClick={() => run('history.clear', { sinceMinutes: 60 })}>Clear last hour</button>
        <button class="danger" onClick={() => confirm('Clear all browsing history?') && run('history.clear')}>Clear all</button>
      </div>
      <For each={list()}>
        {(h) => (
          <div class="row link" onClick={() => run('tabs.open', { url: h.url })}>
            <div class="row-main">
              <div class="row-title">{h.title || h.url}</div>
              <div class="row-sub">{hostOf(h.url)} · {fmtTime(h.visited_at)}</div>
            </div>
            <button class="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); run('history.delete', { id: h.id }); }}>×</button>
          </div>
        )}
      </For>
    </div>
  );
}

export function BookmarksTool() {
  const [list, refetch] = useCommand<any[]>('bookmarks.list', () => ({}), ['bookmark.added']);
  return (
    <div class="list">
      <Show when={list()?.length} fallback={<Empty>No bookmarks. Press Ctrl+D on a page.</Empty>}>
        <For each={list()}>
          {(b) => (
            <div class="row link" onClick={() => run('tabs.open', { url: b.url })}>
              <div class="row-main">
                <div class="row-title">{b.title || b.url}</div>
                <div class="row-sub">{b.folder ? b.folder + ' · ' : ''}{hostOf(b.url)}</div>
              </div>
              <button class="icon-btn" onClick={(e) => { e.stopPropagation(); run('bookmarks.remove', { id: b.id }).then(refetch); }}>×</button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

export function NotificationsTool() {
  const [list] = useCommand<any[]>('notifications.list', () => ({}), ['notification.*']);
  return (
    <div class="list">
      <div class="list-actions">
        <button onClick={() => run('notifications.markRead')}>Mark all read</button>
        <button onClick={() => run('notifications.clear')}>Clear</button>
      </div>
      <Show when={list()?.length} fallback={<Empty>No notifications.</Empty>}>
        <For each={list()}>
          {(n) => (
            <div class={'row notif ' + n.level + (n.read ? '' : ' unread')} onClick={() => run('notifications.markRead', { id: n.id })}>
              <div class="row-main">
                <div class="row-title">{n.title}</div>
                <Show when={n.body}><div class="row-sub pre">{n.body}</div></Show>
                <div class="row-sub">{n.source} · {fmtTime(n.created_at)}</div>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

export function SearchTool() {
  const [q, setQ] = createSignal('');
  const [sources, setSources] = createSignal<string[]>([]);
  const [allSources] = useCommand<string[]>('search.sources');
  const [hits] = useCommand<any[]>('search.query', () => ({ q: q() || ' ', sources: sources().length ? sources() : undefined, limit: 100 }));
  return (
    <div class="list">
      <input class="filter" autofocus placeholder="Search everything: tabs, history, bookmarks, notes, files, feeds…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="chips">
        <For each={allSources()}>
          {(s) => (
            <button class={'chip' + (sources().includes(s) ? ' on' : '')} onClick={() => setSources((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}>
              {s}
            </button>
          )}
        </For>
      </div>
      <Show when={q().trim()}>
        <For each={hits()}>
          {(h) => (
            <div class="row link" onClick={() => run('resources.open', { uri: h.uri })}>
              <span class="pal-src">{h.source}</span>
              <div class="row-main">
                <div class="row-title">{h.title}</div>
                <div class="row-sub">{h.snippet ?? h.uri}</div>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

export function SettingsTool() {
  const [list, refetch] = useCommand<any[]>('settings.list', () => ({}), ['settings.changed']);
  const [tokens, refetchTokens] = useCommand<any[]>('auth.list', () => ({}));
  const [metrics] = useCommand<any>('metrics.processes');
  const [filter, setFilter] = createSignal('');
  const save = (key: string, raw: string, orig: any) => {
    let v: any = raw;
    if (typeof orig === 'number') v = Number(raw);
    else if (typeof orig === 'boolean') v = raw === 'true';
    else if (typeof orig === 'object') {
      try {
        v = JSON.parse(raw);
      } catch {
        alert('Invalid JSON');
        return;
      }
    }
    run('settings.set', { key, value: v }).then(refetch);
  };
  return (
    <div class="list settings">
      <input class="filter" placeholder="Filter settings" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
      <h3>Settings</h3>
      <For each={list()?.filter((s) => !filter() || s.key.includes(filter()))}>
        {(s) => (
          <div class="setting">
            <div class="setting-key">{s.key}</div>
            <div class="setting-desc">{s.description}</div>
            <Show
              when={typeof s.value === 'boolean'}
              fallback={
                <input
                  value={typeof s.value === 'object' ? JSON.stringify(s.value) : String(s.value)}
                  onChange={(e) => save(s.key, e.currentTarget.value, s.value)}
                />
              }
            >
              <label class="toggle">
                <input type="checkbox" checked={s.value} onChange={(e) => run('settings.set', { key: s.key, value: e.currentTarget.checked }).then(refetch)} /> enabled
              </label>
            </Show>
          </div>
        )}
      </For>
      <h3>API tokens</h3>
      <div class="row-sub">Local API: {state.snap.api?.path ?? 'disabled'}</div>
      <For each={tokens()}>
        {(t) => (
          <div class="row">
            <div class="row-main">
              <div class="row-title">{t.name}</div>
              <div class="row-sub">{t.scopes.join(', ')}</div>
            </div>
            <button class="danger" onClick={() => run('auth.revoke', { id: t.id }).then(refetchTokens)}>Revoke</button>
          </div>
        )}
      </For>
      <h3>Processes</h3>
      <Show when={metrics()}>
        <div class="row-sub">
          {metrics().processes} processes · {metrics().memMB} MB · CPU {metrics().cpu}%
        </div>
        <table class="proc">
          <tbody>
            <For each={(metrics().detail ?? []).sort((a: any, b: any) => b.memMB - a.memMB)}>
              {(p: any) => (
                <tr>
                  <td>{p.type}</td>
                  <td class="ellipsis">{p.name}</td>
                  <td>{p.memMB} MB</td>
                  <td>{p.cpu}%</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
