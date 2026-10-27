import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cases, listFiles, materialize } from './parser-cases.mjs';
import { buildEmitDriver, compareEmits, emittable, isCommonJSHang, materializeGrouped, tsgo } from './emit-cases.mjs';
import { tempDir } from './temp.mjs';

// Every 25th test case.
function sample() {
  return [...listFiles(join(cases, 'compiler')), ...listFiles(join(cases, 'conformance'))].filter(
    (_, i) => i % 25 === 0,
  );
}

test(
  'emit matches tsgo on test cases',
  { skip: (!existsSync(tsgo) || !existsSync(cases)) && 'needs upstream sources and tsgo' },
  async () => {
    const command = buildEmitDriver();
    const units = materialize(sample(), 'tsc-ts-emit-test-').paths.filter(
      (unit) => emittable.test(unit.path) && !isCommonJSHang(unit),
    );
    const root = dirname(dirname(units[0].path));
    const paths = units.map((unit) => unit.path);
    for (const flags of [
      ['--sourceMap'],
      ['--removeComments'],
      ['--inlineSourceMap', '--inlineSources', '--newLine', 'crlf', '--emitBOM'],
      ['--sourceMap', '--sourceRoot', 'https://example.com/src', '--mapRoot', 'maps'],
      ['--module', 'commonjs', '--sourceMap'],
      ['--module', 'commonjs', '--importHelpers'],
      ['--module', 'nodenext'],
      ['--target', 'es2015'],
      ['--target', 'es2020', '--sourceMap'],
      ['--target', 'es2022', '--useDefineForClassFields', 'false'],
      ['--jsx', 'react'],
      ['--jsx', 'react-jsx', '--module', 'commonjs'],
      ['--experimentalDecorators', '--emitDecoratorMetadata', '--module', 'commonjs', '--sourceMap'],
    ]) {
      const result = await compareEmits(command, root, paths, flags, 8);
      assert.deepEqual(result.failures, [], `emitting with ${flags.join(' ')}`);
      assert.ok(result.units - result.unsupported > 400, 'enough units compared');
    }
  },
);

test(
  'emit matches tsgo on test cases laid out as packages',
  { skip: (!existsSync(tsgo) || !existsSync(cases)) && 'needs upstream sources and tsgo' },
  async () => {
    const command = buildEmitDriver();
    const dir = tempDir('tsc-ts-emit-packages-test-');
    const units = materializeGrouped(sample(), dir).filter((unit) => !isCommonJSHang(unit));
    for (const flags of [
      ['--module', 'commonjs'],
      ['--module', 'node16'],
    ]) {
      const result = await compareEmits(
        command,
        dir,
        units.map((unit) => unit.path),
        flags,
        8,
      );
      assert.deepEqual(result.failures, [], `emitting with ${flags.join(' ')}`);
      assert.ok(result.units > 400, 'enough units compared');
    }
  },
);

// Code with and without comments side by side: comment-like text in strings, regular expressions,
// templates and JSX text, comments right after tokens, and trailing comments where nested nodes end.
const commentPlacements = {
  strings: [
    'a.ts',
    [
      'const url = "http://example.com/*path*/"; // after a string',
      'const re = /\\/\\/x/g; /* after a regular expression */',
      'const t = `a // b ${1 /* inner */} c /* d */`;',
      'const q = a / b / c;',
      'f()//touching',
      'g() /* last */',
    ].join('\n'),
  ],
  statements: [
    'a.ts',
    [
      'function f(a: number, b: string): number {',
      '  return a + b.length; // at the end of a statement',
      '}',
      'export const x = f(1, "a") // before a continued expression',
      '  + 2;',
      'let p = 1, /* between */ q = 2;',
      'var v = [1, 2,',
      '  // inside a list',
      '  3];',
      'class C {',
      '  m() { return 1 } // after a method',
      '  /** doc */ n(): void {}',
      '  k = (x: number) => x * 2;',
      '}',
      'if (x) { f(1, "b") } /* after a block */ else { }',
      'call(a, b, (c) => { return c; }); // after nested calls',
      'const o = { a: 1, b: { c: 2 } } // no semicolon',
      'export default o; // last line without a line break',
    ].join('\n'),
  ],
  jsx: [
    'a.tsx',
    [
      'const e = <div className="x">http://a.b {/* inside */} // text, not a comment</div>;',
      'const g = <span>{value}</span>; // after JSX',
    ].join('\n'),
  ],
  types: [
    'a.ts',
    [
      'type T = { a: number }; // erased',
      'interface I { b: string } /* erased */',
      'let y: T = { a: 1 } /* after an annotated initializer */;',
      'function h(this: I, z: number /* parameter */): void {}',
      'enum E { A = 1, B /* member */ }',
      'namespace N { export const n = 1; } // namespace',
    ].join('\n'),
  ],
};

test(
  'emit places comments around code without comments as tsgo does',
  { skip: !existsSync(tsgo) && 'needs tsgo' },
  async () => {
    const command = buildEmitDriver();
    const dir = tempDir('tsc-ts-emit-comments-test-');
    const paths = [];
    for (const [unit, [name, text]] of Object.entries(commentPlacements)) {
      mkdirSync(join(dir, unit));
      paths.push(join(dir, unit, name));
      writeFileSync(paths.at(-1), text);
    }
    for (const flags of [[], ['--module', 'commonjs'], ['--target', 'es2015'], ['--jsx', 'react'], ['--sourceMap']]) {
      const result = await compareEmits(command, dir, paths, flags, 2);
      assert.deepEqual(result.failures, [], `emitting with ${flags.join(' ') || 'defaults'}`);
      assert.equal(result.units, paths.length);
    }
  },
);

