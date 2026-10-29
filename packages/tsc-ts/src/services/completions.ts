// Completions at a position, like tsgo's language service. Completions that need auto imports (global identifiers,
// import statements and exhaustive switch cases) take them from an auto-import registry; without one they report
// `NeedsAutoImports`, as `tsc --api` does before auto-imports are prepared.
import {
  BindingElement,
  getTypeArguments,
  JsxAttributes,
  JsxSelfClosingElement,
  getBody,
  getImportClause,
  TypeParameterDeclaration,
  getLiteral,
  JSDocAugmentsTag,
  JSDocImplementsTag,
  JsxNamespacedName,
  TaggedTemplateExpression,
  getElements,
  getExpression,
  getInitializer,
  getModuleSpecifier,
  getName,
  getParameters,
  getProperties,
  getPropertyName,
  getText,
  getType,
  getTypeParameters,
  Identifier,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  ImportTypeNode,
  JSDoc,
  JSDocParameterOrPropertyTag,
  JSDocTemplateTag,
  JsxAttribute,
  JsxElement,
  JsxOpeningElement,
  JsxSpreadAttribute,
  type Node,
  NodeFlags,
  PropertyAccessExpression,
  QualifiedName,
  type SourceFile,
  getTagName,
  getTypeExpression,
  ExternalModuleReference,
  BigIntLiteral,
  CaseBlock,
  CaseOrDefaultClause,
  NodeList,
  PrefixUnaryExpression,
  NamedImports,
  ImportAttributes,
  ImportAttribute,
  BinaryExpression,
  ArrayLiteralExpression,
  getMembers,
  getLocals,
  getSymbol,
  getLabel,
  ParameterDeclaration,
  CallExpression,
  ElementAccessExpression,
  IndexedAccessTypeNode,
  LiteralTypeNode,
  NumericLiteral,
  ParenthesizedExpression,
  ParenthesizedTypeNode,
  StringLiteral,
  TypeQueryNode,
  TypeReferenceNode,
} from '../compiler/ast.js';
import {
  findChildOfKind,
  findPrecedingToken,
  getFirstToken,
  getLastChild,
  getLastToken,
  getStartOfNode,
  getTokenAtPosition,
  getTouchingPropertyName,
} from '../compiler/astnav.js';
import {
  isFunctionLike,
  isKeyword,
  isParameterPropertyModifier,
  isClassMemberModifier,
  nodeIsMissing,
  isInJSFile,
} from '../compiler/ast-utilities.js';
import {
  getModifierFlags,
  getRootDeclaration,
  getSourceFileOfNode,
  isClassLike,
  isPrivateIdentifierClassElementDeclaration,
  isStatic,
  symbolName,
  isPropertyNameLiteral,
} from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { ContextFlags } from '../compiler/checker-contextual.js';
import {
  getContextualTypeForArgumentAtIndex,
  getTypeOfPropertyOfContextualType,
} from '../compiler/checker-contextual.js';
import { getElementTypeOfArrayType } from '../compiler/checker-declared-types.js';
import { isDeprecatedDeclaration } from '../compiler/checker-deprecation.js';
import { getNonNullableType } from '../compiler/checker-flow.js';
import { getPromisedTypeOfPromise } from '../compiler/checker-iteration.js';
import { getContextualTypeForJsxAttribute } from '../compiler/checker-jsx.js';
import {
  getDeclarationModifierFlagsFromSymbol,
  getPropertiesOfType,
  isArrayLikeType,
} from '../compiler/checker-members.js';
import { isPropertyAccessible } from '../compiler/checker-property-access.js';
import {
  getConstantValue,
  getSymbolAtLocation,
  getTypeAtLocation,
  getTypeOfSymbolAtLocation,
  isDeclarationName,
  isEntityName,
  isPartOfTypeNode,
} from '../compiler/checker-services.js';

import { getUnionType, typesOf } from '../compiler/checker-type-factory.js';
import { getTypeFromTypeNode } from '../compiler/checker-type-nodes.js';
import { LiteralType, ObjectFlags, type Type, TypeFlags } from '../compiler/checker-types.js';
import { isLateBoundName } from '../compiler/checker-utilities.js';
import { isTypeOnlyImportOrExportDeclaration } from '../compiler/checker-modules.js';
import { isCheckJsEnabledForFile, isSourceFileJS } from '../compiler/program-utilities.js';
import type { CompilerOptions } from '../compiler/options.js';
import type { Program } from '../compiler/program.js';
import {
  identifierToKeywordKind,
  isIdentifierText,
  Scanner,
  stringToToken,
  tokenToString,
} from '../compiler/scanner.js';
import { getAccessibleSymbolChain } from '../compiler/symbol-accessibility.js';
import { ModifierFlags } from '../compiler/ast.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { symbolToString } from '../compiler/type-printer.js';
import { LanguageVariant } from '../compiler/types.js';
import {
  getAllPossiblePropertiesOfTypes,
  getApparentProperties,
  getCallSignatures,
  getContextualTypeForArrayLiteralAtPosition,
  getContextualTypeWithFlags,
  getExportsAndPropertiesOfModule,
  getExportsOfModuleAsArray,
  getNonOptionalType,
  getNumberIndexType,
  getStringIndexType,
  getTypeArgumentConstraint,
  isExternalModuleSymbol,
  isNullableType,
  isTypeInvalidDueToUnionDiscriminant,
  isValidPropertyAccess,
  isValidPropertyAccessForCompletions,
  skipAlias,
  tryGetMemberInModuleExportsAndProperties,
} from './completion-checker.js';
import {
  CaseClauseTracker,
  findAncestor,
  findAncestorOrQuit,
  FindAncestorResult,
  getAllSuperTypeNodes,
  getArgumentInfoForCompletions,
  getClassExtendsHeritageElement,
  getContextualTypeFromParent,
  getLineEndOfPosition,
  getLineOfPosition,
  getLineStartPositionForPosition,
  getLinesBetweenPositions,
  getSwitchedType,
  isClassOrTypeElement,
  isContextualKeyword,
  isEqualityOperatorKind,
  isInComment,
  isInRightSideOfInternalImportEqualsDeclaration,
  isInString,
  isNodeDescendantOf,
  isNonContextualKeyword,
  isObjectTypeDeclaration,
  isPossiblyTypeArgumentPosition,
  isStringLiteralLike,
  isStringTextContainingNode,
  isTypeKeyword,
  isTypeNode,
  isUnterminatedLiteral,
  positionIsASICandidate,
  quote,
  quotePropertyName,
  isJsxOpeningLikeElement,
  isFunctionBlock,
  positionBelongsToNode,
  probablyUsesSemicolons,
} from './completion-utilities.js';
import { CompletionItemKind, getCompletionsSymbolKind, getSymbolKind, ScriptElementKind } from './symbol-kinds.js';
import { getStringLiteralCompletions } from './string-completions.js';
import { getJsxType } from '../compiler/checker-jsx.js';
import { TokenFlags } from '../compiler/types.js';
import { isValidTypeOnlyAliasUseSite } from '../compiler/checker-modules.js';
import { isAssertionExpression } from '../compiler/checker-type-nodes.js';
import { type AutoImportRegistry, AutoImportView, type FixAndExport, ImportKind } from './auto-import-view.js';
import { ModuleSpecifierPreferences } from '../compiler/module-specifiers.js';
import { getSymbolsInScope, isArgumentsSymbol, tryGetThisTypeAtEx } from './scope-queries.js';
import { getGlobalSymbol, getSymbolFlags } from '../compiler/checker-symbols.js';
import { isFunctionLikeDeclarationKind } from '../compiler/ast-utilities.js';
import { isClassLike as isClassLikeNode } from '../compiler/binder-utilities.js';
import { getJSDocSnippetCompletion } from './jsdoc-snippet.js';
import {
  declarationCount,
  getDeclarations,
  getSymbolId,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
  tryGetAmbientModuleNameFromSymbolName,
} from '../compiler/symbol.js';

/** Thrown where tsgo needs its auto-import registry. */
/** A completion request tsgo can't answer. */
export class CompletionsError {
  constructor(readonly message: string) {}
}

/** Thrown where tsgo needs its auto-import registry. */
export class NeedsAutoImports extends CompletionsError {
  constructor() {
    super('completion list needs auto imports');
  }
}

export interface CompletionEntry {
  name: string;
  kind: CompletionItemKind;
  sortText: string;
  insertText?: string;
  filterText?: string;
  detail?: string;
  labelDetails?: { detail?: string; description?: string };
  symbol?: Symbol;
}

export interface CompletionList {
  isIncomplete: boolean;
  entries: CompletionEntry[];
}

export const enum SortText {
  LocalDeclarationPriority = '10',
  LocationPriority = '11',
  OptionalMember = '12',
  MemberDeclaredBySpreadAssignment = '13',
  SuggestedClassMembers = '14',
  GlobalsOrKeywords = '15',
  AutoImportSuggestions = '16',
  ClassMemberSnippets = '17',
  JavascriptIdentifiers = '18',
}

function deprecateSortText(original: string): string {
  return 'z' + original;
}

export const enum CompletionKind {
  None,
  ObjectPropertyDeclaration,
  Global,
  PropertyAccess,
  MemberLike,
  String,
}

const enum KeywordCompletionFilters {
  None,
  All,
  ClassElementKeywords,
  InterfaceElementKeywords,
  ConstructorParameterKeywords,
  FunctionLikeBodyKeywords,
  TypeAssertionKeywords,
  TypeKeywords,
  TypeKeyword,
}

const enum SymbolOriginInfoKind {
  ThisType = 1 << 0,
  SymbolMember = 1 << 1,
  Promise = 1 << 2,
  Nullable = 1 << 3,
  TypeOnlyAlias = 1 << 4,
  ObjectLiteralMethod = 1 << 5,
  Ignore = 1 << 6,
  ComputedPropertyName = 1 << 7,
}

interface SymbolOriginInfo {
  kind: SymbolOriginInfoKind;
  /** For computed property names, the symbol's display name. */
  symbolName: string;
}

const enum GlobalsSearch {
  Continue,
  Success,
  Fail,
}

/** A literal value of a contextual type: a string, a number or a bigint's decimal text. */
interface LiteralValue {
  kind: 'string' | 'number' | 'bigint';
  text: string;
  number: number;
}

export interface CompletionData {
  symbols: Symbol[];
  completionKind: CompletionKind;
  propertyAccessToConvert: PropertyAccessExpression | undefined;
  isNewIdentifierLocation: boolean;
  location: Node;
  keywordFilters: KeywordCompletionFilters;
  literals: LiteralValue[];
  symbolToOriginInfoMap: Map<number, SymbolOriginInfo>;
  symbolToSortTextMap: Map<number, string>;
  previousToken: Node | undefined;
  contextToken: Node | undefined;
  isJsxInitializer: boolean;
  jsxInitializer: Node | undefined;
  insideJSDocTagTypeExpression: boolean;
  isTypeOnlyLocation: boolean;
  isJsxIdentifierExpected: boolean;
  isRightOfOpenTag: boolean;
  isRightOfDotOrQuestionDot: boolean;
  /** Whether auto-imports are prepared (completions take them from a registry). */
  autoImportsPrepared: boolean;
  onAutoImportsNeeded: () => void;
  /** The auto-imports offered, best fix first, and the view they came from. */
  autoImports: FixAndExport[];
  autoImportView: AutoImportView | undefined;
  importStatementCompletion: ImportStatementCompletionInfo | undefined;
}

export function newCompletionData(location: Node, contextToken: Node | undefined): CompletionData {
  return {
    symbols: [],
    completionKind: CompletionKind.None,
    propertyAccessToConvert: undefined,
    isNewIdentifierLocation: false,
    location,
    keywordFilters: KeywordCompletionFilters.None,
    literals: [],
    symbolToOriginInfoMap: new Map(),
    symbolToSortTextMap: new Map(),
    previousToken: undefined,
    contextToken,
    isJsxInitializer: false,
    jsxInitializer: undefined,
    insideJSDocTagTypeExpression: false,
    isTypeOnlyLocation: false,
    isJsxIdentifierExpected: false,
    isRightOfOpenTag: false,
    isRightOfDotOrQuestionDot: false,
    autoImportsPrepared: false,
    onAutoImportsNeeded: () => {},
    autoImports: [],
    autoImportView: undefined,
    importStatementCompletion: undefined,
  };
}

/**
 * The completions at `position` of `file`, or undefined where there are none. Auto-imports come from `autoImports`,
 * the program's prepared auto-import registry; without it, a completion list that needs them throws
 * `NeedsAutoImports`.
 */
export function getCompletionsAtPosition(
  c: Checker,
  program: Program,
  file: SourceFile,
  position: number,
  triggerCharacter: string | undefined,
  includeSymbols: boolean,
  autoImports: AutoImportRegistry | undefined,
  // Called when the list needs auto-imports, where tsc prepares them for the request.
  onAutoImportsNeeded: () => void = () => {},
): CompletionList | undefined {
  const previousToken = getRelevantTokens(position, file).previousToken;
  if (
    triggerCharacter !== undefined &&
    !isInString(file, position, previousToken) &&
    !isValidTrigger(file, triggerCharacter, previousToken, position)
  )
    return undefined;
  if (triggerCharacter === ' ') return { isIncomplete: true, entries: [] };
  const jsDocSnippet = getJSDocSnippetCompletion(file, position);
  if (jsDocSnippet !== undefined) return jsDocSnippet;
  const options = program.options;
  const stringCompletions = getStringLiteralCompletions(c, program, file, position, previousToken, includeSymbols);
  if (stringCompletions !== undefined) return stringCompletions;
  if (
    previousToken !== undefined &&
    (previousToken.kind === SyntaxKind.BreakKeyword ||
      previousToken.kind === SyntaxKind.ContinueKeyword ||
      previousToken.kind === SyntaxKind.Identifier) &&
    previousToken.parent !== undefined &&
    (previousToken.parent.kind === SyntaxKind.BreakStatement ||
      previousToken.parent.kind === SyntaxKind.ContinueStatement)
  )
    return getLabelCompletionsAtPosition(previousToken.parent, file, position);
  const result = getCompletionData(c, program, file, position, autoImports, onAutoImportsNeeded);
  if (result === undefined) return undefined;
  if (result instanceof KeywordCompletionData) return { isIncomplete: false, entries: result.entries };
  if (result instanceof JSDocTagNameCompletionData) {
    const entries = getJSDocTagNameCompletions();
    entries.push(...getJSDocParameterCompletions(c, file, position, true));
    return { isIncomplete: false, entries };
  }
  if (result instanceof JSDocTagCompletionData) {
    const entries = getJSDocTagCompletions();
    entries.push(...getJSDocParameterCompletions(c, file, position, false));
    return { isIncomplete: false, entries };
  }
  if (result instanceof JSDocParameterNameCompletionData)
    return { isIncomplete: false, entries: getJSDocParameterNameCompletions(result.tag) };
  return completionInfoFromData(c, options, file, result.data, position, includeSymbols);
}

class SymbolCompletionData {
  constructor(readonly data: CompletionData) {}
}

class KeywordCompletionData {
  constructor(readonly entries: CompletionEntry[]) {}
}

class JSDocTagNameCompletionData {}

class JSDocTagCompletionData {}

class JSDocParameterNameCompletionData {
  constructor(readonly tag: JSDocParameterOrPropertyTag) {}
}

type CompletionDataResult =
  | SymbolCompletionData
  | KeywordCompletionData
  | JSDocTagNameCompletionData
  | JSDocTagCompletionData
  | JSDocParameterNameCompletionData;

interface RelevantTokens {
  contextToken: Node | undefined;
  previousToken: Node | undefined;
}

/**
 * The token before `position` and the one completion depends on: in `x = 1 * o|`, `o` and `*`;
 * in `x = 1 * |`, `*` twice.
 */
export function getRelevantTokens(position: number, file: SourceFile): RelevantTokens {
  const previousToken = findPrecedingToken(file, position);
  if (
    previousToken !== undefined &&
    position <= previousToken.end &&
    (isMemberName(previousToken) || isKeyword(previousToken.kind))
  )
    return { contextToken: findPrecedingToken(file, previousToken.pos), previousToken };
  return { contextToken: previousToken, previousToken };
}

function isMemberName(node: Node): boolean {
  return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier;
}

function isValidTrigger(
  file: SourceFile,
  triggerCharacter: string,
  contextToken: Node | undefined,
  position: number,
): boolean {
  switch (triggerCharacter) {
    case '.':
    case '@':
      return true;
    case '"':
    case "'":
    case '`':
      // Only an opening quote.
      return (
        contextToken !== undefined &&
        isStringLiteralOrTemplate(contextToken) &&
        position === getStartOfNode(contextToken, file, false) + 1
      );
    case '#':
      return (
        contextToken !== undefined &&
        contextToken.kind === SyntaxKind.PrivateIdentifier &&
        findAncestor(contextToken.parent, isClassLike) !== undefined
      );
    case '<':
      return (
        contextToken !== undefined &&
        contextToken.kind === SyntaxKind.LessThanToken &&
        (!(contextToken.parent instanceof BinaryExpression) || binaryExpressionMayBeOpenTag(contextToken.parent))
      );
    case '/':
      if (contextToken === undefined) return false;
      if (isStringLiteralLike(contextToken)) return tryGetImportFromModuleSpecifier(contextToken) !== undefined;
      return (
        contextToken.kind === SyntaxKind.LessThanSlashToken &&
        contextToken.parent !== undefined &&
        contextToken.parent.kind === SyntaxKind.JsxClosingElement
      );
    case ' ':
      return (
        contextToken !== undefined &&
        contextToken.kind === SyntaxKind.ImportKeyword &&
        contextToken.parent !== undefined &&
        contextToken.parent.kind === SyntaxKind.SourceFile
      );
    case '*':
      return isPotentiallyValidJSDocSnippetCompletionPosition(file, position);
  }
  throw new Error('Unknown trigger character: ' + triggerCharacter);
}

import { isPotentiallyValidJSDocSnippetCompletionPosition } from './jsdoc-snippet.js';

function isStringLiteralOrTemplate(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.TaggedTemplateExpression:
      return true;
  }
  return false;
}

function binaryExpressionMayBeOpenTag(binary: BinaryExpression): boolean {
  return nodeIsMissing(binary.left);
}

/** The import or export declaration, require call or import type of a module specifier. */
export function tryGetImportFromModuleSpecifier(node: Node): Node | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (parent.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.JSDocImportTag:
      return parent;
    case SyntaxKind.ExternalModuleReference:
      return parent.parent;
    case SyntaxKind.CallExpression: {
      const call = parent as CallExpression;
      const callee = call.expression;
      if (
        callee.kind === SyntaxKind.ImportKeyword ||
        (callee instanceof Identifier && callee.text === 'require' && call.arguments.nodes.length === 1)
      )
        return parent;
      return undefined;
    }
    case SyntaxKind.LiteralType:
      if (node.kind !== SyntaxKind.StringLiteral) return undefined;
      return parent.parent !== undefined && parent.parent.kind === SyntaxKind.ImportType ? parent.parent : undefined;
  }
  return undefined;
}

export function isCheckedFile(file: SourceFile, options: CompilerOptions): boolean {
  return !isSourceFileJS(file) || isCheckJsEnabledForFile(file, options);
}

// ---- Completion data

