/**
 * Checking on several threads (`--checkers N`).
 *
 * In scriptc builds the main thread starts N checker threads and only collects their results
 * (`mainThreadChecks`); under Node.js it is checker 0 and starts N-1. Every checker creates its own
 * checker over the program and checks the files tsgo assigns to its index (`planChecks`): file i of
 * the program to checker i % N, in program order. What a checker computed for the files it checked
 * before a file can change that file's diagnostics, so with this fixed assignment they are the same
 * on every run, and the same as tsgo's with N checkers. The threads send back the semantic
 * diagnostics of their files (and under `noEmit` with declarations, their declaration diagnostics)
 * and their global diagnostics, and the main thread reports them like a single checker would. When
 * the program emits, each checker also emits its files once it has checked them all, as tsgo emits
 * each file with its checker after checking, and sends back what it wrote (`checkersEmit`).
 *
 * In scriptc builds, threads share one program: the main thread computes the program's lazy caches,
 * publishes it with `@scriptc/threads` (the program becomes immutable and immortal, and threads
 * receive it by reference), and keeps the JSDoc that checking parses lazily in tables of each thread.
 * Checker threads publish their diagnostics back. Under Node.js, which copies what it posts, every
 * checker thread builds its own copy of the program from the command line instead, and the main
 * thread revives the diagnostics it receives against its own files.
 */
