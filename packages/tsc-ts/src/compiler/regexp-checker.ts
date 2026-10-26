import {
  CharacterCodes,
  charSize,
  codePointAt,
  isASCIILetter,
  isDigit,
  isIdentifierPart,
  isWordCharacter,
} from './character-codes.js';
import { Diagnostics } from './diagnostic-messages.js';
import type { DiagnosticMessage } from './diagnostics.js';
import { IdentifierVariant, type Scanner } from './scanner.js';
import { getSpellingSuggestion } from './spelling.js';
import { ScriptTarget } from './types.js';
import {
  binaryUnicodeProperties,
  binaryUnicodePropertiesOfStrings,
  generalCategoryValues,
  nonBinaryUnicodeProperties,
  valuesOfNonBinaryUnicodeProperty,
} from './unicode-properties.js';

/** Special results of `Scanner.scanEscapeCodePoint`. */
export const enum EscapeValue {
  /** A line continuation, which has no value. */
  Empty = -1,
  /** An invalid escape whose value is its source text. */
  Raw = -2,
}

export const enum EscapeSequenceScanningFlags {
  String = 1 << 0,
  ReportErrors = 1 << 1,
  RegularExpression = 1 << 2,
  AnnexB = 1 << 3,
  AnyUnicodeMode = 1 << 4,
  AtomEscape = 1 << 5,
  ReportInvalidEscapeErrors = RegularExpression | ReportErrors,
  AllowExtendedUnicodeEscape = String | AnyUnicodeMode,
}

export const enum RegularExpressionFlags {
  None = 0,
  HasIndices = 1 << 0, // d
  Global = 1 << 1, // g
  IgnoreCase = 1 << 2, // i
  Multiline = 1 << 3, // m
  DotAll = 1 << 4, // s
  Unicode = 1 << 5, // u
  UnicodeSets = 1 << 6, // v
  Sticky = 1 << 7, // y
  AnyUnicodeMode = Unicode | UnicodeSets,
  Modifiers = IgnoreCase | Multiline | DotAll,
}

/** The flag for a regular expression flag character, or `None`. */
export function regularExpressionFlag(ch: number): RegularExpressionFlags {
  switch (ch) {
    case CharacterCodes.d:
      return RegularExpressionFlags.HasIndices;
    case CharacterCodes.g:
      return RegularExpressionFlags.Global;
    case CharacterCodes.i:
      return RegularExpressionFlags.IgnoreCase;
    case CharacterCodes.m:
      return RegularExpressionFlags.Multiline;
    case CharacterCodes.s:
      return RegularExpressionFlags.DotAll;
    case CharacterCodes.u:
      return RegularExpressionFlags.Unicode;
    case CharacterCodes.v:
      return RegularExpressionFlags.UnicodeSets;
    case CharacterCodes.y:
      return RegularExpressionFlags.Sticky;
    default:
      return RegularExpressionFlags.None;
  }
}

const enum ClassSetExpressionType {
  Unknown,
  ClassUnion,
  ClassIntersection,
  ClassSubtraction,
}

class GroupNameReference {
  readonly pos: number;
  readonly end: number;
  readonly name: string;

  constructor(pos: number, end: number, name: string) {
    this.pos = pos;
    this.end = end;
    this.name = name;
  }
}

class DecimalEscape {
  readonly pos: number;
  readonly end: number;
  readonly value: number;

  constructor(pos: number, end: number, value: number) {
    this.pos = pos;
    this.end = end;
    this.value = value;
  }
}

const noArgs: readonly string[] = [];

/**
 * Checks the body of a regular expression literal, which the scanner has bounded
 * to `[scanner.pos, end)`, and reports syntax errors through the scanner.
 */
export function checkRegularExpression(
  scanner: Scanner,
  end: number,
  flags: RegularExpressionFlags,
  namedCaptureGroups: boolean,
): void {
  new RegularExpressionChecker(scanner, end, flags, namedCaptureGroups).check();
}

// Class atoms and operands evaluate to a code point, or to one of these.
const enum ClassValue {
  /** A character class escape or nested class, which can't bound a range. */
  None = -1,
  /** More than one character, which isn't compared as a range bound. */
  String = -2,
}

function compareDecimalStrings(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a.charCodeAt(i) === CharacterCodes._0) i++;
  let j = 0;
  while (j < b.length && b.charCodeAt(j) === CharacterCodes._0) j++;
  const x = i === a.length ? '0' : a.substring(i);
  const y = j === b.length ? '0' : b.substring(j);
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

function mapKeys(map: Map<string, string>): string[] {
  const result: string[] = [];
  for (const key of map.keys()) result.push(key);
  return result;
}

function setToArray(set: Set<string>): string[] {
  const result: string[] = [];
  for (const value of set) result.push(value);
  return result;
}

class RegularExpressionChecker {
  private readonly scanner: Scanner;
  private readonly text: string;
  private readonly end: number;
  private readonly anyUnicodeMode: boolean;
  private readonly unicodeSetsMode: boolean;
  private readonly annexB: boolean;
  // Checked strictly in Unicode modes or without Annex B's looser grammar.
  private readonly anyUnicodeModeOrNonAnnexB: boolean;
  private readonly namedCaptureGroups: boolean;
  // See scanClassSetExpression.
  private mayContainStrings: boolean;
  private numberOfCapturingGroups: number;
  private readonly groupSpecifiers: Set<string>;
  private readonly groupNameReferences: GroupNameReference[];
  private readonly decimalEscapes: DecimalEscape[];
  // Scopes of named capturing groups; see scanGroupName.
  private readonly namedCapturingGroups: Set<string>[];

