// What syntax a subtree contains, computed as tsgo's subtree facts are. Downlevel transforms
// skip subtrees without the syntax they lower.
import {
  BinaryExpression,
  BindingElement,
  BindingPattern,
  CatchClause,
  ForInOrOfStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  MetaProperty,
  MethodDeclaration,
  ModifierFlags,
  type ModifierList,
  type Node,
  NodeFlags,
  NodeVisitor,
  NoSubstitutionTemplateLiteral,
  PropertyAccessExpression,
  TemplateHead,
  TemplateMiddle,
  TemplateTail,
  VariableDeclarationList,
  getModifiers,
  getName,
} from '../ast.js';
import { ClusteredIntLinkTable } from '../link-tables.js';
import { isTypeNodeKind } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { isImportCall } from '../ast-utilities.js';
import { TokenFlags } from '../types.js';
import { getElementsOfBindingOrAssignmentPattern, getTargetOfBindingOrAssignmentElement } from './destructuring.js';

export const enum SubtreeFacts {
  None = 0,
  ContainsTypeScript = 1 << 0,
  ContainsJsx = 1 << 1,
  ContainsUsing = 1 << 2,
  ContainsLogicalAssignments = 1 << 3,
  ContainsNullishCoalescing = 1 << 4,
  ContainsOptionalChaining = 1 << 5,
  ContainsMissingCatchClauseVariable = 1 << 6,
  /** A `...` in an object literal or object pattern somewhere inside; never cleared. */
  ContainsESObjectRestOrSpread = 1 << 7,
  ContainsForAwaitOrAsyncGenerator = 1 << 8,
  ContainsAnyAwait = 1 << 9,
  ContainsExponentiationOperator = 1 << 10,
  ContainsLexicalThis = 1 << 11,
  ContainsLexicalSuper = 1 << 12,
  /** A `...` anywhere; cleared when leaving a binding pattern. */
  ContainsRestOrSpread = 1 << 13,
  /** A `{ ...x }`; cleared when leaving most scopes. */
  ContainsObjectRestOrSpread = 1 << 14,
  ContainsAwait = 1 << 15,
  ContainsDynamicImport = 1 << 16,
  ContainsClassFields = 1 << 17,
  ContainsDecorators = 1 << 18,
  ContainsIdentifier = 1 << 19,
  ContainsPrivateIdentifierInExpression = 1 << 20,
  ContainsInvalidTemplateEscape = 1 << 21,

  ContainsLexicalThisOrSuper = ContainsLexicalThis | ContainsLexicalSuper,
}

// Facts that don't propagate out of a node to its parent.
const enum Exclusions {
  None = 0,
  ArrowFunction = SubtreeFacts.ContainsAwait | SubtreeFacts.ContainsObjectRestOrSpread,
  Function = SubtreeFacts.ContainsLexicalThisOrSuper |
    SubtreeFacts.ContainsAwait |
    SubtreeFacts.ContainsObjectRestOrSpread,
  Property = SubtreeFacts.ContainsLexicalThisOrSuper,
  Module = SubtreeFacts.ContainsLexicalThisOrSuper,
  ObjectRestOrSpread = SubtreeFacts.ContainsObjectRestOrSpread,
  BindingPattern = SubtreeFacts.ContainsRestOrSpread,
}

/** Marks a computed entry of `SyntaxFacts.cache`, whose facts may be `None`. */
const computedFacts = 1 << 30;

/** Memoized subtree facts for one emit; synthesized nodes get theirs on first use. */
export class SyntaxFacts extends NodeVisitor {
  /** The facts of each node, by node id, with `computedFacts` set. */
  private readonly cache: ClusteredIntLinkTable;
  private collected: SubtreeFacts;

  constructor() {
    super();
    this.cache = new ClusteredIntLinkTable();
    this.collected = SubtreeFacts.None;
  }

  of(node: Node): SubtreeFacts {
    const cached = this.cache.get(node.id);
    if (cached !== 0) return cached & ~computedFacts;
    const facts = this.compute(node);
    this.cache.set(node.id, facts | computedFacts);
    return facts;
  }

