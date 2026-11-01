/**
 * `tsc --build`: builds projects and their references in dependency order, skipping projects whose
 * outputs are up to date, like tsgo's build orchestrator. Projects are built one after another; the
 * program of a project whose every file is checked is checked by checker threads.
 */
import { BuildInfo, isBuildInfoFileNameDefaultLibrary, parseBuildInfo } from './build-info.js';
import type { ParsedBuildCommandLine } from './command-line.js';
import { CheckedProgram, CompileTimes, OutputWriter } from './compile-program.js';
import {
  createCompilerDiagnostic,
  type Diagnostic,
  type DiagnosticMessage,
  Diagnostics,
  formatDiagnosticStatus,
  formatDiagnosticStatusWithColor,
  type DiagnosticFormatOptions,
  type Locale,
  localizeMessage,
  type MessageWithArgs,
} from './diagnostics.js';
import { type ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from './ast.js';
import { parseSourceFile } from './parser.js';
import { CompilerHost, FileLoader } from './file-loader.js';
import { CachedFileSystem } from './file-system.js';
import { defaultIsPretty, version } from './help.js';
import {
  BuildInfoReader,
  computeHash,
  fileInfoFromBuildInfo,
  IncrementalProgram,
  readBuildInfoProgram,
  type Snapshot,
} from './incremental.js';
import { getAreDeclarationMapsEnabled, getEmitDeclarations, isIncremental } from './options.js';
import { getOutputDeclarationFileName, getOutputJSFileName, getSourceMapFilePath } from './output-paths.js';
import {
  combinePaths,
  fileExtensionIs,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getPathComponentsRelativeTo,
  getPathFromPathComponents,
  isDeclarationFileName,
  isRootedDiskPath,
  toPath,
} from './path.js';
import { Program } from './program.js';
import { ConfigParser, ParsedCommandLine } from './tsconfig.js';
import {
  DiagnosticReporter,
  ErrorSummaryReporter,
  ExitStatus,
  outputLocale,
  System,
  SystemFileSystem,
} from './tsc-cli.js';
import {
  checkWhileThreadsEmit,
  emitFilesAndReportErrors,
  emitKindsOf,
  emitsOnThreads,
  exitStatusOf,
  rechecksOnThreads,
  reportEmitAndErrors,
  saveRunRecord,
  Statistics,
  statisticsOf,
  SystemTimeStamps,
} from './tsc-compile.js';
import { sharesPublishedGraphs } from '@scriptc/threads';
import { checkerThreads, shareWithCheckers, startParallelCheck } from './parallel-check.js';
import { preParseConfig, reportRunConfig, type RunConfig } from './run-config.js';
import { emitThreads } from './parallel-emit.js';
import { LoadKind, ParseSession, clearPreparedFiles, parallelParse, reportPreparedFiles } from './parallel-parse.js';
import { assignSymbolIdsAtCreation } from './symbol.js';

const enum BuildKind {
  None,
  Pseudo,
  Program,
}

const enum Status {
  // Errors
  ConfigFileNotFound,
  BuildErrors,
  UpstreamErrors,
  // Nothing to do
  UpToDate,
  // Pseudo builds: only time stamps change
  UpToDateWithUpstreamTypes,
  UpToDateWithInputFileText,
  // Needs a build
  InputFileMissing,
  OutputMissing,
  InputFileNewer,
  OutOfDateBuildInfoWithPendingEmit,
  OutOfDateBuildInfoWithErrors,
  OutOfDateOptions,
  OutOfDateRoots,
  TsVersionOutputOfDate,
  ForceBuild,
  // A solution: nothing to build
  Solution,
}

class FileAndTime {
  constructor(
    readonly file: string,
    /** `undefined` for a missing file. */
    readonly time: number | undefined,
  ) {}
}

/** Whether `a` is a later time than `b`; a missing time is the earliest. */
function after(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined) return false;
  return b === undefined || a > b;
}

class UpToDateStatus {
  constructor(
    readonly kind: Status,
    /** A file name for missing files, build info and versions. */
    readonly name = '',
    /** Input and output names for out-of-date statuses. */
    readonly input = '',
    readonly output = '',
    /** Newest input and oldest output of an up-to-date project. */
    readonly newestInput: FileAndTime | undefined = undefined,
    readonly oldestOutput: FileAndTime | undefined = undefined,
    /** The reference of an upstream error, and whether it wasn't built itself. */
    readonly refHasUpstreamErrors = false,
  ) {}

  isError(): boolean {
    return (
      this.kind === Status.ConfigFileNotFound || this.kind === Status.BuildErrors || this.kind === Status.UpstreamErrors
    );
  }

  isPseudoBuild(): boolean {
    return this.kind === Status.UpToDateWithUpstreamTypes || this.kind === Status.UpToDateWithInputFileText;
  }

  oldestOutputFileName(): string {
    const oldest = this.oldestOutput;
    if (oldest !== undefined) return oldest.file;
    if (this.output !== '') return this.output;
    return this.name;
  }
}

function inputNewer(input: string, output: string): UpToDateStatus {
  return new UpToDateStatus(Status.InputFileNewer, '', input, output);
}

class BuildInfoEntry {
  constructor(
    readonly buildInfo: BuildInfo | undefined,
    readonly path: string,
    public mTime: number | undefined,
    public dtsTime: number | undefined,
    public dtsTimeKnown: boolean,
  ) {}
}

class UpstreamTask {
  constructor(
    readonly task: BuildTask,
    readonly refIndex: number,
  ) {}
}

class BuildTask {
  resolved: ParsedCommandLine | undefined = undefined;
  upStream: UpstreamTask[] = [];
  status: UpToDateStatus | undefined = undefined;
  buildInfoEntry: BuildInfoEntry | undefined = undefined;
  errors: Diagnostic[] = [];
  exitStatus = ExitStatus.Success;
  statistics: Statistics | undefined = undefined;
  program: IncrementalProgram | undefined = undefined;
  buildKind = BuildKind.None;
  filesToDelete: string[] = [];
  configTime = 0;
  /** The project's run configuration (run-config.ts), one per project of the build. */
  run: RunConfig | undefined = undefined;

  constructor(readonly config: string) {}
}

/** The build info of a task, read once. */
class TaskBuildInfoReader extends BuildInfoReader {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly task: BuildTask,
  ) {
    super();
  }

  readBuildInfo(config: ParsedCommandLine): BuildInfo | undefined {
    return this.orchestrator.loadOrStoreBuildInfo(this.task, config.buildInfoFileName()).buildInfo;
  }
}

/** A compiler host writing `--traceResolution` output to the system. */
/**
 * The declaration and JSON files parsed in the current build (BuildCompilerHost), by name, path and
 * module detection options. Not reachable from the programs: a program shared with checker threads
 * is immutable, and so is everything it refers to.
 */
let buildSourceFiles = new Map<string, SourceFile>();
/** The names of `buildSourceFiles`, which parse threads don't load again. */
let buildSourceFileNames = new Set<string>();

/**
 * In `tsc -b -w`, the source files of the last rebuild and those of this one, by the key of
 * `buildSourceFiles` (`startWatchRebuild`); outside watch mode `undefined`. Not reachable from the
 * programs, like `buildSourceFiles`.
 */
