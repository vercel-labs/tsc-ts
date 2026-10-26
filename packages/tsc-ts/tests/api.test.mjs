import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Differential, explore, exploreServices } from './differential.mjs';
import { symbolKey } from './compare.mjs';
import { Client } from './client.mjs';
import { typescriptLib as bundledLib, tscTs, tscTsMissing } from './toolchain.mjs';
import { tempDir } from './temp.mjs';

// The reference: TypeScript's tsc at the pinned upstream (npm run build:oracle). It reads lib files from its real
// directory.
const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const realTsc = join(typescriptLib, 'tsc');
const env = { TSC_TS_LIB_DIR: typescriptLib };
const skip = !existsSync(realTsc) ? 'needs the scriptc toolchain' : tscTsMissing;

function copyProject() {
  const dir = tempDir('tsc-ts-api-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  return dir;
}

function report(d) {
  assert.deepEqual(
    d.failures.slice(0, Number(process.env.SHOW_FAILURES ?? 20)),
    [],
    `${d.failures.length} of ${d.count} responses differ`,
  );
}

test('tsc-ts --api answers like tsc --api', { skip, timeout: 600_000 }, async () => {
  const dir = copyProject();
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    await d.call('ping');
    await d.call('getServerTiming');
    const config = join(dir, 'tsconfig.json');
    await d.call('parseConfigFile', { file: config });
    const update = await d.snapshot({ openProjects: [config] });
    const snapshot = update.snapshot;
    const project = update.projects[0].id;
    const base = { snapshot, project };

    const fileNames = await d.call('getSourceFileNames', base);
    const userFiles = [];
    for (const file of fileNames) {
      const encoded = await d.call('getSourceFile', { ...base, file });
      await d.call('getSourceFileMetadata', { ...base, file });
      if (file.startsWith(dir)) userFiles.push({ file, length: readFileSync(file, 'utf8').length, encoded });
    }
    await d.call('getSourceFile', { ...base, file: join(dir, 'missing.ts') });
    await d.call('getDefaultProjectForFile', { snapshot, file: join(dir, 'src/main.ts') });

    for (const method of ['getConfigFileParsingDiagnostics', 'getProgramDiagnostics', 'getGlobalDiagnostics']) {
      await d.call(method, base);
    }
    for (const method of [
      'getSyntacticDiagnostics',
      'getBindDiagnostics',
      'getSemanticDiagnostics',
      'getSuggestionDiagnostics',
    ]) {
      await d.call(method, base);
      for (const { file } of userFiles) await d.call(method, { ...base, files: [file] });
    }

    for (const name of [
      'Any',
      'String',
      'Number',
      'Boolean',
      'Void',
      'Undefined',
      'Null',
      'Never',
      'Unknown',
      'BigInt',
      'ESSymbol',
    ]) {
      await d.call(`get${name}Type`, base);
    }
    await d.call('getWellKnownSymbols', base);
    await d.call('resolveName', { ...base, name: 'Circle', meaning: 0xffffffff, file: userFiles[0].file, position: 0 });
    await d.call('resolveName', { ...base, name: 'Array', meaning: 0xffffffff });

    const explored = await explore(d, snapshot, project, userFiles, 4000);
    assert.ok(explored > 500, `explored ${explored} objects`);

    // Type nodes round-trip through printNode.
    const positions = Array.from({ length: 60 }, (_, i) => i * 37);
    const types = await d.call('getTypesAtPositions', { ...base, file: userFiles[0].file, positions });
    for (const type of types.filter((t) => t !== null)) {
      const node = await d.call('typeToTypeNode', { ...base, type: type.id });
      if (node instanceof Uint8Array) await d.call('printNode', { data: Buffer.from(node).toString('base64') });
    }
    await d.call('printNode', { data: '!!' });
    await d.call('echo', { hello: 'wörld' });
    // echo returns its payload's bytes as they are, also a byte order mark and bytes that are not UTF-8 text.
    for (const bytes of [
      new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]),
      Uint8Array.from({ length: 300 }, (_, i) => (i * 31) % 256),
    ]) {
      const [expected, actual] = await Promise.all([
        d.expected.requestBytes('echo', bytes),
        d.actual.requestBytes('echo', bytes),
      ]);
      assert.deepEqual(new Uint8Array(expected.payload), bytes);
      assert.deepEqual(new Uint8Array(actual.payload), bytes);
    }

    // Errors the API reports for bad requests.
    await d.call('getTypeOfSymbol', { ...base, symbol: { kind: 1, snapshot, project, id: 999999 } });
    await d.call('getTypeOfSymbol', { ...base, symbol: { kind: 1, snapshot: snapshot + 50, project, id: 1 } });
    await d.call('getTypeOfSymbol', { ...base, symbol: { kind: 2, id: 1 } });
    await d.call('getTypeOfSymbol', { ...base, symbol: { kind: 0, id: 1 } });
    await d.call('getTypeOfSymbol', { ...base, symbol: null });
    await d.call('getParentOfSymbol', { symbol: { kind: 1, snapshot, id: 1 } });
    await d.call('getParentOfSymbol', { symbol: { kind: 1, snapshot: 99, project, id: 1 } });
    await d.call('getMembersOfSymbol', {
      symbol: { kind: 0, file: { fileName: 'x', path: 'x', contentHash: '0' }, id: 1 },
    });
    await d.call('getPropertiesOfType', { ...base, type: 999999 });
    await d.call('getTypeAtLocation', { ...base, location: '1.2' });
    await d.call('getTypeAtLocation', { ...base, location: `99999.79.${userFiles[0].file}` });
    await d.call('getSourceFileNames', { snapshot: 99, project });
    await d.call('getSourceFileNames', { snapshot, project: '/nope/tsconfig.json' });
    await d.call('noSuchMethod', base);

    // Snapshots: an unchanged update reuses the snapshot; edits report changes.
    const again = await d.snapshot({});
    assert.equal(again.snapshot, snapshot + 1);
    await d.call('release', { snapshot });
    const shapes = join(dir, 'src/shapes.ts');
    writeFileSync(shapes, readFileSync(shapes, 'utf8') + '\nexport const added = 1;\n');
    const changed = await d.snapshot({ fileNotifications: { changed: [shapes] } });
    await d.call('getSourceFile', { snapshot: changed.snapshot, project, file: shapes });
    await d.call('getSemanticDiagnostics', { snapshot: changed.snapshot, project, files: [shapes] });
    await d.snapshot({ closeProjects: [config] });
    await d.call('release', { snapshot });
    await d.call('release', { snapshot: changed.snapshot });
    await d.call('release', { snapshot: changed.snapshot });
  } finally {
    await d.close();
  }
  console.log(`compared ${d.count} responses`);
  report(d);
});

