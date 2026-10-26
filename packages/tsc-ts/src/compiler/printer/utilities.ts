// Node predicates, literal text and line helpers shared by the printer and transforms.
import {
  BigIntLiteral,
  BinaryExpression,
  CallExpression,
  ConditionalExpression,
  ElementAccessExpression,
  InferTypeNode,
  NewExpression,
  type Node,
  NodeFlags,
  NoSubstitutionTemplateLiteral,
  NonNullExpression,
  NumericLiteral,
  ParenthesizedExpression,
  PartiallyEmittedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  RegularExpressionLiteral,
  AsExpression,
  SatisfiesExpression,
  SourceFile,
  StringLiteral,
  TaggedTemplateExpression,
  TemplateHead,
  TemplateMiddle,
  TemplateTail,
  ExpressionStatement,
  Identifier,
  PrivateIdentifier,
  getExpression,
} from '../ast.js';
import {
  OperatorPrecedence,
  getBinaryOperatorPrecedence,
  isJSDocTypeExpressionOrChild,
  normalizeJSDocTypeSourceText,
} from '../ast-utilities.js';
import {
  CharacterCodes,
  isDigit,
  isLineBreak,
  isUnicodeWhiteSpace,
  isWhiteSpaceLike,
  isWhiteSpaceSingleLine,
} from '../character-codes.js';
import { computeLineOfPosition, skipTrivia } from '../scanner.js';
import { SyntaxKind } from '../syntax-kind.js';
import { type CommentRange, TokenFlags } from '../types.js';
import { getBaseFileName } from '../path.js';

// Nodes

export function positionIsSynthesized(pos: number): boolean {
  return pos < 0;
}

export function nodeIsSynthesized(node: Node): boolean {
  return node.pos < 0 || node.end < 0;
}

/** Whether the parser (not a transform) created the node. */
export function isParseTreeNode(node: Node): boolean {
  return (node.flags & NodeFlags.Synthesized) === 0;
}

export function getSourceFileOfNode(node: Node | undefined): SourceFile | undefined {
  while (node !== undefined) {
    if (node instanceof SourceFile) return node;
    node = node.parent;
  }
  return undefined;
}

export function isPrologueDirective(node: Node): boolean {
  return (
    node instanceof ExpressionStatement && (node as ExpressionStatement).expression.kind === SyntaxKind.StringLiteral
  );
}

export function isKeywordKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword;
}

export function isPunctuationKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstPunctuation && kind <= SyntaxKind.LastPunctuation;
}

export function isLiteralKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstLiteralToken && kind <= SyntaxKind.LastLiteralToken;
}

export function isJSDocKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.JSDocTypeExpression && kind <= SyntaxKind.JSDocImportTag;
}

export function isMemberName(node: Node): boolean {
  return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier;
}

export function isModifier(node: Node): boolean {
  switch (node.kind) {
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

export function isOptionalChain(node: Node): boolean {
  if ((node.flags & NodeFlags.OptionalChain) === 0) return false;
  switch (node.kind) {
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NonNullExpression:
      return true;
  }
  return false;
}

export function isUnterminatedLiteral(node: Node): boolean {
  if (node instanceof StringLiteral) return (node.tokenFlags & TokenFlags.Unterminated) !== 0;
  if (node instanceof NumericLiteral) return (node.tokenFlags & TokenFlags.Unterminated) !== 0;
  if (node instanceof BigIntLiteral) return (node.tokenFlags & TokenFlags.Unterminated) !== 0;
  if (node instanceof RegularExpressionLiteral) return (node.tokenFlags & TokenFlags.Unterminated) !== 0;
  if (node instanceof NoSubstitutionTemplateLiteral) return (node.templateFlags & TokenFlags.Unterminated) !== 0;
  if (node instanceof TemplateHead) return (node.templateFlags & TokenFlags.Unterminated) !== 0;
  if (node instanceof TemplateMiddle) return (node.templateFlags & TokenFlags.Unterminated) !== 0;
  if (node instanceof TemplateTail) return (node.templateFlags & TokenFlags.Unterminated) !== 0;
  return false;
}

export function skipPartiallyEmittedExpressions(node: Node): Node {
  while (node instanceof PartiallyEmittedExpression) node = node.expression;
  return node;
}

/** Whether a variable declaration list declares `let`, `const`, `using` or `await using`, as `NodeFlags.BlockScoped`. */
export function blockScopeFlags(node: Node): NodeFlags {
  let flags = node.flags;
  const parent = node.parent;
  if (parent !== undefined && parent.kind === SyntaxKind.VariableStatement) flags |= parent.flags;
  return flags & NodeFlags.BlockScoped;
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

function isUnaryExpressionKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.AwaitExpression:
    case SyntaxKind.TypeAssertionExpression:
      return true;
  }
  return isLeftHandSideExpressionKind(kind);
}

export function isExpressionKind(kind: SyntaxKind): boolean {
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
      return true;
  }
  return isUnaryExpressionKind(kind);
}

