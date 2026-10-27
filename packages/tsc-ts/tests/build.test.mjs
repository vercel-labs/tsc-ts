// Runs `tsc --build`, `--incremental` and related scenarios through tsgo (packages/tsgo/dist/tsgo) and tsc-ts
// (the Node build, or TSC_TS_BIN), step by step in two copies of a project, and compares output, exit status and
// every file afterwards, .tsbuildinfo included. Times in status lines are masked, as are statistics values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

/**
 * @typedef {{ args: string[], edit?: Record<string, string | null>, touch?: string[], cwd?: string }} Step
 * @typedef {{ files: Record<string, string>, links?: Record<string, string>, steps: Step[] }} Scenario
 */

/**
 * `count` modules, each importing the next, an ambient module, a pattern ambient module and a type of a module
 * another file augments; every tenth also references a declaration file with `/// <reference>`.
 */
function referencingModules(count) {
  const files = {
    'tsconfig.json':
      '{"compilerOptions":{"incremental":true,"noEmit":true,"strict":true,"module":"esnext",' +
      '"moduleResolution":"bundler","types":[]},"include":["src"]}',
    'src/ambient.d.ts':
      'declare module "virtual:a" { export const v: number; }\n' +
      'declare module "*.css" { const s: string; export default s; }\n',
    'src/extra.d.ts': 'declare const X: string;\n',
    'src/target.ts': 'export interface Box { a: number }\n',
    'src/augment.ts': 'import "./target";\ndeclare module "./target" { interface Box { b?: string } }\nexport {};\n',
  };
  const name = (i) => 'm' + String(i).padStart(3, '0');
  for (let i = 0; i < count; i++) {
    const next = name((i + 1) % count);
    files[`src/${name(i)}.ts`] =
      (i % 10 === 0 ? '/// <reference path="./extra.d.ts" />\n' : '') +
      `import { v as next } from "./${next}";\nimport { v as w } from "virtual:a";\nimport css from "./style.css";\n` +
      `import type { Box } from "./target";\nexport const v: number = ${i};\n` +
      'export const f = (b: Box) => next + w + css.length + b.a;\n';
  }
  return files;
}

