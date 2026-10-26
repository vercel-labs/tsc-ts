// Compiles small projects reduced from real-world code through tsgo (packages/tsgo/dist/tsgo) and
// tsc-ts (the Node build, or TSC_TS_BIN), and compares stdout, stderr, exit status and the files
// written in the project's directory.
// Set PROJECTS_FILTER to a substring of project names to run only those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

const base = { target: 'ES2022', strict: true, noEmit: true, types: [] };

const nestedKeyOf =
  'export type NestedKeyOf<T, K = keyof T> = K extends keyof T & (string | number)\n' +
  '  ? `${K}` | (T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : never)\n' +
  '  : never;\n';

/** Projects as `[name, files, args]`; files without a tsconfig.json get one with `base` options. */
const projects = [
  [
    'BigInt literals as names and values below ES2020',
    {
      'a.ts': 'export enum E {\n  0n = 0,\n}\nexport const o = { 1n: 1 };\nexport const v = 2n;\nexport type T = 3n;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, target: 'ES2015' }, files: ['a.ts'] }),
    },
  ],
  [
    'callbacks of generic JSX elements whose props type is conditional',
    {
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '1.0.0', types: 'index.d.ts' }),
      'node_modules/react/index.d.ts': 'export {};\n',
      'node_modules/react/jsx-runtime.d.ts':
        'export declare function jsx(...args: any[]): any;\nexport declare const Fragment: any;\n',
      'a.tsx':
        'type Id = string | number;\ninterface GetItemValue<T> { getItemValue: (item: T) => Id }\n' +
        'type Props<T> = (T extends object ? GetItemValue<T> : Partial<GetItemValue<T>>) & { value: T[] };\n' +
        'declare function Sortable<T>(props: Props<T>): any;\n' +
        'export const a = <Sortable value={["x"]} getItemValue={(item) => item} />;\n' +
        'export const b = <Sortable value={[{ id: 1 }]} getItemValue={(item) => item.id} />;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler' },
        files: ['a.tsx'],
      }),
    },
  ],
  [
    'JSON default import',
    {
      'a.ts':
        'import data from "./data.json";\nimport * as ns from "./data.json";\n' +
        'export const n: number = data;\nexport const m: number = ns.labels.paste;\n',
      'data.json': '{ "labels": { "paste": "Paste", "count": 1 }, "list": [1, 2] }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', moduleResolution: 'bundler', resolveJsonModule: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'contextually typed attributes of generic JSX elements',
    {
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '1.0.0', types: 'index.d.ts' }),
      'node_modules/react/index.d.ts': 'export {};\n',
      'node_modules/react/jsx-runtime.d.ts':
        'export declare function jsx(...args: any[]): any;\nexport declare const Fragment: any;\n',
      'a.tsx':
        'type Props = { onKey?: (e: { key: string }) => void; value: string; children?: (n: number) => string };\n' +
        'interface Polymorphic {\n' +
        '  <As extends string | void = void>(props: { as?: As } & ([As] extends [string] ? unknown : Props)): any;\n' +
        '}\n' +
        'declare const P: Polymorphic;\n' +
        'export const a = <P value="" onKey={(event) => { event.key; }} />;\n' +
        'export const b = <P value="">{(n) => n.toFixed()}</P>;\n' +
        'export const c = <P as="span" onKey={(event) => {}} />;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler' },
        files: ['a.tsx'],
      }),
    },
  ],
  [
    'static properties named like Function properties without standard class fields',
    {
      'a.ts':
        'const names = { name: "name", length: "length" } as const;\n' +
        'export class C {\n  static [names.name]: number;\n  static [names.length]() {}\n  static caller = 1;\n  static ["arguments"] = 2;\n}\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, target: 'ES2015' },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'compound assignments to elements under noUncheckedIndexedAccess',
    {
      'a.ts':
        'declare const a: number[];\ndeclare const r: Record<string, number>;\n' +
        'a[0] |= 1;\na[0] += 1;\na[0]++;\n--a[0];\na[0] = 1;\nr["x"] ??= 2;\nr.y += 1;\nexport const b = a[0] + 1;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, noUncheckedIndexedAccess: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'unused parameters in code the checker skips',
    {
      'a.ts':
        'declare const d: any;\nexport class C {\n  m(@d((t: number) => 0) p: number) {}\n  @d((u: number) => 0) n() {}\n}\n',
      'b.ts': 'return [1].map((role: number) => 1);\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, noUnusedLocals: true, noUnusedParameters: true },
        files: ['a.ts', 'b.ts'],
      }),
    },
  ],
  [
    'nested keys of a JSON module',
    {
      'a.ts':
        'import data from "./en.json";\n' +
        nestedKeyOf +
        'export type Keys = NestedKeyOf<typeof data>;\n' +
        'export const t = (path: Keys) => path;\nt("labels.paste");\nt("labels.missing");\n',
      'en.json': '{ "labels": { "paste": "Paste", "copy": "Copy" }, "empty": {}, "title": "Title" }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', moduleResolution: 'bundler', resolveJsonModule: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'ambient const enums under isolatedModules',
    {
      'a.ts': 'declare const enum E { X = 1 }\nexport const y = E.X;\nexport type T = typeof E;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', isolatedModules: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'const enums and import aliases under verbatimModuleSyntax',
    {
      'a.ts':
        'export function f() {\n  return E.A;\n  const enum E { A }\n}\n' +
        'declare global { const enum G { A } }\nexport const g = G.A;\n' +
        'namespace x { export interface c {} }\nexport import a = x.c;\n' +
        'import Foo = SomeMissingName;\nexport { Foo };\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', verbatimModuleSyntax: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'narrowing of element accesses with union keys',
    {
      'a.ts':
        'class A { clear() {} }\n' +
        'class B { other() {} }\n' +
        'declare const r: { a: A; b: B; c?: string; d: string | number };\n' +
        'declare const k: "a" | "b";\n' +
        'declare let lk: "a" | "b" | "d";\n' +
        'if ("clear" in r[k]) { const t: number = r[k]; }\n' +
        'if (r["c"]) { const t: number = r["c"]; }\n' +
        'if (typeof r["d"] === "string") { const t: number = r["d"]; }\n' +
        'if (typeof r[lk] === "string") { const t: number = r[lk]; }\n' +
        'const key = Math.random() ? "c" : "d";\n' +
        'if (typeof r[key] === "string") { const t: number = r[key]; }\n' +
        'declare const tup: [string | undefined, number];\n' +
        'if (tup[0]) { const t: number = tup[0]; }\n' +
        'const m: { [k: string]: number | undefined } = {};\n' +
        'if (m["x"]) { const t: string = m["x"]; }\n' +
        'function g(o: { x: string | null; y: number | null }, kk: "x" | "y") {\n' +
        '  if (o[kk] !== null) { const t: boolean = o[kk]; }\n' +
        '  o[kk] = null;\n' +
        '  const u: boolean = o[kk];\n' +
        '  o.x = "s";\n' +
        '  const w: boolean = o[kk];\n' +
        '}\n' +
        'class Store { a = new A(); b = new B(); run(key: "a" | "b") { if ("clear" in this[key]) this[key].clear(); } }\n' +
        'let obj = { p: 1 as number | string };\n' +
        'obj["p"] = "s";\n' +
        'const v: boolean = obj["p"];\n' +
        'obj["p"] += 1;\n',
    },
  ],
  [
    'ESM syntax in CommonJS files under verbatimModuleSyntax',
    {
      'main.ts':
        'import { a } from "./dep";\nexport { a as b };\nexport default a;\nimport type { T } from "./dep";\nexport type { T };\n',
      'dep.ts':
        'export const a = 1;\nexport type T = number;\nexport namespace N {\n  export const n = 1;\n}\nexport namespace Types {\n  export type U = 1;\n}\n',
      'package.json': '{ "type": "commonjs" }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'node16', verbatimModuleSyntax: true },
        files: ['main.ts', 'dep.ts'],
      }),
    },
  ],
  [
    'ESM syntax under verbatimModuleSyntax with module commonjs',
    {
      'main.ts':
        'import { a } from "./dep";\nexport { a as b };\nexport default a;\nimport type { T } from "./dep";\nexport type { T };\n',
      'dep.ts':
        'export const a = 1;\nexport type T = number;\nexport namespace N {\n  export const n = 1;\n}\nexport namespace Types {\n  export type U = 1;\n}\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'commonjs', verbatimModuleSyntax: true },
        files: ['main.ts', 'dep.ts'],
      }),
    },
  ],
  [
    'ESM syntax in .cts files under verbatimModuleSyntax',
    {
      'main.cts': 'import { a } from "./dep.cjs";\nexport { a as b };\nexport default a;\n',
      'dep.cts': 'export const a = 1;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'nodenext', verbatimModuleSyntax: true },
        files: ['main.cts', 'dep.cts'],
      }),
    },
  ],
  [
    'ESM syntax in .cts files under module preserve',
    {
      'main.cts': 'import { a } from "./dep.cjs";\nexport { a as b };\n',
      'dep.cts': 'export const a = 1;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'preserve', isolatedModules: true },
        files: ['main.cts', 'dep.cts'],
      }),
    },
  ],
  [
    'property initializers that reference constructor locals without standard class fields',
    {
      'a.ts':
        'export class C {\n  a = x;\n  b: typeof x = 0;\n  constructor(x: number) {}\n}\n' +
        'export class D {\n  y = aaa;\n  z = w;\n  w = 1;\n  constructor() {\n    var aaa = 1;\n    var w = 2;\n  }\n}\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, target: 'ES2015' },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'variables of a loop referenced while their declarations are resolved',
    {
      'a.ts':
        'declare const api: any;\nexport function f() {\n  let cursor: string | null = "";\n  while (cursor !== null) {\n    const response = api.req({ cursor });\n    cursor = response.next;\n  }\n}\nexport function g(api: { req(x: unknown): any }) {\n  let cursor: string | null = "";\n  while (cursor !== null) {\n    const [response] = api.req({ cursor });\n    cursor = response.next;\n  }\n}\n',
    },
  ],
  [
    'object literal returned by a contextually generic arrow',
    {
      'a.ts':
        'declare function walker<N>(visit: <U>(f: (data: N) => U) => { get: () => U[] }): N;\n' +
        'export const make = <N>(m: <U>(f: (data: N) => U) => U[]): N =>\n' +
        '  walker((f) => ({ get: () => m((data) => f(data)) }));\n' +
        'export const wrong = <N>(m: <U>(f: (data: N) => U) => U[]): N =>\n' +
        '  walker((f) => ({ get: () => m((data) => String(f(data))) }));\n',
    },
  ],
  [
    'enum members and namespaces under isolatedModules',
    {
      'a.ts':
        'import { S, N, O } from "./other";\nconst s = "x";\nconst n = 3;\nexport enum E1 { A = `${S}a`, B = S + "b", C = "c" + S, D = (S), E = s, F = `${s}`, G = O.B, H = O["B"] }\nexport enum E2 { A = -N, B, C = n, D, E = O.A, F, G = O["A"], H }\nexport enum E3 { A = "a", B = E3.A, C = E3["A"] + "", D = s as string, E = 1 + 2, F }\nexport const enum E4 { A = S, B = N, C }\ndeclare enum E5 { A = S, B }\nexport enum E6 { A = N * 2, B, C = ~N, D }\n',
      'other.ts': 'export const S = "s";\nexport const N = 2;\nexport enum O { A = 1, B = "b" }\n',
      'script.ts':
        'namespace Global { export const x = 1; }\nnamespace TypesOnly { export type T = 1; }\ndeclare namespace Ambient { const y: number; }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', isolatedModules: true },
        files: ['a.ts', 'other.ts', 'script.ts'],
      }),
    },
  ],
  [
    'erasable syntax',
    {
      'a.ts':
        'export const n = <number>(1 as unknown);\nexport const t = <const>["a"];\n' +
        'export const [d = <any>undefined] = [1];\n' +
        'declare class C { constructor(public x: number); }\nexport enum E { A }\n' +
        'namespace M { export const y = 1; }\nnamespace N { export = M; }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', erasableSyntaxOnly: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'iterable walker built from a generic iterator factory',
    {
      'a.ts':
        'export class Walker<T, N> {\n' +
        '  constructor(readonly visit: <U>(f: (index: T, data: N) => U) => Iterable<U>) {}\n' +
        '}\n' +
        'export const walk = <N>(\n' +
        '  make: <U>(f: (index: number, data: N) => U) => Iterator<U>,\n' +
        '): Walker<number, N> =>\n' +
        '  new Walker((f) => ({ [Symbol.iterator]: () => make((index, data) => f(index, data)) }));\n' +
        'export const nodes = <N>(data: N[]): Walker<number, N> =>\n' +
        '  walk<N>((f) => {\n' +
        '    let i = 0;\n' +
        '    return {\n' +
        '      next() {\n' +
        '        if (i < data.length) return { done: false, value: f(i, data[i++]!) };\n' +
        '        return { done: true, value: undefined } as const;\n' +
        '      },\n' +
        '    };\n' +
        '  });\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, lib: ['ES2022'], exactOptionalPropertyTypes: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'JSDoc type tags of class methods',
    {
      'a.js':
        'class Base {\n  /** @param {number} n */\n  size(n) { return n; }\n}\n' +
        '/** @typedef {(a: number, b: string) => number} Two */\nexport class K extends Base {\n' +
        '  /** @type {Base["missing"]} */\n  m1(module, type) { return 42; }\n' +
        '  /** @type {Base["size"]} */\n  size(n) { return n; }\n' +
        '  /** @type {Two} */\n  m2(a) { return a; }\n' +
        '  /** @type {(a: number) => number} */\n  m3(a, b) { return a; }\n' +
        '  /** @type {string} */\n  m4() { return 1; }\n}\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, allowJs: true, checkJs: true }, files: ['a.js'] }),
    },
  ],
  [
    'types of decorated signatures under isolatedModules and emitDecoratorMetadata',
    {
      'a.ts':
        'import { Point, Polygon, Id, Model, Shapes } from "./types";\nimport type { Point as TypePoint } from "./types";\nimport * as all from "./types";\ndeclare function dec(...args: any[]): any;\n@dec\nexport class Entity {\n  constructor(p: Point, m: Model) {}\n  @dec point: Point = { x: 1 };\n  @dec polygon: Polygon | null = null;\n  @dec typed: TypePoint = { x: 1 };\n  @dec ns: all.Point = { x: 1 };\n  @dec circle: Shapes.Circle = { r: 1 };\n  @dec id: Id = "";\n  @dec both: Point & Polygon = { x: 1, p: [] };\n  @dec method(a: Point, ...rest: Polygon[]): Point { return a; }\n  @dec get acc(): Point { return { x: 1 }; }\n  set acc(v: Point) {}\n  other(@dec q: Polygon): Id { return ""; }\n}\n',
      'types.ts':
        'export interface Point { x: number }\nexport interface Polygon { p: Point[] }\nexport type Id = string;\nexport class Model { id = 1 }\nexport namespace Shapes { export interface Circle { r: number } }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          module: 'ESNext',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          isolatedModules: true,
        },
        files: ['a.ts', 'types.ts'],
      }),
    },
  ],
  [
    'UMD globals referenced from modules',
    {
      'umd.d.ts':
        'export = Lib;\nexport as namespace Lib;\ndeclare namespace Lib {\n  function hello(): string;\n  interface T { a: 1 }\n}\n',
      'react.d.ts':
        'export = React;\nexport as namespace React;\ndeclare namespace React {\n  function createElement(...a: any[]): any;\n  const Fragment: any;\n}\n' +
        'declare global { namespace JSX { interface IntrinsicElements { [k: string]: any } } }\n',
      'a.tsx':
        'export const x = Lib.hello();\nexport type T1 = Lib.T;\nexport type T2 = typeof Lib;\n' +
        'export const A = () => <div>hi</div>;\nexport const B = () => <>x</>;\n',
      'script.ts': 'const s = Lib.hello();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'preserve', moduleResolution: 'bundler', jsx: 'react' },
        files: ['a.tsx', 'script.ts', 'umd.d.ts', 'react.d.ts'],
      }),
    },
  ],
  [
    'UMD globals referenced from modules under allowUmdGlobalAccess',
    {
      'umd.d.ts':
        'export = Lib;\nexport as namespace Lib;\ndeclare namespace Lib {\n  function hello(): string;\n  interface T { a: 1 }\n}\n',
      'a.ts': 'export const x = Lib.hello();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'preserve', moduleResolution: 'bundler', allowUmdGlobalAccess: true },
        files: ['a.ts', 'umd.d.ts'],
      }),
    },
  ],
  [
    'asserted unique symbol in an inferred object literal',
    {
      'a.ts':
        'export const TypeId: unique symbol = Symbol.for("x");\n' +
        'export type TypeId = typeof TypeId;\n' +
        'interface Client { readonly [TypeId]: TypeId; config: string; other: number }\n' +
        'declare function identity<A>(a: A): A;\n' +
        'declare function assign<T, U>(t: T, u: U): T & U;\n' +
        'declare const base: { other: number };\n' +
        'export const c = identity<Client>(assign(base, { [TypeId]: TypeId as TypeId, config: "x" }));\n' +
        'export const d = identity<Client>(assign(base, { [TypeId]: (<TypeId>TypeId), config: "x" }));\n' +
        'export const e = identity<Client>(assign(base, { [TypeId]: TypeId, config: "x" }));\n' +
        'export const f = assign(base, { n: 1 as 1, s: "s" as "s" });\n' +
        'export const g: { n: 1 } = f;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, lib: ['ES2022'] }, files: ['a.ts'] }),
    },
  ],
  [
    'auto-typed variables assigned an unchecked element',
    {
      'a.ts':
        'declare const segs: string[];\n' +
        'export function f(i: number): number {\n  let path;\n  path = segs[i];\n  return path.length;\n}\n' +
        'export function g(i: number): string {\n  let s;\n  s = segs[i];\n  return s;\n}\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, noUncheckedIndexedAccess: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'discriminated unions with primitive and unmatched constituents',
    {
      'a.ts':
        'type G = { type: "geo"; props: { w: number; h: number }; x: number };\n' +
        'type R = { type: "arrow"; props: { start: number }; x: number };\n' +
        'type P1 = ({ type: "geo"; props?: Partial<G["props"]> } & Partial<Omit<G, "type" | "props">>) | ({ type: "arrow"; props?: Partial<R["props"]> } & Partial<Omit<R, "type" | "props">>);\n' +
        'declare function f1(p: P1 | null | undefined): void;\n' +
        'f1({ type: "geo", props: { w: "x" } });\n' +
        'f1({ type: "geo", extra: 1 });\n' +
        'f1({ type: "line", props: { w: "x" } });\n' +
        'type U = { kind: "a"; a: number } | { kind: "b"; b: string } | { [k: string]: boolean } | string | null;\n' +
        'declare function f2(u: U): void;\n' +
        'f2({ kind: "a", a: "x" });\n' +
        'f2({ kind: "c", a: 1 });\n' +
        'f2({ kind: "b", b: 1, c: 2 });\n' +
        'type V = { kind: "a"; v: 1 } | { kind: "b"; v: 2 } | { other: true };\n' +
        'declare function f3(v: V): void;\n' +
        'f3({ kind: "a", v: 2 });\n' +
        'f3({ kind: "z", v: 1 });\n' +
        'declare function f4(v: V | undefined): void;\n' +
        'f4({ kind: "a", v: 2, extra: 0 });\n' +
        'const x: { tag: 1; n: number } | { tag: 2; s: string } | number = { tag: 1, n: "no" };\n',
      'b.ts':
        'type G = { type: "geo"; props: { w: number; h: number }; x: number };\n' +
        'type R = { type: "arrow"; props: { start: number }; x: number };\n' +
        'type P1 = ({ type: "geo"; props?: Partial<G["props"]> } & Partial<Omit<G, "type" | "props">>) | ({ type: "arrow"; props?: Partial<R["props"]> } & Partial<Omit<R, "type" | "props">>);\n' +
        'declare function f1(p: P1 | null | undefined): void;\n' +
        'f1({ type: "geo", props: { w: "x" } });\n' +
        'type P2 = ({ type: "geo"; props?: Partial<G["props"]> } & Partial<Omit<G, "type" | "props">>) | ({ type: "arrow"; props?: Partial<R["props"]> } & Partial<Omit<R, "type" | "props">>);\n' +
        'declare function f2(p: P2): void;\n' +
        'f2({ type: "geo", props: { w: "x" } });\n' +
        'type P3 = ({ type: "geo"; props?: Partial<G["props"]> } & { x?: number }) | ({ type: "arrow"; props?: Partial<R["props"]> } & { x?: number });\n' +
        'declare function f3(p: P3 | null): void;\n' +
        'f3({ type: "geo", props: { w: "x" } });\n',
    },
  ],
  [
    'narrowing a NoInfer parameter',
    {
      'a.ts':
        'declare function transform<T, E>(o: { readonly decode: (input: E) => T }): { readonly decode: (e: E) => T };\n' +
        'type Decode<E, T> = { readonly decode: (e: NoInfer<E>) => NoInfer<T> };\n' +
        'export const x: Decode<ArrayBuffer | Uint8Array, Uint8Array> = transform({\n' +
        '  decode: (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value),\n' +
        '});\n' +
        'export const y: Decode<ArrayBuffer | Uint8Array, Uint8Array> = transform({ decode: (value) => value });\n' +
        'export function f<T>(v: NoInfer<T | undefined>, d: T): T {\n' +
        '  return v === undefined ? d : v;\n' +
        '}\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, lib: ['ES2022'] }, files: ['a.ts'] }),
    },
  ],
  [
    'type-only default import used as a namespace',
    {
      'a.ts': 'import type yargs from "./y";\nexport const x: yargs.T = 1;\n',
      'y.ts': 'declare const y: { a: number };\nexport default y;\nexport type T = number;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'preserve', moduleResolution: 'bundler', noUnusedLocals: true },
        files: ['a.ts', 'y.ts'],
      }),
    },
  ],
  [
    'type-only exports in the type of a module namespace',
    {
      'mods.d.ts':
        "declare module 'dep' {\n  export class K {}\n  export const v: 1;\n}\n" +
        "declare module 'mid' {\n  export { type K, v } from 'dep';\n}\n" +
        "declare module 'mid2' {\n  import type { K } from 'dep';\n  export { K };\n  export { v } from 'dep';\n}\n" +
        "declare module 'mid3' {\n  export type * from 'dep';\n  export { v } from 'dep';\n}\n",
      'a.ts':
        "import * as m from 'mid';\nimport * as m2 from 'mid2';\nimport * as m3 from 'mid3';\n" +
        "export const t: [keyof typeof m, keyof typeof m2] = ['K', 'K'];\n" +
        'export const k = [m.K, m2.K, m3.K];\n' +
        'export type Q = [m.K, typeof m.K, m3.K];\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'esnext', moduleResolution: 'bundler' },
        files: ['a.ts', 'mods.d.ts'],
      }),
    },
  ],
  [
    'JSON required from checked JavaScript',
    {
      'a.js':
        'const data = require("./data.json");\n/** @type {number} */\nconst n = data.name;\nmodule.exports = n;\n',
      'data.json': '{ "name": "x", "version": 1 }\n',
      'empty.json': '',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          module: 'CommonJS',
          allowJs: true,
          checkJs: true,
          resolveJsonModule: true,
        },
        files: ['a.js'],
      }),
    },
  ],
  [
    'string literal export names under module es2015',
    {
      'a.ts': 'export * as "x-y" from "./b";\nexport * as z from "./b";\nexport { v as "w-v" } from "./b";\n',
      'b.ts': 'export const v = 1;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, module: 'ES2015' }, files: ['a.ts', 'b.ts'] }),
    },
  ],
  [
    'type argument constraints of type references and import types',
    {
      'm.ts': 'export type G<T extends string, U = 1> = { t: T; u: U };\nexport class K<T extends string> { t!: T }\n',
      'a.ts':
        "import type { Base, Sql } from './missing';\n" +
        'type R<T extends string> = Sql<T>;\nexport type U = R<number>;\n' +
        "export interface F extends Base { q: R<this['x']> }\n" +
        'export type A = import("./m").G<number>;\nexport type C = import("./m").K<boolean>;\n' +
        'export type H = import("./m").G<"x", 2>;\n' +
        'type P<A extends string, B extends number> = [A, B];\n' +
        'export type T1 = P<\n  // @ts-ignore\n  number,\n  string\n>;\nexport type T2 = P<number, string>;\n' +
        'interface I<A extends string, B extends number> { a: A; b: B }\nexport interface J extends I<number, string> {}\n' +
        'type W<A, B extends string> = [A, B];\nexport type W1 = W<Missing, number>;\n',
    },
  ],
  [
    'JSON imports into ES modules under nodenext',
    {
      'a.ts':
        'import d from "./data.json";\nimport { name } from "./data.json";\nimport * as ns from "./data.json";\nimport ok from "./data.json" with { type: "json" };\nexport const v = [d.name, name, ns.default.count, ok.count];\nexport async function f() {\n  const m = await import("./data.json", { with: { type: "json" } });\n  return m.default.name;\n}\n',
      'b.ts':
        'export { name } from "./data.json";\nexport { default as dflt } from "./data.json";\nimport type T from "./data.json";\nimport * as ns2 from "./data.json" with { type: "json" };\nexport const n: T["count"] = ns2.default.count;\n',
      'data.json': '{ "name": "x", "count": 1 }\n',
      'package.json': '{ "type": "module" }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'nodenext', moduleResolution: 'nodenext', resolveJsonModule: true },
        files: ['a.ts', 'b.ts'],
      }),
    },
  ],
  [
    'JSON imports into CommonJS modules under node16',
    {
      'a.ts':
        'import d from "./data.json";\nimport { name } from "./data.json";\nimport * as ns from "./data.json";\nimport ok from "./data.json" with { type: "json" };\nexport const v = [d.name, name, ns.default.count, ok.count];\nexport async function f() {\n  const m = await import("./data.json", { with: { type: "json" } });\n  return m.default.name;\n}\n',
      'b.ts':
        'export { name } from "./data.json";\nexport { default as dflt } from "./data.json";\nimport type T from "./data.json";\nimport * as ns2 from "./data.json" with { type: "json" };\nexport const n: T["count"] = ns2.default.count;\n',
      'data.json': '{ "name": "x", "count": 1 }\n',
      'package.json': '{ "type": "commonjs" }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'node16', moduleResolution: 'node16', resolveJsonModule: true },
        files: ['a.ts', 'b.ts'],
      }),
    },
  ],
  [
    'excess property check against a union with a union-constrained type parameter',
    {
      'a.ts':
        'export function f<T extends { a: number } | { b: string }>(): void {\n' +
        '  const ok: { c: boolean } | T = { c: true };\n' +
        '  const wrong: { c: boolean } | T = { c: 1 };\n' +
        '  void ok, wrong;\n' +
        '}\n',
    },
  ],
  [
    'imports that conflict with global values under isolatedModules',
    {
      'types.ts': 'export interface Map<K, V> { x: K; y: V }\nexport type Promise = 1;\nexport type Set = 2;\n',
      'a.ts':
        'import { Map, Promise } from "./types";\nimport type { Set } from "./types";\n' +
        'export const m = new Map<string, number>();\nexport const p = Promise.resolve(1);\nexport const s = new Set<number>();\n',
      'b.ts': 'import { Map } from "./types";\nexport type T = Map<1, 2>;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, isolatedModules: true, module: 'esnext', moduleResolution: 'bundler' },
        files: ['a.ts', 'b.ts', 'types.ts'],
      }),
    },
  ],
  [
    'index types of indexed accesses in the true branch of a conditional type',
    {
      'a.ts':
        'export interface Column { readonly table: string }\n' +
        'export type Keys<T extends Record<string, Column>> = {\n' +
        "  [K in keyof T]: T[K]['_']['p'] extends true ? T[K]['_']['a'] extends true ? K\n" +
        "    : T[K]['_']['h'] extends true ? T[K]['_']['p'] extends true ? K : never\n" +
        '    : never\n    : never;\n};\n' +
        "export type J<T> = T extends { x: infer X } ? X extends { y: unknown } ? X['y'] : X['z'] : never;\n",
    },
  ],
  [
    'conditional types inferring from references to the same interface',
    {
      'a.ts':
        'interface Rpc<in out Tag extends string, out P = unknown, out S = unknown, out E = never> { readonly _tag: Tag; p: P; s: S; e: E }\n' +
        'interface Stream<out A, out E> { a: A; e: E }\n' +
        'type A1 = Rpc<"a", { x: 1 }, Stream<1, 2>, "e1"> | Rpc<"b", { y: 2 }, string, "e2"> | Rpc<"c", void, void, void>;\n' +
        'type IsStream<R, Tag extends string> = R extends Rpc<Tag, infer _P, Stream<infer _A, infer _E>, infer _Er> ? true : never;\n' +
        'type Provides<R, Tag extends string> = R extends Rpc<Tag, infer P, infer _S, infer _Er> ? P : "none";\n' +
        'export const s1: IsStream<A1, "a"> = 0;\n' +
        'export const s2: IsStream<A1, "b"> = 0;\n' +
        'export const p1: Provides<A1, "a"> = 0;\n' +
        'export const p2: Provides<A1, "b" | "c"> = 0;\n' +
        'export const p3: Provides<A1, string> = 0;\n' +
        '// A covariant void type argument relates by structure.\n' +
        'interface Fn<in out K extends string, out R> { k: K; (): R }\n' +
        'type Ret<F, K extends string> = F extends Fn<K, infer R> ? R : "none";\n' +
        'export const f1: Ret<Fn<"a", void>, "b"> = 0;\n' +
        'export const f2: Ret<Fn<"a", number>, "b"> = 0;\n' +
        'type FixedVoid<F> = F extends Fn<"a", void> ? 1 : 0;\n' +
        'export const f3: FixedVoid<Fn<"a", number>> = 2;\n' +
        'type InferVoid<F> = F extends Fn<"b", infer R extends void> ? R : "none";\n' +
        'export const f4: InferVoid<Fn<"a", undefined>> = 0;\n' +
        '// Covariant and contravariant fixed arguments.\n' +
        'interface Co<out T, out U> { t: T; u: U }\n' +
        'interface Contra<in T, out U> { f(x: T): void; u: U }\n' +
        'type C1<X> = X extends Co<"a" | "b", infer U> ? U : "no";\n' +
        'export const c1: C1<Co<"a", 1>> = 0;\n' +
        'export const c2: C1<Co<"c", 1>> = 0;\n' +
        'type C2<X> = X extends Contra<"a", infer U> ? U : "no";\n' +
        'export const c3: C2<Contra<"a" | "b", 1>> = 0;\n' +
        'export const c4: C2<Contra<"b", 1>> = 0;\n' +
        '// Measured variances, including unmeasurable ones.\n' +
        'interface M<T, U> { m: { [K in keyof T]: T[K] }; u: U }\n' +
        'type C3<X> = X extends M<{ a: 1 }, infer U> ? U : "no";\n' +
        'export const c5: C3<M<{ a: 2 }, 1>> = 0;\n' +
        'interface Plain<T, U> { t: T; u: U }\n' +
        'type C4<X> = X extends Plain<"x", infer U> ? U : "no";\n' +
        'export const c6: C4<Plain<"y", 1>> = 0;\n' +
        'export const c7: C4<Plain<"x", 1>> = 0;\n' +
        'type C5<X> = X extends Plain<infer T, T> ? T : "no";\n' +
        'export const c8: C5<Plain<"y", 1>> = 0;\n' +
        'type C6<X> = X extends Plain<string, infer U extends number> ? U : "no";\n' +
        'export const c9: C6<Plain<1, 2>> = 0;\n',
    },
  ],
  [
    'conditional types inferring from the parameters of callback-taking functions',
    {
      'a.ts':
        'declare function access(path: string, mode: number, callback: (err: Error | null) => void): void;\n' +
        'declare function access(path: string, callback: (err: Error | null) => void): void;\n' +
        'declare function read(path: string, callback: (err: Error | null, data: string) => void): void;\n' +
        'interface Callback<E, A> { (err: E, a?: A): void }\n' +
        'type WithCallback<Args extends any[], E, A> = [...args: Args, cb: Callback<E, A>];\n' +
        'type Effectify<T> = T extends {\n' +
        '  (...args: WithCallback<infer Args1, infer _E1, infer A1>): void;\n' +
        '  (...args: WithCallback<infer Args2, infer _E2, infer A2>): void;\n' +
        '} ? { (...args: Args1): A1; (...args: Args2): A2 }\n' +
        '  : T extends (...args: WithCallback<infer Args, infer _E, infer A>) => void ? (...args: Args) => A\n' +
        '  : never;\n' +
        'declare const accessE: Effectify<typeof access>;\n' +
        'declare const readE: Effectify<typeof read>;\n' +
        'export const a1: string = accessE("a", 1);\n' +
        'export const a2: string = accessE("a");\n' +
        'export const r: number = readE("a");\n' +
        'type Split<T> = T extends (...args: [...args: infer A, cb: infer C]) => void ? [A, C] : never;\n' +
        'export const s: Split<typeof read> = 0;\n' +
        'type Spread<A extends unknown[]> = (...args: [...A, cb: (err: Error | null, data: string) => void]) => void;\n' +
        'type SpreadArgs<T> = T extends Spread<infer A> ? A : never;\n' +
        'export const sa: SpreadArgs<typeof read> = 0;\n' +
        'type Parts<T> = T extends (...args: infer A) => infer R ? [A, R] : "none";\n' +
        'export const p: Parts<string> = 0;\n',
    },
  ],
  [
    'unused labels under allowUnusedLabels false',
    {
      'a.ts':
        'export {};\nhttps: `abc`;\nouter: for (;;) {\n  inner: for (;;) continue outer;\n}\n' +
        'a: b: {\n  break b;\n}\nfunction f() {\n  return;\n  late: {}\n}\n',
      'b.js': 'lbl: {\n}\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, allowUnusedLabels: false, allowJs: true, checkJs: true },
        files: ['a.ts', 'b.js'],
      }),
    },
  ],
  [
    'unannotated this parameters',
    {
      'a.ts':
        'declare function define<T>(o: T & ThisType<{ x: number }>): T;\n' +
        'export const c = define({\n  m(this) { return this.x; },\n  f: function (this) { return this.x; },\n});\n' +
        'export const d = { y: 1, m(this) { return this.y; } };\n' +
        'const o: { h(this: { z: string }): void } = { h(this) { this.z; } };\n' +
        'o.h = function (this) { this.z; };\n' +
        'export class K { m(this) {} }\n' +
        'export function f(this) {}\n',
    },
  ],
  [
    'type nodes of satisfies expressions',
    {
      'a.ts':
        'type N<T extends number> = { v: T };\ntype A = { a: string };\n' +
        'export const x = { k: 1 } as const satisfies { k: number } & { readonly t?: A };\n' +
        "export const y = { v: 's' } satisfies N<string>;\n" +
        'export const z = { v: 1 } satisfies { [k: string]: number; v: string };\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, noUnusedLocals: true }, files: ['a.ts'] }),
    },
  ],
  [
    'declaration errors under noEmit next to other errors',
    {
      'node_modules/lib/package.json': JSON.stringify({ name: 'lib', version: '1.0.0', types: 'index.d.ts' }),
      'node_modules/lib/index.d.ts': 'import { Inner } from "dep";\nexport declare function make(): Inner;\n',
      'node_modules/lib/node_modules/dep/package.json': JSON.stringify({
        name: 'dep',
        version: '1.0.0',
        types: 'index.d.ts',
      }),
      'node_modules/lib/node_modules/dep/index.d.ts': 'export interface Inner { x: number }\n',
      'a.ts': 'import { make } from "lib";\nexport const v = make();\nexport const e: number = "";\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, declaration: true, module: 'preserve' },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'defaults of missing type arguments in JavaScript',
    {
      'types.d.ts':
        'export interface Box<V = unknown> { v: V }\nexport interface Obj<V = {}> { o: V }\nexport interface Num<V = number> { n: V }\n',
      'a.js':
        "/** @import { Box, Obj, Num } from './types' */\n" +
        '/**\n * @template T\n * @param {Box} b\n * @returns {T}\n */\nexport function f(b) {\n  return b.v;\n}\n' +
        '/**\n * @template T\n * @param {Obj} o\n * @returns {T}\n */\nexport function g(o) {\n  return o.o;\n}\n' +
        '/**\n * @template T\n * @param {Num} n\n * @returns {T}\n */\nexport function h(n) {\n  return n.n;\n}\n',
      'c.ts': 'import type { Box } from "./types";\nexport function t(b: Box) { const s: string = b.v; return s; }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, allowJs: true, checkJs: true },
        files: ['a.js', 'c.ts', 'types.d.ts'],
      }),
    },
  ],
  [
    'namespaced JSX attributes and template literal index signatures',
    {
      'a.tsx':
        'type H = () => void;\n' +
        'declare global {\n  namespace JSX {\n    interface Element {}\n' +
        "    interface IntrinsicElements { d: { 'q:slot'?: string; [key: `${'w:' | ''}on${string}`]: H } }\n  }\n}\n" +
        'export const a = <d q:slot="x" />;\n' +
        'export const b = <d q:slot={1} />;\n' +
        'export const c = <d w:onx={1} />;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, jsx: 'preserve' }, files: ['a.tsx'] }),
    },
  ],
];

