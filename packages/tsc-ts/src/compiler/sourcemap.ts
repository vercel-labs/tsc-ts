// Source map v3 generation: base64 VLQ mappings and the JSON document, as tsgo writes them.
import { getPathComponentsRelativeTo, getPathFromPathComponents, isRootedDiskPath } from './path.js';

const base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64DigitCodes = new Uint8Array(64);
for (let i = 0; i < 64; i++) base64DigitCodes[i] = base64Digits.charCodeAt(i);
const mappingsDecoder = new TextDecoder();

/** The path of `path` relative to `directory`, with absolute results as `file://` URLs. */
export function getRelativePathToDirectoryOrUrl(
  directory: string,
  path: string,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
): string {
  const components = getPathComponentsRelativeTo(directory, path, useCaseSensitiveFileNames, currentDirectory);
  const first = components[0]!;
  if (isRootedDiskPath(first)) components[0] = (first.charCodeAt(0) === 0x2f ? 'file://' : 'file:///') + first;
  return getPathFromPathComponents(components);
}

export class SourceMapGenerator {
  readonly file: string;
  readonly sourceRoot: string;
  private readonly sourcesDirectoryPath: string;
  private readonly useCaseSensitiveFileNames: boolean;
  private readonly currentDirectory: string;
  /** Source file names as added. */
  readonly rawSources: string[];
  private readonly sources: string[];
  private readonly sourceIndices: Map<string, number>;
  private readonly sourcesContent: (string | undefined)[];
  private readonly names: string[];
  /** The mappings as ASCII bytes; the first `mappingsLength` are used. */
  private mappings: Uint8Array;
  private mappingsLength: number;

  private lastGeneratedLine: number;
  private lastGeneratedCharacter: number;
  private lastSourceIndex: number;
  private lastSourceLine: number;
  private lastSourceCharacter: number;
  private lastNameIndex: number;
  private hasLast: boolean;

  private pendingGeneratedLine: number;
  private pendingGeneratedCharacter: number;
  private pendingSourceIndex: number;
  private pendingSourceLine: number;
  private pendingSourceCharacter: number;
  private pendingNameIndex: number;
  private hasPending: boolean;
  private hasPendingSource: boolean;
  private hasPendingName: boolean;

  constructor(
    file: string,
    sourceRoot: string,
    sourcesDirectoryPath: string,
    useCaseSensitiveFileNames: boolean,
    currentDirectory: string,
  ) {
    this.file = file;
    this.sourceRoot = sourceRoot;
    this.sourcesDirectoryPath = sourcesDirectoryPath;
    this.useCaseSensitiveFileNames = useCaseSensitiveFileNames;
    this.currentDirectory = currentDirectory;
    this.rawSources = [];
    this.sources = [];
    this.sourceIndices = new Map<string, number>();
    this.sourcesContent = [];
    this.names = [];
    this.mappings = new Uint8Array(1024);
    this.mappingsLength = 0;
    this.lastGeneratedLine = 0;
    this.lastGeneratedCharacter = 0;
    this.lastSourceIndex = 0;
    this.lastSourceLine = 0;
    this.lastSourceCharacter = 0;
    this.lastNameIndex = 0;
    this.hasLast = false;
    this.pendingGeneratedLine = 0;
    this.pendingGeneratedCharacter = 0;
    this.pendingSourceIndex = 0;
    this.pendingSourceLine = 0;
    this.pendingSourceCharacter = 0;
    this.pendingNameIndex = 0;
    this.hasPending = false;
    this.hasPendingSource = false;
    this.hasPendingName = false;
  }

  addSource(fileName: string): number {
    const source = getRelativePathToDirectoryOrUrl(
      this.sourcesDirectoryPath,
      fileName,
      this.useCaseSensitiveFileNames,
      this.currentDirectory,
    );
    const existing = this.sourceIndices.get(source);
    if (existing !== undefined) return existing;
    const index = this.sources.length;
    this.sources.push(source);
    this.rawSources.push(fileName);
    this.sourceIndices.set(source, index);
    return index;
  }

