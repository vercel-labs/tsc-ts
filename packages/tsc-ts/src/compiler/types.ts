import type { SyntaxKind } from './syntax-kind.js';

export const enum TokenFlags {
  None = 0,
  PrecedingLineBreak = 1 << 0,
  PrecedingJSDocComment = 1 << 1,
  Unterminated = 1 << 2,
  /** e.g. `\u{10ffff}` */
  ExtendedUnicodeEscape = 1 << 3,
  /** e.g. `10e2` */
  Scientific = 1 << 4,
  /** e.g. `0777` */
  Octal = 1 << 5,
  /** e.g. `0x00000000` */
  HexSpecifier = 1 << 6,
  /** e.g. `0b0110010000000000` */
  BinarySpecifier = 1 << 7,
  /** e.g. `0o777` */
  OctalSpecifier = 1 << 8,
  /** e.g. `0b1100_0101` */
  ContainsSeparator = 1 << 9,
  /** e.g. `\u00a0` */
  UnicodeEscape = 1 << 10,
  /** e.g. `\uhello` */
  ContainsInvalidEscape = 1 << 11,
  /** e.g. `\xa0` */
  HexEscape = 1 << 12,
  /** e.g. `0888` */
  ContainsLeadingZero = 1 << 13,
  /** e.g. `0_1` */
  ContainsInvalidSeparator = 1 << 14,
  PrecedingJSDocLeadingAsterisks = 1 << 15,
  /** e.g. `'abc'` */
  SingleQuote = 1 << 16,
  /** The preceding JSDoc comment contains `@deprecated`. */
  PrecedingJSDocWithDeprecated = 1 << 17,
  /** The preceding JSDoc comment contains `@see` or `@link`. */
  PrecedingJSDocWithSeeOrLink = 1 << 18,

  BinaryOrOctalSpecifier = BinarySpecifier | OctalSpecifier,
  WithSpecifier = HexSpecifier | BinaryOrOctalSpecifier,
  StringLiteralFlags = Unterminated |
    HexEscape |
    UnicodeEscape |
    ExtendedUnicodeEscape |
    ContainsInvalidEscape |
    SingleQuote,
  NumericLiteralFlags = Scientific |
    Octal |
    ContainsLeadingZero |
    WithSpecifier |
    ContainsSeparator |
    ContainsInvalidSeparator,
  TemplateLiteralLikeFlags = Unterminated | HexEscape | UnicodeEscape | ExtendedUnicodeEscape | ContainsInvalidEscape,
  RegularExpressionLiteralFlags = Unterminated,
  IsInvalid = Octal | ContainsLeadingZero | ContainsInvalidSeparator | ContainsInvalidEscape,
}

export const enum ScriptTarget {
  None = 0,
  ES5 = 1,
  ES2015 = 2,
  ES2016 = 3,
  ES2017 = 4,
  ES2018 = 5,
  ES2019 = 6,
  ES2020 = 7,
  ES2021 = 8,
  ES2022 = 9,
  ES2023 = 10,
  ES2024 = 11,
  ES2025 = 12,
  ES2026 = 13,
  ESNext = 99,
  JSON = 100,
  Latest = ESNext,
  LatestStandard = ES2026,
}

export const enum LanguageVariant {
  Standard = 0,
  JSX = 1,
}

export const enum CommentDirectiveKind {
  Unknown = 0,
  ExpectError = 1,
  Ignore = 2,
}

/** A `// @ts-expect-error` or `// @ts-ignore` comment. */
export class CommentDirective {
  readonly pos: number;
  readonly end: number;
  readonly kind: CommentDirectiveKind;

  constructor(pos: number, end: number, kind: CommentDirectiveKind) {
    this.pos = pos | 0;
    this.end = end | 0;
    this.kind = kind;
  }
}

export class CommentRange {
  readonly pos: number;
  readonly end: number;
  readonly kind: SyntaxKind;
  readonly hasTrailingNewLine: boolean;

  constructor(pos: number, end: number, kind: SyntaxKind, hasTrailingNewLine: boolean) {
    this.pos = pos | 0;
    this.end = end | 0;
    this.kind = kind;
    this.hasTrailingNewLine = hasTrailingNewLine;
  }
}
