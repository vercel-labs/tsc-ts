// Projects for comparing tsconfig.json handling and program construction with tsgo.
// Each fixture is a set of files and the argument lists to run in its directory.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTestCase } from './module-resolution-cases.mjs';

const listArgs = [['--listFilesOnly'], ['--explainFiles', '--listFilesOnly'], ['--showConfig']];

function json(value) {
  return JSON.stringify(value, null, 2);
}

/** @returns {{ name: string, files: Record<string, string>, args?: string[][], symlinks?: Record<string, string> }[]} */
export function fixtureProjects() {
  const fixtures = [];
  const add = (name, files, args = listArgs) => fixtures.push({ name, files, args });

  // ---- extends
  add('extends-relative', {
    'tsconfig.json': json({ extends: './base.json', compilerOptions: { strict: true }, include: ['src'] }),
    'base.json': json({ compilerOptions: { target: 'es2020', outDir: 'out', lib: ['es2020'] } }),
    'src/a.ts': 'export const a = 1;\n',
  });
  add('extends-without-extension', {
    'tsconfig.json': json({ extends: './configs/base' }),
    'configs/base.json': json({ compilerOptions: { noImplicitAny: true }, include: ['../src/**/*'] }),
    'src/a.ts': 'export {};\n',
    'other/b.ts': 'export {};\n',
  });
  add('extends-chain-with-files', {
    'tsconfig.json': json({ extends: './a/tsconfig.json' }),
    'a/tsconfig.json': json({ extends: '../b/tsconfig.json', compilerOptions: { declaration: true } }),
    'b/tsconfig.json': json({ files: ['../main.ts'], compilerOptions: { target: 'es2022', strict: false } }),
    'main.ts': 'export {};\n',
    'b/ignored.ts': 'export {};\n',
  });
  add('extends-array', {
    'tsconfig.json': json({ extends: ['./one.json', './two.json'], compilerOptions: { noEmit: true } }),
    'one.json': json({ compilerOptions: { target: 'es2018', module: 'commonjs' }, exclude: ['skip'] }),
    'two.json': json({ compilerOptions: { target: 'esnext', strict: true } }),
    'a.ts': 'export {};\n',
    'skip/b.ts': 'export {};\n',
  });
  add('extends-package', {
    'tsconfig.json': json({ extends: '@scope/config/base.json', include: ['*.ts'] }),
    'node_modules/@scope/config/package.json': json({ name: '@scope/config', version: '1.0.0' }),
    'node_modules/@scope/config/base.json': json({ compilerOptions: { strict: true, types: [] } }),
    'a.ts': 'export {};\n',
  });
  add('extends-package-main', {
    'tsconfig.json': json({ extends: 'shared-config' }),
    'node_modules/shared-config/package.json': json({ name: 'shared-config', tsconfig: './tsconfig.shared.json' }),
    'node_modules/shared-config/tsconfig.shared.json': json({ compilerOptions: { checkJs: true, allowJs: true } }),
    'node_modules/shared-config/tsconfig.json': json({ compilerOptions: { strict: true } }),
    'a.js': 'module.exports = 1;\n',
  });
  add('extends-package-exports', {
    'tsconfig.json': json({ extends: 'cfg/strict' }),
    'node_modules/cfg/package.json': json({ name: 'cfg', exports: { './strict': './strict.json' } }),
    'node_modules/cfg/strict.json': json({ compilerOptions: { strict: true, exactOptionalPropertyTypes: true } }),
    'a.ts': 'export {};\n',
  });
  add('extends-missing', {
    'tsconfig.json': json({ extends: './nope.json' }),
    'a.ts': 'export {};\n',
  });
  add('extends-missing-package', {
    'tsconfig.json': json({ extends: ['missing-package', ''] }),
    'a.ts': 'export {};\n',
  });
  add('extends-cycle', {
    'tsconfig.json': json({ extends: './a.json' }),
    'a.json': json({ extends: './b.json', compilerOptions: { strict: true } }),
    'b.json': json({ extends: './a.json' }),
    'x.ts': 'export {};\n',
  });
  add('extends-self', {
    'tsconfig.json': json({ extends: './tsconfig.json', compilerOptions: { strict: true } }),
    'x.ts': 'export {};\n',
  });
  add('extends-errors-in-base', {
    'tsconfig.json': json({ extends: './base.json' }),
    'base.json': '{ "compilerOptions": { "target": "es1999", "bogus": true, "strict": "yes" } }',
    'x.ts': 'export {};\n',
  });
  add('extends-syntax-error-in-base', {
    'tsconfig.json': json({ extends: './base.json' }),
    'base.json': '{ "compilerOptions": { "target": "es2020", } ',
    'x.ts': 'export {};\n',
  });
  add('extends-null-resets', {
    'tsconfig.json': json({ extends: './base.json', compilerOptions: { outDir: null, lib: null } }),
    'base.json': json({ compilerOptions: { outDir: 'dist', lib: ['es5'], types: ['node'] } }),
    'x.ts': 'export {};\n',
  });
  add('extends-paths-base', {
    'tsconfig.json': json({ extends: './configs/base.json' }),
    'configs/base.json': json({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'x.ts': 'import "@/y";\n',
    'configs/src/y.ts': 'export {};\n',
  });
  add('extends-diamond', {
    'tsconfig.json': json({ extends: ['./a.json', './b.json'] }),
    'a.json': json({ extends: './c.json', compilerOptions: { strict: true } }),
    'b.json': json({ extends: './c.json' }),
    'c.json': json({ compilerOptions: { target: 'es5x' } }),
    'x.ts': 'export {};\n',
  });
  add('extends-bad-value', {
    'tsconfig.json': '{ "extends": 42, "compilerOptions": {} }',
    'x.ts': 'export {};\n',
  });
  add('extends-array-bad-items', {
    'tsconfig.json': '{ "extends": ["./a.json", 1, null, true], "compilerOptions": {} }',
    'a.json': '{}',
    'x.ts': 'export {};\n',
  });

  // ---- ${configDir}
  add('config-dir', {
    'tsconfig.json': json({ extends: './shared/base.json' }),
    'shared/base.json': json({
      compilerOptions: { outDir: '${configDir}/dist', rootDir: '${configDir}/src', typeRoots: ['${configDir}/types'] },
      include: ['${configDir}/src'],
    }),
    'src/a.ts': 'export {};\n',
    'shared/src/b.ts': 'export {};\n',
  });
  add('config-dir-case', {
    'tsconfig.json': json({ compilerOptions: { outDir: '${CONFIGDIR}/dist' }, files: ['${configDir}/a.ts'] }),
    'a.ts': 'export {};\n',
  });

  // ---- include / exclude / files
  add('include-globs', {
    'tsconfig.json': json({ include: ['src/**/*.ts', 'lib/*', 'x?.ts', 'deep/**/*'], exclude: ['src/skip'] }),
    'src/a.ts': '',
    'src/nested/b.ts': '',
    'src/skip/c.ts': '',
    'src/d.tsx': '',
    'lib/e.ts': '',
    'lib/inner/f.ts': '',
    'x1.ts': '',
    'x12.ts': '',
    'deep/.hidden/g.ts': '',
    'deep/node_modules/h.ts': '',
    'deep/i.d.ts': '',
    'deep/i.ts': '',
  });
  // Several includes over the same directories, matched a directory at a time.
  add('include-shared-directories', {
    'tsconfig.json': json({
      compilerOptions: { allowJs: true },
      include: ['src/*/lib/*', 'src/a?/**/*', 'src/deep/**/est/*', 'test/**/*', '*.ts'],
      exclude: ['**/fixtures/**', 'src/a2/other', '**/*.test.ts'],
    }),
    'a.ts': '',
    'a.tsx': '',
    'src/a1/lib/m.ts': '',
    'src/a1/lib/m.js': '',
    'src/a2/lib/n.ts': '',
    'src/a2/other/o.ts': '',
    'src/b1/lib/.hidden.ts': '',
    'src/b1/lib/z.min.js': '',
    'src/deep/er/est/p.ts': '',
    'src/deep/er/est/p.test.ts': '',
    'src/deep/node_modules/est/q.ts': '',
    'test/t.ts': '',
    'test/fixtures/f.ts': '',
    'test/.dot/d.ts': '',
  });
  add('include-default-excludes', {
    'tsconfig.json': json({ compilerOptions: { outDir: 'build', declarationDir: 'types', declaration: true } }),
    'a.ts': '',
    'build/a.js': '',
    'build/a.d.ts': '',
    'types/a.d.ts': '',
    'node_modules/pkg/index.ts': '',
    'bower_components/x.ts': '',
    'jspm_packages/y.ts': '',
    '.git/z.ts': '',
  });
  add('include-priority', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true } }),
    'a.ts': '',
    'a.d.ts': '',
    'a.js': '',
    'b.js': '',
    'b.d.ts': '',
    'c.tsx': '',
    'c.ts': '',
    'd.mts': '',
    'd.d.mts': '',
    'e.min.js': '',
    'f.cjs': '',
  });
  add('include-json', {
    'tsconfig.json': json({ compilerOptions: { resolveJsonModule: true }, include: ['*.ts', 'data/*.json', '**/*'] }),
    'a.ts': 'import d from "./data/d.json";\n',
    'data/d.json': '{ "a": 1 }',
    'data/e.json': '{}',
    'other.json': '{}',
  });
  add('files-and-include', {
    'tsconfig.json': json({ files: ['a.ts', './a.ts', 'missing.ts'], include: ['*.ts'] }),
    'a.ts': '',
    'b.ts': '',
  });
  add('files-empty', { 'tsconfig.json': json({ files: [] }), 'a.ts': '' });
  add('files-empty-with-references', {
    'tsconfig.json': json({ files: [], references: [{ path: './lib' }] }),
    'lib/tsconfig.json': json({ compilerOptions: { composite: true } }),
    'lib/a.ts': 'export {};\n',
  });
  add('files-null-items', { 'tsconfig.json': '{ "files": [null], "exclude": [null] }', 'a.ts': '' });
  add('no-inputs', { 'tsconfig.json': json({ include: ['src'], exclude: ['<html>&'] }), 'a.ts': '' });
  add('no-inputs-default', { 'tsconfig.json': '{}', 'readme.md': '' });
  add('invalid-specs', {
    'tsconfig.json': json({ include: ['**', 'src/**', 'a/**/../b/*.ts', 'ok/*.ts'], exclude: ['**/../x'] }),
    'ok/a.ts': '',
  });
  add('wrong-spec-types', {
    'tsconfig.json': '{ "include": "src", "exclude": [1, "x"], "files": "a.ts", "references": {} }',
    'src/a.ts': '',
  });
  add('excludes-typo', { 'tsconfig.json': json({ excludes: ['a'], include: ['*.ts'] }), 'a.ts': '' });
  add('include-parent', {
    'proj/tsconfig.json': json({ include: ['../shared/**/*', '*.ts'] }),
    'proj/a.ts': '',
    'shared/b.ts': '',
    'shared/sub/c.ts': '',
  });

  // ---- config syntax and option errors
  add('config-syntax-error', {
    'tsconfig.json': '{ "compilerOptions": { "strict": true, }, "files": ["a.ts"] ',
    'a.ts': '',
  });
  add('config-root-array', { 'tsconfig.json': '[{ "compilerOptions": { "strict": true } }]', 'a.ts': '' });
  add('config-root-string', { 'tsconfig.json': '"hello"', 'a.ts': '' });
  add('config-empty-file', { 'tsconfig.json': '', 'a.ts': '' });
  add('config-comments', {
    'tsconfig.json': '// leading\n{\n  /* block */ "compilerOptions": { "strict": true, // trailing\n },\n}\n',
    'a.ts': '',
  });
  add('config-option-errors', {
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "es1999",
    "module": 5,
    "strict": "yes",
    "lib": ["es5", "bogus", "", null, "DOM"],
    "types": "node",
    "bogusOption": true,
    "Strict": true,
    "outdir": "x",
    "help": true,
    "watch": true,
    "locale": "not a locale",
    "maxNodeModuleJsDepth": "2",
    "jsx": "react-jsxdev",
    "paths": { "a": "b", "c/*/*": ["./d/*/*", "e", "/abs"], "f": [] },
    "moduleResolution": "classic",
    "newLine": "lf",
    "plugins": [{ "name": "x" }],
    "rootDirs": ["a", 1],
    "checkers": 2.7,
    "noEmit": null
  },
  "typeAcquisition": { "enable": true, "bogus": 1, "Include": [] },
  "watchOptions": { "watchFile": "bogus" },
  "compileOnSave": "yes"
}`,
    'a.ts': '',
  });
  add('config-property-errors', {
    'tsconfig.json': '{ "compilerOptions": { a, "b"?: 1, "c": undefined, "d": -1, "e": -"x", "f": [1, x] } }',
    'a.ts': '',
  });
  add('config-wrong-object-types', {
    'tsconfig.json': '{ "compilerOptions": "strict", "typeAcquisition": [] }',
    'a.ts': '',
  });
  add('jsconfig', { 'jsconfig.json': json({ compilerOptions: { checkJs: true } }), 'a.js': 'export {};\n' }, [
    ['-p', 'jsconfig.json', '--listFilesOnly'],
    ['-p', 'jsconfig.json', '--showConfig'],
    ['-p', 'jsconfig.json', '--explainFiles', '--listFilesOnly'],
  ]);
  add('config-unreadable', { 'tsconfig.json/x': '' }, [['-p', 'tsconfig.json/x/..']]);

  // ---- program option diagnostics
  add('removed-options', {
    'tsconfig.json': json({
      compilerOptions: {
        baseUrl: './src',
        outFile: 'out.js',
        target: 'es5',
        module: 'amd',
        moduleResolution: 'node10',
        alwaysStrict: false,
        esModuleInterop: false,
        allowSyntheticDefaultImports: false,
        downlevelIteration: true,
      },
    }),
    'a.ts': '',
  });
  add('removed-options-command-line', { 'a.ts': '' }, [
    ['--listFilesOnly', '--module', 'system', '--baseUrl', '.', 'a.ts'],
    ['--listFilesOnly', '--module', 'umd', '--moduleResolution', 'classic', 'a.ts'],
  ]);
  add('option-conflicts', {
    'tsconfig.json': json({
      compilerOptions: {
        strict: false,
        strictPropertyInitialization: true,
        exactOptionalPropertyTypes: true,
        isolatedDeclarations: true,
        allowJs: true,
        sourceMap: true,
        inlineSourceMap: true,
        mapRoot: 'maps',
        composite: true,
        declaration: false,
        incremental: false,
        inlineSources: true,
        declarationMap: true,
        lib: ['es5'],
        noLib: true,
        isolatedModules: true,
        preserveConstEnums: false,
        checkJs: true,
        emitDecoratorMetadata: true,
        jsxFactory: 'h.',
        reactNamespace: 'React',
        jsxFragmentFactory: '1',
        jsx: 'react-jsx',
        jsxImportSource: 'preact',
        allowImportingTsExtensions: true,
        resolvePackageJsonExports: true,
        customConditions: ['x'],
        moduleResolution: 'node16',
        module: 'esnext',
      },
    }),
    'a.ts': '',
  });
  add('option-conflicts-2', {
    'tsconfig.json': json({
      compilerOptions: {
        declarationDir: 'types',
        emitDeclarationOnly: true,
        sourceRoot: 'src',
        reactNamespace: '1abc',
        jsx: 'react',
        jsxImportSource: 'preact',
        module: 'nodenext',
        moduleResolution: 'bundler',
        resolvePackageJsonImports: true,
        incremental: true,
      },
    }),
    'a.ts': '',
  });
  add('incremental-without-config', { 'a.ts': '' }, [['--incremental', '--listFilesOnly', 'a.ts']]);
  add('root-dir', {
    'tsconfig.json': json({ compilerOptions: { rootDir: 'src', outDir: 'out' } }),
    'src/a.ts': '',
    'other/b.ts': '',
  });
  add('root-dir-inferred-change', {
    'tsconfig.json': json({ compilerOptions: { outDir: 'out' }, include: ['src'] }),
    'src/a.ts': '',
    'src/b/c.ts': '',
  });
  add('outputs-overwrite-inputs', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true, declaration: true } }),
    'a.ts': '',
    'a.js': '',
    'b.js': '',
    'b.d.ts': '',
  });
  add('outputs-overwrite-inputs-command-line', { 'a.js': '', 'a.ts': '' }, [
    ['--listFilesOnly', '--allowJs', 'a.ts', 'a.js'],
  ]);
  add('composite-unlisted', {
    'tsconfig.json': json({ compilerOptions: { composite: true }, files: ['a.ts'] }),
    'a.ts': 'import "./b";\n',
    'b.ts': 'export {};\n',
  });

  // ---- references
  add('references', {
    'tsconfig.json': json({
      files: ['main.ts'],
      references: [
        { path: './lib' },
        { path: './lib/tsconfig.json' },
        { path: './missing' },
        { path: './plain' },
        { path: './noemit', circular: true },
      ],
    }),
    'main.ts': 'import "./lib/a";\nimport "./plain/p";\n',
    'lib/tsconfig.json': json({
      compilerOptions: { composite: true, outDir: 'out' },
      references: [{ path: '../base' }],
    }),
    'lib/a.ts': 'import "../base/b";\nexport {};\n',
    'base/tsconfig.json': json({ compilerOptions: { composite: true, declarationDir: 'types' } }),
    'base/b.ts': 'export {};\n',
    'plain/tsconfig.json': json({}),
    'plain/p.ts': 'export {};\n',
    'noemit/tsconfig.json': json({ compilerOptions: { composite: true, noEmit: true } }),
    'noemit/n.ts': 'export {};\n',
  });
  add('references-buildinfo-clash', {
    'tsconfig.json': json({
      compilerOptions: { composite: true, tsBuildInfoFile: 'x.tsbuildinfo' },
      references: [{ path: 'a' }],
    }),
    'index.ts': '',
    'a/tsconfig.json': json({ compilerOptions: { composite: true, tsBuildInfoFile: '../x.tsbuildinfo' } }),
    'a/a.ts': '',
  });
  add('references-invalid', {
    'tsconfig.json': '{ "references": [{ "path": "" }, {}, "x", { "path": "./a", "circular": true }] }',
    'a/tsconfig.json': '{ "compilerOptions": { "composite": true } }',
    'a/a.ts': '',
    'b.ts': '',
  });

  // ---- libraries
  add('libs', {
    'tsconfig.json': json({ compilerOptions: { lib: ['ES2015', 'dom', 'lib.es2017.object.d.ts'] } }),
    'a.ts':
      '/// <reference lib="es2019.array" />\n/// <reference lib="ES2016" />\n/// <reference lib="bogus" />\n/// <reference lib="dom.iterabl" />\nexport {};\n',
  });
  add('no-lib', {
    'tsconfig.json': json({ compilerOptions: { noLib: true } }),
    'a.ts': '/// <reference lib="es2015" />\nexport {};\n',
  });
  add('lib-targets', { 'a.ts': '' }, [
    ['--listFilesOnly', '--target', 'es2015', 'a.ts'],
    ['--explainFiles', '--listFilesOnly', '--target', 'es2016', 'a.ts'],
    ['--listFilesOnly', '--target', 'esnext', 'a.ts'],
    ['--listFilesOnly', '--target', 'es5', 'a.ts'],
    ['--listFilesOnly', '--lib', 'es5,webworker', 'a.ts'],
  ]);
  add('target-related-info', {
    'tsconfig.json': json({ compilerOptions: { target: 'ES2020' } }),
    'a.ts': '/// <reference lib="nope" />\n',
  });
  add(
    'lib-replacement',
    {
      'tsconfig.json': json({ compilerOptions: { libReplacement: true, lib: ['dom', 'es2015'] } }),
      'node_modules/@typescript/lib-dom/package.json': json({ name: '@typescript/lib-dom', types: 'index.d.ts' }),
      'node_modules/@typescript/lib-dom/index.d.ts': 'declare var replaced: number;\n',
      'a.ts': '',
    },
    [...listArgs, ['--listFilesOnly', '--traceResolution']],
  );

  // ---- types
  add('types-automatic', {
    'tsconfig.json': '{}',
    'a.ts': '',
    'node_modules/@types/node/index.d.ts': 'declare var process: any;\n',
    'node_modules/@types/node/package.json': json({ name: '@types/node', version: '20.0.0' }),
    'node_modules/@types/jest/index.d.ts': '',
    'node_modules/@types/.hidden/index.d.ts': '',
  });
  add('types-wildcard', {
    'tsconfig.json': json({ compilerOptions: { types: ['*'] } }),
    'a.ts': '',
    'node_modules/@types/node/index.d.ts': '',
    'node_modules/@types/scope__pkg/index.d.ts': '',
  });
  add('types-list', {
    'tsconfig.json': json({
      compilerOptions: { types: ['node', 'missing'], typeRoots: ['./typings', './node_modules/@types'] },
    }),
    'a.ts': '/// <reference types="other" />\n/// <reference types="nowhere" />\n',
    'typings/node/index.d.ts': '',
    'node_modules/@types/other/index.d.ts': '',
  });
  add('types-empty', {
    'tsconfig.json': json({ compilerOptions: { types: [] } }),
    'a.ts': '',
    'node_modules/@types/node/index.d.ts': '',
  });

  // ---- references between files
  add(
    'triple-slash',
    {
      'a.ts':
        '/// <reference path="b.ts" />\n/// <reference path="c" />\n/// <reference path="missing.ts" />\n/// <reference path="a.ts" />\n/// <reference path="d.js" />\n/// <reference path="e.txt" />\n/// <reference path="nope" />\n',
      'b.ts': '',
      'c.d.ts': '',
      'd.js': '',
      'e.txt': '',
    },
    [
      ['--listFilesOnly', 'a.ts'],
      ['--explainFiles', '--listFilesOnly', 'a.ts'],
      ['--listFilesOnly', '--noResolve', 'a.ts'],
    ],
  );
  add('root-file-errors', { 'a.ts': '', 'b.js': '', 'c.txt': '', 'dir/x.ts': '' }, [
    ['--listFilesOnly', 'a.ts', 'b.js', 'c.txt', 'missing.ts', 'noext'],
    ['--listFilesOnly', 'a', 'dir/x'],
    ['--explainFiles', '--listFilesOnly', 'b.js', 'c.txt'],
  ]);
  add('casing', {
    'tsconfig.json': json({ files: ['a.ts', 'A.ts'] }),
    'a.ts': 'import "./B";\nimport "./b";\n',
    'A.ts': '',
    'b.ts': '',
    'B.ts': '',
  });
  add('casing-off', {
    'tsconfig.json': json({ compilerOptions: { forceConsistentCasingInFileNames: false }, files: ['a.ts', 'A.ts'] }),
    'a.ts': '',
    'A.ts': '',
  });

  // ---- modules and JavaScript
  add(
    'imports',
    {
      'tsconfig.json': json({ compilerOptions: { module: 'nodenext' } }),
      'package.json': json({ type: 'module' }),
      'a.ts': 'import "./b.js";\nimport type {} from "pkg";\nconst c = require("./c.cjs");\nexport {};\n',
      'b.ts': 'export {};\n',
      'c.cts': 'export = 1;\n',
      'node_modules/pkg/package.json': json({ name: 'pkg', version: '1.2.3', types: 'index.d.ts' }),
      'node_modules/pkg/index.d.ts': 'export {};\n',
    },
    [...listArgs, ['--listFilesOnly', '--traceResolution']],
  );
  add('js-depth', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true, maxNodeModuleJsDepth: 1 }, include: ['*.js'] }),
    'a.js': 'require("lib1");\n',
    'node_modules/lib1/index.js': 'require("lib2");\n',
    'node_modules/lib2/index.js': 'module.exports = 1;\n',
  });
  // `pc` is reached first at depth 3, through `pa` and `pb`, and later at depth 1, through a chain of local
  // imports from b.ts: its JavaScript import loads within `maxNodeModuleJsDepth` only from the lower depth.
  for (const depth of [1, 2]) {
    add(`js-depth-lowered-${depth}`, {
      'tsconfig.json': json({
        compilerOptions: { allowJs: true, maxNodeModuleJsDepth: depth },
        files: ['a.ts', 'b.ts'],
      }),
      'a.ts': 'import "pa";\n',
      'b.ts': 'import "./c";\n',
      'c.ts': 'import "./d";\n',
      'd.ts': 'import "./e";\n',
      'e.ts': 'import "./f";\n',
      'f.ts': 'import "./g";\n',
      'g.ts': 'import "./h";\n',
      'h.ts': 'import "pc";\n',
      'node_modules/pa/index.d.ts': 'import "pb";\n',
      'node_modules/pb/index.d.ts': 'import "pc";\n',
      'node_modules/pc/index.d.ts': 'import "pj";\n',
      'node_modules/pj/index.js': 'require("pk");\n',
      'node_modules/pk/index.js': 'module.exports = 1;\n',
    });
  }
  add('js-without-allowjs', {
    'tsconfig.json': '{}',
    'a.ts': 'import "./b";\nimport "lib";\n',
    'b.js': '',
    'node_modules/lib/index.js': '',
  });
  add('dedupe-packages', {
    'tsconfig.json': '{}',
    'a.ts': 'import "x";\nimport "y";\n',
    'node_modules/x/index.d.ts': 'import "z";\n',
    'node_modules/x/package.json': json({ name: 'x', version: '1.0.0' }),
    'node_modules/x/node_modules/z/index.d.ts': '',
    'node_modules/x/node_modules/z/package.json': json({ name: 'z', version: '2.0.0' }),
    'node_modules/y/index.d.ts': 'import "z";\n',
    'node_modules/y/package.json': json({ name: 'y', version: '1.0.0' }),
    'node_modules/y/node_modules/z/index.d.ts': '',
    'node_modules/y/node_modules/z/package.json': json({ name: 'z', version: '2.0.0' }),
  });
  add('import-helpers-and-jsx', {
    'tsconfig.json': json({ compilerOptions: { importHelpers: true, jsx: 'react-jsx', isolatedModules: true } }),
    'a.tsx': 'export const x = <div />;\n',
    'b.ts': 'export {};\n',
    'node_modules/tslib/package.json': json({ name: 'tslib', version: '2.0.0', types: 'tslib.d.ts' }),
    'node_modules/tslib/tslib.d.ts': '',
    'node_modules/react/jsx-runtime.d.ts': '',
    'node_modules/react/package.json': json({ name: 'react', version: '18.0.0' }),
  });
  add('syntax-errors', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true, outDir: 'o' } }),
    'a.ts': 'let x = ;\n',
    'b.js': 'function f(@dec x) {}\nlet y: number = 1;\n',
  });
  add(
    'pretty-summary',
    {
      'tsconfig.json': json({ compilerOptions: { pretty: true, target: 'es5' } }),
      'a.ts': 'let x = ;\n',
    },
    [['--listFilesOnly'], ['--listFilesOnly', '--pretty', 'false']],
  );
  add('symlinked-sources', {
    'tsconfig.json': json({ include: ['src', 'linked'] }),
    'src/a.ts': '',
    'real/b.ts': '',
  });
  fixtures[fixtures.length - 1].symlinks = { linked: 'real', 'src/loop': '.' };
  return fixtures;
}

// ---- TypeScript's test cases

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Harness options that are not compiler options, and options whose effects aren't comparable. */
const harnessOnly = new Set([
  'filename',
  'currentdirectory',
  'noimplicitreferences',
  'baselinefile',
  'includebuiltfile',
  'fullemitpaths',
  'reportdiagnostics',
  'captureSuggestions'.toLowerCase(),
  'usecasesensitivefilenames',
  'typescriptversion',
  'libfiles',
  'nocheck',
  'link',
  'symlink',
]);

function optionValue(declaration, raw) {
  const first = raw.split(',')[0].trim();
  switch (declaration.kind) {
    case 'boolean':
      return first.toLowerCase() === 'true';
    case 'number':
      return Number(first);
    case 'list':
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    default:
      return first;
  }
}

/**
 * Projects from TypeScript's multi-file test cases. Cases with a tsconfig.json are run with it; others get one with
 * their `@option` headers and every source file in `files`.
 */
export function testCaseProjects(testsRoot, declarations) {
  const byName = new Map();
  for (const declaration of declarations) byName.set(declaration.name.toLowerCase(), declaration);
  const projects = [];
  const testFiles = [...walk(join(testsRoot, 'compiler'), []), ...walk(join(testsRoot, 'conformance'), [])].sort();
  for (const testFile of testFiles) {
    const code = readFileSync(testFile, 'utf8');
    if (!/@filename\s*:/i.test(code)) continue;
    let parsed;
    try {
      parsed = parseTestCase(code, testFile);
    } catch {
      continue;
    }
    if (parsed.options.usecasesensitivefilenames === 'false') continue;
    const cwd = parsed.options.currentdirectory ?? '/.src';
    if (/^[a-zA-Z]:|\\/.test(cwd)) continue;
    const files = {};
    let configFile;
    let unusable = false;
    for (const file of parsed.files) {
      const name = toProjectPath(file.name, cwd);
      if (name === undefined || name in files) {
        unusable = true;
        break;
      }
      files[name] = file.content;
      const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
      if (configFile === undefined && (base === 'tsconfig.json' || base === 'jsconfig.json')) configFile = name;
    }
    if (unusable) continue;
    const symlinks = {};
    for (const [link, target] of Object.entries(parsed.symlinks)) {
      const from = toProjectPath(link, cwd);
      const to = toProjectPath(target, cwd);
      if (from === undefined || to === undefined) unusable = true;
      else symlinks[from] = to;
    }
    if (unusable) continue;
    const projectCwd = toProjectPath('.', cwd);
    const name = testFile.slice(testsRoot.length + 1);
    if (configFile !== undefined) {
      const project = ['-p', configFile];
      projects.push({
        name,
        files,
        symlinks,
        cwd: projectCwd,
        args: [
          [...project, '--listFilesOnly'],
          [...project, '--explainFiles', '--listFilesOnly'],
          [...project, '--showConfig'],
          ...(/node_modules|package\.json|@trace/i.test(code)
            ? [[...project, '--listFilesOnly', '--traceResolution']]
            : []),
        ],
      });
      continue;
    }
    const compilerOptions = {};
    for (const [key, raw] of Object.entries(parsed.options)) {
      if (harnessOnly.has(key)) continue;
      const declaration = byName.get(key);
      if (declaration === undefined || declaration.isCommandLineOnly) continue;
      compilerOptions[declaration.name] = optionValue(declaration, raw);
    }
    const rootFiles = [];
    for (const fileName of Object.keys(files)) {
      if (!/\.(d\.)?[cm]?[tj]sx?$/.test(fileName) || fileName.includes('node_modules/')) continue;
      rootFiles.push(relativeTo(projectCwd, fileName));
    }
    const generatedConfig = join(projectCwd, 'tsconfig.json');
    if (generatedConfig in files) continue;
    files[generatedConfig] = JSON.stringify({ compilerOptions, files: rootFiles }, null, 2);
    projects.push({
      name,
      files,
      symlinks,
      cwd: projectCwd,
      args: [
        ['--explainFiles', '--listFilesOnly'],
        ['--showConfig'],
        ...(/node_modules|package\.json|@trace/i.test(code) ? [['--listFilesOnly', '--traceResolution']] : []),
      ],
    });
  }
  return projects;
}

/** A test file name as a path relative to the project directory, which stands for `/`. */
function toProjectPath(fileName, cwd) {
  if (/^[a-zA-Z]:|\\|^\w+:\/\//.test(fileName)) return undefined;
  const absolute = fileName.startsWith('/') ? fileName : cwd.replace(/\/$/, '') + '/' + fileName;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

function relativeTo(from, to) {
  const a = from === '.' ? [] : from.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.';
}
