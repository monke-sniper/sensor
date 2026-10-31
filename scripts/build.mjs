// Builds main + preloads with esbuild and the renderer with Vite.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import solid from 'vite-plugin-solid';
import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const prod = process.argv.includes('--prod');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: !prod,
  minify: prod,
  logLevel: 'warning',
  external: ['electron', 'koffi', '@lydell/node-pty', 'node:sqlite'],
};

await Promise.all([
  build({ ...common, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(out, 'main/main.js') }),
  build({ ...common, entryPoints: [join(root, 'src/main/indexer-worker.ts')], outfile: join(out, 'main/indexer-worker.js') }).catch((e) => {
    if (!String(e.message).includes('Could not resolve')) throw e;
  }),
  build({ ...common, entryPoints: [join(root, 'src/preload/shell.ts')], outfile: join(out, 'preload/shell.js') }),
  build({ ...common, entryPoints: [join(root, 'src/preload/web.ts')], outfile: join(out, 'preload/web.js') }),
]);

await viteBuild({
  root: join(root, 'src/renderer'),
  base: './',
  logLevel: 'warn',
  plugins: [solid()],
  build: { outDir: join(out, 'renderer'), emptyOutDir: true, sourcemap: !prod, minify: prod, target: 'chrome130' },
});
console.log('build ok');
