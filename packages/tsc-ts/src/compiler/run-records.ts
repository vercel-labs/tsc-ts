/**
 * Run records: what each eligible run measured, in a per-user cache directory, one file per project key.
 * This step writes a sample after every eligible run and lets the `--extendedDiagnostics` section name the
 * file; no decision reads a record yet (a later step's `decideCheck` does).
 *
 * Records do not go in the `.tsbuildinfo`: that file is tsgo's format and part of the output, and
 * non-incremental runs do not write it. A record lives at `<cache>/runs-v1/<key>.json`, where the key
 * covers what can change the best configuration: the build (the reported version and the executable's size
 * and mtime), the project (its config file, or its root files), the options that change the work, and the
 * machine's CPUs and memory. Reads and writes are best effort: a record that cannot be read or parsed is
 * treated as absent and replaced, an unwritable directory turns writing off for the run, and nothing is
 * printed except the section's `Records:` line.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { hash128String, toHex } from './xxh3.js';

/** The format this build writes and accepts; another format is treated as absent. */
export const recordFormat = 1;

/** The most record files the cache directory keeps (`capDirectory`). */
const maxRecordFiles = 512;

/** The most samples a record keeps, oldest dropped first. */
const maxSamples = 32;

/** Samples older than this many days are dropped when a record is read or written. */
const maxSampleAgeDays = 30;

/** What a bound program shows about the project, and the last run's numbers for it. */
export interface RecordShape {
  /** The program's files. */
  files: number;
  /** Characters of all of them. */
  chars: number;
  /** Characters of its declaration files. */
  declarationChars: number;
  /** Characters of its other files. */
  checkChars: number;
  /** Characters of the libraries a checker's range reached, on average (`CheckSignals.library`). */
  library: number;
  /** Characters of the files a checker's range checked, on average (`CheckSignals.own`). */
  own: number;
  /** The share of declarations two ranges reach (`CheckSignals.redundancy`). */
  redundancy: number;
  /**
   * The share of the program's files that are declarations or under `node_modules` (the larger of
   * `CheckSignals.declarationShare` and `CheckSignals.nodeModulesShare`), which the sharing rule reads
   * as `F`. Records written before this field lack it, and the parse threads' choice reads it as 0.
   */
  fileShare?: number;
}

/** What one run measured. */
export interface RecordSample {
  /** 1-based, counted in the record (`runs`). */
  run: number;
  /** Seconds since the epoch, when the run finished. */
  at: number;
  /** `chosen` for a run that used the configuration it would have used anyway. */
  role: 'chosen' | 'control' | 'explore' | 'doctor';
  checkers: number;
  share: boolean;
  parseThreads: number;
  /** Parse and bind, milliseconds. */
  parseMs: number;
  /** Check, milliseconds. */
  checkMs: number;
  /** The process's wall time, milliseconds. */
  totalMs: number;
  /** User plus system CPU time of the process, milliseconds. */
  cpuMs: number;
  /** VmHWM at exit, MB; 0 where unavailable. */
  peakMB: number;
  /** The 1-minute load average at the start divided by the CPUs; samples above 0.5 are kept, not used. */
  load: number;
  /** The duplicate-work fraction (DESIGN 2.3) where this run measured it. */
  dup?: number;
}

/** The configuration a run chose, recorded so a later run knows what the samples compare. */
export interface RecordChoice {
  checkers: number;
  share: boolean;
  parseThreads: number;
  /** `default` or `pinned` today; a later step also records `learned`. */
  source: string;
  /** The run that chose it. */
  since: number;
}

/** One record file. */
export interface RunRecord {
  format: number;
  shape: RecordShape;
  /** The runs of this key, samples or not. */
  runs: number;
  lastExplore: number;
  lastControl: number;
  chosen: RecordChoice;
  samples: RecordSample[];
}

/** The options the key covers: those that change the work a run does (`RecordKeyInput.options`). */
export interface RecordOptions {
  noEmit?: boolean;
  emitDeclarationOnly?: boolean;
  declaration?: boolean;
  composite?: boolean;
  incremental?: boolean;
  outFile?: string;
  noEmitOnError?: boolean;
  skipLibCheck?: boolean;
  checkJs?: boolean;
  isolatedDeclarations?: boolean;
  /** The config file the run reads, whose real path is part of the key. */
  configFilePath?: string;
}

