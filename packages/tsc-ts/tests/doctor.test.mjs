// `tsc-ts doctor`: the command line, the child report `TSC_TS_DOCTOR_REPORT` writes, and the samples
// doctor stores in the project's record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';
import { tscTs, tscTsMissing, typescriptLib } from './toolchain.mjs';

const skip = tscTsMissing;

/** Runs tsc-ts in `dir` with `args`, and the lib files of the TypeScript the harness compares against. */
function run(dir, args, env = {}) {
  const result = spawnSync(tscTs[0], [...tscTs.slice(1), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: typescriptLib, NO_COLOR: '1', TSC_TS_CACHE: '0', ...env },
    encoding: 'utf8',
  });
  return { output: result.stdout + result.stderr, status: result.status };
}

/** A project of one file that checks without emitting. */
function project() {
  const dir = tempDir('tsc-ts-doctor-project-');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true,"noEmit":true,"types":[]},"files":["a.ts"]}\n',
  );
  writeFileSync(join(dir, 'a.ts'), 'export const a: number = 1;\n');
  return dir;
}

/** A project whose config sets `compilerOptions`, of the files `files` (name to text). */
function configured(compilerOptions, files = { 'a.ts': 'export const a: number = 1;\n' }) {
  const dir = tempDir('tsc-ts-doctor-project-');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: Object.keys(files) }) + '\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test('doctor --help prints the usage and exits 0', { skip }, () => {
  const { output, status } = run(project(), ['doctor', '--help']);
  assert.equal(status, 0);
  assert.match(output, /^Usage: tsc-ts doctor /m);
  assert.match(output, /--no-save/);
});

test('doctor rejects an unknown option', { skip }, () => {
  const { output, status } = run(project(), ['doctor', '--nonsense']);
  assert.equal(status, 1);
  assert.match(output, /doctor: unknown option --nonsense/);
});

test('doctor reports a project it cannot check, and does not measure it', { skip }, () => {
  const { output, status } = run(project(), ['doctor', '-p', 'missing.json', '--runs', '1']);
  assert.equal(status, 1);
  assert.match(output, /doctor: the first run did not check the project/);
  assert.doesNotMatch(output, /Configuration/);
});

test('doctor measures a project and prints its configurations as one JSON object', { skip }, () => {
  const { output, status } = run(project(), [
    'doctor',
    '-p',
    '.',
    '--runs',
    '2',
    '--budget',
    '60',
    '--no-save',
    '--json',
  ]);
  assert.equal(status, 0, output);
  const result = JSON.parse(output);
  assert.equal(result.project, 'tsconfig.json');
  assert.ok(result.machine.cpus >= 1);
  assert.ok(result.shape.files > 1);
  assert.ok(result.shape.chars > 0);
  const ids = result.configurations.map((configuration) => configuration.id);
  assert.equal(ids[0], 'A');
  assert.equal(new Set(ids).size, ids.length);
  for (const configuration of result.configurations) {
    assert.equal(configuration.runs, 2);
    assert.equal(configuration.output, configuration.id === 'A' ? 'reference' : 'same');
  }
  // Configuration A is the default: the checker count and parse threads its runs used.
  assert.ok(result.before.checkers >= 1);
  assert.ok(result.before.parseThreads >= 1);
  assert.equal(result.before.share, false);
  assert.equal(typeof result.recommended.checkers, 'number');
  assert.equal(typeof result.recommended.share, 'boolean');
  assert.equal(typeof result.recommended.parseThreads, 'number');
  assert.equal(result.saved.reason, '--no-save');
});

test('doctor compares the diagnostics of a project whose config prints the statistics', { skip }, () => {
  const dir = configured({ strict: true, noEmit: true, types: [], diagnostics: true, extendedDiagnostics: true });
  const { output, status } = run(dir, ['doctor', '-p', '.', '--runs', '1', '--budget', '60', '--no-save', '--json']);
  assert.equal(status, 0, output);
  const result = JSON.parse(output);
  assert.equal(result.output, 'same');
  for (const configuration of result.configurations) assert.notEqual(configuration.output, 'differs');
});

test('doctor checks a composite project on every run', { skip }, () => {
  const dir = configured({ strict: true, composite: true, declaration: true, outDir: 'out', types: [] });
  const { output, status } = run(dir, ['doctor', '-p', '.', '--runs', '1', '--budget', '60', '--no-save', '--json']);
  // A run that the compiler refuses to check exits 1, with the child's error: TS6379 here, before
  // the run got a build info file of its own.
  assert.equal(status, 0, output);
  const result = JSON.parse(output);
  assert.equal(result.output, 'same');
  assert.ok(!existsSync(join(dir, 'tsconfig.tsbuildinfo')), 'the run wrote build info into the project');
});

