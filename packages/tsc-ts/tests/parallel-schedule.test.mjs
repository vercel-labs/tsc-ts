// How --checkers spreads work: the order parse threads load files in (libraries first, so a large
// one such as lib.dom.d.ts does not finish last), the files each checker checks (tsgo's assignment),
// and the number of checkers the default starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compileSources('tsc-ts-parallel-schedule-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');
const { CompileTimes, PlainProgram, getDiagnosticsOfProgram } = await load('compiler/compile-program.js');
const { ParseQueue } = await load('compiler/parallel-parse.js');
const {
  autoCheckers,
  checkFromQueue,
  checkersFittingMemory,
  packResult,
  planChecks,
  scheduleOf,
  takePosition,
  textLengths,
  unpackResult,
} = await load('compiler/parallel-check.js');

const Root = 0;
const File = 1;
const Library = 2;
const LibraryHash = 4;

test('parse threads get library files first, one per chunk, also libraries queued later', () => {
  const queue = new ParseQueue();
  queue.push(Root, '/p/a.ts', 0);
  queue.push(Root, '/p/b.ts', 0);
  queue.push(Library, 'lib.es5.d.ts', 0);
  queue.push(Library, 'lib.es5.d.ts', 0);
  assert.deepEqual(queue.next(2).names, ['lib.es5.d.ts']);
  queue.push(File, '/p/c.ts', 0);
  queue.push(Library, 'lib.dom.d.ts', 0);
  assert.deepEqual(queue.next(2).names, ['lib.dom.d.ts']);
  assert.equal(queue.queued(), 5);
  assert.equal(queue.left(), 4);
  // Another thread hashes a large library while one parses it.
  const hash = queue.next(2);
  assert.deepEqual(hash.names, ['lib.dom.d.ts']);
  assert.deepEqual(hash.kinds, [LibraryHash]);
  assert.deepEqual(queue.next(2).names, ['/p/a.ts']);
  assert.deepEqual(queue.next(1).names, ['/p/b.ts', '/p/c.ts']);
  assert.equal(queue.next(1), undefined);
});

test('parse threads get large files right after libraries, one per chunk, ahead of files queued earlier', () => {
  const dir = tempDir('tsc-ts-parallel-schedule-large-');
  // 300 KB, a large root file such as TypeScript's checker.ts.
  writeFileSync(join(dir, 'checker.ts'), 'export const a = 1;\n'.repeat(15_000));
  const queue = new ParseQueue();
  queue.push(Root, '/p/a.ts', 0);
  queue.push(File, '/p/small.d.ts', 0, 1000);
  queue.push(File, '/p/csstype.d.ts', 0, 900_000);
  queue.push(Library, 'lib.dom.d.ts', 0);
  // The queue reads the size of a root file: one it can't read stays in program order.
  queue.push(Root, '/p/root-of-unknown-size.ts', 0);
  queue.push(Root, join(dir, 'checker.ts'), 0);
  queue.push(File, '/p/electron.d.ts', 0, 1_100_000);
  assert.equal(queue.left(), 8);
  assert.deepEqual(queue.next(1).names, ['lib.dom.d.ts']);
  assert.deepEqual(queue.next(1).kinds, [LibraryHash]);
  assert.deepEqual(queue.next(1).names, ['/p/csstype.d.ts']);
  assert.deepEqual(queue.next(1).names, [join(dir, 'checker.ts')]);
  assert.deepEqual(queue.next(1).names, ['/p/electron.d.ts']);
  assert.deepEqual(queue.next(1).names, ['/p/a.ts', '/p/small.d.ts', '/p/root-of-unknown-size.ts']);
  assert.equal(queue.next(1), undefined);
});

test('while root files are matched, other files go out to parse threads in full chunks only', () => {
  const queue = new ParseQueue();
  queue.push(Library, 'lib.es5.d.ts', 0);
  for (let i = 0; i < 20; i++) queue.push(Root, `/p/${i}.ts`, 0);
  assert.deepEqual(queue.next(8, true).names, ['lib.es5.d.ts']);
  assert.equal(queue.next(8, true).names.length, 16);
  assert.equal(queue.next(8, true), undefined);
  assert.deepEqual(queue.next(8).names, ['/p/16.ts']);
  assert.equal(queue.left(), 3);
});

