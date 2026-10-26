/**
 * `tsc --watch` and `tsc --build --watch`: rebuild when inputs change. Changes are found by comparing
 * the time stamps of the files a build read and of the directories that may gain files, when their
 * directories report an event, or by polling where directories can't be watched.
 */
import type { ParsedBuildCommandLine, ParsedCommandLine as CommandLine } from './command-line.js';
import { CheckedProgram, CompileTimes, ProgramEmitter } from './compile-program.js';
import {
  type Diagnostic,
  type DiagnosticMessage,
  Diagnostics,
  type Locale,
  localizeMessage,
  type MessageWithArgs,
} from './diagnostics.js';
import { type ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from './ast.js';
import { CompilerHost, FileLoader, releaseLater } from './file-loader.js';
import { CachedFileSystem } from './file-system.js';
import { clearLibGlobalsCache } from './checker-symbols.js';
import { forgetLazyJSDocFile, parseSourceFile } from './parser.js';
import { forgetNavigationFile } from './astnav.js';
import { forgetRangeScannerFile } from './binder-utilities.js';
import { forgetIdentifierSets } from './printer/name-generator.js';
import {
  computeLastSignatures,
  declarationSignature,
  FileBuildInfoReader,
  IncrementalProgram,
  readBuildInfoProgram,
  type Snapshot,
} from './incremental.js';
import { combinePaths, getDirectoryPath, getNormalizedAbsolutePath, toPath } from './path.js';
import { Program } from './program.js';
import { ConfigParser, ParsedCommandLine } from './tsconfig.js';
import {
  DiagnosticReporter,
  type DirectoryWatch,
  ErrorSummaryReporter,
  outputLocale,
  rootFilesPerChunk,
  type System,
  SystemFileSystem,
} from './tsc-cli.js';
import { isIncremental } from './options.js';
import { ParseSession, clearPreparedFiles, parallelParse, takePreparedFile } from './parallel-parse.js';
import { checkerThreads, parseThreads, shareWithCheckers, startParallelCheck } from './parallel-check.js';
import { assignSymbolIdsAtCreation, symbolIdsAtCreation } from './symbol.js';
import { Orchestrator, StatusReporter, startWatchRebuild } from './tsc-build.js';
import { mark } from './timeline.js';
import { emitFilesAndReportErrors, rechecksOnThreads, SystemTimeStamps, SystemWriter } from './tsc-compile.js';

/** How often inputs are polled, in milliseconds, where their directories can't be watched. */
const pollInterval = 250;

/**
 * Directory events are batched as tsgo's file watching batches them: the first event after
 * `quietTime` milliseconds without a check is checked at once, and later ones once no other event came
 * for `settleTime` milliseconds.
 */
const settleTime = 50;
const quietTime = 500;

/**
 * Natively, ProgramLifetime objects (syntax trees, symbols, types, signatures, links) are never freed,
 * so each rebuild keeps what its checkers allocated. The driver runs watch mode in a child process and
 * sets `restart` (node-system.ts): a rebuild that would start with more resident memory than `limit`
 * calls it instead of building, and the driver starts a new process, which builds with the changed
 * files and reports the change as this process would have.
 */
export class WatchRestart {
  /** Whether this process continues the watch of one that restarted: its first build reports a change. */
  resumed = false;
  /** The resident bytes above which a rebuild restarts; 0 to take `firstBuildFactor` times the first build's. */
  limit = 0;
  restart: (() => void) | undefined = undefined;

  /** Sets `limit` from the resident memory after the first build, unless it is set. */
  firstBuildDone(): void {
    if (this.restart !== undefined && this.limit === 0) this.limit = residentMemory() * firstBuildFactor;
  }

  /** Restarts the process if a rebuild would start above `limit`; returns whether it did. */
  restartsBeforeRebuild(): boolean {
    const restart = this.restart;
    if (restart === undefined || this.limit <= 0 || residentMemory() <= this.limit) return false;
    restart();
    return true;
  }
}

/** The process's resident memory in bytes, as Node.js reads it on each platform; 0 if it can't be read. */
function residentMemory(): number {
  try {
    return process.memoryUsage.rss();
  } catch {
    return 0;
  }
}

/** The default restart limit, as a multiple of the resident memory after the first build. */
const firstBuildFactor = 2.5;

export const watchRestart = new WatchRestart();

/** Writes watch status lines, clearing the screen where tsc does. */
class WatchStatusReporter {
  private readonly status: StatusReporter;

  constructor(
    private readonly sys: System,
    private readonly clearScreen: boolean,
    pretty: boolean | undefined,
    locale: Locale,
  ) {
    this.status = new StatusReporter(sys, pretty, false, locale);
  }

  report(message: DiagnosticMessage, ...args: string[]): void {
    if (
      this.clearScreen &&
      (message === Diagnostics.Starting_compilation_in_watch_mode ||
        message === Diagnostics.File_change_detected_Starting_incremental_compilation)
    ) {
      this.sys.write('\x1B[2J\x1B[3J\x1B[H');
    }
    this.status.report(message, ...args);
  }

  reportErrorCount(count: number): void {
    if (count === 1) this.report(Diagnostics.Found_1_error_Watching_for_file_changes);
    else this.report(Diagnostics.Found_0_errors_Watching_for_file_changes, String(count));
  }
}

/** Time stamps of files and directories, to tell when any changed. */
class Stamps {
  private readonly times = new Map<string, number | undefined>();
  private readonly directories = new Set<string>();

  constructor(private readonly sys: System) {}

  add(path: string): void {
    if (!this.times.has(path)) this.times.set(path, this.sys.getMTime(path));
  }

  /** A directory and, if `recursive`, the directories below it except `node_modules` and hidden ones. */
  addDirectory(path: string, recursive: boolean, depth = 0): void {
    if (this.times.has(path) || !this.sys.directoryExists(path)) return;
    this.add(path);
    this.directories.add(path);
    if (!recursive || depth > 32) return;
    for (const name of this.sys.getAccessibleEntries(path).directories) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      this.addDirectory(combinePaths(path, name), true, depth + 1);
    }
  }

  changed(): boolean {
    for (const [path, time] of this.times) {
      if (this.sys.getMTime(path) !== time) return true;
    }
    return false;
  }

  /**
   * The files whose time stamps changed, or `undefined` when a watched directory's did: a file was added,
   * removed or renamed there.
   */
  changedFiles(): string[] | undefined {
    const files: string[] = [];
    for (const [path, time] of this.times) {
      if (this.sys.getMTime(path) === time) continue;
      if (this.directories.has(path)) return undefined;
      files.push(path);
    }
    return files;
  }

  /** Takes the current time stamps of `paths`. */
  refresh(paths: readonly string[]): void {
    for (const path of paths) if (this.times.has(path)) this.times.set(path, this.sys.getMTime(path));
  }

  /**
   * Adds the directories whose events report changes of these paths: each directory, and each file's,
   * and for a file that is a symbolic link, its target's.
   */
  addWatchedDirectories(directories: Set<string>, links: LinkTargets): void {
    for (const [path, time] of this.times) {
      if (this.directories.has(path)) {
        directories.add(path);
        continue;
      }
      const directory = getDirectoryPath(path);
      directories.add(directory);
      const directoryTime = this.times.has(directory) ? this.times.get(directory) : this.sys.getMTime(directory);
      const target = links.directoryOf(path, time, directoryTime);
      if (target !== undefined) directories.add(target);
    }
  }
}

