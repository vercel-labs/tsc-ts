// Builds programs with scriptc using this tsc-ts as its type checker, and
// checks they behave like programs built with the tsgo scriptc ships.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { scriptcDist, tscTs, tscTsMissing } from './toolchain.mjs';
import { tempDir } from './temp.mjs';

const bundled = scriptcDist ?? '';
const skip = !existsSync(bundled) ? 'needs the scriptc toolchain' : tscTsMissing;

// A copy of the scriptc toolchain whose checker executables (its bundled
// tsc-ts, and tsgo's tsc) run this tsc-ts. Each run touches `marker`.
function toolchain(marker) {
  const source = realpathSync(bundled);
  const root = tempDir('tsc-ts-scriptc-');
  mkdirSync(join(root, 'bin'));
  for (const name of readdirSync(join(source, 'bin'))) copyFileSync(join(source, 'bin', name), join(root, 'bin', name));
  chmodSync(join(root, 'bin/scriptc'), 0o755);
  // The compiler finds its LLVM helper and runtime pack packages from its own directory, as Node resolves its
  // dependencies. The copy names the installed ones in its manifest instead.
  const manifestPath = join(root, 'bin/scriptc.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const scope = dirname(dirname(source));
  manifest.llvm_package = join(scope, `llvm-${manifest.target}`);
  manifest.runtime_pack = join(scope, `runtime-${manifest.target}`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const link = (from, to, skipName) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (name !== skipName) symlinkSync(join(from, name), join(to, name));
  };
  const wrap = (dir, name) => {
    const lib = join(root, dir);
    link(join(source, dir), lib, name);
    writeFileSync(
      join(lib, name),
      `#!/bin/sh\n: > "${marker}"\nTSC_TS_LIB_DIR="${lib}" exec ${tscTs.map((arg) => `"${arg}"`).join(' ')} "$@"\n`,
    );
    chmodSync(join(lib, name), 0o755);
  };
  mkdirSync(join(root, 'lib'));
  for (const name of readdirSync(join(source, 'lib')))
    if (name !== 'typescript' && name !== 'tsc-ts') symlinkSync(join(source, 'lib', name), join(root, 'lib', name));
  link(join(source, 'lib/typescript'), join(root, 'lib/typescript'), 'lib');
  wrap('lib/typescript/lib', 'tsc');
  link(join(source, 'lib/tsc-ts'), join(root, 'lib/tsc-ts'), 'lib');
  wrap('lib/tsc-ts/lib', 'tsc-ts');
  return join(root, 'bin/scriptc');
}

function build(scriptc, checker, dir, entry) {
  const out = join(dir, 'out');
  const result = spawnSync(scriptc, ['build', entry, '-o', out], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, SCRIPTC_CHECKER: checker },
  });
  const run = result.status === 0 ? spawnSync(out, [], { cwd: dir, encoding: 'utf8' }) : undefined;
  return {
    status: result.status,
    // Build output names the temporary directory.
    output: (result.stdout + result.stderr).replaceAll(dir, '<dir>'),
    run: run && { status: run.status, stdout: run.stdout, stderr: run.stderr },
  };
}

const programs = [
  ['classes.ts', 'classes.ts'],
  ['generics.ts', 'generics.ts'],
  ['modules', 'main.ts'],
  ['type-error.ts', 'type-error.ts'],
];

test('scriptc builds the same programs with tsc-ts', { skip, timeout: 900_000 }, () => {
  const marker = join(tempDir('tsc-ts-marker-'), 'ran');
  const ours = toolchain(marker);
  const theirs = resolve('../../node_modules/.bin/scriptc');
  const seconds = [0, 0];
  for (const [fixture, entry] of programs) {
    const results = [];
    for (const [i, [scriptc, checker]] of [
      [theirs, 'tsgo'],
      [ours, 'tsc-ts'],
    ].entries()) {
      const dir = tempDir('tsc-ts-program-');
      cpSync(resolve('tests/fixtures/programs', fixture), fixture.endsWith('.ts') ? join(dir, fixture) : dir, {
        recursive: true,
      });
      const start = performance.now();
      results.push(build(scriptc, checker, dir, entry));
      seconds[i] += (performance.now() - start) / 1000;
    }
    assert.deepEqual(results[1], results[0], fixture);
    assert.ok(existsSync(marker), `${fixture}: scriptc did not run this tsc-ts`);
    rmSync(marker);
    if (fixture !== 'type-error.ts') assert.equal(results[0].run?.status, 0, `${fixture}: ${results[0].output}`);
  }
  console.log(`builds and runs: ${seconds[0].toFixed(1)} s with tsgo, ${seconds[1].toFixed(1)} s with tsc-ts`);
});
