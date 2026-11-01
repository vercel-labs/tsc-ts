/**
 * `tsc-ts doctor`: measures the settings that change how a project is checked, on this machine, and
 * recommends values for them. Each measured run is a child process of this executable, so every
 * configuration runs as a user's run would; the child reports its phase times and signals through
 * `TSC_TS_DOCTOR_REPORT` (`doctor-report.ts`), and this process times the child and compares its
 * diagnostic output with the default configuration's.
 *
 * The recommendation applies the adoption rule of the automatic selection (`run-config.ts`) against
 * configuration A, one setting at a time in the order sharing, checkers, parse threads, so doctor and
 * automatic selection agree on the same data. Unless `--no-save`, the samples go into the project's
 * record with role `doctor`.
 */
import { sharesPublishedGraphs } from '@scriptc/threads';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { memoryLimit } from '../compiler/parallel-check.js';
import {
  displayPath,
  recordsDirectory,
  writeRecord,
  type RecordChoice,
  type RecordEnvironment,
  type RecordSample,
  type RecordShape,
} from '../compiler/run-records.js';
import type { DoctorReport as ChildReport } from '../compiler/doctor-report.js';
import { version } from '../compiler/help.js';

/** The most configurations doctor runs (A through F). */
const maxConfigurations = 6;

/** The measured rounds doctor always runs, whatever the budget. */
const leastRounds = 2;

/** The least usable samples a comparison needs (`4.1`). */
const leastSamples = 3;

/** A sample with a load above this is stored but not used for decisions (`4.1`). */
const usableLoad = 0.5;

/** What the command line asked for. */
class DoctorOptions {
  /** `-p`'s value, or `undefined` for the current directory's tsconfig. */
  project: string | undefined = undefined;
  /** Measured runs per configuration (`--runs`). */
  runs = 3;
  /** The seconds the measured runs may take (`--budget`). */
  budget = 120;
  /** Whether to emit to a temporary directory instead of `--noEmit`. */
  emit = false;
  /** Whether to print the result as one JSON object (`--json`). */
  json = false;
  /** Whether to store the samples in the record (`--no-save` turns it off). */
  save = true;
}

/** One configuration doctor measures. */
class DoctorPlan {
  constructor(
    /** The letter the table prints (`A`, `B`, …). */
    readonly id: string,
    /** What the configuration is: the default, sharing, the checker count, both, or the parse threads. */
    readonly role: 'default' | 'share' | 'checkers' | 'checkers-share' | 'parse',
    /** What the table prints after the letter. */
    readonly title: string,
    /** `--checkers`, when the configuration pins the count. */
    readonly checkers: number | undefined,
    /** `TSC_TS_SHARE`, when the configuration pins sharing; `undefined` for the default. */
    readonly share: boolean | undefined,
    /** `TSC_TS_PARSE_THREADS`, when the configuration pins the parse threads. */
    readonly parseThreads: number | undefined,
  ) {}
}

/** One measured run of a configuration. */
class DoctorRun {
  constructor(
    /** The parent's wall clock, seconds. */
    readonly wall: number,
    /** The child's exit status, or `null` when it did not exit normally. */
    readonly status: number | null,
    /** The child's diagnostic output (stdout and stderr). */
    readonly output: string,
    /** The report the child wrote, or `undefined` when it wrote none. */
    readonly report: ChildReport | undefined,
    /** The 1-minute load average at the start divided by the CPUs. */
    readonly load: number,
    /** Seconds since the epoch, when the run finished. */
    readonly at: number,
  ) {}
}

/** All the runs of one configuration. */
class Measurements {
  readonly runs: DoctorRun[] = [];
}

/** The median and relative MAD of one measurement. */
class Statistic {
  constructor(
    readonly median: number,
    /** The relative MAD, percent. */
    readonly noise: number,
    readonly samples: number,
  ) {}
}

/** The outcome of comparing an alternative configuration with its baseline. */
class Comparison {
  constructor(
    readonly beats: boolean,
    /** How much faster the alternative's median is, percent, on the phase the setting affects. */
    readonly percent: number,
    /** The same for CPU time; positive is less CPU. */
    readonly cpuPercent: number,
    /** Why nothing was recommended, when nothing was. */
    readonly reason: string | undefined,
    /** The alternative's value, for the `within noise` text. */
    readonly alternative: string | undefined,
  ) {}
}

/** What doctor recommends, and the evidence for each setting. */
class Recommendation {
  constructor(
    readonly checkers: number,
    readonly share: boolean,
    readonly parseThreads: number,
    readonly checkersEvidence: Comparison,
    readonly shareEvidence: Comparison,
    readonly parseEvidence: Comparison,
    /** The configuration B, when the checkers' baseline was sharing on, for the line's text. */
    readonly shareBaseline: boolean,
    /** The checker count the sharing percentage was taken at, where it was measured. */
    readonly shareCheckers: number | undefined,
  ) {}
}