/** Writes each `[unit, name, text]` as `dir/unit/name` and compares their emit, in one batch, with tsgo's. */
async function compareUnits(units, flagSets) {
  const command = buildEmitDriver();
  const dir = tempDir('tsc-ts-emit-units-test-');
  const paths = [];
  for (const [unit, name, text] of units) {
    mkdirSync(join(dir, unit), { recursive: true });
    paths.push(join(dir, unit, name));
    writeFileSync(paths.at(-1), text);
  }
  for (const flags of flagSets) {
    const result = await compareEmits(command, dir, paths, flags, 1);
    assert.deepEqual(result.failures, [], `emitting with ${flags.join(' ') || 'defaults'}`);
    assert.equal(result.units, new Set(units.map(([unit]) => unit)).size);
  }
}

test(
  'emit inlines the const enum members that accesses name as values, as tsgo does',
  { skip: !existsSync(tsgo) && 'needs tsgo' },
  async () => {
    await compareUnits(
      [
        ['global', 'g.ts', 'declare const enum E { A = 1, B }\n'],
        // The module's own `E` hides the global const enum.
        ['local', 'a.ts', 'let E = { A: 1 } as const;\nexport const o = { [E.A]: 1, b: E.A, c: E["A"] };\n'],
        ['uses', 'b.ts', 'export const v = E.B, w = E["A"];\n'],
        [
          'namespace',
          'c.ts',
          'namespace N { export const enum F { X = 3 } }\nexport const x = N.F.X, y = N.F["X"];\n' +
            'function f(N: { F: { X: number } }) { return N.F.X; }\nf;\n',
        ],
        // A namespace merged with an import has the members of the imported const enum.
        ['enum', 'enum.ts', 'export const enum Enum { One = 1 }\n'],
        [
          'merge',
          'merge.ts',
          'import { Enum } from "../enum/enum";\nnamespace Enum { export type Foo = number; }\nexport { Enum };\n',
        ],
        ['index', 'index.ts', 'import { Enum } from "../merge/merge";\nexport const one = Enum.One;\n'],
      ],
      [[], ['--module', 'commonjs']],
    );
  },
);

test(
  'emit elides imports that checking never resolves, as tsgo does',
  { skip: !existsSync(tsgo) && 'needs tsgo' },
  async () => {
    await compareUnits(
      [
        [
          'm',
          'm.ts',
          'export function foo(a: any, b: any, c: any) {}\nexport class A {}\nexport class B {}\n' +
            "export const s = 1, k = 'a', w = 1, x = {}, X = [1];\nexport function d(a: any, b?: any) {}\n",
        ],
        // A parameter decorator, which only experimentalDecorators allows.
        [
          'decorator',
          'a.ts',
          'import { foo, d } from "../m/m";\nexport class C { constructor(@foo p: any) {} m(@d q: any) {} }\n' +
            'export const e = class { @d m() {} };\n',
        ],
        ['shorthand', 'b.ts', 'import { s } from "../m/m";\nexport const o = { s = 5 };\n'],
        ['for', 'c.ts', 'import { X } from "../m/m";\nfor (var of X) {}\n'],
        ['computed', 'd.ts', 'import { k, x } from "../m/m";\nexport class C { [k in x] = 1; }\n'],
        [
          'heritage',
          'e.ts',
          'import { A, B } from "../m/m";\nexport class C extends A, B {}\nexport interface I extends B {}\n',
        ],
        ['with', 'g.ts', 'import { w } from "../m/m";\ndeclare const obj: any;\nwith (obj) { w; }\n'],
      ],
      [[], ['--experimentalDecorators'], ['--module', 'commonjs']],
    );
  },
);

test(
  'emit maps the temporary declaration of a flattened binding as tsgo does',
  { skip: !existsSync(tsgo) && 'needs tsgo' },
  async () => {
    await compareUnits(
      [
        ['empty', 'a.ts', 'declare const x: any;\nexport var {...{ }} = x;\n'],
        [
          'nested',
          'b.ts',
          'declare const y: any;\nexport var { a, ...{ b } } = y;\nexport let { c: [d], ...e } = y;\n',
        ],
      ],
      [
        ['--target', 'es2017', '--sourceMap'],
        ['--target', 'es2015', '--module', 'commonjs', '--sourceMap'],
      ],
    );
  },
);

test(
  'emit keeps imports of names that an export star also re-exports as values, as tsgo does',
  { skip: !existsSync(tsgo) && 'needs tsgo' },
  async () => {
    await compareUnits(
      [
        ['a', 'a.ts', 'export class A {}\nexport class B {}\n'],
        ['typeFirst', 'b.ts', 'export type * from "../a/a";\nexport * from "../a/a";\n'],
        ['valueFirst', 'c.ts', 'export * from "../a/a";\nexport type * from "../a/a";\n'],
        ['typeOnly', 'd.ts', 'export type * from "../a/a";\n'],
        ['chain', 'e.ts', 'export type * from "../typeOnly/d";\nexport * from "../a/a";\n'],
        ['through', 'f.ts', 'export * from "../typeOnly/d";\n'],
        [
          'uses',
          'g.ts',
          'import { A } from "../typeFirst/b";\nimport { B } from "../valueFirst/c";\n' +
            'import { A as D } from "../typeOnly/d";\nimport { B as E } from "../chain/e";\n' +
            'import { A as F } from "../through/f";\nnew A(); new B(); new D(); new E(); new F();\n',
        ],
      ],
      [
        ['--module', 'commonjs'],
        ['--module', 'esnext'],
      ],
    );
  },
);
