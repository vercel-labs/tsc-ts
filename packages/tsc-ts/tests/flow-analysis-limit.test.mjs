// A body too large for control flow analysis (TS2563) stops narrowing in that body only. A checker
// checks many files with --checkers (parallel-check.ts), so a file's diagnostics must not depend on
// the files the checker checked before it: which file a checker takes next is not decided in advance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

const out = compileSources('tsc-ts-flow-limit-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');

// The walk of `x`'s flow passes 1200 branch conditions, past the depth at which flow analysis stops.
const big = [
  'export function big(a: boolean): number {',
  '  let x: number;',
  ...Array.from({ length: 1200 }, (_, i) => `  if (a) { x = ${i}; }`),
  '  return x;',
  '}',
  '',
];
// Flow analysis finds `value` used before being assigned, after only a few steps.
const later = ['let value: number;', 'console.log(value);', ''];

const dir = tempDir('tsc-ts-flow-limit-project-');
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ['big.ts', 'later.ts'] }),
);
writeFileSync(join(dir, 'big.ts'), big.join('\n'));
writeFileSync(join(dir, 'later.ts'), later.join('\n'));

/** One checker over the project, as a checker thread checks the files it takes (parallel-check.ts). */
function setup() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const checked = new CheckedProgram(work.program);
  const file = (name) => work.program.getSourceFiles().find((f) => f.fileName.endsWith('/' + name));
  return { checker: checked.createChecker(), big: file('big.ts'), later: file('later.ts') };
}

const codes = (diagnostics) => diagnostics.map((d) => d.code);

test('a body too large for flow analysis does not stop narrowing in the next file a checker checks', () => {
  const { checker, big, later } = setup();
  // The body's flow walk stops at its limit and reports it there.
  assert.deepEqual(codes(checker.getDiagnostics(big)), [2563]);
  // The next file is checked with flow analysis again: `value` is used before being assigned.
  assert.deepEqual(codes(checker.getDiagnostics(later)), [2454]);
});

test('a file keeps its flow diagnostics when it is checked before the large body', () => {
  const { checker, big, later } = setup();
  assert.deepEqual(codes(checker.getDiagnostics(later)), [2454]);
  assert.deepEqual(codes(checker.getDiagnostics(big)), [2563]);
});

// 19 files with one unused local each, plus a file that uses a variable before assigning it.
const smalls = Array.from({ length: 19 }, (_, i) => `export {};\nconst unused${i} = ${i};\n`);
const manyDir = tempDir('tsc-ts-flow-limit-many-');
writeFileSync(
  join(manyDir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, noUnusedLocals: true, types: [] },
    files: ['big.ts', ...smalls.map((_, i) => `small${i}.ts`), 'later.ts'],
  }),
);
writeFileSync(join(manyDir, 'big.ts'), big.join('\n'));
smalls.forEach((text, i) => writeFileSync(join(manyDir, `small${i}.ts`), text));
writeFileSync(join(manyDir, 'later.ts'), later.join('\n'));

test('19 files after a large body keep their diagnostics: 21 in total, with TS2454 in the next file', () => {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', manyDir]);
  assert.equal(work.kind, 'compile');
  const checked = new CheckedProgram(work.program);
  const checker = checked.createChecker();
  const file = (name) => work.program.getSourceFiles().find((f) => f.fileName.endsWith('/' + name));
  // The large body is checked first; it reports TS2563 there.
  const found = [checker.getDiagnostics(file('big.ts'))];
  for (let i = 0; i < smalls.length; i++) found.push(checker.getDiagnostics(file(`small${i}.ts`)));
  // The file checked last keeps the narrowing diagnostic that the large body's flag used to suppress.
  found.push(checker.getDiagnostics(file('later.ts')));
  assert.deepEqual(found.map((diagnostics) => diagnostics.length), [1, ...smalls.map(() => 1), 1]);
  assert.equal(found.flat().length, 21);
  assert.deepEqual(codes(found.at(-1)), [2454]);
});
