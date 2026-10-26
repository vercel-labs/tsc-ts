/**
 * Path utilities with TypeScript's semantics.
 *
 * Paths use `/` as the separator. A root is `/`, `//server/`, `c:/`, `^/` or a URL prefix such as `file:///`.
 */

/** A normalized absolute path in canonical case, used as a map key. */
export type Path = string & { readonly __pathBrand: never };

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const COLON = 0x3a;

export const supportedDeclarationExtensions: readonly string[] = ['.d.ts', '.d.cts', '.d.mts'];
export const supportedTSImplementationExtensions: readonly string[] = ['.ts', '.tsx', '.mts', '.cts'];
export const supportedJSExtensionsFlat: readonly string[] = ['.js', '.jsx', '.mjs', '.cjs'];
export const supportedTSExtensionsFlat: readonly string[] = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.cts',
  '.d.cts',
  '.mts',
  '.d.mts',
];
export const supportedTSExtensionsWithJsonFlat: readonly string[] = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.cts',
  '.d.cts',
  '.mts',
  '.d.mts',
  '.json',
];

const tsExtensionsForExtract: readonly string[] = ['.d.ts', '.d.cts', '.d.mts', '.ts', '.tsx', '.mts', '.cts'];
const extensionsToRemove: readonly string[] = [
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.mjs',
  '.mts',
  '.cjs',
  '.cts',
  '.ts',
  '.js',
  '.tsx',
  '.jsx',
  '.json',
];

function isAnyDirectorySeparator(ch: number): boolean {
  return ch === SLASH || ch === BACKSLASH;
}

function isVolumeCharacter(ch: number): boolean {
  return (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x41 && ch <= 0x5a);
}

export function normalizeSlashes(path: string): string {
  return path.indexOf('\\') < 0 ? path : path.replaceAll('\\', '/');
}

function fileUrlVolumeSeparatorEnd(url: string, start: number): number {
  if (url.length <= start) return -1;
  const ch0 = url.charCodeAt(start);
  if (ch0 === COLON) return start + 1;
  if (ch0 === 0x25 && url.length > start + 2 && url.charCodeAt(start + 1) === 0x33) {
    const ch2 = url.charCodeAt(start + 2);
    if (ch2 === 0x61 || ch2 === 0x41) return start + 3;
  }
  return -1;
}

/** Root length of `path`, bitwise-negated (`~n`) for URLs and 0 for relative paths. */
export function getEncodedRootLength(path: string): number {
  const length = path.length;
  if (length === 0) return 0;
  const ch0 = path.charCodeAt(0);

  // POSIX or UNC
  if (ch0 === SLASH || ch0 === BACKSLASH) {
    if (length === 1 || path.charCodeAt(1) !== ch0) return 1;
    const p1 = path.indexOf(ch0 === SLASH ? '/' : '\\', 2);
    if (p1 < 0) return length;
    return p1 + 1;
  }

  // DOS
  if (isVolumeCharacter(ch0) && length > 1 && path.charCodeAt(1) === COLON) {
    if (length === 2) return 2;
    if (isAnyDirectorySeparator(path.charCodeAt(2))) return 3;
  }

  // Untitled
  if (ch0 === 0x5e && length > 1 && path.charCodeAt(1) === SLASH) return 2;

  // URL
  const schemeEnd = path.indexOf('://');
  if (schemeEnd !== -1) {
    const authorityStart = schemeEnd + 3;
    const authorityEnd = path.indexOf('/', authorityStart);
    if (authorityEnd !== -1) {
      const scheme = path.slice(0, schemeEnd);
      const authority = path.slice(authorityStart, authorityEnd);
      if (
        scheme === 'file' &&
        (authority === '' || authority === 'localhost') &&
        path.length > authorityEnd + 2 &&
        isVolumeCharacter(path.charCodeAt(authorityEnd + 1))
      ) {
        const volumeSeparatorEnd = fileUrlVolumeSeparatorEnd(path, authorityEnd + 2);
        if (volumeSeparatorEnd !== -1) {
          if (volumeSeparatorEnd === path.length) return ~volumeSeparatorEnd;
          if (path.charCodeAt(volumeSeparatorEnd) === SLASH) return ~(volumeSeparatorEnd + 1);
        }
      }
      return ~(authorityEnd + 1);
    }
    return ~length;
  }

  return 0;
}

