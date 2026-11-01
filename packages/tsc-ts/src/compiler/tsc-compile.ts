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
  declarationDiagnosticsDue,
  getDiagnosticsOfProgram,
  OutputWriter,
  PlainProgram,
  recordMetadataKinds,
} from './compile-program.js';
import { type Diagnostic, formattedReports, type Locale } from './diagnostics.js';
import { EmitOnly, EmitResult } from './emitter.js';
import { type CompilerOptions, getEmitDeclarations } from './options.js';
import {
  FileBuildInfoReader,
  IncrementalProgram,
  readBuildInfoProgram,
  type Snapshot,
  TimeStampHost,
} from './incremental.js';
import {
  checkerThreads,
  memoryLimit,
  parallelCheck,
  residentMB,
  shareWithCheckers,
  startParallelCheck,
  traceSingleChecker,
} from './parallel-check.js';
import {
  declarationThreadPays,
  emitThreads,
  startDeclarationErrorThread,
  startDeclarationThread,
  startMetadataEmit,
  startParallelEmit,
} from './parallel-emit.js';
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
import { reportRunConfig, Source, type CheckSignals, type RunConfig, type RecordsReport } from './run-config.js';
import { availableCpus } from './cgroup.js';
import { doctorReportPath, setDoctorCompile, type DoctorCompile, type DoctorSignals } from './doctor-report.js';
import {
  displayPath,
  recordEnvironment,
  recordKey,
  recordsDirectory,
  writeRecord,
  type RecordChoice,
  type RecordSample,
  type RecordShape,
} from './run-records.js';
import { recordOptionsOf } from './run-record-read.js';
import { version } from './help.js';
import { loadavg } from 'node:os';

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
    // An incremental recheck on old build info checks the files a change affects, not the program:
    // a record's samples are full checks (`run-records.ts`).
    if (old !== undefined && work.config !== undefined) {
      work.config.records = false;
      work.config.recordsReason = 'incremental recheck';
    }
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
  return emitStatusAndReportStatistics(sys, compilerProgram, result, work.config);
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
  // The run's configuration counts the checkers the program allows: one where it checks little, or
  // where its text doesn't fit the machine's memory as many. A checker thread run decides again once
  // the plan is made (`startParallelCheck`, run-config.ts).
  const count = checkerThreads(options.checkers, options.singleThreaded, work.program);
  work.config.checkers = count;
  return count;
}

/** The number of threads to emit JavaScript on while this thread checks (`compileWithEmitThreads`), or 0. */
export function compileEmitThreads(work: CompileWork): number {
  return emitThreads(work.program, work.program.options.singleThreaded);
}

/**
 * Like `compile`, with this thread checking the program while `threads` threads emit its JavaScript
 * (parallel-emit.ts); calls `done` with the exit status once it is emitted and reported. Returns
 * false, and `compile` runs instead, where emit threads don't apply (`emitsOnThreads`) and for an
 * incremental program with build info, whose rebuild emits what changed. An incremental program
 * without build info emits every file, as its pending emit holds (`emitKindsOf`).
 */
