// The exports of the packages in the node_modules directories above a file, as tsgo's ls/autoimport registry builds
// its node_modules buckets for an auto-imports request: the packages the package.json files above the file depend on
// and the packages the program imports, extracted from their entrypoints with a checker of their own.
import { getText, type Node, type SourceFile } from '../compiler/ast.js';
import { isSourcePhaseImport } from '../compiler/ast-utilities.js';
import { getSourceFileOfNode } from '../compiler/binder-utilities.js';
import { bindSourceFile } from '../compiler/binder.js';
import { Checker, CheckerHost } from '../compiler/checker.js';
import { tryFindAmbientModule } from '../compiler/checker-modules.js';
import { CompilerHost } from '../compiler/file-loader.js';
import type { FileSystem } from '../compiler/file-system.js';
import {
  getPackageNameFromTypesPackageName,
  getTypesPackageName,
  parsePackageName,
  type ResolvedModule,
  Resolver,
} from '../compiler/module-resolution.js';
import { getPackageNameFromDirectory } from '../compiler/module-specifiers.js';
import { type CompilerOptions, ModuleKind } from '../compiler/options.js';
import { getEntrypointsFromPackageJsonInfo, type ResolvedEntrypoint } from '../compiler/package-entrypoints.js';
import { type PackageJson, type PackageJsonInfo, parsePackageJson } from '../compiler/package-json.js';
import {
  combinePaths,
  containsPath,
  getBaseFileName,
  getDirectoryPath,
  isExternalModuleNameRelative,
  normalizePath,
} from '../compiler/path.js';
import type { Program } from '../compiler/program.js';
import type { Symbol } from '../compiler/symbol.js';
import { Export, ExportExtractor, ExportIndex, getNonAugmentationDeclaration } from './auto-import-exports.js';

/** Packages whose every file is offered, as tsgo searches them even when nothing imports their subpaths. */
const knownRecursiveSearchPackages = new Set([
  '@material-ui/core',
  '@material-ui/icons',
  '@sap/cds',
  '@testing-library/react-native',
  'ajv',
  'asap',
  'async',
  'aws-sdk',
  'braintree-web',
  'core-js',
  'core-js-pure',
  'crypto-js',
  'cypress-mochawesome-reporter',
  'dd-trace',
  'dumi',
  'dva',
  'egg-mock',
  'electron-log',
  'es-abstract',
  'es6-promise',
  'eslint-config-taro',
  'expo',
  'expo-router',
  'flow-remove-types',
  'gatsby',
  'glamor',
  'gluegun',
  'graphology-indices',
  'graphology-traversal',
  'graphology-utils',
  'jest-expo',
  'lodash',
  'lodash-es',
  'moment',
  'mz',
  'next',
  'pdfjs-dist',
  'protobufjs',
  'react-app-polyfill',
  'react-dev-utils',
  'react-devtools-inline',
  'recast',
  'semver',
  'stylelint-config-html',
  'umi',
  'web3-provider-engine',
  'webpack',
]);

/** What building package buckets reads with. */
export interface PackageHost {
  /** The file system packages are read from. */
  readonly fs: FileSystem;
  readonly currentDirectory: string;
  toPath(fileName: string): string;
  /** A package file parsed as auto-imports parse files, without the program's module detection options. */
  getSourceFile(fileName: string): SourceFile | undefined;
}

/** A directory above an importing file: its `package.json` and whether it has a `node_modules` directory. */
export class PackageDirectory {
  constructor(
    readonly name: string,
    readonly packageJson: PackageJsonInfo,
    readonly hasNodeModules: boolean,
  ) {}
}

/** The exports of the packages in one `node_modules` directory. */
export class NodeModulesBucket {
  constructor(
    readonly index: ExportIndex,
    /** The packages in the directory, indexed or not, which hide packages of the same name further up. */
    readonly packageNames: ReadonlySet<string>,
    /** The ambient modules the packages' entrypoints declare, and the files declaring them. */
    readonly ambientModuleNames: ReadonlyMap<string, readonly string[]>,
  ) {}
}

/** The node_modules buckets for an importing file's directories, and the entrypoints of their packages' files. */
export class PackageBuckets {
  constructor(
    /** The directories above the importing file, by path. */
    readonly directories: ReadonlyMap<string, PackageDirectory>,
    /** The buckets of the directories with a `node_modules` directory, by the directory's path. */
    readonly nodeModules: ReadonlyMap<string, NodeModulesBucket>,
    /** The entrypoints of each indexed package file, by its path. */
    readonly entrypoints: ReadonlyMap<string, readonly ResolvedEntrypoint[]>,
  ) {}
}

