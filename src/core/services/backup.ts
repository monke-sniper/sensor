// Two-slot rolling checkpoints.
//
// Each checkpoint goes into the older (or invalid) of two slots. A slot's
// manifest is deleted first and written last, so a crash mid-checkpoint leaves
// that slot invalid and the other slot intact. The database is copied with
// VACUUM INTO (consistent while the app runs). Extra folders listed in
// "backup.include" are copied too; files unchanged since the other slot are
// hard-linked instead of copied when possible.
//
// Restore is staged: the chosen slot is verified, then swapped in at the next
// start, before the database is opened.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Core, CoreModule } from '../core';
import { CommandError, type CommandDef } from '../commands';
import { now } from '../db';

export const SLOTS = ['slot-a', 'slot-b'] as const;
type Slot = (typeof SLOTS)[number];

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  mtimeMs?: number;
}

export interface Manifest {
  format: 1;
  slot: Slot;
  createdAt: number;
  appVersion: string;
  reason: string;
  files: ManifestFile[];
  includes: string[];
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 20 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function readManifest(slotDir: string): Manifest | null {
  const p = join(slotDir, 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    return m && m.format === 1 && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

export function verifySlot(slotDir: string): { ok: boolean; problems: string[]; manifest: Manifest | null } {
  const m = readManifest(slotDir);
  if (!m) return { ok: false, problems: ['no valid manifest'], manifest: null };
  const problems: string[] = [];
  for (const f of m.files) {
    const p = join(slotDir, f.path);
    if (!existsSync(p)) problems.push(`missing ${f.path}`);
    else if (statSync(p).size !== f.size) problems.push(`size mismatch ${f.path}`);
    else if (sha256(p) !== f.sha256) problems.push(`checksum mismatch ${f.path}`);
  }
  return { ok: problems.length === 0, problems, manifest: m };
}

/**
 * Called by Core before opening the database: apply a staged restore.
 * The current database is kept as core.db.before-restore.
 */
export function applyPendingRestore(dataDir: string): { restored: boolean; from?: string; error?: string } {
  const pending = join(dataDir, 'restore-pending.json');
  if (!existsSync(pending)) return { restored: false };
  let slotDir = '';
  try {
    slotDir = JSON.parse(readFileSync(pending, 'utf8')).slotDir;
    const v = verifySlot(slotDir);
    if (!v.ok) throw new Error(v.problems.join('; '));
    const db = join(dataDir, 'core.db');
    if (existsSync(db)) {
      rmSync(`${db}.before-restore`, { force: true });
      copyFileSync(db, `${db}.before-restore`);
    }
    for (const sfx of ['-wal', '-shm']) rmSync(db + sfx, { force: true });
    copyFileSync(join(slotDir, 'core.db'), `${db}.restoring`);
    renameSync(`${db}.restoring`, db);
    // included folders go back to their original locations
    const m = readManifest(slotDir)!;
    for (const f of m.files) {
      if (!f.path.startsWith('include/')) continue;
      const [, idx, ...rest] = f.path.split('/');
      const root = m.includes[Number(idx)];
      if (!root) continue;
      const dest = join(root, ...rest);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(slotDir, f.path), dest);
    }
    rmSync(pending, { force: true });
    writeFileSync(join(dataDir, 'restore-result.json'), JSON.stringify({ ok: true, from: slotDir, at: now() }));
    return { restored: true, from: slotDir };
  } catch (e: any) {
    rmSync(pending, { force: true });
    writeFileSync(join(dataDir, 'restore-result.json'), JSON.stringify({ ok: false, from: slotDir, error: String(e?.message ?? e), at: now() }));
    return { restored: false, error: String(e?.message ?? e) };
  }
}

export class Checkpoints {
  private busy = false;

  constructor(private core: Core) {}

  root(): string {
    const custom = this.core.settings.get<string>('backup.dir');
    return resolve(custom || join(this.core.dataDir, 'checkpoints'));
  }

  slots() {
    return SLOTS.map((slot) => {
      const dir = join(this.root(), slot);
      const m = readManifest(dir);
      return { slot, dir, valid: !!m, createdAt: m?.createdAt ?? null, reason: m?.reason ?? null, files: m?.files.length ?? 0, bytes: m?.files.reduce((n, f) => n + f.size, 0) ?? 0 };
    });
  }

  latest() {
    return this.slots().filter((s) => s.valid).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
  }

  /** Write a checkpoint into the older or invalid slot. */
  async create(reason = 'manual'): Promise<Manifest> {
    if (this.busy) throw new CommandError('failed', 'a checkpoint is already being written');
    this.busy = true;
    const t0 = now();
    try {
      const list = this.slots();
      const target = list.find((s) => !s.valid) ?? list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
      const other = SLOTS.find((s) => s !== target.slot)!;
      const dir = target.dir;
      const otherDir = join(this.root(), other);
      const otherManifest = readManifest(otherDir);
      mkdirSync(dir, { recursive: true });
      // invalidate first: a crash from here on leaves this slot invalid, the other intact
      rmSync(join(dir, 'manifest.json'), { force: true });
      for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });

      const files: ManifestFile[] = [];
      const dbOut = join(dir, 'core.db');
      this.core.db.raw.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
      files.push({ path: 'core.db', size: statSync(dbOut).size, sha256: sha256(dbOut) });

      const includes = (this.core.settings.get<string[]>('backup.include') ?? []).filter((p) => typeof p === 'string' && existsSync(p)).map((p) => resolve(p));
      const prevByPath = new Map((otherManifest?.files ?? []).map((f) => [f.path, f]));
      let linked = 0;
      for (const [i, root] of includes.entries()) {
        for (const src of walk(root)) {
          const rel = relative(root, src).split(/[\\/]/).join('/');
          if (rel.split('/').some((seg) => seg === '.git' || seg === 'node_modules' || seg === '.trash')) continue;
          const st = statSync(src);
          if (st.size > 512 * 1024 * 1024) continue;
          const mpath = `include/${i}/${rel}`;
          const dest = join(dir, mpath);
          mkdirSync(dirname(dest), { recursive: true });
          const prev = prevByPath.get(mpath);
          let done = false;
          if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && existsSync(join(otherDir, mpath))) {
            try {
              linkSync(join(otherDir, mpath), dest);
              files.push({ ...prev });
              linked++;
              done = true;
            } catch {
              /* cross-device or unsupported: copy */
            }
          }
          if (!done) {
            copyFileSync(src, dest);
            files.push({ path: mpath, size: st.size, sha256: sha256(dest), mtimeMs: st.mtimeMs });
          }
        }
      }

      const manifest: Manifest = { format: 1, slot: target.slot, createdAt: now(), appVersion: String(this.core.settings.get('app.version') ?? 'dev'), reason, files, includes };
      writeFileSync(join(dir, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2));
      renameSync(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
      this.core.settings.set('backup.last', manifest.createdAt);
      this.core.events.emit('backup.created', { slot: target.slot, files: files.length, linked, ms: now() - t0, reason });
      return manifest;
    } finally {
      this.busy = false;
    }
  }

