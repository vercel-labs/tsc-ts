/**
 * `package.json` as module resolution reads it.
 *
 * Fields keep the JSON type they were written with, so resolution can trace
 * "Expected type of 'main' field in 'package.json' to be 'string', got 'number'".
 */

import { Diagnostics, messageWithArgs, type MessageWithArgs } from './diagnostics.js';
import { toPath, type Path } from './path.js';

export const typeScriptVersion = '7.0.2';
export const typeScriptVersionMajorMinor = '7.0';

//// JSON values

export type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

/** How an object in `exports` or `imports` is interpreted, from the first character of its keys. */
export const enum JsonObjectKind {
  /** No key starts with `.` or `#` (also used for empty objects). */
  Conditions,
  /** Keys start with `.`. */
  Subpaths,
  /** Keys start with `#`. */
  Imports,
  /** Keys mix `.`/`#` with other keys. */
  Invalid,
}

export interface JsonNull {
  readonly type: 'null';
}
export interface JsonBoolean {
  readonly type: 'boolean';
  readonly value: boolean;
}
export interface JsonNumber {
  readonly type: 'number';
  readonly value: number;
}
export interface JsonString {
  readonly type: 'string';
  readonly value: string;
}
export interface JsonArray {
  readonly type: 'array';
  readonly items: readonly JsonValue[];
}
export interface JsonObject {
  readonly type: 'object';
  /** Entries in source order; a repeated key keeps its first position and its last value. */
  readonly entries: ReadonlyMap<string, JsonValue>;
  readonly kind: JsonObjectKind;
}

export type JsonValue = JsonNull | JsonBoolean | JsonNumber | JsonString | JsonArray | JsonObject;

const JSON_NULL: JsonNull = { type: 'null' };
const JSON_TRUE: JsonBoolean = { type: 'boolean', value: true };
const JSON_FALSE: JsonBoolean = { type: 'boolean', value: false };

/**
 * JavaScript-style falsiness as tsgo checks it for `exports`.
 * Numbers are never falsy there, matching tsgo.
 */
export function isFalsyJson(value: JsonValue | undefined): boolean {
  if (value === undefined) return true;
  switch (value.type) {
    case 'null':
      return true;
    case 'string':
      return value.value === '';
    case 'boolean':
      return !value.value;
    default:
      return false;
  }
}

function objectKind(entries: ReadonlyMap<string, JsonValue>): JsonObjectKind {
  let seenDot = false;
  let seenHash = false;
  let seenOther = false;
  for (const key of entries.keys()) {
    if (key.length === 0) continue;
    const c = key.charCodeAt(0);
    if (c === 0x2e) seenDot = true;
    else if (c === 0x23) seenHash = true;
    else seenOther = true;
  }
  if (seenOther && (seenDot || seenHash)) return JsonObjectKind.Invalid;
  if (seenDot) return JsonObjectKind.Subpaths;
  if (seenHash) return JsonObjectKind.Imports;
  return JsonObjectKind.Conditions;
}

/** Strict RFC 8259 parser. Any error makes the whole document unparseable. */
export class JsonParser {
  pos = 0;

  constructor(readonly text: string) {}