let watchSourceFilesOfLastBuild: ReadonlyMap<string, SourceFile> | undefined = undefined;
let watchSourceFiles: Map<string, SourceFile> | undefined = undefined;

/**
 * Starts a rebuild of `tsc -b -w`: its projects' programs take the source files of the last rebuild
 * whose text is unchanged (`BuildCompilerHost`), as `tsc -w` does. Natively, syntax trees and symbols
 * are never freed (ProgramLifetime), so parsing every file again made each rebuild keep another copy of
 * every project's program.
 */
export function startWatchRebuild(): void {
  watchSourceFilesOfLastBuild = watchSourceFiles ?? new Map<string, SourceFile>();
  watchSourceFiles = new Map<string, SourceFile>();
}

class BuildCompilerHost extends CompilerHost {
  constructor(
    private readonly sys: System,
    fs: CachedFileSystem,
    private readonly locale: Locale,
  ) {
    super(fs, sys.currentDirectory, sys.defaultLibraryPath);
  }

  /**
   * Declaration and JSON files are parsed once per build and shared by the programs of its projects,
   * as tsgo's build host shares them: libraries and the declaration outputs of referenced projects
   * are in many programs. A file is parsed the same for the same name, path and module detection
   * options, and binding a bound file does nothing.
   */
  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    const key =
      fileName +
      '\u0000' +
      path +
      (externalModuleIndicatorOptions.jsx ? '\u0000j' : '\u0000') +
      (externalModuleIndicatorOptions.force ? 'f' : '');
    if (watchSourceFiles !== undefined)
      return this.getWatchSourceFile(fileName, path, externalModuleIndicatorOptions, key);
    if (!isDeclarationFileName(fileName) && !fileExtensionIs(fileName, '.json'))
      return super.getSourceFile(fileName, path, externalModuleIndicatorOptions);
    const cached = buildSourceFiles.get(key);
    if (cached !== undefined) return cached;
    const file = super.getSourceFile(fileName, path, externalModuleIndicatorOptions);
    // A file that can't be read is looked up again, as tsgo does.
    if (file !== undefined) {
      buildSourceFiles.set(key, file);
      buildSourceFileNames.add(fileName);
    }
    return file;
  }

  /**
   * In `tsc -b -w` (`startWatchRebuild`), any file is parsed once per rebuild and shared by its
   * projects' programs, and a rebuild takes the last rebuild's file when its text is unchanged. A file
   * parses the same for the same text, name, path and module detection options, and binding a bound
   * file does nothing.
   */
  private getWatchSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
    key: string,
  ): SourceFile | undefined {
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    let file = watchSourceFiles!.get(key);
    if (file !== undefined && file.text === text) return file;
    file = watchSourceFilesOfLastBuild?.get(key);
    if (file === undefined || file.text !== text)
      file = parseSourceFile(
        fileName,
        text,
        new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions),
      );
    watchSourceFiles!.set(key, file);
    buildSourceFileNames.add(fileName);
    return file;
  }

  trace(message: MessageWithArgs): void {
    this.sys.write(localizeMessage(this.locale, message.message, message.args) + '\n');
  }
}

/** Writes a task's outputs, noting when its build info is written. */
class TaskWriter extends OutputWriter {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly task: BuildTask,
  ) {
    super();
  }

  write(fileName: string, text: string, _declarationDiagnostics: readonly Diagnostic[]): string {
    const sys = this.orchestrator.sys;
    if (!sys.writeFile(fileName, text)) return `Could not write file '${fileName}'.`;
    const resolved = this.task.resolved;
    const program = this.task.program;
    if (resolved !== undefined && program !== undefined && fileName === resolved.buildInfoFileName()) {
      const buildInfo = program.lastBuildInfo;
      this.orchestrator.onBuildInfoEmit(this.task, fileName, buildInfo, program.hasChangedDtsFile);
    }
    return '';
  }
}

/** Every output file a project produces, without its build info. */
export function getOutputFileNames(config: ParsedCommandLine): string[] {
  const result: string[] = [];
  const options = config.options;
  for (const fileName of config.fileNames) {
    if (isDeclarationFileName(fileName)) continue;
    const jsFileName = getOutputJSFileName(fileName, options, config);
    const isJson = fileExtensionIs(fileName, '.json');
    if (jsFileName !== '') {
      result.push(jsFileName);
      if (!isJson) {
        const sourceMap = getSourceMapFilePath(jsFileName, options);
        if (sourceMap !== '') result.push(sourceMap);
      }
    }
    if (isJson) continue;
    if (getEmitDeclarations(options)) {
      const dtsFileName = getOutputDeclarationFileName(fileName, options, config);
      if (dtsFileName !== '') {
        result.push(dtsFileName);
        if (getAreDeclarationMapsEnabled(options)) result.push(dtsFileName + '.map');
      }
    }
  }
  return result;
}

/** `path` relative to `currentDirectory` if absolute. */
function convertToRelativePath(path: string, currentDirectory: string, useCaseSensitiveFileNames: boolean): string {
  if (!isRootedDiskPath(path)) return path;
  return getPathFromPathComponents(
    getPathComponentsRelativeTo(currentDirectory, path, useCaseSensitiveFileNames, currentDirectory),
  );
}

/** `hh:mm:ss AM` of the current local time. */
export function statusTime(): string {
  const now = new Date();
  let hours = now.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const pad = (n: number): string => (n < 10 ? '0' + String(n) : String(n));
  return `${pad(hours)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${suffix}`;
}

/** Writes build and watch status lines: `time - message`, or with a colored time under `--pretty`. */
export class StatusReporter {
  private readonly pretty: boolean;
  private readonly format: DiagnosticFormatOptions;

  constructor(
    private readonly sys: System,
    pretty: boolean | undefined,
    private readonly quiet: boolean,
    locale: Locale,
  ) {
    this.pretty = pretty ?? defaultIsPretty(sys);
    this.format = {
      locale,
      currentDirectory: sys.currentDirectory,
      useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
      newLine: '\n',
    };
  }

  report(message: DiagnosticMessage, ...args: string[]): void {
    if (this.quiet) return;
    const diagnostic = createCompilerDiagnostic(message, ...args);
    const time = statusTime();
    const text = this.pretty
      ? formatDiagnosticStatusWithColor(time, diagnostic, this.format)
      : formatDiagnosticStatus(time, diagnostic, this.format);
    this.sys.write(text + '\n\n');
  }
}

/** Collects the diagnostics of a task as it reports them. */
class TaskDiagnosticReporter extends DiagnosticReporter {
  constructor(
    private readonly task: BuildTask,
    private readonly inner: DiagnosticReporter,
    sys: System,
    locale: Locale,
  ) {
    super(sys, {}, locale);
  }

  report(diagnostic: Diagnostic): void {
    this.task.errors.push(diagnostic);
    this.inner.report(diagnostic);
  }

  reportAll(diagnostics: readonly Diagnostic[]): void {
    for (const diagnostic of diagnostics) this.task.errors.push(diagnostic);
    this.inner.reportAll(diagnostics);
  }
}

class QuietSummary extends ErrorSummaryReporter {
  report(_diagnostics: readonly Diagnostic[]): void {}
}

