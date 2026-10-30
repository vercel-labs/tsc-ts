/**
 * A program: the files of a compilation and the diagnostics found building it, before binding and checking.
 *
 * ```ts
 * const program = new Program(config, new CompilerHost(fs, cwd, libDirectory));
 * for (const file of program.getSourceFiles()) console.log(file.fileName);
 * ```
 */
import {
  ArrayLiteralExpression,
  Decorator,
  getText,
  NodeVisitor,
  ObjectLiteralExpression,
  ParameterDeclaration,
  ScriptKind,
  type Node,
  type PropertyAssignment,
  type SourceFile,
} from './ast.js';
import {
  compareDiagnostics,
  createCompilerDiagnostic,
  Diagnostic,
  Diagnostics,
  equalDiagnostics,
  equalDiagnosticsNoRelatedInfo,
  type DiagnosticMessage,
  type Locale,
  sortDiagnostics,
  useThreadTextCaches,
} from './diagnostics.js';
import {
  canReplaceFile,
  FileLoader,
  jsxRuntimeImportOf,
  modeAwareKey,
  needsImportHelpersImportSpecifier,
  withReplacedFile,
  type CompilerHost,
  type LibFile,
  type ProcessedFiles,
  type RedirectFile,
} from './file-loader.js';
import { type PackageJsonInfo, PackageJsonLookup } from './package-json.js';
import type { MergedGlobals } from './checker-symbols.js';
import type { EmitIndexes } from './compile-program.js';
import { ProcessingDiagnostic, type IncludeProcessor } from './file-include.js';
import type { ResolvedModule } from './module-resolution-types.js';
import { getTypesPackageName, moduleResolutionKindName } from './module-resolution-types.js';
import {
  getAllowJS,
  getEmitDeclarations,
  getEmitModuleKind,
  getEmitScriptTarget,
  getModuleResolutionKind,
  getStrictOptionValue,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  type CompilerOptions,
} from './options.js';
import {
  getCommonSourceDirectory,
  getComputedCommonSourceDirectory,
  getOutputPathsFor,
  getSourceFilePathInNewDirWorker,
  type OutputPathsHost,
} from './output-paths.js';
import { parseIsolatedEntityName } from './parser.js';
import {
  combinePaths,
  comparePaths,
  containsPath,
  getBaseFileName,
  getCanonicalFileName,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getPathComponentsRelativeTo,
  getPathFromPathComponents,
  getRelativePathFromFile,
  getRootLength,
  pathIsAbsolute,
  pathIsRelative,
  toFileNameLowerCase,
  toPath,
  isNetworkPathValue,
} from './path.js';
import {
  getDefaultResolutionModeForFile,
  getImpliedNodeFormatForEmit,
  getModeForUsageLocation,
  isCheckJsEnabledForFile,
  isSourceFileJS,
  jsxEmitName,
  moduleKindName,
  SourceFileMetadata,
  libFileMetadata,
} from './program-utilities.js';
import { isIdentifierText } from './scanner.js';
import {
  diagnosticAtNode,
  findPropertyAssignment,
  getTsConfigObjectLiteral,
  type ParsedCommandLine,
  type SourceOutputAndProjectReference,
} from './tsconfig.js';
import { SyntaxKind } from './syntax-kind.js';
import { isSourcePhaseImport } from './ast-utilities.js';
import { KnownSymlinks } from './symlinks.js';
import { mark } from './timeline.js';
import { LanguageVariant } from './types.js';

// The symlink caches and packages maps of programs shared with other threads (`prepareForSharing`),
// as this thread computed them.
const threadSymlinkCaches = new Map<Program, KnownSymlinks>();
const threadPackagesMaps = new Map<Program, Map<string, boolean>>();

export class Program implements OutputPathsHost {
  readonly options: CompilerOptions;
  readonly currentDirectory: string;
  readonly useCaseSensitiveFileNames: boolean;
  readonly includeProcessor: IncludeProcessor;
  private readonly processed: ProcessedFiles;
  private readonly programDiagnosticsList: Diagnostic[] = [];
  private readonly emitBlockingPaths = new Set<string>();
  private commonSourceDirectoryValue: string | undefined = undefined;
  private packagesMap: Map<string, boolean> | undefined = undefined;
  private symlinks: KnownSymlinks | undefined = undefined;
  /** Set by `prepareForSharing`: the program is immutable from then on. */
  private shared = false;
  /** The globals and module augmentations as the main thread's checker merged them, for checker threads. */
  mergedGlobals: MergedGlobals | undefined = undefined;
  /** What emit resolvers index for all files, built by the main thread for checker threads. */
  emitIndexes: EmitIndexes | undefined = undefined;

  /**
   * `loader`, if given, is a FileLoader of `host` and `commandLine` that has not loaded yet. With `previous`
   * and `processed` (`updateFile`), the program takes `processed` as its files and the option diagnostics of
   * `previous`.
   */
  constructor(
    readonly commandLine: ParsedCommandLine,
    readonly host: CompilerHost,
    loader?: FileLoader,
    previous?: Program,
    processed?: ProcessedFiles,
  ) {
    this.options = commandLine.options;
    this.currentDirectory = host.currentDirectory;
    this.useCaseSensitiveFileNames = host.fs.useCaseSensitiveFileNames;
    if (previous !== undefined && processed !== undefined) {
      this.processed = processed;
      this.includeProcessor = processed.includeProcessor;
      for (const diagnostic of previous.programDiagnosticsList) this.programDiagnosticsList.push(diagnostic);
      for (const path of previous.emitBlockingPaths) this.emitBlockingPaths.add(path);
      // The files and include reasons it takes from a program shared with checker threads are immutable, and
      // so is that program's symlink cache: this one computes its own then (`getSymlinkCache`).
      this.shared = previous.shared;
      if (!previous.shared) this.symlinks = previous.symlinks;
      // The same files are emitted, so the common source directory is the same. Its diagnostics are those
      // `previous` was created with (`IncludeProcessor.copy`).
      this.commonSourceDirectoryValue = previous.commonSourceDirectoryValue;
    } else {
      this.processed = (loader ?? new FileLoader(host, commandLine)).load();
      this.includeProcessor = this.processed.includeProcessor;
      this.verifyCompilerOptions();
    }
    this.includeProcessor.noteProgramCreated();
  }