// A source file lease keeps the file's symbols resolvable by their references after the snapshots that returned them
// are released.
test('tsc-ts --api keeps retained source files like tsc --api', { skip, timeout: 300_000 }, async () => {
  const dir = copyProject();
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    const update = await d.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
    const base = { snapshot: update.snapshot, project: update.projects[0].id };
    const file = join(dir, 'src/shapes.ts');
    const positions = Array.from({ length: readFileSync(file, 'utf8').length }, (_, i) => i);
    const symbols = (await d.call('getSymbolsAtPositions', { ...base, file, positions })) ?? [];
    const owned = symbols.find((s) => s !== null && s.reference.kind === 0 && s.parent !== undefined);
    assert.ok(owned !== undefined, 'a symbol of shapes.ts');
    const { reference } = owned;
    const { lease } = await d.call('retainSourceFile', { file: reference.file });
    await d.call('retainSourceFile', { file: { ...reference.file, contentHash: '0'.repeat(32) } });
    await d.call('retainSourceFile', { file: { ...reference.file, contentHash: 'x'.repeat(32) } });
    await d.call('retainSourceFile', { file: { ...reference.file, parseOptionsKey: '4' } });
    await d.call('retainSourceFile', { file: { ...reference.file, scriptKind: 5 } });
    await d.call('retainSourceFile', {});
    // The file is parsed again in a newer snapshot; the older version stays available through the old snapshot
    // and the lease.
    writeFileSync(file, readFileSync(file, 'utf8') + '\nexport const added = 1;\n');
    const next = await d.snapshot({ fileNotifications: { changed: [file] } });
    await d.call('getSourceFile', { snapshot: next.snapshot, project: base.project, file });
    await d.call('getParentOfSymbol', { symbol: reference });
    // Undoing the edit gives back the file the first snapshot has, and its references.
    writeFileSync(file, readFileSync(file, 'utf8').replace('\nexport const added = 1;\n', ''));
    const undone = await d.snapshot({ fileNotifications: { changed: [file] } });
    const undoneBase = { snapshot: undone.snapshot, project: base.project };
    await d.call('getSourceFile', { ...undoneBase, file });
    const undoneSymbols = (await d.call('getSymbolsAtPositions', { ...undoneBase, file, positions })) ?? [];
    const undoneOwned = undoneSymbols.find((s) => s !== null && s.reference.kind === 0 && s.parent !== undefined);
    await d.call('getTypeOfSymbol', { ...undoneBase, symbol: undoneOwned.reference });
    await d.call('getParentOfSymbol', { symbol: undoneOwned.reference });
    await d.call('release', { snapshot: base.snapshot });
    await d.call('getParentOfSymbol', { symbol: reference });
    await d.call('getMembersOfSymbol', { symbol: reference });
    await d.call('releaseSourceFile', { lease });
    await d.call('releaseSourceFile', { lease });
    await d.call('releaseSourceFile', {});
    await d.call('getParentOfSymbol', { symbol: reference });
  } finally {
    await d.close();
  }
  report(d);
});

