// Runs CI test units (units.mjs) one after another, retrying each failed unit once.
//
// Usage: node scripts/ci/run-tests.mjs [--plan plan.json] [--set node|native|all] [--shard i/n] [--report report.json]
//          [unit id ...]
//
// Without unit ids or --plan (the output of select-tests.mjs), runs every unit. --set picks the Node units (the
// default) or the native ones (`native:`), which need packages/tsc-ts/dist/tsc and dist/cli (units.mjs); unit ids
// given on the command line run whatever their set. --shard i/n runs the ith of n shards of the set, packed from
// measured durations. A unit that fails and then passes is reported as flaky and does not fail the run.
// A unit whose failing tests are all listed in scripts/ci/quarantine.txt is reported as quarantined and does not
// fail the run either. Everything else that fails twice fails the run. Results go to stdout, to the GitHub step
// summary and annotations when running in GitHub Actions, and to --report as JSON.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allUnits, durationOf, nativeBinaries, pack, referenceBinaries, root } from './units.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const planPath = option('--plan');
const shardArg = option('--shard');
const reportPath = option('--report');
const set = option('--set') ?? 'node';
if (!['node', 'native', 'all'].includes(set)) throw new Error(`unknown set ${set}`);

const units = new Map(allUnits().map((unit) => [unit.id, unit]));
let ids = args.length > 0 ? args : planPath ? JSON.parse(readFileSync(planPath, 'utf8')).units : [...units.keys()];
for (const id of ids) if (!units.has(id)) throw new Error(`unknown unit ${id}`);
if (args.length === 0 && set !== 'all') ids = ids.filter((id) => units.get(id).native === (set === 'native'));
let shard = '1/1';
if (shardArg !== undefined) {
  const [index, count] = shardArg.split('/').map(Number);
  ids = pack(ids, count)[index - 1].ids;
  shard = shardArg;
}

/** Quarantined test files (`file`) and top-level tests (`file :: name`). */
function quarantine() {
  const entries = new Set();
  const path = join(root, 'scripts/ci/quarantine.txt');
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const entry = line.replace(/#.*/, '').trim();
    if (entry) entries.add(entry.replace(/\s*::\s*/, ' :: '));
  }
  return entries;
}
const quarantined = quarantine();

const work = mkdtempSync(join(tmpdir(), 'tsc-ts-ci-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const reporter = pathToFileURL(join(root, 'scripts/ci/test-reporter.mjs')).href;
// Spawned compilers reuse compiled code across the many processes a test file starts.
const compileCache = process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'tsc-ts-node-compile-cache');
const github = process.env.GITHUB_ACTIONS === 'true';

/** Runs a unit once; returns its status, time and the names of its failed top-level tests. */
function attempt(unit, number) {
  const events = join(work, `events-${number}-${unit.id.replace(/[^\w.-]+/g, '_')}.jsonl`);
  const [command, ...rest] = unit.command;
  const argv =
    rest[0] === '--test'
      ? [
          '--test',
          '--test-reporter=spec',
          '--test-reporter-destination=stdout',
          `--test-reporter=${reporter}`,
          `--test-reporter-destination=${events}`,
          ...rest.slice(1),
        ]
      : rest;
  const started = Date.now();
  if (github) console.log(`::group::${unit.id}${number > 1 ? ' (retry)' : ''}`);
  else console.log(`--- ${unit.id}${number > 1 ? ' (retry)' : ''}`);
  return new Promise((done) => {
    const child = spawn(command === 'node' ? process.execPath : command, argv, {
      cwd: join(root, unit.cwd),
      env: { ...process.env, NODE_COMPILE_CACHE: compileCache, ...unit.env },
      stdio: 'inherit',
    });
    child.on('close', (code, signal) => {
      if (github) console.log('::endgroup::');
      const failed = existsSync(events)
        ? readFileSync(events, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((event) => !event.passed)
            .map((event) => event.name)
        : [];
      done({ passed: code === 0, seconds: (Date.now() - started) / 1000, failed, exit: signal ?? code });
    });
  });
}

const expected = ids.reduce((sum, id) => sum + durationOf(id), 0);
console.log(`shard ${shard}: ${ids.length} units, ${Math.round(expected)} s expected`);
// A missing native build would make some test files skip their tests and pass.
const missing = Object.values(nativeBinaries).filter(
  (binary) => ids.some((id) => Object.values(units.get(id).env).includes(binary)) && !existsSync(binary),
);
if (missing.length > 0) throw new Error(`native units need ${missing.join(' and ')}: build them first`);
// So would missing reference compilers, which a build:oracle cache entry might lack.
const missingReferences = referenceBinaries.filter((binary) => !existsSync(binary));
if (ids.length > 0 && missingReferences.length > 0)
  throw new Error(`the tests need ${missingReferences.join(' and ')}: run npm run build:oracle`);
const results = [];
for (const id of ids) {
  const unit = units.get(id);
  const first = await attempt(unit, 1);
  let result = { id, status: 'passed', seconds: first.seconds, attempts: 1, failed: [], exit: first.exit };
  if (!first.passed) {
    const second = await attempt(unit, 2);
    result = { ...result, attempts: 2, failed: second.failed, firstFailed: first.failed, exit: second.exit };
    if (second.passed) result.status = 'flaky';
    else if (
      quarantined.has(unit.file) ||
      (second.failed.length > 0 && second.failed.every((name) => quarantined.has(`${unit.file} :: ${name}`)))
    )
      result.status = 'quarantined';
    else result.status = 'failed';
  }
  results.push(result);
  console.log(`${result.status} ${id} (${result.seconds.toFixed(0)} s)`);
}

const describe = (r) => {
  const names = r.status === 'flaky' ? r.firstFailed : r.failed;
  return names?.length ? names.join(', ') : `exit ${r.exit}`;
};
for (const r of results) {
  if (!github) break;
  if (r.status === 'flaky')
    console.log(`::warning title=Flaky test::${r.id} failed, then passed on retry: ${describe(r)}`);
  if (r.status === 'quarantined') console.log(`::warning title=Quarantined test failed::${r.id}: ${describe(r)}`);
  if (r.status === 'failed') console.log(`::error title=Test failed::${r.id} failed twice: ${describe(r)}`);
}

const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
const lines = [
  `### Tests, shard ${shard}`,
  '',
  Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ') || 'no units',
  '',
  '| unit | result | seconds | expected seconds | failed tests |',
  '| --- | --- | ---: | ---: | --- |',
  ...results.map(
    (r) =>
      `| ${r.id} | ${r.status} | ${r.seconds.toFixed(0)} | ${durationOf(r.id)} | ${r.status === 'passed' ? '' : describe(r)} |`,
  ),
  '',
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (reportPath) writeFileSync(reportPath, JSON.stringify({ shard, units: results }, null, 2) + '\n');
process.exitCode = results.some((r) => r.status === 'failed') ? 1 : 0;
