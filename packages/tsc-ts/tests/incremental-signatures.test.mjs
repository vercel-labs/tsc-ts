// An incremental program without build info, as a watch builds one, computes the shape signature of a changed file
// from its declaration file even when the options emit no declarations, as tsgo does. A change that keeps the
// declaration file the same then rechecks only the changed file, not the files that import it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

const out = compileSources('tsc-ts-incremental-signatures-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { bindProgram, CheckedProgram } = await load('compiler/program-checker.js');
const { CompileTimes } = await load('compiler/compile-program.js');
const { computeLastSignatures, IncrementalProgram } = await load('compiler/incremental.js');
const { SystemTimeStamps } = await load('compiler/tsc-compile.js');

function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

/**
 * Builds `dir` on the snapshot of the last build; returns the new snapshot, the project files it checks and its
 * checked program. With `last`, the checked program of the last build, the signatures that build left as versions
 * are computed first for the files of `edited`, as a watch computes them for the files it parsed again.
 */
function build(dir, snapshot, last, edited = []) {
  const sys = createNodeSystem(bundledLibs, '');
  const work = executeCommandLine(sys, ['-p', dir]);
  assert.equal(work.kind, 'compile');
  bindProgram(work.program);
  if (last !== undefined) {
    const paths = work.program
      .getSourceFiles()
      .filter((file) => edited.includes(relative(dir, file.fileName)))
      .map((file) => file.path);
    assert.equal(paths.length, edited.length);
    computeLastSignatures(snapshot, last, paths);
  }
  const checkedProgram = new CheckedProgram(work.program);
  const program = new IncrementalProgram(checkedProgram, new CompileTimes(), snapshot, new SystemTimeStamps(sys));
  const checked = program
    .filesToCheck()
    .map((file) => relative(dir, file.fileName))
    .filter((name) => !name.startsWith('..'))
    .sort();
  program.getSemanticDiagnostics();
  return { snapshot: program.snapshot, checked, last: checkedProgram, program };
}

for (const options of [{ noEmit: true }, { outDir: 'out' }]) {
  test(`body edits recheck only the edited file without build info (${JSON.stringify(options)})`, () => {
    const dir = tempDir('tsc-ts-incremental-signatures-project-');
    const lib = (body) => `export function double(x: number): number {\n  return ${body};\n}\n`;
    writeFiles(dir, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, types: [], ...options }, include: ['src'] }),
      'src/lib.ts': lib('x * 2'),
      'src/main.ts': "import { double } from './lib';\nexport const four = double(2);\n",
      'src/app.ts': "import { four } from './main';\nexport const eight = four * 2;\n",
      // A file that affects the global scope: a changed signature of a file it imports rechecks every file.
      'src/globals.ts': "import { double } from './lib';\ndeclare global {\n  var doubled: typeof double;\n}\n",
    });
    let state = build(dir, undefined);
    assert.deepEqual(state.checked, ['src/app.ts', 'src/globals.ts', 'src/lib.ts', 'src/main.ts']);
    // The first build takes each file's version as its signature, so the first edit compares a declaration
    // file with a version and rechecks the importers.
    writeFiles(dir, { 'src/lib.ts': lib('x + x') });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/app.ts', 'src/globals.ts', 'src/lib.ts', 'src/main.ts']);
    writeFiles(dir, { 'src/lib.ts': lib('2 * x') });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/lib.ts']);
    // A changed declaration file rechecks every file, through the file that affects the global scope.
    writeFiles(dir, { 'src/lib.ts': lib('x * 2') + 'export const extra = 1;\n' });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/app.ts', 'src/globals.ts', 'src/lib.ts', 'src/main.ts']);
    // The rebuilds computed no signature for the importers, which keep their versions: the first edit of
    // `main.ts` rechecks its importer, and the next one only `main.ts`.
    const main = (n) => `import { double } from './lib';\nexport const four = double(2);\nvoid ${n};\n`;
    writeFiles(dir, { 'src/main.ts': main(1) });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/app.ts', 'src/main.ts']);
    writeFiles(dir, { 'src/main.ts': main(2) });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/main.ts']);
  });
}

// A watch computes the signature that the last build left as a version for each file it parses again, from the last
// build's program (`computeLastSignatures`). The first edit of a file then rechecks its importers only when its
// declaration file changed.
for (const options of [{ noEmit: true }, { outDir: 'out' }, { outDir: 'out', declaration: true }]) {
  test(`first body edits recheck only the edited file with the last build's signatures (${JSON.stringify(options)})`, () => {
    const dir = tempDir('tsc-ts-incremental-signatures-project-');
    const lib = (body) => `export function double(x: number): number {\n  return ${body};\n}\n`;
    const main = (n) => `import { double } from './lib';\nexport const four = double(2);\nvoid ${n};\n`;
    writeFiles(dir, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, types: [], ...options }, include: ['src'] }),
      'src/lib.ts': lib('x * 2'),
      'src/main.ts': main(0),
      'src/app.ts': "import { four } from './main';\nexport const eight = four * 2;\n",
      'src/globals.ts': "import { double } from './lib';\ndeclare global {\n  var doubled: typeof double;\n}\n",
    });
    const all = ['src/app.ts', 'src/globals.ts', 'src/lib.ts', 'src/main.ts'];
    let state = build(dir, undefined);
    assert.deepEqual(state.checked, all);
    const edit = (files) => {
      writeFiles(dir, files);
      state = build(dir, state.snapshot, state.last, Object.keys(files));
    };
    edit({ 'src/lib.ts': lib('x + x') });
    assert.deepEqual(state.checked, ['src/lib.ts']);
    edit({ 'src/main.ts': main(1) });
    assert.deepEqual(state.checked, ['src/main.ts']);
    // A changed declaration file of a file that nothing imports rechecks only that file.
    edit({ 'src/app.ts': "import { four } from './main';\nexport const eight = four * 2;\nexport const nine = 9;\n" });
    assert.deepEqual(state.checked, ['src/app.ts']);
    // A changed declaration file of `lib.ts` rechecks its importers: every file, through `globals.ts`.
    edit({ 'src/lib.ts': lib('x * 2') + 'export const extra = 1;\n' });
    assert.deepEqual(state.checked, all);
    edit({ 'src/lib.ts': lib('2 * x') + 'export const extra = 1;\n' });
    assert.deepEqual(state.checked, ['src/lib.ts']);
  });
}

// Declaration emit that computes signatures while checking is timed apart from checking, and reported as emit time
// (TypeScript 7.1); a nested emit adds its time once, when the outermost one ends.
test('declaration emit for signatures while checking counts as emit time', () => {
  const dir = tempDir('tsc-ts-incremental-signatures-project-');
  const lib = (type) => `export function value(): ${type} {\n  return 1;\n}\n`;
  writeFiles(dir, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, types: [], noEmit: true }, include: ['src'] }),
    'src/lib.ts': lib('number'),
    'src/main.ts': "import { value } from './lib';\nexport const v = value();\n",
  });
  let state = build(dir, undefined);
  state.program.takeNestedEmitTime();
  writeFiles(dir, { 'src/lib.ts': lib('1') });
  state = build(dir, state.snapshot);
  assert.ok(state.program.takeNestedEmitTime() > 0);
  assert.equal(state.program.takeNestedEmitTime(), 0);

  const spin = (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  };
  const outer = state.program.beginNestedEmit();
  const inner = state.program.beginNestedEmit();
  spin(2);
  inner();
  assert.equal(state.program.takeNestedEmitTime(), 0);
  spin(2);
  outer();
  assert.ok(state.program.takeNestedEmitTime() >= 4);
});
