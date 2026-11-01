/**
 * The `tsc` command line up to binding: argument errors, `--init`, `--version`, `--help`, project lookup,
 * tsconfig.json, `--showConfig`, program construction and `--listFilesOnly`.
 */
import { mark } from './timeline.js';
import { FileBuildInfoReader, readBuildInfoProgram, type Snapshot } from './incremental.js';
import {
  createCompilerDiagnostic,
  Diagnostics,
  formatDiagnostic,
  formatDiagnostics,
  formatDiagnosticWithColorAndContext,
  formatErrorSummary,
  localizeMessage,
  parseLocale,
  type Diagnostic,
  type DiagnosticFormatOptions,
  type Locale,
  type MessageWithArgs,
} from './diagnostics.js';
import { CompilerHost, FileLoader, releaseLater } from './file-loader.js';
import { CachedFileSystem, FileSystem, type DirectoryEntries } from './file-system.js';
import { Program, sortAndDeduplicateDiagnostics } from './program.js';
import { ConfigParser, ParsedCommandLine as ProjectConfig } from './tsconfig.js';
import {
  CommandLineHost,
  parseBuildCommandLine,
  parseCommandLine,
  type ParsedBuildCommandLine,
  type ParsedCommandLine,
} from './command-line.js';
import { Colors, defaultIsPretty, header, printBuildHelp, printHelp, printVersion } from './help.js';
import { generateTSConfig } from './init.js';
import { isIncremental, type CompilerOptions } from './options.js';
import { combinePaths, getDirectoryPath, normalizePath } from './path.js';
import { checkerThreads } from './parallel-check.js';
import { ParseSession, parallelParse, reportPreparedFiles } from './parallel-parse.js';
import { preParseConfig, type RunConfig } from './run-config.js';
import { showConfig, type ShowConfigInput } from './show-config.js';
import { assignSymbolIdsAtCreation } from './symbol.js';
import { sharesPublishedGraphs } from '@scriptc/threads';

export enum ExitStatus {
  Success = 0,
  DiagnosticsPresent_OutputsSkipped = 1,
  DiagnosticsPresent_OutputsGenerated = 2,
  InvalidProject_OutputsSkipped = 3,
  ProjectReferenceCycle_OutputsSkipped = 4,
  NotImplemented = 5,
}

/** The process environment `tsc` runs in. All output goes to `write`. */
export abstract class System extends CommandLineHost {
  constructor(
    currentDirectory: string,
    readonly writeOutputIsTTY: boolean,
    /** Columns of the output terminal; `0` when not a terminal. */
    readonly terminalWidth: number,
    readonly useCaseSensitiveFileNames: boolean,
    /** Where the bundled `lib.*.d.ts` files are. */
    readonly defaultLibraryPath: string,
  ) {
    super(currentDirectory);
  }

  /** Returns `''` for unset variables. */
  abstract getEnvironmentVariable(name: string): string;
  /** Whether the variable is set, perhaps to `''`. */
  abstract hasEnvironmentVariable(name: string): boolean;
  abstract write(text: string): void;
  abstract fileExists(path: string): boolean;
  abstract directoryExists(path: string): boolean;
  abstract writeFile(path: string, text: string): boolean;
  /** Sorted entries of a directory; empty if it can't be read. */
  abstract getAccessibleEntries(path: string): DirectoryEntries;
  /** The path with symlinks resolved, or `path` itself if it does not exist. */
  abstract realpath(path: string): string;
  /** Modification time in milliseconds, or `undefined` if the file doesn't exist. */
  abstract getMTime(path: string): number | undefined;
  abstract setMTime(path: string, time: number): boolean;
  abstract removeFile(path: string): boolean;
  /**
   * Calls `onChange` when the directory or a file in it changes, until the watch is closed. Undefined
   * if the directory can't be watched, or where watching a directory doesn't report writes to its
   * files.
   */
  abstract watchDirectory(path: string, onChange: () => void): DirectoryWatch | undefined;

  private readonly startTime = performance.now();

  /** Milliseconds since the system was created. */
  sinceStart(): number {
    return performance.now() - this.startTime;
  }
}

/** A watch of `System.watchDirectory`. */
export interface DirectoryWatch {
  close(): void;
}

/** The file system of a `System`. */
/** The old state from an incremental program's build info (`readBuildInfoProgram`), and the time reading it took. */
export class EarlyBuildInfo {
  constructor(
    readonly snapshot: Snapshot | undefined,
    readonly readTime: number,
  ) {}
}