  setSourceContent(sourceIndex: number, content: string): boolean {
    if (sourceIndex < 0 || sourceIndex >= this.sources.length) throw new Error('sourceIndex is out of range');
    while (this.sourcesContent.length <= sourceIndex) this.sourcesContent.push(undefined);
    this.sourcesContent[sourceIndex] = content;
    return true;
  }

  addName(name: string): number {
    const index = this.names.indexOf(name);
    if (index >= 0) return index;
    this.names.push(name);
    return this.names.length - 1;
  }

  /** Appends the ASCII character `code` to the mappings. */
  private appendMapping(code: number): boolean {
    const length = this.mappingsLength;
    if (length === this.mappings.length) {
      const grown = new Uint8Array(length * 2);
      grown.set(this.mappings);
      this.mappings = grown;
    }
    this.mappings[length] = code;
    this.mappingsLength = length + 1;
    return true;
  }

  private appendBase64VLQ(value: number): boolean {
    value = value < 0 ? (-value << 1) + 1 : value << 1;
    do {
      let digit = value & 31;
      value = value >> 5;
      if (value > 0) digit |= 32;
      this.appendMapping(base64DigitCodes[digit]!);
    } while (value > 0);
    return true;
  }

  private shouldCommitMapping(): boolean {
    return (
      this.hasPending &&
      (!this.hasLast ||
        this.lastGeneratedLine !== this.pendingGeneratedLine ||
        this.lastGeneratedCharacter !== this.pendingGeneratedCharacter ||
        this.lastSourceIndex !== this.pendingSourceIndex ||
        this.lastSourceLine !== this.pendingSourceLine ||
        this.lastSourceCharacter !== this.pendingSourceCharacter ||
        this.lastNameIndex !== this.pendingNameIndex)
    );
  }

  private commitPendingMapping(): boolean {
    if (!this.shouldCommitMapping()) return false;
    if (this.lastGeneratedLine < this.pendingGeneratedLine) {
      do {
        this.appendMapping(0x3b); // ;
        this.lastGeneratedLine++;
      } while (this.lastGeneratedLine < this.pendingGeneratedLine);
      this.lastGeneratedCharacter = 0;
    } else {
      if (this.lastGeneratedLine !== this.pendingGeneratedLine) throw new Error('generatedLine cannot backtrack');
      if (this.hasLast) this.appendMapping(0x2c); // ,
    }
    this.appendBase64VLQ(this.pendingGeneratedCharacter - this.lastGeneratedCharacter);
    this.lastGeneratedCharacter = this.pendingGeneratedCharacter;
    if (this.hasPendingSource) {
      this.appendBase64VLQ(this.pendingSourceIndex - this.lastSourceIndex);
      this.lastSourceIndex = this.pendingSourceIndex;
      this.appendBase64VLQ(this.pendingSourceLine - this.lastSourceLine);
      this.lastSourceLine = this.pendingSourceLine;
      this.appendBase64VLQ(this.pendingSourceCharacter - this.lastSourceCharacter);
      this.lastSourceCharacter = this.pendingSourceCharacter;
      if (this.hasPendingName) {
        this.appendBase64VLQ(this.pendingNameIndex - this.lastNameIndex);
        this.lastNameIndex = this.pendingNameIndex;
      }
    }
    this.hasLast = true;
    return true;
  }

  private addMapping(
    generatedLine: number,
    generatedCharacter: number,
    sourceIndex: number,
    sourceLine: number,
    sourceCharacter: number,
    nameIndex: number,
  ): boolean {
    const backtracking =
      sourceIndex >= 0 &&
      sourceLine >= 0 &&
      sourceCharacter >= 0 &&
      this.pendingSourceIndex === sourceIndex &&
      (this.pendingSourceLine > sourceLine ||
        (this.pendingSourceLine === sourceLine && this.pendingSourceCharacter > sourceCharacter));
    if (
      !this.hasPending ||
      this.pendingGeneratedLine !== generatedLine ||
      this.pendingGeneratedCharacter !== generatedCharacter ||
      backtracking
    ) {
      this.commitPendingMapping();
      this.pendingGeneratedLine = generatedLine;
      this.pendingGeneratedCharacter = generatedCharacter;
      this.hasPendingSource = false;
      this.hasPendingName = false;
      this.hasPending = true;
    }
    if (sourceIndex >= 0 && sourceLine >= 0 && sourceCharacter >= 0) {
      this.pendingSourceIndex = sourceIndex;
      this.pendingSourceLine = sourceLine;
      this.pendingSourceCharacter = sourceCharacter;
      this.hasPendingSource = true;
      if (nameIndex >= 0) {
        this.pendingNameIndex = nameIndex;
        this.hasPendingName = true;
      }
    }
    return true;
  }