export function compileWithEmitThreads(
  sys: System,
  work: CompileWork,
  threads: number,
  done: (status: ExitStatus) => void,
): boolean {
  const program = work.program;
  if (!emitsOnThreads(program.options)) return false;
  if (work.incremental && !checksIncrementalOnThreads(sys, program.commandLine.buildInfoFileName())) return false;
  const times = new CompileTimes();
  times.configTime = work.configTime;
  times.parseTime = work.parseTime;
  const bindStart = performance.now();
  const checked = new CheckedProgram(program);
  times.bindTime = performance.now() - bindStart;
  // The program is shared before its checker does more than merge the globals.
  shareWithCheckers(checked);
  let compilerProgram: CompilerProgram;
  if (work.incremental) {
    const old = oldSnapshotOf(sys, work, times);
    const changesStart = performance.now();
    compilerProgram = new IncrementalProgram(checked, times, old, new SystemTimeStamps(sys));
    times.changesComputeTime = performance.now() - changesStart;
  } else compilerProgram = new PlainProgram(checked, times);
  const report = (diagnostics: Diagnostic[]): void => {
    const result = reportEmitAndErrors(
      sys,
      compilerProgram,
      diagnostics,
      work.reporter,
      work.errorSummary,
      new SystemWriter(sys),
      outputLocale(program.options),
    );
    traceSingleChecker(checked);
    done(emitStatusAndReportStatistics(sys, compilerProgram, result, work.config));
  };
  const emitKinds = emitKindsOf(compilerProgram);
  if (emitKinds !== undefined) threads = emitThreads(program, program.options.singleThreaded, emitKinds);
  if (threads > 0) checkWhileThreadsEmit(compilerProgram, threads, emitKinds, report);
  else {
    const diagnostics = getDiagnosticsOfProgram(compilerProgram, false);
    mark('diagnostics collected');
    report(diagnostics);
  }
  return true;
}

/**
 * Whether emit threads (parallel-emit.ts) can emit a program with `options` while this thread checks it:
 * not one that emits nothing or waits for its errors to emit (`noEmitOnError`), nor one that emits a
 * single `outFile` from the whole program.
 */
export function emitsOnThreads(options: CompilerOptions): boolean {
  return (
    options.noEmit !== true &&
    options.noEmitOnError !== true &&
    options.listFilesOnly !== true &&
    (options.outFile ?? '') === ''
  );
}

/**
 * What emit threads emit of each file of `program`, by file index (`emitsJavaScript`, parallel-emit.ts):
 * for an incremental program that keeps incremental state, the emit pending before checking
 * (`IncrementalProgram.emitKindsOnCheckers`), which checking only adds to and the program's emit
 * completes; `undefined` where every file is emitted in full.
 */
export function emitKindsOf(program: CompilerProgram): number[] | undefined {
  if (!(program instanceof IncrementalProgram) || !program.snapshot.canUseIncrementalState()) return undefined;
  return program.emitKindsOnCheckers(program.program.getSourceFiles());
}

/**
 * Checks `compilerProgram` on this thread while `threads` emit threads emit the JavaScript of its files that
 * `emitKinds` selects, and the declaration thread their declarations where that pays; then calls `report`
 * with the program's diagnostics, once the outputs of every thread arrived for the program's emit to complete
 * (`PlainProgram.emit`, `IncrementalProgram.emit`). The program must be shared (`shareWithCheckers`).
 */
export function checkWhileThreadsEmit(
  compilerProgram: CompilerProgram,
  threads: number,
  emitKinds: readonly number[] | undefined,
  report: (diagnostics: Diagnostic[]) => void,
): void {
  const checked = compilerProgram.checked;
  const program = checked.program;
  let diagnostics: Diagnostic[] | undefined = undefined;
  // The first wave of emit threads, and the declaration thread or the second wave.
  let emitting = 2;
  let declarations: (EmitResult | undefined)[] | undefined = undefined;
  const reportOnce = (): void => {
    if (diagnostics === undefined || emitting > 0) return;
    if (declarations !== undefined) {
      // The declaration thread emitted all of each decorator metadata file: its result is the file's emit.
      for (const i of metadata) {
        const result = declarations[i];
        if (result === undefined) continue;
        checked.emittedInParallel![i] = result;
        declarations[i] = new EmitResult();
      }
      checked.declarationsEmittedAhead = declarations;
    }
    report(diagnostics);
  };
  const emitted = (): void => {
    emitting--;
    reportOnce();
  };
  const metadata = startParallelEmit(checked, threads, emitted, emitKinds);
  // With declarations, the declaration thread also emits the files with decorator metadata.
  if (getEmitDeclarations(program.options) && declarationThreadPays(1))
    declarations = startDeclarationThread(checked, metadata, emitted, emitKinds);
  const found = getDiagnosticsOfProgram(compilerProgram, false);
  mark('diagnostics collected');
  // Else they are emitted with the kinds this thread's checker gives, now that it checked.
  if (declarations === undefined) {
    if (metadata.length > 0) {
      const files = program.getSourceFiles();
      const kinds = recordMetadataKinds(
        checked,
        metadata.map((i) => files[i]!),
      );
      mark('metadata kinds recorded');
      startMetadataEmit(checked, threads, metadata, kinds, emitted);
    } else emitting--;
  }
  diagnostics = found;
  reportOnce();
}

