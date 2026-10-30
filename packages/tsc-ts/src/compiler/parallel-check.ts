/**
 * Checking on several threads (`--checkers N`).
 *
 * In scriptc builds the main thread starts N checker threads and only collects their results
 * (`mainThreadChecks`); under Node.js it is checker 0 and starts N-1. Every checker creates its own
 * checker over the program and takes files until none are left (`planSchedule`): the costliest files first,
 * and groups of files that share costly declarations as a whole (`checkGroups`), then a range of
 * neighboring files of its own, then the end of other checkers' ranges where that makes them finish
 * earlier (`takePosition`). Checkers beyond tsgo's four stop when the process's memory nears its
 * limit, and checkers 1-3 when it is about to run out; the others take over their files
 * (`retires`). The threads send back the semantic
 * diagnostics of their files (and under `noEmit` with declarations, their declaration diagnostics)
 * and their global diagnostics, and the main thread reports them like a single checker would. Which
 * checker checks a file does not change its diagnostics. When the program emits, each checker also
 * emits the files it checks, right after checking each one, as tsgo emits on its checkers, and sends
 * back what it wrote (`checkersEmit`).
 *
 * In scriptc builds, threads share one program: the main thread computes the program's lazy caches,
 * publishes it with `@scriptc/threads` (the program becomes immutable and immortal, and threads
 * receive it by reference), and keeps the JSDoc that checking parses lazily in tables of each thread.
 * Checker threads publish their diagnostics back. Under Node.js, which copies what it posts, every
 * checker thread builds its own copy of the program from the command line instead, and the main
 * thread revives the diagnostics it receives against its own files.
 */
import { mark, markAt, timeline } from './timeline.js';
import type { Worker } from 'node:worker_threads';
import { publish, sharesPublishedGraphs } from '@scriptc/threads';
import { lastNodeIdValue } from './ast.js';
import {
  declarationDiagnosticsOfFile,
  EmitIndexes,
  HoldingWriter,
  type OutputWriter,
  ProgramEmitter,
} from './compile-program.js';
import {
  Diagnostic,
  DiagnosticFile,
  type DiagnosticFormatOptions,
  formatDiagnostic,
  formattedReports,
  RepopulateInfo,
} from './diagnostics.js';
import { EmitOnly, EmitResult } from './emitter.js';
import { getEmitDeclarations, isIncremental } from './options.js';
import { DeclarationSignatureWriter } from './incremental.js';
import { useLazyJSDocTable } from './parser.js';
import type { CheckedProgram } from './program-checker.js';
import type { Program } from './program.js';
import type { SourceFile } from './ast.js';
import { lastSymbolIdValue } from './symbol.js';
import { shareMergedGlobals } from './checker-symbols.js';
import { readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import {
  forbiddenWords,
  isForbidden,
  maxSharingCheckers,
  numberLogSize,
  recordTableSize,
  resultTableSize,
  shareThreads,
  stringLogSize,
  type ThreadSharingData,
} from './shared-results.js';

/** With TSC_TS_CHECKERS_TRACE: the process's resident and peak resident set in MB (Linux), else 0. */
export function residentMB(): number[] {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const rss = /VmRSS:\s+(\d+)/.exec(status);
    const hwm = /VmHWM:\s+(\d+)/.exec(status);
    return [rss === null ? 0 : Math.round(Number(rss[1]) / 1024), hwm === null ? 0 : Math.round(Number(hwm[1]) / 1024)];
  } catch {
    return [0, 0];
  }
}

/**
 * Starts checker thread `index` (main.ts owns the worker entry point). `program` is the shared,
 * published program in scriptc builds and `undefined` under Node.js; ids continue above `nodeIds` and
 * `symbolIds`. `reserved` are the positions of a group the thread's predecessor on `index` left
 * (`CheckerResult.reserved`). With `emits` false the thread doesn't emit the files it checks, where
 * the main thread emits the program (`checkersEmit`). `emitKinds`, by file index, is what the emit of
 * each file includes (an `EmitOnly`, or -1 for none) where not every output of every file is emitted
 * (an incremental program's rebuild); `undefined` for all of them. `units` are the statement ranges of
 * declaration files the order has positions for (`CheckPlan.units`). `globalsInFileDiagnostics` is the main
 * thread's `CheckedProgram.globalsInFileDiagnostics`.
 */
export type CheckerSpawn = (
  program: Program | undefined,
  index: number,
  counter: SharedArrayBuffer,
  order: number[],
  nodeIds: number,
  symbolIds: number,
  reserved: number[],
  emits: boolean,
  emitKinds: number[] | undefined,
  checking: boolean,
  units: number[],
  globalsInFileDiagnostics: boolean,
  sharing: ThreadSharingData | undefined,
) => Worker;

export class ParallelCheck {
  /** Set where checker threads can be started. */
  spawn: CheckerSpawn | undefined = undefined;
  /** Where checkers write the files they emit (`checkersEmit`); set where they can write files. */
  writer: OutputWriter | undefined = undefined;
}

export const parallelCheck = new ParallelCheck();

/**
 * What a checker thread sends back: the files it checked (indices) with their semantic diagnostics,
 * their declaration diagnostics when the program reports them without emitting, and the results of
 * emitting them when it emits them (`checkersEmit`).
 */
export class CheckerResult {
  constructor(
    readonly index: number,
    readonly files: number[],
    readonly diagnostics: Diagnostic[][],
    readonly declarations: Diagnostic[][],
    readonly globals: Diagnostic[],
    readonly checkTime: number,
    /**
     * With TSC_TS_CHECKERS_TRACE: wall clock (ms since the epoch) when the thread started, when its
     * checker was ready and when it finished; types and instantiations it created; thread CPU ms
     * (user, system); process RSS MB when it finished.
     */
    readonly stats: number[],
    /** Whether the thread stopped at its file limit (`recycleFiles`) with files possibly left. */
    readonly more: boolean = false,
    /** The positions of a group the thread took and had not checked when it stopped at its file limit. */
    readonly reserved: number[] = [],
    readonly emits: EmitResult[] = [],
    /** The statement ranges of declaration files it checked (`rangeUnits`). */
    readonly units: number[] = [],
    /** Those of `units` after which its checker had diagnostics in their file (`checkSourceFileRange`). */
    readonly reportingUnits: number[] = [],
  ) {}
}

/**
 * Whether checker threads send their results as plain data (`PackedResult`), which the message
 * copies, instead of publishing them (TSC_TS_REGION, default on in scriptc builds). Then nothing a
 * checker thread allocated is reachable from another thread, and the scriptc runtime discards the
 * thread's whole heap when it ends: a finished or retired checker returns its memory.
 */
export const packsResults: boolean = sharesPublishedGraphs && process.env.TSC_TS_REGION !== '0';

/**
 * The number of files after which a checker thread ends and a new one takes over its schedule
 * index (TSC_TS_RECYCLE=n; 0, the default, for none). A new checker starts empty, so with packed
 * results the old one's types, links and caches go back to the system.
 */
export const recycleFiles: number = Math.max(0, Number(process.env.TSC_TS_RECYCLE ?? '0') | 0);

/**
 * A `CheckerResult` as plain data. `nums` holds, in order, the diagnostic lists of `files`, the
 * declaration diagnostic lists, the global diagnostics and the emit results, each list as a count
 * followed by that many items. A diagnostic is file name (an index into `strs`, -1 for none), file
 * text (index, -1 when the program has the file), pos, end, code, category, message,
 * skippedOnNoEmit, the argument count and indices, its repopulate kind (0 for none) followed by the
 * module reference (index), mode and package name (index) of other kinds, then its message chain and
 * related information as lists. A diagnostic of a reported list (the files' diagnostic and declaration
 * diagnostic lists, the global diagnostics and an emit result's diagnostics) is followed by its text in
 * the main thread's report format (`Diagnostic.formatted`, an index, -1 for none). An emit result is
 * emitSkipped, the emitted files, errors and unsupported files as lists of indices, then its
 * diagnostics and its declaration signatures as a list of indices. `files` and `nums` are typed
 * arrays, which postMessage copies as one block of memory each; it copies an array of numbers element
 * by element.
 */
export type PackedResult = {
  readonly index: number;
  readonly files: Int32Array;
  readonly nums: Int32Array;
  readonly strs: string[];
  readonly checkTime: number;
  readonly stats: number[];
  readonly more: boolean;
  readonly reserved: number[];
  readonly units: Int32Array;
  readonly reportingUnits: Int32Array;
};

class ResultPacker {
  readonly nums: number[] = [];
  readonly strs: string[] = [];
  private readonly indices = new Map<string, number>();

  constructor(
    private readonly program: Program,
    /** The main thread's report format, which this thread formats the reported diagnostics in. */
    private readonly format: DiagnosticFormatOptions | undefined,
  ) {}

  private str(text: string): number {
    let k = this.indices.get(text);
    if (k === undefined) {
      k = this.strs.length;
      this.strs.push(text);
      this.indices.set(text, k);
    }
    return k;
  }

  list(diagnostics: readonly Diagnostic[]): void {
    this.nums.push(diagnostics.length);
    for (const d of diagnostics) this.diagnostic(d);
  }

  /** A list the main thread reports: each diagnostic with its text in the report format. */
  reported(diagnostics: readonly Diagnostic[]): void {
    const nums = this.nums;
    const format = this.format;
    nums.push(diagnostics.length);
    for (const d of diagnostics) {
      this.diagnostic(d);
      if (format === undefined) nums.push(-1);
      else {
        nums.push(this.strs.length);
        this.strs.push(formatDiagnostic(d, format));
      }
    }
  }

  private strList(texts: readonly string[]): void {
    this.nums.push(texts.length);
    for (const text of texts) this.nums.push(this.str(text));
  }

  emit(result: EmitResult): void {
    this.nums.push((result.emitSkipped ? 1 : 0) | (result.declarationTransformed ? 2 : 0));
    this.strList(result.emittedFiles);
    this.strList(result.errors);
    this.strList(result.unsupported);
    this.reported(result.diagnostics);
    this.strList(result.declarationSignatures);
    this.strList(result.heldOutputs);
  }

  private diagnostic(d: Diagnostic): void {
    const nums = this.nums;
    const file = d.file;
    if (file === undefined) nums.push(-1, -1);
    else
      nums.push(
        this.str(file.fileName),
        this.program.getSourceFile(file.fileName) === undefined ? this.str(file.text) : -1,
      );
    nums.push(d.pos, d.end, d.code, d.category, d.message, d.skippedOnNoEmit ? 1 : 0, d.args.length);
    for (const arg of d.args) nums.push(this.str(arg));
    const repopulate = d.repopulateInfo;
    if (repopulate === undefined) nums.push(0);
    else
      nums.push(
        repopulate.kind,
        this.str(repopulate.moduleReference),
        repopulate.mode,
        this.str(repopulate.packageName),
      );
    this.list(d.messageChain);
    this.list(d.relatedInformation);
  }
}

/** Packs `result` (on the checker thread) for `postMessage`. */
export function packResult(result: CheckerResult, program: Program): PackedResult {
  const packer = new ResultPacker(program, formattedReports.format);
  for (const list of result.diagnostics) packer.reported(list);
  packer.nums.push(result.declarations.length);
  for (const list of result.declarations) packer.reported(list);
  packer.reported(result.globals);
  packer.nums.push(result.emits.length);
  for (const emit of result.emits) packer.emit(emit);
  return {
    index: result.index,
    files: Int32Array.from(result.files),
    nums: Int32Array.from(packer.nums),
    strs: packer.strs,
    checkTime: result.checkTime,
    stats: result.stats,
    more: result.more,
    reserved: result.reserved,
    units: Int32Array.from(result.units),
    reportingUnits: Int32Array.from(result.reportingUnits),
  };
}

/** Rebuilds a packed result on the main thread against `program`'s files. */
class ResultUnpacker {
  private at = 0;

  constructor(
    private readonly packed: PackedResult,
    private readonly program: Program,
    private readonly files: Map<string, DiagnosticFile>,
  ) {}

  private next(): number {
    return this.packed.nums[this.at++]!;
  }

  count(): number {
    return this.next();
  }

