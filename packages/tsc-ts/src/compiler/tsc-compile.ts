/**
 * The `tsc` compile step after the command line: bind and check the program, emit it, then report
 * diagnostics, listed files, the error summary and statistics like tsgo's `EmitFilesAndReportErrors`.
 */
import type { SourceFile } from './ast.js';
import { mark } from './timeline.js';
import {
  CheckedProgram,
  CompilerProgram,
  CompileTimes,
  getDiagnosticsOfProgram,
  OutputWriter,
  PlainProgram,
  recordMetadataKinds,
} from './compile-program.js';
import type { Diagnostic, Locale } from './diagnostics.js';
import { EmitResult } from './emitter.js';
import { getEmitDeclarations } from './options.js';
import {
  FileBuildInfoReader,
  IncrementalProgram,
  readBuildInfoProgram,
  type Snapshot,
  TimeStampHost,
} from './incremental.js';
import { checkerThreads, shareWithCheckers, startParallelCheck, traceSingleChecker } from './parallel-check.js';
import { emitThreads, startMetadataEmit, startParallelEmit } from './parallel-emit.js';
import { sharesPublishedGraphs } from '@scriptc/threads';
import { getNormalizedAbsolutePath } from './path.js';
import { sortAndDeduplicateDiagnostics } from './program.js';
import {
  checksIncrementalOnThreads,
  type CommandLineResult,
  type DiagnosticReporter,
  type ErrorSummaryReporter,
  ExitStatus,
  outputLocale,
  type System,
  SystemFileSystem,
} from './tsc-cli.js';

type CompileWork = Extract<CommandLineResult, { kind: 'compile' }>;

/** Writes outputs to the system. */
export class SystemWriter extends OutputWriter {
  constructor(private readonly sys: System) {
    super();
  }

  write(fileName: string, text: string, _declarationDiagnostics: readonly Diagnostic[]): string {
    return this.sys.writeFile(fileName, text) ? '' : `Could not write file '${fileName}'.`;
  }
}

/** File times of the system. */
export class SystemTimeStamps extends TimeStampHost {
  constructor(private readonly sys: System) {
    super();
  }

  getMTime(fileName: string): number | undefined {
    return this.sys.getMTime(fileName);
  }

  setMTime(fileName: string, time: number): void {
    this.sys.setMTime(fileName, time);
  }
}

/** Binds, checks and emits the program of `work`; returns the exit status. */
export function compile(sys: System, work: CompileWork): ExitStatus {
  const program = work.program;
  const times = new CompileTimes();
  times.configTime = work.configTime;
  times.parseTime = work.parseTime;
  const bindStart = performance.now();
  const checked = new CheckedProgram(program);
  times.bindTime = performance.now() - bindStart;
  let compilerProgram: CompilerProgram;
  if (work.incremental) {
    const old = oldSnapshotOf(sys, work, times);
    const changesStart = performance.now();
    compilerProgram = new IncrementalProgram(checked, times, old, new SystemTimeStamps(sys));
    times.changesComputeTime = performance.now() - changesStart;
  } else compilerProgram = new PlainProgram(checked, times);
  const result = emitFilesAndReportErrors(
    sys,
    compilerProgram,
    work.reporter,
    work.errorSummary,
    new SystemWriter(sys),
    outputLocale(program.options),
  );
  traceSingleChecker(checked);
  return emitStatusAndReportStatistics(sys, compilerProgram, result);
}

/** The old state of `work`'s incremental program: read while threads parsed its files, or now. */
function oldSnapshotOf(sys: System, work: CompileWork, times: CompileTimes): Snapshot | undefined {
  const early = work.buildInfo;
  if (early !== undefined) {
    times.buildInfoReadTime = early.readTime;
    return early.snapshot;
  }
  const readStart = performance.now();
  const old = readBuildInfoProgram(
    work.program.commandLine,
    new FileBuildInfoReader(new SystemFileSystem(sys)),
    sys.defaultLibraryPath,
    sys.currentDirectory,
  );
  times.buildInfoReadTime = performance.now() - readStart;
  return old;
}

