// Cross-compiles the Go CLI into bin/.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.includes('--all')
  ? [['windows', 'amd64', 'sensor.exe'], ['linux', 'amd64', 'sensor-linux'], ['darwin', 'arm64', 'sensor-darwin']]
  : [[process.platform === 'win32' ? 'windows' : process.platform, process.arch === 'x64' ? 'amd64' : process.arch, process.platform === 'win32' ? 'sensor.exe' : 'sensor']];
mkdirSync(join(root, 'bin'), { recursive: true });
for (const [goos, goarch, name] of targets) {
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', join(root, 'bin', name), '.'], {
    cwd: join(root, 'cli'),
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
  console.log(`built bin/${name}`);
}
