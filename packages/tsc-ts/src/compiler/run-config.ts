/**
 * The run configuration: how many checker threads check a program, whether they share results with each
 * other, and how many threads parse ahead of the program, with where each value came from. The values are
 * pinned by `--checkers` / `"checkers"` and by the `TSC_TS_CHECKERS`, `TSC_TS_SHARE`, `TSC_TS_PARSE_THREADS`
 * and `TSC_TS_AUTO` environment variables; a value that no pin gives is chosen by the program's signals
 * (the static rules below) and, where the project has run before, by what those runs measured: a
 * configuration the record shows to be faster is adopted, an adopted one is re-measured by control runs
 * and dropped when it stops paying, and a configuration the signals leave uncertain is tried in a real run
 * (`decideCheck`, `preParseConfig`).
 *
 * The parse threads must be known before any file is parsed (`preParseConfig`); the checker count and
 * sharing are decided once the program is bound, from what it shows about the cost of checking it
 * (`decideCheck`). `--extendedDiagnostics` prints the values, their sources and how to pin them after the
 * statistics table (`reportRunConfig`).
 */
import { availableCpus } from './cgroup.js';
import {
  shapeChanged,
  type RecordChoice,
  type RecordRejection,
  type RecordSample,
  type RecordShape,
  type RunRecord,
} from './run-records.js';

/** Where a setting's value came from. */
export enum Source {
  /** An explicit pin: `--checkers`, `"checkers"`, or a `TSC_TS_*` environment variable. */
  Pinned,
  /** What the compiler used before anything chose, and what `TSC_TS_AUTO=0` keeps. */
  Default,
  /** A rule over the program's signals. */
  Static,
  /** What earlier runs of the project measured (run records). */
  Learned,
  /** A measurement taken during this run. */
  Measured,
  /** A run trying an alternative configuration, to learn from it. */
  Explore,
  /** A run re-measuring the default, to keep the learned choice honest. */
  Control,
}

/** How much of the selection may run. */
export enum Automaticity {
  /** Every source may choose: rules, records and in-run switches. */
  On,
  /** Rules and in-run guards only (`TSC_TS_AUTO=static`): no records are read or written. */
  Static,
  /** Nothing but the defaults the pins leave (`TSC_TS_AUTO=0`). */
  Off,
  /**
   * As `On`, and a run may try an alternative the signals leave uncertain (`TSC_TS_AUTO=explore`).
   * Experimental: a run that explores is slower than the configuration it would have used.
   */
  Explore,
}

/**
 * Whether the record may decide any setting: `TSC_TS_AUTO` unset or `1`, and `explore`, which adds the
 * exploration of the settings the signals leave uncertain.
 */
export function learns(automaticity: Automaticity): boolean {
  return automaticity === Automaticity.On || automaticity === Automaticity.Explore;
}

/** The values a run uses and where each came from. */
export class RunConfig {
  /** The checker threads that check the program; 1 checks on the main thread. */
  checkers = 1;
  checkersSource: Source = Source.Default;
  /** Whether checker threads share the results they compute (`shared-results.ts`). */
  share = false;
  shareSource: Source = Source.Default;
  /** The threads that parse and bind the program's files ahead of it (`parallel-parse.ts`). */
  parseThreads = 1;
  parseSource: Source = Source.Default;
  /** The pin a value came from, for the section (`--checkers`, `TSC_TS_SHARE`, `TSC_TS_PARSE_THREADS`). */
  checkersPin: string | undefined = undefined;
  sharePin: string | undefined = undefined;
  parsePin: string | undefined = undefined;
  /** How much of the selection may run (`TSC_TS_AUTO`); `Off` leaves every value to the pins and defaults. */
  automaticity = Automaticity.On;
  /** Whether this run reports its signals to a doctor child's report (`TSC_TS_DOCTOR_REPORT`). */
  measure = false;
  /** Why each value was chosen, for the section's `automatic:` reason on that setting's line. */
  readonly checkersReasons: string[] = [];
  readonly shareReasons: string[] = [];
  readonly parseReasons: string[] = [];
  /** Whether this run may write a run record (`run-records.ts`), and why not where it may not. */
  records = true;
  recordsReason: string | undefined = undefined;
  /** What the bound program showed about the cost of checking it (`parallel-check.ts`), where computed. */
  signals: CheckSignals | undefined = undefined;
  /** The project's record of earlier runs, where it was read before this run's files were parsed. */
  record: RunRecord | undefined = undefined;
  /** Where that record lives: its directory and key, and the file they name (`run-records.ts`). */
  recordDirectory: string | undefined = undefined;
  recordKey: string | undefined = undefined;
  recordFile: string | undefined = undefined;
  /** The program's size, where this run computed it (`parallel-check.ts`): its record and the shape check. */
  shape: RecordShape | undefined = undefined;
  /** The role this run's sample gets in the record. */
  role: 'chosen' | 'control' | 'explore' = 'chosen';
  /**
   * The configuration the record keeps as chosen after this run. Learning adopts a measured configuration
   * and reverts to the static one; a run reading no record leaves it for the writer.
   */
  chosen: RecordChoice | undefined = undefined;
  /**
   * The configuration `fastRevert` rejected in this run, which the record keeps so a later run reads only
   * the samples taken after the rejection as evidence for it (`run-records.ts`).
   */
  rejected: RecordRejection | undefined = undefined;
  /** The window a sharing run reads its checkers' counters in: a tenth of the recorded check, or 300 ms. */
  shareWindowMs = shareWindow;
  /**
   * Whether this run may try an alternative configuration: `TSC_TS_AUTO=explore` only, and never in CI,
   * watch mode or a concurrent build. Off by default: a run adopts what the record's samples show faster,
   * and tries nothing that would make the run itself slower.
   */
  explore = false;
}

/** The environment's pins, parsed once per run: `TSC_TS_AUTO`, `TSC_TS_SHARE` and `TSC_TS_PARSE_THREADS`. */
export interface Pins {
  readonly automaticity: Automaticity;
  /** `TSC_TS_SHARE`: sharing pinned on or off; `undefined` when the variable is not set. */
  readonly share: boolean | undefined;
  /** `TSC_TS_PARSE_THREADS`: the parse threads pinned; `undefined` when not set or not a whole number above 0. */
  readonly parseThreads: number | undefined;
}