function project() {
  const dir = tempDir('tsc-ts-parallel-schedule-project-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true, module: 'nodenext' },
      include: ['src'],
    }),
    'node_modules/heavy/package.json': JSON.stringify({ name: 'heavy', types: 'index.d.ts' }),
    'node_modules/heavy/index.d.ts': "export * from './more';\n" + 'export declare const a0: number;\n'.repeat(500),
    'node_modules/heavy/more.d.ts': 'export declare const b0: string;\n'.repeat(500),
    'src/adapter.ts': "import { a0 } from 'heavy';\nexport const x = a0;\n",
    'src/big.ts': 'export const big = 1;\n'.repeat(200),
    'src/small.ts': 'export const small = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function checked() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', project()]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

test('planning reads the text length of each file once per program', () => {
  const program = checked().program;
  const lengths = textLengths(program);
  assert.equal(textLengths(program), lengths);
  assert.deepEqual(
    lengths,
    program.getSourceFiles().map((file) => file.text.length),
  );
});

test('file i of the program goes to checker i % count, and each checker checks its files in program order', () => {
  const c = checked();
  const files = c.program.getSourceFiles();
  const checkedFiles = [];
  for (let i = 0; i < files.length; i++) if (!c.skipTypeChecking(files[i])) checkedFiles.push(i);
  assert.ok(checkedFiles.length >= 3);
  for (const count of [1, 2, 3, 4]) {
    const plan = planChecks(c, count);
    for (let k = 0; k < count; k++)
      assert.deepEqual(
        plan.order.slice(plan.ranges[2 * k], plan.ranges[2 * k + 1]),
        checkedFiles.filter((i) => i % count === k),
      );
    assert.equal(plan.order.length, checkedFiles.length);
  }
  // In a rebuild, only the files to check again, on the checkers of their indices.
  const small = files.findIndex((file) => file.fileName.endsWith('small.ts'));
  c.checkOnly = new Set([files[small]]);
  const plan = planChecks(c, 4);
  assert.deepEqual(plan.order, [small]);
  assert.equal(plan.filesOf(small % 4), 1);
});

test('a checker takes only its own files, in order, until none are left', () => {
  const c = checked();
  const plan = planChecks(c, 2);
  const schedule = new Int32Array(scheduleOf(plan));
  for (const k of [1, 0]) {
    const taken = [];
    for (let p; (p = takePosition(schedule, k)) >= 0;) taken.push(plan.order[p]);
    assert.deepEqual(taken, plan.order.slice(plan.ranges[2 * k], plan.ranges[2 * k + 1]));
    assert.equal(takePosition(schedule, k), -1);
  }
});

test('auto starts a checker per CPU, at least four, fewer only when memory does not fit', () => {
  assert.equal(autoCheckers(8, 100), 8);
  assert.equal(autoCheckers(2, 100), 4);
  assert.equal(autoCheckers(16, 10), 10);
  assert.equal(autoCheckers(8, 1), 4);
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  // VS Code (4209 MiB when checking starts, 16.8M characters in declaration files; 9.1 GB at 8
  // checkers, 8.6 GB at 4) gets one checker per CPU on 16 GiB and 32 GiB, and six on 12 GiB.
  assert.equal(autoCheckers(8, checkersFittingMemory(4209 * MiB, 16769893, 16 * GiB)), 8);
  assert.equal(autoCheckers(16, checkersFittingMemory(4209 * MiB, 16769893, 32 * GiB)), 16);
  assert.equal(autoCheckers(8, checkersFittingMemory(4209 * MiB, 16769893, 12 * GiB)), 6);
  // Sentry (2003 MiB, 22.1M; 7.2 GB at 8, 6.2 GB at 4) gets 8 on 16 GiB, 6 on 8 GiB and tsgo's four
  // on 6 GiB. T3 Code's apps/server (about 1.6 GB, 30.4M; 9.2 GiB at 8, 11.8 GiB at 16) gets 16 on
  // 16 GiB.
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 16 * GiB)), 8);
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 8 * GiB)), 6);
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 6 * GiB)), 4);
  assert.equal(autoCheckers(16, checkersFittingMemory(1600 * MiB, 30414210, 16 * GiB)), 16);
});