test('tsc-ts --api reports global diagnostics like tsc --api', { skip, timeout: 300_000 }, async () => {
  // Below ES2022 the libs have no Disposable, so `using` reports global diagnostics, which have no node.
  const dir = tempDir('tsc-ts-api-');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    '{"compilerOptions":{"target":"ES2015","strict":true,"types":[]},"files":["a.ts"]}',
  );
  writeFileSync(join(dir, 'a.ts'), 'export function f(d: any) {\n  using x = d;\n}\n');
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    const update = await d.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
    const base = { snapshot: update.snapshot, project: update.projects[0].id };
    await d.call('getSemanticDiagnostics', { ...base, files: [join(dir, 'a.ts')] });
    await d.call('getGlobalDiagnostics', base);
  } finally {
    await d.close();
  }
  report(d);
});

test('tsc-ts --api tracks projects and open files like tsc --api', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-');
  cpSync(resolve('tests/fixtures/project'), join(dir, 'a'), { recursive: true });
  mkdirSync(join(dir, 'b'));
  writeFileSync(join(dir, 'b/tsconfig.json'), '{"compilerOptions":{"strict":false,"types":[]},"files":["x.ts"]}');
  writeFileSync(join(dir, 'b/x.ts'), 'export const x: number = 1;\n');
  mkdirSync(join(dir, 'loose'));
  writeFileSync(join(dir, 'loose/y.ts'), 'export const y = 2;\n');
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    const first = await d.snapshot({ openProjects: [join(dir, 'b/tsconfig.json'), 'a/tsconfig.json'] });
    await d.call('getDefaultProjectForFile', { snapshot: first.snapshot, file: join(dir, 'b/x.ts') });
    await d.call('getDefaultProjectForFile', { snapshot: first.snapshot, file: join(dir, 'loose/y.ts') });
    await d.snapshot({ closeProjects: ['a/tsconfig.json'] });
    await d.snapshot({ openFiles: [join(dir, 'a/src/main.ts')] });
    await d.snapshot({ openFiles: [{ uri: `file://${join(dir, 'b/x.ts')}` }] });
    const loose = await d.snapshot({ openFiles: [join(dir, 'loose/y.ts')] });
    await d.call('getSourceFileNames', { snapshot: loose.snapshot, project: '/dev/null/inferred' });
    writeFileSync(join(dir, 'b/x.ts'), 'export const x: number = 2;\n');
    // Without ensurePrograms, the changed project is dirty and keeps its program until a later update.
    const dirty = await d.snapshot({ fileNotifications: { changed: [join(dir, 'b/x.ts')] } }, { ensure: false });
    await d.call('getSemanticDiagnostics', { snapshot: dirty.snapshot, project: join(dir, 'b/tsconfig.json') });
    await d.snapshot({}, { ensure: false });
    await d.snapshot({ ensurePrograms: [join(dir, 'b/tsconfig.json')] }, { ensure: false });
    await d.snapshot({ fileNotifications: { invalidateAll: true } });
    await d.snapshot({ closeFiles: [join(dir, 'loose/y.ts'), join(dir, 'a/src/main.ts')] });
  } finally {
    await d.close();
  }
  report(d);
});