  /**
   * The program with the file at `path` read again from `host` and everything else taken from this program,
   * as tsgo's UpdateProgram makes it: `undefined` when the file is not in the program, belongs to a package
   * that is installed more than once, or no longer imports, references or needs the same modules
   * (`canReplaceFile`, and the tslib and JSX runtime imports the program kept for the file), so the program
   * must be loaded again.
   */
  updateFile(path: string, host: CompilerHost): Program | undefined {
    const processed = this.processed;
    const file = processed.filesByPath.get(path);
    if (file === undefined) return undefined;
    const next = host.getSourceFile(file.fileName, file.path, file.externalModuleIndicatorOptions);
    if (next === undefined) return undefined;
    if (processed.redirectFilesByPath.has(path) || processed.redirectTargets.has(path)) return undefined;
    if (!canReplaceFile(file, next, (f, specifier) => this.getModeForUsageLocation(f, specifier))) return undefined;
    const options = processed.projectReferenceMapper.getCompilerOptionsForFile(next.path, next.fileName);
    if (processed.importHelpersImportSpecifiers.has(path) !== needsImportHelpersImportSpecifier(next, options))
      return undefined;
    const jsxImport = processed.jsxRuntimeImports.get(path);
    if ((jsxImport === undefined ? '' : jsxImport.moduleReference) !== jsxRuntimeImportOf(next, options))
      return undefined;
    return new Program(this.commandLine, host, undefined, this, withReplacedFile(processed, next));
  }

  /** Libraries first, then the other files in the order they were found. */
  getSourceFiles(): readonly SourceFile[] {
    return this.processed.files;
  }

  getSourceFileByPath(path: string): SourceFile | undefined {
    return this.processed.filesByPath.get(path);
  }

  getSourceFile(fileName: string): SourceFile | undefined {
    return this.getSourceFileByPath(this.toPath(fileName));
  }

  /** Files that were referenced but could not be read. */
  missingFiles(): readonly string[] {
    return this.processed.missingFiles;
  }

  toPath(fileName: string): string {
    return toPath(fileName, this.currentDirectory, this.useCaseSensitiveFileNames);
  }

  emitScriptTarget(): ScriptTarget {
    return getEmitScriptTarget(this.options);
  }

  /** `fileName` as given, or relative to the current directory. */
  displayFileName(fileName: string, relative: boolean): string {
    if (!relative) return fileName;
    return getPathFromPathComponents(
      getPathComponentsRelativeTo(
        this.currentDirectory,
        fileName,
        this.useCaseSensitiveFileNames,
        this.currentDirectory,
      ),
    );
  }

  // ---- Files

  isSourceFileFromExternalLibrary(file: SourceFile): boolean {
    return this.processed.sourceFilesFoundSearchingNodeModules.has(file.path);
  }

  isSourceFileDefaultLibrary(path: string): boolean {
    return this.processed.libFiles.has(path);
  }

  /** The bundled library loaded as `path`, if any. */
  getDefaultLibFile(path: string): LibFile | undefined {
    return this.processed.libFiles.get(path);
  }

  /** The declaration output loaded instead of a source of a referenced project, or `''`. */
  getParseFileRedirect(fileName: string): string {
    return this.processed.projectReferenceMapper.getParseFileRedirect(this.toPath(fileName));
  }

  /** Files the type reference directives of a file resolved to. */
  getResolvedTypeReferenceDirectiveFiles(path: string): string[] {
    const result: string[] = [];
    const resolutions = this.processed.typeResolutionsInFile.get(path);
    if (resolutions !== undefined) {
      for (const resolved of resolutions.values()) {
        if (resolved.resolvedFileName !== '') result.push(resolved.resolvedFileName);
      }
    }
    return result;
  }

  /**
   * Whether `packageJsonLookups` has every lookup of the program's module resolution: not where it
   * took resolutions from parse threads whose lookups may miss some (`preparedPackageJsonLookups`).
   */
  hasAllPackageJsonLookups(): boolean {
    return this.processed.preparedPackageJsons !== undefined;
  }

  /**
   * The `package.json` lookups of module resolution: this program's, and those of the parse threads
   * whose resolutions it took. A directory can be among both.
   */
  packageJsonLookups(): PackageJsonLookup[] {
    const result: PackageJsonLookup[] = [];
    for (const info of this.processed.resolver.packageJsonInfoCache.infos())
      result.push(new PackageJsonLookup(info.packageDirectory, info.contents !== undefined, info.directoryExists));
    const prepared = this.processed.preparedPackageJsons;
    if (prepared !== undefined) for (const lookup of prepared) result.push(lookup);
    return result;
  }

  /** The typings cache of automatic type acquisition, or `''`. */
  getGlobalTypingsCacheLocation(): string {
    return this.processed.resolver.typingsLocation;
  }

  /** Files of the same package version that redirect to the file at `path`. */
  getRedirectTargets(path: string): readonly string[] {
    return this.processed.redirectTargets.get(path) ?? [];
  }

  /** The nearest `package.json` lookup at or above `directory`. */
  getPackageScopeForPath(directory: string): PackageJsonInfo | undefined {
    return this.processed.resolver.getPackageScopeForPath(directory);
  }

  /** The directory of the nearest `package.json` at or above `directory`, or `''`. */
  getNearestAncestorDirectoryWithPackageJson(directory: string): string {
    const scope = this.processed.resolver.getPackageScopeForPath(directory);
    return scope !== undefined && scope.contents !== undefined ? scope.packageDirectory : '';
  }

  /** The `package.json` at `packageJsonPath`, if it exists and is the scope of its directory. */
  getPackageJsonInfo(packageJsonPath: string): PackageJsonInfo | undefined {
    const directory = getDirectoryPath(packageJsonPath);
    const scope = this.processed.resolver.getPackageScopeForPath(directory);
    return scope !== undefined && scope.contents !== undefined && scope.packageDirectory === directory
      ? scope
      : undefined;
  }

  /**
   * Directory symlinks seen by module resolution, and those of the runtime dependencies of the
   * packages that contain emitted files.
   */
  getSymlinkCache(): KnownSymlinks {
    let symlinks = this.symlinks ?? (this.shared ? threadSymlinkCaches.get(this) : undefined);
    if (symlinks !== undefined) return symlinks;
    symlinks = this.computeSymlinkCache();
    if (this.shared) threadSymlinkCaches.set(this, symlinks);
    else this.symlinks = symlinks;
    return symlinks;
  }

