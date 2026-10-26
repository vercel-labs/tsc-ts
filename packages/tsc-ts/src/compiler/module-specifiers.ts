// Module specifier generation: the specifier a file uses to import another, as written by
// declaration emit, `import("…")` types in diagnostics and the language service. Prefers a
// package name reachable through `node_modules` (following symlinks the program saw), then
// `paths` and `package.json` `imports`, then a relative path, with the ending the resolution
// mode and the importing file's other imports call for.
import { type Node, type SourceFile, getText } from './ast.js';
import { type ResolvedModule, getConditions, getPackageNameFromTypesPackageName } from './module-resolution-types.js';
import { matchPatternOrExact, parsePatterns } from './module-resolution.js';
import {
  type CompilerOptions,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  getAllowImportingTsExtensions,
  getModuleResolutionKind,
  getResolvePackageJsonExports,
  getResolvePackageJsonImports,
} from './options.js';
import { type OutputPathsHost, getOutputDeclarationFileNameWorker, getOutputJSFileNameWorker } from './output-paths.js';
import { type JsonValue, JsonObjectKind, type PackageJsonInfo, isApplicableVersionedTypesKey } from './package-json.js';
import {
  changeExtension,
  combinePaths,
  comparePaths,
  containsPath,
  ensureTrailingDirectorySeparator,
  fileExtensionIsOneOf,
  getBaseFileName,
  getCanonicalFileName,
  getDeclarationFileExtension,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getPathComponentsRelativeTo,
  getPathFromPathComponents,
  getRelativePathFromDirectory,
  hasImplementationTSFileExtension,
  hasJSFileExtension,
  hasTSFileExtension,
  isDeclarationFileName,
  isExternalModuleNameRelative,
  isRootedDiskPath,
  normalizePath,
  pathIsAbsolute,
  pathIsRelative,
  removeExtension,
  removeFileExtension,
  removeTrailingDirectorySeparator,
  resolvePath,
  toPath,
  tryGetExtensionFromPath,
} from './path.js';
import { type KnownSymlinks, containsIgnoredPath } from './symlinks.js';

export const enum ModuleSpecifierEnding {
  Minimal,
  Index,
  JsExtension,
  TsExtension,
}

const enum RelativePreference {
  Relative,
  NonRelative,
  Shortest,
  ExternalNonRelative,
}

const enum MatchingMode {
  Exact,
  Directory,
  Pattern,
}

/** `importModuleSpecifierPreference`: `''`, `shortest`, `project-relative`, `relative` or `non-relative`. */
export type ImportModuleSpecifierPreference = string;
/** `importModuleSpecifierEnding`: `''`, `auto`, `minimal`, `index` or `js`. */
export type ImportModuleSpecifierEndingPreference = string;

export class ModuleSpecifierPreferences {
  constructor(
    readonly importModuleSpecifierPreference: ImportModuleSpecifierPreference,
    readonly importModuleSpecifierEnding: ImportModuleSpecifierEndingPreference,
  ) {}
}

/** What specifier generation needs from a program. */
export abstract class ModuleSpecifierHost {
  abstract getCurrentDirectory(): string;
  abstract useCaseSensitiveFileNames(): boolean;
  abstract getSymlinkCache(): KnownSymlinks | undefined;
  /** The global typings cache of automatic type acquisition, or `''`. */
  abstract getGlobalTypingsCacheLocation(): string;
  /** The declaration output of a referenced project's source file, or `''`. */
  abstract getProjectReferenceOutputDts(path: string): string;
  /** Files of the same package version that resolve to `path` instead of being loaded. */
  abstract getRedirectTargets(path: string): readonly string[];
  /** The source a referenced project's declaration output was loaded for, else the file's name. */
  abstract getSourceOfProjectReferenceIfOutputIncluded(file: SourceFile): string;
  abstract fileExists(path: string): boolean;
  /** The directory of the nearest `package.json` at or above `directory`, or `''`. */
  abstract getNearestAncestorDirectoryWithPackageJson(directory: string): string;
  /** The `package.json` at `packageJsonPath`, if it exists and is a package scope. */
  abstract getPackageJsonInfo(packageJsonPath: string): PackageJsonInfo | undefined;
  abstract getDefaultResolutionModeForFile(file: SourceFile): ModuleKind;
  abstract getResolvedModuleFromModuleSpecifier(file: SourceFile, specifier: Node): ResolvedModule | undefined;
  abstract getModeForUsageLocation(file: SourceFile, specifier: Node): ModuleKind;
  /** For output paths of `package.json` `imports` targets. */
  abstract getOutputPathsHost(): OutputPathsHost;
}

/** A path a module can be imported through. */
class ModulePath {
  constructor(
    readonly fileName: string,
    readonly isInNodeModules: boolean,
    /** A referenced project's declaration output standing for the imported source. */
    readonly isRedirect: boolean,
  ) {}
}

class ImporterInfo {
  readonly sourceDirectory: string;

  constructor(
    readonly importingSourceFileName: string,
    readonly useCaseSensitiveFileNames: boolean,
  ) {
    this.sourceDirectory = getDirectoryPath(importingSourceFileName);
  }
}

/** Preferences resolved for one importing file. */
class ResolvedPreferences {
  constructor(
    readonly relativePreference: RelativePreference,
    private readonly preferences: ModuleSpecifierPreferences,
    private readonly host: ModuleSpecifierHost,
    private readonly options: CompilerOptions,
    private readonly importingFile: SourceFile,
    private readonly oldImportSpecifier: string,
  ) {}

  allowedEndings(syntaxImpliedNodeFormat: ModuleKind): ModuleSpecifierEnding[] {
    return getAllowedEndingsInPreferredOrder(
      this.preferences,
      this.host,
      this.options,
      this.importingFile,
      this.oldImportSpecifier,
      syntaxImpliedNodeFormat,
    );
  }
}

//// Entry points

/**
 * Specifiers `importingFile` can import `moduleFileName` with, best first, as tsgo's
 * `GetModuleSpecifiersForFileWithInfo`. `overrideImportMode` is `None` for the file's own mode.
 */
export function getModuleSpecifiersForFile(
  importingFile: SourceFile,
  moduleFileName: string,
  options: CompilerOptions,
  host: ModuleSpecifierHost,
  preferences: ModuleSpecifierPreferences,
  overrideImportMode: ModuleKind,
  forAutoImports: boolean,
): string[] {
  const modulePaths = getAllModulePaths(
    new ImporterInfo(host.getSourceOfProjectReferenceIfOutputIncluded(importingFile), host.useCaseSensitiveFileNames()),
    moduleFileName,
    host,
  );
  return computeModuleSpecifiers(
    modulePaths,
    options,
    importingFile,
    host,
    preferences,
    overrideImportMode,
    forAutoImports,
  );
}

/** Number of `/` in a specifier, ignoring a leading `./`. */
export function countPathComponents(path: string): number {
  let count = 0;
  for (let i = path.startsWith('./') ? 2 : 0; i < path.length; i++) if (path.charCodeAt(i) === 0x2f) count++;
  return count;
}

//// Module paths

function containsNodeModules(path: string): boolean {
  return path.includes('/node_modules/');
}