class LinkTarget {
  constructor(
    readonly time: number | undefined,
    readonly directoryTime: number | undefined,
    readonly directory: string | undefined,
  ) {}
}

/**
 * The directories of the targets of files that are symbolic links, kept while the time stamps of the
 * file and of its directory are the same. Pointing a link elsewhere replaces it, which changes its
 * directory's time stamp even when the new target has the old one's.
 */
class LinkTargets {
  private readonly targets = new Map<string, LinkTarget>();

  constructor(private readonly sys: System) {}

  /** The directory of the target of the file, or undefined if the file isn't a link. */
  directoryOf(path: string, time: number | undefined, directoryTime: number | undefined): string | undefined {
    let target = this.targets.get(path);
    if (target === undefined || target.time !== time || target.directoryTime !== directoryTime) {
      const real = this.sys.realpath(path);
      target = new LinkTarget(time, directoryTime, real !== path ? getDirectoryPath(real) : undefined);
      this.targets.set(path, target);
    }
    return target.directory;
  }
}

/** The directories a config's `include` specs can add files to, and whether recursively. */
function includeDirectories(config: ParsedCommandLine): { path: string; recursive: boolean }[] {
  const result: { path: string; recursive: boolean }[] = [];
  const specs = config.configFile?.configFileSpecs;
  if (specs === undefined) return result;
  for (const spec of specs.validatedIncludeSpecs) {
    const absolute = getNormalizedAbsolutePath(spec, config.currentDirectory);
    const components = absolute.split('/');
    let base = '';
    let wildcard = false;
    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      if (component.includes('*') || component.includes('?')) {
        wildcard = true;
        break;
      }
      base = i === 0 ? (component === '' ? '/' : component) : combinePaths(base, component);
    }
    result.push({ path: wildcard ? base : getDirectoryPath(absolute), recursive: wildcard });
  }
  return result;
}