  private computeSymlinkCache(): KnownSymlinks {
    const symlinks = new KnownSymlinks(this.currentDirectory, this.useCaseSensitiveFileNames);
    // Resolutions record the symlink path they were found through.
    for (const resolutions of this.processed.resolvedModules.values())
      if (resolutions !== undefined)
        for (const resolved of resolutions.values())
          symlinks.processResolution(resolved.originalPath, resolved.resolvedFileName);
    for (const resolutions of this.processed.typeResolutionsInFile.values())
      if (resolutions !== undefined)
        for (const resolved of resolutions.values())
          symlinks.processResolution(resolved.originalPath, resolved.resolvedFileName);
    const seenPackageJsons = new Set<string>();
    // Directories as spelled, once one of their files got past the checks below: every file of a
    // package names its directory the same, and its path need not be computed again.
    const seenDirectories = new Set<string>();
    const resolver = this.processed.resolver;
    for (const [path, metadata] of this.processed.sourceFileMetadata) {
      const directory = metadata.packageJsonDirectory;
      if (directory === '' || seenDirectories.has(directory)) continue;
      const file = this.getSourceFileByPath(path);
      if (file === undefined || !this.sourceFileMayBeEmitted(file, false)) continue;
      const directoryPath = this.toPath(directory);
      seenDirectories.add(directory);
      if (seenPackageJsons.has(directoryPath)) continue;
      seenPackageJsons.add(directoryPath);
      const packageJsonName = combinePaths(directory, 'package.json');
      const contents = this.getPackageJsonInfo(packageJsonName)?.contents;
      if (contents === undefined) continue;
      for (const dependency of contents.getRuntimeDependencyNames()) {
        // Usually the symlink next to the package.json is already known.
        if (symlinks.hasDirectory(this.toPath(combinePaths(combinePaths(directory, 'node_modules'), dependency))))
          continue;
        if (
          !dependency.startsWith('@types') &&
          symlinks.hasDirectory(
            this.toPath(combinePaths(combinePaths(directory, 'node_modules'), getTypesPackageName(dependency))),
          )
        )
          continue;
        const resolved = resolver.resolvePackageDirectory(dependency, packageJsonName, ModuleKind.CommonJS);
        // A dependency installed in place has no original path to map from.
        if (resolved !== undefined && resolved.resolvedFileName !== '' && resolved.originalPath !== '')
          symlinks.processResolution(
            combinePaths(resolved.originalPath, 'package.json'),
            combinePaths(resolved.resolvedFileName, 'package.json'),
          );
      }
    }
    return symlinks;
  }

  sourceFileMetadata(path: string): SourceFileMetadata {
    return this.processed.sourceFileMetadata.get(path) ?? libFileMetadata;
  }

  redirectFile(path: string): RedirectFile | undefined {
    return this.processed.redirectFilesByPath.get(path);
  }

  /** The source of a referenced project whose declaration output was loaded as `path`, else `fileName`. */
  getSourceOfProjectReferenceIfOutputIncluded(path: string, fileName: string): string {
    return this.processed.outputFileToProjectReferenceSource.get(path) ?? fileName;
  }

  getProjectReferenceFromSource(path: string): SourceOutputAndProjectReference | undefined {
    return this.processed.projectReferenceMapper.sourceToProjectReference.get(path);
  }

  /** The configs of the project's references; `undefined` for those that couldn't be read. */
  getResolvedProjectReferences(): (ParsedCommandLine | undefined)[] {
    return this.processed.projectReferenceMapper.resolvedProjectReferences();
  }

  getCompilerOptionsForFile(file: SourceFile): CompilerOptions {
    return this.processed.projectReferenceMapper.getCompilerOptionsForFile(file.path, file.fileName);
  }

  importHelpersImportSpecifier(path: string): Node | undefined {
    return this.processed.importHelpersImportSpecifiers.get(path);
  }

  getModeForUsageLocation(file: SourceFile, location: Node): ModuleKind {
    return getModeForUsageLocation(
      file.fileName,
      this.sourceFileMetadata(file.path),
      location,
      this.getCompilerOptionsForFile(file),
    );
  }

  getImpliedNodeFormatForEmit(file: SourceFile): ModuleKind {
    return getImpliedNodeFormatForEmit(
      file.fileName,
      getEmitModuleKind(this.getCompilerOptionsForFile(file)),
      this.sourceFileMetadata(file.path),
    );
  }

  getDefaultResolutionModeForFile(file: SourceFile): ModuleKind {
    return getDefaultResolutionModeForFile(
      file.fileName,
      this.sourceFileMetadata(file.path),
      this.getCompilerOptionsForFile(file),
    );
  }

  /** The program file for a resolved file name, or the source file a referenced project's output redirects to. */
  getSourceFileForResolvedModule(fileName: string): SourceFile | undefined {
    const file = this.getSourceFile(fileName);
    if (file !== undefined) return file;
    const redirect = this.getParseFileRedirect(fileName);
    return redirect !== '' ? this.getSourceFile(redirect) : undefined;
  }

  /** Packages that modules resolved into, by name: whether any resolution into them was a declaration file. */
  getPackagesMap(): ReadonlyMap<string, boolean> {
    let map = this.packagesMap ?? (this.shared ? threadPackagesMaps.get(this) : undefined);
    if (map !== undefined) return map;
    map = new Map<string, boolean>();
    for (const resolutions of this.processed.resolvedModules.values()) {
      if (resolutions === undefined) continue;
      for (const resolved of resolutions.values()) {
        const name = resolved.packageId?.name ?? '';
        if (name !== '') map.set(name, map.get(name) === true || resolved.extension === '.d.ts');
      }
    }
    if (this.shared) threadPackagesMaps.set(this, map);
    else this.packagesMap = map;
    return map;
  }

  getResolvedModule(file: SourceFile, moduleName: string, mode: ModuleKind): ResolvedModule | undefined {
    return this.processed.resolvedModules.get(file.path)?.get(modeAwareKey(moduleName, mode));
  }

  /** The files each file added to the program (`ProcessedFiles.addedFiles`), as indices of `getSourceFiles`. */
  addedFiles(): readonly (readonly number[])[] {
    return this.processed.addedFiles;
  }

  /** The specifier of the implicit JSX runtime import of `file`, if any. */
  jsxRuntimeImportSpecifier(path: string): Node | undefined {
    return this.processed.jsxRuntimeImports.get(path)?.specifier;
  }

  getResolvedModuleFromModuleSpecifier(file: SourceFile, specifier: Node): ResolvedModule | undefined {
    // A source phase import loads no module declarations.
    if (specifier.parent !== undefined && isSourcePhaseImport(specifier.parent)) return undefined;
    const text = specifierText(specifier);
    return this.getResolvedModule(file, text, this.getModeForUsageLocation(file, specifier));
  }

  /** Whether emit writes outputs for `file`. */
  sourceFileMayBeEmitted(file: SourceFile, forceDtsEmit: boolean): boolean {
    const options = this.options;
    if (options.noEmitForJsFiles === true && isSourceFileJS(file)) return false;
    if (file.isDeclarationFile) return false;
    if (this.isSourceFileFromExternalLibrary(file)) return false;
    if (forceDtsEmit) return true;
    if (this.getProjectReferenceFromSource(file.path) !== undefined) return false;
    if (file.scriptKind !== ScriptKind.JSON) return true;
    if (options.outDir === undefined) return false;
    if (options.rootDir !== undefined || options.configFilePath !== undefined) {
      const commonDirectory = getNormalizedAbsolutePath(
        getCommonSourceDirectory(options, () => [], this.currentDirectory, this.useCaseSensitiveFileNames, undefined),
        this.currentDirectory,
      );
      const outputPath = getSourceFilePathInNewDirWorker(
        file.fileName,
        options.outDir,
        this.currentDirectory,
        commonDirectory,
        this.useCaseSensitiveFileNames,
      );
      if (comparePaths(file.fileName, outputPath, this.useCaseSensitiveFileNames, this.currentDirectory) === 0) {
        return false;
      }
    }
    return true;
  }