export function isExpression(node: Node): boolean {
  return isExpressionKind(skipPartiallyEmittedExpressions(node).kind);
}

export function isTypeNodeKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.NumberKeyword:
    case SyntaxKind.BigIntKeyword:
    case SyntaxKind.ObjectKeyword:
    case SyntaxKind.BooleanKeyword:
    case SyntaxKind.StringKeyword:
    case SyntaxKind.SymbolKeyword:
    case SyntaxKind.VoidKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.NeverKeyword:
    case SyntaxKind.IntrinsicKeyword:
    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.JSDocAllType:
    case SyntaxKind.JSDocNullableType:
    case SyntaxKind.JSDocNonNullableType:
    case SyntaxKind.JSDocOptionalType:
    case SyntaxKind.JSDocVariadicType:
      return true;
  }
  return kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode;
}

function isDeclarationStatementKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MissingDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.NamespaceExportDeclaration:
      return true;
  }
  return false;
}

function isStatementKindButNotDeclarationKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ContinueStatement:
    case SyntaxKind.DebuggerStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.EmptyStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.IfStatement:
    case SyntaxKind.LabeledStatement:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.ThrowStatement:
    case SyntaxKind.TryStatement:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.NotEmittedStatement:
      return true;
  }
  return false;
}

export function isFunctionLikeKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.JSDocSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      return true;
  }
  return false;
}

export function isStatement(node: Node): boolean {
  const kind = node.kind;
  if (isStatementKindButNotDeclarationKind(kind) || isDeclarationStatementKind(kind)) return true;
  if (kind !== SyntaxKind.Block) return false;
  const parent = node.parent;
  if (parent === undefined) return true;
  return (
    parent.kind !== SyntaxKind.TryStatement &&
    parent.kind !== SyntaxKind.CatchClause &&
    !isFunctionLikeKind(parent.kind)
  );
}

// Precedence

export function getExpressionPrecedence(expression: Node): OperatorPrecedence {
  switch (expression.kind) {
    case SyntaxKind.SpreadElement:
      return OperatorPrecedence.Spread;
    case SyntaxKind.YieldExpression:
      return OperatorPrecedence.Yield;
    case SyntaxKind.ArrowFunction:
      return OperatorPrecedence.Assignment;
    case SyntaxKind.ConditionalExpression:
      return OperatorPrecedence.Conditional;
    case SyntaxKind.BinaryExpression:
      if (expression instanceof BinaryExpression) {
        const operator = expression.operatorToken.kind;
        if (operator === SyntaxKind.CommaToken) return OperatorPrecedence.Comma;
        if (operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment)
          return OperatorPrecedence.Assignment;
        return getBinaryOperatorPrecedence(operator);
      }
      return OperatorPrecedence.Invalid;
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.AwaitExpression:
      return OperatorPrecedence.Unary;
    case SyntaxKind.PostfixUnaryExpression:
      return OperatorPrecedence.Update;
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.CallExpression:
      return isOptionalChain(expression) ? OperatorPrecedence.OptionalChain : OperatorPrecedence.Member;
    case SyntaxKind.NewExpression:
      return expression instanceof NewExpression && expression.arguments === undefined
        ? OperatorPrecedence.LeftHandSide
        : OperatorPrecedence.Member;
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.MetaProperty:
    case SyntaxKind.ExpressionWithTypeArguments:
      return OperatorPrecedence.Member;
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
      return OperatorPrecedence.Relational;
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.ImportKeyword:
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.OmittedExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.MissingDeclaration:
      return OperatorPrecedence.Primary;
    case SyntaxKind.ParenthesizedExpression:
      return OperatorPrecedence.Parentheses;
  }
  return OperatorPrecedence.Invalid;
}