/** A copy of `config` with its own lazily computed parts and errors, for a program shared with checker threads. */
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

/** The key of a source file in `WatchSourceFiles`: a file parses the same for the same name, path and options. */
function watchFileKey(fileName: string, path: string, options: ExternalModuleIndicatorOptions): string {
  return fileName + '\u0000' + path + (options.jsx ? '\u0000j' : '\u0000') + (options.force ? 'f' : '');
}

/**
 * The source files of the last build, by name, path and module detection options, for the next build
 * to take where their text is unchanged (`WatchCompilerHost`).
 */
class WatchSourceFiles {
  readonly current = new Map<string, SourceFile>();
  /** The paths of the files this build parsed rather than took from the last one. */
  readonly parsed: string[] = [];

  constructor(readonly previous: ReadonlyMap<string, SourceFile> = new Map<string, SourceFile>()) {}

  /**
   * The files of the next build, which can take these. A new object: a program shared with checker
   * threads holds its host's.
   */
  next(): WatchSourceFiles {
    return new WatchSourceFiles(this.current);
  }
}

/**
 * A compiler host writing `--traceResolution` output to the system, which takes the parsed and bound
 * source file of the last build when a file's text is unchanged, as tsgo's watch reuses the files of
 * its old program. A file parses the same for the same text, name, path and module detection options,
 * and binding a bound file does nothing. Natively, syntax trees and symbols are never freed
 * (ProgramLifetime), so parsing every file again made each rebuild keep another copy of the program.
 */
class WatchCompilerHost extends CompilerHost {
  constructor(
    private readonly sys: System,
    fs: CachedFileSystem,
    private readonly locale: Locale,
    private readonly files: WatchSourceFiles,
  ) {
    super(fs, sys.currentDirectory, sys.defaultLibraryPath);
  }

  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    // A file that parse threads prepared for a first build on threads (`Watcher.buildOnThreads`).
    const prepared = takePreparedFile(fileName, path, externalModuleIndicatorOptions);
    if (prepared !== undefined) return prepared;
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    const key = watchFileKey(fileName, path, externalModuleIndicatorOptions);
    let file = this.files.current.get(key);
    if (file !== undefined && file.text === text) return file;
    file = this.files.previous.get(key);
    if (file === undefined || file.text !== text) {
      file = parseSourceFile(
        fileName,
        text,
        new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions),
      );
      this.files.parsed.push(path);
    }
    this.files.current.set(key, file);
    return file;
  }

  trace(message: MessageWithArgs): void {
    this.sys.write(localizeMessage(this.locale, message.message, message.args) + '\n');
  }
}

/** A watched directory, with its time stamp when the watch started. */
class WatchedDirectory {
  constructor(
    readonly watch: DirectoryWatch,
    readonly time: number,
  ) {}
}

/**
 * Calls `check` when inputs may have changed: on events of the directories of the stamped paths, or
 * every `pollInterval` milliseconds once a directory can't be watched.
 */
class ChangeWatcher {
  private readonly watches = new Map<string, WatchedDirectory>();
  private readonly links: LinkTargets;
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private lastCheck = -quietTime;

  constructor(
    private readonly sys: System,
    private readonly check: () => void,
  ) {
    this.links = new LinkTargets(sys);
  }

