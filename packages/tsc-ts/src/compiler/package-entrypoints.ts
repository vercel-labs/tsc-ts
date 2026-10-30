// The files a package offers for import and the module specifiers that reach them, as tsgo's
// GetEntrypointsFromPackageJsonInfo finds them for auto-imports, and the ending a specifier takes in an importing file.
import type { FileSystem } from './file-system.js';
import type { Resolver } from './module-resolution.js';
import {
  getJSExtensionForDeclarationFileExtension,
  ModuleSpecifierEnding,
  tryGetJSExtensionForFile,
} from './module-specifiers.js';
import type { CompilerOptions } from './options.js';
import { isApplicableVersionedTypesKey, type JsonValue, JsonObjectKind, type PackageJsonInfo } from './package-json.js';
import {
  changeExtension,
  comparePaths,
  fileExtensionIsOneOf,
  getDeclarationFileExtension,
  getPathComponents,
  getRelativePathFromDirectory,
  normalizePath,
  removeExtension,
  removeFileExtension,
  resolvePath,
} from './path.js';
import { readDirectory, unlimitedDepth } from './vfs-match.js';

/** Whether the file name and extension of an entrypoint's module specifier can change. */
export const enum EntrypointEnding {
  /** The specifier cannot change without changing what it resolves to. */
  Fixed,
  /** The extension came from a file on disk, so an interchangeable one can be used (`.d.ts` as `.js`). */
  ExtensionChangeable,
  /**
   * The file name and extension came from a file on disk outside an `exports` pattern, so they follow the
   * importing file's resolution rules (an `/index.d.ts` may be dropped).
   */
  Changeable,
}

/** A file a package offers for import, with the module specifier that reaches it. */
export class ResolvedEntrypoint {
  constructor(
    /** The path the entrypoint was found at when that is a symlink, else `''`. */
    readonly originalFileName: string,
    /** The real path of the file. */
    readonly resolvedFileName: string,
    readonly moduleSpecifier: string,
    readonly ending: EntrypointEnding,
    /** The conditions a resolver needs to reach this entrypoint. */
    readonly includeConditions: ReadonlySet<string> | undefined,
    /** The conditions a resolver must not have to reach this entrypoint. */
    readonly excludeConditions: ReadonlySet<string> | undefined,
  ) {}

  symlinkOrRealpath(): string {
    return this.originalFileName !== '' ? this.originalFileName : this.resolvedFileName;
  }
}

// TypeScript and declaration files.
const entrypointExtensions = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts'];

/**
 * The entrypoints of a package: what its `exports` lead to, or else its main file and, with `enableDirectorySearch`,
 * every TypeScript and declaration file in it outside `node_modules`. Undefined for none.
 */
export function getEntrypointsFromPackageJsonInfo(
  resolver: Resolver,
  fs: FileSystem,
  info: PackageJsonInfo,
  packageName: string,
  enableDirectorySearch: boolean,
): ResolvedEntrypoint[] | undefined {
  const exports = info.contents?.exports;
  if (exports !== undefined) return new ExportMapWalker(resolver, fs, info, packageName).walk(exports);

  const result: ResolvedEntrypoint[] = [];
  const main = resolver.loadPackageMainEntrypoint(info);
  if (main !== '') {
    result.push(createEntrypoint(fs, main, packageName, undefined, undefined, EntrypointEnding.Fixed));
  }
  if (enableDirectorySearch) {
    const directory = info.packageDirectory;
    const files = readDirectory(
      fs,
      directory,
      directory,
      entrypointExtensions,
      ['node_modules'],
      ['**/*'],
      unlimitedDepth,
    );
    for (const file of files) {
      if (main !== '' && comparePaths(file, main, fs.useCaseSensitiveFileNames) === 0) continue;
      const relative = getRelativePathFromDirectory(directory, file, fs.useCaseSensitiveFileNames);
      result.push(
        createEntrypoint(fs, file, packageName + '/' + relative, undefined, undefined, EntrypointEnding.Changeable),
      );
    }
  }
  return result.length > 0 ? result : undefined;
}

function createEntrypoint(
  fs: FileSystem,
  fileName: string,
  moduleSpecifier: string,
  includeConditions: ReadonlySet<string> | undefined,
  excludeConditions: ReadonlySet<string> | undefined,
  ending: EntrypointEnding,
): ResolvedEntrypoint {
  const realpath = normalizePath(fs.realpath(fileName));
  return realpath !== fileName
    ? new ResolvedEntrypoint(fileName, realpath, moduleSpecifier, ending, includeConditions, excludeConditions)
    : new ResolvedEntrypoint('', fileName, moduleSpecifier, ending, includeConditions, excludeConditions);
}

// Walks an `exports` value, collecting the entrypoint of each target and the conditions that reach it.
class ExportMapWalker {
  readonly entrypoints: ResolvedEntrypoint[] = [];

