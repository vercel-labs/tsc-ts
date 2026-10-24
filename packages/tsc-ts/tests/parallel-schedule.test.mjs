// How --checkers spreads work: the order parse threads load files in (libraries first, so a large
// one such as lib.dom.d.ts does not finish last), the estimated cost of checking a file (a small file
// that alone imports a large library is expensive), the ranges of files checkers take, with
// idle checkers taking the cheap end of another's range, and the statement ranges of a large
// declaration file that several checkers check.
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
  checkGroups,
  checkOrder,
  checkersFittingMemory,
  fillScheduleCosts,
  libraryBoundCount,
  newSchedule,
  packResult,
  planSchedule,
  rangeUnits,
  retirementMemory,
  retires,
  scheduleOf,
  takePosition,
  textLengths,
  unpackResult,
} = await load('compiler/parallel-check.js');
const {
  compareDiagnostics,
  createDiagnostic,
  DiagnosticFile,
  formatDiagnostic,
  formatDiagnostics,
  formattedReports,
  sortDiagnostics,
} = await load('compiler/diagnostics.js');

const Root = 0;
const File = 1;
const Library = 2;

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
  assert.equal(queue.left(), 3);
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
  assert.equal(queue.left(), 7);
  assert.deepEqual(queue.next(1).names, ['lib.dom.d.ts']);
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

const baseName = (program, i) => program.getSourceFiles()[i].fileName.split('/').pop();

test('planning reads the text length of each file once per program', () => {
  const program = checked().program;
  const lengths = textLengths(program);
  assert.equal(textLengths(program), lengths);
  assert.deepEqual(
    lengths,
    program.getSourceFiles().map((file) => file.text.length),
  );
});

test('a small file that alone imports a large library is checked before larger files', () => {
  const c = checked();
  assert.deepEqual(
    checkOrder(c).map((i) => baseName(c.program, i)),
    ['adapter.ts', 'big.ts', 'small.ts'],
  );
});

test('a checker resolving a library for the first time pays for all the text the library reaches', () => {
  const c = checked();
  const plan = planSchedule(c, 2);
  // The only library is heavy/index.d.ts, which reaches more.d.ts: both texts in full.
  const reach =
    "export * from './more';\n".length +
    'export declare const a0: number;\n'.length * 500 +
    'export declare const b0: string;\n'.length * 500;
  assert.deepEqual(plan.libraryCosts, [reach]);
});

test('checkers take every file once: the costliest first, then their ranges, then the end of others', () => {
  const c = checked();
  const plan = planSchedule(c, 2);
  const schedule = new Int32Array(scheduleOf(plan, 2));
  const order = plan.order;
  assert.equal(order.length, 3);
  // Checker 1 takes the two costliest files from the shared queue, then the whole range of checker 0.
  const taken = [];
  for (let k; (k = takePosition(schedule, order.length, 1)) >= 0;) taken.push(baseName(c.program, order[k]));
  assert.deepEqual(taken.slice(0, 2), ['adapter.ts', 'big.ts']);
  assert.deepEqual(taken.sort(), ['adapter.ts', 'big.ts', 'small.ts']);
  assert.equal(takePosition(schedule, order.length, 0), -1);
});

// The ranges start after the 8 header entries of the schedule.
const ranges = 8;

function ownRanges(schedule, ...bounds) {
  schedule[2] = 0; // no shared prefix
  for (let k = 0; k < bounds.length; k++) schedule[ranges + k] = bounds[k];
}

test('without costs, an idle checker takes the back half of the largest remaining range', () => {
  const schedule = new Int32Array(newSchedule(2));
  // Checker 0 owns positions 0..9, checker 1 none.
  ownRanges(schedule, 0, 10, 10, 10);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.equal(takePosition(schedule, 10, 1), 5);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 5, 6, 10]);
});

