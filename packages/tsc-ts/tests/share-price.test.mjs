import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyUnifiedDiff, writeSharePriceSources } from '../scripts/share-price-sources.mjs';

// A price build compiles a copy of src/ with scripts/share-price-sources.patch applied, and a release build compiles
// src/ itself. These tests keep the patch applying to the sources it ships with, and keep the replay's rules from
// counting work they do not do: a post the run never measured, a translation a take does not pay for, and a wall
// estimate that saves time the bottleneck checker still spends.

const packageRoot = join(import.meta.dirname, '..');

test('the price patch applies to the sources it ships with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-price-sources-'));
  try {
    const source = readFileSync(join(packageRoot, 'src', 'compiler', 'parallel-check.ts'), 'utf8');
    const entry = writeSharePriceSources(packageRoot, join(dir, 'share-price'));
    assert.ok(entry.endsWith(join('src', 'main.ts')), entry);
    assert.match(
      readFileSync(join(dir, 'share-price', 'src', 'compiler', 'parallel-check.ts'), 'utf8'),
      /TSC_TS_SHARE_PRICE/,
    );
    assert.match(readFileSync(join(dir, 'share-price', 'src', 'compiler', 'thread-entry.ts'), 'utf8'), /writePriceLog/);
    assert.equal(readFileSync(join(packageRoot, 'src', 'compiler', 'parallel-check.ts'), 'utf8'), source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hunk whose line numbers drifted is found by its own lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-price-drift-'));
  try {
    const file = join(dir, 'file.ts');
    writeFileSync(file, ['const added: string[] = [];', 'export function f(): void {', '  one();', '}', ''].join('\n'));
    applyUnifiedDiff(
      [
        'diff --git a/file.ts b/file.ts',
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -1,3 +1,4 @@',
        ' export function f(): void {',
        '   one();',
        '+  two();',
        ' }',
        '',
      ].join('\n'),
      dir,
    );
    assert.equal(
      readFileSync(file, 'utf8'),
      ['const added: string[] = [];', 'export function f(): void {', '  one();', '  two();', '}', ''].join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hunk whose lines are gone fails instead of patching something else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-price-missing-'));
  try {
    const file = join(dir, 'file.ts');
    const before = ['export function f(): void {', '  one();', '}', ''].join('\n');
    writeFileSync(file, before);
    assert.throws(
      () =>
        applyUnifiedDiff(
          [
            'diff --git a/file.ts b/file.ts',
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -1,3 +1,4 @@',
            ' export function f(): void {',
            '   gone();',
            '+  two();',
            ' }',
            '',
          ].join('\n'),
          dir,
        ),
      /does not apply/,
    );
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The replay's rules

const milliseconds = (value) => value.toFixed(3);

/** One `t` line of a price log: a translation of a posted result, and the checker that posted it. */
function translation(fields) {
  return [
    't',
    fields.key,
    fields.kind ?? 0,
    fields.producer,
    milliseconds(fields.start),
    milliseconds(fields.end),
    fields.walked ?? 1,
    fields.built ?? 1,
    milliseconds(fields.unpackMs ?? 0),
    milliseconds(fields.buildMs ?? 0),
    fields.types ?? 0,
    fields.symbols ?? 0,
    fields.taken === false ? 0 : 1,
  ].join(' ');
}

/** One `c` line of a price log: a computation, its outcome, its file, and the dry run of its export. */
function computation(fields) {
  return [
    'c',
    fields.key,
    fields.kind ?? 0,
    fields.outcome ?? 1,
    fields.file ?? 0,
    fields.taker ?? 100,
    milliseconds(fields.start),
    milliseconds(fields.end),
    fields.depth ?? 0,
    fields.shareable ?? 1,
    fields.annotated ?? 1,
    fields.diagnosticFiles ?? 0,
    fields.reason ?? '-',
    fields.slot ?? -1,
    fields.records ?? -1,
    -1,
    -1,
    -1,
    0,
    0,
  ].join(' ');
}

/** One checker's log: the names its file fields index, its computations and the interval it checked in. */
function log(index, names, computations, start, end) {
  return [
    `# tsc-ts share price, checker ${index} of 2`,
    'origin 0',
    ...names.map((name, at) => `n ${at} ${name}`),
    ...computations,
    `w ${index} ${milliseconds(start)} ${milliseconds(end)}`,
    '',
  ].join('\n');
}

/** Runs the replay on two logs and returns what it reports, as JSON. */
function replay(dir, files) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const json = join(dir, 'replay.json');
  const run = spawnSync(
    process.execPath,
    [join(packageRoot, 'scripts', 'share-price.mjs'), '--logs', dir, '--json', json],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(readFileSync(json, 'utf8'));
}

const ruleOf = (report, name) => report.rules.find((rule) => rule.name === name);

test('a result the run never exported is not replayed as a zero-record post', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-price-export-'));
  try {
    const report = replay(dir, {
      'price-c0-1.log': log(0, ['src/a.ts'], [computation({ key: 42, start: 0, end: 3 })], 0, 5),
      'price-c1-1.log': log(1, ['src/a.ts'], [computation({ key: 42, start: 4, end: 8 })], 0, 10),
    });
    for (const rule of report.rules) assert.equal(rule.posts, 0, rule.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a take whose translation fits the budget is taken, and its translation is charged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-price-budget-'));
  try {
    const report = replay(dir, {
      'price-c0-1.log': log(0, ['src/a.ts'], [computation({ key: 7, start: 0, end: 100, records: 10 })], 0, 100),
      'price-c1-1.log': log(1, ['src/a.ts'], [computation({ key: 7, start: 110, end: 120 })], 0, 1000),
    });
    const budgeted = ruleOf(report, 'with λ budget');
    // 10 records built at 6.3 µs each fit under 0.5 of the producer's 100 ms.
    assert.equal(budgeted.takes, 1);
    assert.ok(Math.abs(budgeted.takeMs - 0.063) < 1e-9, `takeMs ${budgeted.takeMs}`);
    assert.ok(Math.abs(budgeted.savedMs - 10) < 1e-9, `savedMs ${budgeted.savedMs}`);
    assert.ok(Math.abs(budgeted.postMs - 0.0123) < 1e-9, `postMs ${budgeted.postMs}`);
    assert.ok(Math.abs(budgeted.netMs - (10 - 0.063 - 0.0123)) < 1e-9, `netMs ${budgeted.netMs}`);
    // The consumer's checker is the longest one, so the rule's wall time is its busy time with the take priced in.
    assert.ok(Math.abs(budgeted.wallMs - (1000 - 10 + 0.063)) < 1e-6, `wallMs ${budgeted.wallMs}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ρ pairs a translation with the producer’s own computation, not a longer duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-price-rho-'));
  try {
    const report = replay(dir, {
      // The owner computes the result for a file it owns and posts it; the consumer translates it.
      'price-c0-1.log': log(0, ['src/a.ts'], [computation({ key: 42, outcome: 0, start: 0, end: 1 })], 0, 60),
      'price-c1-1.log': log(
        1,
        ['src/a.ts'],
        [
          // The consumer computes the same key itself, for longer than the producer did.
          computation({ key: 42, start: 20, end: 60 }),
          translation({ key: 42, producer: 0, start: 40, end: 50, unpackMs: 0.3, buildMs: 0.2 }),
        ],
        0,
        60,
      ),
    });
    // 0.5 ms of translation over the owner's 1 ms, not over the consumer's 40 ms computation of the same key.
    assert.ok(Math.abs(report.rhoP10 - 0.5) < 1e-9, `rhoP10 ${report.rhoP10}`);
    assert.equal(report.rhoSmallCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a take on another checker saves no wall time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-price-wall-'));
  try {
    const report = replay(dir, {
      'price-c0-1.log': log(0, ['src/a.ts'], [computation({ key: 9, start: 0, end: 50, records: 10 })], 0, 1000),
      'price-c1-1.log': log(1, ['src/a.ts'], [computation({ key: 9, start: 60, end: 80 })], 0, 100),
    });
    const budgeted = ruleOf(report, 'with λ budget');
    assert.equal(budgeted.takes, 1);
    // The first checker is the longest one and the take costs it a post, so the wall time cannot fall below it.
    assert.ok(budgeted.wallMs > 1000, `wallMs ${budgeted.wallMs}`);
    assert.ok(Math.abs(budgeted.wallMs - 1000.0123) < 1e-6, `wallMs ${budgeted.wallMs}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
