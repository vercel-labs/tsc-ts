// Checks TypeScript's compiler and conformance test cases with the checker and with the reference
// check oracle, and reports how many files match exactly.
//
// Usage: node scripts/check-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [--cache FILE]
//                                      [--save FILE] [--list] [--show CODE] [--js] [--options A,B]
//                                      [compiler|conformance|DIR|FILE ...]
//
// Test cases are checked whole, as `/input.ts`, as `/input.tsx` with their JSX directives, or as
// `/input.js` when all their files are JavaScript and they set @checkJs (--js checks only those).
// Without --native, the checker runs under Node from a tsc build. --cache stores the oracle's
// output, which only changes with the reference build.
// --save writes the checker's output as JSON. --list prints the differing files; --show CODE prints
// the files with mismatches of that code. --options turns on boolean options (such as
// exactOptionalPropertyTypes or noUncheckedIndexedAccess) for every file in both compilers, through
// TSC_TS_CHECK_OPTIONS, and sets module, moduleResolution and target as name=value and the strict
// family, allowUnreachableCode and allowUnusedLabels as name=true or name=false (such as
// strictNullChecks=false); a --cache file holds the oracle's output for one set of options.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { tempDir } from '../tests/temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const valued = new Set(['--native', '--jobs', '--limit', '--cache', '--show', '--save', '--options']);
const jobs = Number(option('--jobs', Math.min(16, availableParallelism())));
const limit = Number(option('--limit', Infinity));
const cacheFile = option('--cache', undefined);
const show = option('--show', undefined);
const saveFile = option('--save', undefined);
const list = args.includes('--list');
const jsOnly = args.includes('--js');
const checkOptions = option('--options', '');
const env = { ...process.env, TSC_TS_CHECK_OPTIONS: checkOptions };
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const libs = join(repo, 'upstream/TypeScript/tsc/internal/bundled/libs');
const cases = join(repo, 'upstream/TypeScript/tsc/testdata/tests/cases');
const oracle = join(repo, 'packages/tsgo/dist/check-oracle');
const work = tempDir('tsc-ts-check-corpus-');

function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  const out = [];
  for (const name of readdirSync(path)) out.push(...files(join(path, name)));
  return out.filter((f) => /\.tsx?$/.test(f)).sort();
}

const native = option('--native', undefined);
let check = native !== undefined ? [resolve(native)] : undefined;
if (check === undefined) {
  const out = join(work, 'js');
  const options = ['--strict', '--target', 'es2024', '--module', 'nodenext', '--moduleResolution', 'nodenext'];
  const tsc = spawnSync(
    join(repo, 'node_modules/.bin/tsc'),
    ['--outDir', out, ...options, '--skipLibCheck', '--types', 'node', join(root, 'src/drivers/check.ts')],
    {
      stdio: 'inherit',
    },
  );
  if (tsc.status !== 0) throw new Error('could not compile the checker');
  check = [process.execPath, '--stack-size=16000', '--max-old-space-size=6000', join(out, 'drivers/check.js')];
}

