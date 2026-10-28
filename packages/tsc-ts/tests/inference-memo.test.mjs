// Contextual return type inference walks are memoized per checker (inferTypesFromUnstarted). With
// TSC_TS_VERIFY_INFERENCE_MEMO=1, every skipped walk is walked anyway and compared with what was
// skipped. Each call below repeats often enough for its walks to be skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileSources } from './temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const libs = join(repo, 'upstream/typescript-go/internal/bundled/libs');
const oracle = join(repo, 'packages/tsgo/dist/check-oracle');

const source = [
  'interface Tags {',
  "  a: { kind: 'a'; a: string; shared: number };",
  "  b: { kind: 'b'; b: number; shared: number };",
  '}',
  'interface Shared { shared: number }',
  'declare function make<K extends keyof Tags>(tag: K): Tags[K];',
  'declare function list<T>(): T[];',
  'declare function box<T>(value: T): { value: T };',
  'declare function id<T>(x: T): T;',
  'type Identity = <T>(x: T) => T;',
  "const s1: Shared = make('a');",
  "const s2: Shared = make('a');",
  "const s3: Shared = make('b');",
  "const s4: Shared = make('a');",
  "const s5: Shared = make('b');",
  "const s6: Shared = make('a');",
  'const l1: string[] = list();',
  'const l2: string[] = list();',
  'const l3: string[] = list();',
  'const l4: string[] = list();',
  'const l5: number[] = list();',
  'const l6: string[] = list();',
  'const b1: { value: number } = box(1);',
  'const b2: { value: number } = box(2);',
  'const b3: { value: number } = box(3);',
  'const b4: { value: number } = box(4);',
  'const b5: { value: string } = box(5);',
  "const b6: { value: number } = box('6');",
  'const f1: Identity = id(id);',
  'const f2: Identity = id(id);',
  'const f3: Identity = id(id);',
  'const f4: Identity = id(id);',
  'const f5: Identity = id(id);',
  "const u: Tags[keyof Tags] = make('b');",
  "const k: keyof Tags[keyof Tags] = 'shared';",
  "const s7: Shared = make('a');",
  "const s8: Shared = make('b');",
];

test(
  'skipped return type inference walks match walking them',
  { skip: !existsSync(libs) && 'needs upstream sources', timeout: 120_000 },
  () => {
    const out = compileSources('tsc-ts-inference-memo-', ['drivers/check.ts']);
    const file = join(out, 'input.ts');
    writeFileSync(file, source.join('\n') + '\n');
    const result = spawnSync(process.execPath, ['--stack-size=16000', join(out, 'drivers/check.js'), file, libs], {
      encoding: 'utf8',
      env: { ...process.env, TSC_TS_VERIFY_INFERENCE_MEMO: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.stderr.split('\n').filter((l) => l.startsWith('inference memo:')),
      [],
    );
    const lines = result.stdout.split('\n').filter((l) => l !== '');
    assert.deepEqual(lines, [
      "/input.ts 2322 870 2 Type '{ value: number; }' is not assignable to type '{ value: string; }'.",
      "/input.ts 2322 908 2 Type '{ value: string; }' is not assignable to type '{ value: number; }'.",
    ]);
    if (existsSync(oracle)) {
      const reference = execFileSync(oracle, [file, libs], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l !== '');
      assert.deepEqual(lines, reference);
    }
  },
);