/** The package names the program's files import, as tsgo's Program collects them for auto-imports. */
export class ProgramPackageNames {
  constructor(
    /** Packages imports resolved into, by `package.json` name. */
    readonly resolved: ReadonlySet<string>,
    /** Module names of imports that did not resolve. */
    readonly unresolved: ReadonlySet<string>,
    /** Packages without `exports` that imports reach subpaths of. */
    readonly deepImports: ReadonlySet<string>,
  ) {}
}

/** The package names the program's own files (not libraries or packages) import. */
export function collectProgramPackageNames(program: Program): ProgramPackageNames {
  const resolved = new Set<string>();
  const unresolved = new Set<string>();
  const deepImports = new Set<string>();
  for (const file of program.getSourceFiles()) {
    if (
      program.isSourceFileDefaultLibrary(file.path) ||
      program.isSourceFileFromExternalLibrary(file) ||
      file.fileName.toLowerCase().includes('/node_modules/')
    ) {
      continue;
    }
    for (const imported of file.imports) {
      const text = moduleNameText(imported);
      if ((imported.parent !== undefined && isSourcePhaseImport(imported.parent)) || isExternalModuleNameRelative(text))
        continue;
      const resolution = program.getResolvedModule(file, text, program.getModeForUsageLocation(file, imported));
      if (resolution !== undefined && resolution.resolvedFileName !== '') {
        if (!resolution.isExternalLibraryImport) continue;
        const name = getResolvedPackageName(program, resolution);
        if (name !== '') {
          resolved.add(name);
          // A subpath of a package without `exports` is found only by searching the package's directory.
          if (parsePackageName(text).rest !== '') {
            const scope = program.getPackageScopeForPath(getDirectoryPath(resolution.resolvedFileName));
            if (scope?.contents !== undefined && scope.contents.exports === undefined)
              deepImports.add(getPackageNameFromTypesPackageName(name));
          }
        }
        continue;
      }
      unresolved.add(text);
    }
  }
  return new ProgramPackageNames(resolved, unresolved, deepImports);
}

function moduleNameText(node: Node): string {
  return getText(node);
}

// The package a resolution reached: its package ID's name, the name in its package.json, or the name in its path.
function getResolvedPackageName(program: Program, resolution: ResolvedModule): string {
  let name = resolution.packageId?.name ?? '';
  if (name === '') {
    const scope = program.getPackageScopeForPath(getDirectoryPath(resolution.resolvedFileName));
    if (scope?.contents !== undefined) name = scope.contents.name.value ?? '';
  }
  if (name === '') name = getPackageNameFromDirectory(resolution.resolvedFileName);
  return name;
}

/**
 * The packages a program uses, without `@types/`: those imports resolved into, those of the `types` option, and the
 * packages declaring the ambient modules unresolved imports name.
 */
export function getResolvedPackageNames(program: Program, checker: Checker, names: ProgramPackageNames): Set<string> {
  const result = new Set<string>();
  for (const name of names.resolved) result.add(getPackageNameFromTypesPackageName(name));
  for (const name of program.options.types ?? [])
    if (name !== '*') result.add(getPackageNameFromTypesPackageName(name));
  for (const name of names.unresolved) {
    const symbol = tryFindAmbientModule(checker, name, true);
    if (symbol === undefined) continue;
    const declaringFile = getSourceFileOfModule(symbol);
    if (declaringFile === undefined) continue;
    const packageName = getPackageNameFromDirectory(declaringFile.fileName);
    if (packageName !== '') result.add(getPackageNameFromTypesPackageName(packageName));
  }
  return result;
}

function getSourceFileOfModule(symbol: Symbol): SourceFile | undefined {
  const declaration = symbol.valueDeclaration ?? getNonAugmentationDeclaration(symbol);
  return declaration === undefined ? undefined : getSourceFileOfNode(declaration);
}

/** A `package.json` as auto-imports read it: missing, unparseable, or its contents. */
export function readPackageJson(fs: FileSystem, fileName: string): PackageJsonInfo {
  const packageDirectory = getDirectoryPath(fileName);
  const text = fs.readFile(fileName);
  if (text === undefined) {
    return { packageDirectory, directoryExists: fs.directoryExists(packageDirectory), contents: undefined };
  }
  return { packageDirectory, directoryExists: true, contents: parsePackageJson(text) };
}

