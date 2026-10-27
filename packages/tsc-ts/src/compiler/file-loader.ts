/**
 * Finds every file of a program: root files, libraries, references, imports and type directives, in tsgo's order.
 */
import {
  ImportDeclaration,
  NodeFlags,
  ParseOptions,
  ScriptKind,
  StringLiteral,
  getText,
  type ExternalModuleIndicatorOptions,
  type FileReference,
  type Node,
  type SourceFile,
} from './ast.js';
import { Diagnostics, type DiagnosticMessage, type MessageWithArgs, messageWithArgs } from './diagnostics.js';
import { FileIncludeKind, FileIncludeReason, IncludeProcessor, ProcessingDiagnostic } from './file-include.js';
import type { FileSystem } from './file-system.js';
import { ModuleResolutionHost, Resolver, getAutomaticTypeDirectiveNames } from './module-resolution.js';
import {
  getResolutionDiagnostic,
  inferredTypesContainingFile,
  type PackageId,
  type ResolvedModule,
  type ResolvedTypeReferenceDirective,
} from './module-resolution-types.js';
import {
  getAllowJS,
  getIsolatedModules,
  getModuleResolutionKind,
  ModuleKind,
  ModuleResolutionKind,
  type CompilerOptions,
} from './options.js';
import {
  LoadKind,
  type LoadJobs,
  type PreparedFile,
  isPrepared,
  preparedLoad,
  preparedPackageJsonLookups,
  takePreparedFile,
} from './parallel-parse.js';
import type { PackageJsonLookup } from './package-json.js';
import { parseSourceFile, getScriptKindFromFileName } from './parser.js';
import { mark } from './timeline.js';
import {
  combinePaths,
  fileExtensionIsOneOf,
  getCanonicalFileName,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getRootLength,
  hasJSFileExtension,
  isRootedDiskPath,
  normalizePath,
  normalizeSlashes,
  removeTrailingDirectorySeparator,
  supportedTSExtensionsWithJsonFlat,
  toFileNameLowerCase,
  toPath,
  isNetworkPath,
} from './path.js';
import {
  getDefaultLibFileName,
  getDefaultResolutionModeForFile,
  getExternalModuleIndicatorOptions,
  getImpliedNodeFormatForFile,
  getJSXImplicitImportBase,
  getJSXRuntimeImport,
  getLibFileName,
  getModeForUsageLocation,
  isExternalModule,
  isSourceFileJS,
  libFileMetadata,
  libNames,
  SourceFileMetadata,
} from './program-utilities.js';
import { SyntaxKind } from './syntax-kind.js';
import { isSourcePhaseImport } from './ast-utilities.js';
import { hasExtension } from './vfs-match.js';
import { TokenFlags } from './types.js';
import {
  ConfigParser,
  flattenExtensions,
  getSupportedExtensions,
  getSupportedExtensionsWithJsonIfResolveJsonModule,
  type ParsedCommandLine,
  type SourceOutputAndProjectReference,
} from './tsconfig.js';

/** Files and services the compiler reads through. */
export class CompilerHost extends ModuleResolutionHost {
  private readonly configParser: ConfigParser;

  constructor(
    readonly fs: FileSystem,
    readonly currentDirectory: string,
    /** Where bundled `lib.*.d.ts` files are. */
    readonly defaultLibraryPath: string,
  ) {
    super();
    this.configParser = new ConfigParser(fs, currentDirectory);
  }

  useCaseSensitiveFileNames(): boolean {
    return this.fs.useCaseSensitiveFileNames;
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }

  fileExists(path: string): boolean {
    return this.fs.fileExists(path);
  }

  directoryExists(path: string): boolean {
    return this.fs.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    return this.fs.readFile(path);
  }

  realpath(path: string): string {
    return this.fs.realpath(path);
  }

  getDirectories(path: string): readonly string[] {
    return this.fs.getAccessibleEntries(path).directories;
  }

  /** Parses a file, or returns `undefined` if it can't be read. */
  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    // A file that parse threads prepared (parallel-parse.ts).
    const prepared = takePreparedFile(fileName, path, externalModuleIndicatorOptions);
    if (prepared !== undefined) return prepared;
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    // A file without a known extension (with allowNonTsExtensions) parses as TypeScript.
    const kind = getScriptKindFromFileName(fileName);
    const scriptKind = kind === ScriptKind.Unknown ? ScriptKind.TS : kind;
    return parseSourceFile(fileName, text, new ParseOptions(path, scriptKind, externalModuleIndicatorOptions));
  }

  /** The config of a referenced project, or `undefined` if it can't be read. */
  getResolvedProjectReference(fileName: string): ParsedCommandLine | undefined {
    return this.configParser.parseConfigFile(fileName, undefined, undefined, []);
  }

  /** Called with module resolution traces under `--traceResolution`. */
  trace(_message: MessageWithArgs): void {}
}

/** A bundled library file. */
export class LibFile {
  constructor(
    readonly name: string,
    readonly path: string,
    /** Found through `libReplacement` in `node_modules/@typescript/lib-*`. */
    readonly replaced: boolean,
  ) {}
}

/** The JSX runtime import of a file, synthesized for resolution. */
export class JsxRuntimeImport {
  constructor(
    readonly moduleReference: string,
    readonly specifier: StringLiteral,
  ) {}
}

/** A file found through a package installed at several places, kept only once. */
export class RedirectFile {
  constructor(
    /** Where in `getSourceFiles()` order it is explained. */
    public index: number,
    readonly fileName: string,
    readonly path: string,
    /** The path of the file it redirects to. */
    readonly target: string,
  ) {}
}

/** Module resolution results of a file, by name and mode. */
export type ModeAwareCache<T> = Map<string, T>;

export function modeAwareKey(name: string, mode: ModuleKind): string {
  return mode + '|' + name;
}

/** A file a loaded file adds (`ParseTask.addSubTask`), as a parse thread recorded it (`LoadedFile`). */
export class LoadedReference {
  constructor(
    readonly normalizedFilePath: string,
    /** The library file's name, or `''`. */
    readonly libName: string,
    readonly reason: FileIncludeReason,
    readonly increaseDepth: boolean,
    readonly elideOnDepth: boolean,
    readonly packageId: PackageId | undefined,
  ) {}
}

/**
 * What a parse thread's FileLoader found loading a file it prepared (parallel-parse.ts): the same
 * as the program's FileLoader finds, since both load with the same options and file system. The
 * program's FileLoader takes it instead of resolving the file's references, imports and type
 * directives again, and takes its reasons as they are (they are immutable).
 */
export class LoadedFile {
  constructor(
    readonly file: SourceFile,
    readonly isLibFile: boolean,
    readonly metadata: SourceFileMetadata,
    readonly references: LoadedReference[],
    readonly resolutionsInFile: ModeAwareCache<ResolvedModule> | undefined,
    readonly typeResolutionsInFile: ModeAwareCache<ResolvedTypeReferenceDirective> | undefined,
    readonly processingDiagnostics: readonly ProcessingDiagnostic[],
    readonly importHelpersImportSpecifier: StringLiteral | undefined,
    readonly jsxRuntimeImport: JsxRuntimeImport | undefined,
  ) {}
}

/** Sub-tasks of a prepared file built ahead (`FileLoader.takeAhead`), and what they were built from. */
class SubTasksAhead {
  constructor(
    readonly loaded: LoadedFile,
    readonly subTasks: ParseTask[],
  ) {}
}

/** Read in place of a task's lists it has not created. */
const noParseTasks: readonly ParseTask[] = [];
const noTraces: readonly MessageWithArgs[] = [];
const noProcessingDiagnostics: readonly ProcessingDiagnostic[] = [];

/**
 * A file to load. Its lists are created on first use: most tasks never get sub-tasks, traces or processing
 * diagnostics, and large programs create hundreds of thousands of tasks.
 */
class ParseTask {
  path = '';
  file: SourceFile | undefined = undefined;
  redirectedParseTask: ParseTask | undefined = undefined;
  subTasks: ParseTask[] | undefined = undefined;
  loaded = false;
  startedSubTasks = false;
  /** A root file name that resolved to no supported file: the task only carries its processing diagnostic. */
  failedLookup = false;
  metadata: SourceFileMetadata = libFileMetadata;
  resolutionsInFile: ModeAwareCache<ResolvedModule> | undefined = undefined;
  resolutionsTrace: MessageWithArgs[] | undefined = undefined;
  typeResolutionsInFile: ModeAwareCache<ResolvedTypeReferenceDirective> | undefined = undefined;
  typeResolutionsTrace: MessageWithArgs[] | undefined = undefined;
  processingDiagnostics: ProcessingDiagnostic[] | undefined = undefined;
  importHelpersImportSpecifier: StringLiteral | undefined = undefined;
  jsxRuntimeImport: JsxRuntimeImport | undefined = undefined;
  /** The task of the same file name that was loaded instead of this one. */
  loadedTask: ParseTask | undefined = undefined;
  /** The index in `FileLoader.taskData` of the tasks of this task's path, once known; -1 before. */
  dataIndex = -1;
  /** Whether an import or a type reference directive adds the file (`ProcessedFiles.addedFiles`). */
  readonly byImport: boolean;