/** What identifies a record: the build, the project, the options and the machine. */
export interface RecordKeyInput {
  /** The version the executable reports (`help.ts`). */
  version: string;
  /** The executable, whose size and mtime separate builds that share a version. */
  executable: string;
  /** The project's config file, or the root files when there is none. */
  configFile: string | undefined;
  rootNames: readonly string[];
  options: RecordOptions;
  cpus: number;
  memoryBytes: number;
}

/** The environment the records read: `TSC_TS_CACHE`, `TSC_TS_CACHE_DIR` and the platform's home. */
export interface RecordEnvironment {
  TSC_TS_CACHE?: string;
  TSC_TS_CACHE_DIR?: string;
  XDG_CACHE_HOME?: string;
  LOCALAPPDATA?: string;
  HOME?: string;
  USERPROFILE?: string;
}

/**
 * The directory the records live in, or `undefined` when `TSC_TS_CACHE=0` turns them off. Else
 * `TSC_TS_CACHE_DIR`; else the platform's cache directory for this user.
 */
export function recordsDirectory(
  env: RecordEnvironment,
  platform: string = process.platform,
  home: string = homedir(),
): string | undefined {
  if (env.TSC_TS_CACHE === '0') return undefined;
  if (env.TSC_TS_CACHE_DIR !== undefined && env.TSC_TS_CACHE_DIR !== '') return env.TSC_TS_CACHE_DIR;
  const userHome = env.HOME ?? env.USERPROFILE ?? home;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? joinPath(userHome, 'AppData', 'Local');
    return joinPath(local, 'tsc-ts', 'cache');
  }
  if (platform === 'darwin') return joinPath(userHome, 'Library', 'Caches', 'tsc-ts');
  const cache =
    env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== '' ? env.XDG_CACHE_HOME : joinPath(userHome, '.cache');
  return joinPath(cache, 'tsc-ts');
}

/** The path of `key`'s record in `directory`. */
export function recordFile(directory: string, key: string): string {
  return joinPath(directory, 'runs-v1', key + '.json');
}

/** The record-related environment, read by name (a scriptc build holds `process.env` as an index signature). */
export function recordEnvironment(): RecordEnvironment {
  return {
    TSC_TS_CACHE: process.env.TSC_TS_CACHE,
    TSC_TS_CACHE_DIR: process.env.TSC_TS_CACHE_DIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
}

/** The key of a record: the xxh3-128 hash of what identifies the build, project, options and machine. */
export function recordKey(input: RecordKeyInput): string {
  return toHex(hash128String(recordKeyText(input)));
}

/** The text `recordKey` hashes; exported so a test can read it. */
export function recordKeyText(input: RecordKeyInput): string {
  let build = input.version;
  try {
    const stat = statSync(input.executable);
    build += ' ' + stat.size + ' ' + Math.floor(stat.mtimeMs);
  } catch {
    // No executable to stat (a dev build): the version alone identifies it.
  }
  let project: string;
  if (input.configFile !== undefined && input.configFile !== '') {
    try {
      project = realpathSync(input.configFile);
    } catch {
      project = input.configFile;
    }
  } else project = [...input.rootNames].sort().join('\n');
  const memoryGiB = Math.floor(input.memoryBytes / 1073741824);
  return [
    'format ' + recordFormat,
    'build ' + build,
    'project ' + project,
    optionsText(input.options),
    'cpus ' + input.cpus,
    'memory ' + memoryGiB,
  ].join('\n');
}

/** The options line of the key: each named option's value, so a change gives a different key. */
function optionsText(options: RecordOptions): string {
  const flags: [string, boolean | undefined][] = [
    ['noEmit', options.noEmit],
    ['emitDeclarationOnly', options.emitDeclarationOnly],
    ['declaration', options.declaration],
    ['composite', options.composite],
    ['incremental', options.incremental],
    ['noEmitOnError', options.noEmitOnError],
    ['skipLibCheck', options.skipLibCheck],
    ['checkJs', options.checkJs],
    ['isolatedDeclarations', options.isolatedDeclarations],
  ];
  let text = 'options';
  for (const [name, value] of flags) text += ' ' + name + '=' + (value === true ? '1' : '0');
  return text + ' outFile=' + (options.outFile ?? '');
}

/** A record as read from a file, or `undefined` where the file is missing, unreadable or malformed. */
export function readRecord(file: string, now: number = Math.floor(Date.now() / 1000)): RunRecord | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = recordOf(parsed);
  if (record === undefined) return undefined;
  return dropOldSamples(record, now);
}