/** Adds a `package.json`'s `dependencies` and `peerDependencies`, without `@types/`. */
export function addPackageJsonDependencies(contents: PackageJson, dependencies: Set<string>): void {
  for (const field of [contents.dependencies, contents.peerDependencies]) {
    if (field.value === undefined) continue;
    for (const name of field.value.keys()) {
      if (name === '' || name === '@types/' || name.startsWith('.')) continue;
      dependencies.add(getPackageNameFromTypesPackageName(name));
    }
  }
}

/** The directories at and above `directory`, innermost first. */
export function ancestorDirectories(directory: string): string[] {
  const result: string[] = [];
  let current = directory;
  for (;;) {
    result.push(current);
    const parent = getDirectoryPath(current);
    if (parent === current) return result;
    current = parent;
  }
}

// A package of a bucket: its package.json and real path, and those of its `@types` package.
class DiscoveredPackage {
  constructor(
    readonly packageName: string,
    readonly packageJson: PackageJsonInfo,
    readonly realpath: string,
    readonly typesPackageJson: PackageJsonInfo | undefined,
    readonly typesRealpath: string,
  ) {}
}

// A file whose module names did not all resolve, so its exports may need ambient modules of other packages.
class FailedAmbientModuleLookupSource {
  packageName = '';
  constructor(readonly fileName: string) {}
}

// What extracting one package gives.
class PackageExtraction {
  readonly packageFiles = new Map<string, string>();
  readonly exports = new Map<string, Export[]>();
  readonly ambientModules = new Map<string, string[]>();
  readonly failedSources = new Map<string, FailedAmbientModuleLookupSource>();
  readonly failedTargets = new Set<string>();
  constructor(public entrypoints: ResolvedEntrypoint[]) {}
}

// A bucket being built.
class BucketTask {
  discovered: DiscoveredPackage[] = [];
  directoryPackageNames = new Set<string>();
  readonly index = new ExportIndex();
  readonly failedSources = new Map<string, FailedAmbientModuleLookupSource>();
  readonly failedTargets = new Set<string>();
  readonly ambientModuleNames = new Map<string, string[]>();
  constructor(
    readonly directoryName: string,
    readonly directoryPath: string,
    readonly dependencies: ReadonlySet<string>,
  ) {}
}

/**
 * The node_modules buckets for `importingFileName`: one for each directory above it with a `node_modules` directory,
 * holding the packages of `resolvedPackageNames` and of the `dependencies` and `peerDependencies` of the
 * `package.json` files in the directories between it and the file. A package without TypeScript entrypoints is
 * offered from its `@types` package. `deepImports` packages are searched for every file in them.
 */