  constructor(scanner: Scanner, end: number, flags: RegularExpressionFlags, namedCaptureGroups: boolean) {
    this.scanner = scanner;
    this.text = scanner.text;
    this.end = end;
    this.anyUnicodeMode = (flags & RegularExpressionFlags.AnyUnicodeMode) !== 0;
    this.unicodeSetsMode = (flags & RegularExpressionFlags.UnicodeSets) !== 0;
    this.annexB = true;
    this.anyUnicodeModeOrNonAnnexB = this.anyUnicodeMode || !this.annexB;
    this.namedCaptureGroups = namedCaptureGroups;
    this.mayContainStrings = false;
    this.numberOfCapturingGroups = 0;
    this.groupSpecifiers = new Set<string>();
    this.groupNameReferences = [];
    this.decimalEscapes = [];
    this.namedCapturingGroups = [];
  }

  private char(): number {
    return this.scanner.char();
  }

  /** The code unit at absolute position `pos`, or -1 past the body. */
  private charAt(pos: number): number {
    return pos < this.end ? this.text.charCodeAt(pos) : CharacterCodes.EOF;
  }

  private error(message: DiagnosticMessage, start: number, length: number, args: readonly string[]): void {
    this.scanner.errorAt(message, start, length, args);
  }

  /** Checks the expression and returns its number of capturing groups. */
  check(): number {
    this.scanDisjunction(false);
    for (const reference of this.groupNameReferences) {
      if (this.groupSpecifiers.has(reference.name)) continue;
      this.error(
        Diagnostics.There_is_no_capturing_group_named_0_in_this_regular_expression,
        reference.pos,
        reference.end - reference.pos,
        [reference.name],
      );
      if (this.groupSpecifiers.size > 0) {
        const suggestion = getSpellingSuggestion(reference.name, setToArray(this.groupSpecifiers));
        if (suggestion !== '')
          this.error(Diagnostics.Did_you_mean_0, reference.pos, reference.end - reference.pos, [suggestion]);
      }
    }
    // Annex B reads such escapes as octal or identity escapes, but they are most likely mistakes.
    for (const escape of this.decimalEscapes) {
      if (escape.value <= this.numberOfCapturingGroups) continue;
      if (this.numberOfCapturingGroups > 0)
        this.error(
          Diagnostics.This_backreference_refers_to_a_group_that_does_not_exist_There_are_only_0_capturing_groups_in_this_regular_expression,
          escape.pos,
          escape.end - escape.pos,
          [String(this.numberOfCapturingGroups)],
        );
      else
        this.error(
          Diagnostics.This_backreference_refers_to_a_group_that_does_not_exist_There_are_no_capturing_groups_in_this_regular_expression,
          escape.pos,
          escape.end - escape.pos,
          noArgs,
        );
    }
    return this.numberOfCapturingGroups;
  }

  // Disjunction ::= Alternative ('|' Alternative)*
  private scanDisjunction(isInGroup: boolean): void {
    // The names any alternative defines. One alternative matches, so in a group they join the
    // enclosing alternative's scope: `(?:(?<a>x))(?<a>z)` defines `a` twice.
    let disjunctionNames: Set<string> | undefined;
    for (;;) {
      this.namedCapturingGroups.push(new Set<string>());
      this.scanAlternative(isInGroup);
      const alternativeNames = this.namedCapturingGroups.pop()!;
      if (alternativeNames.size > 0) {
        if (disjunctionNames === undefined) disjunctionNames = new Set<string>();
        for (const name of alternativeNames) disjunctionNames.add(name);
      }
      if (this.char() !== CharacterCodes.bar) break;
      this.scanner.pos = (this.scanner.pos + 1) | 0;
    }
    if (isInGroup && disjunctionNames !== undefined && this.namedCapturingGroups.length > 0) {
      const parentScope = this.namedCapturingGroups[this.namedCapturingGroups.length - 1]!;
      for (const name of disjunctionNames) parentScope.add(name);
    }
  }