// File contents are kept across snapshots: an edit is seen once the client reports the file, its real
// path (for a file read through a symbolic link in node_modules) or invalidateAll.
test(
  'tsc-ts --api reads changed files when the client reports them, like tsc --api',
  { skip, timeout: 300_000 },
  async () => {
    const dir = tempDir('tsc-ts-api-');
    writeFileSync(join(dir, 'base.json'), '{"compilerOptions":{"strict":true}}');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      '{"extends":"./base.json","compilerOptions":{"types":[],"module":"nodenext"},"files":["a.ts","b.ts","c.ts"]}',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(
      join(dir, 'b.ts'),
      "import { a } from './a.js';\nimport { p } from 'pkg';\nexport const b = a + p;\n",
    );
    writeFileSync(join(dir, 'c.ts'), 'export function c(x) { return x; }\n');
    mkdirSync(join(dir, 'packages/pkg'), { recursive: true });
    writeFileSync(join(dir, 'packages/pkg/package.json'), '{"name":"pkg","types":"index.d.ts"}');
    writeFileSync(join(dir, 'packages/pkg/index.d.ts'), 'export declare const p: number;\n');
    writeFileSync(join(dir, 'packages/pkg/other.d.ts'), 'export declare const p: string;\n');
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(join(dir, 'packages/pkg'), join(dir, 'node_modules/pkg'));
    const d = new Differential([realTsc], tscTs, dir, env);
    try {
      await d.call('initialize');
      const config = join(dir, 'tsconfig.json');
      let update = await d.snapshot({ openProjects: [config] });
      const project = update.projects[0].id;
      const query = async (snapshot) => {
        const base = { snapshot, project };
        await d.call('getSourceFileNames', base);
        for (const name of ['a.ts', 'b.ts', 'c.ts']) {
          await d.call('getSyntacticDiagnostics', { ...base, files: [join(dir, name)] });
          await d.call('getSemanticDiagnostics', { ...base, files: [join(dir, name)] });
        }
      };
      // a.ts changes without a report; b.ts is reported.
      writeFileSync(join(dir, 'a.ts'), 'export const a = ;\n');
      writeFileSync(
        join(dir, 'b.ts'),
        "import { a } from './a.js';\nimport { p } from 'pkg';\nexport const b = a + p + 1;\n",
      );
      update = await d.snapshot({ fileNotifications: { changed: [join(dir, 'b.ts')] } });
      await query(update.snapshot);
      update = await d.snapshot({ fileNotifications: { changed: [join(dir, 'a.ts')] } });
      await query(update.snapshot);
      // The package.json read through node_modules/pkg changes, reported by its real path.
      writeFileSync(join(dir, 'packages/pkg/package.json'), '{"name":"pkg","types":"other.d.ts"}');
      update = await d.snapshot({ fileNotifications: { changed: [join(dir, 'packages/pkg/package.json')] } });
      await query(update.snapshot);
      // The extended config changes.
      writeFileSync(join(dir, 'base.json'), '{"compilerOptions":{"strict":false}}');
      update = await d.snapshot({ fileNotifications: { changed: [join(dir, 'base.json')] } });
      await query(update.snapshot);
      // c.ts is deleted; then a.ts changes without a report, and invalidateAll rereads it.
      rmSync(join(dir, 'c.ts'));
      update = await d.snapshot({ fileNotifications: { deleted: [join(dir, 'c.ts')] } });
      await d.call('getProgramDiagnostics', { snapshot: update.snapshot, project });
      writeFileSync(join(dir, 'c.ts'), 'export function c(x: number) { return x; }\n');
      writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
      update = await d.snapshot({ fileNotifications: { invalidateAll: true } });
      await query(update.snapshot);
      // c.ts is reported deleted while it is still there, which leaves it out of the program, then changed
      // and reported created: the update reads its new contents.
      update = await d.snapshot({ fileNotifications: { deleted: [join(dir, 'c.ts')] } });
      await d.call('getSourceFileNames', { snapshot: update.snapshot, project });
      writeFileSync(join(dir, 'c.ts'), 'export function c(x: string): number { return x; }\n');
      update = await d.snapshot({ fileNotifications: { created: [join(dir, 'c.ts')] } });
      await query(update.snapshot);
    } finally {
      await d.close();
    }
    report(d);
  },
);

