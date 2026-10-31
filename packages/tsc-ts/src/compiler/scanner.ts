import {
  CharacterCodes,
  charSize,
  codePointAt,
  isASCIILetter,
  isDigit,
  isHexDigit,
  isIdentifierPart,
  isIdentifierStart,
  isLineBreak,
  isOctalDigit,
  isWhiteSpaceLike,
  isWhiteSpaceSingleLine,
} from './character-codes.js';
import { Diagnostics } from './diagnostic-messages.js';
import { IdentifierName } from './identifier-name.js';
import type { DiagnosticMessage } from './diagnostics.js';
import { parsePseudoBigInt } from './pseudo-bigint.js';
import {
  EscapeSequenceScanningFlags,
  EscapeValue,
  RegularExpressionFlags,
  checkRegularExpression,
  regularExpressionFlag,
} from './regexp-checker.js';
import { SyntaxKind } from './syntax-kind.js';
import {
  CommentDirective,
  CommentDirectiveKind,
  CommentRange,
  LanguageVariant,
  ScriptTarget,
  TokenFlags,
} from './types.js';

export { isIdentifierPart, isIdentifierStart } from './character-codes.js';
export { EscapeSequenceScanningFlags, EscapeValue } from './regexp-checker.js';

const textToKeyword: Map<string, SyntaxKind> = new Map<string, SyntaxKind>([
  ['abstract', SyntaxKind.AbstractKeyword],
  ['accessor', SyntaxKind.AccessorKeyword],
  ['any', SyntaxKind.AnyKeyword],
  ['as', SyntaxKind.AsKeyword],
  ['asserts', SyntaxKind.AssertsKeyword],
  ['assert', SyntaxKind.AssertKeyword],
  ['bigint', SyntaxKind.BigIntKeyword],
  ['boolean', SyntaxKind.BooleanKeyword],
  ['break', SyntaxKind.BreakKeyword],
  ['case', SyntaxKind.CaseKeyword],
  ['catch', SyntaxKind.CatchKeyword],
  ['class', SyntaxKind.ClassKeyword],
  ['continue', SyntaxKind.ContinueKeyword],
  ['const', SyntaxKind.ConstKeyword],
  ['constructor', SyntaxKind.ConstructorKeyword],
  ['debugger', SyntaxKind.DebuggerKeyword],
  ['declare', SyntaxKind.DeclareKeyword],
  ['default', SyntaxKind.DefaultKeyword],
  ['defer', SyntaxKind.DeferKeyword],
  ['delete', SyntaxKind.DeleteKeyword],
  ['do', SyntaxKind.DoKeyword],
  ['else', SyntaxKind.ElseKeyword],
  ['enum', SyntaxKind.EnumKeyword],
  ['export', SyntaxKind.ExportKeyword],
  ['extends', SyntaxKind.ExtendsKeyword],
  ['false', SyntaxKind.FalseKeyword],
  ['finally', SyntaxKind.FinallyKeyword],
  ['for', SyntaxKind.ForKeyword],
  ['from', SyntaxKind.FromKeyword],
  ['function', SyntaxKind.FunctionKeyword],
  ['get', SyntaxKind.GetKeyword],
  ['if', SyntaxKind.IfKeyword],
  ['immediate', SyntaxKind.ImmediateKeyword],
  ['implements', SyntaxKind.ImplementsKeyword],
  ['import', SyntaxKind.ImportKeyword],
  ['in', SyntaxKind.InKeyword],
  ['infer', SyntaxKind.InferKeyword],
  ['instanceof', SyntaxKind.InstanceOfKeyword],
  ['interface', SyntaxKind.InterfaceKeyword],
  ['intrinsic', SyntaxKind.IntrinsicKeyword],
  ['is', SyntaxKind.IsKeyword],
  ['keyof', SyntaxKind.KeyOfKeyword],
  ['let', SyntaxKind.LetKeyword],
  ['module', SyntaxKind.ModuleKeyword],
  ['namespace', SyntaxKind.NamespaceKeyword],
  ['never', SyntaxKind.NeverKeyword],
  ['new', SyntaxKind.NewKeyword],
  ['null', SyntaxKind.NullKeyword],
  ['number', SyntaxKind.NumberKeyword],
  ['object', SyntaxKind.ObjectKeyword],
  ['package', SyntaxKind.PackageKeyword],
  ['private', SyntaxKind.PrivateKeyword],
  ['protected', SyntaxKind.ProtectedKeyword],
  ['public', SyntaxKind.PublicKeyword],
  ['override', SyntaxKind.OverrideKeyword],
  ['out', SyntaxKind.OutKeyword],
  ['readonly', SyntaxKind.ReadonlyKeyword],
  ['require', SyntaxKind.RequireKeyword],
  ['global', SyntaxKind.GlobalKeyword],
  ['return', SyntaxKind.ReturnKeyword],
  ['satisfies', SyntaxKind.SatisfiesKeyword],
  ['set', SyntaxKind.SetKeyword],
  ['source', SyntaxKind.SourceKeyword],
  ['static', SyntaxKind.StaticKeyword],
  ['string', SyntaxKind.StringKeyword],
  ['super', SyntaxKind.SuperKeyword],
  ['switch', SyntaxKind.SwitchKeyword],
  ['symbol', SyntaxKind.SymbolKeyword],
  ['this', SyntaxKind.ThisKeyword],
  ['throw', SyntaxKind.ThrowKeyword],
  ['true', SyntaxKind.TrueKeyword],
  ['try', SyntaxKind.TryKeyword],
  ['type', SyntaxKind.TypeKeyword],
  ['typeof', SyntaxKind.TypeOfKeyword],
  ['undefined', SyntaxKind.UndefinedKeyword],
  ['unique', SyntaxKind.UniqueKeyword],
  ['unknown', SyntaxKind.UnknownKeyword],
  ['using', SyntaxKind.UsingKeyword],
  ['var', SyntaxKind.VarKeyword],
  ['void', SyntaxKind.VoidKeyword],
  ['while', SyntaxKind.WhileKeyword],
  ['with', SyntaxKind.WithKeyword],
  ['yield', SyntaxKind.YieldKeyword],
  ['async', SyntaxKind.AsyncKeyword],
  ['await', SyntaxKind.AwaitKeyword],
  ['of', SyntaxKind.OfKeyword],
]);

const textToToken: Map<string, SyntaxKind> = new Map<string, SyntaxKind>([
  ['{', SyntaxKind.OpenBraceToken],
  ['}', SyntaxKind.CloseBraceToken],
  ['(', SyntaxKind.OpenParenToken],
  [')', SyntaxKind.CloseParenToken],
  ['[', SyntaxKind.OpenBracketToken],
  [']', SyntaxKind.CloseBracketToken],
  ['.', SyntaxKind.DotToken],
  ['...', SyntaxKind.DotDotDotToken],
  [';', SyntaxKind.SemicolonToken],
  [',', SyntaxKind.CommaToken],
  ['<', SyntaxKind.LessThanToken],
  ['>', SyntaxKind.GreaterThanToken],
  ['<=', SyntaxKind.LessThanEqualsToken],
  ['>=', SyntaxKind.GreaterThanEqualsToken],
  ['==', SyntaxKind.EqualsEqualsToken],
  ['!=', SyntaxKind.ExclamationEqualsToken],
  ['===', SyntaxKind.EqualsEqualsEqualsToken],
  ['!==', SyntaxKind.ExclamationEqualsEqualsToken],
  ['=>', SyntaxKind.EqualsGreaterThanToken],
  ['+', SyntaxKind.PlusToken],
  ['-', SyntaxKind.MinusToken],
  ['**', SyntaxKind.AsteriskAsteriskToken],
  ['*', SyntaxKind.AsteriskToken],
  ['/', SyntaxKind.SlashToken],
  ['%', SyntaxKind.PercentToken],
  ['++', SyntaxKind.PlusPlusToken],
  ['--', SyntaxKind.MinusMinusToken],
  ['<<', SyntaxKind.LessThanLessThanToken],
  ['</', SyntaxKind.LessThanSlashToken],
  ['>>', SyntaxKind.GreaterThanGreaterThanToken],
  ['>>>', SyntaxKind.GreaterThanGreaterThanGreaterThanToken],
  ['&', SyntaxKind.AmpersandToken],
  ['|', SyntaxKind.BarToken],
  ['^', SyntaxKind.CaretToken],
  ['!', SyntaxKind.ExclamationToken],
  ['~', SyntaxKind.TildeToken],
  ['&&', SyntaxKind.AmpersandAmpersandToken],
  ['||', SyntaxKind.BarBarToken],
  ['?', SyntaxKind.QuestionToken],
  ['??', SyntaxKind.QuestionQuestionToken],
  ['?.', SyntaxKind.QuestionDotToken],
  [':', SyntaxKind.ColonToken],
  ['=', SyntaxKind.EqualsToken],
  ['+=', SyntaxKind.PlusEqualsToken],
  ['-=', SyntaxKind.MinusEqualsToken],
  ['*=', SyntaxKind.AsteriskEqualsToken],
  ['**=', SyntaxKind.AsteriskAsteriskEqualsToken],
  ['/=', SyntaxKind.SlashEqualsToken],
  ['%=', SyntaxKind.PercentEqualsToken],
  ['<<=', SyntaxKind.LessThanLessThanEqualsToken],
  ['>>=', SyntaxKind.GreaterThanGreaterThanEqualsToken],
  ['>>>=', SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken],
  ['&=', SyntaxKind.AmpersandEqualsToken],
  ['|=', SyntaxKind.BarEqualsToken],
  ['^=', SyntaxKind.CaretEqualsToken],
  ['||=', SyntaxKind.BarBarEqualsToken],
  ['&&=', SyntaxKind.AmpersandAmpersandEqualsToken],
  ['??=', SyntaxKind.QuestionQuestionEqualsToken],
  ['@', SyntaxKind.AtToken],
  ['#', SyntaxKind.HashToken],
  ['`', SyntaxKind.BacktickToken],
]);

const tokenToText: string[] = [];
for (let kind = 0; kind <= SyntaxKind.LastToken; kind++) tokenToText.push('');
for (const [text, kind] of textToToken) tokenToText[kind] = text;
for (const [text, kind] of textToKeyword) tokenToText[kind] = text;

// Keywords bucketed by first letter and length, so identifiers are classified
// without allocating their text.
const keywordBucketStart = new Int32Array(26 * 13 + 2);
const keywordKinds = new Uint16Array(textToKeyword.size);
// The code units of every keyword, 12 slots each, in bucket order.
const keywordCodeUnits = new Uint16Array(textToKeyword.size * 12);
{
  for (const text of textToKeyword.keys()) keywordBucketStart[keywordBucket(text) + 2]++;
  for (let i = 2; i < keywordBucketStart.length; i++) keywordBucketStart[i] += keywordBucketStart[i - 1];
  for (const [text, kind] of textToKeyword) {
    const slot = keywordBucketStart[keywordBucket(text) + 1]++;
    keywordKinds[slot] = kind;
    for (let j = 0; j < text.length; j++) keywordCodeUnits[slot * 12 + j] = text.charCodeAt(j);
  }
}

function keywordBucket(text: string): number {
  return (text.charCodeAt(0) - CharacterCodes.a) * 13 + text.length;
}

/** The keyword kind of the code units `chars[start, end)`, or `Identifier`. */
function keywordKindAt(chars: Uint16Array, start: number, end: number): SyntaxKind {
  const length = (end - start) | 0;
  if (length < 2 || length > 12) return SyntaxKind.Identifier;
  const first = chars[start] | 0;
  if (first < CharacterCodes.a || first > CharacterCodes.z) return SyntaxKind.Identifier;
  const bucket = ((first - CharacterCodes.a) * 13 + length) | 0;
  const last = keywordBucketStart[bucket + 1] | 0;
  for (let i = keywordBucketStart[bucket] | 0; i < last; i = (i + 1) | 0) {
    const base = (i * 12) | 0;
    let j = 1;
    while (j < length && (keywordCodeUnits[(base + j) | 0] | 0) === (chars[(start + j) | 0] | 0)) j = (j + 1) | 0;
    if (j === length) return (keywordKinds[i]! | 0) as SyntaxKind;
  }
  return SyntaxKind.Identifier;
}

/** The keyword kind of `text`, or `Identifier`. */
export function getIdentifierToken(text: string): SyntaxKind {
  if (text.length < 2 || text.length > 12) return SyntaxKind.Identifier;
  const first = text.charCodeAt(0);
  if (first < CharacterCodes.a || first > CharacterCodes.z) return SyntaxKind.Identifier;
  // `| 0`: a SyntaxKind is an int32, which lets its storage stay int32.
  return (textToKeyword.get(text) ?? SyntaxKind.Identifier) | 0;
}

/** The keyword kind of an identifier's text, or `Unknown`. */
export function identifierToKeywordKind(text: string): SyntaxKind {
  return (textToKeyword.get(text) ?? SyntaxKind.Unknown) | 0;
}

export function tokenToString(kind: SyntaxKind): string {
  return kind >= 0 && kind < tokenToText.length ? tokenToText[kind]! : '';
}

export function stringToToken(text: string): SyntaxKind {
  return (textToToken.get(text) ?? textToKeyword.get(text) ?? SyntaxKind.Unknown) | 0;
}

/** Keywords longer than two characters, for spelling suggestions. */
export function getViableKeywordSuggestions(): string[] {
  const result: string[] = [];
  for (const text of textToKeyword.keys()) if (text.length > 2) result.push(text);
  return result;
}

export function tokenIsIdentifierOrKeyword(token: SyntaxKind): boolean {
  return token >= SyntaxKind.Identifier;
}

/** Whether `name` is a valid identifier (JSX names may contain `-` and `:`). */
export function isIdentifierText(name: string, languageVariant = LanguageVariant.Standard): boolean {
  let ch = codePointAt(name, 0, name.length);
  if (!isIdentifierStart(ch)) return false;
  for (let i = charSize(ch); i < name.length; i += charSize(ch)) {
    ch = codePointAt(name, i, name.length);
    if (!isIdentifierPart(ch, languageVariant)) return false;
  }
  return true;
}

/** Receives scanner diagnostics. An abstract class rather than a function so native builds dispatch statically. */
export abstract class ScannerErrorReporter {
  abstract onError(message: DiagnosticMessage, start: number, length: number, args: readonly string[]): void;
}

const noArgs: readonly string[] = [];

/** A snapshot of the scanner's token state for `Scanner.rewind`. */
export class ScannerState {
  pos: number;
  fullStartPos: number;
  tokenStart: number;
  token: SyntaxKind;
  tokenFlags: TokenFlags;
  tokenValue: string;
  valueStart: number;
  valueEnd: number;
  commentDirectiveCount: number;
  skipJSDocLeadingAsterisks: number;