export const enum TypePrecedence {
  Conditional = 0,
  JSDoc = 1,
  Function = 2,
  Union = 3,
  Intersection = 4,
  TypeOperator = 5,
  Postfix = 6,
  NonArray = 7,
  Lowest = Conditional,
  Highest = NonArray,
}

export function getTypeNodePrecedence(node: Node): TypePrecedence {
  switch (node.kind) {
    case SyntaxKind.ConditionalType:
      return TypePrecedence.Conditional;
    case SyntaxKind.JSDocOptionalType:
    case SyntaxKind.JSDocVariadicType:
      return TypePrecedence.JSDoc;
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      return TypePrecedence.Function;
    case SyntaxKind.UnionType:
      return TypePrecedence.Union;
    case SyntaxKind.IntersectionType:
      return TypePrecedence.Intersection;
    case SyntaxKind.TypeOperator:
    case SyntaxKind.TypeQuery:
      return TypePrecedence.TypeOperator;
    case SyntaxKind.InferType:
      return node instanceof InferTypeNode && node.typeParameter.constraint !== undefined
        ? TypePrecedence.Function
        : TypePrecedence.TypeOperator;
    case SyntaxKind.IndexedAccessType:
    case SyntaxKind.ArrayType:
    case SyntaxKind.OptionalType:
      return TypePrecedence.Postfix;
  }
  return TypePrecedence.NonArray;
}

/** The leftmost operand of an expression, e.g. `a` in `a.b + c`. */
export function getLeftmostExpression(node: Node, stopAtCallExpressions: boolean): Node {
  for (;;) {
    if (node instanceof PostfixUnaryExpression) node = node.operand;
    else if (node instanceof BinaryExpression) node = node.left;
    else if (node instanceof ConditionalExpression) node = node.condition;
    else if (node instanceof TaggedTemplateExpression) node = node.tag;
    else if (node instanceof PartiallyEmittedExpression) node = node.expression;
    else if (node instanceof CallExpression) {
      if (stopAtCallExpressions) return node;
      node = node.expression;
    } else if (
      node instanceof AsExpression ||
      node instanceof ElementAccessExpression ||
      node instanceof PropertyAccessExpression ||
      node instanceof NonNullExpression ||
      node instanceof PartiallyEmittedExpression ||
      node instanceof SatisfiesExpression
    ) {
      const expression = getExpression(node);
      if (expression === undefined) return node;
      node = expression;
    } else return node;
  }
}

export function skipSynthesizedParentheses(node: Node): Node {
  while (node instanceof ParenthesizedExpression && nodeIsSynthesized(node)) node = node.expression;
  return node;
}

export function isNewExpressionWithoutArguments(node: Node): boolean {
  return node instanceof NewExpression && node.arguments === undefined;
}

export function isBinaryOperation(node: Node, token: SyntaxKind): boolean {
  node = skipPartiallyEmittedExpressions(node);
  return node instanceof BinaryExpression && node.operatorToken.kind === token;
}

export function mixingBinaryOperatorsRequiresParentheses(a: SyntaxKind, b: SyntaxKind): boolean {
  if (a === SyntaxKind.QuestionQuestionToken)
    return b === SyntaxKind.AmpersandAmpersandToken || b === SyntaxKind.BarBarToken;
  if (b === SyntaxKind.QuestionQuestionToken)
    return a === SyntaxKind.AmpersandAmpersandToken || a === SyntaxKind.BarBarToken;
  return false;
}