export function buildPackageBuckets(
  host: PackageHost,
  importingFileName: string,
  resolvedPackageNames: ReadonlySet<string>,
  deepImports: ReadonlySet<string>,
): PackageBuckets {
  const directories = new Map<string, PackageDirectory>();
  for (const name of ancestorDirectories(getDirectoryPath(importingFileName))) {
    const packageJson = readPackageJson(host.fs, combinePaths(name, 'package.json'));
    const hasNodeModules = host.fs.directoryExists(combinePaths(name, 'node_modules'));
    directories.set(host.toPath(name), new PackageDirectory(name, packageJson, hasNodeModules));
  }

  // The packages each bucket holds.
  const tasks: BucketTask[] = [];
  for (const [path, directory] of directories) {
    if (!directory.hasNodeModules) continue;
    const dependencies = new Set<string>();
    for (const [otherPath, other] of directories) {
      if (other.packageJson.contents !== undefined && containsPath(path, otherPath, true))
        addPackageJsonDependencies(other.packageJson.contents, dependencies);
    }
    for (const name of resolvedPackageNames) dependencies.add(name);
    tasks.push(new BucketTask(directory.name, path, dependencies));
  }

  // Discovery: each package's package.json and real path.
  for (const task of tasks) {
    task.directoryPackageNames = getPackageNamesInNodeModules(
      host.fs,
      combinePaths(task.directoryName, 'node_modules'),
    );
    task.discovered = discoverBucketPackages(host, task.dependencies, task.directoryName);
  }

  // Extraction, once for each real path. A package without TypeScript entrypoints falls back to its @types package.
  const recursivePackages = new Set(deepImports);
  const seen = new Set<string>();
  const extractions = new Map<string, PackageExtraction>();
  const typesFallbacks: DiscoveredPackage[] = [];
  for (const task of tasks) {
    for (const pkg of task.discovered) {
      if (pkg.realpath !== '') {
        if (!seen.has(pkg.realpath)) {
          seen.add(pkg.realpath);
          const directorySearch =
            recursivePackages.has(pkg.packageName) || knownRecursiveSearchPackages.has(pkg.packageName);
          const extraction = extractPackage(host, pkg.packageJson, pkg.packageName, directorySearch);
          if (extraction !== undefined) extractions.set(pkg.realpath, extraction);
        }
        if (pkg.typesRealpath !== '') typesFallbacks.push(pkg);
      } else if (pkg.typesRealpath !== '' && !seen.has(pkg.typesRealpath)) {
        seen.add(pkg.typesRealpath);
        const extraction = extractPackage(host, pkg.typesPackageJson!, pkg.packageName, true);
        if (extraction !== undefined) extractions.set(pkg.typesRealpath, extraction);
      }
    }
  }
  for (const pkg of typesFallbacks) {
    if (extractions.has(pkg.realpath) || seen.has(pkg.typesRealpath)) continue;
    seen.add(pkg.typesRealpath);
    const extraction = extractPackage(host, pkg.typesPackageJson!, pkg.packageName, true);
    if (extraction !== undefined) extractions.set(pkg.typesRealpath, extraction);
  }

  // Each bucket's index, from the extractions of its packages.
  const entrypoints = new Map<string, ResolvedEntrypoint[]>();
  const nodeModules = new Map<string, NodeModulesBucket>();
  for (const task of tasks) {
    const exports = new Map<string, Export[]>();
    const bucketEntrypoints = new Map<string, ResolvedEntrypoint[]>();
    for (const pkg of task.discovered) {
      const extraction = extractions.get(pkg.realpath) ?? extractions.get(pkg.typesRealpath);
      if (extraction === undefined) continue;
      for (const [path, fileExports] of extraction.exports) exports.set(path, fileExports);
      for (const [name, fileNames] of extraction.ambientModules) {
        const existing = task.ambientModuleNames.get(name);
        if (existing === undefined) task.ambientModuleNames.set(name, [...fileNames]);
        else existing.push(...fileNames);
      }
      for (const entrypoint of extraction.entrypoints) {
        const path = host.toPath(entrypoint.resolvedFileName);
        const existing = bucketEntrypoints.get(path);
        if (existing === undefined) bucketEntrypoints.set(path, [entrypoint]);
        else existing.push(entrypoint);
      }
      for (const [path, source] of extraction.failedSources)
        if (!task.failedSources.has(path)) task.failedSources.set(path, source);
      for (const target of extraction.failedTargets) task.failedTargets.add(target);
    }
    for (const fileExports of exports.values()) for (const exported of fileExports) task.index.insertAsWords(exported);
    // A later bucket's entrypoints of a file replace an earlier one's.
    for (const [path, fileEntrypoints] of bucketEntrypoints) entrypoints.set(path, fileEntrypoints);
    nodeModules.set(
      task.directoryPath,
      new NodeModulesBucket(task.index, task.directoryPackageNames, task.ambientModuleNames),
    );
  }

  // A second pass over the files whose module names did not resolve, with the ambient modules the buckets' packages
  // declare: `export * from "fs"` in one package finds the `fs` module another declares.
  for (const task of tasks) {
    if (task.failedTargets.size === 0) continue;
    const rootFiles = new Map<string, SourceFile>();
    for (const target of task.failedTargets) {
      for (const fileName of resolveAmbientModuleName(host, nodeModules, target, task.directoryPath)) {
        if (rootFiles.has(fileName)) continue;
        const file = host.getSourceFile(fileName);
        if (file !== undefined) {
          bindSourceFile(file);
          rootFiles.set(fileName, file);
        }
      }
    }
    if (rootFiles.size === 0) continue;
    const resolver = packageResolver(host);
    const checker = new Checker(new AliasResolverHost([...rootFiles.values()], host, resolver, () => {}));
    for (const source of task.failedSources.values()) {
      const file = host.getSourceFile(source.fileName);
      if (file === undefined) continue;
      bindSourceFile(file);
      const realpath = (fileName: string): string => normalizePath(host.fs.realpath(fileName));
      const extractor = new ExportExtractor(checker, source.packageName, resolver, (f) => host.toPath(f), realpath);
      for (const exported of extractor.extractFromFile(file)) task.index.insertAsWords(exported);
    }
  }
  return new PackageBuckets(directories, nodeModules, entrypoints);
}

