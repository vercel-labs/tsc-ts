// Emit with checker threads (parallel-check.ts `checkersEmit`) writes what one checker writes: each
// checker emits the files it checks, the main thread the files no checker checks (JSON, unchecked
// JavaScript), and the program reports the files in program order with the same diagnostics. Runs the
// tsc-ts under test (the Node build, or TSC_TS_BIN) with --singleThreaded and with checker threads in
// one directory, and compares stdout (with --listEmittedFiles), the exit status and every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bundledLibs = join(resolve(here, '../../..'), 'upstream/TypeScript/tsc/internal/bundled/libs');
const tsgo = join(resolve(here, '../../..'), 'packages/tsgo/dist/tsgo');
const tsgoMissing = !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo';

const files = {
  'src/shapes.ts':
    'export interface Shape { kind: string; size: number }\n' +
    'export const shapes = [{ kind: "a", size: 1 }, { kind: "b", size: 2, extra: true }];\n',
  'src/area.ts':
    'import { Shape, shapes } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
    'export const total = shapes.map(area).reduce((a, b) => a + b, 0);\n',
  'src/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
  'src/wrong.ts': 'export const n: number = "not a number";\n',
  'src/decorated.ts':
    'declare function d(...args: any[]): any;\nexport type Name = `n${string}`;\n' +
    'export class Model { @d name!: Name; @d run(@d at: Date): Promise<void> { return Promise.resolve(); } }\n',
  'src/data.json': '{ "name": "data", "values": [1, 2, 3] }\n',
  'src/plain.js': 'export function plain(a) { return a + 1; }\n',
  // Not checked, but its declarations take the checker's inferred types.
  'src/generated.ts':
    '// @ts-nocheck\nimport { shapes } from "./shapes";\n' +
    'export const pick = (n: number) => (n > 0 ? shapes[0] : { kind: "none", size: 0, missing: undefined });\n',
  'src/index.ts':
    'import data from "./data.json";\nimport { plain } from "./plain.js";\nimport { total } from "./area";\n' +
    'export * from "./hidden";\nexport * from "./decorated";\nexport * from "./generated";\n' +
    'export const summary = { name: data.name, total, next: plain(total) };\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      strict: true,
      types: [],
      module: 'commonjs',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowJs: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      listEmittedFiles: true,
      rootDir: 'src',
      outDir: 'out',
    },
    include: ['src'],
  }),
};

function readOutputs(dir, root = dir, outputs = {}) {
  if (!existsSync(dir)) return outputs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readOutputs(path, root, outputs);
    else outputs[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return outputs;
}

function run(cwd, args) {
  rmSync(join(cwd, 'out'), { recursive: true, force: true });
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(tscTs[0], [...tscTs.slice(1), '-p', '.', '--pretty', 'false', ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs },
      encoding: 'utf8',
    });
  } catch (error) {
    stdout = error.stdout;
    status = error.status;
  }
  return { stdout, status, outputs: readOutputs(join(cwd, 'out')) };
}

test('emit on checker threads matches emit on one checker', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-emit-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const expected = run(cwd, ['--singleThreaded']);
  assert.ok(expected.stdout.includes('TS4094'), 'a declaration error is reported');
  assert.ok(expected.stdout.includes('TS2322'), 'a type error is reported');
  assert.equal(Object.keys(expected.outputs).length, 31);
  for (const checkers of ['3']) {
    const actual = run(cwd, ['--checkers', checkers]);
    assert.equal(actual.stdout, expected.stdout, `stdout with --checkers ${checkers}`);
    assert.equal(actual.status, expected.status, `status with --checkers ${checkers}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with --checkers ${checkers}`);
  }
});

