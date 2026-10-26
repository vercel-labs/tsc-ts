// tsc-ts/api compiled with scriptc: tests/native/api-probe.ts, built natively with the installed scriptc and with
// tsc for Node, prints the same answers for the library fixture projects (files, diagnostics, and the symbols, types,
// signatures and text at every node). api-library.test.mjs compares the Node build's answers with tsc --api's.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildWithDiagnostics, environmentReport } from './probe-build-diagnostics.mjs';
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

test('a native build of tsc-ts/api answers as the Node build', { skip, timeout: 1_800_000 }, async () => {
  const node = compiledDir('tsc-ts-api-probe-');
  execFileSync(join(repo, 'node_modules/.bin/tsc'), [...compileOptions, '--outDir', node, '--rootDir', root, probe], {
    cwd: root,
    stdio: 'inherit',
  });
  const nodeProbe = [process.execPath, '--stack-size=16000', join(node, probe.replace(/\.ts$/, '.js'))];

  // Diagnostics for a hang in scriptc's forked emit workers: the probe is built three times with scriptc's own emit
  // worker count, and a build that has not finished after six minutes is reported while it is stuck, then killed.
  const env = { ...process.env };
  delete env.SCRIPTC_EMIT_WORKERS;
  console.log(environmentReport(scriptc));
  let native = '';
  for (let i = 0; i < 3; i++) {
    const buildDir = tempDir('tsc-ts-api-native-build-');
    const output = join(buildDir, 'api-probe');
    const build = await buildWithDiagnostics(
      scriptc,
      [probe, '--optimization=dev', '-o', output],
      root,
      env,
      join(buildDir, 'build.log'),
      360_000,
    );
    console.log(build.report);
    assert.ok(build.status === 0 && existsSync(output), `${build.report}\n${build.output}`);
    native = output;
  }

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