test('an idle checker takes the end of a range that makes both finish earliest', () => {
  // Ten files of cost 10 without libraries: checker 1 takes the last four of the nine checker 0 has
  // left (the first larger end that does not make it finish later).
  const schedule = new Int32Array(newSchedule(2, 10, 0, 0));
  fillScheduleCosts(schedule, Array(10).fill(10), Array(10).fill([]), []);
  ownRanges(schedule, 0, 10, 10, 10);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.equal(takePosition(schedule, 10, 1), 6);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 6, 7, 10]);
  // Uneven costs: the end that balances the estimated work, not half of the files.
  const uneven = new Int32Array(newSchedule(2, 4, 0, 0));
  fillScheduleCosts(uneven, [100, 10, 10, 10], Array(4).fill([]), []);
  ownRanges(uneven, 0, 4, 4, 4);
  assert.equal(takePosition(uneven, 4, 1), 1);
  assert.deepEqual(Array.from(uneven.slice(ranges, ranges + 4)), [0, 1, 2, 4]);
});

test('an idle checker leaves files whose library only the owner has resolved', () => {
  // Four small files importing one library that costs 1000 to resolve; checker 0 has taken the first.
  const schedule = new Int32Array(newSchedule(2, 4, 1, 4));
  fillScheduleCosts(schedule, Array(4).fill(10), Array(4).fill([0]), [1000]);
  ownRanges(schedule, 0, 4, 4, 4);
  assert.equal(takePosition(schedule, 4, 0), 0);
  // Taking any of the other three would make checker 1 resolve the library: it is done instead.
  assert.equal(takePosition(schedule, 4, 1), -1);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 4, 4, 4]);
  // Once checker 1 has resolved the library too, it takes the last file.
  const both = new Int32Array(newSchedule(2, 6, 1, 6));
  fillScheduleCosts(both, Array(6).fill(10), Array(6).fill([0]), [1000]);
  ownRanges(both, 0, 2, 2, 6);
  assert.equal(takePosition(both, 6, 0), 0);
  assert.equal(takePosition(both, 6, 1), 2);
  assert.equal(takePosition(both, 6, 0), 1);
  assert.deepEqual(Array.from(both.slice(ranges, ranges + 4)), [2, 2, 3, 6]);
  assert.equal(takePosition(both, 6, 0), 5);
  assert.deepEqual(Array.from(both.slice(ranges, ranges + 4)), [6, 6, 3, 5]);
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
  // 16 GiB. Programs above the estimate retire checkers instead.
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 16 * GiB)), 8);
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 8 * GiB)), 6);
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 6 * GiB)), 4);
  assert.equal(autoCheckers(16, checkersFittingMemory(1600 * MiB, 30414210, 16 * GiB)), 16);
});

function groupProject() {
  const dir = tempDir('tsc-ts-parallel-schedule-groups-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true, module: 'nodenext' },
      include: ['src'],
    }),
    // A large generated module that few files import, the files importing it, and their importer.
    'src/schema.gen.ts': 'export declare const s0: { a: number; b: string };\n'.repeat(200),
    'src/meta.gen.ts': "import { s0 } from './schema.gen.js';\nexport const meta = s0;\n",
    'src/client.ts':
      "import { s0 } from './schema.gen.js';\nimport { meta } from './meta.gen.js';\nexport const client = [s0, meta];\n",
    'src/app.ts': "import { client } from './client.js';\nexport const app = client;\n",
    'src/other.ts': 'export const other = 1;\n'.repeat(20),
    'src/more.ts': 'export const more = 1;\n'.repeat(20),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

test('auto starts fewer checkers where each would mostly resolve the same large libraries', () => {
  // Library and own characters per range of the benchmark programs at 16 checkers.
  assert.equal(libraryBoundCount(16, 12_145_000, 889_000), 12); // T3 Code web
  assert.equal(libraryBoundCount(16, 8_727_000, 1_134_000), 12); // T3 Code server
  assert.equal(libraryBoundCount(16, 5_704_000, 3_037_000), 16); // Sentry
  assert.equal(libraryBoundCount(16, 2_403_000, 232_000), 16); // Playwright
  assert.equal(libraryBoundCount(16, 1_354_000, 151_000), 16); // Excalidraw
  assert.equal(libraryBoundCount(8, 12_145_000, 889_000), 6);
  assert.equal(libraryBoundCount(4, 12_145_000, 889_000), 4);
  assert.equal(libraryBoundCount(5, 12_145_000, 889_000), 4);
});