  skipWhitespace(): void {
    const text = this.text;
    let pos = this.pos;
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
      pos++;
    }
    this.pos = pos;
  }

  /** Consumes `literal` if it is next. */
  eat(literal: string): boolean {
    if (!this.text.startsWith(literal, this.pos)) return false;
    this.pos += literal.length;
    return true;
  }

  peek(): number {
    return this.pos < this.text.length ? this.text.charCodeAt(this.pos) : -1;
  }

  /** Parses the value at `pos` (after whitespace); `undefined` on error. */
  value(): JsonValue | undefined {
    this.skipWhitespace();
    const c = this.peek();
    if (c === 0x7b) return this.object();
    if (c === 0x5b) return this.array();
    if (c === 0x22) {
      const s = this.string();
      return s === undefined ? undefined : { type: 'string', value: s };
    }
    if (c === 0x74) return this.literal('true', JSON_TRUE);
    if (c === 0x66) return this.literal('false', JSON_FALSE);
    if (c === 0x6e) return this.literal('null', JSON_NULL);
    const n = this.number();
    return n === undefined ? undefined : { type: 'number', value: n };
  }

  literal(text: string, value: JsonValue): JsonValue | undefined {
    if (this.eat(text)) return value;
    return undefined;
  }

  object(): JsonObject | undefined {
    this.pos++;
    const entries = new Map<string, JsonValue>();
    this.skipWhitespace();
    if (this.peek() === 0x7d) {
      this.pos++;
      return { type: 'object', entries, kind: JsonObjectKind.Conditions };
    }
    for (;;) {
      const key = this.key();
      if (key === undefined) return undefined;
      const value = this.value();
      if (value === undefined) return undefined;
      entries.set(key, value);
      if (!this.endOfMember(0x7d)) return undefined;
      if (this.peek() === 0x7d) {
        this.pos++;
        return { type: 'object', entries, kind: objectKind(entries) };
      }
    }
  }

  array(): JsonArray | undefined {
    this.pos++;
    const items: JsonValue[] = [];
    this.skipWhitespace();
    if (this.peek() === 0x5d) {
      this.pos++;
      return { type: 'array', items };
    }
    for (;;) {
      const item = this.value();
      if (item === undefined) return undefined;
      items.push(item);
      if (!this.endOfMember(0x5d)) return undefined;
      if (this.peek() === 0x5d) {
        this.pos++;
        return { type: 'array', items };
      }
    }
  }

  /** Reads `"key":`, leaving `pos` after the colon. */
  key(): string | undefined {
    this.skipWhitespace();
    if (this.peek() !== 0x22) return undefined;
    const key = this.string();
    if (key === undefined) return undefined;
    this.skipWhitespace();
    if (this.peek() !== 0x3a) return undefined;
    this.pos++;
    return key;
  }

  /** After a member: consumes `,` (requiring another member) or stops before `close`. */
  endOfMember(close: number): boolean {
    this.skipWhitespace();
    const c = this.peek();
    if (c === close) return true;
    if (c !== 0x2c) return false;
    this.pos++;
    this.skipWhitespace();
    return this.peek() !== close;
  }

  /** Validates a value without building it. */
  skip(): boolean {
    this.skipWhitespace();
    const c = this.peek();
    if (c === 0x7b) {
      this.pos++;
      this.skipWhitespace();
      if (this.peek() === 0x7d) {
        this.pos++;
        return true;
      }
      for (;;) {
        if (this.key() === undefined || !this.skip() || !this.endOfMember(0x7d)) return false;
        if (this.peek() === 0x7d) {
          this.pos++;
          return true;
        }
      }
    }
    if (c === 0x5b) {
      this.pos++;
      this.skipWhitespace();
      if (this.peek() === 0x5d) {
        this.pos++;
        return true;
      }
      for (;;) {
        if (!this.skip() || !this.endOfMember(0x5d)) return false;
        if (this.peek() === 0x5d) {
          this.pos++;
          return true;
        }
      }
    }
    return this.value() !== undefined;
  }

  string(): string | undefined {
    const text = this.text;
    let pos = this.pos + 1;
    let start = pos;
    let result = '';
    for (;;) {
      if (pos >= text.length) return undefined;
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        this.pos = pos + 1;
        return result + text.slice(start, pos);
      }
      if (c < 0x20) return undefined;
      if (c !== 0x5c) {
        pos++;
        continue;
      }
      result += text.slice(start, pos);
      const e = pos + 1 < text.length ? text.charCodeAt(pos + 1) : -1;
      pos += 2;
      switch (e) {
        case 0x22:
          result += '"';
          break;
        case 0x5c:
          result += '\\';
          break;
        case 0x2f:
          result += '/';
          break;
        case 0x62:
          result += '\b';
          break;
        case 0x66:
          result += '\f';
          break;
        case 0x6e:
          result += '\n';
          break;
        case 0x72:
          result += '\r';
          break;
        case 0x74:
          result += '\t';
          break;
        case 0x75: {
          const unit = hex4(text, pos);
          if (unit < 0) return undefined;
          pos += 4;
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = text.startsWith('\\u', pos) ? hex4(text, pos + 2) : -1;
            if (low < 0xdc00 || low > 0xdfff) return undefined;
            pos += 6;
            result += String.fromCharCode(unit, low);
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return undefined;
          } else {
            result += String.fromCharCode(unit);
          }
          break;
        }
        default:
          return undefined;
      }
      start = pos;
    }
  }

  number(): number | undefined {
    const text = this.text;
    const start = this.pos;
    let pos = start;
    if (text.charCodeAt(pos) === 0x2d) pos++;
    const first = pos < text.length ? text.charCodeAt(pos) : -1;
    const integerStart = pos;
    if (first === 0x30) pos++;
    else if (first >= 0x31 && first <= 0x39) pos = digits(text, pos);
    else return undefined;
    const next = pos < text.length ? text.charCodeAt(pos) : -1;
    if (next !== 0x2e && next !== 0x65 && next !== 0x45 && pos - integerStart <= 15) {
      // An integer of up to 15 digits, which its digits give exactly.
      let value = 0;
      for (let i = integerStart; i < pos; i++) value = value * 10 + (text.charCodeAt(i) - 0x30);
      this.pos = pos;
      return integerStart > start ? -value : value;
    }
    if (text.charCodeAt(pos) === 0x2e) {
      const end = digits(text, pos + 1);
      if (end === pos + 1) return undefined;
      pos = end;
    }
    const e = pos < text.length ? text.charCodeAt(pos) : -1;
    if (e === 0x65 || e === 0x45) {
      pos++;
      const sign = pos < text.length ? text.charCodeAt(pos) : -1;
      if (sign === 0x2b || sign === 0x2d) pos++;
      const end = digits(text, pos);
      if (end === pos) return undefined;
      pos = end;
    }
    this.pos = pos;
    return Number(text.slice(start, pos));
  }
}

