/**
 * Module and type reference resolution for `node16`, `nodenext` and `bundler`.
 *
 * ```ts
 * const resolver = new Resolver(host, options);
 * const traces: MessageWithArgs[] = [];
 * const resolved = resolver.resolveModuleName('pkg', '/app/src/index.ts', ModuleKind.ESNext, undefined, traces);
 * ```
 */

import {
  createDiagnostic,
  Diagnostics,
  messageWithArgs,
  type Diagnostic,
  type DiagnosticMessage,
  type MessageWithArgs,
} from './diagnostics.js';
import {
  ModuleKind,
  ModuleResolutionHost,
  ModuleResolutionKind,
  comparePatternKeys,
  getConditions,
  getEffectiveTypeRoots,
  inferredTypesContainingFile,
  mangleScopedPackageName,
  moduleResolutionKindName,
  packageIdToString,
  parseNodeModuleFromPath,
  parsePackageName,
  type PackageId,
  type ResolutionMode,
  type ResolvedModule,
  type ResolvedProjectReference,
  type ResolvedTypeReferenceDirective,
} from './module-resolution-types.js';
import {
  JsonObjectKind,
  PackageJsonInfoCache,
  isApplicableVersionedTypesKey,
  isFalsyJson,
  parsePackageJson,
  typeScriptVersion,
  withPackageDirectory,
  type Expected,
  type JsonObject,
  type JsonValue,
  type PackageJsonInfo,
  type VersionPaths,
} from './package-json.js';
import { getAllowJS, getModuleResolutionKind, getResolveJsonModule, type CompilerOptions } from './options.js';
import {
  changeExtension,
  combinePaths,
  comparePaths,
  containsPath,
  ensureTrailingDirectorySeparator,
  extensionIsTs,
  fileExtensionIs,
  getBaseFileName,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getPathComponents,
  getPossibleOriginalInputExtensionForExtension,
  getRelativePathFromDirectory,
  getRootLength,
  hasImplementationTSFileExtension,
  hasTrailingDirectorySeparator,
  isDeclarationFileName,
  isExternalModuleNameRelative,
  isRootedDiskPath,
  normalizePath,
  normalizeSlashes,
  pathIsRelative,
  removeExtension,
  removeFileExtension,
  removeTrailingDirectorySeparator,
  removeTrailingDirectorySeparators,
  supportedTSExtensionsWithJsonFlat,
  tryExtractTSExtension,
  tryGetExtensionFromPath,
} from './path.js';

export * from './module-resolution-types.js';

/** File kinds a lookup accepts. */
const enum Extensions {
  TypeScript = 1,
  JavaScript = 2,
  Declaration = 4,
  Json = 8,
  ImplementationFiles = TypeScript | JavaScript,
}

const enum Features {
  None = 0,
  Imports = 1,
  SelfName = 2,
  Exports = 4,
  ExportsPatternTrailers = 8,
  /** `#/` keys in `imports`. */
  ImportsPatternRoot = 16,
  Node16Default = Imports | SelfName | Exports | ExportsPatternTrailers,
  NodeNextDefault = Imports | SelfName | Exports | ExportsPatternTrailers | ImportsPatternRoot,
  BundlerDefault = Imports | SelfName | Exports | ExportsPatternTrailers | ImportsPatternRoot,
}

function extensionsToString(extensions: number): string {
  let result = '';
  if ((extensions & Extensions.TypeScript) !== 0) result = 'TypeScript';
  if ((extensions & Extensions.JavaScript) !== 0) result += result === '' ? 'JavaScript' : ', JavaScript';
  if ((extensions & Extensions.Declaration) !== 0) result += result === '' ? 'Declaration' : ', Declaration';
  if ((extensions & Extensions.Json) !== 0) result += result === '' ? 'JSON' : ', JSON';
  return result;
}

