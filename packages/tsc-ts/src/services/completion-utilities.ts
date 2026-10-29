// Syntax and position helpers for completions, like tsgo's ls and lsutil utilities.
import {
  BinaryExpression,
  CallExpression,
  CatchClause,
  ConditionalExpression,
  getStatement,
  getText,
  IfStatement,
  PrefixUnaryExpression,
  TypeQueryNode,
  getArguments,
  getBody,
  getExpression,
  getHeritageClauses,
  getModuleSpecifier,
  getType,
  HeritageClause,
  ImportEqualsDeclaration,
  NewExpression,
  type Node,
  NodeFlags,
  NodeVisitor,
  type NodeList,
  type SourceFile,
  StringLiteral,
  TaggedTemplateExpression,
  TemplateExpression,
  TemplateSpan,
  callTypeArguments,
} from '../compiler/ast.js';
import {
  findChildOfKind,
  findPrecedingToken,
  getLastChild,
  getLastToken,
  getLastVisitedChild,
  getStartOfNode,
  getTokensOfNodeList,
  scanTokens,
} from '../compiler/astnav.js';
import { isFunctionLike, isKeyword, nodeIsMissing, nodeIsPresent } from '../compiler/ast-utilities.js';
import { isClassLike, isOptionalChain, isOptionalChainRoot, skipParentheses } from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { ContextFlags } from '../compiler/checker-contextual.js';
import { getNonNullableType } from '../compiler/checker-flow.js';
import { getSignaturesOfType } from '../compiler/checker-members.js';
import {
  getConstantValue,
  getSymbolAtLocation,
  getTypeAtLocation,
  isDeclarationName,
  isPartOfTypeNode,
} from '../compiler/checker-services.js';
import {
  ElementFlags,
  type Signature,
  SignatureKind,
  TupleType,
  type Type,
  type TypeReference,
} from '../compiler/checker-types.js';
import { isTupleType } from '../compiler/checker-type-factory.js';
import { getLeadingCommentRanges, getTrailingCommentRanges, skipTrivia, tokenToString } from '../compiler/scanner.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { isUnterminatedLiteral } from '../compiler/printer/utilities.js';
import { TokenFlags, type CommentRange } from '../compiler/types.js';
import { getContextualTypeWithFlags, getNonOptionalType } from './completion-checker.js';

export { isUnterminatedLiteral };

// ---- Ancestors

export function findAncestor(node: Node | undefined, predicate: (n: Node) => boolean): Node | undefined {
  for (let n = node; n !== undefined; n = n.parent) if (predicate(n)) return n;
  return undefined;
}

export const enum FindAncestorResult {
  False,
  True,
  Quit,
}

export function findAncestorOrQuit(
  node: Node | undefined,
  callback: (n: Node) => FindAncestorResult,
): Node | undefined {
  for (let n = node; n !== undefined; n = n.parent) {
    const result = callback(n);
    if (result === FindAncestorResult.Quit) return undefined;
    if (result === FindAncestorResult.True) return n;
  }
  return undefined;
}

export function isNodeDescendantOf(node: Node | undefined, ancestor: Node | undefined): boolean {
  for (let n = node; n !== undefined; n = n.parent) if (n === ancestor) return true;
  return false;
}

// ---- Kinds

export function isTokenKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstToken && kind <= SyntaxKind.LastToken;
}

export function isContextualKeyword(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstContextualKeyword && kind <= SyntaxKind.LastContextualKeyword;
}

export function isNonContextualKeyword(kind: SyntaxKind): boolean {
  return isKeyword(kind) && !isContextualKeyword(kind);
}

export function isStringTextContainingNode(node: Node): boolean {
  return node.kind === SyntaxKind.StringLiteral || isTemplateLiteralKind(node.kind);
}

export function isTemplateLiteralKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstTemplateToken && kind <= SyntaxKind.LastTemplateToken;
}

export function isStringLiteralLike(node: Node): boolean {
  return node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

const typeKeywords = new Set<SyntaxKind>([
  SyntaxKind.AnyKeyword,
  SyntaxKind.AssertsKeyword,
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.InferKeyword,
  SyntaxKind.KeyOfKeyword,
  SyntaxKind.NeverKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.UniqueKeyword,
  SyntaxKind.UnknownKeyword,
]);

export function isTypeKeyword(kind: SyntaxKind): boolean {
  return typeKeywords.has(kind);
}

export function isFunctionBlock(node: Node): boolean {
  return node.kind === SyntaxKind.Block && node.parent !== undefined && isFunctionLike(node.parent);
}

export function isObjectTypeDeclaration(node: Node): boolean {
  return isClassLike(node) || node.kind === SyntaxKind.InterfaceDeclaration || node.kind === SyntaxKind.TypeLiteral;
}

export function isClassOrTypeElement(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Constructor:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.SemicolonClassElement:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.NotEmittedTypeElement:
      return true;
  }
  return false;
}

export function isCallLikeExpression(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.Decorator:
      return true;
  }
  return false;
}