  has(node: Node, facts: SubtreeFacts): boolean {
    return (this.of(node) & facts) !== 0;
  }

  /** Whether the subtree has a `...` in a pattern or literal. */
  hasRestOrSpread(node: Node): boolean {
    return this.has(node, SubtreeFacts.ContainsRestOrSpread | SubtreeFacts.ContainsObjectRestOrSpread);
  }

  /** Whether the subtree has a `{ ...x }` in a pattern or literal, outside nested scopes. */
  hasObjectRestOrSpread(node: Node): boolean {
    return this.has(node, SubtreeFacts.ContainsObjectRestOrSpread);
  }

  /** The facts `node` contributes to its parent. */
  propagate(node: Node | undefined): SubtreeFacts {
    if (node === undefined) return SubtreeFacts.None;
    const kind = node.kind;
    if (isTypeNodeKind(kind) && kind !== SyntaxKind.ExpressionWithTypeArguments) return SubtreeFacts.ContainsTypeScript;
    const facts = this.of(node);
    switch (kind) {
      case SyntaxKind.ArrowFunction:
        return facts & ~Exclusions.ArrowFunction;
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.Constructor:
        return facts & ~Exclusions.Function;
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        return (facts & ~Exclusions.Function) | this.propagate(getName(node));
      case SyntaxKind.PropertyDeclaration:
        return (facts & ~Exclusions.Property) | this.propagate(getName(node));
      case SyntaxKind.ModuleDeclaration:
        return facts & ~Exclusions.Module;
      case SyntaxKind.ObjectLiteralExpression:
      case SyntaxKind.VariableDeclarationList:
      case SyntaxKind.CatchClause:
        return facts & ~Exclusions.ObjectRestOrSpread;
      case SyntaxKind.ObjectBindingPattern:
      case SyntaxKind.ArrayBindingPattern:
        return facts & ~Exclusions.BindingPattern;
    }
    return facts;
  }

  visitNode(node: Node): boolean {
    this.collected |= this.propagate(node);
    return false;
  }

  private children(node: Node): SubtreeFacts {
    const saved = this.collected;
    this.collected = SubtreeFacts.None;
    node.forEachChild(this);
    const facts = this.collected;
    this.collected = saved;
    return facts;
  }

