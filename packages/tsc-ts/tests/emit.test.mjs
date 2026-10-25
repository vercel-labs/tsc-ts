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
