/**
 * Diagnostics: message lookup and localization, the `Diagnostic` type, and tsc's plain and
 * pretty diagnostic output.
 */
import { isDigit, isUnicodeWhiteSpace, utf8Length } from './character-codes.js';
import { Locale, translations } from './diagnostic-locales.js';
import { Diagnostics, messageCodes, messageFlags, messageKeys, messageTexts } from './diagnostic-messages.js';
import { getPathComponentsRelativeTo, getPathFromPathComponents, isRootedDiskPath, pathIsAbsolute } from './path.js';
import { computeLineOfPosition, computeLineStarts } from './scanner.js';

export { Diagnostics, Locale };
export { parseLocale } from './locale.js';

export const enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

/** A diagnostic message template, e.g. `Diagnostics.X_0_expected` for `'{0}' expected.`. */
export type DiagnosticMessage = Diagnostics;

const reportsUnnecessaryFlag = 4;
const elidedInCompatibilityPyramidFlag = 8;
const reportsDeprecatedFlag = 16;

export function categoryName(category: DiagnosticCategory): string {
  switch (category) {
    case DiagnosticCategory.Warning:
      return 'warning';
    case DiagnosticCategory.Error:
      return 'error';
    case DiagnosticCategory.Suggestion:
      return 'suggestion';
    case DiagnosticCategory.Message:
      return 'message';
  }
}

export function messageCode(message: DiagnosticMessage): number {
  return messageCodes[message]!;
}

export function messageCategory(message: DiagnosticMessage): DiagnosticCategory {
  return (messageFlags[message] & 3) as DiagnosticCategory;
}

export function messageReportsUnnecessary(message: DiagnosticMessage): boolean {
  return (messageFlags[message] & reportsUnnecessaryFlag) !== 0;
}

export function messageElidedInCompatibilityPyramid(message: DiagnosticMessage): boolean {
  return (messageFlags[message] & elidedInCompatibilityPyramidFlag) !== 0;
}

export function messageReportsDeprecated(message: DiagnosticMessage): boolean {
  return (messageFlags[message] & reportsDeprecatedFlag) !== 0;
}

// Texts are split out of the generated strings on first use. Index 0 holds English.
const texts: string[][] = [];
let keys: string[] = [];
let messagesByKey: Map<string, DiagnosticMessage> | undefined;

function textOf(locale: Locale, message: DiagnosticMessage): string {
  while (texts.length <= locale) texts.push([]);
  let table = texts[locale]!;
  if (table.length === 0) {
    table = (locale === Locale.Default ? messageTexts : translations(locale)).split('\n');
    texts[locale] = table;
  }
  return table[message] ?? '';
}

function keyList(): readonly string[] {
  if (keys.length === 0) keys = messageKeys.split('\n');
  return keys;
}

/** The message's key, e.g. `_0_expected_1005`, which identifies it in translations and build info. */
export function messageKey(message: DiagnosticMessage): string {
  return keyList()[message] ?? '';
}

/** The message's English text. */
export function messageText(message: DiagnosticMessage): string {
  return textOf(Locale.Default, message);
}

/** Finds a message by its key. */
export function messageForKey(key: string): DiagnosticMessage | undefined {
  if (messagesByKey === undefined) {
    messagesByKey = new Map();
    const all = keyList();
    for (let i = 0; i < all.length; i++) messagesByKey.set(all[i]!, i as DiagnosticMessage);
  }
  return messagesByKey.get(key);
}

/** The message's text in `locale`, with `{n}` placeholders replaced by `args[n]`. */
export function localizeMessage(locale: Locale, message: DiagnosticMessage, args: readonly string[]): string {
  const translated = locale === Locale.Default ? '' : textOf(locale, message);
  return formatMessage(translated !== '' ? translated : textOf(Locale.Default, message), args);
}

/**
 * Replaces `{n}` placeholders in `text` with `args[n]`. With no arguments, `text` is returned as is. A
 * placeholder without an argument stays as it is. tsgo panics there instead ("Invalid formatting
 * placeholder"), which ends the run before it reports the rest of its diagnostics.
 */