export class Orchestrator {
  private readonly tasks = new Map<string, BuildTask>();
  private order: string[] = [];
  private errors: Diagnostic[] = [];
  private readonly locale: Locale;
  private readonly fs: CachedFileSystem;
  private readonly configParser: ConfigParser;
  private readonly mTimes = new Map<string, number | undefined>();
  private readonly status: StatusReporter;
  private readonly reporter: DiagnosticReporter;
  private readonly errorSummary: ErrorSummaryReporter;
  /** Under `--watch`, the error count is reported by the watcher instead of the summary. */
  watching = false;
  errorCount = 0;

  constructor(
    readonly sys: System,
    readonly command: ParsedBuildCommandLine,
  ) {
    const options = command.compilerOptions;
    this.locale = outputLocale(options);
    this.fs = new CachedFileSystem(new SystemFileSystem(sys));
    this.configParser = new ConfigParser(this.fs, sys.currentDirectory);
    this.status = new StatusReporter(sys, options.pretty, options.quiet === true, this.locale);
    this.reporter = new DiagnosticReporter(sys, options, this.locale);
    this.errorSummary = new ErrorSummaryReporter(sys, options, this.locale);
    buildSourceFiles = new Map<string, SourceFile>();
    buildSourceFileNames = new Set<string>();
  }

  private get verbose(): boolean {
    return this.command.buildOptions.verbose === true;
  }

  private get dry(): boolean {
    return this.command.buildOptions.dry === true;
  }

  private get force(): boolean {
    return this.command.buildOptions.force === true;
  }

  private get stopBuildOnErrors(): boolean {
    return this.command.buildOptions.stopBuildOnErrors === true;
  }

  private relativeFileName(fileName: string): string {
    return convertToRelativePath(fileName, this.sys.currentDirectory, this.sys.useCaseSensitiveFileNames);
  }

  private toPath(fileName: string): string {
    return toPath(fileName, this.sys.currentDirectory, this.sys.useCaseSensitiveFileNames);
  }

  private getTask(path: string): BuildTask {
    const task = this.tasks.get(path);
    if (task === undefined) throw new Error('No build task found for ' + path);
    return task;
  }

  private getMTime(fileName: string): number | undefined {
    const path = this.toPath(fileName);
    if (this.mTimes.has(path)) return this.mTimes.get(path);
    const time = this.sys.getMTime(fileName);
    this.mTimes.set(path, time);
    return time;
  }

  private setMTime(fileName: string, time: number): boolean {
    return this.sys.setMTime(fileName, time);
  }

  private parseConfig(fileName: string): ParsedCommandLine | undefined {
    const errors: Diagnostic[] = [];
    return this.configParser.parseConfigFile(fileName, this.command.compilerOptions, this.command.raw, errors);
  }

  private resolvedProjectPaths(): string[] {
    return this.command.projects.map((project) =>
      resolveProjectReferencePathOf(getNormalizedAbsolutePath(project, this.sys.currentDirectory)),
    );
  }

  private createBuildTasks(configs: readonly string[]): void {
    for (const config of configs) {
      const path = this.toPath(config);
      if (this.tasks.has(path)) continue;
      const task = new BuildTask(config);
      this.tasks.set(path, task);
      const configStart = performance.now();
      task.resolved = this.parseConfig(config);
      task.configTime = performance.now() - configStart;
      const resolved = task.resolved;
      if (resolved !== undefined) this.createBuildTasks(resolved.resolvedProjectReferencePaths());
    }
  }

  private setupBuildTask(
    configName: string,
    inCircularContext: boolean,
    completed: Set<string>,
    analyzing: Set<string>,
    circularityStack: string[],
  ): BuildTask | undefined {
    const path = this.toPath(configName);
    const task = this.getTask(path);
    if (!completed.has(path)) {
      if (analyzing.has(path)) {
        if (!inCircularContext) {
          this.errors.push(
            createCompilerDiagnostic(
              Diagnostics.Project_references_may_not_form_a_circular_graph_Cycle_detected_Colon_0,
              circularityStack.join('\n'),
            ),
          );
        }
        return undefined;
      }
      analyzing.add(path);
      circularityStack.push(configName);
      const resolved = task.resolved;
      if (resolved !== undefined) {
        const references = resolved.resolvedProjectReferencePaths();
        for (let index = 0; index < references.length; index++) {
          const reference = resolved.projectReferences[index];
          const upstream = this.setupBuildTask(
            references[index],
            inCircularContext || (reference !== undefined && reference.circular),
            completed,
            analyzing,
            circularityStack,
          );
          if (upstream !== undefined) task.upStream.push(new UpstreamTask(upstream, index));
        }
      }
      circularityStack.pop();
      completed.add(path);
      this.order.push(configName);
    }
    return task;
  }

  private generateGraph(): void {
    const projects = this.resolvedProjectPaths();
    this.createBuildTasks(projects);
    const completed = new Set<string>();
    const analyzing = new Set<string>();
    for (const project of projects) this.setupBuildTask(project, false, completed, analyzing, []);
  }

  /** Builds or cleans every project; returns the exit status. */
  start(): ExitStatus {
    let status: ExitStatus | undefined;
    this.run((s) => (status = s), false);
    return status!;
  }

  /**
   * Builds or cleans every project like `start`. A project whose every file is checked is checked
   * by checker threads (parallel-check.ts), and the build continues on this thread's event loop once
   * they are done. `done` gets the exit status, on this call or later; returns whether later.
   */
  startWithThreads(done: (status: ExitStatus) => void): boolean {
    return this.run(done, true);
  }

  /** Builds the projects from `this.order`; returns whether a project's check went to threads. */
  private run(done: (status: ExitStatus) => void, threads: boolean): boolean {
    this.generateGraph();
    const command = this.command;
    if (command.buildOptions.clean !== true && this.verbose) {
      this.status.report(
        Diagnostics.Projects_in_this_build_Colon_0,
        this.order.map((p) => '\r\n    * ' + this.relativeFileName(p)).join(''),
      );
    }
    const state = new BuildState();
    if (this.errors.length === 0) {
      state.statistics.projects = this.order.length;
      return this.runFrom(0, state, threads, done);
    }
    state.status = ExitStatus.ProjectReferenceCycle_OutputsSkipped;
    this.reporter.reportAll(this.errors);
    state.errors = this.errors;
    done(this.finish(state));
    return false;
  }

  /**
   * Builds the projects from `index` on; when a project is checked by threads, continues after it
   * once they are done. Returns whether that happened.
   */
  private runFrom(index: number, state: BuildState, threads: boolean, done: (status: ExitStatus) => void): boolean {
    const clean = this.command.buildOptions.clean === true;
    for (let i = index; i < this.order.length; i++) {
      const task = this.getTask(this.toPath(this.order[i]!));
      if (clean) this.cleanProject(task);
      else {
        const deferred = this.buildProject(task, threads, () => {
          this.recordTask(task, state);
          this.runFrom(i + 1, state, threads, done);
        });
        if (deferred) return true;
      }
      this.recordTask(task, state);
    }
    done(this.finish(state));
    return false;
  }

