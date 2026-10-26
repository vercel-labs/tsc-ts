// Builds the reference scanner, parser, binder, checker, resolver, diagnostics and printer drivers and the tsgo command line from upstream.
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve('../../upstream/TypeScript/tsc');
const expected = JSON.parse(readFileSync('../../upstream.json', 'utf8')).commit;
const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.stdout.trim() !== expected) throw new Error('Upstream revision does not match upstream.json');
// The repository's go.work names modules outside the sparse checkout; the compiler's module builds alone.
const env = { ...process.env, GOWORK: 'off' };
mkdirSync(root + '/internal/checkhost', { recursive: true });
for (const file of ['checkhost.go']) copyFileSync('checkhost/' + file, root + '/internal/checkhost/' + file);
// The tsgo command line, the reference the tsc-ts command line is compared with.
const tsgo = spawnSync('go', ['build', '-o', resolve('dist/tsgo'), './cmd/tsc'], { cwd: root, env, stdio: 'inherit' });
if (tsgo.status !== 0) process.exitCode = tsgo.status ?? 1;
// The tsgo command line laid out as TypeScript's npm package has it: built without embedded lib files, which it
// reads from its own directory, with the lib files next to it. Tests run `tsc --api` from there.
mkdirSync('dist/typescript', { recursive: true });
const packaged = spawnSync('go', ['build', '-tags', 'noembed', '-o', resolve('dist/typescript/tsc'), './cmd/tsc'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (packaged.status !== 0) process.exitCode = packaged.status ?? 1;
const libs = root + '/internal/bundled/libs';
for (const name of readdirSync(libs))
  if (name.endsWith('.d.ts')) copyFileSync(libs + '/' + name, 'dist/typescript/' + name);
for (const name of [
  'scan-oracle',
  'parse-oracle',
  'bind-oracle',
  'check-oracle',
  'resolve-oracle',
  'diag-oracle',
  'encode-oracle',
  'print-oracle',
]) {
  mkdirSync(root + '/cmd/' + name, { recursive: true });
  copyFileSync('oracles/' + name + '/main.go', root + '/cmd/' + name + '/main.go');
  const built = spawnSync('go', ['build', '-o', resolve('dist/' + name), './cmd/' + name], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (built.status !== 0) process.exitCode = built.status ?? 1;
}