  /**
   * Watches the directories of the paths of `stamps`, keeping the watches of unchanged directories.
   * A change between the stamps and a new watch has no event, so new watches are followed by a check.
   */
  watch(stamps: Stamps[]): void {
    if (this.polling) return;
    let created = false;
    const directories = new Set<string>();
    for (const s of stamps) s.addWatchedDirectories(directories, this.links);
    // A missing directory is watched through its closest existing ancestor, which reports its creation.
    const existing = new Map<string, number>();
    for (const directory of directories) {
      let path = directory;
      let time = this.sys.getMTime(path);
      while (time === undefined && getDirectoryPath(path) !== path) {
        path = getDirectoryPath(path);
        time = this.sys.getMTime(path);
      }
      if (time !== undefined) existing.set(path, time);
    }
    for (const [path, watched] of this.watches) {
      if (existing.has(path)) continue;
      watched.watch.close();
      this.watches.delete(path);
    }
    for (const [path, time] of existing) {
      const watched = this.watches.get(path);
      if (watched !== undefined) {
        if (watched.time === time) continue;
        // A changed directory may have been removed and created again, which ends the old watch.
        watched.watch.close();
        this.watches.delete(path);
      }
      const watch = this.sys.watchDirectory(path, () => this.changed());
      if (watch === undefined) {
        this.startPolling();
        return;
      }
      this.watches.set(path, new WatchedDirectory(watch, time));
      created = true;
    }
    // Without a watch nothing would keep the process running.
    if (this.watches.size === 0) this.startPolling();
    else if (created) this.changed();
  }

  private changed(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const wait = performance.now() - this.lastCheck > quietTime ? 0 : settleTime;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastCheck = performance.now();
      this.check();
    }, wait);
  }

  private startPolling(): void {
    this.polling = true;
    for (const watched of this.watches.values()) watched.watch.close();
    this.watches.clear();
    setInterval(this.check, pollInterval);
  }
}

class Watcher {
  private snapshot: Snapshot | undefined = undefined;
  private stamps: Stamps;
  private configStamps: Stamps;
  /** Whether the last read of the config file after a change succeeded (`reloadConfig`). */
  private configRead = true;
  private readonly locale: Locale;
  private readonly reporter: DiagnosticReporter;
  private readonly status: WatchStatusReporter;
  private files = new WatchSourceFiles();
  private readonly changes: ChangeWatcher;
  /**
   * The checked program of the last build, until the next build computes the signatures it left as versions
   * (`computeLastSignatures`).
   */
  private lastChecked: CheckedProgram | undefined = undefined;
  /** The program of the last build, which a rebuild updates when only the text of its files changed. */
  private lastProgram: Program | undefined = undefined;
  /** Whether a rebuild is running (`poll`), and whether a check came during it. */
  private building = false;
  private checkPending = false;

  constructor(
    private readonly sys: System,
    private config: ParsedCommandLine,
    private readonly commandLine: CommandLine,
  ) {
    const options = config.options;
    this.locale = outputLocale(commandLine.options);
    this.reporter = new DiagnosticReporter(sys, commandLine.options, this.locale);
    this.status = new WatchStatusReporter(
      sys,
      options.preserveWatchOutput !== true && options.extendedDiagnostics !== true && options.diagnostics !== true,
      options.pretty,
      this.locale,
    );
    this.stamps = new Stamps(sys);
    this.configStamps = new Stamps(sys);
    this.changes = new ChangeWatcher(sys, () => this.poll());
  }

  start(): void {
    const sys = this.sys;
    if (this.config.options.incremental === true || this.config.options.composite === true) {
      this.snapshot = readBuildInfoProgram(
        this.config,
        new FileBuildInfoReader(new SystemFileSystem(sys)),
        sys.defaultLibraryPath,
        sys.currentDirectory,
      );
    }
    this.status.report(
      watchRestart.resumed
        ? Diagnostics.File_change_detected_Starting_incremental_compilation
        : Diagnostics.Starting_compilation_in_watch_mode,
    );
    const watchChanges = (): void => {
      watchRestart.firstBuildDone();
      this.changes.watch([this.stamps, this.configStamps]);
    };
    // A program shared with checker threads is never written: symbols get their ids when created.
    const options = this.config.options;
    if (parallelParse.spawn !== undefined && checkerThreads(options.checkers, options.singleThreaded) > 1)
      assignSymbolIdsAtCreation();
    const threads = this.firstBuildThreads();
    if (threads > 1) this.buildOnThreads(threads, watchChanges);
    else this.build(watchChanges);
  }