/**
 * The number of checker threads for `work` (`--checkers`); 1 checks on this thread with `compile`. An
 * incremental program is checked in full on threads without build info (`checksIncrementalOnThreads`);
 * with build info, threads may check the files a change affects (`recheckInParallel`). Threads report
 * diagnostics before `noEmit` filtering, which an incremental program keeps.
 */
export function compileThreads(_sys: System, work: CompileWork): number {
  const options = work.program.options;
  mark('compile threads');
  return checkerThreads(options.checkers, options.singleThreaded, work.program);
}

/** The number of threads to emit JavaScript on while this thread checks (`compileWithEmitThreads`), or 0. */
export function compileEmitThreads(work: CompileWork): number {
  return emitThreads(work.program, work.program.options.singleThreaded);
}

/**
 * Like `compile`, with this thread checking the program while `threads` threads emit its JavaScript
 * (parallel-emit.ts); calls `done` with the exit status once it is emitted and reported. Returns
 * false where emit threads don't apply, and `compile` runs instead: an incremental program, which
 * emits what changed, one that emits nothing or waits for its errors to emit (`noEmitOnError`), and
 * `composite` and `outFile`, whose emit depends on the whole program.
 */
export function compileWithEmitThreads(
  sys: System,
  work: CompileWork,
  threads: number,
  done: (status: ExitStatus) => void,
): boolean {
  const program = work.program;
  const options = program.options;
  if (
    work.incremental ||
    options.noEmit === true ||
    options.noEmitOnError === true ||
    options.listFilesOnly === true ||
    options.composite === true ||
    (options.outFile ?? '') !== ''
  )
    return false;
  const times = new CompileTimes();
  times.configTime = work.configTime;
  times.parseTime = work.parseTime;
  const bindStart = performance.now();
  const checked = new CheckedProgram(program);
  times.bindTime = performance.now() - bindStart;
  shareWithCheckers(checked);
  const compilerProgram = new PlainProgram(checked, times);
  let diagnostics: Diagnostic[] | undefined = undefined;
  let emitting = 2;
  const report = (): void => {
    if (diagnostics === undefined || emitting > 0) return;
    const result = reportEmitAndErrors(
      sys,
      compilerProgram,
      diagnostics,
      work.reporter,
      work.errorSummary,
      new SystemWriter(sys),
      outputLocale(options),
    );
    traceSingleChecker(checked);
    done(emitStatusAndReportStatistics(sys, compilerProgram, result));
  };
  const emitted = (): void => {
    emitting--;
    report();
  };
  const metadata = startParallelEmit(checked, threads, emitted);
  const found = getDiagnosticsOfProgram(compilerProgram, false);
  mark('diagnostics collected');
  // Files with decorator metadata are emitted with the kinds this thread's checker gives, now that it checked.
  if (metadata.length > 0) {
    const files = program.getSourceFiles();
    const kinds = recordMetadataKinds(
      checked,
      metadata.map((i) => files[i]!),
    );
    mark('metadata kinds recorded');
    startMetadataEmit(checked, threads, metadata, kinds, emitted);
  } else emitting--;
  if (getEmitDeclarations(options)) compilerProgram.emitDeclarationsAhead(new SystemWriter(sys));
  diagnostics = found;
  report();
  return true;
}

/**
 * Like `compile`, with `threads` checker threads (parallel-check.ts): calls `done` with the exit
 * status once the threads have checked the program and it is emitted and reported.
 */
