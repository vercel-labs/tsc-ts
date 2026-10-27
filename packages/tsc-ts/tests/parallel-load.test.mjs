// Parse threads (parallel-parse.ts) record what their FileLoader found loading each file they
// prepare, and the program's FileLoader takes it instead of resolving the file's references,
// imports and type directives again. The program must be the one it would load on its own: the
// same files in the same order, include reasons, resolutions and diagnostics. Here one parse thread
// object prepares the files on this thread; its batches are published (frozen under Node.js), as
// they are when they come from a thread, so taking them must not write into them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compileSources('tsc-ts-parallel-load-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem, parseThreadOfCommandLine } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');
const { ParseQueue, parallelParse } = await load('compiler/parallel-parse.js');
const { PackageJsonLookup } = await load('compiler/package-json.js');
const { useLazyJSDocTable } = await load('compiler/parser.js');
const { parseLocale } = await load('compiler/diagnostics.js');
const { assignSymbolIdsAtCreation } = await load('compiler/symbol.js');
const { ConfigParser } = await load('compiler/tsconfig.js');
const { CachedFileSystem } = await load('compiler/file-system.js');
const { SystemFileSystem } = await load('compiler/tsc-cli.js');
const { CompilerHost, FileLoader } = await load('compiler/file-loader.js');
const { Program } = await load('compiler/program.js');

const Root = 0;
const Library = 2;
const AutomaticTypes = 3;

function project() {
  const dir = tempDir('tsc-ts-parallel-load-project-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'nodenext',
        jsx: 'react-jsx',
        importHelpers: true,
        lib: ['es2022', 'dom'],
        types: ['present'],
      },
      include: ['src'],
    }),
    'node_modules/@types/present/package.json': JSON.stringify({ name: '@types/present', types: 'index.d.ts' }),
    'node_modules/@types/present/index.d.ts': 'declare const present: number;\n',
    'node_modules/heavy/package.json': JSON.stringify({ name: 'heavy', version: '1.0.0', types: 'index.d.ts' }),
    'node_modules/heavy/index.d.ts': "export * from './more';\nexport declare const a0: number;\n",
    'node_modules/heavy/more.d.ts': 'export declare const b0: string;\n',
    'node_modules/tslib/package.json': JSON.stringify({ name: 'tslib', version: '2.0.0', types: 'tslib.d.ts' }),
    'node_modules/tslib/tslib.d.ts': 'export declare function __assign(t: any, ...sources: any[]): any;\n',
    'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '19.0.0' }),
    'node_modules/react/jsx-runtime.d.ts':
      'export declare function jsx(type: any, props: any): any;\n' +
      'export declare namespace JSX { interface IntrinsicElements { div: { id?: string } } type Element = any; }\n',
    'src/a.ts':
      '/// <reference types="missing-types" />\n' +
      '/// <reference path="./missing.ts" />\n' +
      '/// <reference path="./ref.ts" />\n' +
      '/// <reference lib="es2023.array" />\n' +
      "import { a0, b0 } from 'heavy';\n" +
      "import { view } from './b.js';\n" +
      "import type {} from 'not-installed';\n" +
      'export const x = { ...{ a0 }, b0, view, present, last: [1].findLast((n) => n > 0) };\n',
    'src/b.tsx': "export const view = <div id='v' />;\nexport const wrong: string = 1;\n",
    'src/ref.ts': 'declare const referenced: string;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** Everything about a program that loading decides, as text. */
function describe(program) {
  const locale = parseLocale('en');
  const diagnostic = (d) => `${d.file?.fileName ?? ''}:${d.pos}-${d.end}:${d.code}:${d.args.join(',')}`;
  const checked = new CheckedProgram(program);
  const lines = [program.explainFiles(locale)];
  for (const d of program.getProgramDiagnostics()) lines.push('program ' + diagnostic(d));
  for (const file of program.getSourceFiles()) {
    lines.push(
      'file ' +
        file.fileName +
        ' ' +
        JSON.stringify(program.sourceFileMetadata(file.path)) +
        (program.isSourceFileFromExternalLibrary(file) ? ' external' : ''),
    );
    const resolutions = program.processed.resolvedModules.get(file.path);
    for (const [key, resolved] of resolutions?.entries() ?? [])
      lines.push(`  module ${key} ${resolved.resolvedFileName} ${resolved.isExternalLibraryImport}`);
    const types = program.processed.typeResolutionsInFile.get(file.path);
    for (const [key, resolved] of types?.entries() ?? []) lines.push(`  types ${key} ${resolved.resolvedFileName}`);
    for (const d of program.getIncludeProcessorDiagnostics(file)) lines.push('  include ' + diagnostic(d));
    for (const d of checked.semanticDiagnosticsOfFile(file)) lines.push('  semantic ' + diagnostic(d));
  }
  return lines.join('\n');
}