  addSourceMapping(
    generatedLine: number,
    generatedCharacter: number,
    sourceIndex: number,
    sourceLine: number,
    sourceCharacter: number,
  ): boolean {
    if (generatedLine < this.pendingGeneratedLine) throw new Error('generatedLine cannot backtrack');
    if (generatedCharacter < 0) throw new Error('generatedCharacter cannot be negative');
    if (sourceIndex < 0 || sourceIndex >= this.sources.length) throw new Error('sourceIndex is out of range');
    if (sourceLine < 0) throw new Error('sourceLine cannot be negative');
    if (sourceCharacter < 0) throw new Error('sourceCharacter cannot be negative');
    return this.addMapping(generatedLine, generatedCharacter, sourceIndex, sourceLine, sourceCharacter, -1);
  }

  /** The mappings string. */
  getMappings(): string {
    this.commitPendingMapping();
    return mappingsDecoder.decode(this.mappings.subarray(0, this.mappingsLength));
  }

  /** The source map as JSON, with keys in tsgo's order. */
  toJSON(): string {
    const mappings = this.getMappings();
    let json =
      '{"version":3,"file":' +
      jsonString(this.file) +
      // An empty source root is left out, as tsgo's `omitzero` does.
      (this.sourceRoot === '' ? '' : ',"sourceRoot":' + jsonString(this.sourceRoot)) +
      ',"sources":' +
      jsonStrings(this.sources) +
      ',"names":' +
      jsonStrings(this.names) +
      // Base64 digits, `;` and `,` need no escaping.
      ',"mappings":"' +
      mappings +
      '"';
    if (this.sourcesContent.length > 0) {
      json += ',"sourcesContent":[';
      let separator = '';
      for (const content of this.sourcesContent) {
        json += separator + (content === undefined ? 'null' : jsonString(content));
        separator = ',';
      }
      json += ']';
    }
    return json + '}';
  }

  toBase64DataURL(): string {
    return 'data:application/json;base64,' + base64Encode(utf8Bytes(this.toJSON()));
  }
}

const hex = '0123456789abcdef';

/** A JSON string literal, escaped as Go's encoding/json/v2 does by default. */
export function jsonString(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    let escape: string;
    if (ch === 0x22) escape = '\\"';
    else if (ch === 0x5c) escape = '\\\\';
    else if (ch >= 0x20) continue;
    else if (ch === 0x08) escape = '\\b';
    else if (ch === 0x0c) escape = '\\f';
    else if (ch === 0x0a) escape = '\\n';
    else if (ch === 0x0d) escape = '\\r';
    else if (ch === 0x09) escape = '\\t';
    else escape = '\\u00' + hex.charAt(ch >> 4) + hex.charAt(ch & 15);
    out += s.substring(start, i) + escape;
    start = i + 1;
  }
  return out + s.substring(start) + '"';
}

function jsonStrings(values: readonly string[]): string {
  let out = '[';
  for (let i = 0; i < values.length; i++) {
    if (i > 0) out += ',';
    out += jsonString(values[i]!);
  }
  return out + ']';
}

/** UTF-8 bytes of `s`; lone surrogates become U+FFFD. */
export function utf8Bytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = (c - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(bytes);
}

export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk +=
      base64Digits.charAt(n >> 18) +
      base64Digits.charAt((n >> 12) & 63) +
      base64Digits.charAt((n >> 6) & 63) +
      base64Digits.charAt(n & 63);
    if (chunk.length >= 4096) {
      parts.push(chunk);
      chunk = '';
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    chunk += base64Digits.charAt(n >> 18) + base64Digits.charAt((n >> 12) & 63) + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunk +=
      base64Digits.charAt(n >> 18) + base64Digits.charAt((n >> 12) & 63) + base64Digits.charAt((n >> 6) & 63) + '=';
  }
  parts.push(chunk);
  return parts.join('');
}