  constructor(
    pos: number,
    fullStartPos: number,
    tokenStart: number,
    token: SyntaxKind,
    tokenFlags: TokenFlags,
    tokenValue: string,
    valueStart: number,
    valueEnd: number,
    commentDirectiveCount: number,
    skipJSDocLeadingAsterisks: number,
  ) {
    this.pos = pos | 0;
    this.fullStartPos = fullStartPos | 0;
    this.tokenStart = tokenStart | 0;
    this.token = token;
    this.tokenFlags = tokenFlags;
    this.tokenValue = tokenValue;
    this.valueStart = valueStart | 0;
    this.valueEnd = valueEnd | 0;
    this.commentDirectiveCount = commentDirectiveCount;
    this.skipJSDocLeadingAsterisks = skipJSDocLeadingAsterisks;
  }

  /** @internal Overwrites this snapshot with the scanner's current state, like `Scanner.mark`. */
  assign(scanner: Scanner): void {
    this.pos = scanner.pos | 0;
    this.fullStartPos = scanner.fullStartPos;
    this.tokenStart = scanner.tokenStart;
    this.token = scanner.token;
    this.tokenFlags = scanner.tokenFlags;
    this.tokenValue = scanner.tokenValue;
    this.valueStart = scanner.valueStart;
    this.valueEnd = scanner.valueEnd;
    this.commentDirectiveCount = scanner.commentDirectives.length;
    this.skipJSDocLeadingAsterisks = scanner.skipJSDocLeadingAsterisks;
  }
}

/**
 * `[A-Za-z0-9_$]`, for an int32 code unit. The scanner's hot loops test this inline rather than
 * calling `isWordCharacter`, whose parameter native builds keep as a double.
 */
function isASCIIIdentifierPart(c: number): boolean {
  return (
    (c >= CharacterCodes.a && c <= CharacterCodes.z) ||
    (c >= CharacterCodes.A && c <= CharacterCodes.Z) ||
    (c >= CharacterCodes._0 && c <= CharacterCodes._9) ||
    c === CharacterCodes._ ||
    c === CharacterCodes.$
  );
}

/** FNV-1a over a range's code units. The identifier scan computes the same hash as it goes. */
function rangeHash(chars: Uint16Array, start: number, end: number): number {
  let hash = 0x811c9dc5 | 0;
  for (let i = start | 0; i < end; i = (i + 1) | 0) hash = Math.imul(hash ^ (chars[i] | 0), 0x01000193);
  return finishHash(hash);
}

function finishHash(hash: number): number {
  return hash ^ (hash >>> 15);
}

/**
 * Names for ranges of one text, keyed by their code units: equal identifiers share one
 * `IdentifierName`.
 */
class IdentifierTable {
  // Pairs of (entry index + 1, hash) per slot, (0, 0) when empty; linear probing.
  private slots: Int32Array;
  // Each entry's length in code units.
  private lengths: Int32Array;
  private names: IdentifierName[];
  private count: number;
  // Per entry: 1 once its name was recorded among the file's identifier texts (`markRecorded`).
  private recorded: Uint8Array;

  constructor() {
    this.slots = new Int32Array(512);
    this.lengths = new Int32Array(128);
    this.names = [];
    this.count = 0;
    this.recorded = new Uint8Array(128);
  }

  /** Empties the table for a new text. */
  clear(): void {
    if (this.count === 0) return;
    this.slots.fill(0);
    this.names.length = 0;
    this.recorded.fill(0, 0, this.count);
    this.count = 0;
  }

  /**
   * Whether `text`, the text of the entry `entry` that `intern` returned (-1 for none), still needs
   * recording among the file's identifier texts; marks it recorded. Texts the table doesn't know are
   * always recorded.
   */
  markRecorded(entry: number, text: string): boolean {
    if (entry < 0 || this.names[entry]!.text !== text) return true;
    if (this.recorded[entry] !== 0) return false;
    this.recorded[entry] = 1;
    return true;
  }

  /** The name of the entry `intern` returned. */
  name(entry: number): IdentifierName {
    return this.names[entry]!;
  }

  /**
   * The entry of `text.substring(start, end)`, added when the table has no equal range; `hash` is its
   * `rangeHash`. A candidate of the same hash and length is compared with `startsWith`, which natively
   * compares the bytes of both strings at once.
   */
  intern(text: string, start: number, end: number, hash: number): number {
    start = start | 0;
    end = end | 0;
    hash = hash | 0;
    const length = (end - start) | 0;
    const slots = this.slots;
    const mask = ((slots.length >> 1) - 1) | 0;
    let slot = hash & mask;
    for (;;) {
      const entry = slots[(slot * 2) | 0] | 0;
      if (entry === 0) break;
      if ((slots[(slot * 2 + 1) | 0] | 0) === hash && (this.lengths[(entry - 1) | 0] | 0) === length) {
        if (text.startsWith(this.names[(entry - 1) | 0]!.text, start)) return (entry - 1) | 0;
      }
      slot = (slot + 1) & mask;
    }
    const index = this.count | 0;
    if (index === this.lengths.length) {
      const lengths = new Int32Array(index * 2);
      lengths.set(this.lengths);
      this.lengths = lengths;
      const recorded = new Uint8Array(index * 2);
      recorded.set(this.recorded);
      this.recorded = recorded;
    }
    this.lengths[index] = length;
    this.names.push(new IdentifierName(text.substring(start, end)));
    this.count = (index + 1) | 0;
    slots[(slot * 2) | 0] = (index + 1) | 0;
    slots[(slot * 2 + 1) | 0] = hash;
    if (this.count * 2 > mask + 1) this.slots = rehash(slots);
    return index;
  }
}

/** `IdentifierTable` slots in a table twice the size. */
function rehash(old: Int32Array): Int32Array {
  const slots = new Int32Array(old.length * 2);
  const mask = slots.length / 2 - 1;
  for (let i = 0; i < old.length; i += 2) {
    const entry = old[i];
    if (entry === 0) continue;
    const hash = old[i + 1];
    let slot = hash & mask;
    while (slots[slot * 2] !== 0) slot = (slot + 1) & mask;
    slots[slot * 2] = entry;
    slots[slot * 2 + 1] = hash;
  }
  return slots;
}

/**
 * The code units a scanner with code units on demand copies at a time: few enough that the comments
 * of a large declaration file copy a small part of it, enough that a file whose comments are all
 * parsed is copied in a few hundred writes.
 */
const unitBlockSize = 1024;

function isLowSurrogate(ch: number): boolean {
  return ch >= 0xdc00 && ch <= 0xdfff;
}

/** Which line breaks a text holds, for the comment scans that search it (`Scanner.getTextKind`). */
const enum TextKind {
  Unknown = 0,
  /** Line feeds only. */
  LF = 1,
  /** Line feeds and carriage returns. */
  LFAndCR = 2,
  /** Also line or paragraph separators (U+2028, U+2029): comments are scanned code unit by code unit. */
  Separators = 3,
}

/** The UTF-16 code units of `text`, followed by zeros so the scanner can peek past the end. */
function toCodeUnits(text: string): Uint16Array {
  const chars = new Uint16Array(text.length + 4);
  Buffer.from(chars.buffer).write(text, 'utf16le');
  return chars;
}

// The two loops below scan long runs. They index `chars` from `pos` on an int32 counter, which
// native builds compile to an integer loop without allocating a view.

/** The position of the next `` ` ``, `$`, `\\` or CR at or after `pos`, or `end`. */
function skipTemplateText(chars: Uint16Array, pos: number, end: number): number {
  for (let i = pos | 0; i < end; i = (i + 1) | 0) {
    const c = chars[i] | 0;
    if (
      c === CharacterCodes.backtick ||
      c === CharacterCodes.$ ||
      c === CharacterCodes.backslash ||
      c === CharacterCodes.carriageReturn
    )
      return i;
  }
  return end;
}

/** The position of the next `*`, `@`, line break or non-ASCII unit at or after `pos`, or `end`. */
function skipCommentText(chars: Uint16Array, pos: number, end: number): number {
  for (let i = pos | 0; i < end; i = (i + 1) | 0) {
    const c = chars[i] | 0;
    if (
      c === CharacterCodes.asterisk ||
      c === CharacterCodes.at ||
      c === CharacterCodes.lineFeed ||
      c === CharacterCodes.carriageReturn ||
      c > CharacterCodes.maxAsciiCharacter
    )
      return i;
  }
  return end;
}

function hasPrefixAt(text: string, pos: number, prefix: string): boolean {
  if (pos + prefix.length > text.length) return false;
  for (let i = 0; i < prefix.length; i++) if (text.charCodeAt(pos + i) !== prefix.charCodeAt(i)) return false;
  return true;
}

/** Whether `chars[pos, end)` starts with `tag` followed by whitespace, `}`, `*` or `end`. */
function hasJSDocTag(chars: Uint16Array, pos: number, end: number, tag: string): boolean {
  const tagEnd = pos + tag.length;
  if (tagEnd > end) return false;
  for (let i = 0; i < tag.length; i++) if (chars[pos + i] !== tag.charCodeAt(i)) return false;
  if (tagEnd === end) return true;
  const ch = chars[tagEnd];
  return (
    ch === CharacterCodes.space ||
    ch === CharacterCodes.tab ||
    ch === CharacterCodes.lineFeed ||
    ch === CharacterCodes.carriageReturn ||
    ch === CharacterCodes.closeBrace ||
    ch === CharacterCodes.asterisk
  );
}

/** Adds the `@deprecated` and `@see`/`@link` flags for a JSDoc tag name at `pos`. */
function jsDocTagFlags(chars: Uint16Array, pos: number, end: number, flags: TokenFlags): TokenFlags {
  if ((flags & TokenFlags.PrecedingJSDocWithDeprecated) === 0 && hasJSDocTag(chars, pos, end, 'deprecated'))
    flags |= TokenFlags.PrecedingJSDocWithDeprecated;
  if (
    (flags & TokenFlags.PrecedingJSDocWithSeeOrLink) === 0 &&
    (hasJSDocTag(chars, pos, end, 'see') ||
      hasJSDocTag(chars, pos, end, 'link') ||
      hasJSDocTag(chars, pos, end, 'linkcode') ||
      hasJSDocTag(chars, pos, end, 'linkplain'))
  )
    flags |= TokenFlags.PrecedingJSDocWithSeeOrLink;
  return flags;
}

function hexByte(value: number): string {
  const hex = value.toString(16);
  return hex.length < 2 ? '\\x0' + hex : '\\x' + hex;
}

function regularExpressionFlagName(target: ScriptTarget): string {
  switch (target) {
    case ScriptTarget.ES2018:
      return 'es2018';
    case ScriptTarget.ES2022:
      return 'es2022';
    default:
      return 'es2024';
  }
}

/**
 * Tokenizes TypeScript and JavaScript source text. Positions are UTF-16 offsets.
 *
 * ```ts
 * const scanner = new Scanner();
 * scanner.setText(text);
 * while (scanner.scan() !== SyntaxKind.EndOfFile) console.log(scanner.getTokenText());
 * ```
 */
export class Scanner {
  /** @internal */ text: string;
  // The text's UTF-16 code units: indexing a typed array is much cheaper than
  // `charCodeAt` on large native strings.
  /** @internal */ chars: Uint16Array;
  /** @internal */ end: number;
  private languageVariant: LanguageVariant;
  private scriptTarget: ScriptTarget;
  private onError: ScannerErrorReporter | undefined;
  private skipTrivia: boolean;

  // Writes of the token offsets below are coerced with `| 0` where the compiler can't bound the
  // value, so native builds store them as 32-bit integers. `pos` too: every write (also in the
  // regular expression checker) is `(pos + n) | 0` or an int32 value, never `++` or `+=`, and hot
  // loops copy it into an int32 local and read code units as `chars[i] | 0`, so they run on
  // integers instead of doubles. Positions stay far below 2^31, so `| 0` never changes a value.
  /** @internal Current position; the end of the current token. */
  pos: number;
  /** @internal */ fullStartPos: number;
  /** @internal */ tokenStart: number;
  /** @internal */ token: SyntaxKind;
  /** @internal */ tokenFlags: TokenFlags;
  // The token value is `text[valueStart, valueEnd)` while `valueStart >= 0`,
  // so identifiers and keywords don't allocate until their value is read.
  /** @internal */ tokenValue: string;
  /** @internal */ valueStart: number;
  // The name `getIdentifierValue` last interned, whose text `tokenValue` then holds.
  private tokenName: IdentifierName | undefined;
  /** @internal */ valueEnd: number;
  // `rangeHash` of `chars[hashStart, hashEnd)`, which the ASCII identifier scan computes as it goes.
  private valueHash: number;
  private hashStart: number;
  private hashEnd: number;
  /** @internal */ commentDirectives: CommentDirective[];
  /** @internal */ skipJSDocLeadingAsterisks: number;
  // The code units zeroed by `setTextEnd`.
  private readonly cutUnits: Uint16Array;
  private readonly identifiers: IdentifierTable;
  // The entry `getIdentifierValue` last interned, -1 for none.
  private lastEntry: number;
  // With code units on demand: per block of `unitBlockSize` code units, 1 once `chars` holds them
  // (`loadUnits`); `chars` is zero elsewhere.
  private loadedBlocks: Uint8Array | undefined;
  // The line breaks the text holds, computed on first use.
  private textKind: TextKind;
  // The first LF and CR at or after `lineFeedFrom` and `carriageReturnFrom`: `lineFeedAt` and
  // `carriageReturnAt` (the text length where there is none), found by `nextLineFeed` and
  // `nextCarriageReturn`. -1 for none found yet.
  private lineFeedFrom: number;
  private lineFeedAt: number;
  private carriageReturnFrom: number;
  private carriageReturnAt: number;

  /**
   * With `unitsOnDemand`, the code units of the text are copied only for the ranges passed to
   * `loadUnits`, for scanning a few ranges of a large text.
   */
  constructor(text = '', unitsOnDemand = false) {
    this.text = text;
    if (unitsOnDemand) {
      this.chars = new Uint16Array(text.length + 4);
      this.loadedBlocks = new Uint8Array(((text.length + unitBlockSize - 1) / unitBlockSize) | 0);
    } else {
      this.chars = toCodeUnits(text);
      this.loadedBlocks = undefined;
    }
    this.end = text.length | 0;
    this.languageVariant = LanguageVariant.Standard;
    this.scriptTarget = ScriptTarget.None;
    this.onError = undefined;
    this.skipTrivia = true;
    this.pos = 0;
    this.fullStartPos = 0;
    this.tokenStart = 0;
    this.token = SyntaxKind.Unknown;
    this.tokenFlags = TokenFlags.None;
    this.tokenValue = '';
    this.valueStart = -1;
    this.tokenName = undefined;
    this.valueEnd = -1;
    this.valueHash = 0;
    this.hashStart = -1;
    this.hashEnd = -1;
    this.commentDirectives = [];
    this.skipJSDocLeadingAsterisks = 0;
    this.cutUnits = new Uint16Array(4);
    this.identifiers = new IdentifierTable();
    this.lastEntry = -1;
    this.textKind = TextKind.Unknown;
    this.lineFeedFrom = -1;
    this.lineFeedAt = -1;
    this.carriageReturnFrom = -1;
    this.carriageReturnAt = -1;
  }