  list(): Diagnostic[] {
    const n = this.next();
    const result: Diagnostic[] = [];
    for (let k = 0; k < n; k++) result.push(this.diagnostic());
    return result;
  }

  /** A list `ResultPacker.reported` packed. */
  reported(): Diagnostic[] {
    const n = this.next();
    const result: Diagnostic[] = [];
    for (let k = 0; k < n; k++) {
      const d = this.diagnostic();
      const text = this.next();
      if (text >= 0) d.formatted = this.packed.strs[text]!;
      result.push(d);
    }
    return result;
  }

  private diagnostic(): Diagnostic {
    const strs = this.packed.strs;
    const name = this.next();
    const text = this.next();
    let file: DiagnosticFile | undefined = undefined;
    if (name >= 0) {
      const fileName = strs[name]!;
      file = this.files.get(fileName);
      if (file === undefined) {
        file =
          text >= 0
            ? new DiagnosticFile(fileName, strs[text]!)
            : this.program.getSourceFile(fileName)!.diagnosticFile();
        this.files.set(fileName, file);
      }
    }
    const pos = this.next();
    const end = this.next();
    const code = this.next();
    const category = this.next();
    const message = this.next();
    const skipped = this.next() === 1;
    const argc = this.next();
    const args: string[] = [];
    for (let k = 0; k < argc; k++) args.push(strs[this.next()]!);
    const result = new Diagnostic(file, pos, end, message, args);
    result.code = code;
    result.category = category;
    result.skippedOnNoEmit = skipped;
    const kind = this.next();
    if (kind !== 0) {
      const moduleReference = strs[this.next()]!;
      const mode = this.next();
      result.repopulateInfo = new RepopulateInfo(kind, moduleReference, mode, strs[this.next()]!);
    }
    result.messageChain = this.list();
    result.relatedInformation = this.list();
    return result;
  }

  private strList(into: string[]): void {
    const n = this.next();
    for (let k = 0; k < n; k++) into.push(this.packed.strs[this.next()]!);
  }

  emit(): EmitResult {
    const result = new EmitResult();
    const flags = this.next();
    result.emitSkipped = (flags & 1) !== 0;
    result.declarationTransformed = (flags & 2) !== 0;
    this.strList(result.emittedFiles);
    this.strList(result.errors);
    this.strList(result.unsupported);
    for (const d of this.reported()) result.diagnostics.push(d);
    this.strList(result.declarationSignatures);
    this.strList(result.heldOutputs);
    return result;
  }
}

export function unpackResult(
  packed: PackedResult,
  program: Program,
  files: Map<string, DiagnosticFile>,
): CheckerResult {
  const unpacker = new ResultUnpacker(packed, program, files);
  const diagnostics: Diagnostic[][] = [];
  for (let k = 0; k < packed.files.length; k++) diagnostics.push(unpacker.reported());
  const declarations: Diagnostic[][] = [];
  const nd = unpacker.count();
  for (let k = 0; k < nd; k++) declarations.push(unpacker.reported());
  const globals = unpacker.reported();
  const emits: EmitResult[] = [];
  const ne = unpacker.count();
  for (let k = 0; k < ne; k++) emits.push(unpacker.emit());
  return new CheckerResult(
    packed.index,
    Array.from(packed.files),
    diagnostics,
    declarations,
    globals,
    packed.checkTime,
    packed.stats,
    packed.more,
    packed.reserved,
    emits,
    Array.from(packed.units),
    Array.from(packed.reportingUnits),
  );
}

/**
 * Whether checkers also compute declaration diagnostics: under `noEmit` with declarations, reporting
 * collects them for every file (getDiagnosticsOfProgram), and tsgo computes them per file on its
 * checkers too. Otherwise they come from emitting.
 */
function checkersReportDeclarations(checked: CheckedProgram): boolean {
  const options = checked.program.options;
  return options.noEmit === true && getEmitDeclarations(options);
}

/**
 * Records in the shared schedule that a checked file has diagnostics, which under `noEmitOnError`
 * keeps the program from emitting: checkers stop emitting the files they check.
 */
function blockEmit(schedule: Int32Array): void {
  Atomics.store(schedule, schedule.length - 1, 1);
}

function blocksEmit(schedule: Int32Array): boolean {
  return Atomics.load(schedule, schedule.length - 1) !== 0;
}

/**
 * Whether checkers emit the files they check, each right after checking it (where they can write
 * files): unless the program doesn't emit. The checker that checked a file has its types at hand, and
 * its declarations print as on the checker tsgo emits the file with. Under `noEmitOnError`, which
 * makes emit wait for every file's diagnostics, they hold the outputs (`EmitResult.heldOutputs`) for
 * the main thread, which writes them if there are no errors. The main thread emits the files no
 * checker emitted. With `emits` false checkers don't emit.
 */
function checkersEmit(checked: CheckedProgram, emits: boolean): boolean {
  const options = checked.program.options;
  return emits && parallelCheck.writer !== undefined && options.noEmit !== true && options.listFilesOnly !== true;
}

/**
 * How the number of checkers is chosen without `--checkers`: `auto` (the default) uses every CPU
 * this process may run on (`os.availableParallelism()`, at most `maxAutoCheckers`), and at least
 * tsgo's four; fewer than the CPUs, but never fewer than four, when the estimated peak memory of more
 * checkers would not fit (`memoryCheckers`). `fixed` (TSC_TS_CHECKERS=fixed) uses tsgo's four.
 */
export const checkerPolicy: 'fixed' | 'auto' = process.env.TSC_TS_CHECKERS === 'fixed' ? 'fixed' : 'auto';

/** tsgo's number of checkers, and the fewest `auto` starts. */
const tsgoCheckers = 4;

/** The most checkers `auto` starts (measured up to 16 CPUs). */
const maxAutoCheckers = 16;

/**
 * The number of checker threads for `checkers` (`--checkers`), or 1 to check on this thread. Without
 * the option, native builds follow `checkerPolicy` (with `program`, the memory estimate of `auto`
 * applies); under Node.js, where every thread builds its own copy of the program, tsc-ts checks on
 * one thread.
 */
export function checkerThreads(
  checkers: number | undefined,
  singleThreaded: boolean | undefined,
  program?: Program,
): number {
  if (parallelCheck.spawn === undefined || singleThreaded === true) return 1;
  const count = checkers ?? defaultCheckers(program);
  return count > 1 ? Math.min(Math.floor(count), 256) : 1;
}

function defaultCheckers(program: Program | undefined): number {
  if (!sharesPublishedGraphs) return 1;
  if (program !== undefined && checksLittle(program)) return 1;
  if (checkerPolicy === 'fixed') return tsgoCheckers;
  const cpus = Math.min(availableParallelism(), maxAutoCheckers);
  return autoCheckers(cpus, program === undefined ? Number.MAX_SAFE_INTEGER : memoryCheckers(program));
}

/**
 * The most text of the files to check, in characters, of a program checked on this thread without
 * `--checkers`: starting checker threads and sharing the program with them takes about 10 ms on 16
 * CPUs, more than checking that much.
 */
const littleText = 20_000;

/**
 * Whether `program` has less than `littleText` characters to check, not counting the declaration
 * files `skipLibCheck` skips.
 */
function checksLittle(program: Program): boolean {
  const options = program.options;
  let text = 0;
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile && options.skipLibCheck === true) continue;
    text += file.end;
    if (text >= littleText) return false;
  }
  return true;
}

/** `auto` with `cpus` CPUs when the memory estimate fits `fit` checkers: tsgo's four at least. */
export function autoCheckers(cpus: number, fit: number): number {
  return Math.max(tsgoCheckers, Math.min(cpus, fit));
}

/**
 * The number of threads that parse ahead of a program checked by `checkers` checkers: every CPU this
 * process may run on, as tsgo parses on every core whatever its checker count (parse threads hand
 * their files to the shared program; what else they allocate is reused by the checker threads), but
 * one. The main thread hands out the chunks they load: with a thread on every CPU, it waits for a CPU
 * each time a thread returns a chunk, and so does that thread for its next chunk (VS Code's parse took
 * 18-57 ms longer with 16 threads on 16 CPUs than with 15).
 */
export function parseThreads(checkers: number): number {
  const cpus = availableParallelism();
  return Math.max(1, Math.min(cpus - 1, Math.max(checkers, Math.min(cpus, maxAutoCheckers))));
}

/**
 * The program's memory per character of source text, where it can't be measured (`residentBytes`):
 * 23-28 bytes on the benchmark apps when checking starts (parse threads' arenas included).
 */
const programBytesPerChar = 32;

/**
 * What the first checker adds, as a share of the program's memory: measured 0.24 (tRPC), 0.7-0.9
 * (TypeORM, Playwright, Excalidraw), 1.0 (VS Code) and 1.4 (Sentry). The first checker needs this
 * whatever the count, so the estimate mostly decides how many further checkers fit; programs above
 * it stay within memory by retiring checkers (`retires`).
 */
const firstCheckerShare = 1;

/**
 * What each further checker adds, per character of declaration files, for a typical program:
 * measured 6 bytes for VS Code, 9 for Excalidraw, 15 for Sentry and up to 31 for T3 Code's
 * Effect-based projects (every checker resolves the declarations its files use; under 2 for tRPC).
 */
const checkerBytesPerDeclarationChar = 24;

/** The share of the memory limit that checking may use (`checkersFittingMemory`, `retires`). */
const memoryShare = 0.85;

/**
 * The share of the memory limit at which even checkers 1-3 retire, to finish on fewer threads rather
 * than run out of memory (`retires`).
 */
const lastResortShare = 0.95;

/**
 * The most checkers whose estimated peak memory fits `memoryShare` of the memory limit, of `memory`
 * bytes, for a program of `programBytes` (`firstCheckerShare`, `checkerBytesPerDeclarationChar`);
 * at least 1.
 */
export function checkersFittingMemory(programBytes: number, declarationChars: number, memory: number): number {
  const peak = programBytes * (1 + firstCheckerShare);
  const perChecker = Math.max(1, declarationChars * checkerBytesPerDeclarationChar);
  return Math.max(1, 1 + Math.floor((memoryShare * memory - peak) / perChecker));
}

/**
 * The memory this process may use, in bytes: the smallest of the total, its constrained memory, and
 * the limits of its cgroup (`cgroupMemoryLimit`).
 */
export function memoryLimit(): number {
  let limit = totalmem();
  const constrained = process.constrainedMemory();
  if (constrained > 0 && constrained < limit) limit = constrained;
  const cgroup = cgroupMemoryLimit();
  if (cgroup > 0 && cgroup < limit) limit = cgroup;
  return limit;
}

/**
 * The smallest memory limit of this process's cgroup and its ancestors (Linux), or 0 where there is
 * none or it is unknown: `memory.max` and `memory.high` under cgroup v2, `memory.limit_in_bytes`
 * under v1. `process.constrainedMemory()` does not always see these: libuv reads only the process's
 * own cgroup, and scriptc's runtime only the root of the cgroup mount, which is the process's own
 * cgroup only inside a cgroup namespace.
 */
export function cgroupMemoryLimit(): number {
  let membership: string;
  try {
    membership = readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return 0;
  }
  let limit = 0;
  const lower = (value: number): void => {
    if (value > 0 && (limit === 0 || value < limit)) limit = value;
  };
  for (const line of membership.split('\n')) {
    // "0::/path" (v2), "N:memory:/path" or "N:cpu,memory:/path" (v1).
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first < 0 || second < 0) continue;
    const controllers = line.substring(first + 1, second);
    const path = line.substring(second + 1);
    if (controllers === '') {
      for (let dir = path; ; dir = dir.substring(0, dir.lastIndexOf('/'))) {
        const base = '/sys/fs/cgroup' + (dir === '/' ? '' : dir);
        lower(cgroupLimitValue(base + '/memory.max'));
        lower(cgroupLimitValue(base + '/memory.high'));
        if (dir === '/' || dir === '' || dir.lastIndexOf('/') < 0) break;
      }
    } else if (controllers.split(',').indexOf('memory') >= 0) {
      lower(cgroupLimitValue('/sys/fs/cgroup/memory' + (path === '/' ? '' : path) + '/memory.limit_in_bytes'));
    }
  }
  return limit;
}