export function getRootLength(path: string): number {
  const rootLength = getEncodedRootLength(path);
  return rootLength < 0 ? ~rootLength : rootLength;
}

export function isUrl(path: string): boolean {
  return getEncodedRootLength(path) < 0;
}

/** True for `/x`, `c:/x` and other disk roots (not URLs). */
export function isRootedDiskPath(path: string): boolean {
  return getEncodedRootLength(path) > 0;
}

/**
 * Whether Windows may resolve `path` over the network: a UNC path (`//server/share`), a Win32 device path
 * (`//?/…`, `//./…`) or an NT object path (`/??/…`), with either separator. Device and object paths count even
 * for local volumes, since their `UNC` and `GLOBALROOT` forms reach the network redirector. Accessing one can
 * make Windows authenticate to an arbitrary host, so such paths are never accessed on any platform.
 */
export function isNetworkPath(path: string): boolean {
  if (path.length < 2 || !isAnyDirectorySeparator(path.charCodeAt(0))) return false;
  if (isAnyDirectorySeparator(path.charCodeAt(1))) return true;
  return (
    path.length >= 3 &&
    path.charCodeAt(1) === 0x3f &&
    path.charCodeAt(2) === 0x3f &&
    (path.length === 3 || isAnyDirectorySeparator(path.charCodeAt(3)))
  );
}

/** Whether a path written in a config or on the command line names a network location once resolved. */
export function isNetworkPathValue(value: string, basePath: string): boolean {
  return isNetworkPath(getNormalizedAbsolutePath(value, basePath));
}

export function pathIsAbsolute(path: string): boolean {
  return getEncodedRootLength(path) !== 0;
}

/** True for `.`, `..`, and paths starting with `./` or `../`. */
export function pathIsRelative(path: string): boolean {
  const length = path.length;
  if (length === 0 || path.charCodeAt(0) !== DOT) return false;
  if (length === 1) return true;
  const ch1 = path.charCodeAt(1);
  if (isAnyDirectorySeparator(ch1)) return true;
  if (ch1 !== DOT) return false;
  return length === 2 || isAnyDirectorySeparator(path.charCodeAt(2));
}

/** Relative module names and rooted paths are never looked up in `node_modules`. */
export function isExternalModuleNameRelative(moduleName: string): boolean {
  return pathIsRelative(moduleName) || isRootedDiskPath(moduleName);
}

export function hasTrailingDirectorySeparator(path: string): boolean {
  return path.length > 0 && isAnyDirectorySeparator(path.charCodeAt(path.length - 1));
}

export function removeTrailingDirectorySeparator(path: string): string {
  return hasTrailingDirectorySeparator(path) ? path.slice(0, -1) : path;
}

export function removeTrailingDirectorySeparators(path: string): string {
  let end = path.length;
  while (end > 0 && isAnyDirectorySeparator(path.charCodeAt(end - 1))) end--;
  return end === path.length ? path : path.slice(0, end);
}

export function ensureTrailingDirectorySeparator(path: string): string {
  return hasTrailingDirectorySeparator(path) ? path : path + '/';
}

/** Joins `path` onto `base`; an absolute `path` replaces `base`. Does not resolve `.` or `..`. */
export function combinePaths(base: string, path: string): string {
  base = normalizeSlashes(base);
  if (path === '') return base;
  path = normalizeSlashes(path);
  if (base === '' || getRootLength(path) !== 0) return path;
  return hasTrailingDirectorySeparator(base) ? base + path : base + '/' + path;
}

/** Splits a path into its root followed by its segments, dropping a trailing empty segment. */
export function getPathComponents(path: string, currentDirectory = ''): string[] {
  path = combinePaths(currentDirectory, path);
  const rootLength = getRootLength(path);
  const components = [path.slice(0, rootLength)];
  const rest = path.slice(rootLength);
  if (rest !== '') {
    const parts = rest.split('/');
    const count = parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
    for (let i = 0; i < count; i++) components.push(parts[i]!);
  }
  return components;
}