/** Whether `extension` is one of `extensions`. */
function extensionIsOk(extensions: number, extension: string): boolean {
  return (
    ((extensions & Extensions.JavaScript) !== 0 &&
      (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs')) ||
    ((extensions & Extensions.TypeScript) !== 0 &&
      (extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts')) ||
    ((extensions & Extensions.Declaration) !== 0 &&
      (extension === '.d.ts' || extension === '.d.mts' || extension === '.d.cts')) ||
    ((extensions & Extensions.Json) !== 0 && extension === '.json')
  );
}

/**
 * A lookup result. `undefined` means "keep searching"; a result with an empty `path` stops the search unresolved.
 */
interface Resolved {
  path: string;
  extension: string;
  packageId: PackageId | undefined;
  originalPath: string;
  resolvedUsingTsExtension: boolean;
}

function resolvedFile(path: string, extension: string, resolvedUsingTsExtension: boolean): Resolved {
  return { path, extension, packageId: undefined, originalPath: '', resolvedUsingTsExtension };
}

function unresolved(): Resolved {
  return resolvedFile('', '', false);
}

/** A `paths` or `typesVersions` pattern: `text` with an optional `*` at `starIndex`. */
export interface Pattern {
  readonly text: string;
  readonly starIndex: number;
}

export interface ParsedPatterns {
  readonly exact: ReadonlySet<string>;
  readonly patterns: readonly Pattern[];
}

export function parsePatterns(paths: ReadonlyMap<string, readonly string[] | undefined>): ParsedPatterns {
  const exact = new Set<string>();
  const patterns: Pattern[] = [];
  for (const key of paths.keys()) {
    const star = key.indexOf('*');
    if (star === -1) exact.add(key);
    else if (key.indexOf('*', star + 1) === -1) patterns.push({ text: key, starIndex: star });
  }
  return { exact, patterns };
}

function patternMatches(pattern: Pattern, candidate: string): boolean {
  return (
    candidate.length >= pattern.text.length - 1 &&
    candidate.startsWith(pattern.text.slice(0, pattern.starIndex)) &&
    candidate.endsWith(pattern.text.slice(pattern.starIndex + 1))
  );
}

/** The exact key equal to `candidate`, else the matching pattern with the longest prefix. */
export function matchPatternOrExact(parsed: ParsedPatterns, candidate: string): Pattern | undefined {
  if (parsed.exact.has(candidate)) return { text: candidate, starIndex: -1 };
  let best: Pattern | undefined;
  let longestPrefix = -1;
  for (const pattern of parsed.patterns) {
    if (pattern.starIndex > longestPrefix && patternMatches(pattern, candidate)) {
      best = pattern;
      longestPrefix = pattern.starIndex;
    }
  }
  return best;
}

function matchedText(pattern: Pattern, candidate: string): string {
  if (pattern.starIndex === -1) return '';
  return candidate.slice(pattern.starIndex, candidate.length - pattern.text.length + pattern.starIndex + 1);
}

function replaceFirstStar(text: string, replacement: string): string {
  const star = text.indexOf('*');
  return star === -1 ? text : text.slice(0, star) + replacement + text.slice(star + 1);
}

function replaceAllStars(text: string, replacement: string): string {
  let star = text.indexOf('*');
  if (star === -1) return text;
  let result = '';
  let start = 0;
  while (star !== -1) {
    result += text.slice(start, star) + replacement;
    start = star + 1;
    star = text.indexOf('*', start);
  }
  return result + text.slice(start);
}

/** Whether a `/`-separated segment of `path` after `start` is `.`, `..` or `node_modules`. */
function hasInvalidTargetSegment(path: string, start: number): boolean {
  while (start <= path.length) {
    let end = path.indexOf('/', start);
    if (end === -1) end = path.length;
    const length = end - start;
    if (
      (length === 1 && path.charCodeAt(start) === 0x2e) ||
      (length === 2 && path.startsWith('..', start)) ||
      (length === 12 && path.startsWith('node_modules', start))
    ) {
      return true;
    }
    start = end + 1;
  }
  return false;
}

function matchesPatternWithTrailer(target: string, name: string): boolean {
  if (target.endsWith('*')) return false;
  const star = target.indexOf('*');
  if (star === -1) return false;
  return name.startsWith(target.slice(0, star)) && name.endsWith(target.slice(star + 1));
}

/**
 * `.` and `..` at the end of a relative name mean a directory, so they normalize to a trailing `/`.
 */
function normalizePathForCJSResolution(containingDirectory: string, moduleName: string): string {
  const combined = combinePaths(containingDirectory, moduleName);
  const rootLength = getRootLength(combined);
  let end = combined.length;
  if (end > rootLength && combined.charCodeAt(end - 1) === 0x2f) end--;
  let isDotSegment = false;
  if (end > rootLength) {
    const start = Math.max(rootLength, combined.lastIndexOf('/', end - 1) + 1);
    const length = end - start;
    isDotSegment = (length === 1 || length === 2) && combined.startsWith(length === 1 ? '.' : '..', start);
  }
  return isDotSegment ? ensureTrailingDirectorySeparator(normalizePath(combined)) : normalizePath(combined);
}

/** How a `paths`/`typesVersions` substitution is loaded. */
type PathsLoader =
  | { readonly kind: 'relative' }
  | { readonly kind: 'package'; readonly rest: string; readonly packageInfo: PackageJsonInfo | undefined }
  | { readonly kind: 'directory'; readonly packageFile: string; readonly packageInfo: PackageJsonInfo | undefined };

const RELATIVE_LOADER: PathsLoader = { kind: 'relative' };

const NO_DIAGNOSTICS: readonly Diagnostic[] = [];

function unresolvedModule(diagnostics: readonly Diagnostic[]): ResolvedModule {
  return {
    resolvedFileName: '',
    originalPath: '',
    extension: '',
    resolvedUsingTsExtension: false,
    packageId: undefined,
    isExternalLibraryImport: false,
    alternateResult: '',
    resolutionDiagnostics: diagnostics,
  };
}

// The results each resolver shared with other threads (and so immutable) did not have yet when it was
// shared, as this thread resolved them.
const threadModuleCaches = new Map<Resolver, Map<string, ResolvedModule>>();
const threadTypeReferenceCaches = new Map<Resolver, Map<string, ResolvedTypeReferenceDirective>>();

export class Resolver {
  readonly packageJsonInfoCache: PackageJsonInfoCache;
  private readonly moduleCache = new Map<string, ResolvedModule>();
  private readonly typeReferenceCache = new Map<string, ResolvedTypeReferenceDirective>();
  private pathPatterns: ParsedPatterns | undefined;
  private shared = false;

  constructor(
    readonly host: ModuleResolutionHost,
    readonly options: CompilerOptions,
    /** Global typings cache for automatic type acquisition, or `''`. */
    readonly typingsLocation = '',
    readonly projectName = '',
    packageJsonInfoCache?: PackageJsonInfoCache,
  ) {
    this.packageJsonInfoCache =
      packageJsonInfoCache ?? new PackageJsonInfoCache(host.getCurrentDirectory(), host.useCaseSensitiveFileNames());
  }

  /**
   * Called before the resolver is shared with other threads, which makes it immutable
   * (parallel-check.ts): from then on, each thread caches the results and `package.json` lookups the
   * resolver did not have yet in tables of its own. A resolver already shared (by an earlier program of
   * a watch, which a rebuild updates: `Program.updateFile`) is immutable and stays as it is.
   */
  prepareForSharing(): void {
    if (this.shared) return;
    this.getPathPatterns();
    this.packageJsonInfoCache.prepareForSharing();
    this.shared = true;
  }

  private cachedModule(key: string): ResolvedModule | undefined {
    const cached = this.moduleCache.get(key);
    if (cached !== undefined || !this.shared) return cached;
    return threadModuleCaches.get(this)?.get(key);
  }

  private cacheModule(key: string, resolved: ResolvedModule): void {
    if (this.cachedModule(key) !== undefined) return;
    if (!this.shared) {
      this.moduleCache.set(key, resolved);
      return;
    }
    let cache = threadModuleCaches.get(this);
    if (cache === undefined) {
      cache = new Map<string, ResolvedModule>();
      threadModuleCaches.set(this, cache);
    }
    cache.set(key, resolved);
  }

  private cachedTypeReference(key: string): ResolvedTypeReferenceDirective | undefined {
    const cached = this.typeReferenceCache.get(key);
    if (cached !== undefined || !this.shared) return cached;
    return threadTypeReferenceCaches.get(this)?.get(key);
  }

  private cacheTypeReference(key: string, resolved: ResolvedTypeReferenceDirective): void {
    if (!this.shared) {
      this.typeReferenceCache.set(key, resolved);
      return;
    }
    let cache = threadTypeReferenceCaches.get(this);
    if (cache === undefined) {
      cache = new Map<string, ResolvedTypeReferenceDirective>();
      threadTypeReferenceCaches.set(this, cache);
    }
    cache.set(key, resolved);
  }

  /** Parsed `paths` of the resolver's own options. */
  getPathPatterns(): ParsedPatterns {
    if (this.pathPatterns === undefined) this.pathPatterns = parsePatterns(this.options.paths ?? new Map());
    return this.pathPatterns;
  }

  /**
   * Resolves an import specifier. With `traceResolution` set, trace messages are appended to `traces` and the
   * result cache is bypassed.
   */
  resolveModuleName(
    moduleName: string,
    containingFile: string,
    mode: ResolutionMode,
    redirect?: ResolvedProjectReference,
    traces?: MessageWithArgs[],
  ): ResolvedModule {
    const containingDirectory = getDirectoryPath(containingFile);
    const tracer = this.options.traceResolution === true ? (traces ?? []) : undefined;
    const cacheKey = mode + '|' + (redirect?.configName ?? '') + '|' + containingDirectory + '|' + moduleName;
    if (tracer === undefined) {
      const cached = this.cachedModule(cacheKey);
      if (cached !== undefined) return cached;
    }

    const options = optionsWithRedirect(this.options, redirect);
    tracer?.push(messageWithArgs(Diagnostics.Resolving_module_0_from_1, moduleName, containingFile));
    if (tracer !== undefined) traceRedirect(tracer, redirect);

    const kind = getModuleResolutionKind(options);
    tracer?.push(
      options.moduleResolution !== kind
        ? messageWithArgs(Diagnostics.Module_resolution_kind_is_not_specified_using_0, moduleResolutionKindName(kind))
        : messageWithArgs(
            Diagnostics.Explicitly_specified_module_resolution_kind_Colon_0,
            moduleResolutionKindName(kind),
          ),
    );

    const state = new ResolutionState(this, tracer, moduleName, containingDirectory, false, mode, options);
    const result = state.resolveNodeLike();

    if (tracer !== undefined) {
      if (result.resolvedFileName === '') {
        tracer.push(messageWithArgs(Diagnostics.Module_name_0_was_not_resolved, moduleName));
      } else if (result.packageId !== undefined) {
        tracer.push(
          messageWithArgs(
            Diagnostics.Module_name_0_was_successfully_resolved_to_1_with_Package_ID_2,
            moduleName,
            result.resolvedFileName,
            packageIdToString(result.packageId),
          ),
        );
      } else {
        tracer.push(
          messageWithArgs(
            Diagnostics.Module_name_0_was_successfully_resolved_to_1,
            moduleName,
            result.resolvedFileName,
          ),
        );
      }
    }

    const final = this.tryResolveFromTypingsLocation(moduleName, containingDirectory, result, tracer);
    this.cacheModule(cacheKey, final);
    return final;
  }

  /** Resolves a `/// <reference types>` directive or an entry of `types`. */
  resolveTypeReferenceDirective(
    name: string,
    containingFile: string,
    mode: ResolutionMode,
    redirect?: ResolvedProjectReference,
    traces?: MessageWithArgs[],
  ): ResolvedTypeReferenceDirective {
    const containingDirectory = getDirectoryPath(containingFile);
    const tracer = this.options.traceResolution === true ? (traces ?? []) : undefined;
    const fromInferredTypes = containingFile.endsWith(inferredTypesContainingFile);
    const cacheKey =
      mode +
      '|' +
      (fromInferredTypes ? '1' : '0') +
      (redirect?.configName ?? '') +
      '|' +
      containingDirectory +
      '|' +
      name;
    if (tracer === undefined) {
      const cached = this.cachedTypeReference(cacheKey);
      if (cached !== undefined) return cached;
    }

    const options = optionsWithRedirect(this.options, redirect);
    const typeRoots = getEffectiveTypeRoots(options, this.host.getCurrentDirectory());
    const fromConfig = options.typeRoots !== undefined;
    if (tracer !== undefined) {
      tracer.push(
        messageWithArgs(
          Diagnostics.Resolving_type_reference_directive_0_containing_file_1_root_directory_2,
          name,
          containingFile,
          typeRoots.join(','),
        ),
      );
      traceRedirect(tracer, redirect);
    }

    const state = new ResolutionState(this, tracer, name, containingDirectory, true, mode, options);
    const result = state.resolveTypeReferenceDirective(typeRoots, fromConfig, fromInferredTypes);

    if (tracer !== undefined) {
      if (result.resolvedFileName === '') {
        tracer.push(messageWithArgs(Diagnostics.Type_reference_directive_0_was_not_resolved, name));
      } else if (result.packageId !== undefined) {
        tracer.push(
          messageWithArgs(
            Diagnostics.Type_reference_directive_0_was_successfully_resolved_to_1_with_Package_ID_2_primary_Colon_3,
            name,
            result.resolvedFileName,
            packageIdToString(result.packageId),
            String(result.primary),
          ),
        );
      } else {
        tracer.push(
          messageWithArgs(
            Diagnostics.Type_reference_directive_0_was_successfully_resolved_to_1_primary_Colon_2,
            name,
            result.resolvedFileName,
            String(result.primary),
          ),
        );
      }
    }

    this.cacheTypeReference(cacheKey, result);
    return result;
  }

  /** Finds the directory of package `moduleName` in the nearest `node_modules`, without loading files. */
  resolvePackageDirectory(
    moduleName: string,
    containingFile: string,
    mode: ResolutionMode,
    redirect?: ResolvedProjectReference,
  ): ResolvedModule | undefined {
    const options = optionsWithRedirect(this.options, redirect);
    const state = new ResolutionState(
      this,
      undefined,
      moduleName,
      getDirectoryPath(containingFile),
      false,
      mode,
      options,
    );
    state.resolvePackageDirectoryOnly = true;
    const result = state.loadModuleFromNearestNodeModulesDirectory(false);
    if (result !== undefined && result.path !== '') return state.createResolvedModuleHandlingSymlink(result);
    return undefined;
  }

  /** The nearest `package.json` at or above `directory`. */
  getPackageScopeForPath(directory: string): PackageJsonInfo | undefined {
    const state = new ResolutionState(this, undefined, '', directory, false, ModuleKind.None, this.options);
    return state.getPackageScopeForPath(directory);
  }

  /** Resolves an `extends` specifier of a tsconfig file. */
  resolveConfig(moduleName: string, containingFile: string): ResolvedModule {
    const state = new ResolutionState(
      this,
      undefined,
      moduleName,
      getDirectoryPath(containingFile),
      false,
      ModuleKind.CommonJS,
      this.options,
    );
    state.isConfigLookup = true;
    state.extensions = Extensions.Json;
    return state.resolveNodeLike();
  }

  private tryResolveFromTypingsLocation(
    moduleName: string,
    containingDirectory: string,
    original: ResolvedModule,
    tracer: MessageWithArgs[] | undefined,
  ): ResolvedModule {
    if (
      this.typingsLocation === '' ||
      isExternalModuleNameRelative(moduleName) ||
      (original.resolvedFileName !== '' && supportedTSExtensionsWithJsonFlat.includes(original.extension))
    ) {
      return original;
    }
    const state = new ResolutionState(
      this,
      tracer,
      moduleName,
      containingDirectory,
      false,
      ModuleKind.None,
      this.options,
    );
    tracer?.push(
      messageWithArgs(
        Diagnostics.Auto_discovery_for_typings_is_enabled_in_project_0_Running_extra_resolution_pass_for_module_1_using_cache_location_2,
        this.projectName,
        moduleName,
        this.typingsLocation,
      ),
    );
    const global = state.loadModuleFromImmediateNodeModulesDirectory(
      Extensions.Declaration,
      this.typingsLocation,
      false,
    );
    if (global === undefined) return original;
    const result = state.createResolvedModule(global, true);
    result.resolutionDiagnostics = original.resolutionDiagnostics.concat(result.resolutionDiagnostics);
    return result;
  }
}

function optionsWithRedirect(
  options: CompilerOptions,
  redirect: ResolvedProjectReference | undefined,
): CompilerOptions {
  return redirect?.options ?? options;
}

function traceRedirect(tracer: MessageWithArgs[], redirect: ResolvedProjectReference | undefined): void {
  if (redirect !== undefined && redirect.options !== undefined) {
    tracer.push(
      messageWithArgs(Diagnostics.Using_compiler_options_of_project_reference_redirect_0, redirect.configName),
    );
  }
}

/** Resolves an `extends` specifier of a tsconfig file with `nodenext` rules. */
export function resolveConfig(moduleName: string, containingFile: string, host: ModuleResolutionHost): ResolvedModule {
  return new Resolver(host, { moduleResolution: ModuleResolutionKind.NodeNext }).resolveConfig(
    moduleName,
    containingFile,
  );
}

/** The `types` entries to include automatically, expanding `*` to every package in the type roots. */
export function getAutomaticTypeDirectiveNames(options: CompilerOptions, host: ModuleResolutionHost): string[] {
  const types = options.types ?? [];
  if (!types.includes('*')) return types.slice();
  const wildcardMatches: string[] = [];
  for (const root of getEffectiveTypeRoots(options, host.getCurrentDirectory())) {
    if (!host.directoryExists(root)) continue;
    for (const directory of host.getDirectories(root)) {
      const normalized = normalizePath(directory);
      const packageJsonPath = combinePaths(combinePaths(root, normalized), 'package.json');
      // types-publisher writes `"typings": null` for packages that ship their own types.
      let isNotNeeded = false;
      if (host.fileExists(packageJsonPath)) {
        isNotNeeded = parsePackageJson(host.readFile(packageJsonPath) ?? '').typings.isNull;
      }
      if (isNotNeeded) continue;
      const base = getBaseFileName(normalized);
      if (!base.startsWith('.')) wildcardMatches.push(base);
    }
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    if (type === '*') {
      for (const match of wildcardMatches) {
        if (!seen.has(match)) {
          seen.add(match);
          result.push(match);
        }
      }
    } else if (!seen.has(type)) {
      seen.add(type);
      result.push(type);
    }
  }
  return result;
}

/** One resolution request: the name being resolved plus the knobs that change along the way. */
class ResolutionState {
  readonly host: ModuleResolutionHost;
  isConfigLookup = false;
  features: number = Features.None;
  esmMode = false;
  conditions: readonly string[] = [];
  extensions: number;
  resolvePackageDirectoryOnly = false;
  /**
   * Set while the candidate's extension comes from configuration (package.json, `paths`, wildcard
   * substitutions) rather than the specifier, which suppresses `resolvedUsingTsExtension`.
   */
  candidateEndingIsFromConfig = false;
  resolvedPackageDirectory = false;
  diagnostics: Diagnostic[] = [];
  private pathPatterns: ParsedPatterns | undefined;

  constructor(
    readonly resolver: Resolver,
    readonly traces: MessageWithArgs[] | undefined,
    public name: string,
    public containingDirectory: string,
    isTypeReferenceDirective: boolean,
    mode: ResolutionMode,
    readonly options: CompilerOptions,
  ) {
    this.host = resolver.host;
    if (isTypeReferenceDirective) this.extensions = Extensions.Declaration;
    else if (options.noDtsResolution === true) this.extensions = Extensions.ImplementationFiles;
    else this.extensions = Extensions.TypeScript | Extensions.JavaScript | Extensions.Declaration;
    if (!isTypeReferenceDirective && getResolveJsonModule(options)) this.extensions |= Extensions.Json;

    switch (getModuleResolutionKind(options)) {
      case ModuleResolutionKind.Node16:
        this.features = Features.Node16Default;
        this.esmMode = mode === ModuleKind.ESNext;
        this.conditions = getConditions(options, mode);
        break;
      case ModuleResolutionKind.NodeNext:
        this.features = Features.NodeNextDefault;
        this.esmMode = mode === ModuleKind.ESNext;
        this.conditions = getConditions(options, mode);
        break;
      case ModuleResolutionKind.Bundler:
        this.features = bundlerFeatures(options);
        this.conditions = getConditions(options, mode);
        break;
    }
  }

  private trace(message: DiagnosticMessage, ...args: string[]): void {
    this.traces?.push({ message, args });
  }

  //// Type reference directives

  resolveTypeReferenceDirective(
    typeRoots: readonly string[],
    fromConfig: boolean,
    fromInferredTypes: boolean,
  ): ResolvedTypeReferenceDirective {
    const traces = this.traces;
    if (typeRoots.length > 0) {
      if (traces !== undefined) this.trace(Diagnostics.Resolving_with_primary_search_path_0, typeRoots.join(', '));
      for (const typeRoot of typeRoots) {
        const candidate = this.getCandidateFromTypeRoot(typeRoot);
        if (!this.host.directoryExists(typeRoot)) {
          if (traces !== undefined)
            this.trace(Diagnostics.Directory_0_does_not_exist_skipping_all_lookups_in_it, typeRoot);
          continue;
        }
        if (fromConfig) {
          // Configured type roots resolve as files or directories, like modules.
          const fromFile = this.loadModuleFromFile(Extensions.Declaration, candidate);
          if (fromFile !== undefined) {
            this.setPackageIdFromNodeModulesPath(fromFile);
            return this.createResolvedTypeReferenceDirective(fromFile, true);
          }
        }
        const fromDirectory = this.loadNodeModuleFromDirectory(Extensions.Declaration, candidate, true);
        if (fromDirectory !== undefined) return this.createResolvedTypeReferenceDirective(fromDirectory, true);
      }
    } else if (traces !== undefined) {
      this.trace(Diagnostics.Root_directory_cannot_be_determined_skipping_primary_search_paths);
    }

    let resolved: Resolved | undefined;
    if (!fromConfig || !fromInferredTypes) {
      if (traces !== undefined)
        this.trace(Diagnostics.Looking_up_in_node_modules_folder_initial_location_0, this.containingDirectory);
      if (!isExternalModuleNameRelative(this.name)) {
        resolved = this.loadModuleFromNearestNodeModulesDirectory(false);
      } else {
        const candidate = normalizePathForCJSResolution(this.containingDirectory, this.name);
        resolved = this.nodeLoadModuleByRelativeName(Extensions.Declaration, candidate, true);
      }
    } else if (traces !== undefined) {
      this.trace(
        Diagnostics.Resolving_type_reference_directive_for_program_that_specifies_custom_typeRoots_skipping_lookup_in_node_modules_folder,
      );
    }
    return this.createResolvedTypeReferenceDirective(resolved, false);
  }

  private setPackageIdFromNodeModulesPath(resolved: Resolved): void {
    const packageDirectory = parseNodeModuleFromPath(resolved.path, false);
    if (packageDirectory !== '') {
      resolved.packageId = this.getPackageId(resolved.path, this.getPackageJsonInfo(packageDirectory));
    }
  }

  private getCandidateFromTypeRoot(typeRoot: string): string {
    const name =
      typeRoot.endsWith('/node_modules/@types') || typeRoot.endsWith('/node_modules/@types/')
        ? this.mangleScopedPackageName(this.name)
        : this.name;
    return combinePaths(typeRoot, name);
  }

  private mangleScopedPackageName(name: string): string {
    const mangled = mangleScopedPackageName(name);
    if (this.traces !== undefined && mangled !== name)
      this.trace(Diagnostics.Scoped_package_detected_looking_in_0, mangled);
    return mangled;
  }

  /** Falls back to configured `typeRoots` for declaration lookups of bare names. */
  private resolveFromTypeRoot(): Resolved | undefined {
    const typeRoots = this.options.typeRoots;
    if (typeRoots === undefined) return undefined;
    for (const typeRoot of typeRoots) {
      const candidate = this.getCandidateFromTypeRoot(typeRoot);
      if (!this.host.directoryExists(typeRoot)) {
        if (this.traces !== undefined)
          this.trace(Diagnostics.Directory_0_does_not_exist_skipping_all_lookups_in_it, typeRoot);
        continue;
      }
      const fromFile = this.loadModuleFromFile(Extensions.Declaration, candidate);
      if (fromFile !== undefined) {
        this.setPackageIdFromNodeModulesPath(fromFile);
        return fromFile;
      }
      const fromDirectory = this.loadNodeModuleFromDirectory(Extensions.Declaration, candidate, true);
      if (fromDirectory !== undefined) return fromDirectory;
    }
    return undefined;
  }

  getPackageScopeForPath(directory: string): PackageJsonInfo | undefined {
    const stop = this.resolver.typingsLocation;
    for (;;) {
      const result = this.getPackageJsonInfo(directory);
      if (result !== undefined || directory === stop) return result;
      const parent = getDirectoryPath(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }

  //// Module names

  resolveNodeLike(): ResolvedModule {
    if (this.traces !== undefined) {
      const conditions = this.conditions.map((c) => "'" + c + "'").join(', ');
      this.trace(Diagnostics.Resolving_in_0_mode_with_conditions_1, this.esmMode ? 'ESM' : 'CJS', conditions);
    }
    const result = this.resolveNodeLikeWorker();
    if (
      this.resolvedPackageDirectory &&
      !this.isConfigLookup &&
      (this.features & Features.Exports) !== 0 &&
      (this.extensions & (Extensions.TypeScript | Extensions.Declaration)) !== 0 &&
      !isExternalModuleNameRelative(this.name) &&
      result.resolvedFileName !== '' &&
      result.isExternalLibraryImport &&
      !extensionIsOk(Extensions.TypeScript | Extensions.Declaration, result.extension) &&
      this.conditions.includes('import')
    ) {
      // Find out whether the package would resolve to types without `exports`, to suggest a fix.
      if (this.traces !== undefined) {
        this.trace(
          Diagnostics.Resolution_of_non_relative_name_failed_trying_with_modern_Node_resolution_features_disabled_to_see_if_npm_library_needs_configuration_update,
        );
      }
      this.features &= ~Features.Exports;
      this.extensions &= Extensions.TypeScript | Extensions.Declaration;
      const diagnosticsCount = this.diagnostics.length;
      const alternate = this.resolveNodeLikeWorker();
      if (alternate.resolvedFileName !== '' && alternate.isExternalLibraryImport) {
        result.alternateResult = alternate.resolvedFileName;
      }
      // Results share the array, so truncate a copy.
      if (this.diagnostics.length !== diagnosticsCount) this.diagnostics = this.diagnostics.slice(0, diagnosticsCount);
    }
    return result;
  }

  private resolveNodeLikeWorker(): ResolvedModule {
    const fromSettings = this.tryLoadModuleUsingOptionalResolutionSettings();
    if (fromSettings !== undefined) return this.createResolvedModuleHandlingSymlink(fromSettings);

    if (isExternalModuleNameRelative(this.name)) {
      const candidate = normalizePathForCJSResolution(this.containingDirectory, this.name);
      const resolved = this.nodeLoadModuleByRelativeName(this.extensions, candidate, true);
      return this.createResolvedModule(resolved, resolved !== undefined && resolved.path.includes('/node_modules/'));
    }

    if ((this.features & Features.Imports) !== 0 && this.name.startsWith('#')) {
      const resolved = this.loadModuleFromImports();
      if (resolved !== undefined) return this.createResolvedModuleHandlingSymlink(resolved);
    }
    if ((this.features & Features.SelfName) !== 0) {
      const resolved = this.loadModuleFromSelfNameReference();
      if (resolved !== undefined) return this.createResolvedModuleHandlingSymlink(resolved);
    }
    if (this.name.includes(':')) {
      if (this.traces !== undefined) {
        this.trace(
          Diagnostics.Skipping_module_0_that_looks_like_an_absolute_URI_target_file_types_Colon_1,
          this.name,
          extensionsToString(this.extensions),
        );
      }
      return this.createResolvedModule(undefined, false);
    }
    if (this.traces !== undefined) {
      this.trace(
        Diagnostics.Loading_module_0_from_node_modules_folder_target_file_types_Colon_1,
        this.name,
        extensionsToString(this.extensions),
      );
    }
    const fromNodeModules = this.loadModuleFromNearestNodeModulesDirectory(false);
    if (fromNodeModules !== undefined) return this.createResolvedModuleHandlingSymlink(fromNodeModules);
    if ((this.extensions & Extensions.Declaration) !== 0) {
      const fromTypeRoot = this.resolveFromTypeRoot();
      if (fromTypeRoot !== undefined) return this.createResolvedModuleHandlingSymlink(fromTypeRoot);
    }
    return this.createResolvedModule(undefined, false);
  }

  private loadModuleFromSelfNameReference(): Resolved | undefined {
    const directory = getNormalizedAbsolutePath(this.containingDirectory, this.host.getCurrentDirectory());
    const scope = this.getPackageScopeForPath(directory);
    const contents = scope?.contents;
    if (scope === undefined || contents === undefined || isFalsyJson(contents.exports)) return undefined;
    const name = contents.name.value;
    if (name === undefined) return undefined;
    // Cheap rejection before the component-wise comparison.
    if (
      !this.name.includes('\\') &&
      !name.includes('\\') &&
      !this.name.startsWith(removeTrailingDirectorySeparators(name))
    ) {
      return undefined;
    }
    const parts = getPathComponents(this.name);
    const nameParts = getPathComponents(name);
    if (parts.length < nameParts.length) return undefined;
    for (let i = 0; i < nameParts.length; i++) if (parts[i] !== nameParts[i]) return undefined;
    let subpath = '.';
    for (let i = nameParts.length; i < parts.length; i++) subpath = combinePaths(subpath, parts[i]);
    // Two passes keep @types packages higher in the tree ahead of untyped implementations, as in
    // node_modules lookups. With allowJs, one pass lets self-names map back to input JS files.
    if (getAllowJS(this.options) && !this.containingDirectory.includes('/node_modules/')) {
      return this.loadModuleFromExports(scope, this.extensions, subpath);
    }
    const priority = this.extensions & (Extensions.TypeScript | Extensions.Declaration);
    const secondary = this.extensions & ~(Extensions.TypeScript | Extensions.Declaration);
    return (
      this.loadModuleFromExports(scope, priority, subpath) ?? this.loadModuleFromExports(scope, secondary, subpath)
    );
  }

  private loadModuleFromImports(): Resolved | undefined {
    if (this.name === '#' || (this.name.startsWith('#/') && (this.features & Features.ImportsPatternRoot) === 0)) {
      if (this.traces !== undefined)
        this.trace(Diagnostics.Invalid_import_specifier_0_has_no_possible_resolutions, this.name);
      return undefined;
    }
    const directory = getNormalizedAbsolutePath(this.containingDirectory, this.host.getCurrentDirectory());
    const scope = this.getPackageScopeForPath(directory);
    const contents = scope?.contents;
    if (scope === undefined || contents === undefined) {
      if (this.traces !== undefined) {
        this.trace(Diagnostics.Directory_0_has_no_containing_package_json_scope_Imports_will_not_resolve, directory);
      }
      return undefined;
    }
    const imports = contents.imports;
    if (imports === undefined || imports.type !== 'object') {
      if (this.traces !== undefined)
        this.trace(Diagnostics.X_package_json_scope_0_has_no_imports_defined, scope.packageDirectory);
      return undefined;
    }
    const result = this.loadModuleFromExportsOrImports(this.extensions, this.name, imports, scope, true);
    if (result !== undefined) return result;
    if (this.traces !== undefined) {
      this.trace(
        Diagnostics.Import_specifier_0_does_not_exist_in_package_json_scope_at_path_1,
        this.name,
        scope.packageDirectory,
      );
    }
    return undefined;
  }

  private loadModuleFromExports(scope: PackageJsonInfo, extensions: number, subpath: string): Resolved | undefined {
    const exports = scope.contents?.exports;
    if (exports === undefined || isFalsyJson(exports)) return undefined;
    if (subpath === '.') {
      let mainExport: JsonValue | undefined;
      if (exports.type === 'string' || exports.type === 'array') mainExport = exports;
      else if (exports.type === 'object') {
        mainExport = exports.kind === JsonObjectKind.Conditions ? exports : exports.entries.get('.');
      }
      if (mainExport !== undefined) {
        return this.loadModuleFromTargetExportOrImport(extensions, subpath, scope, false, mainExport, '', false, '.');
      }
    } else if (exports.type === 'object' && exports.kind === JsonObjectKind.Subpaths) {
      const result = this.loadModuleFromExportsOrImports(extensions, subpath, exports, scope, false);
      if (result !== undefined) return result;
    }
    if (this.traces !== undefined) {
      this.trace(
        Diagnostics.Export_specifier_0_does_not_exist_in_package_json_scope_at_path_1,
        subpath,
        scope.packageDirectory,
      );
    }
    return undefined;
  }

  private loadModuleFromExportsOrImports(
    extensions: number,
    moduleName: string,
    lookupTable: JsonObject,
    scope: PackageJsonInfo,
    isImports: boolean,
  ): Resolved | undefined {
    const entries = lookupTable.entries;
    if (!moduleName.endsWith('/') && !moduleName.includes('*')) {
      const target = entries.get(moduleName);
      if (target !== undefined) {
        return this.loadModuleFromTargetExportOrImport(
          extensions,
          moduleName,
          scope,
          isImports,
          target,
          '',
          false,
          moduleName,
        );
      }
    }
    const expandingKeys: string[] = [];
    for (const key of entries.keys()) {
      const star = key.indexOf('*');
      if ((star !== -1 && key.indexOf('*', star + 1) === -1) || key.endsWith('/')) expandingKeys.push(key);
    }
    expandingKeys.sort(comparePatternKeys);
    for (const key of expandingKeys) {
      const target = entries.get(key);
      if (target === undefined) continue;
      if ((this.features & Features.ExportsPatternTrailers) !== 0 && matchesPatternWithTrailer(key, moduleName)) {
        const star = key.indexOf('*');
        const subpath = moduleName.slice(star, moduleName.length - (key.length - 1 - star));
        return this.loadModuleFromTargetExportOrImport(
          extensions,
          moduleName,
          scope,
          isImports,
          target,
          subpath,
          true,
          key,
        );
      }
      if (key.endsWith('*') && moduleName.startsWith(key.slice(0, -1))) {
        const subpath = moduleName.slice(key.length - 1);
        return this.loadModuleFromTargetExportOrImport(
          extensions,
          moduleName,
          scope,
          isImports,
          target,
          subpath,
          true,
          key,
        );
      }
      if (moduleName.startsWith(key)) {
        const subpath = moduleName.slice(key.length);
        return this.loadModuleFromTargetExportOrImport(
          extensions,
          moduleName,
          scope,
          isImports,
          target,
          subpath,
          false,
          key,
        );
      }
    }
    return undefined;
  }

  private invalidTarget(scope: PackageJsonInfo, moduleName: string): undefined {
    if (this.traces !== undefined) {
      this.trace(
        Diagnostics.X_package_json_scope_0_has_invalid_type_for_target_of_specifier_1,
        scope.packageDirectory,
        moduleName,
      );
    }
    return undefined;
  }

  private loadModuleFromTargetExportOrImport(
    extensions: number,
    moduleName: string,
    scope: PackageJsonInfo,
    isImports: boolean,
    target: JsonValue,
    subpath: string,
    isPattern: boolean,
    key: string,
  ): Resolved | undefined {
    const traces = this.traces;
    switch (target.type) {
      case 'string': {
        const targetString = target.value;
        const normalizedTarget = normalizeSlashes(targetString);
        if (!isPattern && subpath.length > 0 && !targetString.endsWith('/'))
          return this.invalidTarget(scope, moduleName);
        if (!targetString.startsWith('./')) {
          if (
            isImports &&
            !targetString.startsWith('../') &&
            !targetString.startsWith('/') &&
            !isRootedDiskPath(targetString)
          ) {
            return this.resolveImportsTargetAsModule(targetString, subpath, isPattern, scope, key);
          }
          return this.invalidTarget(scope, moduleName);
        }
        if (hasInvalidTargetSegment(normalizedTarget, 2)) return this.invalidTarget(scope, moduleName);
        const resolvedTarget = combinePaths(scope.packageDirectory, targetString);
        const normalizedSubpath = normalizeSlashes(subpath);
        if (hasInvalidTargetSegment(normalizedSubpath, getRootLength(normalizedSubpath))) {
          return this.invalidTarget(scope, moduleName);
        }
        if (traces !== undefined) {
          this.trace(
            Diagnostics.Using_0_subpath_1_with_target_2,
            isImports ? 'imports' : 'exports',
            key,
            isPattern ? replaceAllStars(targetString, subpath) : targetString + subpath,
          );
        }
        const finalPath = getNormalizedAbsolutePath(
          isPattern ? replaceAllStars(resolvedTarget, subpath) : resolvedTarget + subpath,
          this.host.getCurrentDirectory(),
        );
        const inputLink = this.tryLoadInputFileForPath(
          finalPath,
          subpath,
          combinePaths(scope.packageDirectory, 'package.json'),
          isImports,
        );
        if (inputLink !== undefined) {
          inputLink.packageId = this.getPackageId(inputLink.path, scope);
          return inputLink;
        }
        const result = this.loadFileNameFromPackageJsonField(extensions, finalPath, targetString);
        if (result !== undefined) {
          result.packageId = this.getPackageId(result.path, scope);
          return result;
        }
        return undefined;
      }
      case 'object': {
        if (traces !== undefined) this.trace(Diagnostics.Entering_conditional_exports);
        for (const [condition, subTarget] of target.entries) {
          if (!this.conditionMatches(condition)) {
            if (traces !== undefined) this.trace(Diagnostics.Saw_non_matching_condition_0, condition);
            continue;
          }
          if (traces !== undefined)
            this.trace(Diagnostics.Matched_0_condition_1, isImports ? 'imports' : 'exports', condition);
          const result = this.loadModuleFromTargetExportOrImport(
            extensions,
            moduleName,
            scope,
            isImports,
            subTarget,
            subpath,
            isPattern,
            key,
          );
          if (result !== undefined) {
            if (traces !== undefined) {
              if (result.path !== '') this.trace(Diagnostics.Resolved_under_condition_0, condition);
              this.trace(Diagnostics.Exiting_conditional_exports);
            }
            return result;
          }
          if (traces !== undefined) this.trace(Diagnostics.Failed_to_resolve_under_condition_0, condition);
        }
        if (traces !== undefined) this.trace(Diagnostics.Exiting_conditional_exports);
        return undefined;
      }
      case 'array':
        if (target.items.length === 0) return this.invalidTarget(scope, moduleName);
        for (const item of target.items) {
          const result = this.loadModuleFromTargetExportOrImport(
            extensions,
            moduleName,
            scope,
            isImports,
            item,
            subpath,
            isPattern,
            key,
          );
          if (result !== undefined) return result;
        }
        return this.invalidTarget(scope, moduleName);
      case 'null':
        if (traces !== undefined) {
          this.trace(
            Diagnostics.X_package_json_scope_0_explicitly_maps_specifier_1_to_null,
            scope.packageDirectory,
            moduleName,
          );
        }
        return unresolved();
      default:
        return this.invalidTarget(scope, moduleName);
    }
  }

  /** An `imports` target naming a package resolves as a module from the scope's directory. */
  private resolveImportsTargetAsModule(
    targetString: string,
    subpath: string,
    isPattern: boolean,
    scope: PackageJsonInfo,
    key: string,
  ): Resolved | undefined {
    const combinedLookup = isPattern ? replaceAllStars(targetString, subpath) : targetString + subpath;
    const scopeDirectory = ensureTrailingDirectorySeparator(scope.packageDirectory);
    if (this.traces !== undefined) {
      this.trace(Diagnostics.Using_0_subpath_1_with_target_2, 'imports', key, combinedLookup);
      this.trace(Diagnostics.Resolving_module_0_from_1, combinedLookup, scopeDirectory);
    }
    const name = this.name;
    const containingDirectory = this.containingDirectory;
    this.name = combinedLookup;
    this.containingDirectory = scopeDirectory;
    const result = this.resolveNodeLike();
    this.name = name;
    this.containingDirectory = containingDirectory;
    if (result.resolvedFileName === '') return undefined;
    return {
      path: result.resolvedFileName,
      extension: result.extension,
      packageId: result.packageId,
      originalPath: result.originalPath,
      resolvedUsingTsExtension: result.resolvedUsingTsExtension,
    };
  }

  /** Maps a path into `outDir`/`declarationDir` back to the input file, so self-names work before a build. */
  private tryLoadInputFileForPath(
    finalPath: string,
    entry: string,
    packagePath: string,
    isImports: boolean,
  ): Resolved | undefined {
    const options = this.options;
    const outDir = options.outDir ?? '';
    const declarationDir = options.declarationDir ?? '';
    const configFilePath = options.configFilePath ?? '';
    const caseSensitive = this.host.useCaseSensitiveFileNames();
    const currentDirectory = this.host.getCurrentDirectory();
    if (
      this.isConfigLookup ||
      (declarationDir === '' && outDir === '') ||
      finalPath.includes('/node_modules/') ||
      (configFilePath !== '' &&
        !containsPath(getDirectoryPath(packagePath), configFilePath, caseSensitive, currentDirectory))
    ) {
      return undefined;
    }

    // Unlike tsc 5.x, no guessing: the root comes from `rootDir` or the config file location.
    let rootDir: string;
    if (options.rootDir !== undefined && options.rootDir !== '') {
      rootDir = options.rootDir;
    } else if (configFilePath !== '') {
      rootDir = getDirectoryPath(configFilePath);
    } else {
      this.diagnostics.push(
        createDiagnostic(
          undefined,
          0,
          0,
          isImports
            ? Diagnostics.The_project_root_is_ambiguous_but_is_required_to_resolve_import_map_entry_0_in_file_1_Supply_the_rootDir_compiler_option_to_disambiguate
            : Diagnostics.The_project_root_is_ambiguous_but_is_required_to_resolve_export_map_entry_0_in_file_1_Supply_the_rootDir_compiler_option_to_disambiguate,
          entry === '' ? '.' : entry,
          packagePath,
        ),
      );
      return unresolved();
    }

    // Output paths in a config are relative to the current directory; otherwise to the root.
    const base = configFilePath !== '' ? currentDirectory : rootDir;
    const candidateDirectories: string[] = [];
    if (declarationDir !== '') {
      candidateDirectories.push(getNormalizedAbsolutePath(combinePaths(base, declarationDir), currentDirectory));
    }
    if (outDir !== '' && outDir !== declarationDir) {
      candidateDirectories.push(getNormalizedAbsolutePath(combinePaths(base, outDir), currentDirectory));
    }
    for (const candidateDirectory of candidateDirectories) {
      if (!containsPath(candidateDirectory, finalPath, caseSensitive, currentDirectory)) continue;
      const fragment =
        finalPath.length > candidateDirectory.length ? finalPath.slice(candidateDirectory.length + 1) : '';
      const possibleInputBase = combinePaths(rootDir, fragment);
      for (const ext of OUTPUT_EXTENSIONS) {
        if (!fileExtensionIs(possibleInputBase, ext)) continue;
        for (const inputExt of getPossibleOriginalInputExtensionForExtension(possibleInputBase)) {
          if (!extensionIsOk(this.extensions, inputExt)) continue;
          const input = changeExtension(possibleInputBase, inputExt);
          if (this.host.fileExists(input)) {
            const resolved = this.loadFileNameFromPackageJsonField(this.extensions, input, '');
            if (resolved !== undefined) return resolved;
          }
        }
      }
    }
    return undefined;
  }

  //// node_modules

  loadModuleFromNearestNodeModulesDirectory(typesScopeOnly: boolean): Resolved | undefined {
    // First TS/DTS in implementation packages and @types in every ancestor, then JS in every ancestor.
    const priority = this.extensions & (Extensions.TypeScript | Extensions.Declaration);
    const secondary = this.extensions & ~(Extensions.TypeScript | Extensions.Declaration);
    if (priority !== 0) {
      if (this.traces !== undefined) {
        this.trace(
          Diagnostics.Searching_all_ancestor_node_modules_directories_for_preferred_extensions_Colon_0,
          extensionsToString(priority),
        );
      }
      const result = this.loadModuleFromAncestorNodeModules(priority, typesScopeOnly);
      if (result !== undefined) return result;
    }
    if (secondary !== 0 && !typesScopeOnly) {
      if (this.traces !== undefined) {
        this.trace(
          Diagnostics.Searching_all_ancestor_node_modules_directories_for_fallback_extensions_Colon_0,
          extensionsToString(secondary),
        );
      }
      return this.loadModuleFromAncestorNodeModules(secondary, typesScopeOnly);
    }
    return undefined;
  }

  private loadModuleFromAncestorNodeModules(extensions: number, typesScopeOnly: boolean): Resolved | undefined {
    let directory = this.containingDirectory;
    for (;;) {
      if (getBaseFileName(directory) !== 'node_modules') {
        const result = this.loadModuleFromImmediateNodeModulesDirectory(extensions, directory, typesScopeOnly);
        if (result !== undefined) return result;
      }
      const parent = getDirectoryPath(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }

  loadModuleFromImmediateNodeModulesDirectory(
    extensions: number,
    directory: string,
    typesScopeOnly: boolean,
  ): Resolved | undefined {
    const nodeModules = combinePaths(directory, 'node_modules');
    if (!this.host.directoryExists(nodeModules)) {
      if (this.traces !== undefined)
        this.trace(Diagnostics.Directory_0_does_not_exist_skipping_all_lookups_in_it, nodeModules);
      return undefined;
    }
    if (!typesScopeOnly) {
      const result = this.loadModuleFromSpecificNodeModulesDirectory(extensions, this.name, nodeModules);
      if (result !== undefined) return result;
    }
    if ((extensions & Extensions.Declaration) !== 0) {
      const atTypes = combinePaths(nodeModules, '@types');
      if (!this.host.directoryExists(atTypes)) {
        if (this.traces !== undefined)
          this.trace(Diagnostics.Directory_0_does_not_exist_skipping_all_lookups_in_it, atTypes);
        return undefined;
      }
      return this.loadModuleFromSpecificNodeModulesDirectory(
        Extensions.Declaration,
        this.mangleScopedPackageName(this.name),
        atTypes,
      );
    }
    return undefined;
  }

  private loadModuleFromSpecificNodeModulesDirectory(
    extensions: number,
    moduleName: string,
    nodeModulesDirectory: string,
  ): Resolved | undefined {
    // Without the trailing separator, `pkg/` and `pkg` share their candidate and package directory.
    const candidate = removeTrailingDirectorySeparator(normalizePath(combinePaths(nodeModulesDirectory, moduleName)));
    const { packageName, rest } = parsePackageName(moduleName);
    const packageDirectory = packageName === '' ? candidate : combinePaths(nodeModulesDirectory, packageName);

    if (this.resolvePackageDirectoryOnly) {
      return this.host.directoryExists(packageDirectory) ? resolvedFile(packageDirectory, '', false) : undefined;
    }

    // A nested package.json (`node_modules/foo/bar/package.json`) applies unless the root has `exports`.
    let rootPackageInfo: PackageJsonInfo | undefined;
    let packageInfo = this.getPackageJsonInfo(candidate);
    if (rest !== '' && packageInfo !== undefined) {
      if ((this.features & Features.Exports) !== 0) rootPackageInfo = this.getPackageJsonInfo(packageDirectory);
      if (rootPackageInfo === undefined || rootPackageInfo.contents?.exports === undefined) {
        const fromFile = this.loadModuleFromFile(extensions, candidate);
        if (fromFile !== undefined) return fromFile;
        const fromDirectory = this.loadNodeModuleFromDirectoryWorker(extensions, candidate, packageInfo);
        if (fromDirectory !== undefined) {
          fromDirectory.packageId = this.getPackageId(fromDirectory.path, packageInfo);
          return fromDirectory;
        }
      }
    }

    if (rest !== '') packageInfo = rootPackageInfo ?? this.getPackageJsonInfo(packageDirectory);
    const contents = packageInfo?.contents;
    if (packageInfo !== undefined) {
      this.resolvedPackageDirectory = true;
      // `exports` takes priority over files, directories and typesVersions, and blocks them.
      // A top-level `"exports": null` does not block them.
      if ((this.features & Features.Exports) !== 0 && contents !== undefined && !isFalsyJson(contents.exports)) {
        return this.loadModuleFromExports(packageInfo, extensions, combinePaths('.', rest));
      }
      if (rest !== '' && contents !== undefined) {
        const versionPaths = contents.getVersionPaths(this.traces);
        if (versionPaths !== undefined) {
          if (this.traces !== undefined) {
            this.trace(
              Diagnostics.X_package_json_has_a_typesVersions_entry_0_that_matches_compiler_version_1_looking_for_a_pattern_to_match_module_name_2,
              versionPaths.version,
              typeScriptVersion,
              rest,
            );
          }
          const fromPaths = this.tryLoadModuleUsingPaths(
            extensions,
            rest,
            packageDirectory,
            versionPaths.paths,
            parsePatterns(versionPaths.paths),
            { kind: 'package', rest, packageInfo },
          );
          if (fromPaths !== undefined) return fromPaths;
        }
      }
    }
    return this.loadFromNodeModulesPackage(extensions, candidate, rest, packageInfo);
  }

  /** Loads `candidate` inside a `node_modules` package as a file, then as a directory. */
  private loadFromNodeModulesPackage(
    extensions: number,
    candidate: string,
    rest: string,
    packageInfo: PackageJsonInfo | undefined,
  ): Resolved | undefined {
    if (rest !== '' || !this.esmMode) {
      const fromFile = this.loadModuleFromFile(extensions, candidate);
      if (fromFile !== undefined) {
        fromFile.packageId = this.getPackageId(fromFile.path, packageInfo);
        return fromFile;
      }
    }
    const fromDirectory = this.loadNodeModuleFromDirectoryWorker(extensions, candidate, packageInfo);
    if (fromDirectory !== undefined) {
      fromDirectory.packageId = this.getPackageId(fromDirectory.path, packageInfo);
      return fromDirectory;
    }
    const contents = packageInfo?.contents;
    if (
      rest === '' &&
      contents !== undefined &&
      (contents.exports === undefined || contents.exports.type === 'null') &&
      this.esmMode
    ) {
      // ESM skips index lookups, but a package without `main` or `exports` still defaults to `index.js`.
      const index = this.loadModuleFromFile(extensions, combinePaths(candidate, 'index.js'));
      if (index !== undefined) {
        index.packageId = this.getPackageId(index.path, packageInfo);
        return index;
      }
    }
    return undefined;
  }

  createResolvedModuleHandlingSymlink(resolved: Resolved | undefined): ResolvedModule {
    const isExternalLibraryImport = resolved !== undefined && resolved.path.includes('/node_modules/');
    if (
      resolved !== undefined &&
      this.options.preserveSymlinks !== true &&
      isExternalLibraryImport &&
      resolved.originalPath === '' &&
      !isExternalModuleNameRelative(this.name)
    ) {
      const real = this.realPathIfDifferent(resolved.path);
      if (real !== '') {
        resolved.originalPath = resolved.path;
        resolved.path = real;
      }
    }
    return this.createResolvedModule(resolved, isExternalLibraryImport);
  }

  /** The real path of `path`, or `''` if it is the same path. */
  private realPathIfDifferent(path: string): string {
    const real = this.realPath(path);
    // A real path differing only in case keeps the original spelling for forceConsistentCasingInFileNames.
    const caseSensitive = this.host.useCaseSensitiveFileNames();
    return comparePaths(path, real, caseSensitive, this.host.getCurrentDirectory()) !== 0 ? real : '';
  }

  createResolvedModule(resolved: Resolved | undefined, isExternalLibraryImport: boolean): ResolvedModule {
    const diagnostics = this.diagnostics.length === 0 ? NO_DIAGNOSTICS : this.diagnostics;
    if (resolved === undefined) return unresolvedModule(diagnostics);
    return {
      resolvedFileName: resolved.path,
      originalPath: resolved.originalPath,
      extension: resolved.extension,
      resolvedUsingTsExtension: resolved.resolvedUsingTsExtension,
      packageId: resolved.packageId,
      isExternalLibraryImport,
      alternateResult: '',
      resolutionDiagnostics: diagnostics,
    };
  }

  private createResolvedTypeReferenceDirective(
    resolved: Resolved | undefined,
    primary: boolean,
  ): ResolvedTypeReferenceDirective {
    const result: ResolvedTypeReferenceDirective = {
      resolvedFileName: '',
      originalPath: '',
      primary: false,
      packageId: undefined,
      isExternalLibraryImport: false,
      resolutionDiagnostics: this.diagnostics.length === 0 ? NO_DIAGNOSTICS : this.diagnostics,
    };
    if (resolved === undefined || resolved.path === '') return result;
    if (!extensionIsTs(resolved.extension)) throw new Error('expected a TypeScript file extension');
    result.resolvedFileName = resolved.path;
    result.primary = primary;
    result.packageId = resolved.packageId;
    result.isExternalLibraryImport = resolved.path.includes('/node_modules/');
    if (this.options.preserveSymlinks !== true) {
      const real = this.realPathIfDifferent(resolved.path);
      if (real !== '') {
        result.resolvedFileName = real;
        result.originalPath = resolved.path;
      }
    }
    return result;
  }

  //// paths and rootDirs

  private tryLoadModuleUsingOptionalResolutionSettings(): Resolved | undefined {
    const fromPaths = this.tryLoadModuleUsingPathsIfEligible();
    if (fromPaths !== undefined) return fromPaths;
    // baseUrl lookups were removed; rootDirs only apply to relative names.
    return isExternalModuleNameRelative(this.name) ? this.tryLoadModuleUsingRootDirs() : undefined;
  }

  private getPathPatterns(): ParsedPatterns {
    if (this.options === this.resolver.options) return this.resolver.getPathPatterns();
    if (this.pathPatterns === undefined) this.pathPatterns = parsePatterns(this.options.paths ?? new Map());
    return this.pathPatterns;
  }

  private tryLoadModuleUsingPathsIfEligible(): Resolved | undefined {
    const paths = this.options.paths;
    if (paths === undefined || paths.size === 0 || pathIsRelative(this.name)) return undefined;
    if (this.traces !== undefined) {
      this.trace(Diagnostics.X_paths_option_is_specified_looking_for_a_pattern_to_match_module_name_0, this.name);
    }
    const baseDirectory =
      this.options.pathsBasePath !== undefined && this.options.pathsBasePath !== ''
        ? this.options.pathsBasePath
        : this.host.getCurrentDirectory();
    return this.tryLoadModuleUsingPaths(
      this.extensions,
      this.name,
      baseDirectory,
      paths,
      this.getPathPatterns(),
      RELATIVE_LOADER,
    );
  }

  private tryLoadModuleUsingPaths(
    extensions: number,
    moduleName: string,
    containingDirectory: string,
    paths: ReadonlyMap<string, readonly string[] | undefined>,
    patterns: ParsedPatterns,
    loader: PathsLoader,
  ): Resolved | undefined {
    const pattern = matchPatternOrExact(patterns, moduleName);
    if (pattern === undefined) return undefined;
    const star = matchedText(pattern, moduleName);
    if (this.traces !== undefined) this.trace(Diagnostics.Module_name_0_matched_pattern_1, moduleName, pattern.text);
    for (const substitution of paths.get(pattern.text) ?? []) {
      const path = replaceFirstStar(substitution, star);
      const candidate = normalizePath(combinePaths(containingDirectory, path));
      if (this.traces !== undefined) {
        this.trace(Diagnostics.Trying_substitution_0_candidate_module_location_Colon_1, substitution, path);
      }
      // A substitution may name a file with its extension.
      const extension = tryGetExtensionFromPath(substitution);
      if (extension !== '') {
        const found = this.tryFile(candidate);
        if (found !== undefined) return resolvedFile(found, extension, false);
      }
      const saved = this.candidateEndingIsFromConfig;
      if (extension !== '') this.candidateEndingIsFromConfig = true;
      const resolved = this.runLoader(loader, extensions, candidate);
      this.candidateEndingIsFromConfig = saved;
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }

  private runLoader(loader: PathsLoader, extensions: number, candidate: string): Resolved | undefined {
    switch (loader.kind) {
      case 'relative':
        return this.nodeLoadModuleByRelativeName(extensions, candidate, true);
      case 'package':
        return this.loadFromNodeModulesPackage(extensions, candidate, loader.rest, loader.packageInfo);
      case 'directory':
        return this.loadFromPackageJsonEntry(extensions, candidate, loader.packageFile, loader.packageInfo);
    }
  }

  private tryLoadModuleUsingRootDirs(): Resolved | undefined {
    const rootDirs = this.options.rootDirs;
    if (rootDirs === undefined || rootDirs.length === 0) return undefined;
    const traces = this.traces;
    if (traces !== undefined)
      this.trace(Diagnostics.X_rootDirs_option_is_set_using_it_to_resolve_relative_module_name_0, this.name);

    const candidate = normalizePath(combinePaths(this.containingDirectory, this.name));
    let matchedRootDir = '';
    let matchedPrefix = '';
    for (const rootDir of rootDirs) {
      const normalizedRoot = ensureTrailingDirectorySeparator(normalizePath(rootDir));
      const isLongest =
        candidate.startsWith(normalizedRoot) && (matchedPrefix === '' || matchedPrefix.length < normalizedRoot.length);
      if (traces !== undefined) {
        this.trace(
          Diagnostics.Checking_if_0_is_the_longest_matching_prefix_for_1_2,
          normalizedRoot,
          candidate,
          String(isLongest),
        );
      }
      if (isLongest) {
        matchedPrefix = normalizedRoot;
        matchedRootDir = rootDir;
      }
    }
    if (matchedPrefix === '') return undefined;

    if (traces !== undefined) this.trace(Diagnostics.Longest_matching_prefix_for_0_is_1, candidate, matchedPrefix);
    const suffix = candidate.slice(matchedPrefix.length);
    if (traces !== undefined)
      this.trace(Diagnostics.Loading_0_from_the_root_dir_1_candidate_location_2, suffix, matchedPrefix, candidate);
    const initial = this.nodeLoadModuleByRelativeName(this.extensions, candidate, true);
    if (initial !== undefined) return initial;

    if (traces !== undefined) this.trace(Diagnostics.Trying_other_entries_in_rootDirs);
    for (const rootDir of rootDirs) {
      if (rootDir === matchedRootDir) continue;
      const other = combinePaths(normalizePath(rootDir), suffix);
      if (traces !== undefined)
        this.trace(Diagnostics.Loading_0_from_the_root_dir_1_candidate_location_2, suffix, rootDir, other);
      const resolved = this.nodeLoadModuleByRelativeName(this.extensions, other, true);
      if (resolved !== undefined) return resolved;
    }
    if (traces !== undefined) this.trace(Diagnostics.Module_resolution_using_rootDirs_has_failed);
    return undefined;
  }

  //// Files and directories

  private nodeLoadModuleByRelativeName(
    extensions: number,
    candidate: string,
    considerPackageJson: boolean,
  ): Resolved | undefined {
    if (this.traces !== undefined) {
      this.trace(
        Diagnostics.Loading_module_as_file_Slash_folder_candidate_module_location_0_target_file_types_Colon_1,
        candidate,
        extensionsToString(extensions),
      );
    }
    if (!hasTrailingDirectorySeparator(candidate)) {
      const parent = getDirectoryPath(candidate);
      if (!this.host.directoryExists(parent)) {
        if (this.traces !== undefined)
          this.trace(Diagnostics.Directory_0_does_not_exist_skipping_all_lookups_in_it, parent);
        return undefined;
      }
      const fromFile = this.loadModuleFromFile(extensions, candidate);
      if (fromFile !== undefined) {
        if (considerPackageJson) this.setPackageIdFromNodeModulesPath(fromFile);
        return fromFile;
      }
    }
    if (!this.host.directoryExists(candidate)) {
      if (this.traces !== undefined)
        this.trace(Diagnostics.Directory_0_does_not_exist_skipping_all_lookups_in_it, candidate);
      return undefined;
    }
    // ESM relative imports do no directory lookups (neither package.json nor index files).
    return this.esmMode ? undefined : this.loadNodeModuleFromDirectory(extensions, candidate, considerPackageJson);
  }

  private loadModuleFromFile(extensions: number, candidate: string): Resolved | undefined {
    // ./foo.js -> ./foo.ts
    const replaced = this.loadModuleFromFileNoImplicitExtensions(extensions, candidate);
    if (replaced !== undefined) return replaced;
    // ./foo -> ./foo.ts
    return this.esmMode ? undefined : this.tryAddingExtensions(candidate, extensions, '');
  }

  private loadModuleFromFileNoImplicitExtensions(extensions: number, candidate: string): Resolved | undefined {
    // Extensionless files are not supported.
    if (!getBaseFileName(candidate).includes('.')) return undefined;
    let extensionless = removeFileExtension(candidate);
    // Unknown extensions map to declaration files such as `.d.css.ts`.
    if (extensionless === candidate) extensionless = candidate.slice(0, candidate.lastIndexOf('.'));
    const extension = candidate.slice(extensionless.length);
    if (this.traces !== undefined)
      this.trace(Diagnostics.File_name_0_has_a_1_extension_stripping_it, candidate, extension);
    return this.tryAddingExtensions(extensionless, extensions, extension);
  }

  private tryAddingExtensions(
    extensionless: string,
    extensions: number,
    originalExtension: string,
  ): Resolved | undefined {
    const directory = getDirectoryPath(extensionless);
    if (directory !== '' && !this.host.directoryExists(directory)) return undefined;
    const ts = (extensions & Extensions.TypeScript) !== 0;
    const dts = (extensions & Extensions.Declaration) !== 0;
    const js = (extensions & Extensions.JavaScript) !== 0;
    switch (originalExtension) {
      case '.mjs':
      case '.mts':
      case '.d.mts': {
        const usingTs = originalExtension === '.mts' || originalExtension === '.d.mts';
        return (
          (ts ? this.tryExtension('.mts', extensionless, usingTs) : undefined) ??
          (dts ? this.tryExtension('.d.mts', extensionless, usingTs) : undefined) ??
          (js ? this.tryExtension('.mjs', extensionless, false) : undefined)
        );
      }
      case '.cjs':
      case '.cts':
      case '.d.cts': {
        const usingTs = originalExtension === '.cts' || originalExtension === '.d.cts';
        return (
          (ts ? this.tryExtension('.cts', extensionless, usingTs) : undefined) ??
          (dts ? this.tryExtension('.d.cts', extensionless, usingTs) : undefined) ??
          (js ? this.tryExtension('.cjs', extensionless, false) : undefined)
        );
      }
      case '.json':
        return (
          (dts ? this.tryExtension('.d.json.ts', extensionless, false) : undefined) ??
          ((extensions & Extensions.Json) !== 0 ? this.tryExtension('.json', extensionless, false) : undefined)
        );
      case '.tsx':
      case '.jsx': {
        // Prefer an exact .tsx/.jsx match before the .ts/.js file.
        const usingTs = originalExtension === '.tsx';
        return (
          (ts
            ? (this.tryExtension('.tsx', extensionless, usingTs) ?? this.tryExtension('.ts', extensionless, usingTs))
            : undefined) ??
          (dts ? this.tryExtension('.d.ts', extensionless, usingTs) : undefined) ??
          (js
            ? (this.tryExtension('.jsx', extensionless, false) ?? this.tryExtension('.js', extensionless, false))
            : undefined)
        );
      }
      case '.ts':
      case '.d.ts':
      case '.js':
      case '': {
        const usingTs = originalExtension === '.ts' || originalExtension === '.d.ts';
        return (
          (ts
            ? (this.tryExtension('.ts', extensionless, usingTs) ?? this.tryExtension('.tsx', extensionless, usingTs))
            : undefined) ??
          (dts ? this.tryExtension('.d.ts', extensionless, usingTs) : undefined) ??
          (js
            ? (this.tryExtension('.js', extensionless, false) ?? this.tryExtension('.jsx', extensionless, false))
            : undefined) ??
          (this.isConfigLookup ? this.tryExtension('.json', extensionless, false) : undefined)
        );
      }
      default:
        if (dts && !isDeclarationFileName(extensionless + originalExtension)) {
          return this.tryExtension('.d' + originalExtension + '.ts', extensionless, false);
        }
        return undefined;
    }
  }

  private tryExtension(
    extension: string,
    extensionless: string,
    resolvedUsingTsExtension: boolean,
  ): Resolved | undefined {
    const path = this.tryFile(extensionless + extension);
    if (path === undefined) return undefined;
    return resolvedFile(path, extension, !this.candidateEndingIsFromConfig && resolvedUsingTsExtension);
  }

  /** The existing file for `fileName`, trying each of `moduleSuffixes`. */
  private tryFile(fileName: string): string | undefined {
    const suffixes = this.options.moduleSuffixes;
    if (suffixes === undefined || suffixes.length === 0) return this.tryFileLookup(fileName) ? fileName : undefined;
    const extension = tryGetExtensionFromPath(fileName);
    const withoutExtension = removeExtension(fileName, extension);
    for (const suffix of suffixes) {
      const path = withoutExtension + suffix + extension;
      if (this.tryFileLookup(path)) return path;
    }
    return undefined;
  }

  private tryFileLookup(fileName: string): boolean {
    if (this.host.fileExists(fileName)) {
      if (this.traces !== undefined) this.trace(Diagnostics.File_0_exists_use_it_as_a_name_resolution_result, fileName);
      return true;
    }
    if (this.traces !== undefined) this.trace(Diagnostics.File_0_does_not_exist, fileName);
    return false;
  }

  private loadNodeModuleFromDirectory(
    extensions: number,
    candidate: string,
    considerPackageJson: boolean,
  ): Resolved | undefined {
    const packageInfo = considerPackageJson ? this.getPackageJsonInfo(candidate) : undefined;
    return this.loadNodeModuleFromDirectoryWorker(extensions, candidate, packageInfo);
  }

  private loadNodeModuleFromDirectoryWorker(
    extensions: number,
    candidate: string,
    packageInfo: PackageJsonInfo | undefined,
  ): Resolved | undefined {
    let packageFile = '';
    let versionPaths: VersionPaths | undefined;
    const contents = packageInfo?.contents;
    if (packageInfo !== undefined && contents !== undefined) {
      versionPaths = contents.getVersionPaths(this.traces);
      if (comparePaths(candidate, packageInfo.packageDirectory, this.host.useCaseSensitiveFileNames()) === 0) {
        packageFile = this.getPackageFile(extensions, packageInfo);
      }
    }
    const indexPath = combinePaths(candidate, this.isConfigLookup ? 'tsconfig' : 'index');

    if (versionPaths !== undefined && (packageFile === '' || containsPath(candidate, packageFile, false))) {
      const moduleName = getRelativePathFromDirectory(candidate, packageFile !== '' ? packageFile : indexPath, false);
      if (this.traces !== undefined) {
        this.trace(
          Diagnostics.X_package_json_has_a_typesVersions_entry_0_that_matches_compiler_version_1_looking_for_a_pattern_to_match_module_name_2,
          versionPaths.version,
          typeScriptVersion,
          moduleName,
        );
      }
      const result = this.tryLoadModuleUsingPaths(
        extensions,
        moduleName,
        candidate,
        versionPaths.paths,
        parsePatterns(versionPaths.paths),
        { kind: 'directory', packageFile, packageInfo },
      );
      if (result !== undefined) return result;
    }

    if (packageFile !== '') {
      const result = this.loadFromPackageJsonEntry(extensions, packageFile, packageFile, packageInfo);
      if (result !== undefined) return result;
    }

    // ESM resolutions do no index lookups.
    if (this.esmMode || !this.host.directoryExists(candidate)) return undefined;
    return this.loadModuleFromFile(extensions, indexPath);
  }

  /** Loads a `main`/`types` entry (or a typesVersions substitution for it). */
  private loadFromPackageJsonEntry(
    extensions: number,
    candidate: string,
    packageFile: string,
    packageInfo: PackageJsonInfo | undefined,
  ): Resolved | undefined {
    const fromFile = this.loadFileNameFromPackageJsonField(extensions, candidate, packageFile);
    if (fromFile !== undefined) return fromFile;
    // `types` may point at a .ts file even for declaration-only lookups.
    const expanded =
      extensions === Extensions.Declaration ? Extensions.TypeScript | Extensions.Declaration : extensions;
    // CommonJS packages may omit extensions in `main`, even from ESM importers.
    const savedEsmMode = this.esmMode;
    const savedEnding = this.candidateEndingIsFromConfig;
    this.candidateEndingIsFromConfig = true;
    if (packageInfo?.contents !== undefined && packageInfo.contents.type.value !== 'module') this.esmMode = false;
    const result = this.nodeLoadModuleByRelativeName(expanded, candidate, false);
    this.esmMode = savedEsmMode;
    this.candidateEndingIsFromConfig = savedEnding;
    return result;
  }

  /**
   * Loads a path written in package.json. TS extensions are allowed as is; JS extensions are also tried as their
   * TS counterparts.
   */
  private loadFileNameFromPackageJsonField(
    extensions: number,
    candidate: string,
    packageJsonValue: string,
  ): Resolved | undefined {
    if (
      ((extensions & Extensions.TypeScript) !== 0 && hasImplementationTSFileExtension(candidate)) ||
      ((extensions & Extensions.Declaration) !== 0 && isDeclarationFileName(candidate))
    ) {
      const path = this.tryFile(candidate);
      if (path === undefined) return undefined;
      const extension = tryExtractTSExtension(path);
      // True when a trailing `*` matched a TS extension written in the specifier.
      return resolvedFile(path, extension, packageJsonValue.endsWith('*') && extension !== '');
    }
    if (this.isConfigLookup && (extensions & Extensions.Json) !== 0 && fileExtensionIs(candidate, '.json')) {
      const path = this.tryFile(candidate);
      if (path !== undefined) return resolvedFile(path, '.json', false);
    }
    return this.loadModuleFromFileNoImplicitExtensions(extensions, candidate);
  }

  private getPackageFile(extensions: number, packageInfo: PackageJsonInfo): string {
    const contents = packageInfo.contents;
    if (contents === undefined) return '';
    const directory = packageInfo.packageDirectory;
    if (this.isConfigLookup) return this.getPackageJsonPathField('tsconfig', contents.tsconfig, directory);
    if ((extensions & Extensions.Declaration) !== 0) {
      const typings = this.getPackageJsonPathField('typings', contents.typings, directory);
      if (typings !== '') return typings;
      const types = this.getPackageJsonPathField('types', contents.types, directory);
      if (types !== '') return types;
    }
    if ((extensions & (Extensions.ImplementationFiles | Extensions.Declaration)) !== 0) {
      return this.getPackageJsonPathField('main', contents.main, directory);
    }
    return '';
  }

  //// package.json

  private getPackageJsonInfo(packageDirectory: string): PackageJsonInfo | undefined {
    const packageJsonPath = combinePaths(packageDirectory, 'package.json');
    const cache = this.resolver.packageJsonInfoCache;
    const existing = cache.get(packageJsonPath);
    if (existing !== undefined) {
      if (existing.contents !== undefined) {
        if (this.traces !== undefined)
          this.trace(Diagnostics.File_0_exists_according_to_earlier_cached_lookups, packageJsonPath);
        return withPackageDirectory(existing, packageDirectory);
      }
      if (existing.directoryExists && this.traces !== undefined) {
        this.trace(Diagnostics.File_0_does_not_exist_according_to_earlier_cached_lookups, packageJsonPath);
      }
      return undefined;
    }
    const directoryExists = this.host.directoryExists(packageDirectory);
    if (directoryExists && this.host.fileExists(packageJsonPath)) {
      const contents = parsePackageJson(this.host.readFile(packageJsonPath) ?? '');
      if (this.traces !== undefined) this.trace(Diagnostics.Found_package_json_at_0, packageJsonPath);
      const stored = cache.set(packageJsonPath, { packageDirectory, directoryExists: true, contents });
      return withPackageDirectory(stored, packageDirectory);
    }
    if (directoryExists && this.traces !== undefined) this.trace(Diagnostics.File_0_does_not_exist, packageJsonPath);
    cache.set(packageJsonPath, { packageDirectory, directoryExists, contents: undefined });
    return undefined;
  }

  private getPackageId(resolvedFileName: string, packageInfo: PackageJsonInfo | undefined): PackageId | undefined {
    const contents = packageInfo?.contents;
    if (packageInfo === undefined || contents === undefined) return undefined;
    const name = contents.name.value;
    const version = contents.version.value;
    if (name === undefined || version === undefined) return undefined;
    const directory = packageInfo.packageDirectory;
    return {
      name,
      version,
      subModuleName: resolvedFileName.length > directory.length ? resolvedFileName.slice(directory.length + 1) : '',
      peerDependencies: this.readPeerDependencies(packageInfo),
    };
  }

  private readPeerDependencies(packageInfo: PackageJsonInfo): string {
    const field = packageInfo.contents?.peerDependencies;
    if (field === undefined || !this.validatePackageJsonField('peerDependencies', field, 'object')) return '';
    const peers = field.value;
    if (peers === undefined || peers.size === 0) return '';
    if (this.traces !== undefined) this.trace(Diagnostics.X_package_json_has_a_peerDependencies_field);
    const packageDirectory = this.realPath(packageInfo.packageDirectory);
    const index = packageDirectory.lastIndexOf('/node_modules');
    if (index === -1) return '';
    const nodeModules = packageDirectory.slice(0, index + 13) + '/';
    const names = [...peers.keys()].sort();
    let result = '';
    for (const name of names) {
      const peer = this.getPackageJsonInfo(nodeModules + name);
      const peerContents = peer?.contents;
      if (peerContents !== undefined) {
        const version = peerContents.version.value ?? '';
        result += '+' + name + '@' + version;
        if (this.traces !== undefined) this.trace(Diagnostics.Found_peerDependency_0_with_1_version, name, version);
      } else if (this.traces !== undefined) {
        this.trace(Diagnostics.Failed_to_find_peerDependency_0, name);
      }
    }
    return result;
  }

  private realPath(path: string): string {
    const real = normalizePath(this.host.realpath(path));
    if (this.traces !== undefined) this.trace(Diagnostics.Resolving_real_path_for_0_result_1, path, real);
    return real;
  }

  private validatePackageJsonField<T>(fieldName: string, field: Expected<T>, expectedType: string): boolean {
    if (field.actualType !== undefined) {
      if (field.value !== undefined) return true;
      if (this.traces !== undefined) {
        this.trace(
          Diagnostics.Expected_type_of_0_field_in_package_json_to_be_1_got_2,
          fieldName,
          expectedType,
          field.actualType,
        );
      }
    }
    if (this.traces !== undefined) this.trace(Diagnostics.X_package_json_does_not_have_a_0_field, fieldName);
    return false;
  }

  /** The normalized path a string field points at, or `''`. */
  private getPackageJsonPathField(fieldName: string, field: Expected<string>, directory: string): string {
    if (!this.validatePackageJsonField(fieldName, field, 'string')) return '';
    const value = field.value ?? '';
    if (value === '') {
      if (this.traces !== undefined) this.trace(Diagnostics.X_package_json_had_a_falsy_0_field, fieldName);
      return '';
    }
    const path = normalizePath(combinePaths(directory, value));
    if (this.traces !== undefined)
      this.trace(Diagnostics.X_package_json_has_0_field_1_that_references_2, fieldName, value, path);
    return path;
  }

  private conditionMatches(condition: string): boolean {
    if (condition === 'default' || this.conditions.includes(condition)) return true;
    // Versioned types conditions only apply along with `types`.
    return this.conditions.includes('types') && isApplicableVersionedTypesKey(condition);
  }
}

const OUTPUT_EXTENSIONS: readonly string[] = ['.mjs', '.cjs', '.js', '.json', '.d.mts', '.d.cts', '.d.ts'];

function bundlerFeatures(options: CompilerOptions): number {
  let features: number = Features.BundlerDefault;
  if (options.resolvePackageJsonExports === true) features |= Features.Exports;
  else if (options.resolvePackageJsonExports === false) features &= ~Features.Exports;
  if (options.resolvePackageJsonImports === true) features |= Features.Imports;
  else if (options.resolvePackageJsonImports === false) features &= ~Features.Imports;
  return features;
}