export function compileInParallel(
  sys: System,
  work: CompileWork,
  threads: number,
  done: (status: ExitStatus) => void,
): void {
  const program = work.program;
  const times = new CompileTimes();
  times.configTime = work.configTime;
  times.parseTime = work.parseTime;
  const bindStart = performance.now();
  mark(`${threads} checkers`);
  const checked = new CheckedProgram(program);
  times.bindTime = performance.now() - bindStart;
  mark('checker created');
  if (work.incremental && !checksIncrementalOnThreads(sys, program.commandLine.buildInfoFileName())) {
    recheckInParallel(sys, work, threads, times, checked, done);
    return;
  }
  // Reporting checks only a program without syntactic and program errors (getDiagnosticsOfProgram). With
  // them, the threads only emit the files, and with nothing to emit no thread starts. The program is
  // shared first, as for every check on threads.
  let checking = true;
  if (!work.incremental) {
    if (sharesPublishedGraphs) shareWithCheckers(checked);
    checking = program.getSyntacticDiagnostics().length === 0 && program.getProgramDiagnostics().length === 0;
  }
  const finish = (checkTime: number): void => {
    // An incremental program here has no build info (`compileThreads`).
    let compilerProgram: CompilerProgram;
    if (work.incremental) {
      const changesStart = performance.now();
      compilerProgram = new IncrementalProgram(checked, times, undefined, new SystemTimeStamps(sys));
      times.changesComputeTime = performance.now() - changesStart;
    } else compilerProgram = new PlainProgram(checked, times);
    mark('report start');
    const result = emitFilesAndReportErrors(
      sys,
      compilerProgram,
      work.reporter,
      work.errorSummary,
      new SystemWriter(sys),
      outputLocale(program.options),
    );
    times.checkTime = checkTime;
    mark(`reported ${result.diagnostics.length} diagnostics`);
    done(emitStatusAndReportStatistics(sys, compilerProgram, result));
  };
  const options = program.options;
  if (!checking && (options.noEmit === true || options.noEmitOnError === true)) return finish(0);
  startParallelCheck(checked, threads, finish, true, undefined, checking);
}

/**
 * The rest of `compileInParallel` for an incremental program with build info: its program is shared with
 * the checker threads first, then the incremental program finds the files a change affects
 * and those whose outputs are pending (`IncrementalProgram.filesForCheckers`); the threads check those
 * when they are many enough to be worth it (`rechecksOnThreads`), each emitting what the incremental
 * program's emit would of the files it checks (`emitKindsOnCheckers`), and this thread checks and emits
 * them otherwise.
 */
function recheckInParallel(
  sys: System,
  work: CompileWork,
  threads: number,
  times: CompileTimes,
  checked: CheckedProgram,
  done: (status: ExitStatus) => void,
): void {
  const program = work.program;
  const old = oldSnapshotOf(sys, work, times);
  // The program is shared before its checker does more than merge the globals; the incremental program
  // compares the references of its files with the old state on as many threads as check.
  if (sharesPublishedGraphs) {
    shareWithCheckers(checked);
    checked.referenceThreads = threads;
  }
  const changesStart = performance.now();
  const incrementalProgram = new IncrementalProgram(checked, times, old, new SystemTimeStamps(sys));
  times.changesComputeTime = performance.now() - changesStart;
  // `threadsCheckTime` is the wall time of checker threads that checked the affected files: the check
  // time reported (--diagnostics) is theirs and this thread's, which takes their diagnostics.
  const finish = (threadsCheckTime: number = 0): void => {
    mark('report start');
    const result = emitFilesAndReportErrors(
      sys,
      incrementalProgram,
      work.reporter,
      work.errorSummary,
      new SystemWriter(sys),
      outputLocale(program.options),
    );
    times.checkTime += threadsCheckTime;
    mark(`reported ${result.diagnostics.length} diagnostics`);
    done(emitStatusAndReportStatistics(sys, incrementalProgram, result));
  };
  // Reporting checks only programs without syntactic, program and global errors (getDiagnosticsOfProgram).
  // The threads emit the files they check, as the checker that checks a file emits it on this thread: into
  // memory under noEmitOnError, for this thread to write if there are no errors, and for a composite program,
  // whose unchanged declaration files this thread doesn't write (`skipDtsOutputOfComposite`).
  const options = program.options;
  if (
    !sharesPublishedGraphs ||
    options.listFilesOnly === true ||
    incrementalProgram.getSyntacticDiagnostics().length > 0 ||
    incrementalProgram.getProgramDiagnostics().length > 0 ||
    incrementalProgram.getGlobalDiagnostics(false).length > 0
  )
    return finish();
  const files = incrementalProgram.filesForCheckers();
  mark(`${files.length} files to check or emit`);
  if (!rechecksOnThreads(files, threads, options.checkers !== undefined)) return finish();
  checked.checkOnly = new Set(files);
  startParallelCheck(
    checked,
    threads,
    finish,
    true,
    incrementalProgram.emitKindsOnCheckers(files),
    incrementalProgram.checksOnCheckers,
  );
}