/** Removes `.`, empty and resolvable `..` components. */
export function reducePathComponents(components: readonly string[]): string[] {
  if (components.length === 0) return [];
  const reduced = [components[0]!];
  for (let i = 1; i < components.length; i++) {
    const component = components[i]!;
    if (component === '' || component === '.') continue;
    if (component === '..') {
      if (reduced.length > 1) {
        if (reduced[reduced.length - 1] !== '..') {
          reduced.pop();
          continue;
        }
      } else if (reduced[0] !== '') {
        continue;
      }
    }
    reduced.push(component);
  }
  return reduced;
}

export function getPathFromPathComponents(components: readonly string[]): string {
  if (components.length === 0) return '';
  let root = components[0]!;
  if (root !== '') root = ensureTrailingDirectorySeparator(root);
  return root + components.slice(1).join('/');
}

/** The path without its last segment; a root is returned as is. */
export function getDirectoryPath(path: string): string {
  path = normalizeSlashes(path);
  const rootLength = getRootLength(path);
  if (rootLength === path.length) return path;
  path = removeTrailingDirectorySeparator(path);
  return path.slice(0, Math.max(rootLength, path.lastIndexOf('/')));
}

/** The last segment of the path, or `''` for a root. */
export function getBaseFileName(path: string): string {
  path = normalizeSlashes(path);
  const rootLength = getRootLength(path);
  if (rootLength === path.length) return '';
  path = removeTrailingDirectorySeparator(path);
  return path.slice(Math.max(getRootLength(path), path.lastIndexOf('/') + 1));
}

/** Whether `p` contains a `.`/`..` segment or `//`. */
function hasRelativePathSegment(p: string): boolean {
  const n = p.length;
  if (n === 0) return false;
  // A `.` or `..` segment either starts the path or follows a `/`; substring searches run natively,
  // which beats reading every code unit of these long, mostly ASCII paths.
  if (p.charCodeAt(0) === DOT) {
    if (n === 1 || p.charCodeAt(1) === SLASH) return true;
    if (p.charCodeAt(1) === DOT && (n === 2 || p.charCodeAt(2) === SLASH)) return true;
  }
  if (p.charCodeAt(n - 1) === DOT) {
    if (n >= 2 && p.charCodeAt(n - 2) === SLASH) return true;
    if (n >= 3 && p.charCodeAt(n - 2) === DOT && p.charCodeAt(n - 3) === SLASH) return true;
  }
  return p.indexOf('//') >= 0 || p.indexOf('/./') >= 0 || p.indexOf('/../') >= 0;
}

/** Normalizes paths that only need `/./` or a leading `./` removed; `undefined` otherwise. */
function simpleNormalizePath(path: string): string | undefined {
  if (!hasRelativePathSegment(path)) return path;
  const simplified = path.indexOf('/./') < 0 ? path : path.replaceAll('/./', '/');
  const trimmed = simplified.startsWith('./') ? simplified.slice(2) : simplified;
  if (
    trimmed !== path &&
    !hasRelativePathSegment(trimmed) &&
    !(trimmed !== simplified && trimmed.charCodeAt(0) === SLASH)
  ) {
    return trimmed;
  }
  return undefined;
}