/** @type {Record<string, Scenario>} */
const scenarios = {
  'errors on intersections reduced to never': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true},"files":["a.ts"]}',
      // TS2339 and TS2509 say which property reduced the intersection to never.
      'a.ts':
        'declare class A<T> { private _p: T; a: T }\ndeclare class B { private _p: number; b: string }\n' +
        'declare function isB(x: unknown): x is B;\ndeclare const x: A<number>;\nif (isB(x)) x.c;\n' +
        'declare const C: new () => A<number> & B;\nexport class D extends C {}\n',
    },
    steps: [{ args: [] }],
  },
  'numeric separators without a target': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"outDir":"out"},"files":["a.ts","b.ts"]}',
      'a.ts': 'export const n = 30_000;\nlet q: number | undefined;\nq ??= 1_000;\n',
      'b.ts': 'export const m = 0x_ff;\n',
    },
    steps: [{ args: [] }, { args: ['--target', 'es2020'] }, { args: ['--target', 'es2021'] }],
  },
  'stored relation errors with elaborations and related information': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true},"files":["a.ts","b.ts"]}',
      // TS2322 elaborated by TS2326 and TS2741, with "'b' is declared here." as related information.
      'a.ts':
        'interface P { a: number; b: string; }\ndeclare const r: { x: { a: number } };\nexport const p: { x: P } = r;\n' +
        'declare function f(x: { a: { b: number } }): void;\ndeclare const v: { a: { b: string } };\nf(v);\n' +
        // TS2769 with "The last overload is declared here." as related information of the outermost message.
        'declare function g(x: number): void;\ndeclare function g(x: { a: number }): void;\ng({ a: "s" });\n',
      'b.ts': 'export const b = 1;\n',
    },
    steps: [{ args: [] }, { args: [], edit: { 'b.ts': 'export const b = 2;\n' } }, { args: [] }],
  },
  'references with --verbose, --force, --dry and --clean': {
    files: {
      'a/tsconfig.json': '{"compilerOptions":{"composite":true,"outDir":"out"},"files":["index.ts"]}',
      'a/index.ts': 'export const a: number = 1;\n',
      'b/tsconfig.json': '{"compilerOptions":{"outDir":"out"},"references":[{"path":"../a"}],"files":["index.ts"]}',
      'b/index.ts': 'import { a } from "../a/index";\nexport const b: number = a + 1;\n',
    },
    steps: [
      { args: ['-b', 'b', '--verbose'] },
      { args: ['-b', 'b', '--verbose'] },
      {
        args: ['-b', 'b', '--verbose'],
        edit: { 'b/index.ts': 'import { a } from "../a/index";\nexport const b: string = a;\n' },
      },
      { args: ['-b', 'b', '--verbose'] },
      { args: ['-b', 'b', '-v'], edit: { 'b/index.ts': 'import { a } from "../a/index";\nexport const b = a;\n' } },
      { args: ['-b', 'b', '-v'], edit: { 'a/index.ts': 'export const a: number = 2;\n' } },
      { args: ['-b', 'b', '-v'], edit: { 'a/index.ts': 'export const a: number = 2;\n// changed\n' } },
      { args: ['-b', 'b', '--verbose', '--force'] },
      { args: ['-b', 'b', '--dry'] },
      { args: ['-b', 'b', '--clean', '--dry'] },
      { args: ['-b', 'b', '--clean'] },
      { args: ['-b', 'b', '--dry'] },
      { args: ['-b', 'b', '--pretty'] },
    ],
  },
  // A reference checked on checker threads writes its declarations outside its directory, and the root
  // project imports them by their own path: a fresh build finds them, and a forced rebuild reads the
  // declarations the reference just wrote.
  'references with outputs outside their directory on checker threads': {
    files: {
      'a/tsconfig.json':
        '{"compilerOptions":{"composite":true,"outDir":"../out/a","rootDir":"."},"files":["index.ts"]}',
      'a/index.ts': 'export const a: number = 1;\n',
      'b/tsconfig.json':
        '{"compilerOptions":{"declaration":true,"outDir":"../out/b"},"references":[{"path":"../a"}],"files":["index.ts"]}',
      'b/index.ts': 'import { a } from "../out/a/index";\nexport const b = a;\n',
    },
    steps: [
      { args: ['-b', 'b', '--checkers', '4'] },
      { args: ['-b', 'b', '--checkers', '4', '--force'], edit: { 'a/index.ts': 'export const a: string = "s";\n' } },
      { args: ['-b', 'b', '--checkers', '4', '--force'], edit: { 'a/index.ts': 'export const a: boolean = true;\n' } },
    ],
  },
  'signatures of files with several declaration errors': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"incremental":true,"outDir":"out","module":"nodenext"},"files":["a.ts"]}',
      'package.json': '{"name":"app","type":"module"}',
      'node_modules/dep/package.json': '{"name":"dep","exports":{".":{"types":"./index.d.ts"}}}',
      'node_modules/dep/index.d.ts':
        'import type { Z, A } from "./internal.js";\nexport declare function make(): { z: Z; a: A };\n',
      'node_modules/dep/internal.d.ts': 'export interface Z { z: 1 }\nexport interface A { a: 1 }\n',
      // TS2883 for Z, then for A: the declaration emitter reports them in that order.
      'a.ts': 'import { make } from "dep";\nexport const x = make();\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'a.ts': 'import { make } from "dep";\nexport const x = make();\n// edit\n' } },
    ],
  },
  // A JSON module's signature is its version, so fixing it rechecks its importers.
  'JSON module errors cleared after fixing the JSON file': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true,"resolveJsonModule":true,' +
        '"esModuleInterop":true}}',
      'data.json': '{ "title": "hello" }',
      'check.ts':
        'import type data from "./data.json";\n\ntype Shape = { title: string };\ntype Covers<T extends Shape> = T;\n\n' +
        'export type Check = Covers<typeof data>;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'data.json': '{}' } },
      { args: [], edit: { 'data.json': '{ "title": "fixed" }' } },
    ],
  },
  // Deleting a global declaration file with another file rechecks every file, also when the other file
  // (exports.d.ts) comes first.
  'mixed file deletion with add and change': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"incremental":true,"noEmit":true,"types":[]}}',
      'consumer.ts': 'declare const value: RemovedGlobal; value.property;',
      'global.d.ts': 'interface RemovedGlobal { property: string; }',
      'exports.d.ts': 'export interface ModuleOnly { property: string; }',
      'changed.ts': 'export const changed = 1;',
    },
    steps: [
      { args: [] },
      {
        args: [],
        edit: {
          'global.d.ts': null,
          'exports.d.ts': null,
          'changed.ts': 'export const changed = 2;',
          'added.ts': 'export const added = 1;',
        },
      },
      { args: [] },
      { args: [], edit: { 'global.d.ts': 'interface RemovedGlobal { property: number; }' } },
      { args: [], edit: { 'added.ts': null } },
      { args: [] },
    ],
  },
  // A global declaration file that becomes a module changes the global scope: its user, which does not
  // import it, is checked again.
  'global declaration file that becomes a module': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"incremental":true,"noEmit":true,"types":[]}}',
      'consumer.ts': 'declare const value: Shared; value.property;\n',
      'global.d.ts': 'interface Shared { property: string; }\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'global.d.ts': 'export interface Shared { property: string; }\n' } },
      { args: [] },
      { args: [], edit: { 'global.d.ts': 'interface Shared { property: string; }\n' } },
    ],
  },
  // Pending changes of deleted files leave the build info.
  'unchecked deleted paths with no emit': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"noCheck":true,"noEmit":true,"composite":true,"types":[]}}',
      'stable.ts': 'export const stable = 1;',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'first.ts': 'export const first = 1;', 'second.ts': 'export const second = 1;' } },
      { args: [], edit: { 'first.ts': null, 'second.ts': null } },
      { args: [] },
      {
        args: [],
        edit: {
          'tsconfig.json':
            '{"compilerOptions":{"incremental":true,"noCheck":false,"noEmit":false,"composite":true,"types":[]}}',
        },
      },
      { args: [] },
    ],
  },
  'upstream errors, --stopBuildOnErrors, solutions and missing references': {
    files: {
      'tsconfig.json': '{"files":[],"references":[{"path":"./b"},{"path":"./c"}]}',
      'a/tsconfig.json': '{"compilerOptions":{"composite":true},"files":["index.ts"]}',
      'a/index.ts': 'export const a: number = "one";\n',
      'b/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../a"}],"files":["index.ts"]}',
      'b/index.ts': 'import { a } from "../a/index";\nexport const b: number = a;\n',
      'c/tsconfig.json': '{"references":[{"path":"../missing"}],"files":["index.ts"]}',
      'c/index.ts': 'export const c: number = 3;\n',
    },
    steps: [
      { args: ['-b', '-v'] },
      { args: ['-b', '-v', '--stopBuildOnErrors'] },
      { args: ['-b', '-v'], edit: { 'a/index.ts': 'export const a: number = 1;\n' } },
      { args: ['-b', '-v'] },
      { args: ['-b', 'missing', 'c'] },
    ],
  },
  // Both projects include shared/value.ts, whose import of "lib" resolves to a different file in each.
  // In the second build, a (no build info) is checked on threads and parsed on parse threads, and b
  // (incremental) on the main thread: b must load the file itself.
  'a project parsed on threads before one that is not': {
    files: {
      'shared/value.ts': 'import { v } from "lib";\nexport const n: number = v;\n',
      'a/x/lib.ts': 'export const v: number = 1;\n',
      'b/y/lib.ts': 'export const v: string = "s";\n',
      'a/tsconfig.json':
        '{"compilerOptions":{"outDir":"out","rootDir":"..","paths":{"lib":["./x/lib.ts"]}},"files":["../shared/value.ts"]}',
      'b/tsconfig.json':
        '{"compilerOptions":{"incremental":true,"outDir":"out","rootDir":"..","paths":{"lib":["./y/lib.ts"]}},"files":["../shared/value.ts"]}',
    },
    steps: [
      { args: ['-b', 'a', 'b'] },
      {
        args: ['-b', 'a', 'b'],
        edit: { 'shared/value.ts': 'import { v } from "lib";\nexport const n: number = v;\n// changed\n' },
      },
    ],
  },
  'circular references': {
    files: {
      'a/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../b"}],"files":["a.ts"]}',
      'a/a.ts': 'export const a = 1;\n',
      'b/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../a"}],"files":["b.ts"]}',
      'b/b.ts': 'export const b = 1;\n',
    },
    steps: [{ args: ['-b', 'a', '-v'] }, { args: ['-b', 'a', 'b'] }],
  },
  'incremental emit, errors and option changes': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"outDir":"out","declaration":true,"strict":true},"include":["src"]}',
      'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): number { return x; }\n',
      'src/b.ts': 'import { a, f } from "./a";\nexport const b: number = f(a);\nlet x: string = 1;\n',
      'src/c.ts': 'import { b } from "./b";\nexport const c: number = b;\n',
      'src/g.ts': 'declare const g: number;\n',
    },
    steps: [
      { args: ['--listEmittedFiles'] },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'src/b.ts': 'import { a, f } from "./a";\nexport const b: number = f(a);\n' },
      },
      {
        args: ['--listEmittedFiles'],
        edit: {
          'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): string { return String(x); }\n',
        },
      },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): number { return x; }\n// c\n' },
      },
      { args: ['--listEmittedFiles', '--sourceMap'] },
      { args: ['--listEmittedFiles'], edit: { 'src/g.ts': 'declare const g: string;\n' } },
      { args: ['--listEmittedFiles'], edit: { 'src/c.ts': null } },
      { args: ['--listEmittedFiles', '--noEmit'], edit: { 'src/c.ts': 'export const c: number = "x";\n' } },
      { args: ['--listEmittedFiles'] },
      { args: ['--listFiles', '--pretty'] },
    ],
  },
  // In native builds the programs are checked and emitted on three checker threads, without old build info.
  'composite references built on checker threads': {
    files: {
      'a/tsconfig.json':
        '{"compilerOptions":{"composite":true,"declarationMap":true,"sourceMap":true,"outDir":"out"},' +
        '"include":["*.ts"]}',
      'a/shapes.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'a/area.ts':
        'import { Shape, unit } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
        'export const total = [unit].map(area);\n',
      'a/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
      'a/index.ts': 'export * from "./area";\nexport * from "./hidden";\nexport { unit } from "./shapes";\n',
      'b/tsconfig.json':
        '{"compilerOptions":{"composite":true,"outDir":"out"},"references":[{"path":"../a"}],"include":["*.ts"]}',
      'b/main.ts': 'import { area, unit } from "../a/index";\nexport const value = area(unit);\n',
      'b/other.ts': 'export const other: number = "x";\n',
    },
    steps: [
      { args: ['-b', 'b', '--verbose', '--checkers', '3'] },
      {
        args: ['-b', 'b', '--verbose', '--checkers', '3'],
        edit: {
          'a/shapes.ts':
            'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 2 };\n',
        },
      },
      { args: ['-b', 'b', '--verbose', '--checkers', '3', '--force'] },
    ],
  },
  // In native builds the first step checks and emits on three checker threads (no build info yet).
  'incremental program on checker threads': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"declaration":true,"declarationMap":true,"outDir":"out"},' +
        '"include":["src"]}',
      'src/shapes.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'src/area.ts':
        'import { Shape, unit } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
        'export const total = [unit].map(area);\n',
      'src/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
      'src/wrong.ts': 'export const n: number = "not a number";\n',
    },
    steps: [
      { args: ['--checkers', '3', '--listEmittedFiles'] },
      {
        args: ['--checkers', '3', '--listEmittedFiles'],
        edit: {
          'src/shapes.ts':
            'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 2 };\n',
        },
      },
      { args: ['--checkers', '3', '--listEmittedFiles'] },
    ],
  },
  // Missing global types that checking a file finds stay with the file, and a rebuild that doesn't check it
  // again reports them from the build info. In native builds the first step checks on two checker threads.
  'missing global types of an incremental program on checker threads': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"incremental":true,"lib":["es5"],"target":"es2017","types":[]}}',
      'generators.ts': 'export async function* values() { yield 1; }\nexport function* keys() { yield 1; }\n',
      'other.ts': 'export const other = 1;\n',
    },
    steps: [
      { args: ['--checkers', '2'] },
      { args: ['--checkers', '2'], edit: { 'other.ts': 'export const other = 2;\n' } },
      { args: ['--checkers', '2'] },
    ],
  },
  // In native builds the second step checks and emits the files the change affects on two checker threads.
  'incremental rebuild of affected files on checker threads': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"declaration":true,"declarationMap":true,"sourceMap":true,' +
        '"outDir":"out","rootDir":"src"},"include":["src"]}',
      'src/base.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'src/a.ts': 'import { Shape, unit } from "./base";\nexport const a = (s: Shape) => [s, unit];\n',
      'src/b.ts': 'import { unit } from "./base";\nexport const b = { ...unit, extra: true };\n',
      'src/c.ts': 'import * as base from "./base";\nexport const c: base.Shape = base.unit;\n',
      'src/d.ts': 'import { Shape } from "./base";\nexport function d(s: Shape): Shape | undefined { return s; }\n',
      'src/e.ts': 'import { unit } from "./base";\nexport const e: number = unit.kind;\n',
      'src/f.ts': 'import { a } from "./a";\nexport const f = a({ kind: "f", size: 2 });\n',
      'src/g.ts': 'export const g = 1;\n',
    },
    steps: [
      { args: ['--checkers', '2', '--listEmittedFiles'] },
      {
        args: ['--checkers', '2', '--listEmittedFiles'],
        edit: {
          'src/base.ts':
            'export interface Shape { kind: string; size: number; label?: string }\n' +
            'export const unit = { kind: "u", size: 1, label: "unit" };\n',
        },
      },
      { args: ['--checkers', '2', '--listEmittedFiles'], edit: { 'src/g.ts': 'export const g = 2;\n' } },
      { args: ['--checkers', '2', '--listEmittedFiles', '--strictNullChecks', 'false'] },
    ],
  },
  // In native builds the first step checks on two checker threads, which also find the declaration error,
  // the second checks the files the change affects on them, and the last builds without build info on them.
  'noEmit incremental program on checker threads': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"noEmit":true,"declaration":true,"rootDir":"src"},"include":["src"]}',
      'src/base.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'src/a.ts': 'import { Shape, unit } from "./base";\nexport const a = (s: Shape) => [s, unit];\n',
      'src/b.ts': 'import { unit } from "./base";\nexport const b = { ...unit, extra: true };\n',
      'src/c.ts': 'import * as base from "./base";\nexport const c: base.Shape = base.unit;\n',
      'src/d.ts': 'import { Shape } from "./base";\nexport function d(s: Shape): Shape | undefined { return s; }\n',
      'src/e.ts': 'import { unit } from "./base";\nexport const e: string = unit.kind;\n',
      'src/f.ts': 'import { a } from "./a";\nexport const f = a({ kind: "f", size: 2 });\n',
      'src/hidden.ts':
        'import { unit } from "./base";\nexport const instance = new (class { private secret = unit })();\n',
    },
    steps: [
      { args: ['--checkers', '2'] },
      {
        args: ['--checkers', '2'],
        edit: {
          'src/base.ts':
            'export interface Shape { kind: string; size: number; label?: string }\n' +
            'export const unit = { kind: "u", size: 1, label: "unit" };\n',
        },
      },
      {
        args: ['--checkers', '2'],
        edit: { 'src/e.ts': 'import { unit } from "./base";\nexport const e: number = unit.kind;\n' },
      },
      { args: ['-b', '--checkers', '2'], edit: { 'tsconfig.tsbuildinfo': null } },
    ],
  },
  // In native builds, programs checked by one checker are parsed on parse threads (unless --singleThreaded):
  // the first step without build info, the rebuilds after a body and an exported-signature edit, a plain
  // check, an emit and -b builds.
  'one checker after parse threads': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"noEmit":true,"declaration":true,"outDir":"out","rootDir":"src"},' +
        '"include":["src"]}',
      'src/base.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'src/a.ts': 'import { Shape, unit } from "./base";\nexport const a = (s: Shape) => [s, unit];\n',
      'src/b.ts': 'import { unit } from "./base";\nexport const b = { ...unit, extra: true };\n',
      'src/c.ts': 'import * as base from "./base";\nexport const c: base.Shape = base.unit;\n',
      'src/e.ts': 'import { unit } from "./base";\nexport const e: number = unit.kind;\n',
      'src/f.ts': 'import { a } from "./a";\nexport const f = a({ kind: "f", size: 2 });\n',
    },
    steps: [
      { args: ['--checkers', '1'] },
      {
        args: ['--checkers', '1'],
        edit: { 'src/f.ts': 'import { a } from "./a";\nexport const f = a({ kind: "f", size: 2 });\nvoid 0;\n' },
      },
      {
        args: ['--checkers', '1'],
        edit: {
          'src/base.ts':
            'export interface Shape { kind: string; size: number; label?: string }\n' +
            'export const unit = { kind: "u", size: 1, label: "unit" };\n',
        },
      },
      { args: ['--checkers', '1', '--singleThreaded'], edit: { 'src/b.ts': 'export const b = 2;\n' } },
      { args: ['--checkers', '1', '--incremental', 'false'] },
      { args: ['--checkers', '1', '--incremental', 'false', '--noEmit', 'false', '--listEmittedFiles'] },
      {
        args: ['-b', '--checkers', '1'],
        edit: { 'src/c.ts': 'import * as base from "./base";\nexport const c = base.unit;\n' },
      },
      { args: ['-b', '--checkers', '1', '--force'] },
    ],
  },
  // In native builds, -b rebuilds with build info check the files a change affects on two checker threads:
  // the composite project's threads only check, and it emits on the main thread; the other project's
  // threads also emit.
  'build rebuild of affected files on checker threads': {
    files: {
      'lib/tsconfig.json': '{"compilerOptions":{"composite":true,"rootDir":"src","outDir":"out"},"include":["src"]}',
      'lib/src/base.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'lib/src/a.ts': 'import { Shape, unit } from "./base";\nexport const a = (s: Shape) => [s, unit];\n',
      'lib/src/b.ts': 'import { unit } from "./base";\nexport const b = { ...unit, extra: true };\n',
      'lib/src/c.ts': 'import * as base from "./base";\nexport const c: base.Shape = base.unit;\n',
      'lib/src/d.ts': 'import { Shape } from "./base";\nexport function d(s: Shape): Shape | undefined { return s; }\n',
      'app/tsconfig.json':
        '{"compilerOptions":{"incremental":true,"rootDir":"src","outDir":"out"},"include":["src"],"references":[{"path":"../lib"}]}',
      'app/src/e.ts': 'import { unit } from "../../lib/src/base";\nexport const e: string = unit.kind;\n',
      'app/src/f.ts': 'import { a } from "../../lib/src/a";\nexport const f = a({ kind: "f", size: 2 });\n',
      'app/src/g.ts': 'import { b } from "../../lib/src/b";\nexport const g = b.extra;\n',
      'app/src/h.ts': 'import { c } from "../../lib/src/c";\nexport const h = c.size;\n',
    },
    steps: [
      { args: ['-b', 'app', '--checkers', '2'] },
      {
        args: ['-b', 'app', '--checkers', '2', '-v'],
        edit: {
          'lib/src/base.ts':
            'export interface Shape { kind: string; size: number; label?: string }\n' +
            'export const unit = { kind: "u", size: 1, label: "unit" };\n',
        },
      },
      {
        args: ['-b', 'app', '--checkers', '2'],
        edit: {
          'lib/src/base.ts':
            'export interface Shape { kind: string; size: number; label?: number }\n' +
            'export const unit = { kind: "u", size: 1, label: "unit" };\n',
        },
      },
      { args: ['-b', 'app', '--checkers', '2'], edit: { 'app/src/e.ts': 'export const e: string = "e";\n' } },
    ],
  },
  // With build info left by an incremental build, a project that is no longer incremental is built again
  // in full: every output is written (in native builds the threads would otherwise check without emitting).
  'build rebuild after incremental is turned off, with checker threads': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"incremental":true,"rootDir":"src","outDir":"out"},"include":["src"]}',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'src/c.ts': 'export const c = 1;\n',
      'src/d.ts': 'export const d = 1;\n',
      'src/e.ts': 'export const e = 1;\n',
      'src/f.ts': 'export const f = 1;\n',
    },
    steps: [
      { args: ['-b', '--checkers', '2'] },
      {
        args: ['-b', '--checkers', '2'],
        edit: {
          'tsconfig.json': '{"compilerOptions":{"incremental":false,"rootDir":"src","outDir":"out"},"include":["src"]}',
          'src/a.ts': 'export const a = 2;\n',
          'src/f.ts': 'export const f = 2;\n',
        },
      },
    ],
  },
  'noEmitOnError rebuild of affected files on checker threads': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"noEmitOnError":true,"declaration":true,"sourceMap":true,' +
        '"outDir":"out","rootDir":"src"},"include":["src"]}',
      'src/base.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'src/a.ts': 'import { Shape, unit } from "./base";\nexport const a = (s: Shape) => [s, unit];\n',
      'src/b.ts': 'import { unit } from "./base";\nexport const b = { ...unit, extra: true };\n',
      'src/c.ts': 'import * as base from "./base";\nexport const c: base.Shape = base.unit;\n',
      'src/d.ts': 'import { Shape } from "./base";\nexport function d(s: Shape): Shape | undefined { return s; }\n',
      'src/e.ts': 'import { unit } from "./base";\nexport const e: string = unit.kind;\n',
      'src/f.ts': 'import { a } from "./a";\nexport const f = a({ kind: "f", size: 2 });\n',
    },
    steps: [
      { args: ['--checkers', '2', '--listEmittedFiles'] },
      {
        args: ['--checkers', '2', '--listEmittedFiles'],
        edit: {
          'src/base.ts':
            'export interface Shape { kind: string; size: number; label?: string }\n' +
            'export const unit = { kind: "u", size: 1, label: "unit" };\n',
        },
      },
      {
        args: ['--checkers', '2', '--listEmittedFiles'],
        edit: { 'src/e.ts': 'import { unit } from "./base";\nexport const e: number = unit.kind;\n' },
      },
      {
        args: ['--checkers', '2', '--listEmittedFiles'],
        edit: {
          'src/e.ts': 'import { unit } from "./base";\nexport const e: string = unit.kind;\n',
          'src/base.ts':
            'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "v", size: 1 };\n',
        },
      },
    ],
  },
  'composite, node16 packages, tsBuildInfoFile and noEmitOnError': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"composite":true,"module":"nodenext","declarationMap":true,' +
        '"tsBuildInfoFile":"build/info.json","noEmitOnError":true},"include":["*.ts","*.mts"]}',
      'package.json': '{"name":"p","type":"module"}',
      'node_modules/foo/package.json': '{"name":"foo","types":"index.d.ts"}',
      'node_modules/foo/index.d.ts': 'export declare const foo: number;\n',
      'a.ts': 'import { foo } from "foo";\nexport const enum E { A = 1 }\nexport const a: number = foo;\n',
      'b.ts':
        'import { E, a } from "./a.js";\nexport const b: number = E.A + a;\ndeclare module "foo" { export const z: 1; }\n',
      'c.mts': 'import type { b } from "./b.js";\nexport type C = typeof b;\n',
      'amb.d.ts': 'declare module "amb" { export const q: number; }\n',
    },
    steps: [
      { args: ['--listEmittedFiles'] },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'a.ts': 'import { foo } from "foo";\nexport const enum E { A = 2 }\nexport const a: number = foo;\n' },
      },
      {
        args: ['--listEmittedFiles'],
        edit: {
          'c.mts':
            'import type { b } from "./b.js";\nexport type C = typeof b;\nexport const i: { x: string } = { x: 1 };\n',
        },
      },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles', '--declarationMap', 'false'],
        edit: { 'c.mts': 'export const i: { x: string } = { x: "" };\n' },
      },
      { args: ['--listEmittedFiles'] },
      { args: ['-b', '-v'] },
      { args: ['-b', '-v'], touch: ['a.ts'] },
      { args: ['-b', '-v'], touch: ['package.json'] },
      { args: ['-b', '-v', '--diagnostics'] },
    ],
  },
  'stored diagnostics whose elaborations depend on the program': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"module":"node16","strict":true,"noEmit":true,"incremental":true,"types":[]},' +
        '"files":["a.ts","c.ts","d.ts"]}',
      'package.json': '{"name":"app"}',
      'node_modules/esm/package.json': '{"name":"esm","type":"module","exports":"./index.js","types":"./index.d.ts"}',
      'node_modules/esm/index.d.ts': 'export declare const e: number;\n',
      'node_modules/esm/index.js': 'export const e = 1;\n',
      'node_modules/untyped/package.json': '{"name":"untyped","version":"1.0.0","main":"index.js"}',
      'node_modules/untyped/index.js': 'module.exports = 1;\n',
      // A CommonJS file importing an ES module, and an import of a package without types.
      'a.ts': 'import { e } from "esm";\nexport const a = e;\n',
      'c.ts': 'export const c = 1;\n',
      'd.ts': 'import * as u from "untyped";\nexport const d = u;\n',
    },
    steps: [
      { args: [] },
      { args: [] },
      { args: [], edit: { 'c.ts': 'export const c = 2;\n' } },
      { args: [], edit: { 'node_modules/@types/untyped/package.json': '{"name":"@types/untyped","version":"1.0.0"}' } },
      { args: [], edit: { 'c.ts': 'export const c = 3;\n' } },
    ],
  },
  'ambient modules augmented in module files': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true,"types":["lib"]},' +
        '"files":["a.ts","b.ts","dup1.d.ts","dup2.d.ts","dup-aug.d.ts"]}',
      // "lib" is declared in one file and augmented in a module file.
      'node_modules/@types/lib/package.json': '{"name":"@types/lib","version":"1.0.0"}',
      'node_modules/@types/lib/index.d.ts':
        '/// <reference path="base.d.ts" />\ndeclare module "lib" { export const x: number; }\n',
      'node_modules/@types/lib/base.d.ts': 'export {};\ndeclare module "lib" { export const y: number; }\n',
      // "dup" is declared in two files and augmented in a module file.
      'dup1.d.ts': 'declare module "dup" { export const d1: number; }\n',
      'dup2.d.ts': 'declare module "dup" { export const d2: number; }\n',
      'dup-aug.d.ts': 'export {};\ndeclare module "dup" { export const d3: number; }\n',
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'import { x, y } from "lib";\nexport const b = x + y;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'a.ts': 'export const a = 2;\n' } },
      {
        args: [],
        edit: { 'node_modules/@types/lib/base.d.ts': 'export {};\ndeclare module "lib" { export const y: string; }\n' },
      },
    ],
  },
  'dependencies of each kind of import': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"incremental":true,"declaration":true,"outDir":"out","module":"nodenext"},' +
        '"files":["main.ts","d1.ts","d2.ts","d3.ts","d4.ts","d5.ts","d6.ts"]}',
      'package.json': '{"name":"app","type":"module"}',
      'main.ts':
        'import { a } from "./d1.js";\nexport { b } from "./d2.js";\nimport type { C } from "./d3.js";\n' +
        'export type D = typeof import("./d4.js");\nexport const e = () => import("./d5.js");\n' +
        'import f = require("./d6.cjs");\nexport const c: C = a;\nexport const g = f;\n',
      'd1.ts': 'export const a = 1;\n',
      'd2.ts': 'export const b = 1;\n',
      'd3.ts': 'export type C = number;\n',
      'd4.ts': 'export const d = 1;\n',
      'd5.ts': 'export const e = 1;\n',
      'd6.cts': 'export = 1;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'd4.ts': 'export const d = "s";\n' } },
      { args: [], edit: { 'd6.cts': 'export = "s";\n' } },
      { args: [] },
    ],
  },
  'modules augmented in several files': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true,"esModuleInterop":true,"types":[]},' +
        '"files":["a.ts","m.ts","m-aug1.ts","m-aug2.ts"]}',
      // A package whose `export =` target is augmented in two files.
      'node_modules/@types/lib/package.json': '{"name":"@types/lib","version":"1.0.0"}',
      'node_modules/@types/lib/index.d.ts':
        '/// <reference path="./common/one.d.ts" />\n/// <reference path="./common/two.d.ts" />\n' +
        'export = _;\nexport as namespace _;\ndeclare const _: _.Static;\ndeclare namespace _ {\n  interface Static {}\n}\n',
      'node_modules/@types/lib/common/one.d.ts':
        'import _ = require("../index");\ndeclare module "../index" {\n  interface Static { one(): number; }\n}\n',
      'node_modules/@types/lib/common/two.d.ts':
        'import _ = require("../index");\ndeclare module "../index" {\n  interface Static { two(): number; }\n}\n',
      // A module of the program augmented in two files.
      'm.ts': 'export interface M { m: number; }\n',
      'm-aug1.ts': 'export {};\ndeclare module "./m" { interface M { aug1: number; } }\n',
      'm-aug2.ts': 'export {};\ndeclare module "./m" { interface M { aug2: number; } }\n',
      'a.ts':
        'import _ from "lib";\nimport type { M } from "./m";\nexport const a = (m: M) => _.one() + _.two() + m.aug1;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'm-aug2.ts': 'export {};\ndeclare module "./m" { interface M { aug2: string; } }\n' } },
      {
        args: [],
        edit: {
          'node_modules/@types/lib/common/two.d.ts':
            'import _ = require("../index");\ndeclare module "../index" {\n  interface Static { two(): string; }\n}\n',
        },
      },
    ],
  },
  'type references that are not found in files whose diagnostics are not reported': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"skipLibCheck":true,"composite":true,"types":[]},' +
        '"files":["a.ts","b.ts","env.d.ts"]}',
      // Not checked with skipLibCheck.
      'env.d.ts': '/// <reference types="missing-env" />\n',
      // Filtered by the directive.
      'b.ts': '// @ts-ignore\n/// <reference types="missing-b" />\nexport const b = 1;\n',
      'a.ts': 'export const a = 1;\n',
    },
    steps: [
      { args: [] },
      { args: ['-b', '-v'] },
      { args: ['-b', '-v'], edit: { 'a.ts': 'export const a = 2;\n' } },
      {
        args: ['-b', '-v'],
        edit: {
          'tsconfig.json':
            '{"compilerOptions":{"strict":true,"composite":true,"types":[]},"files":["a.ts","b.ts","env.d.ts"]}',
        },
      },
      { args: ['-b', '-v'] },
    ],
  },
  // Steps 2 and 3 keep the references of most files, whose lists of file ids the build info writes as it
  // read them; step 4 adds a file ahead of the others, which renumbers the files, and step 5 removes it.
  // "lib" resolves through a symbolic link, and build info lists the real path of its package.json.
  'references kept, changed and renumbered across rebuilds': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"outDir":"out","rootDir":"src","module":"nodenext"},"include":["src"]}',
      'src/a.ts': 'import { b } from "./b.js";\nimport { c } from "./c.js";\nexport const a = b + c;\n',
      'src/b.ts': 'import { c } from "./c.js";\nexport const b = c;\n',
      'src/c.ts': 'import { lib } from "lib";\nexport const c = lib;\n',
      'src/d.ts': 'import { a } from "./a.js";\nimport { b } from "./b.js";\nexport const d = a + b;\n',
      'packages/lib/package.json': '{"name":"lib","types":"./index.d.ts"}',
      'packages/lib/index.d.ts': 'export declare const lib: number;\n',
    },
    links: { 'node_modules/lib': '../packages/lib' },
    steps: [
      { args: [] },
      {
        args: [],
        edit: { 'src/d.ts': 'import { a } from "./a.js";\nimport { b } from "./b.js";\nexport const d = a * b;\n' },
      },
      { args: [], edit: { 'src/b.ts': 'export const b = 2;\n' } },
      { args: [], edit: { 'src/0.ts': 'import { d } from "./d.js";\nexport const zero = d;\n' } },
      { args: [], edit: { 'src/0.ts': null } },
    ],
  },
  // Every file references the files that declare ambient modules. Step 2 changes a signature that two files
  // depend on, step 3 adds an ambient module and step 4 removes it, which changes the references of every
  // file. Step 5 deletes e.ts: the references of d.ts stay the same, and d.ts is emitted again (listed by
  // listEmittedFiles) as a file that references a deleted file.
  'references with ambient modules across rebuilds': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"outDir":"out","rootDir":"src","listEmittedFiles":true},"include":["src"]}',
      'src/ambient.d.ts': 'declare module "m" { export const m: number; }\n',
      'src/a.ts': 'import { m } from "m";\nimport { b } from "./b";\nexport const a = m + b;\n',
      'src/b.ts': 'export const b = 1;\n',
      'src/c.ts': 'import { a } from "./a";\nexport const c = a;\n',
      'src/d.ts': '/// <reference path="./e.ts" />\nexport const d = 1;\n',
      'src/e.ts': 'export const e = 1;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'src/b.ts': 'export const b = "b";\n' } },
      { args: [], edit: { 'src/ambient2.d.ts': 'declare module "n" { export const n: number; }\n' } },
      { args: [], edit: { 'src/ambient2.d.ts': null } },
      { args: [], edit: { 'src/e.ts': null } },
      { args: [] },
    ],
  },
  'explainFiles and statistics': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"outDir":"out"},"files":["a.ts"]}',
      'a.ts': 'import "./b";\nexport const a = 1;\n',
      'b.ts': 'export {};\n',
    },
    steps: [{ args: ['--explainFiles'] }, { args: ['--diagnostics'] }, { args: ['--extendedDiagnostics', '--noEmit'] }],
  },
  'signatures of files whose declaration files are empty': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"strict":true,"incremental":true,"outDir":"out"},"files":["m.ts","g.ts"]}',
      'm.ts': 'export interface I { a: number; }\n',
      // A script whose declarations are all inside a function: its declaration file is empty.
      'g.ts': '(function () {\n  type T = import("./m").I;\n  const t: T = { a: 1 };\n  console.log(t);\n})();\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'm.ts': 'export interface I { a: number; }\n// edit\n' } },
      { args: [], edit: { 'm.ts': 'export interface I { a: number; b?: string; }\n' } },
      { args: [] },
    ],
  },
  // In native builds the rebuilds compare the references of most files with the build info on reference threads,
  // which take files from the last one back while the main thread takes them from the first.
  'incremental rebuilds that compare references on threads': {
    files: referencingModules(300),
    steps: [
      { args: ['--checkers', '4'] },
      { args: ['--checkers', '4'], edit: { 'src/m010.ts': referencingModules(300)['src/m010.ts'] + 'void 0;\n' } },
      // The importers of target.ts reference m200.ts once it augments target.ts too.
      {
        args: ['--checkers', '4'],
        edit: {
          'src/m200.ts':
            referencingModules(300)['src/m200.ts'] + 'declare module "./target" { interface Box { c?: number } }\n',
        },
      },
      // m029.ts imports m030.ts, which is deleted.
      { args: ['--checkers', '4'], edit: { 'src/m030.ts': null } },
      { args: ['--checkers', '4'] },
    ],
  },
};