export function formatMessage(text: string, args: readonly string[]): string {
  if (args.length === 0) return text;
  let result = '';
  let start = 0;
  for (let open = text.indexOf('{'); open >= 0; open = text.indexOf('{', open + 1)) {
    let close = open + 1;
    while (close < text.length && isDigit(text.charCodeAt(close))) close++;
    if (close === open + 1 || close >= text.length || text.charCodeAt(close) !== 0x7d) continue;
    const index = Number(text.slice(open + 1, close));
    if (index >= args.length) continue;
    result += text.slice(start, open) + toWellFormed(args[index]!);
    start = close + 1;
    open = close;
  }
  return result + text.slice(start);
}

/** Replaces lone surrogates with U+FFFD, as tsgo makes arguments valid UTF-8. */
function toWellFormed(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }
    text = text.slice(0, i) + '�' + text.slice(i + 1);
  }
  return text;
}

/**
 * Where this thread computes the line starts and UTF-8 offsets of files that may be shared with other
 * threads (`useThreadTextCaches`): a copy of each such file, by file, that computes them in place.
 * Files leave the parser without line starts and UTF-8 offsets, except JSON files, which have line
 * starts.
 */
let threadCopies: Map<DiagnosticFile, DiagnosticFile> | undefined = undefined;

/**
 * Makes this thread compute the caches of files that do not have them yet in copies of its own: the
 * files may be published (immutable) and shared with other threads. Files leave the parser without
 * them (`Parser.parseSourceFile`): most files are never pointed into by a diagnostic.
 */
export function useThreadTextCaches(): void {
  if (threadCopies === undefined) threadCopies = new Map<DiagnosticFile, DiagnosticFile>();
}

/** This thread's copy of `file` for its caches, if this thread computes them in copies. */
function threadCopyOf(file: DiagnosticFile): DiagnosticFile | undefined {
  const copies = threadCopies;
  if (copies === undefined || file.isThreadCopy) return undefined;
  let copy = copies.get(file);
  if (copy === undefined) {
    copy = new DiagnosticFile(file.fileName, file.text);
    // A copy computes its caches in place, each on first use.
    copy.isThreadCopy = true;
    copies.set(file, copy);
  }
  return copy;
}

/** The empty value of a file's position tables until they are computed. */
const noNumbers: readonly number[] = [];

/** The text of a file diagnostics point into. */
export class DiagnosticFile {
  readonly fileName: string;
  readonly text: string;
  // Computed on first use; never empty once computed.
  private lineStarts: readonly number[] = noNumbers;
  /** Whether this is a thread's copy of a possibly shared file (`threadCopyOf`). */
  isThreadCopy = false;

  constructor(fileName: string, text: string) {
    this.fileName = fileName;
    this.text = text;
  }

  /**
   * Computes the line starts, so that later reads never write to the file. The UTF-8 offsets, which
   * only incremental builds read (for the diagnostics they store), are computed on first use, in a
   * thread's copy where the file may be shared (`useThreadTextCaches`).
   */
  computeCaches(): void {
    if (this.lineStarts.length === 0) this.lineStarts = computeLineStarts(this.text);
  }

  /** Start offsets of each line, split at CR, LF, CRLF, LS and PS. */
  getLineStarts(): readonly number[] {
    if (this.lineStarts.length === 0) {
      const copy = threadCopyOf(this);
      if (copy !== undefined) return copy.getLineStarts();
      this.lineStarts = computeLineStarts(this.text);
    }
    return this.lineStarts;
  }

  // The non-ASCII characters, in order: their UTF-16 offsets, UTF-8 lengths, and the UTF-8 bytes
  // beyond one per UTF-16 code unit of the text up to and including each. Unset until first used.
  private nonASCIIStarts: number[] | undefined = undefined;
  private nonASCIILengths: readonly number[] = noNumbers;
  private extraBytes: readonly number[] = noNumbers;