/** Resolves `fileName` against `currentDirectory` and removes `.`, `..` and duplicate separators. */
export function getNormalizedAbsolutePath(fileName: string, currentDirectory: string): string {
  let rootLength = getRootLength(fileName);
  fileName =
    rootLength === 0 && currentDirectory !== '' ? combinePaths(currentDirectory, fileName) : normalizeSlashes(fileName);
  rootLength = getRootLength(fileName);

  const simple = simpleNormalizePath(fileName);
  if (simple !== undefined) {
    const length = simple.length;
    if (length > rootLength) return removeTrailingDirectorySeparator(simple);
    if (length === rootLength && rootLength !== 0) return ensureTrailingDirectorySeparator(simple);
    return simple;
  }

  const length = fileName.length;
  const root = fileName.slice(0, rootLength);
  let changed = false;
  let normalized = '';
  let index = rootLength;
  let normalizedUpTo = index;
  let seenNonDotDotSegment = rootLength !== 0;
  while (index < length) {
    let segmentStart = index;
    let ch = fileName.charCodeAt(index);
    while (ch === SLASH) {
      index++;
      if (index < length) ch = fileName.charCodeAt(index);
      else break;
    }
    if (index > segmentStart) {
      // Superfluous separator.
      if (!changed) {
        normalized = fileName.slice(0, Math.max(rootLength, segmentStart - 1));
        changed = true;
      }
      if (index === length) break;
      segmentStart = index;
    }
    let segmentEnd = fileName.indexOf('/', index + 1);
    if (segmentEnd === -1) segmentEnd = length;
    const segmentLength = segmentEnd - segmentStart;
    if (segmentLength === 1 && fileName.charCodeAt(index) === DOT) {
      if (!changed) {
        normalized = fileName.slice(0, normalizedUpTo);
        changed = true;
      }
    } else if (segmentLength === 2 && fileName.charCodeAt(index) === DOT && fileName.charCodeAt(index + 1) === DOT) {
      if (!seenNonDotDotSegment) {
        if (changed) {
          normalized += normalized.length === rootLength ? '..' : '/..';
        } else {
          normalizedUpTo = index + 2;
        }
      } else if (!changed) {
        if (normalizedUpTo - 1 >= 0) {
          const lastSlash = normalizedUpTo - 1 > 0 ? fileName.lastIndexOf('/', normalizedUpTo - 2) : -1;
          normalized = fileName.slice(0, Math.max(rootLength, lastSlash));
        } else {
          normalized = fileName.slice(0, normalizedUpTo);
        }
        changed = true;
        seenNonDotDotSegment = isNonDotDotPrefix(normalized, rootLength);
      } else {
        const lastSlash = normalized.lastIndexOf('/');
        normalized = lastSlash !== -1 ? normalized.slice(0, Math.max(rootLength, lastSlash)) : root;
        seenNonDotDotSegment = isNonDotDotPrefix(normalized, rootLength);
      }
    } else if (changed) {
      if (normalized.length !== rootLength) normalized += '/';
      seenNonDotDotSegment = true;
      normalized += fileName.slice(segmentStart, segmentEnd);
    } else {
      seenNonDotDotSegment = true;
      normalizedUpTo = segmentEnd;
    }
    index = segmentEnd + 1;
  }
  if (changed) return normalized;
  if (length > rootLength) return removeTrailingDirectorySeparators(fileName);
  if (length === rootLength) return ensureTrailingDirectorySeparator(fileName);
  return fileName;
}

function isNonDotDotPrefix(normalized: string, rootLength: number): boolean {
  return (normalized.length !== rootLength || rootLength !== 0) && normalized !== '..' && !normalized.endsWith('/..');
}

/** Removes `.`, `..` and duplicate separators, keeping a trailing separator. */
export function normalizePath(path: string): string {
  path = normalizeSlashes(path);
  const normalized = getNormalizedAbsolutePath(path, '');
  return normalized !== '' && hasTrailingDirectorySeparator(path)
    ? ensureTrailingDirectorySeparator(normalized)
    : normalized;
}

/** Combines and normalizes, keeping a trailing separator. */
export function resolvePath(base: string, path: string): string {
  return normalizePath(combinePaths(base, path));
}

/**
 * Lower-cases a file name for case-insensitive comparison. `İ` (U+0130) is kept as is since its lower-case form is
 * two characters.
 */
export function toFileNameLowerCase(fileName: string): string {
  const length = fileName.length;
  let needsLower = false;
  for (let i = 0; i < length; i++) {
    const c = fileName.charCodeAt(i);
    if (c >= 0x80) return toFileNameLowerCaseUnicode(fileName);
    if (c >= 0x41 && c <= 0x5a) needsLower = true;
  }
  return needsLower ? fileName.toLowerCase() : fileName;
}

function toFileNameLowerCaseUnicode(fileName: string): string {
  let result = '';
  for (let i = 0; i < fileName.length;) {
    const c = fileName.codePointAt(i) ?? 0;
    i += c > 0xffff ? 2 : 1;
    result += String.fromCodePoint(c === 0x130 ? c : lowerCodePoint(c));
  }
  return result;
}

