// Worker thread: indexes files without blocking the main process.
import { parentPort, workerData } from 'node:worker_threads';
import { Db } from '../core/db';
import { indexRoots, type IndexOptions } from '../core/services/file-index';

const { dbPath, opts } = workerData as { dbPath: string; opts: IndexOptions };
let stop = false;
parentPort?.on('message', (m) => {
  if (m === 'stop') stop = true;
});

(async () => {
  const db = new Db(dbPath);
  try {
    const n = await indexRoots(db, opts, (done, current) => {
      parentPort?.postMessage({ type: 'progress', done, current });
      return !stop;
    });
    parentPort?.postMessage({ type: 'done', done: n });
  } catch (e: any) {
    parentPort?.postMessage({ type: 'error', error: String(e?.message ?? e) });
  } finally {
    db.close();
  }
})();