test('a run takes the settings the project allows: statistics off, and no declarationDir without declarations', async () => {
  const out = compileSources('tsc-ts-doctor-args-', ['main.ts']);
  const { runArguments } = await import(pathToFileURL(join(out, 'drivers/doctor.js')).href);
  const plain = { declaration: false };
  const plainArgs = runArguments(['-p', '.'], plain, '/out', '/build.tsbuildinfo');
  assert.ok(!plainArgs.includes('--noEmit'));
  assert.ok(!plainArgs.includes('--declarationDir'), 'declarationDir without declaration is TS5069');
  assert.ok(plainArgs.includes('--outDir'));
  // The statistics carry timings, so the runs turn them off whatever the project's config says.
  for (const name of ['--diagnostics', '--extendedDiagnostics'])
    assert.equal(plainArgs[plainArgs.indexOf(name) + 1], 'false');
  // Every run gets a build info file of its own: a composite project cannot turn incremental
  // compilation off (TS6379), and a project that does not use one writes none.
  const buildInfo = plainArgs.indexOf('--tsBuildInfoFile');
  assert.deepEqual(plainArgs.slice(buildInfo, buildInfo + 2), ['--tsBuildInfoFile', '/build.tsbuildinfo']);
  assert.ok(!plainArgs.includes('--incremental'));
  // A project that declares still gets its declarations redirected to the run's directory.
  const declared = runArguments([], { declaration: true }, '/out', '/build.tsbuildinfo');
  assert.deepEqual(declared.slice(declared.indexOf('--declarationDir')), ['--declarationDir', '/out']);
  // Without `--emit`, the run checks without writing anything.
  assert.deepEqual(runArguments([], plain, undefined, '/build.tsbuildinfo').slice(-1), ['--noEmit']);
});

test('TSC_TS_DOCTOR_REPORT makes a run write what it measured', { skip }, () => {
  const dir = project();
  const reportFile = join(tempDir('tsc-ts-doctor-report-'), 'report.json');
  const { output, status } = run(dir, ['-p', '.'], { TSC_TS_DOCTOR_REPORT: reportFile });
  assert.equal(status, 0, output);
  assert.ok(existsSync(reportFile), `no report in:\n${output}`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.status, 0);
  assert.ok(report.times.parseMs >= 0);
  assert.ok(report.times.checkMs >= 0);
  assert.ok(report.times.totalMs >= report.times.checkMs);
  assert.ok(report.shape.files > 0);
  assert.ok(report.shape.chars > 0);
  assert.ok(report.cpuMs > 0);
  assert.ok(report.peakMB > 0);
  assert.ok(report.checkers >= 1);
  assert.equal(report.share, false);
  assert.ok(report.parseThreads >= 1);
  assert.equal(report.key.length, 32);
});

// A native run writes its record; the Node build keeps none (`sharesPublishedGraphs`).
const native = tscTs.length === 1;

test(
  'doctor stores its samples in the record with role doctor',
  { skip: !native && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = project();
    const cache = tempDir('tsc-ts-doctor-cache-');
    const { output, status } = run(dir, ['doctor', '-p', '.', '--runs', '2', '--budget', '60'], {
      TSC_TS_CACHE: '1',
      TSC_TS_CACHE_DIR: cache,
    });
    assert.equal(status, 0, output);
    assert.match(output, /^Saved \d+ samples? to /m);
    const files = existsSync(cache) ? readdirSync(join(cache, 'runs-v1')) : [];
    assert.equal(files.length, 1, `expected one record, found ${files.join(', ')}`);
    const record = JSON.parse(readFileSync(join(cache, 'runs-v1', files[0]), 'utf8'));
    assert.equal(record.format, 1);
    assert.ok(record.samples.length >= 2);
    assert.equal(record.samples.length, record.runs);
    for (const sample of record.samples) {
      assert.equal(sample.role, 'doctor');
      assert.ok(sample.checkMs > 0);
      assert.ok(sample.parseMs >= 0);
      assert.ok(sample.totalMs > 0);
      assert.ok(sample.cpuMs > 0);
      assert.ok(sample.peakMB > 0);
      assert.ok(sample.load >= 0);
    }
    // The runs cover more than the default configuration: the checker-count alternative among them.
    assert.ok(new Set(record.samples.map((sample) => sample.checkers)).size >= 1);
  },
);