export function isJsxOpeningLikeElement(node: Node): boolean {
  return node.kind === SyntaxKind.JsxOpeningElement || node.kind === SyntaxKind.JsxSelfClosingElement;
}

export function isTypeNodeKind(kind: SyntaxKind): boolean {
  return (
    (kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode) ||
    kind === SyntaxKind.AnyKeyword ||
    kind === SyntaxKind.UnknownKeyword ||
    kind === SyntaxKind.NumberKeyword ||
    kind === SyntaxKind.BigIntKeyword ||
    kind === SyntaxKind.ObjectKeyword ||
    kind === SyntaxKind.BooleanKeyword ||
    kind === SyntaxKind.StringKeyword ||
    kind === SyntaxKind.SymbolKeyword ||
    kind === SyntaxKind.VoidKeyword ||
    kind === SyntaxKind.UndefinedKeyword ||
    kind === SyntaxKind.NeverKeyword ||
    kind === SyntaxKind.IntrinsicKeyword ||
    kind === SyntaxKind.ExpressionWithTypeArguments ||
    kind === SyntaxKind.JSDocAllType ||
    kind === SyntaxKind.JSDocNullableType ||
    kind === SyntaxKind.JSDocNonNullableType ||
    kind === SyntaxKind.JSDocOptionalType ||
    kind === SyntaxKind.JSDocVariadicType
  );
}

export function isTypeNode(node: Node): boolean {
  return isTypeNodeKind(node.kind);
}

export { isDeclarationName, isPartOfTypeNode };

// ---- Lines

export function getLineOfPosition(file: SourceFile, pos: number): number {
  const lineStarts = file.lineStarts();
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    if (lineStarts[middle] <= pos) low = middle + 1;
    else high = middle - 1;
  }
  return low - 1;
}

export function getLineStartPositionForPosition(position: number, file: SourceFile): number {
  return file.lineStarts()[getLineOfPosition(file, position)];
}

export function getLineEndOfPosition(file: SourceFile, pos: number): number {
  const line = getLineOfPosition(file, pos);
  const lineStarts = file.lineStarts();
  const text = file.text;
  const lastCharPos = line + 1 >= lineStarts.length ? file.end : lineStarts[line + 1] - 1;
  if (
    lastCharPos > 0 &&
    lastCharPos < text.length &&
    text.charCodeAt(lastCharPos) === 0x0a &&
    text.charCodeAt(lastCharPos - 1) === 0x0d
  )
    return lastCharPos - 1;
  return lastCharPos;
}

export function getLinesBetweenPositions(file: SourceFile, pos1: number, pos2: number): number {
  if (pos1 === pos2) return 0;
  const line1 = getLineOfPosition(file, pos1);
  const line2 = getLineOfPosition(file, pos2);
  return pos1 < pos2 ? line2 - line1 : line1 - line2;
}

// ---- Positions and tokens

/** Whether `position` is inside the text of a string or template literal token. */
export function isInString(file: SourceFile, position: number, previousToken: Node | undefined): boolean {
  if (previousToken !== undefined && isStringTextContainingNode(previousToken)) {
    const start = getStartOfNode(previousToken, file, false);
    const end = previousToken.end;
    if (start < position && position < end) return true;
    if (position === end) return isUnterminatedLiteral(previousToken);
  }
  return false;
}

/** The comment containing `position`, if any. */
export function isInComment(file: SourceFile, position: number, tokenAtPosition: Node): CommentRange | undefined {
  return getRangeOfEnclosingComment(file, position, findPrecedingToken(file, position), tokenAtPosition);
}

function getRangeOfEnclosingComment(
  file: SourceFile,
  position: number,
  precedingToken: Node | undefined,
  tokenAtPositionIn: Node,
): CommentRange | undefined {
  let tokenAtPosition = tokenAtPositionIn;
  const jsDoc = findAncestor(tokenAtPosition, (n) => n.kind === SyntaxKind.JSDoc);
  if (jsDoc !== undefined) tokenAtPosition = jsDoc.parent!;
  const tokenStart = getStartOfNode(tokenAtPosition, file, false);
  if (tokenStart <= position && position < tokenAtPosition.end) return undefined;
  const ranges: CommentRange[] = [];
  if (precedingToken !== undefined) ranges.push(...(getTrailingCommentRanges(file.text, precedingToken.end) ?? []));
  if (tokenAtPosition.kind !== SyntaxKind.JsxText)
    ranges.push(...(getLeadingCommentRanges(file.text, tokenAtPosition.pos) ?? []));
  for (const range of ranges) {
    // Single-line comments and unterminated comments at the end of the file contain their end.
    if (
      (range.pos < position && position < range.end) ||
      (position === range.end && (range.kind === SyntaxKind.SingleLineCommentTrivia || position === file.text.length))
    )
      return range;
  }
  return undefined;
}

/** Whether `position` belongs to `candidate`, which starts at or before it. */
export function positionBelongsToNode(candidate: Node, position: number, file: SourceFile): boolean {
  if (candidate.pos > position) throw new Error('Expected candidate.pos <= position');
  return position < candidate.end || !isCompletedNode(candidate, file);
}

