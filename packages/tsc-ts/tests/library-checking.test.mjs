// Compiles projects whose global augmentations make the default library files invalid, or that use
// features of newer library files than the selected ones, through tsgo
// (packages/tsgo/dist/tsgo) and tsc-ts (the Node build, or TSC_TS_BIN), and compares stdout, stderr and exit
// status, and the build info of incremental runs. Each project runs with several option combinations,
// skipLibCheck and skipDefaultLibCheck included. Projects with packages in node_modules check module
// resolution and the checks that depend on it the same way.
// Set LIBRARY_FILTER to a substring of project names to run only those, and LIBRARY_SHARD to `i/n` to run every nth
// run of each test starting at the ith.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;
const workers = Number(process.env.TEST_WORKERS ?? 8);
// Lets the many Node processes share compiled code (https://nodejs.org/api/module.html#module-compile-cache).
const compileCache = process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {};

const base = { target: 'ES2025', module: 'NodeNext', strict: true, noEmit: true, types: [], pretty: false };

/** Option combinations every project runs with, on top of `base` and the project's own options. */
const variants = [
  {},
  { skipLibCheck: true },
  { skipDefaultLibCheck: true },
  { strict: false },
  { target: 'ES5', module: 'CommonJS' },
  { lib: ['ES2020'] },
  { lib: ['ESNext', 'DOM', 'DOM.Iterable', 'WebWorker.ImportScripts'] },
  { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, noPropertyAccessFromIndexSignature: true },
  { noUnusedLocals: true, noUnusedParameters: true, noImplicitReturns: true, noImplicitOverride: true },
  { noLib: true },
  { incremental: true },
  { pretty: true },
];

/**
 * Projects as `[name, files, options]`; a lone `a.ts` source stands for `{ 'a.ts': source }`.
 * @type {[string, string | Record<string, string>, Record<string, unknown>?][]}
 */
const projects = [
  ['extra Array type parameter', 'declare global { interface Array<T, U> { extra: U; } }\nexport {};\n'],
  ['duplicate PropertyKey alias', 'declare global { type PropertyKey = number; }\nexport {};\n'],
  ['duplicate Partial alias', 'declare global { type Partial<T> = T; }\nexport {};\n'],
  ['conflicting String property', 'declare global { interface String { length: string; } }\nexport {};\n'],
  ['conflicting Error property', 'declare global { interface Error { cause: number; } }\nexport {};\n'],
  ['Object index signature', 'declare global { interface Object { [key: string]: number; } }\nexport {};\n'],
  ['Array string index signature', 'declare global { interface Array<T> { [key: string]: boolean; } }\nexport {};\n'],
  ['Promise then property', 'declare global { interface Promise<T> { then: number; } }\nexport {};\n'],
  ['Function apply property', 'declare global { interface Function { apply: string; } }\nexport {};\n'],
  ['Symbol redeclared', 'declare global { var Symbol: number; }\nexport {};\n'],
  ['Iterator required member', 'declare global { interface Iterator<T> { required: never; } }\nexport {};\n'],
  ['Number method overload', 'declare global { interface Number { toFixed(digits: string): string; } }\nexport {};\n'],
  ['Intl namespace augmentation', 'declare global { namespace Intl { var Collator: string; } }\nexport {};\n'],
  [
    'ReadonlyArray type parameter constraint',
    'declare global { interface ReadonlyArray<T extends string> {} }\nexport {};\n',
  ],
  ['global script', 'interface Array<T> { [n: string]: T; }\ninterface Boolean { valueOf(): string; }\n'],
  ['merged lib class', 'declare global { interface Date { getTime(): string; } }\nexport {};\n'],
  ['clean augmentation', 'declare global { interface Array<T> { last(): T | undefined; } }\nexport {};\n'],
  ['no augmentation', 'export const a: number = 1;\n'],
  [
    'features of newer libraries',
    'export const m = new Map<string, number>();\nexport const a = [1].at(0);\n' +
      'export const s = "ab".replaceAll("a", "b");\nexport const y = Symbol();\nexport const w: WeakRef<object> = null!;\n',
  ],
  [
    'unconstrained type parameters',
    'export function f<T>(x: T) { const y: string = x; return y; }\n' +
      'export function g<T>(x: T): Record<string, number> { return x; }\n',
  ],
  [
    'non-ASCII text',
    '// caf\u00e9 \u2014 \u{1f600}\ndeclare global { interface String { length: string; } }\nexport const s: string = 1;\n',
  ],
  [
    'library declaration file augmentation',
    {
      'a.ts': 'import "./globals";\nexport const n: number = [1].length;\n',
      'globals.d.ts': 'interface Array<T, U> { extra: U; }\ninterface String { length: string; }\n',
    },
    { files: ['a.ts', 'globals.d.ts'] },
  ],
  [
    'checked JavaScript augmentation',
    {
      'a.ts': 'export {};\n',
      'b.js': '/** @type {number} */\nvar Symbol = 1;\n',
    },
    { allowJs: true, checkJs: true, files: ['a.ts', 'b.js'] },
  ],
  ['conflicting library reference', '/// <reference lib="webworker" />\nexport const n: number = 1;\n'],
  [
    'unrelated global script',
    { 'a.ts': 'export const n: number = unrelated;\n', 'globals.d.ts': 'declare var unrelated: number;\n' },
    { files: ['a.ts', 'globals.d.ts'] },
  ],
  [
    'UMD global',
    { 'a.ts': 'export {};\n', 'umd.d.ts': 'export declare const x: number;\nexport as namespace Lib;\n' },
    { files: ['a.ts', 'umd.d.ts'] },
  ],
  [
    'module augmentation',
    {
      'a.ts': 'export interface I { a: number; }\n',
      'b.ts': 'import "./a";\ndeclare module "./a" { interface I { b: string; } }\nexport {};\n',
    },
    { files: ['a.ts', 'b.ts'] },
  ],
  [
    'errors in every kind of file',
    {
      'a.ts': 'declare global { type PropertyKey = number; }\nexport const x: string = 1;\n',
      'b.d.ts': 'declare const y: string = 1;\n',
    },
    { files: ['a.ts', 'b.d.ts'] },
  ],
];