/** A cgroup memory limit file's value in bytes, or 0 for `max`, an unreadable file or no number. */
function cgroupLimitValue(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return 0;
  }
  if (text === '' || text === 'max') return 0;
  const value = Number(text);
  // cgroup v1 reports no limit as a page-aligned value near 2^63.
  return Number.isFinite(value) && value > 0 && value < 2 ** 62 ? value : 0;
}

/** The program whose text lengths `textLengths` holds. */
let lengthsProgram: Program | undefined = undefined;
let lengthsOfProgram: number[] = [];

/**
 * The text length of each of `program`'s files, by index, computed once per program: a file's `end`,
 * the length the parser found. In scriptc builds a thread caches the UTF-16 length of only the few
 * non-ASCII strings it read last, so reading a non-ASCII file's `text.length` scans its text.
 */
export function textLengths(program: Program): number[] {
  if (lengthsProgram !== program) {
    const lengths: number[] = [];
    for (const file of program.getSourceFiles()) lengths.push(file.end);
    lengthsProgram = program;
    lengthsOfProgram = lengths;
  }
  return lengthsOfProgram;
}

/**
 * The most checkers whose estimated peak memory fits (`checkersFittingMemory`), for `program`: its
 * memory is this process's resident memory now (it is parsed and bound, and nothing is checked yet),
 * or an estimate from its text where that is unknown.
 */
export function memoryCheckers(program: Program): number {
  let chars = 0;
  let declarationChars = 0;
  const files = program.getSourceFiles();
  const length = textLengths(program);
  for (let i = 0; i < files.length; i++) {
    chars += length[i]!;
    if (files[i]!.isDeclarationFile) declarationChars += length[i]!;
  }
  const resident = residentBytes();
  const programBytes = resident > 0 ? resident : chars * programBytesPerChar;
  const memory = memoryLimit();
  const fit = checkersFittingMemory(programBytes, declarationChars, memory);
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined)
    process.stderr.write(
      `checkers: ${chars} source chars (${declarationChars} in declaration files), program ${Math.round(programBytes / 1048576)}MB${resident > 0 ? '' : ' (estimated)'}, memory ${Math.round(memory / 1048576)}MB fits ${fit} checkers\n`,
    );
  return fit;
}

/**
 * The files to check, costliest first, ties in program order. A file's estimated cost is its text
 * length plus a share of the declaration files it makes its checker resolve: for each unchecked
 * declaration file it imports, the text length of everything that file reaches through imports,
 * divided by the number of checked files importing it (each checker resolves a library once, so a
 * library many files import costs little per file, while one only a single small file imports, like
 * a server framework's types under an adapter, makes that file one of the most expensive).
 */
export function checkOrder(checked: CheckedProgram): number[] {
  return costOrder(checked).order;
}

/** The estimated costs of checking a program's files (`checkOrder`). */
class CheckCosts {
  constructor(
    /** The files to check (indices into the program files), costliest first. */
    readonly order: number[],
    /** The estimated cost of each file, by index. */
    readonly cost: number[],
    /** The libraries (indices) each file of `order` imports, by index. */
    readonly libraries: number[][],
    /** What resolving a library costs a checker the first time (`libraryFirstUseShare` of the text it reaches), by index. */
    readonly libraryCost: number[],
    /** The program files (indices) each file imports (`ProcessedFiles.addedFiles`), by index. */
    readonly imports: readonly (readonly number[])[],
  ) {}
}

function costOrder(checked: CheckedProgram): CheckCosts {
  const files = checked.program.getSourceFiles();
  const only = checked.checkOnly;
  const order: number[] = [];
  for (let i = 0; i < files.length; i++)
    if (!checked.skipTypeChecking(files[i]!) && (only === undefined || only.has(files[i]!))) order.push(i);
  const costs = checkCosts(checked, order);
  const cost = costs.cost;
  order.sort((a, b) => cost[b]! - cost[a]! || a - b);
  return costs;
}

/** How much of a library's text counts as checking cost of the files importing it. */
const libraryCostShare = 0.25;

/**
 * How much of a library's text counts as the cost of a checker resolving it for the first time, in
 * the steals of `takeCheapestEnd`: all of it. A checker pays that once for all the files importing
 * the library, so the estimate of each file counts only a share (`libraryCostShare`); but a thief
 * that takes files whose libraries it has not resolved pays for them all at once. Counted at a
 * quarter, the end of a range was often taken in pieces by checkers that each paid for the
 * library again: Playwright's 41 MCP tool files (zod, its MCP SDK and Playwright's own types)
 * went to up to seven checkers, each paying 100-260 ms before its first tool file checked, often
 * at the very end.
 */
const libraryFirstUseShare = 1;

/** The estimated cost of checking each file of `order` (indices into the program files). */
function checkCosts(checked: CheckedProgram, order: number[]): CheckCosts {
  const program = checked.program;
  const files = program.getSourceFiles();
  const cost: number[] = [];
  const librariesOf: number[][] = [];
  const libraryCost: number[] = [];
  for (let i = 0; i < files.length; i++) {
    cost.push(0);
    librariesOf.push([]);
    libraryCost.push(0);
  }
  const length = textLengths(program);
  for (const i of order) cost[i] = length[i]!;
  const checkedFile: boolean[] = [];
  for (let i = 0; i < files.length; i++) checkedFile.push(false);
  for (const i of order) checkedFile[i] = true;
  // Libraries: unchecked modules that are not default libraries (globals every checker has).
  const isLibrary = (i: number): boolean =>
    !checkedFile[i]! && !program.isSourceFileDefaultLibrary(files[i]!.path) && isExternalModuleFile(files[i]!);
  // The files each file imports: those it added to the program (`ProcessedFiles.addedFiles`).
  const edges = program.addedFiles();
  const importers = new Map<number, number>();
  for (const i of order) {
    const libraries: number[] = [];
    for (const k of edges[i]!) if (isLibrary(k) && libraries.indexOf(k) < 0) libraries.push(k);
    librariesOf[i] = libraries;
    for (const k of libraries) importers.set(k, (importers.get(k) ?? 0) + 1);
  }
  // The text length of the libraries each library reaches (itself included).
  const reach = new Map<number, number>();
  const reachOf = (root: number): number => {
    let total = reach.get(root);
    if (total !== undefined) return total;
    total = 0;
    const seen = new Set<number>([root]);
    const stack = [root];
    while (stack.length > 0) {
      const k = stack.pop()!;
      total += length[k]!;
      for (const t of edges[k]!)
        if (!seen.has(t) && isLibrary(t)) {
          seen.add(t);
          stack.push(t);
        }
    }
    reach.set(root, total);
    return total;
  };
  for (let n = 0; n < order.length; n++) {
    const i = order[n]!;
    let share = 0;
    for (const k of librariesOf[i]!) {
      libraryCost[k] = libraryFirstUseShare * reachOf(k);
      share += reachOf(k) / importers.get(k)!;
    }
    cost[i] = cost[i]! + libraryCostShare * share;
  }
  return new CheckCosts(order, cost, librariesOf, libraryCost, edges);
}

function isExternalModuleFile(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined;
}

/**
 * The shared schedule (an Int32Array over a SharedArrayBuffer). Header: [0] the cursor of the
 * shared queue, [1] a lock, [2] the number of leading positions of the order that every checker
 * takes from the shared queue first, or -1 when the whole order is one shared queue, [3] the number
 * of checkers, [4] the number of positions with costs (0 for none), [5] the number of libraries, [6]
 * the words of a set of libraries, [7] the number of library references. Then, for each checker, the
 * start and end of its range of positions; with costs, for each position the text length of its file
 * and the start of its libraries in the library references (one more start at the end), the library
 * references, for each library what resolving it costs, and for each checker the set of libraries it
 * has resolved (one bit per library), and for each position the number of files of the group starting
 * there (0 or 1 for a file of its own). Between the ranges and the costs, the time of the latest
 * retirement (`Date.now()` modulo 2^31, 0 for none) and for each checker whether it retired
 * (`retires`). The last word is 1 once a checked file has diagnostics (`blocksEmit`).
 *
 * The leading positions are the shared queue: the costliest files, and groups of files that a
 * checker takes as a whole (`checkGroups`), which no other checker takes from it.
 *
 * With ranges, each checker checks a contiguous run of the program's files (files next to each
 * other in program order tend to use the same declarations, so its checker resolves fewer of them),
 * and a checker whose range is empty takes the end of another checker's range: the part that brings
 * the later of the two checkers' estimated finishing times furthest forward, counting for itself the
 * libraries it has not resolved yet. It takes nothing when that would not finish earlier: the end of
 * a range is often a few files that are cheap only to the checker that resolved their libraries.
 * Without costs, it takes the back half of the largest remaining range.
 */
const scheduleHeader = 8;

export function newSchedule(count: number, positions = 0, libraries = 0, references = 0): SharedArrayBuffer {
  const words = (libraries + 31) >> 5;
  const plan = positions === 0 ? 0 : 3 * positions + 1 + references + libraries + count * words;
  const buffer = new SharedArrayBuffer(4 * (scheduleHeader + 3 * count + 1 + plan + 1));
  const schedule = new Int32Array(buffer);
  schedule[3] = count;
  if (positions > 0) {
    schedule[4] = positions;
    schedule[5] = libraries;
    schedule[6] = words;
    schedule[7] = references;
  }
  return buffer;
}

/** Where the parts of a schedule with costs start (`newSchedule`). */
class PlanLayout {
  readonly lengths: number;
  readonly starts: number;
  readonly references: number;
  readonly costs: number;
  readonly groups: number;
  readonly resolved: number;
  readonly words: number;

  constructor(schedule: Int32Array) {
    const positions = schedule[4]!;
    this.lengths = scheduleHeader + 3 * schedule[3]! + 1;
    this.starts = this.lengths + positions;
    this.references = this.starts + positions + 1;
    this.costs = this.references + schedule[7]!;
    this.groups = this.costs + schedule[5]!;
    this.resolved = this.groups + positions;
    this.words = schedule[6]!;
  }
}

/**
 * The costs of a schedule, copied out of the shared buffer once per checker: they do not change, and
 * in scriptc builds every access to a shared buffer takes a process-wide lock, which the checkers
 * waiting for the schedule's own lock also take.
 */
export class SchedulePlan {
  readonly layout: PlanLayout;
  /** The schedule from its first length up to the sets of resolved libraries. */
  private readonly data: Int32Array;

  constructor(schedule: Int32Array) {
    this.layout = new PlanLayout(schedule);
    this.data = schedule.slice(this.layout.lengths, this.layout.resolved);
  }

  length(position: number): number {
    return this.data[position]!;
  }

  /** The start of the libraries of `position` in the references (`referenceStart(position + 1)` is its end). */
  referenceStart(position: number): number {
    return this.data[this.layout.starts - this.layout.lengths + position]!;
  }

  reference(k: number): number {
    return this.data[this.layout.references - this.layout.lengths + k]!;
  }

  cost(library: number): number {
    return this.data[this.layout.costs - this.layout.lengths + library]!;
  }

  /** The number of files of the group starting at `position` (0 or 1 for a file of its own). */
  group(position: number): number {
    return this.data[this.layout.groups - this.layout.lengths + position]!;
  }

  /** A copy of the set of libraries `checker` has resolved. */
  resolvedBy(schedule: Int32Array, checker: number): number[] {
    const words: number[] = [];
    const at = this.layout.resolved + checker * this.layout.words;
    for (let w = 0; w < this.layout.words; w++) words.push(Atomics.load(schedule, at + w));
    return words;
  }
}

/** The costs of `schedule`, or `undefined` if it has none. */
export function schedulePlan(schedule: Int32Array): SchedulePlan | undefined {
  return Atomics.load(schedule, 4) > 0 ? new SchedulePlan(schedule) : undefined;
}

function isResolved(words: readonly number[], library: number): boolean {
  return (words[library >> 5]! & (1 << (library & 31))) !== 0;
}

/**
 * Fills the costs of a schedule from `newSchedule(count, lengths.length, libraryCosts.length, R)`:
 * the text length of the file at each position, the libraries (0 to `libraryCosts.length - 1`) it
 * imports, R in total, what resolving each library costs, and the number of files of the group
 * starting at each position (`groups`, by default none).
 */