export function isCompletedNode(n: Node | undefined, file: SourceFile): boolean {
  if (n === undefined || nodeIsMissing(n)) return false;
  switch (n.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.Block:
    case SyntaxKind.ModuleBlock:
    case SyntaxKind.CaseBlock:
    case SyntaxKind.NamedImports:
    case SyntaxKind.NamedExports:
      return nodeEndsWith(n, SyntaxKind.CloseBraceToken, file);
    case SyntaxKind.CatchClause:
      return n instanceof CatchClause && isCompletedNode(n.block, file);
    case SyntaxKind.NewExpression:
      if (getArguments(n) === undefined) return true;
      return nodeEndsWith(n, SyntaxKind.CloseParenToken, file);
    case SyntaxKind.CallExpression:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.ParenthesizedType:
      return nodeEndsWith(n, SyntaxKind.CloseParenToken, file);
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      return isCompletedNode(getType(n), file);
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ArrowFunction: {
      const body = getBody(n);
      if (body !== undefined) return isCompletedNode(body, file);
      const type = getType(n);
      if (type !== undefined) return isCompletedNode(type, file);
      return findChildOfKind(n, SyntaxKind.CloseParenToken, file) !== undefined;
    }
    case SyntaxKind.ModuleDeclaration: {
      const body = getBody(n);
      return body !== undefined && isCompletedNode(body, file);
    }
    case SyntaxKind.IfStatement:
      return n instanceof IfStatement && isCompletedNode(n.elseStatement ?? n.thenStatement, file);
    case SyntaxKind.ExpressionStatement:
      return (
        isCompletedNode(getExpression(n), file) || findChildOfKind(n, SyntaxKind.SemicolonToken, file) !== undefined
      );
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ArrayBindingPattern:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.ComputedPropertyName:
    case SyntaxKind.TupleType:
      return nodeEndsWith(n, SyntaxKind.CloseBracketToken, file);
    case SyntaxKind.IndexSignature: {
      const type = getType(n);
      if (type !== undefined) return isCompletedNode(type, file);
      return findChildOfKind(n, SyntaxKind.CloseBracketToken, file) !== undefined;
    }
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
      // These have no terminator token, so they're never complete.
      return false;
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.WhileStatement:
      return isCompletedNode(getStatement(n), file);
    case SyntaxKind.DoStatement:
      if (findChildOfKind(n, SyntaxKind.WhileKeyword, file) !== undefined)
        return nodeEndsWith(n, SyntaxKind.CloseParenToken, file);
      return isCompletedNode(getStatement(n), file);
    case SyntaxKind.TypeQuery:
      return n instanceof TypeQueryNode && isCompletedNode(n.exprName, file);
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.SpreadElement:
      return isCompletedNode(getExpression(n), file);
    case SyntaxKind.TaggedTemplateExpression:
      return n instanceof TaggedTemplateExpression && isCompletedNode(n.template, file);
    case SyntaxKind.TemplateExpression: {
      if (!(n instanceof TemplateExpression)) return false;
      const spans = n.templateSpans.nodes;
      return spans.length > 0 && isCompletedNode(spans[spans.length - 1], file);
    }
    case SyntaxKind.TemplateSpan:
      return n instanceof TemplateSpan && nodeIsPresent(n.literal);
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ImportDeclaration: {
      const specifier = getModuleSpecifier(n);
      return specifier !== undefined && nodeIsPresent(specifier);
    }
    case SyntaxKind.PrefixUnaryExpression:
      return n instanceof PrefixUnaryExpression && isCompletedNode(n.operand, file);
    case SyntaxKind.BinaryExpression:
      return n instanceof BinaryExpression && isCompletedNode(n.right, file);
    case SyntaxKind.ConditionalExpression:
      return n instanceof ConditionalExpression && isCompletedNode(n.whenFalse, file);
  }
  return true;
}

function nodeEndsWith(n: Node, expectedLastToken: SyntaxKind, file: SourceFile): boolean {
  const lastChildNode = getLastVisitedChild(n, file);
  const lastNodeAndTokens: Node[] = [];
  if (lastChildNode !== undefined) lastNodeAndTokens.push(lastChildNode);
  lastNodeAndTokens.push(...scanTokens(n, lastChildNode !== undefined ? lastChildNode.end : n.pos, n.end, file));
  if (lastNodeAndTokens.length === 0) return false;
  const lastChild = lastNodeAndTokens[lastNodeAndTokens.length - 1];
  if (lastChild.kind === expectedLastToken) return true;
  if (lastChild.kind === SyntaxKind.SemicolonToken && lastNodeAndTokens.length > 1)
    return lastNodeAndTokens[lastNodeAndTokens.length - 2].kind === expectedLastToken;
  return false;
}

// ---- Type arguments

export interface PossibleTypeArgumentInfo {
  called: Node;
  nTypeArguments: number;
}