// Module specifiers of inferred types: `import("…")` types in declaration emit and the TS2883
// portability check. Projects write declarations to `out`, which must match too.
const emit = { ...base, noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: 'out' };
const link = (target) => ({ link: target });
const dependency = (name, types) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' }),
  [`node_modules/${name}/index.d.ts`]: types,
});

projects.push(
  [
    'emit helpers missing from tslib',
    {
      'a.ts':
        'import * as fs from "./dep";\nimport d, { default as d2, x } from "./dep";\nexport * from "./dep";\nexport * as ns from "./dep";\nexport { default as dd } from "./dep";\nexport async function f() { await 1; }\nexport async function* g() { yield* [1]; for await (const v of [1]) { } }\nexport function rest(o: { a: number; b: number }) { const { a, ...others } = o; return [a, others]; }\nexport class C {\n  #p = 1;\n  static { }\n  m(o: C) { this.#p = 2; return this.#p + (#p in o ? 1 : 0); }\n}\nexport const K = class { static z = 1; };\nexport function u() { using res = { [Symbol.dispose]() {} }; return res; }\nexport const all = [fs, d, d2, x];\n',
      'b.ts':
        'declare function dec(...args: any[]): any;\n@dec export class D {\n  @dec m(a: number): string { return ""; }\n  constructor(@dec p: number) {}\n}\n',
      'dep.ts': 'export const x = 1;\nexport default 2;\n',
      ...dependency(
        'tslib',
        'export declare function __awaiter(...a: any[]): any;\nexport declare function __rest(...a: any[]): any;\nexport declare function __classPrivateFieldGet(a: any, b: any, c: any): any;\nexport declare function __importDefault(...a: any[]): any;\n',
      ),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          target: 'ES2015',
          module: 'commonjs',
          importHelpers: true,
          esModuleInterop: true,
          lib: ['esnext'],
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
        files: ['a.ts', 'b.ts', 'dep.ts'],
      }),
    },
  ],
  [
    'emit helpers without tslib',
    {
      'a.ts':
        'import * as fs from "./dep";\nimport d, { default as d2, x } from "./dep";\nexport * from "./dep";\nexport * as ns from "./dep";\nexport { default as dd } from "./dep";\nexport async function f() { await 1; }\nexport async function* g() { yield* [1]; for await (const v of [1]) { } }\nexport function rest(o: { a: number; b: number }) { const { a, ...others } = o; return [a, others]; }\nexport class C {\n  #p = 1;\n  static { }\n  m(o: C) { this.#p = 2; return this.#p + (#p in o ? 1 : 0); }\n}\nexport const K = class { static z = 1; };\nexport function u() { using res = { [Symbol.dispose]() {} }; return res; }\nexport const all = [fs, d, d2, x];\n',
      'b.ts':
        'declare function dec(...args: any[]): any;\n@dec export class D {\n  @dec m(a: number): string { return ""; }\n  constructor(@dec p: number) {}\n}\n',
      'dep.ts': 'export const x = 1;\nexport default 2;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          target: 'ES2015',
          module: 'commonjs',
          importHelpers: true,
          esModuleInterop: true,
          lib: ['esnext'],
        },
        files: ['a.ts', 'b.ts', 'dep.ts'],
      }),
    },
  ],
  [
    'package name of a dependency of a dependency',
    {
      ...dependency('dep', 'export interface Inner { x: number }\n'),
      ...dependency('lib', 'import { Inner } from "dep";\nexport declare function make(): { inner: Inner };\n'),
      'src/index.ts': 'import { make } from "lib";\nexport const v = make();\nexport const w = () => make().inner;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'deferred imports under module commonjs',
    {
      'a.ts': 'export {};\nimport defer * as ns from "./missing";\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, module: 'CommonJS' }, files: ['a.ts'] }),
    },
  ],
  [
    'names reserved by emitted CommonJS code',
    {
      'a.ts':
        'const require = (id: string) => id;\nfunction exports() {}\nconst Object = 1;\nconst Promise = 2;\nexport async function af() { await 0; }\nlet WeakMap = 3;\nclass P { #x = 1; get() { return this.#x; } }\nfunction outer() {\n  const WeakSet = 4;\n  class Q { #y = 1; }\n  return [WeakSet, Q];\n}\nclass Base { static v = 1; }\nconst Reflect = 5;\nclass D extends Base { static w = super.v; }\nimport type { T as require2 } from "./b";\ndeclare const require3: number;\nexport { require, exports, Object, Promise, WeakMap, P, outer, Reflect, D };\nexport type R = require2;\n',
      'b.ts': 'export type T = number;\nexport class Object {}\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          noEmit: false,
          outDir: 'out',
          target: 'ES2015',
          module: 'commonjs',
          lib: ['esnext'],
        },
        files: ['a.ts', 'b.ts'],
      }),
    },
  ],
  [
    'names reserved by emitted code under noEmit',
    {
      'a.ts':
        'const require = (id: string) => id;\nfunction exports() {}\nconst Object = 1;\nconst Promise = 2;\nexport async function af() { await 0; }\nlet WeakMap = 3;\nclass P { #x = 1; get() { return this.#x; } }\nfunction outer() {\n  const WeakSet = 4;\n  class Q { #y = 1; }\n  return [WeakSet, Q];\n}\nclass Base { static v = 1; }\nconst Reflect = 5;\nclass D extends Base { static w = super.v; }\nimport type { T as require2 } from "./b";\ndeclare const require3: number;\nexport { require, exports, Object, Promise, WeakMap, P, outer, Reflect, D };\nexport type R = require2;\n',
      'b.ts': 'export type T = number;\nexport class Object {}\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, target: 'ES2015', module: 'commonjs', lib: ['esnext'] },
        files: ['a.ts', 'b.ts'],
      }),
    },
  ],
  [
    'package names through pnpm symlinks',
    {
      'package.json': JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0', dep: '1.0.0' } }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json': JSON.stringify({
        name: 'dep',
        version: '1.0.0',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.d.ts': 'export interface Inner { x: number }\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/package.json': JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.d.ts':
        'import { Inner } from "dep";\nexport declare function make(): { inner: Inner };\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/dep': link('../../dep@1.0.0/node_modules/dep'),
      'node_modules/lib': link('.pnpm/lib@1.0.0/node_modules/lib'),
      'node_modules/dep': link('.pnpm/dep@1.0.0/node_modules/dep'),
      'src/index.ts': 'import { make } from "lib";\nexport const v = make();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'type arguments of untyped JSX elements',
    {
      'a.tsx':
        'import { Missing } from "./nope";\nimport type { A } from "./n1";\nimport type { F } from "./t";\ndeclare const Anyy: any;\nexport const p = <Missing<A> a={1} />;\nexport const q = <Missing<F, NotAType> />;\nexport const r = <Anyy<AlsoMissing, string> b="x" />;\n',
      't.ts': 'export type T = number;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          jsx: 'preserve',
          module: 'esnext',
          moduleResolution: 'bundler',
          noUnusedLocals: true,
        },
        files: ['a.tsx', 't.ts'],
      }),
    },
  ],
  [
    'pnpm dependency the project does not declare',
    {
      'package.json': JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0' } }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json': JSON.stringify({
        name: 'dep',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.d.ts': 'export interface Inner { x: number }\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/package.json': JSON.stringify({
        name: 'lib',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.d.ts':
        'import { Inner } from "dep";\nexport declare function make(): { inner: Inner };\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/dep': link('../../dep@1.0.0/node_modules/dep'),
      'node_modules/lib': link('.pnpm/lib@1.0.0/node_modules/lib'),
      'src/index.ts': 'import { make } from "lib";\nexport const v = make();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'workspace package linked into node_modules',
    {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: '@ws/a', version: '1.0.0', types: 'dist/index.d.ts' }),
      'packages/a/dist/index.d.ts':
        'import type { Options } from "./options";\nexport interface Config { options: Options }\nexport declare function config(): Config;\n',
      'packages/a/dist/options.d.ts': 'export interface Options { strict: boolean }\n',
      'packages/b/package.json': JSON.stringify({ name: '@ws/b', version: '1.0.0', dependencies: { '@ws/a': '*' } }),
      'packages/b/src/index.ts':
        'import { config } from "@ws/a";\nexport const c = config();\nexport const o = () => config().options;\n',
      'packages/b/tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
      'node_modules/@ws/a': link('../../packages/a'),
      'node_modules/@ws/b': link('../../packages/b'),
    },
    ['-p', 'packages/b'],
  ],
  [
    'package exports with import and require conditions',
    {
      'node_modules/lib/package.json': JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': { types: './types/index.d.ts', default: './index.js' },
          './feature': {
            import: { types: './types/feature.d.mts', default: './feature.mjs' },
            require: { types: './types/feature.d.cts', default: './feature.cjs' },
          },
          './utils/*': { types: './types/utils/*.d.ts' },
        },
      }),
      'node_modules/lib/types/index.d.ts':
        'export { make } from "./internal.js";\nexport * from "./utils/strings.js";\n',
      'node_modules/lib/types/internal.d.ts':
        'export interface Hidden { h: 1 }\nexport declare function make(): Hidden;\n',
      'node_modules/lib/types/utils/strings.d.ts':
        'export interface Str { s: string }\nexport declare function str(): Str;\n',
      'node_modules/lib/types/feature.d.mts': 'export interface F { f: 1 }\nexport declare function feature(): F;\n',
      'node_modules/lib/types/feature.d.cts': 'export interface FC { f: 2 }\nexport declare function feature(): FC;\n',
      'src/a.mts':
        'import { feature } from "lib/feature";\nimport { str } from "lib";\nexport const f = () => feature();\nexport const s = () => str();\n',
      'src/b.cts': 'import { feature } from "lib/feature";\nexport const f = () => feature();\n',
      'src/c.mts': 'import { make } from "lib";\nexport const h = make();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'nodenext', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'typesVersions of a dependency',
    {
      'node_modules/tv/package.json': JSON.stringify({
        name: 'tv',
        version: '1.0.0',
        types: 'index.d.ts',
        typesVersions: { '*': { '*': ['ts/*'] } },
      }),
      'node_modules/tv/ts/index.d.ts': 'export * from "./sub";\n',
      'node_modules/tv/ts/sub.d.ts':
        'import { Deep } from "./deep/thing";\nexport declare function s(): { deep: Deep };\n',
      'node_modules/tv/ts/deep/thing.d.ts': 'export interface Deep { d: 1 }\n',
      'src/index.ts': 'import { s } from "tv";\nexport const v = s();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'paths to a directory outside the project',
    {
      'lib/deep/thing.ts':
        'import type { Inner } from "@lib/other/inner";\nexport function thing(): { inner: Inner } { return { inner: { i: 1 } }; }\n',
      'lib/other/inner.ts': 'export interface Inner { i: number }\n',
      'app/src/index.ts': 'import { thing } from "@lib/deep/thing";\nexport const v = thing();\n',
      'app/tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: '..', paths: { '@lib/*': ['../lib/*'] } },
        include: ['src'],
      }),
    },
    ['-p', 'app'],
  ],
  [
    'paths inside the project',
    {
      'src/lib/deep/thing.ts':
        'import type { Inner } from "@lib/other/inner";\nexport function thing(): { inner: Inner } { return { inner: { i: 1 } }; }\n',
      'src/lib/other/inner.ts': 'export interface Inner { i: number }\n',
      'src/app/index.ts': 'import { thing } from "@lib/deep/thing";\nexport const v = thing();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src', paths: { '@lib/*': ['./src/lib/*'] } },
        include: ['src'],
      }),
    },
  ],
  [
    'rootDirs',
    {
      'src/index.ts': 'import { make } from "./generated";\nexport const v = make();\n',
      'generated/generated.ts':
        'import type { Shape } from "./shape";\nexport function make(): { shape: Shape } { return { shape: { n: 1 } }; }\n',
      'generated/shape.ts': 'export interface Shape { n: number }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: '.', rootDirs: ['src', 'generated'] },
        include: ['src'],
      }),
    },
  ],
  [
    'node16 endings of ES modules and CommonJS files',
    {
      'package.json': JSON.stringify({ name: 'app', type: 'module' }),
      'src/lib/util.ts': 'export interface U { u: 1 }\nexport function u(): U { return { u: 1 }; }\n',
      'src/lib/index.ts': 'export { u } from "./util.js";\n',
      'src/main.ts': 'import { u } from "./lib/index.js";\nexport const v = u();\n',
      'src/c/helper.cts': 'export interface H { h: 1 }\nexport function h(): H { return { h: 1 }; }\n',
      'src/c/index.cts': 'export { h } from "./helper.cjs";\n',
      'src/d.cts': 'import { h } from "./c/index.cjs";\nexport const x = h();\n',
      'node_modules/esm-only/package.json': JSON.stringify({
        name: 'esm-only',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: { types: './index.d.ts', default: './index.js' } } },
      }),
      'node_modules/esm-only/index.d.ts': 'export interface E { e: 1 }\nexport declare function e(): E;\n',
      'src/e.cts': 'export const p = import("esm-only").then((m) => m.e());\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'node16', rootDir: 'src', lib: ['ES2022'] },
        include: ['src'],
      }),
    },
  ],
  [
    'import types reused from another directory',
    {
      'src/deep/a.ts':
        'export function f(): import("./b").B { return { b: 1 }; }\n' +
        'export declare const holder: { item: import("./b").B; list: import("./b").B[] };\n' +
        'export class K { m(): import("./b").B { return { b: 1 }; } p!: import("./b").B; }\n',
      'src/deep/b.ts': 'export interface B { b: number }\n',
      'src/index.ts':
        'import { f, holder, K } from "./deep/a";\n' +
        'export const h = { ...holder };\nexport const mm = new K().m;\nexport const pp = { p: new K().p, f };\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'missing exports of a workspace package linked into node_modules',
    {
      'app/package.json': JSON.stringify({ name: '@scope/app', private: true, type: 'module' }),
      'app/utils/theme/index.ts': 'export const size = 1;\n',
      'app/components/a.ts': 'import type { Size, Variant } from "app/utils/theme";\nexport type S = Size | Variant;\n',
      'node_modules/app': link('../app'),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'preserve', moduleResolution: 'bundler' },
        include: ['app'],
      }),
    },
  ],
  [
    'missing exports of a namespace module imported with its output extension',
    {
      'src/types.ts': 'export interface Diagnostic {\n  code: number;\n}\n',
      'src/_namespaces/ts.ts': 'export * from "../types.js";\nexport * from "../messages.generated.js";\n',
      'src/binder.ts': 'import { Diagnostics } from "./_namespaces/ts.js";\nexport const d = Diagnostics;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, module: 'nodenext' }, include: ['src'] }),
    },
  ],
  [
    'narrowing of references to declarations with escaped names',
    {
      'a.ts':
        'declare const input: string | number | undefined;\n' +
        'let \\u0061 = input;\nconst { b: \\u0063 = 1 } = { b: input };\nlet other = input;\n' +
        "if (typeof a === 'string') {\n  const s: number = a;\n}\n" +
        "a = 1;\nconst n: string = a;\nconst t: boolean = c;\nother = 'x';\nconst u: number = other;\n" +
        'export {};\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, module: 'preserve' }, files: ['a.ts'] }),
    },
  ],
  [
    'unique symbols of modules as missing index keys',
    {
      'a.ts':
        'export const sym: unique symbol = Symbol();\n' +
        'export namespace NS {\n  export const inner: unique symbol = Symbol();\n}\n',
      'b.ts':
        'import { sym, NS } from "./a";\nconst o = { x: 1 };\no[sym];\no[NS.inner];\n' +
        'declare const g: unique symbol;\no[g];\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, module: 'preserve' }, files: ['a.ts', 'b.ts'] }),
    },
  ],
  [
    'workspace package sources through a node_modules symlink are not emitted',
    {
      'packages/contracts/package.json': JSON.stringify({
        name: '@ws/contracts',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
      }),
      'packages/contracts/src/index.ts':
        'export * from "./util.js";\nexport interface Contract { id: string }\nexport const version = 1;\n',
      'packages/contracts/src/util.ts': 'export const util = (x: number) => ({ x, y: [x] });\n',
      'apps/server/package.json': JSON.stringify({ name: 'server', type: 'module' }),
      'apps/server/node_modules/@ws/contracts': link('../../../../packages/contracts'),
      'apps/server/src/index.ts':
        'import { util, version, type Contract } from "@ws/contracts";\n' +
        'export const c: Contract = { id: String(version) };\nexport const u = util(1);\n',
      'apps/server/tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, emitDeclarationOnly: false, module: 'nodenext', rootDir: 'src' },
        include: ['src'],
      }),
    },
    ['-p', 'apps/server'],
  ],
);

// Emit on checker threads: each checker emits the files it checks; the main thread emits the files no
// checker checks (JSON, unchecked JavaScript). Declaration errors and outputs must match.
const emitFiles = {
  'src/shapes.ts':
    'export interface Shape { kind: string; size: number }\n' +
    'export const shapes = [{ kind: "a", size: 1 }, { kind: "b", size: 2, extra: true }];\n',
  'src/area.ts':
    'import { Shape, shapes } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
    'export const total = shapes.map(area).reduce((a, b) => a + b, 0);\n',
  'src/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
  'src/wrong.ts': 'export const n: number = "not a number";\n',
  'src/data.json': '{ "name": "data", "values": [1, 2, 3] }\n',
  'src/plain.js': 'export function plain(a) { return a + 1; }\n',
  'src/index.ts':
    'import data from "./data.json";\nimport { plain } from "./plain.js";\nimport { total } from "./area";\n' +
    'export * from "./hidden";\nexport const summary = { name: data.name, total, next: plain(total) };\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      ...base,
      noEmit: false,
      module: 'commonjs',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowJs: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      rootDir: 'src',
      outDir: 'out',
    },
    include: ['src'],
  }),
};

projects.push(
  ['emit on one checker', emitFiles, ['--singleThreaded']],
  ['emit on three checkers', emitFiles, ['--checkers', '3']],
);

// JSX emit: opening and self-closing elements, fragments and spread attributes for the automatic and
// classic runtimes, with JavaScript, declarations and maps compared.
const jsxRuntime = {
  'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '1.0.0', types: 'index.d.ts' }),
  'node_modules/react/index.d.ts':
    'export declare function createElement(...args: any[]): any;\nexport declare const Fragment: any;\n' +
    'declare global { namespace JSX { interface Element {} interface IntrinsicElements { [name: string]: any } } }\n',
  'node_modules/react/jsx-runtime.d.ts':
    'export declare function jsx(...args: any[]): any;\nexport declare function jsxs(...args: any[]): any;\n' +
    'export declare const Fragment: any;\n',
  'a.tsx':
    'import * as React from "react";\nvoid React;\n' +
    'export const Item = (props: { name: string }) => <li className="item">{props.name}<br /></li>;\n' +
    'export const List = (props: any) => <ul {...props} key="k"><Item name="a" /><>{[1, 2]}</></ul>;\n' +
    'export const Empty = () => <input disabled />;\n',
};

for (const jsx of ['react-jsx', 'react'])
  projects.push([
    `JSX elements with jsx ${jsx}`,
    {
      ...jsxRuntime,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          noEmit: false,
          jsx,
          module: 'esnext',
          moduleResolution: 'bundler',
          sourceMap: true,
          declaration: true,
          declarationMap: true,
          outDir: 'out',
        },
        files: ['a.tsx'],
      }),
    },
  ]);

// Decorator metadata: `design:type`, `design:paramtypes` and `design:returntype` of type references
// follow the referenced types, and the JavaScript, declarations and their maps must match.
const decorated = {
  ...base,
  noEmit: false,
  module: 'commonjs',
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  useDefineForClassFields: false,
  sourceMap: true,
  declaration: true,
  declarationMap: true,
  outDir: 'out',
};

projects.push([
  'decorator metadata of type references',
  {
    'types.ts':
      'export type Str = string;\nexport enum Color { Red = "red", Blue = "blue" }\n' +
      'export const enum Size { S = 1, M = 2 }\nexport type Keys = keyof { a: 1; b: 2 };\n' +
      'export interface Shape { name: string; size: number; draw(): void }\n' +
      'export type Name = Shape["name"];\nexport type Picked = { [K in "x"]: number }["x"];\n' +
      'export type Cond<T> = T extends string ? string : string;\nexport type Extracted = Extract<"a" | 1, string>;\n' +
      'export const values = ["one", "two"] as const;\nexport type Value = (typeof values)[number];\n' +
      'export type Lower = Lowercase<"A">;\nexport type Present = NonNullable<string | undefined>;\n' +
      'export type Callback = () => void;\nexport type Factory = new () => object;\n' +
      'export type Pair = [string, number];\nexport type Strings = Array<string>;\n' +
      'export type Frozen = ReadonlyArray<string>;\nexport interface Callable { (): void }\n' +
      'export class Model { id!: number }\nexport namespace NS { export class Inner {} export type Id = number }\n',
    'a.ts':
      'import type { Model as ModelType } from "./types";\n' +
      'import { Str, Color, Size, Keys, Shape, Name, Picked, Cond, Extracted, Value, Lower, Present, Callback, Factory, Pair, Strings, Frozen, Callable, Model, NS } from "./types";\n' +
      'declare function d(...args: any[]): any;\n' +
      'type Local = Color.Red;\n' +
      'export class C {\n' +
      '  @d a!: Str;\n  @d b!: Color;\n  @d c!: Size;\n  @d k!: Keys;\n  @d s!: Shape;\n  @d n!: Name;\n' +
      '  @d p!: Picked;\n  @d cs!: Cond<number>;\n  @d ex!: Extracted;\n  @d v!: Value;\n  @d lo!: Lower;\n' +
      '  @d pr!: Present;\n  @d cb!: Callback;\n  @d f!: Factory;\n  @d pa!: Pair;\n  @d st!: Strings;\n' +
      '  @d fr!: Frozen;\n  @d ca!: Callable;\n  @d m!: Model;\n  @d mt!: ModelType;\n  @d ni!: NS.Inner;\n' +
      '  @d nid!: NS.Id;\n  @d l!: Local;\n  @d u!: Str | undefined;\n  @d pm!: Promise<Model[]>;\n' +
      '  @d dt!: Date;\n  @d rec!: Record<string, string>;\n  @d miss!: Missing;\n' +
      '  @d method(@d x: Keys, y: Value, z: Promise<Name>): Value { return "one"; }\n' +
      '  @d async run(): Promise<void> {}\n' +
      '  @d get g(): Name { return ""; }\n' +
      '  constructor(@d readonly x: Value, readonly y: Strings) {}\n' +
      '}\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: decorated, files: ['a.ts'] }),
  },
]);

/** Writes `files`; a `{ link }` value is a symlink to the relative path `link`. */
function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    if (typeof content === 'string') writeFileSync(join(dir, path), content);
    else symlinkSync(content.link, join(dir, path));
  }
}