  // Alternative ::= Term*
  // Term ::= Assertion | Atom Quantifier?
  private scanAlternative(isInGroup: boolean): void {
    let isPreviousTermQuantifiable = false;
    while (this.scanner.pos < this.end) {
      const start = this.scanner.pos;
      const ch = this.char();
      switch (ch) {
        case CharacterCodes.caret:
        case CharacterCodes.$:
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          isPreviousTermQuantifiable = false;
          continue;
        case CharacterCodes.backslash:
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          if (this.char() === CharacterCodes.b || this.char() === CharacterCodes.B) {
            this.scanner.pos = (this.scanner.pos + 1) | 0;
            isPreviousTermQuantifiable = false;
          } else {
            this.scanAtomEscape(this.char());
            isPreviousTermQuantifiable = true;
          }
          continue;
        case CharacterCodes.openParen:
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          if (this.char() === CharacterCodes.question) {
            this.scanner.pos = (this.scanner.pos + 1) | 0;
            const next = this.char();
            if (next === CharacterCodes.equals || next === CharacterCodes.exclamation) {
              this.scanner.pos = (this.scanner.pos + 1) | 0;
              // Annex B makes `(?=…)` and `(?!…)` quantifiable.
              isPreviousTermQuantifiable = !this.anyUnicodeModeOrNonAnnexB;
            } else if (next === CharacterCodes.lessThan) {
              const groupNameStart = this.scanner.pos;
              this.scanner.pos = (this.scanner.pos + 1) | 0;
              if (this.char() === CharacterCodes.equals || this.char() === CharacterCodes.exclamation) {
                this.scanner.pos = (this.scanner.pos + 1) | 0;
                isPreviousTermQuantifiable = false;
              } else {
                this.scanGroupName(false);
                this.scanExpectedChar(CharacterCodes.greaterThan);
                if (this.scanner.languageVersion() < ScriptTarget.ES2018)
                  this.error(
                    Diagnostics.Named_capturing_groups_are_only_available_when_targeting_ES2018_or_later,
                    groupNameStart,
                    this.scanner.pos - groupNameStart,
                    noArgs,
                  );
                this.numberOfCapturingGroups++;
                isPreviousTermQuantifiable = true;
              }
            } else {
              const flagsStart = this.scanner.pos;
              const setFlags = this.scanPatternModifiers(RegularExpressionFlags.None);
              if (this.char() === CharacterCodes.minus) {
                this.scanner.pos = (this.scanner.pos + 1) | 0;
                this.scanPatternModifiers(setFlags);
                if (this.scanner.pos === flagsStart + 1)
                  this.error(
                    Diagnostics.Subpattern_flags_must_be_present_when_there_is_a_minus_sign,
                    flagsStart,
                    this.scanner.pos - flagsStart,
                    noArgs,
                  );
              }
              // Modifier characters make this `(?flags:` rather than a plain `(?:` group.
              if (this.scanner.pos !== flagsStart && this.scanner.languageVersion() < ScriptTarget.ES2025)
                this.error(
                  Diagnostics.Regular_expression_pattern_modifiers_are_only_available_when_targeting_0_or_later,
                  flagsStart,
                  this.scanner.pos - flagsStart,
                  ['es2025'],
                );
              this.scanExpectedChar(CharacterCodes.colon);
              isPreviousTermQuantifiable = true;
            }
          } else {
            this.numberOfCapturingGroups++;
            isPreviousTermQuantifiable = true;
          }
          this.scanDisjunction(true);
          this.scanExpectedChar(CharacterCodes.closeParen);
          continue;
        case CharacterCodes.openBrace: {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          const digitsStart = this.scanner.pos;
          const min = this.scanDigits();
          if (!this.anyUnicodeModeOrNonAnnexB && min === '') {
            isPreviousTermQuantifiable = true;
            continue;
          }
          if (this.char() === CharacterCodes.comma) {
            this.scanner.pos = (this.scanner.pos + 1) | 0;
            const max = this.scanDigits();
            if (min === '') {
              if (max !== '' || this.char() === CharacterCodes.closeBrace) {
                this.error(Diagnostics.Incomplete_quantifier_Digit_expected, digitsStart, 0, noArgs);
              } else {
                this.error(Diagnostics.Unexpected_0_Did_you_mean_to_escape_it_with_backslash, start, 1, [
                  String.fromCharCode(ch),
                ]);
                isPreviousTermQuantifiable = true;
                continue;
              }
            } else if (
              max !== '' &&
              compareDecimalStrings(min, max) > 0 &&
              (this.anyUnicodeModeOrNonAnnexB || this.char() === CharacterCodes.closeBrace)
            ) {
              this.error(
                Diagnostics.Numbers_out_of_order_in_quantifier,
                digitsStart,
                this.scanner.pos - digitsStart,
                noArgs,
              );
            }
          } else if (min === '') {
            if (this.anyUnicodeModeOrNonAnnexB)
              this.error(Diagnostics.Unexpected_0_Did_you_mean_to_escape_it_with_backslash, start, 1, [
                String.fromCharCode(ch),
              ]);
            isPreviousTermQuantifiable = true;
            continue;
          }
          if (this.char() !== CharacterCodes.closeBrace) {
            if (!this.anyUnicodeModeOrNonAnnexB) {
              isPreviousTermQuantifiable = true;
              continue;
            }
            this.error(Diagnostics.X_0_expected, this.scanner.pos, 0, ['}']);
            this.scanner.pos = (this.scanner.pos - 1) | 0;
          }
          isPreviousTermQuantifiable = this.scanQuantifier(start, isPreviousTermQuantifiable);
          continue;
        }
        case CharacterCodes.asterisk:
        case CharacterCodes.plus:
        case CharacterCodes.question:
          isPreviousTermQuantifiable = this.scanQuantifier(start, isPreviousTermQuantifiable);
          continue;
        case CharacterCodes.dot:
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          isPreviousTermQuantifiable = true;
          continue;
        case CharacterCodes.openBracket:
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          if (this.unicodeSetsMode) this.scanClassSetExpression();
          else this.scanClassRanges();
          this.scanExpectedChar(CharacterCodes.closeBracket);
          isPreviousTermQuantifiable = true;
          continue;
        case CharacterCodes.closeParen:
        case CharacterCodes.closeBracket:
        case CharacterCodes.closeBrace:
          if (ch === CharacterCodes.closeParen && isInGroup) return;
          if (this.anyUnicodeModeOrNonAnnexB || ch === CharacterCodes.closeParen)
            this.error(Diagnostics.Unexpected_0_Did_you_mean_to_escape_it_with_backslash, this.scanner.pos, 1, [
              String.fromCharCode(ch),
            ]);
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          isPreviousTermQuantifiable = true;
          continue;
        case CharacterCodes.slash:
        case CharacterCodes.bar:
          return;
        default:
          this.scanSourceCharacter();
          isPreviousTermQuantifiable = true;
          continue;
      }
    }
  }

  /** Scans the last character of a quantifier and an optional `?`; returns false. */
  private scanQuantifier(start: number, isPreviousTermQuantifiable: boolean): boolean {
    this.scanner.pos = (this.scanner.pos + 1) | 0;
    if (this.char() === CharacterCodes.question) this.scanner.pos = (this.scanner.pos + 1) | 0; // non-greedy
    if (!isPreviousTermQuantifiable)
      this.error(Diagnostics.There_is_nothing_available_for_repetition, start, this.scanner.pos - start, noArgs);
    return false;
  }

  private scanPatternModifiers(currentFlags: RegularExpressionFlags): RegularExpressionFlags {
    while (this.scanner.pos < this.end) {
      const ch = codePointAt(this.text, this.scanner.pos, this.end);
      if (ch === CharacterCodes.replacementCharacter || !isIdentifierPart(ch)) break;
      const size = charSize(ch);
      const flag = regularExpressionFlag(ch);
      if (flag === RegularExpressionFlags.None)
        this.error(Diagnostics.Unknown_regular_expression_flag, this.scanner.pos, size, noArgs);
      else if ((currentFlags & flag) !== 0)
        this.error(Diagnostics.Duplicate_regular_expression_flag, this.scanner.pos, size, noArgs);
      else if ((flag & RegularExpressionFlags.Modifiers) === 0)
        this.error(
          Diagnostics.This_regular_expression_flag_cannot_be_toggled_within_a_subpattern,
          this.scanner.pos,
          size,
          noArgs,
        );
      // Modifiers need ES2025, later than any flag they can toggle, and the group reports that.
      else currentFlags |= flag;
      this.scanner.pos = (this.scanner.pos + size) | 0;
    }
    return currentFlags;
  }