test('a large module that few files import groups with the files importing it, costliest first', () => {
  const c = groupProject();
  // The default least load is a million characters: this project has no groups.
  assert.deepEqual(checkGroups(c, 2), []);
  const groups = checkGroups(c, 2, 1000);
  assert.equal(groups.length, 1);
  const names = groups[0].map((i) => baseName(c.program, i));
  assert.equal(names[0], 'schema.gen.ts');
  assert.deepEqual(names.slice().sort(), ['app.ts', 'client.ts', 'meta.gen.ts', 'schema.gen.ts']);
  // With many checkers, the files around the schema would be too much for one checker.
  assert.deepEqual(checkGroups(c, 64, 1000), []);
});

test('a checker takes a group from the shared queue as a whole, and nobody takes it from that checker', () => {
  // Positions 0-2 are a group, 3 a file of its own, then the ranges 4-5 and 6-7.
  const schedule = new Int32Array(newSchedule(2, 8, 0, 0));
  fillScheduleCosts(schedule, Array(8).fill(10), Array(8).fill([]), [], [3, 0, 0, 1]);
  ownRanges(schedule, 4, 6, 6, 8);
  schedule[2] = 4;
  assert.equal(takePosition(schedule, 8, 1), 0);
  assert.equal(takePosition(schedule, 8, 0), 3);
  assert.equal(takePosition(schedule, 8, 1), 1);
  assert.equal(takePosition(schedule, 8, 0), 4);
  assert.equal(takePosition(schedule, 8, 0), 5);
  // Checker 0 is idle: it takes from checker 1's range, never the rest of its group.
  assert.equal(takePosition(schedule, 8, 0), 7);
  assert.equal(takePosition(schedule, 8, 1), 2);
  assert.equal(takePosition(schedule, 8, 1), 6);
  assert.equal(takePosition(schedule, 8, 0), -1);
  assert.equal(takePosition(schedule, 8, 1), -1);
});

test('one checker thread at a time retires when memory runs short, and an idle checker takes its range', () => {
  const schedule = new Int32Array(newSchedule(6, 10, 0, 0));
  fillScheduleCosts(schedule, Array(10).fill(10), Array(10).fill([]), []);
  ownRanges(schedule, 10, 10, 10, 10, 10, 10, 10, 10, 0, 10, 10, 10);
  assert.equal(retires(schedule, 4, 100, 50), false);
  // The main thread's checker never retires.
  assert.equal(retires(schedule, 0, 100, 200), false);
  assert.equal(retires(schedule, 4, 100, 200), true);
  // The next retirement waits until the first one's memory has come back.
  assert.equal(retires(schedule, 5, 100, 200), false);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 2)), [1, 10]);
  assert.deepEqual(Array.from(schedule.slice(ranges + 8, ranges + 10)), [0, 0]);
  // Beyond tsgo's four at 85% of the memory limit, checkers 1-3 only at 95%.
  assert.equal(retirementMemory(4, 1000), 850);
  assert.equal(retirementMemory(1, 1000), 950);
  assert.equal(retirementMemory(0, 1000), 0);
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
  const plan = planSchedule(c, 1);
  const result = checkFromQueue(c, 0, new Int32Array(scheduleOf(plan, 1)), plan.order, 0);
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

