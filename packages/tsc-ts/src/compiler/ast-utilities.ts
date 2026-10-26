// Predicates and helpers over syntax kinds and nodes, as in tsgo's ast/utilities.go.
//
// Fields of `instanceof`-narrowed nodes are read through `as` casts: scriptc reads them
// statically, but reads fields of a narrowed value dynamically.
import {
  CallExpression,
  ExternalModuleReference,
  Identifier,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportTypeNode,
  JsxNamespacedName,
  LiteralTypeNode,
  MetaProperty,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  PartiallyEmittedExpression,
  PropertyAccessExpression,
  StringLiteral,
  TypeReferenceNode,
  getExpression,
  getIsTypeOnly,
  getModuleSpecifier,
  getText,
  getType,
} from './ast.js';
import { isTypeNodeKind } from './binder-utilities.js';
import { CharacterCodes, isLineBreak, isWhiteSpaceLike } from './character-codes.js';
import { skipTrivia } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import { TokenFlags } from './types.js';

export const enum OperatorPrecedence {
  Invalid = -1,
  Comma = 0,
  Spread,
  Yield,
  Assignment,
  Conditional,
  LogicalOR,
  LogicalAND,
  BitwiseOR,
  BitwiseXOR,
  BitwiseAND,
  Equality,
  Relational,
  Shift,
  Additive,
  Multiplicative,
  Exponentiation,
  Unary,
  Update,
  LeftHandSide,
  OptionalChain,
  Member,
  Primary,
  Parentheses,
  Lowest = Comma,
  Highest = Parentheses,
  DisallowComma = Yield,
  Coalesce = LogicalOR,
}

export function getBinaryOperatorPrecedence(kind: SyntaxKind): OperatorPrecedence {
  switch (kind) {
    case SyntaxKind.QuestionQuestionToken:
      return OperatorPrecedence.Coalesce;
    case SyntaxKind.BarBarToken:
      return OperatorPrecedence.LogicalOR;
    case SyntaxKind.AmpersandAmpersandToken:
      return OperatorPrecedence.LogicalAND;
    case SyntaxKind.BarToken:
      return OperatorPrecedence.BitwiseOR;
    case SyntaxKind.CaretToken:
      return OperatorPrecedence.BitwiseXOR;
    case SyntaxKind.AmpersandToken:
      return OperatorPrecedence.BitwiseAND;
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
      return OperatorPrecedence.Equality;
    case SyntaxKind.LessThanToken:
    case SyntaxKind.GreaterThanToken:
    case SyntaxKind.LessThanEqualsToken:
    case SyntaxKind.GreaterThanEqualsToken:
    case SyntaxKind.InstanceOfKeyword:
    case SyntaxKind.InKeyword:
    case SyntaxKind.AsKeyword:
    case SyntaxKind.SatisfiesKeyword:
      return OperatorPrecedence.Relational;
    case SyntaxKind.LessThanLessThanToken:
    case SyntaxKind.GreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return OperatorPrecedence.Shift;
    case SyntaxKind.PlusToken:
    case SyntaxKind.MinusToken:
      return OperatorPrecedence.Additive;
    case SyntaxKind.AsteriskToken:
    case SyntaxKind.SlashToken:
    case SyntaxKind.PercentToken:
      return OperatorPrecedence.Multiplicative;
    case SyntaxKind.AsteriskAsteriskToken:
      return OperatorPrecedence.Exponentiation;
  }
  // Lower than every precedence, so binary expression parsing stops.
  return OperatorPrecedence.Invalid;
}

// Tokens

export function isKeyword(token: SyntaxKind): boolean {
  return token >= SyntaxKind.FirstKeyword && token <= SyntaxKind.LastKeyword;
}

export function isPunctuation(token: SyntaxKind): boolean {
  return token >= SyntaxKind.FirstPunctuation && token <= SyntaxKind.LastPunctuation;
}

export function isKeywordOrPunctuation(token: SyntaxKind): boolean {
  return isKeyword(token) || isPunctuation(token);
}

export function isReservedWord(token: SyntaxKind): boolean {
  return token >= SyntaxKind.FirstReservedWord && token <= SyntaxKind.LastReservedWord;
}

