import { LanguageVariant } from './types.js';
import { identifierPartRanges, identifierStartRanges } from './unicode-identifiers.js';

/** UTF-16 code units the scanner tests for. */
export const enum CharacterCodes {
  EOF = -1,
  nullCharacter = 0,
  maxAsciiCharacter = 0x7f,

  lineFeed = 0x0a, // \n
  carriageReturn = 0x0d, // \r
  lineSeparator = 0x2028,
  paragraphSeparator = 0x2029,
  nextLine = 0x0085,

  // Unicode 3.0 space characters
  space = 0x0020,
  nonBreakingSpace = 0x00a0,
  enQuad = 0x2000,
  emQuad = 0x2001,
  enSpace = 0x2002,
  emSpace = 0x2003,
  threePerEmSpace = 0x2004,
  fourPerEmSpace = 0x2005,
  sixPerEmSpace = 0x2006,
  figureSpace = 0x2007,
  punctuationSpace = 0x2008,
  thinSpace = 0x2009,
  hairSpace = 0x200a,
  zeroWidthSpace = 0x200b,
  narrowNoBreakSpace = 0x202f,
  ideographicSpace = 0x3000,
  mathematicalSpace = 0x205f,
  ogham = 0x1680,

  replacementCharacter = 0xfffd,

  _ = 0x5f,
  $ = 0x24,

  _0 = 0x30,
  _1 = 0x31,
  _2 = 0x32,
  _3 = 0x33,
  _4 = 0x34,
  _5 = 0x35,
  _6 = 0x36,
  _7 = 0x37,
  _8 = 0x38,
  _9 = 0x39,

  a = 0x61,
  b = 0x62,
  c = 0x63,
  d = 0x64,
  e = 0x65,
  f = 0x66,
  g = 0x67,
  h = 0x68,
  i = 0x69,
  j = 0x6a,
  k = 0x6b,
  l = 0x6c,
  m = 0x6d,
  n = 0x6e,
  o = 0x6f,
  p = 0x70,
  q = 0x71,
  r = 0x72,
  s = 0x73,
  t = 0x74,
  u = 0x75,
  v = 0x76,
  w = 0x77,
  x = 0x78,
  y = 0x79,
  z = 0x7a,

  A = 0x41,
  B = 0x42,
  C = 0x43,
  D = 0x44,
  E = 0x45,
  F = 0x46,
  G = 0x47,
  H = 0x48,
  I = 0x49,
  J = 0x4a,
  K = 0x4b,
  L = 0x4c,
  M = 0x4d,
  N = 0x4e,
  O = 0x4f,
  P = 0x50,
  Q = 0x51,
  R = 0x52,
  S = 0x53,
  T = 0x54,
  U = 0x55,
  V = 0x56,
  W = 0x57,
  X = 0x58,
  Y = 0x59,
  Z = 0x5a,

  ampersand = 0x26, // &
  asterisk = 0x2a, // *
  at = 0x40, // @
  backslash = 0x5c, // \
  backtick = 0x60, // `
  bar = 0x7c, // |
  caret = 0x5e, // ^
  closeBrace = 0x7d, // }
  closeBracket = 0x5d, // ]
  closeParen = 0x29, // )
  colon = 0x3a, // :
  comma = 0x2c, // ,
  dot = 0x2e, // .
  doubleQuote = 0x22, // "
  equals = 0x3d, // =
  exclamation = 0x21, // !
  greaterThan = 0x3e, // >
  hash = 0x23, // #
  lessThan = 0x3c, // <
  minus = 0x2d, // -
  openBrace = 0x7b, // {
  openBracket = 0x5b, // [
  openParen = 0x28, // (
  percent = 0x25, // %
  plus = 0x2b, // +
  question = 0x3f, // ?
  semicolon = 0x3b, // ;
  singleQuote = 0x27, // '
  slash = 0x2f, // /
  tilde = 0x7e, // ~

  backspace = 0x08, // \b
  formFeed = 0x0c, // \f
  byteOrderMark = 0xfeff,
  tab = 0x09, // \t
  verticalTab = 0x0b, // \v
}

/** ECMAScript line terminators: LF, CR, LS and PS. */
export function isLineBreak(ch: number): boolean {
  return (
    ch === CharacterCodes.lineFeed ||
    ch === CharacterCodes.carriageReturn ||
    ch === CharacterCodes.lineSeparator ||
    ch === CharacterCodes.paragraphSeparator
  );
}

/** Whitespace other than line terminators. NEL (U+0085) counts as whitespace. */
export function isWhiteSpaceSingleLine(ch: number): boolean {
  if (ch < 0x80) {
    return (
      ch === CharacterCodes.space ||
      ch === CharacterCodes.tab ||
      ch === CharacterCodes.verticalTab ||
      ch === CharacterCodes.formFeed
    );
  }
  return (
    ch === CharacterCodes.nextLine ||
    ch === CharacterCodes.nonBreakingSpace ||
    ch === CharacterCodes.ogham ||
    (ch >= CharacterCodes.enQuad && ch <= CharacterCodes.zeroWidthSpace) ||
    ch === CharacterCodes.narrowNoBreakSpace ||
    ch === CharacterCodes.mathematicalSpace ||
    ch === CharacterCodes.ideographicSpace ||
    ch === CharacterCodes.byteOrderMark
  );
}