/** Every path the imported file can be reached by, closest to the importing file first. */
function getAllModulePaths(info: ImporterInfo, importedFileName: string, host: ModuleSpecifierHost): ModulePath[] {
  const remaining = new Map<string, ModulePath>();
  for (const p of getEachFileNameOfModule(info.importingSourceFileName, importedFileName, host, true))
    remaining.set(p.fileName, p);
  const caseSensitive = info.useCaseSensitiveFileNames;
  const compare = (a: ModulePath, b: ModulePath): number => comparePathsByRedirect(a, b, caseSensitive);
  const sorted: ModulePath[] = [];
  for (let directory = info.sourceDirectory; remaining.size !== 0;) {
    const directoryStart = ensureTrailingDirectorySeparator(directory);
    const inDirectory: ModulePath[] = [];
    for (const [fileName, p] of remaining) {
      if (fileName.startsWith(directoryStart)) {
        inDirectory.push(p);
        remaining.delete(fileName);
      }
    }
    if (inDirectory.length > 0) {
      inDirectory.sort(compare);
      for (const p of inDirectory) sorted.push(p);
    }
    const parent = getDirectoryPath(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (remaining.size > 0) {
    const rest = [...remaining.values()];
    rest.sort(compare);
    for (const p of rest) sorted.push(p);
  }
  return sorted;
}

function comparePathsByRedirect(a: ModulePath, b: ModulePath, useCaseSensitiveFileNames: boolean): number {
  // Redirects first.
  if (a.isRedirect !== b.isRedirect) return a.isRedirect ? -1 : 1;
  const separators = countSlashes(a.fileName) - countSlashes(b.fileName);
  if (separators !== 0) return separators < 0 ? -1 : 1;
  return comparePaths(a.fileName, b.fileName, useCaseSensitiveFileNames);
}

function countSlashes(path: string): number {
  let count = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 0x2f) count++;
  return count;
}

/** The imported file's paths: its real path, redirects and paths through known symlinks. */
function getEachFileNameOfModule(
  importingFileName: string,
  importedFileName: string,
  host: ModuleSpecifierHost,
  preferSymlinks: boolean,
): ModulePath[] {
  const cwd = host.getCurrentDirectory();
  const caseSensitive = host.useCaseSensitiveFileNames();
  const importedPath = toPath(importedFileName, cwd, caseSensitive);
  const referenceRedirect = host.getProjectReferenceOutputDts(importedPath);
  const targets: string[] = [];
  if (referenceRedirect !== '') targets.push(getNormalizedAbsolutePath(referenceRedirect, cwd));
  targets.push(getNormalizedAbsolutePath(importedFileName, cwd));
  for (const redirect of host.getRedirectTargets(importedPath)) targets.push(getNormalizedAbsolutePath(redirect, cwd));
  let shouldFilterIgnoredPaths = false;
  for (const target of targets) if (!containsIgnoredPath(target)) shouldFilterIgnoredPaths = true;

  const results: ModulePath[] = [];
  const addTargets = (): void => {
    for (const p of targets)
      if (!(shouldFilterIgnoredPaths && containsIgnoredPath(p)))
        results.push(new ModulePath(p, containsNodeModules(p), referenceRedirect === p));
  };
  if (!preferSymlinks) addTargets();

  const symlinks = host.getSymlinkCache();
  if (symlinks !== undefined) {
    const globalCache = host.getGlobalTypingsCacheLocation();
    for (let directory = getDirectoryPath(getNormalizedAbsolutePath(importedFileName, cwd)); ;) {
      const symlinkSet = symlinks.getSymlinksOfDirectory(
        ensureTrailingDirectorySeparator(toPath(directory, cwd, caseSensitive)),
      );
      if (symlinkSet !== undefined) {
        // A package never imports itself through its own symlink; neither do ancestors.
        if (startsWithDirectory(importingFileName, directory, caseSensitive)) break;
        for (const target of targets) {
          if (!startsWithDirectory(target, directory, caseSensitive)) continue;
          const relative = getRelativePathFromDirectory(directory, target, caseSensitive, cwd);
          for (const symlinkDirectory of symlinkSet) {
            const option = resolvePath(symlinkDirectory, relative);
            results.push(new ModulePath(option, containsNodeModules(option), target === referenceRedirect));
            // A path through a symlink rules out ignored real paths.
            shouldFilterIgnoredPaths = true;
          }
        }
      }
      if (directory === globalCache) break;
      const parent = getDirectoryPath(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  if (preferSymlinks) addTargets();
  return results;
}

function startsWithDirectory(fileName: string, directoryName: string, useCaseSensitiveFileNames: boolean): boolean {
  if (directoryName === '') return false;
  const file = getCanonicalFileName(fileName, useCaseSensitiveFileNames);
  let directory = getCanonicalFileName(directoryName, useCaseSensitiveFileNames);
  if (directory.endsWith('/') || directory.endsWith('\\')) directory = directory.slice(0, directory.length - 1);
  return file.startsWith(directory + '/') || file.startsWith(directory + '\\');
}

//// Choosing specifiers

function computeModuleSpecifiers(
  modulePaths: readonly ModulePath[],
  options: CompilerOptions,
  importingFile: SourceFile,
  host: ModuleSpecifierHost,
  userPreferences: ModuleSpecifierPreferences,
  overrideImportMode: ModuleKind,
  forAutoImport: boolean,
): string[] {
  const info = new ImporterInfo(importingFile.fileName, host.useCaseSensitiveFileNames());
  const preferences = resolvePreferences(userPreferences, host, options, importingFile, '');
  const cwd = host.getCurrentDirectory();
  const targetMode =
    overrideImportMode !== ModuleKind.None ? overrideImportMode : host.getDefaultResolutionModeForFile(importingFile);

  // An existing import of the module wins.
  for (const modulePath of modulePaths) {
    const targetPath = toPath(modulePath.fileName, cwd, info.useCaseSensitiveFileNames);
    let existingImport: Node | undefined;
    for (const specifier of importingFile.imports) {
      const resolved = host.getResolvedModuleFromModuleSpecifier(importingFile, specifier);
      if (
        resolved !== undefined &&
        resolved.resolvedFileName !== '' &&
        toPath(resolved.resolvedFileName, cwd, info.useCaseSensitiveFileNames) === targetPath
      ) {
        existingImport = specifier;
        break;
      }
    }
    if (existingImport === undefined) continue;
    const text = getText(existingImport);
    if (preferences.relativePreference === RelativePreference.NonRelative && pathIsRelative(text)) continue;
    const existingMode = host.getModeForUsageLocation(importingFile, existingImport);
    // An import resolved in another mode may not resolve the same way.
    if (existingMode !== targetMode && existingMode !== ModuleKind.None && targetMode !== ModuleKind.None) continue;
    return [text];
  }

  let importedFileIsInNodeModules = false;
  for (const p of modulePaths) if (p.isInNodeModules) importedFileIsInNodeModules = true;

  // Priority: package names through `node_modules` (a bare package name first), then `paths`,
  // then deeper `node_modules` paths, then relative paths.
  const pathsSpecifiers: string[] = [];
  const redirectPathsSpecifiers: string[] = [];
  const nodeModulesSpecifiers: string[] = [];
  const relativeSpecifiers: string[] = [];
  for (const modulePath of modulePaths) {
    const specifier = modulePath.isInNodeModules
      ? tryGetModuleNameAsNodeModule(
          modulePath,
          info,
          importingFile,
          host,
          options,
          userPreferences,
          false,
          overrideImportMode,
        )
      : '';
    if (specifier !== '') {
      nodeModulesSpecifiers.push(specifier);
      // A specifier for a redirect is a bare package name; nothing beats it.
      if (modulePath.isRedirect) return nodeModulesSpecifiers;
    }
    const local = getLocalModuleSpecifier(
      modulePath.fileName,
      info,
      options,
      host,
      targetMode,
      preferences,
      modulePath.isRedirect || specifier !== '',
    );
    if (local === '') continue;
    if (modulePath.isRedirect) {
      redirectPathsSpecifiers.push(local);
    } else if (pathIsBareSpecifier(local)) {
      // A bare specifier through `node_modules` likely comes from a misused `baseUrl`; it would be
      // reported as not portable, so it isn't preferred.
      if (containsNodeModules(local)) relativeSpecifiers.push(local);
      else pathsSpecifiers.push(local);
    } else if (forAutoImport || !importedFileIsInNodeModules || modulePath.isInNodeModules) {
      // When only some paths go through `node_modules`, a relative path that doesn't is probably
      // the real path of a symlinked monorepo package, which isn't portable; the relative path
      // through `node_modules` is used so declaration emit reports it.
      relativeSpecifiers.push(local);
    }
  }
  if (pathsSpecifiers.length > 0) return pathsSpecifiers;
  if (redirectPathsSpecifiers.length > 0) return redirectPathsSpecifiers;
  if (nodeModulesSpecifiers.length > 0) return nodeModulesSpecifiers;
  return relativeSpecifiers;
}

/** A specifier through `paths`, `package.json` `imports`, `rootDirs` or a relative path. */
function getLocalModuleSpecifier(
  moduleFileName: string,
  info: ImporterInfo,
  options: CompilerOptions,
  host: ModuleSpecifierHost,
  importMode: ModuleKind,
  preferences: ResolvedPreferences,
  pathsOnly: boolean,
): string {
  const paths = options.paths;
  const rootDirs = options.rootDirs;
  if (pathsOnly && paths === undefined) return '';
  const cwd = host.getCurrentDirectory();
  const caseSensitive = host.useCaseSensitiveFileNames();
  const sourceDirectory = info.sourceDirectory;
  const allowedEndings = preferences.allowedEndings(importMode);
  let relativePath =
    rootDirs !== undefined && rootDirs.length > 0
      ? tryGetModuleNameFromRootDirs(rootDirs, moduleFileName, sourceDirectory, allowedEndings, options, host)
      : '';
  if (relativePath === '')
    relativePath = processEnding(
      ensurePathIsNonModuleName(getRelativePathFromDirectory(sourceDirectory, moduleFileName, caseSensitive, cwd)),
      allowedEndings,
      options,
      host,
    );
  if (
    (paths === undefined && !getResolvePackageJsonImports(options)) ||
    preferences.relativePreference === RelativePreference.Relative
  )
    return pathsOnly ? '' : relativePath;

  const baseDirectory = getNormalizedAbsolutePath(getPathsBasePath(options, cwd), cwd);
  const relativeToBaseUrl = getRelativePathIfInSameVolume(moduleFileName, baseDirectory, caseSensitive);
  if (relativeToBaseUrl === '') return pathsOnly ? '' : relativePath;

  const fromPackageJsonImports = pathsOnly
    ? ''
    : tryGetModuleNameFromPackageJsonImports(
        moduleFileName,
        sourceDirectory,
        options,
        host,
        importMode,
        prefersTsExtension(allowedEndings),
      );
  const fromPaths =
    (pathsOnly || fromPackageJsonImports === '') && paths !== undefined
      ? tryGetModuleNameFromPaths(relativeToBaseUrl, paths, allowedEndings, baseDirectory, host, options)
      : '';
  if (pathsOnly) return fromPaths;

  const maybeNonRelative = fromPackageJsonImports !== '' ? fromPackageJsonImports : fromPaths;
  if (maybeNonRelative === '') return relativePath;

  if (preferences.relativePreference === RelativePreference.NonRelative && !pathIsRelative(maybeNonRelative))
    return maybeNonRelative;

  if (preferences.relativePreference === RelativePreference.ExternalNonRelative && !pathIsRelative(maybeNonRelative)) {
    const projectDirectory = toPath(
      options.configFilePath !== undefined && options.configFilePath !== ''
        ? getDirectoryPath(options.configFilePath)
        : cwd,
      cwd,
      caseSensitive,
    );
    const canonicalSourceDirectory = toPath(sourceDirectory, cwd, caseSensitive);
    const modulePath = toPath(moduleFileName, projectDirectory, caseSensitive);
    const sourceIsInternal = pathContainsPath(projectDirectory, canonicalSourceDirectory);
    const targetIsInternal = pathContainsPath(projectDirectory, modulePath);
    // The import crosses the directory of the tsconfig.json.
    if (sourceIsInternal !== targetIsInternal) return maybeNonRelative;
    const nearestTargetPackageJson = host.getNearestAncestorDirectoryWithPackageJson(getDirectoryPath(modulePath));
    const nearestSourcePackageJson = host.getNearestAncestorDirectoryWithPackageJson(sourceDirectory);
    // The files belong to different packages.
    if (!packageJsonPathsAreEqual(nearestTargetPackageJson, nearestSourcePackageJson, caseSensitive, cwd))
      return maybeNonRelative;
    return relativePath;
  }

  // A relative path wins over a non-relative one with more components.
  if (
    isPathRelativeToParent(maybeNonRelative) ||
    countPathComponents(relativePath) < countPathComponents(maybeNonRelative)
  )
    return relativePath;
  return maybeNonRelative;
}

function getPathsBasePath(options: CompilerOptions, currentDirectory: string): string {
  if (options.paths === undefined || options.paths.size === 0) return '';
  return options.pathsBasePath !== undefined && options.pathsBasePath !== '' ? options.pathsBasePath : currentDirectory;
}

/** Whether the canonical path `child` is `parent` or inside it. */
function pathContainsPath(parent: string, child: string): boolean {
  if (parent === '') return false;
  return (
    parent === child ||
    (child.length > parent.length &&
      child.startsWith(parent) &&
      (parent.endsWith('/') || child.charCodeAt(parent.length) === 0x2f))
  );
}

function packageJsonPathsAreEqual(a: string, b: string, useCaseSensitiveFileNames: boolean, cwd: string): boolean {
  if (a === b) return true;
  if (a === '' || b === '') return false;
  return comparePaths(a, b, useCaseSensitiveFileNames, cwd) === 0;
}

function tryGetModuleNameFromRootDirs(
  rootDirs: readonly string[],
  moduleFileName: string,
  sourceDirectory: string,
  allowedEndings: readonly ModuleSpecifierEnding[],
  options: CompilerOptions,
  host: ModuleSpecifierHost,
): string {
  const caseSensitive = host.useCaseSensitiveFileNames();
  const targetPaths = getPathsRelativeToRootDirs(moduleFileName, rootDirs, caseSensitive);
  if (targetPaths.length === 0) return '';
  const sourcePaths = getPathsRelativeToRootDirs(sourceDirectory, rootDirs, caseSensitive);
  let shortest = '';
  let shortestSeparators = 0;
  for (const sourcePath of sourcePaths) {
    for (const targetPath of targetPaths) {
      const candidate = ensurePathIsNonModuleName(
        getPathFromPathComponents(
          getPathComponentsRelativeTo(sourcePath, targetPath, caseSensitive, host.getCurrentDirectory()),
        ),
      );
      const separators = countSlashes(candidate);
      if (shortest === '' || separators < shortestSeparators) {
        shortest = candidate;
        shortestSeparators = separators;
      }
    }
  }
  return shortest === '' ? '' : processEnding(shortest, allowedEndings, options, host);
}

function getPathsRelativeToRootDirs(
  path: string,
  rootDirs: readonly string[],
  useCaseSensitiveFileNames: boolean,
): string[] {
  const results: string[] = [];
  for (const rootDir of rootDirs) {
    const relative = getRelativePathIfInSameVolume(path, rootDir, useCaseSensitiveFileNames);
    if (!isPathRelativeToParent(relative)) results.push(relative);
  }
  return results;
}

function isPathRelativeToParent(path: string): boolean {
  return path.startsWith('..');
}

/** The path from `directoryPath` to `path`, or `''` when they are on different roots. */
function getRelativePathIfInSameVolume(
  path: string,
  directoryPath: string,
  useCaseSensitiveFileNames: boolean,
): string {
  const relative = getPathFromPathComponents(
    getPathComponentsRelativeTo(directoryPath, path, useCaseSensitiveFileNames, directoryPath),
  );
  return isRootedDiskPath(relative) ? '' : relative;
}

function pathIsBareSpecifier(path: string): boolean {
  return !pathIsAbsolute(path) && !pathIsRelative(path);
}

function ensurePathIsNonModuleName(path: string): string {
  return pathIsBareSpecifier(path) ? './' + path : path;
}

//// Package names

/** Index positions in a path through `node_modules`. */
class NodeModulePathParts {
  constructor(
    /** The `/` before the outermost `node_modules`. */
    readonly topLevelNodeModulesIndex: number,
    /** The `/` before the outermost package name. */
    readonly topLevelPackageNameIndex: number,
    /** The `/` after the innermost package name. */
    readonly packageRootIndex: number,
    readonly fileNameIndex: number,
  ) {}
}

const enum PathParseState {
  BeforeNodeModules,
  NodeModules,
  Scope,
  PackageContent,
}

/**
 * The parts of `/base/node_modules/[@scope/]package/[node_modules/[@scope/]package/]sub/file.js`,
 * or undefined if the path is not a file inside a package.
 */
function getNodeModulePathParts(fullPath: string): NodeModulePathParts | undefined {
  let topLevelNodeModulesIndex = 0;
  let topLevelPackageNameIndex = 0;
  let packageRootIndex = 0;
  let partStart = 0;
  let partEnd = 0;
  let state = PathParseState.BeforeNodeModules;
  while (partEnd >= 0) {
    partStart = partEnd;
    partEnd = fullPath.indexOf('/', partStart + 1);
    switch (state) {
      case PathParseState.BeforeNodeModules:
        if (fullPath.startsWith('/node_modules/', partStart)) {
          topLevelNodeModulesIndex = partStart;
          topLevelPackageNameIndex = partEnd;
          state = PathParseState.NodeModules;
        }
        break;
      case PathParseState.NodeModules:
      case PathParseState.Scope:
        if (state === PathParseState.NodeModules && fullPath.charCodeAt(partStart + 1) === 0x40) {
          state = PathParseState.Scope;
        } else {
          packageRootIndex = partEnd;
          state = PathParseState.PackageContent;
        }
        break;
      case PathParseState.PackageContent:
        state = fullPath.startsWith('/node_modules/', partStart)
          ? PathParseState.NodeModules
          : PathParseState.PackageContent;
        break;
    }
  }
  if (state <= PathParseState.NodeModules) return undefined;
  return new NodeModulePathParts(topLevelNodeModulesIndex, topLevelPackageNameIndex, packageRootIndex, partStart);
}

/** The package name of a file or directory in `node_modules`, or `''`. */
export function getPackageNameFromDirectory(fileOrDirectoryPath: string): string {
  const index = fileOrDirectoryPath.lastIndexOf('/node_modules/');
  if (index === -1) return '';
  const basename = fileOrDirectoryPath.slice(index + '/node_modules/'.length);
  if (basename.startsWith('.')) return '';
  const nextSlash = basename.indexOf('/');
  if (nextSlash === -1) return basename;
  if (!basename.startsWith('@') || nextSlash === basename.length - 1) return basename.slice(0, nextSlash);
  const secondSlash = basename.indexOf('/', nextSlash + 1);
  return secondSlash === -1 ? basename : basename.slice(0, secondSlash);
}

/** A specifier through the nearest `node_modules` of the importing file, or `''`. */
function tryGetModuleNameAsNodeModule(
  modulePath: ModulePath,
  info: ImporterInfo,
  importingFile: SourceFile,
  host: ModuleSpecifierHost,
  options: CompilerOptions,
  userPreferences: ModuleSpecifierPreferences,
  packageNameOnly: boolean,
  overrideMode: ModuleKind,
): string {
  const parts = getNodeModulePathParts(modulePath.fileName);
  if (parts === undefined) return '';
  // Only a `node_modules` in the importing file's directory or above can be used, and not the global typings
  // cache. This is checked before `exports`, which can give a bare specifier directly.
  const caseSensitive = host.useCaseSensitiveFileNames();
  const globalTypingsCacheLocation = host.getGlobalTypingsCacheLocation();
  const pathToTopLevelNodeModules = modulePath.fileName.slice(0, parts.topLevelNodeModulesIndex);
  if (
    !hasPrefix(info.sourceDirectory, pathToTopLevelNodeModules, caseSensitive) ||
    (globalTypingsCacheLocation !== '' &&
      hasPrefix(globalTypingsCacheLocation, pathToTopLevelNodeModules, caseSensitive))
  )
    return '';
  const preferences = resolvePreferences(userPreferences, host, options, importingFile, '');
  const allowedEndings = preferences.allowedEndings(ModuleKind.None);
  let moduleSpecifier = modulePath.fileName;
  let isPackageRootPath = false;
  if (!packageNameOnly) {
    // tsgo tries only the innermost package directory, with no deeper directories.
    const attempt = tryDirectoryWithPackageJson(
      parts,
      modulePath,
      importingFile,
      host,
      overrideMode,
      options,
      allowedEndings,
    );
    // Not exported: `node_modules` resolution can't reach it.
    if (attempt.blockedByExports) return '';
    if (attempt.verbatimFromExports) return attempt.moduleFileToTry;
    if (attempt.packageRootPath !== '') {
      moduleSpecifier = attempt.packageRootPath;
      isPackageRootPath = true;
    } else {
      moduleSpecifier = processEnding(attempt.moduleFileToTry, allowedEndings, options, host);
    }
  }
  if (modulePath.isRedirect && !isPackageRootPath) return '';

  // A package found in `@types` is imported by its own name.
  return getPackageNameFromTypesPackageName(moduleSpecifier.slice(parts.topLevelPackageNameIndex + 1));
}

class PackageDirectoryAttempt {
  constructor(
    readonly moduleFileToTry: string,
    /** The package directory, when the file is the package's entry point. */
    readonly packageRootPath: string,
    readonly blockedByExports: boolean,
    /** `moduleFileToTry` is a specifier from `exports`, used as is. */
    readonly verbatimFromExports: boolean,
  ) {}
}

function attempt(moduleFileToTry: string, packageRootPath: string): PackageDirectoryAttempt {
  return new PackageDirectoryAttempt(moduleFileToTry, packageRootPath, false, false);
}

function tryDirectoryWithPackageJson(
  parts: NodeModulePathParts,
  modulePath: ModulePath,
  importingFile: SourceFile,
  host: ModuleSpecifierHost,
  overrideMode: ModuleKind,
  options: CompilerOptions,
  allowedEndings: readonly ModuleSpecifierEnding[],
): PackageDirectoryAttempt {
  const fileName = modulePath.fileName;
  const packageRootPath = fileName.slice(0, parts.packageRootIndex === -1 ? fileName.length : parts.packageRootIndex);
  const packageJsonPath = combinePaths(packageRootPath, 'package.json');
  let moduleFileToTry = fileName;
  let maybeBlockedByTypesVersions = false;
  const packageJson = host.getPackageJsonInfo(packageJsonPath);
  if (packageJson === undefined) {
    // Without a package.json, an index file still resolves as the package name.
    const name = moduleFileToTry.slice(parts.packageRootIndex + 1);
    return name === 'index.d.ts' || name === 'index.js' || name === 'index.ts' || name === 'index.tsx'
      ? attempt(moduleFileToTry, packageRootPath)
      : attempt(moduleFileToTry, '');
  }
  let importMode =
    overrideMode !== ModuleKind.None ? overrideMode : host.getDefaultResolutionModeForFile(importingFile);
  const contents = packageJson.contents;
  if (getResolvePackageJsonExports(options)) {
    // The directory name in node_modules, not the package.json `name`, which can differ for
    // url or file dependencies.
    const packageName = getPackageNameFromTypesPackageName(packageRootPath.slice(parts.topLevelPackageNameIndex + 1));
    // Conditions follow the target file's format: `.cjs`-like files match `require`, `.mjs`-like `import`.
    if (fileExtensionIsOneOf(fileName, ['.cjs', '.cts', '.d.cts'])) importMode = ModuleKind.CommonJS;
    else if (fileExtensionIsOneOf(fileName, ['.mjs', '.mts', '.d.mts'])) importMode = ModuleKind.ESNext;
    const exports = contents?.exports;
    if (exports !== undefined) {
      const conditions = getConditions(options, importMode);
      const fromExports = tryGetModuleNameFromExports(
        options,
        host,
        fileName,
        packageRootPath,
        packageName,
        exports,
        conditions,
      );
      if (fromExports !== '') return new PackageDirectoryAttempt(fromExports, '', false, true);
      return new PackageDirectoryAttempt(fileName, '', true, false);
    }
  }

  const versionPaths =
    contents !== undefined && contents.typesVersions !== undefined && contents.typesVersions.type === 'object'
      ? contents.getVersionPaths(undefined)
      : undefined;
  if (versionPaths !== undefined) {
    const subModuleName = fileName.slice(packageRootPath.length + 1);
    const fromPaths = tryGetModuleNameFromPaths(
      subModuleName,
      versionPaths.paths,
      allowedEndings,
      packageRootPath,
      host,
      options,
    );
    if (fromPaths === '') maybeBlockedByTypesVersions = true;
    else moduleFileToTry = combinePaths(packageRootPath, fromPaths);
  }

  // The main file can be imported by the package name.
  let mainFileRelative = 'index.js';
  if (contents !== undefined) {
    if (contents.typings.value !== undefined) mainFileRelative = contents.typings.value;
    else if (contents.types.value !== undefined) mainFileRelative = contents.types.value;
    else if (contents.main.value !== undefined) mainFileRelative = contents.main.value;
  }
  // When typesVersions maps the main file but gave no path for this file, the main file isn't
  // reachable through the package name.
  if (
    mainFileRelative !== '' &&
    !(
      maybeBlockedByTypesVersions &&
      versionPaths !== undefined &&
      matchPatternOrExact(parsePatterns(versionPaths.paths), mainFileRelative) !== undefined
    )
  ) {
    const caseSensitive = host.useCaseSensitiveFileNames();
    const cwd = host.getCurrentDirectory();
    const mainExportFile = toPath(mainFileRelative, packageRootPath, caseSensitive);
    if (
      comparePaths(removeFileExtension(mainExportFile), removeFileExtension(moduleFileToTry), caseSensitive, cwd) === 0
    )
      return attempt(moduleFileToTry, packageRootPath);
    // A main naming a directory reaches its index file, except in `"type": "module"` packages.
    if (
      (contents === undefined || contents.type.value !== 'module') &&
      !fileExtensionIsOneOf(moduleFileToTry, extensionsNotSupportingExtensionlessResolution()) &&
      hasPrefix(moduleFileToTry, mainExportFile, caseSensitive) &&
      comparePaths(
        getDirectoryPath(moduleFileToTry),
        removeTrailingDirectorySeparator(mainExportFile),
        caseSensitive,
        cwd,
      ) === 0 &&
      removeFileExtension(getBaseFileName(moduleFileToTry)) === 'index'
    )
      return attempt(moduleFileToTry, packageRootPath);
  }
  return attempt(moduleFileToTry, '');
}

function tryGetModuleNameFromExports(
  options: CompilerOptions,
  host: ModuleSpecifierHost,
  targetFilePath: string,
  packageDirectory: string,
  packageName: string,
  exports: JsonValue,
  conditions: readonly string[],
): string {
  if (exports.type === 'object' && exports.kind === JsonObjectKind.Subpaths) {
    // Directory (`./dir/`), pattern (`./*`) and exact subpath keys.
    for (const [key, value] of exports.entries) {
      const subPackageName = getNormalizedAbsolutePath(combinePaths(packageName, key), '');
      const mode = key.endsWith('/')
        ? MatchingMode.Directory
        : key.includes('*')
          ? MatchingMode.Pattern
          : MatchingMode.Exact;
      const result = tryGetModuleNameFromExportsOrImports(
        options,
        host,
        targetFilePath,
        packageDirectory,
        subPackageName,
        value,
        conditions,
        mode,
        false,
        false,
      );
      if (result !== '') return result;
    }
  }
  return tryGetModuleNameFromExportsOrImports(
    options,
    host,
    targetFilePath,
    packageDirectory,
    packageName,
    exports,
    conditions,
    MatchingMode.Exact,
    false,
    false,
  );
}

function tryGetModuleNameFromPackageJsonImports(
  moduleFileName: string,
  sourceDirectory: string,
  options: CompilerOptions,
  host: ModuleSpecifierHost,
  importMode: ModuleKind,
  preferTsExtension: boolean,
): string {
  if (!getResolvePackageJsonImports(options)) return '';
  const packageDirectory = host.getNearestAncestorDirectoryWithPackageJson(sourceDirectory);
  if (packageDirectory === '') return '';
  const info = host.getPackageJsonInfo(combinePaths(packageDirectory, 'package.json'));
  const imports = info?.contents?.imports;
  if (imports === undefined || imports.type !== 'object') return '';
  const conditions = getConditions(options, importMode);
  const resolution = getModuleResolutionKind(options);
  for (const [key, value] of imports.entries) {
    if (key === '#' || key === '#/' || !key.startsWith('#')) continue;
    // `#/` keys are valid only in nodenext and bundler.
    if (
      key.startsWith('#/') &&
      resolution !== ModuleResolutionKind.NodeNext &&
      resolution !== ModuleResolutionKind.Bundler
    )
      continue;
    const mode = key.endsWith('/')
      ? MatchingMode.Directory
      : key.includes('*')
        ? MatchingMode.Pattern
        : MatchingMode.Exact;
    const result = tryGetModuleNameFromExportsOrImports(
      options,
      host,
      moduleFileName,
      packageDirectory,
      key,
      value,
      conditions,
      mode,
      true,
      preferTsExtension,
    );
    if (result !== '') return result;
  }
  return '';
}

function tryGetModuleNameFromExportsOrImports(
  options: CompilerOptions,
  host: ModuleSpecifierHost,
  targetFilePath: string,
  packageDirectory: string,
  packageName: string,
  exports: JsonValue,
  conditions: readonly string[],
  mode: MatchingMode,
  isImports: boolean,
  preferTsExtension: boolean,
): string {
  switch (exports.type) {
    case 'string': {
      // As tsgo, the importing project's options apply to the package's files.
      const outputFile = isImports ? getOutputJSFileNameWorker(targetFilePath, options, host.getOutputPathsHost()) : '';
      const declarationFile = isImports
        ? getOutputDeclarationFileNameWorker(targetFilePath, options, host.getOutputPathsHost())
        : '';
      const target = exports.value;
      const pathOrPattern = getNormalizedAbsolutePath(combinePaths(packageDirectory, target), '');
      const extensionSwappedTarget = hasTSFileExtension(targetFilePath)
        ? removeFileExtension(targetFilePath) + tryGetJSExtensionForFile(targetFilePath, options)
        : '';
      const canTryTsExtension = preferTsExtension && hasImplementationTSFileExtension(targetFilePath);
      const caseSensitive = host.useCaseSensitiveFileNames();
      const cwd = host.getCurrentDirectory();
      switch (mode) {
        case MatchingMode.Exact:
          if (
            (extensionSwappedTarget !== '' &&
              comparePaths(extensionSwappedTarget, pathOrPattern, caseSensitive, cwd) === 0) ||
            comparePaths(targetFilePath, pathOrPattern, caseSensitive, cwd) === 0 ||
            (outputFile !== '' && comparePaths(outputFile, pathOrPattern, caseSensitive, cwd) === 0) ||
            (declarationFile !== '' && comparePaths(declarationFile, pathOrPattern, caseSensitive, cwd) === 0)
          )
            return packageName;
          break;
        case MatchingMode.Directory: {
          const subdirectory = (file: string): string =>
            getNormalizedAbsolutePath(
              combinePaths(
                combinePaths(packageName, target),
                getRelativePathFromDirectory(pathOrPattern, file, caseSensitive, cwd),
              ),
              '',
            );
          if (canTryTsExtension && containsPath(targetFilePath, pathOrPattern, caseSensitive, cwd))
            return subdirectory(targetFilePath);
          if (extensionSwappedTarget !== '' && containsPath(pathOrPattern, extensionSwappedTarget, caseSensitive, cwd))
            return subdirectory(extensionSwappedTarget);
          if (!canTryTsExtension && containsPath(pathOrPattern, targetFilePath, caseSensitive, cwd))
            return subdirectory(targetFilePath);
          if (outputFile !== '' && containsPath(pathOrPattern, outputFile, caseSensitive, cwd))
            return combinePaths(
              packageName,
              getRelativePathFromDirectory(pathOrPattern, outputFile, caseSensitive, cwd),
            );
          if (declarationFile !== '' && containsPath(pathOrPattern, declarationFile, caseSensitive, cwd)) {
            const fragment = getRelativePathFromDirectory(pathOrPattern, declarationFile, caseSensitive, cwd);
            return combinePaths(
              packageName,
              changeExtension(fragment, tryGetJSExtensionForFile(declarationFile, options)),
            );
          }
          break;
        }
        case MatchingMode.Pattern: {
          const star = pathOrPattern.indexOf('*');
          const leading = star === -1 ? pathOrPattern : pathOrPattern.slice(0, star);
          const trailing = star === -1 ? '' : pathOrPattern.slice(star + 1);
          const replacement = (file: string): string =>
            replaceFirstStar(packageName, file.slice(leading.length, file.length - trailing.length));
          if (canTryTsExtension && hasPrefixAndSuffixWithoutOverlap(targetFilePath, leading, trailing, caseSensitive))
            return replacement(targetFilePath);
          if (
            extensionSwappedTarget !== '' &&
            hasPrefixAndSuffixWithoutOverlap(extensionSwappedTarget, leading, trailing, caseSensitive)
          )
            return replacement(extensionSwappedTarget);
          if (!canTryTsExtension && hasPrefixAndSuffixWithoutOverlap(targetFilePath, leading, trailing, caseSensitive))
            return replacement(targetFilePath);
          if (outputFile !== '' && hasPrefixAndSuffixWithoutOverlap(outputFile, leading, trailing, caseSensitive))
            return replacement(outputFile);
          if (
            declarationFile !== '' &&
            hasPrefixAndSuffixWithoutOverlap(declarationFile, leading, trailing, caseSensitive)
          ) {
            const jsExtension = tryGetJSExtensionForFile(declarationFile, options);
            if (jsExtension !== '') return changeFullExtension(replacement(declarationFile), jsExtension);
          }
          break;
        }
      }
      return '';
    }
    case 'array':
      for (const item of exports.items) {
        const result = tryGetModuleNameFromExportsOrImports(
          options,
          host,
          targetFilePath,
          packageDirectory,
          packageName,
          item,
          conditions,
          mode,
          isImports,
          preferTsExtension,
        );
        if (result !== '') return result;
      }
      return '';
    case 'object':
      // Conditions.
      for (const [key, value] of exports.entries) {
        if (
          key === 'default' ||
          conditions.includes(key) ||
          (conditions.includes('types') && isApplicableVersionedTypesKey(key))
        ) {
          const result = tryGetModuleNameFromExportsOrImports(
            options,
            host,
            targetFilePath,
            packageDirectory,
            packageName,
            value,
            conditions,
            mode,
            isImports,
            preferTsExtension,
          );
          if (result !== '') return result;
        }
      }
      return '';
  }
  return '';
}

/** The first `paths` key whose substitution matches the file, with `*` filled in, or `''`. */
function tryGetModuleNameFromPaths(
  relativeToBaseUrl: string,
  paths: ReadonlyMap<string, readonly string[] | undefined>,
  allowedEndings: readonly ModuleSpecifierEnding[],
  baseDirectory: string,
  host: ModuleSpecifierHost,
  options: CompilerOptions,
): string {
  const caseSensitive = host.useCaseSensitiveFileNames();
  for (const [key, values] of paths) {
    if (values === undefined) continue;
    for (const patternText of values) {
      const normalized = normalizePath(patternText);
      let pattern = getRelativePathIfInSameVolume(normalized, baseDirectory, caseSensitive);
      if (pattern === '') pattern = normalized;
      const star = pattern.indexOf('*');
      const prefix = star === -1 ? pattern : pattern.slice(0, star);
      const suffix = star === -1 ? '' : pattern.slice(star + 1);
      // Candidates: the file with each allowed ending, then, when the pattern has an extension,
      // the file name itself (a pattern like `./dist/*.d.ts` maps to the file directly).
      const candidateEndings: ModuleSpecifierEnding[] = [];
      const candidates: string[] = [];
      for (const ending of allowedEndings) {
        candidateEndings.push(ending);
        candidates.push(processEnding(relativeToBaseUrl, [ending], options, host));
      }
      if (tryGetExtensionFromPath(pattern) !== '') {
        candidateEndings.push(ModuleSpecifierEnding.JsExtension);
        candidates.push(relativeToBaseUrl);
      }
      if (star !== -1) {
        for (let i = 0; i < candidates.length; i++) {
          const value = candidates[i]!;
          if (
            value.length >= prefix.length + suffix.length &&
            hasPrefix(value, prefix, caseSensitive) &&
            hasSuffix(value, suffix, caseSensitive) &&
            validateEnding(candidateEndings[i]!, value, relativeToBaseUrl, options, host)
          ) {
            const matchedStar = value.slice(prefix.length, value.length - suffix.length);
            if (!pathIsRelative(matchedStar)) return replaceFirstStar(key, matchedStar);
          }
        }
      } else {
        for (let i = 0; i < candidates.length; i++)
          if (candidateEndings[i] !== ModuleSpecifierEnding.Minimal && pattern === candidates[i]) return key;
        for (let i = 0; i < candidates.length; i++)
          if (
            candidateEndings[i] === ModuleSpecifierEnding.Minimal &&
            pattern === candidates[i] &&
            validateEnding(candidateEndings[i]!, candidates[i]!, relativeToBaseUrl, options, host)
          )
            return key;
      }
    }
  }
  return '';
}

/** A minimal ending must agree with what dropping `/index` gives once the file system is checked. */
function validateEnding(
  ending: ModuleSpecifierEnding,
  value: string,
  relativeToBaseUrl: string,
  options: CompilerOptions,
  host: ModuleSpecifierHost,
): boolean {
  return (
    ending !== ModuleSpecifierEnding.Minimal || value === processEnding(relativeToBaseUrl, [ending], options, host)
  );
}

function replaceFirstStar(text: string, replacement: string): string {
  const star = text.indexOf('*');
  return star === -1 ? text : text.slice(0, star) + replacement + text.slice(star + 1);
}

function hasPrefix(text: string, prefix: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return text.startsWith(prefix);
  if (prefix.length > text.length) return false;
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function hasSuffix(text: string, suffix: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return text.endsWith(suffix);
  if (suffix.length > text.length) return false;
  return text.slice(text.length - suffix.length).toLowerCase() === suffix.toLowerCase();
}

function hasPrefixAndSuffixWithoutOverlap(
  text: string,
  prefix: string,
  suffix: string,
  caseSensitive: boolean,
): boolean {
  return (
    prefix.length + suffix.length <= text.length &&
    hasPrefix(text, prefix, caseSensitive) &&
    hasSuffix(text, suffix, caseSensitive)
  );
}

/** Replaces the extension, taking a declaration extension from its `.d`. */
function changeFullExtension(path: string, newExtension: string): string {
  const declarationExtension = getDeclarationFileExtension(path);
  if (declarationExtension === '') return changeExtension(path, newExtension);
  return (
    path.slice(0, path.length - declarationExtension.length) +
    (newExtension.startsWith('.') ? newExtension : '.' + newExtension)
  );
}

//// Endings

function extensionsNotSupportingExtensionlessResolution(): readonly string[] {
  return ['.mts', '.d.mts', '.mjs', '.cts', '.d.cts', '.cjs'];
}

function isNodeNext(options: CompilerOptions): boolean {
  const kind = getModuleResolutionKind(options);
  return ModuleResolutionKind.Node16 <= kind && kind <= ModuleResolutionKind.NodeNext;
}

// `noEmit` or `emitDeclarationOnly` is validated with the option elsewhere.
function shouldAllowImportingTsExtension(options: CompilerOptions, fromFileName: string): boolean {
  return getAllowImportingTsExtensions(options) || (fromFileName !== '' && isDeclarationFileName(fromFileName));
}

function usesExtensionsOnImports(file: SourceFile): boolean {
  for (const specifier of file.imports) {
    const text = getText(specifier);
    if (pathIsRelative(text) && !fileExtensionIsOneOf(text, extensionsNotSupportingExtensionlessResolution()))
      return hasTSFileExtension(text) || hasJSFileExtension(text);
  }
  return false;
}

function inferPreference(resolutionMode: ModuleKind, file: SourceFile, nodeNext: boolean): ModuleSpecifierEnding {
  let usesJsExtensions = false;
  for (const specifier of file.imports) {
    const path = getText(specifier);
    if (!pathIsRelative(path)) continue;
    if (nodeNext && resolutionMode === ModuleKind.CommonJS) continue;
    // Extensions these require say nothing about preference.
    if (fileExtensionIsOneOf(path, extensionsNotSupportingExtensionlessResolution())) continue;
    if (hasTSFileExtension(path)) return ModuleSpecifierEnding.TsExtension;
    if (hasJSFileExtension(path)) usesJsExtensions = true;
  }
  return usesJsExtensions ? ModuleSpecifierEnding.JsExtension : ModuleSpecifierEnding.Minimal;
}

function getModuleSpecifierEndingPreference(
  preference: ImportModuleSpecifierEndingPreference,
  resolutionMode: ModuleKind,
  options: CompilerOptions,
  file: SourceFile,
): ModuleSpecifierEnding {
  const nodeNext = isNodeNext(options);
  if (preference === 'js' || (resolutionMode === ModuleKind.ESNext && nodeNext)) {
    // An extension is requested or required: `.js`, or `.ts` where allowed unless the file
    // only uses `.js`.
    if (!shouldAllowImportingTsExtension(options, '')) return ModuleSpecifierEnding.JsExtension;
    return inferPreference(resolutionMode, file, nodeNext) !== ModuleSpecifierEnding.JsExtension
      ? ModuleSpecifierEnding.TsExtension
      : ModuleSpecifierEnding.JsExtension;
  }
  if (preference === 'minimal') return ModuleSpecifierEnding.Minimal;
  if (preference === 'index') return ModuleSpecifierEnding.Index;
  // No preference: follow the file's other imports.
  if (!shouldAllowImportingTsExtension(options, ''))
    return usesExtensionsOnImports(file) ? ModuleSpecifierEnding.JsExtension : ModuleSpecifierEnding.Minimal;
  return inferPreference(resolutionMode, file, nodeNext);
}

function getPreferredEnding(
  preferences: ModuleSpecifierPreferences,
  host: ModuleSpecifierHost,
  options: CompilerOptions,
  importingFile: SourceFile,
  oldImportSpecifier: string,
  resolutionMode: ModuleKind,
): ModuleSpecifierEnding {
  if (oldImportSpecifier !== '') {
    if (hasJSFileExtension(oldImportSpecifier)) return ModuleSpecifierEnding.JsExtension;
    if (oldImportSpecifier.endsWith('/index')) return ModuleSpecifierEnding.Index;
  }
  if (resolutionMode === ModuleKind.None) resolutionMode = host.getDefaultResolutionModeForFile(importingFile);
  return getModuleSpecifierEndingPreference(
    preferences.importModuleSpecifierEnding,
    resolutionMode,
    options,
    importingFile,
  );
}

/** The endings a specifier from `importingFile` may have, most preferred first. */
export function getAllowedEndingsInPreferredOrder(
  preferences: ModuleSpecifierPreferences,
  host: ModuleSpecifierHost,
  options: CompilerOptions,
  importingFile: SourceFile,
  oldImportSpecifier: string,
  syntaxImpliedNodeFormat: ModuleKind,
): ModuleSpecifierEnding[] {
  let preferred = getPreferredEnding(preferences, host, options, importingFile, oldImportSpecifier, ModuleKind.None);
  const resolutionMode = host.getDefaultResolutionModeForFile(importingFile);
  if (resolutionMode !== syntaxImpliedNodeFormat)
    preferred = getPreferredEnding(
      preferences,
      host,
      options,
      importingFile,
      oldImportSpecifier,
      syntaxImpliedNodeFormat,
    );
  const allowTs = shouldAllowImportingTsExtension(options, importingFile.fileName);
  // Without a mode implied by the syntax, the file's default resolution mode applies.
  const effectiveSyntaxMode = syntaxImpliedNodeFormat !== ModuleKind.None ? syntaxImpliedNodeFormat : resolutionMode;
  if (effectiveSyntaxMode === ModuleKind.ESNext && isNodeNext(options))
    return allowTs
      ? [ModuleSpecifierEnding.TsExtension, ModuleSpecifierEnding.JsExtension]
      : [ModuleSpecifierEnding.JsExtension];
  switch (preferred) {
    case ModuleSpecifierEnding.JsExtension:
      return allowTs
        ? [
            ModuleSpecifierEnding.JsExtension,
            ModuleSpecifierEnding.TsExtension,
            ModuleSpecifierEnding.Minimal,
            ModuleSpecifierEnding.Index,
          ]
        : [ModuleSpecifierEnding.JsExtension, ModuleSpecifierEnding.Minimal, ModuleSpecifierEnding.Index];
    case ModuleSpecifierEnding.TsExtension:
      return [
        ModuleSpecifierEnding.TsExtension,
        ModuleSpecifierEnding.Minimal,
        ModuleSpecifierEnding.JsExtension,
        ModuleSpecifierEnding.Index,
      ];
    case ModuleSpecifierEnding.Index:
      return allowTs
        ? [
            ModuleSpecifierEnding.Index,
            ModuleSpecifierEnding.Minimal,
            ModuleSpecifierEnding.TsExtension,
            ModuleSpecifierEnding.JsExtension,
          ]
        : [ModuleSpecifierEnding.Index, ModuleSpecifierEnding.Minimal, ModuleSpecifierEnding.JsExtension];
  }
  return allowTs
    ? [
        ModuleSpecifierEnding.Minimal,
        ModuleSpecifierEnding.Index,
        ModuleSpecifierEnding.TsExtension,
        ModuleSpecifierEnding.JsExtension,
      ]
    : [ModuleSpecifierEnding.Minimal, ModuleSpecifierEnding.Index, ModuleSpecifierEnding.JsExtension];
}

function resolvePreferences(
  preferences: ModuleSpecifierPreferences,
  host: ModuleSpecifierHost,
  options: CompilerOptions,
  importingFile: SourceFile,
  oldImportSpecifier: string,
): ResolvedPreferences {
  let relativePreference = RelativePreference.Shortest;
  if (oldImportSpecifier !== '') {
    relativePreference = isExternalModuleNameRelative(oldImportSpecifier)
      ? RelativePreference.Relative
      : RelativePreference.NonRelative;
  } else {
    switch (preferences.importModuleSpecifierPreference) {
      case 'relative':
        relativePreference = RelativePreference.Relative;
        break;
      case 'non-relative':
        relativePreference = RelativePreference.NonRelative;
        break;
      case 'project-relative':
        relativePreference = RelativePreference.ExternalNonRelative;
        break;
    }
  }
  return new ResolvedPreferences(relativePreference, preferences, host, options, importingFile, oldImportSpecifier);
}

function prefersTsExtension(allowedEndings: readonly ModuleSpecifierEnding[]): boolean {
  const tsPriority = allowedEndings.indexOf(ModuleSpecifierEnding.TsExtension);
  return tsPriority > -1 && tsPriority < allowedEndings.indexOf(ModuleSpecifierEnding.JsExtension);
}

/** The JavaScript extension a file is imported with, or `''`. */
export function tryGetJSExtensionForFile(fileName: string, options: CompilerOptions): string {
  const extension = tryGetExtensionFromPath(fileName);
  switch (extension) {
    case '.ts':
    case '.d.ts':
      return '.js';
    case '.tsx':
      return options.jsx === JsxEmit.Preserve ? '.jsx' : '.js';
    case '.js':
    case '.jsx':
    case '.json':
      return extension;
    case '.d.mts':
    case '.mts':
    case '.mjs':
      return '.mjs';
    case '.d.cts':
    case '.cts':
    case '.cjs':
      return '.cjs';
  }
  return '';
}

function getJSExtensionForFile(fileName: string, options: CompilerOptions): string {
  const extension = tryGetJSExtensionForFile(fileName, options);
  if (extension === '')
    throw new Error('Extension ' + tryGetExtensionFromPath(fileName) + ' is unsupported: ' + fileName);
  return extension;
}

/** `.js`, `.mjs` or `.cjs` for `.d.ts`, `.d.mts` or `.d.cts`; `.json` for `.d.json.ts` and the like. */
export function getJSExtensionForDeclarationFileExtension(extension: string): string {
  switch (extension) {
    case '.d.ts':
      return '.js';
    case '.d.mts':
      return '.mjs';
    case '.d.cts':
      return '.cjs';
  }
  return extension.slice('.d'.length, extension.length - '.ts'.length);
}

/** `foo.d.json.ts` or `foo.module.d.css.ts` back to `foo.json` or `foo.module.css`, else `''`. */
export function tryGetRealFileNameForNonJSDeclarationFileName(fileName: string): string {
  const baseName = getBaseFileName(fileName);
  if (!fileName.endsWith('.ts') || !baseName.includes('.d.') || baseName.endsWith('.d.ts')) return '';
  const noExtension = removeExtension(fileName, '.ts');
  const extension = noExtension.slice(noExtension.lastIndexOf('.'));
  return noExtension.slice(0, noExtension.indexOf('.d.')) + extension;
}

/** `fileName`, a path to a module, with the ending the first of `allowedEndings` gives it. */
export function processEnding(
  fileName: string,
  allowedEndings: readonly ModuleSpecifierEnding[],
  options: CompilerOptions,
  host: ModuleSpecifierHost | undefined,
): string {
  if (fileExtensionIsOneOf(fileName, ['.json', '.mjs', '.cjs'])) return fileName;
  const noExtension = removeFileExtension(fileName);
  if (fileName === noExtension) return fileName;
  const jsPriority = allowedEndings.indexOf(ModuleSpecifierEnding.JsExtension);
  const tsPriority = allowedEndings.indexOf(ModuleSpecifierEnding.TsExtension);
  if (fileExtensionIsOneOf(fileName, ['.mts', '.cts']) && tsPriority !== -1 && tsPriority < jsPriority) return fileName;
  if (fileExtensionIsOneOf(fileName, ['.d.mts', '.d.cts'])) {
    const inputExtension = getDeclarationFileExtension(fileName);
    return removeExtension(fileName, inputExtension) + getJSExtensionForDeclarationFileExtension(inputExtension);
  }
  if (fileExtensionIsOneOf(fileName, ['.mts', '.cts'])) return noExtension + getJSExtensionForFile(fileName, options);
  if (!fileName.endsWith('.d.ts') && fileName.endsWith('.ts') && fileName.includes('.d.')) {
    const real = tryGetRealFileNameForNonJSDeclarationFileName(fileName);
    if (real !== '') return real;
  }
  switch (allowedEndings[0]) {
    case ModuleSpecifierEnding.Minimal: {
      const withoutIndex = noExtension.endsWith('/index')
        ? noExtension.slice(0, noExtension.length - '/index'.length)
        : noExtension;
      // A file named like the directory would be imported instead.
      if (host !== undefined && withoutIndex !== noExtension && tryGetAnyFileFromPath(host, withoutIndex))
        return noExtension;
      return withoutIndex;
    }
    case ModuleSpecifierEnding.Index:
      return noExtension;
    case ModuleSpecifierEnding.JsExtension:
      return noExtension + getJSExtensionForFile(fileName, options);
    case ModuleSpecifierEnding.TsExtension: {
      // Whether the import is type-only isn't known, so a declaration file gets no extension or `.js`.
      if (isDeclarationFileName(fileName)) {
        let extensionlessPriority = -1;
        for (let i = 0; i < allowedEndings.length; i++) {
          if (
            allowedEndings[i] === ModuleSpecifierEnding.Minimal ||
            allowedEndings[i] === ModuleSpecifierEnding.Index
          ) {
            extensionlessPriority = i;
            break;
          }
        }
        if (extensionlessPriority !== -1 && extensionlessPriority < jsPriority) return noExtension;
        return noExtension + getJSExtensionForFile(fileName, options);
      }
      return fileName;
    }
  }
  return fileName;
}

/** Whether a file `path` with a JavaScript, TypeScript or declaration extension exists. */
function tryGetAnyFileFromPath(host: ModuleSpecifierHost, path: string): boolean {
  const extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.cts', '.d.cts', '.cjs', '.mts', '.d.mts', '.mjs'];
  const cwd = host.getCurrentDirectory();
  for (const extension of extensions)
    if (host.fileExists(getNormalizedAbsolutePath(path + extension, cwd))) return true;
  return false;
}