function digits(text: string, pos: number): number {
  while (pos < text.length) {
    const c = text.charCodeAt(pos);
    if (c < 0x30 || c > 0x39) break;
    pos++;
  }
  return pos;
}

function hex4(text: string, pos: number): number {
  if (pos + 4 > text.length) return -1;
  let value = 0;
  for (let i = pos; i < pos + 4; i++) {
    const c = text.charCodeAt(i);
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
    else return -1;
    value = value * 16 + d;
  }
  return value;
}

/** Parses a JSON document; `undefined` if it is not valid JSON. */
export function parseJson(text: string): JsonValue | undefined {
  const parser = new JsonParser(text);
  const value = parser.value();
  if (value === undefined) return undefined;
  parser.skipWhitespace();
  return parser.pos === text.length ? value : undefined;
}

//// package.json

/** A field read with an expected JSON type. */
export interface Expected<T> {
  /** JSON type as written, or `undefined` when absent. */
  readonly actualType: JsonType | undefined;
  /** The value, if it ever had the expected type. */
  readonly value: T | undefined;
  readonly isNull: boolean;
}

const ABSENT_STRING: Expected<string> = { actualType: undefined, value: undefined, isNull: false };
const ABSENT_MAP: Expected<ReadonlyMap<string, string>> = { actualType: undefined, value: undefined, isNull: false };

/** `typesVersions` paths for the entry matching the compiler version. */
export interface VersionPaths {
  /** The matching `typesVersions` key. */
  readonly version: string;
  /** Values are never `undefined`; the type matches compiler options' `paths`. */
  readonly paths: ReadonlyMap<string, readonly string[] | undefined>;
}

export class PackageJson {
  name = ABSENT_STRING;
  version = ABSENT_STRING;
  type = ABSENT_STRING;
  tsconfig = ABSENT_STRING;
  main = ABSENT_STRING;
  types = ABSENT_STRING;
  typings = ABSENT_STRING;
  dependencies = ABSENT_MAP;
  peerDependencies = ABSENT_MAP;
  optionalDependencies = ABSENT_MAP;
  typesVersions: JsonValue | undefined = undefined;
  imports: JsonValue | undefined = undefined;
  exports: JsonValue | undefined = undefined;
  /** False when the text was not valid JSON; all fields are then absent. */
  parseable = true;

  private versionPathsRead = false;
  private versionPaths: VersionPaths | undefined = undefined;
  private readonly versionTraces: MessageWithArgs[] = [];