export class SystemFileSystem extends FileSystem {
  constructor(private readonly sys: System) {
    super(sys.useCaseSensitiveFileNames);
  }

  fileExists(path: string): boolean {
    return this.sys.fileExists(path);
  }

  directoryExists(path: string): boolean {
    return this.sys.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    return this.sys.readFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    return this.sys.getAccessibleEntries(path);
  }

  realpath(path: string): string {
    return this.sys.realpath(path);
  }
}

/** A compiler host writing `--traceResolution` output to the system. */
class SystemCompilerHost extends CompilerHost {
  constructor(
    private readonly sys: System,
    fs: FileSystem,
    private readonly locale: Locale,
  ) {
    super(fs, sys.currentDirectory, sys.defaultLibraryPath);
  }

  trace(message: MessageWithArgs): void {
    this.sys.write(localizeMessage(this.locale, message.message, message.args) + '\n');
  }
}

/** How a `tsc` run ended, or the work left for the compiler. */
export type CommandLineResult =
  | { readonly kind: 'exit'; readonly status: ExitStatus }
  /** Bind, check and emit `program`, reporting with `reporter` and `errorSummary`. */
  | {
      readonly kind: 'compile';
      readonly program: Program;
      readonly incremental: boolean;
      /** Milliseconds spent reading the config and building the program. */
      readonly configTime: number;
      readonly parseTime: number;
      readonly reporter: DiagnosticReporter;
      readonly errorSummary: ErrorSummaryReporter;
      /** The build info of an incremental program, read while threads parsed its files; `undefined` if not read yet. */
      readonly buildInfo?: EarlyBuildInfo;
      /** How the run is configured: parse threads, checker count and sharing (run-config.ts). */
      readonly config: RunConfig;
    }
  /** Threads are preparing the program's files; `run` calls back with the result once they are done. */
  | { readonly kind: 'deferred'; readonly run: (done: (result: CommandLineResult) => void) => void }
  /** Watch the project of `config`. */
  | { readonly kind: 'watch'; readonly config: ProjectConfig; readonly commandLine: ParsedCommandLine }
  | { readonly kind: 'build'; readonly commandLine: ParsedBuildCommandLine };

function exit(status: ExitStatus): CommandLineResult {
  return { kind: 'exit', status };
}

/** Writes diagnostics in tsgo's plain or colored format, or nothing under `--quiet`. */
export class DiagnosticReporter {
  private readonly quiet: boolean;
  private readonly pretty: boolean;
  private readonly format: DiagnosticFormatOptions;

  constructor(
    private readonly sys: System,
    options: CompilerOptions,
    locale: Locale,
  ) {
    this.quiet = options.quiet === true;
    this.pretty = options.pretty ?? defaultIsPretty(sys);
    this.format = {
      locale,
      currentDirectory: sys.currentDirectory,
      useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
      newLine: '\n',
    };
  }

  report(diagnostic: Diagnostic): void {
    if (this.quiet) return;
    if (this.pretty) this.sys.write(formatDiagnosticWithColorAndContext(diagnostic, this.format) + '\n');
    else this.sys.write(formatDiagnostic(diagnostic, this.format));
  }

  /** The format `reportAll` writes diagnostics in, where it writes them plainly; undefined otherwise. */
  plainFormat(): DiagnosticFormatOptions | undefined {
    return this.quiet || this.pretty ? undefined : this.format;
  }

  /** Writes the diagnostics at once: a write for each costs more than formatting it. */
  reportAll(diagnostics: readonly Diagnostic[]): void {
    if (this.quiet || diagnostics.length === 0) return;
    if (!this.pretty) {
      this.sys.write(formatDiagnostics(diagnostics, this.format));
      return;
    }
    let text = '';
    for (const diagnostic of diagnostics) text += formatDiagnosticWithColorAndContext(diagnostic, this.format) + '\n';
    this.sys.write(text);
  }
}

/** Writes "Found N errors" after diagnostics under `--pretty`. */
export class ErrorSummaryReporter {
  private readonly pretty: boolean;
  private readonly format: DiagnosticFormatOptions;

  constructor(
    private readonly sys: System,
    options: CompilerOptions,
    locale: Locale,
  ) {
    this.pretty = options.pretty ?? defaultIsPretty(sys);
    this.format = {
      locale,
      currentDirectory: sys.currentDirectory,
      useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
      newLine: '\n',
    };
  }