// The files the buckets at and above a directory say declare an ambient module: of the innermost bucket that knows it.
function resolveAmbientModuleName(
  host: PackageHost,
  nodeModules: ReadonlyMap<string, NodeModulesBucket>,
  moduleName: string,
  fromPath: string,
): readonly string[] {
  for (const directory of ancestorDirectories(fromPath)) {
    const fileNames = nodeModules.get(host.toPath(directory))?.ambientModuleNames.get(moduleName);
    if (fileNames !== undefined) return fileNames;
  }
  return [];
}

/** The package names of a `node_modules` directory's directories; `@types/x` as `x`. */
export function getPackageNamesInNodeModules(fs: FileSystem, nodeModulesDirectory: string): Set<string> {
  const names = new Set<string>();
  for (const baseName of fs.getAccessibleEntries(nodeModulesDirectory).directories) {
    if (baseName.startsWith('.')) continue;
    if (baseName.startsWith('@')) {
      for (const scoped of fs.getAccessibleEntries(combinePaths(nodeModulesDirectory, baseName)).directories) {
        const scopedBaseName = getBaseFileName(scoped);
        names.add(
          baseName === '@types'
            ? getPackageNameFromTypesPackageName('@types/' + scopedBaseName)
            : baseName + '/' + scopedBaseName,
        );
      }
      continue;
    }
    names.add(baseName);
  }
  return names;
}

function discoverBucketPackages(
  host: PackageHost,
  packageNames: ReadonlySet<string>,
  directoryName: string,
): DiscoveredPackage[] {
  const result: DiscoveredPackage[] = [];
  const nodeModules = combinePaths(directoryName, 'node_modules');
  for (const packageName of packageNames) {
    const typesPackageName = getTypesPackageName(packageName);
    const packageJson = readPackageJson(host.fs, combinePaths(combinePaths(nodeModules, packageName), 'package.json'));
    let typesPackageJson: PackageJsonInfo | undefined;
    if (packageName !== typesPackageName) {
      const types = readPackageJson(host.fs, combinePaths(combinePaths(nodeModules, typesPackageName), 'package.json'));
      if (types.directoryExists) typesPackageJson = types;
    }
    const realpath = packageJson.directoryExists ? normalizePath(host.fs.realpath(packageJson.packageDirectory)) : '';
    const typesRealpath =
      typesPackageJson !== undefined ? normalizePath(host.fs.realpath(typesPackageJson.packageDirectory)) : '';
    result.push(new DiscoveredPackage(packageName, packageJson, realpath, typesPackageJson, typesRealpath));
  }
  return result;
}

function packageResolver(host: PackageHost): Resolver {
  return new Resolver(new CompilerHost(host.fs, host.currentDirectory, ''), {});
}