export function isImmediatelyInvokedFunctionExpressionOrArrowFunction(node: Node): boolean {
  node = skipPartiallyEmittedExpressions(node);
  if (!(node instanceof CallExpression)) return false;
  const callee = skipPartiallyEmittedExpressions(node.expression);
  return callee.kind === SyntaxKind.FunctionExpression || callee.kind === SyntaxKind.ArrowFunction;
}

export function getOperatorOfPrefixOperand(node: Node): SyntaxKind {
  return node instanceof PrefixUnaryExpression ? node.operator : SyntaxKind.Unknown;
}

// Literal text

export const enum LiteralTextFlags {
  None = 0,
  NeverAsciiEscape = 1 << 0,
  JsxAttributeEscape = 1 << 1,
  TerminateUnterminatedLiterals = 1 << 2,
  AllowNumericSeparator = 1 << 3,
}

const hexDigits = '0123456789ABCDEF';

function hex(code: number): string {
  let s = '';
  do {
    s = hexDigits.charAt(code & 15) + s;
    code = code >>> 4;
  } while (code > 0);
  return s;
}

function utf16Escape(code: number): string {
  const digits = hex(code);
  return '\\u' + '0000'.substring(digits.length) + digits;
}

function escapedChar(ch: number): string {
  switch (ch) {
    case CharacterCodes.tab:
      return '\\t';
    case CharacterCodes.verticalTab:
      return '\\v';
    case CharacterCodes.formFeed:
      return '\\f';
    case CharacterCodes.backspace:
      return '\\b';
    case CharacterCodes.carriageReturn:
      return '\\r';
    case CharacterCodes.lineFeed:
      return '\\n';
    case CharacterCodes.backslash:
      return '\\\\';
    case CharacterCodes.doubleQuote:
      return '\\"';
    case CharacterCodes.singleQuote:
      return "\\'";
    case CharacterCodes.backtick:
      return '\\`';
    case CharacterCodes.$:
      return '\\$';
    case CharacterCodes.lineSeparator:
      return '\\u2028';
    case CharacterCodes.paragraphSeparator:
      return '\\u2029';
    case CharacterCodes.nextLine:
      return '\\u0085';
  }
  return utf16Escape(ch);
}

/**
 * Escapes `s` for a literal quoted with `quote`, as ECMA-262's QuoteJSONString plus LS, PS
 * and NEL; non-ASCII characters too unless `NeverAsciiEscape` is set. Doesn't add quotes.
 */
export function escapeString(s: string, quote: number, flags: LiteralTextFlags): string {
  let out = '';
  let start = 0;
  const length = s.length;
  for (let i = 0; i < length;) {
    let ch = s.charCodeAt(i);
    let size = 1;
    if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        ch = (ch - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        size = 2;
      }
    }
    let escape = ch >= 0xd800 && ch <= 0xdfff;
    switch (ch) {
      case CharacterCodes.backslash:
        if ((flags & LiteralTextFlags.JsxAttributeEscape) === 0) escape = true;
        break;
      case CharacterCodes.$:
        if (quote === CharacterCodes.backtick && i + 1 < length && s.charCodeAt(i + 1) === CharacterCodes.openBrace)
          escape = true;
        break;
      case CharacterCodes.lineSeparator:
      case CharacterCodes.paragraphSeparator:
      case CharacterCodes.nextLine:
      case CharacterCodes.carriageReturn:
        escape = true;
        break;
      case CharacterCodes.lineFeed:
        if (quote !== CharacterCodes.backtick) escape = true;
        break;
      default:
        if (ch === quote || ch <= 0x1f || ((flags & LiteralTextFlags.NeverAsciiEscape) === 0 && ch > 0x7f))
          escape = true;
    }
    if (escape) {
      if (start < i) out += s.substring(start, i);
      if ((flags & LiteralTextFlags.JsxAttributeEscape) !== 0) {
        if (ch === 0) out += '&#0;';
        else if (ch === CharacterCodes.doubleQuote) out += '&quot;';
        else if (ch === CharacterCodes.singleQuote) out += '&apos;';
        else out += '&#x' + hex(ch) + ';';
      } else if (
        ch === CharacterCodes.carriageReturn &&
        quote === CharacterCodes.backtick &&
        i + 1 < length &&
        s.charCodeAt(i + 1) === CharacterCodes.lineFeed
      ) {
        size++;
        out += '\\r\\n';
      } else if (ch > 0xffff) {
        const c = ch - 0x10000;
        out += utf16Escape((c >> 10) + 0xd800) + utf16Escape((c & 0x3ff) + 0xdc00);
      } else if (ch === 0) {
        out += i + 1 < length && isDigit(s.charCodeAt(i + 1)) ? '\\x00' : '\\0';
      } else out += escapedChar(ch);
      start = i + size;
    }
    i += size;
  }
  if (start === 0) return s;
  if (start < length) out += s.substring(start);
  return out;
}

