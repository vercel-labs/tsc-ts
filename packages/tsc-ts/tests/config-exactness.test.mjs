// How scripts/config-exactness.mjs classifies a difference: a run that prints what the reference printed passes,
// one that prints what the unshared run at its count printed is counted apart, any other difference fails, and a
// one-checker difference from tsgo fails only when it is new against --baseline. The compilers here are shell
// scripts that print what the case being tested makes them print.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads the count from --checkers. */
const count = `count=1
previous=
for argument in "$@"; do
  [ "$previous" = "--checkers" ] && count=$argument
  previous=$argument
done`;

/** A project directory with an empty program, and the projects file that names it. */
function project(dir) {
  mkdirSync(join(dir, 'p'), { recursive: true });
  writeFileSync(join(dir, 'p/tsconfig.json'), '{ "files": [] }\n');
  const file = join(dir, 'projects.txt');
  writeFileSync(file, 'p ' + join(dir, 'p') + ' tsconfig.json\n');
  return ['--projects', file];
}

function compiler(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  return path;
}

function run(dir, projects, extra) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/config-exactness.mjs'), ...projects, '--work', join(dir, 'work'), ...extra],
    { encoding: 'utf8', env: { ...process.env, TSC_TS_SHARE: undefined } },
  );
  assert.equal(result.status === null, false, result.stderr);
  return { status: result.status, output: result.stdout + result.stderr };
}

/** A case's directory with its tsgo and native compilers, and the projects file of its project. */
function setup(nativeBody) {
  const dir = tempDir('tsc-ts-config-exactness-');
  const projects = project(dir);
  // tsgo prints what one checker prints in every case here.
  const tsgo = compiler(dir, 'tsgo', 'echo one\necho two\nexit 0');
  const native = compiler(dir, 'native', count + '\n' + nativeBody);
  return { dir, projects, tsgo, native };
}

test('identical configurations pass', () => {
  const { dir, projects, tsgo, native } = setup('echo one\necho two\nexit 0');
  const result = run(dir, projects, ['--tsgo', tsgo, '--native', native]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /all match the reference/);
});

test('a shared run that prints what its count printed unshared is counted apart', () => {
  const { dir, projects, tsgo, native } = setup(
    '[ "$count" = 1 ] && { echo one; echo two; exit 0; }\necho three\nexit 0',
  );
  const result = run(dir, projects, ['--tsgo', tsgo, '--native', native]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /as unshared/);
  assert.match(result.output, /4 counts differ from one checker without sharing/);
});

test('a shared run that prints neither fails', () => {
  const { dir, projects, tsgo, native } = setup(
    '[ "$count" = 1 ] && { echo one; echo two; exit 0; }\n[ "$TSC_TS_SHARE" = 1 ] && { echo four; exit 0; }\necho three\nexit 0',
  );
  const result = run(dir, projects, ['--tsgo', tsgo, '--native', native]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /DIFF/);
});

test('a difference from tsgo at one checker fails until --baseline knows the line', () => {
  const { dir, projects, tsgo, native } = setup('echo one\necho other\nexit 0');
  const json = join(dir, 'first.json');
  const first = run(dir, projects, ['--tsgo', tsgo, '--native', native, '--json', json]);
  assert.equal(first.status, 1, first.output);
  assert.match(first.output, /1 projects where one checker differs from tsgo \(a failure without --baseline\)/);

  const same = run(dir, projects, ['--tsgo', tsgo, '--native', native, '--baseline', json]);
  assert.equal(same.status, 0, same.output);
  assert.match(same.output, /no differing line is new/);

  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '{ "differences": [], "asUnshared": [], "countDifferences": [], "referenceDifferences": [] }\n');
  const grown = run(dir, projects, ['--tsgo', tsgo, '--native', native, '--baseline', empty]);
  assert.equal(grown.status, 1, grown.output);
  assert.match(grown.output, /2 differing lines are new/);
});
