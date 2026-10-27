// `typeToString` and `symbolToString` keep the text of prints that created no types (Checker.typeStrings and
// symbolStrings), and print again where a print created types, as tsgo does each time: skipping such a print would
// change the ids, and so the order, of the types created after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

const out = compileSources('tsc-ts-type-strings-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');
const { symbolToString, typeToString } = await load('compiler/type-printer.js');
const { getTypeOfSymbol } = await load('compiler/checker-symbol-types.js');

// The type of `r` is an instantiation of an anonymous type whose members are resolved when it is first printed,
// which creates `Box<number>` and `Box<number[]>`.
const dir = tempDir('tsc-ts-type-strings-project-');
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ['a.ts'] }),
);
writeFileSync(
  join(dir, 'a.ts'),
  [
    'interface Box<U> { v: U }',
    'declare function f<T>(x: T): { a: Box<T>; b: Box<T[]> };',
    'const r = f(1);',
    'const s = r;',
    '',
  ].join('\n'),
);

function setup() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const file = work.program.getSourceFiles().find((f) => f.fileName.endsWith('/a.ts'));
  const checker = new CheckedProgram(work.program).createChecker();
  return { checker, type: getTypeOfSymbol(checker, file.locals.get('r')) };
}

function setupSymbol() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const file = work.program.getSourceFiles().find((f) => f.fileName.endsWith('/a.ts'));
  return { checker: new CheckedProgram(work.program).createChecker(), symbol: file.locals.get('r') };
}

const text = '{ a: Box<number>; b: Box<number[]>; }';

test('a print that creates types is not kept, and the next print that creates none is', () => {
  const { checker, type } = setup();
  const kept = checker.typeStrings.size;
  let types = checker.typeCount;
  assert.equal(typeToString(checker, type), text);
  assert.ok(checker.typeCount > types, 'the first print creates the member types');
  assert.equal(checker.typeStrings.size, kept, 'a print that created types is not kept');
  types = checker.typeCount;
  assert.equal(typeToString(checker, type), text);
  assert.equal(checker.typeCount, types, 'the second print creates no types');
  assert.equal(checker.typeStrings.size, kept + 1, 'a print that created no types is kept');
  assert.equal(typeToString(checker, type), text);
  assert.equal(checker.typeCount, types);
  assert.equal(checker.typeStrings.size, kept + 1);
});

test('prints with other flags or declarations are kept apart', () => {
  const { checker, type } = setup();
  typeToString(checker, type);
  const kept = checker.typeStrings.size;
  assert.equal(typeToString(checker, type), text);
  assert.equal(typeToString(checker, type, undefined, 1 << 6), text);
  assert.equal(checker.typeStrings.size, kept + 2);
});

test('prints nested in a serialization are not kept', () => {
  const { checker, type } = setup();
  typeToString(checker, type);
  const kept = checker.typeStrings.size;
  checker.serializationLevel++;
  try {
    assert.equal(typeToString(checker, type), text);
  } finally {
    checker.serializationLevel--;
  }
  assert.equal(checker.typeStrings.size, kept);
});

test('symbol prints are kept by symbol, declaration and flags', () => {
  const { checker, symbol } = setupSymbol();
  const kept = checker.symbolStrings.size;
  assert.equal(symbolToString(checker, symbol), 'r');
  assert.equal(checker.symbolStrings.size, kept + 1);
  assert.equal(symbolToString(checker, symbol), 'r');
  assert.equal(checker.symbolStrings.get(symbol).size, 1);
  checker.serializationLevel++;
  try {
    assert.equal(symbolToString(checker, symbol, symbol.declaration), 'r');
  } finally {
    checker.serializationLevel--;
  }
  assert.equal(checker.symbolStrings.get(symbol).size, 1, 'prints nested in a serialization are not kept');
});