/** The temporary directory one doctor run keeps its report files and `--emit` output in. */
class Work {
  /**
   * @param directory the directory, deleted when the run ends
   * @param runs the report files written so far
   */
  constructor(
    readonly directory: string,
    public runs = 0,
  ) {}
}

/** One configuration's row. */
class ConfigurationResult {
  id = '';
  title = '';
  checkers: number | undefined = undefined;
  share: boolean | undefined = undefined;
  parseThreads: number | undefined = undefined;
  runs = 0;
  usable = 0;
  parse: Statistic | undefined = undefined;
  check: Statistic | undefined = undefined;
  total: Statistic | undefined = undefined;
  cpu: Statistic | undefined = undefined;
  peak: Statistic | undefined = undefined;
  output: 'reference' | 'same' | 'differs' = 'same';
}

/** One setting's evidence. */
class EvidenceResult {
  beats = false;
  percent = 0;
  cpuPercent = 0;
  reason: string | undefined = undefined;
  alternative: string | undefined = undefined;
}

/** What saving the samples did. */
class SavedResult {
  samples = 0;
  path: string | undefined = undefined;
  reason: string | undefined = undefined;
}

/** What a doctor run prints, as text or as one JSON object. */
class DoctorResult {
  version = '';
  project = '';
  machine: { cpus: number; memoryGiB: number; load: number } = { cpus: 1, memoryGiB: 0, load: 0 };
  shape: RecordShape | undefined = undefined;
  signals: ChildReport['signals'] | undefined = undefined;
  configurations: ConfigurationResult[] = [];
  rounds = 0;
  recommended: { checkers: number; share: boolean; parseThreads: number } | undefined = undefined;
  evidence:
    | {
        checkers: EvidenceResult;
        share: EvidenceResult;
        parse: EvidenceResult;
        shareBaseline: boolean;
        shareCheckers: number | undefined;
      }
    | undefined = undefined;
  before: { checkers: number; share: boolean; parseThreads: number } = { checkers: 1, share: false, parseThreads: 1 };
  output: 'same' | 'differs' = 'same';
  diff: string[] = [];
  saved: SavedResult | undefined = undefined;
}

/** Runs `tsc-ts doctor`; returns the exit status (2 when a configuration prints another output). */
export function runDoctor(args: readonly string[]): number {
  const options = new DoctorOptions();
  const parsed = parseDoctorArgs(args, options);
  if (parsed !== undefined) {
    if (parsed === '') {
      writeStdout(usage() + '\n');
      return 0;
    }
    writeStderr(parsed + '\n\n' + usage() + '\n');
    return 1;
  }
  const work = new Work(mkdtempSync(joinPath(tmpdir(), 'tsc-ts-doctor-')));
  try {
    return measure(options, work);
  } finally {
    removeDirectory(work.directory);
  }
}

/** Parses `args` into `options`; returns an error message, `''` for `--help`, or `undefined`. */
function parseDoctorArgs(args: readonly string[], options: DoctorOptions): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-p' || arg === '--project') {
      const value = args[++i];
      if (value === undefined) return 'doctor: --project needs a path';
      options.project = value;
    } else if (arg === '--runs') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) return 'doctor: --runs needs a whole number above 0';
      options.runs = value;
    } else if (arg === '--budget') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) return 'doctor: --budget needs a number of seconds above 0';
      options.budget = value;
    } else if (arg === '--emit') {
      options.emit = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-save') {
      options.save = false;
    } else if (arg === '-h' || arg === '--help') {
      return '';
    } else return 'doctor: unknown option ' + arg;
  }
  return undefined;
}

function usage(): string {
  return [
    'Usage: tsc-ts doctor [-p <tsconfig>] [--runs N] [--budget SECONDS] [--emit] [--json] [--no-save]',
    '',
    'Measures the checker count, result sharing and parse threads of a project on this machine.',
    'Experimental: the configurations it compares and what it recommends may change.',
    '  --runs N          measured runs per configuration (default 3)',
    '  --budget SECONDS  the measured runs may take (default 120; 2 rounds always run)',
    '  --emit            emit to a temporary directory instead of --noEmit',
    '  --json            print the result as one JSON object',
    '  --no-save         do not store the samples in the project record',
  ].join('\n');
}

