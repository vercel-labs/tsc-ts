// The properties of instantiations of a class, interface or object type are built from an order cached
// for their source (`NamedMemberOrder`). They must be the properties `getNamedMembers` picks from the
// instantiation's members table, in the same order, whether the source's members are all properties,
// include signatures or are merged from several declarations, and for every instantiation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

const out = compileSources('tsc-ts-member-order-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');
const { getPropertiesOfType, resolveStructuredTypeMembers } = await load('compiler/checker-members.js');
const { getNamedMembers } = await load('compiler/checker-symbols.js');
const { getTypeOfSymbol } = await load('compiler/checker-symbol-types.js');
const { typeToString } = await load('compiler/type-printer.js');

const dir = tempDir('tsc-ts-member-order-project-');
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ['a.ts'] }),
);
writeFileSync(
  join(dir, 'a.ts'),
  [
    'export interface Pair<T> { second: T; first: T; method(): T; opt?: T; }',
    'export interface Callable<T> { (x: T): T; new (x: T): Callable<T>; z: T; [key: number]: T; y?: T; }',
    'export interface Merged<T> { z: T; }',
    'export interface Merged<T> { y: T; x(): T; }',
    'export class K<T> { q!: T; static s = 1; constructor(public p: T) {} m(): T { return this.q; } }',
    'export class D<T> extends K<T> { w!: T; }',
    'export type Anon<T> = { r: T; s: (t: T) => void; "quoted key": T; 1: T };',
    'export declare const pairs: [Pair<string>, Pair<number>, Pair<Pair<boolean>>];',
    'export declare const pair: Pair<string>;',
    'export declare const callable: Callable<string>;',
    'export declare const merged: Merged<number>;',
    'export declare const k: K<string>;',
    'export declare const d: D<number>;',
    'export declare const anon: Anon<string>;',
    'export declare const anon2: Anon<number>;',
    '',
  ].join('\n'),
);

function setup() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const checker = new CheckedProgram(work.program).createChecker();
  const file = work.program.getSourceFiles().find((f) => f.fileName.endsWith('/a.ts'));
  assert.deepEqual(checker.getDiagnostics(file), []);
  return { checker, exports: file.symbol.exports };
}

/** The property names of `t`, then the names `getNamedMembers` picks from its members table, built after them. */
function propertiesAndTable(c, t) {
  const properties = getPropertiesOfType(c, t).map((p) => p.name);
  const resolved = resolveStructuredTypeMembers(c, t);
  const named = getNamedMembers(c, resolved.members, t.symbol).map((p) => p.name);
  return { properties, named };
}

const expected = {
  pair: ['second', 'first', 'method', 'opt'],
  callable: ['z', 'y'],
  merged: ['z', 'y', 'x'],
  k: ['q', 'p', 'm'],
  d: ['w', 'q', 'p', 'm'],
  anon: ['r', 's', 'quoted key', '1'],
  anon2: ['r', 's', 'quoted key', '1'],
};

test('properties of instantiations are the named members of their tables, in order', () => {
  const { checker, exports } = setup();
  for (const [name, names] of Object.entries(expected)) {
    const t = getTypeOfSymbol(checker, exports.get(name));
    const { properties, named } = propertiesAndTable(checker, t);
    assert.deepEqual(properties, names, `${name}: ${typeToString(checker, t)}`);
    assert.deepEqual(named, names, `${name} table`);
  }
});

test('every instantiation of a source gets its properties in the same order', () => {
  const { checker, exports } = setup();
  const tuple = getTypeOfSymbol(checker, exports.get('pairs'));
  for (const element of getPropertiesOfType(checker, tuple).filter((p) => /^\d$/.test(p.name))) {
    const t = getTypeOfSymbol(checker, element);
    assert.deepEqual(propertiesAndTable(checker, t).properties, expected.pair, typeToString(checker, t));
  }
});