  // AtomEscape ::= DecimalEscape | CharacterClassEscape | CharacterEscape | 'k<' RegExpIdentifierName '>'
  private scanAtomEscape(ch: number): void {
    switch (ch) {
      case CharacterCodes.k:
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        if (this.char() === CharacterCodes.lessThan) {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          this.scanGroupName(true);
          this.scanExpectedChar(CharacterCodes.greaterThan);
        } else if (this.anyUnicodeModeOrNonAnnexB || this.namedCaptureGroups) {
          this.error(
            Diagnostics.X_k_must_be_followed_by_a_capturing_group_name_enclosed_in_angle_brackets,
            this.scanner.pos - 2,
            2,
            noArgs,
          );
        }
        return;
      case CharacterCodes.q:
        if (this.unicodeSetsMode) {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          this.error(Diagnostics.X_q_is_only_available_inside_character_class, this.scanner.pos - 2, 2, noArgs);
          return;
        }
        break;
    }
    // Regex literals cannot contain line breaks, so a character escape always consumes something.
    if (!this.scanCharacterClassEscape() && !this.scanDecimalEscape()) this.scanCharacterEscape(true);
  }

  // DecimalEscape ::= [1-9] [0-9]*
  private scanDecimalEscape(): boolean {
    const ch = this.char();
    if (ch < CharacterCodes._1 || ch > CharacterCodes._9) return false;
    const start = this.scanner.pos;
    const digits = this.scanDigits();
    this.decimalEscapes.push(new DecimalEscape(start, this.scanner.pos, Number(digits)));
    return true;
  }

  // CharacterEscape ::= 'c' ControlLetter | IdentityEscape | (sequences handled by scanEscapeSequence)
  private scanCharacterEscape(atomEscape: boolean): number {
    let ch = this.char();
    switch (ch) {
      case CharacterCodes.EOF:
        this.error(Diagnostics.Undetermined_character_escape, this.scanner.pos - 1, 1, noArgs);
        return CharacterCodes.backslash;
      case CharacterCodes.c:
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        ch = this.char();
        if (isASCIILetter(ch)) {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          return ch & 0x1f;
        }
        if (this.anyUnicodeModeOrNonAnnexB) {
          this.error(Diagnostics.X_c_must_be_followed_by_an_ASCII_letter, this.scanner.pos - 2, 2, noArgs);
        } else if (atomEscape) {
          this.scanner.pos = (this.scanner.pos - 1) | 0;
          return CharacterCodes.backslash;
        }
        return ch < 0 ? CharacterCodes.replacementCharacter : ch;
      case CharacterCodes.caret:
      case CharacterCodes.$:
      case CharacterCodes.slash:
      case CharacterCodes.backslash:
      case CharacterCodes.dot:
      case CharacterCodes.asterisk:
      case CharacterCodes.plus:
      case CharacterCodes.question:
      case CharacterCodes.openParen:
      case CharacterCodes.closeParen:
      case CharacterCodes.openBracket:
      case CharacterCodes.closeBracket:
      case CharacterCodes.openBrace:
      case CharacterCodes.closeBrace:
      case CharacterCodes.bar:
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        return ch;
      default: {
        this.scanner.pos = (this.scanner.pos - 1) | 0; // include the backslash
        let flags = EscapeSequenceScanningFlags.RegularExpression;
        if (this.annexB) flags |= EscapeSequenceScanningFlags.AnnexB;
        if (this.anyUnicodeMode) flags |= EscapeSequenceScanningFlags.AnyUnicodeMode;
        if (atomEscape) flags |= EscapeSequenceScanningFlags.AtomEscape;
        const value = this.scanner.scanEscapeCodePoint(flags);
        return value === EscapeValue.Raw ? ClassValue.String : value;
      }
    }
  }

  private scanGroupName(isReference: boolean): void {
    const scanner = this.scanner;
    scanner.tokenStart = this.scanner.pos | 0;
    const start = scanner.tokenStart;
    if (!scanner.scanIdentifier(0, IdentifierVariant.RegExpGroupName)) {
      this.error(Diagnostics.Expected_a_capturing_group_name, this.scanner.pos, 0, noArgs);
      return;
    }
    const name = scanner.getTokenValue();
    if (isReference) {
      this.groupNameReferences.push(new GroupNameReference(start, this.scanner.pos, name));
    } else if (this.namedCapturingGroupsContains(name)) {
      this.error(
        Diagnostics.Named_capturing_groups_with_the_same_name_must_be_mutually_exclusive_to_each_other,
        start,
        this.scanner.pos - start,
        noArgs,
      );
    } else {
      // An earlier definition is in a mutually exclusive alternative. Below ES2018 the group is
      // reported already.
      const languageVersion = this.scanner.languageVersion();
      if (
        this.groupSpecifiers.has(name) &&
        languageVersion >= ScriptTarget.ES2018 &&
        languageVersion < ScriptTarget.ES2025
      )
        this.error(
          Diagnostics.Duplicate_named_capturing_groups_are_only_available_when_targeting_0_or_later,
          start,
          this.scanner.pos - start,
          ['es2025'],
        );
      if (this.namedCapturingGroups.length > 0)
        this.namedCapturingGroups[this.namedCapturingGroups.length - 1]!.add(name);
      this.groupSpecifiers.add(name);
    }
  }

  private namedCapturingGroupsContains(name: string): boolean {
    for (const group of this.namedCapturingGroups) if (group.has(name)) return true;
    return false;
  }