/** Info for an expression like `f <` that may start type arguments. */
export function getPossibleTypeArgumentsInfo(
  tokenIn: Node | undefined,
  file: SourceFile,
): PossibleTypeArgumentInfo | undefined {
  // Without a `<` in the file there can't be type arguments.
  if (file.text.lastIndexOf('<') === -1) return undefined;
  let token = tokenIn;
  let remainingLessThanTokens = 0;
  let nTypeArguments = 0;
  while (token !== undefined) {
    switch (token.kind) {
      case SyntaxKind.LessThanToken:
        // The beginning of the type arguments.
        token = findPrecedingToken(file, token.pos);
        if (token !== undefined && token.kind === SyntaxKind.QuestionDotToken)
          token = findPrecedingToken(file, token.pos);
        if (token === undefined || token.kind !== SyntaxKind.Identifier) return undefined;
        if (remainingLessThanTokens === 0) {
          if (isDeclarationName(token)) return undefined;
          return { called: token, nTypeArguments };
        }
        remainingLessThanTokens--;
        break;
      case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        remainingLessThanTokens += 3;
        break;
      case SyntaxKind.GreaterThanGreaterThanToken:
        remainingLessThanTokens += 2;
        break;
      case SyntaxKind.GreaterThanToken:
        remainingLessThanTokens++;
        break;
      case SyntaxKind.CloseBraceToken:
        // An object type: skip to the matching open brace.
        token = findPrecedingMatchingToken(token, SyntaxKind.OpenBraceToken, file);
        if (token === undefined) return undefined;
        break;
      case SyntaxKind.CloseParenToken:
        token = findPrecedingMatchingToken(token, SyntaxKind.OpenParenToken, file);
        if (token === undefined) return undefined;
        break;
      case SyntaxKind.CloseBracketToken:
        token = findPrecedingMatchingToken(token, SyntaxKind.OpenBracketToken, file);
        if (token === undefined) return undefined;
        break;
      case SyntaxKind.CommaToken:
        nTypeArguments++;
        break;
      case SyntaxKind.EqualsGreaterThanToken:
      case SyntaxKind.Identifier:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.TypeOfKeyword:
      case SyntaxKind.ExtendsKeyword:
      case SyntaxKind.KeyOfKeyword:
      case SyntaxKind.DotToken:
      case SyntaxKind.BarToken:
      case SyntaxKind.QuestionToken:
      case SyntaxKind.ColonToken:
        break;
      default:
        if (!isTypeNode(token)) return undefined;
    }
    token = findPrecedingToken(file, token.pos);
  }
  return undefined;
}

function findPrecedingMatchingToken(tokenIn: Node, matchingTokenKind: SyntaxKind, file: SourceFile): Node | undefined {
  let token = tokenIn;
  const closeTokenText = tokenToString(token.kind);
  const matchingTokenText = tokenToString(matchingTokenKind);
  // A text search usually finds the match without counting nested tokens.
  const bestGuessIndex = file.text.lastIndexOf(matchingTokenText);
  if (bestGuessIndex === -1) return undefined;
  if (file.text.lastIndexOf(closeTokenText) < bestGuessIndex) {
    const nodeAtGuess = findPrecedingToken(file, bestGuessIndex + 1);
    if (nodeAtGuess !== undefined && nodeAtGuess.kind === matchingTokenKind) return nodeAtGuess;
  }
  const tokenKind = token.kind;
  let remainingMatchingTokens = 0;
  for (;;) {
    const preceding = findPrecedingToken(file, token.pos);
    if (preceding === undefined) return undefined;
    token = preceding;
    if (token.kind === matchingTokenKind) {
      if (remainingMatchingTokens === 0) return token;
      remainingMatchingTokens--;
    } else if (token.kind === tokenKind) remainingMatchingTokens++;
  }
}

export function getPossibleGenericSignatures(c: Checker, called: Node, typeArgumentCount: number): Signature[] {
  let typeAtLocation = getTypeAtLocation(c, called);
  const parent = called.parent!;
  if (isOptionalChain(parent))
    typeAtLocation = isOptionalChainRoot(parent)
      ? getNonNullableType(c, typeAtLocation)
      : getNonOptionalType(c, typeAtLocation);
  const signatures = getSignaturesOfType(
    c,
    typeAtLocation,
    parent.kind === SyntaxKind.NewExpression ? SignatureKind.Construct : SignatureKind.Call,
  );
  return signatures.filter((s) => s.typeParameters.length > 0 && s.typeParameters.length >= typeArgumentCount);
}

export function isPossiblyTypeArgumentPosition(c: Checker, token: Node | undefined, file: SourceFile): boolean {
  const info = getPossibleTypeArgumentsInfo(token, file);
  return (
    info !== undefined &&
    (isPartOfTypeNode(info.called) ||
      getPossibleGenericSignatures(c, info.called, info.nTypeArguments).length !== 0 ||
      isPossiblyTypeArgumentPosition(c, info.called, file))
  );
}

// ---- Arguments

export interface ArgumentInfoForCompletions {
  invocation: Node;
  argumentIndex: number;
  argumentCount: number;
}