/** Option combinations every package project runs with, on top of `base` and the project's own options. */
const packageVariants = [
  {},
  { strict: false },
  { noUnusedLocals: true, noUnusedParameters: true },
  { module: 'Node16' },
  { module: 'ESNext', moduleResolution: 'bundler' },
  { allowJs: true },
];

/**
 * Projects with packages, as `[name, files, options]`.
 * @type {[string, Record<string, string>, Record<string, unknown>?][]}
 */
const packageProjects = [
  [
    'augmentation of a module re-exported with export *',
    {
      'node_modules/kit/package.json': '{"name":"kit","types":"index.d.ts"}\n',
      'node_modules/kit/index.d.ts': "export * from './dist/index.js';\n",
      'node_modules/kit/dist/index.d.ts':
        'interface Checker { (value: number): string; label: string; }\n' +
        'export { type Checker, check };\ndeclare const check: Checker;\n',
      'aug.d.ts': "declare module 'kit' { interface Checker { extra: () => void; } }\nexport {};\n",
      'a.ts':
        "import { type Checker, check } from 'kit';\ndeclare const c: Checker;\n" +
        'c(1);\nc.label;\nc.extra();\ncheck.extra();\nexport {};\n',
    },
    { files: ['a.ts', 'aug.d.ts'] },
  ],
  [
    'JSDoc links in type members',
    {
      't.ts':
        'export interface Token {}\nexport interface Other {}\nexport class K {}\nexport interface P {}\n' +
        'export interface Unused {}\n',
      'a.ts':
        "import type { Token, Unused } from './t.js';\nimport { Other, K } from './t.js';\nimport { type P } from './t.js';\n" +
        'export interface Shape {\n  /** see {@link Token}. */\n  draw(meta: number): void;\n' +
        '  /** see {@link Other}. */\n  x: number;\n}\n' +
        'export type Literal = {\n  /** {@link K} */\n  y(\n    /** {@link P} */\n    n: number,\n  ): void;\n};\n',
    },
    { files: ['a.ts'] },
  ],
  [
    'uncalled function check with type assertions in the body',
    {
      't.ts': 'export interface Config { x: number; }\n',
      'a.ts':
        "import type { Config } from './t.js';\ndeclare function use(config: Config): void;\n" +
        'export function f(value: string, callback: (n: number) => void, other: () => void) {\n' +
        '  if (value.length > 0 && callback) {\n    use(value as unknown as Config);\n    callback(1);\n  }\n' +
        '  if (other) {\n    use(<Config>(<unknown>value));\n  }\n}\n',
    },
    { files: ['a.ts'] },
  ],
  [
    'untyped JavaScript packages',
    {
      'node_modules/poly/package.json': '{"name":"poly","main":"dist/poly.js"}\n',
      'node_modules/poly/dist/poly.js': 'window.poly = 1;\n',
      'node_modules/@scope/lib/package.json': '{"name":"@scope/lib","version":"1.0.0","main":"index.js"}\n',
      'node_modules/@scope/lib/index.js': 'module.exports = 1;\n',
      'local.js': 'export const q = 1;\n',
      'a.ts':
        'import "poly";\nimport "poly/missing";\nimport "./local.js";\nimport lib from "@scope/lib";\n' +
        'import * as poly from "poly";\nlib;\npoly;\n' +
        'declare module "poly" { export const z: number; }\nexport {};\n',
    },
    { files: ['a.ts'] },
  ],
  [
    'module resolution errors',
    {
      'package.json': '{"type":"module"}\n',
      'b.ts': 'export const b = 1;\n',
      'd.d.ts': 'export declare const d: number;\n',
      'c.tsx': 'export const c = 1;\n',
      'cjs/package.json': '{"type":"commonjs"}\n',
      'cjs/e.ts': 'import { b } from "../b.js";\nimport x = require("../b.js");\nb;\nx;\n',
      'node_modules/exp/package.json': '{"name":"exp","exports":{".":"./index.js"}}\n',
      'node_modules/exp/index.js': 'export default 1;\n',
      'node_modules/exp/index.d.ts': 'declare const v: number;\nexport default v;\n',
      'a.ts':
        'import { b } from "./b.ts";\nimport { d } from "./d.d.ts";\nimport { b as b2 } from "./b";\n' +
        'import { c } from "./c.tsx";\nimport v from "exp";\nimport "./missing.js";\n' +
        'import type { b as b3 } from "./b.ts";\nb; d; b2; c; v;\nexport type { b3 };\n',
    },
    { files: ['a.ts', 'cjs/e.ts'] },
  ],
];

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** Compiles the project in a fresh directory; returns the output, exit status and any build info. */
function run(command, files) {
  const cwd = tempDir('tsc-ts-library-');
  writeFiles(cwd, files);
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1', ...compileCache };
  const args = [...command.slice(1), '-p', '.'];
  return new Promise((done) => {
    execFile(command[0], args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 }, (error, stdout, stderr) => {
      const buildInfoFile = join(cwd, 'tsconfig.tsbuildinfo');
      const buildInfo = existsSync(buildInfoFile) ? readFileSync(buildInfoFile, 'utf8') : '';
      // Messages name resolved files by absolute path.
      const relative = (text) => text.replaceAll(cwd, '.');
      const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      done({ stdout: relative(stdout), stderr: relative(stderr), status, buildInfo });
    });
  });
}