  private isClassContentExit(ch: number): boolean {
    return ch === CharacterCodes.closeBracket || this.scanner.pos >= this.end;
  }

  // ClassRanges ::= '^'? (ClassAtom ('-' ClassAtom)?)*
  // Returns MayContainStrings, which is false for class ranges.
  private scanClassRanges(): boolean {
    if (this.char() === CharacterCodes.caret) this.scanner.pos = (this.scanner.pos + 1) | 0;
    while (this.scanner.pos < this.end) {
      if (this.isClassContentExit(this.char())) return false;
      const minStart = this.scanner.pos;
      const min = this.scanClassAtom();
      if (this.char() !== CharacterCodes.minus) continue;
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      if (this.isClassContentExit(this.char())) return false;
      if (min === ClassValue.None && this.anyUnicodeModeOrNonAnnexB)
        this.error(
          Diagnostics.A_character_class_range_must_not_be_bounded_by_another_character_class,
          minStart,
          this.scanner.pos - 1 - minStart,
          noArgs,
        );
      const maxStart = this.scanner.pos;
      const max = this.scanClassAtom();
      if (max === ClassValue.None && this.anyUnicodeModeOrNonAnnexB) {
        this.error(
          Diagnostics.A_character_class_range_must_not_be_bounded_by_another_character_class,
          maxStart,
          this.scanner.pos - maxStart,
          noArgs,
        );
        continue;
      }
      if (min >= 0 && max >= 0 && min > max)
        this.error(Diagnostics.Range_out_of_order_in_character_class, minStart, this.scanner.pos - minStart, noArgs);
    }
    return false;
  }

  // ClassSetExpression ::= '^'? (ClassUnion | ClassIntersection | ClassSubtraction)
  // ClassUnion ::= (ClassSetRange | ClassSetOperand)*
  // ClassIntersection ::= ClassSetOperand ('&&' ClassSetOperand)+
  // ClassSubtraction ::= ClassSetOperand ('--' ClassSetOperand)+
  // ClassSetRange ::= ClassSetCharacter '-' ClassSetCharacter
  //
  // mayContainStrings tracks the MayContainStrings static semantics: some operand of a
  // union, every operand of an intersection, or the first operand of a subtraction.
  private scanClassSetExpression(): boolean {
    let isCharacterComplement = false;
    if (this.char() === CharacterCodes.caret) {
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      isCharacterComplement = true;
    }
    let expressionMayContainStrings = false;
    let ch = this.char();
    if (this.isClassContentExit(ch)) return this.mayContainStrings;
    let start = this.scanner.pos;
    let operand: number = ClassValue.None;
    if (this.isDoublePunctuatorOperator()) {
      this.error(Diagnostics.Expected_a_class_set_operand, this.scanner.pos, 0, noArgs);
      this.mayContainStrings = false;
    } else {
      operand = this.scanClassSetOperand();
    }
    switch (this.char()) {
      case CharacterCodes.minus:
        if (this.scanner.pos + 1 < this.end && this.charAt(this.scanner.pos + 1) === CharacterCodes.minus) {
          if (isCharacterComplement && this.mayContainStrings)
            this.error(
              Diagnostics.Anything_that_would_possibly_match_more_than_a_single_character_is_invalid_inside_a_negated_character_class,
              start,
              this.scanner.pos - start,
              noArgs,
            );
          expressionMayContainStrings = this.mayContainStrings;
          this.scanClassSetSubExpression(ClassSetExpressionType.ClassSubtraction);
          this.mayContainStrings = !isCharacterComplement && expressionMayContainStrings;
          return this.mayContainStrings;
        }
        break;
      case CharacterCodes.ampersand:
        if (this.scanner.pos + 1 < this.end && this.charAt(this.scanner.pos + 1) === CharacterCodes.ampersand) {
          this.scanClassSetSubExpression(ClassSetExpressionType.ClassIntersection);
          if (isCharacterComplement && this.mayContainStrings)
            this.error(
              Diagnostics.Anything_that_would_possibly_match_more_than_a_single_character_is_invalid_inside_a_negated_character_class,
              start,
              this.scanner.pos - start,
              noArgs,
            );
          expressionMayContainStrings = this.mayContainStrings;
          this.mayContainStrings = !isCharacterComplement && expressionMayContainStrings;
          return this.mayContainStrings;
        }
        break;
      default:
        if (isCharacterComplement && this.mayContainStrings)
          this.error(
            Diagnostics.Anything_that_would_possibly_match_more_than_a_single_character_is_invalid_inside_a_negated_character_class,
            start,
            this.scanner.pos - start,
            noArgs,
          );
        expressionMayContainStrings = this.mayContainStrings;
        break;
    }
    while (this.scanner.pos < this.end) {
      ch = this.char();
      if (ch === CharacterCodes.minus) {
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        ch = this.char();
        if (this.isClassContentExit(ch)) {
          this.mayContainStrings = !isCharacterComplement && expressionMayContainStrings;
          return this.mayContainStrings;
        }
        if (ch === CharacterCodes.minus) {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          this.error(
            Diagnostics.Operators_must_not_be_mixed_within_a_character_class_Wrap_it_in_a_nested_class_instead,
            this.scanner.pos - 2,
            2,
            noArgs,
          );
          start = this.scanner.pos - 2;
          operand = ClassValue.String;
          continue;
        }
        if (operand === ClassValue.None)
          this.error(
            Diagnostics.A_character_class_range_must_not_be_bounded_by_another_character_class,
            start,
            this.scanner.pos - 1 - start,
            noArgs,
          );
        const secondStart = this.scanner.pos;
        const secondOperand = this.scanClassSetOperand();
        if (isCharacterComplement && this.mayContainStrings)
          this.error(
            Diagnostics.Anything_that_would_possibly_match_more_than_a_single_character_is_invalid_inside_a_negated_character_class,
            secondStart,
            this.scanner.pos - secondStart,
            noArgs,
          );
        expressionMayContainStrings = expressionMayContainStrings || this.mayContainStrings;
        if (secondOperand === ClassValue.None) {
          this.error(
            Diagnostics.A_character_class_range_must_not_be_bounded_by_another_character_class,
            secondStart,
            this.scanner.pos - secondStart,
            noArgs,
          );
        } else if (operand >= 0 && secondOperand >= 0 && operand > secondOperand) {
          this.error(Diagnostics.Range_out_of_order_in_character_class, start, this.scanner.pos - start, noArgs);
        }
      } else if (
        ch === CharacterCodes.ampersand &&
        this.scanner.pos + 1 < this.end &&
        this.charAt(this.scanner.pos + 1) === CharacterCodes.ampersand
      ) {
        start = this.scanner.pos;
        this.scanner.pos = (this.scanner.pos + 2) | 0;
        this.error(
          Diagnostics.Operators_must_not_be_mixed_within_a_character_class_Wrap_it_in_a_nested_class_instead,
          this.scanner.pos - 2,
          2,
          noArgs,
        );
        if (this.char() === CharacterCodes.ampersand) {
          this.error(Diagnostics.Unexpected_0_Did_you_mean_to_escape_it_with_backslash, this.scanner.pos, 1, [
            String.fromCharCode(ch),
          ]);
          this.scanner.pos = (this.scanner.pos + 1) | 0;
        }
        operand = ClassValue.String;
        continue;
      }
      if (this.isClassContentExit(this.char())) break;
      start = this.scanner.pos;
      if (this.isDoublePunctuatorOperator()) {
        this.error(
          Diagnostics.Operators_must_not_be_mixed_within_a_character_class_Wrap_it_in_a_nested_class_instead,
          this.scanner.pos,
          2,
          noArgs,
        );
        this.scanner.pos = (this.scanner.pos + 2) | 0;
        operand = ClassValue.String;
      } else {
        operand = this.scanClassSetOperand();
        // Each operand of a negated union must match single characters.
        if (isCharacterComplement && this.mayContainStrings)
          this.error(
            Diagnostics.Anything_that_would_possibly_match_more_than_a_single_character_is_invalid_inside_a_negated_character_class,
            start,
            this.scanner.pos - start,
            noArgs,
          );
        expressionMayContainStrings = expressionMayContainStrings || this.mayContainStrings;
      }
    }
    this.mayContainStrings = !isCharacterComplement && expressionMayContainStrings;
    return this.mayContainStrings;
  }