function canUseOriginalText(node: Node, flags: LiteralTextFlags): boolean {
  if (
    nodeIsSynthesized(node) ||
    node.parent === undefined ||
    ((flags & LiteralTextFlags.TerminateUnterminatedLiterals) !== 0 && isUnterminatedLiteral(node))
  )
    return false;
  if (node instanceof NumericLiteral) {
    if ((node.tokenFlags & TokenFlags.IsInvalid) !== 0) return false;
    if ((node.tokenFlags & TokenFlags.ContainsSeparator) !== 0)
      return (flags & LiteralTextFlags.AllowNumericSeparator) !== 0;
  }
  return node.kind !== SyntaxKind.BigIntLiteral;
}

function templateText(open: string, text: string, rawText: string, close: string, flags: LiteralTextFlags): string {
  if (rawText.length > 0 || text.length === 0) return open + rawText + close;
  return open + escapeString(text, CharacterCodes.backtick, flags) + close;
}

/** The text of a literal as written, or its canonical (escaped, quoted) form for synthesized literals. */
export function getLiteralText(node: Node, sourceText: string | undefined, flags: LiteralTextFlags): string {
  if (sourceText !== undefined && canUseOriginalText(node, flags)) return getSourceTextOfNode(sourceText, node);
  if (node instanceof StringLiteral) {
    const quote =
      (node.tokenFlags & TokenFlags.SingleQuote) !== 0 ? CharacterCodes.singleQuote : CharacterCodes.doubleQuote;
    const q = quote === CharacterCodes.singleQuote ? "'" : '"';
    return q + escapeString(node.text, quote, flags) + q;
  }
  if (node instanceof NoSubstitutionTemplateLiteral) return templateText('`', node.text, '', '`', flags);
  if (node instanceof TemplateHead) return templateText('`', node.text, node.rawText, '${', flags);
  if (node instanceof TemplateMiddle) return templateText('}', node.text, node.rawText, '${', flags);
  if (node instanceof TemplateTail) return templateText('}', node.text, node.rawText, '`', flags);
  if (node instanceof NumericLiteral) return node.text;
  if (node instanceof BigIntLiteral) return node.text;
  if (node instanceof RegularExpressionLiteral) {
    const text = node.text;
    if ((flags & LiteralTextFlags.TerminateUnterminatedLiterals) !== 0 && isUnterminatedLiteral(node))
      return text.length > 0 && text.charCodeAt(text.length - 1) === CharacterCodes.backslash
        ? text + ' /'
        : text + '/';
    return text;
  }
  throw new Error('Unsupported literal');
}

/** The source text of a node without leading trivia, as tsgo's GetSourceTextOfNodeFromSourceFile. */
export function getSourceTextOfNode(sourceText: string, node: Node): string {
  if (node.pos === node.end && node.pos >= 0 && node.kind !== SyntaxKind.EndOfFile) return '';
  let text = sourceText.substring(skipTrivia(sourceText, node.pos), node.end);
  if (isJSDocTypeExpressionOrChild(node)) text = normalizeJSDocTypeSourceText(text);
  if ((node.flags & NodeFlags.ReparserTransformedLiteral) !== 0) {
    if (node instanceof StringLiteral)
      return (node.tokenFlags & TokenFlags.SingleQuote) !== 0 ? "'" + text + "'" : '"' + text + '"';
    return getTextOfIdentifierLike(node);
  }
  return text;
}