  stageRestore(slot: Slot): { slot: Slot; createdAt: number } {
    const dir = join(this.root(), slot);
    const v = verifySlot(dir);
    if (!v.ok) throw new CommandError('failed', `slot ${slot} failed verification: ${v.problems.join('; ')}`);
    writeFileSync(join(this.core.dataDir, 'restore-pending.json'), JSON.stringify({ slotDir: dir, stagedAt: now() }));
    this.core.events.emit('backup.restorePending', { slot, createdAt: v.manifest!.createdAt });
    return { slot, createdAt: v.manifest!.createdAt };
  }
}

export function backupModule(): CoreModule {
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  return {
  name: 'backup',
  init(core) {
    const C = new Checkpoints(core);
    core.services.backup = C;
    const result = join(core.dataDir, 'restore-result.json');
    if (existsSync(result)) {
      try {
        const r = JSON.parse(readFileSync(result, 'utf8'));
        if (r.ok) core.notify('success', 'Checkpoint restored', `Restored from ${r.from}`, 'backup');
        else core.notify('error', 'Checkpoint restore failed', r.error ?? '', 'backup');
      } catch {
        /* ignore */
      }
      rmSync(result, { force: true });
    }
    // automatic checkpoints; checked every 10 minutes
    const check = () => {
      const hours = Number(core.settings.get('backup.intervalHours') ?? 0);
      if (!(hours > 0)) return;
      const last = Number(core.settings.get('backup.last') ?? 0);
      if (now() - last >= hours * 3_600_000) C.create('scheduled').catch((e) => core.notify('error', 'Automatic checkpoint failed', String(e?.message ?? e), 'backup'));
    };
    if (!process.env.SENSOR_TEST) {
      timer = setInterval(check, 10 * 60_000);
      timer.unref?.();
      first = setTimeout(check, 60_000);
      first.unref?.();
    }
    return backupCommands(core, C);
  },
  dispose() {
    if (timer) clearInterval(timer);
    if (first) clearTimeout(first);
  },
  };
}

function backupCommands(core: Core, C: Checkpoints): CommandDef[] {
  return [
    {
      id: 'backup.now', title: 'Create Checkpoint Now', scopes: ['backup:write'],
      params: { reason: { type: 'string', default: 'manual' } },
      handler: async (a) => {
        const m = await C.create(a.reason);
        return { slot: m.slot, createdAt: m.createdAt, files: m.files.length, bytes: m.files.reduce((n, f) => n + f.size, 0) };
      },
    },
    {
      id: 'backup.list', title: 'List Checkpoints', scopes: ['app:read'], palette: false,
      handler: () => ({ root: C.root(), slots: C.slots(), intervalHours: core.settings.get('backup.intervalHours'), includes: core.settings.get('backup.include') ?? [] }),
    },
    {
      id: 'backup.verify', title: 'Verify Checkpoints', scopes: ['app:read'],
      params: { slot: { type: 'string', enum: [...SLOTS], positional: 0 } },
      handler: (a) => (a.slot ? [a.slot] : [...SLOTS]).map((s: string) => ({ slot: s, ...verifySlot(join(C.root(), s)), manifest: undefined })),
    },
    {
      id: 'backup.restore', title: 'Restore Checkpoint', scopes: ['backup:write'], destructive: true, palette: false,
      description: 'Verify a slot and swap it in at the next start. The current database is kept as core.db.before-restore.',
      params: { slot: { type: 'string', enum: [...SLOTS], positional: 0, description: 'default: the newest valid slot' } },
      handler: (a) => {
        const slot = (a.slot ?? C.latest()?.slot) as Slot | undefined;
        if (!slot) throw new CommandError('failed', 'no valid checkpoint');
        return { ...C.stageRestore(slot), restartRequired: true };
      },
    },
    {
      id: 'backup.cancelRestore', title: 'Cancel Pending Restore', scopes: ['backup:write'], palette: false,
      handler: () => {
        const p = join(core.dataDir, 'restore-pending.json');
        const had = existsSync(p);
        rmSync(p, { force: true });
        return { cancelled: had };
      },
    },
  ];
}