  /**
   * The checker threads of the first build: those of a compile (`compileThreads`), or 1 to build on this
   * thread. A first build without old state checks every file, as a compile does; rebuilds check what a
   * change affects (`rebuildThreads`). With build info (`--incremental`), the first build stays here.
   */
  private firstBuildThreads(): number {
    const options = this.config.options;
    if (this.snapshot !== undefined || isIncremental(options) || parallelParse.spawn === undefined) return 1;
    return checkerThreads(options.checkers, options.singleThreaded);
  }

  /**
   * Builds the first program as a compile does: parse threads load its files, and checker threads check
   * it (parallel-check.ts) unless it checks little. The program is shared with them, so it gets its own
   * copy of the config and a host of its own. Its files go to the watch's file maps for rebuilds to take,
   * and are never written again: rebuilds check them with the checker's side tables. Calls `done` once
   * the build is reported.
   */
  private buildOnThreads(threads: number, done: () => void): void {
    releaseProgramCaches();
    const sys = this.sys;
    const config = copyCommandLine(this.config);
    const options = config.options;
    const session = new ParseSession(
      parseThreads(threads),
      options,
      sys.currentDirectory,
      config.configName,
      config.fileNames.length > 0,
    );
    const host = new WatchCompilerHost(
      sys,
      new CachedFileSystem(new SystemFileSystem(sys)),
      this.locale,
      new WatchSourceFiles(),
    );
    const loader = new FileLoader(host, config);
    let rootFilesAdded = false;
    session.onIdle = (batch) => {
      if (!rootFilesAdded) rootFilesAdded = loader.addRootFiles(rootFilesPerChunk);
      loader.walkAhead(batch.files);
    };
    session.start(config.fileNames, () => {
      const program = new Program(config, host, loader);
      // The session's callbacks keep the loader: its tasks go once checking has started.
      releaseLater(loader);
      this.files = this.files.next();
      for (const file of program.getSourceFiles()) {
        const indicator = file.externalModuleIndicatorOptions;
        this.files.current.set(watchFileKey(file.fileName, file.path, indicator), file);
      }
      const checked = new CheckedProgram(program);
      // The incremental program `finishBuild` makes after checking keeps the globals found checking a file
      // with the file.
      checked.globalsInFileDiagnostics = true;
      const finish = (): void => {
        this.finishBuild(checked);
        // Rebuilds parse what changed themselves.
        clearPreparedFiles();
        done();
      };
      const count = checkerThreads(options.checkers, options.singleThreaded, program);
      if (count > 1) startParallelCheck(checked, count, finish);
      else finish();
    });
  }

  private configFiles(): string[] {
    const configFile = this.config.configFile;
    if (configFile === undefined) return [];
    return [configFile.sourceFile.fileName, ...configFile.extendedSourceFiles];
  }

  private poll(): void {
    // A build on checker threads lets events through; a check during it runs once the build is reported.
    if (this.building) {
      this.checkPending = true;
      return;
    }
    this.building = true;
    this.rebuildIfChanged(() => {
      this.building = false;
      this.changes.watch([this.stamps, this.configStamps]);
      if (this.checkPending) {
        this.checkPending = false;
        this.poll();
      }
    });
  }

  /** Rebuilds if inputs changed, then calls `done`. */
  private rebuildIfChanged(done: () => void): void {
    const configChanged = this.configStamps.changed();
    if (!configChanged && !this.stamps.changed()) return done();
    // A changed config is read here, where errors in it keep the last one. A new process would read the
    // config again, so a process whose last read of it failed builds on with the config it has; after a
    // read that succeeded, a config change restarts the process like any other change.
    if (configChanged && !this.reloadConfig()) return done();
    if (this.configRead && watchRestart.restartsBeforeRebuild()) return done();
    this.status.report(Diagnostics.File_change_detected_Starting_incremental_compilation);
    this.build(done, configChanged ? undefined : this.stamps.changedFiles());
  }

  /** Rereads the config file; false (after reporting) if it can't be used. */
  private reloadConfig(): boolean {
    const configName = this.config.configName;
    if (configName === '') return true;
    const sys = this.sys;
    const errors: Diagnostic[] = [];
    const parser = new ConfigParser(new CachedFileSystem(new SystemFileSystem(sys)), sys.currentDirectory);
    const parsed = parser.parseConfigFile(configName, this.commandLine.options, this.commandLine.raw, errors);
    this.configRead = parsed !== undefined;
    if (parsed === undefined) {
      this.reporter.reportAll(errors);
      this.status.reportErrorCount(errors.length);
      this.configStamps = new Stamps(sys);
      for (const file of this.configFiles()) this.configStamps.add(file);
      return false;
    }
    this.config = parsed;
    return true;
  }