/** The call and argument index at `node`, for a call, `new`, tagged template or JSX element. */
export function getArgumentInfoForCompletions(
  c: Checker,
  node: Node,
  position: number,
  file: SourceFile,
): ArgumentInfoForCompletions | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  if (parent.kind === SyntaxKind.CallExpression || parent.kind === SyntaxKind.NewExpression) {
    const info = getArgumentOrParameterListAndIndex(c, node, file);
    if (info === undefined) return undefined;
    const typeArgumentList = getCallTypeArgumentList(parent);
    // Type argument lists aren't argument positions.
    if (info.list !== undefined && typeArgumentList !== undefined && typeArgumentList.pos === info.list.pos)
      return undefined;
    return {
      invocation: parent,
      argumentIndex: info.argumentIndex,
      argumentCount: info.list !== undefined ? getArgumentCount(c, node, info.list, file) : 0,
    };
  }
  if (node.kind === SyntaxKind.NoSubstitutionTemplateLiteral && parent.kind === SyntaxKind.TaggedTemplateExpression) {
    if (isInsideTemplateLiteral(node, position, file))
      return { invocation: parent, argumentIndex: 0, argumentCount: 1 };
    return undefined;
  }
  if (node.kind === SyntaxKind.TemplateHead && parent.parent?.kind === SyntaxKind.TaggedTemplateExpression) {
    const tag = parent.parent;
    const argumentIndex = isInsideTemplateLiteral(node, position, file) ? 0 : 1;
    return { invocation: tag, argumentIndex, argumentCount: templateArgumentCount(tag) };
  }
  if (parent.kind === SyntaxKind.TemplateSpan && parent.parent?.parent?.kind === SyntaxKind.TaggedTemplateExpression) {
    const tag = parent.parent.parent;
    // Just after a template tail isn't an argument.
    if (node.kind === SyntaxKind.TemplateTail && !isInsideTemplateLiteral(node, position, file)) return undefined;
    const template = parent.parent as TemplateExpression;
    const spanIndex = template.templateSpans.nodes.indexOf(parent);
    let argumentIndex = spanIndex + 1;
    if (isTemplateLiteralKind(node.kind))
      argumentIndex = isInsideTemplateLiteral(node, position, file) ? 0 : spanIndex + 2;
    return { invocation: tag, argumentIndex, argumentCount: templateArgumentCount(tag) };
  }
  if (isJsxOpeningLikeElement(parent)) return { invocation: parent, argumentIndex: 0, argumentCount: 1 };
  return undefined;
}

function templateArgumentCount(tag: Node): number {
  if (!(tag instanceof TaggedTemplateExpression)) return 1;
  const template = tag.template;
  return template instanceof TemplateExpression ? template.templateSpans.nodes.length + 1 : 1;
}

function getCallTypeArgumentList(node: Node): NodeList | undefined {
  if (node instanceof CallExpression) return callTypeArguments(node);
  if (node instanceof NewExpression) return node.typeArguments;
  return undefined;
}

function getCallArgumentList(node: Node): NodeList | undefined {
  if (node instanceof CallExpression) return node.arguments;
  if (node instanceof NewExpression) return node.arguments;
  return undefined;
}

function isInsideTemplateLiteral(node: Node, position: number, file: SourceFile): boolean {
  return (
    isTemplateLiteralKind(node.kind) &&
    ((getStartOfNode(node, file, false) < position && position < node.end) ||
      (isUnterminatedLiteral(node) && position === node.end))
  );
}

interface ListAndIndex {
  list: NodeList | undefined;
  argumentIndex: number;
}

function getArgumentOrParameterListAndIndex(c: Checker, node: Node, file: SourceFile): ListAndIndex | undefined {
  if (node.kind === SyntaxKind.LessThanToken || node.kind === SyntaxKind.OpenParenToken) {
    // Just after the opener: the first item of the list that follows.
    const parent = node.parent!;
    const list = node.kind === SyntaxKind.LessThanToken ? getCallTypeArgumentList(parent) : getCallArgumentList(parent);
    return { list, argumentIndex: 0 };
  }
  const list = findContainingList(node);
  if (list === undefined) return undefined;
  return { list, argumentIndex: getArgumentIndex(c, node, list, file) };
}

/** The list of the parent of `node` whose range contains it. */
export function findContainingList(node: Node): NodeList | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  let result: NodeList | undefined;
  for (const list of getNodeListsOf(parent)) if (list.pos <= node.pos && node.end <= list.end) result = list;
  return result;
}

function getNodeListsOf(node: Node): NodeList[] {
  const lists: NodeList[] = [];
  node.forEachChild(new ListCollector(lists));
  return lists;
}

class ListCollector extends NodeVisitor {
  constructor(readonly lists: NodeList[]) {
    super();
  }

  visitNode(_node: Node): boolean {
    return false;
  }

  visitList(list: NodeList): boolean {
    this.lists.push(list);
    return false;
  }
}

function getArgumentIndex(c: Checker, node: Node, list: NodeList, file: SourceFile): number {
  return getArgumentIndexOrCount(c, getTokensOfNodeList(list, node.parent!, file), node);
}