export function fillScheduleCosts(
  schedule: Int32Array,
  lengths: readonly number[],
  libraries: readonly (readonly number[])[],
  libraryCosts: readonly number[],
  groups: readonly number[] = [],
): void {
  const layout = new PlanLayout(schedule);
  for (let p = 0; p < groups.length; p++) schedule[layout.groups + p] = groups[p]!;
  let reference = 0;
  for (let p = 0; p < lengths.length; p++) {
    schedule[layout.lengths + p] = lengths[p]!;
    schedule[layout.starts + p] = reference;
    for (const library of libraries[p]!) schedule[layout.references + reference++] = library;
  }
  schedule[layout.starts + lengths.length] = reference;
  for (let k = 0; k < libraryCosts.length; k++) schedule[layout.costs + k] = Math.round(libraryCosts[k]!);
}

/** Records that `checker` resolves the libraries of the file at `position`. */
function markResolved(schedule: Int32Array, plan: SchedulePlan | undefined, checker: number, position: number): void {
  if (plan === undefined) return;
  const set = plan.layout.resolved + checker * plan.layout.words;
  const end = plan.referenceStart(position + 1);
  for (let r = plan.referenceStart(position); r < end; r++) {
    const library = plan.reference(r);
    Atomics.or(schedule, set + (library >> 5), 1 << (library & 31));
  }
}

/**
 * The next position of the order for checker `index`, or -1 when every file is taken. `plan` is
 * `schedulePlan(schedule)`, which a checker reads once.
 */
export function takePosition(
  schedule: Int32Array,
  length: number,
  index: number,
  plan: SchedulePlan | undefined = schedulePlan(schedule),
): number {
  const reserved = reservedBy(index);
  if (reserved.length > 0) return reserved.shift()!;
  const heavy = Atomics.load(schedule, 2);
  if (heavy < 0) {
    const k = Atomics.add(schedule, 0, 1);
    return k < length ? k : -1;
  }
  for (;;) {
    // The shared queue: a group goes to one checker as a whole.
    const k = Atomics.load(schedule, 0);
    if (k >= heavy) break;
    const files = plan === undefined ? 1 : Math.max(1, plan.group(k));
    if (Atomics.compareExchange(schedule, 0, k, k + files) !== k) continue;
    for (let j = k; j < k + files; j++) {
      markResolved(schedule, plan, index, j);
      if (j > k) reserved.push(j);
    }
    return k;
  }
  while (Atomics.compareExchange(schedule, 1, 0, 1) !== 0) {
    // Another checker is taking a file; this takes nanoseconds, or microseconds to take a range.
  }
  const own = scheduleHeader + 2 * index;
  let lo = Atomics.load(schedule, own);
  let hi = Atomics.load(schedule, own + 1);
  if (lo >= hi) {
    const taken = plan !== undefined ? takeCheapestEnd(schedule, plan, index) : takeBackHalf(schedule);
    if (taken === undefined) {
      Atomics.store(schedule, 1, 0);
      return -1;
    }
    lo = taken[0]!;
    hi = taken[1]!;
  }
  Atomics.store(schedule, own, lo + 1);
  Atomics.store(schedule, own + 1, hi);
  markResolved(schedule, plan, index, lo);
  Atomics.store(schedule, 1, 0);
  return lo;
}

/** The rest of a group that checker `index` took from the shared queue, by checker index. */
const reservedPositions = new Map<number, number[]>();

function reservedBy(index: number): number[] {
  let reserved = reservedPositions.get(index);
  if (reserved === undefined) {
    reserved = [];
    reservedPositions.set(index, reserved);
  }
  return reserved;
}

/** Where the retirement state starts in `schedule` (`newSchedule`). */
function retirementAt(schedule: Int32Array): number {
  return scheduleHeader + 2 * Atomics.load(schedule, 3);
}

/** For checker `thief`, the whole remaining range of a checker that retired (its positions), or `undefined`. */
function takeRetired(schedule: Int32Array, thief: number): number[] | undefined {
  const count = Atomics.load(schedule, 3);
  const flags = retirementAt(schedule) + 1;
  for (let v = 0; v < count; v++) {
    if (v === thief || Atomics.load(schedule, flags + v) === 0) continue;
    const at = scheduleHeader + 2 * v;
    const lo = Atomics.load(schedule, at);
    const hi = Atomics.load(schedule, at + 1);
    if (lo >= hi) continue;
    Atomics.store(schedule, at + 1, lo);
    if (traceSteals)
      process.stderr.write(`checkers: steal ${thief} from retired ${v} [${lo},${hi}) at ${Date.now()}\n`);
    return [lo, hi];
  }
  return undefined;
}

/** How long after a retirement the next checker may retire: the first one's memory returns as its thread ends. */
const retirementSpacing = 1000;

/**
 * Whether checker `index` stops taking files: it is not checker 0 and holds no group, the process's
 * resident memory has reached `limit` bytes (`retirementMemory`), and no other checker retired in the
 * last `retirementSpacing` ms. Its thread then ends, which returns its memory (with ProgramLifetime
 * classes, only its other objects: it still stops adding to it), and idle checkers take the rest of
 * its range.
 */
export function retires(schedule: Int32Array, index: number, limit: number, resident = residentBytes()): boolean {
  if (index === 0 || reservedBy(index).length > 0 || resident < limit) return false;
  const at = retirementAt(schedule);
  const now = (Date.now() % 0x7fffffff) + 1;
  const last = Atomics.load(schedule, at);
  if (last !== 0 && (now - last + 0x7fffffff) % 0x7fffffff < retirementSpacing) return false;
  if (Atomics.compareExchange(schedule, at, last, now) !== last) return false;
  while (Atomics.compareExchange(schedule, 1, 0, 1) !== 0) {
    // Idle checkers read the flags under the schedule's lock.
  }
  Atomics.store(schedule, at + 1 + index, 1);
  Atomics.store(schedule, 1, 0);
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined)
    process.stderr.write(`checkers: thread ${index} retires at rss ${Math.round(resident / 1048576)}MB\n`);
  return true;
}

/** The process's resident memory in bytes (Linux), or 0 where it is unknown. */
function residentBytes(): number {
  try {
    // VmRSS is in kB, so this holds on kernels with any page size (statm counts pages).
    const rss = /VmRSS:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'));
    return rss === null ? 0 : Number(rss[1]) * 1024;
  } catch {
    return 0;
  }
}

/**
 * The resident memory, in bytes, at which checker `index` retires: `memoryShare` of the memory limit
 * beyond tsgo's four, `lastResortShare` for checkers 1-3; checker 0 never retires.
 */
export function retirementMemory(index: number, memory = memoryLimit()): number {
  if (index === 0) return 0;
  return (index >= tsgoCheckers ? memoryShare : lastResortShare) * memory;
}

/** Takes the back half of the largest remaining range: its positions, or `undefined` if none is left. */
function takeBackHalf(schedule: Int32Array): number[] | undefined {
  const count = Atomics.load(schedule, 3);
  const retired = takeRetired(schedule, -1);
  if (retired !== undefined) return retired;
  let victim = -1;
  let most = 0;
  for (let v = 0; v < count; v++) {
    const at = scheduleHeader + 2 * v;
    const left = Atomics.load(schedule, at + 1) - Atomics.load(schedule, at);
    if (left > most) {
      most = left;
      victim = v;
    }
  }
  if (victim < 0) return undefined;
  const at = scheduleHeader + 2 * victim;
  const hi = Atomics.load(schedule, at + 1);
  const lo = Atomics.load(schedule, at) + (most >> 1);
  Atomics.store(schedule, at + 1, lo);
  return [lo, hi];
}

/**
 * For checker `thief`: takes the end of another checker's range that brings the later of the two
 * estimated finishing times furthest forward (its positions), or nothing (`undefined`) if every part
 * would make it later. The owner's remaining cost counts its files and, once, the libraries they import that it
 * has not resolved; the thief's cost of an end counts its files and the libraries they import that
 * the thief has not resolved.
 */
/** With TSC_TS_CHECKERS_TRACE=3: what each idle checker takes. */
const traceSteals = process.env.TSC_TS_CHECKERS_TRACE === '3';

function takeCheapestEnd(schedule: Int32Array, plan: SchedulePlan, thief: number): number[] | undefined {
  const count = Atomics.load(schedule, 3);
  const retired = takeRetired(schedule, thief);
  if (retired !== undefined) return retired;
  const thiefResolved = plan.resolvedBy(schedule, thief);
  let bestVictim = -1;
  let bestStart = 0;
  // Even taking what changes nothing helps when the owner is busy with a long file, or never starts.
  let bestGain = -1;
  let bestRemaining = 0;
  let bestThiefCost = 0;
  for (let v = 0; v < count; v++) {
    if (v === thief) continue;
    const at = scheduleHeader + 2 * v;
    const lo = Atomics.load(schedule, at);
    const hi = Atomics.load(schedule, at + 1);
    if (lo >= hi) continue;
    const ownerResolved = plan.resolvedBy(schedule, v);
    let remaining = 0;
    const counted = new Set<number>();
    for (let p = lo; p < hi; p++) {
      remaining += plan.length(p);
      const end = plan.referenceStart(p + 1);
      for (let r = plan.referenceStart(p); r < end; r++) {
        const library = plan.reference(r);
        if (!counted.has(library) && !isResolved(ownerResolved, library)) {
          counted.add(library);
          remaining += plan.cost(library);
        }
      }
    }
    // The thief takes [start, hi): the owner keeps the rest, the thief pays for libraries it lacks.
    let taken = 0;
    let thiefCost = 0;
    const lacking = new Set<number>();
    for (let start = hi - 1; start >= lo; start--) {
      const length = plan.length(start);
      taken += length;
      thiefCost += length;
      const end = plan.referenceStart(start + 1);
      for (let r = plan.referenceStart(start); r < end; r++) {
        const library = plan.reference(r);
        if (!lacking.has(library) && !isResolved(thiefResolved, library)) {
          lacking.add(library);
          thiefCost += plan.cost(library);
        }
      }
      const gain = remaining - Math.max(remaining - taken, thiefCost);
      if (gain > bestGain) {
        bestGain = gain;
        bestVictim = v;
        bestStart = start;
        bestRemaining = remaining;
        bestThiefCost = thiefCost;
      }
      // Taking more only makes the thief finish later.
      if (thiefCost >= remaining - taken) break;
    }
  }
  if (bestVictim < 0) {
    if (traceSteals) process.stderr.write(`checkers: steal ${thief} none at ${Date.now()}\n`);
    return undefined;
  }
  const at = scheduleHeader + 2 * bestVictim;
  const hi = Atomics.load(schedule, at + 1);
  if (traceSteals)
    process.stderr.write(
      `checkers: steal ${thief} from ${bestVictim} [${bestStart},${hi}) of [${Atomics.load(schedule, at)},${hi}) remaining ${bestRemaining} thief ${bestThiefCost} at ${Date.now()}\n`,
    );
  Atomics.store(schedule, at + 1, bestStart);
  return [bestStart, hi];
}

/**
 * A plan for checking a program with several checkers (`planSchedule`): the order of its files, the
 * number of leading positions every checker takes from the shared queue (-1 for all), the start and
 * end of each checker's range, and the costs of each position (`fillScheduleCosts`).
 */
export class CheckPlan {
  constructor(
    readonly order: number[],
    readonly heavy: number,
    readonly ranges: number[],
    readonly lengths: number[],
    readonly libraries: number[][],
    readonly libraryCosts: number[],
    readonly references: number,
    /** For each position, the number of files of the group starting there (0 elsewhere). */
    readonly groups: number[] = [],
    /**
     * The statement ranges of declaration files that several checkers check (`rangeUnits`): for each,
     * the file's index and its first and end statement. Position `k` of `order` is range `u` where
     * `order[k]` is `-1 - u`.
     */
    readonly units: number[] = [],
  ) {}
}

