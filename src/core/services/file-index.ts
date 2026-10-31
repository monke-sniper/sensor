// File indexing shared by the worker thread and the in-process fallback.
// Writes file names (and text contents for small text files) into the FTS
// table with source "files".
import { openSync, readSync, closeSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { extname, join, basename } from 'node:path';
import type { Db } from '../db';

export const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1', '.bat', '.cmd', '.yml', '.yaml',
  '.toml', '.ini', '.cfg', '.conf', '.log', '.sql', '.lua', '.swift', '.vue', '.svelte', '.tex', '.rst', '.org', '.env.example',
]);

export interface IndexOptions {
  roots: string[];
  exclude: string[];
  contents: boolean;
  maxContentBytes?: number;
  maxFiles?: number;
}

export function fileUriOf(path: string): string {
  return `sensor://file/${encodeURIComponent(path)}`;
}

function readHead(path: string, max: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    const slice = buf.subarray(0, n);
    // skip binary-looking files
    if (slice.includes(0)) return '';
    return slice.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function indexOne(db: Db, path: string, opts: Pick<IndexOptions, 'contents' | 'maxContentBytes'>): void {
  const uri = fileUriOf(path);
  let st;
  try {
    st = statSync(path);
  } catch {
    db.run('DELETE FROM search_index WHERE uri = ?', uri);
    return;
  }
  if (!st.isFile()) return;
  let body = path;
  const ext = extname(path).toLowerCase();
  if (opts.contents && TEXT_EXT.has(ext) && st.size <= (opts.maxContentBytes ?? 1_000_000)) {
    try {
      body += '\n' + readHead(path, opts.maxContentBytes ?? 1_000_000);
    } catch {
      /* unreadable */
    }
  }
  db.run('DELETE FROM search_index WHERE uri = ?', uri);
  db.run("INSERT INTO search_index (uri, source, title, body, updated) VALUES (?, 'files', ?, ?, ?)", uri, basename(path), body, Date.now());
}

/** Walk roots and index. Yields periodically via the onBatch callback (return false to stop). */
export async function indexRoots(db: Db, opts: IndexOptions, onBatch?: (done: number, current: string) => boolean | void): Promise<number> {
  const excl = new Set(opts.exclude.map((e) => e.toLowerCase()));
  let done = 0;
  const max = opts.maxFiles ?? 500_000;
  const stack = [...opts.roots];
  let batch = 0;
  db.raw.exec('BEGIN');
  try {
    while (stack.length && done < max) {
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || excl.has(e.name.toLowerCase())) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) {
          indexOne(db, p, opts);
          done++;
          if (++batch >= 500) {
            db.raw.exec('COMMIT');
            batch = 0;
            if (onBatch?.(done, p) === false) return done;
            await new Promise((r) => setImmediate(r));
            db.raw.exec('BEGIN');
          }
        }
      }
    }
    db.raw.exec('COMMIT');
  } catch (e) {
    try {
      db.raw.exec('ROLLBACK');
    } catch {
      /* not in tx */
    }
    throw e;
  }
  onBatch?.(done, '');
  return done;
}