// A change to one program file whose imports and references are unchanged replaces the file in the program;
// other changes load the program again.
test('tsc-ts --api updates a program for a changed file like tsc --api', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        allowJs: true,
        importHelpers: true,
        isolatedModules: false,
      },
      files: ['a.ts', 'b.ts', 'c.tsx', 'd.js', 'e.ts', 'g.ts', 'h.d.ts'],
    }),
  );
  const write = (name, text) => writeFileSync(join(dir, name), text);
  write('a.ts', 'export const a = 1;\nexport function f(x: number) { return x; }\n');
  write('b.ts', "import { a, f } from './a';\nexport const b: string = f(a);\n");
  write('c.tsx', 'export const c = <div>{1}</div>;\n');
  write('d.js', '// @ts-check\nexport const d = 1;\nd.toFixed(1);\n');
  write('e.ts', 'export class E { x = 1; }\n');
  write('g.ts', 'export const g: string = h + globalD;\n');
  write('h.d.ts', 'export declare const h: number;\n');
  mkdirSync(join(dir, 'node_modules/react'), { recursive: true });
  write('node_modules/react/package.json', '{"name":"react","types":"index.d.ts"}');
  write('node_modules/react/index.d.ts', 'export {};\n');
  write(
    'node_modules/react/jsx-runtime.d.ts',
    'export declare function jsx(...args: any[]): any;\ndeclare global { namespace JSX { interface IntrinsicElements { [name: string]: any } } }\n',
  );
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    let update = await d.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
    const project = update.projects[0].id;
    const query = async (snapshot) => {
      const base = { snapshot, project };
      await d.call('getSourceFileNames', base);
      await d.call('getProgramDiagnostics', base);
      await d.call('getGlobalDiagnostics', base);
      for (const name of ['a.ts', 'b.ts', 'c.tsx', 'd.js', 'e.ts', 'g.ts', 'h.d.ts']) {
        await d.call('getSyntacticDiagnostics', { ...base, files: [join(dir, name)] });
        await d.call('getSemanticDiagnostics', { ...base, files: [join(dir, name)] });
      }
    };
    const change = async (...names) => {
      update = await d.snapshot({ fileNotifications: { changed: names.map((name) => join(dir, name)) } });
      await query(update.snapshot);
    };
    await query(update.snapshot);
    // A body edit, then an edit that changes an exported signature.
    write('a.ts', 'export const a = 1;\nexport function f(x: number) { return x + 1; }\n');
    await change('a.ts');
    write('a.ts', 'export const a = 1;\nexport function f(x: number) { return String(x); }\n');
    await change('a.ts');
    // A new import, and two files at once.
    write(
      'b.ts',
      "import { a, f } from './a';\nimport { E } from './e';\nexport const b: string = f(a) + new E().x;\n",
    );
    await change('b.ts');
    // tsgo lists changed files in map order, so only one of the two reported files changes.
    write('a.ts', 'export const a = 2;\nexport function f(x: number) { return String(x); }\n');
    await change('a.ts', 'e.ts');
    write('e.ts', 'export class E { x = "1"; }\n');
    await change('e.ts');
    // A JavaScript file that is no longer checked.
    write('d.js', 'export const d = 1;\nd.toFixed(1);\n');
    await change('d.js');
    // A file that is no longer a module, so it no longer imports tslib.
    write('e.ts', 'class E { x = "1"; }\n');
    await change('e.ts');
    // Files that become scripts with the same imports and tslib import (a JavaScript file imports tslib either way, a
    // declaration file never does), so only the change between module and script loads the program again; g.ts finds
    // their declarations as globals.
    write('d.js', 'var globalD = 1;\nglobalD.toFixed(1);\n');
    await change('d.js');
    write('h.d.ts', 'declare const h: number;\n');
    await change('h.d.ts');
    // And modules again.
    write('h.d.ts', 'export declare const h: number;\n');
    await change('h.d.ts');
    write('d.js', 'export const d = 1;\nd.toFixed(1);\n');
    await change('d.js');
  } finally {
    await d.close();
  }
  report(d);
});