function getCompletionData(
  c: Checker,
  program: Program,
  file: SourceFile,
  position: number,
  autoImports: AutoImportRegistry | undefined,
  onAutoImportsNeeded: () => void,
): CompletionDataResult | undefined {
  const options = program.options;
  const inCheckedFile = isCheckedFile(file, options);
  let currentToken = getTokenAtPosition(file, position)!;
  const insideComment = isInComment(file, position, currentToken);
  let insideJSDocTagTypeExpression = false;
  let insideJsDocImportTag = false;
  if (insideComment !== undefined) {
    if (hasDocComment(file, position)) {
      if (position > 0 && file.text.charCodeAt(position - 1) === 0x40) {
        // Right after `@`: every tag name.
        return new JSDocTagNameCompletionData();
      }
      // Without `@`, only `*`, whitespace and a few separators may precede the position on its line.
      const lineStart = getLineStartPositionForPosition(position, file);
      let noCommentPrefix = true;
      for (let i = lineStart; i < position; i += 1) {
        const ch = file.text.charCodeAt(i);
        if (
          !(isWhiteSpaceSingleLineChar(ch) || ch === 0x2a || ch === 0x2f || ch === 0x28 || ch === 0x29 || ch === 0x7c)
        ) {
          noCommentPrefix = false;
          break;
        }
      }
      if (noCommentPrefix) return new JSDocTagCompletionData();
    }
    // Completion works inside some JSDoc tags, like the braces of `@type {...}`.
    const tag = getJSDocTagAtPosition(currentToken, position);
    if (tag !== undefined) {
      const tagName = getTagName(tag)!;
      if (tagName.pos <= position && position <= tagName.end) return new JSDocTagNameCompletionData();
      if (tag.kind === SyntaxKind.JSDocImportTag) insideJsDocImportTag = true;
      else {
        const typeExpression = tryGetTypeExpressionFromTag(tag);
        if (typeExpression !== undefined) {
          currentToken = getTokenAtPosition(file, position)!;
          if (
            currentToken === undefined ||
            (!isDeclarationName(currentToken) &&
              (currentToken.parent!.kind !== SyntaxKind.JSDocPropertyTag ||
                getName(currentToken.parent!) !== currentToken))
          )
            insideJSDocTagTypeExpression = isCurrentlyEditingNode(typeExpression, file, position);
        }
        if (
          !insideJSDocTagTypeExpression &&
          tag instanceof JSDocParameterOrPropertyTag &&
          tag.kind === SyntaxKind.JSDocParameterTag &&
          (nodeIsMissing(tag.name) || (tag.name.pos <= position && position <= tag.name.end))
        )
          return new JSDocParameterNameCompletionData(tag);
      }
    }
    // Plain comment text has no completions.
    if (!insideJSDocTagTypeExpression && !insideJsDocImportTag) return undefined;
  }

  const isJSOnlyLocation = !insideJSDocTagTypeExpression && !insideJsDocImportTag && isSourceFileJS(file);
  const tokens = getRelevantTokens(position, file);
  let contextToken = tokens.contextToken;
  const previousToken = tokens.previousToken;

  let node: Node = currentToken;
  let propertyAccessToConvert: PropertyAccessExpression | undefined;
  let isRightOfDot = false;
  let isRightOfQuestionDot = false;
  let isRightOfOpenTag = false;
  let isStartingCloseTag = false;
  let isJsxInitializer = false;
  let jsxInitializer: Node | undefined;
  let isJsxIdentifierExpected = false;
  let location: Node = getTouchingPropertyName(file, position)!;
  let keywordFilters = KeywordCompletionFilters.None;
  let isNewIdentifierLocation = false;
  let hasImportStatementCompletion = false;
  let importStatementCompletionInfo: ImportStatementCompletionInfo | undefined;

  if (contextToken !== undefined) {
    const importStatementCompletion = getImportStatementCompletionInfo(contextToken, file);
    if (importStatementCompletion.keywordCompletion !== SyntaxKind.Unknown) {
      if (importStatementCompletion.isKeywordOnlyCompletion)
        return new KeywordCompletionData([
          {
            name: tokenToString(importStatementCompletion.keywordCompletion),
            kind: CompletionItemKind.Keyword,
            sortText: SortText.GlobalsOrKeywords,
          },
        ]);
      // Only `type` maps to a keyword filter.
      keywordFilters = KeywordCompletionFilters.TypeKeyword;
    }
    // Import statement completions are on by default; they offer auto imports.
    if (importStatementCompletion.hasReplacementSpan) {
      hasImportStatementCompletion = true;
      importStatementCompletionInfo = importStatementCompletion;
      isNewIdentifierLocation = importStatementCompletion.isNewIdentifierLocation;
    }
    if (
      !importStatementCompletion.hasReplacementSpan &&
      isCompletionListBlocker(c, contextToken, previousToken!, location, file, position)
    ) {
      if (keywordFilters !== KeywordCompletionFilters.None)
        return keywordCompletionData(keywordFilters, isJSOnlyLocation);
      return undefined;
    }
    let parent = contextToken.parent!;
    if (contextToken.kind === SyntaxKind.DotToken || contextToken.kind === SyntaxKind.QuestionDotToken) {
      isRightOfDot = contextToken.kind === SyntaxKind.DotToken;
      isRightOfQuestionDot = contextToken.kind === SyntaxKind.QuestionDotToken;
      switch (parent.kind) {
        case SyntaxKind.PropertyAccessExpression: {
          propertyAccessToConvert = parent as PropertyAccessExpression;
          node = propertyAccessToConvert.expression;
          const leftmostAccessExpression = getLeftmostAccessExpression(parent);
          if (
            nodeIsMissing(leftmostAccessExpression) ||
            ((node.kind === SyntaxKind.CallExpression || isFunctionLike(node)) &&
              node.end === contextToken.pos &&
              getLastChild(node, file)?.kind !== SyntaxKind.CloseParenToken)
          )
            // Likely a dot of a spread being typed: `Math.min(./**/)`.
            return undefined;
          break;
        }
        case SyntaxKind.QualifiedName:
          node = (parent as QualifiedName).left;
          break;
        case SyntaxKind.ModuleDeclaration:
          node = getName(parent)!;
          break;
        case SyntaxKind.ImportType:
          node = parent;
          break;
        case SyntaxKind.MetaProperty: {
          const first = getFirstToken(parent, file)!;
          if (first.kind !== SyntaxKind.ImportKeyword && first.kind !== SyntaxKind.NewKeyword)
            throw new Error('Unexpected token kind: ' + first.kind);
          node = first;
          break;
        }
        default:
          // Nothing precedes the dot.
          return undefined;
      }
    } else if (!hasImportStatementCompletion) {
      // `<UI.Test /* completion position */ />`: walk up the tag name's property accesses.
      if (parent.kind === SyntaxKind.PropertyAccessExpression) {
        contextToken = parent;
        parent = parent.parent!;
      }
      if (parent === location) {
        switch (currentToken.kind) {
          case SyntaxKind.GreaterThanToken:
            if (parent.kind === SyntaxKind.JsxElement || parent.kind === SyntaxKind.JsxOpeningElement)
              location = currentToken;
            break;
          case SyntaxKind.LessThanSlashToken:
            if (parent.kind === SyntaxKind.JsxSelfClosingElement) location = currentToken;
            break;
        }
      }
      switch (parent.kind) {
        case SyntaxKind.JsxClosingElement:
          if (contextToken.kind === SyntaxKind.LessThanSlashToken) {
            isStartingCloseTag = true;
            location = contextToken;
          }
          break;
        case SyntaxKind.BinaryExpression:
          if (!binaryExpressionMayBeOpenTag(parent as BinaryExpression)) break;
          isJsxIdentifierExpected = true;
          if (contextToken.kind === SyntaxKind.LessThanToken) {
            isRightOfOpenTag = true;
            location = contextToken;
          }
          break;
        case SyntaxKind.JsxSelfClosingElement:
        case SyntaxKind.JsxElement:
        case SyntaxKind.JsxOpeningElement:
          isJsxIdentifierExpected = true;
          if (contextToken.kind === SyntaxKind.LessThanToken) {
            isRightOfOpenTag = true;
            location = contextToken;
          }
          break;
        case SyntaxKind.JsxExpression:
        case SyntaxKind.JsxSpreadAttribute:
          // `<div foo={true} [||] />` and `<div foo={true} t[||] ></div>`.
          if (
            previousToken!.kind === SyntaxKind.CloseBraceToken ||
            (previousToken!.kind === SyntaxKind.Identifier && previousToken!.parent!.kind === SyntaxKind.JsxAttribute)
          )
            isJsxIdentifierExpected = true;
          break;
        case SyntaxKind.JsxAttribute: {
          const attribute = parent as JsxAttribute;
          // `<div className="x" [||] ></div>`
          if (attribute.initializer === previousToken && previousToken!.end < position) isJsxIdentifierExpected = true;
          else if (previousToken!.kind === SyntaxKind.EqualsToken) isJsxInitializer = true;
          else if (previousToken!.kind === SyntaxKind.Identifier) {
            isJsxIdentifierExpected = true;
            // `<div x=[|f/**/|]`; `<div someBool f>` names an attribute.
            if (
              parent !== previousToken!.parent &&
              attribute.initializer === undefined &&
              findChildOfKind(parent, SyntaxKind.EqualsToken, file) !== undefined
            )
              jsxInitializer = previousToken;
          }
          break;
        }
      }
    }
  }

  const data = newCompletionData(location, contextToken);
  data.previousToken = previousToken;
  data.propertyAccessToConvert = propertyAccessToConvert;
  data.isJsxInitializer = isJsxInitializer || jsxInitializer !== undefined;
  data.jsxInitializer = jsxInitializer;
  data.insideJSDocTagTypeExpression = insideJSDocTagTypeExpression;
  data.isJsxIdentifierExpected = isJsxIdentifierExpected;
  data.isRightOfOpenTag = isRightOfOpenTag;
  data.isRightOfDotOrQuestionDot = isRightOfDot || isRightOfQuestionDot;
  data.isTypeOnlyLocation =
    insideJSDocTagTypeExpression ||
    insideJsDocImportTag ||
    (hasImportStatementCompletion &&
      location.parent !== undefined &&
      isTypeOnlyImportOrExportDeclaration(location.parent)) ||
    (!isContextTokenValueLocation(contextToken) &&
      (isPossiblyTypeArgumentPosition(c, contextToken, file) ||
        isPartOfTypeNode(location) ||
        isContextTokenTypeLocation(contextToken)));
  data.keywordFilters = keywordFilters;
  data.isNewIdentifierLocation = isNewIdentifierLocation;
  data.importStatementCompletion = importStatementCompletionInfo;
  data.autoImportsPrepared = autoImports !== undefined;
  data.onAutoImportsNeeded = onAutoImportsNeeded;

  const search = new SymbolSearch(c, program, file, position, data, node, inCheckedFile, autoImports);
  search.isRightOfDot = isRightOfDot;
  search.isRightOfQuestionDot = isRightOfQuestionDot;
  search.hasImportStatementCompletion = hasImportStatementCompletion;
  if (isRightOfDot || isRightOfQuestionDot) search.getTypeScriptMemberSymbols();
  else if (isRightOfOpenTag) {
    // JSX tag names: the intrinsic elements whose names are tag names, then the global completions.
    data.symbols = getPropertiesOfType(c, getJsxType(c, 'IntrinsicElements', location)).filter((symbol) =>
      isJsxTagNameText(symbolName(symbol)),
    );
    search.tryGetGlobalSymbols();
    data.completionKind = CompletionKind.Global;
    data.keywordFilters = KeywordCompletionFilters.None;
  } else if (isStartingCloseTag) {
    const element = contextToken!.parent!.parent as JsxElement;
    const tagSymbol = getSymbolAtLocation(c, element.openingElement.tagName);
    if (tagSymbol !== undefined) data.symbols = [tagSymbol];
    data.completionKind = CompletionKind.Global;
    data.keywordFilters = KeywordCompletionFilters.None;
  } else if (!search.tryGetGlobalSymbols()) {
    if (data.keywordFilters !== KeywordCompletionFilters.None)
      return keywordCompletionData(data.keywordFilters, isJSOnlyLocation);
    return undefined;
  }

  let contextualTypeOrConstraint: Type | undefined;
  if (previousToken !== undefined)
    contextualTypeOrConstraint =
      getContextualTypeForCompletions(c, previousToken, position, file) ??
      getConstraintOfTypeArgumentProperty(c, previousToken);
  // Literals aren't suggested after a string literal or in JSX tags.
  const isLiteralExpected =
    !(previousToken !== undefined && isStringLiteralLike(previousToken)) && !isJsxIdentifierExpected;
  if (isLiteralExpected && contextualTypeOrConstraint !== undefined) {
    const types =
      (contextualTypeOrConstraint.flags & TypeFlags.Union) !== 0
        ? typesOf(contextualTypeOrConstraint)
        : [contextualTypeOrConstraint];
    for (const t of types) {
      if (isLiteral(t) && (t.flags & TypeFlags.EnumLiteral) === 0) data.literals.push(literalValueOf(t));
    }
  }
  return new SymbolCompletionData(data);
}

function isWhiteSpaceSingleLineChar(ch: number): boolean {
  return (
    ch === 0x20 ||
    ch === 0x09 ||
    ch === 0x0b ||
    ch === 0x0c ||
    ch === 0xa0 ||
    ch === 0x85 ||
    ch === 0x1680 ||
    (ch >= 0x2000 && ch <= 0x200b) ||
    ch === 0x202f ||
    ch === 0x205f ||
    ch === 0x3000 ||
    ch === 0xfeff
  );
}

function keywordCompletionData(
  filters: KeywordCompletionFilters,
  filterOutTsOnlyKeywords: boolean,
): KeywordCompletionData {
  return new KeywordCompletionData(getKeywordCompletions(filters, filterOutTsOnlyKeywords));
}

function getLeftmostAccessExpression(expr: Node): Node {
  let e = expr;
  while (
    e.kind === SyntaxKind.PropertyAccessExpression ||
    e.kind === SyntaxKind.ElementAccessExpression ||
    e.kind === SyntaxKind.CallExpression ||
    e.kind === SyntaxKind.NewExpression ||
    e.kind === SyntaxKind.NonNullExpression ||
    e.kind === SyntaxKind.TaggedTemplateExpression
  ) {
    const next = e instanceof TaggedTemplateExpression ? e.tag : getExpression(e);
    if (next === undefined) break;
    e = next;
  }
  return e;
}

function isLiteral(t: Type): boolean {
  return (t.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral | TypeFlags.BigIntLiteral)) !== 0;
}

function literalValueOf(t: Type): LiteralValue {
  const literal = t as LiteralType;
  if ((t.flags & TypeFlags.StringLiteral) !== 0) return { kind: 'string', text: literal.stringValue, number: 0 };
  if ((t.flags & TypeFlags.NumberLiteral) !== 0) return { kind: 'number', text: '', number: literal.numberValue };
  return { kind: 'bigint', text: literal.stringValue, number: 0 };
}

function hasDocComment(file: SourceFile, position: number): boolean {
  const token = getTokenAtPosition(file, position);
  return findAncestor(token, (n) => n.kind === SyntaxKind.JSDoc) !== undefined;
}

function isJSDocTagKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstJSDocTagNode && kind <= SyntaxKind.LastJSDocTagNode;
}

function getJSDocTagAtPosition(node: Node, position: number): Node | undefined {
  return findAncestorOrQuit(node, (n) => {
    if (isJSDocTagKind(n.kind) && n.pos <= position && position <= n.end) return FindAncestorResult.True;
    if (n.kind === SyntaxKind.JSDoc) return FindAncestorResult.Quit;
    return FindAncestorResult.False;
  });
}

function isTagWithTypeExpression(tag: Node): boolean {
  switch (tag.kind) {
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
    case SyntaxKind.JSDocReturnTag:
    case SyntaxKind.JSDocTypeTag:
    case SyntaxKind.JSDocTypedefTag:
    case SyntaxKind.JSDocThrowsTag:
    case SyntaxKind.JSDocSatisfiesTag:
      return true;
    case SyntaxKind.JSDocTemplateTag:
      return tag instanceof JSDocTemplateTag && tag.constraint !== undefined;
  }
  return false;
}

function tryGetTypeExpressionFromTag(tag: Node): Node | undefined {
  if (isTagWithTypeExpression(tag)) {
    const typeExpression = tag instanceof JSDocTemplateTag ? tag.constraint : getTypeExpression(tag);
    if (typeExpression !== undefined && typeExpression.kind === SyntaxKind.JSDocTypeExpression) return typeExpression;
  }
  if (tag.kind === SyntaxKind.JSDocAugmentsTag || tag.kind === SyntaxKind.JSDocImplementsTag)
    return tag instanceof JSDocAugmentsTag
      ? tag.className
      : tag instanceof JSDocImplementsTag
        ? tag.className
        : undefined;
  return undefined;
}

export function isCurrentlyEditingNode(node: Node, file: SourceFile, position: number): boolean {
  const start = getStartOfNode(node, file, false);
  return start <= position && position <= node.end;
}

function isContextTokenValueLocation(contextToken: Node | undefined): boolean {
  if (contextToken === undefined) return false;
  const parent = contextToken.parent!;
  return (
    (contextToken.kind === SyntaxKind.TypeOfKeyword &&
      (parent.kind === SyntaxKind.TypeQuery || parent.kind === SyntaxKind.TypeOfExpression)) ||
    (contextToken.kind === SyntaxKind.AssertsKeyword && parent.kind === SyntaxKind.TypePredicate)
  );
}

function isContextTokenTypeLocation(contextToken: Node | undefined): boolean {
  if (contextToken === undefined) return false;
  const parentKind = contextToken.parent!.kind;
  switch (contextToken.kind) {
    case SyntaxKind.ColonToken:
      return (
        parentKind === SyntaxKind.PropertyDeclaration ||
        parentKind === SyntaxKind.PropertySignature ||
        parentKind === SyntaxKind.Parameter ||
        parentKind === SyntaxKind.VariableDeclaration ||
        isFunctionLikeKind(parentKind)
      );
    case SyntaxKind.EqualsToken:
      return parentKind === SyntaxKind.TypeAliasDeclaration || parentKind === SyntaxKind.TypeParameter;
    case SyntaxKind.AsKeyword:
      return parentKind === SyntaxKind.AsExpression;
    case SyntaxKind.LessThanToken:
      return parentKind === SyntaxKind.TypeReference || parentKind === SyntaxKind.TypeAssertionExpression;
    case SyntaxKind.ExtendsKeyword:
      return parentKind === SyntaxKind.TypeParameter;
    case SyntaxKind.SatisfiesKeyword:
      return parentKind === SyntaxKind.SatisfiesExpression;
    case SyntaxKind.OpenBracketToken:
    case SyntaxKind.CommaToken:
      return parentKind === SyntaxKind.TupleType;
  }
  return false;
}

import { isFunctionLikeKind } from '../compiler/ast-utilities.js';

// ---- Symbols for each kind of location

class SymbolSearch {
  isRightOfDot = false;
  isRightOfQuestionDot = false;
  hasImportStatementCompletion = false;
  private readonly seenPropertySymbols = new Set<number>();

  readonly options: CompilerOptions;

  constructor(
    readonly c: Checker,
    readonly program: Program,
    readonly file: SourceFile,
    readonly position: number,
    readonly data: CompletionData,
    readonly node: Node,
    readonly inCheckedFile: boolean,
    readonly autoImports: AutoImportRegistry | undefined,
  ) {
    this.options = program.options;
  }

  private addSymbolOriginInfo(symbol: Symbol, insertQuestionDot: boolean, insertAwait: boolean): void {
    const index = this.data.symbols.length - 1;
    if (insertAwait && !this.seenPropertySymbols.has(getSymbolId(symbol))) {
      this.seenPropertySymbols.add(getSymbolId(symbol));
      this.data.symbolToOriginInfoMap.set(index, {
        kind: nullableOriginKind(SymbolOriginInfoKind.Promise, insertQuestionDot),
        symbolName: '',
      });
    } else if (insertQuestionDot)
      this.data.symbolToOriginInfoMap.set(index, { kind: SymbolOriginInfoKind.Nullable, symbolName: '' });
  }

  private addSymbolSortInfo(symbol: Symbol): void {
    if (isStaticProperty(symbol))
      this.data.symbolToSortTextMap.set(getSymbolId(symbol), SortText.LocalDeclarationPriority);
  }