// Under `noEmitOnError` checker threads hold what they emit, and the main thread writes it only when
// there are no errors; with errors only the build info is written.
test('under noEmitOnError, emit on checker threads matches emit on one checker', { skip: tscTsMissing }, () => {
  const config = JSON.parse(files['tsconfig.json']);
  config.compilerOptions.noEmitOnError = true;
  config.compilerOptions.incremental = true;
  config.compilerOptions.tsBuildInfoFile = 'out/build.tsbuildinfo';
  const clean = { ...files, 'tsconfig.json': JSON.stringify(config) };
  delete clean['src/hidden.ts'];
  delete clean['src/wrong.ts'];
  clean['src/index.ts'] = clean['src/index.ts'].replace('export * from "./hidden";\n', '');
  for (const [project, withErrors] of [
    [clean, false],
    [{ ...files, 'tsconfig.json': JSON.stringify(config) }, true],
  ]) {
    const cwd = tempDir('tsc-ts-parallel-emit-no-emit-on-error-');
    for (const [path, content] of Object.entries(project)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const expected = run(cwd, ['--singleThreaded']);
    const outputs = Object.keys(expected.outputs);
    if (withErrors) assert.deepEqual(outputs, ['build.tsbuildinfo']);
    else assert.ok(outputs.length > 10 && outputs.includes('index.js'), `outputs: ${outputs.join(' ')}`);
    const actual = run(cwd, ['--checkers', '3']);
    assert.equal(actual.stdout, expected.stdout);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.outputs, expected.outputs);
  }
});

// With a program error (here TS5102: `baseUrl`, which TypeScript 7 removed), the report has no semantic diagnostics
// (getDiagnosticsOfProgram), so checker threads only emit the files, as one checker emits them without
// checking; under `noEmit` and `noEmitOnError` nothing is emitted and no thread starts.
test('with a program error, emit on checker threads matches emit on one checker', { skip: tscTsMissing }, () => {
  for (const extra of [{}, { noEmit: true }, { noEmitOnError: true }]) {
    const config = JSON.parse(files['tsconfig.json']);
    Object.assign(config.compilerOptions, { baseUrl: '.' }, extra);
    const cwd = tempDir('tsc-ts-parallel-emit-program-error-');
    for (const [path, content] of Object.entries({ ...files, 'tsconfig.json': JSON.stringify(config) })) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const expected = run(cwd, ['--singleThreaded']);
    assert.ok(expected.stdout.includes('TS5102'), 'the program error is reported');
    assert.ok(!expected.stdout.includes('TS2322'), 'no semantic error is reported');
    if (Object.keys(extra).length === 0) assert.equal(Object.keys(expected.outputs).length, 31);
    else assert.deepEqual(Object.keys(expected.outputs), []);
    const actual = run(cwd, ['--checkers', '3']);
    assert.equal(actual.stdout, expected.stdout, `stdout with ${JSON.stringify(extra)}`);
    assert.equal(actual.status, expected.status, `status with ${JSON.stringify(extra)}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with ${JSON.stringify(extra)}`);
  }
});

// Under `noEmit`, a program with declarations reports the errors of declaration emit when it has no other errors,
// as tsgo does. At `--checkers 1` in native builds, the declaration thread finds them while the main thread checks
// (`compileWithDeclarationThread`), and with checker threads each checker finds those of the files it checks.
test('under noEmit, declaration errors found on threads match those of one checker', { skip: tscTsMissing }, () => {
  const config = JSON.parse(files['tsconfig.json']);
  Object.assign(config.compilerOptions, { noEmit: true });
  const cwd = tempDir('tsc-ts-parallel-noemit-declarations-');
  for (const [path, content] of Object.entries({ ...files, 'tsconfig.json': JSON.stringify(config) })) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const expected = run(cwd, ['--singleThreaded']);
  assert.ok(!expected.stdout.includes('TS4094'), 'with a type error, no declaration error is reported');
  assert.ok(expected.stdout.includes('TS2322'), 'a type error is reported');
  assert.deepEqual(Object.keys(expected.outputs), []);
  for (const checkers of ['1', '3']) {
    const actual = run(cwd, ['--checkers', checkers]);
    assert.equal(actual.stdout, expected.stdout, `stdout with --checkers ${checkers}`);
    assert.equal(actual.status, expected.status, `status with --checkers ${checkers}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with --checkers ${checkers}`);
  }
  const traced = spawnSync(tscTs[0], [...tscTs.slice(1), '-p', '.', '--pretty', 'false', '--checkers', '1'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, TSC_TS_CHECKERS_TRACE: '1' },
    encoding: 'utf8',
  });
  assert.doesNotMatch(traced.stderr, /thread \d+ failed/);
  // Under Node.js, which copies what it posts, there is no declaration thread.
  if (/checkers: start/.test(traced.stderr))
    assert.match(traced.stderr, /checkers: emit-only thread 0 found the declaration errors of \d+ files/);
});