/**
 * Like `compile` for a `noEmit` program with declarations, which reports the errors of declaration emit:
 * this thread checks the program while the declaration thread (`startDeclarationErrorThread`) finds the
 * declaration errors of every file, then reports both; calls `done` with the exit status. Returns false
 * where the declaration thread doesn't apply, and `compile` runs instead: an incremental program, one
 * that waits for its errors (`noEmitOnError`), a program that isn't shared with threads, or one where a
 * declaration thread doesn't pay (`declarationThreadPays`).
 */
export function compileWithDeclarationThread(
  sys: System,
  work: CompileWork,
  done: (status: ExitStatus) => void,
): boolean {
  const program = work.program;
  const options = program.options;
  if (
    work.incremental ||
    options.noEmit !== true ||
    options.noEmitOnError === true ||
    options.listFilesOnly === true ||
    options.singleThreaded === true ||
    !getEmitDeclarations(options) ||
    parallelCheck.spawn === undefined ||
    !sharesPublishedGraphs ||
    !declarationThreadPays(1)
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
  let declaring = true;
  const report = (): void => {
    if (diagnostics === undefined || declaring) return;
    if (declarationDiagnosticsDue(compilerProgram, diagnostics, false))
      for (const d of compilerProgram.getDeclarationDiagnostics()) diagnostics.push(d);
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
    done(emitStatusAndReportStatistics(sys, compilerProgram, result, work.config));
  };
  startDeclarationErrorThread(checked, (declarations) => {
    // `PlainProgram.getDeclarationDiagnostics` reads them.
    checked.declarationsInParallel = declarations;
    declaring = false;
    report();
  });
  // `report` adds the declaration errors once the thread has found them, when they are due.
  diagnostics = getDiagnosticsOfProgram(compilerProgram, false, true);
  mark('diagnostics collected');
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
  // The checker threads format their diagnostics in the format the reporter writes them in.
  formattedReports.format = work.reporter.plainFormat();
  mark(`${threads} checkers`);
  const checked = new CheckedProgram(program);
  // The incremental program made after checking keeps the globals found checking a file with the file.
  if (work.incremental) checked.globalsInFileDiagnostics = true;
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
  if (!checking && work.config !== undefined) {
    // The threads only emit: nothing is checked, so there is no sample to keep.
    work.config.records = false;
    work.config.recordsReason = 'nothing checked';
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
    done(emitStatusAndReportStatistics(sys, compilerProgram, result, work.config));
  };
  const options = program.options;
  if (!checking && (options.noEmit === true || options.noEmitOnError === true)) return finish(0);
  if (
    sharesPublishedGraphs &&
    checking &&
    !work.incremental &&
    getEmitDeclarations(options) &&
    options.noEmit !== true &&
    options.noEmitOnError !== true &&
    options.composite !== true &&
    (options.outFile ?? '') === '' &&
    declarationThreadPays(threads)
  ) {
    // The checker threads emit JavaScript and the declaration thread declarations (parallel-emit.ts).
    const kinds: number[] = [];
    for (let i = 0; i < program.getSourceFiles().length; i++) kinds.push(EmitOnly.Js);
    let pending = 2;
    let checkTime = 0;
    let declarations: (EmitResult | undefined)[] = [];
    const joined = (): void => {
      if (--pending > 0) return;
      checked.javaScriptEmittedOnThreads = true;
      checked.declarationsEmittedAhead = declarations;
      finish(checkTime);
    };
    declarations = startDeclarationThread(checked, [], joined);
    startParallelCheck(
      checked,
      threads,
      (time) => {
        checkTime = time;
        joined();
      },
      true,
      kinds,
      checking,
      undefined,
      undefined,
      work.config,
    );
    return;
  }
  startParallelCheck(checked, threads, finish, true, undefined, checking, undefined, undefined, work.config);
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
  // An incremental recheck measures a part of the program, which a record's samples are not comparable
  // with full checks (`run-records.ts`).
  if (work.config !== undefined) {
    work.config.records = false;
    work.config.recordsReason = 'incremental recheck';
  }
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
    done(emitStatusAndReportStatistics(sys, incrementalProgram, result, work.config));
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
    undefined,
    undefined,
    work.config,
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
export function reportEmitAndErrors(
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
    program.times.emitTime += performance.now() - emitStart;
  }
  for (const diagnostic of emitResult.diagnostics) diagnostics.push(diagnostic);
  const all = sortAndDeduplicateDiagnostics(diagnostics);
  reporter.reportAll(all);
  listFiles(sys, program, emitResult, locale);
  errorSummary.report(all);
  return new CompileResult(all, emitResult);
}

/**
 * The exit status of a compilation, after printing `--diagnostics` statistics and, under
 * `--extendedDiagnostics` only, the run configuration's `Suggestions:` section (run-config.ts).
 */
export function emitStatusAndReportStatistics(
  sys: System,
  program: CompilerProgram,
  result: CompileResult,
  config: RunConfig | undefined = undefined,
): ExitStatus {
  const options = program.options;
  const records = saveRunRecord(sys, program, config);
  if (doctorReportPath() !== undefined) setDoctorCompile(doctorCompileOf(program, config));
  if (options.diagnostics === true || options.extendedDiagnostics === true) {
    program.times.totalTime = sys.sinceStart();
    statisticsOf(program).report(sys);
    if (options.extendedDiagnostics === true && config !== undefined) reportRunConfig(sys, config, records);
  }
  return exitStatusOf(result);
}

/**
 * Writes this run's sample to its record (`run-records.ts`) and says what the section's `Records:` line
 * reports. A run keeps no record where it may not write one (watch mode, a build's concurrent projects,
 * `--singleThreaded`, Node builds, `TSC_TS_AUTO=0` or `static`, `TSC_TS_CACHE=0`), where it checked
 * nothing, and where it rechecked the files a change affects on old build info (`recheckInParallel`, a
 * build's projects). The write is best effort: a cache directory that cannot be written reports why and
 * the run goes on.
 */
export function saveRunRecord(
  sys: System,
  program: CompilerProgram,
  config: RunConfig | undefined,
): RecordsReport | undefined {
  if (config === undefined) return undefined;
  if (!config.records) return { off: config.recordsReason ?? 'not measured' };
  if (!sharesPublishedGraphs) return { off: 'Node.js builds' };
  if (program.options.singleThreaded === true) return { off: '--singleThreaded' };
  // A run that stopped before checking (`--noCheck`, syntax errors) has nothing to sample.
  if (!program.checkedTheProgram) return { off: 'nothing checked' };
  // A run that read its record before parsing already knows the directory and key (`openRecord`); a
  // build project that did not computes them now, from the parsed program.
  const directory = config.recordDirectory ?? recordsDirectory(recordEnvironment());
  if (directory === undefined) return { off: 'TSC_TS_CACHE=0' };
  const shape = config.shape ?? recordShapeOf(program, config);
  const key = config.recordKey ?? recordKeyOf(program);
  const written = writeRecord(
    directory,
    key,
    recordSampleOf(sys, program, config),
    shape,
    chosenOf(config),
    config.rejected,
  );
  if (written.path !== undefined) return { path: displayPath(written.path) };
  return { unavailable: written.reason };
}

/** The key this run's record has: the build, the project, the options and the machine (`run-records.ts`). */
function recordKeyOf(program: CompilerProgram): string {
  return recordKey({
    version,
    executable: process.execPath,
    configFile: program.options.configFilePath,
    rootNames: program.program.commandLine.fileNames,
    options: recordOptionsOf(program.options),
    cpus: Math.max(1, availableCpus()),
    memoryBytes: memoryLimit(),
  });
}

/** What this compile measured, for a doctor child's report (`doctor-report.ts`). */
function doctorCompileOf(program: CompilerProgram, config: RunConfig | undefined): DoctorCompile {
  const times = program.times;
  const signals = config?.signals;
  return {
    version,
    configFile: program.options.configFilePath,
    key: recordKeyOf(program),
    checkers: config?.checkers ?? 1,
    share: config?.share ?? false,
    parseThreads: config?.parseThreads ?? 1,
    times: {
      parseMs: times.parseTime + times.bindTime,
      checkMs: times.checkTime,
      totalMs:
        times.totalTime !== 0 ? times.totalTime : times.parseTime + times.bindTime + times.checkTime + times.emitTime,
    },
    shape: recordShapeOf(program, config),
    signals: signals === undefined ? undefined : doctorSignalsOf(signals),
  };
}

/** The bound program's signals as a doctor report keeps them. */
function doctorSignalsOf(signals: CheckSignals): DoctorSignals {
  return {
    count: signals.count,
    ranges: signals.ranges,
    library: signals.library,
    own: signals.own,
    redundancy: signals.redundancy,
    declarationShare: signals.declarationShare,
    nodeModulesShare: signals.nodeModulesShare,
    fileShare: signals.fileShare,
  };
}

/** The program's size, and the library and redundancy signals where the run computed them. */
function recordShapeOf(program: CompilerProgram, config: RunConfig | undefined): RecordShape {
  let files = 0;
  let chars = 0;
  let declarationChars = 0;
  for (const file of program.program.getSourceFiles()) {
    files++;
    chars += file.end;
    if (file.isDeclarationFile) declarationChars += file.end;
  }
  const signals = config?.signals;
  return {
    files,
    chars,
    declarationChars,
    checkChars: chars - declarationChars,
    library: signals === undefined ? 0 : Math.round(signals.library),
    own: signals === undefined ? 0 : Math.round(signals.own),
    redundancy: signals === undefined ? 0 : signals.redundancy,
    fileShare: signals === undefined ? 0 : Math.max(signals.declarationShare, signals.nodeModulesShare),
  };
}

/** What this run measured, for its record (`RecordSample`, without the number the record gives it). */
function recordSampleOf(sys: System, program: CompilerProgram, config: RunConfig): Omit<RecordSample, 'run'> {
  const times = program.times;
  const usage = process.cpuUsage();
  const cpus = Math.max(1, availableCpus());
  return {
    at: Math.floor(Date.now() / 1000),
    role: config.role,
    checkers: config.checkers,
    share: config.share,
    parseThreads: config.parseThreads,
    parseMs: Math.round(times.parseTime + times.bindTime),
    checkMs: Math.round(times.checkTime),
    totalMs: Math.round(sys.sinceStart()),
    cpuMs: Math.round((usage.user + usage.system) / 1000),
    peakMB: residentMB()[1] ?? 0,
    load: Math.round((loadavg()[0]! / cpus) * 100) / 100,
  };
}

/**
 * The configuration this run chose for the next one, as its record keeps it (the record numbers the run
 * that chose it). The learning rules name it (`config.chosen`); a run without them records the choice it
 * used, and whether a pin made it.
 */
function chosenOf(config: RunConfig): RecordChoice {
  if (config.chosen !== undefined) return config.chosen;
  return {
    checkers: config.checkers,
    share: config.share,
    parseThreads: config.parseThreads,
    source: config.checkersSource === Source.Pinned || config.shareSource === Source.Pinned ? 'pinned' : 'default',
    since: 0,
  };
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
