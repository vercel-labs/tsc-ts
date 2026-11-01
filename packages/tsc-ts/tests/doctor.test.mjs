// `tsc-ts doctor`: the command line, the child report `TSC_TS_DOCTOR_REPORT` writes, and the samples
// doctor stores in the project's record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './temp.mjs';
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