// Runs a batch and returns diagnostics by file; files of a batch that crashes or times out are missing.
function run(command, batch) {
  const listFile = join(work, `list-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(listFile, batch.join('\n') + '\n');
  return new Promise((done) => {
    const child = spawn(command[0], [...command.slice(1), listFile, libs, '--batch'], { timeout: 600_000, env });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('close', () => {
      const byFile = new Map();
      let current;
      for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
        if (line.startsWith('== ')) byFile.set((current = line.slice(3)), []);
        else if (current !== undefined && line !== '') byFile.get(current).push(line);
      }
      done(byFile);
    });
  });
}

async function runAll(command, paths) {
  const batches = [];
  for (let i = 0; i < paths.length; i += 100) batches.push(paths.slice(i, i + 100));
  const results = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < batches.length)
        for (const [file, diags] of await run(command, batches[next++])) results.set(file, diags);
    }),
  );
  return results;
}

async function expectedResults(paths) {
  const cached =
    cacheFile !== undefined && existsSync(cacheFile)
      ? new Map(Object.entries(JSON.parse(readFileSync(cacheFile, 'utf8'))))
      : new Map();
  // Entries for other options are stale.
  if ((cached.get('#options')?.[0] ?? '') !== checkOptions) cached.clear();
  cached.set('#options', [checkOptions]);
  // Entries from before JavaScript cases were checked as JavaScript are stale.
  if (!cached.has('#js')) for (const key of cached.keys()) if (existsSync(key) && isCheckedJS(key)) cached.delete(key);
  cached.set('#js', []);
  // Entries from before .tsx cases were checked as JSX are stale.
  if (!cached.has('#jsx')) for (const key of cached.keys()) if (key.endsWith('.tsx')) cached.delete(key);
  cached.set('#jsx', []);
  const missing = paths.filter((p) => !cached.has(p));
  if (missing.length > 0) {
    for (const [file, diags] of await runAll([oracle], missing)) cached.set(file, diags);
    if (cacheFile !== undefined) writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cached)));
  }
  return cached;
}

const code = (line) => line.split(' ')[1];

/** Whether a test case is checked as JavaScript, as the check drivers decide. */
function isCheckedJS(path) {
  if (path.endsWith('.tsx')) return false;
  let units = 0;
  let checkJs = false;
  for (const m of readFileSync(path, 'utf8').matchAll(/^[ \t]*\/\/[ \t]*@(\w+)[ \t]*:([^\r\n]*)/gim)) {
    const value = m[2].trim();
    const name = m[1].toLowerCase();
    if (name === 'filename') {
      if (!/\.(js|jsx|cjs|mjs)$/i.test(value)) return false;
      units++;
    } else if (name === 'checkjs') checkJs = value.split(',')[0].trim().toLowerCase() === 'true';
  }
  return units > 0 && checkJs;
}

const suites = inputs.length > 0 ? inputs : ['compiler', 'conformance'];
const jsCases = new Set();
const paths = suites
  .flatMap((s) => files(existsSync(s) ? resolve(s) : join(cases, s)))
  .filter((p) => {
    if (!isCheckedJS(p)) return !jsOnly;
    jsCases.add(p);
    return true;
  })
  .slice(0, limit);
const start = performance.now();
const [expected, actual] = await Promise.all([expectedResults(paths), runAll(check, paths)]);
const seconds = ((performance.now() - start) / 1000).toFixed(1);

let compared = 0;
let matched = 0;
let clean = 0;
let cleanMatched = 0;
let crashed = 0;
let jsCompared = 0;
let jsMatched = 0;
let jsxCompared = 0;
let jsxMatched = 0;
const missingByCode = new Map();
const extraByCode = new Map();
const filesByCode = new Map();
const differing = [];
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
for (const file of paths) {
  const want = expected.get(file);
  if (want === undefined || want.includes('!! panic')) continue;
  compared++;
  const isJS = jsCases.has(file);
  if (isJS) jsCompared++;
  const isJsx = file.endsWith('.tsx');
  if (isJsx) jsxCompared++;
  const got = actual.get(file);
  if (want.length === 0) clean++;
  if (got !== undefined && JSON.stringify(want) === JSON.stringify(got)) {
    matched++;
    if (isJS) jsMatched++;
    if (isJsx) jsxMatched++;
    if (want.length === 0) cleanMatched++;
    continue;
  }
  differing.push(file);
  if (got === undefined || got.includes('!! panic')) {
    crashed++;
    continue;
  }
  const gotSet = new Set(got);
  const wantSet = new Set(want);
  const codes = new Set();
  for (const line of want) {
    if (gotSet.has(line)) continue;
    codes.add('-' + code(line));
    bump(missingByCode, code(line));
  }
  for (const line of got) {
    if (wantSet.has(line)) continue;
    codes.add('+' + code(line));
    bump(extraByCode, code(line));
  }
  for (const c of codes) {
    if (!filesByCode.has(c)) filesByCode.set(c, []);
    filesByCode.get(c).push(file);
  }
}

const pct = (a, b) => (b === 0 ? '0.0' : ((100 * a) / b).toFixed(1));
console.log(`${matched} of ${compared} files match tsgo (${pct(matched, compared)}%) in ${seconds}s`);
console.log(`${cleanMatched} of ${clean} files without diagnostics match (${pct(cleanMatched, clean)}%)`);
console.log(`${jsMatched} of ${jsCompared} JavaScript files match (${pct(jsMatched, jsCompared)}%)`);
console.log(`${jsxMatched} of ${jsxCompared} .tsx files match (${pct(jsxMatched, jsxCompared)}%)`);
console.log(`${crashed} files crashed`);
const top = (map) =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([c, n]) => `TS${c} ${n}`)
    .join(', ');
console.log(`missing diagnostics by code: ${top(missingByCode)}`);
console.log(`extra diagnostics by code: ${top(extraByCode)}`);
if (list) for (const f of differing) console.log(`  ${f}`);
if (show !== undefined) for (const f of filesByCode.get(show) ?? []) console.log(`  ${f}`);
if (saveFile !== undefined) writeFileSync(saveFile, JSON.stringify(Object.fromEntries(actual)));