  constructor(
    private readonly resolver: Resolver,
    private readonly fs: FileSystem,
    private readonly info: PackageJsonInfo,
    private readonly packageName: string,
  ) {}

  walk(exports: JsonValue): ResolvedEntrypoint[] {
    if (exports.type === 'array') {
      for (const element of exports.items) this.target('.', undefined, undefined, element);
    } else if (exports.type === 'object' && exports.kind === JsonObjectKind.Subpaths) {
      for (const [subpath, target] of exports.entries) this.target(subpath, undefined, undefined, target);
    } else {
      this.target('.', undefined, undefined, exports);
    }
    return this.entrypoints;
  }

  private target(
    subpath: string,
    includeConditions: Set<string> | undefined,
    excludeConditionsIn: Set<string> | undefined,
    exports: JsonValue,
  ): void {
    let excludeConditions = excludeConditionsIn;
    if (exports.type === 'string' && exports.value.startsWith('./')) {
      const target = exports.value;
      // A target with `.` or `..` after its leading `./` offers nothing, as in tsc; for a pattern this also keeps the
      // directory search inside the package. A literal target into `node_modules` offers nothing either.
      const partsAfterFirst = getPathComponents(target).slice(2);
      if (partsAfterFirst.includes('..') || partsAfterFirst.includes('.')) return;
      if (target.includes('*')) this.patternTarget(subpath, includeConditions, excludeConditions, target);
      else {
        if (partsAfterFirst.includes('node_modules')) return;
        const candidate = resolvePath(this.info.packageDirectory, target);
        const resolved = this.resolver.loadPackageExportTargetEntrypoint(this.info.packageDirectory, candidate, target);
        if (resolved !== '') {
          this.entrypoints.push(
            createEntrypoint(
              this.fs,
              resolved,
              resolvePath(this.packageName, subpath),
              includeConditions,
              excludeConditions,
              target.endsWith('*') ? EntrypointEnding.ExtensionChangeable : EntrypointEnding.Fixed,
            ),
          );
        }
      }
    } else if (exports.type === 'array') {
      for (const element of exports.items) this.target(subpath, includeConditions, excludeConditions, element);
    } else if (exports.type === 'object') {
      const previousConditions: string[] = [];
      for (const [condition, conditionTarget] of exports.entries) {
        if (excludeConditions?.has(condition) === true) continue;
        const alwaysMatches =
          condition === 'default' || condition === 'types' || isApplicableVersionedTypesKey(condition);
        let newIncludeConditions = includeConditions;
        if (!alwaysMatches) {
          // A later condition is reached only without the earlier ones; the exclusions carry over to the
          // conditions after it, as tsgo keeps them.
          newIncludeConditions = includeConditions === undefined ? new Set<string>() : new Set(includeConditions);
          if (excludeConditions !== undefined) excludeConditions = new Set(excludeConditions);
          newIncludeConditions.add(condition);
          for (const previous of previousConditions) {
            excludeConditions ??= new Set();
            excludeConditions.add(previous);
          }
        }
        previousConditions.push(condition);
        this.target(subpath, newIncludeConditions, excludeConditions, conditionTarget);
        if (alwaysMatches) break;
      }
    }
  }

  // A target with a `*`: each file the pattern matches.
  private patternTarget(
    subpath: string,
    includeConditions: Set<string> | undefined,
    excludeConditions: Set<string> | undefined,
    target: string,
  ): void {
    const star = target.indexOf('*');
    if (star !== target.lastIndexOf('*')) return;
    const directory = this.info.packageDirectory;
    const include = changeFullExtension(target.replace('*', '**/*'), '.*');
    const patternPath = target.slice('./'.length);
    const leading = patternPath.slice(0, patternPath.indexOf('*'));
    const trailing = patternPath.slice(patternPath.indexOf('*') + 1);
    const caseSensitive = this.fs.useCaseSensitiveFileNames;
    const files = readDirectory(this.fs, directory, directory, entrypointExtensions, [], [include], unlimitedDepth);
    for (const file of files) {
      const relative = getRelativePathFromDirectory(directory, file, caseSensitive);
      const matchedStar = getMatchedStarForPatternEntrypoint(relative, leading, trailing, caseSensitive);
      if (matchedStar === undefined) continue;
      let resolvedSubpath = subpath.replace('*', matchedStar);
      if (resolvedSubpath.startsWith('./')) resolvedSubpath = resolvedSubpath.slice('./'.length);
      if (resolvedSubpath === '') continue;
      this.entrypoints.push(
        createEntrypoint(
          this.fs,
          file,
          this.packageName + '/' + resolvedSubpath,
          includeConditions,
          excludeConditions,
          target.endsWith('*') ? EntrypointEnding.ExtensionChangeable : EntrypointEnding.Fixed,
        ),
      );
    }
  }
}