/** The shared schedule of `plan` for `count` checkers. */
export function scheduleOf(plan: CheckPlan, count: number): SharedArrayBuffer {
  const buffer = newSchedule(count, plan.lengths.length, plan.libraryCosts.length, plan.references);
  const schedule = new Int32Array(buffer);
  if (plan.lengths.length > 0)
    fillScheduleCosts(schedule, plan.lengths, plan.libraries, plan.libraryCosts, plan.groups);
  Atomics.store(schedule, 2, plan.heavy);
  for (let k = 0; k < plan.ranges.length; k++) Atomics.store(schedule, scheduleHeader + k, plan.ranges[k]!);
  return buffer;
}

/** The most checked files that may import a file that starts a group (`checkGroups`), and the most files joining it from its importers. */
const groupImporters = 16;

/** The least load (`checkGroups`) of a file that starts a group, in characters. */
const groupLoad = 1_000_000;

/**
 * Groups of checked files that one of `count` checkers should check together, each costliest first
 * (`costs`, the estimate of `checkOrder`, also has the files' imports). A checker resolving the declarations of a file pays for much
 * of what the files it imports declare, and so does every checker checking a file that imports it:
 * a large generated schema and the files importing it, or a module that composes a server from
 * everything else, can cost each checker seconds. So a file whose load, its own text and the text
 * of the checked files it imports directly, is at least a sixteenth of all checked text and
 * `least` characters, and that 1 to `groupImporters` checked files import, starts a group. Such files
 * join the groups of those they import or that import them, and the files importing one directly
 * or indirectly join its group when there are at most `groupImporters` of them. Only groups of small
 * files around one large file form: the text of the others may be at most a quarter of a checker's
 * share, so that checking them together costs little more than their shared declarations (a group
 * of large components, each mostly its own work, would only make its checker finish last).
 */
export function checkGroups(
  checked: CheckedProgram,
  count: number,
  least: number = groupLoad,
  costs: CheckCosts = costOrder(checked),
): number[][] {
  const files = checked.program.getSourceFiles();
  const n = files.length;
  const length = textLengths(checked.program);
  const order = costs.order;
  const cost = costs.cost;
  const isChecked: boolean[] = [];
  const isStart: boolean[] = [];
  const mark: number[] = [];
  const parent: number[] = [];
  const imports: (number[] | undefined)[] = [];
  const importers: (number[] | undefined)[] = [];
  for (let i = 0; i < n; i++) {
    isChecked.push(false);
    isStart.push(false);
    mark.push(-1);
    parent.push(-1);
    imports.push(undefined);
    importers.push(undefined);
  }
  for (const i of order) isChecked[i] = true;
  // The checked files that each checked file imports, once each, and their importers.
  let total = 0;
  for (const i of order) {
    total += length[i]!;
    const own: number[] = [];
    for (const k of costs.imports[i] ?? []) {
      if (!isChecked[k]! || mark[k] === i) continue;
      mark[k] = i;
      own.push(k);
      let by = importers[k];
      if (by === undefined) importers[k] = by = [];
      by.push(i);
    }
    imports[i] = own;
  }
  const threshold = Math.max(least, total / 16);
  const starts: number[] = [];
  for (const i of order) {
    const by = importers[i]?.length ?? 0;
    if (by < 1 || by > groupImporters) continue;
    let load = length[i]!;
    for (const k of imports[i]!) load += length[k]!;
    if (load < threshold) continue;
    starts.push(i);
    isStart[i] = true;
  }
  if (starts.length === 0) return [];
  // Union-find over the files of groups (`parent` -1: in none).
  const find = (x: number): number => {
    if (parent[x]! < 0) parent[x] = x;
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) mark[i] = -1;
  for (const start of starts) {
    find(start);
    for (const k of imports[start]!) if (isStart[k]!) union(start, k);
    for (const k of importers[start]!) if (isStart[k]!) union(start, k);
    // The files importing it directly or indirectly, if they are few.
    const closure = [start];
    mark[start] = start;
    let complete = true;
    for (let q = 0; q < closure.length && complete; q++)
      for (const k of importers[closure[q]!] ?? []) {
        if (mark[k] === start) continue;
        mark[k] = start;
        closure.push(k);
        if (closure.length > groupImporters + 1) {
          complete = false;
          break;
        }
      }
    if (complete) for (const k of closure) union(start, k);
  }
  const members = new Map<number, number[]>();
  for (const i of order) {
    if (parent[i]! < 0) continue;
    const root = find(i);
    let group = members.get(root);
    if (group === undefined) members.set(root, (group = []));
    group.push(i);
  }
  const groups: number[][] = [];
  for (const group of members.values()) {
    if (group.length < 2) continue;
    let largest = 0;
    let text = 0;
    for (const i of group) {
      text += length[i]!;
      largest = Math.max(largest, length[i]!);
    }
    if (text - largest > total / count / 4) continue;
    group.sort((a, b) => cost[b]! - cost[a]! || a - b);
    groups.push(group);
  }
  return groups;
}

/**
 * How many ranges a declaration file checked in statement ranges (`rangeUnits`) has per checker's share
 * of the program's estimated cost, and at most per checker.
 */
const rangesPerShare = 2;
const rangesPerChecker = 2;

/**
 * The statement ranges that `count` checkers check declaration files in, as `CheckPlan.units`: those of
 * the files of `costs` whose estimated cost is more than a checker's share, which one checker would
 * finish long after the others. lib.dom.d.ts (2.4 MB) is such a file in a small program: one checker
 * took 150 ms on it while 15 waited. Each range is about half a share, of about equal text, and the
 * last one ends the file (`checkSourceFileRange`). `grouped` files (`checkGroups`) are checked whole.
 * TSC_TS_RANGES=0 checks every file whole; TSC_TS_RANGES=all checks every checked declaration file in
 * ranges, `count` of them.
 */
export function rangeUnits(
  checked: CheckedProgram,
  count: number,
  costs: CheckCosts,
  grouped: ReadonlySet<number> = new Set<number>(),
): number[] {
  const units: number[] = [];
  const mode = process.env.TSC_TS_RANGES;
  if (count < 2 || mode === '0') return units;
  const files = checked.program.getSourceFiles();
  const cost = costs.cost;
  let all = 0;
  for (const i of costs.order) all += cost[i]!;
  const share = all / count;
  for (const i of costs.order) {
    const file = files[i]!;
    if (!file.isDeclarationFile || grouped.has(i) || (mode !== 'all' && cost[i]! <= share)) continue;
    const statements = file.statements.nodes;
    const n = Math.min(
      statements.length,
      mode === 'all' ? count : Math.min(rangesPerChecker * count, Math.ceil((rangesPerShare * cost[i]!) / share)),
    );
    if (n < 2) continue;
    const text = file.text.length;
    let start = 0;
    for (let r = 1; r <= n && start < statements.length; r++) {
      let end = statements.length;
      if (r < n) {
        const target = (text * r) / n;
        end = start + 1;
        while (end < statements.length && statements[end - 1]!.end < target) end++;
      }
      units.push(i, start, end);
      start = end;
    }
  }
  return units;
}

/** The estimated cost of range `u` of `units`, its file's share by text. */
function unitCost(checked: CheckedProgram, costs: CheckCosts, units: readonly number[], u: number): number {
  const file = checked.program.getSourceFiles()[units[3 * u]!]!;
  return (costs.cost[units[3 * u]!]! * unitLength(file, units, u)) / Math.max(1, file.text.length);
}

/** The text length of the statements of range `u` of `units` of `file`. */
function unitLength(file: SourceFile, units: readonly number[], u: number): number {
  const statements = file.statements.nodes;
  return statements[units[3 * u + 2]! - 1]!.end - statements[units[3 * u + 1]!]!.pos;
}

/**
 * Plans checking with `count` checkers: the order to check files in, the costliest files and the
 * groups (`checkGroups`; at least `count` entries, and every file costing more than a 32nd of a
 * checker's share), costliest first, from the shared queue; then the others split, in program
 * order, into one range of about equal cost per checker, each costliest first. With `inRanges`, the
 * statement ranges of large declaration files (`rangeUnits`) replace them in the shared queue.
 */
export function planSchedule(
  checked: CheckedProgram,
  count: number,
  costs = costOrder(checked),
  inRanges = false,
): CheckPlan {
  const order = costs.order;
  const cost = costs.cost;
  if (order.length <= count) {
    const units = inRanges ? rangeUnits(checked, count, costs) : [];
    if (units.length === 0) return new CheckPlan(order, -1, [], [], [], [], 0);
    // The ranges take the place of their files, all in one shared queue, costliest first.
    const split = new Set<number>();
    for (let u = 0; u < units.length; u += 3) split.add(units[u]!);
    const entries: number[] = order.filter((i) => !split.has(i));
    for (let u = 0; u < units.length / 3; u++) entries.push(-1 - u);
    const costOf = (k: number): number => (k < 0 ? unitCost(checked, costs, units, -1 - k) : cost[k]!);
    entries.sort((a, b) => costOf(b) - costOf(a));
    return new CheckPlan(entries, -1, [], [], [], [], 0, [], units);
  }
  let all = 0;
  for (const i of order) all += cost[i]!;
  // Files that cost more than a 32nd of a checker's share go first, costliest first: at the end of
  // a range they would make its checker finish last.
  let heavyCount = count;
  while (heavyCount < order.length && cost[order[heavyCount]!]! * count * 32 >= all) heavyCount++;
  // The groups go to the shared queue as one entry each, among the costliest files, by total cost.
  const groups = checkGroups(checked, count, groupLoad, costs);
  const grouped = new Set<number>();
  for (const group of groups) for (const i of group) grouped.add(i);
  const units = inRanges ? rangeUnits(checked, count, costs, grouped) : [];
  const split = new Set<number>();
  for (let u = 0; u < units.length; u += 3) split.add(units[u]!);
  const entries: number[][] = groups.slice();
  for (const i of order.slice(0, heavyCount)) if (!grouped.has(i) && !split.has(i)) entries.push([i]);
  for (let u = 0; u < units.length / 3; u++) entries.push([-1 - u]);
  const entryCost = (entry: number[]): number => {
    let sum = 0;
    for (const i of entry) sum += i < 0 ? unitCost(checked, costs, units, -1 - i) : cost[i]!;
    return sum;
  };
  entries.sort((a, b) => entryCost(b) - entryCost(a) || a[0]! - b[0]!);
  const heavy: number[] = [];
  const groupAt: number[] = [];
  for (const entry of entries)
    for (let k = 0; k < entry.length; k++) {
      heavy.push(entry[k]!);
      groupAt.push(k === 0 && entry.length > 1 ? entry.length : 0);
    }
  const rest = order
    .slice(heavyCount)
    .filter((i) => !grouped.has(i) && !split.has(i))
    .sort((a, b) => a - b);
  heavyCount = heavy.length;
  let total = 0;
  for (const i of rest) total += cost[i]!;
  const planned = heavy.concat(rest);
  const ranges: number[] = [];
  let position = heavyCount;
  let sum = 0;
  for (let c = 0; c < count; c++) {
    const start = position;
    const target = (total * (c + 1)) / count;
    while (position < planned.length && (c === count - 1 || sum + cost[planned[position]!]! / 2 <= target)) {
      sum += cost[planned[position]!]!;
      position++;
    }
    ranges.push(start, position);
    // A range is the files of a checker; within it, costliest first, so that the files other
    // checkers take from its end, and the last files anyone checks, are cheap.
    const range = planned.slice(start, position).sort((a, b) => cost[b]! - cost[a]! || a - b);
    for (let k = 0; k < range.length; k++) planned[start + k] = range[k]!;
  }
  // The costs of each position, with the libraries numbered in order of first use.
  const files = checked.program.getSourceFiles();
  const textLength = textLengths(checked.program);
  const libraryIds = new Map<number, number>();
  const libraryCosts: number[] = [];
  const lengths: number[] = [];
  const libraries: number[][] = [];
  let references = 0;
  for (const i of planned) {
    lengths.push(i < 0 ? unitLength(files[units[-3 * i - 3]!]!, units, -1 - i) : textLength[i]!);
    const ids: number[] = [];
    for (const k of costs.libraries[i < 0 ? units[-3 * i - 3]! : i]!) {
      let id = libraryIds.get(k);
      if (id === undefined) {
        id = libraryCosts.length;
        libraryIds.set(k, id);
        libraryCosts.push(costs.libraryCost[k]!);
      }
      ids.push(id);
    }
    libraries.push(ids);
    references += ids.length;
  }
  while (groupAt.length < planned.length) groupAt.push(0);
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined)
    for (const group of groups)
      process.stderr.write(
        `checkers: group of ${group.length}: ${group.map((i) => files[i]!.fileName.split('/').slice(-2).join('/')).join(' ')}\n`,
      );
  return new CheckPlan(planned, heavyCount, ranges, lengths, libraries, libraryCosts, references, groupAt, units);
}