  /** Sets the text to scan and resets the token state. */
  setText(text: string): void {
    this.text = text;
    this.chars = toCodeUnits(text);
    this.loadedBlocks = undefined;
    this.identifiers.clear();
    this.lastEntry = -1;
    this.textKind = TextKind.Unknown;
    this.lineFeedFrom = -1;
    this.lineFeedAt = -1;
    this.carriageReturnFrom = -1;
    this.carriageReturnAt = -1;
    this.end = text.length | 0;
    this.pos = 0;
    this.fullStartPos = 0;
    this.tokenStart = 0;
    this.token = SyntaxKind.Unknown;
    this.tokenFlags = TokenFlags.None;
    this.tokenValue = '';
    this.valueStart = -1;
    this.hashStart = -1;
    this.commentDirectives = [];
    this.skipJSDocLeadingAsterisks = 0;
  }

  /** @internal Like `setText(text.substring(0, end))` without copying, but keeps comment directives; pass the text length to undo. */
  setTextEnd(end: number): void {
    const chars = this.chars;
    const cut = this.cutUnits;
    // Restore the units zeroed by the previous call, then zero the units past `end`.
    if (this.end < this.text.length) for (let i = 0; i < 4; i++) chars[this.end + i] = cut[i];
    if (end < this.text.length)
      for (let i = 0; i < 4; i++) {
        cut[i] = chars[end + i];
        chars[end + i] = 0;
      }
    this.end = end | 0;
    this.pos = 0;
    this.fullStartPos = 0;
    this.tokenStart = 0;
    this.token = SyntaxKind.Unknown;
    this.tokenFlags = TokenFlags.None;
    this.tokenValue = '';
    this.valueStart = -1;
    this.hashStart = -1;
    this.skipJSDocLeadingAsterisks = 0;
  }

  /**
   * @internal Where the scanner copies code units on demand, copies those of `text[start, end)`
   * and the four around each end, a block of `unitBlockSize` units at a time (and whole surrogate
   * pairs); otherwise does nothing.
   */
  loadUnits(start: number, end: number): void {
    const blocks = this.loadedBlocks;
    if (blocks === undefined) return;
    const text = this.text;
    const length = text.length;
    const last = Math.min(blocks.length - 1, ((end + 4) / unitBlockSize) | 0);
    for (let block = (Math.max(0, start - 4) / unitBlockSize) | 0; block <= last; block++) {
      if (blocks[block] !== 0) continue;
      // The run of blocks not copied yet.
      let runEnd = block;
      while (runEnd < last && blocks[runEnd + 1] === 0) runEnd++;
      let from = block * unitBlockSize;
      let to = Math.min(length, (runEnd + 1) * unitBlockSize);
      if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from--;
      if (to < length && isLowSurrogate(text.charCodeAt(to))) to++;
      Buffer.from(this.chars.buffer, from * 2, (to - from) * 2).write(text.substring(from, to), 'utf16le');
      blocks.fill(1, block, runEnd + 1);
      block = runEnd;
    }
  }

  setOnError(reporter: ScannerErrorReporter | undefined): void {
    this.onError = reporter;
  }

  setLanguageVariant(languageVariant: LanguageVariant): void {
    this.languageVariant = languageVariant;
  }

  setScriptTarget(scriptTarget: ScriptTarget): void {
    this.scriptTarget = scriptTarget;
  }

  /** When false, `scan` returns whitespace, newline and comment trivia tokens. */
  setSkipTrivia(skip: boolean): void {
    this.skipTrivia = skip;
  }

  /** Nests skipping of JSDoc leading `*` after line breaks; balance every `true` with a `false`. */
  setSkipJSDocLeadingAsterisks(skip: boolean): void {
    this.skipJSDocLeadingAsterisks += skip ? 1 : -1;
  }

  getText(): string {
    return this.text;
  }

  getToken(): SyntaxKind {
    return this.token;
  }

  getTokenFlags(): TokenFlags {
    return this.tokenFlags;
  }

  /** Start of the token including leading trivia. */
  getTokenFullStart(): number {
    return this.fullStartPos;
  }

  getTokenStart(): number {
    return this.tokenStart;
  }

  getTokenEnd(): number {
    return this.pos;
  }

  getTokenText(): string {
    return this.text.substring(this.tokenStart, this.pos);
  }

  /** The cooked value: identifier text, string contents, normalized number, etc. */
  getTokenValue(): string {
    if (this.valueStart >= 0) {
      this.tokenValue = this.text.substring(this.valueStart, this.valueEnd);
      this.valueStart = -1;
    }
    return this.tokenValue;
  }

  /**
   * Whether `text`, the identifier value just returned by `getIdentifierValue`, is the first of its
   * file to be recorded; files record each identifier text once.
   */
  recordIdentifierValue(text: string): boolean {
    return this.identifiers.markRecorded(this.lastEntry, text);
  }

  /** @internal Like `getTokenValue`, but identifiers with the same text share one string. */
  getIdentifierValue(): string {
    const start = this.valueStart;
    if (start >= 0) {
      const end = this.valueEnd;
      const hash =
        start === this.hashStart && end === this.hashEnd ? this.valueHash : rangeHash(this.chars, start, end);
      const entry = this.identifiers.intern(this.text, start, end, hash);
      this.lastEntry = entry;
      this.tokenName = this.identifiers.name(entry);
      this.tokenValue = this.tokenName.text;
      this.valueStart = -1;
    }
    return this.tokenValue;
  }

  /**
   * The identifier value as a name that identifiers with the same text share, after
   * `getIdentifierValue`; a cooked value (with escapes) gets a name of its own.
   */
  getIdentifierName(): IdentifierName {
    const name = this.tokenName;
    if (name !== undefined && name.text === this.tokenValue) return name;
    return new IdentifierName(this.tokenValue);
  }

  getCommentDirectives(): readonly CommentDirective[] {
    return this.commentDirectives;
  }

  hasUnicodeEscape(): boolean {
    return (this.tokenFlags & TokenFlags.UnicodeEscape) !== 0;
  }

  hasExtendedUnicodeEscape(): boolean {
    return (this.tokenFlags & TokenFlags.ExtendedUnicodeEscape) !== 0;
  }

  hasPrecedingLineBreak(): boolean {
    return (this.tokenFlags & TokenFlags.PrecedingLineBreak) !== 0;
  }

  hasPrecedingJSDocComment(): boolean {
    return (this.tokenFlags & TokenFlags.PrecedingJSDocComment) !== 0;
  }

  hasPrecedingJSDocLeadingAsterisks(): boolean {
    return (this.tokenFlags & TokenFlags.PrecedingJSDocLeadingAsterisks) !== 0;
  }

  hasPrecedingJSDocWithDeprecatedTag(): boolean {
    return (this.tokenFlags & TokenFlags.PrecedingJSDocWithDeprecated) !== 0;
  }

  hasPrecedingJSDocWithSeeOrLink(): boolean {
    return (this.tokenFlags & TokenFlags.PrecedingJSDocWithSeeOrLink) !== 0;
  }

  isUnterminated(): boolean {
    return (this.tokenFlags & TokenFlags.Unterminated) !== 0;
  }

  mark(): ScannerState {
    return new ScannerState(
      this.pos,
      this.fullStartPos,
      this.tokenStart,
      this.token,
      this.tokenFlags,
      this.tokenValue,
      this.valueStart,
      this.valueEnd,
      this.commentDirectives.length,
      this.skipJSDocLeadingAsterisks,
    );
  }

  rewind(state: ScannerState): void {
    this.pos = state.pos;
    this.fullStartPos = state.fullStartPos;
    this.tokenStart = state.tokenStart;
    this.token = state.token;
    this.tokenFlags = state.tokenFlags;
    this.tokenValue = state.tokenValue;
    this.valueStart = state.valueStart;
    this.valueEnd = state.valueEnd;
    while (this.commentDirectives.length > state.commentDirectiveCount) this.commentDirectives.pop();
    this.skipJSDocLeadingAsterisks = state.skipJSDocLeadingAsterisks;
  }

  /** Runs `callback` and restores the scanner state afterwards. */
  lookAhead<T>(callback: () => T): T {
    const state = this.mark();
    const result = callback();
    this.rewind(state);
    return result;
  }

  /** Runs `callback` and restores the scanner state if it returns `undefined`. */
  tryScan<T>(callback: () => T | undefined): T | undefined {
    const state = this.mark();
    const result = callback();
    if (result === undefined) this.rewind(state);
    return result;
  }

  /** Moves to `pos` without changing the current token. */
  resetPos(pos: number): void {
    if (pos < 0) throw new Error('Cannot reset token state to negative position');
    this.pos = pos | 0;
    this.fullStartPos = pos | 0;
    this.tokenStart = pos | 0;
  }

  resetTokenState(pos: number): void {
    this.resetPos(pos);
    this.token = SyntaxKind.Unknown;
    this.tokenValue = '';
    this.valueStart = -1;
    this.tokenFlags = TokenFlags.None;
  }

  /** @internal */
  languageVersion(): ScriptTarget {
    return this.scriptTarget === ScriptTarget.None ? ScriptTarget.Latest : this.scriptTarget;
  }

  private error(message: DiagnosticMessage): void {
    this.errorAt(message, this.pos, 0, noArgs);
  }

  /** @internal */
  errorAt(message: DiagnosticMessage, start: number, length: number, args: readonly string[]): void {
    if (this.onError !== undefined) this.onError.onError(message, start, length, args);
  }

  /** @internal The code unit at `pos`, or -1 at the end. */
  char(): number {
    return this.pos < this.end ? this.chars[this.pos] | 0 : CharacterCodes.EOF;
  }

  /** @internal The code unit at `pos + offset`, or -1 past the end. */
  peek(offset: number): number {
    const at = (this.pos + offset) | 0;
    return at < this.end ? this.chars[at] | 0 : CharacterCodes.EOF;
  }

  /** @internal The code point at `pos`, or -1 at the end. */
  codePoint(): number {
    return this.codePointAt(this.pos, this.end);
  }