  private addPropertySymbol(symbol: Symbol, insertAwait: boolean, insertQuestionDot: boolean): void {
    const c = this.c;
    const data = this.data;
    // For a computed property like `[Symbol.iterator]`, complete `Symbol` instead.
    let computedPropertyName: Node | undefined;
    for (const declaration of getDeclarations(symbol)) {
      const name = getNameOfDeclarationForCompletions(declaration);
      if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) {
        computedPropertyName = name;
        break;
      }
    }
    if (computedPropertyName === undefined) {
      data.symbols.push(symbol);
      this.addSymbolOriginInfo(symbol, insertQuestionDot, insertAwait);
      this.addSymbolSortInfo(symbol);
      return;
    }
    const leftMostName = getLeftMostName(getExpression(computedPropertyName)!);
    const nameSymbol = leftMostName !== undefined ? getSymbolAtLocation(c, leftMostName) : undefined;
    // In `namespace N { export const sym = Symbol(); }`, the completion is `N`.
    const firstAccessibleSymbol =
      nameSymbol !== undefined ? getFirstSymbolInChain(c, nameSymbol, data.contextToken) : undefined;
    const firstAccessibleSymbolId = firstAccessibleSymbol !== undefined ? getSymbolId(firstAccessibleSymbol) : 0;
    if (firstAccessibleSymbolId !== 0 && !this.seenPropertySymbols.has(firstAccessibleSymbolId)) {
      this.seenPropertySymbols.add(firstAccessibleSymbolId);
      data.symbols.push(firstAccessibleSymbol!);
      data.symbolToSortTextMap.set(firstAccessibleSymbolId, SortText.GlobalsOrKeywords);
      const moduleSymbol = firstAccessibleSymbol!.parent;
      if (
        moduleSymbol === undefined ||
        !isExternalModuleSymbol(moduleSymbol) ||
        tryGetMemberInModuleExportsAndProperties(c, firstAccessibleSymbol!.name, moduleSymbol) !== firstAccessibleSymbol
      )
        data.symbolToOriginInfoMap.set(data.symbols.length - 1, {
          kind: nullableOriginKind(SymbolOriginInfoKind.SymbolMember, insertQuestionDot),
          symbolName: '',
        });
    } else if (firstAccessibleSymbolId === 0 || !this.seenPropertySymbols.has(firstAccessibleSymbolId)) {
      data.symbols.push(symbol);
      this.addSymbolOriginInfo(symbol, insertQuestionDot, insertAwait);
      this.addSymbolSortInfo(symbol);
    }
  }

  private addTypeProperties(t: Type, insertAwait: boolean, insertQuestionDot: boolean): void {
    const c = this.c;
    const data = this.data;
    if (getStringIndexType(c, t) !== undefined) data.isNewIdentifierLocation = true;
    if (this.isRightOfQuestionDot && getCallSignatures(c, t).length !== 0) data.isNewIdentifierLocation = true;
    const propertyAccess = this.node.kind === SyntaxKind.ImportType ? this.node : this.node.parent!;
    if (this.inCheckedFile) {
      for (const symbol of getApparentProperties(c, t))
        if (isValidPropertyAccessForCompletions(c, propertyAccess, t, symbol))
          this.addPropertySymbol(symbol, false, insertQuestionDot);
    } else {
      // In JavaScript, every member of each constituent of a union is offered.
      for (const symbol of getPropertiesForCompletion(c, t))
        if (isValidPropertyAccessForCompletions(c, propertyAccess, t, symbol)) data.symbols.push(symbol);
    }
    if (insertAwait) {
      const promiseType = getPromisedTypeOfPromise(c, t);
      if (promiseType !== undefined)
        for (const symbol of getApparentProperties(c, promiseType))
          if (isValidPropertyAccessForCompletions(c, propertyAccess, promiseType, symbol))
            this.addPropertySymbol(symbol, true, insertQuestionDot);
    }
  }

  getTypeScriptMemberSymbols(): void {
    const c = this.c;
    const data = this.data;
    const node = this.node;
    data.completionKind = CompletionKind.PropertyAccess;
    // A qualified name is a type location.
    const isImportType = isLiteralImportTypeNode(node);
    const isTypeLocation =
      (isImportType && !(node as ImportTypeNode).isTypeOf) ||
      isPartOfTypeNode(node.parent!) ||
      isPossiblyTypeArgumentPosition(c, data.contextToken, this.file);
    const isRhsOfImportDeclaration = isInRightSideOfInternalImportEqualsDeclaration(node);
    if (isEntityName(node) || isImportType || node.kind === SyntaxKind.PropertyAccessExpression) {
      const isNamespaceName = node.parent!.kind === SyntaxKind.ModuleDeclaration;
      if (isNamespaceName) data.isNewIdentifierLocation = true;
      let symbol = getSymbolAtLocation(c, node);
      if (symbol !== undefined) {
        symbol = skipAlias(c, symbol);
        if ((symbol.flags & (SymbolFlags.Module | SymbolFlags.Enum)) !== 0) {
          const valueAccessNode = isImportType ? node : node.parent!;
          for (const exportedSymbol of getExportsOfModuleAsArray(c, symbol)) {
            let isValidAccess: boolean;
            if (isNamespaceName)
              // At `namespace N.M/**/`, `M` isn't offered if this is its only declaration.
              isValidAccess =
                (exportedSymbol.flags & SymbolFlags.Namespace) !== 0 &&
                !getDeclarations(exportedSymbol).every((d) => d.parent === node.parent);
            else if (isRhsOfImportDeclaration)
              isValidAccess =
                symbolCanBeReferencedAtTypeLocation(c, exportedSymbol, new Set()) ||
                isValidPropertyAccess(c, valueAccessNode, exportedSymbol.name);
            else if (isTypeLocation || data.insideJSDocTagTypeExpression)
              isValidAccess = symbolCanBeReferencedAtTypeLocation(c, exportedSymbol, new Set());
            else isValidAccess = isValidPropertyAccess(c, valueAccessNode, exportedSymbol.name);
            if (isValidAccess) data.symbols.push(exportedSymbol);
          }
          // A module merged with a value: add the value's properties, e.g. inherited static methods.
          if (
            !isTypeLocation &&
            !data.insideJSDocTagTypeExpression &&
            getDeclarations(symbol).some(
              (d) =>
                d.kind !== SyntaxKind.SourceFile &&
                d.kind !== SyntaxKind.ModuleDeclaration &&
                d.kind !== SyntaxKind.EnumDeclaration,
            )
          ) {
            let t = getNonOptionalType(c, getTypeOfSymbolAtLocation(c, symbol, node));
            let insertQuestionDot = false;
            if (isNullableType(c, t)) {
              const canCorrectToQuestionDot = this.isRightOfDot && !this.isRightOfQuestionDot;
              if (canCorrectToQuestionDot || this.isRightOfQuestionDot) {
                t = getNonNullableType(c, t);
                if (canCorrectToQuestionDot) insertQuestionDot = true;
              }
            }
            this.addTypeProperties(t, (node.flags & NodeFlags.AwaitContext) !== 0, insertQuestionDot);
          }
          return;
        }
      }
    }
    if (!isTypeLocation || isInTypeQuery(node)) {
      let t = getNonOptionalType(c, getTypeAtLocation(c, node));
      if (!isTypeLocation) {
        let insertQuestionDot = false;
        if (isNullableType(c, t)) {
          const canCorrectToQuestionDot = this.isRightOfDot && !this.isRightOfQuestionDot;
          if (canCorrectToQuestionDot || this.isRightOfQuestionDot) {
            t = getNonNullableType(c, t);
            if (canCorrectToQuestionDot) insertQuestionDot = true;
          }
        }
        this.addTypeProperties(t, (node.flags & NodeFlags.AwaitContext) !== 0, insertQuestionDot);
      } else this.addTypeProperties(getNonNullableType(c, t), false, false);
    }
  }

  /** Runs the global symbol searches in order; false when completion should stop. */
  tryGetGlobalSymbols(): boolean {
    let result = this.tryGetObjectTypeLiteralInTypeArgumentCompletionSymbols();
    if (result === GlobalsSearch.Continue) result = this.tryGetObjectLikeCompletionSymbols();
    if (result === GlobalsSearch.Continue && this.hasImportStatementCompletion)
      result = this.tryGetImportCompletionSymbols();
    if (result === GlobalsSearch.Continue) result = this.tryGetImportOrExportClauseCompletionSymbols();
    if (result === GlobalsSearch.Continue) result = this.tryGetImportAttributesCompletionSymbols();
    if (result === GlobalsSearch.Continue) result = this.tryGetLocalNamedExportCompletionSymbols();
    if (result === GlobalsSearch.Continue) result = this.tryGetConstructorCompletion();
    if (result === GlobalsSearch.Continue) result = this.tryGetClassLikeCompletionSymbols();
    if (result === GlobalsSearch.Continue) result = this.tryGetJsxCompletionSymbols();
    if (result === GlobalsSearch.Continue) result = this.getGlobalCompletions();
    return result === GlobalsSearch.Success;
  }

  /** At an import statement being typed, the auto-imports it can complete to. */
  private tryGetImportCompletionSymbols(): GlobalsSearch {
    this.data.isNewIdentifierLocation = true;
    this.collectAutoImports();
    return GlobalsSearch.Success;
  }

  /** Every symbol in scope, the members of `this`, and the auto-imports. */
  private getGlobalCompletions(): GlobalsSearch {
    const c = this.c;
    const data = this.data;
    const contextToken = data.contextToken;
    const previousToken = data.previousToken;
    data.keywordFilters =
      tryGetFunctionLikeBodyCompletionContainer(contextToken) !== undefined
        ? KeywordCompletionFilters.FunctionLikeBodyKeywords
        : KeywordCompletionFilters.All;
    data.completionKind = CompletionKind.Global;
    data.isNewIdentifierLocation = computeIsNewIdentifierLocation(contextToken);
    // At the end of an identifier, the scope is the identifier's: `xyz => x|` completes as `xyz => |x`.
    const adjustedPosition =
      previousToken !== contextToken ? getStartOfNode(previousToken!, this.file, false) : this.position;
    const scopeNode = getScopeNode(contextToken, adjustedPosition, this.file) ?? this.file;
    const symbolMeanings =
      (data.isTypeOnlyLocation ? SymbolFlags.None : SymbolFlags.Value) |
      SymbolFlags.Type |
      SymbolFlags.Namespace |
      SymbolFlags.Alias;
    const typeOnlyAliasNeedsPromotion = previousToken !== undefined && !isValidTypeOnlyAliasUseSite(previousToken);
    const inScope = getSymbolsInScope(c, scopeNode, symbolMeanings);
    const start = data.symbols.length;
    data.symbols.push(...inScope);
    for (let i = 0; i < inScope.length; i++) {
      const symbol = inScope[i]!;
      if (!isArgumentsSymbol(c, symbol) && !getDeclarations(symbol).some((d) => getSourceFileOfNode(d) === this.file))
        data.symbolToSortTextMap.set(getSymbolId(symbol), SortText.GlobalsOrKeywords);
      if (typeOnlyAliasNeedsPromotion && (symbol.flags & SymbolFlags.Value) === 0) {
        if (getDeclarations(symbol).some(isTypeOnlyImportDeclaration))
          data.symbolToOriginInfoMap.set(start + i, { kind: SymbolOriginInfoKind.TypeOnlyAlias, symbolName: '' });
      }
    }
    // The properties of `this`, which need `this.`.
    if (scopeNode.kind !== SyntaxKind.SourceFile) {
      const thisType = tryGetThisTypeAtEx(
        c,
        scopeNode,
        false,
        scopeNode.parent !== undefined && isClassLikeNode(scopeNode.parent) ? scopeNode : undefined,
      );
      if (thisType !== undefined && !isProbablyGlobalType(c, thisType, this.file)) {
        for (const symbol of getPropertiesForCompletion(c, thisType)) {
          data.symbols.push(symbol);
          data.symbolToOriginInfoMap.set(data.symbols.length - 1, {
            kind: SymbolOriginInfoKind.ThisType,
            symbolName: '',
          });
          data.symbolToSortTextMap.set(getSymbolId(symbol), SortText.SuggestedClassMembers);
        }
      }
    }
    this.collectAutoImports();
    if (data.isTypeOnlyLocation) {
      data.keywordFilters =
        contextToken !== undefined && isAssertionExpression(contextToken.parent!)
          ? KeywordCompletionFilters.TypeAssertionKeywords
          : KeywordCompletionFilters.TypeKeywords;
    }
    return GlobalsSearch.Success;
  }

  /** The auto-imports matching the identifier being typed, from the prepared registry. */
  private collectAutoImports(): void {
    const data = this.data;
    const previousToken = data.previousToken;
    // At `import { type |`, the token text is blank.
    let lowerCaseTokenText = '';
    if (previousToken !== undefined && previousToken instanceof Identifier) {
      if (!(previousToken === data.contextToken && data.importStatementCompletion !== undefined))
        lowerCaseTokenText = previousToken.text.toLowerCase();
    }
    this.data.onAutoImportsNeeded();
    if (this.autoImports === undefined) throw new NeedsAutoImports();
    const view = new AutoImportView(
      this.autoImports,
      this.autoImports.packagesFor(this.file),
      this.file,
      this.program,
      this.c,
      new ModuleSpecifierPreferences('', ''),
    );
    data.autoImports = view.getCompletions(lowerCaseTokenText, data.isRightOfOpenTag, data.isTypeOnlyLocation);
    data.autoImportView = view;
  }

  private tryGetObjectTypeLiteralInTypeArgumentCompletionSymbols(): GlobalsSearch {
    const c = this.c;
    const data = this.data;
    const typeLiteralNode = tryGetTypeLiteralNode(data.contextToken);
    if (typeLiteralNode === undefined) return GlobalsSearch.Continue;
    const containerTypeNode =
      typeLiteralNode.parent!.kind === SyntaxKind.IntersectionType ? typeLiteralNode.parent! : typeLiteralNode;
    const containerExpectedType = getConstraintOfTypeArgumentProperty(c, containerTypeNode);
    if (containerExpectedType === undefined) return GlobalsSearch.Continue;
    const containerActualType = getTypeFromTypeNode(c, containerTypeNode);
    const members = getPropertiesForCompletion(c, containerExpectedType);
    const existingMemberNames = new Set<string>();
    for (const member of getPropertiesForCompletion(c, containerActualType)) existingMemberNames.add(member.name);
    for (const member of members) if (!existingMemberNames.has(member.name)) data.symbols.push(member);
    data.completionKind = CompletionKind.ObjectPropertyDeclaration;
    data.isNewIdentifierLocation = true;
    return GlobalsSearch.Success;
  }

  private tryGetObjectLikeCompletionSymbols(): GlobalsSearch {
    const c = this.c;
    const data = this.data;
    const contextToken = data.contextToken;
    if (contextToken !== undefined && contextToken.kind === SyntaxKind.DotDotDotToken) return GlobalsSearch.Continue;
    const objectLikeContainer = tryGetObjectLikeCompletionContainer(contextToken, this.position, this.file);
    if (objectLikeContainer === undefined) return GlobalsSearch.Continue;
    data.completionKind = CompletionKind.ObjectPropertyDeclaration;
    let typeMembers: Symbol[] = [];
    let existingMembers: Node[] = [];
    if (objectLikeContainer.kind === SyntaxKind.ObjectLiteralExpression) {
      const instantiatedType = tryGetObjectLiteralContextualType(c, objectLikeContainer);
      // Shorthand property values.
      if (instantiatedType === undefined) {
        if ((objectLikeContainer.flags & NodeFlags.InWithStatement) !== 0) return GlobalsSearch.Fail;
        return GlobalsSearch.Continue;
      }
      const completionsType = getContextualTypeWithFlags(c, objectLikeContainer, ContextFlags.Completions);
      const t = completionsType ?? instantiatedType;
      const stringIndexType = getStringIndexType(c, t);
      const numberIndexType = getNumberIndexType(c, t);
      data.isNewIdentifierLocation = stringIndexType !== undefined || numberIndexType !== undefined;
      typeMembers = getPropertiesForObjectExpression(c, instantiatedType, completionsType, objectLikeContainer);
      existingMembers = getProperties(objectLikeContainer)!.nodes;
      // An empty member list continues, unless there's a number index type.
      if (typeMembers.length === 0 && numberIndexType === undefined) return GlobalsSearch.Continue;
    } else {
      // Only properties of the destructured type are completed.
      data.isNewIdentifierLocation = false;
      const rootDeclaration = getRootDeclaration(objectLikeContainer.parent!);
      // The type of the pattern's shape doesn't count; only declared or inferred types.
      let canGetType =
        getInitializer(rootDeclaration) !== undefined ||
        getType(rootDeclaration) !== undefined ||
        rootDeclaration.parent!.parent!.kind === SyntaxKind.ForOfStatement;
      if (!canGetType && rootDeclaration.kind === SyntaxKind.Parameter) {
        const func = rootDeclaration.parent!;
        if (isExpressionKind(func.kind))
          canGetType = getContextualTypeWithFlags(c, func, ContextFlags.None) !== undefined;
        else if (func.kind === SyntaxKind.MethodDeclaration || func.kind === SyntaxKind.SetAccessor)
          canGetType =
            isExpressionKind(func.parent!.kind) &&
            getContextualTypeWithFlags(c, func.parent!, ContextFlags.None) !== undefined;
      }
      if (canGetType) {
        const typeForObject = getTypeAtLocation(c, objectLikeContainer);
        typeMembers = getPropertiesOfType(c, typeForObject).filter((p) =>
          isPropertyAccessible(c, objectLikeContainer, false, false, typeForObject, p),
        );
        existingMembers = getElements(objectLikeContainer)!.nodes;
      }
    }
    if (typeMembers.length > 0) {
      const filtered = filterObjectMembersList(c, typeMembers, existingMembers, this.file, this.position);
      data.symbols.push(...filtered.members);
      for (const member of filtered.members) {
        const id = getSymbolId(member);
        if (filtered.spreadMemberNames.has(member.name))
          data.symbolToSortTextMap.set(id, SortText.MemberDeclaredBySpreadAssignment);
        if ((member.flags & SymbolFlags.Optional) !== 0 && !data.symbolToSortTextMap.has(id))
          data.symbolToSortTextMap.set(id, SortText.OptionalMember);
      }
    }
    return GlobalsSearch.Success;
  }

  private tryGetImportOrExportClauseCompletionSymbols(): GlobalsSearch {
    const c = this.c;
    const data = this.data;
    const contextToken = data.contextToken;
    if (contextToken === undefined) return GlobalsSearch.Continue;
    // `import { |`, `import { a as 0, | }`, `import { type | }`
    let namedImportsOrExports: Node | undefined;
    if (contextToken.kind === SyntaxKind.OpenBraceToken || contextToken.kind === SyntaxKind.CommaToken)
      namedImportsOrExports = isNamedImportsOrExports(contextToken.parent!) ? contextToken.parent : undefined;
    else if (isTypeKeywordTokenOrIdentifier(contextToken))
      namedImportsOrExports = isNamedImportsOrExports(contextToken.parent!.parent!)
        ? contextToken.parent!.parent
        : undefined;
    if (namedImportsOrExports === undefined) return GlobalsSearch.Continue;
    // `type` can at least be offered at `import { |`.
    if (!isTypeKeywordTokenOrIdentifier(contextToken)) data.keywordFilters = KeywordCompletionFilters.TypeKeyword;
    const declaration =
      namedImportsOrExports.kind === SyntaxKind.NamedImports
        ? namedImportsOrExports.parent!.parent!
        : namedImportsOrExports.parent!;
    const moduleSpecifier = getModuleSpecifier(declaration);
    if (moduleSpecifier === undefined) {
      data.isNewIdentifierLocation = true;
      return namedImportsOrExports.kind === SyntaxKind.NamedImports ? GlobalsSearch.Fail : GlobalsSearch.Continue;
    }
    const moduleSpecifierSymbol = getSymbolAtLocation(c, moduleSpecifier);
    if (moduleSpecifierSymbol === undefined) {
      data.isNewIdentifierLocation = true;
      return GlobalsSearch.Fail;
    }
    data.completionKind = CompletionKind.MemberLike;
    data.isNewIdentifierLocation = false;
    const exports = getExportsAndPropertiesOfModule(c, moduleSpecifierSymbol);
    const existing = new Set<string>();
    for (const element of getElements(namedImportsOrExports)!.nodes) {
      if (isCurrentlyEditingNode(element, this.file, this.position)) continue;
      existing.add(getText(getPropertyName(element) ?? getName(element)!));
    }
    const uniques = exports.filter((s) => symbolName(s) !== 'default' && !existing.has(symbolName(s)));
    data.symbols.push(...uniques);
    // With nothing left to import, `type` isn't offered either.
    if (uniques.length === 0) data.keywordFilters = KeywordCompletionFilters.None;
    return GlobalsSearch.Success;
  }

  private tryGetImportAttributesCompletionSymbols(): GlobalsSearch {
    const c = this.c;
    const contextToken = this.data.contextToken;
    if (contextToken === undefined) return GlobalsSearch.Continue;
    let importAttributes: Node | undefined;
    if (contextToken.kind === SyntaxKind.OpenBraceToken || contextToken.kind === SyntaxKind.CommaToken)
      importAttributes = contextToken.parent;
    else if (contextToken.kind === SyntaxKind.ColonToken) importAttributes = contextToken.parent!.parent;
    if (!(importAttributes instanceof ImportAttributes)) return GlobalsSearch.Continue;
    const existing = new Set<string>();
    for (const element of importAttributes.attributes.nodes)
      if (element instanceof ImportAttribute && element.name !== undefined) existing.add(getText(element.name));
    for (const symbol of getApparentProperties(c, getTypeAtLocation(c, importAttributes)))
      if (!existing.has(symbolName(symbol))) this.data.symbols.push(symbol);
    return GlobalsSearch.Success;
  }

  private tryGetLocalNamedExportCompletionSymbols(): GlobalsSearch {
    const data = this.data;
    const contextToken = data.contextToken;
    if (contextToken === undefined) return GlobalsSearch.Continue;
    if (
      !(contextToken.kind === SyntaxKind.OpenBraceToken || contextToken.kind === SyntaxKind.CommaToken) ||
      contextToken.parent!.kind !== SyntaxKind.NamedExports
    )
      return GlobalsSearch.Continue;
    const localsContainer = findAncestor(
      contextToken.parent,
      (n) => n.kind === SyntaxKind.SourceFile || n.kind === SyntaxKind.ModuleDeclaration,
    )!;
    data.completionKind = CompletionKind.None;
    data.isNewIdentifierLocation = false;
    const localSymbol = getSymbol(localsContainer);
    const localExports = localSymbol?.exports;
    const locals = getLocals(localsContainer);
    if (locals !== undefined)
      for (const [name, symbol] of locals) {
        data.symbols.push(symbol);
        if (localExports !== undefined && localExports.has(name))
          data.symbolToSortTextMap.set(getSymbolId(symbol), SortText.OptionalMember);
      }
    return GlobalsSearch.Success;
  }

  private tryGetConstructorCompletion(): GlobalsSearch {
    if (tryGetConstructorLikeCompletionContainer(this.data.contextToken) === undefined) return GlobalsSearch.Continue;
    // Only keywords for constructor parameters.
    this.data.completionKind = CompletionKind.None;
    this.data.isNewIdentifierLocation = true;
    this.data.keywordFilters = KeywordCompletionFilters.ConstructorParameterKeywords;
    return GlobalsSearch.Success;
  }

  private tryGetClassLikeCompletionSymbols(): GlobalsSearch {
    const c = this.c;
    const data = this.data;
    const contextToken = data.contextToken;
    const decl = tryGetObjectTypeDeclarationCompletionContainer(this.file, contextToken, data.location, this.position);
    if (decl === undefined) return GlobalsSearch.Continue;
    data.completionKind = CompletionKind.MemberLike;
    data.isNewIdentifierLocation = true;
    if (contextToken!.kind === SyntaxKind.AsteriskToken) data.keywordFilters = KeywordCompletionFilters.None;
    else if (isClassLike(decl)) data.keywordFilters = KeywordCompletionFilters.ClassElementKeywords;
    else data.keywordFilters = KeywordCompletionFilters.InterfaceElementKeywords;
    // Interfaces don't repeat members of their base interfaces.
    if (!isClassLike(decl)) return GlobalsSearch.Success;
    const classElement =
      contextToken!.kind === SyntaxKind.SemicolonToken ? contextToken!.parent!.parent! : contextToken!.parent!;
    let classElementModifierFlags = isClassElementNode(classElement)
      ? getModifierFlags(classElement)
      : ModifierFlags.None;
    // A context token that isn't being edited may become a modifier.
    if (
      contextToken!.kind === SyntaxKind.Identifier &&
      !isCurrentlyEditingNode(contextToken!, this.file, this.position)
    ) {
      switch ((contextToken as Identifier).text) {
        case 'private':
          classElementModifierFlags |= ModifierFlags.Private;
          break;
        case 'static':
          classElementModifierFlags |= ModifierFlags.Static;
          break;
        case 'override':
          classElementModifierFlags |= ModifierFlags.Override;
          break;
      }
    }
    if (classElement.kind === SyntaxKind.ClassStaticBlockDeclaration) classElementModifierFlags |= ModifierFlags.Static;
    // No members for private members.
    if ((classElementModifierFlags & ModifierFlags.Private) === 0) {
      let baseTypeNodes: Node[];
      if ((classElementModifierFlags & ModifierFlags.Override) !== 0) {
        const extendsElement = getClassExtendsHeritageElement(decl);
        baseTypeNodes = extendsElement !== undefined ? [extendsElement] : [];
      } else baseTypeNodes = getAllSuperTypeNodes(decl);
      const baseSymbols: Symbol[] = [];
      for (const baseTypeNode of baseTypeNodes) {
        const t = getTypeAtLocation(c, baseTypeNode);
        if ((classElementModifierFlags & ModifierFlags.Static) !== 0) {
          if (t.symbol !== undefined)
            baseSymbols.push(...getPropertiesOfType(c, getTypeOfSymbolAtLocation(c, t.symbol, decl)));
        } else baseSymbols.push(...getPropertiesOfType(c, t));
      }
      data.symbols.push(
        ...filterClassMembersList(
          c,
          baseSymbols,
          getMembers(decl)!.nodes,
          classElementModifierFlags,
          this.file,
          this.position,
        ),
      );
      for (let index = 0; index < data.symbols.length; index++) {
        const symbol = data.symbols[index];
        const declaration = symbol.valueDeclaration;
        if (
          declaration !== undefined &&
          isClassElementNode(declaration) &&
          getName(declaration) !== undefined &&
          getName(declaration)!.kind === SyntaxKind.ComputedPropertyName
        )
          data.symbolToOriginInfoMap.set(index, {
            kind: SymbolOriginInfoKind.ComputedPropertyName,
            symbolName: symbolToString(c, symbol),
          });
      }
    }
    return GlobalsSearch.Success;
  }

  private tryGetJsxCompletionSymbols(): GlobalsSearch {
    const c = this.c;
    const data = this.data;
    const jsxContainer = tryGetContainingJsxElement(data.contextToken, this.file);
    if (jsxContainer === undefined) return GlobalsSearch.Continue;
    const attributes = getJsxAttributes(jsxContainer);
    if (attributes === undefined) return GlobalsSearch.Continue;
    const attrsType = getContextualTypeWithFlags(c, attributes, ContextFlags.None);
    if (attrsType === undefined) return GlobalsSearch.Continue;
    const completionsType = getContextualTypeWithFlags(c, attributes, ContextFlags.Completions);
    const filtered = filterJsxAttributes(
      c,
      getPropertiesForObjectExpression(c, attrsType, completionsType, attributes),
      attributes.properties.nodes,
      this.file,
      this.position,
    );
    data.symbols.push(...filtered.members);
    for (const symbol of filtered.members) {
      const id = getSymbolId(symbol);
      if (filtered.spreadMemberNames.has(symbolName(symbol)))
        data.symbolToSortTextMap.set(id, SortText.MemberDeclaredBySpreadAssignment);
      if ((symbol.flags & SymbolFlags.Optional) !== 0 && !data.symbolToSortTextMap.has(id))
        data.symbolToSortTextMap.set(id, SortText.OptionalMember);
    }
    data.completionKind = CompletionKind.MemberLike;
    data.isNewIdentifierLocation = false;
    return GlobalsSearch.Success;
  }
}

function isExpressionKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.ParenthesizedExpression:
      return true;
  }
  return false;
}

function isClassElementNode(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Constructor:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.SemicolonClassElement:
      return true;
  }
  return false;
}

function nullableOriginKind(kind: SymbolOriginInfoKind, insertQuestionDot: boolean): SymbolOriginInfoKind {
  return insertQuestionDot ? kind | SymbolOriginInfoKind.Nullable : kind;
}

function isStaticProperty(symbol: Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return (
    declaration !== undefined &&
    (getModifierFlags(declaration) & ModifierFlags.Static) !== 0 &&
    declaration.parent !== undefined &&
    isClassLike(declaration.parent)
  );
}

function getNameOfDeclarationForCompletions(declaration: Node): Node | undefined {
  return getNameOfDeclaration(declaration);
}

function getLeftMostName(e: Node): Node | undefined {
  if (e.kind === SyntaxKind.Identifier) return e;
  if (e.kind === SyntaxKind.PropertyAccessExpression)
    return getLeftMostName((e as PropertyAccessExpression).expression);
  return undefined;
}

function getFirstSymbolInChain(c: Checker, symbol: Symbol, enclosingDeclaration: Node | undefined): Symbol | undefined {
  const chain = getAccessibleSymbolChain(c, symbol, enclosingDeclaration, SymbolFlags.All, false);
  if (chain.length > 0) return chain[0];
  if (symbol.parent !== undefined) {
    if (isModuleSymbol(symbol.parent)) return symbol;
    return getFirstSymbolInChain(c, symbol.parent, enclosingDeclaration);
  }
  return undefined;
}

function isModuleSymbol(symbol: Symbol): boolean {
  return getDeclarations(symbol).some((d) => d.kind === SyntaxKind.SourceFile);
}

function isLiteralImportTypeNode(node: Node): boolean {
  if (!(node instanceof ImportTypeNode)) return false;
  const argument = node.argument;
  return argument.kind === SyntaxKind.LiteralType && getLiteralOf(argument).kind === SyntaxKind.StringLiteral;
}

function getLiteralOf(node: Node): Node {
  return getLiteral(node)!;
}

function isInTypeQuery(node: Node): boolean {
  // In `typeof x.y`, a type query's expression.
  return (
    findAncestorOrQuit(node, (n) => {
      switch (n.kind) {
        case SyntaxKind.TypeQuery:
          return FindAncestorResult.True;
        case SyntaxKind.Identifier:
        case SyntaxKind.QualifiedName:
          return FindAncestorResult.False;
      }
      return FindAncestorResult.Quit;
    }) !== undefined
  );
}

/** True for types, and modules containing at least one type. */
function symbolCanBeReferencedAtTypeLocation(c: Checker, symbol: Symbol, seenModules: Set<number>): boolean {
  // An alias can merge with a local declaration, so both meanings are tested.
  return (
    nonAliasCanBeReferencedAtTypeLocation(c, symbol, seenModules) ||
    nonAliasCanBeReferencedAtTypeLocation(c, skipAlias(c, symbol.exportSymbol ?? symbol), seenModules)
  );
}

function nonAliasCanBeReferencedAtTypeLocation(c: Checker, symbol: Symbol, seenModules: Set<number>): boolean {
  if ((symbol.flags & SymbolFlags.Type) !== 0 || symbol === c.unknownSymbol) return true;
  if ((symbol.flags & SymbolFlags.Module) === 0) return false;
  const id = getSymbolId(symbol);
  if (seenModules.has(id)) return false;
  seenModules.add(id);
  return getExportsOfModuleAsArray(c, symbol).some((e) => symbolCanBeReferencedAtTypeLocation(c, e, seenModules));
}

/** The properties of a type; for a union, those of any constituent. */
export function getPropertiesForCompletion(c: Checker, t: Type): Symbol[] {
  if ((t.flags & TypeFlags.Union) !== 0) return getAllPossiblePropertiesOfTypes(c, typesOf(t));
  return getApparentProperties(c, t);
}

import { getNameOfDeclaration } from '../compiler/binder-utilities.js';
import { typeToTypeNode } from '../compiler/node-builder.js';
import { NodeBuilderInternalFlags } from '../compiler/transformers/declarations-resolver.js';
import { getFirstIdentifier } from '../compiler/checker-symbols.js';
import { getDefaultLikeExportNameFromDeclaration, moduleSpecifierToValidIdentifier } from './auto-import-exports.js';
import { NodeBuilderFlags } from '../compiler/transformers/declarations-resolver.js';
import { EmitContext } from '../compiler/printer/emit-context.js';
import { EmitFlags } from '../compiler/printer/emit-flags.js';
import { Printer, PrinterOptions } from '../compiler/printer/printer.js';
import { getQuotePreference, QuotePreference } from './completion-utilities.js';

// ---- Containers

function tryGetTypeLiteralNode(node: Node | undefined): Node | undefined {
  if (node === undefined) return undefined;
  const parent = node.parent!;
  switch (node.kind) {
    case SyntaxKind.OpenBraceToken:
      if (parent.kind === SyntaxKind.TypeLiteral) return parent;
      break;
    case SyntaxKind.SemicolonToken:
    case SyntaxKind.CommaToken:
    case SyntaxKind.Identifier:
      if (parent.kind === SyntaxKind.PropertySignature && parent.parent!.kind === SyntaxKind.TypeLiteral)
        return parent.parent;
      break;
  }
  return undefined;
}

export function getConstraintOfTypeArgumentProperty(c: Checker, node: Node | undefined): Type | undefined {
  if (node === undefined) return undefined;
  if (isTypeNode(node)) {
    const constraint = getTypeArgumentConstraint(c, node);
    if (constraint !== undefined) return constraint;
  }
  const t = getConstraintOfTypeArgumentProperty(c, node.parent);
  if (t === undefined) return undefined;
  switch (node.kind) {
    case SyntaxKind.PropertySignature: {
      const reparsed = getReparsedNodeForNode(node);
      const symbol = getSymbol(reparsed);
      if (symbol !== undefined) return getTypeOfPropertyOfContextualType(c, t, symbol.name);
      const name = getName(reparsed);
      if (name !== undefined && isPropertyNameLiteral(name))
        return getTypeOfPropertyOfContextualType(c, t, getText(name));
      return undefined;
    }
    case SyntaxKind.ColonToken:
      // At `Foo<{ x: | }`, `t` is the property's type.
      if (node.parent!.kind === SyntaxKind.PropertySignature) return t;
      break;
    case SyntaxKind.IntersectionType:
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.UnionType:
      return t;
    case SyntaxKind.OpenBracketToken:
      return getElementTypeOfArrayType(c, t);
  }
  return undefined;
}

import { getReparsedNodeForNode } from '../compiler/checker-services.js';

function tryGetObjectLikeCompletionContainer(
  contextToken: Node | undefined,
  position: number,
  file: SourceFile,
): Node | undefined {
  if (contextToken === undefined) return undefined;
  const parent = contextToken.parent!;
  switch (contextToken.kind) {
    // `{ |` and `{ a: 0, |`
    case SyntaxKind.OpenBraceToken:
    case SyntaxKind.CommaToken:
      if (parent.kind === SyntaxKind.ObjectLiteralExpression || parent.kind === SyntaxKind.ObjectBindingPattern)
        return parent;
      break;
    case SyntaxKind.AsteriskToken:
      if (parent.kind === SyntaxKind.MethodDeclaration && parent.parent!.kind === SyntaxKind.ObjectLiteralExpression)
        return parent.parent;
      break;
    case SyntaxKind.AsyncKeyword:
      if (parent.parent!.kind === SyntaxKind.ObjectLiteralExpression) return parent.parent;
      break;
    case SyntaxKind.Identifier: {
      if ((contextToken as Identifier).text === 'async' && parent.kind === SyntaxKind.ShorthandPropertyAssignment)
        return parent.parent;
      if (
        parent.parent!.kind === SyntaxKind.ObjectLiteralExpression &&
        (parent.kind === SyntaxKind.SpreadAssignment ||
          (parent.kind === SyntaxKind.ShorthandPropertyAssignment &&
            getLineOfPosition(file, contextToken.end) !== getLineOfPosition(file, position)))
      )
        return parent.parent;
      const ancestor = findAncestor(parent, (n) => n.kind === SyntaxKind.PropertyAssignment);
      if (
        ancestor !== undefined &&
        getLastToken(ancestor, file) === contextToken &&
        ancestor.parent!.kind === SyntaxKind.ObjectLiteralExpression
      )
        return ancestor.parent;
      break;
    }
    default: {
      const grandparent = parent.parent;
      if (
        grandparent !== undefined &&
        grandparent.parent !== undefined &&
        (grandparent.kind === SyntaxKind.MethodDeclaration ||
          grandparent.kind === SyntaxKind.GetAccessor ||
          grandparent.kind === SyntaxKind.SetAccessor) &&
        grandparent.parent.kind === SyntaxKind.ObjectLiteralExpression
      )
        return grandparent.parent;
      if (parent.kind === SyntaxKind.SpreadAssignment && grandparent!.kind === SyntaxKind.ObjectLiteralExpression)
        return grandparent;
      const ancestor = findAncestor(parent, (n) => n.kind === SyntaxKind.PropertyAssignment);
      if (
        contextToken.kind !== SyntaxKind.ColonToken &&
        ancestor !== undefined &&
        getLastToken(ancestor, file) === contextToken &&
        ancestor.parent!.kind === SyntaxKind.ObjectLiteralExpression
      )
        return ancestor.parent;
    }
  }
  return undefined;
}

function tryGetObjectLiteralContextualType(c: Checker, node: Node): Type | undefined {
  const t = getContextualTypeWithFlags(c, node, ContextFlags.None);
  if (t !== undefined) return t;
  let parent = node.parent!;
  while (parent.kind === SyntaxKind.ParenthesizedExpression) parent = parent.parent!;
  if (
    parent instanceof BinaryExpression &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    node === parent.left
  )
    // An assignment pattern: `({ | } = x)`.
    return getTypeAtLocation(c, parent);
  if (isExpressionNodeKind(parent))
    // `f(() => (({ | })))`
    return getContextualTypeWithFlags(c, parent, ContextFlags.None);
  return undefined;
}

function isExpressionNodeKind(node: Node): boolean {
  return isExpressionSyntaxKind(node.kind);
}

/** Whether a node kind is an expression, like tsgo's `ast.IsExpression`. */
export function isExpressionSyntaxKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.ConditionalExpression:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.AsExpression:
    case SyntaxKind.OmittedExpression:
    case SyntaxKind.PartiallyEmittedExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.AwaitExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.MetaProperty:
    case SyntaxKind.ImportKeyword:
    case SyntaxKind.MissingDeclaration:
      return true;
  }
  return false;
}

export function getPropertiesForObjectExpression(
  c: Checker,
  contextualType: Type,
  completionsType: Type | undefined,
  obj: Node,
): Symbol[] {
  const hasCompletionsType = completionsType !== undefined && completionsType !== contextualType;
  const types = (contextualType.flags & TypeFlags.Union) !== 0 ? typesOf(contextualType) : [contextualType];
  const promiseFilteredContextualType = getUnionType(
    c,
    types.filter((t) => getPromisedTypeOfPromise(c, t) === undefined),
  );
  const t =
    hasCompletionsType && (completionsType!.flags & TypeFlags.AnyOrUnknown) === 0
      ? getUnionType(c, [promiseFilteredContextualType, completionsType!])
      : promiseFilteredContextualType;
  const properties = getApparentPropertiesForObject(c, t, obj);
  if ((t.objectFlags & ObjectFlags.Class) !== 0 && containsNonPublicProperties(c, properties)) return [];
  // Members declared only by the object literal itself aren't completions.
  if (hasCompletionsType)
    return properties.filter((m) => declarationCount(m) === 0 || getDeclarations(m).some((d) => d.parent !== obj));
  return properties;
}

function getApparentPropertiesForObject(c: Checker, t: Type, node: Node): Symbol[] {
  if ((t.flags & TypeFlags.Union) === 0) return getApparentProperties(c, t);
  return getAllPossiblePropertiesOfTypes(
    c,
    typesOf(t).filter(
      (memberType) =>
        !(
          (memberType.flags & TypeFlags.Primitive) !== 0 ||
          isArrayLikeType(c, memberType) ||
          isTypeInvalidDueToUnionDiscriminant(c, memberType, node) ||
          typeHasCallOrConstructSignatures(c, memberType) ||
          ((memberType.objectFlags & ObjectFlags.Class) !== 0 &&
            containsNonPublicProperties(c, getApparentProperties(c, memberType)))
        ),
    ),
  );
}

import { typeHasCallOrConstructSignatures } from '../compiler/relations.js';

function containsNonPublicProperties(c: Checker, props: Symbol[]): boolean {
  return props.some(
    (p) => (getDeclarationModifierFlagsFromSymbol(c, p, false) & ModifierFlags.NonPublicAccessibilityModifier) !== 0,
  );
}

interface FilteredMembers {
  members: Symbol[];
  spreadMemberNames: Set<string>;
}

function filterObjectMembersList(
  c: Checker,
  contextualMemberSymbols: Symbol[],
  existingMembers: Node[],
  file: SourceFile,
  position: number,
): FilteredMembers {
  const spreadMemberNames = new Set<string>();
  if (existingMembers.length === 0) return { members: contextualMemberSymbols, spreadMemberNames };
  const existingMemberNames = new Set<string>();
  for (const member of existingMembers) {
    switch (member.kind) {
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ShorthandPropertyAssignment:
      case SyntaxKind.BindingElement:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.SpreadAssignment:
        break;
      default:
        continue;
    }
    // The member being edited isn't filtered out.
    if (isCurrentlyEditingNode(member, file, position)) continue;
    let existingName = '';
    if (member.kind === SyntaxKind.SpreadAssignment) setMemberDeclaredBySpreadAssignment(c, member, spreadMemberNames);
    else if (member instanceof BindingElement && member.propertyName !== undefined) {
      if (member.propertyName.kind === SyntaxKind.Identifier) existingName = getText(member.propertyName);
    } else {
      const name = getNameOfDeclaration(member);
      if (name !== undefined && isPropertyNameLiteral(name)) existingName = getText(name);
    }
    if (existingName !== '') existingMemberNames.add(existingName);
  }
  return { members: contextualMemberSymbols.filter((m) => !existingMemberNames.has(m.name)), spreadMemberNames };
}

function setMemberDeclaredBySpreadAssignment(c: Checker, declaration: Node, members: Set<string>): void {
  const expression = getExpression(declaration)!;
  const symbol = getSymbolAtLocation(c, expression);
  const t = symbol !== undefined ? getTypeOfSymbolAtLocation(c, symbol, expression) : undefined;
  if (t !== undefined && (t.flags & TypeFlags.StructuredType) !== 0)
    for (const property of resolveStructuredTypeMembers(c, t).properties) members.add(property.name);
}

import { resolveStructuredTypeMembers } from '../compiler/checker-members.js';

function tryGetConstructorLikeCompletionContainer(contextToken: Node | undefined): Node | undefined {
  if (contextToken === undefined) return undefined;
  const parent = contextToken.parent!;
  switch (contextToken.kind) {
    case SyntaxKind.OpenParenToken:
    case SyntaxKind.CommaToken:
      return parent.kind === SyntaxKind.Constructor ? parent : undefined;
  }
  if (isConstructorParameterCompletion(contextToken)) return parent.parent;
  return undefined;
}

function isConstructorParameterCompletion(node: Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    parent.kind === SyntaxKind.Parameter &&
    parent.parent!.kind === SyntaxKind.Constructor &&
    (isParameterPropertyModifier(node.kind) || isDeclarationName(node))
  );
}

function tryGetObjectTypeDeclarationCompletionContainer(
  file: SourceFile,
  contextToken: Node | undefined,
  location: Node,
  position: number,
): Node | undefined {
  // `class c { method() { } | method2() { } }`
  switch (location.kind) {
    case SyntaxKind.SyntaxList:
      return location.parent !== undefined && isObjectTypeDeclaration(location.parent) ? location.parent : undefined;
    case SyntaxKind.EndOfFile: {
      const statements = (location.parent as SourceFile).statements.nodes;
      if (statements.length > 0) {
        const last = statements[statements.length - 1];
        if (isObjectTypeDeclaration(last) && findChildOfKind(last, SyntaxKind.CloseBraceToken, file) === undefined)
          return last;
      }
      break;
    }
    case SyntaxKind.PrivateIdentifier:
      if (location.parent!.kind === SyntaxKind.PropertyDeclaration) return findAncestor(location, isClassLike);
      break;
    case SyntaxKind.Identifier: {
      if (identifierToKeywordKind((location as Identifier).text) !== SyntaxKind.Unknown) return undefined;
      // `class c { public prop = c| }`
      if (location.parent!.kind === SyntaxKind.PropertyDeclaration && getInitializer(location.parent!) === location)
        return undefined;
      // `class c extends React.Component { a: () => 1\n compon| }`
      if (isFromObjectTypeDeclaration(location)) return findAncestor(location, isObjectTypeDeclaration);
      break;
    }
  }
  if (contextToken === undefined) return undefined;
  // `class C { blah; constructor/**/ }`
  if (
    location.kind === SyntaxKind.ConstructorKeyword ||
    (contextToken.kind === SyntaxKind.Identifier &&
      contextToken.parent!.kind === SyntaxKind.PropertyDeclaration &&
      isClassLike(location))
  )
    return findAncestor(contextToken, isClassLike);
  switch (contextToken.kind) {
    // `class c { public prop = | /* global completions */ }`
    case SyntaxKind.EqualsToken:
      return undefined;
    // `class c {getValue(): number; | }` and `class c { method() { } | }`
    case SyntaxKind.SemicolonToken:
    case SyntaxKind.CloseBraceToken:
      if (isFromObjectTypeDeclaration(location) && getName(location.parent!) === location)
        return location.parent!.parent;
      return isObjectTypeDeclaration(location) ? location : undefined;
    // `class c { |` and `class c {getValue(): number, | }`
    case SyntaxKind.OpenBraceToken:
    case SyntaxKind.CommaToken:
      return isObjectTypeDeclaration(contextToken.parent!) ? contextToken.parent : undefined;
  }
  if (isObjectTypeDeclaration(location)) {
    // `class C { prop = ""\n | }`
    if (getLineOfPosition(file, contextToken.end) !== getLineOfPosition(file, position)) return location;
    const isValidKeyword = isClassLike(contextToken.parent!.parent!)
      ? isClassMemberCompletionKeyword
      : isInterfaceOrTypeLiteralCompletionKeyword;
    if (
      isValidKeyword(contextToken.kind) ||
      contextToken.kind === SyntaxKind.AsteriskToken ||
      (contextToken.kind === SyntaxKind.Identifier &&
        isValidKeyword(identifierToKeywordKind((contextToken as Identifier).text)))
    )
      return contextToken.parent!.parent;
  }
  return undefined;
}

