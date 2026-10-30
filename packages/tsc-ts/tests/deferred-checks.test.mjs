// Deferred checks (function expression and arrow bodies, JSX elements, assertions, …) run with their
// own file, as in tsgo: checking one file resolves types declared in others, which defers their
// function bodies, but those bodies are checked only when their file is. With --checkers, a checker
// that checked them with whatever file it was on would repeat the work of the file's own checker.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

const out = compileSources('tsc-ts-deferred-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');

// `b.ts`'s functions have no return type annotations, so checking `a.ts` infers their return types
// from the function and arrow expressions they return, which defers those expressions' bodies.
const dir = tempDir('tsc-ts-deferred-project-');
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ['a.ts', 'b.ts'] }),
);
writeFileSync(join(dir, 'a.ts'), ["import { arrow, make } from './b';", 'make()();', 'arrow()();', ''].join('\n'));
writeFileSync(
  join(dir, 'b.ts'),
  [
    'export function make() {',
    '  return function inner() {',
    '    const s: string = 1;',
    '    return s;',
    '  };',
    '}',
    "export const arrow = () => () => { const n: number = 'x'; return n; };",
    '',
  ].join('\n'),
);

function setup() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const checked = new CheckedProgram(work.program);
  const file = (name) => work.program.getSourceFiles().find((f) => f.fileName.endsWith('/' + name));
  return { checker: checked.createChecker(), a: file('a.ts'), b: file('b.ts') };
}

const codes = (diagnostics) => diagnostics.map((d) => `${d.code}@${d.pos}`);
const expectedB = ['2322@63', '2322@140'];

test("checking a file leaves other files' deferred bodies to their own file", () => {
  const { checker, a, b } = setup();
  assert.deepEqual(codes(checker.getDiagnostics(a)), []);
  // Checking a.ts resolved make() and arrow(), but did not check the bodies they return.
  assert.deepEqual(codes(checker.diagnostics.forFile(b.fileName)), []);
  assert.deepEqual(codes(checker.getDiagnostics(b)), expectedB);
});

test('a file checked first reports its deferred bodies once, whatever is checked next', () => {
  const { checker, a, b } = setup();
  assert.deepEqual(codes(checker.getDiagnostics(b)), expectedB);
  assert.deepEqual(codes(checker.getDiagnostics(a)), []);
  assert.deepEqual(codes(checker.diagnostics.forFile(b.fileName)), expectedB);
});