  /** @internal The code point at `pos`, combining a surrogate pair; -1 at or past `end`. */
  codePointAt(pos: number, end: number): number {
    if (pos >= end) return CharacterCodes.EOF;
    const chars = this.chars;
    const ch = chars[pos] | 0;
    if (ch >= 0xd800 && ch <= 0xdbff && pos + 1 < end) {
      const low = chars[pos + 1] | 0;
      if (low >= 0xdc00 && low <= 0xdfff) return (ch - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
    return ch;
  }

  /** The code point ending just before `pos`; -1 at the start. */
  private codePointBefore(pos: number): number {
    if (pos <= 0) return CharacterCodes.EOF;
    const ch = this.chars[pos - 1] | 0;
    if (ch >= 0xdc00 && ch <= 0xdfff && pos >= 2) {
      const high = this.chars[pos - 2] | 0;
      if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (ch - 0xdc00) + 0x10000;
    }
    return ch;
  }

  private setValue(value: string): void {
    this.tokenValue = value;
    this.valueStart = -1;
  }

  private setValueSlice(start: number, end: number): void {
    this.valueStart = start | 0;
    this.valueEnd = end | 0;
  }

  scan(): SyntaxKind {
    // `chars` is zero-padded, so peeking a few units past the end is safe.
    const chars = this.chars;
    this.fullStartPos = this.pos | 0;
    this.tokenFlags = TokenFlags.None;
    for (;;) {
      const ch = this.pos < this.end ? chars[this.pos] | 0 : CharacterCodes.EOF;
      this.tokenStart = this.pos | 0;
      switch (ch) {
        case CharacterCodes.tab:
        case CharacterCodes.verticalTab:
        case CharacterCodes.formFeed:
        case CharacterCodes.space:
          if (this.skipTrivia) {
            let pos = (this.pos + 1) | 0;
            const end = this.end;
            while (pos < end) {
              const c = chars[pos] | 0;
              if (c !== CharacterCodes.space && c !== CharacterCodes.tab) break;
              pos = (pos + 1) | 0;
            }
            this.pos = pos;
            continue;
          }
          this.pos = (this.pos + 1) | 0;
          while (this.pos < this.end && isWhiteSpaceSingleLine(chars[this.pos] | 0)) this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.WhitespaceTrivia);
        case CharacterCodes.lineFeed:
        case CharacterCodes.carriageReturn:
          this.tokenFlags |= TokenFlags.PrecedingLineBreak;
          if (this.skipTrivia) {
            let pos = (this.pos + 1) | 0;
            const end = this.end;
            while (pos < end) {
              const c = chars[pos] | 0;
              if (c !== CharacterCodes.space && (c < CharacterCodes.tab || c > CharacterCodes.carriageReturn)) break;
              pos = (pos + 1) | 0;
            }
            this.pos = pos;
            continue;
          }
          this.pos =
            (this.pos +
              (ch === CharacterCodes.carriageReturn && (chars[this.pos + 1] | 0) === CharacterCodes.lineFeed ? 2 : 1)) |
            0;
          return (this.token = SyntaxKind.NewLineTrivia);
        case CharacterCodes.exclamation:
          if ((chars[this.pos + 1] | 0) === CharacterCodes.equals) {
            if ((chars[this.pos + 2] | 0) === CharacterCodes.equals) {
              this.pos = (this.pos + 3) | 0;
              return (this.token = SyntaxKind.ExclamationEqualsEqualsToken);
            }
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.ExclamationEqualsToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.ExclamationToken);
        case CharacterCodes.doubleQuote:
        case CharacterCodes.singleQuote:
          this.scanString(false);
          return (this.token = SyntaxKind.StringLiteral);
        case CharacterCodes.backtick:
          return (this.token = this.scanTemplateAndSetTokenValue(false));
        case CharacterCodes.percent:
          if ((chars[this.pos + 1] | 0) === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.PercentEqualsToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.PercentToken);
        case CharacterCodes.ampersand: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.ampersand) {
            if ((chars[this.pos + 2] | 0) === CharacterCodes.equals) {
              this.pos = (this.pos + 3) | 0;
              return (this.token = SyntaxKind.AmpersandAmpersandEqualsToken);
            }
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.AmpersandAmpersandToken);
          }
          if (next === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.AmpersandEqualsToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.AmpersandToken);
        }
        case CharacterCodes.openParen:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.OpenParenToken);
        case CharacterCodes.closeParen:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.CloseParenToken);
        case CharacterCodes.asterisk: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.AsteriskEqualsToken);
          }
          if (next === CharacterCodes.asterisk) {
            if ((chars[this.pos + 2] | 0) === CharacterCodes.equals) {
              this.pos = (this.pos + 3) | 0;
              return (this.token = SyntaxKind.AsteriskAsteriskEqualsToken);
            }
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.AsteriskAsteriskToken);
          }
          this.pos = (this.pos + 1) | 0;
          if (
            this.skipJSDocLeadingAsterisks !== 0 &&
            (this.tokenFlags & TokenFlags.PrecedingJSDocLeadingAsterisks) === 0 &&
            (this.tokenFlags & TokenFlags.PrecedingLineBreak) !== 0
          ) {
            this.tokenFlags |= TokenFlags.PrecedingJSDocLeadingAsterisks;
            continue;
          }
          return (this.token = SyntaxKind.AsteriskToken);
        }
        case CharacterCodes.plus: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.PlusEqualsToken);
          }
          if (next === CharacterCodes.plus) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.PlusPlusToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.PlusToken);
        }
        case CharacterCodes.comma:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.CommaToken);
        case CharacterCodes.minus: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.MinusEqualsToken);
          }
          if (next === CharacterCodes.minus) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.MinusMinusToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.MinusToken);
        }
        case CharacterCodes.dot: {
          const next = chars[this.pos + 1] | 0;
          if (isDigit(next)) return (this.token = this.scanNumber());
          if (next === CharacterCodes.dot && (chars[this.pos + 2] | 0) === CharacterCodes.dot) {
            this.pos = (this.pos + 3) | 0;
            return (this.token = SyntaxKind.DotDotDotToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.DotToken);
        }
        case CharacterCodes.slash: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.slash) {
            const pos = this.lineCommentEnd((this.pos + 2) | 0);
            this.pos = pos;
            this.processCommentDirective(this.tokenStart, pos, false);
            if (this.skipTrivia) continue;
            return (this.token = SyntaxKind.SingleLineCommentTrivia);
          }
          if (next === CharacterCodes.asterisk) {
            if (this.scanMultiLineComment()) continue;
            return (this.token = SyntaxKind.MultiLineCommentTrivia);
          }
          if (next === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.SlashEqualsToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.SlashToken);
        }
        case CharacterCodes._0: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.X || next === CharacterCodes.x) return (this.token = this.scanHexNumber());
          if (next === CharacterCodes.B || next === CharacterCodes.b)
            return (this.token = this.scanBinaryOrOctalNumber(2));
          if (next === CharacterCodes.O || next === CharacterCodes.o)
            return (this.token = this.scanBinaryOrOctalNumber(8));
          return (this.token = this.scanNumber());
        }
        case CharacterCodes._1:
        case CharacterCodes._2:
        case CharacterCodes._3:
        case CharacterCodes._4:
        case CharacterCodes._5:
        case CharacterCodes._6:
        case CharacterCodes._7:
        case CharacterCodes._8:
        case CharacterCodes._9:
          return (this.token = this.scanNumber());
        case CharacterCodes.colon:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.ColonToken);
        case CharacterCodes.semicolon:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.SemicolonToken);
        case CharacterCodes.lessThan: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.lessThan && isConflictMarkerTrivia(this.text, this.pos)) {
            if (this.scanConflictMarker()) continue;
            return (this.token = SyntaxKind.ConflictMarkerTrivia);
          }
          if (next === CharacterCodes.lessThan) {
            if ((chars[this.pos + 2] | 0) === CharacterCodes.equals) {
              this.pos = (this.pos + 3) | 0;
              return (this.token = SyntaxKind.LessThanLessThanEqualsToken);
            }
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.LessThanLessThanToken);
          }
          if (next === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.LessThanEqualsToken);
          }
          if (
            this.languageVariant === LanguageVariant.JSX &&
            next === CharacterCodes.slash &&
            (chars[this.pos + 2] | 0) !== CharacterCodes.asterisk
          ) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.LessThanSlashToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.LessThanToken);
        }
        case CharacterCodes.equals: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.equals && isConflictMarkerTrivia(this.text, this.pos)) {
            if (this.scanConflictMarker()) continue;
            return (this.token = SyntaxKind.ConflictMarkerTrivia);
          }
          if (next === CharacterCodes.equals) {
            if ((chars[this.pos + 2] | 0) === CharacterCodes.equals) {
              this.pos = (this.pos + 3) | 0;
              return (this.token = SyntaxKind.EqualsEqualsEqualsToken);
            }
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.EqualsEqualsToken);
          }
          if (next === CharacterCodes.greaterThan) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.EqualsGreaterThanToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.EqualsToken);
        }
        case CharacterCodes.greaterThan:
          if ((chars[this.pos + 1] | 0) === CharacterCodes.greaterThan && isConflictMarkerTrivia(this.text, this.pos)) {
            if (this.scanConflictMarker()) continue;
            return (this.token = SyntaxKind.ConflictMarkerTrivia);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.GreaterThanToken);
        case CharacterCodes.question: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.dot && !isDigit(chars[this.pos + 2] | 0)) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.QuestionDotToken);
          }
          if (next === CharacterCodes.question) {
            if ((chars[this.pos + 2] | 0) === CharacterCodes.equals) {
              this.pos = (this.pos + 3) | 0;
              return (this.token = SyntaxKind.QuestionQuestionEqualsToken);
            }
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.QuestionQuestionToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.QuestionToken);
        }
        case CharacterCodes.openBracket:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.OpenBracketToken);
        case CharacterCodes.closeBracket:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.CloseBracketToken);
        case CharacterCodes.caret:
          if ((chars[this.pos + 1] | 0) === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.CaretEqualsToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.CaretToken);
        case CharacterCodes.openBrace:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.OpenBraceToken);
        case CharacterCodes.bar: {
          const next = chars[this.pos + 1] | 0;
          if (next === CharacterCodes.bar && isConflictMarkerTrivia(this.text, this.pos)) {
            if (this.scanConflictMarker()) continue;
            return (this.token = SyntaxKind.ConflictMarkerTrivia);
          }
          if (next === CharacterCodes.bar) {
            if ((chars[this.pos + 2] | 0) === CharacterCodes.equals) {
              this.pos = (this.pos + 3) | 0;
              return (this.token = SyntaxKind.BarBarEqualsToken);
            }
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.BarBarToken);
          }
          if (next === CharacterCodes.equals) {
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.BarEqualsToken);
          }
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.BarToken);
        }
        case CharacterCodes.closeBrace:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.CloseBraceToken);
        case CharacterCodes.tilde:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.TildeToken);
        case CharacterCodes.at:
          this.pos = (this.pos + 1) | 0;
          return (this.token = SyntaxKind.AtToken);
        case CharacterCodes.backslash:
          if (this.scanIdentifier(0, IdentifierVariant.Standard))
            return (this.token = getIdentifierToken(this.tokenValue));
          return this.scanInvalidCharacter();
        case CharacterCodes.hash:
          if ((chars[this.pos + 1] | 0) === CharacterCodes.exclamation) {
            if (this.pos === 0) {
              this.pos = scanShebangTrivia(this.text, 0) | 0;
              continue;
            }
            this.errorAt(Diagnostics.X_can_only_be_used_at_the_start_of_a_file, this.pos, 2, noArgs);
            this.pos = (this.pos + 2) | 0;
            return (this.token = SyntaxKind.Unknown);
          }
          if (!this.scanIdentifier(1, IdentifierVariant.Standard)) {
            this.errorAt(Diagnostics.Invalid_character, this.pos - 1, 1, noArgs);
            this.setValue('#');
          }
          return (this.token = SyntaxKind.PrivateIdentifier);
        default: {
          if (ch < 0) return (this.token = SyntaxKind.EndOfFile);
          if (this.scanIdentifier(0, IdentifierVariant.Standard)) return (this.token = this.identifierKind());
          const codePoint = this.codePoint();
          if (codePoint === CharacterCodes.replacementCharacter) {
            this.errorAt(Diagnostics.File_appears_to_be_binary, 0, 0, noArgs);
            this.pos = this.end;
            return (this.token = SyntaxKind.NonTextFileMarkerTrivia);
          }
          if (isWhiteSpaceSingleLine(codePoint)) {
            this.pos = (this.pos + 1) | 0;
            if (codePoint === CharacterCodes.nextLine || this.skipTrivia) continue;
            while (this.pos < this.end && isWhiteSpaceSingleLine(chars[this.pos] | 0)) this.pos = (this.pos + 1) | 0;
            return (this.token = SyntaxKind.WhitespaceTrivia);
          }
          if (isLineBreak(codePoint)) {
            this.tokenFlags |= TokenFlags.PrecedingLineBreak;
            this.pos = (this.pos + 1) | 0;
            continue;
          }
          return this.scanInvalidCharacter();
        }
      }
    }
  }

  /** The kind of the identifier just scanned by `scanIdentifier`. */
  private identifierKind(): SyntaxKind {
    return this.valueStart >= 0
      ? keywordKindAt(this.chars, this.valueStart, this.valueEnd)
      : getIdentifierToken(this.tokenValue);
  }

  /** The line breaks the text holds, found once per text. */
  private getTextKind(): TextKind {
    let kind = this.textKind;
    if (kind === TextKind.Unknown) {
      const text = this.text;
      // Natively, the UTF-8 length is known without a search, and ASCII texts hold no separators.
      if (
        Buffer.byteLength(text, 'utf8') !== text.length &&
        (text.indexOf('\u2028') >= 0 || text.indexOf('\u2029') >= 0)
      )
        kind = TextKind.Separators;
      else kind = text.indexOf('\r') >= 0 ? TextKind.LFAndCR : TextKind.LF;
      this.textKind = kind;
    }
    return kind;
  }

  /**
   * The end of the line comment whose text starts at `pos`: the next line break, or `end`. Found with
   * string searches (natively, byte searches) instead of a loop over code units, except in texts with
   * line or paragraph separators.
   */
  private lineCommentEnd(pos: number): number {
    const end = this.end;
    const kind = this.getTextKind();
    if (kind !== TextKind.Separators) {
      let at = this.nextLineFeed(pos);
      if (kind === TextKind.LFAndCR) at = Math.min(at, this.nextCarriageReturn(pos));
      return at > end ? end : at | 0;
    }
    const chars = this.chars;
    while (pos < end && !isLineBreak(chars[pos] | 0)) pos = (pos + 1) | 0;
    return pos;
  }

  /**
   * The position of the first LF at or after `pos`, or the text length. The last result is kept: as
   * the scanner moves forward each search starts where the previous one ended, so a text with few
   * LFs (CR line breaks) is not searched to its end once per line comment.
   */
  private nextLineFeed(pos: number): number {
    if (pos >= this.lineFeedFrom && pos <= this.lineFeedAt) return this.lineFeedAt;
    const text = this.text;
    const at = text.indexOf('\n', pos);
    this.lineFeedFrom = pos;
    this.lineFeedAt = at < 0 ? text.length : at;
    return this.lineFeedAt;
  }

  /** Like `nextLineFeed`, for CR: a text with LF line breaks and few CRs is searched once. */
  private nextCarriageReturn(pos: number): number {
    if (pos >= this.carriageReturnFrom && pos <= this.carriageReturnAt) return this.carriageReturnAt;
    const text = this.text;
    const at = text.indexOf('\r', pos);
    this.carriageReturnFrom = pos;
    this.carriageReturnAt = at < 0 ? text.length : at;
    return this.carriageReturnAt;
  }

  /** Scans `/* … *\/`; returns true if the comment is skipped as trivia. */
  private scanMultiLineComment(): boolean {
    const chars = this.chars;
    const end = this.end;
    let pos = (this.pos + 2) | 0;
    const isJSDoc =
      pos < end && (chars[pos] | 0) === CharacterCodes.asterisk && (chars[pos + 1] | 0) !== CharacterCodes.slash;
    let closed = false;
    let lastLineStart = this.tokenStart;
    let flags = this.tokenFlags;
    if (isJSDoc) flags |= TokenFlags.PrecedingJSDocComment;
    const kind = this.getTextKind();
    if (kind !== TextKind.Separators) {
      // String searches for the closing `*/`, then for the line breaks and JSDoc tags in the comment,
      // instead of a loop over code units; not in texts with line or paragraph separators.
      const text = this.text;
      const close = text.indexOf('*/', pos);
      closed = close >= 0 && close + 2 <= end;
      const bodyEnd = closed ? close : end;
      if (pos < bodyEnd) {
        const body = text.substring(pos, bodyEnd);
        // A forward search first: most comments have no line break, and searching back is slower.
        let lastBreak = body.indexOf('\n') >= 0 ? body.lastIndexOf('\n') : -1;
        if (kind === TextKind.LFAndCR && body.indexOf('\r') >= 0)
          lastBreak = Math.max(lastBreak, body.lastIndexOf('\r'));
        if (lastBreak >= 0) {
          lastLineStart = (pos + lastBreak + 1) | 0;
          flags |= TokenFlags.PrecedingLineBreak;
        }
        if (isJSDoc)
          for (let at = body.indexOf('@'); at >= 0; at = body.indexOf('@', at + 1))
            flags = jsDocTagFlags(chars, pos + at + 1, end, flags);
      }
      pos = closed ? (close + 2) | 0 : end;
    } else {
      while (pos < end) {
        pos = skipCommentText(chars, pos, end) | 0;
        if (pos >= end) break;
        const c = chars[pos] | 0;
        pos = (pos + 1) | 0;
        if (c === CharacterCodes.asterisk) {
          if ((chars[pos] | 0) === CharacterCodes.slash) {
            pos = (pos + 1) | 0;
            closed = true;
            break;
          }
        } else if (c === CharacterCodes.lineFeed || c === CharacterCodes.carriageReturn || c >= 0x2028) {
          if (isLineBreak(c)) {
            lastLineStart = pos;
            flags |= TokenFlags.PrecedingLineBreak;
          }
        } else if (c === CharacterCodes.at && isJSDoc) {
          flags = jsDocTagFlags(chars, pos, end, flags);
        }
      }
    }
    this.pos = pos;
    this.tokenFlags = flags;
    this.processCommentDirective(lastLineStart, pos, true);
    if (!closed) this.error(Diagnostics.Asterisk_Slash_expected);
    if (this.skipTrivia) return true;
    if (!closed) this.tokenFlags |= TokenFlags.Unterminated;
    return false;
  }

  /** Scans a merge conflict marker; returns true if it is skipped as trivia. */
  private scanConflictMarker(): boolean {
    this.pos = scanConflictMarkerTrivia(this.text, this.pos, this) | 0;
    return this.skipTrivia;
  }

  private processCommentDirective(start: number, end: number, multiline: boolean): void {
    const text = this.text;
    const chars = this.chars;
    let pos = start;
    if (multiline) {
      while (pos < end && (chars[pos] === CharacterCodes.space || chars[pos] === CharacterCodes.tab)) pos++;
      while (pos < end && (chars[pos] === CharacterCodes.slash || chars[pos] === CharacterCodes.asterisk)) pos++;
    } else {
      pos += 2;
      while (pos < end && chars[pos] === CharacterCodes.slash) pos++;
    }
    while (pos < end && (chars[pos] === CharacterCodes.space || chars[pos] === CharacterCodes.tab)) pos++;
    if (!(pos < end && chars[pos] === CharacterCodes.at)) return;
    pos++;
    let kind: CommentDirectiveKind;
    if (hasPrefixAt(text, pos, 'ts-expect-error')) kind = CommentDirectiveKind.ExpectError;
    else if (hasPrefixAt(text, pos, 'ts-ignore')) kind = CommentDirectiveKind.Ignore;
    else return;
    this.commentDirectives.push(new CommentDirective(start, end, kind));
  }

  /**
   * @internal Scans an identifier after `prefixLength` units; sets the token value. `variant`
   * decides the identifier parts: JSX and JSDoc names also take `-`, and regular expression group
   * names take a surrogate pair written as two `\u` escapes.
   */
  scanIdentifier(prefixLength: number, variant: IdentifierVariant): boolean {
    const text = this.text;
    const chars = this.chars;
    const start = this.pos;
    this.pos = (this.pos + prefixLength) | 0;
    const identifierStart = this.pos;
    let ch = this.char();
    if (variant === IdentifierVariant.JSX) {
      if (isASCIILetter(ch) || ch === CharacterCodes._ || ch === CharacterCodes.$) {
        // ASCII names, as the general loop below scans them.
        let pos = (this.pos + 1) | 0;
        const end = this.end;
        while (pos < end) {
          const c = chars[pos] | 0;
          if (!isASCIIIdentifierPart(c) && c !== CharacterCodes.minus) break;
          pos = (pos + 1) | 0;
        }
        const next = pos < end ? chars[pos] | 0 : CharacterCodes.EOF;
        if (next <= CharacterCodes.maxAsciiCharacter && next !== CharacterCodes.backslash) {
          this.pos = pos;
          this.setValueSlice(start, pos);
          return true;
        }
      }
    } else if (isASCIILetter(ch) || ch === CharacterCodes._ || ch === CharacterCodes.$) {
      // Fast path for ASCII identifiers, which also hashes the units for interning.
      let pos = (this.pos + 1) | 0;
      const end = this.end;
      // The FNV-1a offset basis, as in `rangeHash` (a literal: native builds load module constants).
      let hash = 0x811c9dc5 | 0;
      for (let i = start; i < pos; i = (i + 1) | 0) hash = Math.imul(hash ^ (chars[i] | 0), 0x01000193);
      while (pos < end) {
        const c = chars[pos] | 0;
        if (!isASCIIIdentifierPart(c)) break;
        hash = Math.imul(hash ^ c, 0x01000193);
        pos = (pos + 1) | 0;
      }
      this.pos = pos;
      ch = pos < end ? chars[pos] | 0 : CharacterCodes.EOF;
      if (ch <= CharacterCodes.maxAsciiCharacter && ch !== CharacterCodes.backslash) {
        this.setValueSlice(start, pos);
        this.valueHash = finishHash(hash);
        this.hashStart = start;
        this.hashEnd = pos;
        return true;
      }
    }
    this.pos = identifierStart;
    const languageVariant = variant === IdentifierVariant.JSX ? LanguageVariant.JSX : LanguageVariant.Standard;
    ch = this.codePoint();
    if (isIdentifierStart(ch)) {
      do {
        this.pos = (this.pos + charSize(ch)) | 0;
        ch = this.codePoint();
      } while (isIdentifierPart(ch, languageVariant));
      if (ch === CharacterCodes.backslash)
        this.setValue(text.substring(start, this.pos) + this.scanIdentifierParts(variant));
      else this.setValueSlice(start, this.pos);
      return true;
    }
    if (ch === CharacterCodes.backslash) {
      const escaped = this.scanIdentifierEscape(true, variant);
      if (escaped >= 0) {
        const head = text.substring(start, identifierStart) + String.fromCodePoint(escaped);
        this.setValue(head + this.scanIdentifierParts(variant));
        return true;
      }
    }
    return false;
  }

  /** Scans identifier parts including `\u` escapes and returns their cooked text. */
  private scanIdentifierParts(variant: IdentifierVariant): string {
    const languageVariant = variant === IdentifierVariant.JSX ? LanguageVariant.JSX : LanguageVariant.Standard;
    let result = '';
    let start = this.pos;
    for (;;) {
      const ch = this.codePoint();
      if (isIdentifierPart(ch, languageVariant)) {
        this.pos = (this.pos + charSize(ch)) | 0;
        continue;
      }
      if (ch === CharacterCodes.backslash) {
        const escapeStart = this.pos;
        const escaped = this.scanIdentifierEscape(false, variant);
        if (escaped >= 0) {
          result += this.text.substring(start, escapeStart) + String.fromCodePoint(escaped);
          start = this.pos;
          continue;
        }
      }
      break;
    }
    return start === this.pos ? result : result + this.text.substring(start, this.pos);
  }

  /**
   * At `\`: scans a `\u` escape of an identifier start (`isStart`) or part and returns its code point,
   * or returns -1 and leaves the scanner unchanged.
   */
  private scanIdentifierEscape(isStart: boolean, variant: IdentifierVariant): number {
    const languageVariant = variant === IdentifierVariant.JSX ? LanguageVariant.JSX : LanguageVariant.Standard;
    const escaped = this.peekUnicodeEscape();
    if (escaped >= 0 && (isStart ? isIdentifierStart(escaped) : isIdentifierPart(escaped, languageVariant)))
      return this.scanUnicodeEscape(true);
    // Group names in regular expressions, in Unicode mode or not, take `\u` HexLeadSurrogate `\u`
    // HexTrailSurrogate as part of RegExpIdentifierName (tc39/ecma262#1869), but not the braced form.
    if (
      variant === IdentifierVariant.RegExpGroupName &&
      this.peek(2) !== CharacterCodes.openBrace &&
      escaped >= 0xd800 &&
      escaped <= 0xdbff
    ) {
      const pos = this.pos;
      const flags = this.tokenFlags;
      this.scanUnicodeEscape(false);
      if (this.peek(2) !== CharacterCodes.openBrace) {
        const low = this.scanLowSurrogateEscape();
        if (low >= 0) {
          const codePoint = (escaped - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          if (isStart ? isIdentifierStart(codePoint) : isIdentifierPart(codePoint, languageVariant)) return codePoint;
        }
      }
      this.pos = pos | 0;
      this.tokenFlags = flags;
    }
    return -1;
  }

  private scanInvalidCharacter(): SyntaxKind {
    const size = charSize(this.codePoint());
    this.errorAt(Diagnostics.Invalid_character, this.pos, size, noArgs);
    this.pos = (this.pos + size) | 0;
    return (this.token = SyntaxKind.Unknown);
  }

  /** Scans a quoted string and sets its cooked value. */
  private scanString(jsxAttributeString: boolean): void {
    const text = this.text;
    const chars = this.chars;
    const quote = this.char();
    if (quote === CharacterCodes.singleQuote) this.tokenFlags |= TokenFlags.SingleQuote;
    let start = (this.pos + 1) | 0;
    // Fast path: no escapes or line breaks before the closing quote.
    let pos = start;
    const end = this.end;
    while (pos < end) {
      const ch = chars[pos] | 0;
      if (ch === quote) {
        this.setValueSlice(start, pos);
        this.pos = (pos + 1) | 0;
        return;
      }
      if (
        !jsxAttributeString &&
        (ch === CharacterCodes.backslash || ch === CharacterCodes.lineFeed || ch === CharacterCodes.carriageReturn)
      )
        break;
      pos = (pos + 1) | 0;
    }
    this.pos = pos;
    let result = '';
    for (;;) {
      const ch = this.char();
      if (ch < 0) {
        result += text.substring(start, this.pos);
        this.tokenFlags |= TokenFlags.Unterminated;
        this.error(Diagnostics.Unterminated_string_literal);
        break;
      }
      if (ch === quote) {
        result += text.substring(start, this.pos);
        this.pos = (this.pos + 1) | 0;
        break;
      }
      if (ch === CharacterCodes.backslash && !jsxAttributeString) {
        result += text.substring(start, this.pos);
        result += this.scanEscapeSequence(
          EscapeSequenceScanningFlags.String | EscapeSequenceScanningFlags.ReportErrors,
        );
        start = this.pos;
        continue;
      }
      if ((ch === CharacterCodes.lineFeed || ch === CharacterCodes.carriageReturn) && !jsxAttributeString) {
        result += text.substring(start, this.pos);
        this.tokenFlags |= TokenFlags.Unterminated;
        this.error(Diagnostics.Unterminated_string_literal);
        break;
      }
      this.pos = (this.pos + 1) | 0;
    }
    this.setValue(result);
  }

  /** Scans a template literal part starting at `` ` `` or `}`. */
  private scanTemplateAndSetTokenValue(shouldEmitInvalidEscapeError: boolean): SyntaxKind {
    const text = this.text;
    const chars = this.chars;
    const end = this.end;
    const startedWithBacktick = this.char() === CharacterCodes.backtick;
    let start = this.pos + 1;
    let pos = start;
    // The value is `text[start, pos)` unless escapes or CRs make it `cooked`.
    let cooked = false;
    let result = '';
    let token = SyntaxKind.Unknown;
    for (;;) {
      pos = skipTemplateText(chars, pos, end);
      const ch = pos < end ? chars[pos] : CharacterCodes.EOF;
      if (ch < 0 || ch === CharacterCodes.backtick) {
        this.pos = pos | 0;
        if (ch === CharacterCodes.backtick) {
          this.pos = (this.pos + 1) | 0;
        } else {
          this.tokenFlags |= TokenFlags.Unterminated;
          this.error(Diagnostics.Unterminated_template_literal);
        }
        token = startedWithBacktick ? SyntaxKind.NoSubstitutionTemplateLiteral : SyntaxKind.TemplateTail;
        break;
      }
      if (ch === CharacterCodes.$) {
        if (chars[pos + 1] !== CharacterCodes.openBrace) {
          pos++;
          continue;
        }
        this.pos = (pos + 2) | 0;
        token = startedWithBacktick ? SyntaxKind.TemplateHead : SyntaxKind.TemplateMiddle;
        break;
      }
      result += text.substring(start, pos);
      cooked = true;
      if (ch === CharacterCodes.backslash) {
        this.pos = pos | 0;
        result += this.scanEscapeSequence(
          shouldEmitInvalidEscapeError
            ? EscapeSequenceScanningFlags.String | EscapeSequenceScanningFlags.ReportErrors
            : EscapeSequenceScanningFlags.String,
        );
        pos = this.pos;
      } else {
        // <CR><LF> and <CR> are normalized to <LF> in template values.
        result += '\n';
        pos++;
        if (pos < end && chars[pos] === CharacterCodes.lineFeed) pos++;
      }
      start = pos;
    }
    if (cooked) this.setValue(result + text.substring(start, pos));
    else this.setValueSlice(start, pos);
    return token;
  }

  /** Scans an escape sequence at `\` and returns its cooked value. */
  private scanEscapeSequence(flags: EscapeSequenceScanningFlags): string {
    const start = this.pos;
    const value = this.scanEscapeCodePoint(flags);
    if (value >= 0) return String.fromCodePoint(value);
    return value === EscapeValue.Empty ? '' : this.text.substring(start, this.pos);
  }

  /**
   * @internal Scans an escape sequence at `\`. Returns its code point, `EscapeValue.Empty`
   * for a line continuation, or `EscapeValue.Raw` when the value is the escape's own text.
   */
  scanEscapeCodePoint(flags: EscapeSequenceScanningFlags): number {
    const start = this.pos;
    this.pos = (this.pos + 1) | 0;
    let ch = this.char();
    if (ch < 0) {
      this.error(Diagnostics.Unexpected_end_of_text);
      return EscapeValue.Empty;
    }
    this.pos = (this.pos + 1) | 0;
    switch (ch) {
      case CharacterCodes._0:
      case CharacterCodes._1:
      case CharacterCodes._2:
      case CharacterCodes._3:
      case CharacterCodes._4:
      case CharacterCodes._5:
      case CharacterCodes._6:
      case CharacterCodes._7: {
        // '\0' not followed by a digit is the null character; '\08' is '\0' + '8'.
        if (ch === CharacterCodes._0 && !isDigit(this.char())) return 0;
        // '\1', '\17', '\177', but '\4', '\47' and not '\477'.
        if (ch <= CharacterCodes._3 && isOctalDigit(this.char())) this.pos = (this.pos + 1) | 0;
        if (isOctalDigit(this.char())) this.pos = (this.pos + 1) | 0;
        this.tokenFlags |= TokenFlags.ContainsInvalidEscape;
        if ((flags & EscapeSequenceScanningFlags.ReportInvalidEscapeErrors) !== 0) {
          const code = parseInt(this.text.substring(start + 1, this.pos), 8);
          const args = [hexByte(code)];
          if (
            (flags & EscapeSequenceScanningFlags.RegularExpression) !== 0 &&
            (flags & EscapeSequenceScanningFlags.AtomEscape) === 0 &&
            ch !== CharacterCodes._0
          )
            this.errorAt(
              Diagnostics.Octal_escape_sequences_and_backreferences_are_not_allowed_in_a_character_class_If_this_was_intended_as_an_escape_sequence_use_the_syntax_0_instead,
              start,
              this.pos - start,
              args,
            );
          else
            this.errorAt(
              Diagnostics.Octal_escape_sequences_are_not_allowed_Use_the_syntax_0,
              start,
              this.pos - start,
              args,
            );
          return code;
        }
        return EscapeValue.Raw;
      }
      case CharacterCodes._8:
      case CharacterCodes._9:
        this.tokenFlags |= TokenFlags.ContainsInvalidEscape;
        if ((flags & EscapeSequenceScanningFlags.ReportInvalidEscapeErrors) !== 0) {
          if (
            (flags & EscapeSequenceScanningFlags.RegularExpression) !== 0 &&
            (flags & EscapeSequenceScanningFlags.AtomEscape) === 0
          )
            this.errorAt(
              Diagnostics.Decimal_escape_sequences_and_backreferences_are_not_allowed_in_a_character_class,
              start,
              this.pos - start,
              noArgs,
            );
          else
            this.errorAt(Diagnostics.Escape_sequence_0_is_not_allowed, start, this.pos - start, [
              this.text.substring(start, this.pos),
            ]);
          return ch;
        }
        return EscapeValue.Raw;
      case CharacterCodes.b:
        return CharacterCodes.backspace;
      case CharacterCodes.t:
        return CharacterCodes.tab;
      case CharacterCodes.n:
        return CharacterCodes.lineFeed;
      case CharacterCodes.v:
        return CharacterCodes.verticalTab;
      case CharacterCodes.f:
        return CharacterCodes.formFeed;
      case CharacterCodes.r:
        return CharacterCodes.carriageReturn;
      case CharacterCodes.singleQuote:
        return CharacterCodes.singleQuote;
      case CharacterCodes.doubleQuote:
        return CharacterCodes.doubleQuote;
      case CharacterCodes.u: {
        // '\uDDDD' and '\u{DDDDDD}'
        const extended = this.char() === CharacterCodes.openBrace;
        this.pos = (this.pos - 2) | 0;
        const reportErrors = (flags & EscapeSequenceScanningFlags.ReportInvalidEscapeErrors) !== 0;
        const codePoint = this.scanUnicodeEscape(reportErrors);
        if (extended && (flags & EscapeSequenceScanningFlags.AllowExtendedUnicodeEscape) === 0) {
          this.tokenFlags |= TokenFlags.ContainsInvalidEscape;
          if (reportErrors)
            this.errorAt(
              Diagnostics.Unicode_escape_sequences_are_only_available_when_the_Unicode_u_flag_or_the_Unicode_Sets_v_flag_is_set,
              start,
              this.pos - start,
              noArgs,
            );
        }
        if (codePoint < 0) return EscapeValue.Raw;
        // In any-Unicode regular expressions, '\uHigh\uLow' is one code point.
        if (
          !extended &&
          (flags & EscapeSequenceScanningFlags.RegularExpression) !== 0 &&
          (flags & EscapeSequenceScanningFlags.AnyUnicodeMode) !== 0 &&
          codePoint >= 0xd800 &&
          codePoint <= 0xdbff &&
          this.char() === CharacterCodes.backslash &&
          this.peek(1) === CharacterCodes.u &&
          this.peek(2) !== CharacterCodes.openBrace
        ) {
          const savedPos = this.pos;
          const low = this.scanUnicodeEscape(reportErrors);
          if (low >= 0xdc00 && low <= 0xdfff) return (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          this.pos = savedPos | 0;
        }
        // In strings, a high surrogate escape joins a following low surrogate escape.
        if (
          (flags & EscapeSequenceScanningFlags.RegularExpression) === 0 &&
          codePoint >= 0xd800 &&
          codePoint <= 0xdbff
        ) {
          const low = this.scanLowSurrogateEscape();
          if (low >= 0) return (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        }
        return codePoint;
      }
      case CharacterCodes.x:
        // '\xDD'
        for (; this.pos < start + 4; this.pos = (this.pos + 1) | 0) {
          if (!isHexDigit(this.char())) {
            this.tokenFlags |= TokenFlags.ContainsInvalidEscape;
            if ((flags & EscapeSequenceScanningFlags.ReportInvalidEscapeErrors) !== 0)
              this.error(Diagnostics.Hexadecimal_digit_expected);
            return EscapeValue.Raw;
          }
        }
        this.tokenFlags |= TokenFlags.HexEscape;
        return parseInt(this.text.substring(start + 2, this.pos), 16);
      case CharacterCodes.carriageReturn:
        // A line continuation is the empty code unit sequence.
        if (this.char() === CharacterCodes.lineFeed) this.pos = (this.pos + 1) | 0;
        return EscapeValue.Empty;
      case CharacterCodes.lineFeed:
      case CharacterCodes.lineSeparator:
      case CharacterCodes.paragraphSeparator:
        return EscapeValue.Empty;
      default:
        if (ch >= 0xd800 && ch <= 0xdbff) {
          this.pos = (this.pos - 1) | 0;
          ch = this.codePoint();
          this.pos = (this.pos + charSize(ch)) | 0;
        }
        if (
          (flags & EscapeSequenceScanningFlags.AnyUnicodeMode) !== 0 ||
          ((flags & EscapeSequenceScanningFlags.RegularExpression) !== 0 &&
            (flags & EscapeSequenceScanningFlags.AnnexB) === 0 &&
            isIdentifierPart(ch))
        )
          this.errorAt(
            Diagnostics.This_character_cannot_be_escaped_in_a_regular_expression,
            start,
            this.pos - start,
            noArgs,
          );
        return ch;
    }
  }

  /** After a high surrogate escape: the low surrogate of a following `\u` escape, or -1. */
  private scanLowSurrogateEscape(): number {
    if (this.char() !== CharacterCodes.backslash || this.peek(1) !== CharacterCodes.u) return -1;
    const pos = this.pos;
    const flags = this.tokenFlags;
    // Errors are reported when the escape is scanned again on its own.
    const low = this.scanUnicodeEscape(false);
    if (low >= 0xdc00 && low <= 0xdfff) return low;
    this.pos = pos | 0;
    this.tokenFlags = flags;
    return -1;
  }

  /** Scans `\uXXXX` or `\u{X…}` at `pos`; returns the code point or -1 if invalid. */
  private scanUnicodeEscape(shouldEmitInvalidEscapeError: boolean): number {
    this.pos = (this.pos + 2) | 0;
    const start = this.pos;
    const extended = this.char() === CharacterCodes.openBrace;
    let value: number;
    if (extended) {
      this.pos = (this.pos + 1) | 0;
      value = this.scanHexValue(1, true);
    } else {
      this.tokenFlags |= TokenFlags.UnicodeEscape;
      value = this.scanHexValue(4, false);
    }
    if (value < 0) {
      this.tokenFlags |= TokenFlags.ContainsInvalidEscape;
      if (shouldEmitInvalidEscapeError) this.error(Diagnostics.Hexadecimal_digit_expected);
      return -1;
    }
    if (extended) {
      let invalid = false;
      if (value > 0x10ffff) {
        if (shouldEmitInvalidEscapeError)
          this.errorAt(
            Diagnostics.An_extended_Unicode_escape_value_must_be_between_0x0_and_0x10FFFF_inclusive,
            start + 1,
            this.pos - start - 1,
            noArgs,
          );
        invalid = true;
      }
      if (this.pos >= this.end) {
        if (shouldEmitInvalidEscapeError) this.error(Diagnostics.Unexpected_end_of_text);
        invalid = true;
      } else if (this.char() === CharacterCodes.closeBrace) {
        this.pos = (this.pos + 1) | 0;
      } else {
        if (shouldEmitInvalidEscapeError) this.error(Diagnostics.Unterminated_Unicode_escape_sequence);
        invalid = true;
      }
      if (invalid) {
        this.tokenFlags |= TokenFlags.ContainsInvalidEscape;
        return -1;
      }
      this.tokenFlags |= TokenFlags.ExtendedUnicodeEscape;
    }
    return value;
  }

  /** At `\`: the code point of a following `\u` escape, or -1. Leaves the scanner unchanged. */
  private peekUnicodeEscape(): number {
    if (this.peek(1) !== CharacterCodes.u) return -1;
    const pos = this.pos;
    const flags = this.tokenFlags;
    const codePoint = this.scanUnicodeEscape(false);
    this.pos = pos | 0;
    this.tokenFlags = flags;
    return codePoint;
  }

  /** Scans hex digits (no separators) and returns their value, or -1 if fewer than `minCount`. */
  private scanHexValue(minCount: number, scanAsManyAsPossible: boolean): number {
    let count = 0;
    let value = 0;
    while (count < minCount || scanAsManyAsPossible) {
      const ch = this.char();
      let digit: number;
      if (ch >= CharacterCodes._0 && ch <= CharacterCodes._9) digit = ch - CharacterCodes._0;
      else if (ch >= CharacterCodes.A && ch <= CharacterCodes.F) digit = ch - CharacterCodes.A + 10;
      else if (ch >= CharacterCodes.a && ch <= CharacterCodes.f) digit = ch - CharacterCodes.a + 10;
      else break;
      value = value * 16 + digit;
      count++;
      this.pos = (this.pos + 1) | 0;
    }
    return count < minCount ? -1 : value;
  }

  /** `text[start, end)` without numeric separators. */
  private withoutSeparators(start: number, end: number): string {
    if ((this.tokenFlags & TokenFlags.ContainsSeparator) === 0) return this.text.substring(start, end);
    let result = '';
    let from = start;
    for (let i = start; i < end; i++) {
      if (this.chars[i] !== CharacterCodes._) continue;
      result += this.text.substring(from, i);
      from = i + 1;
    }
    return result + this.text.substring(from, end);
  }

  private scanNumber(): SyntaxKind {
    let start = this.pos;
    if (this.char() === CharacterCodes._0) {
      this.pos = (this.pos + 1) | 0;
      if (this.char() === CharacterCodes._) {
        this.tokenFlags |= TokenFlags.ContainsSeparator | TokenFlags.ContainsInvalidSeparator;
        this.errorAt(Diagnostics.Numeric_separators_are_not_allowed_here, this.pos, 1, noArgs);
        this.pos = start | 0;
        this.scanNumberFragment();
      } else {
        const digitsStart = this.pos;
        let isOctal = true;
        while (isDigit(this.char())) {
          if (!isOctalDigit(this.char())) isOctal = false;
          this.pos = (this.pos + 1) | 0;
        }
        if (this.pos > digitsStart && isOctal) {
          // Legacy octal literal, e.g. `0777`.
          const value = parseInt(this.text.substring(digitsStart, this.pos), 8);
          this.setValue(String(value));
          this.tokenFlags |= TokenFlags.Octal;
          const withMinus = this.token === SyntaxKind.MinusToken;
          const literal = (withMinus ? '-0o' : '0o') + value.toString(8);
          if (withMinus) start--;
          this.errorAt(Diagnostics.Octal_literals_are_not_allowed_Use_the_syntax_0, start, this.pos - start, [literal]);
          return SyntaxKind.NumericLiteral;
        }
        if (this.pos > digitsStart) this.tokenFlags |= TokenFlags.ContainsLeadingZero;
      }
    } else {
      this.scanNumberFragment();
    }
    const fixedPartEnd = this.pos;
    if (this.char() === CharacterCodes.dot) {
      this.pos = (this.pos + 1) | 0;
      this.scanNumberFragment();
    }
    let end = this.pos;
    if (this.char() === CharacterCodes.E || this.char() === CharacterCodes.e) {
      this.pos = (this.pos + 1) | 0;
      this.tokenFlags |= TokenFlags.Scientific;
      if (this.char() === CharacterCodes.plus || this.char() === CharacterCodes.minus) this.pos = (this.pos + 1) | 0;
      if (this.scanNumberFragment() === 0) this.error(Diagnostics.Digit_expected);
      else end = this.pos;
    }
    // Integers of up to 15 digits without separators are already canonical.
    if (
      fixedPartEnd === this.pos &&
      this.pos - start <= 15 &&
      (this.tokenFlags & (TokenFlags.ContainsSeparator | TokenFlags.ContainsLeadingZero)) === 0 &&
      this.chars[this.pos] !== CharacterCodes.n
    ) {
      this.setValueSlice(start, this.pos);
      if (!isIdentifierStart(this.codePoint())) return SyntaxKind.NumericLiteral;
    }
    const raw = this.withoutSeparators(start, end);
    if ((this.tokenFlags & TokenFlags.ContainsLeadingZero) !== 0) {
      this.errorAt(Diagnostics.Decimals_with_leading_zeros_are_not_allowed, start, this.pos - start, noArgs);
      this.setValue(String(Number(raw)));
      return SyntaxKind.NumericLiteral;
    }
    let result: SyntaxKind;
    if (fixedPartEnd === this.pos) {
      this.setValue(raw);
      result = this.scanBigIntSuffix();
    } else {
      this.setValue(String(Number(raw)));
      result = SyntaxKind.NumericLiteral;
    }
    if (isIdentifierStart(this.codePoint())) {
      const idStart = this.pos;
      const id = this.scanIdentifierParts(IdentifierVariant.Standard);
      if (result !== SyntaxKind.BigIntLiteral && id.length === 1 && this.chars[idStart] === CharacterCodes.n) {
        if ((this.tokenFlags & TokenFlags.Scientific) !== 0) {
          this.errorAt(Diagnostics.A_bigint_literal_cannot_use_exponential_notation, start, this.pos - start, noArgs);
          return result;
        }
        if (fixedPartEnd < idStart) {
          this.errorAt(Diagnostics.A_bigint_literal_must_be_an_integer, start, this.pos - start, noArgs);
          return result;
        }
      }
      this.errorAt(
        Diagnostics.An_identifier_or_keyword_cannot_immediately_follow_a_numeric_literal,
        idStart,
        this.pos - idStart,
        noArgs,
      );
      this.pos = idStart | 0;
    }
    return result;
  }

  /** Scans decimal digits with numeric separators; returns how many digits. */
  private scanNumberFragment(): number {
    let count = 0;
    let allowSeparator = false;
    let isPreviousTokenSeparator = false;
    for (;;) {
      const ch = this.char();
      if (isDigit(ch)) {
        allowSeparator = true;
        isPreviousTokenSeparator = false;
        count++;
      } else if (ch === CharacterCodes._) {
        this.tokenFlags |= TokenFlags.ContainsSeparator;
        if (allowSeparator) {
          allowSeparator = false;
          isPreviousTokenSeparator = true;
        } else {
          this.tokenFlags |= TokenFlags.ContainsInvalidSeparator;
          if (isPreviousTokenSeparator)
            this.errorAt(Diagnostics.Multiple_consecutive_numeric_separators_are_not_permitted, this.pos, 1, noArgs);
          else this.errorAt(Diagnostics.Numeric_separators_are_not_allowed_here, this.pos, 1, noArgs);
        }
      } else {
        break;
      }
      this.pos = (this.pos + 1) | 0;
    }
    if (isPreviousTokenSeparator) {
      this.tokenFlags |= TokenFlags.ContainsInvalidSeparator;
      this.errorAt(Diagnostics.Numeric_separators_are_not_allowed_here, this.pos - 1, 1, noArgs);
    }
    return count;
  }

  /** Scans digits of a `0x`, `0b` or `0o` literal (allowing separators); returns how many. */
  private scanSpecifierDigits(base: number): number {
    let count = 0;
    let allowSeparator = false;
    let isPreviousTokenSeparator = false;
    for (;;) {
      const ch = this.char();
      if (base === 16 ? isHexDigit(ch) : isDigit(ch) && ch - CharacterCodes._0 < base) {
        allowSeparator = true;
        isPreviousTokenSeparator = false;
        count++;
      } else if (ch === CharacterCodes._) {
        this.tokenFlags |= TokenFlags.ContainsSeparator;
        if (allowSeparator) {
          allowSeparator = false;
          isPreviousTokenSeparator = true;
        } else if (isPreviousTokenSeparator) {
          this.errorAt(Diagnostics.Multiple_consecutive_numeric_separators_are_not_permitted, this.pos, 1, noArgs);
        } else {
          this.errorAt(Diagnostics.Numeric_separators_are_not_allowed_here, this.pos, 1, noArgs);
        }
      } else {
        break;
      }
      this.pos = (this.pos + 1) | 0;
    }
    if (isPreviousTokenSeparator)
      this.errorAt(Diagnostics.Numeric_separators_are_not_allowed_here, this.pos - 1, 1, noArgs);
    return count;
  }

  private scanHexNumber(): SyntaxKind {
    this.pos = (this.pos + 2) | 0;
    const digitsStart = this.pos;
    let digits: string;
    if (this.scanSpecifierDigits(16) === 0) {
      this.error(Diagnostics.Hexadecimal_digit_expected);
      digits = '0';
    } else {
      digits = this.withoutSeparators(digitsStart, this.pos).toLowerCase();
    }
    this.setValue('0x' + digits);
    this.tokenFlags |= TokenFlags.HexSpecifier;
    return this.scanBigIntSuffix();
  }

  private scanBinaryOrOctalNumber(base: number): SyntaxKind {
    this.pos = (this.pos + 2) | 0;
    const digitsStart = this.pos;
    let digits: string;
    if (this.scanSpecifierDigits(base) === 0) {
      this.error(base === 2 ? Diagnostics.Binary_digit_expected : Diagnostics.Octal_digit_expected);
      digits = '0';
    } else {
      digits = this.withoutSeparators(digitsStart, this.pos);
    }
    this.setValue((base === 2 ? '0b' : '0o') + digits);
    this.tokenFlags |= base === 2 ? TokenFlags.BinarySpecifier : TokenFlags.OctalSpecifier;
    return this.scanBigIntSuffix();
  }

  /** Completes a numeric literal whose value is set: a `n` suffix makes it a bigint. */
  private scanBigIntSuffix(): SyntaxKind {
    if (this.char() === CharacterCodes.n) {
      if ((this.tokenFlags & TokenFlags.BinaryOrOctalSpecifier) !== 0)
        this.setValue(parsePseudoBigInt(this.tokenValue) + 'n');
      else this.setValue(this.tokenValue + 'n');
      this.pos = (this.pos + 1) | 0;
      return SyntaxKind.BigIntLiteral;
    }
    this.setValue(String(Number(this.tokenValue)));
    return SyntaxKind.NumericLiteral;
  }

  /** Splits `<<` into `<`. */
  reScanLessThanToken(): SyntaxKind {
    if (this.token === SyntaxKind.LessThanLessThanToken) {
      this.pos = (this.tokenStart + 1) | 0;
      this.token = SyntaxKind.LessThanToken;
    }
    return this.token;
  }

  /** Joins `>` with following `>`, `>=`, `>>`, `>>=` or `=`. */
  reScanGreaterThanToken(): SyntaxKind {
    if (this.token !== SyntaxKind.GreaterThanToken) return this.token;
    this.pos = (this.tokenStart + 1) | 0;
    if (this.char() === CharacterCodes.greaterThan) {
      if (this.peek(1) === CharacterCodes.greaterThan) {
        if (this.peek(2) === CharacterCodes.equals) {
          this.pos = (this.pos + 3) | 0;
          return (this.token = SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken);
        }
        this.pos = (this.pos + 2) | 0;
        return (this.token = SyntaxKind.GreaterThanGreaterThanGreaterThanToken);
      }
      if (this.peek(1) === CharacterCodes.equals) {
        this.pos = (this.pos + 2) | 0;
        return (this.token = SyntaxKind.GreaterThanGreaterThanEqualsToken);
      }
      this.pos = (this.pos + 1) | 0;
      return (this.token = SyntaxKind.GreaterThanGreaterThanToken);
    }
    if (this.char() === CharacterCodes.equals) {
      this.pos = (this.pos + 1) | 0;
      return (this.token = SyntaxKind.GreaterThanEqualsToken);
    }
    return this.token;
  }

  /** Rescans a `}` as a template middle or tail. */
  reScanTemplateToken(isTaggedTemplate: boolean): SyntaxKind {
    this.pos = this.tokenStart;
    return (this.token = this.scanTemplateAndSetTokenValue(!isTaggedTemplate));
  }

  /** Splits `*=` into `*` and `=`, returning `=`. */
  reScanAsteriskEqualsToken(): SyntaxKind {
    if (this.token !== SyntaxKind.AsteriskEqualsToken)
      throw new Error("'reScanAsteriskEqualsToken' should only be called on a '*='");
    this.pos = (this.tokenStart + 1) | 0;
    return (this.token = SyntaxKind.EqualsToken);
  }

  /** Rescans `/` or `/=` as a regular expression literal, optionally checking its syntax. */
  reScanSlashToken(reportErrors = false): SyntaxKind {
    if (this.token !== SyntaxKind.SlashToken && this.token !== SyntaxKind.SlashEqualsToken) return this.token;
    const chars = this.chars;
    // Find the end of the body quickly so the flags are known before checking it.
    const bodyStart = this.tokenStart + 1;
    let p = bodyStart;
    let inEscape = false;
    let namedCaptureGroups = false;
    // A `[` inside a class does not nest here, even in Unicode Sets mode: `/[[]/` is terminated.
    let inCharacterClass = false;
    for (;;) {
      if (p >= this.end) {
        this.tokenFlags |= TokenFlags.Unterminated;
        break;
      }
      const ch = chars[p];
      if (isLineBreak(ch)) {
        this.tokenFlags |= TokenFlags.Unterminated;
        break;
      }
      if (inEscape) {
        inEscape = false;
      } else if (ch === CharacterCodes.slash && !inCharacterClass) {
        break;
      } else if (ch === CharacterCodes.openBracket) {
        inCharacterClass = true;
      } else if (ch === CharacterCodes.backslash) {
        inEscape = true;
      } else if (ch === CharacterCodes.closeBracket) {
        inCharacterClass = false;
      } else if (
        !inCharacterClass &&
        ch === CharacterCodes.openParen &&
        p + 2 < this.end &&
        chars[p + 1] === CharacterCodes.question &&
        chars[p + 2] === CharacterCodes.lessThan &&
        (p + 3 >= this.end || (chars[p + 3] !== CharacterCodes.equals && chars[p + 3] !== CharacterCodes.exclamation))
      ) {
        namedCaptureGroups = true;
      }
      p++;
    }
    const bodyEnd = p;
    if ((this.tokenFlags & TokenFlags.Unterminated) !== 0) {
      // Recover at the nearest unbalanced bracket, counting nested classes.
      p = bodyStart;
      inEscape = false;
      let classDepth = 0;
      let inDecimalQuantifier = false;
      let groupDepth = 0;
      while (p < bodyEnd) {
        const ch = chars[p];
        if (inEscape) {
          inEscape = false;
        } else if (ch === CharacterCodes.backslash) {
          inEscape = true;
        } else if (ch === CharacterCodes.openBracket) {
          classDepth++;
        } else if (ch === CharacterCodes.closeBracket && classDepth !== 0) {
          classDepth--;
        } else if (classDepth === 0) {
          if (ch === CharacterCodes.openBrace) {
            inDecimalQuantifier = true;
          } else if (ch === CharacterCodes.closeBrace && inDecimalQuantifier) {
            inDecimalQuantifier = false;
          } else if (!inDecimalQuantifier) {
            if (ch === CharacterCodes.openParen) groupDepth++;
            else if (ch === CharacterCodes.closeParen && groupDepth !== 0) groupDepth--;
            else if (
              ch === CharacterCodes.closeParen ||
              ch === CharacterCodes.closeBracket ||
              ch === CharacterCodes.closeBrace
            )
              break;
          }
        }
        p++;
      }
      // Trailing whitespace and semicolons are unlikely to belong to the regex.
      while (p > bodyStart) {
        const ch = chars[p - 1];
        if (!isWhiteSpaceLike(ch) && ch !== CharacterCodes.semicolon) break;
        p--;
      }
      this.errorAt(Diagnostics.Unterminated_regular_expression_literal, this.tokenStart, p - this.tokenStart, noArgs);
    } else {
      p++; // the closing slash
      let flags = RegularExpressionFlags.None;
      while (p < this.end) {
        const ch = this.codePointAt(p, this.end);
        if (ch === CharacterCodes.replacementCharacter || !isIdentifierPart(ch)) break;
        const size = charSize(ch);
        if (reportErrors) {
          const flag = regularExpressionFlag(ch);
          if (flag === RegularExpressionFlags.None)
            this.errorAt(Diagnostics.Unknown_regular_expression_flag, p, size, noArgs);
          else if ((flags & flag) !== 0) this.errorAt(Diagnostics.Duplicate_regular_expression_flag, p, size, noArgs);
          else if (((flags | flag) & RegularExpressionFlags.AnyUnicodeMode) === RegularExpressionFlags.AnyUnicodeMode)
            this.errorAt(
              Diagnostics.The_Unicode_u_flag_and_the_Unicode_Sets_v_flag_cannot_be_set_simultaneously,
              p,
              size,
              noArgs,
            );
          else {
            flags |= flag;
            this.checkRegularExpressionFlagAvailability(flag, p, size);
          }
        }
        p += size;
      }
      if (reportErrors) {
        const savedEnd = this.end;
        const savedTokenStart = this.tokenStart;
        const savedTokenFlags = this.tokenFlags;
        this.pos = bodyStart | 0;
        this.end = bodyEnd | 0;
        checkRegularExpression(this, bodyEnd, flags, namedCaptureGroups);
        this.end = savedEnd;
        this.tokenStart = savedTokenStart;
        this.tokenFlags = savedTokenFlags;
      }
    }
    this.pos = p | 0;
    this.setValueSlice(this.tokenStart, p);
    return (this.token = SyntaxKind.RegularExpressionLiteral);
  }

  /** @internal Reports a regular expression flag unavailable at the current target. */
  checkRegularExpressionFlagAvailability(flag: RegularExpressionFlags, pos: number, size: number): void {
    let availableFrom: ScriptTarget;
    if (flag === RegularExpressionFlags.HasIndices) availableFrom = ScriptTarget.ES2022;
    else if (flag === RegularExpressionFlags.DotAll) availableFrom = ScriptTarget.ES2018;
    else if (flag === RegularExpressionFlags.UnicodeSets) availableFrom = ScriptTarget.ES2024;
    else return;
    if (this.languageVersion() < availableFrom)
      this.errorAt(Diagnostics.This_regular_expression_flag_is_only_available_when_targeting_0_or_later, pos, size, [
        regularExpressionFlagName(availableFrom),
      ]);
  }

  /** Rescans from the token's full start as JSX text or a JSX token. */
  reScanJsxToken(allowMultilineJsxText = true): SyntaxKind {
    this.pos = this.fullStartPos;
    this.tokenStart = this.fullStartPos;
    return (this.token = this.scanJsxToken(allowMultilineJsxText));
  }

  /** Splits a private identifier into `#` and the name. */
  reScanHashToken(): SyntaxKind {
    if (this.token === SyntaxKind.PrivateIdentifier) {
      this.pos = (this.tokenStart + 1) | 0;
      this.token = SyntaxKind.HashToken;
    }
    return this.token;
  }

  /** Splits `??` into `?`. */
  reScanQuestionToken(): SyntaxKind {
    if (this.token !== SyntaxKind.QuestionQuestionToken)
      throw new Error("'reScanQuestionToken' should only be called on a '??'");
    this.pos = (this.tokenStart + 1) | 0;
    return (this.token = SyntaxKind.QuestionToken);
  }

  /** Scans JSX children: text, `<`, `</` or `{`. */
  scanJsxToken(allowMultilineJsxText = true): SyntaxKind {
    this.fullStartPos = this.pos | 0;
    this.tokenStart = this.pos | 0;
    const ch = this.char();
    if (ch < 0) return (this.token = SyntaxKind.EndOfFile);
    if (ch === CharacterCodes.lessThan) {
      if (this.peek(1) === CharacterCodes.slash) {
        this.pos = (this.pos + 2) | 0;
        return (this.token = SyntaxKind.LessThanSlashToken);
      }
      this.pos = (this.pos + 1) | 0;
      return (this.token = SyntaxKind.LessThanToken);
    }
    if (ch === CharacterCodes.openBrace) {
      this.pos = (this.pos + 1) | 0;
      return (this.token = SyntaxKind.OpenBraceToken);
    }
    // 0: only whitespace so far; -1: only whitespace and a line break, which is ignored.
    let firstNonWhitespace = 0;
    while (this.pos < this.end) {
      const c = this.chars[this.pos] | 0;
      if (c === CharacterCodes.openBrace) break;
      if (c === CharacterCodes.lessThan) {
        if (isConflictMarkerTrivia(this.text, this.pos)) {
          this.pos = scanConflictMarkerTrivia(this.text, this.pos, this) | 0;
          return (this.token = SyntaxKind.ConflictMarkerTrivia);
        }
        break;
      }
      if (c === CharacterCodes.greaterThan)
        this.errorAt(Diagnostics.Unexpected_token_Did_you_mean_or_gt, this.pos, 1, noArgs);
      else if (c === CharacterCodes.closeBrace)
        this.errorAt(Diagnostics.Unexpected_token_Did_you_mean_or_rbrace, this.pos, 1, noArgs);
      if (isLineBreak(c) && firstNonWhitespace === 0) firstNonWhitespace = -1;
      else if (!allowMultilineJsxText && isLineBreak(c) && firstNonWhitespace > 0) break;
      else if (!isWhiteSpaceLike(c)) firstNonWhitespace = this.pos;
      this.pos = (this.pos + 1) | 0;
    }
    this.setValueSlice(this.fullStartPos, this.pos);
    return (this.token = firstNonWhitespace === -1 ? SyntaxKind.JsxTextAllWhiteSpaces : SyntaxKind.JsxText);
  }

  /** Extends an identifier or keyword with `-` and further parts, as JSX names allow. */
  scanJsxIdentifier(): SyntaxKind {
    if (!tokenIsIdentifierOrKeyword(this.token)) return this.token;
    // An identifier or keyword is scanned: append a following `-` and the rest of the name.
    const value = this.getTokenValue() + this.scanIdentifierParts(IdentifierVariant.JSX);
    this.setValue(value);
    return (this.token = getIdentifierToken(value));
  }

  /** Scans a JSX attribute value after `=`: a string, or any other token. */
  scanJsxAttributeValue(): SyntaxKind {
    this.fullStartPos = this.pos | 0;
    while (this.pos < this.end && isWhiteSpaceLike(this.chars[this.pos] | 0)) this.pos = (this.pos + 1) | 0;
    this.tokenStart = this.pos | 0;
    const ch = this.char();
    if (ch === CharacterCodes.doubleQuote || ch === CharacterCodes.singleQuote) {
      this.scanString(true);
      return (this.token = SyntaxKind.StringLiteral);
    }
    return this.scan();
  }

  reScanJsxAttributeValue(): SyntaxKind {
    this.pos = this.fullStartPos;
    this.tokenStart = this.fullStartPos;
    return this.scanJsxAttributeValue();
  }

  /** Scans JSDoc comment text up to a line break, backtick, `{` or tag; falls back to `scanJSDocToken`. */
  scanJSDocCommentTextToken(inBackticks: boolean): SyntaxKind {
    this.fullStartPos = this.pos | 0;
    this.tokenFlags = TokenFlags.None;
    if (this.pos >= this.end) return (this.token = SyntaxKind.EndOfFile);
    this.tokenStart = this.pos | 0;
    while (this.pos < this.end) {
      // Fast path: an ASCII unit that ends no text run.
      const unit = this.chars[this.pos] | 0;
      if (
        unit < 0x80 &&
        unit !== CharacterCodes.lineFeed &&
        unit !== CharacterCodes.carriageReturn &&
        unit !== CharacterCodes.backtick &&
        unit !== CharacterCodes.openBrace &&
        unit !== CharacterCodes.at
      ) {
        this.pos = (this.pos + 1) | 0;
        continue;
      }
      const ch = this.codePointAt(this.pos, this.end);
      if (isLineBreak(ch) || ch === CharacterCodes.backtick) break;
      const size = charSize(ch);
      if (!inBackticks) {
        if (ch === CharacterCodes.openBrace) break;
        // Outside backticks, `@` starts a tag after whitespace and before an identifier.
        if (
          ch === CharacterCodes.at &&
          isWhiteSpaceSingleLine(this.codePointBefore(this.pos)) &&
          isIdentifierStart(this.codePointAt((this.pos + size) | 0, this.end))
        )
          break;
      }
      this.pos = (this.pos + size) | 0;
    }
    if (this.pos === this.tokenStart) return this.scanJSDocToken();
    this.setValueSlice(this.tokenStart, this.pos);
    return (this.token = SyntaxKind.JSDocCommentTextToken);
  }

  /** After `@`: whether a tag name (or an incomplete tag) can follow. */
  canFollowJSDocAt(): boolean {
    if (this.pos >= this.end) return true;
    const ch = this.codePointAt(this.pos, this.end);
    return isIdentifierStart(ch) || isWhiteSpaceSingleLine(ch) || isLineBreak(ch);
  }

  scanJSDocToken(): SyntaxKind {
    this.fullStartPos = this.pos | 0;
    this.tokenFlags = TokenFlags.None;
    const chars = this.chars;
    if (this.pos >= this.end) return (this.token = SyntaxKind.EndOfFile);
    this.tokenStart = this.pos | 0;
    const ch = this.codePointAt(this.pos, this.end);
    this.pos = (this.pos + charSize(ch)) | 0;
    switch (ch) {
      case CharacterCodes.tab:
      case CharacterCodes.verticalTab:
      case CharacterCodes.formFeed:
      case CharacterCodes.space:
        while (this.pos < this.end && isWhiteSpaceSingleLine(chars[this.pos] | 0)) this.pos = (this.pos + 1) | 0;
        return (this.token = SyntaxKind.WhitespaceTrivia);
      case CharacterCodes.at:
        return (this.token = SyntaxKind.AtToken);
      case CharacterCodes.carriageReturn:
      case CharacterCodes.lineFeed:
        if (ch === CharacterCodes.carriageReturn && this.char() === CharacterCodes.lineFeed)
          this.pos = (this.pos + 1) | 0;
        this.tokenFlags |= TokenFlags.PrecedingLineBreak;
        return (this.token = SyntaxKind.NewLineTrivia);
      case CharacterCodes.asterisk:
        return (this.token = SyntaxKind.AsteriskToken);
      case CharacterCodes.openBrace:
        return (this.token = SyntaxKind.OpenBraceToken);
      case CharacterCodes.closeBrace:
        return (this.token = SyntaxKind.CloseBraceToken);
      case CharacterCodes.openBracket:
        return (this.token = SyntaxKind.OpenBracketToken);
      case CharacterCodes.closeBracket:
        return (this.token = SyntaxKind.CloseBracketToken);
      case CharacterCodes.openParen:
        return (this.token = SyntaxKind.OpenParenToken);
      case CharacterCodes.closeParen:
        return (this.token = SyntaxKind.CloseParenToken);
      case CharacterCodes.lessThan:
        return (this.token = SyntaxKind.LessThanToken);
      case CharacterCodes.greaterThan:
        return (this.token = SyntaxKind.GreaterThanToken);
      case CharacterCodes.equals:
        return (this.token = SyntaxKind.EqualsToken);
      case CharacterCodes.comma:
        return (this.token = SyntaxKind.CommaToken);
      case CharacterCodes.dot:
        return (this.token = SyntaxKind.DotToken);
      case CharacterCodes.backtick:
        return (this.token = SyntaxKind.BacktickToken);
      case CharacterCodes.hash:
        return (this.token = SyntaxKind.HashToken);
    }
    // JSDoc names take `-`, as JSX names do.
    this.pos = this.tokenStart;
    if (this.scanIdentifier(0, IdentifierVariant.JSX)) return (this.token = this.identifierKind());
    this.pos = (this.tokenStart + charSize(ch)) | 0;
    return (this.token = SyntaxKind.Unknown);
  }
}

/** Which characters an identifier scan takes after its start. */
export const enum IdentifierVariant {
  Standard,
  /** JSX and JSDoc names, which take `-`. */
  JSX,
  /** Regular expression group names, which take a surrogate pair written as two `\u` escapes. */
  RegExpGroupName,
}

const mergeConflictMarkerLength = 7;

function utf8Length(ch: number): number {
  return ch < 0x80 ? 1 : ch < 0x800 ? 2 : ch >= 0xd800 && ch <= 0xdfff ? 4 : 3;
}

// Whether a conflict marker at `pos` is at a line start, as TypeScript 7 decides it:
// after a CR or LF, or after a line terminator followed by two bytes of UTF-8
// (two ASCII characters or one two-byte character).
function isConflictMarkerLineStart(text: string, pos: number): boolean {
  if (pos === 0) return true;
  const previous = text.charCodeAt(pos - 1);
  if (previous === CharacterCodes.lineFeed || previous === CharacterCodes.carriageReturn) return true;
  const length = utf8Length(previous);
  if (length === 2) return pos >= 2 && isLineBreak(text.charCodeAt(pos - 2));
  if (length === 1 && pos >= 3 && text.charCodeAt(pos - 2) < 0x80) return isLineBreak(text.charCodeAt(pos - 3));
  return false;
}

/** Whether `text` has a `<<<<<<<`, `|||||||`, `=======` or `>>>>>>>` marker at `pos`. */
export function isConflictMarkerTrivia(text: string, pos: number): boolean {
  if (pos + 1 >= text.length || text.charCodeAt(pos + 1) !== text.charCodeAt(pos)) return false;
  if (!isConflictMarkerLineStart(text, pos) || pos + mergeConflictMarkerLength >= text.length) return false;
  const ch = text.charCodeAt(pos);
  for (let i = 2; i < mergeConflictMarkerLength; i++) if (text.charCodeAt(pos + i) !== ch) return false;
  return ch === CharacterCodes.equals || text.charCodeAt(pos + mergeConflictMarkerLength) === CharacterCodes.space;
}

/** Skips a conflict marker and returns the position after it; reports it if `scanner` is given. */
function scanConflictMarkerTrivia(text: string, pos: number, scanner: Scanner | undefined): number {
  if (scanner !== undefined)
    scanner.errorAt(Diagnostics.Merge_conflict_marker_encountered, pos, mergeConflictMarkerLength, noArgs);
  const ch = text.charCodeAt(pos);
  const length = text.length;
  if (ch === CharacterCodes.lessThan || ch === CharacterCodes.greaterThan) {
    while (pos < length && !isLineBreak(text.charCodeAt(pos))) pos++;
    return pos;
  }
  // Consume from a ||||||| or ======= marker to the next ======= or >>>>>>> marker.
  while (pos < length) {
    const current = text.charCodeAt(pos);
    if (
      (current === CharacterCodes.equals || current === CharacterCodes.greaterThan) &&
      current !== ch &&
      isConflictMarkerTrivia(text, pos)
    )
      break;
    pos++;
  }
  return pos;
}

function scanShebangTrivia(text: string, pos: number): number {
  pos += 2;
  while (pos < text.length && !isLineBreak(text.charCodeAt(pos))) pos++;
  return pos;
}

function isShebangTrivia(text: string): boolean {
  return (
    text.length >= 2 && text.charCodeAt(0) === CharacterCodes.hash && text.charCodeAt(1) === CharacterCodes.exclamation
  );
}

/** The `#!` line at the start of `text`, or `''`. */
export function getShebang(text: string): string {
  return isShebangTrivia(text) ? text.substring(0, scanShebangTrivia(text, 0)) : '';
}

/** Whether trivia could start at `pos`; a fast pre-check for `skipTrivia`. */
export function couldStartTrivia(text: string, pos: number): boolean {
  const ch = text.charCodeAt(pos);
  switch (ch) {
    case CharacterCodes.carriageReturn:
    case CharacterCodes.lineFeed:
    case CharacterCodes.tab:
    case CharacterCodes.verticalTab:
    case CharacterCodes.formFeed:
    case CharacterCodes.space:
    case CharacterCodes.slash:
    case CharacterCodes.lessThan:
    case CharacterCodes.bar:
    case CharacterCodes.equals:
    case CharacterCodes.greaterThan:
      return true;
    case CharacterCodes.hash:
      return pos === 0;
    default:
      return ch > CharacterCodes.maxAsciiCharacter;
  }
}

/** Returns the position after whitespace, comments, conflict markers and a leading shebang. */
export function skipTrivia(
  text: string,
  pos: number,
  stopAfterLineBreak = false,
  stopAtComments = false,
  inJSDoc = false,
): number {
  if (pos < 0) return pos;
  const length = text.length;
  let canConsumeStar = false;
  for (;;) {
    if (pos >= length) return pos;
    const ch = text.charCodeAt(pos);
    switch (ch) {
      case CharacterCodes.carriageReturn:
      case CharacterCodes.lineFeed:
        if (
          ch === CharacterCodes.carriageReturn &&
          pos + 1 < length &&
          text.charCodeAt(pos + 1) === CharacterCodes.lineFeed
        )
          pos++;
        pos++;
        if (stopAfterLineBreak) return pos;
        canConsumeStar = inJSDoc;
        continue;
      case CharacterCodes.tab:
      case CharacterCodes.verticalTab:
      case CharacterCodes.formFeed:
      case CharacterCodes.space:
        pos++;
        continue;
      case CharacterCodes.slash:
        if (stopAtComments || pos + 1 >= length) return pos;
        if (text.charCodeAt(pos + 1) === CharacterCodes.slash) {
          pos += 2;
          while (pos < length && !isLineBreak(text.charCodeAt(pos))) pos++;
          canConsumeStar = false;
          continue;
        }
        if (text.charCodeAt(pos + 1) === CharacterCodes.asterisk) {
          const close = text.indexOf('*/', pos + 2);
          pos = close < 0 ? length : close + 2;
          canConsumeStar = false;
          continue;
        }
        return pos;
      case CharacterCodes.lessThan:
      case CharacterCodes.bar:
      case CharacterCodes.equals:
      case CharacterCodes.greaterThan:
        if (isConflictMarkerTrivia(text, pos)) {
          pos = scanConflictMarkerTrivia(text, pos, undefined);
          canConsumeStar = false;
          continue;
        }
        return pos;
      case CharacterCodes.hash:
        if (pos === 0 && isShebangTrivia(text)) {
          pos = scanShebangTrivia(text, pos);
          canConsumeStar = false;
          continue;
        }
        return pos;
      case CharacterCodes.asterisk:
        if (canConsumeStar) {
          pos++;
          canConsumeStar = false;
          continue;
        }
        return pos;
      default:
        if (ch > CharacterCodes.maxAsciiCharacter && isWhiteSpaceLike(ch)) {
          pos++;
          continue;
        }
        return pos;
    }
  }
}

/** Comments before the next token at `pos`; those on the first line are skipped unless `pos` is 0. */
export function getLeadingCommentRanges(text: string, pos: number): CommentRange[] | undefined {
  return collectCommentRanges(text, pos, false);
}

/** Comments after `pos` up to the next line break. */
export function getTrailingCommentRanges(text: string, pos: number): CommentRange[] | undefined {
  return collectCommentRanges(text, pos, true);
}

function collectCommentRanges(text: string, pos: number, trailing: boolean): CommentRange[] | undefined {
  let result: CommentRange[] | undefined;
  let pendingPos = 0;
  let pendingEnd = 0;
  let pendingKind = SyntaxKind.Unknown;
  let pendingHasTrailingNewLine = false;
  let hasPending = false;
  let collecting = trailing;
  if (pos === 0) {
    collecting = true;
    if (isShebangTrivia(text)) pos = scanShebangTrivia(text, pos);
  }
  const length = text.length;
  scan: while (pos >= 0 && pos < length) {
    const ch = text.charCodeAt(pos);
    switch (ch) {
      case CharacterCodes.carriageReturn:
      case CharacterCodes.lineFeed:
        if (
          ch === CharacterCodes.carriageReturn &&
          pos + 1 < length &&
          text.charCodeAt(pos + 1) === CharacterCodes.lineFeed
        )
          pos++;
        pos++;
        if (trailing) break scan;
        collecting = true;
        if (hasPending) pendingHasTrailingNewLine = true;
        continue;
      case CharacterCodes.tab:
      case CharacterCodes.verticalTab:
      case CharacterCodes.formFeed:
      case CharacterCodes.space:
        pos++;
        continue;
      case CharacterCodes.slash: {
        const next = pos + 1 < length ? text.charCodeAt(pos + 1) : 0;
        if (next !== CharacterCodes.slash && next !== CharacterCodes.asterisk) break scan;
        const kind =
          next === CharacterCodes.slash ? SyntaxKind.SingleLineCommentTrivia : SyntaxKind.MultiLineCommentTrivia;
        const start = pos;
        let hasTrailingNewLine = false;
        pos += 2;
        if (next === CharacterCodes.slash) {
          while (pos < length) {
            if (isLineBreak(text.charCodeAt(pos))) {
              hasTrailingNewLine = true;
              break;
            }
            pos++;
          }
        } else {
          const close = text.indexOf('*/', pos);
          pos = close < 0 ? length : close + 2;
        }
        if (collecting) {
          if (hasPending) {
            if (result === undefined) result = [];
            result.push(new CommentRange(pendingPos, pendingEnd, pendingKind, pendingHasTrailingNewLine));
          }
          pendingPos = start;
          pendingEnd = pos;
          pendingKind = kind;
          pendingHasTrailingNewLine = hasTrailingNewLine;
          hasPending = true;
        }
        continue;
      }
      default:
        if (ch > CharacterCodes.maxAsciiCharacter && isWhiteSpaceLike(ch)) {
          if (hasPending && isLineBreak(ch)) pendingHasTrailingNewLine = true;
          pos++;
          continue;
        }
        break scan;
    }
  }
  if (hasPending) {
    if (result === undefined) result = [];
    result.push(new CommentRange(pendingPos, pendingEnd, pendingKind, pendingHasTrailingNewLine));
  }
  return result;
}

/** Start positions of each line, split at CR, LF, CRLF, LS and PS. */
export function computeLineStarts(text: string): number[] {
  // Most texts break lines at LF only, which a search finds fastest.
  if (text.indexOf('\r') < 0 && text.indexOf('\u2028') < 0 && text.indexOf('\u2029') < 0) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    return starts;
  }
  const result: number[] = [];
  let lineStart = 0;
  let pos = 0;
  while (pos < text.length) {
    const ch = text.charCodeAt(pos);
    pos++;
    if (ch === CharacterCodes.carriageReturn) {
      if (pos < text.length && text.charCodeAt(pos) === CharacterCodes.lineFeed) pos++;
    } else if (
      ch !== CharacterCodes.lineFeed &&
      ch !== CharacterCodes.lineSeparator &&
      ch !== CharacterCodes.paragraphSeparator
    ) {
      continue;
    }
    result.push(lineStart);
    lineStart = pos;
  }
  result.push(lineStart);
  return result;
}

/** The zero-based line containing `pos`. */
export function computeLineOfPosition(lineStarts: readonly number[], pos: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const value = lineStarts[middle]!;
    if (value < pos) low = middle + 1;
    else if (value > pos) high = middle - 1;
    else return middle;
  }
  return low - 1;
}