/** `parsed` as a record, or `undefined` where it is not one this build writes. */
function recordOf(parsed: unknown): RunRecord | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const r = parsed as Partial<RunRecord>;
  if (r.format !== recordFormat || typeof r.runs !== 'number' || !isShape(r.shape) || !isChoice(r.chosen))
    return undefined;
  const samples = Array.isArray(r.samples) ? r.samples.filter(isSample) : [];
  return {
    format: recordFormat,
    shape: r.shape,
    runs: r.runs,
    lastExplore: typeof r.lastExplore === 'number' ? r.lastExplore : 0,
    lastControl: typeof r.lastControl === 'number' ? r.lastControl : 0,
    chosen: r.chosen,
    samples,
  };
}

function isShape(value: unknown): value is RecordShape {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<RecordShape>;
  return (
    isNumber(s.files) &&
    isNumber(s.chars) &&
    isNumber(s.declarationChars) &&
    isNumber(s.checkChars) &&
    isNumber(s.library) &&
    isNumber(s.own) &&
    isNumber(s.redundancy)
  );
}

function isChoice(value: unknown): value is RecordChoice {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<RecordChoice>;
  return (
    isNumber(c.checkers) &&
    typeof c.share === 'boolean' &&
    isNumber(c.parseThreads) &&
    typeof c.source === 'string' &&
    isNumber(c.since)
  );
}