/** `TSC_TS_SHARE` parsed: `1` pins sharing on, `0` pins it off, and anything else pins nothing. */
export function sharePin(env: Record<string, string | undefined>): boolean | undefined {
  const value = env.TSC_TS_SHARE;
  return value === '1' ? true : value === '0' ? false : undefined;
}

/** The pins of `env`: `TSC_TS_AUTO` (`0`, `static`, `explore` or unset), `TSC_TS_SHARE` and `TSC_TS_PARSE_THREADS`. */
export function pinsOf(env: Record<string, string | undefined>): Pins {
  const automatic = env.TSC_TS_AUTO;
  const threads = env.TSC_TS_PARSE_THREADS === undefined ? NaN : Number(env.TSC_TS_PARSE_THREADS);
  return {
    automaticity:
      automatic === '0'
        ? Automaticity.Off
        : automatic === 'static'
          ? Automaticity.Static
          : automatic === 'explore'
            ? Automaticity.Explore
            : Automaticity.On,
    share: sharePin(env),
    parseThreads: Number.isInteger(threads) && threads >= 1 ? threads : undefined,
  };
}

/**
 * How the number of checkers is chosen without `--checkers`: `auto` (the default) uses every CPU this
 * process may run on (`availableCpus()`, at most `maxAutoCheckers`), and at least tsgo's four;
 * fewer than the CPUs, but never fewer than four, when the estimated peak memory of more checkers would
 * not fit. `fixed` (`TSC_TS_CHECKERS=fixed`) uses tsgo's four.
 */
export function checkersPolicy(env: Record<string, string | undefined>): 'fixed' | 'auto' {
  return env.TSC_TS_CHECKERS === 'fixed' ? 'fixed' : 'auto';
}

/** tsgo's number of checkers, and the fewest `auto` starts. */
export const tsgoCheckers = 4;

/** The most checkers `auto` starts (measured up to 16 CPUs). */
export const maxAutoCheckers = 16;

/** `auto` with `cpus` CPUs when the memory estimate fits `fit` checkers: tsgo's four at least. */
export function autoCheckers(cpus: number, fit: number): number {
  return Math.max(tsgoCheckers, Math.min(cpus, fit));
}

/**
 * When a checker's own files are a small part of what it resolves (`libraryBoundCount`): the least
 * text, in characters, of the libraries the files of a checker's range reach, on average over the
 * ranges, and the least multiple of the text of the range's own files it is.
 */
export const libraryBoundText = 6_000_000;
export const libraryBoundShare = 5;

/** Whether ranges that reach `library` characters of libraries and check `own` are library-bound. */
export function isLibraryBound(library: number, own: number): boolean {
  return library >= libraryBoundText && library >= libraryBoundShare * own;
}

/**
 * The number of checkers for `count` checkers whose ranges reach `library` characters of libraries
 * and check `own` characters each, on average: three quarters of them (tsgo's four at least) where
 * every checker spends most of its time resolving the same large libraries (`libraryBoundText`,
 * `libraryBoundShare`), else `count`.
 *
 * Each checker resolves the declarations its files reach, whatever else it checks. Where they are
 * millions of characters, such as an Effect-based project's, and much more than the checker's own
 * files, a checker costs seconds of CPU and hundreds of MB before its files get cheap, and the last
 * quarter of the checkers (on 16 CPUs of 8 cores, the ones sharing a core with another) repeat that
 * work rather than save time: T3 Code's web and server projects ran 3% and 1% faster with 12
 * checkers than with 16, and used 16% and 8% less memory. Where checkers resolve less, or mostly
 * check their own files, 12 of 16 checkers were slower: Excalidraw (1.4M library and 0.15M own
 * characters per range) by 6%, Sentry (5.7M and 3.0M) and the tsc-ts sources by about 11%.
 */
export function libraryBoundCount(count: number, library: number, own: number): number {
  return isLibraryBound(library, own) ? Math.max(tsgoCheckers, Math.ceil((count * 3) / 4)) : count;
}

/**
 * The least checkers sharing can pay with: 12, from T3 Code's two projects at 16 and 4 neutral to
 * slightly worse (1.028). c8 and c12 are unmeasured, so 12 is where the measurements begin.
 */
export const minSharingCheckers = 12;

/**
 * The share of a program's files that must be declaration files or come from `node_modules` (F) for
 * sharing to pay: the files every checker resolves again. T3 Code's projects are at 0.48 and 0.66;
 * TypeORM, VS Code and Sentry at 0.08, 0.08 and 0.26, where sharing was neutral or slower.
 */
export const sharingFileShare = 0.4;

/**
 * How much sharing raises the estimated peak memory, for the fit a count must pass before sharing turns
 * on: peak RSS grew by up to 11% at 16 checkers (T3 web), and each extra checker's declarations are
 * resolved by one more checker.
 */
export const sharingPeakShare = 1.12;

/**
 * Whether `signals` say that sharing pays: at least `minSharingCheckers` checkers, `sharingFileShare`
 * of the program declarations or from node_modules, and ranges that mostly resolve the same large
 * libraries — the work sharing removes. The memory fit (`CheckFit`) is checked by `decideCheck`.
 */
export function sharingCandidate(signals: CheckSignals): boolean {
  return (
    signals.count >= minSharingCheckers &&
    signals.fileShare >= sharingFileShare &&
    isLibraryBound(signals.library, signals.own)
  );
}

/** The window a sharing run reads its counters in where the record has no check time: 300 ms. */
export const shareWindow = 300;

/**
 * Learning (DESIGN 3, 4, 5). A run with a record of the project's earlier runs compares the configurations
 * those samples measured with the ones the static rules choose. It needs three usable samples of each arm
 * before it trusts a comparison (`comparisonSamples`), and a configuration beats another only when it is
 * faster by a margin that its own noise cannot explain (`marginOf`, DESIGN 4.1: 3% at least, twice the
 * larger arm's relative MAD). Adopted configurations are re-measured by control runs and dropped by the
 * fast-revert rule; a configuration the signals leave uncertain is tried in a real run, at most one in
 * `exploreRuns` and never when the record shows it loses.
 */