function isFromObjectTypeDeclaration(node: Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    isClassOrTypeElement(parent) &&
    parent.parent !== undefined &&
    isObjectTypeDeclaration(parent.parent)
  );
}

function filterClassMembersList(
  c: Checker,
  baseSymbols: Symbol[],
  existingMembers: Node[],
  classElementModifierFlags: ModifierFlags,
  file: SourceFile,
  position: number,
): Symbol[] {
  const existingMemberNames = new Set<string>();
  for (const member of existingMembers) {
    if (
      member.kind !== SyntaxKind.PropertyDeclaration &&
      member.kind !== SyntaxKind.MethodDeclaration &&
      member.kind !== SyntaxKind.GetAccessor &&
      member.kind !== SyntaxKind.SetAccessor
    )
      continue;
    if (isCurrentlyEditingNode(member, file, position)) continue;
    // Private members don't hide base members.
    if ((getModifierFlags(member) & ModifierFlags.Private) !== 0) continue;
    if (isStatic(member) !== ((classElementModifierFlags & ModifierFlags.Static) !== 0)) continue;
    const existingName = getPropertyNameForPropertyNameNode(getName(member)!);
    if (existingName !== '') existingMemberNames.add(existingName);
  }
  return baseSymbols.filter(
    (p) =>
      !existingMemberNames.has(symbolName(p)) &&
      declarationCount(p) > 0 &&
      (getDeclarationModifierFlagsFromSymbol(c, p, false) & ModifierFlags.Private) === 0 &&
      !(p.valueDeclaration !== undefined && isPrivateIdentifierClassElementDeclaration(p.valueDeclaration)),
  );
}

import { getPropertyNameForPropertyNameNode } from '../compiler/transformers/decorator-utilities.js';

function tryGetContainingJsxElement(contextToken: Node | undefined, file: SourceFile): Node | undefined {
  if (contextToken === undefined) return undefined;
  const parent = contextToken.parent;
  switch (contextToken.kind) {
    case SyntaxKind.GreaterThanToken:
    case SyntaxKind.LessThanSlashToken:
    case SyntaxKind.SlashToken:
    case SyntaxKind.Identifier:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.JsxNamespacedName:
    case SyntaxKind.JsxAttributes:
    case SyntaxKind.JsxAttribute:
    case SyntaxKind.JsxSpreadAttribute:
      if (parent !== undefined && isJsxOpeningLikeElement(parent)) {
        if (contextToken.kind === SyntaxKind.GreaterThanToken) {
          const precedingToken = findPrecedingToken(file, contextToken.pos);
          const typeArguments = getTypeArguments(parent);
          if (
            typeArguments === undefined ||
            typeArguments.nodes.length === 0 ||
            (precedingToken !== undefined && precedingToken.kind === SyntaxKind.SlashToken)
          )
            return undefined;
        }
        return parent;
      }
      if (
        parent !== undefined &&
        parent.kind === SyntaxKind.JsxNamespacedName &&
        parent.parent !== undefined &&
        isJsxOpeningLikeElement(parent.parent)
      )
        return parent.parent;
      if (parent !== undefined && parent.kind === SyntaxKind.JsxAttribute) return parent.parent!.parent;
      break;
    // The closing `}` or `"` of an attribute.
    case SyntaxKind.StringLiteral:
      if (
        parent !== undefined &&
        (parent.kind === SyntaxKind.JsxAttribute || parent.kind === SyntaxKind.JsxSpreadAttribute)
      )
        return parent.parent!.parent;
      break;
    case SyntaxKind.CloseBraceToken:
      if (
        parent !== undefined &&
        parent.kind === SyntaxKind.JsxExpression &&
        parent.parent !== undefined &&
        parent.parent.kind === SyntaxKind.JsxAttribute
      )
        return parent.parent.parent!.parent;
      if (parent !== undefined && parent.kind === SyntaxKind.JsxSpreadAttribute) return parent.parent!.parent;
      break;
  }
  return undefined;
}

function filterJsxAttributes(
  c: Checker,
  symbols: Symbol[],
  attributes: Node[],
  file: SourceFile,
  position: number,
): FilteredMembers {
  const existingNames = new Set<string>();
  const spreadMemberNames = new Set<string>();
  for (const attr of attributes) {
    // The attribute being edited isn't filtered out.
    if (isCurrentlyEditingNode(attr, file, position)) continue;
    if (attr instanceof JsxAttribute) existingNames.add(getJsxAttributeNameText(attr.name));
    else if (attr instanceof JsxSpreadAttribute) setMemberDeclaredBySpreadAssignment(c, attr, spreadMemberNames);
  }
  return { members: symbols.filter((a) => !existingNames.has(a.name)), spreadMemberNames };
}

function getJsxAttributeNameText(name: Node): string {
  if (name instanceof Identifier) return name.text;
  if (name instanceof JsxNamespacedName) return name.namespace.text + ':' + name.name.text;
  return '';
}

function getJsxAttributes(element: Node): JsxAttributes | undefined {
  if (element instanceof JsxOpeningElement) return element.attributes;
  if (element instanceof JsxSelfClosingElement) return element.attributes;
  return undefined;
}

function isNamedImportsOrExports(node: Node): boolean {
  return node.kind === SyntaxKind.NamedImports || node.kind === SyntaxKind.NamedExports;
}

function isTypeKeywordTokenOrIdentifier(node: Node): boolean {
  return (
    node.kind === SyntaxKind.TypeKeyword ||
    (node.kind === SyntaxKind.Identifier &&
      identifierToKeywordKind((node as Identifier).text) === SyntaxKind.TypeKeyword)
  );
}

// ---- Blockers

function isCompletionListBlocker(
  c: Checker,
  contextToken: Node,
  previousToken: Node,
  location: Node,
  file: SourceFile,
  position: number,
): boolean {
  return (
    isInStringOrRegularExpressionOrTemplateLiteral(contextToken, position) ||
    isSolelyIdentifierDefinitionLocation(c, contextToken, previousToken, file, position) ||
    isDotOfNumericLiteral(contextToken, file) ||
    isInJsxText(contextToken, location) ||
    contextToken.kind === SyntaxKind.BigIntLiteral
  );
}

function isInStringOrRegularExpressionOrTemplateLiteral(contextToken: Node, position: number): boolean {
  // Within the token text, at the end of an unterminated token, or at the end of a regular expression.
  return (
    ((contextToken.kind === SyntaxKind.RegularExpressionLiteral || isStringTextContainingNode(contextToken)) &&
      contextToken.pos < position &&
      position < contextToken.end) ||
    (position === contextToken.end &&
      (isUnterminatedLiteral(contextToken) || contextToken.kind === SyntaxKind.RegularExpressionLiteral))
  );
}

function isFunctionLikeButNotConstructor(kind: SyntaxKind): boolean {
  return isFunctionLikeKind(kind) && kind !== SyntaxKind.Constructor;
}

function isPreviousPropertyDeclarationTerminated(contextToken: Node, file: SourceFile, position: number): boolean {
  return (
    contextToken.kind !== SyntaxKind.EqualsToken &&
    (contextToken.kind === SyntaxKind.SemicolonToken ||
      getLineOfPosition(file, contextToken.end) !== getLineOfPosition(file, position))
  );
}

function keywordForNode(node: Node): SyntaxKind {
  return node instanceof Identifier ? identifierToKeywordKind(node.text) : node.kind;
}

/** True where the location certainly declares a new name. */
function isSolelyIdentifierDefinitionLocation(
  c: Checker,
  contextToken: Node,
  previousToken: Node,
  file: SourceFile,
  position: number,
): boolean {
  const parent = contextToken.parent!;
  const containingNodeKind = parent.kind;
  switch (contextToken.kind) {
    case SyntaxKind.CommaToken:
      return (
        containingNodeKind === SyntaxKind.VariableDeclaration ||
        (parent.kind === SyntaxKind.VariableDeclarationList &&
          !isPossiblyTypeArgumentPosition(c, contextToken, file)) ||
        containingNodeKind === SyntaxKind.VariableStatement ||
        containingNodeKind === SyntaxKind.EnumDeclaration ||
        isFunctionLikeButNotConstructor(containingNodeKind) ||
        containingNodeKind === SyntaxKind.InterfaceDeclaration ||
        containingNodeKind === SyntaxKind.ArrayBindingPattern ||
        containingNodeKind === SyntaxKind.TypeAliasDeclaration ||
        (isClassLike(parent) &&
          getTypeParameters(parent) !== undefined &&
          getTypeParameters(parent)!.end >= contextToken.pos)
      );
    case SyntaxKind.DotToken:
      return containingNodeKind === SyntaxKind.ArrayBindingPattern;
    case SyntaxKind.ColonToken:
      return containingNodeKind === SyntaxKind.BindingElement;
    case SyntaxKind.OpenBracketToken:
      return containingNodeKind === SyntaxKind.ArrayBindingPattern;
    case SyntaxKind.OpenParenToken:
      return containingNodeKind === SyntaxKind.CatchClause || isFunctionLikeButNotConstructor(containingNodeKind);
    case SyntaxKind.OpenBraceToken:
      return containingNodeKind === SyntaxKind.EnumDeclaration;
    case SyntaxKind.LessThanToken:
      return (
        containingNodeKind === SyntaxKind.ClassDeclaration ||
        containingNodeKind === SyntaxKind.ClassExpression ||
        containingNodeKind === SyntaxKind.InterfaceDeclaration ||
        containingNodeKind === SyntaxKind.TypeAliasDeclaration ||
        isFunctionLikeKind(containingNodeKind)
      );
    case SyntaxKind.StaticKeyword:
      return containingNodeKind === SyntaxKind.PropertyDeclaration && !isClassLike(parent.parent!);
    case SyntaxKind.DotDotDotToken:
      return (
        containingNodeKind === SyntaxKind.Parameter ||
        (parent.parent !== undefined && parent.parent.kind === SyntaxKind.ArrayBindingPattern)
      );
    case SyntaxKind.PublicKeyword:
    case SyntaxKind.PrivateKeyword:
    case SyntaxKind.ProtectedKeyword:
      return containingNodeKind === SyntaxKind.Parameter && parent.parent!.kind !== SyntaxKind.Constructor;
    case SyntaxKind.AsKeyword:
      return (
        containingNodeKind === SyntaxKind.ImportSpecifier ||
        containingNodeKind === SyntaxKind.ExportSpecifier ||
        containingNodeKind === SyntaxKind.NamespaceImport
      );
    case SyntaxKind.GetKeyword:
    case SyntaxKind.SetKeyword:
      return !isFromObjectTypeDeclaration(contextToken);
    case SyntaxKind.Identifier: {
      if (
        (containingNodeKind === SyntaxKind.ImportSpecifier || containingNodeKind === SyntaxKind.ExportSpecifier) &&
        contextToken === getName(parent) &&
        (contextToken as Identifier).text === 'type'
      )
        // `import { type | }`
        return false;
      const ancestorVariableDeclaration = findAncestor(parent, (n) => n.kind === SyntaxKind.VariableDeclaration);
      // `let a\n|`
      if (ancestorVariableDeclaration !== undefined && getLineEndOfPosition(file, contextToken.end) < position)
        return false;
      break;
    }
    case SyntaxKind.ClassKeyword:
    case SyntaxKind.EnumKeyword:
    case SyntaxKind.InterfaceKeyword:
    case SyntaxKind.FunctionKeyword:
    case SyntaxKind.VarKeyword:
    case SyntaxKind.ImportKeyword:
    case SyntaxKind.LetKeyword:
    case SyntaxKind.ConstKeyword:
    case SyntaxKind.InferKeyword:
      return true;
    case SyntaxKind.TypeKeyword:
      // `import { type foo| }`
      return containingNodeKind !== SyntaxKind.ImportSpecifier;
    case SyntaxKind.AsteriskToken:
      return isFunctionLike(parent) && parent.kind !== SyntaxKind.MethodDeclaration;
  }
  const tokenKind = keywordForNode(contextToken);
  // After a class member keyword, completion is available.
  if (isClassMemberCompletionKeyword(tokenKind) && isFromObjectTypeDeclaration(contextToken)) return false;
  // Constructor parameters: modifiers, and a name that isn't being edited.
  if (isConstructorParameterCompletion(contextToken)) {
    if (
      contextToken.kind !== SyntaxKind.Identifier ||
      isParameterPropertyModifier(tokenKind) ||
      isCurrentlyEditingNode(contextToken, file, position)
    )
      return false;
  }
  // The previous token may be a keyword that was converted to an identifier.
  switch (tokenKind) {
    case SyntaxKind.AbstractKeyword:
    case SyntaxKind.ClassKeyword:
    case SyntaxKind.DeclareKeyword:
    case SyntaxKind.EnumKeyword:
    case SyntaxKind.FunctionKeyword:
    case SyntaxKind.InterfaceKeyword:
    case SyntaxKind.LetKeyword:
    case SyntaxKind.PrivateKeyword:
    case SyntaxKind.ProtectedKeyword:
    case SyntaxKind.PublicKeyword:
    case SyntaxKind.StaticKeyword:
    case SyntaxKind.VarKeyword:
      return true;
    case SyntaxKind.AsyncKeyword:
      return contextToken.parent!.kind === SyntaxKind.PropertyDeclaration;
  }
  // In a class, a completion requested at whitespace after a terminated property isn't blocked.
  const ancestorClassLike = findAncestor(parent, isClassLike);
  if (
    ancestorClassLike !== undefined &&
    contextToken === previousToken &&
    isPreviousPropertyDeclarationTerminated(contextToken, file, position)
  )
    return false;
  const ancestorPropertyDeclaration = findAncestor(parent, (n) => n.kind === SyntaxKind.PropertyDeclaration);
  // Typing `constructor` after a property declaration.
  if (
    ancestorPropertyDeclaration !== undefined &&
    contextToken !== previousToken &&
    isClassLike(previousToken.parent!.parent!) &&
    position <= previousToken.end
  ) {
    if (isPreviousPropertyDeclarationTerminated(contextToken, file, previousToken.end)) return false;
    if (
      contextToken.kind !== SyntaxKind.EqualsToken &&
      (getInitializer(ancestorPropertyDeclaration) !== undefined || getType(ancestorPropertyDeclaration) !== undefined)
    )
      return true;
  }
  if (tokenKind === SyntaxKind.ConstKeyword) return true;
  return (
    isDeclarationName(contextToken) &&
    parent.kind !== SyntaxKind.ShorthandPropertyAssignment &&
    parent.kind !== SyntaxKind.JsxAttribute &&
    // Past the end of `class C`, `interface I` or `<T`, `extends` may follow.
    !(
      (isClassLike(parent) ||
        parent.kind === SyntaxKind.InterfaceDeclaration ||
        parent.kind === SyntaxKind.TypeParameter) &&
      (contextToken !== previousToken || position > previousToken.end)
    )
  );
}

function isDotOfNumericLiteral(contextToken: Node, file: SourceFile): boolean {
  if (contextToken.kind !== SyntaxKind.NumericLiteral) return false;
  return file.text.charCodeAt(contextToken.end - 1) === 0x2e;
}

function isInJsxText(contextToken: Node, location: Node): boolean {
  if (contextToken.kind === SyntaxKind.JsxText) return true;
  if (contextToken.kind === SyntaxKind.GreaterThanToken && contextToken.parent !== undefined) {
    // `<Component<string> /**/ />`
    if (location === contextToken.parent && isJsxOpeningLikeElement(location)) return false;
    // `<div>/**/`
    if (contextToken.parent.kind === SyntaxKind.JsxOpeningElement)
      return location.parent!.kind !== SyntaxKind.JsxOpeningElement;
    if (
      contextToken.parent.kind === SyntaxKind.JsxClosingElement ||
      contextToken.parent.kind === SyntaxKind.JsxSelfClosingElement
    )
      return contextToken.parent.parent !== undefined && contextToken.parent.parent.kind === SyntaxKind.JsxElement;
  }
  return false;
}

// ---- Import statements

interface ImportStatementCompletionInfo {
  isKeywordOnlyCompletion: boolean;
  keywordCompletion: SyntaxKind;
  isNewIdentifierLocation: boolean;
  hasReplacementSpan: boolean;
  isTopLevelTypeOnly: boolean;
  couldBeTypeOnlyImportSpecifier: boolean;
}

function getImportStatementCompletionInfo(contextToken: Node, file: SourceFile): ImportStatementCompletionInfo {
  const result: ImportStatementCompletionInfo = {
    isKeywordOnlyCompletion: false,
    keywordCompletion: SyntaxKind.Unknown,
    isNewIdentifierLocation: false,
    hasReplacementSpan: false,
    isTopLevelTypeOnly: false,
    couldBeTypeOnlyImportSpecifier: false,
  };
  let candidate: Node | undefined;
  const parent = contextToken.parent!;
  if (parent instanceof ImportEqualsDeclaration) {
    // `import Foo |` and `import Foo f|`
    const lastToken = getLastToken(parent, file);
    if (contextToken.kind === SyntaxKind.Identifier && lastToken !== contextToken) {
      result.keywordCompletion = SyntaxKind.FromKeyword;
      result.isKeywordOnlyCompletion = true;
    } else {
      if (contextToken.kind !== SyntaxKind.TypeKeyword) result.keywordCompletion = SyntaxKind.TypeKeyword;
      if (isModuleSpecifierMissingOrEmpty(parent.moduleReference)) candidate = parent;
    }
  } else if (couldBeTypeOnlyImportSpecifier(parent, contextToken) && canCompleteFromNamedBindings(parent.parent!)) {
    candidate = parent;
  } else if (parent.kind === SyntaxKind.NamedImports || parent.kind === SyntaxKind.NamespaceImport) {
    const importClause = parent.parent as ImportClause;
    if (
      !importClauseIsTypeOnly(importClause) &&
      (contextToken.kind === SyntaxKind.OpenBraceToken ||
        contextToken.kind === SyntaxKind.ImportKeyword ||
        contextToken.kind === SyntaxKind.CommaToken)
    )
      result.keywordCompletion = SyntaxKind.TypeKeyword;
    if (canCompleteFromNamedBindings(parent)) {
      // At `import { ... } |` or `import * as Foo |`, only `from` can follow.
      if (contextToken.kind === SyntaxKind.CloseBraceToken || contextToken.kind === SyntaxKind.Identifier) {
        result.isKeywordOnlyCompletion = true;
        result.keywordCompletion = SyntaxKind.FromKeyword;
      } else candidate = parent.parent!.parent;
    }
  } else if (
    (parent.kind === SyntaxKind.ExportDeclaration && contextToken.kind === SyntaxKind.AsteriskToken) ||
    (parent.kind === SyntaxKind.NamedExports && contextToken.kind === SyntaxKind.CloseBraceToken)
  ) {
    result.isKeywordOnlyCompletion = true;
    result.keywordCompletion = SyntaxKind.FromKeyword;
  } else if (contextToken.kind === SyntaxKind.ImportKeyword) {
    if (parent.kind === SyntaxKind.SourceFile) {
      // A lone `import` doesn't parse as a statement.
      result.keywordCompletion = SyntaxKind.TypeKeyword;
      candidate = contextToken;
    } else if (parent instanceof ImportDeclaration) {
      // `import s| from`
      result.keywordCompletion = SyntaxKind.TypeKeyword;
      if (isModuleSpecifierMissingOrEmpty(parent.moduleSpecifier)) candidate = parent;
    }
  }
  if (candidate !== undefined) {
    result.isNewIdentifierLocation = true;
    result.hasReplacementSpan = hasSingleLineReplacementSpanForImportCompletionNode(candidate, file);
    result.couldBeTypeOnlyImportSpecifier = couldBeTypeOnlyImportSpecifier(candidate, contextToken);
    if (candidate instanceof ImportDeclaration) {
      const clause = getImportClause(candidate);
      if (clause instanceof ImportClause) result.isTopLevelTypeOnly = importClauseIsTypeOnly(clause);
    } else if (candidate instanceof ImportEqualsDeclaration) result.isTopLevelTypeOnly = candidate.isTypeOnly;
  } else result.isNewIdentifierLocation = result.keywordCompletion === SyntaxKind.TypeKeyword;
  return result;
}

function importClauseIsTypeOnly(clause: ImportClause): boolean {
  return clause.phaseModifier === SyntaxKind.TypeKeyword;
}

