// Times tsc-ts against tsgo and TypeScript's JavaScript compiler on the same
// inputs. Usage: node scripts/bench.mjs [--runs N] [--json FILE]
// SCRIPTC selects the scriptc executable used for native builds.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const runs = Number(option('--runs', '5'));
const jsonFile = option('--json', undefined);

const repo = resolve('../..');
const libs = join(repo, 'upstream/TypeScript/tsc/internal/bundled/libs');
const cases = join(repo, 'upstream/TypeScript/tsc/testdata/tests/cases');
const scriptc = process.env.SCRIPTC ?? join(repo, 'node_modules/.bin/scriptc');
const scanOracle = join(repo, 'packages/tsgo/dist/scan-oracle');
const tsgo = join(repo, 'packages/tsgo/dist/tsgo');
const ts = createRequire(import.meta.url)('typescript');
const out = resolve(process.env.SCRIPTC === undefined ? 'dist/bench' : 'dist/bench-custom');
mkdirSync(out, { recursive: true });

const files = [
  join(libs, 'lib.dom.d.ts'),
  join(libs, 'lib.es5.d.ts'),
  join(cases, 'compiler/largeControlFlowGraph.ts'),
  join(cases, 'compiler/manyConstExports.ts'),
].filter((f) => existsSync(f));
// The tsc-ts sources, the self-check project.
const projects = [resolve('.')];

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

// Builds a native driver unless it is newer than every source file.
function native(driver) {
  const exe = join(out, driver.replace(/\.ts$/, '').replaceAll('/', '-'));
  const sources = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' }).trim().split('\n');
  const newest = Math.max(...sources.map((f) => statSync(f).mtimeMs));
  if (!existsSync(exe) || statSync(exe).mtimeMs < newest) {
    execFileSync(scriptc, ['build', driver, '--optimization=speed', '--no-keep-llvm', '-o', exe], {
      stdio: 'inherit',
    });
  }
  return exe;
}

// Milliseconds per scan of a file, from a driver's `--bench` output.
function scanTime(command, file) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const text = execFileSync(command[0], [...command.slice(1), file, '--bench'], { encoding: 'utf8' });
    times.push(Number(/time ([\d.]+)ms/.exec(text)[1]));
  }
  return median(times);
}

function scanJs(file) {
  const text = ts.sys.readFile(file);
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    for (let round = 0; round < 20; round++) {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
      while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken);
    }
    times.push((performance.now() - start) / 20);
  }
  return median(times);
}

// Milliseconds for a whole command, median of runs.
function wallTime(command, cwd) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    spawnSync(command[0], command.slice(1), { cwd, stdio: 'ignore' });
    times.push(performance.now() - start);
  }
  return median(times);
}

const scanNative = native('src/drivers/scan.ts');
const results = { date: new Date().toISOString(), cpu: cpus()[0].model, runs, scan: [], check: [] };

for (const file of files) {
  results.scan.push({
    file: file.slice(repo.length + 1),
    tscTsNative: scanTime([scanNative], file),
    tsgo: scanTime([scanOracle], file),
    typescriptJs: scanJs(file),
  });
}
for (const project of projects) {
  results.check.push({
    project: project.slice(repo.length + 1),
    tsgo: wallTime([tsgo, '-p', '.', '--noEmit'], project),
    typescriptJs: wallTime(
      [process.execPath, join(repo, 'node_modules/typescript/lib/tsc.js'), '-p', '.', '--noEmit'],
      project,
    ),
  });
}

const ms = (n) => (n === undefined ? '–' : n.toFixed(2) + ' ms');
console.log('\nScan (per file)\n');
console.log('| File | tsc-ts native | tsgo | TypeScript 5.9 (JS) |');
console.log('| --- | ---: | ---: | ---: |');
for (const r of results.scan)
  console.log(`| ${r.file} | ${ms(r.tscTsNative)} | ${ms(r.tsgo)} | ${ms(r.typescriptJs)} |`);
console.log('\nCheck (whole project, wall time)\n');
console.log('| Project | tsgo | TypeScript 5.9 (JS) |');
console.log('| --- | ---: | ---: |');
for (const r of results.check) console.log(`| ${r.project} | ${ms(r.tsgo)} | ${ms(r.typescriptJs)} |`);
if (jsonFile !== undefined) writeFileSync(jsonFile, JSON.stringify(results, null, 2) + '\n');
