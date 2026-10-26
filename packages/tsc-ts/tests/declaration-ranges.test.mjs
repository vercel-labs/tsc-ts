// Checker threads check a large declaration file in statement ranges (parallel-check.ts `rangeUnits`). A file whose
// ranges find no diagnostics has none; otherwise it is checked whole, since the diagnostics of ranges can differ from
// the file's. TSC_TS_RANGES=all checks every checked declaration file in ranges, so these small projects go through
// the same paths as lib.dom.d.ts in a small program, and must report and emit what tsgo does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

const options = { target: 'ES2022', strict: true, noEmit: true, types: [], skipDefaultLibCheck: true };
const emitting = { ...options, noEmit: false, noEmitOnError: true, outDir: 'out' };

/** `count` declarations that check cleanly, to spread a file's statements over several ranges. */
function filler(prefix, count) {
  let text = '';
  for (let i = 0; i < count; i++)
    text += `interface ${prefix}${i} extends ${prefix}Base { value${i}: ${prefix}${i > 0 ? i - 1 : 'Base'} }\n`;
  return `interface ${prefix}Base { id: number }\n${text}`;
}

/** Projects as `[name, files]`, each checked with `options` unless it has its own tsconfig.json. */
const projects = [
  [
    'a declaration file without diagnostics',
    { 'types.d.ts': filler('A', 200), 'a.ts': 'export const n: number = 1;\n' },
  ],
  [
    'an error in a file next to a declaration file without diagnostics',
    { 'types.d.ts': filler('A', 200), 'a.ts': 'declare const x: A199;\nexport const n: string = x.value199.id;\n' },
  ],
  [
    'a union whose members print in the order the checker created them',
    {
      'types.d.ts':
        'declare const early: 3n;\n' +
        filler('B', 100) +
        'interface G<T extends 1n | 2n | 3n> { t: T }\n' +
        filler('C', 100) +
        'type Bad = G<0n>;\n',
      'a.ts': 'export {};\n',
    },
  ],
  [
    'a check that the first of merged declarations runs, which reports on all of them',
    {
      'types.d.ts': 'export interface I { a: number }\n' + filler('D', 150) + 'interface I { b: number }\n',
      'a.ts': 'import type { I } from "./types";\nexport const i: I = { a: 1, b: 2 };\n',
    },
  ],
  [
    'noEmitOnError with an error a comment suppresses in a declaration file: the program emits',
    {
      'types.d.ts': filler('G', 100) + '// @ts-ignore\ninterface Bad extends GBase { id: string }\n' + filler('H', 100),
      'a.ts': 'export const n: number = 1;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: emitting }),
    },
  ],
  [
    'noEmitOnError with an error in a declaration file: the program does not emit',
    {
      'types.d.ts': filler('G', 100) + 'interface Bad extends GBase { id: string }\n' + filler('H', 100),
      'a.ts': 'export const n: number = 1;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: emitting }),
    },
  ],
  [
    'an unused @ts-expect-error in a declaration file without other diagnostics',
    {
      'types.d.ts': filler('E', 100) + '// @ts-expect-error\ninterface Fine { ok: true }\n' + filler('F', 100),
      'a.ts': 'export {};\n',
    },
  ],
];

function run(command, files, extraArgs, env) {
  const cwd = tempDir('tsc-ts-declaration-ranges-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  return new Promise((done) => {
    execFile(
      command[0],
      [...command.slice(1), '-p', '.', '--pretty', 'false', ...extraArgs],
      {
        cwd,
        env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, NO_COLOR: '1', ...env },
        encoding: 'utf8',
      },
      (error, stdout, stderr) =>
        done({
          stdout,
          stderr,
          status: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          outputs: written(cwd, cwd, files),
        }),
    );
  });
}

/** The files under `dir` that are not in `inputs`, by path relative to `root`, with their text. */
function written(root, dir, inputs, outputs = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) written(root, path, inputs, outputs);
    else if (!(relative(root, path) in inputs)) outputs[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return outputs;
}

test(
  'declaration files checked in statement ranges report and emit what tsgo does',
  { skip, timeout: 300_000 },
  async () => {
    const failures = [];
    await Promise.all(
      projects.map(async ([name, source]) => {
        const files = { 'tsconfig.json': JSON.stringify({ compilerOptions: options }), ...source };
        const expected = await run([tsgo], files, [], {});
        for (const checkers of ['1', '4']) {
          const actual = await run(tscTs, files, ['--checkers', checkers], { TSC_TS_RANGES: 'all' });
          if (
            expected.stdout !== actual.stdout ||
            expected.status !== actual.status ||
            JSON.stringify(expected.outputs) !== JSON.stringify(actual.outputs)
          )
            failures.push(
              `${name} (--checkers ${checkers}):\n  tsgo ${expected.status} ${Object.keys(expected.outputs)}: ${expected.stdout}\n  ours ${actual.status} ${Object.keys(actual.outputs)}: ${actual.stdout}${actual.stderr}`,
            );
        }
      }),
    );
    assert.deepEqual(failures, []);
  },
);