function isSample(value: unknown): value is RecordSample {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<RecordSample>;
  return (
    isNumber(s.run) &&
    isNumber(s.at) &&
    typeof s.role === 'string' &&
    isNumber(s.checkers) &&
    typeof s.share === 'boolean' &&
    isNumber(s.parseThreads) &&
    isNumber(s.parseMs) &&
    isNumber(s.checkMs) &&
    isNumber(s.totalMs) &&
    isNumber(s.cpuMs) &&
    isNumber(s.peakMB) &&
    isNumber(s.load)
  );
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

/** `record` without the samples older than the age limit. */
function dropOldSamples(record: RunRecord, now: number): RunRecord {
  const oldest = now - maxSampleAgeDays * 86400;
  const samples = record.samples.filter((s) => s.at >= oldest);
  if (samples.length === record.samples.length) return record;
  return {
    format: record.format,
    shape: record.shape,
    runs: record.runs,
    lastExplore: record.lastExplore,
    lastControl: record.lastControl,
    chosen: record.chosen,
    samples,
  };
}

/**
 * The record `previous` becomes after `sample`: the run counted, the sample appended (the oldest dropped
 * past the cap), and, where the project's shape changed by more than the limits below, the samples
 * discarded. `runs` is kept through a shape change, so an exploration schedule continues.
 *
 * `chosen` is the configuration the run chose for the next one, and the record's choice follows it: a
 * choice that differs from the one the samples describe (another count, sharing, parse threads or source)
 * starts at this run, and one that is unchanged keeps its `since`. A run recorded with role `explore` or
 * `control` moves the schedule those roles keep (`lastExplore`, `lastControl`); so does adopting a learned
 * choice, so that its runs are re-measured one in `controlRuns` after it was adopted.
 */
export function nextRecord(
  previous: RunRecord | undefined,
  sample: Omit<RecordSample, 'run'>,
  shape: RecordShape,
  chosen: RecordChoice,
): RunRecord {
  const runs = (previous?.runs ?? 0) + 1;
  const changed = previous === undefined || shapeChanged(previous.shape, shape);
  const samples: RecordSample[] = changed ? [] : (previous?.samples ?? []).map((s) => sampleOf(s, s.run));
  samples.push(sampleOf(sample, runs));
  if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
  const choiceChanged = previous !== undefined && !sameChoice(previous.chosen, chosen);
  const adopted =
    chosen.source === 'learned' &&
    (changed || previous === undefined || previous.chosen.source !== 'learned' || choiceChanged);
  return {
    format: recordFormat,
    shape,
    runs,
    lastExplore: sample.role === 'explore' ? runs : (previous?.lastExplore ?? 0),
    lastControl: sample.role === 'control' || adopted ? runs : (previous?.lastControl ?? 0),
    chosen: changed || choiceChanged ? choiceOf(chosen, runs) : previous!.chosen,
    samples,
  };
}

/** Whether two choices choose the same configuration, whatever run chose each. */
function sameChoice(previous: RecordChoice, chosen: RecordChoice): boolean {
  return (
    previous.checkers === chosen.checkers &&
    previous.share === chosen.share &&
    previous.parseThreads === chosen.parseThreads &&
    previous.source === chosen.source
  );
}

/** `sample` as a record keeps it, with the run number the record gives it. */
function sampleOf(sample: Omit<RecordSample, 'run'>, run: number): RecordSample {
  return {
    run,
    at: sample.at,
    role: sample.role,
    checkers: sample.checkers,
    share: sample.share,
    parseThreads: sample.parseThreads,
    parseMs: sample.parseMs,
    checkMs: sample.checkMs,
    totalMs: sample.totalMs,
    cpuMs: sample.cpuMs,
    peakMB: sample.peakMB,
    load: sample.load,
    dup: sample.dup,
  };
}

/** `choice` as a record keeps it, with the run that chose it. */
function choiceOf(choice: RecordChoice, since: number): RecordChoice {
  return {
    checkers: choice.checkers,
    share: choice.share,
    parseThreads: choice.parseThreads,
    source: choice.source,
    since,
  };
}

/**
 * Whether `next` differs from `shape` enough that `shape`'s samples describe another program: files,
 * declaration characters or check characters by more than 15%, or the redundancy by more than 0.1.
 */
export function shapeChanged(shape: RecordShape, next: RecordShape): boolean {
  return (
    beyond(shape.files, next.files) ||
    beyond(shape.declarationChars, next.declarationChars) ||
    beyond(shape.checkChars, next.checkChars) ||
    Math.abs(shape.redundancy - next.redundancy) > 0.1
  );
}

/** Whether `next` differs from `previous` by more than 15% of `previous` (and from 0 by any amount). */
function beyond(previous: number, next: number): boolean {
  if (previous === 0) return next !== 0;
  return Math.abs(next - previous) > previous * 0.15;
}

/** What a run's record write did, for the section's `Records:` line. */
export interface RecordWrite {
  /** The record's path, where it was written. */
  readonly path?: string;
  /** Why the record could not be written. */
  readonly reason?: string;
}

/**
 * Writes `sample` to the record of `key` in `directory`: the record is read (a missing or malformed one is
 * replaced), the sample appended (`nextRecord`), the file written under a temporary name and renamed, and
 * the directory capped. Failures are reported, not thrown.
 */
export function writeRecord(
  directory: string,
  key: string,
  sample: Omit<RecordSample, 'run'>,
  shape: RecordShape,
  chosen: RecordChoice,
): RecordWrite {
  const file = recordFile(directory, key);
  try {
    mkdirSync(joinPath(directory, 'runs-v1'), { recursive: true });
  } catch (e) {
    return { reason: messageOf(e) };
  }
  const record = nextRecord(readRecord(file, sample.at), sample, shape, chosen);
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(record) + '\n');
    renameSync(temporary, file);
  } catch (e) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to remove.
    }
    return { reason: messageOf(e) };
  }
  capDirectory(joinPath(directory, 'runs-v1'));
  return { path: file };
}

/** An error's message for the section: its first line, without the stack. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n')[0] ?? '';
  return line === '' ? 'write failed' : line;
}

/**
 * Keeps the cache directory under `maxRecordFiles` records: past the cap, the oldest tenth by mtime is
 * removed. Best effort, like the writes.
 */
function capDirectory(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  if (names.length <= maxRecordFiles) return;
  const entries: { name: string; mtime: number }[] = [];
  for (const name of names) {
    try {
      entries.push({ name, mtime: statSync(joinPath(directory, name)).mtimeMs });
    } catch {
      // Gone already.
    }
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  const remove = Math.ceil(entries.length / 10);
  for (let i = 0; i < remove; i++) {
    try {
      unlinkSync(joinPath(directory, entries[i]!.name));
    } catch {
      // Someone else removed it.
    }
  }
}

/** `path` as the section prints it: the home directory as `~`. */
export function displayPath(path: string, home: string = homedir()): string {
  if (home !== '' && path.startsWith(home + '/')) return '~' + path.slice(home.length);
  return path;
}