/** Measures the project and prints the result. */
function measure(options: DoctorOptions, work: Work): number {
  const cpus = Math.max(1, availableParallelism());
  const memoryGiB = memoryLimit() / 1073741824;
  // The machine's load before the session's first run: doctor's runs are its own work, spread over every
  // configuration, so what the comparison has to know is whether other work competed with the session,
  // not how busy the session made the machine (`4.1`).
  const load = loadavg()[0] / cpus;
  const projectArgs = options.project === undefined ? [] : ['-p', options.project];
  const warmUp = runChild(
    new DoctorPlan('A', 'default', 'default', undefined, undefined, undefined),
    options,
    projectArgs,
    load,
    work,
  );
  const first = warmUp.report;
  // A report without a compile's numbers is a run that never checked anything (a missing config, say).
  if (first === undefined || first.times === undefined || first.shape === undefined) {
    const output = warmUp.output.trim();
    if (output !== '') writeStderr(output + '\n');
    writeStderr('doctor: the first run did not check the project (status ' + String(warmUp.status) + ')\n');
    return 1;
  }
  const plans = plansOf(first, cpus);
  const measured = new Map<string, Measurements>();
  for (const plan of plans) measured.set(plan.id, new Measurements());
  const started = Date.now();
  const totalRounds = Math.max(options.runs, leastRounds);
  let rounds = 0;
  let lastRoundSeconds = 0;
  while (rounds < totalRounds) {
    if (rounds >= leastRounds && elapsedSeconds(started) + lastRoundSeconds > options.budget) break;
    const roundStart = Date.now();
    for (const plan of plans) measured.get(plan.id)!.runs.push(runChild(plan, options, projectArgs, load, work));
    lastRoundSeconds = (Date.now() - roundStart) / 1000;
    rounds++;
  }
  const reference = measured.get('A')!.runs[0];
  const difference = reference === undefined ? undefined : firstDifference(plans, measured, reference);
  if (difference !== undefined) {
    const result = resultOf(plans, measured, first, cpus, memoryGiB, load, undefined, undefined);
    result.output = 'differs';
    result.diff = differenceLines(reference!, difference.plan, difference.run);
    for (const configuration of result.configurations)
      if (configuration.id === difference.plan.id) configuration.output = 'differs';
    if (options.json) writeStdout(JSON.stringify(result, undefined, 1) + '\n');
    else writeStdout(textOf(result) + '\n');
    return 2;
  }
  const recommendation = recommend(plans, measured, first);
  let saved: SavedResult;
  if (options.save) saved = saveSamples(measured, plans, first);
  else {
    saved = new SavedResult();
    saved.reason = '--no-save';
  }
  const result = resultOf(plans, measured, first, cpus, memoryGiB, load, recommendation, saved);
  if (options.json) writeStdout(JSON.stringify(result, undefined, 1) + '\n');
  else writeStdout(textOf(result) + '\n');
  return 0;
}

/** The child command for this executable, and this file under Node. */
function childCommand(): string[] {
  return isNode() ? [process.execPath, '--stack-size=16000', process.argv[1] ?? ''] : [process.execPath];
}

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}

/** Runs `plan`'s configuration as a child process and reads its report, recording `load` for the run. */
function runChild(
  plan: DoctorPlan,
  options: DoctorOptions,
  projectArgs: readonly string[],
  load: number,
  work: Work,
): DoctorRun {
  const reportFile = joinPath(work.directory, 'report-' + work.runs++ + '.json');
  const args = [...projectArgs, '--incremental', 'false', ...(options.emit ? emitArgs(work) : ['--noEmit'])];
  if (plan.checkers !== undefined) args.push('--checkers', String(plan.checkers));
  const command = childCommand();
  const started = performance.now();
  // No `cwd`: the child runs in this process's directory, as a run of the project would. The child's
  // report carries its times and signals; its output is the diagnostics, compared below.
  const result = spawnSync(command[0]!, [...command.slice(1), ...args], {
    env: childEnvironment(plan, reportFile),
    encoding: 'utf8',
  });
  const wall = (performance.now() - started) / 1000;
  const at = Math.floor(Date.now() / 1000);
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const report = readChildReport(reportFile);
  if (report !== undefined) removeFile(reportFile);
  return new DoctorRun(wall, result.status, output, report, load, at);
}

/** `--emit`'s output arguments: a temporary directory the doctor run deletes afterwards. */
function emitArgs(work: Work): string[] {
  const out = joinPath(work.directory, 'emit');
  mkdirSync(out, { recursive: true });
  return ['--outDir', out, '--declarationDir', out];
}

/**
 * The child's environment: this one's, without the pins the configurations set themselves, and with the
 * configuration's pins and the report file.
 */