  /** Names in `dependencies`, `peerDependencies` and `optionalDependencies`. */
  getRuntimeDependencyNames(): Set<string> {
    const names = new Set<string>();
    for (const field of [this.dependencies, this.peerDependencies, this.optionalDependencies])
      if (field.value !== undefined) for (const name of field.value.keys()) names.add(name);
    return names;
  }

  /** The `typesVersions` paths for this compiler version, appending what was checked to `traces`. */
  getVersionPaths(traces: MessageWithArgs[] | undefined): VersionPaths | undefined {
    if (!this.versionPathsRead) {
      this.versionPathsRead = true;
      this.versionPaths = this.readVersionPaths();
    }
    if (traces !== undefined) for (const trace of this.versionTraces) traces.push(trace);
    return this.versionPaths;
  }

  private readVersionPaths(): VersionPaths | undefined {
    const traces = this.versionTraces;
    const typesVersions = this.typesVersions;
    if (typesVersions === undefined) {
      traces.push(messageWithArgs(Diagnostics.X_package_json_does_not_have_a_0_field, 'typesVersions'));
      return undefined;
    }
    if (typesVersions.type !== 'object') {
      traces.push(
        messageWithArgs(
          Diagnostics.Expected_type_of_0_field_in_package_json_to_be_1_got_2,
          'typesVersions',
          'object',
          typesVersions.type,
        ),
      );
      return undefined;
    }
    traces.push(
      messageWithArgs(
        Diagnostics.X_package_json_has_a_typesVersions_field_with_version_specific_path_mappings,
        'typesVersions',
      ),
    );
    for (const [key, value] of typesVersions.entries) {
      const range = parseVersionRange(key);
      if (range === undefined) {
        traces.push(
          messageWithArgs(Diagnostics.X_package_json_has_a_typesVersions_entry_0_that_is_not_a_valid_semver_range, key),
        );
        continue;
      }
      if (!versionRangeMatches(range, TYPESCRIPT_VERSION)) continue;
      if (value.type !== 'object') {
        traces.push(
          messageWithArgs(
            Diagnostics.Expected_type_of_0_field_in_package_json_to_be_1_got_2,
            "typesVersions['" + key + "']",
            'object',
            value.type,
          ),
        );
        return undefined;
      }
      // An empty key matches every version but, as in tsgo, yields no paths.
      return key === '' ? undefined : { version: key, paths: versionPathsFromJson(value) };
    }
    traces.push(
      messageWithArgs(
        Diagnostics.X_package_json_does_not_have_a_typesVersions_entry_that_matches_version_0,
        typeScriptVersionMajorMinor,
      ),
    );
    return undefined;
  }
}

function versionPathsFromJson(value: JsonObject): Map<string, string[] | undefined> {
  const paths = new Map<string, string[] | undefined>();
  for (const [key, entry] of value.entries) {
    if (entry.type !== 'array') continue;
    const substitutions: string[] = [];
    for (const item of entry.items) substitutions.push(item.type === 'string' ? item.value : '');
    paths.set(key, substitutions);
  }
  return paths;
}

/** A repeated key re-reads into the previous value, as Go's JSON decoding does. */
function readStringField(previous: Expected<string>, value: JsonValue): Expected<string> {
  if (value.type === 'null') return { actualType: 'null', value: undefined, isNull: true };
  if (value.type === 'string') return { actualType: 'string', value: value.value, isNull: previous.isNull };
  return { actualType: value.type, value: previous.value, isNull: previous.isNull };
}

function readStringMapField(
  previous: Expected<ReadonlyMap<string, string>>,
  value: JsonValue,
): Expected<ReadonlyMap<string, string>> {
  if (value.type === 'null') return { actualType: 'null', value: undefined, isNull: true };
  if (value.type !== 'object') return { actualType: value.type, value: previous.value, isNull: previous.isNull };
  const map = previous.value === undefined ? new Map<string, string>() : new Map(previous.value);
  for (const [key, entry] of value.entries) {
    if (entry.type === 'string') map.set(key, entry.value);
    else if (entry.type === 'null') map.set(key, '');
    else return { actualType: 'object', value: previous.value, isNull: previous.isNull };
  }
  return { actualType: 'object', value: map, isNull: previous.isNull };
}

function unparseable(): PackageJson {
  const result = new PackageJson();
  result.parseable = false;
  return result;
}