export function getCanonicalFileName(fileName: string, useCaseSensitiveFileNames: boolean): string {
  return useCaseSensitiveFileNames ? fileName : toFileNameLowerCase(fileName);
}

export function toPath(fileName: string, basePath: string, useCaseSensitiveFileNames: boolean): Path {
  const path = isRootedDiskPath(fileName) ? normalizePath(fileName) : getNormalizedAbsolutePath(fileName, basePath);
  return getCanonicalFileName(path, useCaseSensitiveFileNames) as Path;
}

/** Lower-cases one code point (simple mapping only). */
function lowerCodePoint(c: number): number {
  if (c < 0x80) return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
  const lower = String.fromCodePoint(c).toLowerCase();
  return lower.length === (c > 0xffff ? 2 : 1) ? (lower.codePointAt(0) ?? c) : c;
}

/** Compares strings by lower-cased code points. */
export function compareStringsCaseInsensitive(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  for (;;) {
    if (i >= a.length) return j >= b.length ? 0 : -1;
    if (j >= b.length) return 1;
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
    if (ca === cb) continue;
    const la = lowerCodePoint(ca);
    const lb = lowerCodePoint(cb);
    if (la !== lb) return la < lb ? -1 : 1;
  }
}

export function equateStringsCaseInsensitive(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return compareStringsCaseInsensitive(a, b) === 0;
  for (let i = 0; i < a.length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca >= 0x80 || cb >= 0x80) return compareStringsCaseInsensitive(a, b) === 0;
    if ((ca | 0x20) !== (cb | 0x20) || (ca | 0x20) < 0x61 || (ca | 0x20) > 0x7a) return false;
  }
  return true;
}

function compareStrings(a: string, b: string, ignoreCase: boolean): number {
  if (ignoreCase) return compareStringsCaseInsensitive(a, b);
  return a === b ? 0 : a < b ? -1 : 1;
}

function equateStrings(a: string, b: string, ignoreCase: boolean): boolean {
  return ignoreCase ? equateStringsCaseInsensitive(a, b) : a === b;
}

/** Compares two paths after resolving them against `currentDirectory`. */
export function comparePaths(a: string, b: string, useCaseSensitiveFileNames: boolean, currentDirectory = ''): number {
  a = combinePaths(currentDirectory, a);
  b = combinePaths(currentDirectory, b);
  if (a === b) return 0;
  if (a === '') return -1;
  if (b === '') return 1;
  const aRootLength = getRootLength(a);
  const bRootLength = getRootLength(b);
  const rootResult = compareStringsCaseInsensitive(a.slice(0, aRootLength), b.slice(0, bRootLength));
  if (rootResult !== 0) return rootResult;
  const aRest = a.slice(aRootLength);
  const bRest = b.slice(bRootLength);
  const ignoreCase = !useCaseSensitiveFileNames;
  if (!hasRelativePathSegment(aRest) && !hasRelativePathSegment(bRest)) return compareStrings(aRest, bRest, ignoreCase);
  const aComponents = reducePathComponents(getPathComponents(a));
  const bComponents = reducePathComponents(getPathComponents(b));
  const shared = Math.min(aComponents.length, bComponents.length);
  for (let i = 1; i < shared; i++) {
    const result = compareStrings(aComponents[i]!, bComponents[i]!, ignoreCase);
    if (result !== 0) return result;
  }
  return aComponents.length === bComponents.length ? 0 : aComponents.length < bComponents.length ? -1 : 1;
}