  private recordTask(task: BuildTask, state: BuildState): void {
    if (task.errors.length > 0) for (const e of task.errors) state.errors.push(e);
    if (task.exitStatus > state.status) state.status = task.exitStatus;
    const taskStatistics = task.statistics;
    if (taskStatistics !== undefined) state.statistics.aggregate(taskStatistics);
    if (task.buildKind === BuildKind.Program) state.statistics.projectsBuilt++;
    else if (task.buildKind === BuildKind.Pseudo) state.statistics.timestampUpdates++;
    for (const file of task.filesToDelete) state.filesToDelete.push(file);
  }

  /** Reports the summary of the build; returns its exit status. */
  private finish(state: BuildState): ExitStatus {
    const errors = state.errors;
    this.errorCount = errors.length;
    if (!this.watching) this.errorSummary.report(errors);
    if (state.filesToDelete.length > 0) {
      this.status.report(
        Diagnostics.A_non_dry_build_would_delete_the_following_files_Colon_0,
        state.filesToDelete.map((f) => '\r\n * ' + f).join(''),
      );
    }
    const options = this.command.compilerOptions;
    if (options.diagnostics === true || options.extendedDiagnostics === true) {
      state.statistics.times.totalTime = this.sys.sinceStart();
      state.statistics.report(this.sys);
    }
    return state.status;
  }

  private reportDiagnostic(task: BuildTask, diagnostic: Diagnostic): void {
    task.errors.push(diagnostic);
    this.reporter.report(diagnostic);
  }

  /**
   * Builds `task` unless it is up to date. With `threads`, a program whose every file is checked is
   * checked by checker threads: returns true, and calls `then` once the project is built.
   */
  private buildProject(task: BuildTask, threads: boolean, then: () => void): boolean {
    task.status = this.getUpToDateStatus(task);
    this.reportUpToDateStatus(task);
    if (!this.handleStatusThatDoesntRequireBuild(task)) {
      return this.compileAndEmit(task, threads, then);
    } else {
      const resolved = task.resolved;
      if (resolved !== undefined) {
        for (const diagnostic of resolved.configFileParsingDiagnostics()) this.reportDiagnostic(task, diagnostic);
      }
      if (task.errors.length > 0) task.exitStatus = ExitStatus.DiagnosticsPresent_OutputsSkipped;
    }
    return false;
  }

  /** Builds `task`'s program; see `buildProject` for `threads` and `then`. */
  private compileAndEmit(task: BuildTask, threads: boolean, then: () => void): boolean {
    const resolved = task.resolved;
    if (resolved === undefined) return false;
    const sys = this.sys;
    task.errors = [];
    if (this.verbose) this.status.report(Diagnostics.Building_project_0, this.relativeFileName(task.config));

    // Each project loads its own files, with or without parse threads: the files prepared for the
    // previous project (loaded with its options) go now, not before its incremental program took their
    // versions (programToSnapshot).
    clearPreparedFiles();
    const times = new CompileTimes();
    times.configTime = task.configTime;
    const readStart = performance.now();
    const oldSnapshot = this.force
      ? undefined
      : readBuildInfoProgram(
          resolved,
          new TaskBuildInfoReader(this, task),
          sys.defaultLibraryPath,
          sys.currentDirectory,
        );
    times.buildInfoReadTime = performance.now() - readStart;
    // Checker threads check every file without old build info, and the files a change affects with it
    // (`recheckOnThreads`). They report a file's semantic diagnostics before `noEmit` filtering, which the
    // incremental program keeps (`getSemanticDiagnosticsWithoutNoEmitFiltering`).
    const mayUseThreads = threads;
    const parseStart = performance.now();
    // A program checked by threads is shared with them and can't change after; the project's config
    // here, whose output paths are computed later, gets a copy of its own.
    const config = mayUseThreads ? copyCommandLine(resolved) : resolved;
    const host = new BuildCompilerHost(sys, this.fs, this.locale);
    const configOptions = config.options;
    const checkers = threads ? checkerThreads(configOptions.checkers, configOptions.singleThreaded) : 1;
    // One configuration per project: its parse threads, and the pins of its checker count and sharing.
    const run = (task.run = preParseConfig(configOptions, checkers));
    // The projects of a build that builds several at once run beside each other, and each one's timings
    // are the machine's, not its own: none keeps a record (run-records.ts).
    const builders = this.command.buildOptions.builders ?? (configOptions.singleThreaded === true ? 1 : 4);
    if (builders > 1) {
      run.records = false;
      run.recordsReason = 'concurrent projects';
    }
    if (threads && configOptions.singleThreaded !== true && parallelParse.spawn !== undefined) {
      // Threads parse and bind the program's files ahead of it (parallel-parse.ts), as for plain
      // compiles. Here also when the program is checked on this thread, with one checker or after a
      // change with old build info, whose program is parsed in full all the same. The
      // program's FileLoader takes the files they prepared and the resolutions found loading them.
      // Declaration files that earlier projects of the build parsed come from the build's cache,
      // and parse threads don't load them again.
      const libraryDirectory = getNormalizedAbsolutePath(sys.defaultLibraryPath, sys.currentDirectory);
      const session = new ParseSession(
        run.parseThreads,
        configOptions,
        sys.currentDirectory,
        task.config,
        config.fileNames.length > 0,
        (kind, name) =>
          buildSourceFileNames.has(kind === LoadKind.Library ? combinePaths(libraryDirectory, name) : name),
      );
      session.start(config.fileNames, () => {
        // The program takes the resolutions the threads found, as `tsc -p` does, and is loaded
        // again resolving every file itself only where their `package.json` lookups may miss some
        // of its own (`hasAllPackageJsonLookups`), which the build info lists.
        let program = new Program(config, host, new FileLoader(host, config));
        if (!program.hasAllPackageJsonLookups()) {
          const loader = new FileLoader(host, config);
          loader.takesPreparedResolutions = false;
          program = new Program(config, host, loader);
        }
        reportPreparedFiles(program.getSourceFiles().map((f) => f.fileName));
        if (!this.checkAndEmit(task, program, parseStart, times, oldSnapshot, mayUseThreads, then)) then();
      });
      return true;
    }
    return this.checkAndEmit(task, new Program(config, host), parseStart, times, oldSnapshot, mayUseThreads, then);
  }

  /**
   * Binds and checks `program`, the program of `task` parsed from `parseStart` on, and emits it;
   * returns whether checker threads check it, and then calls `then` once it is emitted.
   */
  private checkAndEmit(
    task: BuildTask,
    program: Program,
    parseStart: number,
    times: CompileTimes,
    oldSnapshot: Snapshot | undefined,
    mayUseThreads: boolean,
    then: () => void,
  ): boolean {
    times.parseTime = performance.now() - parseStart;
    const bindStart = performance.now();
    const checked = new CheckedProgram(program);
    // The project's incremental program, made after checking, keeps the globals found checking a file
    // with the file.
    checked.globalsInFileDiagnostics = true;
    times.bindTime = performance.now() - bindStart;
    const options = program.options;
    const count = mayUseThreads ? checkerThreads(options.checkers, options.singleThreaded, program) : 1;
    // The run's configuration reports the count that checks: a checker thread run decides again once
    // the plan is made (`startParallelCheck`, run-config.ts).
    if (task.run !== undefined) task.run.checkers = count;
    if (count > 1 && oldSnapshot !== undefined) {
      if (isIncremental(options)) return this.recheckOnThreads(task, checked, times, oldSnapshot, count, then);
      // Build info of a project that is no longer incremental has no pending emit to give the threads,
      // and every file is emitted again: this thread checks and emits, as before the threads checked
      // rebuilds.
      this.emitAndReport(task, checked, times, oldSnapshot, undefined);
      return false;
    }
    if (count > 1) {
      // Checker threads also emit the files they check; the incremental program records their
      // declaration signatures on this thread.
      startParallelCheck(
        checked,
        count,
        (checkTime) => {
          this.emitAndReport(task, checked, times, oldSnapshot, checkTime);
          then();
        },
        true,
        undefined,
        true,
        undefined,
        undefined,
        task.run,
      );
      return true;
    }
    if (mayUseThreads && this.emitsOnThreads(checked, oldSnapshot))
      return this.checkWhileThreadsEmit(task, checked, times, oldSnapshot, then);
    this.emitAndReport(task, checked, times, oldSnapshot, undefined);
    return false;
  }