  private getNonASCIIStarts(): number[] {
    let starts = this.nonASCIIStarts;
    if (starts === undefined) {
      starts = [];
      const text = this.text;
      if (Buffer.byteLength(text, 'utf8') !== text.length) {
        // Scanning the UTF-8 encoding is faster than reading each code unit.
        const bytes = Buffer.from(text, 'utf8');
        const lengths: number[] = [];
        const extraBytes: number[] = [];
        let extra = 0;
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i]!;
          if (b < 0x80) continue;
          // A lone surrogate is encoded as U+FFFD, in 3 bytes.
          const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
          starts.push(i - extra);
          lengths.push(length);
          extra += length === 4 ? 2 : length - 1;
          extraBytes.push(extra);
          i += length - 1;
        }
        this.nonASCIILengths = lengths;
        this.extraBytes = extraBytes;
      }
      this.nonASCIIStarts = starts;
    }
    return starts;
  }

  /** The number of non-ASCII characters starting before UTF-16 offset `pos`. */
  private countNonASCIIBefore(starts: readonly number[], pos: number): number {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! < pos) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** The UTF-8 offset of UTF-16 offset `pos`, as tsgo counts positions. */
  toUtf8Offset(pos: number): number {
    if (this.nonASCIIStarts === undefined) {
      const copy = threadCopyOf(this);
      if (copy !== undefined) return copy.toUtf8Offset(pos);
    }
    const starts = this.getNonASCIIStarts();
    if (starts.length === 0 || pos <= 0 || pos > this.text.length) return pos;
    const count = this.countNonASCIIBefore(starts, pos);
    if (count === 0) return pos;
    const last = count - 1;
    // The middle of a surrogate pair shares its start's offset.
    if (this.nonASCIILengths[last] === 4 && starts[last]! + 1 === pos)
      return starts[last]! + (last === 0 ? 0 : this.extraBytes[last - 1]!);
    return pos + this.extraBytes[last]!;
  }

  /** The UTF-16 offset of UTF-8 offset `pos`; inside a character, the offset of its start. */
  fromUtf8Offset(pos: number): number {
    if (this.nonASCIIStarts === undefined) {
      const copy = threadCopyOf(this);
      if (copy !== undefined) return copy.fromUtf8Offset(pos);
    }
    const starts = this.getNonASCIIStarts();
    if (starts.length === 0 || pos <= 0) return pos;
    const extraBytes = this.extraBytes;
    // The last non-ASCII character starting at or before `pos`, in UTF-8.
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const start8 = starts[middle]! + (middle === 0 ? 0 : extraBytes[middle - 1]!);
      if (start8 <= pos) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return pos;
    const index = low - 1;
    const start = starts[index]!;
    const end8 = start + (index === 0 ? 0 : extraBytes[index - 1]!) + this.nonASCIILengths[index]!;
    if (pos < end8) return start;
    return pos - extraBytes[index]!;
  }
}

/** What a message chain entry is recomputed from when an incremental build reuses it (`RepopulateInfo`). */
export const enum RepopulateKind {
  /** How to make a CommonJS file an ES module. */
  ModeMismatch = 1,
  /** Where types for a module might come from. */
  ModuleNotFound = 2,
}

/**
 * How to recompute a message chain entry that depends on the program (`package.json` scopes, the
 * packages, alternate resolutions) when an incremental build reuses the diagnostic, like tsgo's
 * `RepopulateDiagnosticInfo`.
 */
export class RepopulateInfo {
  constructor(
    readonly kind: RepopulateKind,
    readonly moduleReference = '',
    /** The resolution mode of the import (a `ModuleKind`). */
    readonly mode = 0,
    /** The package the types were looked up for, `''` when it is the module reference. */
    readonly packageName = '',
  ) {}
}

/**
 * A diagnostic: a message with arguments, optionally at a span of a file. Positions are UTF-16
 * offsets; compiler diagnostics have no file and a position of -1.
 *
 * `messageChain` holds the elaborations printed indented below the message; they are diagnostics
 * whose file and position are not printed, but recorded in build info.
 */
export class Diagnostic {
  file: DiagnosticFile | undefined;
  pos: number;
  end: number;
  code: number;
  category: DiagnosticCategory;
  readonly message: DiagnosticMessage;
  readonly args: readonly string[];
  messageChain: Diagnostic[] = [];
  relatedInformation: Diagnostic[] = [];
  readonly reportsUnnecessary: boolean;
  readonly reportsDeprecated: boolean;
  skippedOnNoEmit = false;
  repopulateInfo: RepopulateInfo | undefined = undefined;
  /**
   * What `formatDiagnostic` gives for this diagnostic in `formattedReports.format`, where the checker
   * thread that found it formatted it (`packResult`); `''` otherwise.
   */
  formatted = '';

  constructor(
    file: DiagnosticFile | undefined,
    pos: number,
    end: number,
    message: DiagnosticMessage,
    args: readonly string[] = [],
  ) {
    this.file = file;
    this.pos = pos;
    this.end = end;
    this.code = messageCode(message);
    this.category = messageCategory(message);
    this.message = message;
    this.args = args;
    this.reportsUnnecessary = messageReportsUnnecessary(message);
    this.reportsDeprecated = messageReportsDeprecated(message);
  }