export function tokenIsIdentifierOrKeyword(token: SyntaxKind): boolean {
  return token >= SyntaxKind.Identifier;
}

export function tokenIsIdentifierOrKeywordOrGreaterThan(token: SyntaxKind): boolean {
  return token === SyntaxKind.GreaterThanToken || tokenIsIdentifierOrKeyword(token);
}

export function isModifierKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.AbstractKeyword:
    case SyntaxKind.AccessorKeyword:
    case SyntaxKind.AsyncKeyword:
    case SyntaxKind.ConstKeyword:
    case SyntaxKind.DeclareKeyword:
    case SyntaxKind.DefaultKeyword:
    case SyntaxKind.ExportKeyword:
    case SyntaxKind.InKeyword:
    case SyntaxKind.PrivateKeyword:
    case SyntaxKind.ProtectedKeyword:
    case SyntaxKind.PublicKeyword:
    case SyntaxKind.ReadonlyKeyword:
    case SyntaxKind.OutKeyword:
    case SyntaxKind.OverrideKeyword:
    case SyntaxKind.StaticKeyword:
      return true;
  }
  return false;
}

export function modifierToFlag(kind: SyntaxKind): ModifierFlags {
  switch (kind) {
    case SyntaxKind.StaticKeyword:
      return ModifierFlags.Static;
    case SyntaxKind.PublicKeyword:
      return ModifierFlags.Public;
    case SyntaxKind.ProtectedKeyword:
      return ModifierFlags.Protected;
    case SyntaxKind.PrivateKeyword:
      return ModifierFlags.Private;
    case SyntaxKind.AbstractKeyword:
      return ModifierFlags.Abstract;
    case SyntaxKind.AccessorKeyword:
      return ModifierFlags.Accessor;
    case SyntaxKind.ExportKeyword:
      return ModifierFlags.Export;
    case SyntaxKind.DeclareKeyword:
      return ModifierFlags.Ambient;
    case SyntaxKind.ConstKeyword:
      return ModifierFlags.Const;
    case SyntaxKind.DefaultKeyword:
      return ModifierFlags.Default;
    case SyntaxKind.AsyncKeyword:
      return ModifierFlags.Async;
    case SyntaxKind.ReadonlyKeyword:
      return ModifierFlags.Readonly;
    case SyntaxKind.OverrideKeyword:
      return ModifierFlags.Override;
    case SyntaxKind.InKeyword:
      return ModifierFlags.In;
    case SyntaxKind.OutKeyword:
      return ModifierFlags.Out;
    case SyntaxKind.Decorator:
      return ModifierFlags.Decorator;
  }
  return ModifierFlags.None;
}

export function modifiersToFlags(modifiers: readonly Node[]): ModifierFlags {
  let flags = ModifierFlags.None;
  for (let i = 0; i < modifiers.length; i++) flags |= modifierToFlag(modifiers[i]!.kind);
  return flags;
}

export function isParameterPropertyModifier(kind: SyntaxKind): boolean {
  return (modifierToFlag(kind) & ModifierFlags.ParameterPropertyModifier) !== 0;
}

export function isClassMemberModifier(token: SyntaxKind): boolean {
  return (
    isParameterPropertyModifier(token) ||
    token === SyntaxKind.StaticKeyword ||
    token === SyntaxKind.OverrideKeyword ||
    token === SyntaxKind.AccessorKeyword
  );
}

export function isAssignmentOperator(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.EqualsToken:
    case SyntaxKind.PlusEqualsToken:
    case SyntaxKind.MinusEqualsToken:
    case SyntaxKind.AsteriskAsteriskEqualsToken:
    case SyntaxKind.AsteriskEqualsToken:
    case SyntaxKind.SlashEqualsToken:
    case SyntaxKind.PercentEqualsToken:
    case SyntaxKind.AmpersandEqualsToken:
    case SyntaxKind.BarEqualsToken:
    case SyntaxKind.CaretEqualsToken:
    case SyntaxKind.LessThanLessThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case SyntaxKind.BarBarEqualsToken:
    case SyntaxKind.AmpersandAmpersandEqualsToken:
    case SyntaxKind.QuestionQuestionEqualsToken:
      return true;
  }
  return false;
}

// Nodes