  /**
   * Whether `checkWhileThreadsEmit` builds the project of `checked`: one whose emit threads apply
   * (`emitsOnThreads`), that emits every file (one without old build info, or one that is not incremental)
   * and that emits enough for the threads (`emitThreads`).
   */
  private emitsOnThreads(checked: CheckedProgram, oldSnapshot: Snapshot | undefined): boolean {
    const options = checked.program.options;
    return (
      emitsOnThreads(options) &&
      (oldSnapshot === undefined || !isIncremental(options)) &&
      emitThreads(checked.program, options.singleThreaded) > 0
    );
  }

  /**
   * The rest of `checkAndEmit` with one checker for a project that `emitsOnThreads` accepts, as `tsc -p` compiles
   * (`compileWithEmitThreads`, tsc-compile.ts): this thread checks the program while emit threads emit its
   * JavaScript, and the declaration thread its declarations where that pays (parallel-emit.ts). Where its pending
   * emit leaves too little JavaScript for the threads (`emitDeclarationOnly`), this thread checks and emits it.
   * Returns whether the threads emit, and then calls `then` once the project is emitted.
   */
  private checkWhileThreadsEmit(
    task: BuildTask,
    checked: CheckedProgram,
    times: CompileTimes,
    oldSnapshot: Snapshot | undefined,
    then: () => void,
  ): boolean {
    const program = checked.program;
    const options = program.options;
    // The program is shared before its checker does more than merge the globals.
    shareWithCheckers(checked);
    const incrementalProgram = this.incrementalProgramOf(task, checked, times, oldSnapshot);
    const emitKinds = emitKindsOf(incrementalProgram);
    const threads = emitThreads(program, options.singleThreaded, emitKinds);
    if (threads === 0) {
      this.emitAndReport(task, checked, times, oldSnapshot, undefined, incrementalProgram);
      return false;
    }
    checkWhileThreadsEmit(incrementalProgram, threads, emitKinds, (diagnostics) => {
      this.emitAndReport(task, checked, times, oldSnapshot, undefined, incrementalProgram, diagnostics);
      then();
    });
    return true;
  }

  /**
   * The rest of `checkAndEmit` for a project with old build info on checker threads, as `tsc -p` rebuilds
   * (`recheckInParallel`, tsc-compile.ts): the program is shared with the threads first, then the
   * incremental program finds the files the change affects, and the threads check them when they are
   * many enough (`rechecksOnThreads`). They also emit them; for a composite program they hold the outputs, and
   * this thread writes them without its unchanged declaration files (`skipDtsOutputOfComposite`). Returns
   * whether the threads check, and then calls `then` once the project is emitted.
   */
  private recheckOnThreads(
    task: BuildTask,
    checked: CheckedProgram,
    times: CompileTimes,
    oldSnapshot: Snapshot,
    count: number,
    then: () => void,
  ): boolean {
    // The program is shared before its checker does more than merge the globals.
    if (sharesPublishedGraphs) shareWithCheckers(checked);
    const incrementalProgram = this.incrementalProgramOf(task, checked, times, oldSnapshot);
    const options = checked.program.options;
    // Reporting checks only programs without syntactic, program and global errors (getDiagnosticsOfProgram).
    if (
      !sharesPublishedGraphs ||
      options.listFilesOnly === true ||
      incrementalProgram.getSyntacticDiagnostics().length > 0 ||
      incrementalProgram.getProgramDiagnostics().length > 0 ||
      incrementalProgram.getGlobalDiagnostics(false).length > 0
    ) {
      this.emitAndReport(task, checked, times, oldSnapshot, undefined, incrementalProgram);
      return false;
    }
    const files = incrementalProgram.filesForCheckers();
    if (!rechecksOnThreads(files, count, options.checkers !== undefined)) {
      this.emitAndReport(task, checked, times, oldSnapshot, undefined, incrementalProgram);
      return false;
    }
    checked.checkOnly = new Set(files);
    startParallelCheck(
      checked,
      count,
      (checkTime) => {
        this.emitAndReport(task, checked, times, oldSnapshot, checkTime, incrementalProgram);
        then();
      },
      true,
      incrementalProgram.emitKindsOnCheckers(files),
      incrementalProgram.checksOnCheckers,
      undefined,
      undefined,
      task.run,
    );
    return true;
  }

  /** The incremental program of `task`'s checked program and its old build info. */
  private incrementalProgramOf(
    task: BuildTask,
    checked: CheckedProgram,
    times: CompileTimes,
    oldSnapshot: Snapshot | undefined,
  ): IncrementalProgram {
    const changesStart = performance.now();
    const incrementalProgram = new IncrementalProgram(checked, times, oldSnapshot, new SystemTimeStamps(this.sys));
    times.changesComputeTime = performance.now() - changesStart;
    task.program = incrementalProgram;
    return incrementalProgram;
  }

  /** Emits and reports `task`'s checked program, the rest of `compileAndEmit`. */
  private emitAndReport(
    task: BuildTask,
    checked: CheckedProgram,
    times: CompileTimes,
    oldSnapshot: Snapshot | undefined,
    /** The wall time of checker threads that checked the program, as reported. */
    parallelCheckTime: number | undefined,
    /** The incremental program, where `recheckOnThreads` or `checkWhileThreadsEmit` made it. */
    made?: IncrementalProgram,
    /** The program's diagnostics, where `checkWhileThreadsEmit` collected them. */
    diagnostics?: Diagnostic[],
  ): void {
    const resolved = task.resolved!;
    const sys = this.sys;
    const program = checked.program;
    const incrementalProgram = made ?? this.incrementalProgramOf(task, checked, times, oldSnapshot);

    const reporter = new TaskDiagnosticReporter(task, this.reporter, sys, this.locale);
    const summary = new QuietSummary(sys, {}, this.locale);
    const writer = new TaskWriter(this, task);
    const result =
      diagnostics === undefined
        ? emitFilesAndReportErrors(sys, incrementalProgram, reporter, summary, writer, this.locale)
        : reportEmitAndErrors(sys, incrementalProgram, diagnostics, reporter, summary, writer, this.locale);
    task.exitStatus = exitStatusOf(result);
    if (parallelCheckTime !== undefined) times.checkTime = parallelCheckTime;
    const options = program.options;
    if (options.diagnostics === true || options.extendedDiagnostics === true) {
      times.totalTime = sys.sinceStart();
      const statistics = statisticsOf(incrementalProgram);
      statistics.report(sys);
      const records = saveRunRecord(sys, incrementalProgram, task.run);
      if (options.extendedDiagnostics === true && task.run !== undefined) reportRunConfig(sys, task.run, records);
      task.statistics = statistics;
    }
    const status = task.status;
    if (
      (options.noEmitOnError !== true || result.diagnostics.length === 0) &&
      (result.emitResult.emittedFiles.length > 0 ||
        status === undefined ||
        status.kind !== Status.OutOfDateBuildInfoWithErrors)
    ) {
      this.updateTimeStamps(
        task,
        result.emitResult.emittedFiles,
        Diagnostics.Updating_unchanged_output_timestamps_of_project_0,
      );
    }
    task.buildKind = BuildKind.Program;
    if (
      task.exitStatus === ExitStatus.DiagnosticsPresent_OutputsSkipped ||
      task.exitStatus === ExitStatus.DiagnosticsPresent_OutputsGenerated
    ) {
      task.status = new UpToDateStatus(Status.BuildErrors);
    } else {
      const emitted = result.emitResult.emittedFiles;
      const outputs = getOutputFileNames(resolved);
      const oldest = emitted.length > 0 ? emitted[0] : outputs.length > 0 ? outputs[0] : '';
      task.status = new UpToDateStatus(Status.UpToDate, oldest);
    }
  }