function getTextOfIdentifierLike(node: Node): string {
  if (node instanceof Identifier) return node.text;
  if (node instanceof PrivateIdentifier) return node.text;
  throw new Error('Unexpected reparser-transformed node kind');
}

// Lines

/** Go's `strings.TrimSpace`: trims Unicode White_Space. */
export function trimUnicodeSpace(text: string, start: number, end: number): string {
  while (start < end && isUnicodeWhiteSpace(text.charCodeAt(start))) start++;
  while (end > start && isUnicodeWhiteSpace(text.charCodeAt(end - 1))) end--;
  return text.substring(start, end);
}

/** The zero-based line of `pos`, searching from line `low`. */
function lineOfPosition(lineStarts: readonly number[], pos: number, low: number): number {
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const value = lineStarts[middle] | 0;
    if (value < pos) low = middle + 1;
    else if (value > pos) high = middle - 1;
    else return middle;
  }
  return low - 1;
}

export function getLinesBetweenPositions(lineStarts: readonly number[], pos1: number, pos2: number): number {
  if (pos1 === pos2) return 0;
  const negative = pos2 < pos1;
  const lower = negative ? pos2 : pos1;
  const upper = negative ? pos1 : pos2;
  const lowerLine = computeLineOfPosition(lineStarts, lower);
  const upperLine = lineOfPosition(lineStarts, upper, lowerLine < 0 ? 0 : lowerLine);
  return negative ? lowerLine - upperLine : upperLine - lowerLine;
}

export function getStartPositionOfRange(text: string, pos: number, includeComments: boolean): number {
  if (pos < 0) return -1;
  return skipTrivia(text, pos, false, includeComments);
}

export function getPreviousNonWhitespacePosition(text: string, pos: number, stopPos: number): number {
  for (; pos >= stopPos; pos--) if (!isWhiteSpaceLike(text.charCodeAt(pos))) return pos;
  return -1;
}

/** Columns of leading whitespace in `text[pos:end]`, with tabs to the next multiple of 4. */
export function calculateIndent(text: string, pos: number, end: number): number {
  let indent = 0;
  for (; pos < end; pos++) {
    const ch = text.charCodeAt(pos);
    if (!isWhiteSpaceSingleLine(ch)) break;
    if (ch === CharacterCodes.tab) indent += 4 - (indent & 3);
    else indent++;
  }
  return indent;
}

export function isLineBreakChar(ch: number): boolean {
  return isLineBreak(ch);
}

// Comments

export function isJSDocLikeText(text: string, comment: CommentRange): boolean {
  return (
    comment.kind === SyntaxKind.MultiLineCommentTrivia &&
    comment.end - comment.pos >= 5 &&
    text.charCodeAt(comment.pos + 2) === CharacterCodes.asterisk &&
    text.charCodeAt(comment.pos + 3) !== CharacterCodes.slash
  );
}

export function isPinnedComment(text: string, comment: CommentRange): boolean {
  return (
    comment.kind === SyntaxKind.MultiLineCommentTrivia &&
    comment.end - comment.pos > 5 &&
    text.charCodeAt(comment.pos + 2) === CharacterCodes.exclamation
  );
}

function skipWhiteSpaceSingleLine(text: string, pos: number): number {
  while (pos < text.length && isWhiteSpaceSingleLine(text.charCodeAt(pos))) pos++;
  return pos;
}

function skipQuotedString(text: string, pos: number): number {
  const quote = text.charCodeAt(pos);
  if (quote !== CharacterCodes.singleQuote && quote !== CharacterCodes.doubleQuote) return -1;
  const close = text.indexOf(quote === CharacterCodes.singleQuote ? "'" : '"', pos + 1);
  return close < 0 ? -1 : close + 1;
}