/** Whether the node has an empty, non-synthesized range (and isn't the end of file token). */
export function nodeIsMissing(node: Node | undefined): boolean {
  return node === undefined || (node.pos === node.end && node.pos >= 0 && node.kind !== SyntaxKind.EndOfFile);
}

export function nodeIsPresent(node: Node | undefined): boolean {
  return !nodeIsMissing(node);
}

export function isInJSFile(node: Node | undefined): boolean {
  return node !== undefined && (node.flags & NodeFlags.JavaScriptFile) !== 0;
}

export function compareNodePositions(a: Node, b: Node): number {
  const c = a.pos - b.pos;
  return c !== 0 ? c : a.end - b.end;
}

function isLeftHandSideExpressionKind(kind: SyntaxKind): boolean {
  switch (kind) {
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

/** Partially emitted expressions, created by transforms, are skipped. */
export function isLeftHandSideExpression(node: Node): boolean {
  let expression = node;
  while (expression.kind === SyntaxKind.PartiallyEmittedExpression)
    expression = (expression as PartiallyEmittedExpression).expression;
  return isLeftHandSideExpressionKind(expression.kind);
}

export function isFunctionLikeDeclarationKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return true;
  }
  return false;
}

export function isFunctionLikeKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.JSDocSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      return true;
  }
  return isFunctionLikeDeclarationKind(kind);
}

export function isFunctionLike(node: Node | undefined): boolean {
  return node !== undefined && isFunctionLikeKind(node.kind);
}

export function canHaveIllegalDecorators(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.MissingDeclaration:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ExportAssignment:
      return true;
  }
  return false;
}

export function canHaveDecorators(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ClassDeclaration:
      return true;
  }
  return false;
}

export function isStringLiteralLike(node: Node): boolean {
  return node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

/** Whether two JSX tag names (identifiers, `this`, namespaced names or property accesses) are the same. */
export function tagNamesAreEquivalent(lhs: Node, rhs: Node): boolean {
  if (lhs.kind !== rhs.kind) return false;
  if (lhs instanceof Identifier && rhs instanceof Identifier)
    return (lhs as Identifier).text === (rhs as Identifier).text;
  if (lhs.kind === SyntaxKind.ThisKeyword) return true;
  if (lhs instanceof JsxNamespacedName && rhs instanceof JsxNamespacedName)
    return (
      (lhs as JsxNamespacedName).namespace.text === (rhs as JsxNamespacedName).namespace.text &&
      (lhs as JsxNamespacedName).name.text === (rhs as JsxNamespacedName).name.text
    );
  if (lhs instanceof PropertyAccessExpression && rhs instanceof PropertyAccessExpression)
    return (
      getText((lhs as PropertyAccessExpression).name) === getText((rhs as PropertyAccessExpression).name) &&
      tagNamesAreEquivalent((lhs as PropertyAccessExpression).expression, (rhs as PropertyAccessExpression).expression)
    );
  throw new Error('Unhandled case in tagNamesAreEquivalent');
}

/** Whether `node` is a JSDoc type expression or a type node in one. */
export function isJSDocTypeExpressionOrChild(node: Node): boolean {
  if (node.kind === SyntaxKind.JSDocTypeExpression) return true;
  if ((node.flags & (NodeFlags.JSDoc | NodeFlags.Reparsed)) === 0) return false;
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (isTypeNodeKind(current.kind)) return true;
  return false;
}

/** The text of a JSDoc type with the leading whitespace and `*` of each line removed, and LF line breaks. */
export function normalizeJSDocTypeSourceText(text: string): string {
  let result = '';
  let lineStart = 0;
  let multiline = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (!isLineBreak(ch)) continue;
    result += stripLeadingJSDocComment(text.substring(lineStart, i)) + '\n';
    multiline = true;
    if (ch === CharacterCodes.carriageReturn && text.charCodeAt(i + 1) === CharacterCodes.lineFeed) i++;
    lineStart = i + 1;
  }
  if (!multiline) return stripLeadingJSDocComment(text);
  return result + stripLeadingJSDocComment(text.substring(lineStart));
}