  /** Whether `--` or `&&` starts at the current position. */
  private isDoublePunctuatorOperator(): boolean {
    if (this.scanner.pos + 1 >= this.end) return false;
    const ch = this.text.charCodeAt(this.scanner.pos);
    return (
      (ch === CharacterCodes.minus || ch === CharacterCodes.ampersand) &&
      this.text.charCodeAt(this.scanner.pos + 1) === ch
    );
  }

  private scanClassSetSubExpression(expressionType: ClassSetExpressionType): void {
    let expressionMayContainStrings = this.mayContainStrings;
    while (this.scanner.pos < this.end) {
      let ch = this.char();
      if (this.isClassContentExit(ch)) break;
      if (ch === CharacterCodes.minus) {
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        if (this.char() === CharacterCodes.minus) {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          if (expressionType !== ClassSetExpressionType.ClassSubtraction)
            this.error(
              Diagnostics.Operators_must_not_be_mixed_within_a_character_class_Wrap_it_in_a_nested_class_instead,
              this.scanner.pos - 2,
              2,
              noArgs,
            );
        } else {
          this.error(
            Diagnostics.Operators_must_not_be_mixed_within_a_character_class_Wrap_it_in_a_nested_class_instead,
            this.scanner.pos - 1,
            1,
            noArgs,
          );
        }
      } else if (ch === CharacterCodes.ampersand) {
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        if (this.char() === CharacterCodes.ampersand) {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          if (expressionType !== ClassSetExpressionType.ClassIntersection)
            this.error(
              Diagnostics.Operators_must_not_be_mixed_within_a_character_class_Wrap_it_in_a_nested_class_instead,
              this.scanner.pos - 2,
              2,
              noArgs,
            );
          if (this.char() === CharacterCodes.ampersand) {
            this.error(Diagnostics.Unexpected_0_Did_you_mean_to_escape_it_with_backslash, this.scanner.pos, 1, [
              String.fromCharCode(ch),
            ]);
            this.scanner.pos = (this.scanner.pos + 1) | 0;
          }
        } else {
          this.error(Diagnostics.Unexpected_0_Did_you_mean_to_escape_it_with_backslash, this.scanner.pos - 1, 1, [
            String.fromCharCode(ch),
          ]);
        }
      } else if (expressionType === ClassSetExpressionType.ClassSubtraction) {
        this.error(Diagnostics.X_0_expected, this.scanner.pos, 0, ['--']);
      } else if (expressionType === ClassSetExpressionType.ClassIntersection) {
        this.error(Diagnostics.X_0_expected, this.scanner.pos, 0, ['&&']);
      }
      ch = this.char();
      if (this.isClassContentExit(ch)) {
        this.error(Diagnostics.Expected_a_class_set_operand, this.scanner.pos, 0, noArgs);
        break;
      }
      this.scanClassSetOperand();
      if (expressionType === ClassSetExpressionType.ClassIntersection)
        expressionMayContainStrings = expressionMayContainStrings && this.mayContainStrings;
    }
    this.mayContainStrings = expressionMayContainStrings;
  }