// The exports of a package's entrypoints. Undefined for a package without entrypoints.
function extractPackage(
  host: PackageHost,
  packageJson: PackageJsonInfo,
  packageName: string,
  enableDirectorySearch: boolean,
): PackageExtraction | undefined {
  if (!packageJson.directoryExists) return undefined;
  const resolver = packageResolver(host);
  const packageEntrypoints = getEntrypointsFromPackageJsonInfo(
    resolver,
    host.fs,
    packageJson,
    packageName,
    enableDirectorySearch,
  );
  if (packageEntrypoints === undefined || packageEntrypoints.length === 0) return undefined;
  const result = new PackageExtraction(packageEntrypoints);

  const seenFiles = new Set<string>();
  const rootFiles: SourceFile[] = [];
  // The symlink path and file name of each root file found through a symlink, by its real path.
  const symlinks = new Map<string, { path: string; fileName: string }>();
  for (const entrypoint of packageEntrypoints) {
    const fileName = entrypoint.symlinkOrRealpath();
    const realpathFileName = entrypoint.resolvedFileName;
    const realpathPath = host.toPath(realpathFileName);
    if (seenFiles.has(realpathPath)) continue;
    seenFiles.add(realpathPath);
    if (fileName !== realpathFileName) symlinks.set(realpathPath, { path: host.toPath(fileName), fileName });
    const file = host.getSourceFile(realpathFileName);
    if (file !== undefined) {
      bindSourceFile(file);
      rootFiles.push(file);
    }
  }

  const aliasHost = new AliasResolverHost(rootFiles, host, resolver, (source, moduleName) => {
    result.failedTargets.add(moduleName);
    if (!result.failedSources.has(source.path))
      result.failedSources.set(source.path, new FailedAmbientModuleLookupSource(source.fileName));
  });
  const checker = new Checker(aliasHost);
  const realpath = (fileName: string): string => normalizePath(host.fs.realpath(fileName));
  const extractor = new ExportExtractor(checker, packageName, resolver, (f) => host.toPath(f), realpath);

  const nonModuleFiles = new Set<string>();
  for (const entrypoint of rootFiles) {
    const fileExports = extractor.extractFromFile(entrypoint);
    for (const name of entrypoint.ambientModuleNames) {
      const existing = result.ambientModules.get(name);
      if (existing === undefined) result.ambientModules.set(name, [entrypoint.fileName]);
      else existing.push(entrypoint.fileName);
    }
    result.packageFiles.set(entrypoint.path, entrypoint.fileName);
    const symlink = symlinks.get(entrypoint.path);
    if (symlink !== undefined) result.packageFiles.set(symlink.path, symlink.fileName);

    let hasExports = fileExports.length > 0 && entrypoint.externalModuleIndicator !== undefined;
    const source = result.failedSources.get(entrypoint.path);
    if (source === undefined) result.exports.set(entrypoint.path, fileExports);
    else {
      // The file's exports wait for the second pass.
      source.packageName = packageName;
      hasExports = entrypoint.externalModuleIndicator !== undefined;
    }
    if (!hasExports) {
      nonModuleFiles.add(entrypoint.path);
      if (symlink !== undefined) nonModuleFiles.add(symlink.path);
    }
  }
  // Scripts and empty modules are not entrypoints to import.
  result.entrypoints = packageEntrypoints.filter(
    (entrypoint) => !nonModuleFiles.has(host.toPath(entrypoint.resolvedFileName)),
  );
  return result;
}

/**
 * The program a package's checker sees: the package's entrypoints, and the files their module names resolve to,
 * read when the checker asks for them. Every file is an ES module. A module name that does not resolve and is not
 * relative may be an ambient module another package declares, which `onFailedAmbientModuleLookup` records.
 */
class AliasResolverHost extends CheckerHost {
  private readonly resolutions = new Map<string, ResolvedModule>();

  constructor(
    private readonly rootFiles: readonly SourceFile[],
    private readonly host: PackageHost,
    private readonly resolver: Resolver,
    private readonly onFailedAmbientModuleLookup: (source: SourceFile, moduleName: string) => void,
  ) {
    super();
  }

  getCompilerOptions(): CompilerOptions {
    return { noCheck: true };
  }

  getSourceFiles(): readonly SourceFile[] {
    return this.rootFiles;
  }

  isSourceFileDefaultLibrary(_file: SourceFile): boolean {
    return false;
  }

  getResolvedModule(file: SourceFile, moduleName: string, mode: ModuleKind): ResolvedModule | undefined {
    const key = file.path + '\u0000' + moduleName + '\u0000' + mode;
    const cached = this.resolutions.get(key);
    if (cached !== undefined) return cached;
    const resolved = this.resolver.resolveModuleName(moduleName, file.fileName, mode);
    this.resolutions.set(key, resolved);
    if (resolved.resolvedFileName === '' && !isExternalModuleNameRelative(moduleName))
      this.onFailedAmbientModuleLookup(file, moduleName);
    return resolved;
  }

  getSourceFileForResolvedModule(fileName: string): SourceFile | undefined {
    const file = this.host.getSourceFile(fileName);
    if (file !== undefined) bindSourceFile(file);
    return file;
  }

  getModeForUsageLocation(_file: SourceFile, _location: Node): ModuleKind {
    return ModuleKind.ESNext;
  }

  getDefaultResolutionModeForFile(_file: SourceFile): ModuleKind {
    return ModuleKind.ESNext;
  }

  getImpliedNodeFormatForEmit(_file: SourceFile): ModuleKind {
    return ModuleKind.ESNext;
  }

  getEmitSyntaxForUsageLocation(_file: SourceFile, _usage: Node): ModuleKind {
    return ModuleKind.ESNext;
  }

  getEmitModuleFormatOfFile(_file: SourceFile): ModuleKind {
    return ModuleKind.ESNext;
  }
}