/** Creates the symbolic links `links`, from paths in `dir` to their targets. */
function writeLinks(dir, links) {
  for (const [path, target] of Object.entries(links)) {
    const link = join(dir, path);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
  }
}

function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    if (text === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
}

let scratch;
let replacements = 0;

/**
 * Writes `files` into `dir` as `writeFiles` does, for a watch to see: each file with one rename from a temporary
 * directory, so that no build reads it partly written, and a new directory with its file in it. `null` removes a file
 * or a directory, also with one rename.
 */
function replaceFiles(dir, files) {
  scratch ??= tempDir('tsc-ts-watch-scratch-');
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    const temp = join(scratch, String(replacements++));
    if (text === null) {
      if (!existsSync(target)) continue;
      renameSync(target, temp);
      rmSync(temp, { recursive: true });
      continue;
    }
    let top = dirname(target);
    if (existsSync(top)) {
      writeFileSync(temp, text);
      renameSync(temp, target);
      continue;
    }
    while (!existsSync(dirname(top))) top = dirname(top);
    const file = join(temp, relative(top, target));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    renameSync(temp, top);
  }
}

function readFiles(dir) {
  const result = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (!entry.isSymbolicLink()) result[relative(dir, file)] = readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return result;
}

/**
 * Makes `files` newer than everything else in `dir` and older than anything written next, however long the
 * next build takes: shifts every file 10 s into the past, keeping their order, then dates `files` just after
 * the newest of them.
 */