/** With TSC_TS_CHECKERS_TRACE: the single-threaded checker's statistics, like a checker thread's. */
export function traceSingleChecker(checked: CheckedProgram): void {
  if (process.env.TSC_TS_CHECKERS_TRACE === undefined) return;
  const c = checked.checker;
  const relations =
    c.subtypeRelation.size() +
    c.strictSubtypeRelation.size() +
    c.assignableRelation.size() +
    c.comparableRelation.size() +
    c.identityRelation.size();
  const cpu = process.threadCpuUsage();
  process.stderr.write(
    `checkers: single types ${c.typeCount} inst ${c.totalInstantiations} user ${Math.round(cpu.user / 1000)} sys ${Math.round(cpu.system / 1000)} rss ${residentMB().join('/')}MB symlinks ${c.symbolLinkTable.values.size} nodelinks ${c.nodeLinkTable.values.size} sigs ${c.signatureCount} rel ${relations}\n`,
  );
}

/** The file a position of the order checks: a file index, or for a statement range, its file's. */
function fileOfPosition(order: readonly number[], units: readonly number[], k: number): number {
  const i = order[k]!;
  return i >= 0 ? i : units[3 * (-1 - i)]!;
}

/**
 * Hands position `k` of the order on to another checker (TSC_TS_SHARE). The handed-on positions are a list in
 * `handoff`: a lock, their number, the number of checkers that may still hand positions on, then the positions.
 */
function handOff(handoff: Int32Array, k: number): void {
  while (Atomics.compareExchange(handoff, 0, 0, 1) !== 0) {
    // Another checker hands a position on or takes one.
  }
  const n = handoff[1]!;
  handoff[3 + n] = k;
  Atomics.store(handoff, 1, n + 1);
  Atomics.store(handoff, 0, 0);
  // Checkers with nothing else to check wait for handed-on positions.
  Atomics.notify(handoff, 1);
}

/**
 * Once checker `index` has no more positions of its own: a handed-on position it may check, waiting while other
 * checkers may still hand some on; -1 when none is left for it.
 */
function waitForHandedOff(
  handoff: Int32Array,
  forbidden: Int32Array,
  count: number,
  order: readonly number[],
  units: readonly number[],
  index: number,
): number {
  Atomics.sub(handoff, 2, 1);
  const start = performance.now();
  for (;;) {
    const n = Atomics.load(handoff, 1);
    const k = takeHandedOff(handoff, forbidden, count, order, units, index);
    if (k >= 0) {
      // Checking it, this checker may hand positions on again.
      Atomics.add(handoff, 2, 1);
      return k;
    }
    // The main thread checks what is handed on later, as it does the files of a thread that failed.
    if (Atomics.load(handoff, 2) === 0 || performance.now() - start > 2000) return -1;
    Atomics.wait(handoff, 1, n, 1);
  }
}

/**
 * A handed-on position checker `index` of `count` may check, removed from the handed-on positions; -1 if there is
 * none.
 */
function takeHandedOff(
  handoff: Int32Array,
  forbidden: Int32Array,
  count: number,
  order: readonly number[],
  units: readonly number[],
  index: number,
): number {
  if (Atomics.load(handoff, 1) === 0) return -1;
  while (Atomics.compareExchange(handoff, 0, 0, 1) !== 0) {
    // Another checker hands a position on or takes one.
  }
  const n = handoff[1]!;
  let found = -1;
  for (let j = 0; j < n; j++) {
    const k = handoff[3 + j]!;
    if (!isForbidden(forbidden, count, fileOfPosition(order, units, k), index)) {
      found = k;
      handoff[3 + j] = handoff[3 + n - 1]!;
      Atomics.store(handoff, 1, n - 1);
      break;
    }
  }
  Atomics.store(handoff, 0, 0);
  return found;
}

/** TSC_TS_SHARE: the sharing data of each of `count` checker threads. */
function threadSharingOf(
  count: number,
  order: readonly number[],
  units: readonly number[],
  files: number,
): ThreadSharingData[] {
  const takers = new SharedArrayBuffer(4 * files);
  const forbidden = new SharedArrayBuffer(4 * files * forbiddenWords(count));
  const handoff = new SharedArrayBuffer(4 * (3 + order.length));
  new Int32Array(handoff)[2] = count;
  const taken = new Int32Array(takers);
  taken.fill(-2);
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!;
    if (i >= 0) {
      if (taken[i] === -2) taken[i] = 0;
    } else taken[units[3 * (-1 - i)]!] = -1;
  }
  const typeTable = new SharedArrayBuffer(8 * resultTableSize);
  const returnTable = new SharedArrayBuffer(8 * resultTableSize);
  const numberLogs: SharedArrayBuffer[] = [];
  const recordTables: SharedArrayBuffer[] = [];
  const stringLogs: SharedArrayBuffer[] = [];
  for (let i = 0; i < count; i++) {
    numberLogs.push(new SharedArrayBuffer(4 * numberLogSize));
    recordTables.push(new SharedArrayBuffer(8 * recordTableSize));
    stringLogs.push(new SharedArrayBuffer(2 * stringLogSize));
  }
  const used = new SharedArrayBuffer(8 * count);
  const data: ThreadSharingData[] = [];
  for (let i = 0; i < count; i++)
    data.push({
      index: i,
      count,
      takers,
      forbidden,
      handoff,
      typeTable,
      returnTable,
      nodeIds: lastNodeIdValue(),
      symbolIds: lastSymbolIdValue(),
      numberLogs,
      recordTables,
      stringLogs,
      used,
    });
  return data;
}

/**
 * Checks files from the shared queue until it is empty; the main thread and checker threads alike.
 * A checker thread (`onMainThread` false) also sends back its global diagnostics. At `limit` files
 * it stops; `reserved` are the positions of a group its predecessor on `index` had not checked then.
 * With `emit` false it doesn't emit the files it checks (`checkersEmit`). With `checking` false it
 * only emits them (`startParallelCheck`). A position of the order below 0 is a statement range of a
 * declaration file, `-1 - u` for the range at `3 * u` in `units` (`CheckPlan.units`).
 */
export function checkFromQueue(
  checked: CheckedProgram,
  index: number,
  counter: Int32Array,
  order: number[],
  startedAt: number = Date.now(),
  onMainThread: boolean = true,
  limit: number = 0,
  reserved: readonly number[] = [],
  emit: boolean = true,
  emitKinds: readonly number[] | undefined = undefined,
  checking: boolean = true,
  units: readonly number[] = [],
  sharing: ThreadSharingData | undefined = undefined,
): CheckerResult {
  const start = performance.now();
  // TSC_TS_SHARE: each file's taker, which other checkers then take the results of its declarations from.
  const takers = sharing === undefined ? undefined : new Int32Array(sharing.takers);
  const forbidden = sharing === undefined ? undefined : new Int32Array(sharing.forbidden);
  const handoff = sharing === undefined ? undefined : new Int32Array(sharing.handoff);
  const sharingCount = sharing === undefined ? 0 : sharing.count;
  const readyAt = Date.now();
  const verbose = process.env.TSC_TS_CHECKERS_TRACE === '3';
  mark('checking');
  const files = checked.program.getSourceFiles();
  const done: number[] = [];
  const diagnostics: Diagnostic[][] = [];
  const declarations: Diagnostic[][] = [];
  const emits: EmitResult[] = [];
  const unitsDone: number[] = [];
  const reportingUnits: number[] = [];
  // Emit (or declaration emit) of a file right after checking it, with this checker.
  const emitting = checkersEmit(checked, emit);
  // Outputs are held for the main thread under `noEmitOnError`, where emit waits for every file's diagnostics,
  // and when a composite program's rebuild emits on the threads (`emitKinds`): its main thread decides which
  // unchanged declaration files not to write (`EmitFilesHandler.skipDtsOutputOfComposite`).
  // Under `noEmitOnError` a file with diagnostics keeps the program from emitting (`blockEmit`).
  const blocksOnErrors = emitting && checked.program.options.noEmitOnError === true;
  const holding =
    blocksOnErrors || (emitting && checked.program.options.composite === true && emitKinds !== undefined)
      ? new HoldingWriter()
      : undefined;
  const writer = emitting ? (holding ?? parallelCheck.writer) : undefined;
  const emitter = writer !== undefined || checkersReportDeclarations(checked) ? new ProgramEmitter(checked) : undefined;
  // An incremental program records the signatures of the declaration files on the main thread.
  const options = checked.program.options;
  const signatures =
    writer !== undefined && isIncremental(options) && getEmitDeclarations(options)
      ? new DeclarationSignatureWriter(writer, options)
      : undefined;
  const plan = schedulePlan(counter);
  const retirement = retirementMemory(index);
  let memoryReadAt = 0;
  let more = false;
  let left: number[] = [];
  for (const k of reserved) reservedBy(index).push(k);
  for (;;) {
    // At its file limit the thread ends; a new one continues its schedule index, and the rest of the
    // group it took, which no other checker takes.
    if (limit > 0 && done.length >= limit) {
      more = true;
      left = reservedBy(index).splice(0);
      // The thread that continues doesn't share results, so it hands nothing on.
      if (handoff !== undefined) Atomics.sub(handoff, 2, 1);
      break;
    }
    // Except on checker 0, read the process's memory every 20 ms at most.
    if (retirement > 0 && performance.now() - memoryReadAt >= 20) {
      memoryReadAt = performance.now();
      if (retires(counter, index, retirement)) {
        if (handoff !== undefined) Atomics.sub(handoff, 2, 1);
        break;
      }
    }
    let k = handoff !== undefined ? takeHandedOff(handoff, forbidden!, sharingCount, order, units, index) : -1;
    if (k < 0) k = takePosition(counter, order.length, index, plan);
    if (k < 0 && handoff !== undefined) k = waitForHandedOff(handoff, forbidden!, sharingCount, order, units, index);
    if (k < 0) break;
    const i = order[k]!;
    // A file this checker took results for before anyone took it goes to another checker.
    if (forbidden !== undefined && i >= 0 && isForbidden(forbidden, sharingCount, i, index)) {
      handOff(handoff!, k);
      continue;
    }
    if (takers !== undefined && i >= 0) Atomics.store(takers, i, index + 1);
    if (i < 0) {
      // A statement range of a declaration file, which has nothing to emit.
      const u = -1 - i;
      const file = files[units[3 * u]!]!;
      const rangeStart = verbose || timeline ? performance.now() : 0;
      const reports = checking && checked.checkRange(file, units[3 * u + 1]!, units[3 * u + 2]!);
      unitsDone.push(u);
      if (reports) reportingUnits.push(u);
      // A range doesn't block emit under `noEmitOnError`: what its checker found may be suppressed
      // (`// @ts-ignore`) or not the file's, which this thread doesn't know. The main thread decides
      // from the file's diagnostics, and the outputs are held for it.
      if (timeline)
        markAt(
          rangeStart,
          `range ${(performance.now() - rangeStart).toFixed(1)} pos ${k} statements ${units[3 * u + 1]}-${units[3 * u + 2]} ${file.fileName}`,
        );
      if (verbose)
        process.stderr.write(
          `checkers: range ${index} ${(performance.now() - rangeStart).toFixed(1)}ms statements ${units[3 * u + 1]}-${units[3 * u + 2]} ${file.fileName}\n`,
        );
      continue;
    }
    done.push(i);
    const fileStart = verbose || timeline ? performance.now() : 0;
    // Without `checking` the file is only emitted: declaration emit checks what it needs.
    const fileDiagnostics = checking ? checked.unfilteredDiagnosticsOfFile(files[i]!) : [];
    diagnostics.push(fileDiagnostics);
    if (blocksOnErrors && fileDiagnostics.length > 0) blockEmit(counter);
    if (timeline)
      markAt(
        fileStart,
        `file ${(performance.now() - fileStart).toFixed(1)} pos ${k} ${files[i]!.text.length} ${files[i]!.fileName}`,
      );
    if (verbose)
      process.stderr.write(
        `checkers: file ${index} ${(performance.now() - fileStart).toFixed(1)}ms ${files[i]!.text.length} ${files[i]!.fileName}\n`,
      );
    if (blocksOnErrors && blocksEmit(counter)) {
      // The program won't emit (`handleNoEmitOnError`).
      const skipped = new EmitResult();
      skipped.emitSkipped = true;
      emits.push(skipped);
    } else if (writer !== undefined) {
      const emitStart = timeline ? performance.now() : 0;
      const kind = (emitKinds === undefined ? EmitOnly.All : emitKinds[i]!) as EmitOnly;
      // Global diagnostics found while emitting are not reported: the program collects them
      // before it emits.
      const checker = checked.checker;
      if (kind < 0) emits.push(new EmitResult());
      else if (signatures !== undefined) {
        signatures.file = files[i]!;
        const result = checker.withoutGlobalDiagnostics(() => emitter!.emit([files[i]!], kind, signatures));
        for (const s of signatures.take()) result.declarationSignatures.push(s);
        if (holding !== undefined) for (const o of holding.take()) result.heldOutputs.push(o);
        emits.push(result);
      } else {
        const result = checker.withoutGlobalDiagnostics(() => emitter!.emit([files[i]!], kind, writer));
        if (holding !== undefined) for (const o of holding.take()) result.heldOutputs.push(o);
        emits.push(result);
      }
      if (timeline) markAt(emitStart, `emit ${(performance.now() - emitStart).toFixed(1)} ${files[i]!.fileName}`);
    } else if (emitter !== undefined)
      declarations.push(
        checked.checker.withoutGlobalDiagnostics(() => declarationDiagnosticsOfFile(emitter, files[i]!)),
      );
    // What emitting found and forgot can stay cached in this checker (a missing global type, an
    // instantiation too deep), where checking a later file would report it: a new checker continues
    // the schedule, as at the file limit.
    if (checked.checker.forgottenGlobalDiagnostics() > 0) {
      more = true;
      left = reservedBy(index).splice(0);
      break;
    }
  }
  mark(`checked ${done.length} files, ${unitsDone.length} ranges`);
  // On the main thread, those from before checking are the program's own (`ownGlobalDiagnostics`), and
  // CheckedProgram.getGlobalDiagnostics deduplicates them with these.
  const globals = (onMainThread ? checked.checker.getGlobalDiagnostics() : checked.getGlobalDiagnostics()).slice();
  let stats: number[] = [];
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined) {
    const cpu = process.threadCpuUsage();
    const checker = checked.checker;
    const relations =
      checker.subtypeRelation.size() +
      checker.strictSubtypeRelation.size() +
      checker.assignableRelation.size() +
      checker.comparableRelation.size() +
      checker.identityRelation.size();
    stats = [
      startedAt,
      readyAt,
      Date.now(),
      checker.typeCount,
      checker.totalInstantiations,
      cpu.user / 1000,
      cpu.system / 1000,
      residentMB()[0]!,
      checker.symbolLinkTable.values.size,
      checker.nodeLinkTable.values.size,
      checker.signatureCount,
      relations,
    ];
  }
  return new CheckerResult(
    index,
    done,
    diagnostics,
    declarations,
    globals,
    performance.now() - start,
    stats,
    more,
    left,
    emits,
    unitsDone,
    reportingUnits,
  );
}