  /** The directory outputs are laid out relative to, with a trailing `/`. */
  commonSourceDirectory(): string {
    if (this.commonSourceDirectoryValue === undefined) {
      this.commonSourceDirectoryValue = getCommonSourceDirectory(
        this.options,
        () => this.emittedNonDeclarationFiles(),
        this.currentDirectory,
        this.useCaseSensitiveFileNames,
        (files, root) => this.checkSourceFilesBelongToPath(files, root),
      );
    }
    return this.commonSourceDirectoryValue;
  }

  private emittedNonDeclarationFiles(): string[] {
    const files: string[] = [];
    for (const file of this.processed.files) {
      if (this.sourceFileMayBeEmitted(file, false) && !file.isDeclarationFile) files.push(file.fileName);
    }
    return files;
  }

  private checkSourceFilesBelongToPath(files: readonly string[], root: string): void {
    for (const file of files) {
      if (containsPath(root, file, this.useCaseSensitiveFileNames, this.currentDirectory)) continue;
      const absolute = getCanonicalFileName(
        getNormalizedAbsolutePath(file, this.currentDirectory),
        this.useCaseSensitiveFileNames,
      );
      this.includeProcessor.addProcessingDiagnostic(
        ProcessingDiagnostic.explainingFileInclude(
          absolute,
          undefined,
          Diagnostics.File_0_is_not_under_rootDir_1_rootDir_is_expected_to_contain_all_source_files,
          [file, root],
        ),
      );
    }
  }

  /**
   * Computes what checking, reporting and emit would otherwise compute on first use, so that they
   * never write to the program: a program shared with other threads (parallel-check.ts) is
   * immutable. Neither adds diagnostics. File inclusion diagnostics are fixed first, as tsgo fixes
   * them on first use: computing the common source directory checks that files are under `rootDir`
   * (or the config file's directory), which reports only when options compute it while the program
   * is created (verifyCompilerOptions), not when emit or declaration diagnostics compute it later.
   */
  /**
   * Whether the program was prepared for sharing (`prepareForSharing`): its objects are immutable, so what is
   * computed on first use after that is not kept in them.
   */
  isShared(): boolean {
    return this.shared;
  }

  prepareForSharing(): void {
    // Each thread computes the symlink cache and the packages map on first use (module specifiers,
    // and the hint of a missing declaration file): checking rarely needs them.
    this.shared = true;
    this.includeProcessor.diagnostics(this);
    mark('include diagnostics');
    this.commonSourceDirectory();
    // File system and resolution lookups that checking and declaration emit add later (module
    // specifiers probe files and `package.json` scopes) go to tables of each thread.
    this.host.fs.prepareForSharing();
    this.processed.resolver.prepareForSharing();
    // So do the line starts and UTF-8 offsets of declaration files, which the parser leaves out.
    useThreadTextCaches();
  }

  isEmitBlocked(fileName: string): boolean {
    return this.emitBlockingPaths.has(this.toPath(fileName));
  }

  // ---- Diagnostics

  /** Diagnostics of reading the config file. */
  getConfigFileParsingDiagnostics(): readonly Diagnostic[] {
    return this.commandLine.configFileParsingDiagnostics();
  }

  /** Parse errors of `file`, or of every file, sorted. */
  getSyntacticDiagnostics(file?: SourceFile): Diagnostic[] {
    const result: Diagnostic[] = [];
    for (const f of file === undefined ? this.processed.files : [file]) {
      for (const diagnostic of f.diagnostics) result.push(diagnostic);
      for (const diagnostic of f.jsDiagnostics) result.push(diagnostic);
      // Unchecked JavaScript still gets option-dependent syntax errors.
      if (isSourceFileJS(f) && !isCheckJsEnabledForFile(f, this.options)) {
        for (const diagnostic of getAdditionalJSSyntacticDiagnostics(f, this.options)) result.push(diagnostic);
      }
    }
    return sortAndDeduplicateDiagnostics(result);
  }

  /** Option errors and file inclusion errors without a location in a source file. */
  getProgramDiagnostics(): Diagnostic[] {
    const result = [...this.programDiagnosticsList];
    for (const diagnostic of this.includeProcessor.diagnostics(this)) {
      if (diagnostic.file === undefined) result.push(diagnostic);
    }
    return sortAndDeduplicateDiagnostics(result);
  }

  /** File inclusion errors located in `file`, reported with its semantic diagnostics. */
  getIncludeProcessorDiagnostics(file: SourceFile): Diagnostic[] {
    const result: Diagnostic[] = [];
    for (const diagnostic of this.includeProcessor.diagnostics(this)) {
      if (diagnostic.file !== undefined && diagnostic.file.fileName === file.fileName) result.push(diagnostic);
    }
    return result.sort(compareDiagnostics);
  }

  /** Diagnostics of module and type reference resolution. */
  resolutionDiagnostics(): Diagnostic[] {
    const result: Diagnostic[] = [];
    for (const resolutions of this.processed.resolvedModules.values()) {
      if (resolutions === undefined) continue;
      for (const resolved of resolutions.values())
        for (const diagnostic of resolved.resolutionDiagnostics) result.push(diagnostic);
    }
    for (const resolutions of this.processed.typeResolutionsInFile.values()) {
      if (resolutions === undefined) continue;
      for (const resolved of resolutions.values())
        for (const diagnostic of resolved.resolutionDiagnostics) result.push(diagnostic);
    }
    return result;
  }

  /** What `--explainFiles` prints: each file and why it is in the program. */
  explainFiles(locale: Locale): string {
    let out = '';
    let explained = 0;
    const explain = (fileName: string, path: string): void => {
      out += this.displayFileName(fileName, true) + '\n';
      for (const reason of this.includeProcessor.reasonsOf(path)) {
        out += '   ' + reason.toDiagnostic(this, true).localize(locale) + '\n';
      }
      for (const diagnostic of this.includeProcessor.explainRedirectAndImpliedFormat(this, path, true)) {
        out += '   ' + diagnostic.localize(locale) + '\n';
      }
      explained++;
    };
    const redirects = [...this.processed.redirectFilesByPath.values()].sort((a, b) => a.index - b.index);
    const files = this.processed.files;
    let fileIndex = 0;
    for (const redirect of redirects) {
      while (explained < redirect.index) {
        const file = files[fileIndex++];
        explain(file.fileName, file.path);
      }
      explain(redirect.fileName, redirect.path);
    }
    while (explained < files.length + redirects.length) {
      const file = files[fileIndex++];
      explain(file.fileName, file.path);
    }
    return out;
  }

  // ---- Option checks

  private configSourceFile(): SourceFile | undefined {
    return this.commandLine.configFile?.sourceFile;
  }

  private compilerOptionsProperty(): PropertyAssignment | undefined {
    return findPropertyAssignment(getTsConfigObjectLiteral(this.configSourceFile()), 'compilerOptions');
  }

  private compilerOptionsObject(): ObjectLiteralExpression | undefined {
    const initializer = this.compilerOptionsProperty()?.initializer;
    // `as`: scriptc loses instanceof narrowing in conversions to optional types.
    return initializer instanceof ObjectLiteralExpression ? (initializer as ObjectLiteralExpression) : undefined;
  }