  constructor(
    readonly normalizedFilePath: string,
    readonly libFile: LibFile | undefined,
    readonly includeReason: FileIncludeReason | undefined,
    readonly isForAutomaticTypeDirective: boolean,
    readonly increaseDepth: boolean,
    /** A JavaScript file found in `node_modules`, loaded only within `maxNodeModuleJsDepth`. */
    readonly elideOnDepth: boolean,
    readonly packageId: PackageId | undefined,
  ) {
    const kind = includeReason !== undefined ? includeReason.kind : -1;
    this.byImport = kind === FileIncludeKind.Import || kind === FileIncludeKind.TypeReferenceDirective;
  }

  addSubTask(
    fileName: string,
    libFile: LibFile | undefined,
    reason: FileIncludeReason,
    increaseDepth: boolean,
    elideOnDepth: boolean,
    packageId: PackageId | undefined,
  ): void {
    (this.subTasks ??= []).push(
      new ParseTask(normalizePath(fileName), libFile, reason, false, increaseDepth, elideOnDepth, packageId),
    );
  }

  addProcessingDiagnostic(diagnostic: ProcessingDiagnostic): void {
    (this.processingDiagnostics ??= []).push(diagnostic);
  }

  /** Where module resolution traces go under `--traceResolution`; undefined without it. */
  moduleTraces(trace: boolean): MessageWithArgs[] | undefined {
    return trace ? (this.resolutionsTrace ??= []) : undefined;
  }

  /** Where type reference resolution traces go under `--traceResolution`; undefined without it. */
  typeTraces(trace: boolean): MessageWithArgs[] | undefined {
    return trace ? (this.typeResolutionsTrace ??= []) : undefined;
  }
}

const noData: readonly ParseTaskData[] = [];

/** The resolution of a module the importing file declares itself: none. */
const locallyDeclaredModule: ResolvedModule = {
  resolvedFileName: '',
  originalPath: '',
  extension: '',
  resolvedUsingTsExtension: false,
  packageId: undefined,
  isExternalLibraryImport: false,
  alternateResult: '',
  resolutionDiagnostics: [],
};

/** The tasks of one path, by file name casing. */
class ParseTaskData {
  readonly tasks = new Map<string, ParseTask>();
  /** Whether a task of the path is queued (`start`). */
  queued = false;
  /** The path's first queued task, the first of `tasks`. */
  first: ParseTask | undefined = undefined;
  /**
   * Whether every task of `tasks` is loaded (`run`): then more work of the path does nothing unless it
   * reaches the path at a lower depth.
   */
  settled = false;
  lowestDepth = Number.MAX_SAFE_INTEGER;
  startedSubTasks = false;
  packageId: PackageId | undefined = undefined;
  /** The index of this path's file in the program's files, once collected; -1 for none. */
  index = -1;
  /** For a deduplicated package's path, the tasks of the copy kept (`collect`). */
  keptCopy: ParseTaskData | undefined = undefined;
  /** The paths the file's imports and type reference directives add, once collected. */
  added: readonly ParseTaskData[] = noData;
  /** The file name `collect` reached the path by first, once it did. */
  collectedName: string | undefined = undefined;
  /** The path's include reasons, once `collect` found one: the list in `IncludeProcessor.fileIncludeReasons`. */
  reasons: FileIncludeReason[] | undefined = undefined;
}

/** Pending processing of `tasks[index]`. */
class ParseWork {
  constructor(
    readonly tasks: ParseTask[],
    readonly index: number,
    readonly data: ParseTaskData,
    readonly loaded: boolean,
    readonly depth: number,
  ) {}
}

/** Referenced projects, and how their sources map to declaration outputs. */
export class ProjectReferenceMapper {
  readonly configToProjectReference = new Map<string, ParsedCommandLine | undefined>();
  readonly referencesInConfigFile = new Map<string, readonly string[]>();
  readonly sourceToProjectReference = new Map<string, SourceOutputAndProjectReference>();
  readonly outputDtsToProjectReference = new Map<string, SourceOutputAndProjectReference>();
  private readonly realpathDtsToSource = new Map<string, SourceOutputAndProjectReference | null>();
  /** Set while loading files, for symlink lookups. */
  loader: FileLoader | undefined = undefined;

  constructor(readonly config: ParsedCommandLine) {}

  /** The declaration output to load instead of a source of a referenced project, or `''`. */
  getParseFileRedirect(path: string): string {
    const output = this.sourceToProjectReference.get(path);
    return output !== undefined ? output.outputDts : '';
  }

  /** The referenced project whose options apply to a file. */
  getRedirectForResolution(path: string, fileName: string): SourceOutputAndProjectReference | undefined {
    return (
      this.sourceToProjectReference.get(path) ??
      this.outputDtsToProjectReference.get(path) ??
      this.getSourceToDtsIfSymlink(path, fileName)
    );
  }

  getCompilerOptionsForFile(path: string, fileName: string): CompilerOptions {
    return this.getRedirectForResolution(path, fileName)?.resolved.options ?? this.config.options;
  }

  /** Under `preserveSymlinks`, a symlinked declaration in `node_modules` may be the output of a reference. */
  private getSourceToDtsIfSymlink(path: string, fileName: string): SourceOutputAndProjectReference | undefined {
    const known = this.realpathDtsToSource.get(path);
    if (known !== undefined) return known ?? undefined;
    const loader = this.loader;
    if (loader === undefined || this.config.options.preserveSymlinks !== true) return undefined;
    let result: SourceOutputAndProjectReference | undefined;
    if (fileName.includes('/node_modules/')) {
      const realPath = loader.toPath(loader.host.realpath(fileName));
      if (realPath !== path) result = this.outputDtsToProjectReference.get(realPath);
    }
    this.realpathDtsToSource.set(path, result ?? null);
    return result;
  }

  /** The configs of the root config's references, `undefined` for those that couldn't be read. */
  resolvedProjectReferences(): (ParsedCommandLine | undefined)[] {
    const result: (ParsedCommandLine | undefined)[] = [];
    const configFile = this.config.configFile;
    if (configFile === undefined) return result;
    for (const path of this.referencesInConfigFile.get(configFile.sourceFile.path) ?? []) {
      result.push(this.configToProjectReference.get(path));
    }
    return result;
  }
}

/** A referenced project to read. */
class ProjectReferenceTask {
  resolved: ParsedCommandLine | undefined = undefined;
  subTasks: ProjectReferenceTask[] = [];

  constructor(readonly configName: string) {}
}

class ReferenceDiagnostic {
  constructor(
    readonly message: DiagnosticMessage,
    readonly args: readonly string[],
  ) {}
}

/** What loading produced. */
export class ProcessedFiles {
  constructor(
    readonly resolver: Resolver,
    /** Libraries first, sorted, then other files in load order. */
    readonly files: readonly SourceFile[],
    readonly filesByPath: ReadonlyMap<string, SourceFile>,
    readonly missingFiles: readonly string[],
    readonly resolvedModules: ReadonlyMap<string, ModeAwareCache<ResolvedModule> | undefined>,
    readonly typeResolutionsInFile: ReadonlyMap<string, ModeAwareCache<ResolvedTypeReferenceDirective> | undefined>,
    readonly sourceFileMetadata: ReadonlyMap<string, SourceFileMetadata>,
    readonly jsxRuntimeImports: ReadonlyMap<string, JsxRuntimeImport>,
    readonly importHelpersImportSpecifiers: ReadonlyMap<string, StringLiteral>,
    readonly libFiles: ReadonlyMap<string, LibFile>,
    /** Files found while searching `node_modules`. */
    readonly sourceFilesFoundSearchingNodeModules: ReadonlySet<string>,
    readonly includeProcessor: IncludeProcessor,
    /** Declaration outputs of referenced projects loaded for their sources, mapped back to the sources. */
    readonly outputFileToProjectReferenceSource: ReadonlyMap<string, string>,
    readonly redirectTargets: ReadonlyMap<string, string[]>,
    readonly redirectFilesByPath: ReadonlyMap<string, RedirectFile>,
    readonly projectReferenceMapper: ProjectReferenceMapper,
    /**
     * The `package.json` lookups made resolving the files whose resolutions were taken from parse
     * threads (`preparedPackageJsonLookups`); `undefined` where they may miss some.
     */
    readonly preparedPackageJsons: readonly PackageJsonLookup[] | undefined,
    /**
     * The files each file's imports and type reference directives added to the program, by index into
     * `files`, without the file itself.
     */
    readonly addedFiles: readonly (readonly number[])[],
  ) {}
}