function stripLeadingJSDocComment(line: string): string {
  let start = 0;
  while (start < line.length && isWhiteSpaceLike(line.charCodeAt(start))) start++;
  if (start < line.length && line.charCodeAt(start) === CharacterCodes.asterisk) start++;
  while (start < line.length && isWhiteSpaceLike(line.charCodeAt(start))) start++;
  return start === 0 ? line : line.substring(start);
}

/** The source text of a node, without leading trivia. */
export function getTextOfNodeFromSourceText(sourceText: string, node: Node): string {
  if (nodeIsMissing(node)) return '';
  let text = sourceText.substring(skipTrivia(sourceText, node.pos), node.end);
  if (isJSDocTypeExpressionOrChild(node)) text = normalizeJSDocTypeSourceText(text);
  if ((node.flags & NodeFlags.ReparserTransformedLiteral) !== 0) {
    if (node instanceof StringLiteral)
      return ((node as StringLiteral).tokenFlags & TokenFlags.SingleQuote) !== 0 ? "'" + text + "'" : '"' + text + '"';
    if (node instanceof Identifier) return (node as Identifier).text;
    throw new Error('Unexpected reparser-transformed node kind');
  }
  return text;
}

export function isImportMeta(node: Node): boolean {
  return (
    node instanceof MetaProperty &&
    (node as MetaProperty).keywordToken === SyntaxKind.ImportKeyword &&
    (node as MetaProperty).name.text === 'meta'
  );
}

/** `import(…)`, `import.defer(…)` or `import.source(…)`. */
export function isImportCall(node: Node): boolean {
  if (!(node instanceof CallExpression)) return false;
  const e = (node as CallExpression).expression;
  return e.kind === SyntaxKind.ImportKeyword || isImportPhaseMetaProperty(e);
}

/** `import.defer` or `import.source`. */
export function isImportPhaseMetaProperty(node: Node): boolean {
  return isImportMetaPropertyNamed(node, 'defer') || isImportMetaPropertyNamed(node, 'source');
}

export function isImportDeferMetaProperty(node: Node): boolean {
  return isImportMetaPropertyNamed(node, 'defer');
}

export function isImportSourceMetaProperty(node: Node): boolean {
  return isImportMetaPropertyNamed(node, 'source');
}

function isImportMetaPropertyNamed(node: Node, name: string): boolean {
  return (
    node instanceof MetaProperty &&
    (node as MetaProperty).keywordToken === SyntaxKind.ImportKeyword &&
    (node as MetaProperty).name.text === name
  );
}

/** `import source x from "m"` or `import.source("m")`. */
export function isSourcePhaseImport(node: Node): boolean {
  if (node instanceof ImportDeclaration) {
    const clause = (node as ImportDeclaration).importClause;
    return clause !== undefined && (clause as ImportClause).phaseModifier === SyntaxKind.SourceKeyword;
  }
  return isSourcePhaseImportCall(node);
}

/** `import.source(…)`. */
export function isSourcePhaseImportCall(node: Node): boolean {
  return node instanceof CallExpression && isImportSourceMetaProperty((node as CallExpression).expression);
}

/** `require(x)` with one argument, a string literal if `requireStringLiteralLikeArgument`. */
export function isRequireCall(node: Node, requireStringLiteralLikeArgument: boolean): boolean {
  if (!(node instanceof CallExpression)) return false;
  const call = node as CallExpression;
  const callee = call.expression;
  if (!(callee instanceof Identifier) || (callee as Identifier).text !== 'require') return false;
  const args = call.arguments.nodes;
  if (args.length !== 1) return false;
  return !requireStringLiteralLikeArgument || isStringLiteralLike(args[0]!);
}

/** The string literal of `import("x")` types. */
export function getImportTypeNodeLiteral(node: Node): Node | undefined {
  if (node instanceof ImportTypeNode) {
    const argument = (node as ImportTypeNode).argument;
    if (argument instanceof LiteralTypeNode && (argument as LiteralTypeNode).literal.kind === SyntaxKind.StringLiteral)
      return (argument as LiteralTypeNode).literal;
  }
  return undefined;
}

export function isLiteralImportTypeNode(node: Node): boolean {
  return getImportTypeNodeLiteral(node) !== undefined;
}

export function isAnyImportOrReExport(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ExportDeclaration:
      return true;
  }
  return false;
}

