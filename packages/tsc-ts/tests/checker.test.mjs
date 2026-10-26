import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileSources } from './temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const libs = join(repo, 'upstream/TypeScript/tsc/internal/bundled/libs');
const oracle = join(repo, 'packages/tsgo/dist/check-oracle');

/** `n` declarations named after `prefix`, which a flow walk passes one by one. */
const filler = (prefix, n = 40, indent = '') =>
  Array.from({ length: n }, (_, i) => `${indent}const _${prefix}${i} = ${i};`);

// `options` lists options for TSC_TS_CHECK_OPTIONS, separated by commas: boolean options, module, moduleResolution
// and target as name=value, and the strict family, allowUnreachableCode and allowUnusedLabels as name=true or
// name=false. A case with `corpus` checks that test case of TypeScript's corpus instead of `source`, and compares only
// the diagnostics with the `codes` it lists to `expected`; all of them are compared to the oracle's. A case with
// `differsFromOracle` expects TypeScript 7.1's diagnostics where tsc 7.0.2, the oracle, reports others.
const cases = [
  {
    name: 'module and target from TSC_TS_CHECK_OPTIONS',
    options: 'module=es2015,target=es5',
    source: ['export const s = "a".at(0);', 'export const m = import("./m");'],
    expected: [
      "/input.ts 2550 21 2 Property 'at' does not exist on type '\"a\"'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2022' or later.",
      "/input.ts 1323 45 13 Dynamic imports are only supported when the '--module' flag is set to 'es2020', 'es2022', 'esnext', 'commonjs', 'amd', 'system', 'umd', 'node16', 'node18', 'node20', or 'nodenext'.",
      "/input.ts 2307 52 5 Cannot find module './m' or its corresponding type declarations.",
    ],
  },
  {
    name: 'options from TSC_TS_CHECK_OPTIONS',
    options: 'noUncheckedIndexedAccess,noImplicitOverride',
    source: [
      'declare const a: number[];',
      'const n: number = a[0];',
      'class B { m() {} }',
      'class C extends B { m() {} }',
    ],
    expected: [
      "/input.ts 2322 33 1 Type 'number | undefined' is not assignable to type 'number'.",
      "/input.ts 4114 90 1 This member must have an 'override' modifier because it overrides a member in the base class 'B'.",
    ],
  },
  {
    name: 'assignability, missing properties and arity',
    source: [
      'let x: number = "a";',
      'const y = { a: 1, b: "x" };',
      'y.c;',
      'function f(a: number, b: string): number { return a; }',
      'f(1);',
      'f(1, 2);',
      'const s: string = f(1, "a");',
      'class C { p: number; m() { return this.p; } }',
      'new C().m().toFixed();',
      '[1, 2].map(v => v.toFixed());',
    ],
    expected: [
      "/input.ts 2322 4 1 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2339 51 1 Property 'c' does not exist on type '{ a: number; b: string; }'.",
      '/input.ts 2554 109 1 Expected 2 arguments, but got 1.',
      "/input.ts 2345 120 1 Argument of type 'number' is not assignable to parameter of type 'string'.",
      "/input.ts 2322 130 1 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2564 163 1 Property 'p' has no initializer and is not definitely assigned in the constructor.",
    ],
  },
  {
    name: 'narrowing and definite assignment',
    source: [
      'declare const a: string | undefined;',
      'if (a) a.length;',
      'a.length;',
      'let b: number;',
      'b.toFixed();',
      'function f(x: string | number) {',
      '  if (typeof x === "string") return x.length;',
      '  return x.toFixed();',
      '}',
      'type S = { kind: "a"; a: number } | { kind: "b"; b: string };',
      'function g(s: S) {',
      '  switch (s.kind) {',
      '    case "a": return s.a;',
      '    case "b": return s.b;',
      '  }',
      '}',
    ],
    expected: [
      "/input.ts 18048 54 1 'a' is possibly 'undefined'.",
      "/input.ts 2454 79 1 Variable 'b' is used before being assigned.",
    ],
  },
  {
    name: 'unresolved names with suggestions',
    source: ['const count = 1;', 'cuont;'],
    expected: ["/input.ts 2552 17 5 Cannot find name 'cuont'. Did you mean 'count'?"],
  },
  {
    // A const type parameter makes the literals of its argument const, but not the branches of a
    // conditional or a `satisfies` operand in it (T3 Code: `Effect.all([a, b, ...(c ? [d] : [])])`).
    name: 'const type parameter contexts stop at conditionals and satisfies',
    source: [
      "declare function all<const T extends Iterable<{ readonly tag: 'e' }> | Record<string, unknown>>(arg: T): T;",
      "declare const e: { readonly tag: 'e' };",
      'declare const cond: boolean;',
      'all([e, e, e, ...(cond ? [e] : [])]);',
      'all([...(cond ? [] : [e]), e, e]);',
      'declare function f<const T>(x: T): T;',
      'const n: number = f({ a: cond ? [1] : [2, 3], b: [4] satisfies number[] });',
    ],
    expected: [
      "/input.ts 2322 294 1 Type '{ readonly a: number[]; readonly b: number[]; }' is not assignable to type 'number'.",
    ],
  },
  {
    // Inferences flow between the context-sensitive elements of an array literal only in a tuple
    // context: in `f`, `T` is fixed at `b` before the first element's return type is inferred.
    name: 'intra-expression inference in array literals needs a tuple context',
    source: [
      'declare function f<T>(fns: ((a: number, b: T) => T)[]): T;',
      'const r = f([(a) => a, (a, b) => b]);',
      'const n: number = r;',
      'declare function g<T>(fns: [(a: number) => T, (b: T) => void]): T;',
      'const s = g([(a) => a, (b) => b.toFixed()]);',
      'const m: number = s;',
    ],
    expected: ["/input.ts 2322 103 1 Type 'unknown' is not assignable to type 'number'."],
  },
  {
    // The `children` property made from an element's body is an excess property like an attribute.
    name: 'JSX children are checked as excess properties',
    file: 'input.tsx',
    source: [
      '// @jsx: preserve',
      'declare namespace JSX {',
      '  interface Element {}',
      '  interface ElementChildrenAttribute { children: {} }',
      '}',
      'interface Props { resizable?: boolean }',
      'declare function Demo(props: Props): JSX.Element;',
      'const a = <Demo resizable>text</Demo>;',
      'const b = <Demo resizable />;',
    ],
    expected: [
      "/input.tsx 2322 222 4 Type '{ resizable: true; children: string; }' is not assignable to type 'Props'.",
    ],
  },
  {
    // A function with `@param` tags has the `arguments` references of its body resolved, in TypeScript files too.
    name: '`const arguments` in a function with JSDoc parameters',
    source: [
      'class A {',
      '  /** @param {object} [foo] */',
      '  constructor(foo = {}) {',
      '    const arguments = foo;',
      '  }',
      '}',
    ],
    expected: [
      "/input.ts 1210 77 9 Code contained in a class is evaluated in JavaScript's strict mode which does not allow this use of 'arguments'. For more information, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Strict_mode.",
      "/input.ts 2448 77 9 Block-scoped variable 'arguments' used before its declaration.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on a long straight-line flow, with assignments, an assertion call and access references',
    source: [
      'declare function g(): string | number;',
      'declare const o: { p: string | number };',
      'let x = g();',
      'x = "a";',
      ...filler('a'),
      'const a1: number = x;',
      ...filler('b'),
      'x = 1;',
      ...filler('c'),
      'const a2: string = x;',
      ...filler('d'),
      'const a3: string = x;',
      'const a4: string = (x)!;',
      ...filler('e'),
      'const a5: string = x!;',
      'o.p = "s";',
      ...filler('f'),
      'const a6: number = o.p;',
      ...filler('h'),
      'const a7: number = o["p"];',
      'declare function isString(v: unknown): asserts v is string;',
      'let y = g();',
      ...filler('i'),
      'const a8: boolean = y;',
      'isString(y);',
      ...filler('j'),
      'const a9: number = y;',
    ],
    expected: [
      "/input.ts 2322 768 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 2117 2 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2322 2799 2 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2322 2821 2 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2322 3506 2 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2322 4200 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 4884 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 5644 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 6340 2 Type 'string' is not assignable to type 'number'.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on long walks in loops',
    source: [
      'declare function g(): string | number;',
      'let y = g();',
      'for (let i = 0; i < 3; i++) {',
      ...filler('a', 40, '  '),
      '  const c1: boolean = y;',
      ...filler('b', 40, '  '),
      '  y = "s";',
      ...filler('c', 40, '  '),
      '  const c2: number = y;',
      ...filler('d', 40, '  '),
      '  const c3: number = y;',
      '}',
      ...filler('e'),
      'const c4: boolean = y;',
      'let z = g();',
      'while (z !== 1) {',
      ...filler('f', 40, '  '),
      '  const c5: boolean = z;',
      ...filler('h', 40, '  '),
      '  z = 1;',
      '}',
      ...filler('i'),
      'const c6: string = z;',
    ],
    expected: [
      "/input.ts 2322 830 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 2346 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 3110 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 3794 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 4590 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 6024 2 Type 'number' is not assignable to type 'string'.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on long walks through try and finally',
    source: [
      'declare function g(): string | number;',
      'let z = g();',
      'try {',
      '  z = "s";',
      ...filler('a', 40, '  '),
      '  const d1: number = z;',
      '} finally {',
      ...filler('b', 40, '  '),
      '  const d2: boolean = z;',
      ...filler('c', 40, '  '),
      '  const d3: boolean = z;',
      '}',
      ...filler('d'),
      'const d4: number = z;',
      ...filler('e'),
      'const d5: number = z;',
    ],
    expected: [
      "/input.ts 2322 817 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 1593 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 2358 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 3043 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 3725 2 Type 'string' is not assignable to type 'number'.",
    ],
  },
  {
    // More than 128 conditions on `x` and `k`: the walks for each are indexed, and so are walks for
    // `k` inside them.
    name: 'flow analysis matches tsgo on walks through many consecutive conditions',
    source: [
      'declare function g(): string | number;',
      'const x = g();',
      'const k = g();',
      ...Array.from({ length: 150 }, () => 'if (x === k) {}'),
      'if (typeof x === "string") {',
      '  const n: number = x;',
      '}',
      ...Array.from({ length: 150 }, () => 'if (x !== 1) {}'),
      'const b: boolean = x;',
      'const c: boolean = k;',
    ],
    expected: [
      "/input.ts 2322 2506 1 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 4929 1 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 4951 1 Type 'string | number' is not assignable to type 'boolean'.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on long walks in branches of an aliased condition',
    source: [
      'declare function g(): string | number;',
      'const w = g();',
      'const isStr = typeof w === "string";',
      ...filler('a'),
      'if (isStr) {',
      ...filler('b', 40, '  '),
      '  const e1: number = w;',
      ...filler('c', 40, '  '),
      '  const e2: number = w;',
      '} else {',
      ...filler('d', 40, '  '),
      '  const e3: string = w;',
      '}',
      ...filler('e'),
      'const e4: boolean = w;',
    ],
    expected: [
      "/input.ts 2322 1512 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 2276 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 3049 2 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2322 3733 2 Type 'string | number' is not assignable to type 'boolean'.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on long walks of generic references with union constraints',
    source: [
      'function h<T extends string | number>(v: T, o: { k: T }) {',
      ...filler('a', 40, '  '),
      '  const r1: boolean = v;',
      ...filler('b', 40, '  '),
      '  if (typeof v === "string") {',
      ...filler('c', 40, '  '),
      '    const q1: number = v;',
      ...filler('d', 40, '  '),
      '    const q2: number = v.length + v;',
      '  }',
      ...filler('e', 40, '  '),
      '  const r2: boolean = o.k;',
      ...filler('f', 40, '  '),
      '  const r3 = o[`k`];',
      '  const r4: boolean = v;',
      '  let u: string | number | boolean | T = v;',
      ...filler('h', 40, '  '),
      '  const r5: boolean = u;',
      ...filler('i', 40, '  '),
      '  const r6 = [u];',
      '  const r7: boolean = r6;',
      ...filler('j', 40, '  '),
      '  const r8: boolean = u;',
      '}',
    ],
    expected: [
      "/input.ts 2322 807 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 2345 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 3111 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 3890 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 4678 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 5487 2 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 6270 2 Type 'T[]' is not assignable to type 'boolean'.",
      "/input.ts 2322 7036 2 Type 'string | number' is not assignable to type 'boolean'.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on long walks that run while a loop is analyzed',
    source: [
      'declare function g(): string | number;',
      'let x = g();',
      'let n = 0;',
      'while (n < 10) {',
      ...filler('a', 40, '  '),
      '  const y = x;',
      ...filler('b', 40, '  '),
      '  x = typeof y === "string" ? 1 : "s";',
      '  n++;',
      ...filler('c', 40, '  '),
      '  const w: boolean = x;',
      '}',
      'const z: boolean = x;',
      'let a = g();',
      'for (let i = 0; i < 3; i++) {',
      ...filler('d', 40, '  '),
      '  const b = a;',
      ...filler('e', 40, '  '),
      '  a = typeof b === "number" ? "s" : b.length;',
      ...filler('f', 40, '  '),
      '  const c: boolean = b;',
      '}',
      'const d: boolean = a;',
    ],
    expected: [
      "/input.ts 2322 2369 1 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 2393 1 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 4741 1 Type 'string | number' is not assignable to type 'boolean'.",
      "/input.ts 2322 4765 1 Type 'string | number' is not assignable to type 'boolean'.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on long walks of element and property accesses with the same key',
    source: [
      'declare const o: { "a.b": string | number; a: { b: string | number } };',
      'o["a.b"] = "s";',
      ...filler('a'),
      'const t1: number = o["a.b"];',
      'o.a.b = 1;',
      ...filler('b'),
      'const t2: string = o.a.b;',
      ...filler('c'),
      'const t3: number = o["a.b"];',
      ...filler('d'),
      'const t4: string = o.a.b;',
    ],
    expected: [
      "/input.ts 2322 754 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 1454 2 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2322 2140 2 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2322 2829 2 Type 'number' is not assignable to type 'string'.",
    ],
  },
  {
    name: 'flow analysis matches tsgo on long walks through an aliased condition on a readonly or mutable property',
    source: [
      'type R = { readonly kind: "r"; readonly v: string | number };',
      'type M = { kind: "m"; v: string | number };',
      'declare const o: R | M;',
      'const isStr = typeof o.v === "string";',
      'if (isStr) {',
      ...filler('a', 40, '  '),
      '  const x1: string = o.v;',
      '  if (o.kind === "m") {',
      ...filler('b', 40, '    '),
      '    const x2: string = o.v;',
      '  }',
      '}',
    ],
    expected: ["/input.ts 2322 1802 2 Type 'string | number' is not assignable to type 'string'."],
  },
  {
    name: 'infer type parameters in variadic elements of rest parameters',
    source: [
      'declare function access(path: string, callback: (err: Error | null) => void): void;',
      'type Args<T> = T extends (...args: [...args: infer A, cb: (err: any) => void]) => void ? A : never;',
      'type Spread<A extends unknown[]> = (...args: [...A, cb: (err: any) => void]) => void;',
      'type SpreadArgs<T> = T extends Spread<infer A> ? A : never;',
      'const a: Args<typeof access> = [1];',
      'const b: SpreadArgs<typeof access> = [1];',
    ],
    expected: [
      "/input.ts 2322 362 1 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2322 404 1 Type 'number' is not assignable to type 'string'.",
    ],
  },
  {
    // `[...][0]` widens the union of the array's elements, which leaves `b` missing too. As in
    // TypeScript 7.1, y's `b?: undefined` takes y's own `b` and follows `a?: undefined`; tsc 7.0.2 kept
    // one per name, so it took x's `b` and came first.
    name: 'undefined properties of widened object literals from an element of an array literal',
    source: ['let x = [{ a: 0 }, { a: 1, b: "x" }][0];', 'let y = !true ? { a: 0, b: 0 } : { c: 1 };', 'y = 1;'],
    expected: [
      "/input.ts 2322 84 1 Type 'number' is not assignable to type '{ a: number; b: number; c?: undefined; } | { a?: undefined; b?: undefined; c: number; }'.",
    ],
    differsFromOracle: true,
  },
  {
    // The protected-base check reads the type of the containing class with getTypeOfNode, which gives a class
    // expression's constructor type, not its instance type. As in tsgo, `new Base()` in the class expression is an
    // error, and in the class declaration it is not.
    name: 'protected base constructors called in a class expression and in a class declaration',
    source: [
      'class Base {',
      '  protected constructor() {}',
      '}',
      'const Derived = class extends Base {',
      '  make() {',
      '    return new Base();',
      '  }',
      '};',
      'class Declared extends Base {',
      '  make() {',
      '    return new Base();',
      '  }',
      '}',
    ],
    expected: [
      "/input.ts 2674 103 10 Constructor of class 'Base' is protected and only accessible within the class declaration.",
    ],
  },
  {
    // 70 type parameters: the mappers of the tuple reference and of the call look their sources up in an index.
    name: 'instantiation with more than 64 type parameters',
    source: [
      `type T = [${Array.from({ length: 70 }, (_, i) => `"e${i}"`).join(', ')}];`,
      'declare const t: T;',
      'const a: 1 = t[0];',
      'const b: 1 = t[69];',
      `declare function f<${Array.from({ length: 70 }, (_, i) => `A${i}`).join(', ')}>(...args: [${Array.from({ length: 70 }, (_, i) => `A${i}`).join(', ')}]): [A69, A35, A0];`,
      `const r: 1 = f<${Array.from({ length: 70 }, (_, i) => `"x${i}"`).join(', ')}>(${Array.from({ length: 70 }, (_, i) => `"x${i}"`).join(', ')});`,
    ],
    expected: [
      "/input.ts 2322 517 1 Type '\"e0\"' is not assignable to type '1'.",
      "/input.ts 2322 536 1 Type '\"e69\"' is not assignable to type '1'.",
      '/input.ts 2322 1283 1 Type \'["x69", "x35", "x0"]\' is not assignable to type \'1\'.',
    ],
  },
  {
    name: 'implicit any from the widened return and yield types of functions',
    options: 'strictNullChecks=false',
    source: [
      'function f() { return null; }',
      'const g = function () { return undefined; };',
      'function* h() { yield null; }',
      'declare function id<T>(f: () => T): T;',
      'const i = id(() => null);',
      'const j: () => string = () => null;',
    ],
    expected: [
      "/input.ts 7010 9 1 'f', which lacks return-type annotation, implicitly has an 'any' return type.",
      "/input.ts 7011 36 1 Function expression, which lacks return-type annotation, implicitly has an 'any' return type.",
      "/input.ts 7055 85 1 'h', which lacks return-type annotation, implicitly has an 'any' yield type.",
      "/input.ts 7011 157 10 Function expression, which lacks return-type annotation, implicitly has an 'any' return type.",
    ],
  },
  {
    name: 'yield expressions in the extends clause of a class in a generator',
    source: ['function* g() {', '  class C extends (yield 1) {}', '}', 'const s: Generator<string> = g();'],
    expected: [
      "/input.ts 7057 35 5 'yield' expression implicitly results in an 'any' type because its containing generator lacks a return-type annotation.",
      "/input.ts 2322 55 1 Type 'Generator<number, void, unknown>' is not assignable to type 'Generator<string, any, any>'.",
    ],
  },
  {
    name: 'unreachable code that starts with a missing statement',
    options: 'allowUnreachableCode=false',
    corpus: 'compiler/reachabilityChecksNoCrash1.ts',
    codes: ['7027'],
    expected: ['/input.ts 7027 238 0 Unreachable code detected.'],
  },
  {
    name: 'number and string members of one enum',
    source: [
      "enum M { A, B = 'b' }",
      'const x: M.B = M.A;',
      'const y: M.A = M.B;',
      'declare let m: M;',
      'const z: M.B = m;',
    ],
    expected: [
      "/input.ts 2322 28 1 Type 'M.A' is not assignable to type 'M.B'.",
      "/input.ts 2322 48 1 Type 'M.B' is not assignable to type 'M.A'.",
      "/input.ts 2322 86 1 Type 'M' is not assignable to type 'M.B'.",
    ],
  },
  {
    name: 'generic value import type queries instantiate their signatures',
    source: [
      'declare module "factory" {',
      '  export function make<T>(value: T): T[];',
      '  export function pair<A, B = A>(a: A, b: B): [A, B];',
      '  export function keyed<K extends string>(key: K): { key: K };',
      '  export class Box<T> {',
      '    constructor(value: T);',
      '    value: T;',
      '  }',
      '}',
      'declare module "callable" {',
      '  function create<T>(value: T): { value: T };',
      '  export = create;',
      '}',
      'type MakeString = typeof import("factory").make<string>;',
      'const make1: MakeString = (value: string) => [value];',
      'const make2: MakeString = (value: number) => [value];',
      'type BoxOfNumber = typeof import("factory").Box<number>;',
      'declare const BoxCtor: BoxOfNumber;',
      'const box = new BoxCtor(1);',
      'const boxValue: string = box.value;',
      'const badBox = new BoxCtor("x");',
      'type PairDefault = typeof import("factory").pair<number>;',
      'const pair1: PairDefault = (a: number, b: number) => [a, b];',
      'type TooMany = typeof import("factory").make<string, number>;',
      'type BadKey = typeof import("factory").keyed<number>;',
      'type Created = typeof import("callable")<boolean>;',
      'const created: Created = (value: boolean) => ({ value });',
      'const createdBad: Created = (value: string) => ({ value });',
      'type Mapped = { [K in "a" | "b"]: typeof import("factory").make<K> };',
      'const mapped: Mapped = { a: (value: "a") => [value], b: (value: "b") => [value] };',
      'type MakeGeneric = typeof import("factory").make;',
      'const make3: MakeGeneric = <T>(value: T) => [value];',
      'const make4: MakeGeneric = (value: string) => [value];',
    ],
    expected: [
      "/input.ts 2322 469 5 Type '(value: number) => number[]' is not assignable to type '(value: string) => string[]'.",
      "/input.ts 2322 644 8 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2345 701 3 Argument of type 'string' is not assignable to parameter of type 'number'.",
      "/input.ts 2635 871 14 Type '<T>(value: T) => T[]' has no signatures for which the type argument list is applicable.",
      "/input.ts 2344 933 6 Type 'number' does not satisfy the constraint 'string'.",
      "/input.ts 2322 1057 10 Type '(value: string) => { value: string; }' is not assignable to type '(value: boolean) => { value: boolean; }'.",
      "/input.ts 2322 1373 5 Type '(value: string) => string[]' is not assignable to type '<T>(value: T) => T[]'.",
    ],
  },
];

test(
  'checker matches tsgo on small cases',
  { skip: !existsSync(libs) && 'needs upstream sources', timeout: 300_000 },
  () => {
    const out = compileSources('tsc-ts-check-', ['drivers/check.ts']);
    for (const {
      name,
      file: fileName = 'input.ts',
      options = '',
      source,
      corpus,
      codes,
      expected,
      differsFromOracle,
    } of cases) {
      const file =
        corpus !== undefined ? join(repo, 'upstream/TypeScript/tsc/testdata/tests/cases', corpus) : join(out, fileName);
      if (corpus === undefined) writeFileSync(file, source.join('\n') + '\n');
      const env = { ...process.env, TSC_TS_CHECK_OPTIONS: options };
      const actual = execFileSync(process.execPath, ['--stack-size=16000', join(out, 'drivers/check.js'), file, libs], {
        encoding: 'utf8',
        env,
      });
      const lines = actual.split('\n').filter((l) => l !== '');
      const compared = codes === undefined ? lines : lines.filter((l) => codes.includes(l.split(' ')[1]));
      assert.deepEqual(compared, expected, name);
      if (existsSync(oracle) && differsFromOracle !== true) {
        const reference = execFileSync(oracle, [file, libs], { encoding: 'utf8', env })
          .split('\n')
          .filter((l) => l !== '');
        assert.deepEqual(lines, reference, name + ' (oracle)');
      }
    }
  },
);