  /**
   * Builds, on checker threads when the change affects many files, then calls `done`. `changedFiles` are
   * the files whose time stamps changed, when no watched directory's and no config file's did.
   */
  private build(done: () => void, changedFiles?: readonly string[]): void {
    releaseProgramCaches();
    const sys = this.sys;
    const fs = new CachedFileSystem(new SystemFileSystem(sys));
    let program = changedFiles !== undefined ? this.updatedProgram(changedFiles, fs) : undefined;
    if (program === undefined) {
      changedFiles = undefined;
      if (this.config.configName !== '') {
        // Pick up files added to or removed from included directories.
        const parsed = new ConfigParser(fs, sys.currentDirectory).parseConfigFile(
          this.config.configName,
          this.commandLine.options,
          this.commandLine.raw,
          [],
        );
        if (parsed !== undefined) this.config = parsed;
      }
      this.files = this.files.next();
      // A copy: a program shared with checker threads holds its config's errors (`copyCommandLine`).
      program = new Program(copyCommandLine(this.config), new WatchCompilerHost(sys, fs, this.locale, this.files));
    }
    // The signatures the last build left as versions, for the files this one parsed.
    if (this.lastChecked !== undefined && this.snapshot !== undefined)
      computeLastSignatures(this.snapshot, this.lastChecked, this.files.parsed);
    this.lastChecked = undefined;
    const checked = new CheckedProgram(program);
    checked.globalsInFileDiagnostics = true;
    const signatures = new Map<string, string>();
    const threads = this.rebuildThreads(checked, signatures);
    // A new checker for checker threads: `rebuildThreads` may have emitted declarations with this one.
    if (threads > 1) return this.recheckOnThreads(new CheckedProgram(program), threads, signatures, done, changedFiles);
    this.finishBuild(checked, signatures, changedFiles);
    done();
  }

  /**
   * The last build's program with `changedFiles` read again (`Program.updateFile`, as tsgo's watch swaps a
   * changed file into its program), or `undefined` when one of them cannot be swapped in and the program
   * must be loaded again. No directory and no config file changed, so the root files are the same. The
   * source files of the updated program are those of the next build (`WatchSourceFiles`), which takes the
   * unchanged ones without reading them.
   */
  private updatedProgram(changedFiles: readonly string[], fs: CachedFileSystem): Program | undefined {
    let program = this.lastProgram;
    if (program === undefined) return undefined;
    const files = this.files.next();
    const host = new WatchCompilerHost(this.sys, fs, this.locale, files);
    for (const fileName of changedFiles) {
      const file = program.getSourceFile(fileName);
      if (file === undefined) return undefined;
      program = program.updateFile(file.path, host);
      if (program === undefined) return undefined;
    }
    for (const file of program.getSourceFiles())
      files.current.set(watchFileKey(file.fileName, file.path, file.externalModuleIndicatorOptions), file);
    this.files = files;
    mark(`program updated, ${changedFiles.length} files`);
    return program;
  }