/**
 * Whether the main thread is one of the checkers, given whether threads share the published program.
 * In scriptc builds it is not: the main thread carries the memory state of loading the program, and
 * checking there is slower than on a new thread (on Playwright the same files took 1.5 times as long
 * on the main thread, its cycle collector took twice the share of a checker thread's, and a checker
 * created on it after publishing was no faster), so the main thread often finished last. Starting
 * one more thread costs well under a millisecond. Under Node.js, where every checker thread builds
 * its own copy of the program, the main thread checks too.
 */
export function mainThreadChecks(shared: boolean): boolean {
  return !shared;
}

/**
 * When a checker's own files are a small part of what it resolves (`libraryBoundCheckers`): the least
 * text, in characters, of the libraries the files of a checker's range reach, on average over the
 * ranges, and the least multiple of the text of the range's own files it is.
 */
const libraryBoundText = 6_000_000;
const libraryBoundShare = 5;

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
  return library >= libraryBoundText && library >= libraryBoundShare * own
    ? Math.max(tsgoCheckers, Math.ceil((count * 3) / 4))
    : count;
}

/**
 * The number of checkers for `plan`, made with `count` checkers that `auto` chose
 * (`libraryBoundCount` of what its ranges reach and check).
 */
function libraryBoundCheckers(checked: CheckedProgram, plan: CheckPlan, costs: CheckCosts, count: number): number {
  if (checkerPolicy !== 'auto' || checked.program.options.checkers !== undefined || count <= tsgoCheckers) return count;
  const program = checked.program;
  const files = program.getSourceFiles();
  const length = textLengths(program);
  const isChecked: boolean[] = [];
  for (let i = 0; i < files.length; i++) isChecked.push(false);
  for (const i of costs.order) isChecked[i] = true;
  const ranges = plan.ranges.length >> 1;
  if (ranges === 0) return count;
  let library = 0;
  let own = 0;
  for (let r = 0; r < ranges; r++) {
    // The libraries the range's files import, and what they reach through other libraries (as checkCosts counts them).
    const reached = new Set<number>();
    const stack: number[] = [];
    for (let p = plan.ranges[2 * r]!; p < plan.ranges[2 * r + 1]!; p++) {
      const i = plan.order[p]!;
      own += length[i]!;
      for (const k of costs.libraries[i]!)
        if (!reached.has(k)) {
          reached.add(k);
          stack.push(k);
        }
    }
    while (stack.length > 0) {
      const k = stack.pop()!;
      library += length[k]!;
      for (const t of costs.imports[k] ?? [])
        if (
          !reached.has(t) &&
          !isChecked[t]! &&
          !program.isSourceFileDefaultLibrary(files[t]!.path) &&
          isExternalModuleFile(files[t]!)
        ) {
          reached.add(t);
          stack.push(t);
        }
    }
  }
  const fewer = libraryBoundCount(count, library / ranges, own / ranges);
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined)
    process.stderr.write(
      `checkers: ranges reach ${Math.round(library / ranges / 1000)}K library chars and check ${Math.round(own / ranges / 1000)}K on average: ${fewer} checkers\n`,
    );
  return fewer;
}

/**
 * Checks `checked` with `checkers` checkers (fewer where `auto` chose them and they would mostly
 * resolve the same libraries: `libraryBoundCheckers`) and calls `done` with the wall time once
 * `checked` holds every file's diagnostics.
 */
/**
 * Shares the program of `checked` with checker threads (scriptc builds): this thread's checker merges the
 * globals and module augmentations, which checker threads start from, and the program is published, so
 * immutable from then on. `startParallelCheck` does this first unless it was done before.
 */
export function shareWithCheckers(checked: CheckedProgram): void {
  const program = checked.program;
  program.prepareForSharing();
  mark('prepared for sharing');
  program.mergedGlobals = shareMergedGlobals(checked.checker);
  mark('globals merged');
  // Checker threads emit, or report declaration errors, with the program's indexes.
  const options = program.options;
  if (options.noEmit !== true || getEmitDeclarations(options)) {
    program.emitIndexes = new EmitIndexes(program);
    mark('emit indexes built');
  }
  mark('libraries verified');
  publish(program);
  mark('program published');
  // Lazily parsed JSDoc goes to a table of this thread.
  useLazyJSDocTable();
  checked.sharedWithCheckers = true;
}

/**
 * Checks `checked` on `checkers` threads and calls `done` once they are done. With `emits`, each thread
 * emits the files it checks (`emitKinds` limits what). With `checking` false, the threads only emit:
 * for a program whose report has no semantic diagnostics, so that no file is checked in full. With
 * `emitsTo`, the emit results go only there, by file index, and nothing else the threads find reaches
 * the program: a declaration thread (parallel-emit.ts), while this thread's checker checks. With
 * `declarationsTo`, the same holds for the declaration errors of a `noEmit` program
 * (`checkersReportDeclarations`).
 */