export function isWhiteSpaceLike(ch: number): boolean {
  return isWhiteSpaceSingleLine(ch) || isLineBreak(ch);
}

/** Unicode White_Space, as Go's `unicode.IsSpace` defines it. Unlike `isWhiteSpaceLike`, excludes ZWSP and BOM. */
export function isUnicodeWhiteSpace(ch: number): boolean {
  return (
    (ch >= CharacterCodes.tab && ch <= CharacterCodes.carriageReturn) ||
    ch === CharacterCodes.space ||
    ch === CharacterCodes.nextLine ||
    ch === CharacterCodes.nonBreakingSpace ||
    ch === CharacterCodes.ogham ||
    (ch >= CharacterCodes.enQuad && ch <= CharacterCodes.hairSpace) ||
    ch === CharacterCodes.lineSeparator ||
    ch === CharacterCodes.paragraphSeparator ||
    ch === CharacterCodes.narrowNoBreakSpace ||
    ch === CharacterCodes.mathematicalSpace ||
    ch === CharacterCodes.ideographicSpace
  );
}

export function isDigit(ch: number): boolean {
  return ch >= CharacterCodes._0 && ch <= CharacterCodes._9;
}

export function isOctalDigit(ch: number): boolean {
  return ch >= CharacterCodes._0 && ch <= CharacterCodes._7;
}

export function isHexDigit(ch: number): boolean {
  return (
    (ch >= CharacterCodes._0 && ch <= CharacterCodes._9) ||
    (ch >= CharacterCodes.A && ch <= CharacterCodes.F) ||
    (ch >= CharacterCodes.a && ch <= CharacterCodes.f)
  );
}

export function isASCIILetter(ch: number): boolean {
  return (ch >= CharacterCodes.A && ch <= CharacterCodes.Z) || (ch >= CharacterCodes.a && ch <= CharacterCodes.z);
}

/** `[A-Za-z0-9_]`. */
export function isWordCharacter(ch: number): boolean {
  return isASCIILetter(ch) || isDigit(ch) || ch === CharacterCodes._;
}

export function isHighSurrogate(ch: number): boolean {
  return ch >= 0xd800 && ch <= 0xdbff;
}

export function isLowSurrogate(ch: number): boolean {
  return ch >= 0xdc00 && ch <= 0xdfff;
}

/** Number of UTF-16 code units of a code point. */
export function charSize(codePoint: number): number {
  return codePoint >= 0x10000 ? 2 : 1;
}

/** The code point at `pos`, combining a surrogate pair; -1 at or past `end`. */
export function codePointAt(text: string, pos: number, end: number): number {
  if (pos >= end) return CharacterCodes.EOF;
  const ch = text.charCodeAt(pos);
  if (ch >= 0xd800 && ch <= 0xdbff && pos + 1 < end) {
    const low = text.charCodeAt(pos + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return (ch - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  return ch;
}

/** Length of `text` in UTF-8 bytes. A lone surrogate counts as U+FFFD, as `Buffer` encodes it. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The code point ending just before `pos`, combining a surrogate pair; -1 at the start. */
export function codePointBefore(text: string, pos: number): number {
  if (pos <= 0) return CharacterCodes.EOF;
  const ch = text.charCodeAt(pos - 1);
  if (ch >= 0xdc00 && ch <= 0xdfff && pos >= 2) {
    const high = text.charCodeAt(pos - 2);
    if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (ch - 0xdc00) + 0x10000;
  }
  return ch;
}

function inRanges(ranges: Int32Array, codePoint: number): boolean {
  let low = 0;
  let high = (ranges.length >> 1) - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codePoint < ranges[middle * 2]) high = middle - 1;
    else if (codePoint > ranges[middle * 2 + 1]) low = middle + 1;
    else return true;
  }
  return false;
}

/** Unicode ID_Start. */
export function isUnicodeIdentifierStart(codePoint: number): boolean {
  return inRanges(identifierStartRanges, codePoint);
}

/** Unicode ID_Continue. */
export function isUnicodeIdentifierPart(codePoint: number): boolean {
  return inRanges(identifierPartRanges, codePoint);
}

export function isIdentifierStart(codePoint: number): boolean {
  return (
    isASCIILetter(codePoint) ||
    codePoint === CharacterCodes._ ||
    codePoint === CharacterCodes.$ ||
    (codePoint > CharacterCodes.maxAsciiCharacter && isUnicodeIdentifierStart(codePoint))
  );
}

export function isIdentifierPart(codePoint: number, languageVariant = LanguageVariant.Standard): boolean {
  return (
    isWordCharacter(codePoint) ||
    codePoint === CharacterCodes.$ ||
    (codePoint > CharacterCodes.maxAsciiCharacter && isUnicodeIdentifierPart(codePoint)) ||
    // `:` is part of a JSX namespaced name, but not of a JSX identifier.
    (languageVariant === LanguageVariant.JSX && codePoint === CharacterCodes.minus)
  );
}

/** UTF-8 offset of each UTF-16 offset of `text`; the middle of a surrogate pair maps to its start. */
export function utf8Offsets(text: string): Int32Array {
  const offsets = new Int32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = bytes;
    const ch = text.charCodeAt(i);
    if (ch < 0x80) bytes += 1;
    else if (ch < 0x800) bytes += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        offsets[i + 1] = bytes;
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}