  private handleStatusThatDoesntRequireBuild(task: BuildTask): boolean {
    const status = task.status;
    if (status === undefined) return false;
    switch (status.kind) {
      case Status.UpToDate:
        if (this.dry) this.status.report(Diagnostics.Project_0_is_up_to_date, task.config);
        return true;
      case Status.UpstreamErrors:
        if (this.verbose) {
          this.status.report(
            status.refHasUpstreamErrors
              ? Diagnostics.Skipping_build_of_project_0_because_its_dependency_1_was_not_built
              : Diagnostics.Skipping_build_of_project_0_because_its_dependency_1_has_errors,
            this.relativeFileName(task.config),
            this.relativeFileName(status.name),
          );
        }
        return true;
      case Status.Solution:
        return true;
      case Status.ConfigFileNotFound:
        this.reportDiagnostic(task, createCompilerDiagnostic(Diagnostics.File_0_not_found, task.config));
        return true;
    }
    if (status.isPseudoBuild()) {
      if (this.dry) {
        this.status.report(Diagnostics.A_non_dry_build_would_update_timestamps_for_output_of_project_0, task.config);
        task.status = new UpToDateStatus(Status.UpToDate);
        return true;
      }
      this.updateTimeStamps(task, [], Diagnostics.Updating_output_timestamps_of_project_0);
      task.status = new UpToDateStatus(
        Status.UpToDate,
        status.name,
        status.input,
        status.output,
        status.newestInput,
        status.oldestOutput,
      );
      task.buildKind = BuildKind.Pseudo;
      return true;
    }
    if (this.dry) {
      this.status.report(Diagnostics.A_non_dry_build_would_build_project_0, task.config);
      task.status = new UpToDateStatus(Status.UpToDate);
      return true;
    }
    return false;
  }