function getArgumentCount(c: Checker, node: Node, list: NodeList, file: SourceFile): number {
  return getArgumentIndexOrCount(c, getTokensOfNodeList(list, node.parent!, file), undefined);
}

function getArgumentIndexOrCount(c: Checker, args: Node[], node: Node | undefined): number {
  let argumentIndex = 0;
  let skipComma = false;
  for (const arg of args) {
    if (node !== undefined && arg === node) {
      if (!skipComma && arg.kind === SyntaxKind.CommaToken) argumentIndex++;
      return argumentIndex;
    }
    if (arg.kind === SyntaxKind.SpreadElement) {
      argumentIndex += getSpreadElementCount(c, arg);
      skipComma = true;
      continue;
    }
    if (arg.kind !== SyntaxKind.CommaToken) {
      argumentIndex++;
      skipComma = true;
      continue;
    }
    if (skipComma) {
      skipComma = false;
      continue;
    }
    argumentIndex++;
  }
  if (node !== undefined) return argumentIndex;
  // `f(a,)` has two arguments.
  return args.length > 0 && args[args.length - 1].kind === SyntaxKind.CommaToken ? argumentIndex + 1 : argumentIndex;
}

function getSpreadElementCount(c: Checker, node: Node): number {
  const spreadType = getTypeAtLocation(c, getExpression(node)!);
  if (!isTupleType(spreadType)) return 0;
  const target = (spreadType as TypeReference).target;
  if (!(target instanceof TupleType)) return 0;
  const fixedLength = target.fixedLength;
  if (fixedLength === 0) return 0;
  const infos = target.elementInfos;
  for (let i = 0; i < infos.length; i++) if ((infos[i].flags & ElementFlags.Required) === 0) return i;
  return fixedLength;
}

// ---- Contextual types

export function walkUpParenthesizedExpressions(node: Node | undefined): Node | undefined {
  let n = node;
  while (n !== undefined && n.kind === SyntaxKind.ParenthesizedExpression) n = n.parent;
  return n;
}

export function isEqualityOperatorKind(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.EqualsEqualsEqualsToken ||
    kind === SyntaxKind.EqualsEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsToken
  );
}

export function getSwitchedType(c: Checker, caseClause: Node): Type {
  return getTypeAtLocation(c, getExpression(caseClause.parent!.parent!)!);
}

export function getContextualTypeFromParent(c: Checker, node: Node, contextFlags: ContextFlags): Type | undefined {
  const parent = walkUpParenthesizedExpressions(node.parent)!;
  switch (parent.kind) {
    case SyntaxKind.NewExpression:
      return getContextualTypeWithFlags(c, parent, contextFlags);
    case SyntaxKind.BinaryExpression: {
      const binary = parent as BinaryExpression;
      if (isEqualityOperatorKind(binary.operatorToken.kind))
        return getTypeAtLocation(c, node === binary.right ? binary.left : binary.right);
      return getContextualTypeWithFlags(c, node, contextFlags);
    }
    case SyntaxKind.CaseClause:
      return getSwitchedType(c, parent);
  }
  return getContextualTypeWithFlags(c, node, contextFlags);
}

export { ContextFlags };

// ---- Declarations

export function isInRightSideOfInternalImportEqualsDeclaration(nodeIn: Node): boolean {
  let node = nodeIn;
  if (node.parent === undefined) return false;
  while (node.parent!.kind === SyntaxKind.QualifiedName) node = node.parent!;
  const parent = node.parent!;
  return (
    parent instanceof ImportEqualsDeclaration &&
    parent.moduleReference.kind !== SyntaxKind.ExternalModuleReference &&
    parent.moduleReference === node
  );
}

/** The `extends` and `implements` type nodes of a class or interface. */
export function getAllSuperTypeNodes(node: Node): Node[] {
  const clauses = getHeritageClauses(node);
  const result: Node[] = [];
  if (node.kind === SyntaxKind.InterfaceDeclaration) {
    if (clauses !== undefined)
      for (const clause of clauses.nodes)
        if (clause instanceof HeritageClause && clause.token === SyntaxKind.ExtendsKeyword)
          result.push(...clause.types.nodes);
    return result;
  }
  if (isClassLike(node)) {
    const extendsElement = getClassExtendsHeritageElement(node);
    if (extendsElement !== undefined) result.push(extendsElement);
    if (clauses !== undefined)
      for (const clause of clauses.nodes)
        if (clause instanceof HeritageClause && clause.token === SyntaxKind.ImplementsKeyword)
          result.push(...clause.types.nodes);
  }
  return result;
}

export function getClassExtendsHeritageElement(node: Node): Node | undefined {
  const clauses = getHeritageClauses(node);
  if (clauses === undefined) return undefined;
  for (const clause of clauses.nodes)
    if (clause instanceof HeritageClause && clause.token === SyntaxKind.ExtendsKeyword)
      return clause.types.nodes.length > 0 ? clause.types.nodes[0] : undefined;
  return undefined;
}

// ---- Switch statements