// The recommendation's own arithmetic, from runs made up here: each configuration's check time is
// synthesized, so the cases a machine rarely produces can be measured exactly.

const doctorBuild = resolve('dist/tsc-ts/src/drivers/doctor.js');
const doctorBuildSkip = !existsSync(doctorBuild) && 'run npm run build';

/** The recommendation for runs whose check times are `checkMs`, by configuration letter. */
async function recommendFor(checkMs) {
  const { DoctorPlan, DoctorRun, Measurements, recommend } = await import(pathToFileURL(doctorBuild).href);
  const plans = [
    new DoctorPlan('A', 'default', 'default, 12 checkers', undefined, undefined, undefined),
    new DoctorPlan('B', 'share', '12 checkers, sharing on', undefined, true, undefined),
    new DoctorPlan('C', 'checkers', '16 checkers', 16, undefined, undefined),
    new DoctorPlan('D', 'checkers-share', '16 checkers, sharing on', 16, true, undefined),
    new DoctorPlan('E', 'parse', 'default, 8 parse threads', undefined, undefined, 8),
  ];
  const measured = new Map();
  for (const plan of plans) {
    const measurements = new Measurements();
    const { parseMs, checkMs: check } = checkMs[plan.id];
    for (let run = 0; run < 3; run++) {
      const report = {
        status: 0,
        cpuMs: check * 2,
        peakMB: 100,
        times: { parseMs, checkMs: check, totalMs: parseMs + check },
      };
      measurements.runs.push(new DoctorRun(check / 1000, 0, '', report, 0, Date.now()));
    }
    measured.set(plan.id, measurements);
  }
  // The project as it runs today: 12 checkers, no sharing, 15 parse threads.
  const first = { status: 0, cpuMs: 0, peakMB: 0, checkers: 12, share: false, parseThreads: 15 };
  return recommend(plans, measured, first);
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not ${expected}`);

test(
  'sharing that loses at the recommended count is not reported as the count`s gain',
  { skip: doctorBuildSkip },
  async () => {
    // Sharing wins at the default count (900 against 1000), the higher count wins with sharing on (630
    // against 900), and sharing is slower at that count (630 against 600 without it).
    const recommendation = await recommendFor({
      A: { parseMs: 100, checkMs: 1000 },
      B: { parseMs: 100, checkMs: 900 },
      C: { parseMs: 100, checkMs: 600 },
      D: { parseMs: 100, checkMs: 630 },
      E: { parseMs: 100, checkMs: 1000 },
    });
    assert.equal(recommendation.checkers, 16);
    assert.equal(recommendation.share, false);
    assert.equal(recommendation.shareCheckers, 16);
    // Sharing's own comparison at 16 checkers: 630 against 600 is 5% slower, not the 30% the count
    // gained with sharing on (630 against 900).
    close(recommendation.shareEvidence.percent, -5);
    assert.equal(recommendation.shareEvidence.beats, false);
    // The count is recommended on its own, sharing off: 600 against 1000.
    close(recommendation.checkersEvidence.percent, 40);
    assert.equal(recommendation.checkersEvidence.beats, true);
  },
);

test('sharing that still pays at the recommended count reports its gain there', { skip: doctorBuildSkip }, async () => {
  const recommendation = await recommendFor({
    A: { parseMs: 100, checkMs: 1000 },
    B: { parseMs: 100, checkMs: 900 },
    C: { parseMs: 100, checkMs: 600 },
    D: { parseMs: 100, checkMs: 570 },
    E: { parseMs: 100, checkMs: 1000 },
  });
  assert.equal(recommendation.checkers, 16);
  assert.equal(recommendation.share, true);
  assert.equal(recommendation.shareCheckers, 16);
  // 570 against 600 at 16 checkers, not the 36.7% the count gained with sharing on (570 against 900).
  close(recommendation.shareEvidence.percent, 5);
  assert.equal(recommendation.shareEvidence.beats, true);
});

test(
  'sharing stays on at the default count where the higher count does not pay with it',
  { skip: doctorBuildSkip },
  async () => {
    const recommendation = await recommendFor({
      A: { parseMs: 100, checkMs: 1000 },
      B: { parseMs: 100, checkMs: 900 },
      C: { parseMs: 100, checkMs: 700 },
      D: { parseMs: 100, checkMs: 950 },
      E: { parseMs: 100, checkMs: 1000 },
    });
    assert.equal(recommendation.checkers, 12);
    assert.equal(recommendation.share, true);
    assert.equal(recommendation.shareCheckers, undefined);
    close(recommendation.shareEvidence.percent, 10);
  },
);