/** The fewest usable samples of each arm a comparison needs. */
export const comparisonSamples = 3;
/** The smallest margin one configuration must beat another by (DESIGN 4.1: T1's c1 noise band). */
export const marginFloor = 0.03;
/** The load above which a sample is kept in the record but not used for a decision (DESIGN 3.3). */
export const usableLoad = 0.5;
/** The runs between two control runs of an adopted configuration (DESIGN 4.2). */
export const controlRuns = 16;
/** The seconds after which an adopted configuration is re-measured, even without `controlRuns` runs. */
export const controlAfterSeconds = 14 * 86400;
/** The fewest runs between two exploring runs (DESIGN 4.4). */
export const exploreRuns = 8;
/** The least recorded check time exploration is worth its noise at, milliseconds (DESIGN 4.4). */
export const exploreCheckMs = 2000;
/** The fewest checkers a sharing exploration runs with (DESIGN 4.4). */
export const exploreSharingCheckers = 8;
/** The least file share at which sharing is uncertain (DESIGN 4.4). */
export const exploreSharingShare = 0.3;
/** The band of L / O within which the checker count is uncertain (DESIGN 4.4). */
export const exploreLibraryRatio = 2.5;
export const exploreLibraryRatioHigh = 10;
/** The least library text at which the checker count is uncertain (DESIGN 4.4). */
export const exploreLibraryText = 3_000_000;

/** The median of `values`, `undefined` where there are none. */
export function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** An arm's relative noise: 1.4826 × its median absolute deviation / its median (DESIGN 4.1). */
export function noiseOf(values: readonly number[]): number {
  const median = medianOf(values);
  if (median === undefined || median <= 0) return 0;
  const deviations = values.map((value) => Math.abs(value - median));
  return (1.4826 * (medianOf(deviations) ?? 0)) / median;
}

/** The margin `a` and `b` must differ by: 3%, or twice the larger arm's noise (DESIGN 4.1). */
export function marginOf(a: readonly number[], b: readonly number[]): number {
  return Math.max(marginFloor, 2 * Math.max(noiseOf(a), noiseOf(b)));
}

/**
 * How much faster `better` is than `worse`, where it beats it by `marginOf`: `0.21` for 21% faster,
 * `undefined` where there are fewer than `comparisonSamples` usable samples of either arm or no margin
 * separates them.
 */
export function beatsBy(better: readonly number[], worse: readonly number[]): number | undefined {
  if (better.length < comparisonSamples || worse.length < comparisonSamples) return undefined;
  const b = medianOf(better)!;
  const w = medianOf(worse)!;
  if (b <= 0 || w <= 0) return undefined;
  return b <= w * (1 - marginOf(better, worse)) ? 1 - b / w : undefined;
}

/** The samples of `record` a decision may use: those taken while the machine was not busy. */
export function usableSamples(record: RunRecord): RecordSample[] {
  return record.samples.filter((sample) => sample.load <= usableLoad);
}

/** The check times of the samples that checked with `checkers` checkers and sharing `share`. */
export function checkTimes(samples: readonly RecordSample[], checkers: number, share: boolean): number[] {
  const times: number[] = [];
  for (const sample of samples) if (sample.checkers === checkers && sample.share === share) times.push(sample.checkMs);
  return times;
}

/** The parse times of the samples that parsed with `parseThreads` threads. */
export function parseTimes(samples: readonly RecordSample[], parseThreads: number): number[] {
  const times: number[] = [];
  for (const sample of samples) if (sample.parseThreads === parseThreads) times.push(sample.parseMs);
  return times;
}

/**
 * The least margin between masses of the two arms a fast revert needs: the three adopted samples against
 * control samples that may be fewer than `comparisonSamples`.
 */
function revertMargin(adopted: readonly number[], control: readonly number[]): number {
  return Math.max(marginFloor, 2 * Math.max(noiseOf(adopted), noiseOf(control)));
}

/**
 * Whether the last three usable samples of an adopted configuration all measured slower than the latest
 * control samples by more than the margin: the adopted choice has gone bad and reverts now, without
 * waiting for three new control samples (DESIGN 4.2).
 */
export function fastRevert(samples: readonly RecordSample[], checkers: number, share: boolean): boolean {
  const adopted: number[] = [];
  for (const sample of samples)
    if (sample.checkers === checkers && sample.share === share) adopted.push(sample.checkMs);
  if (adopted.length < comparisonSamples) return false;
  const last = adopted.slice(-comparisonSamples);
  const control: number[] = [];
  for (const sample of samples)
    if (sample.role === 'control' && sample.load <= usableLoad) control.push(sample.checkMs);
  if (control.length === 0) return false;
  const baseline = medianOf(control.slice(-comparisonSamples))!;
  const margin = revertMargin(last, control.slice(-comparisonSamples));
  return last.every((ms) => ms > baseline * (1 + margin));
}

/** The window a sharing run reads its counters in: a tenth of the recorded check, at least 200 ms. */
export function shareWindowOf(record: RunRecord | undefined, checkers: number, share: boolean): number {
  if (record === undefined) return shareWindow;
  const times = checkTimes(usableSamples(record), checkers, share);
  const median = medianOf(times);
  if (median === undefined) return shareWindow;
  return Math.max(200, Math.round(median / 10));
}