test('a packed checker result carries the reported text of each diagnostic in the report format', () => {
  const c = erroneous();
  const plan = planSchedule(c, 1);
  const result = checkFromQueue(c, 0, new Int32Array(scheduleOf(plan, 1)), plan.order, 0);
  const format = { locale: 0, currentDirectory: '/', useCaseSensitiveFileNames: true, newLine: '\n' };
  // Without a report format, nothing is formatted.
  const plain = unpackResult(structuredClone(packResult(result, c.program)), c.program, new Map());
  assert.ok(plain.diagnostics.flat().every((d) => d.formatted === ''));
  formattedReports.format = format;
  try {
    const back = unpackResult(structuredClone(packResult(result, c.program)), c.program, new Map());
    const all = back.diagnostics.flat();
    const original = result.diagnostics.flat();
    assert.ok(all.length >= 3);
    for (let k = 0; k < all.length; k++) {
      assert.equal(all[k].formatted, formatDiagnostic(original[k], format));
      // Elaborations and related information are part of their diagnostic's text.
      for (const d of [...all[k].messageChain, ...all[k].relatedInformation]) assert.equal(d.formatted, '');
    }
    // The report writes the texts in place of formatting the diagnostics again.
    assert.equal(formatDiagnostics(all, format), formatDiagnostics(original, format));
    for (const d of all) d.formatted = 'x';
    assert.equal(formatDiagnostics(all, format), 'x'.repeat(all.length));
    // In another format, they are formatted.
    assert.equal(formatDiagnostics(all, { ...format }), formatDiagnostics(original, format));
  } finally {
    formattedReports.format = undefined;
  }
});

test('sorted diagnostics are in the order of compareDiagnostics, equal ones as they came', () => {
  const a = new DiagnosticFile('/p/a.ts', 'let a = 1;\nlet b = 2;\n');
  const b = new DiagnosticFile('/p/b.ts', 'let c = 3;\n');
  // Another file object with a's name, as a thread's copy of a file has.
  const otherA = new DiagnosticFile('/p/a.ts', a.text);
  // Diagnostics.Cannot_find_name_0, a const enum member.
  const message = 482;
  const diagnostics = [
    createDiagnostic(b, 4, 5, message, 'c'),
    createDiagnostic(a, 15, 16, message, 'b'),
    createDiagnostic(undefined, -1, -1, message, 'global'),
    createDiagnostic(otherA, 4, 5, message, 'a'),
    createDiagnostic(a, 4, 5, message, 'a'),
    createDiagnostic(b, 0, 3, message, 'let'),
    createDiagnostic(otherA, 15, 16, message, 'b'),
    createDiagnostic(a, 4, 5, message, 'A'),
  ];
  const sorted = sortDiagnostics(diagnostics);
  const expected = [...diagnostics].sort(compareDiagnostics);
  assert.equal(sorted.length, expected.length);
  for (let k = 0; k < sorted.length; k++) assert.equal(sorted[k], expected[k]);
  assert.deepEqual(sortDiagnostics([]), []);
});

test('a checker at its file limit stops, and a new one on its schedule index checks the rest once', () => {
  const c = erroneous();
  const plan = planSchedule(c, 1);
  const schedule = new Int32Array(scheduleOf(plan, 1));
  const first = checkFromQueue(c, 0, schedule, plan.order, 0, true, 1);
  assert.deepEqual([first.files.length, first.more], [1, true]);
  const rest = checkFromQueue(new CheckedProgram(c.program), 0, schedule, plan.order, 0, true, 100000);
  assert.equal(rest.more, false);
  assert.deepEqual([...first.files, ...rest.files].sort(), [...plan.order].sort());
});

