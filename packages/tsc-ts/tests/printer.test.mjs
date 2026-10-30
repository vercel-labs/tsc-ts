import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cases, libs, listFiles, materialize } from './parser-cases.mjs';
import { buildPrintDriver, comparePrints, printOracle } from './printer-cases.mjs';

// Every 25th test case and the bundled libs.
function sample() {
  const picked = [...listFiles(join(cases, 'compiler')), ...listFiles(join(cases, 'conformance'))].filter(
    (_, i) => i % 25 === 0,
  );
  return [...listFiles(libs), ...picked];
}

test(
  'printer matches tsgo on test cases and libs',
  { skip: (!existsSync(printOracle) || !existsSync(cases)) && 'needs upstream sources and the print oracle' },
  async () => {
    const command = buildPrintDriver();
    const paths = materialize(sample(), 'tsc-ts-print-test-').paths.map((unit) => unit.path);
    for (const flags of [[], ['--remove-comments'], ['--crlf', '--target', 'es2021'], ['--sourcemap']]) {
      const failures = await comparePrints(command, paths, flags, 8);
      assert.deepEqual(
        failures.map((i) => paths[i]),
        [],
        `printing with ${flags.join(' ') || 'defaults'}`,
      );
    }
  },
);

test(
  'printer prints mapped types written without a type as tsgo does',
  { skip: (!existsSync(printOracle) || !existsSync(cases)) && 'needs upstream sources and the print oracle' },
  async () => {
    const command = buildPrintDriver();
    const files = [
      join(cases, 'compiler/anyMappedTypesError.ts'),
      join(cases, 'compiler/mappedTypeNoTypeNoCrash.ts'),
      join(cases, 'conformance/types/mapped/mappedTypeProperties.ts'),
    ];
    const paths = materialize(files, 'tsc-ts-print-mapped-').paths.map((unit) => unit.path);
    for (const flags of [[], ['--remove-comments'], ['--sourcemap']]) {
      const failures = await comparePrints(command, paths, flags, 3);
      assert.deepEqual(
        failures.map((i) => paths[i]),
        [],
        `printing with ${flags.join(' ') || 'defaults'}`,
      );
    }
  },
);