function childEnvironment(plan: DoctorPlan, reportFile: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) env[name] = process.env[name];
  env.TSC_TS_CACHE = '0';
  env.TSC_TS_DOCTOR_REPORT = reportFile;
  env.TSC_TS_AUTO = '0';
  env.TSC_TS_CHECKERS = undefined;
  env.TSC_TS_SHARE = plan.share === undefined ? undefined : plan.share ? '1' : '0';
  env.TSC_TS_PARSE_THREADS = plan.parseThreads === undefined ? undefined : String(plan.parseThreads);
  return env;
}

function readChildReport(file: string): ChildReport | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as ChildReport) : undefined;
  } catch {
    return undefined;
  }
}

/** The configurations to measure, from the warm-up's report: A first, then B through E. */
function plansOf(first: ChildReport, cpus: number): DoctorPlan[] {
  const checkers = first.checkers ?? 1;
  const share = first.share === true;
  const most = Math.min(cpus, 16);
  const half = Math.ceil((first.parseThreads ?? 1) / 2);
  const plans: DoctorPlan[] = [
    new DoctorPlan('A', 'default', 'default' + countText(checkers), undefined, undefined, undefined),
  ];
  const candidates: DoctorPlan[] = [];
  // Sharing needs two checkers: with one, it is off whatever the setting (`4.3`).
  if (checkers > 1)
    candidates.push(new DoctorPlan('B', 'share', countTitle(checkers, true), undefined, !share, undefined));
  candidates.push(new DoctorPlan('C', 'checkers', countTitle(most, false), most, undefined, undefined));
  if (checkers > 1)
    candidates.push(new DoctorPlan('D', 'checkers-share', countTitle(most, true), most, !share, undefined));
  candidates.push(new DoctorPlan('E', 'parse', 'default, ' + half + ' parse threads', undefined, undefined, half));
  for (const candidate of candidates) {
    if (plans.length >= maxConfigurations) break;
    let duplicate = false;
    for (const plan of plans) if (samePlan(candidate, plan, checkers, share, first.parseThreads ?? 1)) duplicate = true;
    if (duplicate) continue;
    plans.push(
      new DoctorPlan(
        letter(plans.length),
        candidate.role,
        candidate.title,
        candidate.checkers,
        candidate.share,
        candidate.parseThreads,
      ),
    );
  }
  return plans;
}

/** Whether two plans measure the same configuration, given the defaults they leave unset. */
function samePlan(
  a: DoctorPlan,
  b: DoctorPlan,
  defaultCheckers: number,
  defaultShare: boolean,
  defaultParse: number,
): boolean {
  return (
    (a.checkers ?? defaultCheckers) === (b.checkers ?? defaultCheckers) &&
    (a.share ?? defaultShare) === (b.share ?? defaultShare) &&
    (a.parseThreads ?? defaultParse) === (b.parseThreads ?? defaultParse)
  );
}

/** `A`, `B`, … for a plan's place in the table. */
function letter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** `: 12 checkers`, or nothing for a single checker. */
function countText(checkers: number): string {
  return checkers <= 1 ? '' : ': ' + checkers + ' checkers';
}

/** `12 checkers`, or `default`, with `, sharing` where sharing is on. */
function countTitle(checkers: number, sharing: boolean): string {
  const title = checkers <= 1 ? 'default' : checkers + ' checkers';
  return sharing ? title + ', sharing' : title;
}