function touch(dir, files) {
  let newest = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        const time = statSync(file).mtimeMs - 10_000;
        utimesSync(file, new Date(time), new Date(time));
        newest = Math.max(newest, time);
      }
    }
  };
  walk(dir);
  const later = new Date(newest + 1000);
  for (const file of files) utimesSync(join(dir, file), later, later);
}

/** Masks what differs between runs: clock times, durations, memory, and counts that depend on checker internals. */
function normalize(text, dir) {
  return (
    text
      .replaceAll(dir, '<dir>')
      .replace(/\d\d:\d\d:\d\d [AP]M/g, '<time>')
      .replace(/^((?:Aggregate )?[A-Za-z][A-Za-z ]+:) +\S+$/gm, '$1 <value>')
      // Outputs written in the same clock tick have the same time, so which one is oldest varies.
      .replace(/(is older than output )'[^']*'/g, "$1'<output>'")
  );
}

function run(command, args, cwd) {
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1' };
  const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd, env, encoding: 'utf8' });
  return { output: result.stdout + result.stderr, status: result.status };
}

for (const [name, scenario] of Object.entries(scenarios)) {
  test(name, { skip }, () => {
    const dirs = { tsgo: tempDir('tsc-ts-build-tsgo-'), ours: tempDir('tsc-ts-build-ours-') };
    for (const dir of Object.values(dirs)) {
      writeFiles(dir, scenario.files);
      if (scenario.links) writeLinks(dir, scenario.links);
    }
    const failures = [];
    for (const [index, step] of scenario.steps.entries()) {
      const results = {};
      for (const [which, dir] of Object.entries(dirs)) {
        if (step.edit) writeFiles(dir, step.edit);
        if (step.touch) touch(dir, step.touch);
        const { output, status } = run(which === 'tsgo' ? [tsgo] : tscTs, step.args, join(dir, step.cwd ?? '.'));
        const files = readFiles(dir);
        for (const [file, text] of Object.entries(files)) files[file] = normalize(text, dir);
        results[which] = { output: normalize(output, dir), status, files };
      }
      const label = `step ${index + 1} (tsc ${step.args.join(' ')})`;
      const { tsgo: expected, ours: actual } = results;
      if (expected.output !== actual.output) {
        failures.push(`${label}: output\n--- tsgo\n${expected.output}\n--- ours\n${actual.output}`);
      }
      if (expected.status !== actual.status)
        failures.push(`${label}: status tsgo ${expected.status}, ours ${actual.status}`);
      const files = new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]);
      for (const file of [...files].sort()) {
        if (expected.files[file] === actual.files[file]) continue;
        if (expected.files[file] === undefined || actual.files[file] === undefined) {
          failures.push(`${label}: ${file} written only by ${expected.files[file] === undefined ? 'tsc-ts' : 'tsgo'}`);
        } else {
          failures.push(`${label}: ${file}\n--- tsgo\n${expected.files[file]}\n--- ours\n${actual.files[file]}`);
        }
      }
      if (failures.length > 0) break;
    }
    assert.deepEqual(failures, []);
  });
}