/**
 * Whether checker threads check `files`, the files a change affects: when there are at least two per
 * checker and, unless the number of checkers was given (`--checkers`), they hold at least
 * `recheckOnThreadsText` characters, so that the threads' start (each checker resolves the
 * declarations the files use again) costs less than checking them on one thread.
 */
export function rechecksOnThreads(files: readonly SourceFile[], threads: number, checkersGiven: boolean): boolean {
  if (files.length < 2 * threads) return false;
  if (checkersGiven) return true;
  let text = 0;
  // A file's `end` is its text length (reading `text.length` scans a non-ASCII text in scriptc builds).
  for (const file of files) text += file.end;
  return text >= recheckOnThreadsText;
}

/** The least text of the files a change affects that checker threads check (`rechecksOnThreads`). */
const recheckOnThreadsText = 200_000;

export class CompileResult {
  constructor(
    readonly diagnostics: Diagnostic[],
    readonly emitResult: EmitResult,
  ) {}
}

/** Reports diagnostics, emits, and lists files. */
export function emitFilesAndReportErrors(
  sys: System,
  program: CompilerProgram,
  reporter: DiagnosticReporter,
  errorSummary: ErrorSummaryReporter,
  writer: OutputWriter,
  locale: Locale,
): CompileResult {
  const diagnostics = getDiagnosticsOfProgram(program, false);
  mark('diagnostics collected');
  return reportEmitAndErrors(sys, program, diagnostics, reporter, errorSummary, writer, locale);
}

/** The rest of `emitFilesAndReportErrors`, with the program's `diagnostics` collected. */
function reportEmitAndErrors(
  sys: System,
  program: CompilerProgram,
  diagnostics: Diagnostic[],
  reporter: DiagnosticReporter,
  errorSummary: ErrorSummaryReporter,
  writer: OutputWriter,
  locale: Locale,
): CompileResult {
  let emitResult = new EmitResult();
  emitResult.emitSkipped = true;
  if (program.options.listFilesOnly !== true) {
    const emitStart = performance.now();
    emitResult = program.emit(writer);
    program.times.emitTime = performance.now() - emitStart;
  }
  for (const diagnostic of emitResult.diagnostics) diagnostics.push(diagnostic);
  const all = sortAndDeduplicateDiagnostics(diagnostics);
  reporter.reportAll(all);
  listFiles(sys, program, emitResult, locale);
  errorSummary.report(all);
  return new CompileResult(all, emitResult);
}

/** The exit status of a compilation, after printing `--diagnostics` statistics. */
export function emitStatusAndReportStatistics(
  sys: System,
  program: CompilerProgram,
  result: CompileResult,
): ExitStatus {
  const options = program.options;
  if (options.diagnostics === true || options.extendedDiagnostics === true) {
    program.times.totalTime = sys.sinceStart();
    statisticsOf(program).report(sys);
  }
  return exitStatusOf(result);
}

export function exitStatusOf(result: CompileResult): ExitStatus {
  if (result.diagnostics.length === 0) return ExitStatus.Success;
  return result.emitResult.emitSkipped
    ? ExitStatus.DiagnosticsPresent_OutputsSkipped
    : ExitStatus.DiagnosticsPresent_OutputsGenerated;
}

function listFiles(sys: System, compilerProgram: CompilerProgram, emitResult: EmitResult, locale: Locale): void {
  const program = compilerProgram.program;
  const options = program.options;
  if (options.listEmittedFiles === true) {
    let out = '';
    for (const file of emitResult.emittedFiles) {
      out += 'TSFILE: ' + getNormalizedAbsolutePath(file, program.currentDirectory) + '\n';
    }
    sys.write(out);
  }
  if (options.explainFiles === true) sys.write(program.explainFiles(locale));
  else if (options.listFiles === true || options.listFilesOnly === true) {
    let out = '';
    for (const file of program.getSourceFiles()) out += file.fileName + '\n';
    sys.write(out);
  }
}

// ---- Statistics

/** What `--diagnostics` and `--extendedDiagnostics` print. */
export class Statistics {
  isAggregate = false;
  projects = 0;
  projectsBuilt = 0;
  timestampUpdates = 0;
  files = 0;
  lines = 0;
  identifiers = 0;
  symbols = 0;
  types = 0;
  instantiations = 0;
  memoryUsed = 0;
  memoryAllocs = 0;
  readonly times = new CompileTimes();