// The text a pattern's `*` matches in a package file, also with the file's JavaScript extension in place of its own.
function getMatchedStarForPatternEntrypoint(
  file: string,
  leading: string,
  trailing: string,
  caseSensitive: boolean,
): string | undefined {
  if (hasPrefixAndSuffixWithoutOverlap(file, leading, trailing, caseSensitive)) {
    return file.slice(leading.length, file.length - trailing.length);
  }
  const jsExtension = tryGetJSExtensionForFile(file, {});
  if (jsExtension !== '') {
    const swapped = changeFullExtension(file, jsExtension);
    if (hasPrefixAndSuffixWithoutOverlap(swapped, leading, trailing, caseSensitive)) {
      return swapped.slice(leading.length, swapped.length - trailing.length);
    }
  }
  return undefined;
}

function hasPrefixAndSuffixWithoutOverlap(
  text: string,
  prefix: string,
  suffix: string,
  caseSensitive: boolean,
): boolean {
  if (prefix.length + suffix.length > text.length) return false;
  if (caseSensitive) return text.startsWith(prefix) && text.endsWith(suffix);
  const lower = text.toLowerCase();
  return lower.startsWith(prefix.toLowerCase()) && lower.endsWith(suffix.toLowerCase());
}

/** Replaces the extension, taking a declaration extension from its `.d`. */
function changeFullExtension(path: string, newExtension: string): string {
  const declarationExtension = getDeclarationFileExtension(path);
  if (declarationExtension === '') return changeExtension(path, newExtension);
  return path.slice(0, path.length - declarationExtension.length) + newExtension;
}

/**
 * The module specifier of an entrypoint as `importingFile` writes it: a fixed specifier as it is, others with the
 * extension or file name the importing file's preferred ending gives them.
 */
export function processEntrypointEnding(
  entrypoint: ResolvedEntrypoint,
  options: CompilerOptions,
  allowedEndings: readonly ModuleSpecifierEnding[],
): string {
  let specifier = entrypoint.moduleSpecifier;
  if (entrypoint.ending === EntrypointEnding.Fixed) return specifier;
  const preferredEnding = allowedEndings[0]!;

  const dtsExtension = getDeclarationFileExtension(specifier);
  if (dtsExtension !== '') {
    const withJsExtension = (): string =>
      removeExtension(specifier, dtsExtension) + getJSExtensionForDeclarationFileExtension(dtsExtension);
    switch (preferredEnding) {
      case ModuleSpecifierEnding.TsExtension:
      case ModuleSpecifierEnding.JsExtension:
        return withJsExtension();
      case ModuleSpecifierEnding.Minimal:
      case ModuleSpecifierEnding.Index:
        if (entrypoint.ending === EntrypointEnding.Changeable && dtsExtension === '.d.ts') {
          specifier = removeExtension(specifier, dtsExtension);
          if (preferredEnding === ModuleSpecifierEnding.Minimal) specifier = trimSuffix(specifier, '/index');
          return specifier;
        }
        // `.d.mts` and `.d.cts` keep an extension; an extension changeable entrypoint keeps one too.
        return withJsExtension();
    }
    return specifier;
  }

  if (fileExtensionIsOneOf(specifier, ['.ts', '.tsx', '.mts', '.cts'])) {
    switch (preferredEnding) {
      case ModuleSpecifierEnding.TsExtension:
        return specifier;
      case ModuleSpecifierEnding.JsExtension: {
        const jsExtension = tryGetJSExtensionForFile(specifier, options);
        return jsExtension !== '' ? removeFileExtension(specifier) + jsExtension : specifier;
      }
      case ModuleSpecifierEnding.Minimal:
      case ModuleSpecifierEnding.Index: {
        if (entrypoint.ending === EntrypointEnding.Changeable) {
          specifier = removeFileExtension(specifier);
          if (preferredEnding === ModuleSpecifierEnding.Minimal) specifier = trimSuffix(specifier, '/index');
          return specifier;
        }
        const jsExtension = tryGetJSExtensionForFile(specifier, options);
        return jsExtension !== '' ? removeFileExtension(specifier) + jsExtension : specifier;
      }
    }
    return specifier;
  }

  if (fileExtensionIsOneOf(specifier, ['.js', '.jsx', '.mjs', '.cjs'])) {
    switch (preferredEnding) {
      case ModuleSpecifierEnding.Minimal:
      case ModuleSpecifierEnding.Index:
        if (entrypoint.ending === EntrypointEnding.Changeable) {
          specifier = removeFileExtension(specifier);
          if (preferredEnding === ModuleSpecifierEnding.Minimal) specifier = trimSuffix(specifier, '/index');
        }
        return specifier;
    }
  }
  return specifier;
}

function trimSuffix(text: string, suffix: string): string {
  return text.endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text;
}