// tsgo leaves out of build info the modules of JavaScript `require` calls that do not initialize a variable, and its
// incremental builds then keep outputs that depend on them; tsc-ts records them, so its output matches a clean build.
test('JavaScript require dependencies are rebuilt', { skip: tscTsMissing }, () => {
  const files = {
    'tsconfig.json':
      '{"compilerOptions":{"allowJs":true,"checkJs":true,"declaration":true,"incremental":true,"outDir":"out",' +
      '"module":"commonjs"},"files":["main.js","dep.js","dep2.js","dep3.js"]}',
    'main.js':
      'exports.value = require("./dep").value;\nmodule.exports.other = require("./dep2");\n' +
      '/** @type {number} */\nexports.m = require("./dep3").m;\n',
    'dep.js': 'exports.value = 1;\n',
    'dep2.js': 'exports.other = 1;\n',
    'dep3.js': 'module.exports = { m: 1 };\n',
  };
  const edit = {
    'dep.js': 'exports.value = "s";\n',
    'dep2.js': 'exports.other = "s";\n',
    'dep3.js': 'module.exports = { m: "s" };\n',
  };
  const incremental = tempDir('tsc-ts-build-require-');
  writeFiles(incremental, files);
  run(tscTs, [], incremental);
  writeFiles(incremental, edit);
  const rebuilt = run(tscTs, [], incremental);
  const clean = tempDir('tsc-ts-build-require-clean-');
  writeFiles(clean, files);
  writeFiles(clean, edit);
  const expected = run(tscTs, [], clean);
  assert.equal(normalize(rebuilt.output, incremental), normalize(expected.output, clean));
  assert.equal(rebuilt.status, expected.status);
  const outputs = (dir) =>
    Object.fromEntries(Object.entries(readFiles(join(dir, 'out'))).filter(([file]) => !file.endsWith('.tsbuildinfo')));
  assert.deepEqual(outputs(incremental), outputs(clean));
});