// A union's constituents tie in compareTypes when they differ only in their mappers, as two
// instantiations of one mapped type do, and are then ordered by type id, which follows the order in
// which the emitting checker created them. With one checker, `defs.ts` is checked first and creates
// `a` before `b`; with checker threads, the checker of `pick.ts` may not have checked `defs.ts`, and
// `pick.ts` needs `b` first. Declaration files are written in the same order either way.
test('declaration files are the same with any number of checkers', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-declaration-order-');
  const project = {
    'src/view.ts': 'export function view<F>(fields: F): { readonly [K in keyof F]: F[K] } {\n  return fields;\n}\n',
    'src/defs.ts':
      'import { view } from "./view";\n' +
      'export const a = view({ kind: "a" as const, x: 1 });\n' +
      'export const b = view({ kind: "b" as const, y: "s" });\n',
    'src/pick.ts':
      'import { a, b } from "./defs";\nexport const first = b;\nexport const pick = Math.random() > 0.5 ? a : b;\n',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        strict: true,
        types: [],
        module: 'commonjs',
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: 'src',
        outDir: 'out',
      },
      include: ['src'],
    }),
  };
  for (const [path, content] of Object.entries(project)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const expected = run(cwd, ['--singleThreaded']);
  assert.match(expected.outputs['pick.d.ts'], /pick: \{\n {4}readonly kind: "a";[^]*\} \| \{\n {4}readonly kind: "b";/);
  for (const checkers of ['2', '3', '4']) {
    const actual = run(cwd, ['--checkers', checkers]);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with --checkers ${checkers}`);
  }
});

// A program reports the global diagnostics found checking it, collected before it emits: serializing a
// declaration type can report one more (TS2589 on a type that only declaration emit expands), which is
// never reported, with any number of checkers. Those found checking files (TS2318 for a global type a
// generator needs) are.
test('global diagnostics found emitting declarations are not reported', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-declaration-globals-');
  const project = {
    'src/library.d.ts':
      'type Recursive<T> = T extends { value: unknown } ? Recursive<T> : T;\n' +
      'export declare const object: { property: Recursive<{ value: 1 }> };\n',
    'src/index.ts': 'import { object } from "./library";\nexport const result = object;\n',
    'src/other.ts': 'export const other = 1;\n',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        strict: true,
        types: [],
        module: 'esnext',
        moduleResolution: 'bundler',
        declaration: true,
        skipLibCheck: true,
        rootDir: 'src',
        outDir: 'out',
      },
      include: ['src'],
    }),
  };
  for (const [path, content] of Object.entries(project)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  for (const extra of [[], ['--noEmit']]) {
    const expected = run(cwd, ['--singleThreaded', ...extra]);
    assert.equal(expected.stdout, '');
    assert.equal(expected.status, 0);
    for (const checkers of ['1', '2', '4']) {
      const actual = run(cwd, ['--checkers', checkers, ...extra]);
      assert.equal(actual.stdout, expected.stdout, `stdout with --checkers ${checkers} ${extra.join(' ')}`);
      assert.equal(actual.status, expected.status, `status with --checkers ${checkers} ${extra.join(' ')}`);
      assert.deepEqual(actual.outputs, expected.outputs, `outputs with --checkers ${checkers} ${extra.join(' ')}`);
    }
  }
  // Emitting `index.ts`, scheduled first (the larger file), expands the type first and finds the error
  // with no location; a checker that forgot what emitting found checks no more files, so checking
  // `other.ts` still reports the error there.
  writeFileSync(
    join(cwd, 'src/index.ts'),
    project['src/index.ts'] + 'export const padding = [' + '1, '.repeat(200) + '];\n',
  );
  writeFileSync(
    join(cwd, 'src/other.ts'),
    'import { object } from "./library";\nexport const p: number = object.property;\n',
  );
  const located = run(cwd, ['--singleThreaded']);
  assert.match(located.stdout, /^src\/other\.ts\(2,26\): error TS2589: /);
  for (const checkers of ['2', '4']) {
    const actual = run(cwd, ['--checkers', checkers]);
    assert.equal(actual.stdout, located.stdout, `stdout with --checkers ${checkers}, the type expanded emitting first`);
    assert.equal(actual.status, located.status, `status with --checkers ${checkers}, the type expanded emitting first`);
  }
  writeFileSync(join(cwd, 'src/index.ts'), project['src/index.ts']);
  writeFileSync(join(cwd, 'src/other.ts'), 'export function* other() { yield 1; }\n');
  const missing = run(cwd, ['--singleThreaded', '--lib', 'es5']);
  assert.match(missing.stdout, /error TS2318: Cannot find global type 'IterableIterator'/);
  for (const checkers of ['2', '4']) {
    const actual = run(cwd, ['--checkers', checkers, '--lib', 'es5']);
    assert.equal(actual.stdout, missing.stdout, `stdout with --checkers ${checkers} --lib es5`);
    assert.equal(actual.status, missing.status, `status with --checkers ${checkers} --lib es5`);
  }
});

// Type text in diagnostics lists a union's constituents in the union's order, as tsgo does; only
// declaration files reorder the ones the union orders by type id (above). tsgo 7.1's message has `a | b`.
test('diagnostics list union constituents in the order tsgo does', { skip: tscTsMissing || tsgoMissing }, () => {
  const cwd = tempDir('tsc-ts-diagnostic-union-order-');
  const project = {
    'src/pick.ts':
      'function view<F>(fields: F): { readonly [K in keyof F]: F[K] } {\n  return fields;\n}\n' +
      'export const f = (): number => {\n' +
      "  const a = view({ kind: 'a' as const, x: 1 });\n  const n: number = Math.random() > 0.5 ? a : b;\n" +
      '  return n;\n};\n' +
      "const b = view({ kind: 'b' as const, y: 's' });\n",
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', strict: true, types: [], declaration: true, rootDir: 'src', outDir: 'out' },
      include: ['src'],
    }),
  };
  for (const [path, content] of Object.entries(project)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const actual = run(cwd, ['--singleThreaded']);
  rmSync(join(cwd, 'out'), { recursive: true, force: true });
  const expected = spawnSync(tsgo, ['-p', '.', '--pretty', 'false', '--singleThreaded'], { cwd, encoding: 'utf8' });
  assert.match(expected.stdout, /Type '\{ readonly kind: "a"; readonly x: number; \} \| \{ readonly kind: "b";/);
  assert.equal(actual.stdout, expected.stdout);
  assert.equal(actual.status, expected.status);
});

// A thread that fails leaves its files to the main thread, so the output alone doesn't show it: the threads' trace
// does. In native builds this runs parse and checker threads, under Node.js checker threads.
test('parse and checker threads start and finish without failing', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-threads-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const result = spawnSync(tscTs[0], [...tscTs.slice(1), '-p', '.', '--pretty', 'false', '--checkers', '3'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, TSC_TS_CHECKERS_TRACE: '1' },
    encoding: 'utf8',
  });
  assert.match(result.stderr, /checkers: finished/);
  assert.doesNotMatch(result.stderr, /thread \d+ failed/);
});

// At `--checkers 1` in native builds, threads without a checker emit the JavaScript of the program
// (parallel-emit.ts) while the main thread checks it, and a declaration thread, a checker thread that only emits,
// emits the declarations and the files with decorator metadata. Without declarations, a second wave of threads
// emits those files with the serialization kinds the main thread's checker recorded. With checker threads, the
// declaration thread emits the declarations while they check. Const enum values come from other files: their
// enums, those they re-export or compute members from, a package's declarations and a global declaration. The
// padding makes the program emit enough for threads (`littleEmitText`).
const constEnumFiles = {
  'src/enums.ts':
    'export const enum Flags { None = 0, A = 1 << 0, B = 1 << 1, AB = A | B, Neg = -1, Big = 2 ** 40 }\n' +
    'export const enum Names { First = "first", Quote = "it\'s \\"q\\"\\n", Joined = `${First}-${Quote}` }\n' +
    'export enum Regular { X = 3, Y = X * 2 }\n' +
    'export namespace Space { export const enum Inner { Deep = Flags.AB + 10 } }\n',
  'src/derived.ts':
    'import { Flags } from "./enums";\nexport const enum Derived { C = Flags.AB << 2, E = Flags.B | C }\n',
  'src/reexport.ts': 'export { Flags as Renamed, Space } from "./enums";\nexport * from "./derived";\n',
  'src/globals.d.ts': 'declare const enum Global { Q = 7, R = Q + 1 }\n',
  'node_modules/ambient/package.json': '{ "name": "ambient", "types": "index.d.ts" }\n',
  'node_modules/ambient/index.d.ts': 'export declare const enum Ambient { Z = 42, W = "w" }\n',
  'src/use.ts':
    'import { Flags, Names, Regular, Space } from "./enums";\nimport * as all from "./enums";\n' +
    'import { Renamed, Derived } from "./reexport";\nimport type { Flags as Only } from "./enums";\n' +
    'import { Ambient } from "ambient";\n' +
    'export const values = [Flags.A, Flags["B"], Flags.AB, Flags.Neg, Flags.Big, Names.Quote, Names.Joined,\n' +
    '  Regular.Y, Space.Inner.Deep, all.Flags.B, all.Space.Inner.Deep, Renamed.AB, Derived.C, Derived.E,\n' +
    '  Global.Q, Global.R, Ambient.Z, Ambient.W];\n' +
    'export function pick(f: Only) { return f === Flags.A ? Names.First : Ambient.W; }\n',
  'src/decorated.ts':
    'import { Flags } from "./enums";\nimport { Regular } from "./enums";\n' +
    'declare function d(...args: any[]): any;\n' +
    'export class Model { @d flags: Flags = Flags.AB; @d run(@d at: Date, r: Regular): Promise<void> { return Promise.resolve(); } }\n',
  'src/data.json': '{ "name": "data", "values": [1, 2, 3] }\n',
  'src/plain.js': 'export function plain(a) { return a + 1; }\n',
  'src/index.ts':
    'import data from "./data.json";\nimport { plain } from "./plain.js";\n' +
    'export * from "./use";\nexport * from "./decorated";\nexport const summary = { name: data.name, next: plain(1) };\n',
  'src/padding.ts':
    'import { Flags } from "./enums";\nimport { Derived } from "./reexport";\n' +
    Array.from(
      { length: 800 },
      (_, k) => `export function pad${k}(n: number) { return n + ${k} + Flags.A + Derived.E; }\n`,
    ).join(''),
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      strict: true,
      types: [],
      module: 'commonjs',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowJs: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      listEmittedFiles: true,
      rootDir: 'src',
      outDir: 'out',
    },
    include: ['src'],
  }),
};

test('JavaScript emit on emit threads matches emit on one thread', { skip: tscTsMissing }, () => {
  for (const extra of [
    {},
    { emitDecoratorMetadata: false },
    { module: 'esnext', preserveConstEnums: true, declaration: false, declarationMap: false },
  ]) {
    const config = JSON.parse(constEnumFiles['tsconfig.json']);
    Object.assign(config.compilerOptions, extra);
    const cwd = tempDir('tsc-ts-parallel-js-emit-');
    for (const [path, content] of Object.entries({ ...constEnumFiles, 'tsconfig.json': JSON.stringify(config) })) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const expected = run(cwd, ['--singleThreaded']);
    assert.equal(expected.status, 0, expected.stdout);
    assert.match(expected.outputs['use.js'], /42 \/\* Ambient\.Z \*\//);
    assert.match(expected.outputs['use.js'], /14 \/\* Derived\.E \*\//);
    assert.match(expected.outputs['padding.js'], /13 \/\* Space\.Inner\.Deep \*\/|14 \/\* Derived\.E \*\//);
    for (const checkers of ['1', '2', '4']) {
      const actual = run(cwd, ['--checkers', checkers]);
      const label = `${JSON.stringify(extra)} with --checkers ${checkers}`;
      assert.equal(actual.stdout, expected.stdout, `stdout ${label}`);
      assert.equal(actual.status, expected.status, `status ${label}`);
      assert.deepEqual(actual.outputs, expected.outputs, `outputs ${label}`);
    }
  }
});

// The threads' trace shows that they emitted the files and none failed, which the output alone doesn't (the main
// thread emits what a failed thread didn't).
test('emit threads start and finish without failing', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-js-emit-threads-');
  for (const [path, content] of Object.entries(constEnumFiles)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const traced = (args) => {
    const result = spawnSync(tscTs[0], [...tscTs.slice(1), '-p', '.', '--pretty', 'false', ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, TSC_TS_CHECKERS_TRACE: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stderr, /thread \d+ failed/);
    let emitted = 0;
    let withKinds = 0;
    const lines = /emit threads: thread \d+ emitted (\d+) files( with metadata kinds \((\d+) missed)?/g;
    for (const match of result.stderr.matchAll(lines)) {
      if (match[2] === undefined) emitted += Number(match[1]);
      else {
        withKinds += Number(match[1]);
        assert.equal(match[3], '0', 'no file missed a recorded kind');
      }
    }
    const declarationThread = /checkers: emit-only thread 0 emitted (\d+) files/.exec(result.stderr);
    return { stderr: result.stderr, emitted, withKinds, declarationThread };
  };
  // With declarations, the declaration thread emits them and the decorated file; without, the second wave
  // emits the decorated file.
  const withDeclarations = traced(['--checkers', '1']);
  // Under Node.js, which copies what it posts, there are no emit threads.
  if (!/emit threads:/.test(withDeclarations.stderr)) return;
  // Every file but the declaration file and the decorated file.
  assert.equal(withDeclarations.emitted, 8);
  assert.equal(withDeclarations.withKinds, 0);
  assert.ok(withDeclarations.declarationThread !== null, 'a declaration thread emitted');
  const withoutDeclarations = traced(['--checkers', '1', '--declaration', 'false', '--declarationMap', 'false']);
  assert.equal(withoutDeclarations.emitted, 8);
  assert.equal(withoutDeclarations.withKinds, 1);
  assert.equal(withoutDeclarations.declarationThread, null);
  // With checker threads, the declaration thread emits the declarations while they check, when it has a CPU of its
  // own (`declarationThreadPays`): with 2 checkers, on more than 2 CPUs.
  const withCheckers = traced(['--checkers', '2']);
  if (availableParallelism() > 2)
    assert.ok(withCheckers.declarationThread !== null, 'a declaration thread emitted with checkers');
  else assert.equal(withCheckers.declarationThread, null, 'no declaration thread without a CPU of its own');
});

// Incremental programs and `tsc -b` projects that emit every file emit their JavaScript on emit threads too, the
// declaration thread emitting their declarations: an incremental program without build info, and a project of
// `tsc -b` without build info or that isn't incremental. Their outputs and build info, with its signatures,
// emit signatures and latest changed declaration file, are what one thread writes.
function writeProject(cwd, projectFiles) {
  for (const [path, content] of Object.entries(projectFiles)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
}

function runTraced(cwd, args) {
  const result = spawnSync(tscTs[0], [...tscTs.slice(1), ...args, '--pretty', 'false'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, TSC_TS_CHECKERS_TRACE: '1' },
    encoding: 'utf8',
  });
  let emitted = 0;
  for (const match of result.stderr.matchAll(/emit threads: thread \d+ emitted (\d+) files/g))
    emitted += Number(match[1]);
  assert.doesNotMatch(result.stderr, /thread \d+ failed/);
  // Status lines of `tsc -b` start with the time.
  const stdout = result.stdout.replace(/\d{1,2}:\d{2}:\d{2}( [AP]M)?/g, '<time>');
  return { stdout, status: result.status, emitted };
}

// Native builds start emit threads where there is more than one CPU; under Node.js, which copies what it posts,
// there are none.
const emitsOnThreads = tscTs[0] !== process.execPath && availableParallelism() > 1;

const incrementalConfigs = [
  { incremental: true, tsBuildInfoFile: 'out/tsconfig.tsbuildinfo' },
  { incremental: true, tsBuildInfoFile: 'out/tsconfig.tsbuildinfo', declaration: false, declarationMap: false },
  { composite: true, tsBuildInfoFile: 'out/tsconfig.tsbuildinfo', include: ['src', 'src/*.json'] },
];

test('incremental programs without build info emit on emit threads as on one thread', { skip: tscTsMissing }, () => {
  for (const extra of incrementalConfigs) {
    const config = JSON.parse(constEnumFiles['tsconfig.json']);
    const { include, ...options } = extra;
    Object.assign(config.compilerOptions, options);
    if (include !== undefined) config.include = include;
    const cwd = tempDir('tsc-ts-parallel-incremental-emit-');
    writeProject(cwd, { ...constEnumFiles, 'tsconfig.json': JSON.stringify(config) });
    const outputs = (args) => {
      rmSync(join(cwd, 'out'), { recursive: true, force: true });
      const result = runTraced(cwd, ['-p', '.', ...args]);
      return { ...result, outputs: readOutputs(join(cwd, 'out')) };
    };
    const expected = outputs(['--singleThreaded']);
    assert.equal(expected.status, 0, expected.stdout);
    const label = JSON.stringify(extra);
    assert.ok(expected.outputs['tsconfig.tsbuildinfo'] !== undefined, `build info ${label}`);
    const actual = outputs(['--checkers', '1']);
    if (emitsOnThreads) assert.ok(actual.emitted > 0, `files emitted on emit threads ${label}`);
    assert.equal(actual.stdout, expected.stdout, `stdout ${label}`);
    assert.equal(actual.status, expected.status, `status ${label}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs ${label}`);
  }
});

test('tsc -b emits on emit threads as on one thread', { skip: tscTsMissing }, () => {
  const library = {
    'lib/src/lib.ts':
      'export const enum Level { Low = 1, High = 2 }\nexport function level(n: number) { return n > 1 ? Level.High : Level.Low; }\n',
    'lib/tsconfig.json': JSON.stringify({
      compilerOptions: {
        composite: true,
        strict: true,
        types: [],
        rootDir: 'src',
        outDir: 'out',
        tsBuildInfoFile: 'out/tsconfig.tsbuildinfo',
      },
      include: ['src'],
    }),
  };
  // The last project isn't incremental: `tsc -b` writes its build info next to its config.
  for (const extra of [...incrementalConfigs, { tsBuildInfoFile: undefined }]) {
    const config = JSON.parse(constEnumFiles['tsconfig.json']);
    const { include, ...options } = extra;
    Object.assign(config.compilerOptions, options);
    delete config.compilerOptions.listEmittedFiles;
    config.include = include ?? config.include;
    config.references = [{ path: '../lib' }];
    const app = {};
    for (const [path, content] of Object.entries(constEnumFiles)) app[`app/${path}`] = content;
    app['app/src/level.ts'] =
      'import { Level, level } from "../../lib/src/lib";\nexport const high = level(2) === Level.High;\n';
    app['app/tsconfig.json'] = JSON.stringify(config);
    const cwd = tempDir('tsc-ts-parallel-build-emit-');
    writeProject(cwd, {
      ...library,
      ...app,
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'app' }] }),
    });
    // Each project's outputs, and build info written next to its config.
    const projectOutputs = (project) => {
      const result = readOutputs(join(cwd, project, 'out'));
      for (const name of readdirSync(join(cwd, project)))
        if (name.endsWith('.tsbuildinfo')) result[name] = readFileSync(join(cwd, project, name), 'utf8');
      return result;
    };
    const outputs = (args, clean = true) => {
      if (clean)
        for (const project of ['lib', 'app']) {
          rmSync(join(cwd, project, 'out'), { recursive: true, force: true });
          rmSync(join(cwd, project, 'tsconfig.tsbuildinfo'), { force: true });
        }
      const result = runTraced(cwd, ['-b', '.', '--verbose', ...args]);
      return { ...result, outputs: { lib: projectOutputs('lib'), app: projectOutputs('app') } };
    };
    const label = JSON.stringify(extra);
    const expected = outputs(['--singleThreaded']);
    assert.equal(expected.status, 0, expected.stdout);
    assert.ok(
      Object.keys(expected.outputs.app).some((name) => name.endsWith('.tsbuildinfo')),
      `build info ${label}`,
    );
    const actual = outputs(['--checkers', '1']);
    if (emitsOnThreads) assert.ok(actual.emitted > 0, `files emitted on emit threads ${label}`);
    assert.equal(actual.stdout, expected.stdout, `stdout ${label}`);
    assert.equal(actual.status, expected.status, `status ${label}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs ${label}`);
    // A rebuild after a change: an incremental project emits what changed on this thread, and one that isn't
    // incremental emits every file again, on emit threads.
    const rebuild = (args) => {
      outputs(['--singleThreaded']);
      const edited = join(cwd, 'app/src/level.ts');
      writeFileSync(edited, app['app/src/level.ts'] + 'export const low = level(0);\n');
      // Newer than the outputs, which a time stamp of the same tick isn't.
      const later = Date.now() / 1000 + 10;
      utimesSync(edited, later, later);
      const result = outputs(args, false);
      writeFileSync(join(cwd, 'app/src/level.ts'), app['app/src/level.ts']);
      return result;
    };
    const expectedRebuild = rebuild(['--singleThreaded']);
    const actualRebuild = rebuild(['--checkers', '1']);
    if (emitsOnThreads)
      assert.equal(actualRebuild.emitted > 0, extra.tsBuildInfoFile === undefined, `rebuild on emit threads ${label}`);
    assert.equal(actualRebuild.stdout, expectedRebuild.stdout, `rebuild stdout ${label}`);
    assert.equal(actualRebuild.status, expectedRebuild.status, `rebuild status ${label}`);
    assert.deepEqual(actualRebuild.outputs, expectedRebuild.outputs, `rebuild outputs ${label}`);
  }
});

// A cold build whose pending emit has no JavaScript (`emitDeclarationOnly`) is emitted and reported on the main
// thread once, as with one thread, though the program has enough text for emit threads.
test('declaration-only incremental builds emit and report once', { skip: tscTsMissing }, () => {
  const config = JSON.parse(constEnumFiles['tsconfig.json']);
  Object.assign(config.compilerOptions, {
    incremental: true,
    tsBuildInfoFile: 'out/tsconfig.tsbuildinfo',
    emitDeclarationOnly: true,
  });
  delete config.compilerOptions.listEmittedFiles;
  const cwd = tempDir('tsc-ts-parallel-declaration-only-');
  writeProject(cwd, {
    ...constEnumFiles,
    'src/wrong.ts': 'export const wrong: number = "not a number";\n',
    'tsconfig.json': JSON.stringify(config),
  });
  for (const mode of [
    ['-b', '.', '--verbose'],
    ['-p', '.'],
  ]) {
    const outputs = (args) => {
      rmSync(join(cwd, 'out'), { recursive: true, force: true });
      const result = runTraced(cwd, [...mode, ...args]);
      return { ...result, outputs: readOutputs(join(cwd, 'out')) };
    };
    const label = mode.join(' ');
    const expected = outputs(['--singleThreaded']);
    assert.equal(expected.stdout.match(/TS2322/g)?.length, 1, `one error ${label}`);
    assert.ok(expected.outputs['tsconfig.tsbuildinfo'] !== undefined, `build info ${label}`);
    const actual = outputs(['--checkers', '1']);
    assert.equal(actual.emitted, 0, `nothing emitted on emit threads ${label}`);
    assert.equal(actual.stdout, expected.stdout, `stdout ${label}`);
    assert.equal(actual.status, expected.status, `status ${label}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs ${label}`);
  }
});