/** The files of `processed` with `file` in place of the file at its path, for `Program.updateFile`. */
export function withReplacedFile(processed: ProcessedFiles, file: SourceFile): ProcessedFiles {
  const files = processed.files.slice();
  files[files.findIndex((f) => f.path === file.path)] = file;
  const filesByPath = new Map(processed.filesByPath);
  filesByPath.set(file.path, file);
  return new ProcessedFiles(
    processed.resolver,
    files,
    filesByPath,
    processed.missingFiles,
    processed.resolvedModules,
    processed.typeResolutionsInFile,
    processed.sourceFileMetadata,
    processed.jsxRuntimeImports,
    processed.importHelpersImportSpecifiers,
    processed.libFiles,
    processed.sourceFilesFoundSearchingNodeModules,
    processed.includeProcessor.copy(file.path),
    processed.outputFileToProjectReferenceSource,
    processed.redirectTargets,
    processed.redirectFilesByPath,
    processed.projectReferenceMapper,
    processed.preparedPackageJsons,
    // The file has the same references (`canReplaceFile`), and keeps its index.
    processed.addedFiles,
  );
}

/** Whether `file` imports the `importHelpers` module (tslib) under `options`. */
export function needsImportHelpersImportSpecifier(file: SourceFile, options: CompilerOptions): boolean {
  if (options.importHelpers !== true) return false;
  return isSourceFileJS(file) || (!file.isDeclarationFile && (getIsolatedModules(options) || isExternalModule(file)));
}

/** The module `file` imports the JSX runtime from under `options`, or '' if it imports none. */
export function jsxRuntimeImportOf(file: SourceFile, options: CompilerOptions): string {
  if (!isSourceFileJS(file) && file.scriptKind !== ScriptKind.TSX) return '';
  return getJSXRuntimeImport(getJSXImplicitImportBase(options, file), options);
}

/**
 * Whether `next`, a new version of `file`, can take its place in a program without loading the program again,
 * as tsgo's canReplaceFileInProgram checks: it has the same script kind, is a module if `file` is one, and has
 * the same module specifiers with the same resolution modes (`modeOf`), module augmentation names, ambient
 * modules, file, type and library references, `// @ts-check` directive and node core module style. A CommonJS
 * module indicator is set when a file is bound, so `next` has none yet; the new program's binder sets it.
 */
export function canReplaceFile(
  file: SourceFile,
  next: SourceFile,
  modeOf: (file: SourceFile, specifier: Node) => ModuleKind,
): boolean {
  return (
    file.scriptKind === next.scriptKind &&
    isExternalModule(file) === isExternalModule(next) &&
    file.usesUriStyleNodeCoreModules === next.usesUriStyleNodeCoreModules &&
    sameNodes(
      file.imports,
      next.imports,
      (a, b) =>
        (a.kind !== SyntaxKind.StringLiteral || getText(a) === getText(b)) && modeOf(file, a) === modeOf(next, b),
    ) &&
    sameNodes(file.moduleAugmentations, next.moduleAugmentations, (a, b) => getText(a) === getText(b)) &&
    sameStrings(file.ambientModuleNames, next.ambientModuleNames) &&
    sameFileReferences(file.referencedFiles, next.referencedFiles) &&
    sameFileReferences(file.typeReferenceDirectives, next.typeReferenceDirectives) &&
    sameFileReferences(file.libReferenceDirectives, next.libReferenceDirectives) &&
    (file.checkJsDirective === undefined
      ? next.checkJsDirective === undefined
      : next.checkJsDirective !== undefined && file.checkJsDirective.enabled === next.checkJsDirective.enabled)
  );
}

function sameNodes(a: readonly Node[], b: readonly Node[], same: (a: Node, b: Node) => boolean): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].kind !== b[i].kind || !same(a[i], b[i])) return false;
  return true;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameFileReferences(a: readonly FileReference[], b: readonly FileReference[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].fileName !== b[i].fileName ||
      a[i].resolutionMode !== b[i].resolutionMode ||
      a[i].preserve !== b[i].preserve
    )
      return false;
  }
  return true;
}

class LibResolution {
  constructor(
    readonly libraryName: string,
    readonly resolution: ResolvedModule,
    readonly trace: readonly MessageWithArgs[],
  ) {}
}

/** Loads files depth-first in tsgo's single-threaded order; the result does not depend on that order. */
export class FileLoader {
  readonly resolver: Resolver;
  readonly mapper: ProjectReferenceMapper;
  private readonly options: CompilerOptions;
  private readonly defaultLibraryPath: string;
  private readonly supportedExtensions: readonly (readonly string[])[];
  private readonly supportedExtensionsWithJson: readonly (readonly string[])[];
  private readonly maxNodeModuleJsDepth: number;
  private readonly rootTasks: ParseTask[] = [];
  /** The tasks of each path, created when a task of the path is first queued or built ahead. */
  private readonly taskData: ParseTaskData[] = [];
  /** The index in `taskData` of each path's tasks. */
  private readonly taskDataByPath = new Map<string, number>();
  /** Work queued by `start`, run last-in first-out like tsgo's single-threaded work group. */
  private readonly work: ParseWork[] = [];
  private readonly libFileCache = new Map<string, LibFile>();
  private readonly libResolutions = new Map<string, LibResolution>();
  private readonly referenceTasks = new Map<string, ProjectReferenceTask>();
  /** `toPath` of each file name seen: every reference to a file asks again. */
  private readonly paths = new Map<string, string>();
  /** The normalized config file name root files are found from, once computed. */
  private rootContainingFile: string | undefined = undefined;
  /** Root files whose tasks `addRootFiles` added. */
  private rootFilesAdded = 0;
  /** The sub-tasks of prepared files, by file name, built ahead by `takeAhead`. */
  private readonly subTasksAhead = new Map<string, SubTasksAhead>();
  /** Whether the work of the root tasks is queued (`startRootTasks`). */
  private rootTasksStarted = false;
  /** Set while `walkAhead` runs: the walk stops at work that would parse a file not prepared yet. */
  private walkingAhead = false;
  /**
   * Whether a file that parse threads prepared is loaded from what its thread found (its metadata
   * and resolutions). If not, only the parsed and bound file is taken, and this loader looks up the
   * file's metadata and resolves its references and imports itself, as without parse threads.
   */
  takesPreparedResolutions = true;
  // Whether a file's resolutions were taken from a parse thread.
  private tookPreparedResolutions = false;

  constructor(
    readonly host: CompilerHost,
    private readonly config: ParsedCommandLine,
  ) {
    const options = config.options;
    this.options = options;
    this.defaultLibraryPath = getNormalizedAbsolutePath(host.defaultLibraryPath, host.currentDirectory);
    this.supportedExtensions = getSupportedExtensions(options);
    this.supportedExtensionsWithJson = getSupportedExtensionsWithJsonIfResolveJsonModule(options);
    this.maxNodeModuleJsDepth = options.maxNodeModuleJsDepth ?? 0;
    this.mapper = new ProjectReferenceMapper(config);
    this.loadProjectReferences();
    this.resolver = new Resolver(host, options);
  }

  toPath(fileName: string): string {
    let path = this.paths.get(fileName);
    if (path === undefined) {
      path = toPath(fileName, this.host.currentDirectory, this.host.fs.useCaseSensitiveFileNames);
      this.paths.set(fileName, path);
    }
    return path;
  }

  /**
   * Adds the tasks of up to `count` more root files, the first step of `load`: the main thread does
   * this while parse threads load the files (parallel-parse.ts). Returns whether every root file's
   * task is added.
   */
  addRootFiles(count: number): boolean {
    const rootFiles = this.config.fileNames;
    const end = Math.min(rootFiles.length, this.rootFilesAdded + count);
    for (let i = this.rootFilesAdded; i < end; i++) this.addRootFileTask(rootFiles[i], FileIncludeReason.rootFile(i));
    this.rootFilesAdded = end;
    return end === rootFiles.length;
  }

  /** Builds ahead what loading takes from each of `files` (`takeLoadedFile`). */
  private takeAhead(files: readonly PreparedFile[]): void {
    for (const prepared of files) {
      const loaded = prepared.loaded;
      if (loaded === undefined) continue;
      const subTasks = this.subTasksOf(loaded);
      // Their paths and tasks, found here while threads parse rather than when the walk reaches them.
      for (const task of subTasks) {
        task.path = this.toPath(task.normalizedFilePath);
        task.dataIndex = this.dataIndexOf(task.path);
      }
      this.subTasksAhead.set(prepared.fileName, new SubTasksAhead(loaded, subTasks));
    }
  }