  report(diagnostics: readonly Diagnostic[]): void {
    if (this.pretty) this.sys.write(formatErrorSummary(diagnostics, this.format));
  }
}

/** The language of messages and help: tsgo's choice of translation for `--locale`. */
export function outputLocale(options: CompilerOptions): Locale {
  return parseLocale(options.locale ?? '');
}

function isBuildFlag(arg: string): boolean {
  return arg === '-b' || arg === '--b' || arg === '-build' || arg === '--build';
}

/** Runs `tsc` with `args` (without the executable). */
export function executeCommandLine(sys: System, args: readonly string[]): CommandLineResult {
  if (args.length > 0) {
    const first = args[0].toLowerCase();
    if (isBuildFlag(first)) {
      return executeBuild(sys, parseBuildCommandLine(args, sys));
    }
  }
  return executeCompile(sys, parseCommandLine(args, sys));
}

function executeBuild(sys: System, commandLine: ParsedBuildCommandLine): CommandLineResult {
  const locale = outputLocale(commandLine.compilerOptions);
  const reporter = new DiagnosticReporter(sys, commandLine.compilerOptions, locale);
  if (commandLine.errors.length > 0) {
    reporter.reportAll(commandLine.errors);
    return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
  }
  if (commandLine.compilerOptions.help === true) {
    printVersion(sys, locale);
    printBuildHelp(sys, locale);
    return exit(ExitStatus.Success);
  }
  return { kind: 'build', commandLine };
}