  aggregate(other: Statistics): void {
    this.isAggregate = true;
    this.files += other.files;
    this.lines += other.lines;
    this.identifiers += other.identifiers;
    this.symbols += other.symbols;
    this.types += other.types;
    this.instantiations += other.instantiations;
    this.memoryUsed += other.memoryUsed;
    this.memoryAllocs += other.memoryAllocs;
    const t = this.times;
    const o = other.times;
    t.configTime += o.configTime;
    t.buildInfoReadTime += o.buildInfoReadTime;
    t.parseTime += o.parseTime;
    t.bindTime += o.bindTime;
    t.checkTime += o.checkTime;
    t.emitTime += o.emitTime;
    t.changesComputeTime += o.changesComputeTime;
  }

  report(sys: System): void {
    const rows: [string, string][] = [];
    const prefix = this.isAggregate ? 'Aggregate ' : '';
    if (this.isAggregate) {
      rows.push(['Projects in scope', String(this.projects)]);
      rows.push(['Projects built', String(this.projectsBuilt)]);
      rows.push(['Timestamps only updates', String(this.timestampUpdates)]);
    }
    rows.push([prefix + 'Files', String(this.files)]);
    rows.push([prefix + 'Lines', String(this.lines)]);
    rows.push([prefix + 'Identifiers', String(this.identifiers)]);
    rows.push([prefix + 'Symbols', String(this.symbols)]);
    rows.push([prefix + 'Types', String(this.types)]);
    rows.push([prefix + 'Instantiations', String(this.instantiations)]);
    rows.push([prefix + 'Memory used', `${Math.floor(this.memoryUsed / 1024)}K`]);
    rows.push([prefix + 'Memory allocs', String(this.memoryAllocs)]);
    const t = this.times;
    if (t.configTime !== 0) rows.push([prefix + 'Config time', formatDuration(t.configTime)]);
    if (t.buildInfoReadTime !== 0) rows.push([prefix + 'BuildInfo read time', formatDuration(t.buildInfoReadTime)]);
    rows.push([prefix + 'Parse time', formatDuration(t.parseTime)]);
    if (t.bindTime !== 0) rows.push([prefix + 'Bind time', formatDuration(t.bindTime)]);
    if (t.checkTime !== 0) rows.push([prefix + 'Check time', formatDuration(t.checkTime)]);
    if (t.emitTime !== 0) rows.push([prefix + 'Emit time', formatDuration(t.emitTime)]);
    if (t.changesComputeTime !== 0) rows.push([prefix + 'Changes compute time', formatDuration(t.changesComputeTime)]);
    rows.push([prefix + 'Total time', formatDuration(t.totalTime)]);
    let nameWidth = 0;
    let valueWidth = 0;
    for (const [name, value] of rows) {
      nameWidth = Math.max(nameWidth, name.length);
      valueWidth = Math.max(valueWidth, value.length);
    }
    let out = '';
    for (const [name, value] of rows) {
      out += (name + ':').padEnd(nameWidth + 1) + ' ' + value.padStart(valueWidth) + '\n';
    }
    sys.write(out);
  }
}

function formatDuration(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3) + 's';
}

export function statisticsOf(compilerProgram: CompilerProgram): Statistics {
  const program = compilerProgram.program;
  const statistics = new Statistics();
  const files = program.getSourceFiles();
  statistics.files = files.length;
  for (const file of files) {
    statistics.lines += file.diagnosticFile().getLineStarts().length;
    statistics.identifiers += file.identifierCount;
    statistics.symbols += file.symbolCount;
  }
  statistics.types = compilerProgram.checked.checker.typeCount;
  const t = statistics.times;
  const source = compilerProgram.times;
  t.configTime = source.configTime;
  t.buildInfoReadTime = source.buildInfoReadTime;
  t.parseTime = source.parseTime;
  t.bindTime = source.bindTime;
  t.checkTime = source.checkTime;
  t.emitTime = source.emitTime;
  t.changesComputeTime = source.changesComputeTime;
  t.totalTime = source.totalTime;
  return statistics;
}