  /**
   * Loads what it can while parse threads load more files (parallel-parse.ts), the main thread's work
   * for each batch they return: builds ahead what loading takes from its `files` (`takeAhead`), and once
   * every root file's task is added, runs the walk `load` would run, in the same order, up to work that
   * would parse a file the threads have not prepared yet. A later batch, or `load`, goes on from there.
   * The order decides the program where a file is reached at several depths (the depth it is first
   * loaded at decides the depths of the files it adds), so the walk keeps it.
   */
  walkAhead(files: readonly PreparedFile[]): void {
    this.takeAhead(files);
    if (!this.rootTasksStarted && this.rootFilesAdded < this.config.fileNames.length) return;
    this.startRootTasks();
    this.walkingAhead = true;
    this.walk();
    this.walkingAhead = false;
  }

  load(): ProcessedFiles {
    this.addRootFiles(this.config.fileNames.length);
    this.startRootTasks();
    mark('loader roots added');
    this.walk();
    mark('loader walked');
    const result = this.collect();
    mark('loader collected');
    this.mapper.loader = undefined;
    return result;
  }

  /** Adds the tasks of the libraries and of the automatic type directives, after those of the root files. */
  private addLastRootTasks(): void {
    if (this.config.fileNames.length === 0) return;
    if (this.options.noLib !== true) {
      const lib = this.options.lib;
      if (lib === undefined) {
        const libFile = this.pathForLibFile(getDefaultLibFileName(this.options));
        this.addRootTask(libFile.path, libFile, FileIncludeReason.libFile(-1));
      } else {
        for (let i = 0; i < lib.length; i++) {
          const name = getLibFileName(lib[i]);
          if (name === '') continue;
          const libFile = this.pathForLibFile(name);
          this.addRootTask(libFile.path, libFile, FileIncludeReason.libFile(i));
        }
      }
    }
    const containingDirectory =
      this.options.configFilePath !== undefined
        ? getDirectoryPath(this.options.configFilePath)
        : this.host.currentDirectory;
    this.rootTasks.push(
      new ParseTask(
        combinePaths(containingDirectory, inferredTypesContainingFile),
        undefined,
        undefined,
        true,
        false,
        false,
        undefined,
      ),
    );
  }

  /** Adds the last root tasks and queues the work of every root task, once every root file's task is added. */
  private startRootTasks(): void {
    if (this.rootTasksStarted) return;
    this.rootTasksStarted = true;
    this.addLastRootTasks();
    this.start(this.rootTasks, 0);
  }

  private walk(): void {
    for (let work = this.work.pop(); work !== undefined; work = this.work.pop()) {
      if (this.walkingAhead && this.parsesUnprepared(work.tasks[work.index], work.data)) {
        this.work.push(work);
        return;
      }
      this.run(work);
    }
  }

  /**
   * Drops the tasks once the program has its files, so that whatever holds the loader after loading
   * (a parse session's callbacks) no longer keeps every file's task, sub-task list and resolution
   * traces. Freeing them takes a while on large programs, so the drivers call this once checking
   * has started (`releaseLater`).
   */
  release(): void {
    this.rootTasks.length = 0;
    this.taskData.length = 0;
    this.taskDataByPath.clear();
    this.work.length = 0;
    this.subTasksAhead.clear();
    this.referenceTasks.clear();
    this.paths.clear();
  }

  /**
   * Parse threads (parallel-parse.ts): loads one file as `load` would, parsing it through
   * `host.getSourceFile`, and adds the files it references, imports and type directives add to `out`
   * (libraries by name). `depth` is the file's `maxNodeModuleJsDepth` depth.
   */
  loadAhead(kind: LoadKind, name: string, depth: number, out: LoadJobs): LoadedFile | undefined {
    let task: ParseTask;
    if (kind === LoadKind.Library) {
      const libFile = this.pathForLibFile(name);
      task = new ParseTask(
        getNormalizedAbsolutePath(libFile.path, this.host.currentDirectory),
        libFile,
        undefined,
        false,
        false,
        false,
        undefined,
      );
    } else if (kind === LoadKind.AutomaticTypes) {
      const containingDirectory =
        this.options.configFilePath !== undefined
          ? getDirectoryPath(this.options.configFilePath)
          : this.host.currentDirectory;
      task = new ParseTask(
        combinePaths(containingDirectory, inferredTypesContainingFile),
        undefined,
        undefined,
        true,
        false,
        false,
        undefined,
      );
    } else {
      let fileName = name;
      if (kind === LoadKind.Root) {
        const configFile = this.config.configFile;
        const containingFile =
          configFile !== undefined
            ? getNormalizedAbsolutePath(configFile.sourceFile.fileName, this.host.currentDirectory)
            : this.host.currentDirectory;
        const resolved = this.getSourceFileFromReference(name, name, containingFile, FileIncludeReason.rootFile(0));
        if (typeof resolved !== 'string') return undefined;
        fileName = resolved;
      }
      task = new ParseTask(fileName, undefined, undefined, false, false, false, undefined);
    }
    task.path = this.toPath(task.normalizedFilePath);
    this.loadTask(task);
    const redirected = task.redirectedParseTask;
    if (redirected !== undefined) {
      // A source file of a referenced project: queue its output declaration file, which the program
      // loads in its place. The redirected task has this task's include reason, which is undefined
      // for a task loaded ahead, so no reference is recorded for it.
      out.push(LoadKind.File, redirected.normalizedFilePath, depth);
      return undefined;
    }
    const references: LoadedReference[] = [];
    for (const sub of task.subTasks ?? noParseTasks) {
      references.push(
        new LoadedReference(
          sub.normalizedFilePath,
          sub.libFile !== undefined ? sub.libFile.name : '',
          sub.includeReason!,
          sub.increaseDepth,
          sub.elideOnDepth,
          sub.packageId,
        ),
      );
      const subDepth = sub.increaseDepth ? depth + 1 : depth;
      // `run` skips these.
      if (sub.elideOnDepth && subDepth > this.maxNodeModuleJsDepth) continue;
      if (sub.libFile !== undefined) out.push(LoadKind.Library, sub.libFile.name, subDepth);
      else out.push(LoadKind.File, sub.normalizedFilePath, subDepth);
    }
    const file = task.file;
    // Traces are reported in the program's order: such programs resolve on their own.
    if (file === undefined || this.options.traceResolution === true) return undefined;
    return new LoadedFile(
      file,
      task.libFile !== undefined,
      task.metadata,
      references,
      task.resolutionsInFile,
      task.typeResolutionsInFile,
      task.processingDiagnostics ?? noProcessingDiagnostics,
      task.importHelpersImportSpecifier,
      task.jsxRuntimeImport,
    );
  }

  // ---- Project references

  private loadProjectReferences(): void {
    const references = this.config.resolvedProjectReferencePaths();
    if (references.length === 0) return;
    const configFile = this.config.configFile;
    if (configFile === undefined) return;
    this.mapper.loader = this;
    const tasks = createProjectReferenceTasks(references);
    this.parseProjectReferences(tasks);
    this.mapper.referencesInConfigFile.set(configFile.sourceFile.path, this.mapProjectReferences(tasks, new Set()));
  }