  localize(locale: Locale): string {
    return localizeMessage(locale, this.message, this.args);
  }

  addMessageChain(chain: Diagnostic | undefined): Diagnostic {
    if (chain !== undefined) this.messageChain.push(chain);
    return this;
  }

  addRelatedInfo(related: Diagnostic | undefined): Diagnostic {
    if (related !== undefined) this.relatedInformation.push(related);
    return this;
  }

  clone(): Diagnostic {
    const result = new Diagnostic(this.file, this.pos, this.end, this.message, this.args);
    result.code = this.code;
    result.category = this.category;
    result.messageChain = this.messageChain;
    result.relatedInformation = this.relatedInformation;
    result.skippedOnNoEmit = this.skippedOnNoEmit;
    result.repopulateInfo = this.repopulateInfo;
    result.formatted = this.formatted;
    return result;
  }
}

/** A message with its arguments and no location, such as a module resolution trace. */
export interface MessageWithArgs {
  readonly message: DiagnosticMessage;
  readonly args: readonly string[];
}

export function messageWithArgs(message: DiagnosticMessage, ...args: string[]): MessageWithArgs {
  return { message, args };
}

/** An entry of `Diagnostic.messageChain`. */
export type DiagnosticMessageChain = Diagnostic;

export function createDiagnostic(
  file: DiagnosticFile | undefined,
  pos: number,
  end: number,
  message: DiagnosticMessage,
  ...args: string[]
): Diagnostic {
  return new Diagnostic(file, pos, end, message, args);
}

/** A diagnostic without a file, such as an options error. */
export function createCompilerDiagnostic(message: DiagnosticMessage, ...args: string[]): Diagnostic {
  return new Diagnostic(undefined, -1, -1, message, args);
}

/** A diagnostic for `message` that elaborates with `chain`, taking its location and related information. */
export function chainDiagnostic(
  chain: Diagnostic | undefined,
  message: DiagnosticMessage,
  ...args: string[]
): Diagnostic {
  if (chain === undefined) return new Diagnostic(undefined, 0, 0, message, args);
  const result = new Diagnostic(chain.file, chain.pos, chain.end, message, args).addMessageChain(chain);
  // A copy: related information added to the result later is not part of the chained diagnostic, as in tsgo.
  result.relatedInformation = chain.relatedInformation.slice();
  return result;
}

//// Ordering

/** Orders strings by code point, like Go's byte-wise comparison of UTF-8. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  // Integer lengths and bound: with a double bound (Math.min, or lengths not coerced) scriptc
  // rounds the trip count with a libm ceil call on every call.
  const aLength = a.length | 0;
  const bLength = b.length | 0;
  const length = aLength < bLength ? aLength : bLength;
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return x < 0xd800 && y < 0xd800 ? (x < y ? -1 : 1) : compareUnitsAsCodePoints(x, y);
  }
  // Different strings with a common prefix of the shorter one's length differ in length.
  return aLength < bLength ? -1 : 1;
}

/** Orders two different UTF-16 units as the code points they start. */
function compareUnitsAsCodePoints(x: number, y: number): number {
  // Surrogates encode code points above every other UTF-16 unit.
  if (x >= 0xd800 && x <= 0xdfff) x += 0x10000;
  if (y >= 0xd800 && y <= 0xdfff) y += 0x10000;
  return x < y ? -1 : 1;
}

