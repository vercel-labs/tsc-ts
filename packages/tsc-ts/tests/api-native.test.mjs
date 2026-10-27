// tsc-ts/api compiled with scriptc: tests/native/api-probe.ts, built natively with the installed scriptc and with
// tsc for Node, prints the same answers for the library fixture projects (files, diagnostics, and the symbols, types,
// signatures and text at every node). api-library.test.mjs compares the Node build's answers with tsc --api's.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compileOptions, compiledDir, tempDir } from './temp.mjs';
import { typescriptLib } from './toolchain.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const scriptc = join(repo, 'node_modules/.bin/scriptc');
const lib = typescriptLib !== undefined && existsSync(typescriptLib) ? realpathSync(typescriptLib) : '';
const skip = (!existsSync(scriptc) || lib === '') && 'needs the scriptc toolchain';
const probe = 'tests/native/api-probe.ts';

function answers(command, config) {
  const result = spawnSync(command[0], [...command.slice(1), config, lib], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n');
}

test('a native build of tsc-ts/api answers as the Node build', { skip, timeout: 900_000 }, () => {
  const node = compiledDir('tsc-ts-api-probe-');
  execFileSync(join(repo, 'node_modules/.bin/tsc'), [...compileOptions, '--outDir', node, '--rootDir', root, probe], {
    cwd: root,
    stdio: 'inherit',
  });
  const nodeProbe = [process.execPath, '--stack-size=16000', join(node, probe.replace(/\.ts$/, '.js'))];

  const buildDir = tempDir('tsc-ts-api-native-build-');
  const native = join(buildDir, 'api-probe');
  // The build emits code in its own process (SCRIPTC_EMIT_WORKERS=0): this build has hung with a forked emit worker
  // still running. A build that takes over ten minutes fails the test; its output goes to a file, which a process left
  // behind cannot hold open the way it could a pipe.
  const log = join(buildDir, 'build.log');
  const fd = openSync(log, 'w');
  const build = spawnSync(scriptc, ['build', probe, '--optimization=dev', '-o', native], {
    cwd: root,
    env: { ...process.env, SCRIPTC_EMIT_WORKERS: '0' },
    stdio: ['ignore', fd, fd],
    timeout: 600_000,
  });
  closeSync(fd);
  assert.ok(
    build.status === 0 && existsSync(native),
    `${build.error === undefined ? '' : build.error.message + '\n'}${readFileSync(log, 'utf8')}`,
  );

  // The library fixture (more than 4,000 answers), and one whose files and config file have errors.
  for (const [fixture, minimum] of [
    ['library', 4000],
    ['library-errors', 50],
  ]) {
    const dir = tempDir('tsc-ts-api-native-');
    cpSync(join(root, 'tests/fixtures', fixture), dir, { recursive: true });
    const config = join(dir, 'tsconfig.json');
    const expected = answers(nodeProbe, config);
    const actual = answers([native], config);
    assert.ok(expected.length > minimum, `${expected.length} answers for ${fixture}`);
    const first = expected.findIndex((line, i) => line !== actual[i]);
    assert.equal(
      first === -1 && actual.length === expected.length,
      true,
      `${fixture}: first difference at line ${first + 1}:
  node:   ${expected[first]}
  native: ${actual[first]}`,
    );
  }
});