  private addProgramDiagnostic(diagnostic: Diagnostic): Diagnostic {
    this.programDiagnosticsList.push(diagnostic);
    return diagnostic;
  }

  /** At `key1` (or `key2`) of `object`, on the key or the value; `undefined` if neither is there. */
  private optionDiagnosticInObject(
    object: ObjectLiteralExpression | undefined,
    onKey: boolean,
    key1: string,
    key2: string,
    message: DiagnosticMessage,
    args: string[],
  ): Diagnostic | undefined {
    const property = findPropertyAssignment(object, key1, key2);
    if (property === undefined) return undefined;
    return this.addProgramDiagnostic(
      diagnosticAtNode(this.configSourceFile(), onKey ? property.name : property.initializer, message, ...args),
    );
  }

  /** At `compilerOptions` of the config, or without a location. */
  private compilerOptionsDiagnostic(message: DiagnosticMessage, args: string[]): Diagnostic {
    const property = this.compilerOptionsProperty();
    return this.addProgramDiagnostic(
      property !== undefined
        ? diagnosticAtNode(this.configSourceFile(), property.name, message, ...args)
        : createCompilerDiagnostic(message, ...args),
    );
  }

  private optionDiagnostic(
    onKey: boolean,
    option1: string,
    option2: string,
    message: DiagnosticMessage,
    args: string[],
  ): Diagnostic {
    return (
      this.optionDiagnosticInObject(this.compilerOptionsObject(), onKey, option1, option2, message, args) ??
      this.compilerOptionsDiagnostic(message, args)
    );
  }

  /** At the name of `option1` (or `option2`), with both names as the first arguments. */
  private optionNameDiagnostic(message: DiagnosticMessage, option1: string, option2: string, ...args: string[]): void {
    this.optionDiagnostic(true, option1, option2, message, [option1, option2, ...args]);
  }

  private optionValueDiagnostic(option: string, message: DiagnosticMessage, ...args: string[]): void {
    this.optionDiagnostic(false, option, '', message, args);
  }

  private removedOptionDiagnostic(name: string, value: string, useInstead: string): void {
    const diagnostic =
      value === ''
        ? this.optionDiagnostic(
            true,
            name,
            '',
            Diagnostics.Option_0_has_been_removed_Please_remove_it_from_your_configuration,
            [name],
          )
        : this.optionDiagnostic(
            false,
            name,
            '',
            Diagnostics.Option_0_1_has_been_removed_Please_remove_it_from_your_configuration,
            [name, value],
          );
    if (useInstead !== '') diagnostic.addMessageChain(createCompilerDiagnostic(Diagnostics.Use_0_instead, useInstead));
  }

  private pathsDiagnostic(onKey: boolean, key: string, message: DiagnosticMessage, args: string[]): void {
    const paths = findPropertyAssignment(this.compilerOptionsObject(), 'paths');
    const object = paths?.initializer;
    const diagnostic =
      object instanceof ObjectLiteralExpression
        ? this.optionDiagnosticInObject(object as ObjectLiteralExpression, onKey, key, '', message, args)
        : undefined;
    if (diagnostic === undefined) this.compilerOptionsDiagnostic(message, args);
  }

  private pathsValueDiagnostic(key: string, index: number, message: DiagnosticMessage, args: string[]): void {
    const paths = findPropertyAssignment(this.compilerOptionsObject(), 'paths');
    const object = paths?.initializer;
    if (object instanceof ObjectLiteralExpression) {
      const array = findPropertyAssignment(object as ObjectLiteralExpression, key)?.initializer;
      if (array instanceof ArrayLiteralExpression && array.elements.nodes.length > index) {
        this.addProgramDiagnostic(
          diagnosticAtNode(this.configSourceFile(), array.elements.nodes[index], message, ...args),
        );
        return;
      }
    }
    this.compilerOptionsDiagnostic(message, args);
  }