// After an edit of a JSX import source pragma, of an import's resolution mode, or that makes a module a script, an
// update gives what a new program gives: it loads the program again where the program kept the file's JSX runtime
// import or resolutions. The tsgo that `tsc --api` runs here keeps the old JSX runtime import and resolution after
// the first two, so each update is compared with a server that loads the project anew.
test('tsc-ts --api updates a program for a changed file like a new program', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-');
  const write = (name, text) => {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  const names = ['c.tsx', 'index.ts', 'p.ts', 'q.ts', 'r.js', 's.ts'];
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        module: 'preserve',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        allowJs: true,
        checkJs: true,
      },
      files: names,
    }),
  );
  write('c.tsx', 'export const c = <div>{1}</div>;\n');
  const typeImport = (mode) =>
    `import type { Value } from "pkg" with { "resolution-mode": "${mode}" };\nexport const value: Value = { mode: "require" };\n`;
  write('index.ts', typeImport('require'));
  write('p.ts', 'export const shared = 1;\n');
  write('q.ts', 'const n: string = shared;\n');
  write('r.js', 'var sharedJs = 1;\n');
  write('s.ts', 'const m: string = sharedJs;\n');
  write('node_modules/react/package.json', '{"name":"react","types":"index.d.ts"}');
  write('node_modules/react/index.d.ts', 'export {};\n');
  write(
    'node_modules/react/jsx-runtime.d.ts',
    'export declare function jsx(...args: any[]): any;\ndeclare global { namespace JSX { interface IntrinsicElements { [name: string]: any } } }\n',
  );
  write(
    'node_modules/pkg/package.json',
    '{"name":"pkg","exports":{".":{"import":"./index.mjs","require":"./index.js"}}}',
  );
  write('node_modules/pkg/index.d.mts', 'export interface Value { mode: "import" }\n');
  write('node_modules/pkg/index.d.ts', 'export interface Value { mode: "require" }\n');
  const config = join(dir, 'tsconfig.json');
  const diagnostics = async (client, snapshot) => {
    const base = { snapshot, project: config };
    const result = {
      program: await client.json('getProgramDiagnostics', base),
      global: await client.json('getGlobalDiagnostics', base),
    };
    for (const name of names) {
      result[name] = [
        await client.json('getSyntacticDiagnostics', { ...base, files: [join(dir, name)] }),
        await client.json('getSemanticDiagnostics', { ...base, files: [join(dir, name)] }),
      ];
    }
    return result;
  };
  const loaded = async () => {
    const client = new Client(tscTs, dir, env);
    try {
      await client.json('initialize');
      const { snapshot } = await client.snapshot({ openProjects: [config] });
      return await diagnostics(client, snapshot);
    } finally {
      await client.close();
    }
  };
  const updated = new Client(tscTs, dir, env);
  try {
    await updated.json('initialize');
    let { snapshot } = await updated.snapshot({ openProjects: [config] });
    assert.deepEqual(await diagnostics(updated, snapshot), await loaded());
    const codes = (result, name) => result[name][1].map((d) => d.code);
    // Each edit: the file, its new text, and a code the new program reports for it or, as `[file, code]`, for
    // another file.
    for (const [name, text, code] of [
      ['c.tsx', '/** @jsxImportSource preact */\nexport const c = <div>{1}</div>;\n', 2875],
      // The same JSX runtime import, which the program keeps for the new file.
      ['c.tsx', '/** @jsxImportSource preact */\nexport const c = <div>{3}</div>;\n', 2875],
      ['c.tsx', 'export const c = <div>{2}</div>;\n', undefined],
      ['index.ts', typeImport('import'), 2322],
      ['index.ts', typeImport('require'), undefined],
      ['p.ts', 'const shared = 1;\n', undefined],
      ['p.ts', 'export const shared = 1;\n', undefined],
      // A JavaScript file that becomes a CommonJS module, with the same imports, and a script again: the program
      // takes the new file, whose binding decides whether s.ts finds its declaration as a global.
      ['r.js', 'var sharedJs = 1;\nmodule.exports = { sharedJs };\n', ['s.ts', 2304]],
      ['r.js', 'var sharedJs = 1;\n', ['s.ts', 2322]],
    ]) {
      write(name, text);
      ({ snapshot } = await updated.snapshot({ fileNotifications: { changed: [join(dir, name)] } }));
      const expected = await loaded();
      const [file, expectedCode] = Array.isArray(code) ? code : [name, code];
      if (expectedCode !== undefined)
        assert.ok(codes(expected, file).includes(expectedCode), `${file}: ${codes(expected, file)}`);
      assert.deepEqual(await diagnostics(updated, snapshot), expected, `after the edit of ${name}`);
    }
  } finally {
    await updated.close();
  }
});

// `await (legacy())` parses as a call of `await` until the file turns out to be a module, so
// its statement is reparsed in an await context; the statements around it are retained with
// the JSDoc parsed the first time, including `@deprecated`.
test(
  'tsc-ts --api keeps JSDoc of statements retained by top-level await reparsing',
  { skip, timeout: 300_000 },
  async () => {
    const dir = tempDir('tsc-ts-api-');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          strict: true,
          module: 'esnext',
          target: 'esnext',
          types: [],
        },
        files: ['main.js'],
      }),
    );
    const file = join(dir, 'main.js');
    const source = [
      '/**',
      ' * Computes the legacy value.',
      ' * @deprecated Use `current` instead.',
      ' * @returns {Promise<number>}',
      ' */',
      'export async function legacy() {',
      '  return 1;',
      '}',
      '',
      '/** @type {string} */',
      'export const label = 1;',
      '',
      '/** @deprecated Reparsed. */',
      'const value = await (legacy());',
      'legacy();',
      'value;',
      'export { value };',
      '',
    ].join('\n');
    writeFileSync(file, source);
    const d = new Differential([realTsc], tscTs, dir, env);
    try {
      await d.call('initialize');
      const update = await d.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
      const base = { snapshot: update.snapshot, project: update.projects[0].id };
      await d.call('getSourceFile', { ...base, file });
      await d.call('getSyntacticDiagnostics', { ...base, files: [file] });
      await d.call('getSemanticDiagnostics', { ...base, files: [file] });
      const suggestions = await d.call('getSuggestionDiagnostics', { ...base, files: [file] });
      // The reference reports the deprecated calls, so the comparison is not vacuous.
      assert.ok(
        suggestions.some((s) => s.reportsDeprecated),
        `expected a deprecation suggestion from tsc: ${JSON.stringify(suggestions)}`,
      );
      const positions = Array.from({ length: source.length }, (_, i) => i);
      const symbols = new Map();
      for (const symbol of (await d.call('getSymbolsAtPositions', { ...base, file, positions })) ?? [])
        if (symbol !== null) symbols.set(symbolKey(symbol.reference), symbol);
      let deprecatedTags = 0;
      for (const symbol of symbols.values()) {
        const tags = await d.call('getJsDocTags', { ...base, symbol: symbol.reference });
        if (tags?.some((t) => t.name === 'deprecated')) deprecatedTags++;
        await d.call('getDocumentationComment', { ...base, symbol: symbol.reference });
      }
      assert.ok(deprecatedTags > 0, 'expected tsc to report the @deprecated tag of legacy');
    } finally {
      await d.close();
    }
    report(d);
  },
);