function firstDifference(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] === bl[i]) continue;
    const [x, y] = [al[i] ?? '', bl[i] ?? ''];
    let at = 0;
    while (at < x.length && x[at] === y[at]) at++;
    const start = Math.max(0, at - 60);
    const show = (line) => JSON.stringify(line.slice(start, at + 60));
    return `line ${i + 1}, column ${at + 1}: tsgo ${show(x)}, ours ${show(y)}`;
  }
  return 'none';
}

/** Runs each project with each variant through tsgo and tsc-ts and asserts that they match. */
async function compareProjects(t, projectList, variantList) {
  const filter = process.env.LIBRARY_FILTER;
  let runs = [];
  for (const [name, source, options = {}] of projectList) {
    if (filter !== undefined && !name.includes(filter)) continue;
    const { files: rootFiles, ...projectOptions } = options;
    const files = typeof source === 'string' ? { 'a.ts': source } : source;
    for (const variant of variantList) {
      const compilerOptions = { ...base, ...projectOptions, ...variant };
      const config = { compilerOptions, files: rootFiles ?? ['a.ts'] };
      runs.push({
        label: `${name} ${JSON.stringify(variant)}`,
        files: { ...files, 'tsconfig.json': JSON.stringify(config) },
      });
    }
  }
  const shard = /^(\d+)\/(\d+)$/.exec(process.env.LIBRARY_SHARD ?? '');
  if (shard !== null) runs = runs.filter((_, i) => i % Number(shard[2]) === Number(shard[1]) - 1);
  const failures = [];
  let errors = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < runs.length) {
        const { label, files } = runs[next++];
        const [expected, actual] = await Promise.all([run([tsgo], files), run(tscTs, files)]);
        if (expected.stdout.includes('bundled:///libs/')) errors++;
        const problems = [];
        if (expected.stdout !== actual.stdout)
          problems.push('stdout ' + firstDifference(expected.stdout, actual.stdout));
        if (expected.stderr !== actual.stderr)
          problems.push('stderr ' + firstDifference(expected.stderr, actual.stderr));
        if (expected.status !== actual.status) problems.push(`status tsgo ${expected.status}, ours ${actual.status}`);
        if (expected.buildInfo !== actual.buildInfo)
          problems.push('build info ' + firstDifference(expected.buildInfo, actual.buildInfo));
        if (problems.length > 0) failures.push(`${label}:\n    ${problems.join('\n    ')}`);
      }
    }),
  );
  t.diagnostic(`${runs.length - failures.length}/${runs.length} runs match; ${errors} report library errors`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} mismatches`);
}

test('library diagnostics from global augmentations match tsgo', { skip, timeout: 900_000 }, async (t) => {
  await compareProjects(t, projects, variants);
});

test('diagnostics of projects with packages match tsgo', { skip, timeout: 900_000 }, async (t) => {
  await compareProjects(t, packageProjects, packageVariants);
});
