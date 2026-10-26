// Runs `tsc` argument lists through tsgo (packages/tsgo/dist/tsgo) and the tsc-ts command line,
// comparing stdout, stderr, exit status and any written tsconfig.json.
// Set TSC_TS_CLI to a native build of src/drivers/cli.ts to test it instead of the JS build, and CLI_SHARD to `i/n`
// to run every nth case of each test starting at the ith.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const haveScript = existsSync('/usr/bin/script');
// tsgo's embedded lib files, which ours reads as `bundled:///libs/` from here.
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
// Lets the many Node processes share compiled code (https://nodejs.org/api/module.html#module-compile-cache).
const compileCache = process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {};

const work = mkdtempSync(join(tmpdir(), 'tsc-ts-cli-'));
const out = compileSources('tsc-ts-cli-build-', ['drivers/cli.ts']);
const ours = process.env.TSC_TS_CLI ? [process.env.TSC_TS_CLI] : [process.execPath, join(out, 'drivers/cli.js')];
const decls = await import(pathToFileURL(join(out, 'compiler/option-declarations.js')).href);

/**
 * @typedef {{
 *   args: string[],
 *   files?: Record<string, string>,
 *   env?: Record<string, string>,
 *   width?: number,
 *   skip?: string,
 *   seam?: boolean | 'maybe',
 *   compare?: 'all' | 'locale',
 * }} Case
 */

// ---- case generation

/** Option names as users may spell them. */
function spellings(option) {
  const names = [`--${option.name}`, `-${option.name}`, `--${option.name.toUpperCase()}`];
  if (option.shortName) names.push(`-${option.shortName}`, `--${option.shortName}`);
  return names;
}

const numberValues = ['4', '0', '1', '-1', '+3', '007', 'abc', '1.5', '1e3', '', ' 2', '0x10', '9223372036854775808'];
const stringValues = ['value', '', 'sub/dir/', '../up', '/abs/path', './x/../y', '-x', 'a b', 'C:/win', 'null'];
const booleanValues = ['true', 'false', 'null', 'TRUE', '0', 'x'];
const listValues = ['a,b', 'a,,b', ' a , b ', '', ',', '-x', 'null', '../x,/abs,./y', 'one'];
const tsconfigOnlyValues = ['null', 'false', 'true', 'x', '-x', ''];

function enumValues(option) {
  const names = [...option.values.keys()];
  return [...names, ...names.map((n) => n.toUpperCase()), ` ${names[0]} `, '\t' + names[0], 'bogus', '', 'null'];
}

function libValues(option) {
  const names = [...option.element.values.keys()];
  return [
    ...names,
    names.join(','),
    'ES5,DOM',
    ' es5 , dom ',
    'es5,,dom',
    'es5,bogus',
    'bogus',
    ',',
    '',
    '-x',
    'null',
    'lib.es5.d.ts',
  ];
}

function valuesFor(option) {
  if (option.isTSConfigOnly) return tsconfigOnlyValues;
  switch (option.kind) {
    case 'boolean':
      return booleanValues;
    case 'number':
      return numberValues;
    case 'string':
      return option.name === 'locale' ? ['en', 'en-US', 'EN_us', 'xx', '', 'abcd', 'en-', 'null'] : stringValues;
    case 'enum':
      return enumValues(option);
    case 'list':
      if (option.element.kind === 'enum') return libValues(option);
      if (option.element.extraValidation === 'spec') return [...listValues, '**/../x', 'a/**/b/..', '**/x', '../**'];
      return listValues;
    default:
      return [];
  }
}

/** Why tsgo's behavior for these arguments can't be compared, if so. */
function skipReason(option, value) {
  if (option.name === 'pprofDir' && value !== 'null') return 'pprofDir writes Go runtime profiles';
  if (option.kind === 'number' && /^[+-]?\d{16,}$/.test(value) && value !== '9223372036854775808') {
    return 'integers beyond 2^53';
  }
  return undefined;
}