/** Parses `package.json` text. Invalid JSON yields a `PackageJson` with every field absent. */
export function parsePackageJson(text: string): PackageJson {
  const parser = new JsonParser(text);
  const result = new PackageJson();
  parser.skipWhitespace();
  if (parser.eat('null')) {
    parser.skipWhitespace();
    return parser.pos === text.length ? result : unparseable();
  }
  if (parser.peek() !== 0x7b) return unparseable();
  parser.pos++;
  parser.skipWhitespace();
  if (parser.peek() === 0x7d) {
    parser.pos++;
  } else {
    for (;;) {
      const key = parser.key();
      if (key === undefined) return unparseable();
      if (!readField(parser, result, key)) return unparseable();
      if (!parser.endOfMember(0x7d)) return unparseable();
      if (parser.peek() === 0x7d) {
        parser.pos++;
        break;
      }
    }
  }
  parser.skipWhitespace();
  return parser.pos === text.length ? result : unparseable();
}

function readField(parser: JsonParser, result: PackageJson, key: string): boolean {
  switch (key) {
    case 'name':
    case 'version':
    case 'type':
    case 'tsconfig':
    case 'main':
    case 'types':
    case 'typings':
    case 'typesVersions':
    case 'imports':
    case 'exports':
    case 'dependencies':
    case 'peerDependencies':
    case 'optionalDependencies':
      break;
    default:
      return parser.skip();
  }
  const value = parser.value();
  if (value === undefined) return false;
  switch (key) {
    case 'name':
      result.name = readStringField(result.name, value);
      break;
    case 'version':
      result.version = readStringField(result.version, value);
      break;
    case 'type':
      result.type = readStringField(result.type, value);
      break;
    case 'tsconfig':
      result.tsconfig = readStringField(result.tsconfig, value);
      break;
    case 'main':
      result.main = readStringField(result.main, value);
      break;
    case 'types':
      result.types = readStringField(result.types, value);
      break;
    case 'typings':
      result.typings = readStringField(result.typings, value);
      break;
    case 'typesVersions':
      result.typesVersions = value;
      break;
    case 'imports':
      result.imports = value;
      break;
    case 'exports':
      result.exports = value;
      break;
    case 'dependencies':
      result.dependencies = readStringMapField(result.dependencies, value);
      break;
    case 'peerDependencies':
      result.peerDependencies = readStringMapField(result.peerDependencies, value);
      break;
    case 'optionalDependencies':
      result.optionalDependencies = readStringMapField(result.optionalDependencies, value);
      break;
  }
  return true;
}

//// package.json lookup cache

/** A `package.json` lookup: the directory searched and, if the file exists, its contents. */
export interface PackageJsonInfo {
  readonly packageDirectory: string;
  readonly directoryExists: boolean;
  readonly contents: PackageJson | undefined;
}

/**
 * A `package.json` lookup as build info records it: the directory searched, whether the file exists,
 * and whether the directory does.
 */
export class PackageJsonLookup {
  constructor(
    readonly packageDirectory: string,
    readonly exists: boolean,
    readonly directoryExists: boolean,
  ) {}
}

/** `info` with `packageDirectory` spelled as the caller looked it up. */
export function withPackageDirectory(info: PackageJsonInfo, packageDirectory: string): PackageJsonInfo {
  if (info.packageDirectory === packageDirectory) return info;
  return { packageDirectory, directoryExists: info.directoryExists, contents: info.contents };
}

/** `package.json` lookups keyed by file path; the first entry stored for a path wins. */
// The lookups each cache shared with other threads (and so immutable) did not have yet when it was
// shared, as this thread made them.
const threadPackageJsonInfoCaches = new Map<PackageJsonInfoCache, Map<Path, PackageJsonInfo>>();

export class PackageJsonInfoCache {
  private readonly cache = new Map<Path, PackageJsonInfo>();
  private shared = false;

  constructor(
    readonly currentDirectory: string,
    readonly useCaseSensitiveFileNames: boolean,
  ) {}

  /**
   * Called before the cache is shared with other threads, which makes it immutable: from then on,
   * each thread keeps the lookups it adds in a table of its own. A cache already shared is immutable.
   */
  prepareForSharing(): void {
    if (!this.shared) this.shared = true;
  }

