// With TSC_TS_SIDE_STATE=1, every type and signature keeps its lazily computed state in the
// checker's side tables (`sideOf`) instead of its own fields. Diagnostics must be the same as without
// it: a read or write that bypasses the side tables shows up as a difference here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const cases = join(root, 'upstream/TypeScript/tsc/testdata/tests/cases');

// Recursive base types, conditional, mapped, literal and tuple types, inference and narrowing.
const directories = [
  'conformance/interfaces/interfaceDeclarations',
  'conformance/types/conditional',
  'conformance/types/mapped',
  'conformance/types/literal',
  'conformance/types/tuple',
  'conformance/types/typeRelationships/typeInference',
  'conformance/controlFlow',
];
const files = directories.flatMap((d) =>
  readdirSync(join(cases, d))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(cases, d, name)),
);
for (const name of readdirSync(join(cases, 'compiler')))
  if (name.startsWith('recursive') && name.endsWith('.ts')) files.push(join(cases, 'compiler', name));

const out = compileSources('tsc-ts-side-state-', ['drivers/check.ts']);
const list = join(tempDir('tsc-ts-side-state-list-'), 'files.txt');
writeFileSync(list, files.join('\n') + '\n');

function check(sideState) {
  return execFileSync(
    process.execPath,
    ['--stack-size=16000', join(out, 'drivers/check.js'), list, bundledLibs, '--batch'],
    { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, TSC_TS_SIDE_STATE: sideState } },
  );
}

test('lazily computed state in side tables gives the same diagnostics', () => {
  const plain = check('0');
  assert.ok(plain.split('\n').filter((line) => line.startsWith('== ')).length === files.length);
  assert.equal(check('1'), plain);
});