test('the program takes what parse threads found loading their files and is the same program', () => {
  const dir = project();
  const args = ['-p', dir];
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);

  // Load every file ahead on one parse thread object, as startParallelParse hands them out.
  assignSymbolIdsAtCreation();
  useLazyJSDocTable();
  const thread = parseThreadOfCommandLine(args, join(dir, 'tsconfig.json'), bundledLibs);
  const queue = new ParseQueue();
  for (const name of ['src/a.ts', 'src/b.tsx', 'src/ref.ts']) queue.push(Root, join(dir, name), 0);
  queue.push(Library, 'lib.es2022.d.ts', 0);
  queue.push(Library, 'lib.dom.d.ts', 0);
  queue.push(AutomaticTypes, '', 0);
  let recorded = 0;
  for (let chunk = queue.next(1); chunk !== undefined; chunk = queue.next(1)) {
    const batch = thread.load(chunk);
    assert.ok(Object.isFrozen(batch));
    for (const prepared of batch.files) {
      parallelParse.files.set(prepared.fileName, prepared);
      if (prepared.loaded !== undefined) recorded++;
    }
    for (let k = 0; k < batch.added.names.length; k++)
      queue.push(batch.added.kinds[k], batch.added.names[k], batch.added.depths[k]);
    const lookups = batch.packageJsons;
    for (let k = 0; k < lookups.directories.length; k++)
      parallelParse.packageJsons.push(
        new PackageJsonLookup(lookups.directories[k], lookups.exists[k], lookups.directoryExists[k]),
      );
  }

  const shared = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(shared.kind, 'compile');
  const files = shared.program.getSourceFiles().length;
  assert.equal(parallelParse.used, files);
  assert.equal(recorded, parallelParse.files.size);
  assert.equal(describe(shared.program), expected);
  // The program took every prepared file, so with the parse thread's lookups it has the
  // \`package.json\` lookups resolving everything itself makes, which build info records.
  const lookups = (program) =>
    [
      ...new Set(program.packageJsonLookups().map((l) => `${l.packageDirectory} ${l.exists} ${l.directoryExists}`)),
    ].sort();
  assert.ok(shared.program.hasAllPackageJsonLookups());
  assert.deepEqual(lookups(shared.program), lookups(plain.program));
  assert.ok(lookups(plain.program).some((l) => l.includes('node_modules/heavy true')));
  // The fixture exercises what loading records: a JSX runtime import, import helpers, missing
  // references and type directives, a library reference and a package.
  assert.match(expected, /react\/jsx-runtime\.d\.ts/);
  assert.match(expected, /tslib\.d\.ts/);
  assert.match(expected, /lib\.es2023\.array\.d\.ts/);
  assert.match(expected, /include .*a\.ts:\d+-\d+:2688:missing-types/);
  assert.match(expected, /include .*a\.ts:\d+-\d+:6053:/);
});