  private verifyCompilerOptions(): void {
    const options = this.options;
    const configFilePath = this.configSourceFile()?.fileName ?? '';

    // Removed in TypeScript 7.
    if (options.baseUrl !== undefined) {
      let useInstead = '';
      if (configFilePath !== '') {
        let relative = getRelativePathFromFile(configFilePath, options.baseUrl, this.useCaseSensitiveFileNames);
        if (!relative.startsWith('./') && !relative.startsWith('../')) relative = './' + relative;
        useInstead = '"paths": {"*": [' + JSON.stringify(combinePaths(relative, '*')) + ']}';
      }
      this.removedOptionDiagnostic('baseUrl', '', useInstead);
    }
    if (options.outFile !== undefined) this.removedOptionDiagnostic('outFile', '', '');
    if (options.target === ScriptTarget.ES5) this.removedOptionDiagnostic('target', 'ES5', '');
    if (options.module === ModuleKind.AMD) this.removedOptionDiagnostic('module', 'AMD', '');
    if (options.module === ModuleKind.System) this.removedOptionDiagnostic('module', 'System', '');
    if (options.module === ModuleKind.UMD) this.removedOptionDiagnostic('module', 'UMD', '');
    if (options.moduleResolution === ModuleResolutionKind.Classic)
      this.removedOptionDiagnostic('moduleResolution', 'Classic', '');
    if (options.alwaysStrict === false) this.removedOptionDiagnostic('alwaysStrict', 'false', '');
    if (options.esModuleInterop === false) this.removedOptionDiagnostic('esModuleInterop', 'false', '');
    if (options.allowSyntheticDefaultImports === false) {
      this.removedOptionDiagnostic('allowSyntheticDefaultImports', 'false', '');
    }
    if (options.moduleResolution === ModuleResolutionKind.Node10)
      this.removedOptionDiagnostic('moduleResolution', 'node10', '');
    if (options.downlevelIteration !== undefined) this.removedOptionDiagnostic('downlevelIteration', '', '');

    const strictNullChecks = getStrictOptionValue(options, options.strictNullChecks);
    if (options.strictPropertyInitialization === true && !strictNullChecks) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1,
        'strictPropertyInitialization',
        'strictNullChecks',
      );
    }
    if (options.exactOptionalPropertyTypes === true && !strictNullChecks) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1,
        'exactOptionalPropertyTypes',
        'strictNullChecks',
      );
    }
    if (options.isolatedDeclarations === true) {
      if (getAllowJS(options)) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_cannot_be_specified_with_option_1,
          'allowJs',
          'isolatedDeclarations',
        );
      }
      if (!getEmitDeclarations(options)) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1_or_option_2,
          'isolatedDeclarations',
          'declaration',
          'composite',
        );
      }
    }
    if (options.inlineSourceMap === true) {
      if (options.sourceMap === true) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_cannot_be_specified_with_option_1,
          'sourceMap',
          'inlineSourceMap',
        );
      }
      if (options.mapRoot !== undefined) {
        this.optionNameDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, 'mapRoot', 'inlineSourceMap');
      }
    }
    if (options.composite === true) {
      if (options.declaration === false) {
        this.optionNameDiagnostic(Diagnostics.Composite_projects_may_not_disable_declaration_emit, 'declaration', '');
      }
      if (options.incremental === false) {
        this.optionNameDiagnostic(
          Diagnostics.Composite_projects_may_not_disable_incremental_compilation,
          'declaration',
          '',
        );
      }
    }
    if (options.tsBuildInfoFile === undefined && options.incremental === true && options.configFilePath === undefined) {
      this.compilerOptionsDiagnostic(
        Diagnostics.Option_incremental_is_only_valid_with_a_known_configuration_file_like_tsconfig_json_or_when_tsBuildInfoFile_is_explicitly_provided,
        [],
      );
    }

    this.verifyProjectReferences();

    if (options.composite === true) {
      const rootPaths = new Set<string>();
      for (const fileName of this.commandLine.fileNames) rootPaths.add(this.toPath(fileName));
      for (const file of this.processed.files) {
        if (this.sourceFileMayBeEmitted(file, false) && !rootPaths.has(file.path)) {
          this.includeProcessor.addProcessingDiagnostic(
            ProcessingDiagnostic.explainingFileInclude(
              file.path,
              undefined,
              Diagnostics.File_0_is_not_listed_within_the_file_list_of_project_1_Projects_must_list_all_files_or_use_an_include_pattern,
              [file.fileName, configFilePath],
            ),
          );
        }
      }
    }

    if (options.paths !== undefined) {
      for (const [key, value] of options.paths) {
        if (!hasZeroOrOneAsterisk(key)) {
          this.pathsDiagnostic(true, key, Diagnostics.Pattern_0_can_have_at_most_one_Asterisk_character, [key]);
        }
        if (value === undefined) {
          this.pathsDiagnostic(false, key, Diagnostics.Substitutions_for_pattern_0_should_be_an_array, [key]);
        } else if (value.length === 0) {
          this.pathsDiagnostic(false, key, Diagnostics.Substitutions_for_pattern_0_shouldn_t_be_an_empty_array, [key]);
        }
        if (value === undefined) continue;
        for (let i = 0; i < value.length; i++) {
          const substitution = value[i];
          if (!hasZeroOrOneAsterisk(substitution)) {
            this.pathsValueDiagnostic(
              key,
              i,
              Diagnostics.Substitution_0_in_pattern_1_can_have_at_most_one_Asterisk_character,
              [substitution, key],
            );
          }
          if (!pathIsRelative(substitution) && !pathIsAbsolute(substitution)) {
            this.pathsValueDiagnostic(
              key,
              i,
              Diagnostics.Non_relative_paths_are_not_allowed_Did_you_forget_a_leading_Slash,
              [],
            );
          } else if (isNetworkPathValue(substitution, options.pathsBasePath ?? this.currentDirectory)) {
            this.pathsValueDiagnostic(key, i, Diagnostics.Network_path_0_is_not_supported, [substitution]);
          }
        }
      }
    }

    if (options.sourceMap !== true && options.inlineSourceMap !== true) {
      if (options.inlineSources === true) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_can_only_be_used_when_either_option_inlineSourceMap_or_option_sourceMap_is_provided,
          'inlineSources',
          '',
        );
      }
      if (options.sourceRoot !== undefined) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_can_only_be_used_when_either_option_inlineSourceMap_or_option_sourceMap_is_provided,
          'sourceRoot',
          '',
        );
      }
    }
    if (options.mapRoot !== undefined && !(options.sourceMap === true || options.declarationMap === true)) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1_or_option_2,
        'mapRoot',
        'sourceMap',
        'declarationMap',
      );
    }
    if (options.declarationDir !== undefined && !getEmitDeclarations(options)) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1_or_option_2,
        'declarationDir',
        'declaration',
        'composite',
      );
    }
    if (options.declarationMap === true && !getEmitDeclarations(options)) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1_or_option_2,
        'declarationMap',
        'declaration',
        'composite',
      );
    }
    if (options.lib !== undefined && options.noLib === true) {
      this.optionNameDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, 'lib', 'noLib');
    }
    if (
      (options.isolatedModules === true || options.verbatimModuleSyntax === true) &&
      options.preserveConstEnums === false
    ) {
      this.optionNameDiagnostic(
        Diagnostics.Option_preserveConstEnums_cannot_be_disabled_when_0_is_enabled,
        options.verbatimModuleSyntax === true ? 'verbatimModuleSyntax' : 'isolatedModules',
        'preserveConstEnums',
      );
    }

    if (
      options.outDir !== undefined ||
      options.rootDir !== undefined ||
      options.sourceRoot !== undefined ||
      options.mapRoot !== undefined ||
      (getEmitDeclarations(options) && options.declarationDir !== undefined)
    ) {
      const directory = this.commonSourceDirectory();
      if (options.outDir !== undefined && directory === '') {
        let rooted = false;
        for (const file of this.processed.files) if (getRootLength(file.fileName) > 1) rooted = true;
        if (rooted)
          this.optionNameDiagnostic(
            Diagnostics.Cannot_find_the_common_subdirectory_path_for_the_input_files,
            'outDir',
            '',
          );
      }
    }

    if (
      options.noEmit !== true &&
      options.composite !== true &&
      options.rootDir === undefined &&
      options.configFilePath !== undefined &&
      (options.outDir !== undefined ||
        (getEmitDeclarations(options) && options.declarationDir !== undefined) ||
        options.outFile !== undefined)
    ) {
      // The rootDir default changed in TypeScript 6; report layouts that would change.
      const directory = this.commonSourceDirectory();
      const emittedFiles: string[] = [];
      for (const file of this.processed.files) {
        if (!file.isDeclarationFile && this.sourceFileMayBeEmitted(file, false)) emittedFiles.push(file.fileName);
      }
      const computed = getComputedCommonSourceDirectory(
        emittedFiles,
        this.currentDirectory,
        this.useCaseSensitiveFileNames,
      );
      if (
        computed !== '' &&
        getCanonicalFileName(directory, this.useCaseSensitiveFileNames) !==
          getCanonicalFileName(computed, this.useCaseSensitiveFileNames)
      ) {
        const option1 =
          options.outFile !== undefined ? 'outFile' : options.outDir !== undefined ? 'outDir' : 'declarationDir';
        const option2 = options.outFile === undefined && options.outDir !== undefined ? 'declarationDir' : '';
        const diagnostic = this.optionDiagnostic(
          true,
          option1,
          option2,
          Diagnostics.The_common_source_directory_of_0_is_1_The_rootDir_setting_must_be_explicitly_set_to_this_or_another_path_to_adjust_your_output_s_file_layout,
          [
            getBaseFileName(options.configFilePath),
            getRelativePathFromFile(options.configFilePath, computed, this.useCaseSensitiveFileNames),
          ],
        );
        diagnostic.addMessageChain(
          createCompilerDiagnostic(Diagnostics.Visit_https_Colon_Slash_Slashaka_ms_Slashts6_for_migration_information),
        );
      }
    }

    if (options.checkJs === true && !getAllowJS(options)) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1,
        'checkJs',
        'allowJs',
      );
    }
    if (options.emitDeclarationOnly === true && !getEmitDeclarations(options)) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1_or_option_2,
        'emitDeclarationOnly',
        'declaration',
        'composite',
      );
    }
    if (options.emitDecoratorMetadata === true && options.experimentalDecorators !== true) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1,
        'emitDecoratorMetadata',
        'experimentalDecorators',
      );
    }

    const jsx = options.jsx;
    const automaticJsx = jsx === JsxEmit.ReactJSX || jsx === JsxEmit.ReactJSXDev;
    if (options.jsxFactory !== undefined) {
      if (options.reactNamespace !== undefined) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_cannot_be_specified_with_option_1,
          'reactNamespace',
          'jsxFactory',
        );
      }
      if (automaticJsx && jsx !== undefined) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_cannot_be_specified_when_option_jsx_is_1,
          'jsxFactory',
          jsxEmitName(jsx),
        );
      }
      if (parseIsolatedEntityName(options.jsxFactory) === undefined) {
        this.optionValueDiagnostic(
          'jsxFactory',
          Diagnostics.Invalid_value_for_jsxFactory_0_is_not_a_valid_identifier_or_qualified_name,
          options.jsxFactory,
        );
      }
    } else if (
      options.reactNamespace !== undefined &&
      !isIdentifierText(options.reactNamespace, LanguageVariant.Standard)
    ) {
      this.optionValueDiagnostic(
        'reactNamespace',
        Diagnostics.Invalid_value_for_reactNamespace_0_is_not_a_valid_identifier,
        options.reactNamespace,
      );
    }
    if (options.jsxFragmentFactory !== undefined) {
      if (options.jsxFactory === undefined) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1,
          'jsxFragmentFactory',
          'jsxFactory',
        );
      }
      if (automaticJsx && jsx !== undefined) {
        this.optionNameDiagnostic(
          Diagnostics.Option_0_cannot_be_specified_when_option_jsx_is_1,
          'jsxFragmentFactory',
          jsxEmitName(jsx),
        );
      }
      if (parseIsolatedEntityName(options.jsxFragmentFactory) === undefined) {
        this.optionValueDiagnostic(
          'jsxFragmentFactory',
          Diagnostics.Invalid_value_for_jsxFragmentFactory_0_is_not_a_valid_identifier_or_qualified_name,
          options.jsxFragmentFactory,
        );
      }
    }
    if (options.reactNamespace !== undefined && automaticJsx && jsx !== undefined) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_when_option_jsx_is_1,
        'reactNamespace',
        jsxEmitName(jsx),
      );
    }
    if (options.jsxImportSource !== undefined && jsx === JsxEmit.React) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_cannot_be_specified_when_option_jsx_is_1,
        'jsxImportSource',
        jsxEmitName(jsx),
      );
    }

    const moduleKind = getEmitModuleKind(options);
    if (
      options.allowImportingTsExtensions === true &&
      !(
        options.noEmit === true ||
        options.emitDeclarationOnly === true ||
        options.rewriteRelativeImportExtensions === true
      )
    ) {
      this.optionValueDiagnostic(
        'allowImportingTsExtensions',
        Diagnostics.Option_allowImportingTsExtensions_can_only_be_used_when_one_of_noEmit_emitDeclarationOnly_or_rewriteRelativeImportExtensions_is_set,
      );
    }
    const moduleResolution = getModuleResolutionKind(options);
    const supportsExportsAndImports =
      (moduleResolution >= ModuleResolutionKind.Node16 && moduleResolution <= ModuleResolutionKind.NodeNext) ||
      moduleResolution === ModuleResolutionKind.Bundler;
    if (options.resolvePackageJsonExports === true && !supportsExportsAndImports) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_can_only_be_used_when_moduleResolution_is_set_to_node16_nodenext_or_bundler,
        'resolvePackageJsonExports',
        '',
      );
    }
    if (options.resolvePackageJsonImports === true && !supportsExportsAndImports) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_can_only_be_used_when_moduleResolution_is_set_to_node16_nodenext_or_bundler,
        'resolvePackageJsonImports',
        '',
      );
    }
    if (options.customConditions !== undefined && !supportsExportsAndImports) {
      this.optionNameDiagnostic(
        Diagnostics.Option_0_can_only_be_used_when_moduleResolution_is_set_to_node16_nodenext_or_bundler,
        'customConditions',
        '',
      );
    }
    const isNonNodeESM = moduleKind >= ModuleKind.ES2015 && moduleKind <= ModuleKind.ESNext;
    if (
      moduleResolution === ModuleResolutionKind.Bundler &&
      !isNonNodeESM &&
      moduleKind !== ModuleKind.Preserve &&
      moduleKind !== ModuleKind.CommonJS
    ) {
      this.optionValueDiagnostic(
        'moduleResolution',
        Diagnostics.Option_0_can_only_be_used_when_module_is_set_to_preserve_commonjs_or_es2015_or_later,
        'bundler',
      );
    }
    const isNodeModule = ModuleKind.Node16 <= moduleKind && moduleKind <= ModuleKind.NodeNext;
    const isNodeResolution =
      ModuleResolutionKind.Node16 <= moduleResolution && moduleResolution <= ModuleResolutionKind.NodeNext;
    if (isNodeModule && !isNodeResolution) {
      const resolutionName = moduleKind === ModuleKind.NodeNext ? 'NodeNext' : 'Node16';
      this.optionValueDiagnostic(
        'moduleResolution',
        Diagnostics.Option_moduleResolution_must_be_set_to_0_or_left_unspecified_when_option_module_is_set_to_1,
        resolutionName,
        moduleKindName(moduleKind),
      );
    } else if (isNodeResolution && !isNodeModule) {
      const name = moduleResolutionKindName(moduleResolution);
      this.optionValueDiagnostic(
        'module',
        Diagnostics.Option_module_must_be_set_to_0_when_option_moduleResolution_is_set_to_1,
        name,
        name,
      );
    }

    // Outputs must be unique and must not overwrite inputs.
    if (options.noEmit !== true && options.suppressOutputPathCheck !== true) {
      const seen = new Set<string>();
      for (const file of this.processed.files) {
        if (!this.sourceFileMayBeEmitted(file, false)) continue;
        const paths = getOutputPathsFor(file.fileName, file.scriptKind === ScriptKind.JSON, options, this, false);
        this.verifyEmitFilePath(paths.jsFilePath, seen, configFilePath);
        this.verifyEmitFilePath(paths.sourceMapFilePath, seen, configFilePath);
        this.verifyEmitFilePath(paths.declarationFilePath, seen, configFilePath);
        this.verifyEmitFilePath(paths.declarationMapPath, seen, configFilePath);
      }
      this.verifyEmitFilePath(this.commandLine.buildInfoFileName(), seen, configFilePath);
    }
  }

  private verifyEmitFilePath(fileName: string, seen: Set<string>, configFilePath: string): void {
    if (fileName === '') return;
    const path = this.toPath(fileName);
    if (this.processed.filesByPath.has(path)) {
      const diagnostic = createCompilerDiagnostic(
        Diagnostics.Cannot_write_file_0_because_it_would_overwrite_input_file,
        fileName,
      );
      if (configFilePath === '') {
        diagnostic.addMessageChain(
          createCompilerDiagnostic(
            Diagnostics.Adding_a_tsconfig_json_file_will_help_organize_projects_that_contain_both_TypeScript_and_JavaScript_files_Learn_more_at_https_Colon_Slash_Slashaka_ms_Slashtsconfig,
          ),
        );
      }
      this.blockEmittingOfFile(fileName, diagnostic);
    }
    const key = this.useCaseSensitiveFileNames ? path : toFileNameLowerCase(path);
    if (seen.has(key)) {
      this.blockEmittingOfFile(
        fileName,
        createCompilerDiagnostic(
          Diagnostics.Cannot_write_file_0_because_it_would_be_overwritten_by_multiple_input_files,
          fileName,
        ),
      );
    } else {
      seen.add(key);
    }
  }

  private blockEmittingOfFile(fileName: string, diagnostic: Diagnostic): void {
    this.emitBlockingPaths.add(this.toPath(fileName));
    this.programDiagnosticsList.push(diagnostic);
  }

  private verifyProjectReferences(): void {
    const buildInfoFileName = this.options.suppressOutputPathCheck !== true ? this.commandLine.buildInfoFileName() : '';
    const configFile = this.commandLine.configFile;
    if (configFile === undefined) return;
    const mapper = this.processed.projectReferenceMapper;
    const seen = new Set<string>([configFile.sourceFile.path]);
    const visit = (references: readonly string[], parent: ParsedCommandLine | undefined): void => {
      for (let index = 0; index < references.length; index++) {
        const path = references[index];
        if (seen.has(path)) continue;
        seen.add(path);
        const config = mapper.configToProjectReference.get(path);
        if (parent !== undefined) this.verifyProjectReference(config, parent, index, buildInfoFileName);
        visit(mapper.referencesInConfigFile.get(path) ?? [], config);
      }
    };
    visit(mapper.referencesInConfigFile.get(configFile.sourceFile.path) ?? [], this.commandLine);
  }

  private verifyProjectReference(
    config: ParsedCommandLine | undefined,
    parent: ParsedCommandLine,
    index: number,
    buildInfoFileName: string,
  ): void {
    const reference = parent.projectReferences[index];
    if (config === undefined) {
      this.referenceDiagnostic(parent, index, Diagnostics.File_0_not_found, [reference.path]);
      return;
    }
    const options = config.options;
    if ((options.composite !== true || options.noEmit === true) && parent.fileNames.length > 0) {
      if (options.composite !== true) {
        this.referenceDiagnostic(
          parent,
          index,
          Diagnostics.Referenced_project_0_must_have_setting_composite_Colon_true,
          [reference.path],
        );
      }
      if (options.noEmit === true) {
        this.referenceDiagnostic(parent, index, Diagnostics.Referenced_project_0_may_not_disable_emit, [
          reference.path,
        ]);
      }
    }
    if (buildInfoFileName !== '' && buildInfoFileName === config.buildInfoFileName()) {
      this.referenceDiagnostic(
        parent,
        index,
        Diagnostics.Cannot_write_file_0_because_it_will_overwrite_tsbuildinfo_file_generated_by_referenced_project_1,
        [buildInfoFileName, reference.path],
      );
      this.emitBlockingPaths.add(this.toPath(buildInfoFileName));
    }
  }

  /** At the reference's entry of `references` in the parent config. */
  private referenceDiagnostic(
    parent: ParsedCommandLine,
    index: number,
    message: DiagnosticMessage,
    args: string[],
  ): void {
    const file = parent.configFile?.sourceFile;
    const references = findPropertyAssignment(getTsConfigObjectLiteral(file), 'references')?.initializer;
    if (references instanceof ArrayLiteralExpression && references.elements.nodes.length > index) {
      this.programDiagnosticsList.push(diagnosticAtNode(file, references.elements.nodes[index], message, ...args));
    } else {
      this.programDiagnosticsList.push(createCompilerDiagnostic(message, ...args));
    }
  }
}