/** @returns {Case[]} */
function optionCases() {
  const cases = [];
  const seen = new Set();
  for (const option of [...decls.optionDeclarations, ...decls.optionsForWatch]) {
    const key = option.name + (option.shortName ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    const values = valuesFor(option);
    spellings(option).forEach((flag, i) => {
      // Every value with the canonical spelling, a valid one with the others.
      const chosen = i === 0 ? values : values.slice(0, 1);
      for (const value of chosen) {
        const skip = skipReason(option, value);
        // `--showConfig false` compiles instead.
        const seam = option.name === 'showConfig' && (value === 'false' || value === 'null');
        cases.push({ args: ['--showConfig', flag, value, 'a.ts'], skip, seam });
        // Without files, unless the value would become one (and start a compilation).
        const becomesFile = option.isTSConfigOnly
          ? false
          : option.kind === 'boolean'
            ? !['true', 'false', 'null'].includes(value)
            : option.kind === 'list' && value === ',';
        cases.push({ args: [flag, value], skip, seam: becomesFile ? 'maybe' : false });
      }
      // No value: the option is last.
      cases.push({ args: ['--showConfig', 'a.ts', flag], skip: skipReason(option, '') });
      if (i === 0) cases.push({ args: [flag], skip: skipReason(option, '') });
    });
  }
  return cases;
}

/** @returns {Case[]} */
function buildCases() {
  const cases = [];
  const modes = ['-b', '--b', '-build', '--build', '-B', '--BUILD', '-Build'];
  for (const mode of modes) cases.push({ args: [mode, '--help'] }, { args: [mode, '-h'] }, { args: [mode, '-?'] });
  cases.push({ args: ['-b'], seam: true }, { args: ['--build', 'p1', 'p2'], seam: true });
  for (const option of [...decls.buildOptionDeclarations, ...decls.optionsForWatch]) {
    if (option.name === 'locale' || option.name === 'pprofDir') continue;
    for (const flag of spellings(option)) {
      for (const value of valuesFor(option).slice(0, 6)) cases.push({ args: ['-b', flag, value, '--help'] });
      cases.push({ args: ['-b', '--help', flag] });
    }
  }
  // Compiler-only options are rejected in build mode.
  for (const option of decls.optionsForCompiler) {
    cases.push({ args: ['-b', `--${option.name}`, '--help'] }, { args: ['--build', `-${option.name}`] });
  }
  for (const [a, b] of [
    ['--clean', '--force'],
    ['--clean', '--verbose'],
    ['--clean', '--watch'],
    ['--watch', '--dry'],
    ['--clean', '-f'],
    ['-w', '-d'],
  ]) {
    cases.push({ args: ['-b', a, b] }, { args: ['-b', a, b, '--help'] });
  }
  cases.push(
    { args: ['-b', '--clean', '--force', '--verbose', '--watch', '--dry'] },
    { args: ['-b', '--foo'] },
    { args: ['-b', '-'] },
    { args: ['-b', '--watchFile', 'bogus'] },
    { args: ['-b', '--watchInterval'] },
    { args: ['-b', '--builders'] },
    { args: ['-b', '--builders', '0'] },
    { args: ['-b', '--checkers', 'x'] },
    { args: ['-b', '--pretty', '--foo'] },
    { args: ['-b', '--quiet', '--foo'] },
    { args: ['-b', '--build', '--help'] },
    { args: ['-b', '-v', '-d', '-f', '--help'] },
    { args: ['x', '-b'] },
  );
  return cases;
}

/** @returns {Case[]} */
function miscCases() {
  const cases = [
    { args: [] },
    { args: ['--help'] },
    { args: ['-h'] },
    { args: ['-?'] },
    { args: ['--all'] },
    { args: ['--help', '--all'] },
    { args: ['--all', 'false', '--help'] },
    { args: ['--version'] },
    { args: ['-v'] },
    { args: ['-V'] },
    { args: ['--version', '--help'] },
    { args: ['--help', '--foo'] },
    { args: ['--foo'] },
    { args: ['-foo'] },
    { args: ['---strict'] },
    { args: ['-'] },
    { args: ['--'] },
    { args: ['--strict=true'] },
    { args: ['--foo', '--bar', '--target', 'x', '--lib', 'y'] },
    { args: ['-f'] },
    { args: ['--verbose'] },
    { args: ['-verbose'] },
    { args: ['--clean'] },
    { args: ['--dry'] },
    { args: ['--force'] },
    { args: ['--builders', '2'] },
    { args: ['--stopBuildOnErrors'] },
    { args: ['--build'], seam: true },
    { args: ['--strict', '--build'] },
    { args: ['--BUILD', '--strict'] },
    { args: ['--watch', '--listFilesOnly'] },
    { args: ['-w', '--listFilesOnly', 'a.ts'] },
    { args: ['--watch', '--listFilesOnly', '--version'] },
    { args: ['-p', 'missing'] },
    { args: ['-p', 'missing', 'a.ts'] },
    { args: ['-p', ''] },
    { args: ['-p', '.'] },
    { args: ['-p', 'sub'], files: { 'sub/x.ts': '' } },
    { args: ['-p', 'sub/'], files: { 'sub/x.ts': '' } },
    { args: ['-p', 'a.ts'], files: { 'a.ts': '' }, seam: true },
    { args: ['-p', 'sub'], files: { 'sub/tsconfig.json': '{}' }, seam: true },
    { args: ['a.ts'], seam: true },
    { args: ['a.ts', 'b.ts', '--strict'], seam: true },
    { args: ['--showConfig'] },
    { args: ['--showConfig', '--ignoreConfig'] },
    { args: ['--ignoreConfig'] },
    { args: ['--ignoreConfig', 'a.ts'], seam: true },
    { args: ['--showConfig', 'a.ts', '../b.ts', 'sub/c.ts', '/abs/d.ts', './e.ts', 'A.TS', 'f/../g.ts'] },
    { args: ['--showConfig', '--outDir', 'out', '--rootDir', 'src', '--rootDirs', 'a,b', 'x.ts'] },
    { args: ['--showConfig', '--composite', 'x.ts'] },
    { args: ['--showConfig', '--composite', '--declaration', 'false', 'x.ts'] },
    { args: ['--showConfig', '--declarationMap', '--composite', 'x.ts'] },
    { args: ['--showConfig', '--verbatimModuleSyntax', 'x.ts'] },
    { args: ['--showConfig', '--isolatedModules', 'x.ts'] },
    { args: ['--showConfig', '--checkJs', 'x.ts'] },
    { args: ['--showConfig', '--checkJs', '--allowJs', 'false', 'x.ts'] },
    { args: ['--showConfig', '--rewriteRelativeImportExtensions', 'x.ts'] },
    { args: ['--showConfig', '--module', 'preserve', '--moduleResolution', 'bundler', 'x.ts'] },
    { args: ['--showConfig', '--moduleResolution', 'node16', 'x.ts'] },
    { args: ['--showConfig', '--resolvePackageJsonExports', 'false', '--moduleResolution', 'bundler', 'x.ts'] },
    { args: ['--showConfig', '--target', 'esnext', '--module', 'commonjs', 'x.ts'] },
    { args: ['--showConfig', '--target', 'es2022', '--useDefineForClassFields', 'false', 'x.ts'] },
    { args: ['--showConfig', '--pretty', '--listFiles', '--watch', '--help', 'false', 'x.ts'] },
    { args: ['--showConfig', '--strict', '--strict', 'false', 'x.ts'] },
    { args: ['--showConfig', '--lib', 'es5', '--lib', 'dom', 'x.ts'] },
    { args: ['--showConfig', '--target', 'es2020', '--target', 'null', 'x.ts'] },
    { args: ['--showConfig', '--types', '', 'x.ts'] },
    { args: ['--showConfig', '--jsxFactory', '', '--outDir', '', 'x.ts'] },
    { args: ['--showConfig', '--watchFile', 'usefsevents', '--excludeFiles', 'a,b', 'x.ts'] },
    { args: ['--quiet', '--foo'] },
    { args: ['-q', '--foo', '--target', 'x'] },
    { args: ['--pretty', '--foo'] },
    { args: ['--pretty', 'false', '--foo'] },
    { args: ['--pretty', '--quiet', '--foo'] },
    { args: ['--foo', '--pretty'] },
  ];

  // Response files.
  const responseFiles = {
    'basic.txt': '--strict --target es2020\n',
    'quoted.txt': '"a b.ts" --showConfig "--outDir" "out dir"\n',
    'tabs.txt': '\t--showConfig\r\n\t--noEmit\r\n x.ts \r\n',
    'unterminated.txt': '--showConfig "x.ts\n',
    'empty.txt': '',
    'blank.txt': ' \n\t\n',
    'nested.txt': '@basic.txt --showConfig x.ts\n',
    'bad.txt': '--foo --target bogus\n',
    'end.txt': '--strict',
  };
  const files = { ...responseFiles, 'dir/x': '' };
  cases.push(
    { args: ['@basic.txt', '--showConfig', 'x.ts'], files },
    { args: ['@quoted.txt'], files },
    { args: ['@tabs.txt'], files },
    { args: ['@unterminated.txt'], files },
    { args: ['@empty.txt', '--showConfig', 'x.ts'], files },
    { args: ['@blank.txt', '--showConfig', 'x.ts'], files },
    { args: ['@nested.txt'], files },
    { args: ['@bad.txt'], files },
    { args: ['@missing.txt'], files },
    { args: ['@dir'], files },
    { args: ['@'], files },
    { args: ['--showConfig', 'x.ts', '@basic.txt', '@basic.txt'], files },
    { args: ['-b', '@basic.txt', '--help'], files },
    { args: ['@end.txt', '--showConfig', 'x.ts'], files, skip: 'tsgo panics on a response file ending in an argument' },
  );

  // --init
  const init = [
    ['--init'],
    ['--init', '--help'],
    ['--init', '--version'],
    ['--init', '--strict', 'false', '--target', 'es2020', '--module', 'commonjs', '--jsx', 'react'],
    ['--init', '--lib', 'es2015,dom', '--types', 'node,jest', '--outDir', 'out', '--rootDir', 'src'],
    ['--init', '--noImplicitReturns', '--noUnusedLocals', 'false', '--noPropertyAccessFromIndexSignature'],
    ['--init', '--noEmit', '--checkers', '4', '--locale', 'en', '--declaration', 'false', '--sourceMap'],
    ['--init', '--moduleResolution', 'bundler', '--newLine', 'crlf', '--target', 'es6', '--module', 'es2015'],
    ['--init', '--lib', '', '--types', ''],
    ['--init', '--outDir', 'null', '--strict', 'null'],
    ['--init', '--watch', '--noLib', '--paths', 'null', '--rootDirs', 'a,b', '--typeRoots', 'x'],
    ['--init', '--jsxFactory', 'h', '--maxNodeModuleJsDepth', '2', '--allowJs', '--checkJs'],
    ['--init', '--moduleDetection', 'legacy', '--ignoreDeprecations', '6.0', '--customConditions', 'a,b'],
    ['--init', '--lib', 'ES2015,es6,esnext.asynciterable'],
    ['--init', '--foo'],
    ['--init', '--quiet'],
  ];
  for (const args of init) cases.push({ args });
  cases.push(
    { args: ['--init'], files: { 'tsconfig.json': '{}' } },
    { args: ['--init', '--pretty'], files: { 'tsconfig.json': '{}' } },
    { args: ['--init', '--target', 'null'], skip: 'tsgo panics writing a null enum' },
    { args: ['--init', '--watchFile', 'usefsevents'], skip: 'tsgo panics writing a watch option' },
  );

  // A tsconfig.json in the working directory.
  const config = { 'tsconfig.json': '{}' };
  cases.push(
    { args: ['a.ts'], files: config },
    { args: ['a.ts', '--showConfig'], files: config },
    { args: ['--ignoreConfig', '--showConfig', 'a.ts'], files: config },
    { args: ['--showConfig'], files: config, seam: true },
    { args: [], files: config, seam: true },
    { args: ['--ignoreConfig'], files: config, seam: true },
    { args: ['-p', '.'], files: config, seam: true },
    { args: ['--version'], files: config },
    { args: ['--help'], files: config },
  );

  // Environment-driven colors.
  for (const env of [
    { NO_COLOR: '1' },
    { FORCE_COLOR: '1' },
    { FORCE_COLOR: '1', NO_COLOR: '1' },
    { FORCE_COLOR: '1', COLORTERM: 'truecolor' },
    { FORCE_COLOR: '1', TERM: 'xterm-256color' },
    { FORCE_COLOR: '1', OS: 'Windows_NT' },
    { FORCE_COLOR: '1', OS: 'Windows_NT', WT_SESSION: 'x' },
    { FORCE_COLOR: '1', OS: 'Windows_NT', TERM_PROGRAM: 'vscode' },
  ]) {
    for (const args of [
      [],
      ['--help'],
      ['--all'],
      ['-b', '--help'],
      ['--foo'],
      ['--pretty', 'false', '--foo'],
      ['--init'],
    ]) {
      cases.push({ args, env });
    }
  }

  // Terminal widths (through a pseudo-terminal, so colors are on too).
  if (haveScript) {
    for (const width of [40, 50, 79, 80, 81, 100, 120, 121, 160, 250]) {
      for (const args of [['--help'], ['--all'], ['-b', '--help'], ['--init'], ['--foo'], []]) {
        cases.push({ args, width });
        cases.push({ args, width, env: { NO_COLOR: '1' } });
      }
    }
  }
  return cases;
}

/** Locales: only whether tsgo accepts them is compared, since valid ones change the message language. */
function localeCases() {
  const tags = [
    'en',
    'EN',
    'en-US',
    'en_us',
    'en-GB',
    'xx',
    'zz',
    'qaa',
    'abc',
    'abcd',
    'xyz',
    'tlh',
    'aa',
    'ja-jp',
    'zh-Hans',
    'zh-Hant-TW',
    'sr-Latn-RS',
    'de-1996',
    'de-1997',
    'en-US-u-ca-gregory',
    'en-u-ca-gregory-ca-buddhist',
    'en-u-ca-gregory-ca-gregory',
    'en-u-foo',
    'en-x-foo',
    'x-foo',
    'x',
    'i-klingon',
    'i-foo',
    'art-lojban',
    'en-GB-oed',
    'root',
    'en_US_POSIX',
    'ab-cd-ef',
    'ab-cde',
    'en-',
    '-en',
    'en--us',
    '12',
    'en-12',
    'en-419',
    'es-419',
    'en-999',
    'en-USA',
    'en-Latn-USA',
    'en-Latn',
    'en-Abcd',
    'en-Latn-US-fonipa',
    'en-fonipa-fonipa',
    'en-abcde',
    'en-a',
    'en-a-bb',
    'en-a-b',
    'en-t-ja',
    'en-t-ja-jp',
    'en-t-xx',
    'en-t-k0-abc',
    'en-u',
    'en-u-ab',
    'en-US-x',
    'en-x-a-b',
    'zh-min-nan',
    'zh-cmn',
    'zh-xxx',
    'sgn-BE-FR',
    'no-bok',
    'cel-gaulish',
    'en-US-1abc',
    'de-CH-1901',
    'en-toolongtag',
    'en-US-u-attr-ca-gregory',
    'en-u-attr',
    'fr-FR-u-nu-latn-x-priv',
    'und',
    'mul',
    'zxx',
    'en-ZZ',
    'en-QQ',
    'en-XA',
    'en-AA',
    'en-001',
    'en-150',
    'pt-BR',
    'cs',
    'ko',
    'pl',
    'ru',
    'tr',
    'it',
    'es',
    'fr',
    'tlh-x-a',
    'é',
    'en-é',
  ];
  return tags.flatMap((tag) => [
    { args: ['--locale', tag, '--foo'], compare: 'locale' },
    { args: ['-b', '--locale', tag, '--foo'], compare: 'locale' },
  ]);
}

/** Messages, help and `--init` comments in the languages `--locale` selects. */
function localizedCases() {
  const tags = ['de', 'fr-FR', 'ja', 'zh-CN', 'zh-Hant', 'ko', 'ru', 'pt-BR', 'cs', 'pl', 'tr', 'it', 'es', 'i-lux'];
  const cases = [];
  for (const tag of tags) {
    for (const args of [
      ['--foo'],
      ['--foo', '--target', 'bogus', '--strict', 'x', '--checkers', '0'],
      ['--watch', '--listFilesOnly'],
      ['--project', 'missing'],
      ['--version'],
      ['--help'],
      ['--all'],
      [],
      ['-b', '--help'],
      ['-b', '--foo', '--clean', '--force'],
      ['--init'],
    ]) {
      cases.push({ args: ['--locale', tag, ...args] });
    }
    // The locale applies to errors given before it, too.
    cases.push({ args: ['--foo', '--locale', tag] });
    cases.push({ args: ['--locale', tag, '--foo', '--strict', 'x'], env: { FORCE_COLOR: '1' } });
    cases.push({ args: ['--locale', tag, '--init'], files: { 'tsconfig.json': '{}' } });
  }
  // Wrapping counts UTF-8 bytes. tsgo can split a character there, writing invalid UTF-8; in these
  // locales' help no line break falls inside one.
  if (haveScript) {
    for (const tag of ['es', 'it']) {
      for (const width of [80, 120]) cases.push({ args: ['--locale', tag, '--help'], width });
    }
  }
  return cases;
}

// ---- running

function setUp(dir, files = {}) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function shellQuote(s) {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

/** Runs `command` in a fresh directory; returns what the comparison looks at. */
function run(command, testCase, label) {
  const dir = mkdtempSync(join(work, label + '-'));
  setUp(dir, testCase.files);
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, ...compileCache, ...testCase.env };
  let file = command[0];
  let args = [...command.slice(1), ...testCase.args];
  if (testCase.width !== undefined) {
    // `script` gives the process a terminal of the given width.
    const line = [command[0], ...args].map(shellQuote).join(' ');
    file = 'script';
    args = ['-qec', `stty cols ${testCase.width} rows 40; exec ${line}`, '/dev/null'];
    env.TERM = env.TERM ?? 'dumb';
  }
  return new Promise((done) => {
    const options = { cwd: dir, env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 20000 };
    execFile(file, args, options, (error, stdout, stderr) => {
      const configPath = join(dir, 'tsconfig.json');
      const wroteConfig = !(testCase.files && 'tsconfig.json' in testCase.files) && existsSync(configPath);
      const config = wroteConfig ? readFileSync(configPath, 'utf8') : null;
      rmSync(dir, { recursive: true, force: true });
      const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      done({ stdout: stdout.replaceAll(dir, '<cwd>'), stderr, status, config });
    });
  });
}

/** Runs `fn` on every item, `limit` at a time. */
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function firstDifference(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}: tsgo ${JSON.stringify(al[i])}, ours ${JSON.stringify(bl[i])}`;
  }
  return 'none';
}

function describe(testCase) {
  const extra = [];
  if (testCase.env) extra.push(JSON.stringify(testCase.env));
  if (testCase.width !== undefined) extra.push(`width ${testCase.width}`);
  if (testCase.files) extra.push('files ' + Object.keys(testCase.files).join(','));
  return JSON.stringify(testCase.args) + (extra.length ? ' (' + extra.join('; ') + ')' : '');
}

/** Compares all cases; returns counts and mismatch descriptions. */
async function compare(cases) {
  const shard = /^(\d+)\/(\d+)$/.exec(process.env.CLI_SHARD ?? '');
  if (shard !== null) cases = cases.filter((_, i) => i % Number(shard[2]) === Number(shard[1]) - 1);
  const counts = { total: cases.length, matched: 0, skipped: 0, seam: 0 };
  const skips = new Map();
  const failures = [];
  await pool(cases, 12, async (testCase) => {
    if (testCase.skip) {
      counts.skipped++;
      skips.set(testCase.skip, (skips.get(testCase.skip) ?? 0) + 1);
      return;
    }
    if (testCase.seam) {
      // tsgo may check and emit here: compare only if ours stops before that.
      const actual = await run(ours, testCase, 'ours');
      if (actual.status === 5 && actual.stderr.includes('is not implemented yet')) {
        counts.seam++;
        return;
      }
    }
    const [expected, actual] = await Promise.all([run([tsgo], testCase, 'tsgo'), run(ours, testCase, 'ours')]);
    if (testCase.compare === 'locale') {
      const rejected = (r) => r.stdout.includes('TS6048');
      if (rejected(expected) === rejected(actual) && expected.status === actual.status) counts.matched++;
      else failures.push(`${describe(testCase)}: tsgo ${rejected(expected) ? 'rejects' : 'accepts'} the locale`);
      return;
    }
    const problems = [];
    if (expected.stdout !== actual.stdout) problems.push('stdout ' + firstDifference(expected.stdout, actual.stdout));
    if (expected.stderr !== actual.stderr) problems.push('stderr ' + firstDifference(expected.stderr, actual.stderr));
    if (expected.status !== actual.status) problems.push(`status tsgo ${expected.status}, ours ${actual.status}`);
    if (expected.config !== actual.config) {
      problems.push('tsconfig.json ' + firstDifference(String(expected.config), String(actual.config)));
    }
    if (problems.length === 0) counts.matched++;
    else failures.push(`${describe(testCase)}:\n    ${problems.join('\n    ')}`);
  });
  return { counts, skips, failures };
}

async function check(t, name, cases) {
  const { counts, skips, failures } = await compare(cases);
  const skipped = [...skips].map(([reason, n]) => `${n} ${reason}`).join('; ');
  t.diagnostic(
    `${name}: ${counts.matched}/${counts.total - counts.skipped - counts.seam} match, ` +
      `${counts.seam} reach compilation, ${counts.skipped} skipped${skipped ? ` (${skipped})` : ''}`,
  );
  assert.deepEqual(failures.slice(0, 25), [], `${failures.length} mismatches`);
}

test('every option, value and spelling', { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' }, (t) =>
  check(t, 'options', optionCases()),
);

test('tsc --build arguments', { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' }, (t) =>
  check(t, 'build', buildCases()),
);

test(
  'help, init, showConfig, response files, colors and widths',
  { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' },
  (t) => check(t, 'misc', miscCases()),
);

test('locale validation', { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' }, (t) =>
  check(t, 'locale', localeCases()),
);

test('localized output', { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' }, (t) =>
  check(t, 'localized', localizedCases()),
);

test.after(() => rmSync(work, { recursive: true, force: true }));