test('a checker at its file limit inside a group hands the rest of the group to its successor', () => {
  const c = erroneous();
  const order = planSchedule(c, 1).order;
  assert.ok(order.length >= 4);
  // Positions 0-2 are a group in the shared queue, then checker 0's range.
  const schedule = new Int32Array(newSchedule(1, order.length, 0, 0));
  fillScheduleCosts(schedule, Array(order.length).fill(10), Array(order.length).fill([]), [], [3, 0, 0]);
  ownRanges(schedule, 3, order.length);
  schedule[2] = 3;
  const first = checkFromQueue(c, 0, schedule, order, 0, true, 1);
  assert.deepEqual([first.files, first.more, first.reserved], [[order[0]], true, [1, 2]]);
  const rest = checkFromQueue(new CheckedProgram(c.program), 0, schedule, order, 0, true, 100000, first.reserved);
  assert.equal(rest.more, false);
  assert.deepEqual(rest.files.slice(0, 2), [order[1], order[2]]);
  assert.deepEqual([...first.files, ...rest.files].sort(), [...order].sort());
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
  const plan = planSchedule(c, 1);
  const thread = checkFromQueue(
    new CheckedProgram(work.program),
    0,
    new Int32Array(scheduleOf(plan, 1)),
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

/** A program whose declaration file `types.d.ts` is most of what it checks; `extra` is appended to it. */
function declarationHeavy(extra = '') {
  const dir = tempDir('tsc-ts-parallel-schedule-ranges-');
  let types = 'interface Base { id: number }\n';
  for (let i = 0; i < 400; i++) types += `interface T${i} extends Base { value${i}: number }\n`;
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipDefaultLibCheck: true },
      include: ['src'],
    }),
    'src/types.d.ts': types + extra,
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'src/c.ts': 'export const c = 3;\n',
    'src/d.ts': 'export const d = 4;\n',
    'src/e.ts': 'export const e = 5;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

test("a declaration file costing more than a checker's share is checked in statement ranges", () => {
  const c = declarationHeavy();
  const files = c.program.getSourceFiles();
  const types = files.findIndex((f) => f.fileName.endsWith('types.d.ts'));
  const statements = files[types].statements.nodes.length;
  const plan = planSchedule(c, 4, undefined, true);
  const units = plan.units;
  assert.ok(units.length / 3 >= 2 && units.length / 3 <= 8, `${units.length / 3} ranges`);
  // Consecutive ranges of the whole file, the last one ending it.
  for (let u = 0; u < units.length / 3; u++) {
    assert.equal(units[3 * u], types);
    assert.equal(units[3 * u + 1], u === 0 ? 0 : units[3 * u - 1]);
    assert.ok(units[3 * u + 2] > units[3 * u + 1]);
  }
  assert.equal(units[units.length - 1], statements);
  // The ranges take the place of the file in the order, once each.
  assert.ok(!plan.order.includes(types));
  assert.deepEqual(
    plan.order.filter((k) => k < 0).sort((a, b) => b - a),
    Array.from({ length: units.length / 3 }, (_, u) => -1 - u),
  );
  // Checking whole: with one checker, without ranges, or with TSC_TS_RANGES=0.
  assert.deepEqual(planSchedule(c, 4).units, []);
  assert.deepEqual(planSchedule(c, 1, undefined, true).units, []);
  process.env.TSC_TS_RANGES = '0';
  try {
    assert.deepEqual(rangeUnits(c, 4, { order: checkOrder(c), cost: textLengths(c.program) }), []);
  } finally {
    delete process.env.TSC_TS_RANGES;
  }
});

test('a checker checks the statement ranges it takes, and tells which found diagnostics in their file', () => {
  for (const [extra, reporting] of [
    ['', false],
    ['interface Bad extends Base { id: string }\n', true],
  ]) {
    const c = declarationHeavy(extra);
    const plan = planSchedule(c, 4, undefined, true);
    const result = checkFromQueue(
      c,
      0,
      new Int32Array(scheduleOf(plan, 4)),
      plan.order,
      0,
      true,
      0,
      [],
      true,
      undefined,
      true,
      plan.units,
    );
    assert.deepEqual(
      [...result.units].sort((a, b) => a - b),
      Array.from({ length: plan.units.length / 3 }, (_, u) => u),
    );
    assert.equal(result.files.length, plan.order.length - plan.units.length / 3);
    // The range ending the file has the bad declaration; a range checked after it on the same checker reports too.
    if (reporting) assert.ok(result.reportingUnits.includes(plan.units.length / 3 - 1));
    else assert.deepEqual(result.reportingUnits, []);
    // Packed for postMessage and back.
    const back = unpackResult(structuredClone(packResult(result, c.program)), c.program, new Map());
    assert.deepEqual([back.units, back.reportingUnits], [result.units, result.reportingUnits]);
  }
});