  get(packageJsonPath: string): PackageJsonInfo | undefined {
    return this.lookup(toPath(packageJsonPath, this.currentDirectory, this.useCaseSensitiveFileNames));
  }

  set(packageJsonPath: string, info: PackageJsonInfo): PackageJsonInfo {
    const key = toPath(packageJsonPath, this.currentDirectory, this.useCaseSensitiveFileNames);
    const existing = this.lookup(key);
    if (existing !== undefined) return existing;
    if (!this.shared) this.cache.set(key, info);
    else {
      let cache = threadPackageJsonInfoCaches.get(this);
      if (cache === undefined) {
        cache = new Map<Path, PackageJsonInfo>();
        threadPackageJsonInfoCaches.set(this, cache);
      }
      cache.set(key, info);
    }
    return info;
  }

  private lookup(key: Path): PackageJsonInfo | undefined {
    const info = this.cache.get(key);
    if (info !== undefined || !this.shared) return info;
    return threadPackageJsonInfoCaches.get(this)?.get(key);
  }

  /** The lookups made, in order (on this thread, once shared). */
  infos(): PackageJsonInfo[] {
    const infos = [...this.cache.values()];
    const own = this.shared ? threadPackageJsonInfoCaches.get(this) : undefined;
    if (own !== undefined) for (const info of own.values()) infos.push(info);
    return infos;
  }
}

//// Semantic version ranges, for `typesVersions` keys and `types@<range>` conditions

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

type Operator = '<' | '<=' | '=' | '>=' | '>';

interface Comparator {
  readonly operator: Operator;
  readonly operand: Version;
}

/** Alternatives (`||`) of comparator sets that must all hold. */
export type VersionRange = readonly (readonly Comparator[])[];

const TYPESCRIPT_VERSION: Version = { major: 7, minor: 0, patch: 2, prerelease: [] };
const VERSION_ZERO: Version = { major: 0, minor: 0, patch: 0, prerelease: ['0'] };
const PRERELEASE_ZERO: readonly string[] = ['0'];

interface PartialVersion {
  readonly version: Version;
  readonly majorWildcard: boolean;
  readonly minorWildcard: boolean;
  readonly patchWildcard: boolean;
}

function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

function isIdentifierChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x2d;
}

/** `[a-z0-9-+.*]` (case-insensitive), the characters of a range operand. */
function isOperandChar(c: number): boolean {
  return isIdentifierChar(c) || c === 0x2b || c === 0x2e || c === 0x2a;
}

function splitWhitespace(text: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (i >= text.length) break;
    const start = i;
    while (i < text.length && !isSpace(text.charCodeAt(i))) i++;
    parts.push(text.slice(start, i));
  }
  return parts;
}

function allOperandChars(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) if (!isOperandChar(text.charCodeAt(i))) return false;
  return true;
}

/** Parses an npm-style range such as `>=4.1`, `^3.0.0 || 5.x` or `1 - 2`; `undefined` if invalid. */
export function parseVersionRange(text: string): VersionRange | undefined {
  const alternatives: Comparator[][] = [];
  for (const part of text.trim().split('||')) {
    const range = part.trim();
    if (range === '') continue;
    const comparators: Comparator[] = [];
    const words = splitWhitespace(range);
    if (words.length === 3 && words[1] === '-' && allOperandChars(words[0]) && allOperandChars(words[2])) {
      if (!parseHyphen(words[0], words[2], comparators)) return undefined;
    } else {
      for (const word of words) {
        let operator = '';
        if (word.startsWith('<=') || word.startsWith('>=')) operator = word.slice(0, 2);
        else if (word.length > 0 && '~^<>='.indexOf(word[0]) >= 0) operator = word[0];
        const operand = word.slice(operator.length);
        if (!allOperandChars(operand)) return undefined;
        if (!parseComparator(operator, operand, comparators)) return undefined;
      }
    }
    alternatives.push(comparators);
  }
  return alternatives;
}

