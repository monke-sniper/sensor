import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core, type CoreOptions } from '../../src/core/core';

export function tempDir(prefix = 'sensor-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeCore(opts: Partial<CoreOptions> = {}): { core: Core; dir: string; cleanup: () => void } {
  const dir = opts.dataDir ?? tempDir();
  const core = new Core({ dataDir: dir, ...opts });
  return {
    core,
    dir,
    cleanup: () => {
      core.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
