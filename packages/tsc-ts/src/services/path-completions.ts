// Completions for module specifiers and triple-slash references, like tsgo's path completions.
import { getName, getText, type Node, type SourceFile } from '../compiler/ast.js';
import { getTokenAtPosition } from '../compiler/astnav.js';
import type { Checker } from '../compiler/checker.js';
import { getMergedSymbol, isAmbientModuleSymbolName } from '../compiler/checker-symbols.js';
import { isGlobalScopeAugmentation } from '../compiler/ast-utilities.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { isExternalModuleAugmentation } from './utilities.js';
import {
  comparePatternKeys,
  getConditions,
  getEffectiveTypeRoots,
  unmangleScopedPackageName,
} from '../compiler/module-resolution-types.js';
import {
  getModuleResolutionKind,
  getResolvePackageJsonExports,
  getResolvePackageJsonImports,
  getResolveJsonModule,
  ModuleKind,
  ModuleResolutionKind,
} from '../compiler/options.js';
import {
  isApplicableVersionedTypesKey,
  type JsonValue,
  parseJson,
  parsePackageJson,
} from '../compiler/package-json.js';
import {
  changeExtension,
  combinePaths,
  comparePaths,
  containsPath,
  ensureTrailingDirectorySeparator,
  fileExtensionIsOneOf,
  getAnyExtensionFromPath,
  getBaseFileName,
  getDirectoryPath,
  getPathComponents,
  hasTrailingDirectorySeparator,
  isRootedDiskPath,
  isUrl,
  normalizePath,
  normalizeSlashes,
  removeFileExtension,
  removeTrailingDirectorySeparator,
  resolvePath,
  tryGetExtensionFromPath,
  getCanonicalFileName,
} from '../compiler/path.js';
import type { Program } from '../compiler/program.js';
import {
  ModuleSpecifierEnding,
  ModuleSpecifierPreferences,
  getAllowedEndingsInPreferredOrder,
  tryGetJSExtensionForFile,
  tryGetRealFileNameForNonJSDeclarationFileName,
} from '../compiler/module-specifiers.js';
import { ProgramModuleSpecifierHost } from '../compiler/program-checker.js';
import { getLeadingCommentRanges } from '../compiler/scanner.js';
import { getDeclarations, type Symbol } from '../compiler/symbol.js';
import { flattenExtensions, getSupportedExtensions } from '../compiler/tsconfig.js';
import { readDirectory } from '../compiler/vfs-match.js';
import { isInComment, isStringLiteralLike } from './completion-utilities.js';
import { ScriptElementKind } from './symbol-kinds.js';

export interface PathCompletion {
  name: string;
  kind: ScriptElementKind;
  extension: string;
}

const enum ModuleCompletionKind {
  Directory,
  File,
  ExternalModuleName,
}

interface ModuleCompletion {
  name: string;
  kind: ModuleCompletionKind;
  extension: string;
}

/** Completions by name; a later entry replaces an earlier one of a lower kind. */
class ModuleCompletionSet {
  readonly names = new Map<string, ModuleCompletion>();

  add(entry: ModuleCompletion): void {
    const existing = this.names.get(entry.name);
    if (existing === undefined || existing.kind < entry.kind) this.names.set(entry.name, entry);
  }

  values(): ModuleCompletion[] {
    return [...this.names.values()];
  }
}

const enum ReferenceKind {
  FileName,
  ModuleSpecifier,
}

interface ExtensionOptions {
  extensionsToSearch: string[];
  referenceKind: ReferenceKind;
  importingSourceFile: SourceFile;
  resolutionMode: ModuleKind;
}

class PathCompletions {
  constructor(
    readonly program: Program,
    readonly c: Checker | undefined,
  ) {}

  get options() {
    return this.program.options;
  }

  get fs() {
    return this.program.host.fs;
  }

  private directoryExists(path: string): boolean {
    return this.fs.directoryExists(path);
  }

  private getDirectories(path: string): readonly string[] {
    return this.fs.getAccessibleEntries(path).directories;
  }

  private readDirectory(path: string, extensions: readonly string[], includes: readonly string[]): string[] {
    return readDirectory(this.fs, this.program.currentDirectory, path, extensions, [], includes, -1);
  }

  private packageJson(path: string): PackageJsonContents | undefined {
    if (!this.fs.fileExists(path)) return undefined;
    const text = this.fs.readFile(path);
    if (text === undefined) return undefined;
    return new PackageJsonContents(text);
  }

  extensionOptions(referenceKind: ReferenceKind, file: SourceFile, mode: ModuleKind): ExtensionOptions {
    return {
      extensionsToSearch: this.getSupportedExtensionsForModuleResolution(),
      referenceKind,
      importingSourceFile: file,
      resolutionMode: mode,
    };
  }

  private getSupportedExtensionsForModuleResolution(): string[] {
    // Extensions from ambient module declarations like `*.css`.
    const extensions: string[] = [];
    if (this.c !== undefined)
      for (const module of getAmbientModules(this.c)) {
        const name = getAmbientModuleName(module);
        if (!name.startsWith('*.') || name.includes('/')) continue;
        extensions.push(name.substring(1));
      }
    extensions.push(...flattenExtensions(getSupportedExtensions(this.options)));
    if (
      moduleResolutionUsesNodeModules(getModuleResolutionKind(this.options)) &&
      getResolveJsonModule(this.options) &&
      !extensions.includes('.json')
    )
      extensions.push('.json');
    return extensions;
  }