  private parseProjectReferences(tasks: ProjectReferenceTask[]): void {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const path = this.toPath(task.configName);
      const existing = this.referenceTasks.get(path);
      if (existing !== undefined) {
        tasks[i] = existing;
        continue;
      }
      this.referenceTasks.set(path, task);
      task.resolved = this.host.getResolvedProjectReference(task.configName);
      if (task.resolved !== undefined) {
        const subReferences = task.resolved.resolvedProjectReferencePaths();
        if (subReferences.length > 0) task.subTasks = createProjectReferenceTasks(subReferences);
      }
      this.parseProjectReferences(task.subTasks);
    }
  }

  private mapProjectReferences(tasks: readonly ProjectReferenceTask[], seen: Set<ProjectReferenceTask>): string[] {
    const results: string[] = [];
    for (const task of tasks) {
      const path = this.toPath(task.configName);
      results.push(path);
      if (seen.has(task)) continue;
      seen.add(task);
      this.mapper.configToProjectReference.set(path, task.resolved);
      const resolved = task.resolved;
      if (resolved !== undefined && resolved.configFile !== this.config.configFile) {
        // A project's files are mapped before its references', which win for files in both.
        for (const [source, reference] of resolved.sourceToProjectReference()) {
          this.mapper.sourceToProjectReference.set(source, reference);
        }
        for (const [output, reference] of resolved.outputDtsToProjectReference()) {
          this.mapper.outputDtsToProjectReference.set(output, reference);
        }
      }
      this.mapper.referencesInConfigFile.set(path, this.mapProjectReferences(task.subTasks, seen));
    }
    return results;
  }

  // ---- Root tasks

  private addRootTask(fileName: string, libFile: LibFile | undefined, reason: FileIncludeReason): void {
    const absolute = getNormalizedAbsolutePath(fileName, this.host.currentDirectory);
    if (this.options.allowNonTsExtensions === true || hasExtension(absolute)) {
      this.rootTasks.push(new ParseTask(absolute, libFile, reason, false, false, false, undefined));
    }
  }

  private addRootFileTask(fileName: string, reason: FileIncludeReason): void {
    const currentDirectory = this.host.currentDirectory;
    const absolute = getNormalizedAbsolutePath(fileName, currentDirectory);
    let containingFile = this.rootContainingFile;
    if (containingFile === undefined) {
      const configFile = this.config.configFile;
      containingFile =
        configFile !== undefined
          ? getNormalizedAbsolutePath(configFile.sourceFile.fileName, currentDirectory)
          : currentDirectory;
      this.rootContainingFile = containingFile;
    }
    const resolved = this.getSourceFileFromReference(absolute, fileName, containingFile, reason);
    if (typeof resolved === 'string') {
      this.rootTasks.push(new ParseTask(resolved, undefined, reason, false, false, false, undefined));
      return;
    }
    const task = new ParseTask(absolute, undefined, reason, false, false, false, undefined);
    task.failedLookup = true;
    task.addProcessingDiagnostic(
      ProcessingDiagnostic.explainingFileInclude('', reason, resolved.message, resolved.args),
    );
    this.rootTasks.push(task);
  }

  private isSupportedExtension(canonicalFileName: string): boolean {
    for (const group of this.supportedExtensionsWithJson) {
      if (fileExtensionIsOneOf(canonicalFileName, group)) return true;
    }
    return false;
  }

  private supportedExtensionsList(): string {
    return "'" + flattenExtensions(this.supportedExtensions).join("', '") + "'";
  }

  /** The file a root file or `/// <reference path>` names, trying extensions, or why there is none. */
  private getSourceFileFromReference(
    fileName: string,
    referenceText: string,
    containingFile: string,
    reason: FileIncludeReason,
  ): string | ReferenceDiagnostic {
    const allowNonTsExtensions = this.options.allowNonTsExtensions === true;
    const diagnosticFileName = normalizeSlashes(referenceText);
    if (isNetworkPath(fileName))
      return new ReferenceDiagnostic(Diagnostics.Network_path_0_is_not_supported, [diagnosticFileName]);
    const fs = this.host.fs;
    if (hasExtension(fileName)) {
      const canonicalFileName = getCanonicalFileName(fileName, fs.useCaseSensitiveFileNames);
      if (!allowNonTsExtensions && !this.isSupportedExtension(canonicalFileName)) {
        if (hasJSFileExtension(canonicalFileName)) {
          return new ReferenceDiagnostic(
            Diagnostics.File_0_is_a_JavaScript_file_Did_you_mean_to_enable_the_allowJs_option,
            [diagnosticFileName],
          );
        }
        return new ReferenceDiagnostic(
          Diagnostics.File_0_has_an_unsupported_extension_The_only_supported_extensions_are_1,
          [diagnosticFileName, this.supportedExtensionsList()],
        );
      }
      if (!fs.fileExists(fileName)) return new ReferenceDiagnostic(Diagnostics.File_0_not_found, [diagnosticFileName]);
      if (
        reason.isReferencedFile() &&
        getCanonicalFileName(containingFile, fs.useCaseSensitiveFileNames) === canonicalFileName
      ) {
        return new ReferenceDiagnostic(Diagnostics.A_file_cannot_have_a_reference_to_itself, []);
      }
      return fileName;
    }
    if (allowNonTsExtensions) {
      return fs.fileExists(fileName)
        ? fileName
        : new ReferenceDiagnostic(Diagnostics.File_0_not_found, [diagnosticFileName]);
    }
    for (const extension of this.supportedExtensions[0]) {
      const candidate = fileName + extension;
      if (fs.fileExists(candidate)) return candidate;
    }
    return new ReferenceDiagnostic(Diagnostics.Could_not_resolve_the_path_0_with_the_extensions_Colon_1, [
      diagnosticFileName,
      this.supportedExtensionsList(),
    ]);
  }

  // ---- Libraries

  /** The normalized file name of the library file `name` (`lib.dom.d.ts`), as `loadAhead` loads it. */
  libraryFileName(name: string): string {
    return getNormalizedAbsolutePath(this.pathForLibFile(name).path, this.host.currentDirectory);
  }

  private pathForLibFile(name: string): LibFile {
    const cached = this.libFileCache.get(name);
    if (cached !== undefined) return cached;
    let path = combinePaths(this.defaultLibraryPath, name);
    let replaced = false;
    if (this.options.libReplacement === true && name !== 'lib.d.ts') {
      const libraryName = getLibraryNameFromLibFileName(name);
      const containingDirectory =
        this.options.configFilePath !== undefined
          ? getDirectoryPath(this.options.configFilePath)
          : this.host.currentDirectory;
      const resolveFrom = combinePaths(containingDirectory, '__lib_node_modules_lookup_' + name + '__.ts');
      const trace: MessageWithArgs[] = [];
      const resolution = this.resolver.resolveModuleName(
        libraryName,
        resolveFrom,
        ModuleKind.CommonJS,
        undefined,
        trace,
      );
      if (resolution.resolvedFileName !== '') {
        path = resolution.resolvedFileName;
        replaced = true;
      }
      const key = this.toPath(resolveFrom);
      if (!this.libResolutions.has(key))
        this.libResolutions.set(key, new LibResolution(libraryName, resolution, trace));
    }
    const libFile = new LibFile(name, path, replaced);
    this.libFileCache.set(name, libFile);
    return libFile;
  }

  private libFilePriority(file: SourceFile): number {
    const directory = removeTrailingDirectorySeparator(this.defaultLibraryPath);
    const fileName = file.fileName;
    if (
      fileName.startsWith(directory) &&
      fileName.length > directory.length &&
      fileName.charCodeAt(directory.length) === 0x2f
    ) {
      const baseName = fileName.slice(fileName.lastIndexOf('/') + 1);
      if (baseName === 'lib.d.ts' || baseName === 'lib.es6.d.ts') return 0;
      let name = baseName.startsWith('lib.') ? baseName.slice(4) : baseName;
      if (name.endsWith('.d.ts')) name = name.slice(0, -5);
      const index = libNames.indexOf(name);
      if (index !== -1) return index + 1;
    }
    return libNames.length + 2;
  }

  // ---- Loading

  private start(tasks: ParseTask[], depth: number): void {
    const taskData = this.taskData;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      // Sub-tasks built ahead have their paths and tasks.
      let k = task.dataIndex;
      if (k < 0) {
        if (task.path === '') task.path = this.toPath(task.normalizedFilePath);
        k = this.dataIndexOf(task.path);
        task.dataIndex = k;
      }
      const data = taskData[k];
      const loaded = data.queued;
      if (!loaded) {
        data.queued = true;
        data.first = task;
        data.tasks.set(task.normalizedFilePath, task);
      }
      this.work.push(new ParseWork(tasks, i, data, loaded, depth));
    }
  }

  /** The index in `taskData` of the tasks of `path`, created if needed. */
  private dataIndexOf(path: string): number {
    let k = this.taskDataByPath.get(path);
    if (k === undefined) {
      k = this.taskData.length;
      this.taskData.push(new ParseTaskData());
      this.taskDataByPath.set(path, k);
    }
    return k;
  }

  private run(work: ParseWork): void {
    const task = work.tasks[work.index];
    const data = work.data;
    let startSubTasks = false;
    if (work.loaded) {
      const name = task.normalizedFilePath;
      const first = data.first;
      const existing = first !== undefined && first.normalizedFilePath === name ? first : data.tasks.get(name);
      if (existing !== undefined) {
        task.loadedTask = existing;
      } else {
        data.tasks.set(name, task);
        data.settled = false;
        // A new casing of a file: load its references if another casing's were.
        startSubTasks = data.startedSubTasks;
      }
    }
    if (data.packageId === undefined && task.packageId !== undefined) data.packageId = task.packageId;
    const depth = task.increaseDepth ? work.depth + 1 : work.depth;
    const lowered = depth < data.lowestDepth;
    if (lowered) {
      // Reached at a lower depth than before: load references again.
      data.lowestDepth = depth;
      startSubTasks = true;
      data.startedSubTasks = true;
    }
    if (task.elideOnDepth && depth > this.maxNodeModuleJsDepth) return;
    // Most work reaches a path already loaded, at no lower depth.
    if (data.settled && !startSubTasks) return;
    for (const taskByFileName of data.tasks.values()) {
      let loadSubTasks = startSubTasks;
      if (!taskByFileName.loaded) {
        this.loadTask(taskByFileName);
        if (taskByFileName.redirectedParseTask !== undefined) {
          loadSubTasks = true;
          data.startedSubTasks = true;
        }
      }
      // A lower depth restarts references already started, which may now be loaded past `maxNodeModuleJsDepth`.
      // Every file reached from them is at least as deep, so a depth past it changes nothing they load.
      if (loadSubTasks && ((lowered && depth <= this.maxNodeModuleJsDepth) || !taskByFileName.startedSubTasks)) {
        taskByFileName.startedSubTasks = true;
        if (taskByFileName.subTasks !== undefined) this.start(taskByFileName.subTasks, data.lowestDepth);
      }
    }
    data.settled = true;
  }

  /**
   * Whether running the work of `task` (of `data`'s path) may parse a file that parse threads have not
   * prepared yet: a task of the path not loaded yet, or `task`, a new casing.
   */
  private parsesUnprepared(task: ParseTask, data: ParseTaskData): boolean {
    if (!data.tasks.has(task.normalizedFilePath) && !isPrepared(task.normalizedFilePath)) return true;
    for (const other of data.tasks.values())
      if (!other.loaded && !other.isForAutomaticTypeDirective && !isPrepared(other.normalizedFilePath)) return true;
    return false;
  }

  private loadTask(task: ParseTask): void {
    task.loaded = true;
    if (task.isForAutomaticTypeDirective) {
      this.loadAutomaticTypeDirectives(task);
      return;
    }
    if (task.failedLookup) return;
    const redirect = this.mapper.getParseFileRedirect(task.path);
    if (redirect !== '') {
      const redirected = new ParseTask(
        normalizePath(redirect),
        task.libFile,
        task.includeReason,
        false,
        false,
        false,
        undefined,
      );
      task.redirectedParseTask = redirected;
      task.subTasks = [redirected];
      return;
    }

    const fs = this.host.fs;
    if (hasExtension(task.normalizedFilePath) && this.options.allowNonTsExtensions !== true) {
      const canonicalFileName = getCanonicalFileName(task.normalizedFilePath, fs.useCaseSensitiveFileNames);
      if (!this.isSupportedExtension(canonicalFileName)) {
        task.addProcessingDiagnostic(
          hasJSFileExtension(canonicalFileName)
            ? ProcessingDiagnostic.explainingFileInclude(
                '',
                task.includeReason,
                Diagnostics.File_0_is_a_JavaScript_file_Did_you_mean_to_enable_the_allowJs_option,
                [task.normalizedFilePath],
              )
            : ProcessingDiagnostic.explainingFileInclude(
                '',
                task.includeReason,
                Diagnostics.File_0_has_an_unsupported_extension_The_only_supported_extensions_are_1,
                [task.normalizedFilePath, this.supportedExtensionsList()],
              ),
        );
        return;
      }
    }

    // What a parse thread found loading this file, if it prepared it as the same kind of file.
    let loaded = this.takesPreparedResolutions ? preparedLoad(task.normalizedFilePath) : undefined;
    if (loaded !== undefined && loaded.isLibFile !== (task.libFile !== undefined)) loaded = undefined;
    // Default libraries are scripts: skip looking up their package.json.
    task.metadata =
      task.libFile !== undefined
        ? libFileMetadata
        : (loaded?.metadata ?? this.loadSourceFileMetadata(task.normalizedFilePath));
    const options = this.mapper.getCompilerOptionsForFile(task.path, task.normalizedFilePath);
    const file = this.host.getSourceFile(
      task.normalizedFilePath,
      task.path,
      getExternalModuleIndicatorOptions(task.normalizedFilePath, options, task.metadata),
    );
    if (file === undefined) return;
    task.file = file;
    if (loaded !== undefined && loaded.file === file) {
      this.takeLoadedFile(task, loaded);
      return;
    }

    if (this.options.noResolve !== true) {
      for (let i = 0; i < file.referencedFiles.length; i++) this.resolveTripleSlashPathReference(task, file, i);
      this.resolveTypeReferenceDirectives(task, file);
    }
    if (this.options.noLib !== true) {
      for (let i = 0; i < file.libReferenceDirectives.length; i++) {
        const reason = FileIncludeReason.reference(FileIncludeKind.LibReferenceDirective, task.path, i, undefined);
        const name = getLibFileName(file.libReferenceDirectives[i].fileName);
        if (name === '') {
          task.addProcessingDiagnostic(ProcessingDiagnostic.unknownReference(reason));
          continue;
        }
        const libFile = this.pathForLibFile(name);
        task.addSubTask(libFile.path, libFile, reason, false, false, undefined);
      }
    }
    this.resolveImportsAndModuleAugmentations(task, file);
  }

  /** Loads `task` from what a parse thread found loading the same file (`LoadedFile`). */
  private takeLoadedFile(task: ParseTask, loaded: LoadedFile): void {
    this.tookPreparedResolutions = true;
    const ahead = this.subTasksAhead.get(task.normalizedFilePath);
    if (ahead !== undefined && ahead.loaded === loaded) {
      this.subTasksAhead.delete(task.normalizedFilePath);
      task.subTasks = ahead.subTasks;
    } else task.subTasks = this.subTasksOf(loaded);
    for (const diagnostic of loaded.processingDiagnostics) task.addProcessingDiagnostic(diagnostic.copy());
    task.resolutionsInFile = loaded.resolutionsInFile;
    task.typeResolutionsInFile = loaded.typeResolutionsInFile;
    task.importHelpersImportSpecifier = loaded.importHelpersImportSpecifier;
    task.jsxRuntimeImport = loaded.jsxRuntimeImport;
  }

  /** New tasks of the references a parse thread found loading a file. */
  private subTasksOf(loaded: LoadedFile): ParseTask[] {
    const subTasks: ParseTask[] = [];
    for (const reference of loaded.references) {
      const libFile = reference.libName !== '' ? this.pathForLibFile(reference.libName) : undefined;
      subTasks.push(
        new ParseTask(
          reference.normalizedFilePath,
          libFile,
          reference.reason,
          false,
          reference.increaseDepth,
          reference.elideOnDepth,
          reference.packageId,
        ),
      );
    }
    return subTasks;
  }

  private loadSourceFileMetadata(fileName: string): SourceFileMetadata {
    return sourceFileMetadataOf(this.resolver, this.options, fileName);
  }

  private resolveTripleSlashPathReference(task: ParseTask, file: SourceFile, index: number): void {
    const moduleName = file.referencedFiles[index].fileName;
    const containingFile = file.fileName;
    const referencedFileName = isRootedDiskPath(moduleName)
      ? moduleName
      : combinePaths(getDirectoryPath(containingFile), moduleName);
    const reason = FileIncludeReason.reference(
      FileIncludeKind.ReferenceFile,
      this.toPath(containingFile),
      index,
      undefined,
    );
    const resolved = this.getSourceFileFromReference(
      normalizePath(referencedFileName),
      moduleName,
      containingFile,
      reason,
    );
    if (typeof resolved !== 'string') {
      task.addProcessingDiagnostic(
        ProcessingDiagnostic.explainingFileInclude('', reason, resolved.message, resolved.args),
      );
      return;
    }
    task.addSubTask(resolved, undefined, reason, false, false, undefined);
  }

  private resolveTypeReferenceDirectives(task: ParseTask, file: SourceFile): void {
    const references = file.typeReferenceDirectives;
    if (references.length === 0) return;
    const resolutions: ModeAwareCache<ResolvedTypeReferenceDirective> = new Map();
    for (let i = 0; i < references.length; i++) {
      const reference = references[i];
      const redirect = this.mapper.getRedirectForResolution(file.path, file.fileName);
      const containingFile = redirect !== undefined ? redirect.source : file.fileName;
      const options = redirect !== undefined ? redirect.resolved.options : this.options;
      const mode =
        reference.resolutionMode !== ModuleKind.None
          ? reference.resolutionMode
          : getDefaultResolutionModeForFile(file.fileName, task.metadata, options);
      const resolved = this.resolver.resolveTypeReferenceDirective(
        reference.fileName,
        containingFile,
        mode,
        redirect?.resolved,
        task.typeTraces(this.options.traceResolution === true),
      );
      resolutions.set(modeAwareKey(reference.fileName, mode), resolved);
      const reason = FileIncludeReason.reference(FileIncludeKind.TypeReferenceDirective, task.path, i, undefined);
      if (resolved.resolvedFileName !== '') {
        task.addSubTask(
          resolved.resolvedFileName,
          undefined,
          reason,
          resolved.isExternalLibraryImport,
          false,
          resolved.packageId,
        );
      } else {
        task.addProcessingDiagnostic(ProcessingDiagnostic.unknownReference(reason));
      }
    }
    task.typeResolutionsInFile = resolutions;
  }

  private loadAutomaticTypeDirectives(task: ParseTask): void {
    const names = getAutomaticTypeDirectiveNames(this.options, this.host);
    if (names.length === 0) return;
    const resolutions: ModeAwareCache<ResolvedTypeReferenceDirective> = new Map();
    for (const name of names) {
      // Resolved without a mode: CommonJS under node16/nodenext, `import` conditions under bundler.
      const resolved = this.resolver.resolveTypeReferenceDirective(
        name,
        task.normalizedFilePath,
        ModuleKind.None,
        undefined,
        task.typeTraces(this.options.traceResolution === true),
      );
      resolutions.set(modeAwareKey(name, ModuleKind.None), resolved);
      if (resolved.resolvedFileName !== '') {
        task.addSubTask(
          resolved.resolvedFileName,
          undefined,
          FileIncludeReason.automaticTypeDirective(name, resolved.packageId),
          resolved.isExternalLibraryImport,
          false,
          resolved.packageId,
        );
      } else {
        task.addProcessingDiagnostic(
          ProcessingDiagnostic.explainingFileInclude(
            '',
            FileIncludeReason.automaticTypeDirective(name, undefined),
            Diagnostics.Cannot_find_type_definition_file_for_0,
            [name],
          ),
        );
      }
    }
    task.typeResolutionsInFile = resolutions;
  }

  private resolveImportsAndModuleAugmentations(task: ParseTask, file: SourceFile): void {
    const moduleNames: Node[] = [];
    const redirect = this.mapper.getRedirectForResolution(file.path, file.fileName);
    const containingFile = redirect !== undefined ? redirect.source : file.fileName;
    const options = redirect !== undefined ? redirect.resolved.options : this.options;
    if (needsImportHelpersImportSpecifier(file, options)) {
      const specifier = createSyntheticImport('tslib', file);
      moduleNames.push(specifier);
      task.importHelpersImportSpecifier = specifier;
    }
    const jsxImport = jsxRuntimeImportOf(file, options);
    if (jsxImport !== '') {
      const specifier = createSyntheticImport(jsxImport, file);
      moduleNames.push(specifier);
      task.jsxRuntimeImport = new JsxRuntimeImport(jsxImport, specifier);
    }
    const importsStart = moduleNames.length;
    for (const specifier of file.imports) moduleNames.push(specifier);
    for (const augmentation of file.moduleAugmentations) {
      // `declare global` needs no resolution.
      if (augmentation.kind === SyntaxKind.StringLiteral) moduleNames.push(augmentation);
    }
    if (moduleNames.length === 0) return;

    const resolutions: ModeAwareCache<ResolvedModule> = new Map();
    for (let index = 0; index < moduleNames.length; index++) {
      const entry = moduleNames[index];
      const moduleName = getText(entry);
      // A source phase import loads no module declarations.
      if (moduleName === '' || isSourcePhaseImport(entry.parent!)) continue;
      const mode = getModeForUsageLocation(file.fileName, task.metadata, entry, options);
      // A module the file declares itself (`declare module "m"`) isn't resolved.
      if (file.ambientModuleNames.includes(moduleName)) {
        if (options.traceResolution === true)
          task
            .moduleTraces(true)!
            .push(
              messageWithArgs(
                Diagnostics.Module_0_was_resolved_as_locally_declared_ambient_module_in_file_1,
                moduleName,
                file.fileName,
              ),
            );
        resolutions.set(modeAwareKey(moduleName, mode), locallyDeclaredModule);
        continue;
      }
      const resolved = this.resolver.resolveModuleName(
        moduleName,
        containingFile,
        mode,
        redirect?.resolved,
        task.moduleTraces(this.options.traceResolution === true),
      );
      resolutions.set(modeAwareKey(moduleName, mode), resolved);
      const resolvedFileName = resolved.resolvedFileName;
      if (resolvedFileName === '') continue;
      // Redirected files are not JavaScript files.
      const isJsFile =
        !fileExtensionIsOneOf(resolvedFileName, supportedTSExtensionsWithJsonFlat) &&
        this.mapper.getRedirectForResolution(this.toPath(resolvedFileName), resolvedFileName) === undefined;
      const isJsFileFromNodeModules =
        resolved.isExternalLibraryImport && isJsFile && resolvedFileName.includes('/node_modules/');
      const importIndex = index - importsStart;
      const imports = file.imports;
      // Imports from JSDoc of TypeScript files only resolve; module augmentations aren't added either.
      const shouldAddFile =
        getResolutionDiagnostic(options, resolved, file.isDeclarationFile) === undefined &&
        options.noResolve !== true &&
        !(isJsFile && !getAllowJS(options)) &&
        (importIndex < 0 ||
          (importIndex < imports.length &&
            ((imports[importIndex].flags & NodeFlags.JavaScriptFile) !== 0 ||
              (imports[importIndex].flags & NodeFlags.JSDoc) === 0)));
      if (!shouldAddFile) continue;
      // `as`: scriptc loses instanceof narrowing here.
      const specifier = importIndex < 0 && entry instanceof StringLiteral ? (entry as StringLiteral) : undefined;
      task.addSubTask(
        resolvedFileName,
        undefined,
        FileIncludeReason.reference(FileIncludeKind.Import, task.path, importIndex, specifier),
        resolved.isExternalLibraryImport,
        isJsFileFromNodeModules,
        resolved.packageId,
      );
    }
    task.resolutionsInFile = resolutions;
  }

  // ---- Collecting

  private collect(): ProcessedFiles {
    const host = this.host;
    const cs = host.fs.useCaseSensitiveFileNames;
    const missingFiles: string[] = [];
    const files: SourceFile[] = [];
    const libFiles: SourceFile[] = [];
    const filesByPath = new Map<string, SourceFile>();
    const tasksSeenByNameIgnoreCase = cs ? new Map<string, ParseTask>() : undefined;
    const includeProcessor = new IncludeProcessor();
    const outputFileToProjectReferenceSource = new Map<string, string>();
    const resolvedModules = new Map<string, ModeAwareCache<ResolvedModule> | undefined>();
    const typeResolutionsInFile = new Map<string, ModeAwareCache<ResolvedTypeReferenceDirective> | undefined>();
    const sourceFileMetadata = new Map<string, SourceFileMetadata>();
    const jsxRuntimeImports = new Map<string, JsxRuntimeImport>();
    const importHelpersImportSpecifiers = new Map<string, StringLiteral>();
    const sourceFilesFoundSearchingNodeModules = new Set<string>();
    const libFilesByPath = new Map<string, LibFile>();
    const deduplicatePackages = this.options.deduplicatePackages !== false;
    const redirectTargets = new Map<string, string[]>();
    const redirectFilesByPath = new Map<string, RedirectFile>();
    const packageIdToSourceFile = new Map<string, SourceFile>();
    const checkCasing = this.options.forceConsistentCasingInFileNames !== false;
    const taskData = this.taskData;
    // The paths each file's imports and type reference directives add (the tasks of each path), for
    // `ProcessedFiles.addedFiles`: recorded while collecting visits them, as their files are only known
    // once every file is collected.
    const fileData: ParseTaskData[] = [];
    const libData = new Map<SourceFile, ParseTaskData>();
    const packageIdToData = new Map<string, ParseTaskData>();

    const collectFiles = (tasks: readonly ParseTask[], added: ParseTaskData[] | undefined): void => {
      for (let task of tasks) {
        const includeReason = task.includeReason;
        const byImport = task.byImport;
        // Automatic type directive tasks are an implementation detail, not a reason.
        if (task.redirectedParseTask === undefined && !task.isForAutomaticTypeDirective) {
          if (task.loadedTask !== undefined) task = task.loadedTask;
          if (includeReason !== undefined) addIncludeReason(includeProcessor, taskData, task, includeReason);
        }
        const data = task.dataIndex >= 0 ? taskData[task.dataIndex] : undefined;
        if (added !== undefined && data !== undefined && byImport) added.push(data);
        if (!task.loaded || data === undefined) continue;

        const checkedName = data.collectedName;
        if (checkedName !== undefined) {
          // The same name normalizes the same: only another spelling needs comparing.
          if (
            checkCasing &&
            checkedName !== task.normalizedFilePath &&
            withoutRoot(getNormalizedAbsolutePath(checkedName, host.currentDirectory)) !==
              withoutRoot(getNormalizedAbsolutePath(task.normalizedFilePath, host.currentDirectory))
          ) {
            includeProcessor.addCasingDiagnostic(task.path, checkedName, task.normalizedFilePath, includeReason);
          }
          continue;
        }
        data.collectedName = task.normalizedFilePath;

        if (tasksSeenByNameIgnoreCase !== undefined) {
          const lowerCasePath = toFileNameLowerCase(task.path);
          const existing = tasksSeenByNameIgnoreCase.get(lowerCasePath);
          if (existing !== undefined) {
            includeProcessor.addCasingDiagnostic(
              existing.path,
              existing.normalizedFilePath,
              task.normalizedFilePath,
              includeReason,
            );
          } else {
            tasksSeenByNameIgnoreCase.set(lowerCasePath, task);
          }
        }

        for (const trace of task.typeResolutionsTrace ?? noTraces) host.trace(trace);
        for (const trace of task.resolutionsTrace ?? noTraces) host.trace(trace);

        const file = task.file;
        const packageId = data.packageId;
        if (deduplicatePackages && packageId !== undefined && packageId.name !== '') {
          const key = packageIdKey(packageId);
          const packageIdFile = packageIdToSourceFile.get(key);
          if (packageIdFile !== undefined) {
            const targets = redirectTargets.get(packageIdFile.path);
            if (targets === undefined) redirectTargets.set(packageIdFile.path, [task.normalizedFilePath]);
            else targets.push(task.normalizedFilePath);
            redirectFilesByPath.set(
              task.path,
              new RedirectFile(
                files.length + redirectFilesByPath.size,
                task.normalizedFilePath,
                task.path,
                packageIdFile.path,
              ),
            );
            filesByPath.set(task.path, packageIdFile);
            data.keptCopy = packageIdToData.get(key);
            if (data.lowestDepth > 0) sourceFilesFoundSearchingNodeModules.add(task.path);
            continue;
          }
          if (file !== undefined) {
            packageIdToSourceFile.set(key, file);
            packageIdToData.set(key, data);
          }
        }

        let own: ParseTaskData[] | undefined = undefined;
        if (task.subTasks !== undefined && task.subTasks.length > 0) collectFiles(task.subTasks, (own = []));

        const redirected = task.redirectedParseTask;
        if (redirected !== undefined) {
          outputFileToProjectReferenceSource.set(redirected.path, task.normalizedFilePath);
          continue;
        }
        if (task.isForAutomaticTypeDirective) {
          typeResolutionsInFile.set(task.path, task.typeResolutionsInFile);
          for (const diagnostic of task.processingDiagnostics ?? noProcessingDiagnostics)
            includeProcessor.addProcessingDiagnostic(diagnostic);
          continue;
        }
        for (const diagnostic of task.processingDiagnostics ?? noProcessingDiagnostics)
          includeProcessor.addProcessingDiagnostic(diagnostic);
        if (file === undefined) {
          missingFiles.push(task.normalizedFilePath);
          continue;
        }
        // The program's maps of the file are keyed by the file's own path: lookups by `file.path` then find
        // the same string, also for a file a parse thread created, whose path is another string than the task's.
        const path = file.path === task.path ? file.path : task.path;
        if (task.libFile !== undefined) {
          libFiles.push(file);
          libData.set(file, data);
          libFilesByPath.set(path, task.libFile);
        } else {
          files.push(file);
          fileData.push(data);
        }
        if (own !== undefined) data.added = own;
        filesByPath.set(path, file);
        resolvedModules.set(path, task.resolutionsInFile);
        typeResolutionsInFile.set(path, task.typeResolutionsInFile);
        sourceFileMetadata.set(path, task.metadata);
        if (task.jsxRuntimeImport !== undefined) jsxRuntimeImports.set(path, task.jsxRuntimeImport);
        if (task.importHelpersImportSpecifier !== undefined) {
          importHelpersImportSpecifiers.set(path, task.importHelpersImportSpecifier);
        }
        if (data.lowestDepth > 0) sourceFilesFoundSearchingNodeModules.add(path);
      }
    };
    collectFiles(this.rootTasks, undefined);

    const priorities = new Map<SourceFile, number>();
    for (const file of libFiles) priorities.set(file, this.libFilePriority(file));
    libFiles.sort((a, b) => (priorities.get(a) ?? 0) - (priorities.get(b) ?? 0));
    const allFiles = [...libFiles, ...files];
    for (const redirect of redirectFilesByPath.values()) redirect.index += libFiles.length;
    // The files a file adds, without reading its resolutions again or looking up their paths.
    const dataOfFiles: ParseTaskData[] = [];
    for (const file of libFiles) dataOfFiles.push(libData.get(file)!);
    for (const data of fileData) dataOfFiles.push(data);
    for (let i = 0; i < dataOfFiles.length; i++) dataOfFiles[i]!.index = i;
    const addedFiles: number[][] = [];
    for (let i = 0; i < dataOfFiles.length; i++) {
      const added: number[] = [];
      for (const data of dataOfFiles[i]!.added) {
        const kept = data.keptCopy;
        const k = kept !== undefined ? kept.index : data.index;
        if (k >= 0 && k !== i) added.push(k);
      }
      addedFiles.push(added);
    }

    const keys = [...this.libResolutions.keys()].sort();
    for (const key of keys) {
      const resolution = this.libResolutions.get(key);
      if (resolution === undefined) continue;
      const cache: ModeAwareCache<ResolvedModule> = new Map();
      cache.set(modeAwareKey(resolution.libraryName, ModuleKind.CommonJS), resolution.resolution);
      resolvedModules.set(key, cache);
      for (const trace of resolution.trace) host.trace(trace);
    }

    return new ProcessedFiles(
      this.resolver,
      allFiles,
      filesByPath,
      missingFiles,
      resolvedModules,
      typeResolutionsInFile,
      sourceFileMetadata,
      jsxRuntimeImports,
      importHelpersImportSpecifiers,
      libFilesByPath,
      sourceFilesFoundSearchingNodeModules,
      includeProcessor,
      outputFileToProjectReferenceSource,
      redirectTargets,
      redirectFilesByPath,
      this.mapper,
      this.tookPreparedResolutions ? preparedPackageJsonLookups() : noPackageJsonLookups,
      addedFiles,
    );
  }
}