// With a location, typeToTypeNode, typeToString and signatureToSignatureDeclaration reuse the type nodes the
// declarations wrote, where they denote the type: the reused nodes keep their positions in the file.
test('tsc-ts --api reuses written type nodes like tsc --api', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-');
  const source = [
    'export class Box { value = 1; }',
    'export const instance = new Box();',
    'export const number = 1;',
    'export const text = "hello";',
    'export const tuple: readonly [number, string] = [1, "a"];',
    'export const record: { a: number; b?: string } = { a: 1 };',
    'export const array: number[] = [1, 2];',
    'export function identity<T extends { n: number }>(value: T): T { return value; }',
    'export function predicate(value: unknown): value is Box { return value instanceof Box; }',
    'export function rest(...values: number[]): number { return values.length; }',
    'export function receiver(this: Box, value: number): number { return value; }',
  ].join('\n');
  const file = join(dir, 'main.ts');
  writeFileSync(file, source);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'esnext', types: [] }, files: ['main.ts'] }),
  );
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    const update = await d.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
    const base = { snapshot: update.snapshot, project: update.projects[0].id };
    const positions = Array.from({ length: source.length }, (_, i) => i);
    const symbols = new Map();
    for (const symbol of (await d.call('getSymbolsAtPositions', { ...base, file, positions })) ?? [])
      if (symbol !== null && symbol.valueDeclaration !== undefined) symbols.set(symbolKey(symbol.reference), symbol);
    assert.ok(symbols.size >= 11, `found ${symbols.size} declared symbols`);
    for (const symbol of symbols.values()) {
      const location = symbol.valueDeclaration;
      const type = await d.call('getTypeOfSymbol', { ...base, symbol: symbol.reference });
      if (type !== undefined && type !== null) {
        await d.call('typeToString', { ...base, type: type.id, location });
        await d.call('typeToTypeNode', { ...base, type: type.id, location });
      }
      const signature = await d.call('getSignatureFromDeclaration', { ...base, location });
      if (signature !== undefined && signature !== null) {
        await d.call('signatureToSignatureDeclaration', { ...base, signature: signature.id, kind: 186, location });
      }
    }
  } finally {
    await d.close();
  }
  report(d);
});

// Completions at every position of each user file, and with symbols and trigger characters
// where a trigger character was just typed.
async function compareCompletions(d, base, file) {
  const text = readFileSync(file, 'utf8');
  const call = (params) => d.call('getCompletionsAtPosition', { ...base, file, ...params });
  for (let position = 0; position <= text.length; position++) {
    await call({ position });
    const before = text[position - 1];
    if (before !== undefined && '.\'"`<#@/ *'.includes(before)) {
      await call({ position, includeSymbol: true });
      await call({ position, triggerCharacter: before });
    }
  }
}

// tsc keeps the module specifiers of auto-imports by the file an export is found in, so for a file with a relative
// module augmentation, which exports from the augmented module, the specifiers of the file's own exports depend on the
// order tsc visits them. The completions comparison moves the project fixture's augmentation to a file of its own.
function moveAugmentation(dir) {
  const main = join(dir, 'src/main.ts');
  const text = readFileSync(main, 'utf8');
  const augmentation = /declare module '\.\/shapes\.ts' \{\n(?: .*\n)*\}\n/.exec(text)?.[0];
  assert.ok(augmentation !== undefined, 'the fixture has a module augmentation');
  writeFileSync(main, text.replace(augmentation, ''));
  writeFileSync(join(dir, 'src/augment.ts'), 'export {};\n' + augmentation);
}