// While parse threads load files, the program's FileLoader takes each batch as it comes
// (`FileLoader.walkAhead`): work that would parse a file not prepared yet waits for the batch with it.
// One file per chunk here, in the order the queue hands them out, so that files come before the files
// they import, and libraries before the root files. Returns the program, and how many prepared files
// the loader took before the program loaded.
function loadBatchByBatch(dir, libraries) {
  const args = ['-p', dir];
  assignSymbolIdsAtCreation();
  useLazyJSDocTable();
  const sys = createNodeSystem(bundledLibs, '');
  const fs = new CachedFileSystem(new SystemFileSystem(sys));
  const errors = [];
  const config = new ConfigParser(fs, sys.currentDirectory).parseConfigFile(
    join(dir, 'tsconfig.json'),
    undefined,
    undefined,
    errors,
  );
  assert.deepEqual(errors, []);
  const host = new CompilerHost(fs, sys.currentDirectory, sys.defaultLibraryPath);
  const loader = new FileLoader(host, config);
  const thread = parseThreadOfCommandLine(args, join(dir, 'tsconfig.json'), bundledLibs);
  const queue = new ParseQueue();
  for (const name of libraries) queue.push(Library, name, 0);
  queue.push(AutomaticTypes, '', 0);
  for (const name of config.fileNames) queue.push(Root, name, 0);
  let rootFilesAdded = false;
  for (let chunk = queue.next(100); chunk !== undefined; chunk = queue.next(100)) {
    assert.equal(chunk.names.length, 1);
    const batch = thread.load(chunk);
    for (const prepared of batch.files) parallelParse.files.set(prepared.fileName, prepared);
    for (let k = 0; k < batch.added.names.length; k++)
      queue.push(batch.added.kinds[k], batch.added.names[k], batch.added.depths[k]);
    const lookups = batch.packageJsons;
    for (let k = 0; k < lookups.directories.length; k++)
      parallelParse.packageJsons.push(
        new PackageJsonLookup(lookups.directories[k], lookups.exists[k], lookups.directoryExists[k]),
      );
    if (!rootFilesAdded) rootFilesAdded = loader.addRootFiles(1);
    loader.walkAhead(batch.files);
  }
  const takenAhead = parallelParse.used;
  return { program: new Program(config, host, loader), takenAhead };
}

test('a program loaded batch by batch while files are prepared is the same program', () => {
  const dir = project();
  clearPrepared();
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);

  const { program, takenAhead } = loadBatchByBatch(dir, ['lib.es2022.d.ts', 'lib.dom.d.ts']);
  assert.ok(takenAhead > 0);
  assert.equal(parallelParse.used, program.getSourceFiles().length);
  assert.equal(describe(program), expected);
  assert.ok(program.hasAllPackageJsonLookups());
});

// The depth at which a file is first loaded decides the depth of the files it adds, and with it which
// JavaScript files in node_modules are within maxNodeModuleJsDepth. In tsgo's order the second root
// loads x.js at depth 1, so y.js, which x.js imports, is at depth 2 and loaded; loaded first through
// the first root's package, x.js would be at depth 2 and y.js past the limit. The batches come in the
// order that loads the first root's package first, and walking ahead keeps tsgo's order.
test('a program loaded batch by batch is the same program when files are reached at other depths', () => {
  const dir = tempDir('tsc-ts-parallel-load-depths-');
  const pkg = (name) => JSON.stringify({ name, version: '1.0.0', main: 'index.js' });
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true, maxNodeModuleJsDepth: 2, noEmit: true, lib: ['es2022'], types: [] },
      include: ['src'],
    }),
    'src/a.ts': "import 'outer';\n",
    'src/b.ts': "import 'x';\n",
    'node_modules/outer/package.json': pkg('outer'),
    'node_modules/outer/index.js': "import 'x';\n",
    'node_modules/x/package.json': pkg('x'),
    'node_modules/x/index.js': "import 'y';\n",
    'node_modules/y/package.json': pkg('y'),
    'node_modules/y/index.js': 'export const y = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  clearPrepared();
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);
  assert.match(expected, /node_modules\/y\/index\.js/);

  const { program, takenAhead } = loadBatchByBatch(dir, ['lib.es2022.d.ts']);
  assert.ok(takenAhead > 0);
  assert.equal(describe(program), expected);
});

// With allowJs, a JavaScript file in node_modules past maxNodeModuleJsDepth is not loaded, and no
// parse thread prepares it: walking ahead goes past an import of one instead of waiting for it, so the
// loader takes every prepared file before the program loads. The roots' work runs last root first, so
// b.ts's import comes before a.ts and c.ts.
test('walking ahead does not wait for a JavaScript file past maxNodeModuleJsDepth', () => {
  const dir = tempDir('tsc-ts-parallel-load-elided-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true, noEmit: true, lib: ['es2022'], types: [] },
      include: ['src'],
    }),
    'src/a.ts': "import { c } from './c';\nexport const a = c;\n",
    'src/b.ts': "import 'untyped';\nexport const b = 1;\n",
    'src/c.ts': 'export const c = 1;\n',
    'node_modules/untyped/package.json': JSON.stringify({ name: 'untyped', version: '1.0.0', main: 'index.js' }),
    'node_modules/untyped/index.js': 'exports.u = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  clearPrepared();
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);
  assert.ok(!plain.program.getSourceFiles().some((file) => file.fileName.includes('untyped')));

  const { program, takenAhead } = loadBatchByBatch(dir, ['lib.es2022.d.ts']);
  assert.equal(takenAhead, program.getSourceFiles().length);
  assert.equal(describe(program), expected);
});

