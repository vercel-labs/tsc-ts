// How scripts/config-exactness.mjs classifies a difference: a run that prints what the reference printed passes,
// one that prints what the unshared run at its count printed is counted apart, any other difference fails, and a
// one-checker difference from tsgo fails only when it is new against --baseline. The compilers here are shell
// scripts that print what the case being tested makes them print.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function run(dir, projects, extra, { work = join(dir, 'work'), cwd = undefined } = {}) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/config-exactness.mjs'), ...projects, '--work', work, ...extra],
    { encoding: 'utf8', cwd, env: { ...process.env, TSC_TS_SHARE: undefined } },
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

test('a sharing run stopped at a hook prints what the reference printed', () => {
  const { dir, projects, tsgo, native } = setup('echo one\necho two\nexit 0');
  const result = run(dir, projects, [
    '--tsgo',
    tsgo,
    '--native',
    native,
    '--checkers',
    '4',
    '--repeat',
    '1',
    '--stop',
    '0:1,50',
  ]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /^ {2}c4 stop 0:1 same$/m);
  assert.match(result.output, /^ {2}c4 stop 50 same$/m);
});

test('a stopped run that prints something else fails, and the hook reaches only sharing runs', () => {
  const { dir, projects, tsgo, native } = setup(
    // The hook's runs print a line the reference does not; the unshared runs (which the hook must not
    // reach) print what the reference prints.
    '[ "$count" = 1 ] && { echo one; echo two; exit 0; }\n[ -n "$TSC_TS_SHARE_STOP_AT_MS" ] && echo stopped\necho one\necho two\nexit 0',
  );
  const result = run(dir, projects, [
    '--tsgo',
    tsgo,
    '--native',
    native,
    '--checkers',
    '4',
    '--repeat',
    '1',
    '--stop',
    '0',
  ]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /^ {2}c4 stop 0 1 of 1 DIFF$/m);
  assert.match(result.output, /1 differ/);
});

/** Reads --outDir and --declarationDir, which an emit run passes. */
const directories = `out=
declarations=
previous=
for argument in "$@"; do
  [ "$previous" = "--outDir" ] && out=$argument
  [ "$previous" = "--declarationDir" ] && declarations=$argument
  previous=$argument
done`;

/** Writes `body`'s two files: the program's to --outDir, the declarations to --declarationDir. */
function emitCompiler(dir, name, program, declaration) {
  return compiler(
    dir,
    name,
    directories + '\necho ' + program + ' > "$out/a.js"\necho ' + declaration + ' > "$declarations/a.d.ts"\nexit 0',
  );
}

test("emit runs compare the declarations, wherever the config's declarationDir points", () => {
  const dir = tempDir('tsc-ts-config-exactness-');
  const projects = project(dir);
  // Both write the same file of the program and declarations that differ. With a config's declarationDir taking
  // precedence over --outDir, the declarations would go to a directory the run does not compare.
  const tsgo = emitCompiler(dir, 'tsgo', 'same', 'one');
  const native = emitCompiler(dir, 'native', 'same', 'two');
  const json = join(dir, 'result.json');
  const result = run(dir, projects, ['--tsgo', tsgo, '--native', native, '--emit', '--json', json]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /vs tsgo DIFF 1 files/);
  const record = JSON.parse(readFileSync(json, 'utf8')).projects[0];
  assert.ok(
    record.referenceLines.some((path) => path.endsWith('a.d.ts')),
    'the declaration file is compared: ' + JSON.stringify(record.referenceLines),
  );
});

test('an emit run whose tree is empty fails instead of passing without a comparison', () => {
  const dir = tempDir('tsc-ts-config-exactness-');
  const projects = project(dir);
  // A compiler that writes nothing: two empty trees would compare equal and pass.
  const tsgo = compiler(dir, 'tsgo', 'exit 0');
  const native = compiler(dir, 'native', 'exit 0');
  const result = run(dir, projects, ['--tsgo', tsgo, '--native', native, '--emit']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /wrote no files to compare/);
});

test("a relative --work names this process's directory, not the project's", () => {
  const dir = tempDir('tsc-ts-config-exactness-');
  const projects = project(dir);
  // The compilers start in the project's directory, as a real one does. A --outDir relative to the project would
  // name a different directory than the one this process reads the tree from, and the two empty trees would pass.
  const tsgo = emitCompiler(dir, 'tsgo', 'one', 'declaration');
  const native = emitCompiler(dir, 'native', 'two', 'declaration');
  const result = run(dir, projects, ['--tsgo', tsgo, '--native', native, '--emit'], {
    work: 'emit-work',
    cwd: dir,
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /DIFF 1 files/);
});