function skipAttribute(text: string, pos: number, names: readonly string[]): number {
  const next = skipWhiteSpaceSingleLine(text, pos);
  if (next === pos) return -1;
  pos = next;
  let matched = false;
  for (const name of names) {
    if (text.startsWith(name, pos)) {
      pos += name.length;
      matched = true;
      break;
    }
  }
  if (!matched) return -1;
  pos = skipWhiteSpaceSingleLine(text, pos);
  if (text.charCodeAt(pos) !== CharacterCodes.equals) return -1;
  return skipQuotedString(text, skipWhiteSpaceSingleLine(text, pos + 1));
}

const referenceAttributes: readonly string[] = ['path', 'types', 'lib', 'no-default-lib'];
const amdDependencyAttributes: readonly string[] = ['path'];

/** `/// <reference …/>`, `/// <amd-dependency path="…"/>` and `/// <amd-module/>` comments. */
export function isRecognizedTripleSlashComment(sourceText: string, comment: CommentRange): boolean {
  if (
    comment.kind !== SyntaxKind.SingleLineCommentTrivia ||
    comment.end - comment.pos <= 2 ||
    sourceText.charCodeAt(comment.pos + 1) !== CharacterCodes.slash ||
    sourceText.charCodeAt(comment.pos + 2) !== CharacterCodes.slash
  )
    return false;
  const text = sourceText.substring(comment.pos + 3, comment.end);
  let pos = skipWhiteSpaceSingleLine(text, 0);
  if (text.charCodeAt(pos) !== CharacterCodes.lessThan) return false;
  pos++;
  if (text.startsWith('reference', pos)) pos = skipAttribute(text, pos + 9, referenceAttributes);
  else if (text.startsWith('amd-dependency', pos)) pos = skipAttribute(text, pos + 14, amdDependencyAttributes);
  else if (text.startsWith('amd-module', pos)) pos = skipWhiteSpaceSingleLine(text, pos + 10);
  else return false;
  return pos >= 0 && text.indexOf('/>', pos) >= 0;
}

// Names

export function formatGeneratedName(privateName: boolean, prefix: string, base: string, suffix: string): string {
  const name = removeLeadingHash(prefix) + removeLeadingHash(base) + removeLeadingHash(suffix);
  return privateName ? ensureLeadingHash(name) : name;
}

export function removeLeadingHash(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === CharacterCodes.hash ? text.substring(1) : text;
}

export function ensureLeadingHash(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === CharacterCodes.hash ? text : '#' + text;
}

function isASCIIWordCharacter(ch: number): boolean {
  return (
    (ch >= CharacterCodes.a && ch <= CharacterCodes.z) ||
    (ch >= CharacterCodes.A && ch <= CharacterCodes.Z) ||
    isDigit(ch) ||
    ch === CharacterCodes._
  );
}

/** An identifier for a module's base name, e.g. `foo_bar` for `./foo-bar`; one `_` per UTF-8 byte of other characters. */
export function makeIdentifierFromModuleName(moduleName: string): string {
  moduleName = getBaseFileName(moduleName);
  let out = '';
  let start = 0;
  for (let pos = 0; pos < moduleName.length; pos++) {
    const ch = moduleName.charCodeAt(pos);
    if (pos === 0 && isDigit(ch)) out += '_';
    else if (!isASCIIWordCharacter(ch)) {
      if (start < pos) out += moduleName.substring(start, pos);
      if (ch < 0x80) out += '_';
      else if (ch < 0x800) out += '__';
      else if (ch >= 0xd800 && ch <= 0xdbff && pos + 1 < moduleName.length) {
        out += '____';
        pos++;
      } else out += '___';
      start = pos + 1;
    }
  }
  if (start < moduleName.length) out += moduleName.substring(start);
  return out;
}

export function lineOf(lineStarts: readonly number[], pos: number): number {
  return computeLineOfPosition(lineStarts, pos);
}