test('tsc-ts --api completes like tsc --api', { skip, timeout: 600_000 }, async () => {
  for (const fixture of ['completions', 'services', 'project', 'auto-imports']) {
    const dir = tempDir('tsc-ts-api-');
    cpSync(resolve('tests/fixtures', fixture), dir, { recursive: true });
    if (fixture === 'project') moveAugmentation(dir);
    const d = new Differential([realTsc], tscTs, dir, env);
    try {
      await d.call('initialize');
      const update = await d.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
      const base = { snapshot: update.snapshot, project: update.projects[0].id };
      for (const file of await d.call('getSourceFileNames', base))
        if (file.startsWith(dir)) await compareCompletions(d, base, file);
      await d.call('getCompletionsAtPosition', { ...base, file: join(dir, 'missing.ts'), position: 0 });
    } finally {
      await d.close();
    }
    console.log(`compared ${d.count} completions in ${fixture}`);
    report(d);
  }
});

// tsc prepares auto-imports for a completion request in a snapshot of its own, which takes the next snapshot ID; a
// request with symbols, or one whose list needs no auto-imports, takes none.
test(
  'tsc-ts --api numbers snapshots after completions with auto-imports like tsc --api',
  { skip, timeout: 300_000 },
  async () => {
    const dir = tempDir('tsc-ts-api-');
    const config = join(dir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }));
    writeFileSync(join(dir, 'a.ts'), 'export const value = 1;\n');
    const use = join(dir, 'use.ts');
    const text = 'val\nconst o = { a: 1 };\no.\n';
    writeFileSync(use, text);
    const d = new Differential([realTsc], tscTs, dir, env);
    try {
      await d.call('initialize');
      let update = await d.snapshot({ openProjects: [config] });
      const project = update.projects[0].id;
      const requests = [
        { position: 3 },
        { position: 3 },
        { position: text.indexOf('o.') + 2 },
        { position: 3, includeSymbol: true },
      ];
      for (const request of requests) {
        await d.call('getCompletionsAtPosition', { snapshot: update.snapshot, project, file: use, ...request });
        update = await d.snapshot({});
      }
    } finally {
      await d.close();
    }
    report(d);
  },
);

// The exports of packages in `node_modules` are not indexed yet, so a file with a `node_modules` directory above it
// gets no auto-imports: a completion list that needs them is refused, where tsc answers.
test('tsc-ts --api refuses auto-imports below a node_modules directory', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [] }, include: ['src'] }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'src/b.ts'), 'val\n');
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{"pkg":"1.0.0"}}');
  mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/pkg/package.json'), '{"name":"pkg","types":"index.d.ts"}');
  writeFileSync(join(dir, 'node_modules/pkg/index.d.ts'), 'export declare const valuable: number;\n');
  const servers = [new Client([realTsc], dir), new Client(tscTs, dir, env)];
  try {
    const replies = [];
    for (const client of servers) {
      await client.json('initialize');
      const update = await client.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
      const params = {
        snapshot: update.snapshot,
        project: update.projects[0].id,
        file: join(dir, 'src/b.ts'),
        position: 3,
      };
      replies.push(await client.request('getCompletionsAtPosition', params));
    }
    const [expected, actual] = replies;
    assert.equal(expected.type, 'response');
    assert.ok(JSON.parse(expected.payload.toString()).entries.some((e) => e.labelDetails?.description === 'pkg'));
    assert.equal(actual.type, 'error');
    assert.equal(actual.payload.toString(), 'completion list needs auto imports');
  } finally {
    for (const client of servers) await client.close();
  }
});

for (const fixture of ['services', 'project']) {
  test(
    `tsc-ts --api answers language service queries like tsc --api (${fixture})`,
    { skip, timeout: 600_000 },
    async () => {
      const dir = tempDir('tsc-ts-api-');
      cpSync(resolve('tests/fixtures', fixture), dir, { recursive: true });
      const d = new Differential([realTsc], tscTs, dir, env);
      try {
        await d.call('initialize');
        const update = await d.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
        const base = { snapshot: update.snapshot, project: update.projects[0].id };
        const files = [];
        for (const file of await d.call('getSourceFileNames', base)) {
          if (!file.startsWith(dir)) continue;
          const encoded = await d.call('getSourceFile', { ...base, file });
          files.push({ file, length: readFileSync(file, 'utf8').length, encoded });
        }
        const symbols = await exploreServices(d, base.snapshot, base.project, files);
        assert.ok(symbols > 100, `explored ${symbols} symbols`);
      } finally {
        await d.close();
      }
      console.log(`compared ${d.count} responses`);
      report(d);
    },
  );
}

test('tsc-ts runs tsc without --api', { skip, timeout: 300_000 }, () => {
  const dir = copyProject();
  const run = (command) => {
    try {
      return {
        status: 0,
        stdout: execFileSync(command[0], [...command.slice(1), '-p', '.'], {
          cwd: dir,
          env: { ...process.env, ...env },
        }).toString(),
      };
    } catch (e) {
      return { status: e.status, stdout: e.stdout.toString() };
    }
  };
  assert.deepEqual(run(tscTs), run([realTsc]));
});
