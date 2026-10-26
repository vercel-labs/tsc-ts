// Compiles a small project, with a package's declarations under node_modules, through tsgo (packages/tsgo/dist/tsgo)
// and tsc-ts (the Node build, or TSC_TS_BIN), and compares their output, exit status and emitted files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const project = join(root, 'packages/tsc-ts/tests/fixtures/tsc-project');
const libs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

// Every file under dir, keyed by relative path.
const files = (dir, base = dir, out = {}) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, base, out);
    else out[relative(base, path)] = readFileSync(path, 'utf8');
  }
  return out;
};

const run = (command, args) => {
  const cwd = tempDir('tsc-ts-tsc-');
  cpSync(project, cwd, { recursive: true });
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TSC_TS_LIB_DIR: libs },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, emitted: files(join(cwd, 'dist')) };
};

test(
  'tsc-ts matches tsgo on a project',
  { skip: (!existsSync(tsgo) && 'run npm run build:oracle') || tscTsMissing, timeout: 600_000 },
  () => {
    for (const args of [
      ['-p', '.'],
      ['-p', '.', '--noEmit'],
      ['-p', '.', '--strict', 'false'],
    ]) {
      const expected = run([tsgo], args);
      const actual = run(tscTs, args);
      assert.equal(actual.stderr, '', args.join(' '));
      assert.equal(actual.stdout, expected.stdout, args.join(' '));
      assert.equal(actual.status, expected.status, args.join(' '));
      assert.deepEqual(actual.emitted, expected.emitted, args.join(' '));
    }
  },
);