/** `fraction` as a whole percentage, `21` for 0.213. */
function percent(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * The number of threads that parse ahead of a program checked by `checkers` checkers: every CPU this
 * process may run on, as tsgo parses on every core whatever its checker count (parse threads hand
 * their files to the shared program; what else they allocate is reused by the checker threads), but
 * one. The main thread hands out the chunks they load: with a thread on every CPU, it waits for a CPU
 * each time a thread returns a chunk, and so does that thread for its next chunk (VS Code's parse took
 * 18-57 ms longer with 16 threads on 16 CPUs than with 15).
 */
export function defaultParseThreads(checkers: number): number {
  const cpus = availableCpus();
  return Math.max(1, Math.min(cpus - 1, Math.max(checkers, Math.min(cpus, maxAutoCheckers))));
}

/** The options the configuration reads: `"checkers"` or `--checkers` pins the count (`CompilerOptions`). */
export interface RunOptions {
  readonly checkers?: number;
}

/**
 * The run's configuration for a program with `options`, before its files are parsed: the parse threads,
 * which are fixed before any file is known, and the pins of the checker count and sharing. `checkers` is
 * the count for the options without the program (`checkerThreads`); the count and sharing are decided
 * after bind, in `decideCheck`.
 *
 * `record` is the project's record of earlier runs where this run may read one; its chosen parse threads
 * apply here, and where the record leaves them uncertain and the static rules have nothing to try, this
 * run parses with half the default threads to measure them. `explore` is false where a run may not try an
 * alternative (watch mode, a concurrent build); CI is read from `env`.
 */
export function preParseConfig(
  options: RunOptions,
  checkers: number,
  env: Record<string, string | undefined> = process.env,
  record: RunRecord | undefined = undefined,
  explore: boolean = true,
): RunConfig {
  const config = new RunConfig();
  const pins = pinsOf(env);
  config.automaticity = pins.automaticity;
  config.checkers = checkers;
  config.record = record;
  const ci = env.CI;
  config.explore =
    explore && pins.automaticity === Automaticity.Explore && (ci === undefined || ci === '' || ci === 'false');
  if (options.checkers !== undefined) {
    config.checkersSource = Source.Pinned;
    config.checkersPin = '--checkers';
  } else if (checkersPolicy(env) === 'fixed') {
    config.checkersSource = Source.Pinned;
    config.checkersPin = 'TSC_TS_CHECKERS';
  }
  const parseDefault = defaultParseThreads(checkers);
  if (pins.parseThreads !== undefined) {
    config.parseThreads = pins.parseThreads;
    config.parseSource = Source.Pinned;
    config.parsePin = 'TSC_TS_PARSE_THREADS';
  } else if (controlDue(record, pins.automaticity, Math.floor(Date.now() / 1000))) {
    // A control run parses with the default threads too: it re-measures the static choice whole.
    config.parseThreads = parseDefault;
    config.parseSource = Source.Control;
    config.role = 'control';
  } else {
    config.parseThreads = parseDefault;
    const learned = learnedParseThreads(record, parseDefault, pins.automaticity);
    const explored = learned === undefined ? exploreParseThreads(record, parseDefault, config.explore) : undefined;
    if (learned !== undefined) {
      config.parseThreads = learned.threads;
      config.parseSource = Source.Learned;
      config.parseReasons.push(learned.reason);
    } else if (explored !== undefined) {
      config.parseThreads = explored;
      config.parseSource = Source.Explore;
      config.role = 'explore';
    }
  }
  if (pins.share !== undefined) {
    config.share = pins.share;
    config.shareSource = Source.Pinned;
    config.sharePin = 'TSC_TS_SHARE';
  }
  if (env.TSC_TS_CACHE === '0') {
    config.records = false;
    config.recordsReason = 'TSC_TS_CACHE=0';
  } else if (!learns(pins.automaticity)) {
    config.records = false;
    config.recordsReason = 'TSC_TS_AUTO=' + (pins.automaticity === Automaticity.Off ? '0' : 'static');
  }
  // A doctor child reports the signals even though it keeps no record (`doctor-report.ts`).
  const report = env.TSC_TS_DOCTOR_REPORT;
  config.measure = report !== undefined && report !== '';
  return config;
}

/**
 * What a bound program shows about the cost of checking it, which the rules that choose the checker
 * count and sharing read. The ranges are the checker threads' ranges of files (`planSchedule`).
 */
export class CheckSignals {
  /** The checkers the plan was made for, before any rule cut the count. */
  count: number;
  /** The statement ranges of the plan; 0 where every file is checked whole. */
  ranges: number;
  /** Characters of the libraries a checker's range reaches, on average over the ranges (L). */
  library = 0;
  /** Characters of the files a checker's range checks, on average over the ranges (O). */
  own = 0;
  /** The share of `library` + `own` that a second range reaches too (R). */
  redundancy = 0;
  /** The share of the program's files that are declaration files (F_d). */
  declarationShare = 0;
  /** The share of the program's files that come from `node_modules` (F_n). */
  nodeModulesShare = 0;

  constructor(count: number, ranges: number) {
    this.count = count;
    this.ranges = ranges;
  }

  /** F = max(F_d, F_n): the share of the program that is declarations every checker resolves again. */
  get fileShare(): number {
    return Math.max(this.declarationShare, this.nodeModulesShare);
  }
}

/**
 * The checkers whose estimated peak memory fits a program: without sharing, and with the peak sharing
 * adds (`sharingPeakShare`). Computed by `parallel-check.ts`, which holds the estimate.
 */
export interface CheckFit {
  /** The checkers whose estimated peak memory fits with the peak sharing adds (`sharingPeakShare`). */
  readonly sharing: number;
}

/** What `decideCheck` needs of the run besides the signals: whether it can share, and how many checkers fit. */
export interface CheckDecision {
  /** Whether checking happens on checker threads that share the program (scriptc builds), more than one. */
  readonly possible: boolean;
  /** The memory fit, where the sharing rule needs it; `undefined` elsewhere. */
  readonly fit: CheckFit | undefined;
  /** The program's shape, where this run read a record: its samples describe this program only if it matches. */
  readonly shape?: RecordShape;
  /** The CPUs automatic selection may use (`min(availableCpus(), maxAutoCheckers)`). */
  readonly cpus?: number;
  /** The memory limit, in bytes: a configuration whose recorded peak exceeds `memoryShare` of it is not chosen. */
  readonly memoryBytes?: number;
  /** The time, seconds since the epoch, for the age of the last control sample (DESIGN 4.2). */
  readonly now?: number;
}

/** The decision of a run that cannot share, made without the memory fit. */
export const noSharing: CheckDecision = { possible: false, fit: undefined };

/** The share of the memory limit a configuration may have reached at its peak (DESIGN 5.5). */
export const memoryShare = 0.85;

/**
 * The checker count and sharing for a bound program, from `signals`; returns the count.
 *
 * The count is the one the plan was made for, cut to three quarters where every range mostly resolves
 * the same large libraries and no pin gave it (`libraryBoundCount`, `tests/parallel-schedule` records
 * the measurements).
 *
 * Sharing is turned on by the static rule where the run may choose it and can share, the signals say it
 * pays (`sharingCandidate`), the count it leaves is one sharing was measured at (`minSharingCheckers`),
 * and that count fits memory with the peak sharing adds. The cut stays on: 16 checkers with sharing are
 * within noise of the cut count with it on T3 Code's two projects (Q2: 0.99 and 1.03 of the cut count,
 * the intervals covering 1), and the cut uses 0.4 GB to 0.9 GB less at the peak, so the count is not
 * raised for sharing.
 *
 * Where the run read the project's record, the samples it holds decide more: an adopted configuration
 * stays until the static one beats it and reverts early when it stops paying (`learn`), a configuration
 * the signals leave uncertain is tried, and a run in every `controlRuns` re-measures the static choice.
 *
 * Sharing is what `TSC_TS_SHARE` pins. The decisions are those of a run before this module existed, and
 * what `TSC_TS_AUTO=0` keeps.
 */
export function decideCheck(config: RunConfig, signals: CheckSignals, decision: CheckDecision = noSharing): number {
  const count = signals.count;
  const pinned = config.checkersSource === Source.Pinned;
  const cut = pinned || count <= tsgoCheckers ? count : libraryBoundCount(count, signals.library, signals.own);
  config.checkers = cut;
  const fit = decision.fit;
  if (
    decision.possible &&
    fit !== undefined &&
    fit.sharing >= cut &&
    cut >= minSharingCheckers &&
    config.shareSource !== Source.Pinned &&
    config.automaticity !== Automaticity.Off &&
    sharingCandidate(signals)
  ) {
    config.share = true;
    config.shareSource = Source.Static;
    config.shareReasons.push(sharingReason(signals));
  }
  config.shape = decision.shape;
  if (learns(config.automaticity) && config.record !== undefined) learn(config, signals, decision, cut);
  config.shareWindowMs = shareWindowOf(config.record, config.checkers, config.share);
  return config.checkers;
}

/**
 * The static rules' choice and the record's evidence decide this run's checker count and sharing, and the
 * configuration the record keeps as chosen (DESIGN 4.2-4.4):
 *
 * - an adopted configuration stays while the static one does not beat it, and reverts at once when its
 *   last three samples are slower than the last control samples (`fastRevert`);
 * - one run in `controlRuns`, or the first after `controlAfterSeconds`, uses the static choice and is
 *   recorded with role `control`, so the baseline the keep rule reads stays current;
 * - a configuration with `comparisonSamples` usable samples that beats the static choice by the margin
 *   is adopted;
 * - where the signals leave a setting uncertain and the record has fewer than `comparisonSamples` of the
 *   alternative, one run in `exploreRuns` tries it, with role `explore`.
 *
 * A pinned setting is never chosen by any of this. A run that explored its parse threads (`role`
 * `explore` before binding) or is a control run keeps its static checkers and sharing, so that one
 * dimension is measured at a time.
 */
function learn(config: RunConfig, signals: CheckSignals, decision: CheckDecision, staticCheckers: number): void {
  const record = config.record!;
  const staticShare =
    config.shareSource === Source.Pinned
      ? config.share
      : sharingCandidate(signals) &&
        decision.possible &&
        decision.fit !== undefined &&
        decision.fit.sharing >= staticCheckers &&
        staticCheckers >= minSharingCheckers;
  const changed = decision.shape !== undefined && shapeChanged(record.shape, decision.shape);
  const samples = changed ? [] : usableSamples(record);
  const cpus = Math.min(decision.cpus ?? availableCpus(), maxAutoCheckers);
  const parseDefault = defaultParseThreads(signals.count);
  const checkersPinned = config.checkersSource === Source.Pinned;
  const sharePinned = config.shareSource === Source.Pinned;
  const parsePinned = config.parseSource === Source.Pinned;
  const before = config.role;
  const exploredBefore = before === 'explore';
  const controlBefore = before === 'control';

  // Written out field by field rather than spread (`{ ...record.chosen }`): a spread copies properties
  // the compiler cannot name at its call sites, which scriptc's native build reads as a dynamic store
  // and answers by storing every class's number fields as doubles (`scripts/check-int32-fields.mjs`).
  let chosen: RecordChoice = changed
    ? { checkers: staticCheckers, share: staticShare, parseThreads: parseDefault, source: 'default', since: 0 }
    : {
        checkers: record.chosen.checkers,
        share: record.chosen.share,
        parseThreads: record.chosen.parseThreads,
        source: record.chosen.source,
        since: record.chosen.since,
      };

  let checkers = staticCheckers;
  let share = staticShare;
  let checkersLearned = false;
  let shareLearned = false;
  let checkersGain: number | undefined = undefined;
  let shareGain: number | undefined = undefined;
  let parseChosen = parseDefault;
  let adopted = false;
  let role: 'chosen' | 'control' | 'explore' = before;
  // The configuration `fastRevert` rejected, this run or an earlier one: its older samples can still
  // dominate a median, and the last three runs are what the revert rule reads (`samplesFor`).
  let rejection = record.rejected;

  if (!exploredBefore && !controlBefore) {
    // 1. An adopted configuration stays until the static choice beats it, and a bad one reverts at once.
    const learned = chosen.source === 'learned';
    const wantCheckers = checkersPinned ? staticCheckers : chosen.checkers;
    const wantShare = sharePinned ? staticShare : chosen.share;
    if (
      learned &&
      (wantCheckers !== staticCheckers || wantShare !== staticShare) &&
      fits(wantCheckers, wantShare, decision, cpus, samples, decision.memoryBytes)
    ) {
      const own = checkTimes(samples, wantCheckers, wantShare);
      const baseline = checkTimes(samples, staticCheckers, staticShare);
      const staticBeats = beatsBy(baseline, own) !== undefined;
      const fellBehind = !staticBeats && fastRevert(samples, wantCheckers, wantShare);
      if (!staticBeats && !fellBehind) {
        checkers = wantCheckers;
        share = wantShare;
        checkersLearned = wantCheckers !== staticCheckers;
        shareLearned = wantShare !== staticShare;
        const gain = beatsBy(own, baseline);
        if (checkersLearned) checkersGain = gain;
        if (shareLearned) shareGain = gain;
      }
      if (fellBehind) rejection = { checkers: wantCheckers, share: wantShare, run: record.runs };
    }
    // 2. A control run re-measures the static choice, and changes no choice.
    const learnedBefore =
      learned &&
      (chosen.checkers !== staticCheckers || chosen.share !== staticShare || chosen.parseThreads !== parseDefault);
    if (
      learnedBefore &&
      (record.runs - record.lastControl >= controlRuns || controlIsStale(record, samples, decision.now))
    ) {
      checkers = staticCheckers;
      share = staticShare;
      checkersLearned = false;
      shareLearned = false;
      parseChosen = parseDefault;
      role = 'control';
    } else {
      // 3. A configuration the record shows faster than the static one is adopted.
      if (!sharePinned && !shareLearned) {
        const alternative = !staticShare;
        if (fits(checkers, alternative, decision, cpus, samples, decision.memoryBytes)) {
          const own = checkTimes(samplesFor(samples, rejection, checkers, alternative), checkers, alternative);
          const gain = beatsBy(own, checkTimes(samples, checkers, staticShare));
          if (gain !== undefined) {
            share = alternative;
            shareLearned = true;
            shareGain = gain;
            adopted = true;
          }
        }
      }
      if (!checkersPinned && !checkersLearned) {
        for (const candidate of countCandidates(staticCheckers, cpus)) {
          if (candidate === checkers || !fits(candidate, share, decision, cpus, samples, decision.memoryBytes))
            continue;
          const own = checkTimes(samplesFor(samples, rejection, candidate, share), candidate, share);
          const gain = beatsBy(own, checkTimes(samples, staticCheckers, staticShare));
          if (gain !== undefined) {
            checkers = candidate;
            checkersLearned = true;
            checkersGain = gain;
            adopted = true;
            break;
          }
        }
      }
      // 4. Parse threads are chosen for the next run here; this run parsed with the choice its record had.
      // The recorded count is kept only while the comparison that adopted it still shows it faster: a
      // record can name a count without one (a first run pinned it before any record existed), and the
      // samples of one run are no comparison, so that count is not learned here either.
      if (!parsePinned) {
        if (learned && chosen.parseThreads !== parseDefault && parseWins(samples, chosen.parseThreads, parseDefault)) {
          parseChosen = chosen.parseThreads;
        } else {
          for (const candidate of parseCandidates(parseDefault, cpus)) {
            if (candidate === parseChosen) continue;
            const own = parseTimes(samples, candidate);
            const gain = beatsBy(own, parseTimes(samples, parseDefault));
            if (gain !== undefined) {
              parseChosen = candidate;
              adopted = true;
              break;
            }
          }
        }
      }
      // 5. A setting the signals leave uncertain is tried in this run, one dimension at a time, unless
      // a pin fixed it.
      if (role === 'chosen' && !adopted && config.explore && !changed) {
        const checkMs = medianOf(checkTimes(samples, checkers, share));
        if (record.runs - record.lastExplore >= exploreRuns && checkMs !== undefined && checkMs >= exploreCheckMs) {
          const shareAlt = !share;
          if (
            !sharePinned &&
            sharingBand(signals) &&
            fits(checkers, shareAlt, decision, cpus, samples, decision.memoryBytes) &&
            openCandidate(samples, checkers, shareAlt, checkers, share)
          ) {
            share = shareAlt;
            role = 'explore';
          } else if (!checkersPinned && checkersBand(signals)) {
            for (const candidate of countCandidates(staticCheckers, cpus)) {
              if (candidate === checkers || !fits(candidate, share, decision, cpus, samples, decision.memoryBytes))
                continue;
              if (openCandidate(samples, candidate, share, checkers, share)) {
                checkers = candidate;
                role = 'explore';
                break;
              }
            }
          }
        }
      }
    }
  }

  // Apply what the run uses, and what the record keeps as chosen.
  config.checkers = checkers;
  config.share = share;
  config.role = role;
  config.checkersSource = checkersLearned ? Source.Learned : config.checkersSource;
  if (checkersLearned)
    config.checkersReasons.push(learnedReason('check', checkersGain, checkTimes(samples, checkers, share).length));
  if (shareLearned) {
    config.shareSource = Source.Learned;
    config.shareReasons.length = 0;
    config.shareReasons.push(learnedReason('check', shareGain, checkTimes(samples, checkers, share).length));
  } else if (!share && config.shareSource === Source.Static) {
    config.shareSource = Source.Default;
    config.shareReasons.length = 0;
  }
  if (role === 'explore') {
    // The run explores the dimension it changed: the parse threads where the block above did not run.
    if (share !== staticShare) {
      config.shareSource = Source.Explore;
      config.shareReasons.length = 0;
    } else if (checkers !== staticCheckers) {
      config.checkersSource = Source.Explore;
      config.checkersReasons.length = 0;
    }
  } else if (role === 'control') {
    // A control run uses the static checker count and sharing; the parse threads were fixed before the
    // program was bound, and a run that parsed with learned ones says so.
    config.checkersSource = Source.Control;
    config.shareSource = Source.Control;
    config.checkersReasons.length = 0;
    config.shareReasons.length = 0;
  }
  const chosenNow: RecordChoice = {
    checkers,
    share,
    parseThreads: parseChosen,
    source: checkersLearned || shareLearned || parseChosen !== parseDefault ? 'learned' : 'default',
    since: 0,
  };
  config.chosen = role === 'chosen' ? chosenNow : chosen;
  config.rejected = rejection;
}

/**
 * The samples an adoption may read for a configuration: where the record rejected it, only the runs after
 * the rejection. The older samples are the ones `fastRevert` found it had fallen behind on, and a median
 * over them would adopt the configuration the record just gave up again (`RecordRejection`).
 */
function samplesFor(
  samples: readonly RecordSample[],
  rejection: RecordRejection | undefined,
  checkers: number,
  share: boolean,
): readonly RecordSample[] {
  if (rejection === undefined || rejection.checkers !== checkers || rejection.share !== share) return samples;
  return samples.filter((sample) => sample.run > rejection.run);
}

/** Whether a configuration may be chosen or tried: the count automatic selection may use, and the memory it reaches. */
function fits(
  checkers: number,
  share: boolean,
  decision: CheckDecision,
  cpus: number,
  samples: readonly RecordSample[],
  memoryBytes: number | undefined,
): boolean {
  if (checkers < 1 || checkers > cpus) return false;
  if (share && !(decision.possible && decision.fit !== undefined && decision.fit.sharing >= checkers)) return false;
  return peakFits(samples, checkers, share, memoryBytes);
}

/** Whether every sample of a configuration stayed under `memoryShare` of the memory limit (DESIGN 5.5). */
function peakFits(
  samples: readonly RecordSample[],
  checkers: number,
  share: boolean,
  memoryBytes: number | undefined,
): boolean {
  if (memoryBytes === undefined || memoryBytes <= 0) return true;
  const limit = (memoryBytes / 1048576) * memoryShare;
  for (const sample of samples)
    if (sample.checkers === checkers && sample.share === share && sample.peakMB > limit) return false;
  return true;
}

/** Whether this run is a control run: the record holds a learned choice, and one is due (DESIGN 4.2). */
function controlDue(record: RunRecord | undefined, automaticity: Automaticity, now: number): boolean {
  if (!learns(automaticity) || record === undefined || record.chosen.source !== 'learned') return false;
  if (record.runs - record.lastControl >= controlRuns) return true;
  return controlIsStale(record, usableSamples(record), now);
}

/** Whether a control run is due: none yet, or the last one is older than `controlAfterSeconds` (DESIGN 4.2). */
function controlIsStale(record: RunRecord, samples: readonly RecordSample[], now: number | undefined): boolean {
  if (now === undefined) return false;
  let last: number | undefined = undefined;
  for (const sample of samples)
    if (sample.role === 'control' && (last === undefined || sample.at > last)) last = sample.at;
  if (last === undefined) {
    for (const sample of samples)
      if (sample.run === record.chosen.since && (last === undefined || sample.at > last)) last = sample.at;
  }
  return last === undefined || now - last >= controlAfterSeconds;
}

/**
 * Whether a configuration is still worth trying: it has fewer than `comparisonSamples` usable samples and
 * has not lost to `baseline` by the margin on two (DESIGN 4.4).
 */
function openCandidate(
  samples: readonly RecordSample[],
  checkers: number,
  share: boolean,
  baselineCheckers: number,
  baselineShare: boolean,
): boolean {
  const own = checkTimes(samples, checkers, share);
  if (own.length >= comparisonSamples) return false;
  return !loses(own, checkTimes(samples, baselineCheckers, baselineShare));
}

/** Whether an arm with at least two samples lost to `baseline` by the margin. */
function loses(candidate: readonly number[], baseline: readonly number[]): boolean {
  if (candidate.length < 2 || baseline.length === 0) return false;
  const c = medianOf(candidate)!;
  const b = medianOf(baseline)!;
  if (c <= 0 || b <= 0) return false;
  return c > b * (1 + marginOf(candidate, baseline));
}

/** The counts automatic selection may try instead of `count`: three quarters of it, and every CPU (DESIGN 4.4). */
function countCandidates(count: number, cpus: number): number[] {
  const candidates = [Math.max(1, Math.ceil((count * 3) / 4)), cpus];
  const distinct: number[] = [];
  for (const candidate of candidates)
    if (candidate !== count && !distinct.includes(candidate)) distinct.push(candidate);
  return distinct;
}

/** Whether `threads` parsed faster than `parseDefault` by the margin over `comparisonSamples` runs a side. */
function parseWins(samples: readonly RecordSample[], threads: number, parseDefault: number): boolean {
  return beatsBy(parseTimes(samples, threads), parseTimes(samples, parseDefault)) !== undefined;
}

/** The parse-thread counts automatic selection may try: half the default (DESIGN 4.4). */
function parseCandidates(parseDefault: number, cpus: number): number[] {
  const candidate = Math.max(1, Math.ceil(parseDefault / 2));
  if (candidate >= parseDefault || candidate > Math.max(1, cpus - 1)) return [];
  return [candidate];
}

/**
 * Whether sharing is uncertain (DESIGN 4.4): at least `exploreSharingCheckers` checkers, `exploreSharingShare`
 * of the files, and exactly one of the static rule's two tests holds.
 */
export function sharingBand(signals: CheckSignals): boolean {
  return (
    signals.count >= exploreSharingCheckers &&
    signals.fileShare >= exploreSharingShare &&
    signals.fileShare >= sharingFileShare !== isLibraryBound(signals.library, signals.own)
  );
}

/** Whether the checker count is uncertain (DESIGN 4.4): L / O between 2.5 and 10, and at least 3M library characters. */
export function checkersBand(signals: CheckSignals): boolean {
  return bandOf(signals.library, signals.own);
}

/** `bandOf` on a record's shape, for the parse threads, which are chosen before the program is bound. */
function bandOf(library: number, own: number): boolean {
  if (own <= 0 || library < exploreLibraryText) return false;
  const ratio = library / own;
  return ratio >= exploreLibraryRatio && ratio <= exploreLibraryRatioHigh;
}

/** Whether the record's signals leave sharing uncertain, for the parse threads' choice before binding. */
function recordSharingBand(record: RunRecord): boolean {
  const shape = record.shape;
  const fileShare = shape.fileShare ?? 0;
  return (
    record.chosen.checkers >= exploreSharingCheckers &&
    fileShare >= exploreSharingShare &&
    fileShare >= sharingFileShare !== isLibraryBound(shape.library, shape.own)
  );
}

/** How a learned choice reads in the section: `check 21% faster over 5 runs`, `parse 4% faster over 3 runs`. */
function learnedReason(dimension: 'check' | 'parse', gain: number | undefined, runs: number): string {
  const count = runs === 1 ? '1 run' : `${runs} runs`;
  return gain === undefined
    ? `${dimension} measured over ${count}`
    : `${dimension} ${percent(gain)}% faster over ${count}`;
}

/** The parse threads the record adopted, and why, where this run may use them (`learnedParseThreads`). */
function learnedParseThreads(
  record: RunRecord | undefined,
  parseDefault: number,
  automaticity: Automaticity,
): { threads: number; reason: string } | undefined {
  if (!learns(automaticity) || record === undefined) return undefined;
  const threads = record.chosen.parseThreads;
  if (!Number.isInteger(threads) || threads < 1 || threads === parseDefault) return undefined;
  const samples = usableSamples(record);
  const gain = beatsBy(parseTimes(samples, threads), parseTimes(samples, parseDefault));
  // The record's chosen count can differ from the default without having won a comparison: a run that
  // pinned the parse threads before any record existed stores the pinned count, and the samples of that
  // one run are no comparison. Only the three-sample comparison makes a count learned.
  if (gain === undefined) return undefined;
  return { threads, reason: learnedReason('parse', gain, parseTimes(samples, threads).length) };
}

/**
 * The parse threads this run tries where the record leaves them open: half the default, once in
 * `exploreRuns` runs of at least `exploreCheckMs`, when the settings the bound program decides have no
 * candidate left to try (DESIGN 4.4: one dimension at a time, sharing and checkers first).
 */
function exploreParseThreads(
  record: RunRecord | undefined,
  parseDefault: number,
  explore: boolean,
): number | undefined {
  if (!explore || record === undefined || record.chosen.source === 'learned') return undefined;
  if (record.runs - record.lastExplore < exploreRuns) return undefined;
  const samples = usableSamples(record);
  const checkMs = medianOf(checkTimes(samples, record.chosen.checkers, record.chosen.share));
  if (checkMs === undefined || checkMs < exploreCheckMs) return undefined;
  if (openSetting(record, samples)) return undefined;
  for (const candidate of parseCandidates(parseDefault, availableCpus())) {
    const own = parseTimes(samples, candidate);
    if (own.length >= comparisonSamples || loses(own, parseTimes(samples, parseDefault))) continue;
    return candidate;
  }
  return undefined;
}

/**
 * Whether the checker count or sharing still has a candidate exploration would try now, which the run's
 * binding decides: the parse threads wait for it to close (DESIGN 4.4).
 */
function openSetting(record: RunRecord, samples: readonly RecordSample[]): boolean {
  const chosen = record.chosen;
  const cpus = Math.min(availableCpus(), maxAutoCheckers);
  const open = (checkers: number, share: boolean) =>
    openCandidate(samples, checkers, share, chosen.checkers, chosen.share);
  if (recordSharingBand(record) && open(chosen.checkers, !chosen.share)) return true;
  if (!bandOf(record.shape.library, record.shape.own)) return false;
  for (const candidate of countCandidates(chosen.checkers, cpus)) if (open(candidate, chosen.share)) return true;
  return false;
}

/**
 * Why sharing turned on, for the section: the share of the program that is declarations every checker
 * resolves again, and what the ranges reach, as `66% of files in node_modules; ranges reach 12.1M
 * library characters for 0.9M checked`.
 */
function sharingReason(signals: CheckSignals): string {
  const declarations = signals.declarationShare > signals.nodeModulesShare;
  const share = declarations ? signals.declarationShare : signals.nodeModulesShare;
  return (
    `${Math.round(share * 100)}% of files ` +
    (declarations ? 'are declarations' : 'in node_modules') +
    `; ranges reach ${millions(signals.library)}M library characters for ${millions(signals.own)}M checked`
  );
}

/** `chars` in millions, with one decimal: `12.1M`. */
function millions(chars: number): string {
  return (chars / 1_000_000).toFixed(1);
}

/** Where the section writes: the system of a compile, or anything else with `write`. */
export interface RunConfigOutput {
  write(text: string): void;
}

/** What the section's `Records:` line says (`run-records.ts`). */
export interface RecordsReport {
  /** The record's path, as the section prints it (`~` for the home directory). */
  readonly path?: string;
  /** Why this run wrote no record. */
  readonly off?: string;
  /** Why the record could not be written, where writing was attempted. */
  readonly unavailable?: string;
}

/**
 * The `--extendedDiagnostics` section, printed after the statistics table: a blank line, `Suggestions:`,
 * and one line per setting with its value, where the value came from in parentheses, and how to pin it
 * where no pin chose it. Never printed for `--diagnostics` alone (`emitStatusAndReportStatistics`).
 */
export function reportRunConfig(out: RunConfigOutput, config: RunConfig, records?: RecordsReport): void {
  out.write(
    '\nSuggestions:\n' +
      suggestion(
        'Checkers',
        config.checkers,
        config.checkersSource,
        config.checkersPin,
        `--checkers ${config.checkers}`,
        config.checkersReasons,
      ) +
      suggestion(
        'Sharing',
        config.share ? 'on' : 'off',
        config.shareSource,
        config.sharePin,
        `TSC_TS_SHARE=${config.share ? '1' : '0'}`,
        config.shareReasons,
      ) +
      suggestion(
        'Parse threads',
        config.parseThreads,
        config.parseSource,
        config.parsePin,
        `TSC_TS_PARSE_THREADS=${config.parseThreads}`,
        config.parseReasons,
      ) +
      recordsLine(records),
  );
}

/** The `Records:` line: the record's path, why the run kept none, or why the write failed. */
function recordsLine(records: RecordsReport | undefined): string {
  if (records === undefined) return '';
  if (records.path !== undefined) return `  Records: ${records.path}\n`;
  if (records.unavailable !== undefined) return `  Records: unavailable (${records.unavailable})\n`;
  return `  Records: off (${records.off ?? 'disabled'})\n`;
}

/** One line of the section: the setting, its value, its source, and the pin for it where none chose it. */
function suggestion(
  setting: string,
  value: number | string,
  source: Source,
  pin: string | undefined,
  pinHint: string,
  reasons: readonly string[],
): string {
  let line = `  ${setting}: ${value} (${sourceText(source, pin, reasons)})`;
  if (pin === undefined) line += `; pin with ${pinHint}`;
  return line + '\n';
}

/** A source as the section prints it: `pinned: --checkers`, `default`, `automatic: <reason>`, … */
function sourceText(source: Source, pin: string | undefined, reasons: readonly string[]): string {
  const reason = reasons.join('; ');
  switch (source) {
    case Source.Pinned:
      return `pinned: ${pin ?? 'environment'}`;
    case Source.Default:
      return reason === '' ? 'default' : `automatic: ${reason}`;
    case Source.Static:
      return reason === '' ? 'automatic' : `automatic: ${reason}`;
    case Source.Learned:
      return reason === '' ? 'learned' : `learned: ${reason}`;
    case Source.Measured:
      return reason === '' ? 'measured' : `measured: ${reason}`;
    case Source.Explore:
      return 'exploring';
    case Source.Control:
      return 'control run';
  }
}