  private getUpToDateStatus(task: BuildTask): UpToDateStatus {
    const resolved = task.resolved;
    if (resolved === undefined) return new UpToDateStatus(Status.ConfigFileNotFound);
    if (resolved.fileNames.length === 0 && resolved.projectReferences.length > 0) {
      return new UpToDateStatus(Status.Solution);
    }
    for (const upstream of task.upStream) {
      const upstreamStatus = upstream.task.status;
      if (this.stopBuildOnErrors && upstreamStatus !== undefined && upstreamStatus.isError()) {
        const reference = resolved.projectReferences[upstream.refIndex];
        return new UpToDateStatus(
          Status.UpstreamErrors,
          reference === undefined ? '' : reference.path,
          '',
          '',
          undefined,
          undefined,
          upstreamStatus.kind === Status.UpstreamErrors,
        );
      }
    }
    if (this.force) return new UpToDateStatus(Status.ForceBuild);

    const options = resolved.options;
    const buildInfoPath = resolved.buildInfoFileName();
    const buildInfoDirectory = getDirectoryPath(getNormalizedAbsolutePath(buildInfoPath, this.sys.currentDirectory));
    const entry = this.loadOrStoreBuildInfo(task, buildInfoPath);
    const buildInfo = entry.buildInfo;
    if (buildInfo === undefined) return new UpToDateStatus(Status.OutputMissing, buildInfoPath);
    if (!buildInfo.isValidVersion()) return new UpToDateStatus(Status.TsVersionOutputOfDate, buildInfo.version);
    if (buildInfo.errors || (options.noCheck !== true && (buildInfo.semanticErrors || buildInfo.checkPending))) {
      return new UpToDateStatus(Status.OutOfDateBuildInfoWithErrors, buildInfoPath);
    }
    if (isIncremental(options)) {
      if (!buildInfo.isIncremental()) return new UpToDateStatus(Status.OutOfDateOptions, buildInfoPath);
      if (
        (getEmitDeclarations(options) && buildInfo.emitDiagnosticsPerFile.length > 0) ||
        (options.noCheck !== true &&
          (buildInfo.changeFileSet.length > 0 || buildInfo.semanticDiagnosticsPerFile.length > 0))
      ) {
        return new UpToDateStatus(Status.OutOfDateBuildInfoWithErrors, buildInfoPath);
      }
      if (
        options.noEmit !== true &&
        (buildInfo.changeFileSet.length > 0 || buildInfo.affectedFilesPendingEmit.length > 0)
      ) {
        return new UpToDateStatus(Status.OutOfDateBuildInfoWithPendingEmit, buildInfoPath);
      }
      if (buildInfo.isEmitPending(options, buildInfoDirectory)) {
        return new UpToDateStatus(Status.OutOfDateOptions, buildInfoPath);
      }
    }

    let inputTextUnchanged = false;
    let oldestOutput = new FileAndTime(buildInfoPath, entry.mTime);
    let newestInput = new FileAndTime('', undefined);
    const seenRoots = new Set<string>();
    const rootReader = buildInfo.getRootInfoReader(buildInfoDirectory, this.sys.useCaseSensitiveFileNames);
    for (const inputFile of resolved.fileNames) {
      const inputTime = this.getMTime(inputFile);
      if (inputTime === undefined) return new UpToDateStatus(Status.InputFileMissing, inputFile);
      const inputPath = this.toPath(inputFile);
      if (after(inputTime, oldestOutput.time)) {
        let fileVersion = '';
        let currentVersion = '';
        if (buildInfo.isIncremental()) {
          const found = rootReader.getFileInfo(inputPath);
          const info = found.info;
          if (info !== undefined) {
            const fileInfo = fileInfoFromBuildInfo(info);
            if (fileInfo.version !== '') {
              fileVersion = fileInfo.version;
              const text = this.sys.readFile(found.resolved);
              if (text !== undefined) {
                currentVersion = computeHash(text);
                if (fileVersion === currentVersion) inputTextUnchanged = true;
              }
            }
          }
        }
        if (fileVersion === '' || fileVersion !== currentVersion) return inputNewer(inputFile, buildInfoPath);
      }
      if (after(inputTime, newestInput.time)) newestInput = new FileAndTime(inputFile, inputTime);
      seenRoots.add(inputPath);
    }
    for (const root of rootReader.roots()) {
      if (!seenRoots.has(root)) return new UpToDateStatus(Status.OutOfDateRoots, '', root, buildInfoPath);
    }

    if (buildInfo.isIncremental()) {
      const resolvedRoots = new Set<string>();
      for (const root of rootReader.roots()) {
        const found = rootReader.getFileInfo(root);
        if (found.resolved !== '') resolvedRoots.add(found.resolved);
      }
      for (let index = 0; index < buildInfo.fileInfos.length; index++) {
        if (index >= buildInfo.fileNames.length) break;
        const buildInfoFileName = buildInfo.fileNames[index];
        if (isBuildInfoFileNameDefaultLibrary(buildInfoFileName)) continue;
        const inputFile = getNormalizedAbsolutePath(buildInfoFileName, buildInfoDirectory);
        const inputPath = this.toPath(inputFile);
        if (seenRoots.has(inputPath) || resolvedRoots.has(inputPath)) continue;
        const inputTime = this.getMTime(inputFile);
        if (inputTime === undefined) return new UpToDateStatus(Status.InputFileMissing, inputFile);
        if (after(inputTime, oldestOutput.time)) {
          let currentVersion = '';
          const fileVersion = fileInfoFromBuildInfo(buildInfo.fileInfos[index]).version;
          if (fileVersion !== '') {
            const text = this.sys.readFile(inputFile);
            if (text !== undefined) currentVersion = computeHash(text);
          }
          if (fileVersion === '' || fileVersion !== currentVersion) return inputNewer(inputFile, buildInfoPath);
          inputTextUnchanged = true;
        }
      }
    }

    if (!isIncremental(options)) {
      for (const outputFile of getOutputFileNames(resolved)) {
        const outputTime = this.getMTime(outputFile);
        if (outputTime === undefined) return new UpToDateStatus(Status.OutputMissing, outputFile);
        if (after(newestInput.time, outputTime)) return inputNewer(newestInput.file, outputFile);
        if (after(oldestOutput.time, outputTime)) oldestOutput = new FileAndTime(outputFile, outputTime);
      }
    }

    let refDtsUnchanged = false;
    for (const upstream of task.upStream) {
      const upstreamStatus = upstream.task.status;
      if (upstreamStatus === undefined || upstreamStatus.kind === Status.Solution) continue;
      const refInput = upstreamStatus.newestInput;
      if (refInput !== undefined && refInput.time !== undefined && after(oldestOutput.time, refInput.time)) {
        continue;
      }
      const reference = resolved.projectReferences[upstream.refIndex];
      const referencePath = reference === undefined ? '' : reference.path;
      if (this.hasConflictingBuildInfo(task, upstream.task)) return inputNewer(referencePath, oldestOutput.file);
      const newestDtsChangeTime = this.getLatestChangedDtsMTime(upstream.task);
      if (newestDtsChangeTime !== undefined && after(oldestOutput.time, newestDtsChangeTime)) {
        refDtsUnchanged = true;
        continue;
      }
      return inputNewer(referencePath, oldestOutput.file);
    }

    const configStatus = this.checkInputFileTime(task.config, oldestOutput);
    if (configStatus !== undefined) return configStatus;
    const configFile = resolved.configFile;
    if (configFile !== undefined) {
      for (const extendedConfig of configFile.extendedSourceFiles) {
        const status = this.checkInputFileTime(extendedConfig, oldestOutput);
        if (status !== undefined) return status;
      }
    }
    for (const packageJson of buildInfo.getPackageJsons(buildInfoDirectory)) {
      const packageJsonTime = this.getMTime(packageJson);
      if (packageJsonTime === undefined) return new UpToDateStatus(Status.InputFileMissing, packageJson);
      if (after(packageJsonTime, oldestOutput.time)) return inputNewer(packageJson, oldestOutput.file);
    }
    for (const packageJson of buildInfo.getMissingPackageJsons(buildInfoDirectory)) {
      if (this.getMTime(packageJson) !== undefined) return inputNewer(packageJson, oldestOutput.file);
    }
    return new UpToDateStatus(
      refDtsUnchanged
        ? Status.UpToDateWithUpstreamTypes
        : inputTextUnchanged
          ? Status.UpToDateWithInputFileText
          : Status.UpToDate,
      buildInfoPath,
      '',
      '',
      newestInput,
      oldestOutput,
    );
  }

  private checkInputFileTime(inputFile: string, oldestOutput: FileAndTime): UpToDateStatus | undefined {
    const inputTime = this.getMTime(inputFile);
    if (after(inputTime, oldestOutput.time)) return inputNewer(inputFile, oldestOutput.file);
    return undefined;
  }