/** Whether `child` is `parent` or inside it. */
export function containsPath(
  parent: string,
  child: string,
  useCaseSensitiveFileNames: boolean,
  currentDirectory = '',
): boolean {
  parent = combinePaths(currentDirectory, parent);
  child = combinePaths(currentDirectory, child);
  if (parent === '' || child === '') return false;
  if (parent === child) return true;
  // Both in normal form, their components are their `/`-separated segments.
  if (useCaseSensitiveFileNames && isNormalPosixPath(parent) && isNormalPosixPath(child)) {
    return parent.length === 1 || (child.startsWith(parent) && child.charCodeAt(parent.length) === SLASH);
  }
  const parentComponents = reducePathComponents(getPathComponents(parent));
  const childComponents = reducePathComponents(getPathComponents(child));
  if (childComponents.length < parentComponents.length) return false;
  const ignoreCase = !useCaseSensitiveFileNames;
  for (let i = 0; i < parentComponents.length; i++) {
    const equal =
      i === 0
        ? equateStringsCaseInsensitive(parentComponents[i]!, childComponents[i]!)
        : equateStrings(parentComponents[i]!, childComponents[i]!, ignoreCase);
    if (!equal) return false;
  }
  return true;
}

/**
 * Whether `path` is rooted at a single `/` and has no backslash, no empty, `.` or `..` segment and
 * no trailing `/` (but may be the root itself), so that `getPathComponents` and
 * `reducePathComponents` give `/` followed by its segments.
 */
function isNormalPosixPath(path: string): boolean {
  const n = path.length;
  if (n === 0 || path.charCodeAt(0) !== SLASH) return false;
  if (n === 1) return true;
  let segmentStart = 1;
  for (let i = 1; i <= n; i++) {
    const c = i < n ? path.charCodeAt(i) : SLASH;
    if (c === BACKSLASH) return false;
    if (c !== SLASH) continue;
    const length = i - segmentStart;
    if (length === 0) return false;
    if (
      path.charCodeAt(segmentStart) === DOT &&
      (length === 1 || (length === 2 && path.charCodeAt(segmentStart + 1) === DOT))
    )
      return false;
    segmentStart = i + 1;
  }
  return true;
}

export function getPathComponentsRelativeTo(
  from: string,
  to: string,
  useCaseSensitiveFileNames: boolean,
  currentDirectory = '',
): string[] {
  const fromComponents = reducePathComponents(getPathComponents(from, currentDirectory));
  const toComponents = reducePathComponents(getPathComponents(to, currentDirectory));
  const ignoreCase = !useCaseSensitiveFileNames;
  let start = 0;
  const maxCommon = Math.min(fromComponents.length, toComponents.length);
  for (; start < maxCommon; start++) {
    const equal =
      start === 0
        ? equateStringsCaseInsensitive(fromComponents[start]!, toComponents[start]!)
        : equateStrings(fromComponents[start]!, toComponents[start]!, ignoreCase);
    if (!equal) break;
  }
  if (start === 0) return toComponents;
  const result = [''];
  for (let i = start; i < fromComponents.length; i++) result.push('..');
  for (let i = start; i < toComponents.length; i++) result.push(toComponents[i]!);
  return result;
}

/** The path from directory `from` to `to`; both must be absolute or both relative. */
export function getRelativePathFromDirectory(
  from: string,
  to: string,
  useCaseSensitiveFileNames: boolean,
  currentDirectory = '',
): string {
  if (getRootLength(from) > 0 !== getRootLength(to) > 0) {
    throw new Error('paths must either both be absolute or both be relative');
  }
  return getPathFromPathComponents(getPathComponentsRelativeTo(from, to, useCaseSensitiveFileNames, currentDirectory));
}

/** The path from the directory of file `from` to `to`, prefixed with `./` unless absolute or dot-relative. */
export function getRelativePathFromFile(
  from: string,
  to: string,
  useCaseSensitiveFileNames: boolean,
  currentDirectory = '',
): string {
  return ensurePathIsNonModuleName(
    getRelativePathFromDirectory(getDirectoryPath(from), to, useCaseSensitiveFileNames, currentDirectory),
  );
}

/** Prefixes `./` to paths that would otherwise read as module names. */
export function ensurePathIsNonModuleName(path: string): string {
  return pathIsAbsolute(path) || pathIsRelative(path) ? path : './' + path;
}

//// Extensions

export function fileExtensionIs(path: string, extension: string): boolean {
  return path.length > extension.length && path.endsWith(extension);
}

export function fileExtensionIsOneOf(path: string, extensions: readonly string[]): boolean {
  for (let i = 0; i < extensions.length; i++) if (fileExtensionIs(path, extensions[i]!)) return true;
  return false;
}