function clearPrepared() {
  parallelParse.files.clear();
  parallelParse.used = 0;
  parallelParse.missed = 0;
  parallelParse.unprepared = 0;
  parallelParse.taken.clear();
  parallelParse.packageJsons.length = 0;
}

test('a source file of a referenced project loaded ahead queues the file it is redirected to', () => {
  const dir = tempDir('tsc-ts-parallel-load-references-');
  const files = {
    'lib/tsconfig.json': JSON.stringify({
      compilerOptions: { composite: true, outDir: 'out', rootDir: 'src', lib: ['es2022'] },
      include: ['src'],
    }),
    'lib/src/index.ts': 'export const v = 1;\n',
    'lib/out/index.d.ts': 'export declare const v = 1;\n',
    'app/tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, lib: ['es2022'] },
      include: ['src'],
      references: [{ path: '../lib' }],
    }),
    'app/src/main.ts': "import { v } from '../../lib/src/index';\nexport const w: string = v;\n",
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const args = ['-p', join(dir, 'app')];
  parallelParse.files.clear();
  parallelParse.used = 0;
  parallelParse.missed = 0;
  parallelParse.unprepared = 0;
  parallelParse.packageJsons.length = 0;
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);

  const thread = parseThreadOfCommandLine(args, join(dir, 'app/tsconfig.json'), bundledLibs);
  const queue = new ParseQueue();
  queue.push(Root, join(dir, 'app/src/main.ts'), 0);
  queue.push(Library, 'lib.es2022.d.ts', 0);
  queue.push(AutomaticTypes, '', 0);
  const added = [];
  for (let chunk = queue.next(1); chunk !== undefined; chunk = queue.next(1)) {
    const batch = thread.load(chunk);
    for (const prepared of batch.files) {
      parallelParse.files.set(prepared.fileName, prepared);
      for (const reference of prepared.loaded?.references ?? []) assert.ok(reference.reason !== undefined);
    }
    for (let k = 0; k < batch.added.names.length; k++) {
      added.push(batch.added.names[k]);
      queue.push(batch.added.kinds[k], batch.added.names[k], batch.added.depths[k]);
    }
  }
  assert.ok(added.includes(join(dir, 'lib/out/index.d.ts')));
  assert.ok(!parallelParse.files.has(join(dir, 'lib/src/index.ts')));

  const shared = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(shared.kind, 'compile');
  assert.equal(parallelParse.used, shared.program.getSourceFiles().length);
  assert.equal(describe(shared.program), expected);
  assert.match(expected, /out\/index\.d\.ts/);
  assert.match(expected, /main\.ts:\d+-\d+:2322:/);
});

// Root files go to the parse threads as the config's \`include\` patterns match them
// (\`ConfigParser.beforeRootFiles\`), so that the threads start on them: a file that one of the same
// name with a higher priority extension leaves out of the config is not among them, since the
// program does not load it.
test('root files found while include patterns are matched are the root files of the config', () => {
  const dir = tempDir('tsc-ts-parallel-load-root-files-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { noEmit: true, allowJs: true, lib: ['es2022'] },
      files: ['src/lit.ts'],
      include: ['src'],
    }),
    'src/a.ts': 'export const a = 1;\n',
    'src/a.tsx': 'export const a = 2;\n',
    'src/a.d.ts': 'export declare const a: number;\n',
    'src/b.tsx': 'export const b = 1;\n',
    'src/b.js': 'export const b = 2;\n',
    'src/c.js': 'export const c = 1;\n',
    'src/c.d.ts': 'export declare const c: number;\n',
    'src/d.jsx': 'export const d = 1;\n',
    'src/lit.ts': 'export const lit = 1;\n',
    'src/lit.tsx': 'export const lit = 2;\n',
    'src/sub/e.ts': 'export const e = 1;\n',
    'src/sub/e.d.ts': 'export declare const e: number;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const sys = createNodeSystem(bundledLibs, '');
  const parser = new ConfigParser(new CachedFileSystem(new SystemFileSystem(sys)), sys.currentDirectory);
  const found = [];
  parser.beforeRootFiles = () => (fileName) => found.push(fileName);
  const errors = [];
  const config = parser.parseConfigFile(join(dir, 'tsconfig.json'), undefined, undefined, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual([...found].sort(), [...config.fileNames].sort());
  assert.ok(config.fileNames.some((f) => f.endsWith('src/c.d.ts')));
  assert.ok(!config.fileNames.some((f) => f.endsWith('src/a.tsx') || f.endsWith('src/lit.tsx')));
});