function executeCompile(sys: System, commandLine: ParsedCommandLine): CommandLineResult {
  const options = commandLine.options;
  const locale = outputLocale(options);
  const reporter = new DiagnosticReporter(sys, options, locale);
  if (commandLine.errors.length > 0) {
    reporter.reportAll(commandLine.errors);
    return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
  }
  if (options.init === true) {
    writeConfigFile(sys, locale, reporter, commandLine);
    return exit(ExitStatus.Success);
  }
  if (options.version === true) {
    printVersion(sys, locale);
    return exit(ExitStatus.Success);
  }
  if (options.help === true || options.all === true) {
    printHelp(sys, locale, options.all === true);
    return exit(ExitStatus.Success);
  }
  if (options.watch === true && options.listFilesOnly === true) {
    reporter.report(createCompilerDiagnostic(Diagnostics.Options_0_and_1_cannot_be_combined, 'watch', 'listFilesOnly'));
    return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
  }

  const fileNames = commandLine.fileNames;
  let configFileName = '';
  if (options.project !== undefined) {
    if (fileNames.length !== 0) {
      reporter.report(
        createCompilerDiagnostic(Diagnostics.Option_project_cannot_be_mixed_with_source_files_on_a_command_line),
      );
      return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
    }
    const project = normalizePath(options.project);
    if (sys.directoryExists(project)) {
      configFileName = combinePaths(project, 'tsconfig.json');
      if (!sys.fileExists(configFileName)) {
        reporter.report(
          createCompilerDiagnostic(
            Diagnostics.Cannot_find_a_tsconfig_json_file_at_the_current_directory_Colon_0,
            configFileName,
          ),
        );
        return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
      }
    } else {
      configFileName = project;
      if (!sys.fileExists(configFileName)) {
        reporter.report(createCompilerDiagnostic(Diagnostics.The_specified_path_does_not_exist_Colon_0, project));
        return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
      }
    }
  } else if (options.ignoreConfig !== true || fileNames.length === 0) {
    const searchPath = normalizePath(sys.currentDirectory);
    configFileName = findConfigFile(sys, searchPath);
    if (fileNames.length !== 0) {
      if (configFileName !== '') {
        reporter.report(
          createCompilerDiagnostic(
            Diagnostics.X_tsconfig_json_is_present_but_will_not_be_loaded_if_files_are_specified_on_commandline_Use_ignoreConfig_to_skip_this_error,
          ),
        );
        return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
      }
    } else if (configFileName === '') {
      if (options.showConfig === true) {
        reporter.report(
          createCompilerDiagnostic(
            Diagnostics.Cannot_find_a_tsconfig_json_file_at_the_current_directory_Colon_0,
            searchPath,
          ),
        );
      } else {
        printVersion(sys, locale);
        printHelp(sys, locale, false);
      }
      return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
    }
  }

  const fs = new CachedFileSystem(new SystemFileSystem(sys));
  const configStart = performance.now();
  mark('config start');
  const errors: Diagnostic[] = [];
  // The run's configuration, made once the config's options are known: its parse threads are needed
  // before the first file is parsed.
  let run: RunConfig | undefined = undefined;
  const runConfigOf = (projectOptions: CompilerOptions): RunConfig =>
    (run ??= preParseConfig(projectOptions, checkerThreads(projectOptions.checkers, projectOptions.singleThreaded)));
  // Where threads parse and bind the program's files ahead of it (parallel-parse.ts), they start with
  // the libraries and the root files found so far while the config's `include` patterns are matched.
  let session: ParseSession | undefined = undefined;
  const beforeRootFiles = (projectOptions: CompilerOptions): ((fileName: string) => void) | undefined => {
    if (projectOptions.watch === true || options.showConfig === true || !parsesAhead(projectOptions)) return undefined;
    assignSymbolIdsAtCreation();
    const started = new ParseSession(
      runConfigOf(projectOptions).parseThreads,
      projectOptions,
      sys.currentDirectory,
      configFileName,
      true,
    );
    session = started;
    // JSON root files load with the program's own options only.
    return (fileName) => {
      if (!fileName.endsWith('.json')) started.hint(fileName);
    };
  };
  const config = readProjectConfig(sys, fs, commandLine, configFileName, errors, true, beforeRootFiles);
  if (config === undefined) {
    reporter.reportAll(errors);
    return exit(ExitStatus.DiagnosticsPresent_OutputsGenerated);
  }
  const early: ParseSession | undefined = session;

  // The summary follows `pretty` of the config; diagnostics only that of the command line, as in tsgo.
  const errorSummary = new ErrorSummaryReporter(sys, config.options, locale);
  if (options.showConfig === true) {
    sys.write(showConfig(showConfigInput(config, sys), configFileName));
    return exit(ExitStatus.Success);
  }
  const configTime = configFileName !== '' ? performance.now() - configStart : 0;
  mark(`config read, ${config.fileNames.length} root files`);
  if (config.options.watch === true) return { kind: 'watch', config, commandLine };

  const parseStart = performance.now();
  let buildInfo: EarlyBuildInfo | undefined = undefined;
  const createProgram = (
    host: CompilerHost = new SystemCompilerHost(sys, fs, locale),
    loader?: FileLoader,
  ): CommandLineResult => {
    mark('program start');
    const program = new Program(config, host, loader);
    mark(`program built, ${program.getSourceFiles().length} files`);
    const parseTime = performance.now() - parseStart;
    reportPreparedFiles(program.getSourceFiles().map((f) => f.fileName));
    // Statistics need checking and emit timings.
    const statistics = config.options.diagnostics === true || config.options.extendedDiagnostics === true;
    if (config.options.listFilesOnly === true && !statistics) {
      return exit(listFilesOnly(sys, program, locale, reporter, errorSummary));
    }
    return {
      kind: 'compile',
      program,
      incremental: isIncremental(config.options),
      configTime,
      parseTime,
      reporter,
      errorSummary,
      buildInfo,
      config: runConfigOf(config.options),
    };
  };
  if (parsesAhead(config.options)) {
    // Threads parse and bind the files the program is expected to load first (parallel-parse.ts), and
    // share the program it becomes: its symbols get their ids when they are created.
    assignSymbolIdsAtCreation();
    return {
      kind: 'deferred',
      run: (done: (result: CommandLineResult) => void) => {
        const session =
          early ??
          new ParseSession(
            runConfigOf(config.options).parseThreads,
            config.options,
            sys.currentDirectory,
            configFileName,
            config.fileNames.length > 0,
          );
        // While the threads load files, the program's first step (a task per root file, which looks
        // the file up) runs, and the program's loader takes the files they return as they come.
        const host = new SystemCompilerHost(sys, fs, locale);
        const loader = new FileLoader(host, config);
        let rootFilesAdded = false;
        // The build info lists the real paths of the `package.json` files module resolution looked up:
        // those of the threads' lookups are resolved here, into the file system's cache, rather than
        // when the build info is written.
        const resolvesPackageJsons = config.configName !== '' && config.buildInfoFileName() !== '';
        session.onIdle = (batch) => {
          if (!rootFilesAdded) rootFilesAdded = loader.addRootFiles(rootFilesPerChunk);
          loader.walkAhead(batch.files);
          if (resolvesPackageJsons) {
            const lookups = batch.packageJsons;
            for (let k = 0; k < lookups.directories.length; k++)
              if (lookups.exists[k]! || lookups.directoryExists[k]!)
                fs.realpath(combinePaths(lookups.directories[k]!, 'package.json'));
          }
        };
        session.start(config.fileNames, () => {
          let result = createProgram(host, loader);
          // The build info of an incremental program lists the `package.json` files its module
          // resolution looked up, which include the parse threads' lookups for the resolutions it
          // took. Where those may miss some (`preparedPackageJsonLookups`), the program is loaded
          // again, resolving every file's imports and references itself, as in build mode.
          if (
            result.kind === 'compile' &&
            isIncremental(config.options) &&
            !result.program.hasAllPackageJsonLookups()
          ) {
            const own = new FileLoader(host, config);
            own.takesPreparedResolutions = false;
            result = createProgram(host, own);
          }
          done(result);
          // The session's callbacks keep the loader: its tasks go once checking has started.
          releaseLater(loader);
        });
        // The build info of an incremental program is read while the threads parse: reading it needs
        // only the config (compile and recheckInParallel, tsc-compile.ts, take it from here).
        if (isIncremental(config.options)) {
          if (sys.fileExists(config.buildInfoFileName())) session.queueAhead();
          const readStart = performance.now();
          const snapshot = readBuildInfoProgram(
            config,
            new FileBuildInfoReader(new SystemFileSystem(sys)),
            sys.defaultLibraryPath,
            sys.currentDirectory,
          );
          buildInfo = new EarlyBuildInfo(snapshot, performance.now() - readStart);
          mark('build info read');
        }
      },
    };
  }
  // An incremental program without build info is shared with checker threads too (`compileThreads`).
  if (
    sharesPublishedGraphs &&
    isIncremental(config.options) &&
    checkerThreads(config.options.checkers, config.options.singleThreaded) > 1
  )
    assignSymbolIdsAtCreation();
  return createProgram();
}