function parseHyphen(left: string, right: string, comparators: Comparator[]): boolean {
  const from = parsePartial(left);
  const to = parsePartial(right);
  if (from === undefined || to === undefined) return false;
  if (!from.majorWildcard) comparators.push({ operator: '>=', operand: from.version });
  if (!to.majorWildcard) {
    if (to.minorWildcard) comparators.push({ operator: '<', operand: incrementMajor(to.version) });
    else if (to.patchWildcard) comparators.push({ operator: '<', operand: incrementMinor(to.version) });
    else comparators.push({ operator: '<=', operand: to.version });
  }
  return true;
}

function parseComparator(operator: string, text: string, comparators: Comparator[]): boolean {
  const partial = parsePartial(text);
  if (partial === undefined) return false;
  const version = partial.version;
  if (partial.majorWildcard) {
    if (operator === '<' || operator === '>') comparators.push({ operator: '<', operand: VERSION_ZERO });
    return true;
  }
  switch (operator) {
    case '~':
      comparators.push({ operator: '>=', operand: version });
      comparators.push({
        operator: '<',
        operand: partial.minorWildcard ? incrementMajor(version) : incrementMinor(version),
      });
      return true;
    case '^': {
      let upper: Version;
      if (version.major > 0 || partial.minorWildcard) upper = incrementMajor(version);
      else if (version.minor > 0 || partial.patchWildcard) upper = incrementMinor(version);
      else upper = incrementPatch(version);
      comparators.push({ operator: '>=', operand: version });
      comparators.push({ operator: '<', operand: upper });
      return true;
    }
    case '<':
    case '>=':
      comparators.push({
        operator,
        operand: partial.minorWildcard || partial.patchWildcard ? withPrereleaseZero(version) : version,
      });
      return true;
    case '<=':
    case '>':
      if (partial.minorWildcard) {
        comparators.push({
          operator: operator === '<=' ? '<' : '>=',
          operand: withPrereleaseZero(incrementMajor(version)),
        });
      } else if (partial.patchWildcard) {
        comparators.push({
          operator: operator === '<=' ? '<' : '>=',
          operand: withPrereleaseZero(incrementMinor(version)),
        });
      } else {
        comparators.push({ operator, operand: version });
      }
      return true;
    default:
      if (partial.minorWildcard || partial.patchWildcard) {
        const upper = partial.minorWildcard ? incrementMajor(version) : incrementMinor(version);
        comparators.push({ operator: '>=', operand: withPrereleaseZero(version) });
        comparators.push({ operator: '<', operand: withPrereleaseZero(upper) });
      } else {
        comparators.push({ operator: '=', operand: version });
      }
      return true;
  }
}

function incrementMajor(v: Version): Version {
  return { major: v.major + 1, minor: 0, patch: 0, prerelease: [] };
}

function incrementMinor(v: Version): Version {
  return { major: v.major, minor: v.minor + 1, patch: 0, prerelease: [] };
}

function incrementPatch(v: Version): Version {
  return { major: v.major, minor: v.minor, patch: v.patch + 1, prerelease: [] };
}

function withPrereleaseZero(v: Version): Version {
  return { major: v.major, minor: v.minor, patch: v.patch, prerelease: PRERELEASE_ZERO };
}

function isWildcardChar(c: number): boolean {
  return c === 0x78 || c === 0x58 || c === 0x2a;
}

/**
 * Parses `major[.minor[.patch[-prerelease][+build]]]` where each number may be `x`, `X` or `*`.
 * Returns the end of a component, or -1.
 */
function scanComponent(text: string, pos: number): number {
  if (pos >= text.length) return -1;
  const c = text.charCodeAt(pos);
  if (isWildcardChar(c) || c === 0x30) return pos + 1;
  if (c < 0x31 || c > 0x39) return -1;
  return digits(text, pos + 1);
}

/** `[a-z0-9-.]+` (case-insensitive). */
function scanIdentifiers(text: string, pos: number): number {
  let end = pos;
  while (end < text.length) {
    const c = text.charCodeAt(end);
    if (!isIdentifierChar(c) && c !== 0x2e) break;
    end++;
  }
  return end;
}

/** A version component as a uint32, or -1 on overflow. */
function uintComponent(text: string): number {
  if (text.length > 10) return -1;
  const n = Number(text);
  return n > 4294967295 ? -1 : n;
}

