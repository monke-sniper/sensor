// Small process helpers shared by services that drive external tools.
import { execFile, spawnSync } from 'node:child_process';

/** Absolute path of an executable on PATH, or null. */
export function which(cmd: string): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0]?.trim() || null;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program without a shell. Never throws for a non-zero exit; check `code`. */
export function exec(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; env?: Record<string, string>; input?: string; verbatim?: boolean } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: !!opts.verbatim, env: opts.env ? { ...process.env, ...opts.env } : process.env, encoding: 'utf8' },
      (err: any, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          if (err.killed) return resolve({ code: 124, stdout: String(stdout ?? ''), stderr: `${stderr ?? ''}\ntimed out` });
          return reject(err); // spawn failure (ENOENT, ...)
        }
        resolve({ code: err ? err.code : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Run a command line through the platform shell (for user-provided validation commands). */
export function shell(commandLine: string, opts: { cwd?: string; timeout?: number } = {}): Promise<ExecResult> {
  return process.platform === 'win32'
    ? exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], { ...opts, verbatim: true }) // same quoting as Node's shell: true
    : exec('/bin/sh', ['-c', commandLine], opts);
}

/** Strip ANSI escape sequences (terminal output for API consumers). */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[()][A-Z0-9]|\u001b[=>]/g, '');
}