import { libraryDiagnosticsAreKnownEmpty } from './library-diagnostics.js';
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
import { Diagnostic, DiagnosticFile, RepopulateInfo } from './diagnostics.js';
import { EmitOnly, EmitResult } from './emitter.js';
import { getEmitDeclarations, isIncremental } from './options.js';
import { DeclarationSignatureWriter } from './incremental.js';
import { useLazyJSDocTable } from './parser.js';
import type { CheckedProgram } from './program-checker.js';
import type { Program } from './program.js';
import { lastSymbolIdValue } from './symbol.js';
import { shareMergedGlobals } from './checker-symbols.js';
import { readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';

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
 * `symbolIds`. With `emits` false the thread doesn't emit the files it checks, where
 * the main thread emits the program (`checkersEmit`). `emitKinds`, by file index, is what the emit of
 * each file includes (an `EmitOnly`, or -1 for none) where not every output of every file is emitted
 * (an incremental program's rebuild); `undefined` for all of them.
 */
export type CheckerSpawn = (
  program: Program | undefined,
  index: number,
  counter: SharedArrayBuffer,
  order: number[],
  nodeIds: number,
  symbolIds: number,
  emits: boolean,
  emitKinds: number[] | undefined,
  checking: boolean,
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
    readonly emits: EmitResult[] = [],
  ) {}
}

/**
 * Whether checker threads send their results as plain data (`PackedResult`), which the message
 * copies, instead of publishing them (TSC_TS_REGION, default on in scriptc builds). Then nothing a
 * checker thread allocated is reachable from another thread, and the scriptc runtime discards the
 * thread's whole heap when it ends: a finished checker returns its memory.
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
 * related information as lists. An emit result is emitSkipped, the emitted files, errors and
 * unsupported files as lists of indices, then its diagnostics and its declaration signatures as a list
 * of indices. `files` and `nums` are typed arrays, which postMessage copies as one block of memory
 * each; it copies an array of numbers element by element.
 */
export type PackedResult = {
  readonly index: number;
  readonly files: Int32Array;
  readonly nums: Int32Array;
  readonly strs: string[];
  readonly checkTime: number;
  readonly stats: number[];
  readonly more: boolean;
};

class ResultPacker {
  readonly nums: number[] = [];
  readonly strs: string[] = [];
  private readonly indices = new Map<string, number>();

  constructor(private readonly program: Program) {}

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

  private strList(texts: readonly string[]): void {
    this.nums.push(texts.length);
    for (const text of texts) this.nums.push(this.str(text));
  }

  emit(result: EmitResult): void {
    this.nums.push(result.emitSkipped ? 1 : 0);
    this.strList(result.emittedFiles);
    this.strList(result.errors);
    this.strList(result.unsupported);
    this.list(result.diagnostics);
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
  const packer = new ResultPacker(program);
  for (const list of result.diagnostics) packer.list(list);
  packer.nums.push(result.declarations.length);
  for (const list of result.declarations) packer.list(list);
  packer.list(result.globals);
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
    result.emitSkipped = this.next() === 1;
    this.strList(result.emittedFiles);
    this.strList(result.errors);
    this.strList(result.unsupported);
    for (const d of this.list()) result.diagnostics.push(d);
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
  for (let k = 0; k < packed.files.length; k++) diagnostics.push(unpacker.list());
  const declarations: Diagnostic[][] = [];
  const nd = unpacker.count();
  for (let k = 0; k < nd; k++) declarations.push(unpacker.list());
  const globals = unpacker.list();
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
    emits,
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
 * Whether checkers emit the files they check, once they have checked them all (where they can write
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
 * Whether `program` has less than `littleText` characters to check, not counting the default
 * library files when their diagnostics are known (`libraryDiagnosticsAreKnownEmpty`) nor the
 * declaration files `skipLibCheck` skips.
 */
function checksLittle(program: Program): boolean {
  const options = program.options;
  const files = program.getSourceFiles();
  // Whether the libraries' diagnostics are known depends on what the other files declare.
  for (const file of files) if (!file.isBound) return false;
  let clean = program.librariesAreClean;
  if (clean === undefined) {
    clean = libraryDiagnosticsAreKnownEmpty(program);
    program.librariesAreClean = clean;
  }
  let text = 0;
  for (const file of files) {
    if (
      file.isDeclarationFile &&
      (options.skipLibCheck === true || (clean && program.isSourceFileDefaultLibrary(file.path)))
    )
      continue;
    text += file.text.length;
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
 * their files to the shared program; what else they allocate is reused by the checker threads).
 */
export function parseThreads(checkers: number): number {
  return Math.max(checkers, Math.min(availableParallelism(), maxAutoCheckers));
}

/**
 * The program's memory per character of source text when checking starts: measured 23-28 bytes on
 * the benchmark apps (parse threads' arenas included).
 */
const programBytesPerChar = 32;

/**
 * What the first checker adds, as a share of the program's memory: measured 0.24 (tRPC), 0.7-0.9
 * (TypeORM, Playwright, Excalidraw), 1.0 (VS Code) and 1.4 (Sentry). The first checker needs this
 * whatever the count, so the estimate mostly decides how many further checkers fit.
 */
const firstCheckerShare = 1;

/**
 * What each further checker adds, per character of declaration files, for a typical program:
 * measured 6 bytes for VS Code, 9 for Excalidraw, 15 for Sentry and up to 31 for T3 Code's
 * Effect-based projects (every checker resolves the declarations its files use; under 2 for tRPC).
 */
const checkerBytesPerDeclarationChar = 24;

/** The share of the memory limit that checking may use (`checkersFittingMemory`). */
const memoryShare = 0.85;

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
 * The text length of each of `program`'s files, by index, computed once per program. In scriptc
 * builds a thread caches the UTF-16 length of only the few non-ASCII strings it read last, so each
 * read of a non-ASCII file's `text.length` scans its text again.
 */
export function textLengths(program: Program): number[] {
  if (lengthsProgram !== program) {
    const lengths: number[] = [];
    for (const file of program.getSourceFiles()) lengths.push(file.text.length);
    lengthsProgram = program;
    lengthsOfProgram = lengths;
  }
  return lengthsOfProgram;
}

/**
 * The most checkers whose estimated peak memory fits (`checkersFittingMemory`), for `program`: its
 * memory is estimated from its text (`programBytesPerChar`) rather than measured, so that the number
 * of checkers, and with it the diagnostics, is the same on every run on the same machine.
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
  const programBytes = chars * programBytesPerChar;
  const memory = memoryLimit();
  const fit = checkersFittingMemory(programBytes, declarationChars, memory);
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined)
    process.stderr.write(
      `checkers: ${chars} source chars (${declarationChars} in declaration files), program ${Math.round(programBytes / 1048576)}MB (estimated), memory ${Math.round(memory / 1048576)}MB fits ${fit} checkers\n`,
    );
  return fit;
}

/**
 * The shared schedule (an Int32Array over a SharedArrayBuffer): for each checker, the start and end
 * of its positions in the order that are left to check (`CheckPlan`). The last word is 1 once a
 * checked file has diagnostics (`blocksEmit`). Only the checker on a schedule index takes its
 * positions, or the thread that continues it after its file limit (`recycleFiles`).
 */
export function newSchedule(count: number): SharedArrayBuffer {
  return new SharedArrayBuffer(4 * (2 * count + 1));
}

/**
 * The files each checker checks: `order` holds the files to check (indices into the program files)
 * checker by checker, and checker k's are the positions from `ranges[2k]` to `ranges[2k + 1]`.
 */
export class CheckPlan {
  constructor(
    readonly order: number[],
    readonly ranges: number[],
  ) {}

  /** The number of files checker `index` checks. */
  filesOf(index: number): number {
    return this.ranges[2 * index + 1]! - this.ranges[2 * index]!;
  }
}

/**
 * Plans checking `checked` with `count` checkers as tsgo does (`checkerPool`): file i of the program
 * goes to checker i % count, and each checker checks its files in program order. The files to check
 * are those `skipTypeChecking` doesn't skip, and in a rebuild only `checkOnly`. A checker caches what
 * it computes, such as the variances of generic types, so the files it checked before a file can
 * change that file's diagnostics: with this plan they are the same on every run, and the same as
 * tsgo's with as many checkers.
 */
export function planChecks(checked: CheckedProgram, count: number): CheckPlan {
  const files = checked.program.getSourceFiles();
  const only = checked.checkOnly;
  const lists: number[][] = [];
  for (let k = 0; k < count; k++) lists.push([]);
  for (let i = 0; i < files.length; i++)
    if (!checked.skipTypeChecking(files[i]!) && (only === undefined || only.has(files[i]!))) lists[i % count]!.push(i);
  const order: number[] = [];
  const ranges: number[] = [];
  for (const list of lists) {
    ranges.push(order.length);
    for (const i of list) order.push(i);
    ranges.push(order.length);
  }
  return new CheckPlan(order, ranges);
}

/** The shared schedule of `plan` (`newSchedule`). */
export function scheduleOf(plan: CheckPlan): SharedArrayBuffer {
  const buffer = newSchedule(plan.ranges.length >> 1);
  const schedule = new Int32Array(buffer);
  for (let k = 0; k < plan.ranges.length; k++) Atomics.store(schedule, k, plan.ranges[k]!);
  return buffer;
}

/** The next position checker `index` checks, or -1 once it has checked all of its files. */
export function takePosition(schedule: Int32Array, index: number): number {
  const position = Atomics.load(schedule, 2 * index);
  if (position >= Atomics.load(schedule, 2 * index + 1)) return -1;
  Atomics.store(schedule, 2 * index, position + 1);
  return position;
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

/**
 * Checks the files of checker `index` (`planChecks`) in order, on the main thread or a checker
 * thread, and then emits them, or reports their declaration diagnostics, as tsgo emits after
 * checking: emitting a file can change what its checker computes for the next one it checks. A
 * checker thread (`onMainThread` false) also sends back its global diagnostics. At `limit` files it
 * stops, and a new one on its schedule index checks the rest. With `emit` false it doesn't emit the
 * files it checks (`checkersEmit`). With `checking` false it only emits them (`startParallelCheck`).
 */
export function checkFromQueue(
  checked: CheckedProgram,
  index: number,
  counter: Int32Array,
  order: number[],
  startedAt: number = Date.now(),
  onMainThread: boolean = true,
  limit: number = 0,
  emit: boolean = true,
  emitKinds: readonly number[] | undefined = undefined,
  checking: boolean = true,
): CheckerResult {
  const start = performance.now();
  const readyAt = Date.now();
  const verbose = process.env.TSC_TS_CHECKERS_TRACE === '3';
  mark('checking');
  const files = checked.program.getSourceFiles();
  const done: number[] = [];
  const diagnostics: Diagnostic[][] = [];
  const declarations: Diagnostic[][] = [];
  const emits: EmitResult[] = [];
  // Emit (or declaration emit) of the files this checker checked, with this checker.
  const emitting = checkersEmit(checked, emit);
  // Under `noEmitOnError` emit waits for every file's diagnostics: outputs are held for the main thread.
  const holding = emitting && checked.program.options.noEmitOnError === true ? new HoldingWriter() : undefined;
  const writer = emitting ? (holding ?? parallelCheck.writer) : undefined;
  const emitter = writer !== undefined || checkersReportDeclarations(checked) ? new ProgramEmitter(checked) : undefined;
  // An incremental program records the signatures of the declaration files on the main thread.
  const options = checked.program.options;
  const signatures =
    writer !== undefined && isIncremental(options) && getEmitDeclarations(options)
      ? new DeclarationSignatureWriter(writer, options)
      : undefined;
  let more = false;
  for (;;) {
    // At its file limit the thread ends; a new one continues its schedule index.
    if (limit > 0 && done.length >= limit) {
      more = true;
      break;
    }
    const k = takePosition(counter, index);
    if (k < 0) break;
    const i = order[k]!;
    done.push(i);
    const fileStart = verbose || timeline ? performance.now() : 0;
    // Without `checking` the file is only emitted: declaration emit checks what it needs.
    const fileDiagnostics = checking ? checked.unfilteredDiagnosticsOfFile(files[i]!) : [];
    diagnostics.push(fileDiagnostics);
    if (holding !== undefined && fileDiagnostics.length > 0) blockEmit(counter);
    if (timeline)
      markAt(
        fileStart,
        `file ${(performance.now() - fileStart).toFixed(1)} pos ${k} ${files[i]!.text.length} ${files[i]!.fileName}`,
      );
    if (verbose)
      process.stderr.write(
        `checkers: file ${index} ${(performance.now() - fileStart).toFixed(1)}ms ${files[i]!.text.length} ${files[i]!.fileName}\n`,
      );
  }
  mark(`checked ${done.length} files`);
  for (const i of done) {
    if (holding !== undefined && blocksEmit(counter)) {
      // The program won't emit (`handleNoEmitOnError`).
      const skipped = new EmitResult();
      skipped.emitSkipped = true;
      emits.push(skipped);
    } else if (writer !== undefined) {
      const emitStart = timeline ? performance.now() : 0;
      const kind = (emitKinds === undefined ? EmitOnly.All : emitKinds[i]!) as EmitOnly;
      if (kind < 0) emits.push(new EmitResult());
      else if (signatures !== undefined) {
        signatures.file = files[i]!;
        const result = emitter!.emit([files[i]!], kind, signatures);
        for (const s of signatures.take()) result.declarationSignatures.push(s);
        if (holding !== undefined) for (const o of holding.take()) result.heldOutputs.push(o);
        emits.push(result);
      } else {
        const result = emitter!.emit([files[i]!], kind, writer);
        if (holding !== undefined) for (const o of holding.take()) result.heldOutputs.push(o);
        emits.push(result);
      }
      if (timeline) markAt(emitStart, `emit ${(performance.now() - emitStart).toFixed(1)} ${files[i]!.fileName}`);
    } else if (emitter !== undefined) declarations.push(declarationDiagnosticsOfFile(emitter, files[i]!));
  }
  // The main thread reports its own global diagnostics (CheckedProgram.getGlobalDiagnostics).
  const globals = onMainThread ? [] : checked.getGlobalDiagnostics().slice();
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
    emits,
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
  if (program.librariesAreClean === undefined) program.librariesAreClean = libraryDiagnosticsAreKnownEmpty(program);
  mark('libraries verified');
  publish(program);
  mark('program published');
  // Lazily parsed JSDoc goes to a table of this thread.
  useLazyJSDocTable();
  checked.sharedWithCheckers = true;
}

/**
 * Checks `checked` with `checkers` checkers, at most one per file as in tsgo (`planChecks`), and
 * calls `done` once they are done. With `emits`, each checker emits the files it checks
 * (`emitKinds` limits what). With `checking` false, the checkers only emit: for a program whose
 * report has no semantic diagnostics, so that no file is checked in full.
 */
export function startParallelCheck(
  checked: CheckedProgram,
  checkers: number,
  done: (checkTime: number) => void,
  emits: boolean = true,
  emitKinds: number[] | undefined = undefined,
  checking: boolean = true,
): void {
  const start = performance.now();
  const program = checked.program;
  const files = program.getSourceFiles();
  const count = Math.max(1, Math.min(checkers, files.length));
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
  const plan = planChecks(checked, count);
  const order = plan.order;
  const counter = scheduleOf(plan);
  if (trace) process.stderr.write(`checkers: ${order.length} files on ${count} checkers\n`);
  if (shared) {
    publish(order);
    if (emitKinds !== undefined) publish(emitKinds);
  }
  mark(`planned ${order.length} files`);
  const perFile: (Diagnostic[] | undefined)[] = [];
  const perFileDeclarations: (Diagnostic[] | undefined)[] = [];
  const perFileEmits: (EmitResult | undefined)[] = [];
  for (let i = 0; i < files.length; i++) {
    perFile.push(undefined);
    perFileDeclarations.push(undefined);
    perFileEmits.push(undefined);
  }
  const revival = shared ? undefined : new Revival(program);
  const mainChecks = mainThreadChecks(shared);
  const firstThread = mainChecks ? 1 : 0;
  // A checker without files to check needs no thread.
  let remaining = 0;
  for (let i = firstThread; i < count; i++) if (plan.filesOf(i) > 0) remaining++;
  let ownDone = false;
  const finish = (): void => {
    if (checking) {
      // A thread that failed may have taken files it never checked: check them here.
      for (const i of order) if (perFile[i] === undefined) perFile[i] = checked.unfilteredDiagnosticsOfFile(files[i]!);
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
    if (checkersEmit(checked, emits)) checked.emittedInParallel = perFileEmits;
    done(performance.now() - start);
  };
  const record = (result: CheckerResult): void => {
    for (let k = 0; k < result.files.length; k++) perFile[result.files[k]!] = result.diagnostics[k]!;
    for (let k = 0; k < result.declarations.length; k++)
      perFileDeclarations[result.files[k]!] = result.declarations[k]!;
    for (let k = 0; k < result.emits.length; k++) perFileEmits[result.files[k]!] = result.emits[k]!;
    for (const d of result.globals) checked.parallelGlobalDiagnostics.push(d);
    if (trace) {
      const st = result.stats;
      const rel = (t: number | undefined): string => (t === undefined ? '?' : String(t - epoch));
      process.stderr.write(
        `checkers: thread ${result.index} checked ${result.files.length} files in ${result.checkTime.toFixed(1)}ms, done at ${(performance.now() - start).toFixed(1)}ms` +
          ` [start ${rel(st[0])} ready ${rel(st[1])} end ${rel(st[2])} types ${st[3]} inst ${st[4]} user ${Math.round(st[5] ?? 0)} sys ${Math.round(st[6] ?? 0)} rss ${st[7]}MB symlinks ${st[8]} nodelinks ${st[9]} sigs ${st[10]} rel ${st[11]}]\n`,
      );
    }
  };
  const threadDone = (): void => {
    remaining--;
    if (remaining === 0 && ownDone) finish();
  };
  const diagnosticFiles = new Map<string, DiagnosticFile>();
  const spawn = (i: number): void => {
    const worker = parallelCheck.spawn!(
      shared ? program : undefined,
      i,
      counter,
      order,
      lastNodeIdValue(),
      lastSymbolIdValue(),
      emits,
      emitKinds,
      checking,
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
      if (result.more) spawn(i);
      else threadDone();
    });
    worker.on('error', (error: unknown) => {
      if (trace) process.stderr.write(`checkers: thread ${i} failed: ${String(error)}\n`);
      threadDone();
    });
  };
  for (let i = firstThread; i < count; i++) if (plan.filesOf(i) > 0) spawn(i);
  mark('checkers spawned');
  // Without a shared program, this thread's checker (`CheckedProgram.checker`) merges the globals
  // while the threads start.
  void checked.checker;
  mark('reporting checker created');
  const emittedHere =
    !mainChecks && emitKinds === undefined ? emitUncheckedFiles(checked, order, emits) : new Map<number, EmitResult>();
  if (mainChecks)
    record(checkFromQueue(checked, 0, new Int32Array(counter), order, epoch, true, 0, emits, emitKinds, checking));
  ownDone = true;
  if (remaining === 0) finish();
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
  for (const i of order) inOrder[i] = true;
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
      copy.emits.map((emit) => this.emit(emit)),
    );
  }

  private emit(copy: EmitResult): EmitResult {
    const result = new EmitResult();
    result.emitSkipped = copy.emitSkipped;
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