function hasSingleLineReplacementSpanForImportCompletionNode(nodeIn: Node, file: SourceFile): boolean {
  const ancestor = findAncestor(
    nodeIn,
    (n) =>
      n.kind === SyntaxKind.ImportDeclaration ||
      n.kind === SyntaxKind.ImportEqualsDeclaration ||
      n.kind === SyntaxKind.JSDocImportTag,
  );
  const node = ancestor ?? nodeIn;
  const tokenPos = getStartOfNode(node, file, false);
  if (getLinesBetweenPositions(file, tokenPos, node.end) === 0) return true;
  // Parser recovery may have made a later statement part of the import.
  let potentialSplitPoint: Node | undefined;
  if (node instanceof ImportDeclaration || node.kind === SyntaxKind.JSDocImportTag) {
    const importClause = getImportClause(node);
    const specifier =
      importClause instanceof ImportClause
        ? getPotentiallyInvalidImportSpecifier(importClause.namedBindings)
        : undefined;
    potentialSplitPoint = specifier ?? getModuleSpecifier(node);
  } else potentialSplitPoint = (node as ImportEqualsDeclaration).moduleReference;
  const first = getFirstToken(node, file);
  const start = first !== undefined ? getStartOfNode(first, file, false) : tokenPos;
  return getLinesBetweenPositions(file, start, potentialSplitPoint!.pos) === 0;
}

function couldBeTypeOnlyImportSpecifier(importSpecifier: Node, contextToken: Node): boolean {
  return (
    importSpecifier instanceof ImportSpecifier &&
    (importSpecifier.isTypeOnly ||
      (contextToken === importSpecifier.name && isTypeKeywordTokenOrIdentifier(contextToken)))
  );
}

function canCompleteFromNamedBindings(namedBindings: Node): boolean {
  const importClause = namedBindings.parent as ImportClause;
  if (!isModuleSpecifierMissingOrEmpty(getModuleSpecifier(importClause.parent!)) || importClause.name !== undefined)
    return false;
  if (namedBindings instanceof NamedImports) {
    // Parser recovery may have put later statements in the list; count the valid imports.
    const invalidNamedImport = getPotentiallyInvalidImportSpecifier(namedBindings);
    const elements = namedBindings.elements.nodes;
    const validImports = invalidNamedImport !== undefined ? elements.indexOf(invalidNamedImport) : elements.length;
    return validImports < 2 && validImports > -1;
  }
  return true;
}

/** In `import { Foo|\ninterface Bar {}`, the first specifier that is really a statement. */
function getPotentiallyInvalidImportSpecifier(namedBindings: Node | undefined): Node | undefined {
  if (!(namedBindings instanceof NamedImports)) return undefined;
  const file = getSourceFileOfNode(namedBindings);
  for (const e of namedBindings.elements.nodes) {
    const specifier = e as ImportSpecifier;
    if (
      specifier.propertyName === undefined &&
      isNonContextualKeyword(stringToToken(specifier.name.text)) &&
      findPrecedingToken(file, specifier.name.pos)?.kind !== SyntaxKind.CommaToken
    )
      return e;
  }
  return undefined;
}

function isModuleSpecifierMissingOrEmpty(specifier: Node | undefined): boolean {
  if (specifier === undefined || nodeIsMissing(specifier)) return true;
  let node = specifier;
  if (node instanceof ExternalModuleReference) node = node.expression;
  if (!isStringLiteralLike(node)) return true;
  return getText(node) === '';
}

// ---- Contextual types

function getContextualTypeForConditionalExpression(
  c: Checker,
  conditional: Node,
  position: number,
  file: SourceFile,
): Type | undefined {
  const argInfo = getArgumentInfoForCompletions(c, conditional, position, file);
  if (argInfo !== undefined) return getContextualTypeForArgumentAtIndex(c, argInfo.invocation, argInfo.argumentIndex);
  return (
    getContextualTypeWithFlags(c, conditional, ContextFlags.Completions) ??
    getContextualTypeWithFlags(c, conditional, ContextFlags.None)
  );
}

function getContextualTypeForCompletions(
  c: Checker,
  previousToken: Node,
  position: number,
  file: SourceFile,
): Type | undefined {
  const parent = previousToken.parent!;
  switch (previousToken.kind) {
    case SyntaxKind.Identifier:
      return getContextualTypeFromParent(c, previousToken, ContextFlags.None);
    case SyntaxKind.EqualsToken:
      switch (parent.kind) {
        case SyntaxKind.VariableDeclaration:
          return getContextualTypeWithFlags(c, getInitializer(parent)!, ContextFlags.None);
        case SyntaxKind.BinaryExpression:
          return getTypeAtLocation(c, (parent as BinaryExpression).left);
        case SyntaxKind.JsxAttribute:
          return getContextualTypeForJsxAttribute(c, parent, ContextFlags.None);
      }
      return undefined;
    case SyntaxKind.NewKeyword:
      return getContextualTypeWithFlags(c, parent, ContextFlags.None);
    case SyntaxKind.CaseKeyword:
      return parent.kind === SyntaxKind.CaseClause ? getSwitchedType(c, parent) : undefined;
    case SyntaxKind.OpenBraceToken:
      if (
        parent.kind === SyntaxKind.JsxExpression &&
        parent.parent!.kind !== SyntaxKind.JsxElement &&
        parent.parent!.kind !== SyntaxKind.JsxFragment
      )
        return getContextualTypeForJsxAttribute(c, parent.parent!, ContextFlags.None);
      return undefined;
    case SyntaxKind.OpenBracketToken:
      // `[/*here*/]`: the first element's contextual type.
      if (parent instanceof ArrayLiteralExpression) {
        const contextualArrayType = getContextualTypeWithFlags(c, parent, ContextFlags.None);
        if (contextualArrayType !== undefined)
          return getContextualTypeForArrayLiteralAtPosition(c, contextualArrayType, parent, position);
      }
      return undefined;
    case SyntaxKind.CloseBracketToken:
      return undefined;
    case SyntaxKind.QuestionToken:
      if (parent.kind === SyntaxKind.ConditionalExpression)
        return getContextualTypeForConditionalExpression(c, parent, position, file);
      return undefined;
    case SyntaxKind.ColonToken:
      if (parent.kind === SyntaxKind.ConditionalExpression)
        return getContextualTypeForConditionalExpression(c, parent, position, file);
      break;
    case SyntaxKind.CommaToken:
      if (parent instanceof ArrayLiteralExpression) {
        const contextualArrayType = getContextualTypeWithFlags(c, parent, ContextFlags.None);
        if (contextualArrayType !== undefined)
          return getContextualTypeForArrayLiteralAtPosition(c, contextualArrayType, parent, position);
        return undefined;
      }
      break;
  }
  // In an argument position?
  const argInfo = getArgumentInfoForCompletions(c, previousToken, position, file);
  if (argInfo !== undefined) return getContextualTypeForArgumentAtIndex(c, argInfo.invocation, argInfo.argumentIndex);
  if (
    isEqualityOperatorKind(previousToken.kind) &&
    parent instanceof BinaryExpression &&
    isEqualityOperatorKind(parent.operatorToken.kind)
  )
    // `x ===/**/`
    return getTypeAtLocation(c, parent.left);
  return (
    getContextualTypeWithFlags(c, previousToken, ContextFlags.Completions) ??
    getContextualTypeWithFlags(c, previousToken, ContextFlags.None)
  );
}

// ---- Keywords

function getKeywordCompletions(filter: KeywordCompletionFilters, filterOutTsOnlyKeywords: boolean): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  for (let kind = SyntaxKind.FirstKeyword; kind <= SyntaxKind.LastKeyword; kind++) {
    if (!keywordMatchesFilter(kind, filter)) continue;
    if (filterOutTsOnlyKeywords && isTypeScriptOnlyKeyword(kind)) continue;
    entries.push({ name: tokenToString(kind), kind: CompletionItemKind.Keyword, sortText: SortText.GlobalsOrKeywords });
  }
  return entries;
}

function keywordMatchesFilter(kind: SyntaxKind, filter: KeywordCompletionFilters): boolean {
  switch (filter) {
    case KeywordCompletionFilters.None:
      return false;
    case KeywordCompletionFilters.All:
      return (
        isFunctionLikeBodyKeyword(kind) ||
        kind === SyntaxKind.DeclareKeyword ||
        kind === SyntaxKind.ModuleKeyword ||
        kind === SyntaxKind.TypeKeyword ||
        kind === SyntaxKind.NamespaceKeyword ||
        kind === SyntaxKind.AbstractKeyword ||
        (isTypeKeyword(kind) && kind !== SyntaxKind.UndefinedKeyword)
      );
    case KeywordCompletionFilters.FunctionLikeBodyKeywords:
      return isFunctionLikeBodyKeyword(kind);
    case KeywordCompletionFilters.ClassElementKeywords:
      return isClassMemberCompletionKeyword(kind);
    case KeywordCompletionFilters.InterfaceElementKeywords:
      return isInterfaceOrTypeLiteralCompletionKeyword(kind);
    case KeywordCompletionFilters.ConstructorParameterKeywords:
      return isParameterPropertyModifier(kind);
    case KeywordCompletionFilters.TypeAssertionKeywords:
      return isTypeKeyword(kind) || kind === SyntaxKind.ConstKeyword;
    case KeywordCompletionFilters.TypeKeywords:
      return isTypeKeyword(kind);
    case KeywordCompletionFilters.TypeKeyword:
      return kind === SyntaxKind.TypeKeyword;
  }
  return false;
}

function isTypeScriptOnlyKeyword(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.AbstractKeyword:
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.BigIntKeyword:
    case SyntaxKind.BooleanKeyword:
    case SyntaxKind.DeclareKeyword:
    case SyntaxKind.EnumKeyword:
    case SyntaxKind.GlobalKeyword:
    case SyntaxKind.ImplementsKeyword:
    case SyntaxKind.InferKeyword:
    case SyntaxKind.InterfaceKeyword:
    case SyntaxKind.IsKeyword:
    case SyntaxKind.KeyOfKeyword:
    case SyntaxKind.ModuleKeyword:
    case SyntaxKind.NamespaceKeyword:
    case SyntaxKind.NeverKeyword:
    case SyntaxKind.NumberKeyword:
    case SyntaxKind.ObjectKeyword:
    case SyntaxKind.OverrideKeyword:
    case SyntaxKind.PrivateKeyword:
    case SyntaxKind.ProtectedKeyword:
    case SyntaxKind.PublicKeyword:
    case SyntaxKind.ReadonlyKeyword:
    case SyntaxKind.StringKeyword:
    case SyntaxKind.SymbolKeyword:
    case SyntaxKind.TypeKeyword:
    case SyntaxKind.UniqueKeyword:
    case SyntaxKind.UnknownKeyword:
      return true;
  }
  return false;
}

function isFunctionLikeBodyKeyword(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.AsyncKeyword ||
    kind === SyntaxKind.AwaitKeyword ||
    kind === SyntaxKind.UsingKeyword ||
    kind === SyntaxKind.AsKeyword ||
    kind === SyntaxKind.SatisfiesKeyword ||
    kind === SyntaxKind.TypeKeyword ||
    (!isContextualKeyword(kind) && !isClassMemberCompletionKeyword(kind))
  );
}

function isClassMemberCompletionKeyword(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.AbstractKeyword:
    case SyntaxKind.AccessorKeyword:
    case SyntaxKind.ConstructorKeyword:
    case SyntaxKind.GetKeyword:
    case SyntaxKind.SetKeyword:
    case SyntaxKind.AsyncKeyword:
    case SyntaxKind.DeclareKeyword:
    case SyntaxKind.OverrideKeyword:
      return true;
  }
  return isClassMemberModifier(kind);
}

function isInterfaceOrTypeLiteralCompletionKeyword(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.ReadonlyKeyword;
}

function isContextualKeywordInAutoImportableExpressionSpace(keyword: string): boolean {
  switch (keyword) {
    case 'abstract':
    case 'async':
    case 'await':
    case 'declare':
    case 'module':
    case 'namespace':
    case 'type':
    case 'satisfies':
    case 'as':
      return true;
  }
  return false;
}

function getContextualKeywords(file: SourceFile, contextToken: Node | undefined, position: number): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  // `assert` can follow the module specifier of an import or re-export.
  if (contextToken !== undefined) {
    const parent = contextToken.parent!;
    if (
      (parent.kind === SyntaxKind.ImportDeclaration ||
        (parent.kind === SyntaxKind.ExportDeclaration && getModuleSpecifier(parent) !== undefined)) &&
      contextToken === getModuleSpecifier(parent) &&
      getLineOfPosition(file, contextToken.end) === getLineOfPosition(file, position)
    )
      entries.push({ name: 'assert', kind: CompletionItemKind.Keyword, sortText: SortText.GlobalsOrKeywords });
  }
  return entries;
}

// ---- Completion items

function completionInfoFromData(
  c: Checker,
  options: CompilerOptions,
  file: SourceFile,
  data: CompletionData,
  position: number,
  includeSymbols: boolean,
): CompletionList | undefined {
  const contextToken = data.contextToken;
  if (file.languageVariant === LanguageVariant.JSX) {
    const closingTag = getJsxClosingTagCompletion(data.location, file, position);
    if (closingTag !== undefined) return closingTag;
  }
  let literals = data.literals;
  // At `case |`, values that already have a clause are left out.
  const caseClause = findAncestor(contextToken, (n) => n.kind === SyntaxKind.CaseClause);
  if (
    caseClause !== undefined &&
    contextToken !== undefined &&
    (contextToken.kind === SyntaxKind.CaseKeyword || isNodeDescendantOf(contextToken, getExpression(caseClause)))
  ) {
    const tracker = new CaseClauseTracker(c, (caseClause.parent as CaseBlock).clauses.nodes);
    literals = literals.filter((l) => !trackerHasLiteral(tracker, l));
    data.symbols = data.symbols.filter((symbol) => {
      const declaration = symbol.valueDeclaration;
      if (declaration !== undefined && declaration.kind === SyntaxKind.EnumMember) {
        const value = getConstantValue(c, declaration);
        if (typeof value === 'string' && tracker.hasString(value)) return false;
        if (typeof value === 'number' && tracker.hasNumber(value)) return false;
      }
      return true;
    });
  }
  const isChecked = isCheckedFile(file, options);
  if (
    isChecked &&
    !data.isNewIdentifierLocation &&
    data.symbols.length === 0 &&
    data.keywordFilters === KeywordCompletionFilters.None
  )
    return undefined;
  const { uniqueNames, entries } = getCompletionEntriesFromSymbols(
    c,
    options,
    data,
    undefined,
    position,
    file,
    includeSymbols,
  );
  if (data.keywordFilters !== KeywordCompletionFilters.None) {
    for (const keywordEntry of getKeywordCompletions(
      data.keywordFilters,
      !data.insideJSDocTagTypeExpression && isSourceFileJS(file),
    )) {
      if (
        (data.isTypeOnlyLocation && isTypeKeyword(stringToToken(keywordEntry.name))) ||
        (!data.isTypeOnlyLocation && isContextualKeywordInAutoImportableExpressionSpace(keywordEntry.name)) ||
        !uniqueNames.has(keywordEntry.name)
      ) {
        uniqueNames.add(keywordEntry.name);
        entries.push(keywordEntry);
      }
    }
  }
  for (const keywordEntry of getContextualKeywords(file, contextToken, position)) {
    if (!uniqueNames.has(keywordEntry.name)) {
      uniqueNames.add(keywordEntry.name);
      entries.push(keywordEntry);
    }
  }
  for (const literal of literals) {
    const name = completionNameForLiteral(file, literal);
    uniqueNames.add(name);
    entries.push({ name, kind: CompletionItemKind.Constant, sortText: SortText.LocationPriority });
  }
  if (!isChecked) getJSCompletionEntries(file, position, uniqueNames, entries);
  if (contextToken !== undefined && !data.isRightOfOpenTag && !data.isRightOfDotOrQuestionDot) {
    const caseBlock = findAncestor(contextToken, (n) => n.kind === SyntaxKind.CaseBlock);
    if (caseBlock !== undefined) {
      const snippet = getExhaustiveCaseSnippets(c, caseBlock as CaseBlock, file, data);
      if (snippet !== undefined) entries.push(snippet);
    }
  }
  return { isIncomplete: false, entries };
}

/**
 * For a switch over a union of literals and enum members, the `case` clauses of the values without one, as one
 * snippet. It needs prepared auto-imports, and throws `NeedsAutoImports` without them.
 */
function getExhaustiveCaseSnippets(
  c: Checker,
  caseBlock: CaseBlock,
  file: SourceFile,
  data: CompletionData,
): CompletionEntry | undefined {
  const switchType = getTypeAtLocation(c, getExpression(caseBlock.parent!)!);
  if ((switchType.flags & TypeFlags.Union) === 0 || !typesOf(switchType).every(isLiteral)) return undefined;
  data.onAutoImportsNeeded();
  if (!data.autoImportsPrepared) throw new NeedsAutoImports();
  const tracker = new CaseClauseTracker(c, caseBlock.clauses.nodes);
  const singleQuote = getQuotePreference(file) === QuotePreference.Single;
  const factory = new EmitContext();
  const elements: Node[] = [];
  for (const t of typesOf(switchType)) {
    if ((t.flags & TypeFlags.EnumLiteral) !== 0) {
      // An enum member, unless a clause has its value, written as tsc writes its type.
      const declaration = t.symbol?.valueDeclaration;
      const value = declaration === undefined ? undefined : getConstantValue(c, declaration);
      if (typeof value === 'string') {
        if (tracker.hasString(value)) continue;
        tracker.addString(value);
      } else if (typeof value === 'number') {
        if (tracker.hasNumber(value)) continue;
        tracker.addNumber(value);
      }
      const typeNode = typeToAutoImportableTypeNode(c, t, caseBlock, factory);
      if (typeNode === undefined) return undefined;
      const expression = typeNodeToExpression(typeNode, singleQuote, factory);
      if (expression === undefined) return undefined;
      elements.push(expression);
      continue;
    }
    const literal = literalValueOf(t);
    if (trackerHasLiteral(tracker, literal)) continue;
    switch (literal.kind) {
      case 'bigint': {
        const negative = literal.text.startsWith('-');
        const digits = negative ? literal.text.slice(1) : literal.text;
        const bigInt = factory.created(new BigIntLiteral(digits + 'n', TokenFlags.None));
        elements.push(negative ? factory.created(new PrefixUnaryExpression(SyntaxKind.MinusToken, bigInt)) : bigInt);
        break;
      }
      case 'number': {
        const value = literal.number;
        const number = factory.createNumericLiteral(String(Math.abs(value)));
        elements.push(value < 0 ? factory.created(new PrefixUnaryExpression(SyntaxKind.MinusToken, number)) : number);
        break;
      }
      case 'string':
        elements.push(
          factory.createStringLiteral(literal.text, singleQuote ? TokenFlags.SingleQuote : TokenFlags.None),
        );
        break;
    }
  }
  if (elements.length === 0) return undefined;
  const options = new PrinterOptions();
  options.removeComments = true;
  const printer = new Printer(options, factory);
  const clauses = elements.map((element) =>
    printer.emit(
      factory.created(new CaseOrDefaultClause(SyntaxKind.CaseClause, element, new NodeList(-1, -1, []))),
      undefined,
    ),
  );
  return {
    name: clauses[0] + ' ...',
    kind: CompletionItemKind.Snippet,
    sortText: SortText.GlobalsOrKeywords,
    insertText: clauses.join('\n'),
  };
}

/**
 * The type node of `t` with import types (`import("./a").E.A`) written as references to the names they import
 * (`E.A`), as tsgo's TypeToAutoImportableTypeNode writes them. The imports it adds for those names are text edits,
 * which completion answers do not include.
 */
function typeToAutoImportableTypeNode(c: Checker, t: Type, contextNode: Node, factory: EmitContext): Node | undefined {
  const idToSymbol = new Map<Node, Symbol>();
  const typeNode = typeToTypeNode(c, t, contextNode, 0, NodeBuilderInternalFlags.None, undefined, idToSymbol);
  return typeNode === undefined ? undefined : toImportableReference(typeNode, idToSymbol, factory);
}

// The import types of a type node, where an expression can be made of it, as references.
function toImportableReference(node: Node, idToSymbol: ReadonlyMap<Node, Symbol>, factory: EmitContext): Node {
  if (node instanceof ImportTypeNode && node.qualifier !== undefined && isLiteralImportTypeArgument(node.argument)) {
    const first = getFirstIdentifier(node.qualifier);
    const symbol = idToSymbol.get(first);
    // An import type the builder copied from source names what it imports itself.
    if (symbol === undefined) return node;
    const name = getNameForExportedSymbol(symbol);
    const qualifier =
      name !== first.text
        ? replaceFirstIdentifier(node.qualifier, factory.createIdentifier(name), factory)
        : node.qualifier;
    return factory.created(new TypeReferenceNode(qualifier, node.typeArguments));
  }
  if (node instanceof IndexedAccessTypeNode) {
    return factory.created(
      new IndexedAccessTypeNode(
        toImportableReference(node.objectType, idToSymbol, factory),
        toImportableReference(node.indexType, idToSymbol, factory),
      ),
    );
  }
  if (node instanceof ParenthesizedTypeNode) {
    return factory.created(new ParenthesizedTypeNode(toImportableReference(node.type, idToSymbol, factory)));
  }
  return node;
}

function isLiteralImportTypeArgument(argument: Node): boolean {
  return argument instanceof LiteralTypeNode && argument.literal.kind === SyntaxKind.StringLiteral;
}

function replaceFirstIdentifier(name: Node, identifier: Identifier, factory: EmitContext): Node {
  if (name instanceof QualifiedName) {
    return factory.created(new QualifiedName(replaceFirstIdentifier(name.left, identifier, factory), name.right));
  }
  return identifier;
}

/** The name an exported symbol is imported by: a default export's local or file name, else its own. */
function getNameForExportedSymbol(symbol: Symbol): string {
  if (symbol.name === InternalSymbolName.ExportEquals || symbol.name === InternalSymbolName.Default) {
    const name = getDefaultLikeExportNameFromDeclaration(symbol);
    if (name !== '') return name;
    const moduleName = symbol.parent!.name;
    return moduleSpecifierToValidIdentifier(tryGetAmbientModuleNameFromSymbolName(moduleName) ?? moduleName, false);
  }
  return symbol.name;
}