/** The first run whose output or status differs from the reference, with its configuration. */
function firstDifference(
  plans: readonly DoctorPlan[],
  measured: Map<string, Measurements>,
  reference: DoctorRun,
): { plan: DoctorPlan; run: DoctorRun } | undefined {
  for (const plan of plans) {
    for (const run of measured.get(plan.id)!.runs) {
      if (run === reference) continue;
      if (run.output !== reference.output || run.status !== reference.status) return { plan, run };
    }
  }
  return undefined;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The median and relative MAD of `values`; `undefined` without values. */
function statistic(values: readonly number[]): Statistic | undefined {
  if (values.length === 0) return undefined;
  const m = median(values);
  if (m === 0) return new Statistic(0, 0, values.length);
  const deviations = values.map((value) => Math.abs(value - m));
  return new Statistic(m, (1.4826 * median(deviations) * 100) / m, values.length);
}

/** The phase times of the usable runs of one configuration. */
class Numbers {
  readonly check: Statistic | undefined;
  readonly parse: Statistic | undefined;
  readonly total: Statistic | undefined;
  readonly cpu: Statistic | undefined;
  readonly peak: Statistic | undefined;
  readonly usable: number;

  constructor(runs: readonly DoctorRun[]) {
    const usable = runs.filter((run) => run.load <= usableLoad && run.report?.times !== undefined);
    this.usable = usable.length;
    this.check = statistic(usable.map((run) => run.report!.times!.checkMs ?? 0));
    this.parse = statistic(usable.map((run) => run.report!.times!.parseMs ?? 0));
    this.total = statistic(usable.map((run) => run.report!.times!.totalMs ?? 0));
    this.cpu = statistic(usable.map((run) => run.report!.cpuMs ?? 0));
    this.peak = statistic(usable.map((run) => run.report!.peakMB ?? 0));
  }
}

/** Whether `alternative` beats `baseline` by the adoption rule (`4.1`). */
function compare(
  alternative: Statistic | undefined,
  baseline: Statistic | undefined,
  alternativeCpu: Statistic | undefined,
  baselineCpu: Statistic | undefined,
  alternativeText: string,
): Comparison {
  if (
    alternative === undefined ||
    baseline === undefined ||
    alternative.samples < leastSamples ||
    baseline.samples < leastSamples
  )
    return new Comparison(false, 0, 0, 'fewer than ' + leastSamples + ' usable samples', alternativeText);
  const margin = Math.max(0.03, 2 * Math.max(alternative.noise, baseline.noise) * 0.01);
  const percent = baseline.median === 0 ? 0 : (1 - alternative.median / baseline.median) * 100;
  const cpuPercent =
    alternativeCpu === undefined || baselineCpu === undefined || baselineCpu.median === 0
      ? 0
      : (1 - alternativeCpu.median / baselineCpu.median) * 100;
  return new Comparison(percent >= margin * 100, percent, cpuPercent, undefined, alternativeText);
}

/** The recommendation: each setting's value and the evidence for it. */
function recommend(
  plans: readonly DoctorPlan[],
  measured: Map<string, Measurements>,
  first: ChildReport,
): Recommendation {
  const numbersOf = (id: string): Numbers => new Numbers(measured.get(id)?.runs ?? []);
  const planOf = (role: DoctorPlan['role']): DoctorPlan | undefined => plans.find((plan) => plan.role === role);
  const defaultCheckers = first.checkers ?? 1;
  const defaultShare = first.share === true;
  const defaultParse = first.parseThreads ?? 1;
  const a = numbersOf('A');

  // Sharing: B against A.
  const b = planOf('share');
  let shareEvidence = new Comparison(false, 0, 0, 'already the default', undefined);
  if (b !== undefined) {
    const shareAlternative = numbersOf(b.id);
    shareEvidence = compare(shareAlternative.check, a.check, shareAlternative.cpu, a.cpu, defaultShare ? 'off' : 'on');
  }
  const share = shareEvidence.beats ? !defaultShare : defaultShare;

  // Checkers: C against A with sharing off, D against B with sharing on.
  const checkersPlan = planOf(share ? 'checkers-share' : 'checkers');
  const checkersBaselinePlan = planOf(share ? 'share' : 'default');
  let checkersEvidence = new Comparison(false, 0, 0, 'already the default', undefined);
  if (checkersPlan !== undefined && checkersBaselinePlan !== undefined) {
    const alternative = numbersOf(checkersPlan.id);
    const baseline = numbersOf(checkersBaselinePlan.id);
    checkersEvidence = compare(
      alternative.check,
      baseline.check,
      alternative.cpu,
      baseline.cpu,
      String(checkersPlan.checkers),
    );
  }
  const checkers = checkersEvidence.beats ? (checkersPlan?.checkers ?? defaultCheckers) : defaultCheckers;

  // Parse threads: E against A.
  const e = planOf('parse');
  let parseEvidence = new Comparison(false, 0, 0, 'already the default', undefined);
  if (e !== undefined) {
    const parseAlternative = numbersOf(e.id);
    parseEvidence = compare(parseAlternative.parse, a.parse, parseAlternative.cpu, a.cpu, String(e.parseThreads));
  }
  const parseThreads = parseEvidence.beats ? (e?.parseThreads ?? defaultParse) : defaultParse;

  // The sharing percentage at the checker count doctor recommends, where it was measured.
  let shareCheckers: number | undefined = undefined;
  if (shareEvidence.beats && checkers !== defaultCheckers) {
    const withDefault = checkersBaselinePlan === undefined ? undefined : numbersOf(checkersBaselinePlan.id);
    const withChosen = checkersPlan === undefined ? undefined : numbersOf(checkersPlan.id);
    if (
      withDefault !== undefined &&
      withChosen !== undefined &&
      withDefault.check !== undefined &&
      withChosen.check !== undefined &&
      withDefault.check.median !== 0
    ) {
      shareEvidence = new Comparison(
        true,
        (1 - withChosen.check.median / withDefault.check.median) * 100,
        shareEvidence.cpuPercent,
        undefined,
        shareEvidence.alternative,
      );
      shareCheckers = checkers;
    }
  }
  return new Recommendation(
    checkers,
    share,
    parseThreads,
    checkersEvidence,
    shareEvidence,
    parseEvidence,
    share,
    shareCheckers,
  );
}

/** Collects the result from the measured runs. */
function resultOf(
  plans: readonly DoctorPlan[],
  measured: Map<string, Measurements>,
  first: ChildReport,
  cpus: number,
  memoryGiB: number,
  load: number,
  recommendation: Recommendation | undefined,
  saved: SavedResult | undefined,
): DoctorResult {
  const result = new DoctorResult();
  result.version = version;
  result.project = projectText(first);
  result.machine = {
    cpus,
    memoryGiB: Math.round(memoryGiB * 10) / 10,
    load: Math.round(load * 100) / 100,
  };
  result.shape = shapeOf(first);
  result.signals = first.signals;
  for (const plan of plans) {
    const configuration = new ConfigurationResult();
    const runs = measured.get(plan.id)!.runs;
    const numbers = new Numbers(runs);
    configuration.id = plan.id;
    configuration.title = plan.title;
    configuration.checkers = plan.checkers;
    configuration.share = plan.share;
    configuration.parseThreads = plan.parseThreads;
    configuration.runs = runs.length;
    configuration.usable = numbers.usable;
    configuration.parse = numbers.parse;
    configuration.check = numbers.check;
    configuration.total = numbers.total;
    configuration.cpu = numbers.cpu;
    configuration.peak = numbers.peak;
    configuration.output = plan.id === 'A' ? 'reference' : 'same';
    result.configurations.push(configuration);
    result.rounds = Math.max(result.rounds, runs.length);
  }
  result.before = {
    checkers: first.checkers ?? 1,
    share: first.share === true,
    parseThreads: first.parseThreads ?? 1,
  };
  if (recommendation !== undefined) {
    result.recommended = {
      checkers: recommendation.checkers,
      share: recommendation.share,
      parseThreads: recommendation.parseThreads,
    };
    result.evidence = {
      checkers: evidenceOf(recommendation.checkersEvidence),
      share: evidenceOf(recommendation.shareEvidence),
      parse: evidenceOf(recommendation.parseEvidence),
      shareBaseline: recommendation.shareBaseline,
      shareCheckers: recommendation.shareCheckers,
    };
  }
  result.saved = saved;
  return result;
}

function evidenceOf(comparison: Comparison): EvidenceResult {
  const evidence = new EvidenceResult();
  evidence.beats = comparison.beats;
  evidence.percent = Math.round(comparison.percent * 10) / 10;
  evidence.cpuPercent = Math.round(comparison.cpuPercent * 10) / 10;
  evidence.reason = comparison.reason;
  evidence.alternative = comparison.alternative;
  return evidence;
}

/** The project's config file, relative to this directory where it is inside it. */
function projectText(first: ChildReport): string {
  const file = first.configFile;
  if (file === undefined) return 'root files on the command line';
  const cwd = process.cwd();
  const prefix = cwd.endsWith('/') ? cwd : cwd + '/';
  return file.startsWith(prefix) ? file.slice(prefix.length) : displayPath(file);
}

/** The shape `first` reports, as a record keeps it. */
function shapeOf(first: ChildReport): RecordShape | undefined {
  const shape = first.shape;
  if (shape === undefined) return undefined;
  const chars = shape.chars ?? 0;
  const declarationChars = shape.declarationChars ?? 0;
  const signals = first.signals;
  return {
    files: shape.files ?? 0,
    chars,
    declarationChars,
    checkChars: shape.checkChars ?? chars - declarationChars,
    library: Math.round(signals?.library ?? 0),
    own: Math.round(signals?.own ?? 0),
    redundancy: signals?.redundancy ?? 0,
  };
}

/**
 * Saves every measured run as a `doctor` sample; never throws. A sample a busy machine took is kept with
 * its load and left out of the comparisons, as the record's samples are (`4.1`, `usableLoad`).
 */
function saveSamples(
  measured: Map<string, Measurements>,
  plans: readonly DoctorPlan[],
  first: ChildReport,
): SavedResult {
  const saved = new SavedResult();
  // Node builds keep no records (§3.5), doctor's samples included.
  if (!sharesPublishedGraphs) {
    saved.reason = 'Node.js builds';
    return saved;
  }
  const directory = recordsDirectory(recordEnvironment());
  if (directory === undefined) {
    saved.reason = 'TSC_TS_CACHE=0';
    return saved;
  }
  const key = first.key;
  const shape = shapeOf(first);
  if (key === undefined || shape === undefined) {
    saved.reason = 'no report from the measured runs';
    return saved;
  }
  const choice: RecordChoice = {
    checkers: first.checkers ?? 1,
    share: first.share === true,
    parseThreads: first.parseThreads ?? 1,
    source: 'default',
    since: 0,
  };
  for (const plan of plans) {
    for (const run of measured.get(plan.id)!.runs) {
      const report = run.report;
      if (report?.times === undefined) continue;
      const sample: Omit<RecordSample, 'run'> = {
        at: run.at,
        role: 'doctor',
        checkers: report.checkers ?? 1,
        share: report.share === true,
        parseThreads: report.parseThreads ?? 1,
        parseMs: report.times.parseMs ?? 0,
        checkMs: report.times.checkMs ?? 0,
        totalMs: report.times.totalMs ?? 0,
        cpuMs: report.cpuMs ?? 0,
        peakMB: report.peakMB ?? 0,
        load: run.load,
      };
      const written = writeRecord(directory, key, sample, shape, choice);
      if (written.path === undefined) {
        saved.reason = written.reason;
        return saved;
      }
      saved.samples++;
      saved.path = written.path;
    }
  }
  return saved;
}

/** The environment the records read: the doctor process's, by name (`SC2002`). */
function recordEnvironment(): RecordEnvironment {
  return {
    TSC_TS_CACHE: process.env.TSC_TS_CACHE,
    TSC_TS_CACHE_DIR: process.env.TSC_TS_CACHE_DIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
}

/** The first differing lines of `run` against `reference`, up to 10 lines. */
function differenceLines(reference: DoctorRun, plan: DoctorPlan, run: DoctorRun): string[] {
  const referenceLines = reference.output.split('\n');
  const runLines = run.output.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < Math.max(referenceLines.length, runLines.length) && lines.length < 10; i++) {
    const left = referenceLines[i];
    const right = runLines[i];
    if (left === right) continue;
    lines.push('  reference: ' + truncate(left ?? '(end of output)'));
    lines.push('  ' + plan.id + ':         ' + truncate(right ?? '(end of output)'));
  }
  return lines;
}

function truncate(line: string): string {
  return line.length > 300 ? line.slice(0, 300) + '…' : line;
}

/** The text output. */
function textOf(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push('tsc-ts doctor (experimental): ' + result.project);
  lines.push(
    'Machine: ' +
      result.machine.cpus +
      ' CPUs, ' +
      result.machine.memoryGiB.toFixed(1) +
      ' GiB memory limit, load ' +
      result.machine.load.toFixed(2),
  );
  lines.push(programText(result));
  lines.push(signalsText(result));
  lines.push('');
  lines.push(tableHeader());
  for (const configuration of result.configurations) lines.push(rowText(configuration));
  lines.push(
    '   (check: median and relative MAD; CPU: user + system over all threads; peak: resident set at its highest)',
  );
  if (result.output === 'differs') {
    lines.push('');
    lines.push('Output differs from configuration A:');
    for (const line of result.diff) lines.push(line);
    lines.push('Samples were not saved.');
    return lines.join('\n');
  }
  if (result.recommended !== undefined && result.evidence !== undefined) {
    lines.push('');
    lines.push('Recommended for this project on this machine:');
    lines.push(...recommendationLines(result));
    lines.push('');
    lines.push('Automatic selection would choose:');
    lines.push('  before this run: ' + valuesText(result.before) + ' (defaults; records are written, not read yet)');
    lines.push('  with these measurements: ' + valuesText(result.recommended));
    lines.push(savedText(result.saved));
  }
  return lines.join('\n');
}

function programText(result: DoctorResult): string {
  const shape = result.shape;
  if (shape === undefined) return 'Program: unknown';
  return (
    'Program: ' +
    group(shape.files) +
    ' files, ' +
    magnitude(shape.chars, 1) +
    ' characters (' +
    magnitude(shape.declarationChars, 1) +
    ' in declaration files), ' +
    magnitude(shape.checkChars, 2) +
    ' to check'
  );
}

function signalsText(result: DoctorResult): string {
  const signals = result.signals;
  if (signals === undefined) return 'Signals: unavailable (the check ran on one thread)';
  const ranges = signals.ranges ?? 0;
  if (ranges === 0) return 'Signals: none (every file is checked whole)';
  return (
    'Signals: ranges reach ' +
    magnitude(signals.library ?? 0, 1) +
    ' library characters for ' +
    magnitude(signals.own ?? 0, 1) +
    ' checked; redundancy ' +
    (signals.redundancy ?? 0).toFixed(2)
  );
}

function tableHeader(): string {
  return (
    'Configuration'.padEnd(38) +
    'runs'.padEnd(6) +
    'parse'.padEnd(11) +
    'check'.padEnd(17) +
    'total'.padEnd(10) +
    'CPU'.padEnd(9) +
    'peak'.padEnd(9) +
    'output'
  );
}

function rowText(configuration: ConfigurationResult): string {
  const name = (configuration.id + '  ' + configuration.title).padEnd(38);
  const check = configuration.check;
  return (
    name +
    String(configuration.runs).padEnd(6) +
    secondsText(configuration.parse).padEnd(11) +
    (check === undefined ? '—' : seconds(check.median) + ' ±' + check.noise.toFixed(1) + '%').padEnd(17) +
    secondsText(configuration.total).padEnd(10) +
    cpuText(configuration.cpu).padEnd(9) +
    peakText(configuration.peak).padEnd(9) +
    configuration.output
  );
}

function secondsText(statistic: Statistic | undefined): string {
  return statistic === undefined ? '—' : seconds(statistic.median);
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(2) + 's';
}

function cpuText(statistic: Statistic | undefined): string {
  return statistic === undefined ? '—' : (statistic.median / 1000).toFixed(1) + 's';
}

function peakText(statistic: Statistic | undefined): string {
  return statistic === undefined || statistic.median === 0 ? '—' : (statistic.median / 1024).toFixed(1) + ' GB';
}

/** One recommendation line. */
function settingLine(
  name: string,
  value: string,
  evidence: EvidenceResult,
  beatsText: string,
  defaultReason: string,
  pin: string,
): string {
  let evidenceText: string;
  if (evidence.beats) evidenceText = evidence.percent.toFixed(1) + '% ' + beatsText;
  else if (evidence.reason !== undefined) evidenceText = 'default (' + evidence.reason + ')';
  else
    evidenceText =
      'default (' + (evidence.alternative ?? 'alternative') + ': within noise' + cpuComparison(evidence) + ')';
  return '  ' + (name + ':').padEnd(16) + value.padEnd(8) + evidenceText.padEnd(48) + 'pin: ' + pin;
}

function cpuComparison(evidence: EvidenceResult): string {
  const difference = Math.abs(evidence.cpuPercent);
  if (difference < 0.05) return '';
  return ', ' + difference.toFixed(1) + '% ' + (evidence.cpuPercent > 0 ? 'less' : 'more') + ' CPU';
}

function recommendationLines(result: DoctorResult): string[] {
  const recommended = result.recommended!;
  const evidence = result.evidence!;
  const checkersText = evidence.checkers.beats
    ? 'faster check ' + (evidence.shareBaseline ? 'with sharing on' : 'than default')
    : 'faster check than default';
  const sharingText =
    evidence.share.beats && evidence.shareCheckers !== undefined
      ? 'faster check at ' + evidence.shareCheckers + ' checkers'
      : 'faster check than default';
  return [
    settingLine(
      'Checkers',
      String(recommended.checkers),
      evidence.checkers,
      checkersText,
      'already the default',
      '--checkers ' + recommended.checkers + ', or "checkers": ' + recommended.checkers + ' in compilerOptions',
    ),
    settingLine(
      'Sharing',
      recommended.share ? 'on' : 'off',
      evidence.share,
      sharingText,
      'already the default',
      'TSC_TS_SHARE=' + (recommended.share ? '1' : '0'),
    ),
    settingLine(
      'Parse threads',
      String(recommended.parseThreads),
      evidence.parse,
      'faster parse than default',
      'already the default',
      'TSC_TS_PARSE_THREADS=' + recommended.parseThreads,
    ),
  ];
}

function valuesText(values: { checkers: number; share: boolean; parseThreads: number }): string {
  return (
    values.checkers +
    ' checkers, sharing ' +
    (values.share ? 'on' : 'off') +
    ', ' +
    values.parseThreads +
    ' parse threads'
  );
}

function savedText(saved: SavedResult | undefined): string {
  if (saved === undefined) return 'Samples were not saved.';
  if (saved.path === undefined) return 'Not saving samples (' + (saved.reason ?? 'unavailable') + ').';
  return 'Saved ' + saved.samples + (saved.samples === 1 ? ' sample' : ' samples') + ' to ' + displayPath(saved.path);
}

function group(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** `21.4M`, `1.93M`, `950K`: `value` with `decimals` at the largest of M, K that fits. */
function magnitude(value: number, decimals: number): string {
  if (value >= 1e9) return (value / 1e9).toFixed(decimals) + 'G';
  if (value >= 1e6) return (value / 1e6).toFixed(decimals) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(0) + 'K';
  return String(Math.round(value));
}

function elapsedSeconds(started: number): number {
  return (Date.now() - started) / 1000;
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Gone already.
  }
}

function removeDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort: a file left behind is harmless.
  }
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function writeStderr(text: string): void {
  process.stderr.write(text);
}