  /**
   * The checker threads for a rebuild of `checked`, or 1 to check it on this thread: threads where the
   * change may affect enough files for them (`rechecksOnThreads`), counting each changed file and every
   * file that references it, transitively, in the last build, or every file for a change to a file that
   * affects the global scope. A changed file whose declaration file keeps the signature of the last
   * build affects only itself (`getFilesAffectedBy`); its signature is computed with `checked`'s checker
   * and added to `signatures`. That is what the change affects at most; `recheckOnThreads` then takes
   * what it does affect. A watch whose first config kept it on one thread gave its symbols no ids at
   * creation (`start`), so its rebuilds, which take the unchanged files of earlier builds, stay on this
   * thread after a config edit turns checker threads on.
   */
  private rebuildThreads(checked: CheckedProgram, signatures: Map<string, string>): number {
    const program = checked.program;
    const snapshot = this.snapshot;
    const options = program.options;
    if (snapshot === undefined || parallelParse.spawn === undefined || options.composite === true) return 1;
    if (!symbolIdsAtCreation()) return 1;
    const threads = checkerThreads(options.checkers, options.singleThreaded, program);
    if (threads <= 1) return 1;
    const affected = new Set<string>();
    const queue: string[] = [];
    let emitter: ProgramEmitter | undefined = undefined;
    for (const path of this.files.parsed) {
      const info = snapshot.fileInfos.get(path);
      if (info === undefined || info.affectsGlobalScope) return threads;
      if (affected.has(path)) continue;
      affected.add(path);
      // A signature that is the file's version was never computed from a declaration file.
      const file = program.getSourceFileByPath(path);
      if (file !== undefined && !file.isDeclarationFile && info.signature !== info.version) {
        if (emitter === undefined) {
          // Emit computes the common source directory, which reports files outside `rootDir` unless the
          // file inclusion diagnostics are fixed first, as a report fixes them before it emits.
          program.getProgramDiagnostics();
          emitter = new ProgramEmitter(checked);
        }
        const signature = declarationSignature(emitter, file, options);
        signatures.set(path, signature);
        if (signature === info.signature) continue;
      }
      queue.push(path);
    }
    while (queue.length > 0)
      for (const importer of snapshot.referencedMap.getReferencedBy(queue.pop()!))
        if (!affected.has(importer)) {
          affected.add(importer);
          queue.push(importer);
        }
    const files: SourceFile[] = [];
    for (const path of affected) {
      const file = program.getSourceFileByPath(path);
      if (file !== undefined) files.push(file);
    }
    mark(`${files.length} files the change may affect`);
    return rechecksOnThreads(files, threads, options.checkers !== undefined) ? threads : 1;
  }

  /**
   * Rechecks `checked` as a compile with build info does (`recheckInParallel`, tsc-compile.ts): its
   * program is shared with checker threads before its checker does more than merge the globals, and the
   * threads check the files the change affects when they are many enough, emitting what the incremental
   * program would; otherwise this thread checks them. `signatures` are those `rebuildThreads` computed.
   */
  private recheckOnThreads(
    checked: CheckedProgram,
    threads: number,
    signatures: ReadonlyMap<string, string>,
    done: () => void,
    changedFiles?: readonly string[],
  ): void {
    const sys = this.sys;
    const program = checked.program;
    shareWithCheckers(checked);
    const times = new CompileTimes();
    const incremental = new IncrementalProgram(checked, times, this.snapshot, new SystemTimeStamps(sys), signatures);
    const options = program.options;
    if (
      options.listFilesOnly !== true &&
      incremental.getSyntacticDiagnostics().length === 0 &&
      incremental.getProgramDiagnostics().length === 0 &&
      incremental.getGlobalDiagnostics(false).length === 0
    ) {
      const files = incremental.filesToCheck();
      mark(`${files.length} files to check`);
      if (rechecksOnThreads(files, threads, options.checkers !== undefined)) {
        checked.checkOnly = new Set(files);
        const finish = (): void => {
          this.report(incremental, changedFiles);
          done();
        };
        startParallelCheck(checked, threads, finish, true, incremental.emitKindsOnCheckers(files));
        return;
      }
    }
    this.report(incremental, changedFiles);
    done();
  }

  /**
   * Checks (where checker threads didn't), emits and reports `checked`, and watches its inputs. `signatures`
   * are the shape signatures computed for `checked`'s files before (`rebuildThreads`).
   */
  private finishBuild(
    checked: CheckedProgram,
    signatures?: ReadonlyMap<string, string>,
    changedFiles?: readonly string[],
  ): void {
    const times = new CompileTimes();
    this.report(
      new IncrementalProgram(checked, times, this.snapshot, new SystemTimeStamps(this.sys), signatures),
      changedFiles,
    );
  }

  /**
   * Checks (where checker threads didn't), emits and reports `incremental`, and watches its inputs: those of a
   * program `updatedProgram` made are the last build's, with new time stamps for `changedFiles`.
   */
  private report(incremental: IncrementalProgram, changedFiles?: readonly string[]): void {
    const sys = this.sys;
    const program = incremental.program;
    const result = emitFilesAndReportErrors(
      sys,
      incremental,
      this.reporter,
      new ErrorSummaryReporter(sys, program.options, this.locale),
      new SystemWriter(sys),
      this.locale,
    );
    this.snapshot = incremental.snapshot;
    this.lastChecked = incremental.checked;
    this.lastProgram = program;
    if (changedFiles !== undefined) this.stamps.refresh(changedFiles);
    else this.watchInputs(program);
    this.status.reportErrorCount(result.diagnostics.length);
  }