function erroneous() {
  const dir = tempDir('tsc-ts-parallel-schedule-errors-');
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['src'] }),
    // A message chain (elaboration), related information (redeclaration) and an argument-free error.
    'src/a.ts': 'interface P { x: { y: number } }\nconst p: P = { x: { y: "no" } };\nlet d = 1;\nlet d = 2;\n',
    'src/b.ts': 'export const n: number = "s";\ndeclare const q: { x: string };\nexport const r: { x: number } = q;\n',
    'src/c.ts': 'export const fine = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

const described = (d) => ({
  file: d.file?.fileName,
  pos: d.pos,
  end: d.end,
  code: d.code,
  category: d.category,
  message: d.message,
  args: [...d.args],
  skipped: d.skippedOnNoEmit,
  chain: d.messageChain.map(described),
  related: d.relatedInformation.map(described),
});

test('a checker result packed as plain data comes back with the same diagnostics on the same files', () => {
  const c = erroneous();
  const plan = planChecks(c, 1);
  const result = checkFromQueue(c, 0, new Int32Array(scheduleOf(plan)), plan.order, 0);
  const all = result.diagnostics.flat();
  assert.ok(all.length >= 3);
  assert.ok(all.some((d) => d.messageChain.length > 0));
  assert.ok(all.some((d) => d.relatedInformation.length > 0));
  // Through a structured clone, as postMessage copies it.
  const packed = structuredClone(packResult(result, c.program));
  // Typed arrays, which the message copies as one block each.
  assert.ok(packed.files instanceof Int32Array && packed.nums instanceof Int32Array);
  assert.ok(
    packed.strs.every((s) => !s.includes('interface P')),
    'file texts the program has stay behind',
  );
  const files = new Map();
  const back = unpackResult(packed, c.program, files);
  assert.deepEqual(back.files, result.files);
  assert.deepEqual(
    back.diagnostics.map((list) => list.map(described)),
    result.diagnostics.map((list) => list.map(described)),
  );
  assert.deepEqual(back.globals.map(described), result.globals.map(described));
  assert.equal(back.more, false);
  // Diagnostics refer to the program's own files.
  const a = back.diagnostics.flat().find((d) => d.file?.fileName.endsWith('a.ts'));
  assert.equal(
    a.file,
    c.program
      .getSourceFiles()
      .find((f) => f.fileName.endsWith('a.ts'))
      .diagnosticFile(),
  );
});

test('a checker at its file limit stops, and a new one on its schedule index checks the rest once, in order', () => {
  const c = erroneous();
  const plan = planChecks(c, 1);
  const schedule = new Int32Array(scheduleOf(plan));
  const first = checkFromQueue(c, 0, schedule, plan.order, 0, true, 1);
  assert.deepEqual([first.files.length, first.more], [1, true]);
  const rest = checkFromQueue(new CheckedProgram(c.program), 0, schedule, plan.order, 0, true, 100000);
  assert.equal(rest.more, false);
  assert.deepEqual([...first.files, ...rest.files], plan.order);
});

test('global errors a checker thread found are reported after the semantic diagnostics, which they do not hide', () => {
  const dir = tempDir('tsc-ts-parallel-schedule-globals-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'es2015', lib: ['es5'], strict: true, noEmit: true, types: [] },
      include: ['src'],
    }),
    // Checking the generator needs a global type the library lacks.
    'src/a.ts': 'export function* g() { yield 1; }\n',
    'src/b.ts': 'export const n: number = "s";\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const c = new CheckedProgram(work.program);
  const plan = planChecks(c, 1);
  const thread = checkFromQueue(
    new CheckedProgram(work.program),
    0,
    new Int32Array(scheduleOf(plan)),
    plan.order,
    0,
    false,
  );
  assert.deepEqual(
    thread.globals.map((d) => d.code),
    [2318],
  );
  // What the main thread records of the thread's result.
  const perFile = c.program.getSourceFiles().map(() => undefined);
  for (let k = 0; k < thread.files.length; k++) perFile[thread.files[k]] = thread.diagnostics[k];
  c.checkedInParallel = perFile;
  for (const d of thread.globals) c.parallelGlobalDiagnostics.push(d);
  const reported = getDiagnosticsOfProgram(new PlainProgram(c, new CompileTimes()), false);
  assert.deepEqual(
    reported.map((d) => d.code),
    [2322, 2318],
  );
});