export function startParallelCheck(
  checked: CheckedProgram,
  checkers: number,
  done: (checkTime: number) => void,
  emits: boolean = true,
  emitKinds: number[] | undefined = undefined,
  checking: boolean = true,
  emitsTo: (EmitResult | undefined)[] | undefined = undefined,
  declarationsTo: (Diagnostic[] | undefined)[] | undefined = undefined,
): void {
  let count = checkers;
  const start = performance.now();
  const program = checked.program;
  const files = program.getSourceFiles();
  const trace = process.env.TSC_TS_CHECKERS_TRACE !== undefined;
  const shared = sharesPublishedGraphs;
  const epoch = Date.now();
  if (trace) process.stderr.write(`checkers: start at ${epoch} rss ${residentMB().join('/')}MB\n`);
  if (shared && !checked.sharedWithCheckers) {
    shareWithCheckers(checked);
    if (trace)
      process.stderr.write(
        `checkers: published the program in ${(performance.now() - start).toFixed(1)}ms rss ${residentMB().join('/')}MB\n`,
      );
  }
  const orderStart = performance.now();
  const costs = costOrder(checked);
  let plan = planSchedule(checked, count, costs, checking);
  const fewer = libraryBoundCheckers(checked, plan, costs, count);
  if (fewer < count) {
    count = fewer;
    plan = planSchedule(checked, count, costs, checking);
  }
  const order = plan.order;
  const units = plan.units;
  const counter = scheduleOf(plan, count);
  if (trace) {
    let top = '';
    for (let k = 0; k < Math.min(5, order.length); k++)
      top +=
        ' ' +
        (order[k]! < 0 ? `range ${-1 - order[k]!} of ` : '') +
        files[order[k]! < 0 ? units[-3 * order[k]! - 3]! : order[k]!]!.fileName;
    process.stderr.write(
      `checkers: ordered ${order.length} positions (${units.length / 3} statement ranges) in ${(performance.now() - orderStart).toFixed(1)}ms, first:${top}\n`,
    );
  }
  if (shared) {
    publish(order);
    publish(units);
    if (emitKinds !== undefined) publish(emitKinds);
  }
  mark(`planned ${order.length} files, ${plan.heavy} heavy`);
  const perFile: (Diagnostic[] | undefined)[] = [];
  const perFileDeclarations: (Diagnostic[] | undefined)[] = [];
  const perFileEmits: (EmitResult | undefined)[] = [];
  for (let i = 0; i < files.length; i++) {
    perFile.push(undefined);
    perFileDeclarations.push(undefined);
    perFileEmits.push(undefined);
  }
  // For each statement range (`CheckPlan.units`): 0 until checked, 1 once checked, 2 if its checker then had
  // diagnostics in the file.
  const perUnit: number[] = [];
  for (let u = 0; u < units.length / 3; u++) perUnit.push(0);
  const revival = shared ? undefined : new Revival(program);
  const mainChecks = mainThreadChecks(shared);
  const firstThread = mainChecks ? 1 : 0;
  let remaining = count - firstThread;
  let ownDone = false;
  const finish = (): void => {
    if (emitsTo !== undefined || declarationsTo !== undefined) {
      mark('emitted on checker threads');
      done(performance.now() - start);
      return;
    }
    if (checking) {
      joinRanges(checked, units, perUnit, perFile);
      // A thread that failed may have taken files it never checked, and with TSC_TS_SHARE every checker left may
      // have taken results for declarations of a file handed on: check them here.
      let left = 0;
      for (const i of order)
        if (i >= 0 && perFile[i] === undefined) {
          perFile[i] = checked.unfilteredDiagnosticsOfFile(files[i]!);
          left++;
        }
      if (trace && left > 0) process.stderr.write(`checkers: the main thread checked ${left} files\n`);
      checked.checkedInParallel = perFile;
    }
    mark('all checked');
    if (trace)
      process.stderr.write(
        `checkers: finished at ${(performance.now() - start).toFixed(1)}ms rss ${residentMB().join('/')}MB\n`,
      );
    // Files without declaration diagnostics or emit results here get them on this thread (PlainProgram).
    if (checkersReportDeclarations(checked)) checked.declarationsInParallel = perFileDeclarations;
    for (const [i, result] of emittedHere) perFileEmits[i] = result;
    if (checkersEmit(checked, emits)) {
      checked.emittedInParallel = perFileEmits;
      // A file whose declarations were emitted has its declaration diagnostics in the emit result, so
      // the program doesn't transform it again for them (handleNoEmitOnError).
      if (!checkersReportDeclarations(checked) && getEmitDeclarations(checked.program.options)) {
        for (let i = 0; i < perFileEmits.length; i++) {
          const emitted = perFileEmits[i];
          if (emitted !== undefined && emitted.declarationTransformed) perFileDeclarations[i] = emitted.diagnostics;
        }
        checked.declarationsInParallel = perFileDeclarations;
      }
    }
    done(performance.now() - start);
  };
  const record = (result: CheckerResult): void => {
    if (declarationsTo !== undefined) {
      for (let k = 0; k < result.declarations.length; k++) declarationsTo[result.files[k]!] = result.declarations[k]!;
      if (trace)
        process.stderr.write(
          `checkers: emit-only thread ${result.index} found the declaration errors of ${result.declarations.length} files in ${result.checkTime.toFixed(1)}ms, done at ${(performance.now() - start).toFixed(1)}ms rss ${result.stats[7] ?? '?'}MB\n`,
        );
      return;
    }
    if (emitsTo !== undefined) {
      for (let k = 0; k < result.emits.length; k++) emitsTo[result.files[k]!] = result.emits[k]!;
      if (trace)
        process.stderr.write(
          `checkers: emit-only thread ${result.index} emitted ${result.emits.length} files in ${result.checkTime.toFixed(1)}ms, done at ${(performance.now() - start).toFixed(1)}ms rss ${result.stats[7] ?? '?'}MB\n`,
        );
      return;
    }
    for (let k = 0; k < result.files.length; k++) perFile[result.files[k]!] = result.diagnostics[k]!;
    for (let k = 0; k < result.declarations.length; k++)
      perFileDeclarations[result.files[k]!] = result.declarations[k]!;
    for (let k = 0; k < result.emits.length; k++) perFileEmits[result.files[k]!] = result.emits[k]!;
    for (const u of result.units) perUnit[u] = 1;
    for (const u of result.reportingUnits) perUnit[u] = 2;
    for (const d of result.globals) checked.parallelGlobalDiagnostics.push(d);
    if (trace) {
      const st = result.stats;
      const rel = (t: number | undefined): string => (t === undefined ? '?' : String(t - epoch));
      process.stderr.write(
        `checkers: thread ${result.index} checked ${result.files.length} files and ${result.units.length} ranges in ${result.checkTime.toFixed(1)}ms, done at ${(performance.now() - start).toFixed(1)}ms` +
          ` [start ${rel(st[0])} ready ${rel(st[1])} end ${rel(st[2])} types ${st[3]} inst ${st[4]} user ${Math.round(st[5] ?? 0)} sys ${Math.round(st[6] ?? 0)} rss ${st[7]}MB symlinks ${st[8]} nodelinks ${st[9]} sigs ${st[10]} rel ${st[11]}]\n`,
      );
    }
  };
  const threadDone = (): void => {
    remaining--;
    if (remaining === 0 && ownDone) finish();
  };
  const diagnosticFiles = new Map<string, DiagnosticFile>();
  // TSC_TS_SHARE: checker threads share results (shared-results.ts).
  const sharing =
    shareThreads && shared && !mainChecks && count > 1 && count <= maxSharingCheckers
      ? threadSharingOf(count, order, units, files.length)
      : undefined;
  const sharingStarted: boolean[] = [];
  for (let i = 0; i < count; i++) sharingStarted.push(false);
  const startSharingOf = (i: number): ThreadSharingData => {
    sharingStarted[i] = true;
    return sharing![i]!;
  };
  const spawn = (i: number, reserved: number[]): void => {
    const worker = parallelCheck.spawn!(
      shared ? program : undefined,
      i,
      counter,
      order,
      lastNodeIdValue(),
      lastSymbolIdValue(),
      reserved,
      emits,
      emitKinds,
      checking,
      units,
      checked.globalsInFileDiagnostics,
      // A thread that continues another's index doesn't share.
      reserved.length === 0 && sharing !== undefined && !sharingStarted[i] ? startSharingOf(i) : undefined,
    );
    worker.on('message', (message: unknown) => {
      mark(`result from c${i}`);
      let result: CheckerResult;
      if (packsResults) {
        result = unpackResult(message as PackedResult, program, diagnosticFiles);
        record(result);
      } else {
        result = (message as { result: CheckerResult }).result;
        record(revival === undefined ? publish(result) : revival.result(result));
      }
      // A thread at its file limit hands its schedule index to a new one.
      if (result.more) spawn(i, result.reserved);
      else threadDone();
    });
    worker.on('error', (error: unknown) => {
      // Sharing results (TSC_TS_SHARE) is still checked for such failures, which the main thread hides otherwise.
      if (trace || shareThreads) process.stderr.write(`checkers: thread ${i} failed: ${String(error)}\n`);
      threadDone();
    });
  };
  for (let i = firstThread; i < count; i++) spawn(i, []);
  mark('checkers spawned');
  // Without a shared program, this thread's checker (`CheckedProgram.checker`) merges the globals
  // while the threads start.
  void checked.checker;
  mark('reporting checker created');
  const emittedHere =
    !mainChecks && emitKinds === undefined ? emitUncheckedFiles(checked, order, emits) : new Map<number, EmitResult>();
  if (mainChecks) {
    // The program reports the global diagnostics this checker has before checking files as found before
    // checking; those it finds checking them come with the threads' (`record`).
    checked.ownGlobalDiagnostics = checked.checker.getGlobalDiagnostics().slice();
    const own = checkFromQueue(
      checked,
      0,
      new Int32Array(counter),
      order,
      epoch,
      true,
      0,
      [],
      emits,
      emitKinds,
      checking,
      units,
    );
    record(own);
    // A thread continues where this checker stopped (`checkFromQueue`).
    if (own.more) {
      remaining++;
      spawn(0, own.reserved);
    }
  }
  ownDone = true;
  if (remaining === 0) finish();
}

/**
 * Sets the diagnostics in `perFile` of each file checked in statement ranges (`units`): none from its
 * checkers where every range was checked and found no diagnostics in it (`perUnit`, by range:
 * `checkSourceFileRange`); otherwise a new checker on this thread checks it whole.
 */
function joinRanges(
  checked: CheckedProgram,
  units: readonly number[],
  perUnit: readonly number[],
  perFile: (Diagnostic[] | undefined)[],
): void {
  const files = checked.program.getSourceFiles();
  const trace = process.env.TSC_TS_CHECKERS_TRACE !== undefined;
  // A file's ranges are consecutive.
  for (let u = 0; u < perUnit.length;) {
    const i = units[3 * u]!;
    let clean = true;
    for (; u < perUnit.length && units[3 * u] === i; u++) if (perUnit[u] !== 1) clean = false;
    if (clean) perFile[i] = checked.unfilteredDiagnosticsOfCleanRanges(files[i]!);
    else {
      if (trace) process.stderr.write(`checkers: checking ${files[i]!.fileName} whole: its ranges have diagnostics\n`);
      perFile[i] = checked.unfilteredDiagnosticsOfFileOnNewChecker(files[i]!);
    }
  }
}

/**
 * Emits, on this thread and into memory, the files that checker threads emit nothing for because
 * they don't check them (`skipTypeChecking`, such as a file with `// @ts-nocheck`), while the threads
 * check the others: the program would emit them here after the threads finish. This thread's checker
 * hasn't checked anything yet either way, so the outputs are the same. Returns the results by file
 * index; the program writes them in order with the threads' (`writeHeldOutputs`).
 */
function emitUncheckedFiles(
  checked: CheckedProgram,
  order: readonly number[],
  emits: boolean,
): Map<number, EmitResult> {
  const results = new Map<number, EmitResult>();
  const program = checked.program;
  const options = program.options;
  if (!checkersEmit(checked, emits) || options.noEmitOnError === true || isIncremental(options)) return results;
  const files = program.getSourceFiles();
  const inOrder: boolean[] = [];
  for (let i = 0; i < files.length; i++) inOrder.push(false);
  for (const i of order) if (i >= 0) inOrder[i] = true;
  let emitter: ProgramEmitter | undefined = undefined;
  let holding: HoldingWriter | undefined = undefined;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (inOrder[i]! || file.isDeclarationFile || !program.sourceFileMayBeEmitted(file, false)) continue;
    if (emitter === undefined) {
      emitter = new ProgramEmitter(checked);
      // The program reports the global diagnostics this checker has before emitting, as it would
      // collect them before emitting these files.
      checked.ownGlobalDiagnostics = checked.checker.getGlobalDiagnostics().slice();
    }
    if (holding === undefined) holding = new HoldingWriter();
    const start = timeline ? performance.now() : 0;
    const result = emitter.emit([file], EmitOnly.All, holding);
    for (const output of holding.take()) result.heldOutputs.push(output);
    results.set(i, result);
    if (timeline) markAt(start, `emit ${(performance.now() - start).toFixed(1)} ${file.fileName}`);
  }
  return results;
}

/** Diagnostics copied from another thread (Node.js), attached to this program's files again. */
class Revival {
  private readonly files = new Map<string, DiagnosticFile>();

  constructor(program: Program) {
    for (const file of program.getSourceFiles()) this.files.set(file.fileName, file.diagnosticFile());
  }

  result(copy: CheckerResult): CheckerResult {
    return new CheckerResult(
      copy.index,
      copy.files,
      copy.diagnostics.map((diagnostics) => diagnostics.map((d) => this.diagnostic(d))),
      copy.declarations.map((diagnostics) => diagnostics.map((d) => this.diagnostic(d))),
      copy.globals.map((d) => this.diagnostic(d)),
      copy.checkTime,
      copy.stats,
      copy.more,
      copy.reserved,
      copy.emits.map((emit) => this.emit(emit)),
      copy.units,
      copy.reportingUnits,
    );
  }

  private emit(copy: EmitResult): EmitResult {
    const result = new EmitResult();
    result.emitSkipped = copy.emitSkipped;
    result.declarationTransformed = copy.declarationTransformed;
    for (const f of copy.emittedFiles) result.emittedFiles.push(f);
    for (const e of copy.errors) result.errors.push(e);
    for (const u of copy.unsupported) result.unsupported.push(u);
    for (const d of copy.diagnostics) result.diagnostics.push(this.diagnostic(d));
    for (const s of copy.declarationSignatures) result.declarationSignatures.push(s);
    for (const o of copy.heldOutputs) result.heldOutputs.push(o);
    return result;
  }

  private diagnostic(copy: Diagnostic): Diagnostic {
    let file: DiagnosticFile | undefined = undefined;
    const copied = copy.file;
    if (copied !== undefined) {
      file = this.files.get(copied.fileName);
      if (file === undefined) {
        file = new DiagnosticFile(copied.fileName, copied.text);
        this.files.set(copied.fileName, file);
      }
    }
    const result = new Diagnostic(file, copy.pos, copy.end, copy.message, copy.args);
    result.code = copy.code;
    result.category = copy.category;
    result.skippedOnNoEmit = copy.skippedOnNoEmit;
    const repopulate = copy.repopulateInfo;
    if (repopulate !== undefined)
      result.repopulateInfo = new RepopulateInfo(
        repopulate.kind,
        repopulate.moduleReference,
        repopulate.mode,
        repopulate.packageName,
      );
    result.messageChain = copy.messageChain.map((d) => this.diagnostic(d));
    result.relatedInformation = copy.relatedInformation.map((d) => this.diagnostic(d));
    return result;
  }
}