// The FileLoader takes the prepared files of a second copy of a package version too, resolving their
// imports from what the parse thread found, and only then makes them redirects to the first copy:
// the parse threads' package.json lookups are still those of the program's own load.
test('a program with a redirect to another copy of a package takes the parse threads lookups', () => {
  const dir = tempDir('tsc-ts-parallel-load-redirect-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: 'nodenext', lib: ['es2022'], types: [] },
      include: ['src'],
    }),
    'src/main.ts': "import { dup } from 'dup';\nimport { wrap } from 'wrap';\nexport const v = [dup, wrap];\n",
    'node_modules/dup/package.json': JSON.stringify({ name: 'dup', version: '1.0.0', types: 'index.d.ts' }),
    'node_modules/dup/index.d.ts': "export * from './more';\nexport declare const dup: number;\n",
    'node_modules/dup/more.d.ts': 'export declare const more: number;\n',
    'node_modules/wrap/package.json': JSON.stringify({ name: 'wrap', version: '1.0.0', types: 'index.d.ts' }),
    'node_modules/wrap/index.d.ts': "import { dup } from 'dup';\nexport declare const wrap: typeof dup;\n",
    'node_modules/wrap/node_modules/dup/package.json': JSON.stringify({
      name: 'dup',
      version: '1.0.0',
      types: 'index.d.ts',
    }),
    'node_modules/wrap/node_modules/dup/index.d.ts': "export * from './more';\nexport declare const dup: number;\n",
    'node_modules/wrap/node_modules/dup/more.d.ts':
      "import type {} from 'only-here';\nexport declare const more: number;\n",
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const args = ['-p', dir];
  parallelParse.files.clear();
  parallelParse.used = 0;
  parallelParse.missed = 0;
  parallelParse.unprepared = 0;
  parallelParse.taken.clear();
  parallelParse.packageJsons.length = 0;
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);

  assignSymbolIdsAtCreation();
  useLazyJSDocTable();
  const thread = parseThreadOfCommandLine(args, join(dir, 'tsconfig.json'), bundledLibs);
  const queue = new ParseQueue();
  queue.push(Root, join(dir, 'src/main.ts'), 0);
  queue.push(Library, 'lib.es2022.d.ts', 0);
  queue.push(AutomaticTypes, '', 0);
  for (let chunk = queue.next(1); chunk !== undefined; chunk = queue.next(1)) {
    const batch = thread.load(chunk);
    for (const prepared of batch.files) parallelParse.files.set(prepared.fileName, prepared);
    for (let k = 0; k < batch.added.names.length; k++)
      queue.push(batch.added.kinds[k], batch.added.names[k], batch.added.depths[k]);
    const lookups = batch.packageJsons;
    for (let k = 0; k < lookups.directories.length; k++)
      parallelParse.packageJsons.push(
        new PackageJsonLookup(lookups.directories[k], lookups.exists[k], lookups.directoryExists[k]),
      );
  }

  const shared = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(shared.kind, 'compile');
  assert.equal(describe(shared.program), expected);
  // The second copy is a redirect, so the program has fewer source files than the thread prepared.
  assert.ok(shared.program.getRedirectTargets(join(dir, 'node_modules/dup/index.d.ts')).length > 0);
  assert.ok(shared.program.getSourceFiles().length < parallelParse.files.size);
  const lookups = (program) =>
    [
      ...new Set(program.packageJsonLookups().map((l) => `${l.packageDirectory} ${l.exists} ${l.directoryExists}`)),
    ].sort();
  assert.ok(shared.program.hasAllPackageJsonLookups());
  assert.deepEqual(lookups(shared.program), lookups(plain.program));
  assert.ok(lookups(plain.program).some((l) => l.includes('only-here')));
});