function hasZeroOrOneAsterisk(text: string): boolean {
  const first = text.indexOf('*');
  return first === -1 || text.indexOf('*', first + 1) === -1;
}

function specifierText(node: Node): string {
  if (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return getText(node);
  }
  throw new Error('module specifier must be a string literal');
}

/** Parameter decorators in JavaScript without `experimentalDecorators`, which the checker would report. */
function getAdditionalJSSyntacticDiagnostics(file: SourceFile, options: CompilerOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // Decorators need an `@`.
  if (options.experimentalDecorators === true || !file.text.includes('@')) return diagnostics;
  // Walked with a stack: expression trees can be too deep to recurse.
  const pending = new NodeCollector();
  file.forEachChild(pending);
  for (let node = pending.nodes.pop(); node !== undefined; node = pending.nodes.pop()) {
    if (node instanceof ParameterDeclaration && node.modifiers !== undefined) {
      for (const modifier of node.modifiers.nodes) {
        if (!(modifier instanceof Decorator)) continue;
        diagnostics.push(
          new Diagnostic(file.diagnosticFile(), modifier.pos, modifier.end, Diagnostics.Decorators_are_not_valid_here),
        );
        break;
      }
    }
    node.forEachChild(pending);
  }
  return diagnostics;
}

/** Collects the children it visits. */
class NodeCollector extends NodeVisitor {
  readonly nodes: Node[] = [];

  visitNode(node: Node): boolean {
    this.nodes.push(node);
    return false;
  }
}

/** Sorts diagnostics and merges duplicates, combining their related information. */
export function sortAndDeduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const sorted = sortDiagnostics(diagnostics);
  if (sorted.length < 2) return sorted;
  const result: Diagnostic[] = [];
  let i = 0;
  while (i < sorted.length) {
    let diagnostic = sorted[i];
    let n = 1;
    while (i + n < sorted.length && equalDiagnosticsNoRelatedInfo(diagnostic, sorted[i + n]!)) n++;
    if (n > 1) {
      const related: Diagnostic[] = [];
      for (let k = 0; k < n; k++) for (const info of sorted[i + k].relatedInformation) related.push(info);
      if (related.length > 0) {
        related.sort(compareDiagnostics);
        const compacted: Diagnostic[] = [];
        for (const info of related) {
          if (compacted.length === 0 || !equalDiagnostics(compacted[compacted.length - 1]!, info)) compacted.push(info);
        }
        diagnostic = diagnostic.clone();
        diagnostic.relatedInformation = compacted;
      }
    }
    result.push(diagnostic);
    i += n;
  }
  return result;
}
