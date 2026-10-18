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
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compileSources('tsc-ts-incremental-signatures-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { bindProgram, CheckedProgram } = await load('compiler/program-checker.js');
const { CompileTimes } = await load('compiler/compile-program.js');
const { IncrementalProgram } = await load('compiler/incremental.js');
const { SystemTimeStamps } = await load('compiler/tsc-compile.js');

function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

/** Builds `dir` on the snapshot of the last build; returns the new snapshot and the project files it checks. */
function build(dir, snapshot) {
  const sys = createNodeSystem(bundledLibs, '');
  const work = executeCommandLine(sys, ['-p', dir]);
  assert.equal(work.kind, 'compile');
  bindProgram(work.program);
  const program = new IncrementalProgram(
    new CheckedProgram(work.program),
    new CompileTimes(),
    snapshot,
    new SystemTimeStamps(sys),
  );
  const checked = program
    .filesToCheck()
    .map((file) => relative(dir, file.fileName))
    .filter((name) => !name.startsWith('..'))
    .sort();
  program.getSemanticDiagnostics();
  return { snapshot: program.snapshot, checked };
}

for (const options of [{ noEmit: true }, { outDir: 'out' }]) {
  test(`body edits recheck only the edited file without build info (${JSON.stringify(options)})`, () => {
    const dir = tempDir('tsc-ts-incremental-signatures-project-');
    const lib = (body) => `export function double(x: number): number {\n  return ${body};\n}\n`;
    writeFiles(dir, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, types: [], ...options }, include: ['src'] }),
      'src/lib.ts': lib('x * 2'),
      'src/main.ts': "import { double } from './lib';\nexport const four = double(2);\n",
      // A file that affects the global scope: a changed signature of a file it imports rechecks every file.
      'src/globals.ts': "import { double } from './lib';\ndeclare global {\n  var doubled: typeof double;\n}\n",
    });
    let state = build(dir, undefined);
    assert.deepEqual(state.checked, ['src/globals.ts', 'src/lib.ts', 'src/main.ts']);
    // The first build takes each file's version as its signature, so the first edit compares a declaration
    // file with a version and rechecks the importers.
    writeFiles(dir, { 'src/lib.ts': lib('x + x') });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/globals.ts', 'src/lib.ts', 'src/main.ts']);
    writeFiles(dir, { 'src/lib.ts': lib('2 * x') });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/lib.ts']);
    // A changed declaration file rechecks every file, through the file that affects the global scope.
    writeFiles(dir, { 'src/lib.ts': lib('x * 2') + 'export const extra = 1;\n' });
    state = build(dir, state.snapshot);
    assert.deepEqual(state.checked, ['src/globals.ts', 'src/lib.ts', 'src/main.ts']);
  });
}
