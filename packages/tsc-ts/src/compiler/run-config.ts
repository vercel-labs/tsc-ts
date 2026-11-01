/**
 * The run configuration: how many checker threads check a program, whether they share results with each
 * other, and how many threads parse ahead of the program, with where each value came from. The values are
 * pinned by `--checkers` / `"checkers"` and by the `TSC_TS_CHECKERS`, `TSC_TS_SHARE`, `TSC_TS_PARSE_THREADS`
 * and `TSC_TS_AUTO` environment variables; a value that no pin gives is the compiler's own, which today is
 * what the compiler chose before this module existed, and which the rules that read the program's signals
 * (and, in a later step, earlier runs' records) will choose.
 *
 * The parse threads must be known before any file is parsed (`preParseConfig`); the checker count and
 * sharing are decided once the program is bound, from what it shows about the cost of checking it
 * (`decideCheck`). `--extendedDiagnostics` prints the values, their sources and how to pin them after the
 * statistics table (`reportRunConfig`).
 */
import { availableParallelism } from 'node:os';

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

/** The pins of `env`: `TSC_TS_AUTO` (`0`, `static`, or unset), `TSC_TS_SHARE` and `TSC_TS_PARSE_THREADS`. */
export function pinsOf(env: Record<string, string | undefined>): Pins {
  const automatic = env.TSC_TS_AUTO;
  const threads = env.TSC_TS_PARSE_THREADS === undefined ? NaN : Number(env.TSC_TS_PARSE_THREADS);
  return {
    automaticity: automatic === '0' ? Automaticity.Off : automatic === 'static' ? Automaticity.Static : Automaticity.On,
    share: sharePin(env),
    parseThreads: Number.isInteger(threads) && threads >= 1 ? threads : undefined,
  };
}

/**
 * How the number of checkers is chosen without `--checkers`: `auto` (the default) uses every CPU this
 * process may run on (`os.availableParallelism()`, at most `maxAutoCheckers`), and at least tsgo's four;
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

/**
 * The number of threads that parse ahead of a program checked by `checkers` checkers: every CPU this
 * process may run on, as tsgo parses on every core whatever its checker count (parse threads hand
 * their files to the shared program; what else they allocate is reused by the checker threads), but
 * one. The main thread hands out the chunks they load: with a thread on every CPU, it waits for a CPU
 * each time a thread returns a chunk, and so does that thread for its next chunk (VS Code's parse took
 * 18-57 ms longer with 16 threads on 16 CPUs than with 15).
 */
export function defaultParseThreads(checkers: number): number {
  const cpus = availableParallelism();
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
 */
export function preParseConfig(
  options: RunOptions,
  checkers: number,
  env: Record<string, string | undefined> = process.env,
): RunConfig {
  const config = new RunConfig();
  const pins = pinsOf(env);
  config.automaticity = pins.automaticity;
  config.checkers = checkers;
  if (options.checkers !== undefined) {
    config.checkersSource = Source.Pinned;
    config.checkersPin = '--checkers';
  } else if (checkersPolicy(env) === 'fixed') {
    config.checkersSource = Source.Pinned;
    config.checkersPin = 'TSC_TS_CHECKERS';
  }
  if (pins.parseThreads !== undefined) {
    config.parseThreads = pins.parseThreads;
    config.parseSource = Source.Pinned;
    config.parsePin = 'TSC_TS_PARSE_THREADS';
  } else config.parseThreads = defaultParseThreads(checkers);
  if (pins.share !== undefined) {
    config.share = pins.share;
    config.shareSource = Source.Pinned;
    config.sharePin = 'TSC_TS_SHARE';
  }
  if (env.TSC_TS_CACHE === '0') {
    config.records = false;
    config.recordsReason = 'TSC_TS_CACHE=0';
  } else if (pins.automaticity !== Automaticity.On) {
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
}

/** The decision of a run that cannot share, made without the memory fit. */
export const noSharing: CheckDecision = { possible: false, fit: undefined };

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
  return config.checkers;
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