function parsePartial(text: string): PartialVersion | undefined {
  const parts: string[] = [];
  let pos = 0;
  let prerelease = '';
  for (;;) {
    const end = scanComponent(text, pos);
    if (end < 0) return undefined;
    parts.push(text.slice(pos, end));
    pos = end;
    if (parts.length === 3 || pos >= text.length || text.charCodeAt(pos) !== 0x2e) break;
    pos++;
  }
  if (parts.length === 3) {
    if (text.charCodeAt(pos) === 0x2d) {
      const end = scanIdentifiers(text, pos + 1);
      if (end === pos + 1) return undefined;
      prerelease = text.slice(pos + 1, end);
      pos = end;
    }
    if (text.charCodeAt(pos) === 0x2b) {
      const end = scanIdentifiers(text, pos + 1);
      if (end === pos + 1) return undefined;
      pos = end;
    }
  }
  if (pos !== text.length) return undefined;

  const majorWildcard = isWildcard(parts[0]);
  const minorWildcard = parts.length < 2 || isWildcard(parts[1]);
  const patchWildcard = parts.length < 3 || isWildcard(parts[2]);
  let major = 0;
  let minor = 0;
  let patch = 0;
  if (!majorWildcard) {
    major = uintComponent(parts[0]);
    if (major < 0) return undefined;
    if (!minorWildcard) {
      minor = uintComponent(parts[1]);
      if (minor < 0) return undefined;
      if (!patchWildcard) {
        patch = uintComponent(parts[2]);
        if (patch < 0) return undefined;
      }
    }
  }
  return {
    version: { major, minor, patch, prerelease: prerelease === '' ? [] : prerelease.split('.') },
    majorWildcard,
    minorWildcard,
    patchWildcard,
  };
}

function isWildcard(text: string): boolean {
  return text === '*' || text === 'x' || text === 'X';
}

export function versionRangeMatches(range: VersionRange, version: Version): boolean {
  if (range.length === 0) return true;
  for (const comparators of range) {
    let all = true;
    for (const comparator of comparators) {
      if (!comparatorMatches(comparator, version)) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

function comparatorMatches(comparator: Comparator, version: Version): boolean {
  const c = compareVersions(version, comparator.operand);
  switch (comparator.operator) {
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '=':
      return c === 0;
    case '>=':
      return c >= 0;
    case '>':
      return c > 0;
  }
}

function compareNumbers(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareVersions(a: Version, b: Version): number {
  return (
    compareNumbers(a.major, b.major) ||
    compareNumbers(a.minor, b.minor) ||
    compareNumbers(a.patch, b.patch) ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0) return right.length === 0 ? 0 : 1;
  if (right.length === 0) return -1;
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const result = comparePrereleaseIdentifier(left[i], right[i]);
    if (result !== 0) return result;
  }
  return compareNumbers(left.length, right.length);
}

function isNumericIdentifier(text: string): boolean {
  if (text === '0') return true;
  if (text.length === 0) return false;
  const c = text.charCodeAt(0);
  return c >= 0x31 && c <= 0x39 && digits(text, 1) === text.length;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  if (left === right) return 0;
  const byString = left < right ? -1 : 1;
  const leftNumeric = isNumericIdentifier(left);
  const rightNumeric = isNumericIdentifier(right);
  if (!leftNumeric && !rightNumeric) return byString;
  if (!rightNumeric) return -1;
  if (!leftNumeric) return 1;
  const l = uintComponent(left);
  const r = uintComponent(right);
  if (l < 0 || r < 0) return left.length === right.length ? byString : compareNumbers(left.length, right.length);
  return compareNumbers(l, r);
}

/** Whether a `typesVersions` key or `types@<range>` condition range includes this compiler's version. */
export function versionRangeIncludesTypeScript(text: string): boolean {
  const range = parseVersionRange(text);
  return range !== undefined && versionRangeMatches(range, TYPESCRIPT_VERSION);
}

const versionedTypesKeys = new Map<string, boolean>();

/** Whether `key` is `types@<range>` with a range including this compiler's version. */
export function isApplicableVersionedTypesKey(key: string): boolean {
  if (!key.startsWith('types@')) return false;
  let result = versionedTypesKeys.get(key);
  if (result === undefined) {
    result = versionRangeIncludesTypeScript(key.slice(6));
    versionedTypesKeys.set(key, result);
  }
  return result;
}