/** The files under `dir` that are not in `inputs`, by path relative to `root`; symlinks are skipped. */
function readOutputs(root, dir, inputs, outputs = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) readOutputs(root, path, inputs, outputs);
    else if (!(relative(root, path) in inputs)) outputs[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return outputs;
}

function run(command, files, args) {
  const cwd = tempDir('tsc-ts-projects-');
  writeFiles(cwd, files);
  const env = { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, NO_COLOR: '1' };
  return new Promise((done) => {
    execFile(
      command[0],
      [...command.slice(1), ...(args.includes('-p') ? [] : ['-p', '.']), '--pretty', 'false', ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        done({ stdout, stderr, status, outputs: readOutputs(cwd, cwd, files) });
      },
    );
  });
}

test('projects reduced from real-world code match tsgo', { skip, timeout: 300_000 }, async () => {
  const filter = process.env.PROJECTS_FILTER;
  const failures = [];
  await Promise.all(
    projects
      .filter(([name]) => filter === undefined || name.includes(filter))
      .map(async ([name, source, args = []]) => {
        const files =
          'tsconfig.json' in source
            ? source
            : { ...source, 'tsconfig.json': JSON.stringify({ compilerOptions: base }) };
        const [expected, actual] = await Promise.all([run([tsgo], files, args), run(tscTs, files, args)]);
        const problems = [];
        if (expected.stdout !== actual.stdout)
          problems.push(`stdout\n  tsgo: ${expected.stdout}\n  ours: ${actual.stdout}`);
        if (expected.stderr !== actual.stderr)
          problems.push(`stderr\n  tsgo: ${expected.stderr}\n  ours: ${actual.stderr}`);
        if (expected.status !== actual.status) problems.push(`status tsgo ${expected.status}, ours ${actual.status}`);
        for (const path of new Set([...Object.keys(expected.outputs), ...Object.keys(actual.outputs)]))
          if (expected.outputs[path] !== actual.outputs[path])
            problems.push(`${path}\n  tsgo: ${expected.outputs[path]}\n  ours: ${actual.outputs[path]}`);
        if (problems.length > 0) failures.push(`${name}: ${problems.join('\n')}`);
      }),
  );
  assert.deepEqual(failures, []);
});