/** The expression a type node names: `E.A`, `E['a-b']`, a literal, or undefined for other type nodes. */
function typeNodeToExpression(typeNode: Node, singleQuote: boolean, factory: EmitContext): Node | undefined {
  switch (typeNode.kind) {
    case SyntaxKind.TypeReference:
      return entityNameToExpression((typeNode as TypeReferenceNode).typeName, factory);
    case SyntaxKind.IndexedAccessType: {
      const object = typeNodeToExpression((typeNode as IndexedAccessTypeNode).objectType, singleQuote, factory);
      const index = typeNodeToExpression((typeNode as IndexedAccessTypeNode).indexType, singleQuote, factory);
      if (object === undefined || index === undefined) return undefined;
      return factory.created(new ElementAccessExpression(object, undefined, index, NodeFlags.None));
    }
    case SyntaxKind.LiteralType: {
      const literal = (typeNode as LiteralTypeNode).literal;
      if (literal instanceof StringLiteral)
        return factory.createStringLiteral(literal.text, singleQuote ? TokenFlags.SingleQuote : TokenFlags.None);
      if (literal instanceof NumericLiteral)
        return factory.created(new NumericLiteral(literal.text, literal.tokenFlags));
      return undefined;
    }
    case SyntaxKind.ParenthesizedType: {
      const expression = typeNodeToExpression((typeNode as ParenthesizedTypeNode).type, singleQuote, factory);
      if (expression === undefined) return undefined;
      return expression instanceof Identifier ? expression : factory.created(new ParenthesizedExpression(expression));
    }
    case SyntaxKind.TypeQuery:
      return entityNameToExpression((typeNode as TypeQueryNode).exprName, factory);
  }
  return undefined;
}

function entityNameToExpression(name: Node, factory: EmitContext): Node {
  if (name instanceof QualifiedName) {
    return factory.created(
      new PropertyAccessExpression(entityNameToExpression(name.left, factory), undefined, name.right, NodeFlags.None),
    );
  }
  return name;
}

function trackerHasLiteral(tracker: CaseClauseTracker, literal: LiteralValue): boolean {
  if (literal.kind === 'string') return tracker.hasString(literal.text);
  if (literal.kind === 'number') return tracker.hasNumber(literal.number);
  return tracker.hasBigInt(literal.text);
}

function completionNameForLiteral(file: SourceFile, literal: LiteralValue): string {
  if (literal.kind === 'string') return quote(file, literal.text);
  if (literal.kind === 'number') return formatJsonNumber(literal.number);
  return literal.text + 'n';
}

/** A number as Go's encoding/json writes it. */
function formatJsonNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e21)) {
    // Exponent form, without a leading `+` or zero padding.
    let text = n.toExponential();
    const e = text.indexOf('e');
    let mantissa = text.substring(0, e);
    let exponent = text.substring(e + 1);
    if (exponent.startsWith('+')) exponent = exponent.substring(1);
    const negative = exponent.startsWith('-');
    if (negative) exponent = exponent.substring(1);
    if (exponent.length < 2) exponent = '0' + exponent;
    text = mantissa + 'e' + (negative ? '-' : '+') + exponent;
    mantissa = '';
    return text;
  }
  return String(n);
}

function getJSCompletionEntries(
  file: SourceFile,
  position: number,
  uniqueNames: Set<string>,
  entries: CompletionEntry[],
): void {
  for (const [name, pos] of getNameTable(file)) {
    // Identifiers only at the current location are skipped.
    if (pos === position) continue;
    if (!uniqueNames.has(name) && isIdentifierText(name, LanguageVariant.Standard)) {
      uniqueNames.add(name);
      entries.push({ name, kind: CompletionItemKind.Text, sortText: SortText.JavascriptIdentifiers });
    }
  }
}

import { getNameTable } from './name-table.js';

interface EntriesResult {
  uniqueNames: Set<string>;
  entries: CompletionEntry[];
}

export function getCompletionEntriesFromSymbols(
  c: Checker,
  options: CompilerOptions,
  data: CompletionData,
  replacementToken: Node | undefined,
  position: number,
  file: SourceFile,
  includeSymbols: boolean,
): EntriesResult {
  const entries: CompletionEntry[] = [];
  const closestSymbolDeclaration = getClosestSymbolDeclaration(data.contextToken, data.location);
  // Whether each name is taken by a symbol that shadows later ones with the same name.
  const uniques = new Map<string, boolean>();
  for (let index = 0; index < data.symbols.length; index++) {
    const symbol = data.symbols[index];
    const origin = data.symbolToOriginInfoMap.get(index);
    const display = getCompletionEntryDisplayNameForSymbol(
      file,
      symbol,
      origin,
      data.completionKind,
      data.isJsxIdentifierExpected,
    );
    const name = display.name;
    if (
      name === '' ||
      (uniques.get(name) === true &&
        (origin === undefined || (origin.kind & SymbolOriginInfoKind.ObjectLiteralMethod) === 0)) ||
      (data.completionKind === CompletionKind.Global &&
        !shouldIncludeSymbol(c, symbol, data, closestSymbolDeclaration, file, options))
    )
      continue;
    // In JavaScript value locations, symbols that seem type-only are skipped.
    if (!data.isTypeOnlyLocation && isSourceFileJS(file) && symbolAppearsToBeTypeOnly(c, symbol)) continue;
    const originalSortText = data.symbolToSortTextMap.get(getSymbolId(symbol)) ?? SortText.LocationPriority;
    const sortText = isDeprecated(c, symbol) ? deprecateSortText(originalSortText) : originalSortText;
    const entry = createCompletionItem(
      c,
      symbol,
      sortText,
      replacementToken,
      data,
      position,
      file,
      name,
      display.needsConvertPropertyAccess,
      origin,
    );
    if (entry === undefined) continue;
    // Locals shadow globals, module exports from other files and `this.` completions.
    const shouldShadowLaterSymbols =
      (origin === undefined || (origin.kind & SymbolOriginInfoKind.TypeOnlyAlias) !== 0) &&
      !(symbol.parent === undefined && !getDeclarations(symbol).some((d) => getSourceFileOfNode(d) === file));
    uniques.set(name, shouldShadowLaterSymbols);
    if (includeSymbols) entry.symbol = symbol;
    entries.push(entry);
  }
  const useSemicolons = probablyUsesSemicolons(file);
  for (const { fix, exported } of data.autoImports) {
    let insertText = '';
    let filterText = '';
    let sortText: string = SortText.AutoImportSuggestions;
    const importStatementCompletion = data.importStatementCompletion;
    if (importStatementCompletion !== undefined) {
      insertText = getInsertTextForImportCompletion(
        fix.name,
        fix.moduleSpecifier,
        data.autoImportView!.getImportKind(exported, true),
        importStatementCompletion,
        useSemicolons,
        file,
      );
      // The text the client filters is the import statement being written, not just the name.
      filterText = insertText;
      sortText = SortText.LocationPriority;
    }
    // A non-contextual keyword can't be an identifier, so it doesn't shadow the keyword completion.
    if (isNonContextualKeyword(stringToToken(fix.name))) continue;
    if (!exported.isUnresolvedAlias()) {
      if (data.isTypeOnlyLocation) {
        if ((exported.flags & (SymbolFlags.Type | SymbolFlags.Module)) === 0) continue;
      } else if (importStatementCompletion === undefined && (exported.flags & SymbolFlags.Value) === 0) continue;
    }
    const entry = createEntry(
      fix.name,
      insertText,
      filterText,
      sortText,
      exported.scriptElementKind,
      false,
      file,
      position,
    );
    entry.labelDetails = { description: fix.moduleSpecifier };
    if (uniques.get(fix.name) !== true) {
      uniques.set(fix.name, false);
      entries.push(entry);
    }
  }
  return { uniqueNames: new Set(uniques.keys()), entries };
}

/** The import statement an import statement completion inserts. */
function getInsertTextForImportCompletion(
  nameIn: string,
  moduleSpecifier: string,
  importKind: ImportKind,
  info: ImportStatementCompletionInfo,
  useSemicolons: boolean,
  file: SourceFile,
): string {
  const quotedModuleSpecifier = quote(file, moduleSpecifier);
  const suffix = useSemicolons ? ';' : '';
  const topLevelTypeOnlyText = info.isTopLevelTypeOnly ? ' type ' : ' ';
  const name = nameIn.replaceAll('$', '\\$');
  switch (importKind) {
    case ImportKind.CommonJS:
      return `import${topLevelTypeOnlyText}${name} = require(${quotedModuleSpecifier})${suffix}`;
    case ImportKind.Default:
      return `import${topLevelTypeOnlyText}${name} from ${quotedModuleSpecifier}${suffix}`;
    case ImportKind.Namespace:
      return `import${topLevelTypeOnlyText}* as ${name} from ${quotedModuleSpecifier}${suffix}`;
    case ImportKind.Named:
      return `import${topLevelTypeOnlyText}{ ${info.couldBeTypeOnlyImportSpecifier ? 'type ' : ''}${name} } from ${quotedModuleSpecifier}${suffix}`;
  }
}

/** Whether a global completion offers `symbol` at the completion's location. */
function shouldIncludeSymbol(
  c: Checker,
  symbol: Symbol,
  data: CompletionData,
  closestSymbolDeclaration: Node | undefined,
  file: SourceFile,
  options: CompilerOptions,
): boolean {
  let allFlags = symbol.flags;
  const location = data.location;
  // `export = |` takes every meaning.
  if (location.parent !== undefined && location.parent.kind === SyntaxKind.ExportAssignment) return true;
  // A variable isn't offered in its own initializer: `const a = |`.
  if (
    closestSymbolDeclaration !== undefined &&
    closestSymbolDeclaration.kind === SyntaxKind.VariableDeclaration &&
    symbol.valueDeclaration === closestSymbolDeclaration
  )
    return false;
  // The current and later parameters aren't offered in a default: `function f(a = |, b) {}`,
  // `function f<T = |>(a: T, b: T2) {}`.
  const symbolDeclaration = symbol.valueDeclaration ?? getDeclarations(symbol)[0];
  if (closestSymbolDeclaration !== undefined && symbolDeclaration !== undefined) {
    if (closestSymbolDeclaration.kind === SyntaxKind.Parameter && symbolDeclaration.kind === SyntaxKind.Parameter) {
      const parameters = getParameters(closestSymbolDeclaration.parent!)!;
      if (symbolDeclaration.pos >= closestSymbolDeclaration.pos && symbolDeclaration.pos < parameters.end) return false;
    } else if (
      closestSymbolDeclaration.kind === SyntaxKind.TypeParameter &&
      symbolDeclaration.kind === SyntaxKind.TypeParameter
    ) {
      // `type A<K extends |> = K` doesn't offer `K`.
      if (
        closestSymbolDeclaration === symbolDeclaration &&
        data.contextToken !== undefined &&
        data.contextToken.kind === SyntaxKind.ExtendsKeyword
      )
        return false;
      if (
        isInTypeParameterDefault(data.contextToken) &&
        closestSymbolDeclaration.parent!.kind !== SyntaxKind.InferType
      ) {
        const typeParameters = getTypeParameters(closestSymbolDeclaration.parent!);
        if (
          typeParameters !== undefined &&
          symbolDeclaration.pos >= closestSymbolDeclaration.pos &&
          symbolDeclaration.pos < typeParameters.end
        )
          return false;
      }
    }
  }
  // A module's global exports (`export as namespace`) give way to its auto-imports.
  const symbolOrigin = skipAlias(c, symbol);
  if (
    file.externalModuleIndicator !== undefined &&
    options.allowUmdGlobalAccess !== true &&
    symbol !== symbolOrigin &&
    data.symbolToSortTextMap.get(getSymbolId(symbol)) === SortText.GlobalsOrKeywords &&
    symbol.parent !== undefined &&
    isExternalModuleSymbol(symbol.parent)
  )
    return false;
  allFlags |= symbolOrigin.combinedLocalAndExportSymbolFlags();
  if ((symbol.flags & SymbolFlags.Alias) !== 0) allFlags |= getSymbolFlags(c, symbol);
  // `import m = |` takes a namespace.
  if (isInRightSideOfInternalImportEqualsDeclaration(location)) return (allFlags & SymbolFlags.Namespace) !== 0;
  // A type, or a namespace that leads to one.
  if (data.isTypeOnlyLocation) return symbolCanBeReferencedAtTypeLocation(c, symbol, new Set());
  return (allFlags & SymbolFlags.Value) !== 0;
}

function getClosestSymbolDeclaration(contextToken: Node | undefined, location: Node): Node | undefined {
  if (contextToken === undefined) return undefined;
  const quit = (node: Node): boolean =>
    isFunctionBlock(node) || isArrowFunctionBody(node) || isBindingPatternNode(node);
  const closest = findAncestorOrQuit(contextToken, (node) => {
    if (quit(node)) return FindAncestorResult.Quit;
    if (
      (node.kind === SyntaxKind.Parameter || node.kind === SyntaxKind.TypeParameter) &&
      node.parent!.kind !== SyntaxKind.IndexSignature
    )
      return FindAncestorResult.True;
    return FindAncestorResult.False;
  });
  if (closest !== undefined) return closest;
  return findAncestorOrQuit(location, (node) => {
    if (quit(node)) return FindAncestorResult.Quit;
    return node.kind === SyntaxKind.VariableDeclaration ? FindAncestorResult.True : FindAncestorResult.False;
  });
}

function isArrowFunctionBody(node: Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    parent.kind === SyntaxKind.ArrowFunction &&
    // `const a = () => |;`
    (getBody(parent) === node || node.kind === SyntaxKind.EqualsGreaterThanToken)
  );
}

function isBindingPatternNode(node: Node): boolean {
  return node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern;
}

function isInTypeParameterDefault(contextToken: Node | undefined): boolean {
  if (contextToken === undefined) return false;
  let node = contextToken;
  let parent = contextToken.parent;
  while (parent !== undefined) {
    if (parent instanceof TypeParameterDeclaration)
      return parent.defaultType === node || node.kind === SyntaxKind.EqualsToken;
    node = parent;
    parent = parent.parent;
  }
  return false;
}

/** The function whose body holds the context token, unless a class is in between. */
function tryGetFunctionLikeBodyCompletionContainer(contextToken: Node | undefined): Node | undefined {
  if (contextToken === undefined) return undefined;
  let prev: Node | undefined;
  return findAncestorOrQuit(contextToken, (node) => {
    if (isClassLikeNode(node)) return FindAncestorResult.Quit;
    if (isFunctionLikeDeclarationKind(node.kind) && prev === getBody(node)) return FindAncestorResult.True;
    prev = node;
    return FindAncestorResult.False;
  });
}

/** The innermost node around the context token that `position` belongs to. */
function getScopeNode(initialToken: Node | undefined, position: number, file: SourceFile): Node | undefined {
  let scope = initialToken;
  while (scope !== undefined && !positionBelongsToNode(scope, position, file)) scope = scope.parent;
  return scope;
}

/** Whether a new name may be typed after the context token, as tsgo's computeCommitCharactersAndIsNewIdentifier finds. */
function computeIsNewIdentifierLocation(contextToken: Node | undefined): boolean {
  if (contextToken === undefined) return false;
  const containingNodeKind = contextToken.parent!.kind;
  const tokenKind = keywordForNode(contextToken);
  switch (tokenKind) {
    case SyntaxKind.CommaToken:
      switch (containingNodeKind) {
        case SyntaxKind.CallExpression:
        case SyntaxKind.NewExpression:
        case SyntaxKind.BinaryExpression:
        case SyntaxKind.Constructor:
        case SyntaxKind.FunctionType:
        case SyntaxKind.ObjectLiteralExpression:
        case SyntaxKind.ArrayLiteralExpression:
          return true;
      }
      return false;
    case SyntaxKind.OpenParenToken:
      switch (containingNodeKind) {
        case SyntaxKind.CallExpression:
        case SyntaxKind.NewExpression:
        case SyntaxKind.ParenthesizedExpression:
        case SyntaxKind.Constructor:
        case SyntaxKind.ParenthesizedType:
          return true;
      }
      return false;
    case SyntaxKind.OpenBracketToken:
      switch (containingNodeKind) {
        case SyntaxKind.ArrayLiteralExpression:
        case SyntaxKind.IndexSignature:
        case SyntaxKind.TupleType:
        case SyntaxKind.ComputedPropertyName:
          return true;
      }
      return false;
    case SyntaxKind.ModuleKeyword:
    case SyntaxKind.NamespaceKeyword:
    case SyntaxKind.ImportKeyword:
      return true;
    case SyntaxKind.DotToken:
      return containingNodeKind === SyntaxKind.ModuleDeclaration;
    case SyntaxKind.OpenBraceToken:
      return (
        containingNodeKind === SyntaxKind.ClassDeclaration || containingNodeKind === SyntaxKind.ObjectLiteralExpression
      );
    case SyntaxKind.EqualsToken:
      return (
        containingNodeKind === SyntaxKind.VariableDeclaration || containingNodeKind === SyntaxKind.BinaryExpression
      );
    case SyntaxKind.TemplateHead:
      return containingNodeKind === SyntaxKind.TemplateExpression;
    case SyntaxKind.TemplateMiddle:
      return containingNodeKind === SyntaxKind.TemplateSpan;
    case SyntaxKind.AsyncKeyword:
      return (
        containingNodeKind === SyntaxKind.MethodDeclaration ||
        containingNodeKind === SyntaxKind.ShorthandPropertyAssignment
      );
    case SyntaxKind.AsteriskToken:
      return containingNodeKind === SyntaxKind.MethodDeclaration;
  }
  return isClassMemberCompletionKeyword(tokenKind);
}

/** Whether `t` is the type of `self`, `global` or `globalThis`. */
function isProbablyGlobalType(c: Checker, t: Type, file: SourceFile): boolean {
  for (const name of ['self', 'global', 'globalThis']) {
    const symbol = getGlobalSymbol(c, name, SymbolFlags.Value, undefined);
    if (symbol !== undefined && getTypeOfSymbolAtLocation(c, symbol, file) === t) return true;
  }
  return false;
}

function isTypeOnlyImportDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportSpecifier:
      return (node as ImportSpecifier).isTypeOnly || importClauseIsTypeOnly(node.parent!.parent as ImportClause);
    case SyntaxKind.NamespaceImport:
      return importClauseIsTypeOnly(node.parent as ImportClause);
    case SyntaxKind.ImportClause:
      return importClauseIsTypeOnly(node as ImportClause);
    case SyntaxKind.ImportEqualsDeclaration:
      return (node as ImportEqualsDeclaration).isTypeOnly;
  }
  return false;
}

function symbolAppearsToBeTypeOnly(c: Checker, symbol: Symbol): boolean {
  const flags = skipAlias(c, symbol).combinedLocalAndExportSymbolFlags();
  return (
    (flags & SymbolFlags.Value) === 0 &&
    (declarationCount(symbol) === 0 || !isInJSFile(symbol.declaration) || (flags & SymbolFlags.Type) !== 0)
  );
}

function isDeprecated(c: Checker, symbol: Symbol): boolean {
  const declarations = getDeclarations(skipAlias(c, symbol));
  return declarations.length > 0 && declarations.every((d) => isDeprecatedDeclaration(d));
}

interface DisplayName {
  name: string;
  needsConvertPropertyAccess: boolean;
}

function getCompletionEntryDisplayNameForSymbol(
  file: SourceFile,
  symbol: Symbol,
  origin: SymbolOriginInfo | undefined,
  completionKind: CompletionKind,
  isJsxIdentifierExpected: boolean,
): DisplayName {
  const none: DisplayName = { name: '', needsConvertPropertyAccess: false };
  if (origin !== undefined && (origin.kind & SymbolOriginInfoKind.Ignore) !== 0) return none;
  const isComputed = origin !== undefined && (origin.kind & SymbolOriginInfoKind.ComputedPropertyName) !== 0;
  const name = isComputed ? origin.symbolName : symbolName(symbol);
  if (
    name === '' ||
    // External module symbols aren't completions.
    ((symbol.flags & SymbolFlags.Module) !== 0 && startsWithQuote(name)) ||
    // Nor are the internal names of ES symbols.
    isLateBoundName(symbol.name)
  )
    return none;
  const variant = isJsxIdentifierExpected ? LanguageVariant.JSX : LanguageVariant.Standard;
  if (
    isIdentifierText(name, variant) ||
    (symbol.valueDeclaration !== undefined && isPrivateIdentifierClassElementDeclaration(symbol.valueDeclaration))
  )
    return { name, needsConvertPropertyAccess: false };
  // Non-identifier import and export aliases can be written as string literals.
  if ((symbol.flags & SymbolFlags.Alias) !== 0) return { name, needsConvertPropertyAccess: true };
  switch (completionKind) {
    case CompletionKind.MemberLike:
      return isComputed ? { name: origin.symbolName, needsConvertPropertyAccess: false } : none;
    case CompletionKind.ObjectPropertyDeclaration:
      return { name: quote(file, name), needsConvertPropertyAccess: false };
    case CompletionKind.PropertyAccess:
    case CompletionKind.Global:
      // Names starting with a space aren't offered.
      if (name.charCodeAt(0) === 0x20) return none;
      return { name, needsConvertPropertyAccess: true };
  }
  return { name, needsConvertPropertyAccess: false };
}