/** The literal values of the `case` clauses of a switch statement. */
export class CaseClauseTracker {
  private readonly strings = new Set<string>();
  private readonly numbers = new Set<number>();
  private readonly bigInts = new Set<string>();

  constructor(c: Checker, clauses: Node[]) {
    for (const clause of clauses) {
      if (clause.kind === SyntaxKind.DefaultClause) continue;
      const clauseExpression = getExpression(clause)!;
      const expression = skipParentheses(clauseExpression);
      switch (expression.kind) {
        case SyntaxKind.NoSubstitutionTemplateLiteral:
        case SyntaxKind.StringLiteral:
          this.strings.add(literalText(expression));
          continue;
        case SyntaxKind.NumericLiteral:
          this.numbers.add(Number(literalText(expression)));
          continue;
        case SyntaxKind.BigIntLiteral:
          this.bigInts.add(normalizeBigInt(literalText(expression)));
          continue;
        case SyntaxKind.RegularExpressionLiteral:
        case SyntaxKind.TemplateHead:
        case SyntaxKind.TemplateMiddle:
        case SyntaxKind.TemplateTail:
          continue;
      }
      const symbol = getSymbolAtLocation(c, clauseExpression);
      if (
        symbol !== undefined &&
        symbol.valueDeclaration !== undefined &&
        symbol.valueDeclaration.kind === SyntaxKind.EnumMember
      ) {
        const value = getConstantValue(c, symbol.valueDeclaration);
        if (typeof value === 'string') this.strings.add(value);
        else if (typeof value === 'number') this.numbers.add(value);
      }
    }
  }

  hasString(value: string): boolean {
    return this.strings.has(value);
  }

  hasNumber(value: number): boolean {
    return this.numbers.has(value);
  }

  hasBigInt(value: string): boolean {
    return this.bigInts.has(value);
  }

  addString(value: string): void {
    this.strings.add(value);
  }

  addNumber(value: number): void {
    this.numbers.add(value);
  }
}

function literalText(node: Node): string {
  return getText(node);
}

/** A bigint literal's decimal text without the `n` suffix. */
export function normalizeBigInt(text: string): string {
  const digits = text.endsWith('n') ? text.substring(0, text.length - 1) : text;
  return BigInt(digits.replaceAll('_', '')).toString();
}

// ---- Quotes

export const enum QuotePreference {
  Double,
  Single,
}

// The quotes of the file's first module specifier, without the import of tslib that importHelpers adds.
export function getQuotePreference(file: SourceFile): QuotePreference {
  for (const specifier of file.imports) {
    if (specifier instanceof StringLiteral && specifier.parent!.pos >= 0)
      return (specifier.tokenFlags & TokenFlags.SingleQuote) !== 0 ? QuotePreference.Single : QuotePreference.Double;
  }
  return QuotePreference.Double;
}

/** `text` as a JSON string, escaped as Go's encoding/json does. */
export function stringifyJson(text: string): string {
  let result = JSON.stringify(text);
  let escaped = '';
  let start = 0;
  for (let i = 0; i < result.length; i++) {
    const ch = result.charCodeAt(i);
    let replacement = '';
    if (ch === 0x3c) replacement = '\\u003c';
    else if (ch === 0x3e) replacement = '\\u003e';
    else if (ch === 0x26) replacement = '\\u0026';
    else if (ch === 0x2028) replacement = '\\u2028';
    else if (ch === 0x2029) replacement = '\\u2029';
    else continue;
    escaped += result.substring(start, i) + replacement;
    start = i + 1;
  }
  return start === 0 ? result : escaped + result.substring(start);
}

function stripQuotes(name: string): string {
  if (name.length < 2) return name;
  const first = name.charCodeAt(0);
  if (first === name.charCodeAt(name.length - 1) && (first === 0x27 || first === 0x22 || first === 0x60))
    return name.substring(1, name.length - 1);
  return name;
}

/** `text` quoted for the file's quote style. */
export function quote(file: SourceFile, text: string): string {
  const quoted = stringifyJson(text);
  if (getQuotePreference(file) === QuotePreference.Single)
    return "'" + stripQuotes(quoted).replaceAll("'", "\\'").replaceAll('\\"', '"') + "'";
  return quoted;
}

// A property name as an element access writes it: a numeric name as it is, any other name quoted. A name that
// starts with a digit but is not a number's text, such as `0]; f(); x[`, is quoted too.
export function quotePropertyName(file: SourceFile, name: string): string {
  const ch = name.charCodeAt(0);
  if (ch >= 0x30 && ch <= 0x39 && String(Number(name)) === name) return name;
  return quote(file, name);
}

// ---- Automatic semicolon insertion

export function positionIsASICandidate(pos: number, context: Node, file: SourceFile): boolean {
  const contextAncestor = findAncestorOrQuit(context, (ancestor) => {
    if (ancestor.end !== pos) return FindAncestorResult.Quit;
    return syntaxMayBeASICandidate(ancestor.kind) ? FindAncestorResult.True : FindAncestorResult.False;
  });
  return contextAncestor !== undefined && nodeIsASICandidate(contextAncestor, file);
}