const watchProject = {
  'tsconfig.json': '{"compilerOptions":{"outDir":"out","rootDir":"src"},"include":["src"]}',
  'src/a.ts': 'export const a: number = 1;\n',
};

// The wait after each report of `watchSequence` before its next edit, in milliseconds.
const stampGap = 20;

/**
 * Runs `tsc-ts` with `args` in a new directory with `files` and makes the edits of `steps` (a file and its text, or
 * `null` to remove a directory, files to write in order, or a function of the directory and the `tsc-ts` process), each once the previous build
 * reported. `prepare` runs on the directory before `tsc-ts`
 * starts, which gets `extraEnv` in its environment. Returns the output and the output directory's files.
 *
 * Edits go through `replaceFiles`, and each starts `stampGap` milliseconds after the report: the watch compares
 * modification times, which the system takes from a clock that advances in ticks of a few milliseconds, so an edit in
 * the tick of the last build's stamps would have the time stamp it already saw.
 */
async function watchSequence(args, steps, files = watchProject, prepare = () => {}, extraEnv = {}) {
  const dir = tempDir('tsc-ts-watch-');
  writeFiles(dir, files);
  prepare(dir);
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1', ...extraEnv };
  const child = spawn(tscTs[0], [...tscTs.slice(1), ...args, '--preserveWatchOutput'], { cwd: dir, env });
  let output = '';
  let exit;
  child.stdout.on('data', (chunk) => (output += chunk));
  child.on('exit', (code) => (exit = code));
  const waitFor = async (count) => {
    const deadline = Date.now() + 60_000;
    while ((output.match(/Watching for file changes/g) ?? []).length < count) {
      if (exit !== undefined) throw new Error(`exited with ${exit}; output so far:\n` + output);
      if (Date.now() > deadline) throw new Error('timed out; output so far:\n' + output);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, stampGap));
  };
  try {
    await waitFor(1);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (typeof step === 'function') await step(dir, child);
      else if (!Array.isArray(step)) replaceFiles(dir, step);
      else replaceFiles(dir, { [step[0]]: step[1] });
      await waitFor(i + 2);
    }
  } finally {
    child.kill();
  }
  const out = join(dir, files === watchProject ? 'out' : 'proj/out');
  return { output: normalize(output, dir), files: existsSync(out) ? Object.keys(readFiles(out)).sort() : [] };
}

// Edits, a new file, a new directory and an edit in it, and the directory removed and created again. tsgo's file
// watching doesn't report changes in every environment, so the output is checked against what tsgo prints for the
// same sequence.
const watchSteps = [
  ['src/a.ts', 'export const a: string = 1;\n'],
  ['src/b.ts', 'export const b = 2;\n'],
  ['src/sub/c.ts', 'export const c = 3;\n'],
  ['src/sub/c.ts', 'export const c: string = 3;\n'],
  ['src/sub', null],
  ['src/sub/c.ts', 'export const c = 4;\n'],
  ['src/sub/c.ts', 'export const c: boolean = 4;\n'],
];
const watchOutput = (() => {
  const a = "src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n";
  const c = (type) => `src/sub/c.ts(1,14): error TS2322: Type 'number' is not assignable to type '${type}'.\n`;
  const rebuild = (errors) =>
    '<time> - File change detected. Starting incremental compilation...\n\n' +
    errors.join('') +
    (errors.length === 1
      ? '<time> - Found 1 error. Watching for file changes.\n\n'
      : `<time> - Found ${errors.length} errors. Watching for file changes.\n\n`);
  return (
    '<time> - Starting compilation in watch mode...\n\n' +
    '<time> - Found 0 errors. Watching for file changes.\n\n' +
    rebuild([a]) +
    rebuild([a]) +
    rebuild([a]) +
    rebuild([a, c('string')]) +
    rebuild([a]) +
    rebuild([a]) +
    rebuild([a, c('boolean')])
  );
})();

test('--watch rebuilds on changes', { skip: tscTsMissing, timeout: 120_000 }, async () => {
  const { output, files } = await watchSequence(['--watch'], watchSteps);
  assert.equal(output, watchOutput);
  assert.deepEqual(files, ['a.js', 'b.js', 'sub/c.js']);
});

// A rebuild takes the last program with the edited file swapped in while the edit keeps its imports, and loads the
// program again when an edit imports a file outside it or drops that import (the same output as tsgo).
test(
  '--watch loads the program again when an edit changes the imports',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    const files = {
      'tsconfig.json': '{"compilerOptions":{"outDir":"out","rootDir":"."},"include":["src"]}',
      'src/a.ts': 'export const a: number = 1;\n',
      'lib/x.ts': 'export const x: string = 1;\n',
    };
    // In place, as an editor saves: a write that replaces the file changes its directory, which loads the program.
    const edit = (text) => (dir) => writeFileSync(join(dir, 'src/a.ts'), text);
    const steps = [
      edit("import { x } from '../lib/x';\nexport const a = x;\n"),
      edit("import { x } from '../lib/x';\nexport const a: number = x;\n"),
      edit('export const a: number = 2;\n'),
    ];
    const { output } = await watchSequence(['--watch'], steps, files);
    const x = "lib/x.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n";
    const a = "src/a.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    const detected = '<time> - File change detected. Starting incremental compilation...\n\n';
    assert.equal(
      output,
      '<time> - Starting compilation in watch mode...\n\n' +
        '<time> - Found 0 errors. Watching for file changes.\n\n' +
        detected +
        x +
        '<time> - Found 1 error. Watching for file changes.\n\n' +
        detected +
        x +
        a +
        '<time> - Found 2 errors. Watching for file changes.\n\n' +
        detected +
        '<time> - Found 0 errors. Watching for file changes.\n\n',
    );
  },
);

// An edit that moves a file's reference without changing it updates the program, and a diagnostic of the reference is
// reported where the reference now is.
test(
  '--watch reports a moved reference where it is after an in-place edit',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    const files = {
      'tsconfig.json': '{"compilerOptions":{"noEmit":true},"include":["src"]}',
      'src/a.ts': '/// <reference path="./missing.d.ts" />\nexport const a = 1;\n',
    };
    const steps = [
      (dir) =>
        writeFileSync(
          join(dir, 'src/a.ts'),
          '// moved\n/// <reference path="./missing.d.ts" />\nexport const a = 1;\n',
        ),
    ];
    const { output } = await watchSequence(['--watch'], steps, files);
    assert.equal(
      output,
      '<time> - Starting compilation in watch mode...\n\n' +
        "src/a.ts(1,22): error TS6053: File './missing.d.ts' not found.\n" +
        '<time> - Found 1 error. Watching for file changes.\n\n' +
        '<time> - File change detected. Starting incremental compilation...\n\n' +
        "src/a.ts(2,22): error TS6053: File './missing.d.ts' not found.\n" +
        '<time> - Found 1 error. Watching for file changes.\n\n',
    );
  },
);