// Whether a property name of JSX.IntrinsicElements can be written as an opening tag's name: a JSX identifier, or two
// joined by a colon (a namespaced name). An opening-tag completion inserts the name as it is, so another name, such
// as one that contains spaces, `=` or braces, would add its text to the tag.
function isJsxTagNameText(name: string): boolean {
  const colon = name.indexOf(':');
  if (colon < 0) return isIdentifierText(name, LanguageVariant.JSX);
  return (
    isIdentifierText(name.slice(0, colon), LanguageVariant.JSX) &&
    isIdentifierText(name.slice(colon + 1), LanguageVariant.JSX)
  );
}

function startsWithQuote(s: string): boolean {
  const ch = s.charCodeAt(0);
  return ch === 0x22 || ch === 0x27;
}

function createCompletionItem(
  c: Checker,
  symbol: Symbol,
  sortTextIn: string,
  replacementToken: Node | undefined,
  data: CompletionData,
  position: number,
  file: SourceFile,
  nameIn: string,
  needsConvertPropertyAccess: boolean,
  origin: SymbolOriginInfo | undefined,
): CompletionEntry | undefined {
  const name = nameIn;
  const sortText = sortTextIn;
  let insertText = '';
  const insertQuestionDot = origin !== undefined && (origin.kind & SymbolOriginInfoKind.Nullable) !== 0;
  const useBraces =
    (origin !== undefined && (origin.kind & SymbolOriginInfoKind.SymbolMember) !== 0) || needsConvertPropertyAccess;
  const propertyAccessToConvert = data.propertyAccessToConvert;
  if (origin !== undefined && (origin.kind & SymbolOriginInfoKind.ThisType) !== 0) {
    insertText = needsConvertPropertyAccess
      ? 'this' + (insertQuestionDot ? '?.' : '') + '[' + quotePropertyName(file, name) + ']'
      : 'this' + (insertQuestionDot ? '?.' : '.') + name;
  } else if (propertyAccessToConvert !== undefined && (useBraces || insertQuestionDot)) {
    if (useBraces)
      insertText = needsConvertPropertyAccess ? '[' + quotePropertyName(file, name) + ']' : '[' + name + ']';
    else insertText = name;
    if (insertQuestionDot || propertyAccessToConvert.questionDotToken !== undefined) insertText = '?.' + insertText;
    const dot =
      findChildOfKind(propertyAccessToConvert, SyntaxKind.DotToken, file) ??
      findChildOfKind(propertyAccessToConvert, SyntaxKind.QuestionDotToken, file);
    if (dot === undefined) return undefined;
  }
  if (data.isJsxInitializer) {
    if (insertText === '') insertText = name;
    insertText = '{' + insertText + '}';
  }
  if (
    origin !== undefined &&
    (origin.kind & SymbolOriginInfoKind.Promise) !== 0 &&
    propertyAccessToConvert !== undefined
  ) {
    if (insertText === '') insertText = name;
    const precedingToken = findPrecedingToken(file, propertyAccessToConvert.pos);
    let awaitText = '';
    if (precedingToken !== undefined && positionIsASICandidate(precedingToken.end, precedingToken.parent!, file))
      awaitText = ';';
    awaitText += '(await ' + getTextOfNodeFromSource(file, propertyAccessToConvert.expression) + ')';
    insertText = needsConvertPropertyAccess
      ? awaitText + insertText
      : awaitText + (insertQuestionDot ? '?.' : '.') + insertText;
  }
  // Named imports and exports with non-identifier names are quoted.
  const parentNamedImportOrExport = findAncestor(data.location, isNamedImportsOrExports);
  if (parentNamedImportOrExport !== undefined) {
    if (!isIdentifierText(name, LanguageVariant.Standard)) {
      insertText = quotePropertyName(file, name);
      if (parentNamedImportOrExport.kind === SyntaxKind.NamedImports) {
        // Unless it's `import { ^here as name }`.
        const scanner = new Scanner();
        scanner.setText(file.text);
        scanner.resetTokenState(position);
        if (!(scanner.scan() === SyntaxKind.AsKeyword && scanner.scan() === SyntaxKind.Identifier))
          insertText += ' as ' + generateIdentifierForArbitraryString(name);
      }
    } else if (parentNamedImportOrExport.kind === SyntaxKind.NamedImports) {
      const possibleToken = stringToToken(name);
      if (
        possibleToken !== SyntaxKind.Unknown &&
        (possibleToken === SyntaxKind.AwaitKeyword || isNonContextualKeyword(possibleToken))
      )
        insertText = name + ' as ' + name + '_';
    }
  }
  const elementKind = getSymbolKind(c, symbol, data.location);
  // A member's optional marker: the label of an optional member completion ends with `?`.
  const isMemberCompletion =
    data.completionKind === CompletionKind.ObjectPropertyDeclaration ||
    data.completionKind === CompletionKind.MemberLike ||
    data.completionKind === CompletionKind.PropertyAccess;
  const isOptional = isMemberCompletion && (symbol.flags & SymbolFlags.Optional) !== 0;
  return createEntry(name, insertText, '', sortText, elementKind, isOptional, file, position);
}

/** An entry with its filter text and optional marker, as tsgo's LSP item conversion makes it. */
export function createEntry(
  nameIn: string,
  insertTextIn: string,
  filterTextIn: string,
  sortText: string,
  elementKind: ScriptElementKind,
  isOptional: boolean,
  file: SourceFile,
  position: number,
  detail?: string,
): CompletionEntry {
  let name = nameIn;
  let insertText = insertTextIn;
  let filterText = filterTextIn;
  const word = getWordLengthAndStart(file, position);
  const dotAccessor = getDotAccessor(file, position - word.length);
  if (filterText === '') filterText = getFilterText(insertText, name, word.start, dotAccessor);
  if (isOptional) {
    if (insertText === '') insertText = name;
    if (filterText === '') filterText = name;
    name = name + '?';
  }
  const entry: CompletionEntry = { name, kind: getCompletionsSymbolKind(elementKind), sortText };
  if (insertText !== '') entry.insertText = insertText;
  if (filterText !== '') entry.filterText = filterText;
  if (detail !== undefined) entry.detail = detail;
  return entry;
}

function getTextOfNodeFromSource(file: SourceFile, node: Node): string {
  return file.text.substring(getStartOfNode(node, file, false), node.end);
}

function generateIdentifierForArbitraryString(text: string): string {
  let needsUnderscore = false;
  let identifier = '';
  for (let pos = 0; pos < text.length;) {
    const ch = text.codePointAt(pos)!;
    const size = ch > 0xffff ? 2 : 1;
    const valid = pos === 0 ? isIdentifierStartChar(ch) : isIdentifierPartChar(ch);
    if (valid) {
      if (needsUnderscore) identifier += '_';
      identifier += String.fromCodePoint(ch);
      needsUnderscore = false;
    } else needsUnderscore = true;
    pos += size;
  }
  if (needsUnderscore) identifier += '_';
  return identifier === '' ? '_' : identifier;
}

function isIdentifierStartChar(ch: number): boolean {
  return isIdentifierText(String.fromCodePoint(ch), LanguageVariant.Standard);
}

function isIdentifierPartChar(ch: number): boolean {
  return isIdentifierText('a' + String.fromCodePoint(ch), LanguageVariant.Standard);
}

// ---- Filter text, ported from the VS Code TypeScript extension

interface WordInfo {
  length: number;
  start: number;
}

/** The length and first character of the word ending at `position`. */
function getWordLengthAndStart(file: SourceFile, position: number): WordInfo {
  const text = file.text;
  let length = 0;
  let start = 0;
  for (let i = position - 1; i >= 0; i--) {
    let ch = text.charCodeAt(i);
    let size = 1;
    if (ch >= 0xdc00 && ch <= 0xdfff && i > 0) {
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        ch = (high - 0xd800) * 0x400 + (ch - 0xdc00) + 0x10000;
        size = 2;
      }
    }
    if ((ch < 0x80 && '`~!@%^&*()-=+[{]}\\|;:\'",.<>/?'.indexOf(String.fromCharCode(ch)) >= 0) || isUnicodeSpace(ch))
      break;
    length += size;
    start = ch;
    if (size === 2) i--;
  }
  // A word starting with `@` doesn't include it.
  if (start === 0x40) {
    length -= 1;
    start = text.codePointAt(position - length) ?? 0;
  }
  return { length, start };
}

function isUnicodeSpace(ch: number): boolean {
  return (
    (ch >= 0x09 && ch <= 0x0d) ||
    ch === 0x20 ||
    ch === 0x85 ||
    ch === 0xa0 ||
    ch === 0x1680 ||
    (ch >= 0x2000 && ch <= 0x200a) ||
    ch === 0x2028 ||
    ch === 0x2029 ||
    ch === 0x202f ||
    ch === 0x205f ||
    ch === 0x3000
  );
}

function trimElementAccess(textIn: string): string {
  let text = textIn;
  if (text.startsWith('[')) text = text.substring(1);
  if (text.endsWith(']')) text = text.substring(0, text.length - 1);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) text = text.substring(1, text.length - 1);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.substring(1, text.length - 1);
  return text;
}

function getFilterText(insertText: string, label: string, wordStart: number, dotAccessor: string): string {
  // Private fields: `#bar`.
  if (label.startsWith('#')) {
    if (insertText !== '') {
      if (insertText.startsWith('this.#')) return wordStart === 0x23 ? '' : insertText.substring('this.#'.length);
    } else return wordStart === 0x23 ? '' : label.substring(1);
  }
  // `this.` completions aren't deprioritized.
  if (insertText.startsWith('this.')) return '';
  // `xyz.ab|` inserting `['ab c']` filters on `.ab c`.
  if (insertText.startsWith('[')) return dotAccessor + trimElementAccess(insertText);
  if (insertText.startsWith('?.')) {
    if (insertText.startsWith('?.[')) return dotAccessor + trimElementAccess(insertText.substring(2));
    return dotAccessor + insertText.substring(2);
  }
  return insertText;
}

function getDotAccessor(file: SourceFile, position: number): string {
  const text = file.text;
  if (position >= 2 && text.charCodeAt(position - 2) === 0x3f && text.charCodeAt(position - 1) === 0x2e) return '?.';
  if (position >= 1 && text.charCodeAt(position - 1) === 0x2e) return '.';
  return '';
}

// ---- Labels, JSX closing tags and JSDoc

function getLabelCompletionsAtPosition(node: Node, file: SourceFile, position: number): CompletionList | undefined {
  const entries: CompletionEntry[] = [];
  const uniques = new Set<string>();
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    if (isFunctionLike(current)) break;
    if (current.kind === SyntaxKind.LabeledStatement) {
      const name = getText(getLabel(current)!);
      if (!uniques.has(name)) {
        uniques.add(name);
        entries.push(
          createEntry(name, '', '', SortText.LocationPriority, ScriptElementKind.Label, false, file, position),
        );
      }
    }
  }
  return entries.length === 0 ? undefined : { isIncomplete: false, entries };
}

function getJsxClosingTagCompletion(location: Node, file: SourceFile, position: number): CompletionList | undefined {
  const jsxClosingElement = findAncestorOrQuit(location, (node) => {
    switch (node.kind) {
      case SyntaxKind.JsxClosingElement:
        return FindAncestorResult.True;
      case SyntaxKind.LessThanSlashToken:
      case SyntaxKind.GreaterThanToken:
      case SyntaxKind.Identifier:
      case SyntaxKind.PropertyAccessExpression:
        return FindAncestorResult.False;
    }
    return FindAncestorResult.Quit;
  });
  if (jsxClosingElement === undefined) return undefined;
  // `</` completes to the opening element's tag name.
  const hasClosingAngleBracket = findChildOfKind(jsxClosingElement, SyntaxKind.GreaterThanToken, file) !== undefined;
  const tagName = (jsxClosingElement.parent as JsxElement).openingElement.tagName;
  const closingTag = getTextOfNodeFromSource(file, tagName);
  const fullClosingTag = closingTag + (hasClosingAngleBracket ? '' : '>');
  return {
    isIncomplete: false,
    entries: [
      createEntry(
        fullClosingTag,
        '',
        '',
        SortText.LocationPriority,
        ScriptElementKind.ClassElement,
        false,
        file,
        position,
      ),
    ],
  };
}

function getJSDocTagNames(): string[] {
  return [
    'abstract',
    'access',
    'alias',
    'argument',
    'async',
    'augments',
    'author',
    'borrows',
    'callback',
    'class',
    'classdesc',
    'constant',
    'constructor',
    'constructs',
    'copyright',
    'default',
    'deprecated',
    'description',
    'emits',
    'enum',
    'event',
    'example',
    'exports',
    'extends',
    'external',
    'field',
    'file',
    'fileoverview',
    'fires',
    'function',
    'generator',
    'global',
    'hideconstructor',
    'host',
    'ignore',
    'implements',
    'import',
    'inheritdoc',
    'inner',
    'instance',
    'interface',
    'kind',
    'lends',
    'license',
    'link',
    'linkcode',
    'linkplain',
    'listens',
    'member',
    'memberof',
    'method',
    'mixes',
    'module',
    'name',
    'namespace',
    'overload',
    'override',
    'package',
    'param',
    'private',
    'prop',
    'property',
    'protected',
    'public',
    'readonly',
    'requires',
    'returns',
    'satisfies',
    'see',
    'since',
    'static',
    'summary',
    'template',
    'this',
    'throws',
    'todo',
    'tutorial',
    'type',
    'typedef',
    'var',
    'variation',
    'version',
    'virtual',
    'yields',
  ];
}

function getJSDocTagNameCompletions(): CompletionEntry[] {
  return getJSDocTagNames().map((name) => ({
    name,
    kind: CompletionItemKind.Keyword,
    sortText: SortText.LocationPriority,
  }));
}

function getJSDocTagCompletions(): CompletionEntry[] {
  return getJSDocTagNames().map((name) => ({
    name: '@' + name,
    kind: CompletionItemKind.Keyword,
    sortText: SortText.LocationPriority,
  }));
}

function getJSDocParameterCompletions(
  c: Checker,
  file: SourceFile,
  position: number,
  tagNameOnly: boolean,
): CompletionEntry[] {
  const currentToken = getTokenAtPosition(file, position);
  if (currentToken === undefined) return [];
  if (!isJSDocTagKind(currentToken.kind) && currentToken.kind !== SyntaxKind.JSDoc) return [];
  const jsDoc = currentToken.kind === SyntaxKind.JSDoc ? currentToken : currentToken.parent!;
  if (!(jsDoc instanceof JSDoc)) return [];
  const fun = jsDoc.parent;
  if (fun === undefined || !isFunctionLike(fun)) return [];
  const isJS = isSourceFileJS(file);
  let paramTagCount = 0;
  const tags = jsDoc.tags !== undefined ? jsDoc.tags.nodes : [];
  for (const tag of tags)
    if (
      tag instanceof JSDocParameterOrPropertyTag &&
      tag.kind === SyntaxKind.JSDocParameterTag &&
      getStartOfNode(tag, file, false) < position &&
      tag.name.kind === SyntaxKind.Identifier
    )
      paramTagCount++;
  const entries: CompletionEntry[] = [];
  const parameters = getParameters(fun)!.nodes;
  for (let paramIndex = 0; paramIndex < parameters.length; paramIndex++) {
    // Parameters that already have tags are skipped.
    if (paramIndex < paramTagCount) continue;
    const param = parameters[paramIndex] as ParameterDeclaration;
    if (param.name.kind === SyntaxKind.Identifier) {
      let displayText = getJSDocParamAnnotation(
        c,
        getText(param.name),
        param.initializer,
        param.dotDotDotToken !== undefined,
        isJS,
        false,
      );
      if (tagNameOnly) displayText = displayText.substring(1);
      entries.push({ name: displayText, kind: CompletionItemKind.Variable, sortText: SortText.LocationPriority });
    } else if (paramIndex === paramTagCount) {
      // A destructured parameter, named by position.
      const lines = generateJSDocParamTagsForDestructuring(
        c,
        'param' + paramIndex,
        param.name,
        param.initializer,
        param.dotDotDotToken !== undefined,
        isJS,
      );
      let displayText = lines.join('\n* ');
      if (tagNameOnly && displayText.startsWith('@')) displayText = displayText.substring(1);
      entries.push({ name: displayText, kind: CompletionItemKind.Variable, sortText: SortText.LocationPriority });
    }
  }
  return entries;
}

function getJSDocParamAnnotation(
  c: Checker,
  paramNameIn: string,
  initializer: Node | undefined,
  isRest: boolean,
  isJS: boolean,
  isObject: boolean,
): string {
  let paramName = paramNameIn;
  if (initializer !== undefined) paramName = getJSDocParamNameWithInitializer(paramName, initializer);
  if (isJS) {
    let t = isObject ? 'object' : '*';
    if (!isObject && initializer !== undefined) {
      const inferredType = getTypeAtLocation(c, initializer.parent!);
      if ((inferredType.flags & (TypeFlags.Any | TypeFlags.Void)) === 0) {
        const file = getSourceFileOfNode(initializer);
        const flags =
          getQuotePreference(file) === QuotePreference.Single
            ? NodeBuilderFlags.UseSingleQuotesForStringLiteralType
            : 0;
        const typeNode = typeToTypeNode(c, inferredType, findAncestor(initializer, isFunctionLike), flags);
        if (typeNode !== undefined) {
          const options = new PrinterOptions();
          options.removeComments = true;
          const context = new EmitContext();
          context.setEmitFlags(typeNode, EmitFlags.SingleLine);
          t = new Printer(options, context).emit(typeNode, file);
        }
      }
    }
    const dotDotDot = !isObject && isRest ? '...' : '';
    return '@param {' + dotDotDot + t + '} ' + paramName + ' ';
  }
  return '@param ' + paramName + ' ';
}

function getJSDocParamNameWithInitializer(paramName: string, initializer: Node): string {
  const file = getSourceFileOfNode(initializer);
  const initializerText = getTextOfNodeFromSource(file, initializer).trim();
  if (initializerText.includes('\n') || initializerText.length > 80) return '[' + paramName + ']';
  return '[' + paramName + '=' + initializerText + ']';
}

function generateJSDocParamTagsForDestructuring(
  c: Checker,
  path: string,
  pattern: Node,
  initializer: Node | undefined,
  isRest: boolean,
  isJS: boolean,
): string[] {
  if (!isJS) return [getJSDocParamAnnotation(c, path, initializer, isRest, isJS, false)];
  return jsDocParamPatternWorker(c, path, pattern, initializer, isRest, isJS);
}

function jsDocParamPatternWorker(
  c: Checker,
  path: string,
  pattern: Node,
  initializer: Node | undefined,
  isRest: boolean,
  isJS: boolean,
): string[] {
  if (pattern.kind === SyntaxKind.ObjectBindingPattern && !isRest) {
    const rootParam = getJSDocParamAnnotation(c, path, initializer, isRest, isJS, true);
    let childTags: string[] = [];
    for (const element of getElements(pattern)!.nodes) {
      const elementTags = jsDocParamElementWorker(c, path, element as BindingElement, isJS);
      if (elementTags.length === 0) {
        childTags = [];
        break;
      }
      childTags.push(...elementTags);
    }
    if (childTags.length > 0) return [rootParam, ...childTags];
  }
  return [getJSDocParamAnnotation(c, path, initializer, isRest, isJS, false)];
}

function jsDocParamElementWorker(c: Checker, path: string, element: BindingElement, isJS: boolean): string[] {
  const name = element.name!;
  if (name.kind === SyntaxKind.Identifier) {
    const propertyName =
      element.propertyName !== undefined
        ? isPropertyNameLiteral(element.propertyName)
          ? getText(element.propertyName)
          : ''
        : getText(name);
    if (propertyName === '') return [];
    return [
      getJSDocParamAnnotation(
        c,
        path + '.' + propertyName,
        element.initializer,
        element.dotDotDotToken !== undefined,
        isJS,
        false,
      ),
    ];
  }
  if (element.propertyName !== undefined) {
    const propertyName = isPropertyNameLiteral(element.propertyName) ? getText(element.propertyName) : '';
    if (propertyName === '') return [];
    return jsDocParamPatternWorker(
      c,
      path + '.' + propertyName,
      name,
      element.initializer,
      element.dotDotDotToken !== undefined,
      isJS,
    );
  }
  return [];
}

function getJSDocParameterNameCompletions(tag: JSDocParameterOrPropertyTag): CompletionEntry[] {
  if (tag.name.kind !== SyntaxKind.Identifier) return [];
  const nameThusFar = getText(tag.name);
  // Tags of `@callback` and `@typedef` signatures have no function.
  const jsDoc = tag.parent;
  const fn = jsDoc !== undefined ? jsDoc.parent : undefined;
  if (fn === undefined || !isFunctionLike(fn) || !(jsDoc instanceof JSDoc)) return [];
  const tags = jsDoc.tags !== undefined ? jsDoc.tags.nodes : [];
  const entries: CompletionEntry[] = [];
  for (const param of getParameters(fn)!.nodes) {
    const paramName = getName(param)!;
    if (paramName.kind !== SyntaxKind.Identifier) continue;
    const name = getText(paramName);
    if (
      tags.some(
        (t) =>
          t !== tag &&
          t instanceof JSDocParameterOrPropertyTag &&
          t.kind === SyntaxKind.JSDocParameterTag &&
          t.name.kind === SyntaxKind.Identifier &&
          getText(t.name) === name,
      ) ||
      (nameThusFar !== '' && !name.startsWith(nameThusFar))
    )
      continue;
    entries.push({ name, kind: CompletionItemKind.Variable, sortText: SortText.LocationPriority });
  }
  return entries;
}