  private watchInputs(program: Program): void {
    const sys = this.sys;
    const stamps = new Stamps(sys);
    const configStamps = new Stamps(sys);
    for (const file of this.configFiles()) configStamps.add(file);
    for (const file of program.getSourceFiles()) {
      if (program.isSourceFileDefaultLibrary(file.path)) continue;
      stamps.add(file.fileName);
      stamps.addDirectory(getDirectoryPath(file.fileName), false);
    }
    for (const fileName of this.config.fileNames) stamps.addDirectory(getDirectoryPath(fileName), false);
    for (const directory of includeDirectories(this.config)) stamps.addDirectory(directory.path, directory.recursive);
    if (this.config.configName === '') stamps.addDirectory(sys.currentDirectory, false);
    this.stamps = stamps;
    this.configStamps = configStamps;
  }
}

/** Starts `tsc --watch`; the process keeps running. */
export function watch(sys: System, config: ParsedCommandLine, commandLine: CommandLine): void {
  new Watcher(sys, config, commandLine).start();
}

/** The inputs of every project of a build, from their configs and build infos. */
function buildInputs(sys: System, command: ParsedBuildCommandLine): Stamps {
  const stamps = new Stamps(sys);
  const fs = new CachedFileSystem(new SystemFileSystem(sys));
  const parser = new ConfigParser(fs, sys.currentDirectory);
  const seen = new Set<string>();
  const visit = (configName: string): void => {
    const path = toPath(configName, sys.currentDirectory, sys.useCaseSensitiveFileNames);
    if (seen.has(path)) return;
    seen.add(path);
    stamps.add(configName);
    stamps.addDirectory(getDirectoryPath(configName), false);
    const config = parser.parseConfigFile(configName, command.compilerOptions, command.raw, []);
    if (config === undefined) return;
    const configFile = config.configFile;
    if (configFile !== undefined) for (const extended of configFile.extendedSourceFiles) stamps.add(extended);
    for (const fileName of config.fileNames) {
      stamps.add(fileName);
      stamps.addDirectory(getDirectoryPath(fileName), false);
    }
    for (const directory of includeDirectories(config)) stamps.addDirectory(directory.path, directory.recursive);
    for (const reference of config.resolvedProjectReferencePaths()) visit(reference);
  };
  for (const project of command.projects) {
    const absolute = getNormalizedAbsolutePath(project, sys.currentDirectory);
    visit(absolute.endsWith('.json') ? absolute : combinePaths(absolute, 'tsconfig.json'));
  }
  return stamps;
}

/** Starts `tsc --build --watch`; the process keeps running. */
export function watchBuild(sys: System, command: ParsedBuildCommandLine): void {
  const options = command.compilerOptions;
  const locale = outputLocale(options);
  const status = new WatchStatusReporter(
    sys,
    options.preserveWatchOutput !== true && options.extendedDiagnostics !== true && options.diagnostics !== true,
    options.pretty,
    locale,
  );
  status.report(
    watchRestart.resumed
      ? Diagnostics.File_change_detected_Starting_incremental_compilation
      : Diagnostics.Starting_compilation_in_watch_mode,
  );
  const run = (): Stamps => {
    releaseProgramCaches();
    startWatchRebuild();
    const orchestrator = new Orchestrator(sys, command);
    orchestrator.watching = true;
    orchestrator.start();
    status.reportErrorCount(orchestrator.errorCount);
    return buildInputs(sys, command);
  };
  let stamps = run();
  watchRestart.firstBuildDone();
  const changes = new ChangeWatcher(sys, () => {
    if (stamps.changed() && !watchRestart.restartsBeforeRebuild()) {
      status.report(Diagnostics.File_change_detected_Starting_incremental_compilation);
      stamps = run();
    }
    changes.watch([stamps]);
  });
  changes.watch([stamps]);
}

/**
 * A rebuild parses every file again, so drop the module-level caches that still point at the
 * previous build's files and library globals.
 */
function releaseProgramCaches(): void {
  clearLibGlobalsCache();
  forgetLazyJSDocFile();
  forgetNavigationFile();
  forgetRangeScannerFile();
  forgetIdentifierSets();
}
