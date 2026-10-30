import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractedCases, pathCases, unitCases } from './module-resolution-cases.mjs';
import { compileSources } from './temp.mjs';

// Compares the resolver with tsgo's (packages/tsgo/dist/resolve-oracle, built by `npm run build:oracle`).
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const oracle = join(root, 'packages/tsgo/dist/resolve-oracle');

const out = compileSources('tsc-ts-resolve-', ['drivers/resolve.ts']);
const path = await import(pathToFileURL(join(out, 'compiler/path.js')).href);
const types = await import(pathToFileURL(join(out, 'compiler/options.js')).href);
const driver = join(out, 'drivers/resolve.js');

function run(cases, name) {
  const file = join(out, name + '.json');
  writeFileSync(file, JSON.stringify(cases));
  const options = { maxBuffer: 1 << 30, encoding: 'utf8' };
  const expected = JSON.parse(execFileSync(oracle, [file], options));
  const actual = JSON.parse(execFileSync(process.execPath, [driver, file], options));
  // RESOLVE_NATIVE names a scriptc build of src/drivers/resolve.ts, which must print the same results.
  if (process.env.RESOLVE_NATIVE) {
    assert.deepEqual(JSON.parse(execFileSync(process.env.RESOLVE_NATIVE, [file], options)), actual, `${name}: native`);
  }
  return { expected, actual };
}

/** Go encodes empty slices as null and omits empty `names`. */
function normalize(result) {
  if (result.error !== undefined) return { error: result.error };
  const names = result.names !== undefined && result.names.length > 0 ? { names: result.names } : {};
  return { ...result, diagnostics: result.diagnostics ?? [], traces: result.traces ?? [], names: undefined, ...names };
}

/** Compares results, returning counts and the first few mismatches. */
function compare(cases, expected, actual) {
  const counts = { cases: 0, skipped: 0, requests: 0, matched: 0, traces: 0, traceMatched: 0 };
  const mismatches = [];
  cases.forEach((c, i) => {
    if (expected[i].some((r) => r.error !== undefined)) {
      counts.skipped++;
      return;
    }
    counts.cases++;
    c.requests.forEach((request, j) => {
      const e = normalize(expected[i][j]);
      const a = normalize(actual[i][j]);
      counts.requests++;
      counts.traces += e.traces.length;
      const tracesEqual = JSON.stringify(e.traces) === JSON.stringify(a.traces);
      if (tracesEqual) counts.traceMatched += e.traces.length;
      if (JSON.stringify(e) === JSON.stringify(a)) counts.matched++;
      else if (mismatches.length < 5) mismatches.push({ test: c.test, request, expected: e, actual: a });
    });
  });
  return { counts, mismatches };
}

function check(cases, name) {
  const { expected, actual } = run(cases, name);
  assert.equal(actual.length, expected.length);
  const { counts, mismatches } = compare(cases, expected, actual);
  console.log(`${name}: ${JSON.stringify(counts)}`);
  for (const m of mismatches) {
    console.log(JSON.stringify(m.request), m.test ?? '');
    for (const key of new Set([...Object.keys(m.expected), ...Object.keys(m.actual)])) {
      if (JSON.stringify(m.expected[key]) !== JSON.stringify(m.actual[key])) {
        console.log(
          ' ',
          key,
          '\n    expected',
          JSON.stringify(m.expected[key]),
          '\n    actual  ',
          JSON.stringify(m.actual[key]),
        );
      }
    }
  }
  assert.equal(counts.matched, counts.requests, `${name}: ${counts.requests - counts.matched} mismatches`);
  return counts;
}

const skip = existsSync(oracle) ? false : 'resolve-oracle is not built';

test('containsPath answers by components, also on its fast path for normalized absolute paths', () => {
  const byComponents = (parent, child, caseSensitive, cwd) => {
    parent = path.combinePaths(cwd, parent);
    child = path.combinePaths(cwd, child);
    if (parent === '' || child === '') return false;
    if (parent === child) return true;
    const p = path.reducePathComponents(path.getPathComponents(parent));
    const c = path.reducePathComponents(path.getPathComponents(child));
    if (c.length < p.length) return false;
    for (let i = 0; i < p.length; i++) {
      const a = i === 0 || !caseSensitive ? p[i].toUpperCase() : p[i];
      const b = i === 0 || !caseSensitive ? c[i].toUpperCase() : c[i];
      if (a !== b) return false;
    }
    return true;
  };
  const segments = ['', '/', 'a', 'A', 'ab', 'b', '.', '..', '.a', '..a', 'a.', 'a\\b', 'src', 'src2'];
  const paths = [''];
  for (const s of segments) paths.push(s, '/' + s);
  for (const s of segments)
    for (const t of segments) paths.push('/' + s + '/' + t, s + '/' + t, '/' + s + '/' + t + '/');
  paths.push('//server/share', 'c:/a/b', 'file:///a', '/a/b/c/d', '/a/b/c/../d', '/a/./b');
  let fast = 0;
  for (const caseSensitive of [true, false])
    for (const cwd of ['', '/a/b/'])
      for (const parent of paths)
        for (const child of paths) {
          const expected = byComponents(parent, child, caseSensitive, cwd);
          assert.equal(
            path.containsPath(parent, child, caseSensitive, cwd),
            expected,
            `${parent} ${child} ${caseSensitive} ${cwd}`,
          );
          if (expected && caseSensitive && parent.startsWith('/') && !parent.includes('.')) fast++;
        }
  assert.ok(fast > 100);
});

test('tsgo unit fixtures', { skip }, () => {
  check(unitCases(), 'unit');
});

test('path utilities', { skip }, () => {
  check(pathCases(), 'paths');
});

test('TypeScript test cases', { skip }, () => {
  const cases = extractedCases(join(root, 'upstream/TypeScript/tsc/testdata/tests/cases'), path, types);
  const counts = check(cases, 'extracted');
  assert.ok(counts.requests > 1000);
});

test('TypeScript test cases without tracing (cached lookups)', { skip }, () => {
  const cases = extractedCases(join(root, 'upstream/TypeScript/tsc/testdata/tests/cases'), path, types).map((c) => ({
    ...c,
    options: { ...c.options, traceResolution: false },
  }));
  check(cases, 'extracted-untraced');
});

test('TypeScript test cases on a case-insensitive file system', { skip }, () => {
  const cases = extractedCases(join(root, 'upstream/TypeScript/tsc/testdata/tests/cases'), path, types)
    .filter((c) => c.useCaseSensitiveFileNames)
    .map((c) => ({ ...c, useCaseSensitiveFileNames: false }));
  check(cases, 'extracted-insensitive');
});