const noPackageJsonLookups: readonly PackageJsonLookup[] = [];

/** Releases `loader` (`FileLoader.release`) on a later turn of the event loop, while checking runs. */
export function releaseLater(loader: FileLoader): void {
  setImmediate(() => loader.release());
}

function addIncludeReason(
  processor: IncludeProcessor,
  taskData: readonly ParseTaskData[],
  task: ParseTask,
  reason: FileIncludeReason,
): void {
  const redirected = task.redirectedParseTask;
  if (redirected !== undefined) addIncludeReason(processor, taskData, redirected, reason);
  else if (task.loaded) {
    // The path's list, without looking the path up for each reference to the file.
    const data = task.dataIndex >= 0 ? taskData[task.dataIndex] : undefined;
    if (data === undefined) processor.addReason(task.path, reason);
    else if (data.reasons !== undefined) data.reasons.push(reason);
    else data.reasons = processor.addReason(task.path, reason);
  }
}

function createProjectReferenceTasks(paths: readonly string[]): ProjectReferenceTask[] {
  const tasks: ProjectReferenceTask[] = [];
  for (const path of paths) tasks.push(new ProjectReferenceTask(path));
  return tasks;
}

function packageIdKey(id: PackageId): string {
  return id.name + '\0' + id.subModuleName + '\0' + id.version + '\0' + id.peerDependencies;
}