function compareArgs(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const c = compareCodePoints(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function equalArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fileNameOf(d: Diagnostic): string {
  return d.file === undefined ? '' : d.file.fileName;
}

function compareChainSize(a: readonly Diagnostic[], b: readonly Diagnostic[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let i = 0; i < a.length; i++) {
    const c = compareChainSize(a[i]!.messageChain, b[i]!.messageChain);
    if (c !== 0) return c;
  }
  return 0;
}

function compareChainContent(a: readonly Diagnostic[], b: readonly Diagnostic[]): number {
  for (let i = 0; i < a.length; i++) {
    let c = compareArgs(a[i]!.args, b[i]!.args);
    if (c !== 0) return c;
    c = compareChainContent(a[i]!.messageChain, b[i]!.messageChain);
    if (c !== 0) return c;
  }
  return 0;
}

function compareRelatedInfo(a: readonly Diagnostic[], b: readonly Diagnostic[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let i = 0; i < a.length; i++) {
    const c = compareDiagnostics(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

/** The order tsc reports diagnostics in: by file, position, code, arguments, then elaboration. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a === b) return 0;
  const c = compareCodePoints(fileNameOf(a), fileNameOf(b));
  return c !== 0 ? c : compareDiagnosticsInFile(a, b);
}

/** `compareDiagnostics` of two diagnostics whose files have the same name. */
function compareDiagnosticsInFile(a: Diagnostic, b: Diagnostic): number {
  let c = a.pos - b.pos;
  if (c !== 0) return c;
  c = a.end - b.end;
  if (c !== 0) return c;
  c = a.code - b.code;
  if (c !== 0) return c;
  c = compareArgs(a.args, b.args);
  if (c !== 0) return c;
  c = compareChainSize(a.messageChain, b.messageChain);
  if (c !== 0) return c;
  c = compareChainContent(a.messageChain, b.messageChain);
  if (c !== 0) return c;
  return compareRelatedInfo(a.relatedInformation, b.relatedInformation);
}

/**
 * `diagnostics` in the order of `compareDiagnostics`, equal ones in their order in `diagnostics`. File
 * names are compared once per pair of files rather than once per pair of diagnostics: the distinct
 * files are sorted by name, and each diagnostic sorts by its file's place in that order, then by the
 * rest of `compareDiagnostics`. A program's diagnostics come a file at a time, so the files are found
 * from the runs of one file.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const n = diagnostics.length;
  if (n < 2) return diagnostics.slice();
  const fileIndices = new Map<DiagnosticFile | undefined, number>();
  const files: (DiagnosticFile | undefined)[] = [];
  const fileOf: number[] = [];
  let last: DiagnosticFile | undefined = undefined;
  let lastIndex = -1;
  for (let i = 0; i < n; i++) {
    const file = diagnostics[i]!.file;
    if (lastIndex < 0 || file !== last) {
      let k = fileIndices.get(file);
      if (k === undefined) {
        k = files.length;
        fileIndices.set(file, k);
        files.push(file);
      }
      last = file;
      lastIndex = k;
    }
    fileOf.push(lastIndex);
  }
  // Files with the same name share a rank, as they compare equal.
  const nameOf = (k: number): string => {
    const file = files[k];
    return file === undefined ? '' : file.fileName;
  };
  const byName: number[] = [];
  for (let k = 0; k < files.length; k++) byName.push(k);
  byName.sort((x, y) => compareCodePoints(nameOf(x), nameOf(y)));
  const rank: number[] = [];
  for (let k = 0; k < files.length; k++) rank.push(0);
  for (let k = 1; k < byName.length; k++)
    rank[byName[k]!] = rank[byName[k - 1]!]! + (nameOf(byName[k]!) === nameOf(byName[k - 1]!) ? 0 : 1);
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((x, y) => {
    const c = rank[fileOf[x]!]! - rank[fileOf[y]!]!;
    if (c !== 0) return c;
    const a = diagnostics[x]!;
    const b = diagnostics[y]!;
    return a === b ? 0 : compareDiagnosticsInFile(a, b);
  });
  const sorted: Diagnostic[] = [];
  for (const i of order) sorted.push(diagnostics[i]!);
  return sorted;
}

function equalChain(a: readonly Diagnostic[], b: readonly Diagnostic[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i].code !== b[i].code || !equalArgs(a[i].args, b[i].args)) return false;
    if (!equalChain(a[i].messageChain, b[i].messageChain)) return false;
  }
  return true;
}

/** Whether two diagnostics report the same thing, ignoring related information. */
export function equalDiagnosticsNoRelatedInfo(a: Diagnostic, b: Diagnostic): boolean {
  if (a === b) return true;
  return (
    fileNameOf(a) === fileNameOf(b) &&
    a.pos === b.pos &&
    a.end === b.end &&
    a.code === b.code &&
    equalArgs(a.args, b.args) &&
    equalChain(a.messageChain, b.messageChain)
  );
}

export function equalDiagnostics(a: Diagnostic, b: Diagnostic): boolean {
  if (a === b) return true;
  if (!equalDiagnosticsNoRelatedInfo(a, b)) return false;
  if (a.relatedInformation.length !== b.relatedInformation.length) return false;
  for (let i = 0; i < a.relatedInformation.length; i++) {
    if (!equalDiagnostics(a.relatedInformation[i]!, b.relatedInformation[i]!)) return false;
  }
  return true;
}

//// Output

export interface DiagnosticFormatOptions {
  readonly locale: Locale;
  readonly currentDirectory: string;
  readonly useCaseSensitiveFileNames: boolean;
  readonly newLine: string;
}

const grey = '\u001b[90m';
const red = '\u001b[91m';
const yellow = '\u001b[93m';
const blue = '\u001b[94m';
const cyan = '\u001b[96m';
const gutterStyle = '\u001b[7m';
const gutterSeparator = ' ';
const reset = '\u001b[0m';
const ellipsis = '...';

function relativeFileName(fileName: string, options: DiagnosticFormatOptions): string {
  if (!isRootedDiskPath(fileName)) return fileName;
  return getPathFromPathComponents(
    getPathComponentsRelativeTo(
      options.currentDirectory,
      fileName,
      options.useCaseSensitiveFileNames,
      options.currentDirectory,
    ),
  );
}

function flattenChain(chain: readonly Diagnostic[], newLine: string, locale: Locale, level: number): string {
  let result = '';
  for (const entry of chain) {
    result += newLine + '  '.repeat(level) + entry.localize(locale);
    result += flattenChain(entry.messageChain, newLine, locale, level + 1);
  }
  return result;
}

/** The message followed by its chain, each level indented by two more spaces. */
export function flattenDiagnosticMessage(diagnostic: Diagnostic, newLine: string, locale: Locale): string {
  return diagnostic.localize(locale) + flattenChain(diagnostic.messageChain, newLine, locale, 1);
}

/** `file(line,col): error TS1005: message`, as tsc prints without `--pretty`. */
export function formatDiagnostic(diagnostic: Diagnostic, options: DiagnosticFormatOptions): string {
  const file = diagnostic.file;
  return formatDiagnosticIn(diagnostic, file !== undefined ? relativeFileName(file.fileName, options) : '', options);
}

/** `formatDiagnostic` where `fileName` is the relative name of the diagnostic's file, if it has one. */
function formatDiagnosticIn(diagnostic: Diagnostic, fileName: string, options: DiagnosticFormatOptions): string {
  let result = '';
  const file = diagnostic.file;
  if (file !== undefined) {
    const lineStarts = file.getLineStarts();
    const line = computeLineOfPosition(lineStarts, diagnostic.pos);
    const character = diagnostic.pos - lineStarts[line];
    result += `${fileName}(${line + 1},${character + 1}): `;
  }
  result += `${categoryName(diagnostic.category)} TS${diagnostic.code}: `;
  return result + flattenDiagnosticMessage(diagnostic, options.newLine, options.locale) + options.newLine;
}

/**
 * The plain format the main thread reports a compilation's diagnostics in (`DiagnosticReporter.plainFormat`),
 * which its checker threads receive a copy of and format the diagnostics they send back in
 * (`Diagnostic.formatted`). Unset where diagnostics are reported with color and context, or not at all.
 */
export class FormattedReports {
  format: DiagnosticFormatOptions | undefined = undefined;
}

export const formattedReports = new FormattedReports();

/** `formatDiagnostic` of each diagnostic. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[], options: DiagnosticFormatOptions): string {
  let result = '';
  const formatted = options === formattedReports.format;
  // Sorted diagnostics come a file at a time: the relative name of the last file is kept.
  let lastFile: DiagnosticFile | undefined = undefined;
  let lastName = '';
  for (const diagnostic of diagnostics) {
    if (formatted && diagnostic.formatted !== '') {
      result += diagnostic.formatted;
      continue;
    }
    const file = diagnostic.file;
    if (file !== undefined && file !== lastFile) {
      lastFile = file;
      lastName = relativeFileName(file.fileName, options);
    }
    result += formatDiagnosticIn(diagnostic, file !== undefined ? lastName : '', options);
  }
  return result;
}

function categoryColor(category: DiagnosticCategory): string {
  switch (category) {
    case DiagnosticCategory.Error:
      return red;
    case DiagnosticCategory.Warning:
      return yellow;
    case DiagnosticCategory.Suggestion:
      return grey;
    case DiagnosticCategory.Message:
      return blue;
  }
}

function styled(text: string, style: string): string {
  return style + text + reset;
}

function formatLocation(file: DiagnosticFile, pos: number, options: DiagnosticFormatOptions): string {
  const lineStarts = file.getLineStarts();
  const line = computeLineOfPosition(lineStarts, pos);
  const character = pos - lineStarts[line];
  return `${styled(relativeFileName(file.fileName, options), cyan)}:${styled(String(line + 1), yellow)}:${styled(String(character + 1), yellow)}`;
}

function trimEndSpace(text: string): string {
  let end = text.length;
  while (end > 0 && isUnicodeWhiteSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

function codeSnippet(
  file: DiagnosticFile,
  start: number,
  length: number,
  squiggleColor: string,
  indent: string,
  options: DiagnosticFormatOptions,
): string {
  const newLine = options.newLine;
  const text = file.text;
  const lineStarts = file.getLineStarts();
  const firstLine = computeLineOfPosition(lineStarts, start);
  const firstLineChar = start - lineStarts[firstLine];
  const lastLine = computeLineOfPosition(lineStarts, start + length);
  let lastLineChar = start + length - lineStarts[lastLine];
  // With no length, squiggle the character after the start.
  if (length === 0) lastLineChar++;
  const lastLineOfFile = computeLineOfPosition(lineStarts, text.length);

  const hasMoreThanFiveLines = lastLine - firstLine >= 4;
  let gutterWidth = String(lastLine + 1).length;
  if (hasMoreThanFiveLines) gutterWidth = Math.max(ellipsis.length, gutterWidth);

  let result = '';
  for (let i = firstLine; i <= lastLine; i++) {
    result += newLine;
    // For spans over five lines, show the first two and last two.
    if (hasMoreThanFiveLines && firstLine + 1 < i && i < lastLine - 1) {
      result += indent + gutterStyle + ellipsis.padStart(gutterWidth) + reset + gutterSeparator + newLine;
      i = lastLine - 1;
    }
    const lineStart = lineStarts[i]!;
    const lineEnd = i < lastLineOfFile ? lineStarts[i + 1]! : text.length;
    const lineContent = trimEndSpace(text.slice(lineStart, lineEnd)).replaceAll('\t', ' ');

    result += indent + gutterStyle + String(i + 1).padStart(gutterWidth) + reset + gutterSeparator;
    result += lineContent + newLine;
    result += indent + gutterStyle + ''.padStart(gutterWidth) + reset + gutterSeparator + squiggleColor;
    if (i === firstLine) {
      const lastCharForLine = i === lastLine ? lastLineChar : lineContent.length;
      result += ' '.repeat(firstLineChar) + '~'.repeat(lastCharForLine - firstLineChar);
    } else if (i === lastLine) {
      result += '~'.repeat(lastLineChar);
    } else {
      result += '~'.repeat(lineContent.length);
    }
    result += reset;
  }
  return result;
}

/** The colored form with source snippets, as tsc prints with `--pretty`. */
export function formatDiagnosticWithColorAndContext(diagnostic: Diagnostic, options: DiagnosticFormatOptions): string {
  const newLine = options.newLine;
  let result = '';
  const file = diagnostic.file;
  if (file !== undefined) result += formatLocation(file, diagnostic.pos, options) + ' - ';
  const color = categoryColor(diagnostic.category);
  result += styled(categoryName(diagnostic.category), color);
  result += `${grey} TS${diagnostic.code}: ${reset}`;
  result += flattenDiagnosticMessage(diagnostic, newLine, options.locale);
  if (file !== undefined && diagnostic.code !== messageCode(Diagnostics.File_appears_to_be_binary)) {
    result +=
      newLine + codeSnippet(file, diagnostic.pos, diagnostic.end - diagnostic.pos, color, '', options) + newLine;
  }
  for (const related of diagnostic.relatedInformation) {
    const relatedFile = related.file;
    if (relatedFile !== undefined) {
      result += newLine + '  ' + formatLocation(relatedFile, related.pos, options) + ' - ';
      result += flattenDiagnosticMessage(related, newLine, options.locale);
      result += codeSnippet(relatedFile, related.pos, related.end - related.pos, cyan, '    ', options);
    }
    result += newLine;
  }
  return result;
}

export function formatDiagnosticsWithColorAndContext(
  diagnostics: readonly Diagnostic[],
  options: DiagnosticFormatOptions,
): string {
  let result = '';
  for (let i = 0; i < diagnostics.length; i++) {
    if (i > 0) result += options.newLine;
    result += formatDiagnosticWithColorAndContext(diagnostics[i]!, options);
  }
  return result;
}

/** A watch or build status line: `time - message`. */
export function formatDiagnosticStatus(time: string, diagnostic: Diagnostic, options: DiagnosticFormatOptions): string {
  return `${time} - ${flattenDiagnosticMessage(diagnostic, options.newLine, options.locale)}`;
}

/** A watch or build status line with a colored time: `[time] message`. */
export function formatDiagnosticStatusWithColor(
  time: string,
  diagnostic: Diagnostic,
  options: DiagnosticFormatOptions,
): string {
  return `[${styled(time, grey)}] ${flattenDiagnosticMessage(diagnostic, options.newLine, options.locale)}`;
}

class FileErrors {
  readonly file: DiagnosticFile;
  readonly errors: Diagnostic[] = [];

  constructor(file: DiagnosticFile) {
    this.file = file;
  }
}

function prettyPathForFileError(entry: FileErrors | undefined, options: DiagnosticFormatOptions): string {
  if (entry === undefined || entry.errors.length === 0) return '';
  const line = computeLineOfPosition(entry.file.getLineStarts(), entry.errors[0].pos);
  let fileName = entry.file.fileName;
  if (pathIsAbsolute(fileName) && pathIsAbsolute(options.currentDirectory)) {
    fileName = relativeFileName(fileName, options);
  }
  return `${fileName}${grey}:${line + 1}${reset}`;
}

/**
 * The summary tsc prints after diagnostics with `--pretty`, e.g. "Found 2 errors in 2 files."
 * followed by a table of files; empty when there are no errors.
 */
export function formatErrorSummary(diagnostics: readonly Diagnostic[], options: DiagnosticFormatOptions): string {
  const locale = options.locale;
  const newLine = options.newLine;
  let totalErrorCount = 0;
  let globalErrorCount = 0;
  const byFile = new Map<DiagnosticFile, FileErrors>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== DiagnosticCategory.Error) continue;
    totalErrorCount++;
    const file = diagnostic.file;
    if (file === undefined) {
      globalErrorCount++;
      continue;
    }
    let entry = byFile.get(file);
    if (entry === undefined) {
      entry = new FileErrors(file);
      byFile.set(file, entry);
    }
    entry.errors.push(diagnostic);
  }
  if (totalErrorCount === 0) return '';

  const sorted = [...byFile.values()].sort((a, b) => compareCodePoints(a.file.fileName, b.file.fileName));
  const firstFileName = prettyPathForFileError(sorted.length > 0 ? sorted[0]! : undefined, options);
  const fileCount = sorted.length;
  let message: string;
  if (totalErrorCount === 1) {
    message =
      globalErrorCount > 0 || firstFileName === ''
        ? localizeMessage(locale, Diagnostics.Found_1_error, [])
        : localizeMessage(locale, Diagnostics.Found_1_error_in_0, [firstFileName]);
  } else if (fileCount === 0) {
    message = localizeMessage(locale, Diagnostics.Found_0_errors, [String(totalErrorCount)]);
  } else if (fileCount === 1) {
    message = localizeMessage(locale, Diagnostics.Found_0_errors_in_the_same_file_starting_at_Colon_1, [
      String(totalErrorCount),
      firstFileName,
    ]);
  } else {
    message = localizeMessage(locale, Diagnostics.Found_0_errors_in_1_files, [
      String(totalErrorCount),
      String(fileCount),
    ]);
  }
  let result = newLine + message + newLine + newLine;
  if (fileCount > 1) {
    let maxErrors = 0;
    for (const entry of sorted) maxErrors = Math.max(maxErrors, entry.errors.length);
    const headerRow = localizeMessage(locale, Diagnostics.Errors_Files, []);
    const leftColumnHeadingLength = utf8Length(headerRow.split(' ')[0]!);
    const lengthOfBiggestErrorCount = String(maxErrors).length;
    const leftPaddingGoal = Math.max(leftColumnHeadingLength, lengthOfBiggestErrorCount);
    const headerPadding = Math.max(lengthOfBiggestErrorCount - leftColumnHeadingLength, 0);
    result += ' '.repeat(headerPadding) + headerRow + newLine;
    for (const entry of sorted) {
      result += String(entry.errors.length).padStart(leftPaddingGoal) + '  ';
      result += prettyPathForFileError(entry, options) + newLine;
    }
    result += newLine;
  }
  return result;
}