function syntaxRequiresTrailingCommaOrSemicolonOrASI(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.CallSignature ||
    kind === SyntaxKind.ConstructSignature ||
    kind === SyntaxKind.IndexSignature ||
    kind === SyntaxKind.PropertySignature ||
    kind === SyntaxKind.MethodSignature
  );
}

function syntaxRequiresTrailingFunctionBlockOrSemicolonOrASI(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.FunctionDeclaration ||
    kind === SyntaxKind.Constructor ||
    kind === SyntaxKind.MethodDeclaration ||
    kind === SyntaxKind.GetAccessor ||
    kind === SyntaxKind.SetAccessor
  );
}

function syntaxRequiresTrailingSemicolonOrASI(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.VariableStatement:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.ContinueStatement:
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.ThrowStatement:
    case SyntaxKind.DebuggerStatement:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.ExportAssignment:
      return true;
  }
  return false;
}

function syntaxMayBeASICandidate(kind: SyntaxKind): boolean {
  return (
    syntaxRequiresTrailingCommaOrSemicolonOrASI(kind) ||
    syntaxRequiresTrailingFunctionBlockOrSemicolonOrASI(kind) ||
    kind === SyntaxKind.ModuleDeclaration ||
    syntaxRequiresTrailingSemicolonOrASI(kind)
  );
}

function nodeIsASICandidate(node: Node, file: SourceFile): boolean {
  const lastToken = getLastToken(node, file);
  if (lastToken !== undefined && lastToken.kind === SyntaxKind.SemicolonToken) return false;
  if (syntaxRequiresTrailingCommaOrSemicolonOrASI(node.kind)) {
    if (lastToken !== undefined && lastToken.kind === SyntaxKind.CommaToken) return false;
  } else if (node.kind === SyntaxKind.ModuleDeclaration) {
    const lastChild = getLastChild(node, file);
    if (lastChild !== undefined && lastChild.kind === SyntaxKind.ModuleBlock) return false;
  } else if (syntaxRequiresTrailingFunctionBlockOrSemicolonOrASI(node.kind)) {
    const lastChild = getLastChild(node, file);
    if (lastChild !== undefined && isFunctionBlock(lastChild)) return false;
  } else if (!syntaxRequiresTrailingSemicolonOrASI(node.kind)) return false;
  if (node.kind === SyntaxKind.DoStatement) return true;
  const nextToken = findNextToken(node, file);
  if (nextToken === undefined || nextToken.kind === SyntaxKind.CloseBraceToken) return true;
  return getLineOfPosition(file, node.end) !== getLineOfPosition(file, getStartOfNode(nextToken, file, false));
}

function findNextToken(previousToken: Node, file: SourceFile): Node | undefined {
  // The token that starts where `previousToken` ends.
  const token = findPrecedingToken(file, skipTrivia(file.text, previousToken.end, false, false, false) + 1);
  return token !== undefined && token.pos === previousToken.end ? token : undefined;
}

/**
 * Whether the file probably ends statements with semicolons, from its first five statements and members that need a
 * semicolon or a line break: when one has a semicolon for each five without, or when at most one lacks one.
 */
export function probablyUsesSemicolons(file: SourceFile): boolean {
  const counter = new SemicolonCounter(file);
  file.forEachChild(counter);
  // One statement without a semicolon may be one being written.
  if (counter.withSemicolon === 0 && counter.withoutSemicolon <= 1) return true;
  if (counter.withoutSemicolon === 0) return true;
  return counter.withSemicolon * statementsToObserve > counter.withoutSemicolon;
}

const statementsToObserve = 5;

class SemicolonCounter extends NodeVisitor {
  withSemicolon = 0;
  withoutSemicolon = 0;

  constructor(private readonly file: SourceFile) {
    super();
  }

  visitNode(node: Node): boolean {
    const file = this.file;
    if ((node.flags & NodeFlags.Reparsed) !== 0) return false;
    if (syntaxRequiresTrailingSemicolonOrASI(node.kind)) {
      const lastToken = getLastToken(node, file);
      if (lastToken !== undefined && lastToken.kind === SyntaxKind.SemicolonToken) this.withSemicolon++;
      else this.withoutSemicolon++;
    } else if (syntaxRequiresTrailingCommaOrSemicolonOrASI(node.kind)) {
      const lastToken = getLastToken(node, file);
      if (lastToken !== undefined && lastToken.kind === SyntaxKind.SemicolonToken) this.withSemicolon++;
      else if (lastToken !== undefined && lastToken.kind !== SyntaxKind.CommaToken) {
        const lastTokenLine = getLineOfPosition(file, getStartOfNode(lastToken, file, false));
        const nextTokenLine = getLineOfPosition(file, skipTrivia(file.text, lastToken.end));
        // A missing semicolon in a single-line object type is insignificant.
        if (lastTokenLine !== nextTokenLine) this.withoutSemicolon++;
      }
    }
    if (this.withSemicolon + this.withoutSemicolon >= statementsToObserve) return true;
    return node.forEachChild(this);
  }
}