  fromModuleNames(file: SourceFile, node: Node): ModuleCompletion[] {
    const literalValue = normalizeSlashes(getText(node));
    const mode = isStringLiteralLike(node) ? this.program.getModeForUsageLocation(file, node) : ModuleKind.None;
    const scriptPath = file.path;
    const scriptDirectory = getDirectoryPath(scriptPath);
    const extensionOptions = this.extensionOptions(ReferenceKind.ModuleSpecifier, file, mode);
    const paths = this.options.paths;
    const hasPaths = paths !== undefined && paths.size > 0;
    if (isPathRelativeToScript(literalValue) || (!hasPaths && (isRootedDiskPath(literalValue) || isUrl(literalValue))))
      return this.forRelativeModules(literalValue, scriptDirectory, scriptPath, extensionOptions);
    return this.forNonRelativeModules(literalValue, scriptDirectory, mode, extensionOptions);
  }

  private forRelativeModules(
    literalValue: string,
    scriptDirectory: string,
    scriptPath: string,
    extensionOptions: ExtensionOptions,
  ): ModuleCompletion[] {
    const rootDirs = this.options.rootDirs;
    if (rootDirs !== undefined && rootDirs.length > 0) {
      const basePath = this.options.project ?? this.program.currentDirectory;
      const ignoreCase = !this.fs.useCaseSensitiveFileNames;
      const all: ModuleCompletion[] = [];
      for (const baseDirectory of getBaseDirectoriesFromRootDirs(rootDirs, basePath, scriptDirectory, ignoreCase)) {
        const result = this.forDirectoryFragment(
          literalValue,
          baseDirectory,
          extensionOptions,
          true,
          scriptPath,
          new ModuleCompletionSet(),
        );
        all.push(...result.values());
      }
      const seen = new Set<string>();
      return all.filter((e) => {
        const key = e.name + '\u0000' + e.kind + '\u0000' + e.extension;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return this.forDirectoryFragment(
      literalValue,
      scriptDirectory,
      extensionOptions,
      true,
      scriptPath,
      new ModuleCompletionSet(),
    ).values();
  }

  private forNonRelativeModules(
    fragment: string,
    scriptPath: string,
    mode: ModuleKind,
    extensionOptions: ExtensionOptions,
  ): ModuleCompletion[] {
    const options = this.options;
    const result = new ModuleCompletionSet();
    const moduleResolution = getModuleResolutionKind(options);
    const paths = options.paths;
    if (paths !== undefined && paths.size > 0) {
      const absolute = options.pathsBasePath ?? this.program.currentDirectory;
      this.addFromPaths(result, fragment, absolute, extensionOptions, paths);
    }
    const fragmentDirectory = getFragmentDirectory(fragment);
    if (this.c !== undefined)
      for (const ambientName of getAmbientModuleCompletions(this.c, fragment, fragmentDirectory))
        result.add({ name: ambientName, kind: ModuleCompletionKind.ExternalModuleName, extension: '' });
    this.fromTypings(scriptPath, fragmentDirectory, extensionOptions, result);
    if (moduleResolutionUsesNodeModules(moduleResolution)) {
      // For a global package name, only dependencies are offered, unless there are none.
      let foundGlobal = false;
      if (fragmentDirectory === '') {
        for (const moduleName of this.enumerateNodeModulesVisibleToScript(scriptPath)) {
          if (!result.names.has(moduleName)) {
            foundGlobal = true;
            result.add({ name: moduleName, kind: ModuleCompletionKind.ExternalModuleName, extension: '' });
          }
        }
      }
      if (!foundGlobal) {
        const resolveExports = getResolvePackageJsonExports(options);
        const resolveImports = getResolvePackageJsonImports(options);
        let seenPackageScope = false;
        const conditions = getConditions(options, mode);
        // Returns true when the search should stop.
        const exportsOrImportsLookup = (
          lookupTable: JsonValue | undefined,
          subFragment: string,
          baseDirectory: string,
          isExports: boolean,
          isImports: boolean,
        ): boolean => {
          if (lookupTable === undefined || lookupTable.type !== 'object') return lookupTable !== undefined;
          const keys = [...lookupTable.entries.keys()];
          this.addFromPathsOrExportsOrImports(
            result,
            isExports,
            isImports,
            subFragment,
            baseDirectory,
            extensionOptions,
            keys,
            (key) => {
              const value = lookupTable.entries.get(key);
              if (value === undefined) return [];
              const pattern = getPatternFromFirstMatchingCondition(value, conditions);
              if (pattern === '') return [];
              if (key.endsWith('/') && pattern.endsWith('/')) return [pattern + '*'];
              return [pattern];
            },
            comparePatternKeys,
          );
          return true;
        };
        const importsLookup = (directory: string): void => {
          if (resolveImports && !seenPackageScope) {
            const info = this.packageJson(combinePaths(directory, 'package.json'));
            if (info !== undefined) {
              seenPackageScope = true;
              exportsOrImportsLookup(info.imports, fragment, directory, false, true);
            }
          }
        };
        const nodeModulesLookup = (ancestor: string): void => {
          const nodeModules = combinePaths(ancestor, 'node_modules');
          if (this.directoryExists(nodeModules))
            this.forDirectoryFragment(fragment, nodeModules, extensionOptions, false, '', result);
          importsLookup(ancestor);
        };
        let ancestorLookup = nodeModulesLookup;
        if (fragmentDirectory !== '' && resolveExports) {
          ancestorLookup = (ancestor: string): void => {
            const components = getPathComponents(fragment, '').slice(1);
            if (components.length === 0) return nodeModulesLookup(ancestor);
            let packagePath = components.shift()!;
            if (packagePath.startsWith('@')) {
              if (components.length === 0) return nodeModulesLookup(ancestor);
              packagePath = combinePaths(packagePath, components.shift()!);
            }
            if (resolveImports && packagePath.startsWith('#')) return importsLookup(ancestor);
            const packageDirectory = combinePaths(combinePaths(ancestor, 'node_modules'), packagePath);
            const info = this.packageJson(combinePaths(packageDirectory, 'package.json'));
            if (info !== undefined) {
              let fragmentSubpath = components.join('/');
              if (components.length > 0 && hasTrailingDirectorySeparator(fragment)) fragmentSubpath += '/';
              if (exportsOrImportsLookup(info.exports, fragmentSubpath, packageDirectory, true, false)) return;
            }
            nodeModulesLookup(ancestor);
          };
        }
        forEachAncestorDirectory(scriptPath, ancestorLookup);
      }
    }
    return result.values();
  }

  fromTypings(
    scriptPath: string,
    fragmentDirectory: string,
    extensionOptions: ExtensionOptions,
    result: ModuleCompletionSet,
  ): void {
    const seen = new Set<string>();
    for (const root of getEffectiveTypeRoots(this.options, this.program.currentDirectory))
      this.fromTypingsDirectory(root, fragmentDirectory, extensionOptions, seen, result);
    forEachAncestorDirectory(scriptPath, (directory) =>
      this.fromTypingsDirectory(
        combinePaths(directory, 'node_modules/@types'),
        fragmentDirectory,
        extensionOptions,
        seen,
        result,
      ),
    );
  }

  private fromTypingsDirectory(
    directory: string,
    fragmentDirectory: string,
    extensionOptions: ExtensionOptions,
    seen: Set<string>,
    result: ModuleCompletionSet,
  ): void {
    if (!this.directoryExists(directory)) return;
    const types = this.options.types;
    for (const typeDirectoryName of this.getDirectories(directory)) {
      const packageName = unmangleScopedPackageName(typeDirectoryName);
      if (types !== undefined && types.length > 0 && !types.includes(packageName)) continue;
      if (fragmentDirectory === '') {
        if (!seen.has(packageName)) {
          result.add({ name: packageName, kind: ModuleCompletionKind.ExternalModuleName, extension: '' });
          seen.add(packageName);
        }
      } else {
        const baseDirectory = combinePaths(directory, typeDirectoryName);
        const remainingFragment = tryRemoveDirectoryPrefix(
          fragmentDirectory,
          packageName,
          this.fs.useCaseSensitiveFileNames,
        );
        if (remainingFragment !== undefined)
          this.forDirectoryFragment(remainingFragment, baseDirectory, extensionOptions, false, '', result);
      }
    }
  }

  private enumerateNodeModulesVisibleToScript(scriptPath: string): string[] {
    const result: string[] = [];
    forEachAncestorDirectory(scriptPath, (directory) => {
      const info = this.packageJson(combinePaths(directory, 'package.json'));
      if (info !== undefined)
        for (const name of info.dependencyNames()) if (!name.startsWith('@types/')) result.push(name);
    });
    return result;
  }

  /** The completions for a path ending at a directory. */
  forDirectoryFragment(
    fragmentIn: string,
    scriptDirectory: string,
    extensionOptions: ExtensionOptions,
    moduleSpecifierIsRelative: boolean,
    exclude: string,
    result: ModuleCompletionSet,
  ): ModuleCompletionSet {
    let fragment = normalizeSlashes(fragmentIn);
    // The base name isn't used to filter; the client does that.
    if (!hasTrailingDirectorySeparator(fragment)) fragment = getDirectoryPath(fragment);
    if (fragment === '') fragment = '.';
    fragment = ensureTrailingDirectorySeparator(fragment);
    const baseDirectory = resolvePath(scriptDirectory, fragment);
    if (!moduleSpecifierIsRelative) {
      // A `typesVersions` redirect.
      const packageJsonDirectory = this.nearestAncestorDirectoryWithPackageJson(baseDirectory);
      if (packageJsonDirectory !== undefined) {
        const info = this.program.host.fs.readFile(combinePaths(packageJsonDirectory, 'package.json'));
        const versionPaths = info !== undefined ? parsePackageJson(info).getVersionPaths(undefined) : undefined;
        if (versionPaths !== undefined && versionPaths.paths.size > 0) {
          const pathInPackage = baseDirectory.substring(ensureTrailingDirectorySeparator(packageJsonDirectory).length);
          if (this.addFromPaths(result, pathInPackage, packageJsonDirectory, extensionOptions, versionPaths.paths))
            return result;
        }
      }
    }
    if (!this.directoryExists(baseDirectory)) return result;
    for (const filePath of this.readDirectory(baseDirectory, extensionOptions.extensionsToSearch, ['./*'])) {
      // No self-imports.
      if (comparePaths(exclude, filePath, this.fs.useCaseSensitiveFileNames, this.program.currentDirectory) === 0)
        continue;
      const nameAndExtension = this.getFilenameWithExtensionOption(getBaseFileName(filePath), extensionOptions, false);
      result.add({
        name: nameAndExtension.name,
        kind: ModuleCompletionKind.File,
        extension: nameAndExtension.extension,
      });
    }
    for (const directory of this.getDirectories(baseDirectory)) {
      const directoryName = getBaseFileName(directory);
      if (directoryName !== '@types')
        result.add({ name: directoryName, kind: ModuleCompletionKind.Directory, extension: '' });
    }
    return result;
  }

  private nearestAncestorDirectoryWithPackageJson(directory: string): string | undefined {
    let result: string | undefined;
    forEachAncestorDirectory(directory, (d) => {
      if (result === undefined && this.fs.fileExists(combinePaths(d, 'package.json'))) result = d;
      return result !== undefined;
    });
    return result;
  }

  /** True if `fragment` matched one of `paths`. */
  private addFromPaths(
    result: ModuleCompletionSet,
    fragment: string,
    baseDirectory: string,
    extensionOptions: ExtensionOptions,
    paths: ReadonlyMap<string, readonly string[] | undefined>,
  ): boolean {
    const compare = (a: string, b: string): number => {
      const starA = a.indexOf('*');
      const starB = b.indexOf('*');
      const lengthA = starA !== -1 ? starA : a.length;
      const lengthB = starB !== -1 ? starB : b.length;
      return lengthB < lengthA ? -1 : lengthB > lengthA ? 1 : 0;
    };
    return this.addFromPathsOrExportsOrImports(
      result,
      false,
      false,
      fragment,
      baseDirectory,
      extensionOptions,
      [...paths.keys()],
      (key) => (paths.get(key) ?? []).slice(),
      compare,
    );
  }

  private addFromPathsOrExportsOrImports(
    result: ModuleCompletionSet,
    isExports: boolean,
    isImports: boolean,
    fragment: string,
    baseDirectory: string,
    extensionOptions: ExtensionOptions,
    keys: string[],
    getPatternsForKey: (key: string) => string[],
    comparePathsFn: (a: string, b: string) => number,
  ): boolean {
    let pathResults: { results: ModuleCompletion[]; matched: boolean }[] = [];
    let matchedPath: string | undefined;
    for (const key of keys) {
      if (key === '.') continue;
      let normalizedKey = key.startsWith('./') ? key.substring(2) : key;
      if ((isExports || isImports) && key.endsWith('/')) normalizedKey += '*';
      const patterns = getPatternsForKey(key);
      if (patterns.length === 0) continue;
      const pathPattern = tryParsePattern(normalizedKey);
      if (pathPattern === undefined) continue;
      const isMatch = patternMatches(pathPattern, fragment);
      const isLongestMatch = isMatch && (matchedPath === undefined || comparePathsFn(normalizedKey, matchedPath) < 0);
      if (isLongestMatch) {
        // Results from earlier, shorter matches aren't reachable.
        matchedPath = normalizedKey;
        pathResults = pathResults.filter((r) => !r.matched);
      }
      if (pathPattern.starIndex === -1 || matchedPath === undefined || comparePathsFn(normalizedKey, matchedPath) <= 0)
        pathResults.push({
          matched: isMatch,
          results: this.forPathMapping(
            normalizedKey,
            patterns,
            fragment,
            baseDirectory,
            isExports,
            isImports,
            extensionOptions,
          ),
        });
    }
    for (const r of pathResults) for (const res of r.results) result.add(res);
    return matchedPath !== undefined;
  }

  private forPathMapping(
    path: string,
    patterns: string[],
    fragment: string,
    packageDirectory: string,
    isExports: boolean,
    isImports: boolean,
    extensionOptions: ExtensionOptions,
  ): ModuleCompletion[] {
    let fragmentDirectory = getFragmentDirectory(fragment);
    if (fragmentDirectory !== '') fragmentDirectory = ensureTrailingDirectorySeparator(fragmentDirectory);
    const justPathMappingName = (nameIn: string, kind: ModuleCompletionKind, extension: string): ModuleCompletion[] => {
      if (!nameIn.startsWith(fragment)) return [];
      let name = removeTrailingDirectorySeparator(nameIn);
      if (fragmentDirectory !== '' && name.startsWith(fragmentDirectory))
        name = name.substring(fragmentDirectory.length);
      return [{ name, kind, extension }];
    };
    const parsedPath = tryParsePattern(path);
    if (parsedPath === undefined) return [];
    // A mapping without a star completes its own name.
    if (parsedPath.starIndex === -1) {
      const pattern = patterns.length > 0 ? patterns[0] : '';
      return justPathMappingName(path, ModuleCompletionKind.File, getFileExtension(pattern));
    }
    const pathPrefix = parsedPath.text.substring(0, parsedPath.starIndex);
    const pathSuffix = parsedPath.text.substring(parsedPath.starIndex + 1);
    if (!fragment.startsWith(pathPrefix)) {
      if (!pathPrefix.startsWith(fragment)) return [];
      if (path.endsWith('/*')) return justPathMappingName(pathPrefix, ModuleCompletionKind.Directory, '');
      // With `foo/bar/*` and fragment `foo/b`, the remaining prefix is `bar/`.
      const remainingDirectoryPrefix = pathPrefix.substring(fragmentDirectory.length);
      const completions: ModuleCompletion[] = [];
      for (const pattern of patterns)
        for (const m of this.modulesForPathsPattern(
          '',
          packageDirectory,
          pattern,
          isExports,
          isImports,
          extensionOptions,
        ))
          completions.push({
            name: remainingDirectoryPrefix + m.name + (m.kind === ModuleCompletionKind.File ? pathSuffix : ''),
            kind: m.kind,
            extension: m.extension,
          });
      return completions;
    }
    const remainingFragment = fragment.substring(pathPrefix.length);
    const remainingDirectoryFragment = !fragmentDirectory.startsWith(pathPrefix)
      ? pathPrefix.substring(fragmentDirectory.length)
      : '';
    const completions: ModuleCompletion[] = [];
    for (const pattern of patterns)
      for (const m of this.modulesForPathsPattern(
        remainingFragment,
        packageDirectory,
        pattern,
        isExports,
        isImports,
        extensionOptions,
      ))
        completions.push({
          name: remainingDirectoryFragment + m.name + (m.kind === ModuleCompletionKind.File ? pathSuffix : ''),
          kind: m.kind,
          extension: m.extension,
        });
    return completions;
  }

  private modulesForPathsPattern(
    fragment: string,
    packageDirectory: string,
    pattern: string,
    isExports: boolean,
    isImports: boolean,
    extensionOptions: ExtensionOptions,
  ): ModuleCompletion[] {
    const parsed = tryParsePattern(pattern);
    if (parsed === undefined || parsed.starIndex === -1) return [];
    const prefix = parsed.text.substring(0, parsed.starIndex);
    const suffix = parsed.text.substring(parsed.starIndex + 1);
    // `directory/path/of/prefix/base*`
    const normalizedPrefix = resolvePath(prefix, '');
    const normalizedPrefixDirectory = hasTrailingDirectorySeparator(prefix)
      ? normalizedPrefix
      : getDirectoryPath(normalizedPrefix);
    const normalizedPrefixBase = hasTrailingDirectorySeparator(prefix) ? '' : getBaseFileName(normalizedPrefix);
    const fragmentHasPath = fragment.includes('/');
    const fragmentDirectory = fragmentHasPath
      ? hasTrailingDirectorySeparator(fragment)
        ? fragment
        : getDirectoryPath(fragment)
      : '';
    // The prefix expanded with the fragment's path limits the directory read.
    const expandedPrefixDirectory = fragmentHasPath
      ? combinePaths(normalizedPrefixDirectory, normalizedPrefixBase + fragmentDirectory)
      : normalizedPrefixDirectory;
    const baseDirectory = normalizePath(combinePaths(packageDirectory, expandedPrefixDirectory));
    // An `exports` or `imports` target stays inside its package: a pattern whose directory leaves the package, such
    // as `./../../outside/*`, offers nothing, and the directories outside it are not read.
    if (
      (isExports || isImports) &&
      !containsPath(normalizePath(packageDirectory), baseDirectory, this.fs.useCaseSensitiveFileNames)
    )
      return [];
    const normalizedSuffix = normalizePath(suffix);
    const matchingSuffixes: string[] = [];
    if (normalizedSuffix !== '') {
      const declarationExtension = getDeclarationEmitExtensionForPath('_' + normalizedSuffix);
      if (declarationExtension !== '') matchingSuffixes.push(changeExtension(normalizedSuffix, declarationExtension));
      for (const ext of getPossibleOriginalInputExtensionForExtension('_' + normalizedSuffix))
        matchingSuffixes.push(changeExtension(normalizedSuffix, ext));
    }
    matchingSuffixes.push(normalizedSuffix);
    const includeGlobs = normalizedSuffix !== '' ? matchingSuffixes.map((s) => '**/*' + s) : ['./*'];
    const isExportsOrImportsWildcard = (isExports || isImports) && pattern.endsWith('/*');
    const trimPrefixAndSuffix = (path: string, prefixText: string): string => {
      for (const s of matchingSuffixes) {
        const normalized = normalizePath(path);
        if (
          normalized.startsWith(prefixText) &&
          normalized.endsWith(s) &&
          normalized.length >= prefixText.length + s.length
        ) {
          const inner = normalized.substring(prefixText.length, normalized.length - s.length);
          return inner.startsWith('/') ? inner.substring(1) : inner;
        }
      }
      return '';
    };
    const matches: ModuleCompletion[] = [];
    const completePrefix = fragmentHasPath
      ? baseDirectory
      : ensureTrailingDirectorySeparator(baseDirectory) + normalizedPrefixBase;
    for (const match of this.readDirectory(baseDirectory, extensionOptions.extensionsToSearch, includeGlobs)) {
      const trimmed = trimPrefixAndSuffix(match, completePrefix);
      if (trimmed === '') continue;
      if (trimmed.includes('/')) {
        const components = getPathComponents(trimmed.startsWith('/') ? trimmed.substring(1) : trimmed, '');
        if (components.length > 1)
          matches.push({ name: components[1], kind: ModuleCompletionKind.Directory, extension: '' });
      } else {
        const nameAndExtension = this.getFilenameWithExtensionOption(
          trimmed,
          extensionOptions,
          isExportsOrImportsWildcard,
        );
        matches.push({
          name: nameAndExtension.name,
          kind: ModuleCompletionKind.File,
          extension: nameAndExtension.extension !== '' ? nameAndExtension.extension : getFileExtension(match),
        });
      }
    }
    // Without a suffix, any directory may hold something to import.
    if (normalizedSuffix === '')
      for (const dir of this.getDirectories(baseDirectory))
        if (dir !== 'node_modules') matches.push({ name: dir, kind: ModuleCompletionKind.Directory, extension: '' });
    return matches;
  }

  private getFilenameWithExtensionOption(
    name: string,
    extensionOptions: ExtensionOptions,
    isExportsOrImportsWildcard: boolean,
  ): { name: string; extension: string } {
    const nonJSResult = tryGetRealFileNameForNonJSDeclarationFileName(name);
    if (nonJSResult !== '') return { name: nonJSResult, extension: tryGetExtensionFromPath(nonJSResult) };
    if (extensionOptions.referenceKind === ReferenceKind.FileName)
      return { name, extension: tryGetExtensionFromPath(name) };
    let allowedEndings = getAllowedEndingsInPreferredOrder(
      new ModuleSpecifierPreferences('', ''),
      new ProgramModuleSpecifierHost(this.program),
      this.options,
      extensionOptions.importingSourceFile,
      '',
      extensionOptions.resolutionMode,
    );
    // Wildcard subpaths of `exports` need file names.
    if (isExportsOrImportsWildcard)
      allowedEndings = allowedEndings.filter(
        (e) => e !== ModuleSpecifierEnding.Minimal && e !== ModuleSpecifierEnding.Index,
      );
    if (allowedEndings.length > 0 && allowedEndings[0] === ModuleSpecifierEnding.TsExtension) {
      if (fileExtensionIsOneOf(name, ['.ts', '.tsx', '.mts', '.cts']))
        return { name, extension: tryGetExtensionFromPath(name) };
      const outputExtension = tryGetJSExtensionForFile(name, this.options);
      if (outputExtension !== '') return { name: changeExtension(name, outputExtension), extension: outputExtension };
      return { name, extension: tryGetExtensionFromPath(name) };
    }
    if (
      !isExportsOrImportsWildcard &&
      allowedEndings.length > 0 &&
      (allowedEndings[0] === ModuleSpecifierEnding.Minimal || allowedEndings[0] === ModuleSpecifierEnding.Index) &&
      fileExtensionIsOneOf(name, ['.js', '.jsx', '.ts', '.tsx', '.d.ts'])
    )
      return { name: removeFileExtension(name), extension: tryGetExtensionFromPath(name) };
    const outputExtension = tryGetJSExtensionForFile(name, this.options);
    if (outputExtension !== '') return { name: changeExtension(name, outputExtension), extension: outputExtension };
    return { name, extension: tryGetExtensionFromPath(name) };
  }
}

function getDeclarationEmitExtensionForPath(path: string): string {
  if (fileExtensionIsOneOf(path, ['.mjs', '.mts'])) return '.d.mts';
  if (fileExtensionIsOneOf(path, ['.cjs', '.cts'])) return '.d.cts';
  if (path.endsWith('.json')) return '.d.json.ts';
  return '.d.ts';
}

function getPossibleOriginalInputExtensionForExtension(path: string): string[] {
  if (fileExtensionIsOneOf(path, ['.d.mts', '.mjs', '.mts'])) return ['.mts', '.mjs'];
  if (fileExtensionIsOneOf(path, ['.d.cts', '.cjs', '.cts'])) return ['.cts', '.cjs'];
  if (path.endsWith('.d.json.ts')) return ['.json'];
  return ['.tsx', '.ts', '.jsx', '.js'];
}

function getFileExtension(fileName: string): string {
  const extension = tryGetExtensionFromPath(fileName);
  return extension !== '' ? extension : getAnyExtensionFromPath(fileName);
}

interface Pattern {
  text: string;
  starIndex: number;
}

function tryParsePattern(pattern: string): Pattern | undefined {
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) return { text: pattern, starIndex: -1 };
  if (pattern.indexOf('*', starIndex + 1) !== -1) return undefined;
  return { text: pattern, starIndex };
}

function patternMatches(pattern: Pattern, candidate: string): boolean {
  if (pattern.starIndex === -1) return pattern.text === candidate;
  const prefix = pattern.text.substring(0, pattern.starIndex);
  const suffix = pattern.text.substring(pattern.starIndex + 1);
  return (
    candidate.length >= prefix.length + suffix.length && candidate.startsWith(prefix) && candidate.endsWith(suffix)
  );
}

function getPatternFromFirstMatchingCondition(target: JsonValue, conditions: string[]): string {
  if (target.type === 'string') return target.value;
  if (target.type === 'object')
    for (const [condition, value] of target.entries)
      if (
        condition === 'default' ||
        conditions.includes(condition) ||
        (conditions.includes('types') && isApplicableVersionedTypesKey(condition))
      )
        return getPatternFromFirstMatchingCondition(value, conditions);
  return '';
}

/** The fields of a package.json that path completions read. */
class PackageJsonContents {
  readonly imports: JsonValue | undefined;
  readonly exports: JsonValue | undefined;
  private readonly root: JsonValue | undefined;

  constructor(text: string) {
    this.root = parseJson(text);
    const root = this.root;
    this.imports = root !== undefined && root.type === 'object' ? root.entries.get('imports') : undefined;
    this.exports = root !== undefined && root.type === 'object' ? root.entries.get('exports') : undefined;
  }

  dependencyNames(): string[] {
    const names: string[] = [];
    const root = this.root;
    if (root === undefined || root.type !== 'object') return names;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = root.entries.get(field);
      if (deps !== undefined && deps.type === 'object') for (const name of deps.entries.keys()) names.push(name);
    }
    return names;
  }
}

function forEachAncestorDirectory(directoryIn: string, callback: (directory: string) => boolean | void): void {
  let directory = directoryIn;
  for (;;) {
    if (callback(directory) === true) return;
    const parent = getDirectoryPath(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function getFragmentDirectory(fragment: string): string {
  if (!fragment.includes('/')) return '';
  return hasTrailingDirectorySeparator(fragment) ? fragment : getDirectoryPath(fragment);
}

function getBaseDirectoriesFromRootDirs(
  rootDirs: string[],
  basePath: string,
  scriptDirectory: string,
  ignoreCase: boolean,
): string[] {
  const normalizedRootDirs = rootDirs.map((r) =>
    ensureTrailingDirectorySeparator(normalizePath(isRootedDiskPath(r) ? r : combinePaths(basePath, r))),
  );
  let relativeDirectory = '';
  for (const rootDirectory of normalizedRootDirs) {
    if (containsPath(rootDirectory, scriptDirectory, !ignoreCase, basePath)) {
      relativeDirectory =
        rootDirectory.length > scriptDirectory.length ? '' : scriptDirectory.substring(rootDirectory.length);
      break;
    }
  }
  const directories = normalizedRootDirs.map((r) =>
    removeTrailingDirectorySeparator(combinePaths(r, relativeDirectory)),
  );
  directories.push(removeTrailingDirectorySeparator(scriptDirectory));
  return [...new Set(directories)];
}

function tryRemoveDirectoryPrefix(
  path: string,
  prefix: string,
  useCaseSensitiveFileNames: boolean,
): string | undefined {
  if (
    !getCanonicalFileName(path, useCaseSensitiveFileNames).startsWith(
      getCanonicalFileName(prefix, useCaseSensitiveFileNames),
    )
  )
    return undefined;
  let withoutPrefix = path.substring(prefix.length);
  if (withoutPrefix.startsWith('/') || withoutPrefix.startsWith('\\')) withoutPrefix = withoutPrefix.substring(1);
  return withoutPrefix;
}

function moduleResolutionUsesNodeModules(kind: ModuleResolutionKind): boolean {
  return (
    (kind >= ModuleResolutionKind.Node16 && kind <= ModuleResolutionKind.NodeNext) ||
    kind === ModuleResolutionKind.Bundler
  );
}

function isPathRelativeToScript(path: string): boolean {
  return path.startsWith('./') || path.startsWith('../');
}

function stripQuotes(name: string): string {
  if (name.length < 2) return name;
  const first = name.charCodeAt(0);
  if (first === name.charCodeAt(name.length - 1) && (first === 0x27 || first === 0x22 || first === 0x60))
    return name.substring(1, name.length - 1);
  return name;
}

/** The ambient modules among the globals, then the pattern ambient modules not among them. */
function getAmbientModules(c: Checker): Symbol[] {
  const result: Symbol[] = [];
  const seen = new Set<Symbol>();
  for (const [name, symbol] of c.globals)
    if (isAmbientModuleSymbolName(name)) {
      const merged = getMergedSymbol(c, symbol);
      result.push(merged);
      seen.add(merged);
    }
  for (const pattern of c.patternAmbientModules) {
    const merged = getMergedSymbol(c, pattern.symbol);
    if (!seen.has(merged)) {
      result.push(merged);
      seen.add(merged);
    }
  }
  return result;
}

/** The name an ambient module is declared with; a pattern module with import attributes has another symbol name. */
function getAmbientModuleName(symbol: Symbol): string {
  for (const declaration of getDeclarations(symbol)) {
    if (isExternalModuleAugmentation(declaration) || isGlobalScopeAugmentation(declaration)) continue;
    const name = declaration.kind === SyntaxKind.ModuleDeclaration ? getName(declaration) : undefined;
    if (name !== undefined && name.kind === SyntaxKind.StringLiteral) return getText(name);
    break;
  }
  return stripQuotes(symbol.name);
}

function getAmbientModuleCompletions(c: Checker, fragment: string, fragmentDirectory: string): string[] {
  const names: string[] = [];
  for (const symbol of getAmbientModules(c)) {
    const moduleName = getAmbientModuleName(symbol);
    if (moduleName.startsWith(fragment) && !moduleName.includes('*')) names.push(moduleName);
  }
  if (fragmentDirectory === '') return names;
  const withSeparator = ensureTrailingDirectorySeparator(fragmentDirectory);
  return names.map((n) => (n.startsWith(withSeparator) ? n.substring(withSeparator.length) : n));
}

function toPathCompletions(names: ModuleCompletion[]): PathCompletion[] {
  return names.map((n) => ({
    name: n.name,
    kind:
      n.kind === ModuleCompletionKind.Directory
        ? ScriptElementKind.Directory
        : n.kind === ModuleCompletionKind.File
          ? ScriptElementKind.ScriptElement
          : ScriptElementKind.ExternalModuleName,
    extension: n.extension,
  }));
}

export function getStringLiteralCompletionsFromModuleNames(
  program: Program,
  c: Checker,
  file: SourceFile,
  node: Node,
): PathCompletion[] {
  return toPathCompletions(new PathCompletions(program, c).fromModuleNames(file, node));
}

export function isInReferenceComment(file: SourceFile, position: number): boolean {
  const token = getTokenAtPosition(file, position);
  if (token === undefined) return false;
  const range = isInComment(file, position, token);
  if (range === undefined) return false;
  return hasTripleSlashPrefix(file.text.substring(range.pos, range.end));
}

function hasTripleSlashPrefix(commentText: string): boolean {
  return commentText.startsWith('///') && commentText.substring(3).trim().startsWith('<');
}

function isWhiteSpaceLikeChar(ch: number): boolean {
  return (
    ch === 0x20 ||
    ch === 0x09 ||
    ch === 0x0a ||
    ch === 0x0d ||
    ch === 0x0b ||
    ch === 0x0c ||
    ch === 0xa0 ||
    ch === 0xfeff
  );
}

function trimLeftWhiteSpace(text: string): string {
  let i = 0;
  while (i < text.length && isWhiteSpaceLikeChar(text.charCodeAt(i))) i++;
  return text.substring(i);
}

interface TripleSlashFragment {
  prefix: string;
  kind: string;
  toComplete: string;
}

/** `/// <reference path="fragment`, without the closing quote. */
function parseTripleSlashDirectiveFragment(text: string): TripleSlashFragment | undefined {
  if (!text.startsWith('///')) return undefined;
  let rest = trimLeftWhiteSpace(text.substring(3));
  if (!rest.startsWith('<reference')) return undefined;
  rest = rest.substring('<reference'.length);
  if (rest.length === 0 || !isWhiteSpaceLikeChar(rest.charCodeAt(0))) return undefined;
  rest = trimLeftWhiteSpace(rest);
  let kind: string;
  if (rest.startsWith('path')) kind = 'path';
  else if (rest.startsWith('types')) kind = 'types';
  else return undefined;
  rest = trimLeftWhiteSpace(rest.substring(kind.length));
  if (!rest.startsWith('=')) return undefined;
  rest = trimLeftWhiteSpace(rest.substring(1));
  if (rest.length === 0 || (rest[0] !== "'" && rest[0] !== '"')) return undefined;
  rest = rest.substring(1);
  if (rest.includes("'") || rest.includes('"')) return undefined;
  return { prefix: text.substring(0, text.length - rest.length), kind, toComplete: rest };
}

export function getTripleSlashReferenceCompletions(
  program: Program,
  file: SourceFile,
  position: number,
): PathCompletion[] | undefined {
  const token = getTokenAtPosition(file, position);
  if (token === undefined) return undefined;
  const ranges = getLeadingCommentRanges(file.text, token.pos) ?? [];
  const range = ranges.find((r) => position >= r.pos && position <= r.end);
  if (range === undefined) return undefined;
  const fragment = parseTripleSlashDirectiveFragment(file.text.substring(range.pos, position));
  if (fragment === undefined) return undefined;
  const scriptPath = getDirectoryPath(file.path);
  const completions = new PathCompletions(program, undefined);
  if (fragment.kind === 'path') {
    const options = completions.extensionOptions(ReferenceKind.FileName, file, ModuleKind.None);
    return toPathCompletions(
      completions
        .forDirectoryFragment(fragment.toComplete, scriptPath, options, true, file.path, new ModuleCompletionSet())
        .values(),
    );
  }
  const options = completions.extensionOptions(ReferenceKind.ModuleSpecifier, file, ModuleKind.None);
  const result = new ModuleCompletionSet();
  completions.fromTypings(scriptPath, getFragmentDirectory(fragment.toComplete), options, result);
  return toPathCompletions(result.values());
}