  // ClassSetOperand ::= '[' ClassSetExpression ']' | '\' CharacterClassEscape | '\q{' ClassStringDisjunctionContents '}' | ClassSetCharacter
  private scanClassSetOperand(): number {
    this.mayContainStrings = false;
    const ch = this.char();
    if (ch === CharacterCodes.openBracket) {
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      this.scanClassSetExpression();
      this.scanExpectedChar(CharacterCodes.closeBracket);
      return ClassValue.None;
    }
    if (ch === CharacterCodes.backslash) {
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      if (this.scanCharacterClassEscape()) return ClassValue.None;
      if (this.char() === CharacterCodes.q) {
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        if (this.char() === CharacterCodes.openBrace) {
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          this.scanClassStringDisjunctionContents();
          this.scanExpectedChar(CharacterCodes.closeBrace);
          return ClassValue.None;
        }
        this.error(
          Diagnostics.X_q_must_be_followed_by_string_alternatives_enclosed_in_braces,
          this.scanner.pos - 2,
          2,
          noArgs,
        );
        return CharacterCodes.q;
      }
      this.scanner.pos = (this.scanner.pos - 1) | 0;
    }
    return this.scanClassSetCharacter();
  }

  // ClassStringDisjunctionContents ::= ClassSetCharacter* ('|' ClassSetCharacter*)*
  private scanClassStringDisjunctionContents(): boolean {
    let characterCount = 0;
    while (this.scanner.pos < this.end) {
      const ch = this.char();
      if (ch === CharacterCodes.closeBrace) {
        if (characterCount !== 1) this.mayContainStrings = true;
        return this.mayContainStrings;
      }
      if (ch === CharacterCodes.bar) {
        if (characterCount !== 1) this.mayContainStrings = true;
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        characterCount = 0;
      } else {
        this.scanClassSetCharacter();
        characterCount++;
      }
    }
    return this.mayContainStrings;
  }

  // ClassSetCharacter ::= SourceCharacter -- ClassSetSyntaxCharacter -- ClassSetReservedDoublePunctuator
  //   | '\' (CharacterEscape | ClassSetReservedPunctuator | 'b')
  private scanClassSetCharacter(): number {
    const ch = this.char();
    if (ch === CharacterCodes.backslash) {
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      const inner = this.char();
      switch (inner) {
        case CharacterCodes.b:
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          return CharacterCodes.backspace;
        case CharacterCodes.ampersand:
        case CharacterCodes.minus:
        case CharacterCodes.exclamation:
        case CharacterCodes.hash:
        case CharacterCodes.percent:
        case CharacterCodes.comma:
        case CharacterCodes.colon:
        case CharacterCodes.semicolon:
        case CharacterCodes.lessThan:
        case CharacterCodes.equals:
        case CharacterCodes.greaterThan:
        case CharacterCodes.at:
        case CharacterCodes.backtick:
        case CharacterCodes.tilde:
          this.scanner.pos = (this.scanner.pos + 1) | 0;
          return inner;
        default:
          return this.scanCharacterEscape(false);
      }
    }
    if (this.scanner.pos + 1 < this.end && ch === this.charAt(this.scanner.pos + 1)) {
      switch (ch) {
        case CharacterCodes.ampersand:
        case CharacterCodes.exclamation:
        case CharacterCodes.hash:
        case CharacterCodes.percent:
        case CharacterCodes.asterisk:
        case CharacterCodes.plus:
        case CharacterCodes.comma:
        case CharacterCodes.dot:
        case CharacterCodes.colon:
        case CharacterCodes.semicolon:
        case CharacterCodes.lessThan:
        case CharacterCodes.equals:
        case CharacterCodes.greaterThan:
        case CharacterCodes.question:
        case CharacterCodes.at:
        case CharacterCodes.backtick:
        case CharacterCodes.tilde:
          this.error(
            Diagnostics.A_character_class_must_not_contain_a_reserved_double_punctuator_Did_you_mean_to_escape_it_with_backslash,
            this.scanner.pos,
            2,
            noArgs,
          );
          this.scanner.pos = (this.scanner.pos + 2) | 0;
          return ClassValue.String;
      }
    }
    switch (ch) {
      case CharacterCodes.slash:
      case CharacterCodes.openParen:
      case CharacterCodes.closeParen:
      case CharacterCodes.openBracket:
      case CharacterCodes.closeBracket:
      case CharacterCodes.openBrace:
      case CharacterCodes.closeBrace:
      case CharacterCodes.minus:
      case CharacterCodes.bar:
        this.error(Diagnostics.Unexpected_0_Did_you_mean_to_escape_it_with_backslash, this.scanner.pos, 1, [
          String.fromCharCode(ch),
        ]);
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        return ch;
    }
    return this.scanSourceCharacter();
  }

  // ClassAtom ::= SourceCharacter but not '\' or ']' | '\' ClassEscape
  // ClassEscape ::= 'b' | '-' | CharacterClassEscape | CharacterEscape
  private scanClassAtom(): number {
    if (this.char() !== CharacterCodes.backslash) return this.scanSourceCharacter();
    this.scanner.pos = (this.scanner.pos + 1) | 0;
    const ch = this.char();
    if (ch === CharacterCodes.b) {
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      return CharacterCodes.backspace;
    }
    if (ch === CharacterCodes.minus) {
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      return CharacterCodes.minus;
    }
    if (this.scanCharacterClassEscape()) return ClassValue.None;
    return this.scanCharacterEscape(false);
  }