function withoutRoot(path: string): string {
  return path.slice(getRootLength(path));
}

/** A specifier of an import the compiler adds, such as `tslib` for `importHelpers`. */
function createSyntheticImport(text: string, file: SourceFile): StringLiteral {
  const specifier = new StringLiteral(text, TokenFlags.None);
  const declaration = new ImportDeclaration(SyntaxKind.ImportDeclaration, undefined, undefined, specifier, undefined);
  specifier.parent = declaration;
  declaration.parent = file;
  return specifier;
}

/** `lib.dom.iterable.d.ts` to `@typescript/lib-dom/iterable`, `lib.es2015.symbol.wellknown.d.ts` to `@typescript/lib-es2015/symbol-wellknown`. */
function getLibraryNameFromLibFileName(libFileName: string): string {
  const components = libFileName.split('.');
  let path = '@typescript/lib-';
  if (components.length > 1) path += components[1];
  for (let i = 2; i < components.length && components[i] !== '' && components[i] !== 'd'; i++) {
    path += (i === 2 ? '/' : '-') + components[i];
  }
  return path;
}

/**
 * The metadata of `fileName` in a program with `options`: the `type` and directory of its nearest
 * package.json (`resolver`), where they apply, and its implied module format.
 */
export function sourceFileMetadataOf(
  resolver: Resolver,
  options: CompilerOptions,
  fileName: string,
): SourceFileMetadata {
  const scope = resolver.getPackageScopeForPath(getDirectoryPath(fileName));
  const kind = getModuleResolutionKind(options);
  let packageJsonType = '';
  let packageJsonDirectory = '';
  const contents = scope?.contents;
  if (scope !== undefined && contents !== undefined) {
    packageJsonDirectory = scope.packageDirectory;
    const type = contents.type.value;
    if (
      type !== undefined &&
      ((!fileExtensionIsOneOf(fileName, ['.mts', '.cts', '.mjs', '.cjs']) &&
        ModuleResolutionKind.Node16 <= kind &&
        kind <= ModuleResolutionKind.NodeNext) ||
        fileName.includes('/node_modules/'))
    ) {
      packageJsonType = type;
    }
  }
  return new SourceFileMetadata(
    packageJsonType,
    packageJsonDirectory,
    getImpliedNodeFormatForFile(fileName, packageJsonType),
  );
}