/** Root file tasks the main thread adds each time a parse thread returns a chunk (`FileLoader.addRootFiles`). */
export const rootFilesPerChunk = 32;

/**
 * Whether threads parse and bind the files of a program with `options` ahead of it (parallel-parse.ts):
 * unless `--singleThreaded` is given, as tsgo parses on every core whatever its checker count. Also with
 * one checker, which checks on this thread, and for an incremental program with build info, whose
 * program is parsed in full all the same, as in build mode.
 */
function parsesAhead(options: CompilerOptions): boolean {
  return options.singleThreaded !== true && parallelParse.spawn !== undefined;
}

/**
 * Whether an incremental program with the build info file `buildInfoFileName` is checked in full on
 * checker threads (tsc-compile.ts): only where its build info file doesn't exist, so that every file is
 * checked.
 */
export function checksIncrementalOnThreads(sys: System, buildInfoFileName: string): boolean {
  return buildInfoFileName === '' || !sys.fileExists(buildInfoFileName);
}

/**
 * The project of a compile command line: the config `configFileName` read with the command line's
 * options, or the command line's files without a config (`configFileName` is `''`). `undefined`, with
 * `errors`, if the config cannot be read.
 */
function readProjectConfig(
  sys: System,
  fs: FileSystem,
  commandLine: ParsedCommandLine,
  configFileName: string,
  errors: Diagnostic[],
  expandFileNames = true,
  beforeRootFiles?: (options: CompilerOptions) => ((fileName: string) => void) | undefined,
): ProjectConfig | undefined {
  if (configFileName !== '') {
    const parser = new ConfigParser(fs, sys.currentDirectory);
    parser.expandFileNames = expandFileNames;
    parser.beforeRootFiles = beforeRootFiles;
    return parser.parseConfigFile(configFileName, commandLine.options, commandLine.raw, errors);
  }
  return new ProjectConfig(
    commandLine.options,
    undefined,
    commandLine.fileNames,
    [],
    undefined,
    [],
    sys.currentDirectory,
    sys.useCaseSensitiveFileNames,
    0,
  );
}

/** A parse thread's own copy of the project it loads files of, and the file system it reads it with. */
export class ThreadProject {
  constructor(
    readonly config: ProjectConfig,
    readonly fs: FileSystem,
  ) {}
}