  // CharacterClassEscape ::= 'd' | 'D' | 's' | 'S' | 'w' | 'W'
  //   | [+AnyUnicodeMode] ('P' | 'p') '{' UnicodePropertyValueExpression '}'
  private scanCharacterClassEscape(): boolean {
    const start = this.scanner.pos - 1;
    const ch = this.char();
    switch (ch) {
      case CharacterCodes.d:
      case CharacterCodes.D:
      case CharacterCodes.s:
      case CharacterCodes.S:
      case CharacterCodes.w:
      case CharacterCodes.W:
        this.scanner.pos = (this.scanner.pos + 1) | 0;
        return true;
      case CharacterCodes.P:
      case CharacterCodes.p:
        break;
      default:
        return false;
    }
    const isCharacterComplement = ch === CharacterCodes.P;
    this.scanner.pos = (this.scanner.pos + 1) | 0;
    if (this.char() !== CharacterCodes.openBrace) {
      if (!this.anyUnicodeModeOrNonAnnexB) {
        this.scanner.pos = (this.scanner.pos - 1) | 0;
        return false;
      }
      this.error(
        Diagnostics.X_0_must_be_followed_by_a_Unicode_property_value_expression_enclosed_in_braces,
        this.scanner.pos - 2,
        2,
        [String.fromCharCode(ch)],
      );
      return true;
    }
    this.scanner.pos = (this.scanner.pos + 1) | 0;
    const nameOrValueStart = this.scanner.pos;
    const nameOrValue = this.scanWordCharacters();
    if (this.char() === CharacterCodes.equals) {
      const propertyName = nonBinaryUnicodeProperties.get(nameOrValue) ?? '';
      if (this.scanner.pos === nameOrValueStart) {
        this.error(Diagnostics.Expected_a_Unicode_property_name, this.scanner.pos, 0, noArgs);
      } else if (propertyName === '') {
        this.error(
          Diagnostics.Unknown_Unicode_property_name,
          nameOrValueStart,
          this.scanner.pos - nameOrValueStart,
          noArgs,
        );
        const suggestion = getSpellingSuggestion(nameOrValue, mapKeys(nonBinaryUnicodeProperties));
        if (suggestion !== '')
          this.error(Diagnostics.Did_you_mean_0, nameOrValueStart, this.scanner.pos - nameOrValueStart, [suggestion]);
      }
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      const valueStart = this.scanner.pos;
      const value = this.scanWordCharacters();
      if (this.scanner.pos === valueStart) {
        this.error(Diagnostics.Expected_a_Unicode_property_value, this.scanner.pos, 0, noArgs);
      } else if (propertyName !== '') {
        const values = valuesOfNonBinaryUnicodeProperty(propertyName);
        if (!values.has(value)) {
          this.error(Diagnostics.Unknown_Unicode_property_value, valueStart, this.scanner.pos - valueStart, noArgs);
          const suggestion = getSpellingSuggestion(value, setToArray(values));
          if (suggestion !== '')
            this.error(Diagnostics.Did_you_mean_0, valueStart, this.scanner.pos - valueStart, [suggestion]);
        }
      }
    } else if (this.scanner.pos === nameOrValueStart) {
      this.error(Diagnostics.Expected_a_Unicode_property_name_or_value, this.scanner.pos, 0, noArgs);
    } else if (binaryUnicodePropertiesOfStrings.has(nameOrValue)) {
      if (!this.unicodeSetsMode)
        this.error(
          Diagnostics.Any_Unicode_property_that_would_possibly_match_more_than_a_single_character_is_only_available_when_the_Unicode_Sets_v_flag_is_set,
          nameOrValueStart,
          this.scanner.pos - nameOrValueStart,
          noArgs,
        );
      else if (isCharacterComplement)
        this.error(
          Diagnostics.Anything_that_would_possibly_match_more_than_a_single_character_is_invalid_inside_a_negated_character_class,
          nameOrValueStart,
          this.scanner.pos - nameOrValueStart,
          noArgs,
        );
      else this.mayContainStrings = true;
    } else if (!generalCategoryValues.has(nameOrValue) && !binaryUnicodeProperties.has(nameOrValue)) {
      this.error(
        Diagnostics.Unknown_Unicode_property_name_or_value,
        nameOrValueStart,
        this.scanner.pos - nameOrValueStart,
        noArgs,
      );
      const candidates = setToArray(generalCategoryValues);
      for (const name of binaryUnicodeProperties) candidates.push(name);
      for (const name of binaryUnicodePropertiesOfStrings) candidates.push(name);
      const suggestion = getSpellingSuggestion(nameOrValue, candidates);
      if (suggestion !== '')
        this.error(Diagnostics.Did_you_mean_0, nameOrValueStart, this.scanner.pos - nameOrValueStart, [suggestion]);
    }
    this.scanExpectedChar(CharacterCodes.closeBrace);
    if (!this.anyUnicodeMode)
      this.error(
        Diagnostics.Unicode_property_value_expressions_are_only_available_when_the_Unicode_u_flag_or_the_Unicode_Sets_v_flag_is_set,
        start,
        this.scanner.pos - start,
        noArgs,
      );
    return true;
  }

  private scanWordCharacters(): string {
    const start = this.scanner.pos;
    while (this.scanner.pos < this.end && isWordCharacter(this.char())) this.scanner.pos = (this.scanner.pos + 1) | 0;
    return this.text.substring(start, this.scanner.pos);
  }

  /** One code point in Unicode modes, otherwise one UTF-16 code unit. */
  private scanSourceCharacter(): number {
    if (this.scanner.pos >= this.end) return ClassValue.None;
    if (!this.anyUnicodeMode) {
      const ch = this.scanner.chars[this.scanner.pos];
      this.scanner.pos = (this.scanner.pos + 1) | 0;
      return ch;
    }
    const ch = this.scanner.codePointAt(this.scanner.pos, this.end);
    this.scanner.pos = (this.scanner.pos + charSize(ch)) | 0;
    // Like TypeScript 7, treat U+FFFD as an undecodable character.
    return ch === CharacterCodes.replacementCharacter ? ClassValue.None : ch;
  }

  private scanExpectedChar(ch: number): void {
    if (this.char() === ch) this.scanner.pos = (this.scanner.pos + 1) | 0;
    else this.error(Diagnostics.X_0_expected, this.scanner.pos, 0, [String.fromCharCode(ch)]);
  }

  private scanDigits(): string {
    const start = this.scanner.pos;
    while (this.scanner.pos < this.end && isDigit(this.char())) this.scanner.pos = (this.scanner.pos + 1) | 0;
    return this.text.substring(start, this.scanner.pos);
  }
}