  private compute(node: Node): SubtreeFacts {
    switch (node.kind) {
      case SyntaxKind.UsingKeyword:
        return SubtreeFacts.ContainsUsing;
      case SyntaxKind.AccessorKeyword:
      case SyntaxKind.PrivateIdentifier:
        return SubtreeFacts.ContainsClassFields;
      case SyntaxKind.AsyncKeyword:
        return SubtreeFacts.ContainsAnyAwait;
      case SyntaxKind.SuperKeyword:
        return SubtreeFacts.ContainsLexicalSuper;
      case SyntaxKind.ThisKeyword:
        return SubtreeFacts.ContainsLexicalThis;
      case SyntaxKind.AsteriskAsteriskToken:
      case SyntaxKind.AsteriskAsteriskEqualsToken:
        return SubtreeFacts.ContainsExponentiationOperator;
      case SyntaxKind.QuestionQuestionToken:
        return SubtreeFacts.ContainsNullishCoalescing;
      case SyntaxKind.QuestionDotToken:
        return SubtreeFacts.ContainsOptionalChaining;
      case SyntaxKind.QuestionQuestionEqualsToken:
      case SyntaxKind.BarBarEqualsToken:
      case SyntaxKind.AmpersandAmpersandEqualsToken:
        return SubtreeFacts.ContainsLogicalAssignments;
      case SyntaxKind.Identifier:
        return SubtreeFacts.ContainsIdentifier;
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return node instanceof NoSubstitutionTemplateLiteral && invalidEscape(node.templateFlags)
          ? SubtreeFacts.ContainsInvalidTemplateEscape
          : SubtreeFacts.None;
      case SyntaxKind.TemplateHead:
        return node instanceof TemplateHead && invalidEscape(node.templateFlags)
          ? SubtreeFacts.ContainsInvalidTemplateEscape
          : SubtreeFacts.None;
      case SyntaxKind.TemplateMiddle:
        return node instanceof TemplateMiddle && invalidEscape(node.templateFlags)
          ? SubtreeFacts.ContainsInvalidTemplateEscape
          : SubtreeFacts.None;
      case SyntaxKind.TemplateTail:
        return node instanceof TemplateTail && invalidEscape(node.templateFlags)
          ? SubtreeFacts.ContainsInvalidTemplateEscape
          : SubtreeFacts.None;
      case SyntaxKind.Decorator:
        return this.children(node) | SubtreeFacts.ContainsTypeScript | SubtreeFacts.ContainsDecorators;
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
        return (
          this.children(node) |
          (node instanceof ForInOrOfStatement && node.awaitModifier !== undefined
            ? SubtreeFacts.ContainsForAwaitOrAsyncGenerator
            : SubtreeFacts.None)
        );
      case SyntaxKind.ReturnStatement:
      case SyntaxKind.YieldExpression:
        // Returns and yields in an ES2018 async generator are awaited.
        return this.children(node) | SubtreeFacts.ContainsForAwaitOrAsyncGenerator;
      case SyntaxKind.AwaitExpression:
        return (
          this.children(node) |
          SubtreeFacts.ContainsAwait |
          SubtreeFacts.ContainsAnyAwait |
          SubtreeFacts.ContainsForAwaitOrAsyncGenerator
        );
      case SyntaxKind.CatchClause:
        return (
          this.children(node) |
          (node instanceof CatchClause && node.variableDeclaration === undefined
            ? SubtreeFacts.ContainsMissingCatchClauseVariable
            : SubtreeFacts.None)
        );
      case SyntaxKind.VariableDeclarationList:
        return (
          this.children(node) |
          (node instanceof VariableDeclarationList && (node.flags & NodeFlags.Using) !== 0
            ? SubtreeFacts.ContainsUsing
            : SubtreeFacts.None)
        );
      case SyntaxKind.ObjectBindingPattern:
      case SyntaxKind.ArrayBindingPattern:
        return this.bindingPattern(node as BindingPattern);
      case SyntaxKind.BindingElement:
        return (
          this.children(node) |
          (node instanceof BindingElement && node.dotDotDotToken !== undefined
            ? SubtreeFacts.ContainsRestOrSpread
            : SubtreeFacts.None)
        );
      case SyntaxKind.FunctionDeclaration:
        return this.children(node) | asyncFacts(node, (node as FunctionDeclaration).asteriskToken !== undefined);
      case SyntaxKind.FunctionExpression:
        return this.children(node) | asyncFacts(node, (node as FunctionExpression).asteriskToken !== undefined);
      case SyntaxKind.MethodDeclaration:
        return this.children(node) | asyncFacts(node, (node as MethodDeclaration).asteriskToken !== undefined);
      case SyntaxKind.ArrowFunction:
        return this.children(node) | asyncFacts(node, false);
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.ClassStaticBlockDeclaration:
        return this.children(node) | SubtreeFacts.ContainsClassFields;
      case SyntaxKind.BinaryExpression:
        return this.children(node) | this.binaryFacts(node as BinaryExpression);
      case SyntaxKind.PropertyAccessExpression:
        return (
          this.children(node) |
          (node instanceof PropertyAccessExpression && !(node.name instanceof Identifier)
            ? SubtreeFacts.ContainsPrivateIdentifierInExpression
            : SubtreeFacts.None)
        );
      case SyntaxKind.CallExpression:
        return this.children(node) | (isImportCall(node) ? SubtreeFacts.ContainsDynamicImport : SubtreeFacts.None);
      case SyntaxKind.MetaProperty:
        return node instanceof MetaProperty ? this.propagate(node.name) & ~SubtreeFacts.ContainsIdentifier : 0;
      case SyntaxKind.SpreadElement:
        return this.children(node) | SubtreeFacts.ContainsRestOrSpread;
      case SyntaxKind.SpreadAssignment:
        return (
          this.children(node) | SubtreeFacts.ContainsESObjectRestOrSpread | SubtreeFacts.ContainsObjectRestOrSpread
        );
      case SyntaxKind.JsxElement:
      case SyntaxKind.JsxAttributes:
      case SyntaxKind.JsxNamespacedName:
      case SyntaxKind.JsxOpeningElement:
      case SyntaxKind.JsxSelfClosingElement:
      case SyntaxKind.JsxFragment:
      case SyntaxKind.JsxOpeningFragment:
      case SyntaxKind.JsxClosingFragment:
      case SyntaxKind.JsxAttribute:
      case SyntaxKind.JsxSpreadAttribute:
      case SyntaxKind.JsxClosingElement:
      case SyntaxKind.JsxExpression:
      case SyntaxKind.JsxText:
        return this.children(node) | SubtreeFacts.ContainsJsx;
    }
    return this.children(node);
  }