  private reportUpToDateStatus(task: BuildTask): void {
    const status = task.status;
    if (!this.verbose || status === undefined) return;
    const config = this.relativeFileName(task.config);
    switch (status.kind) {
      case Status.ConfigFileNotFound:
        this.status.report(Diagnostics.Project_0_is_out_of_date_because_config_file_does_not_exist, config);
        break;
      case Status.UpstreamErrors:
        this.status.report(
          status.refHasUpstreamErrors
            ? Diagnostics.Project_0_can_t_be_built_because_its_dependency_1_was_not_built
            : Diagnostics.Project_0_can_t_be_built_because_its_dependency_1_has_errors,
          config,
          this.relativeFileName(status.name),
        );
        break;
      case Status.BuildErrors:
        this.status.report(Diagnostics.Project_0_is_out_of_date_because_it_has_errors, config);
        break;
      case Status.UpToDate: {
        const newest = status.newestInput;
        const oldest = status.oldestOutput;
        if (newest !== undefined && oldest !== undefined) {
          this.status.report(
            Diagnostics.Project_0_is_up_to_date_because_newest_input_1_is_older_than_output_2,
            config,
            this.relativeFileName(newest.file),
            this.relativeFileName(oldest.file),
          );
        }
        break;
      }
      case Status.UpToDateWithUpstreamTypes:
        this.status.report(Diagnostics.Project_0_is_up_to_date_with_d_ts_files_from_its_dependencies, config);
        break;
      case Status.UpToDateWithInputFileText:
        this.status.report(
          Diagnostics.Project_0_is_up_to_date_but_needs_to_update_timestamps_of_output_files_that_are_older_than_input_files,
          config,
        );
        break;
      case Status.InputFileMissing:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_input_1_does_not_exist,
          config,
          this.relativeFileName(status.name),
        );
        break;
      case Status.OutputMissing:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_output_file_1_does_not_exist,
          config,
          this.relativeFileName(status.name),
        );
        break;
      case Status.InputFileNewer:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_output_1_is_older_than_input_2,
          config,
          this.relativeFileName(status.output),
          this.relativeFileName(status.input),
        );
        break;
      case Status.OutOfDateBuildInfoWithPendingEmit:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_buildinfo_file_1_indicates_that_some_of_the_changes_were_not_emitted,
          config,
          this.relativeFileName(status.name),
        );
        break;
      case Status.OutOfDateBuildInfoWithErrors:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_buildinfo_file_1_indicates_that_program_needs_to_report_errors,
          config,
          this.relativeFileName(status.name),
        );
        break;
      case Status.OutOfDateOptions:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_buildinfo_file_1_indicates_there_is_change_in_compilerOptions,
          config,
          this.relativeFileName(status.name),
        );
        break;
      case Status.OutOfDateRoots:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_buildinfo_file_1_indicates_that_file_2_was_root_file_of_compilation_but_not_any_more,
          config,
          this.relativeFileName(status.output),
          this.relativeFileName(status.input),
        );
        break;
      case Status.TsVersionOutputOfDate:
        this.status.report(
          Diagnostics.Project_0_is_out_of_date_because_output_for_it_was_generated_with_version_1_that_differs_with_current_version_2,
          config,
          this.relativeFileName(status.name),
          version,
        );
        break;
      case Status.ForceBuild:
        this.status.report(Diagnostics.Project_0_is_being_forcibly_rebuilt, config);
        break;
      case Status.Solution:
        break;
    }
  }

  private updateTimeStamps(task: BuildTask, emittedFiles: readonly string[], verboseMessage: DiagnosticMessage): void {
    const resolved = task.resolved;
    if (resolved === undefined) return;
    const emitted = new Set(emittedFiles);
    let reported = false;
    const buildInfoName = resolved.buildInfoFileName();
    const now = Date.now();
    const update = (file: string): void => {
      if (emitted.has(file)) return;
      if (!reported && this.verbose) {
        this.status.report(verboseMessage, this.relativeFileName(task.config));
        reported = true;
      }
      if (this.setMTime(file, now) && file === buildInfoName) {
        const entry = task.buildInfoEntry;
        if (entry !== undefined) entry.mTime = now;
      }
    };
    if (resolved.options.noEmit !== true && !isIncremental(resolved.options)) {
      for (const outputFile of getOutputFileNames(resolved)) update(outputFile);
    }
    update(buildInfoName);
  }

  private cleanProject(task: BuildTask): void {
    const resolved = task.resolved;
    if (resolved === undefined) {
      this.reportDiagnostic(task, createCompilerDiagnostic(Diagnostics.File_0_not_found, task.config));
      task.exitStatus = ExitStatus.DiagnosticsPresent_OutputsSkipped;
      return;
    }
    const inputs = new Set(resolved.fileNames.map((f) => this.toPath(f)));
    for (const outputFile of getOutputFileNames(resolved)) this.cleanProjectOutput(task, outputFile, inputs);
    this.cleanProjectOutput(task, resolved.buildInfoFileName(), inputs);
  }

  private cleanProjectOutput(task: BuildTask, outputFile: string, inputs: ReadonlySet<string>): void {
    if (inputs.has(this.toPath(outputFile))) return;
    if (!this.sys.fileExists(outputFile)) return;
    if (this.dry) task.filesToDelete.push(outputFile);
    else if (!this.sys.removeFile(outputFile)) {
      this.reportDiagnostic(task, createCompilerDiagnostic(Diagnostics.Failed_to_delete_file_0, outputFile));
    }
  }

  loadOrStoreBuildInfo(task: BuildTask, buildInfoFileName: string): BuildInfoEntry {
    const path = this.toPath(buildInfoFileName);
    const existing = task.buildInfoEntry;
    if (existing !== undefined && existing.path === path) return existing;
    const resolved = task.resolved;
    let buildInfo: BuildInfo | undefined = undefined;
    if (resolved !== undefined) {
      const fileName = resolved.buildInfoFileName();
      const text = fileName === '' ? undefined : this.sys.readFile(fileName);
      if (text !== undefined) buildInfo = parseBuildInfo(text);
    }
    const entry = new BuildInfoEntry(
      buildInfo,
      path,
      buildInfo !== undefined ? this.getMTime(buildInfoFileName) : undefined,
      undefined,
      false,
    );
    task.buildInfoEntry = entry;
    return entry;
  }

  onBuildInfoEmit(
    task: BuildTask,
    buildInfoFileName: string,
    buildInfo: BuildInfo | undefined,
    hasChangedDtsFile: boolean,
  ): void {
    const now = Date.now();
    let dtsTime: number | undefined = undefined;
    let dtsTimeKnown = false;
    const existing = task.buildInfoEntry;
    if (hasChangedDtsFile) {
      dtsTime = now;
      dtsTimeKnown = true;
    } else if (existing !== undefined) {
      dtsTime = existing.dtsTime;
      dtsTimeKnown = existing.dtsTimeKnown;
    }
    task.buildInfoEntry = new BuildInfoEntry(buildInfo, this.toPath(buildInfoFileName), now, dtsTime, dtsTimeKnown);
  }

  private hasConflictingBuildInfo(task: BuildTask, upstream: BuildTask): boolean {
    const entry = task.buildInfoEntry;
    const upstreamEntry = upstream.buildInfoEntry;
    return entry !== undefined && upstreamEntry !== undefined && entry.path === upstreamEntry.path;
  }

  private getLatestChangedDtsMTime(task: BuildTask): number | undefined {
    const entry = task.buildInfoEntry;
    if (entry === undefined) return undefined;
    if (entry.dtsTimeKnown) return entry.dtsTime;
    const buildInfo = entry.buildInfo;
    const latest = buildInfo === undefined ? '' : buildInfo.latestChangedDtsFile;
    const dtsTime = this.getMTime(getNormalizedAbsolutePath(latest, getDirectoryPath(entry.path)));
    entry.dtsTime = dtsTime;
    entry.dtsTimeKnown = true;
    return dtsTime;
  }
}

function resolveProjectReferencePathOf(path: string): string {
  return fileExtensionIs(path, '.json') ? path : combinePaths(path, 'tsconfig.json');
}

/** Runs `tsc --build`; returns the exit status. */
export function build(sys: System, command: ParsedBuildCommandLine): ExitStatus {
  return new Orchestrator(sys, command).start();
}

/**
 * Runs `tsc --build` like `build`, checking programs on checker threads where every file is
 * checked: returns the exit status, or `undefined` when the build goes on on this thread's event
 * loop and `done` gets it.
 */
export function buildWithThreads(
  sys: System,
  command: ParsedBuildCommandLine,
  done: (status: ExitStatus) => void,
): ExitStatus | undefined {
  // Programs shared with checker threads get their symbol ids when the symbols are created.
  if (sharesPublishedGraphs && command.compilerOptions.singleThreaded !== true) assignSymbolIdsAtCreation();
  let status: ExitStatus | undefined;
  let deferred = false;
  deferred = new Orchestrator(sys, command).startWithThreads((s) => {
    if (deferred) done(s);
    else status = s;
  });
  return deferred ? undefined : status;
}

/** A copy of `config` with its own lazily computed parts and errors. */
function copyCommandLine(config: ParsedCommandLine): ParsedCommandLine {
  return new ParsedCommandLine(
    config.options,
    config.typeAcquisition,
    config.fileNames,
    config.projectReferences,
    config.configFile,
    config.errors.slice(),
    config.currentDirectory,
    config.useCaseSensitiveFileNames,
    config.literalFileNamesLength,
  );
}

/** The totals of a build, gathered project by project. */
class BuildState {
  status = ExitStatus.Success;
  errors: Diagnostic[] = [];
  readonly statistics = new Statistics();
  readonly filesToDelete: string[] = [];
}