/** Whether `ext` is a TypeScript extension, including arbitrary `.d.*.ts` declaration extensions. */
export function extensionIsTs(ext: string): boolean {
  return (
    ext === '.ts' ||
    ext === '.tsx' ||
    ext === '.d.ts' ||
    ext === '.mts' ||
    ext === '.d.mts' ||
    ext === '.cts' ||
    ext === '.d.cts' ||
    (ext.length >= 7 && ext.startsWith('.d.') && ext.endsWith('.ts'))
  );
}

/** Removes a known extension (including `.d.ts` forms). */
export function removeFileExtension(path: string): string {
  for (let i = 0; i < extensionsToRemove.length; i++) {
    const ext = extensionsToRemove[i]!;
    if (path.endsWith(ext)) return path.slice(0, path.length - ext.length);
  }
  return path;
}

/** The known extension of `path`, or `''`. */
export function tryGetExtensionFromPath(path: string): string {
  for (const extension of extensionsToRemove) {
    if (fileExtensionIs(path, extension)) return extension;
  }
  return '';
}

export function removeExtension(path: string, extension: string): string {
  return path.slice(0, path.length - extension.length);
}

/** The TypeScript or declaration extension of `fileName`, or `''`. */
export function tryExtractTSExtension(fileName: string): string {
  for (const extension of tsExtensionsForExtract) {
    if (fileExtensionIs(fileName, extension)) return extension;
  }
  return '';
}

export function hasTSFileExtension(path: string): boolean {
  return fileExtensionIsOneOf(path, supportedTSExtensionsFlat);
}

export function hasImplementationTSFileExtension(path: string): boolean {
  return fileExtensionIsOneOf(path, supportedTSImplementationExtensions) && !isDeclarationFileName(path);
}

export function hasJSFileExtension(path: string): boolean {
  return fileExtensionIsOneOf(path, supportedJSExtensionsFlat);
}

/** `.d.ts`, `.d.mts`, `.d.cts` or `.d.<ext>.ts` of the base name, or `''`. */
export function getDeclarationFileExtension(fileName: string): string {
  const base = getBaseFileName(fileName);
  for (let i = 0; i < supportedDeclarationExtensions.length; i++) {
    if (base.endsWith(supportedDeclarationExtensions[i]!)) return supportedDeclarationExtensions[i]!;
  }
  if (base.endsWith('.ts')) {
    const index = base.indexOf('.d.');
    if (index >= 0) return base.slice(index);
  }
  return '';
}

export function isDeclarationFileName(fileName: string): boolean {
  return getDeclarationFileExtension(fileName) !== '';
}

/** The extension from the last `.` of the base name, or `''`. */
export function getAnyExtensionFromPath(path: string): string {
  const base = getBaseFileName(path);
  const index = base.lastIndexOf('.');
  return index >= 0 ? base.slice(index) : '';
}

/** Replaces a known extension of `path` with `newExtension`. */
export function changeExtension(path: string, newExtension: string): string {
  const trimmed = removeTrailingDirectorySeparator(path);
  for (const ext of extensionsToRemove) {
    if (trimmed.length >= ext.length && trimmed.endsWith(ext)) {
      const result = path.slice(0, path.length - ext.length);
      if (newExtension === '') return result;
      return newExtension.startsWith('.') ? result + newExtension : result + '.' + newExtension;
    }
  }
  return path;
}

/** Source extensions that could have produced an output with the extension of `path`. */
export function getPossibleOriginalInputExtensionForExtension(path: string): readonly string[] {
  if (fileExtensionIs(path, '.d.mts') || fileExtensionIs(path, '.mjs') || fileExtensionIs(path, '.mts')) {
    return ['.mts', '.mjs'];
  }
  if (fileExtensionIs(path, '.d.cts') || fileExtensionIs(path, '.cjs') || fileExtensionIs(path, '.cts')) {
    return ['.cts', '.cjs'];
  }
  const ext = getDeclarationFileExtension(path);
  if (ext !== '' && ext !== '.d.ts') return ['.' + ext.slice(3, ext.length - 3)];
  return ['.tsx', '.ts', '.jsx', '.js'];
}