  private bindingPattern(node: BindingPattern): SubtreeFacts {
    const elements = node.elements.nodes;
    const object = node.kind === SyntaxKind.ObjectBindingPattern;
    let facts = SubtreeFacts.None;
    for (const child of elements) {
      let element = this.propagate(child);
      if ((element & SubtreeFacts.ContainsRestOrSpread) !== 0) {
        element &= ~SubtreeFacts.ContainsRestOrSpread;
        if (object) element |= SubtreeFacts.ContainsObjectRestOrSpread | SubtreeFacts.ContainsESObjectRestOrSpread;
      }
      facts |= element;
    }
    return facts;
  }

  private binaryFacts(node: BinaryExpression): SubtreeFacts {
    const operator = node.operatorToken.kind;
    if (operator === SyntaxKind.InKeyword && node.left.kind === SyntaxKind.PrivateIdentifier)
      return SubtreeFacts.ContainsClassFields | SubtreeFacts.ContainsPrivateIdentifierInExpression;
    if (
      operator === SyntaxKind.EqualsToken &&
      (node.left.kind === SyntaxKind.ObjectLiteralExpression || node.left.kind === SyntaxKind.ArrayLiteralExpression) &&
      this.containsObjectRestOrSpread(node.left)
    )
      return SubtreeFacts.ContainsObjectRestOrSpread;
    return SubtreeFacts.None;
  }

  /** Whether a pattern has an object rest element, at any depth of nested assignment patterns. */
  containsObjectRestOrSpread(node: Node): boolean {
    const facts = this.of(node);
    if ((facts & SubtreeFacts.ContainsObjectRestOrSpread) !== 0) return true;
    if ((facts & SubtreeFacts.ContainsESObjectRestOrSpread) === 0) return false;
    // Nested spreads, as in `{ x: { a, ...b } = foo } = c`.
    const elements = getElementsOfBindingOrAssignmentPattern(node);
    for (const element of elements) {
      const target = getTargetOfBindingOrAssignmentElement(element);
      if (
        target !== undefined &&
        (target.kind === SyntaxKind.ObjectLiteralExpression || target.kind === SyntaxKind.ArrayLiteralExpression) &&
        this.containsObjectRestOrSpread(target)
      )
        return true;
    }
    return false;
  }
}

function invalidEscape(flags: TokenFlags): boolean {
  return (flags & TokenFlags.ContainsInvalidEscape) !== 0;
}

function asyncFacts(node: Node, generator: boolean): SubtreeFacts {
  const modifiers: ModifierList | undefined = getModifiers(node);
  if (modifiers === undefined || (modifiers.modifierFlags & ModifierFlags.Async) === 0) return SubtreeFacts.None;
  return generator ? SubtreeFacts.ContainsForAwaitOrAsyncGenerator : SubtreeFacts.ContainsAnyAwait;
}
