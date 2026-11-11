// tools/build.mjs — server (ESM, node22) to dist/server, client surfaces to public/.
//   node tools/build.mjs          one build, minified
//   node tools/build.mjs --watch  rebuild on change, unminified
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, logLevel: 'info', sourcemap: watch ? 'inline' : false, minify: !watch };

const server = {
  ...common,
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  platform: 'node', format: 'esm', target: 'node22',
  packages: 'external',
};
const overlay = {
  ...common,
  entryPoints: ['src/client/overlay/main.ts'],
  outfile: 'public/overlay.js',
  platform: 'browser', format: 'esm', target: 'es2020',
};

const cfgs = [server, overlay];
if (watch) for (const c of cfgs) await (await context(c)).watch();
else await Promise.all(cfgs.map((c) => build(c)));