test('--build --watch rebuilds on changes', { skip: tscTsMissing, timeout: 120_000 }, async () => {
  const { output, files } = await watchSequence(['--build', '--watch'], watchSteps);
  assert.equal(output, watchOutput);
  assert.deepEqual(files, ['a.js', 'b.js', 'sub/c.js']);
});

// Natively, a watch process whose memory passes TSC_TS_WATCH_MEMORY stops before a rebuild, and a new one builds
// instead (tsc-watch.ts); 1 MB restarts it on every change. The output is the same as without restarts.
for (const args of [['--watch'], ['--build', '--watch']]) {
  test(
    `${args.join(' ')} reports the same when the watch process restarts`,
    { skip: tscTsMissing, timeout: 120_000 },
    async () => {
      const { output, files } = await watchSequence(args, watchSteps, watchProject, () => {}, {
        TSC_TS_WATCH_MEMORY: '1',
      });
      assert.equal(output, watchOutput);
      assert.deepEqual(files, ['a.js', 'b.js', 'sub/c.js']);
    },
  );
}

// Natively, the first build and a rebuild whose change may affect enough files check on checker threads
// (tsc-watch.ts), and a check that comes during a rebuild on threads runs once it is reported. The first three edits
// change the type of a value that every other file imports, so every file is checked again; the second step writes
// the file again once the rebuild started, so its event comes during the rebuild. The last edit keeps the declaration
// file. With declarations, a changed file's signature is computed before the rebuild shares its program. The output
// is that of a watch on one thread.
for (const declaration of [false, true]) {
  test(
    `--watch rebuilds on checker threads${declaration ? ' with declarations' : ''}`,
    { skip: tscTsMissing, timeout: 120_000 },
    async () => {
      const files = {
        'proj/tsconfig.json': JSON.stringify({
          compilerOptions: { outDir: 'out', rootDir: 'src', strict: true, declaration },
          include: ['src'],
        }),
        'proj/src/shared.ts': 'export const shared: number = 1;\n',
      };
      for (let i = 0; i < 200; i++) {
        files[`proj/src/m${i}.ts`] =
          "import { shared } from './shared';\n" +
          `type Digit${i} = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';\n` +
          `type Code${i} = \`\${Digit${i}}\${Digit${i}}\${Digit${i}}-${i}\`;\n` +
          `export const code${i}: Code${i} = '123-${i}';\n` +
          `export const value${i}: number = shared;\n`;
      }
      const started = (child) =>
        new Promise((resolve) => {
          const listener = (chunk) => {
            if (!String(chunk).includes('File change detected')) return;
            child.stdout.off('data', listener);
            resolve();
          };
          child.stdout.on('data', listener);
        });
      const steps = [
        ['proj/src/shared.ts', 'export const shared: string = "s";\n'],
        async (dir, child) => {
          const rebuilding = started(child);
          replaceFiles(dir, { 'proj/src/shared.ts': 'export const shared: number = 1;\n' });
          await rebuilding;
          replaceFiles(dir, { 'proj/src/shared.ts': 'export const shared: number = 1;\n' });
        },
        ['proj/src/shared.ts', 'export const shared: boolean = true;\n'],
        // The same declaration file: with declarations, its signature is that of the last build.
        ['proj/src/shared.ts', 'export const shared: boolean = !false;\n'],
      ];
      const run = (args) =>
        watchSequence(['-p', 'proj', '--watch', ...args], steps, files, () => {}, { TSC_TS_WATCH_MEMORY: '0' });
      const expected = await run(['--singleThreaded']);
      const threaded = await run(['--checkers', '2']);
      assert.equal((expected.output.match(/File change detected/g) ?? []).length, 4);
      assert.equal((expected.output.match(/Found 200 errors/g) ?? []).length, 3);
      assert.equal(threaded.output, expected.output);
      assert.equal(threaded.files.length, declaration ? 402 : 201);
      assert.deepEqual(threaded.files, expected.files);
    },
  );
}

// A rebuild that computes a changed file's signature before it decides on checker threads reports no error for files
// outside the default `rootDir` (the config file's directory), as a watch on one thread. The second and third edits
// keep the declaration file, so their signatures are computed before the rebuild.
test(
  '--watch computes rebuild signatures without reporting files outside rootDir',
  { skip: tscTsMissing },
  async () => {
    const files = {
      'proj/tsconfig.json': '{"compilerOptions":{"noEmit":true,"declaration":true,"strict":true},"include":["src"]}',
      'proj/src/main.ts': "import { shared } from '../../shared/shared';\nexport const value: number = shared;\n",
      'proj/src/other.ts': "import { value } from './main';\nexport const other: number = value;\n",
      'shared/shared.ts': 'export const shared: number = 1;\n',
    };
    const steps = [1, 2, 3].map((i) => ['proj/src/main.ts', `${files['proj/src/main.ts']}void ${i};\n`]);
    const run = (args) =>
      watchSequence(['-p', 'proj', '--watch', ...args], steps, files, () => {}, { TSC_TS_WATCH_MEMORY: '0' });
    const expected = await run(['--singleThreaded']);
    const threaded = await run(['--checkers', '2']);
    assert.equal((expected.output.match(/Found 0 errors/g) ?? []).length, 4);
    assert.equal(threaded.output, expected.output);
  },
);

// A watch that starts on one thread because its config sets `checkers` to 1, then an edit of the config sets it to 2
// with a change that affects every file: the rebuild takes the unchanged files of the first build, whose symbols got
// no ids at creation, so it checks them on this thread rather than sharing them with checker threads. The output is
// that of a watch on one thread.
// A rebuild that swaps an edited file into a program shared with checker threads takes its immutable files and
// include reasons; the file-processing error of an unchanged file is reported again from them.
test(
  "--watch reports an unchanged file's errors after a body edit on checker threads",
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    const files = {
      'proj/tsconfig.json': JSON.stringify({
        compilerOptions: { outDir: 'out', rootDir: 'src', strict: true },
        include: ['src'],
      }),
      'proj/src/shared.ts': 'export const shared: number = 1;\n',
    };
    for (let i = 0; i < 200; i++)
      files[`proj/src/m${i}.ts`] =
        (i === 0 ? '/// <reference path="./missing.d.ts" />\n' : '') +
        "import { shared } from './shared';\n" +
        `export const value${i}: number = shared;\n`;
    // In place: a replaced file changes its directory, and that loads the program.
    const steps = [
      (dir) =>
        writeFileSync(
          join(dir, 'proj/src/m1.ts'),
          "import { shared } from './shared';\nexport const value1: number = shared;\nvoid 0;\n",
        ),
    ];
    const run = (args) =>
      watchSequence(['-p', 'proj', '--watch', ...args], steps, files, () => {}, { TSC_TS_WATCH_MEMORY: '0' });
    const expected = await run(['--singleThreaded']);
    const threaded = await run(['--checkers', '2']);
    assert.equal((expected.output.match(/error TS6053: File '\.\/missing\.d\.ts' not found\./g) ?? []).length, 2);
    assert.equal(threaded.output, expected.output);
  },
);

// A rebuild that swaps an edited file into a program shared with checker threads reports the processing diagnostics
// the program was created with: the common source directory that the rebuild's declaration signatures need adds
// rootDir diagnostics that neither the first build nor tsgo reports.
test(
  '--watch keeps the diagnostics a program was created with after a body edit on checker threads',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    const files = {
      'proj/tsconfig.json': JSON.stringify({
        compilerOptions: { noEmit: true, strict: true },
        include: ['src', '../extra/x.ts'],
      }),
      'extra/x.ts': 'export const x = 1;\n',
      'proj/src/shared.ts': "export { x } from '../../extra/x';\n",
    };
    for (let i = 0; i < 200; i++)
      files[`proj/src/m${i}.ts`] = "import { x } from './shared';\n" + `export const value${i}: number = x;\n`;
    // In place: a replaced file changes its directory, and that loads the program.
    const steps = [
      (dir) =>
        writeFileSync(
          join(dir, 'proj/src/m1.ts'),
          "import { x } from './shared';\nexport const value1: number = x;\nvoid 0;\n",
        ),
    ];
    const run = (args) =>
      watchSequence(['-p', 'proj', '--watch', ...args], steps, files, () => {}, { TSC_TS_WATCH_MEMORY: '0' });
    const expected = await run(['--singleThreaded']);
    const threaded = await run(['--checkers', '2']);
    assert.equal((expected.output.match(/Found 0 errors/g) ?? []).length, 2);
    assert.equal(threaded.output, expected.output);
  },
);