export function getExternalModuleName(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ExportDeclaration:
      return getModuleSpecifier(node);
    case SyntaxKind.ImportEqualsDeclaration:
      if (node instanceof ImportEqualsDeclaration) {
        const reference = (node as ImportEqualsDeclaration).moduleReference;
        if (reference instanceof ExternalModuleReference) return (reference as ExternalModuleReference).expression;
      }
      return undefined;
    case SyntaxKind.ImportType:
      return getImportTypeNodeLiteral(node);
    case SyntaxKind.CallExpression:
      if (node instanceof CallExpression) {
        const args = (node as CallExpression).arguments.nodes;
        return args.length > 0 ? args[0]! : undefined;
      }
      return undefined;
    case SyntaxKind.ModuleDeclaration:
      if (node instanceof ModuleDeclaration) {
        const name = (node as ModuleDeclaration).name;
        if (name.kind === SyntaxKind.StringLiteral) return name;
      }
      return undefined;
  }
  throw new Error('Unhandled case in getExternalModuleName');
}

export function isGlobalScopeAugmentation(node: Node): boolean {
  return node instanceof ModuleDeclaration && (node as ModuleDeclaration).keyword === SyntaxKind.GlobalKeyword;
}

/** Whether a node is written type-only: an `import type` clause, or a `type` specifier, import or export. */
export function isTypeOnly(node: Node): boolean {
  if (node.kind === SyntaxKind.ImportClause) return (node as ImportClause).phaseModifier === SyntaxKind.TypeKeyword;
  return getIsTypeOnly(node);
}

/** Whether a declaration declares only a type. */
export function isTypeDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.TypeParameter:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
      return true;
    case SyntaxKind.ImportClause:
      // `import type { a } from "m"` declares no type of its own.
      return isTypeOnly(node) && (node as ImportClause).name !== undefined;
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier:
      return isTypeOnly(node.parent!.parent!);
  }
  return false;
}

export function isAmbientModule(node: Node): boolean {
  if (!(node instanceof ModuleDeclaration)) return false;
  const declaration = node as ModuleDeclaration;
  return declaration.name.kind === SyntaxKind.StringLiteral || declaration.keyword === SyntaxKind.GlobalKeyword;
}

/** Whether `node` is a JavaScript `/** @type {T} *\/ (x)` cast, reparsed as a parenthesized `as` expression. */
export function isJSDocTypeAssertion(node: Node): boolean {
  if (node.kind !== SyntaxKind.ParenthesizedExpression || !isInJSFile(node)) return false;
  const expression = getExpression(node);
  if (expression === undefined || expression.kind !== SyntaxKind.AsExpression) return false;
  const type = getType(expression);
  return type !== undefined && (type.flags & NodeFlags.Reparsed) !== 0;
}

/** The expression a check applies to: parentheses and `satisfies` are skipped, but not JavaScript casts. */
export function getEffectiveCheckNode(argument: Node): Node {
  const inJS = isInJSFile(argument);
  let node = argument;
  for (;;) {
    if (node.kind === SyntaxKind.ParenthesizedExpression && !(inJS && isJSDocTypeAssertion(node)))
      node = getExpression(node)!;
    else if (node.kind === SyntaxKind.SatisfiesExpression) node = getExpression(node)!;
    else return node;
  }
}

/** The entity name of a heritage clause element: a type reference's type name, or an
 * `ExpressionWithTypeArguments`'s expression. */
export function getHeritageClauseElementName(node: Node): Node {
  if (node.kind === SyntaxKind.TypeReference) return (node as TypeReferenceNode).typeName;
  return getExpression(node)!;
}

/** Whether a name, or the rightmost name of a qualified name, is the type name of a type reference in a
 * heritage clause. */
export function isNameOfHeritageClauseTypeReference(nodeIn: Node): boolean {
  let node = nodeIn;
  while (node.parent!.kind === SyntaxKind.QualifiedName) node = node.parent!;
  const parent = node.parent!;
  return (
    parent.kind === SyntaxKind.TypeReference &&
    (parent as TypeReferenceNode).typeName === node &&
    parent.parent?.kind === SyntaxKind.HeritageClause
  );
}