/**
 * The project of the command line `args` for a parse thread (parallel-parse.ts), whose main thread
 * found its config at `configFileName`; `undefined` if it cannot be read. Under `--build`, the
 * project whose config is `configFileName`, read with the build's compiler options as the build
 * reads it (tsc-build.ts).
 */
export function readThreadProject(
  sys: System,
  args: readonly string[],
  configFileName: string,
): ThreadProject | undefined {
  const fs = new CachedFileSystem(new SystemFileSystem(sys));
  // The main thread hands out the root files: matching the config's `include` patterns again (tens
  // of milliseconds on large trees) would only delay the thread's first files.
  let config: ProjectConfig | undefined;
  if (args.length > 0 && isBuildFlag(args[0]!.toLowerCase())) {
    const command = parseBuildCommandLine(args, sys);
    const parser = new ConfigParser(fs, sys.currentDirectory);
    parser.expandFileNames = false;
    config = parser.parseConfigFile(configFileName, command.compilerOptions, command.raw, []);
  } else config = readProjectConfig(sys, fs, parseCommandLine(args, sys), configFileName, [], false);
  return config === undefined ? undefined : new ThreadProject(config, fs);
}

/** What `--showConfig` prints for a project. */
function showConfigInput(config: ProjectConfig, sys: System): ShowConfigInput {
  const specs = config.configFile?.configFileSpecs;
  let include: readonly string[] | undefined;
  if (specs !== undefined) {
    const includeSpecs = specs.validatedIncludeSpecs;
    if (!(includeSpecs.length === 1 && includeSpecs[0] === '**/*')) include = includeSpecs;
  }
  return {
    options: config.options,
    fileNames: config.fileNames,
    currentDirectory: config.configFile !== undefined ? config.currentDirectory : sys.currentDirectory,
    useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
    references: config.projectReferences,
    include,
    exclude: specs?.validatedExcludeSpecs,
  };
}

/**
 * `--listFilesOnly`: config, syntax and program diagnostics, then the files (explained under `--explainFiles`).
 * Nothing is checked or emitted.
 */
function listFilesOnly(
  sys: System,
  program: Program,
  locale: Locale,
  reporter: DiagnosticReporter,
  errorSummary: ErrorSummaryReporter,
): ExitStatus {
  let diagnostics: Diagnostic[] = [...program.getConfigFileParsingDiagnostics()];
  const configDiagnosticsCount = diagnostics.length;
  for (const diagnostic of program.getSyntacticDiagnostics()) diagnostics.push(diagnostic);
  if (diagnostics.length === configDiagnosticsCount) {
    for (const diagnostic of program.getProgramDiagnostics()) diagnostics.push(diagnostic);
  }
  diagnostics = sortAndDeduplicateDiagnostics(diagnostics);
  reporter.reportAll(diagnostics);
  if (program.options.explainFiles === true) {
    sys.write(program.explainFiles(locale));
  } else {
    let out = '';
    for (const file of program.getSourceFiles()) out += file.fileName + '\n';
    sys.write(out);
  }
  errorSummary.report(diagnostics);
  return diagnostics.length > 0 ? ExitStatus.DiagnosticsPresent_OutputsSkipped : ExitStatus.Success;
}

/** The nearest `tsconfig.json` in `directory` or its ancestors, or `''`. */
function findConfigFile(sys: System, directory: string): string {
  let current = directory;
  for (;;) {
    const candidate = combinePaths(current, 'tsconfig.json');
    if (sys.fileExists(candidate)) return candidate;
    const parent = getDirectoryPath(current);
    if (parent === current) return '';
    current = parent;
  }
}

function writeConfigFile(
  sys: System,
  locale: Locale,
  reporter: DiagnosticReporter,
  commandLine: ParsedCommandLine,
): void {
  const file = normalizePath(combinePaths(sys.currentDirectory, 'tsconfig.json'));
  if (sys.fileExists(file)) {
    reporter.report(createCompilerDiagnostic(Diagnostics.A_tsconfig_json_file_is_already_defined_at_Colon_0, file));
    return;
  }
  sys.writeFile(file, generateTSConfig(commandLine.raw, locale));
  sys.write(
    '\n' +
      header(sys, new Colors(sys), 'Created a new tsconfig.json') +
      'You can learn more at https://aka.ms/tsconfig\n',
  );
}