// Rebuilds in a row that check on checker threads: each edit writes the file in place, so no directory changes and
// the rebuild takes the program of the last build with the file swapped in (`Program.updateFile`), and with it the
// resolver that the last build shared with checker threads, which is immutable once shared. Each edit changes the
// type of a value that every other file imports. The output is that of a watch on one thread.
for (const incremental of [false, true]) {
  test(
    `--watch shares a program with checker threads in consecutive rebuilds${incremental ? ' with --incremental' : ''}`,
    { skip: tscTsMissing, timeout: 120_000 },
    async () => {
      const files = {
        'proj/tsconfig.json': JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, incremental },
          include: ['src'],
        }),
        'proj/src/shared.ts': 'export const shared: number = 1;\n',
      };
      for (let i = 0; i < 150; i++)
        files[`proj/src/m${i}.ts`] =
          "import { shared } from './shared';\n" + `export const value${i}: number = shared;\n`;
      const steps = ['string = "s"', 'boolean = true', 'number = 1'].map(
        (value) => (dir) => writeFileSync(join(dir, 'proj/src/shared.ts'), `export const shared: ${value};\n`),
      );
      const run = (args) =>
        watchSequence(['-p', 'proj', '--watch', ...args], steps, files, () => {}, { TSC_TS_WATCH_MEMORY: '0' });
      const expected = await run(['--singleThreaded']);
      const threaded = await run(['--checkers', '2']);
      assert.equal((expected.output.match(/Found 150 errors/g) ?? []).length, 2);
      assert.equal((expected.output.match(/Found 0 errors/g) ?? []).length, 2);
      assert.equal(threaded.output, expected.output);
    },
  );
}

test('--watch after a config edit turns checker threads on', { skip: tscTsMissing, timeout: 120_000 }, async () => {
  const config = (checkers) =>
    `{"compilerOptions":{"outDir":"out","rootDir":"src","strict":true,"checkers":${checkers}},"include":["src"]}`;
  const files = {
    'proj/tsconfig.json': config(1),
    'proj/src/shared.ts': 'export const shared: number = 1;\n',
  };
  for (let i = 0; i < 20; i++)
    files[`proj/src/m${i}.ts`] = "import { shared } from './shared';\n" + `export const value${i}: number = shared;\n`;
  const steps = [
    { 'proj/tsconfig.json': config(2), 'proj/src/shared.ts': 'export const shared: string = "s";\n' },
    ['proj/src/shared.ts', 'export const shared: boolean = true;\n'],
  ];
  const run = (args) =>
    watchSequence(['-p', 'proj', '--watch', ...args], steps, files, () => {}, { TSC_TS_WATCH_MEMORY: '0' });
  const expected = await run(['--singleThreaded']);
  const threaded = await run([]);
  assert.equal((expected.output.match(/Found 20 errors/g) ?? []).length, 2);
  assert.equal(threaded.output, expected.output);
  assert.deepEqual(threaded.files, expected.files);
});

// A new process reads the config again: after a failed read of a changed config, the process builds on with the
// config it has, as it does without restarts.
test(
  '--watch builds on after a failed config read when the watch process would restart',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    const steps = [
      ['tsconfig.json', null],
      ['src/a.ts', 'export const a: string = 1;\n'],
    ];
    const expected = await watchSequence(['--watch'], steps, watchProject, () => {}, { TSC_TS_WATCH_MEMORY: '0' });
    const restarting = await watchSequence(['--watch'], steps, watchProject, () => {}, { TSC_TS_WATCH_MEMORY: '1' });
    assert.match(expected.output, /error TS2322/);
    assert.equal(restarting.output, expected.output);
  },
);

// A config edit restarts the process too once the config reads again: a run of config edits otherwise grows past the
// limit. Natively on Linux, the supervising process's child is a new process after the edit.
test(
  '--watch restarts after a config edit when the watch process is above its limit',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    const children = (child) => {
      try {
        return readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim();
      } catch {
        return '';
      }
    };
    const run = async (memory) => {
      const workers = [];
      const steps = [
        (dir, child) => {
          workers.push(children(child));
          replaceFiles(dir, {
            'tsconfig.json': '{"compilerOptions":{"outDir":"out","rootDir":"src","strict":true},"include":["src"]}',
          });
        },
        (dir, child) => {
          workers.push(children(child));
          replaceFiles(dir, { 'src/a.ts': 'export const a: string = 1;\n' });
        },
      ];
      const result = await watchSequence(['--watch'], steps, watchProject, () => {}, { TSC_TS_WATCH_MEMORY: memory });
      return { ...result, workers };
    };
    const expected = await run('0');
    const restarting = await run('1');
    assert.match(expected.output, /error TS2322/);
    assert.equal(restarting.output, expected.output);
    assert.deepEqual(restarting.files, expected.files);
    if (tscTs[0] !== process.execPath && existsSync('/proc/self/task')) {
      assert.notEqual(restarting.workers[0], '');
      assert.notEqual(restarting.workers[1], restarting.workers[0]);
    }
  },
);

test(
  '--watch rebuilds when the target of a linked input changes',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    // src/link.ts links to shared/b.ts, in a directory with no other input.
    const { output } = await watchSequence(
      ['--watch'],
      [['shared/b.ts', 'export const b: string = 1;\n']],
      { ...watchProject, 'shared/b.ts': 'export const b: number = 1;\n' },
      (dir) => symlinkSync('../shared/b.ts', join(dir, 'src/link.ts')),
    );
    assert.equal(
      output,
      '<time> - Starting compilation in watch mode...\n\n' +
        '<time> - Found 0 errors. Watching for file changes.\n\n' +
        '<time> - File change detected. Starting incremental compilation...\n\n' +
        "src/link.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n" +
        '<time> - Found 1 error. Watching for file changes.\n\n',
    );
  },
);

test(
  '--watch follows a linked input pointed at another file with the same time stamp',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    // src/link.ts links to one/b.ts, then to two/c.ts, which has the same time stamp; then two/c.ts changes.
    const time = new Date(2020, 0, 1);
    const { output } = await watchSequence(
      ['--watch'],
      [
        (dir) => {
          // Replaced by a rename, so that no build sees the link missing.
          symlinkSync('../two/c.ts', join(dir, 'link.tmp'));
          renameSync(join(dir, 'link.tmp'), join(dir, 'src/link.ts'));
        },
        async (dir) => {
          // After the check that follows the new watches, so only an event of two/ can report the edit.
          await new Promise((resolve) => setTimeout(resolve, 500));
          replaceFiles(dir, { 'two/c.ts': 'export const b: string = 2;\n' });
        },
      ],
      { ...watchProject, 'one/b.ts': 'export const b: number = 1;\n', 'two/c.ts': 'export const b: number = 2;\n' },
      (dir) => {
        utimesSync(join(dir, 'one/b.ts'), time, time);
        utimesSync(join(dir, 'two/c.ts'), time, time);
        symlinkSync('../one/b.ts', join(dir, 'src/link.ts'));
      },
    );
    assert.equal(
      output,
      '<time> - Starting compilation in watch mode...\n\n' +
        '<time> - Found 0 errors. Watching for file changes.\n\n' +
        '<time> - File change detected. Starting incremental compilation...\n\n' +
        '<time> - Found 0 errors. Watching for file changes.\n\n' +
        '<time> - File change detected. Starting incremental compilation...\n\n' +
        "src/link.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n" +
        '<time> - Found 1 error. Watching for file changes.\n\n',
    );
  },
);

test(
  '--build --watch rebuilds when a removed project directory is created again',
  { skip: tscTsMissing, timeout: 120_000 },
  async () => {
    const project = Object.fromEntries(Object.entries(watchProject).map(([path, text]) => ['proj/' + path, text]));
    const { output, files } = await watchSequence(
      ['--build', 'proj', '--watch'],
      [
        ['proj', null],
        // The config last, so that no build sees it without the source file.
        { 'proj/src/a.ts': 'export const a: string = 1;\n', 'proj/tsconfig.json': project['proj/tsconfig.json'] },
      ],
      project,
    );
    assert.equal(
      output,
      '<time> - Starting compilation in watch mode...\n\n' +
        '<time> - Found 0 errors. Watching for file changes.\n\n' +
        '<time> - File change detected. Starting incremental compilation...\n\n' +
        "error TS6053: File '<dir>/proj/tsconfig.json' not found.\n" +
        '<time> - Found 1 error. Watching for file changes.\n\n' +
        '<time> - File change detected. Starting incremental compilation...\n\n' +
        "proj/src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n" +
        '<time> - Found 1 error. Watching for file changes.\n\n',
    );
    assert.deepEqual(files, ['a.js']);
  },
);
