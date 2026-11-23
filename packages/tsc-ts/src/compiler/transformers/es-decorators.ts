// Standard (TC39) decorators: decorated classes become an IIFE that applies `__esDecorate` to
// each decorated element and the class, and runs initializers with `__runInitializers`.
//
// Evaluation order: class decorators, then the heritage clause, then for each member its
// decorators and computed name; then static and instance method/accessor decorators, static and
// instance field decorators, class decorators; then static extra initializers, static fields and
// blocks, and class extra initializers. Constructors run instance extra initializers first, then
// each instance field's initializer and extra initializers.
import {
  ArrayLiteralExpression,
  BinaryExpression,
  BindingElement,
  Block,
  CallExpression,
  ClassDeclaration,
  ClassExpression,
  CatchClause,
  ClassStaticBlockDeclaration,
  ComputedPropertyName,
  ConstructorDeclaration,
  Decorator,
  ElementAccessExpression,
  ExportAssignment,
  ExpressionStatement,
  ExpressionWithTypeArguments,
  ForStatement,
  FunctionExpression,
  GetAccessorDeclaration,
  Identifier,
  IfStatement,
  MethodDeclaration,
  ModifierFlags,
  ModifierList,
  type Node,
  NodeFlags,
  NodeList,
  ObjectLiteralExpression,
  ParameterDeclaration,
  ParenthesizedExpression,
  PartiallyEmittedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyDeclaration,
  SetAccessorDeclaration,
  ShorthandPropertyAssignment,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  SyntaxList,
  TaggedTemplateExpression,
  Token,
  TryStatement,
  VariableDeclaration,
  VariableStatement,
  getBody,
  getModifiers,
  getName,
  getParameters,
} from '../ast.js';
import { isLeftHandSideExpression } from '../ast-utilities.js';
import {
  hasSyntacticModifier,
  hasStaticModifier,
  isAssignmentExpression,
  isAutoAccessorPropertyDeclaration,
  isClassLike,
  isDestructuringAssignment,
  isMethodOrAccessor,
  isPrivateIdentifierClassElementDeclaration,
  isPropertyNameLiteral,
  isStatic,
  skipParentheses,
} from '../binder-utilities.js';
import { type CompilerOptions, ScriptTarget, getEmitScriptTarget, getUseDefineForClassFields } from '../options.js';
import {
  createESDecorateHelper,
  createPropKeyHelper,
  createRunInitializersHelper,
  createSetFunctionNameHelper,
} from '../printer/decorator-helpers.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { NameOptions } from '../printer/factory.js';
import { isIdentifierText } from '../scanner.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  countPrologueDirectives,
  createAccessorPropertyBackingField,
  createExportDefault,
  createExternalModuleExport,
  getClassHeritageClauses,
  getClassMembers,
  getClassName,
  expandPreOrPostfixIncrementOrDecrementExpression,
  findComputedPropertyNameCacheAssignment,
  findSuperStatementIndexPath,
  getHeritageClause,
  getNonAssignmentOperatorForCompoundAssignment,
  injectClassThisAssignmentIfMissing,
  isClassThisAssignmentBlock,
  isCompoundAssignment,
  isSuperProperty,
} from './class-utilities.js';
import {
  childIsDecorated,
  classOrConstructorParameterIsDecorated,
  getDecorators,
  getFirstConstructorWithBody,
  isSimpleInlineableExpression,
  moveRangePastDecorators,
  moveRangePastModifiers,
  nodeIsDecorated,
  nodeOrChildIsDecorated,
} from './decorator-utilities.js';
import {
  AnonymousFunctionFilter,
  classHasDeclaredOrExplicitlyAssignedName,
  injectClassNamedEvaluationHelperBlockIfMissing,
  isClassNamedEvaluationHelperBlock,
  isNamedEvaluation,
  transformNamedEvaluation,
} from './named-evaluation.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { hasDecorators, singleOrMany, OuterExpressionKinds, skipOuterExpressions } from './utilities.js';
import { VisitorBase } from './visitor-base.js';

const enum LexicalEntryKind {
  Class,
  ClassElement,
  Name,
  Other,
}

/** An entry of the stack of classes, class elements, names and other scopes being visited. */
class LexicalEntry {
  readonly kind: LexicalEntryKind;
  readonly next: LexicalEntry | undefined;
  readonly classInfo: ClassInfo | undefined;
  readonly savedPendingExpressions: Node[] | undefined;
  classThis: Identifier | undefined;
  classSuper: Identifier | undefined;
  depth: number;

  constructor(
    kind: LexicalEntryKind,
    next: LexicalEntry | undefined,
    classInfo: ClassInfo | undefined,
    savedPendingExpressions: Node[] | undefined,
  ) {
    this.kind = kind;
    this.next = next;
    this.classInfo = classInfo;
    this.savedPendingExpressions = savedPendingExpressions;
    this.classThis = undefined;
    this.classSuper = undefined;
    this.depth = 0;
  }
}

/** The helper variables of one decorated class element. */
class MemberInfo {
  readonly decoratorsName: Identifier;
  initializersName: Identifier | undefined;
  extraInitializersName: Identifier | undefined;
  descriptorName: Identifier | undefined;

  constructor(decoratorsName: Identifier) {
    this.decoratorsName = decoratorsName;
    this.initializersName = undefined;
    this.extraInitializersName = undefined;
    this.descriptorName = undefined;
  }
}

/** What transforming one decorated class collects. */
class ClassInfo {
  readonly metadataReference: Identifier;
  classDecoratorsName: Identifier | undefined;
  classDescriptorName: Identifier | undefined;
  classExtraInitializersName: Identifier | undefined;
  classThis: Identifier | undefined;
  classSuper: Identifier | undefined;
  /** Decorated members, in order, and their helper variables. */
  readonly decoratedMembers: Node[];
  readonly memberInfos: MemberInfo[];
  instanceMethodExtraInitializersName: Identifier | undefined;
  staticMethodExtraInitializersName: Identifier | undefined;
  readonly staticNonFieldDecorationStatements: Node[];
  readonly nonStaticNonFieldDecorationStatements: Node[];
  readonly staticFieldDecorationStatements: Node[];
  readonly nonStaticFieldDecorationStatements: Node[];
  hasStaticInitializers: boolean;
  hasNonAmbientInstanceFields: boolean;
  hasStaticPrivateClassElements: boolean;
  pendingStaticInitializers: Node[];
  pendingInstanceInitializers: Node[];

  constructor(metadataReference: Identifier) {
    this.metadataReference = metadataReference;
    this.classDecoratorsName = undefined;
    this.classDescriptorName = undefined;
    this.classExtraInitializersName = undefined;
    this.classThis = undefined;
    this.classSuper = undefined;
    this.decoratedMembers = [];
    this.memberInfos = [];
    this.instanceMethodExtraInitializersName = undefined;
    this.staticMethodExtraInitializersName = undefined;
    this.staticNonFieldDecorationStatements = [];
    this.nonStaticNonFieldDecorationStatements = [];
    this.staticFieldDecorationStatements = [];
    this.nonStaticFieldDecorationStatements = [];
    this.hasStaticInitializers = false;
    this.hasNonAmbientInstanceFields = false;
    this.hasStaticPrivateClassElements = false;
    this.pendingStaticInitializers = [];
    this.pendingInstanceInitializers = [];
  }

  setMemberInfo(member: Node, info: MemberInfo): boolean {
    const index = this.decoratedMembers.indexOf(member);
    if (index >= 0) this.memberInfos[index] = info;
    else {
      this.decoratedMembers.push(member);
      this.memberInfos.push(info);
    }
    return true;
  }
}

/** The result of the shared part of transforming a class element. */
class PartialResult {
  modifiers: ModifierList | undefined;
  referencedName: Node | undefined;
  name: Node | undefined;
  initializersName: Identifier | undefined;
  extraInitializersName: Identifier | undefined;
  descriptorName: Identifier | undefined;
  thisArg: Identifier | undefined;

  constructor(modifiers: ModifierList | undefined) {
    this.modifiers = modifiers;
    this.referencedName = undefined;
    this.name = undefined;
    this.initializersName = undefined;
    this.extraInitializersName = undefined;
    this.descriptorName = undefined;
    this.thisArg = undefined;
  }
}

/** Which pseudo-descriptor a private decorated element's body moves into. */
const enum DescriptorKind {
  None,
  Method,
  GetAccessor,
  SetAccessor,
  AccessorProperty,
}

/** Which modifiers a modifier filter keeps. */
const enum ModifierFilter {
  /** All but decorators. */
  NoDecorators,
  /** All but decorators and `export`. */
  NoExport,
  StaticOnly,
  AsyncOnly,
  /** All but `accessor`. */
  NoAccessor,
}

/** Which visitor a list of nodes is visited with. */
const enum ListVisit {
  ClassElements,
  NonConstructorClassElements,
  ConstructorClassElements,
  ArrayAssignmentElements,
  ObjectAssignmentElements,
}

/** Anonymous decorated class expressions, which need an assigned name. */
class AnonymousDecoratedClassFilter extends AnonymousFunctionFilter {
  accepts(node: Node): boolean {
    return node instanceof ClassExpression && node.name === undefined && isDecoratedClassLike(node);
  }
}

const anonymousDecoratedClass = new AnonymousDecoratedClassFilter();

function isDecoratedClassLike(node: Node): boolean {
  return classOrConstructorParameterIsDecorated(false, node) || childIsDecorated(false, node, undefined);
}

/**
 * The IIFE for `(@dec class {})` assigns `var class_1 = class {}`, so an empty assigned name
 * matters; the one for `(class { @dec x; })` returns the class directly, so it can be ignored.
 */
function canIgnoreEmptyStringLiteralInAssignedName(node: Node | undefined): boolean {
  if (node === undefined) return false;
  const inner = skipOuterExpressions(node, OuterExpressionKinds.All);
  return (
    inner instanceof ClassExpression &&
    inner.name === undefined &&
    !classOrConstructorParameterIsDecorated(false, inner)
  );
}

/** Replaces lexical `this` with `_outerThis`, for expressions moved into a class `static {}` block. */
class OuterThisVisitor extends VisitorBase {
  private readonly owner: ESDecorators;

  constructor(owner: ESDecorators) {
    super(owner.context);
    this.owner = owner;
  }

  visit(node: Node): Node | undefined {
    return this.owner.visitOuterThis(node, this);
  }
}

/** Whether ES decorators need lowering for these options. */
export function shouldTransformESDecorators(options: CompilerOptions): boolean {
  if (options.experimentalDecorators === true) return false;
  return getEmitScriptTarget(options) < ScriptTarget.ESNext || !getUseDefineForClassFields(options);
}

export class ESDecorators extends Transformer {
  private readonly facts: SyntaxFacts;
  private readonly outerThisVisitor: OuterThisVisitor;
  private top: LexicalEntry | undefined;
  private classInfo: ClassInfo | undefined;
  private classThis: Identifier | undefined;
  private classSuper: Identifier | undefined;
  private pendingExpressions: Node[];
  private outerThis: Identifier | undefined;
  private shouldTransformPrivateStaticElementsInFile: boolean;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
    this.outerThisVisitor = new OuterThisVisitor(this);
    this.top = undefined;
    this.classInfo = undefined;
    this.classThis = undefined;
    this.classSuper = undefined;
    this.pendingExpressions = [];
    this.outerThis = undefined;
    this.shouldTransformPrivateStaticElementsInFile = false;
  }

  // Lexical state

  private updateState(): boolean {
    this.classInfo = undefined;
    this.classThis = undefined;
    this.classSuper = undefined;
    const top = this.top;
    if (top === undefined) return false;
    switch (top.kind) {
      case LexicalEntryKind.Class:
        this.classInfo = top.classInfo;
        break;
      case LexicalEntryKind.ClassElement:
        this.classInfo = top.next!.classInfo;
        this.classThis = top.classThis;
        this.classSuper = top.classSuper;
        break;
      case LexicalEntryKind.Name: {
        const grandparent = top.next!.next!.next;
        if (grandparent !== undefined && grandparent.kind === LexicalEntryKind.ClassElement) {
          this.classInfo = grandparent.next!.classInfo;
          this.classThis = grandparent.classThis;
          this.classSuper = grandparent.classSuper;
        }
        break;
      }
    }
    return true;
  }

  private enterClass(info: ClassInfo | undefined): boolean {
    this.top = new LexicalEntry(LexicalEntryKind.Class, this.top, info, this.pendingExpressions);
    this.pendingExpressions = [];
    return this.updateState();
  }

  private exitClass(): boolean {
    const top = this.top!;
    this.pendingExpressions = top.savedPendingExpressions!;
    this.top = top.next;
    return this.updateState();
  }

  private enterClassElement(node: Node): boolean {
    const entry = new LexicalEntry(LexicalEntryKind.ClassElement, this.top, undefined, undefined);
    this.top = entry;
    if (
      node.kind === SyntaxKind.ClassStaticBlockDeclaration ||
      (node.kind === SyntaxKind.PropertyDeclaration && hasStaticModifier(node))
    ) {
      const info = entry.next!.classInfo;
      if (info !== undefined) {
        entry.classThis = info.classThis;
        entry.classSuper = info.classSuper;
      }
    }
    return this.updateState();
  }

  private exitClassElement(): boolean {
    this.top = this.top!.next;
    return this.updateState();
  }

  private enterName(): boolean {
    this.top = new LexicalEntry(LexicalEntryKind.Name, this.top, undefined, undefined);
    return this.updateState();
  }

  private exitName(): boolean {
    this.top = this.top!.next;
    return this.updateState();
  }

  private enterOther(): boolean {
    const top = this.top;
    if (top !== undefined && top.kind === LexicalEntryKind.Other) {
      top.depth++;
      return true;
    }
    this.top = new LexicalEntry(LexicalEntryKind.Other, top, undefined, this.pendingExpressions);
    this.pendingExpressions = [];
    return this.updateState();
  }

  private exitOther(): boolean {
    const top = this.top!;
    if (top.depth > 0) {
      top.depth--;
      return true;
    }
    this.pendingExpressions = top.savedPendingExpressions!;
    this.top = top.next;
    return this.updateState();
  }

  // Visitors

  private shouldVisitNode(node: Node): boolean {
    const facts = this.facts.of(node);
    return (
      (facts & SubtreeFacts.ContainsDecorators) !== 0 ||
      (this.classThis !== undefined && (facts & SubtreeFacts.ContainsLexicalThis) !== 0) ||
      (this.classThis !== undefined &&
        this.classSuper !== undefined &&
        (facts & SubtreeFacts.ContainsLexicalSuper) !== 0)
    );
  }

  visit(node: Node): Node | undefined {
    if (node instanceof SourceFile) return this.visitSourceFile(node as SourceFile);
    if (!this.shouldVisitNode(node)) return node;
    switch (node.kind) {
      case SyntaxKind.Decorator:
        return undefined;
      case SyntaxKind.ClassDeclaration:
        if (node instanceof ClassDeclaration) return this.visitClassDeclaration(node);
        break;
      case SyntaxKind.ClassExpression:
        if (node instanceof ClassExpression) return this.visitClassExpression(node);
        break;
      case SyntaxKind.Constructor:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.ClassStaticBlockDeclaration:
        throw new Error('Class elements are visited with visitClassElement');
      case SyntaxKind.Parameter:
        if (node instanceof ParameterDeclaration) return this.visitParameterDeclaration(node);
        break;
      case SyntaxKind.BinaryExpression:
        if (node instanceof BinaryExpression) return this.visitBinaryExpression(node, false);
        break;
      case SyntaxKind.PropertyAssignment:
        if (node instanceof PropertyAssignment) return this.visitNamedEvaluationSite(node, node.initializer);
        break;
      case SyntaxKind.VariableDeclaration:
        if (node instanceof VariableDeclaration) return this.visitNamedEvaluationSite(node, node.initializer);
        break;
      case SyntaxKind.BindingElement:
        if (node instanceof BindingElement) return this.visitNamedEvaluationSite(node, node.initializer);
        break;
      case SyntaxKind.ExportAssignment:
        if (node instanceof ExportAssignment) return this.visitNamedEvaluationSite(node, node.expression);
        break;
      case SyntaxKind.ThisKeyword:
        return this.classThis !== undefined ? this.classThis : node;
      case SyntaxKind.ForStatement:
        if (node instanceof ForStatement) return this.visitForStatement(node);
        break;
      case SyntaxKind.ExpressionStatement:
        if (node instanceof ExpressionStatement)
          return this.factory.updateExpressionStatement(node, this.visitDiscardedNode(node.expression)!);
        break;
      case SyntaxKind.ParenthesizedExpression:
        if (node instanceof ParenthesizedExpression) return this.visitParenthesizedExpression(node, false);
        break;
      case SyntaxKind.PartiallyEmittedExpression:
        if (node instanceof PartiallyEmittedExpression) return this.visitPartiallyEmittedExpression(node, false);
        break;
      case SyntaxKind.CallExpression:
        if (node instanceof CallExpression) return this.visitCallExpression(node);
        break;
      case SyntaxKind.TaggedTemplateExpression:
        if (node instanceof TaggedTemplateExpression) return this.visitTaggedTemplateExpression(node);
        break;
      case SyntaxKind.PrefixUnaryExpression:
      case SyntaxKind.PostfixUnaryExpression:
        return this.visitPreOrPostfixUnaryExpression(node, false);
      case SyntaxKind.PropertyAccessExpression:
        if (node instanceof PropertyAccessExpression) return this.visitPropertyAccessExpression(node);
        break;
      case SyntaxKind.ElementAccessExpression:
        if (node instanceof ElementAccessExpression) return this.visitElementAccessExpression(node);
        break;
      case SyntaxKind.ComputedPropertyName:
        if (node instanceof ComputedPropertyName) return this.visitComputedPropertyName(node);
        break;
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.FunctionDeclaration: {
        this.enterOther();
        const result = this.visitEachChild(node);
        this.exitOther();
        return result;
      }
    }
    return this.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    this.top = undefined;
    this.shouldTransformPrivateStaticElementsInFile = false;
    const visited = this.visitEachChild(node);
    const helpers = this.context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) this.context.addEmitHelper(visited, helpers[i]);
    if (this.shouldTransformPrivateStaticElementsInFile) {
      this.context.addEmitFlags(visited, EmitFlags.TransformPrivateStaticElements);
      this.shouldTransformPrivateStaticElementsInFile = false;
    }
    return visited;
  }

  /** `this` as `_outerThis`, for the outer-this visitor. */
  visitOuterThis(node: Node, visitor: OuterThisVisitor): Node | undefined {
    if (node.kind === SyntaxKind.ThisKeyword) {
      if (this.outerThis === undefined)
        this.outerThis = this.factory.createUniqueName('_outerThis', GeneratedIdentifierFlags.Optimistic);
      return this.outerThis;
    }
    if (!this.facts.has(node, SubtreeFacts.ContainsLexicalThis)) return node;
    return visitor.visitEachChild(node);
  }

  private visitClassElement(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.Constructor:
        if (node instanceof ConstructorDeclaration) return this.visitConstructorDeclaration(node);
        break;
      case SyntaxKind.MethodDeclaration:
        if (node instanceof MethodDeclaration) return this.visitMethodDeclaration(node);
        break;
      case SyntaxKind.GetAccessor:
        if (node instanceof GetAccessorDeclaration) return this.visitGetAccessorDeclaration(node);
        break;
      case SyntaxKind.SetAccessor:
        if (node instanceof SetAccessorDeclaration) return this.visitSetAccessorDeclaration(node);
        break;
      case SyntaxKind.PropertyDeclaration:
        if (node instanceof PropertyDeclaration) return this.visitPropertyDeclaration(node);
        break;
      case SyntaxKind.ClassStaticBlockDeclaration:
        if (node instanceof ClassStaticBlockDeclaration) return this.visitClassStaticBlockDeclaration(node);
        break;
    }
    return this.visit(node);
  }

  /** Visits a node whose value is discarded, such as an expression statement's expression. */
  private visitDiscarded(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.PrefixUnaryExpression:
      case SyntaxKind.PostfixUnaryExpression:
        return this.visitPreOrPostfixUnaryExpression(node, true);
      case SyntaxKind.BinaryExpression:
        if (node instanceof BinaryExpression) return this.visitBinaryExpression(node, true);
        break;
      case SyntaxKind.ParenthesizedExpression:
        if (node instanceof ParenthesizedExpression) return this.visitParenthesizedExpression(node, true);
        break;
      case SyntaxKind.PartiallyEmittedExpression:
        if (node instanceof PartiallyEmittedExpression) return this.visitPartiallyEmittedExpression(node, true);
        break;
    }
    return this.visit(node);
  }

  private visitDiscardedNode(node: Node | undefined): Node | undefined {
    return node === undefined ? undefined : this.visitDiscarded(node);
  }

  private visitListItem(node: Node, mode: ListVisit): Node | undefined {
    switch (mode) {
      case ListVisit.ClassElements:
        return this.visitClassElement(node);
      case ListVisit.NonConstructorClassElements:
        return node.kind === SyntaxKind.Constructor ? node : this.visitClassElement(node);
      case ListVisit.ConstructorClassElements:
        return node.kind === SyntaxKind.Constructor ? this.visitClassElement(node) : node;
      case ListVisit.ArrayAssignmentElements:
        return this.visitArrayAssignmentElement(node);
      case ListVisit.ObjectAssignmentElements:
        return this.visitObjectAssignmentElement(node);
    }
    return node;
  }

  /** Visits each node of a list with the visitor `mode` names; the list itself if nothing changed. */
  private visitList(list: NodeList, mode: ListVisit): NodeList {
    const nodes = list.nodes;
    let updated: Node[] | undefined = undefined;
    for (let i = 0; i < nodes.length; i++) {
      const visited = this.visitListItem(nodes[i], mode);
      if (updated === undefined) {
        if (visited === nodes[i]) continue;
        updated = nodes.slice(0, i);
      }
      if (visited instanceof SyntaxList)
        for (let j = 0; j < visited.children.length; j++) updated.push(visited.children[j]);
      else if (visited !== undefined) updated.push(visited);
    }
    return updated === undefined ? list : new NodeList(list.pos, list.end, updated);
  }

  private filterModifiers(list: ModifierList | undefined, filter: ModifierFilter): ModifierList | undefined {
    if (list === undefined) return undefined;
    const nodes = list.nodes;
    let kept: Node[] | undefined = undefined;
    for (let i = 0; i < nodes.length; i++) {
      const keep = keepsModifier(filter, nodes[i].kind);
      if (keep && kept !== undefined) kept.push(nodes[i]);
      else if (!keep && kept === undefined) kept = nodes.slice(0, i);
    }
    if (kept === undefined) return list;
    const updated = this.factory.createModifierList(kept);
    updated.pos = list.pos;
    updated.end = list.end;
    return updated;
  }

  // Classes

  private createHelperVariable(node: Node, suffix: string): Identifier {
    return this.factory.createUniqueName(
      getHelperVariableName(this.context, node) + '_' + suffix,
      GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.ReservedInNestedScopes,
    );
  }

  private createFileLevelName(text: string): Identifier {
    return this.factory.createUniqueName(
      text,
      GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.FileLevel,
    );
  }

  private createLet(name: Identifier, initializer: Node | undefined): VariableStatement {
    const factory = this.factory;
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([factory.createVariableDeclaration(name, undefined, undefined, initializer)]),
        NodeFlags.Let,
      ),
    );
  }

  private createEmptyArray(): ArrayLiteralExpression {
    return this.factory.created(new ArrayLiteralExpression(this.factory.createNodeList([]), false));
  }

  private setRangePastDecoratorsOrName(initializer: Node, node: Node): boolean {
    const name = getClassName(node);
    if (name !== undefined) this.context.setSourceMapRange(initializer, name.pos, name.end);
    else this.context.setSourceMapRange(initializer, moveRangePastDecorators(node).pos, node.end);
    return true;
  }

  private createClassInfo(node: Node): ClassInfo {
    const factory = this.factory;
    const info = new ClassInfo(this.createFileLevelName('_metadata'));
    const members = getClassMembers(node).nodes;
    if (nodeIsDecorated(false, node, undefined, undefined)) {
      let needsUniqueClassThis = false;
      for (let i = 0; i < members.length; i++)
        if (isStaticPrivateOrAutoAccessor(members[i])) {
          needsUniqueClassThis = true;
          break;
        }
      // `_classThis` isn't file level when class private fields may need an outer class's.
      info.classThis = factory.createUniqueName(
        '_classThis',
        needsUniqueClassThis
          ? GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.ReservedInNestedScopes
          : GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.FileLevel,
      );
    }
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      if (isMethodOrAccessor(member) && nodeOrChildIsDecorated(false, member, node, undefined)) {
        if (hasStaticModifier(member)) {
          if (info.staticMethodExtraInitializersName === undefined) {
            info.staticMethodExtraInitializersName = this.createFileLevelName('_staticExtraInitializers');
            const initializer = createRunInitializersHelper(
              factory,
              info.classThis !== undefined ? info.classThis : factory.createKeywordExpression(SyntaxKind.ThisKeyword),
              info.staticMethodExtraInitializersName,
              undefined,
            );
            this.setRangePastDecoratorsOrName(initializer, node);
            info.pendingStaticInitializers.push(initializer);
          }
        } else if (info.instanceMethodExtraInitializersName === undefined) {
          info.instanceMethodExtraInitializersName = this.createFileLevelName('_instanceExtraInitializers');
          const initializer = createRunInitializersHelper(
            factory,
            factory.createKeywordExpression(SyntaxKind.ThisKeyword),
            info.instanceMethodExtraInitializersName,
            undefined,
          );
          this.setRangePastDecoratorsOrName(initializer, node);
          info.pendingInstanceInitializers.push(initializer);
        }
      }
      if (member instanceof ClassStaticBlockDeclaration) {
        if (!isClassNamedEvaluationHelperBlock(this.context, member)) info.hasStaticInitializers = true;
      } else if (member instanceof PropertyDeclaration) {
        if (hasStaticModifier(member))
          info.hasStaticInitializers =
            info.hasStaticInitializers || member.initializer !== undefined || hasDecorators(member);
        else
          info.hasNonAmbientInstanceFields =
            info.hasNonAmbientInstanceFields || !hasSyntacticModifier(member, ModifierFlags.Ambient);
      }
      if (isStaticPrivateOrAutoAccessor(member)) info.hasStaticPrivateClassElements = true;
      if (
        info.staticMethodExtraInitializersName !== undefined &&
        info.instanceMethodExtraInitializersName !== undefined &&
        info.hasStaticInitializers &&
        info.hasNonAmbientInstanceFields &&
        info.hasStaticPrivateClassElements
      )
        break;
    }
    return info;
  }

  private transformClassLike(original: Node): Node {
    const factory = this.factory;
    const context = this.context;
    context.startVariableEnvironment();
    let node: Node = original;
    // A class that gets class decorators is moved into a statement that would give it an
    // assigned name; without one, it gets the assigned name `""`.
    if (!classHasDeclaredOrExplicitlyAssignedName(context, node) && classOrConstructorParameterIsDecorated(false, node))
      node = injectClassNamedEvaluationHelperBlockIfMissing(
        context,
        node,
        factory.createStringLiteral('', TokenFlags.None),
        undefined,
      );
    const cls = node;
    const classMembers = getClassMembers(cls);
    const classReference = factory.getLocalName(cls, NameOptions.None);
    const info = this.createClassInfo(cls);
    const classDefinitionStatements: Node[] = [];
    let leadingBlockStatements: Node[] = [];
    let trailingBlockStatements: Node[] = [];
    let syntheticConstructor: Node | undefined = undefined;
    let heritageClauses: NodeList | undefined = undefined;
    let shouldTransformPrivateStaticElementsInClass = false;

    // 1. Class decorators are evaluated outside the private name scope of the class.
    const classDecorators = this.transformAllDecoratorsOfDeclaration(getDecorators(cls));
    if (classDecorators.length > 0) {
      info.classDecoratorsName = this.createFileLevelName('_classDecorators');
      info.classDescriptorName = this.createFileLevelName('_classDescriptor');
      info.classExtraInitializersName = this.createFileLevelName('_classExtraInitializers');
      classDefinitionStatements.push(
        this.createLet(
          info.classDecoratorsName,
          factory.created(new ArrayLiteralExpression(factory.createNodeList(classDecorators), false)),
        ),
        this.createLet(info.classDescriptorName, undefined),
        this.createLet(info.classExtraInitializersName, this.createEmptyArray()),
        this.createLet(info.classThis!, undefined),
      );
      if (info.hasStaticPrivateClassElements) {
        shouldTransformPrivateStaticElementsInClass = true;
        this.shouldTransformPrivateStaticElementsInFile = true;
      }
    }

    // 2. The heritage clause is evaluated outside the private name scope of the class.
    const extendsClause = getHeritageClause(getClassHeritageClauses(cls), SyntaxKind.ExtendsKeyword);
    let extendsElement: ExpressionWithTypeArguments | undefined = undefined;
    if (extendsClause !== undefined && extendsClause.types.nodes.length > 0) {
      const first = extendsClause.types.nodes[0];
      if (first instanceof ExpressionWithTypeArguments) extendsElement = first as ExpressionWithTypeArguments;
    }
    const extendsExpression = extendsElement !== undefined ? this.visitNode(extendsElement.expression) : undefined;
    const heritageElement = extendsElement;
    if (extendsClause !== undefined && heritageElement !== undefined && extendsExpression !== undefined) {
      // `super` in static initializers is rewritten to use `_classSuper` with the right `this`.
      info.classSuper = this.createFileLevelName('_classSuper');
      // `0, ` keeps the variable from assigning a name to an anonymous class or function.
      const unwrapped = skipOuterExpressions(extendsExpression, OuterExpressionKinds.All);
      const anonymous =
        (unwrapped instanceof ClassExpression && unwrapped.name === undefined) ||
        (unwrapped instanceof FunctionExpression && unwrapped.name === undefined) ||
        unwrapped.kind === SyntaxKind.ArrowFunction;
      const safeExtendsExpression = anonymous
        ? factory.createCommaExpression(factory.createNumericLiteral('0'), extendsExpression)
        : extendsExpression;
      classDefinitionStatements.push(this.createLet(info.classSuper, safeExtendsExpression));
      const updatedElement: Node = factory.updateExpressionWithTypeArguments(
        heritageElement,
        info.classSuper,
        undefined,
      );
      const updatedClause: Node = factory.updateHeritageClause(
        extendsClause,
        extendsClause.token,
        factory.createNodeList([updatedElement]),
      );
      heritageClauses = factory.createNodeList([updatedClause]);
    }

    const renamedClassThis: Node =
      info.classThis !== undefined ? info.classThis : factory.createKeywordExpression(SyntaxKind.ThisKeyword);

    // 3. The name of the class is assigned (by the named evaluation block, if needed).
    // 4. For each member, its decorators and then its computed name are evaluated. Members
    //    other than the constructor are visited first, since its transform depends on them.
    this.enterClass(info);
    leadingBlockStatements.push(this.createMetadata(info.metadataReference, info.classSuper));
    let members = this.visitList(classMembers, ListVisit.NonConstructorClassElements);
    members = this.visitList(members, ListVisit.ConstructorClassElements);
    if (this.pendingExpressions.length > 0) {
      // Lexical `this` in a pending expression is the container's, captured in `_outerThis`.
      this.outerThis = undefined;
      for (let i = 0; i < this.pendingExpressions.length; i++) {
        let expression = this.pendingExpressions[i];
        if (this.facts.has(expression, SubtreeFacts.ContainsLexicalThis))
          expression = this.outerThisVisitor.visitNode(expression)!;
        leadingBlockStatements.push(factory.createExpressionStatement(expression));
      }
      if (this.outerThis !== undefined)
        classDefinitionStatements.unshift(
          this.createLet(this.outerThis, factory.createKeywordExpression(SyntaxKind.ThisKeyword)),
        );
      this.pendingExpressions = [];
    }
    this.exitClass();

    if (info.pendingInstanceInitializers.length > 0 && getFirstConstructorWithBody(cls) === undefined) {
      const initializerStatements = this.prepareConstructor(info);
      if (initializerStatements.length > 0) {
        const heritage = extendsElement;
        const isDerivedClass =
          heritage !== undefined &&
          skipOuterExpressions(heritage.expression, OuterExpressionKinds.All).kind !== SyntaxKind.NullKeyword;
        const constructorStatements: Node[] = [];
        if (isDerivedClass)
          constructorStatements.push(
            factory.createExpressionStatement(
              factory.createCallExpression(factory.createKeywordExpression(SyntaxKind.SuperKeyword), [
                factory.created(new SpreadElement(factory.createIdentifier('arguments'))),
              ]),
            ),
          );
        for (let i = 0; i < initializerStatements.length; i++) constructorStatements.push(initializerStatements[i]);
        syntheticConstructor = factory.created(
          new ConstructorDeclaration(
            undefined,
            undefined,
            factory.createNodeList([]),
            undefined,
            undefined,
            factory.createBlock(constructorStatements, true),
          ),
        );
      }
    }

    if (info.staticMethodExtraInitializersName !== undefined)
      classDefinitionStatements.push(this.createLet(info.staticMethodExtraInitializersName, this.createEmptyArray()));
    if (info.instanceMethodExtraInitializersName !== undefined)
      classDefinitionStatements.push(this.createLet(info.instanceMethodExtraInitializersName, this.createEmptyArray()));
    if (info.memberInfos.length > 0) {
      // Static members' variables come first.
      this.addMemberInfoDeclarations(classDefinitionStatements, info, true);
      this.addMemberInfoDeclarations(classDefinitionStatements, info, false);
    }

    // 5-8. Member decorators are applied.
    appendAll(leadingBlockStatements, info.staticNonFieldDecorationStatements);
    appendAll(leadingBlockStatements, info.nonStaticNonFieldDecorationStatements);
    appendAll(leadingBlockStatements, info.staticFieldDecorationStatements);
    appendAll(leadingBlockStatements, info.nonStaticFieldDecorationStatements);

    // 9. Class decorators are applied, and 10. the class binding is initialized:
    //   __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata }, null, _classExtraInitializers);
    //   C = _classThis = _classDescriptor.value;
    if (
      info.classDescriptorName !== undefined &&
      info.classDecoratorsName !== undefined &&
      info.classExtraInitializersName !== undefined &&
      info.classThis !== undefined
    ) {
      const classDescriptor = factory.createObjectLiteral(
        [factory.createPropertyAssignment(factory.createIdentifier('value'), renamedClassThis)],
        false,
      );
      const contextObject = factory.createObjectLiteral(
        [
          factory.createPropertyAssignment(
            factory.createIdentifier('kind'),
            factory.createStringLiteral('class', TokenFlags.None),
          ),
          factory.createPropertyAssignment(
            factory.createIdentifier('name'),
            factory.createPropertyAccessExpression(renamedClassThis, factory.createIdentifier('name')),
          ),
          factory.createPropertyAssignment(factory.createIdentifier('metadata'), info.metadataReference),
        ],
        false,
      );
      const decorate = factory.createExpressionStatement(
        createESDecorateHelper(
          factory,
          factory.createToken(SyntaxKind.NullKeyword),
          factory.createAssignment(info.classDescriptorName, classDescriptor),
          info.classDecoratorsName,
          contextObject,
          factory.createToken(SyntaxKind.NullKeyword),
          info.classExtraInitializersName,
        ),
      );
      context.setSourceMapRange(decorate, moveRangePastDecorators(cls).pos, cls.end);
      leadingBlockStatements.push(decorate);
      leadingBlockStatements.push(
        factory.createExpressionStatement(
          factory.createAssignment(
            classReference,
            factory.createAssignment(
              info.classThis,
              factory.createPropertyAccessExpression(info.classDescriptorName, factory.createIdentifier('value')),
            ),
          ),
        ),
      );
    }

    //   if (_metadata) Object.defineProperty(C, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
    leadingBlockStatements.push(this.createSymbolMetadata(renamedClassThis, info.metadataReference));

    // 11. Static extra initializers and 12. static fields are run.
    for (let i = 0; i < info.pendingStaticInitializers.length; i++) {
      const initializer = info.pendingStaticInitializers[i];
      const statement = factory.createExpressionStatement(initializer);
      context.setSourceMapRange(statement, context.sourceMapPos(initializer), context.sourceMapEnd(initializer));
      trailingBlockStatements.push(statement);
    }
    info.pendingStaticInitializers = [];

    // 13. Class extra initializers are run.
    if (info.classExtraInitializersName !== undefined) {
      const statement = factory.createExpressionStatement(
        createRunInitializersHelper(factory, renamedClassThis, info.classExtraInitializersName, undefined),
      );
      this.setRangePastDecoratorsOrName(statement, cls);
      trailingBlockStatements.push(statement);
    }

    // Without other static initializers, the leading and trailing blocks are one.
    if (leadingBlockStatements.length > 0 && trailingBlockStatements.length > 0 && !info.hasStaticInitializers) {
      appendAll(leadingBlockStatements, trailingBlockStatements);
      trailingBlockStatements = [];
    }

    let leadingStaticBlock: Node | undefined = undefined;
    if (leadingBlockStatements.length > 0)
      leadingStaticBlock = factory.created(
        new ClassStaticBlockDeclaration(undefined, factory.createBlock(leadingBlockStatements, true)),
      );
    // Tells the class fields transform not to rename `this` to `_classThis` in this block.
    if (leadingStaticBlock !== undefined && shouldTransformPrivateStaticElementsInClass)
      context.setEmitFlags(leadingStaticBlock, EmitFlags.TransformPrivateStaticElements);
    let trailingStaticBlock: Node | undefined = undefined;
    if (trailingBlockStatements.length > 0)
      trailingStaticBlock = factory.created(
        new ClassStaticBlockDeclaration(undefined, factory.createBlock(trailingBlockStatements, true)),
      );
    leadingBlockStatements = [];

    if (leadingStaticBlock !== undefined || syntheticConstructor !== undefined || trailingStaticBlock !== undefined) {
      const existing = members.nodes;
      let helperBlockIndex = -1;
      for (let i = 0; i < existing.length; i++)
        if (isClassNamedEvaluationHelperBlock(context, existing[i])) {
          helperBlockIndex = i;
          break;
        }
      const updated: Node[] = [];
      if (leadingStaticBlock !== undefined) {
        // After the named evaluation block, if there is one.
        for (let i = 0; i <= helperBlockIndex; i++) updated.push(existing[i]);
        updated.push(leadingStaticBlock);
        for (let i = helperBlockIndex + 1; i < existing.length; i++) updated.push(existing[i]);
      } else appendAll(updated, existing);
      if (syntheticConstructor !== undefined) updated.push(syntheticConstructor);
      if (trailingStaticBlock !== undefined) updated.push(trailingStaticBlock);
      members = new NodeList(members.pos, members.end, updated);
    }

    const lexicalEnvironment = context.endVariableEnvironment();
    let classExpression: Node;
    if (classDecorators.length > 0) {
      // `var` uses NamedEvaluation to name the class and is initialized before any `static {}` use:
      //   (() => { let _classDecorators = [...]; ...; var C = class { static { ... } }; return C = _classThis; })();
      classExpression = factory.created(new ClassExpression(undefined, undefined, undefined, heritageClauses, members));
      context.setOriginal(classExpression, cls);
      if (info.classThis !== undefined)
        classExpression = injectClassThisAssignmentIfMissing(context, classExpression, info.classThis);
      classDefinitionStatements.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            factory.createNodeList([
              factory.createVariableDeclaration(classReference, undefined, undefined, classExpression),
            ]),
            NodeFlags.None,
          ),
        ),
        factory.createReturnStatement(
          info.classThis !== undefined ? factory.createAssignment(classReference, info.classThis) : classReference,
        ),
      );
    } else {
      //   return <classExpression>;
      classExpression = factory.created(
        new ClassExpression(undefined, getClassName(cls), undefined, heritageClauses, members),
      );
      context.setOriginal(classExpression, cls);
      classDefinitionStatements.push(factory.createReturnStatement(classExpression));
    }

    if (shouldTransformPrivateStaticElementsInClass && classExpression instanceof ClassExpression) {
      context.addEmitFlags(classExpression, EmitFlags.TransformPrivateStaticElements);
      const classMembers = classExpression.members.nodes;
      for (let i = 0; i < classMembers.length; i++)
        if (isStaticPrivateOrAutoAccessor(classMembers[i]))
          context.addEmitFlags(classMembers[i], EmitFlags.TransformPrivateStaticElements);
    }
    return factory.createImmediatelyInvokedArrowFunction(
      context.mergeEnvironment(classDefinitionStatements, lexicalEnvironment),
    );
  }

  private addMemberInfoDeclarations(statements: Node[], info: ClassInfo, isStaticMember: boolean): boolean {
    for (let i = 0; i < info.memberInfos.length; i++) {
      if (isStatic(info.decoratedMembers[i]) !== isStaticMember) continue;
      const memberInfo = info.memberInfos[i];
      statements.push(this.createLet(memberInfo.decoratorsName, undefined));
      if (memberInfo.initializersName !== undefined)
        statements.push(this.createLet(memberInfo.initializersName, this.createEmptyArray()));
      if (memberInfo.extraInitializersName !== undefined)
        statements.push(this.createLet(memberInfo.extraInitializersName, this.createEmptyArray()));
      if (memberInfo.descriptorName !== undefined)
        statements.push(this.createLet(memberInfo.descriptorName, undefined));
    }
    return true;
  }

  private visitClassDeclaration(node: ClassDeclaration): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    if (!isDecoratedClassLike(node)) {
      const modifiers = this.filterModifiers(node.modifiers, ModifierFilter.NoDecorators);
      const heritageClauses = this.visitNodes(node.heritageClauses);
      this.enterClass(undefined);
      const members = this.visitList(node.members, ListVisit.ClassElements);
      this.exitClass();
      return factory.updateClassDeclaration(node, modifiers, node.name, undefined, heritageClauses, members);
    }
    const statements: Node[] = [];
    let originalClass = context.mostOriginal(node);
    if (!isClassLike(originalClass)) originalClass = node;
    const originalName = getName(originalClass);
    const className =
      originalName !== undefined
        ? factory.createStringLiteralFromNode(originalName)
        : factory.createStringLiteral('default', TokenFlags.None);
    const isExport = hasSyntacticModifier(node, ModifierFlags.Export);
    const isDefault = hasSyntacticModifier(node, ModifierFlags.Default);
    let classNode: ClassDeclaration = node;
    if (node.name === undefined)
      classNode = injectClassNamedEvaluationHelperBlockIfMissing(
        context,
        node,
        className,
        undefined,
      ) as ClassDeclaration;
    if (isExport && isDefault) {
      const iife = this.transformClassLike(classNode);
      if (classNode.name !== undefined) {
        //   let C = (() => { ... })();
        //   export default C;
        const declaration = factory.createVariableDeclaration(
          factory.getLocalName(classNode, NameOptions.None),
          undefined,
          undefined,
          iife,
        );
        context.setOriginal(declaration, classNode);
        statements.push(
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(factory.createNodeList([declaration]), NodeFlags.Let),
          ),
        );
        const exportStatement = createExportDefault(factory, factory.getDeclarationName(classNode, NameOptions.None));
        context.setOriginal(exportStatement, classNode);
        context.assignCommentRange(exportStatement, classNode);
        context.setSourceMapRange(exportStatement, moveRangePastDecorators(classNode).pos, classNode.end);
        statements.push(exportStatement);
      } else {
        //   export default (() => { ... })();
        const exportStatement = createExportDefault(factory, iife);
        context.setOriginal(exportStatement, classNode);
        context.assignCommentRange(exportStatement, classNode);
        context.setSourceMapRange(exportStatement, moveRangePastDecorators(classNode).pos, classNode.end);
        statements.push(exportStatement);
      }
    } else {
      //   let C = (() => { ... })();
      const iife = this.transformClassLike(classNode);
      const modifiers = this.filterModifiers(classNode.modifiers, ModifierFilter.NoExport);
      const declarationName = factory.getLocalName(classNode, NameOptions.AllowSourceMaps);
      const declaration = factory.createVariableDeclaration(declarationName, undefined, undefined, iife);
      context.setOriginal(declaration, classNode);
      const statement = factory.createVariableStatement(
        modifiers,
        factory.createVariableDeclarationList(factory.createNodeList([declaration]), NodeFlags.Let),
      );
      context.setOriginal(statement, classNode);
      context.assignCommentRange(statement, classNode);
      statements.push(statement);
      if (isExport) {
        //   export { C };
        const exportStatement = createExternalModuleExport(factory, declarationName);
        context.setOriginal(exportStatement, classNode);
        statements.push(exportStatement);
      }
    }
    return singleOrMany(statements, factory);
  }

  private visitClassExpression(node: ClassExpression): Node {
    if (isDecoratedClassLike(node)) {
      const iife = this.transformClassLike(node);
      this.context.setOriginal(iife, node);
      return iife;
    }
    const modifiers = this.filterModifiers(node.modifiers, ModifierFilter.NoDecorators);
    const heritageClauses = this.visitNodes(node.heritageClauses);
    this.enterClass(undefined);
    const members = this.visitList(node.members, ListVisit.ClassElements);
    this.exitClass();
    return this.factory.updateClassExpression(node, modifiers, node.name, undefined, heritageClauses, members);
  }

  /**
   * The `__runInitializers()` call for instance extra initializers, when no instance field
   * initializer carries it.
   */
  private prepareConstructor(info: ClassInfo): Node[] {
    if (info.pendingInstanceInitializers.length === 0) return [];
    const statements = [
      this.factory.createExpressionStatement(this.factory.inlineExpressions(info.pendingInstanceInitializers)!),
    ];
    info.pendingInstanceInitializers = [];
    return statements;
  }

  /** Visits constructor statements, adding the initializers after the `super()` call `superPath` leads to. */
  private transformConstructorBody(
    statementsOut: Node[],
    statementsIn: readonly Node[],
    statementOffset: number,
    superPath: number[],
    superPathDepth: number,
    initializerStatements: Node[],
  ): Node[] {
    const superStatementIndex = superPath[superPathDepth];
    for (let i = statementOffset; i < superStatementIndex; i++)
      pushVisited(statementsOut, this.visitNode(statementsIn[i]));
    const superStatement = statementsIn[superStatementIndex];
    if (superStatement instanceof TryStatement) {
      const tryStatement = superStatement as TryStatement;
      const tryBlock = tryStatement.tryBlock;
      const tryStatements = this.transformConstructorBody(
        [],
        tryBlock.statements.nodes,
        0,
        superPath,
        superPathDepth + 1,
        initializerStatements,
      );
      // Keeps the original try block's range for source maps.
      const newTryBlock = this.factory.createBlock(tryStatements, true);
      newTryBlock.pos = tryBlock.pos;
      newTryBlock.end = tryBlock.end;
      let catchClause: CatchClause | undefined = undefined;
      if (tryStatement.catchClause !== undefined) catchClause = this.visitNode(tryStatement.catchClause) as CatchClause;
      let finallyBlock: Block | undefined = undefined;
      if (tryStatement.finallyBlock !== undefined) finallyBlock = this.visitNode(tryStatement.finallyBlock) as Block;
      const updated: Node = this.factory.updateTryStatement(tryStatement, newTryBlock, catchClause, finallyBlock);
      statementsOut.push(updated);
    } else {
      pushVisited(statementsOut, this.visitNode(superStatement));
      appendAll(statementsOut, initializerStatements);
    }
    for (let i = superStatementIndex + 1; i < statementsIn.length; i++)
      pushVisited(statementsOut, this.visitNode(statementsIn[i]));
    return statementsOut;
  }

  private visitConstructorDeclaration(node: ConstructorDeclaration): Node {
    this.enterClassElement(node);
    const modifiers = this.filterModifiers(node.modifiers, ModifierFilter.NoDecorators);
    const parameters = this.visitNodes(node.parameters)!;
    let body: Node | undefined = undefined;
    const originalBody = node.body;
    if (originalBody instanceof Block && this.classInfo !== undefined) {
      // Instance extra initializers go into the body.
      const initializerStatements = this.prepareConstructor(this.classInfo);
      if (initializerStatements.length > 0) {
        const statements: Node[] = [];
        const all = originalBody.statements.nodes;
        const prologueCount = countPrologueDirectives(all);
        for (let i = 0; i < prologueCount; i++) statements.push(all[i]);
        const rest = all.slice(prologueCount);
        const superPath = findSuperStatementIndexPath(rest, 0);
        if (superPath.length > 0)
          this.transformConstructorBody(statements, rest, 0, superPath, 0, initializerStatements);
        else {
          appendAll(statements, initializerStatements);
          appendAll(statements, this.visitArray(rest));
        }
        body = this.factory.createBlock(statements.slice(), true);
        this.context.setOriginal(body, originalBody);
        body.pos = originalBody.pos;
        body.end = originalBody.end;
      }
    }
    if (body === undefined) body = this.visitNode(originalBody);
    this.exitClassElement();
    return this.factory.updateConstructorDeclaration(
      node,
      modifiers,
      undefined,
      parameters,
      undefined,
      undefined,
      body,
    );
  }

  private finishClassElement(updated: Node, original: Node): Node {
    if (updated !== original) {
      // Source maps start past decorators and modifiers, but comments cover the original range.
      this.context.assignCommentRange(updated, original);
      this.context.setSourceMapRange(updated, moveRangePastDecorators(original).pos, original.end);
    }
    return updated;
  }

  private partialTransformClassElement(
    member: Node,
    info: ClassInfo | undefined,
    descriptorKind: DescriptorKind,
  ): PartialResult {
    const factory = this.factory;
    const context = this.context;
    const memberName = getName(member);
    if (info === undefined) {
      const result = new PartialResult(this.filterModifiers(getModifiers(member), ModifierFilter.NoDecorators));
      this.enterName();
      result.name = this.visitPropertyName(memberName);
      this.exitName();
      return result;
    }
    // Member decorators have privileged access to private names, but computed names are
    // evaluated interspersed with them, so decorator evaluation is inlined into the names.
    // Decorators are evaluated outside the class body, so `this` isn't `_classThis` there.
    const savedClassThis = this.classThis;
    this.classThis = undefined;
    const memberDecorators = this.transformAllDecoratorsOfDeclaration(getDecorators(member));
    this.classThis = savedClassThis;
    const modifiers = this.filterModifiers(getModifiers(member), ModifierFilter.NoDecorators);
    const result = new PartialResult(modifiers);
    if (memberDecorators.length > 0) {
      const memberDecoratorsName = this.createHelperVariable(member, 'decorators');
      const memberInfo = new MemberInfo(memberDecoratorsName);
      info.setMemberInfo(member, memberInfo);
      this.pendingExpressions.push(
        factory.createAssignment(
          memberDecoratorsName,
          factory.created(new ArrayLiteralExpression(factory.createNodeList(memberDecorators), false)),
        ),
      );
      const kind =
        member.kind === SyntaxKind.GetAccessor
          ? 'getter'
          : member.kind === SyntaxKind.SetAccessor
            ? 'setter'
            : member.kind === SyntaxKind.MethodDeclaration
              ? 'method'
              : isAutoAccessorPropertyDeclaration(member)
                ? 'accessor'
                : 'field';
      let nameComputed = false;
      let nameExpression: Node | undefined = undefined;
      if (memberName instanceof Identifier || memberName instanceof PrivateIdentifier) nameExpression = memberName;
      else if (memberName !== undefined && isPropertyNameLiteral(memberName)) {
        nameComputed = true;
        nameExpression = factory.createStringLiteralFromNode(memberName);
      } else if (memberName instanceof ComputedPropertyName) {
        const expression = memberName.expression;
        nameComputed = true;
        if (isPropertyNameLiteral(expression) && !(expression instanceof Identifier))
          nameExpression = factory.createStringLiteralFromNode(expression);
        else {
          this.enterName();
          this.visitReferencedPropertyName(memberName, result);
          this.exitName();
          nameExpression = result.referencedName;
        }
      }
      const isField = member.kind === SyntaxKind.PropertyDeclaration;
      const contextObject = this.createClassElementContextObject(
        kind,
        nameComputed,
        nameExpression!,
        isStatic(member),
        memberName instanceof PrivateIdentifier,
        isField || member.kind === SyntaxKind.GetAccessor || member.kind === SyntaxKind.MethodDeclaration,
        isField || member.kind === SyntaxKind.SetAccessor,
        info.metadataReference,
      );
      if (isMethodOrAccessor(member)) {
        //   __esDecorate(this, null | _member_descriptor = { value() { ... } }, _member_decorators, { kind: "method", ... }, null, _instanceExtraInitializers);
        const extraInitializersName = isStatic(member)
          ? info.staticMethodExtraInitializersName!
          : info.instanceMethodExtraInitializersName!;
        let descriptor: Node;
        if (isPrivateIdentifierClassElementDeclaration(member) && descriptorKind !== DescriptorKind.None) {
          // A private member's body moves into a descriptor object, keeping only `async`.
          const descriptorObject = this.createDescriptorObject(
            descriptorKind,
            member,
            this.filterModifiers(modifiers, ModifierFilter.AsyncOnly),
          );
          memberInfo.descriptorName = this.createHelperVariable(member, 'descriptor');
          result.descriptorName = memberInfo.descriptorName;
          descriptor = factory.createAssignment(memberInfo.descriptorName, descriptorObject);
        } else descriptor = factory.createToken(SyntaxKind.NullKeyword);
        const statement = factory.createExpressionStatement(
          createESDecorateHelper(
            factory,
            factory.createKeywordExpression(SyntaxKind.ThisKeyword),
            descriptor,
            memberDecoratorsName,
            contextObject,
            factory.createToken(SyntaxKind.NullKeyword),
            extraInitializersName,
          ),
        );
        context.setSourceMapRange(statement, moveRangePastDecorators(member).pos, member.end);
        this.appendDecorationStatement(info, member, statement);
      } else if (isField) {
        //   __esDecorate(null | this, null | _member_descriptor = { get() { ... }, set(value) { ... } }, _member_decorators, { kind: "field", ... }, _member_initializers, _member_extraInitializers);
        memberInfo.initializersName = this.createHelperVariable(member, 'initializers');
        memberInfo.extraInitializersName = this.createHelperVariable(member, 'extraInitializers');
        result.initializersName = memberInfo.initializersName;
        result.extraInitializersName = memberInfo.extraInitializersName;
        if (isStatic(member)) result.thisArg = info.classThis;
        const ctor: Node = isAutoAccessorPropertyDeclaration(member)
          ? factory.createKeywordExpression(SyntaxKind.ThisKeyword)
          : factory.createToken(SyntaxKind.NullKeyword);
        let descriptor: Node;
        if (
          isPrivateIdentifierClassElementDeclaration(member) &&
          hasSyntacticModifier(member, ModifierFlags.Accessor) &&
          descriptorKind !== DescriptorKind.None
        ) {
          const descriptorObject = this.createDescriptorObject(descriptorKind, member, undefined);
          memberInfo.descriptorName = this.createHelperVariable(member, 'descriptor');
          result.descriptorName = memberInfo.descriptorName;
          descriptor = factory.createAssignment(memberInfo.descriptorName, descriptorObject);
        } else descriptor = factory.createToken(SyntaxKind.NullKeyword);
        const statement = factory.createExpressionStatement(
          createESDecorateHelper(
            factory,
            ctor,
            descriptor,
            memberDecoratorsName,
            contextObject,
            memberInfo.initializersName,
            memberInfo.extraInitializersName,
          ),
        );
        context.setSourceMapRange(statement, moveRangePastDecorators(member).pos, member.end);
        this.appendDecorationStatement(info, member, statement);
      }
    }
    if (result.name === undefined) {
      this.enterName();
      result.name = this.visitPropertyName(memberName);
      this.exitName();
    }
    // Comments of methods and properties without modifiers would print twice on the name.
    if (
      (modifiers === undefined || modifiers.nodes.length === 0) &&
      (member.kind === SyntaxKind.MethodDeclaration || member.kind === SyntaxKind.PropertyDeclaration)
    )
      context.setEmitFlags(result.name!, EmitFlags.NoLeadingComments);
    return result;
  }

  private appendDecorationStatement(info: ClassInfo, member: Node, statement: Node): boolean {
    if (isMethodOrAccessor(member) || isAutoAccessorPropertyDeclaration(member)) {
      if (isStatic(member)) info.staticNonFieldDecorationStatements.push(statement);
      else info.nonStaticNonFieldDecorationStatements.push(statement);
    } else if (isStatic(member)) info.staticFieldDecorationStatements.push(statement);
    else info.nonStaticFieldDecorationStatements.push(statement);
    return true;
  }

  // Class elements

  private visitMethodDeclaration(node: MethodDeclaration): Node {
    this.enterClassElement(node);
    const result = this.partialTransformClassElement(node, this.classInfo, DescriptorKind.Method);
    if (result.descriptorName !== undefined) {
      this.exitClassElement();
      return this.finishClassElement(
        this.createMethodDescriptorForwarder(result.modifiers, result.name!, result.descriptorName),
        node,
      );
    }
    const parameters = this.visitNodes(node.parameters)!;
    const body = this.visitNode(node.body);
    this.exitClassElement();
    return this.finishClassElement(
      this.factory.updateMethodDeclaration(
        node,
        result.modifiers,
        node.asteriskToken,
        result.name!,
        undefined,
        undefined,
        parameters,
        undefined,
        undefined,
        body,
      ),
      node,
    );
  }

  private visitGetAccessorDeclaration(node: GetAccessorDeclaration): Node {
    this.enterClassElement(node);
    const result = this.partialTransformClassElement(node, this.classInfo, DescriptorKind.GetAccessor);
    if (result.descriptorName !== undefined) {
      this.exitClassElement();
      return this.finishClassElement(
        this.createGetAccessorDescriptorForwarder(result.modifiers, result.name!, result.descriptorName),
        node,
      );
    }
    const parameters = this.visitNodes(node.parameters)!;
    const body = this.visitNode(node.body);
    this.exitClassElement();
    return this.finishClassElement(
      this.factory.updateGetAccessorDeclaration(
        node,
        result.modifiers,
        result.name!,
        undefined,
        parameters,
        undefined,
        undefined,
        body,
      ),
      node,
    );
  }

  private visitSetAccessorDeclaration(node: SetAccessorDeclaration): Node {
    this.enterClassElement(node);
    const result = this.partialTransformClassElement(node, this.classInfo, DescriptorKind.SetAccessor);
    if (result.descriptorName !== undefined) {
      this.exitClassElement();
      return this.finishClassElement(
        this.createSetAccessorDescriptorForwarder(result.modifiers, result.name!, result.descriptorName),
        node,
      );
    }
    const parameters = this.visitNodes(node.parameters)!;
    const body = this.visitNode(node.body);
    this.exitClassElement();
    return this.finishClassElement(
      this.factory.updateSetAccessorDeclaration(
        node,
        result.modifiers,
        result.name!,
        undefined,
        parameters,
        undefined,
        undefined,
        body,
      ),
      node,
    );
  }

  private visitClassStaticBlockDeclaration(node: ClassStaticBlockDeclaration): Node | undefined {
    const original: Node = node;
    this.enterClassElement(node);
    const factory = this.factory;
    const context = this.context;
    let result: Node;
    if (isClassNamedEvaluationHelperBlock(context, node)) {
      result = this.visitEachChild(node);
      // Keeps the block recognizable after `this` became `_classThis`.
      const assignedName = context.getAssignedName(node);
      if (assignedName !== undefined && result !== original) context.setAssignedName(result, assignedName);
    } else if (isClassThisAssignmentBlock(context, node)) {
      const savedClassThis = this.classThis;
      this.classThis = undefined;
      result = this.visitEachChild(node);
      this.classThis = savedClassThis;
    } else {
      // Temporaries of the block's contents stay scoped to the block.
      context.startVariableEnvironment();
      result = this.visitEachChild(node);
      const declarations = context.endVariableEnvironment();
      if (declarations.length > 0 && result instanceof ClassStaticBlockDeclaration) {
        const body = (result as ClassStaticBlockDeclaration).body;
        result = factory.created(
          new ClassStaticBlockDeclaration(
            undefined,
            factory.createBlock(declarations.concat(body.statements.nodes), body.multiLine),
          ),
        );
      }
      const info = this.classInfo;
      if (info !== undefined) {
        info.hasStaticInitializers = true;
        if (info.pendingStaticInitializers.length > 0) {
          // Pending initializers get a block of their own, so names don't collide with this one's.
          const statements: Node[] = [];
          for (let i = 0; i < info.pendingStaticInitializers.length; i++) {
            const initializer = info.pendingStaticInitializers[i];
            const statement = factory.createExpressionStatement(initializer);
            context.setSourceMapRange(statement, context.sourceMapPos(initializer), context.sourceMapEnd(initializer));
            statements.push(statement);
          }
          const staticBlock = factory.created(
            new ClassStaticBlockDeclaration(undefined, factory.createBlock(statements, true)),
          );
          info.pendingStaticInitializers = [];
          this.exitClassElement();
          return singleOrMany([staticBlock, result], factory);
        }
      }
    }
    this.exitClassElement();
    return result;
  }

  private visitPropertyDeclaration(original: PropertyDeclaration): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    let node = original;
    if (isNamedEvaluation(context, node, anonymousDecoratedClass))
      node = transformNamedEvaluation(
        context,
        node,
        canIgnoreEmptyStringLiteralInAssignedName(node.initializer),
        '',
      ) as PropertyDeclaration;
    this.enterClassElement(node);
    const isAccessor = hasSyntacticModifier(node, ModifierFlags.Accessor);
    const result = this.partialTransformClassElement(
      node,
      this.classInfo,
      isAccessor ? DescriptorKind.AccessorProperty : DescriptorKind.None,
    );
    context.startVariableEnvironment();
    let initializer = this.visitNode(node.initializer);
    if (result.initializersName !== undefined)
      initializer = createRunInitializersHelper(
        factory,
        result.thisArg !== undefined ? result.thisArg : factory.createKeywordExpression(SyntaxKind.ThisKeyword),
        result.initializersName,
        initializer !== undefined ? initializer : factory.createVoidZero(),
      );
    const info = this.classInfo;
    if (isStatic(node) && info !== undefined && initializer !== undefined) info.hasStaticInitializers = true;
    const declarations = context.endVariableEnvironment();
    if (declarations.length > 0) {
      declarations.push(factory.createReturnStatement(initializer));
      initializer = factory.createImmediatelyInvokedArrowFunction(declarations);
    }
    if (info !== undefined) {
      if (isStatic(node)) {
        initializer = this.injectPendingInitializers(info, true, initializer);
        if (result.extraInitializersName !== undefined)
          info.pendingStaticInitializers.push(
            createRunInitializersHelper(
              factory,
              info.classThis !== undefined ? info.classThis : factory.createKeywordExpression(SyntaxKind.ThisKeyword),
              result.extraInitializersName,
              undefined,
            ),
          );
      } else {
        initializer = this.injectPendingInitializers(info, false, initializer);
        if (result.extraInitializersName !== undefined)
          info.pendingInstanceInitializers.push(
            createRunInitializersHelper(
              factory,
              factory.createKeywordExpression(SyntaxKind.ThisKeyword),
              result.extraInitializersName,
              undefined,
            ),
          );
      }
    }
    this.exitClassElement();
    if (isAccessor && result.descriptorName !== undefined) {
      // `accessor #x = 1;` becomes a backing field and forwarders to the decorated descriptor:
      //   #x_accessor_storage = 1;
      //   get #x() { return _private_x_descriptor.get.call(this); }
      //   set #x(value) { _private_x_descriptor.set.call(this, value); }
      const commentPos = context.commentPos(node);
      const commentEnd = context.commentEnd(node);
      const sourceMapPos = context.sourceMapPos(node);
      const sourceMapEnd = context.sourceMapEnd(node);
      // Two declarations replace one, so a computed name is cached.
      const propertyName = node.name;
      let getterName = result.name!;
      let setterName = result.name!;
      if (propertyName instanceof ComputedPropertyName && !isSimpleInlineableExpression(propertyName.expression)) {
        const cacheAssignment = findComputedPropertyNameCacheAssignment(propertyName);
        if (cacheAssignment !== undefined) {
          getterName = factory.updateComputedPropertyName(propertyName, this.visitNode(propertyName.expression)!);
          setterName = factory.updateComputedPropertyName(propertyName, cacheAssignment.left);
        } else {
          const temp = factory.createTempVariable(0);
          const expressionNode = propertyName.expression;
          context.setSourceMapRange(temp, expressionNode.pos, expressionNode.end);
          context.addVariableDeclaration(temp);
          const assignment = factory.createAssignment(temp, this.visitNode(expressionNode)!);
          context.setSourceMapRange(assignment, expressionNode.pos, expressionNode.end);
          getterName = factory.updateComputedPropertyName(propertyName, assignment);
          setterName = factory.updateComputedPropertyName(propertyName, temp);
        }
      }
      const modifiers = this.filterModifiers(result.modifiers, ModifierFilter.NoAccessor);
      const backingField: Node = createAccessorPropertyBackingField(factory, node, modifiers, initializer);
      context.setOriginal(backingField, node);
      context.setEmitFlags(backingField, EmitFlags.NoComments);
      context.setSourceMapRange(backingField, sourceMapPos, sourceMapEnd);
      const backingFieldName = getName(backingField)!;
      context.setSourceMapRange(backingFieldName, context.sourceMapPos(node.name), context.sourceMapEnd(node.name));
      const getter = this.createGetAccessorDescriptorForwarder(modifiers, getterName, result.descriptorName);
      context.setOriginal(getter, node);
      context.setCommentRange(getter, commentPos, commentEnd);
      context.setSourceMapRange(getter, sourceMapPos, sourceMapEnd);
      const setter = this.createSetAccessorDescriptorForwarder(modifiers, setterName, result.descriptorName);
      context.setOriginal(setter, node);
      context.setEmitFlags(setter, EmitFlags.NoComments);
      context.setSourceMapRange(setter, sourceMapPos, sourceMapEnd);
      const declarations: Node[] = [];
      declarations.push(backingField);
      declarations.push(getter);
      declarations.push(setter);
      return factory.createSyntaxList(declarations);
    }
    return this.finishClassElement(
      factory.updatePropertyDeclaration(node, result.modifiers, result.name!, undefined, undefined, initializer),
      node,
    );
  }

  // `super` and `this` in static initializers

  private visitCallExpression(node: CallExpression): Node {
    if (isSuperProperty(node.expression) && this.classThis !== undefined) {
      const expression = this.visitNode(node.expression)!;
      const args = this.visitNodes(node.arguments)!;
      const invocation = this.factory.createFunctionCallCall(expression, this.classThis, args.nodes);
      this.context.setOriginal(invocation, node);
      invocation.pos = node.pos;
      invocation.end = node.end;
      return invocation;
    }
    return this.visitEachChild(node);
  }

  private visitTaggedTemplateExpression(node: TaggedTemplateExpression): Node {
    if (isSuperProperty(node.tag) && this.classThis !== undefined) {
      const tag = this.visitNode(node.tag)!;
      const boundTag = this.factory.createFunctionBindCall(tag, this.classThis, []);
      this.context.setOriginal(boundTag, node);
      boundTag.pos = node.pos;
      boundTag.end = node.end;
      const template = this.visitNode(node.template)!;
      return this.factory.updateTaggedTemplateExpression(node, boundTag, undefined, undefined, template, node.flags);
    }
    return this.visitEachChild(node);
  }

  private visitPropertyAccessExpression(node: PropertyAccessExpression): Node {
    if (
      isSuperProperty(node) &&
      node.name instanceof Identifier &&
      this.classThis !== undefined &&
      this.classSuper !== undefined
    ) {
      const superProperty = this.factory.createReflectGetCall(
        this.classSuper,
        this.factory.createStringLiteralFromNode(node.name),
        this.classThis,
      );
      this.context.setOriginal(superProperty, node.expression);
      superProperty.pos = node.expression.pos;
      superProperty.end = node.expression.end;
      return superProperty;
    }
    return this.visitEachChild(node);
  }

  private visitElementAccessExpression(node: ElementAccessExpression): Node {
    if (isSuperProperty(node) && this.classThis !== undefined && this.classSuper !== undefined) {
      const superProperty = this.factory.createReflectGetCall(
        this.classSuper,
        this.visitNode(node.argumentExpression)!,
        this.classThis,
      );
      this.context.setOriginal(superProperty, node.expression);
      superProperty.pos = node.expression.pos;
      superProperty.end = node.expression.end;
      return superProperty;
    }
    return this.visitEachChild(node);
  }

  // NamedEvaluation sites

  private visitParameterDeclaration(original: ParameterDeclaration): Node {
    const context = this.context;
    let node = original;
    if (isNamedEvaluation(context, node, anonymousDecoratedClass))
      node = transformNamedEvaluation(
        context,
        node,
        canIgnoreEmptyStringLiteralInAssignedName(node.initializer),
        '',
      ) as ParameterDeclaration;
    // Drops all modifiers, decorators included.
    const updated = this.factory.updateParameterDeclaration(
      node,
      undefined,
      node.dotDotDotToken,
      this.visitNode(node.name)!,
      undefined,
      undefined,
      this.visitNode(node.initializer),
    );
    if (updated !== node) {
      // Source maps start past the modifiers, but comments cover the original range.
      context.setCommentRange(updated, node.pos, node.end);
      const pos = moveRangePastModifiers(node).pos;
      updated.pos = pos | 0;
      updated.end = node.end;
      context.setSourceMapRange(updated, pos, node.end);
      context.setEmitFlags(updated.name, EmitFlags.NoTrailingSourceMap);
    }
    return updated;
  }

  private visitNamedEvaluationSite(node: Node, value: Node | undefined): Node {
    if (isNamedEvaluation(this.context, node, anonymousDecoratedClass))
      node = transformNamedEvaluation(this.context, node, canIgnoreEmptyStringLiteralInAssignedName(value), '');
    return this.visitEachChild(node);
  }

  private visitForStatement(node: ForStatement): Node {
    return this.factory.updateForStatement(
      node,
      this.visitDiscardedNode(node.initializer),
      this.visitNode(node.condition),
      this.visitDiscardedNode(node.incrementor),
      this.visitIterationBody(node.statement)!,
    );
  }

  private visitBinaryExpression(node: BinaryExpression, discarded: boolean): Node {
    const factory = this.factory;
    const context = this.context;
    if (isDestructuringAssignment(node)) {
      const left = this.visitAssignmentPattern(node.left);
      const right = this.visitNode(node.right)!;
      return factory.updateBinaryExpression(node, undefined, left, undefined, node.operatorToken, right);
    }
    if (isAssignmentExpression(node, false)) {
      if (isNamedEvaluation(context, node, anonymousDecoratedClass))
        return this.visitEachChild(
          transformNamedEvaluation(context, node, canIgnoreEmptyStringLiteralInAssignedName(node.right), ''),
        );
      const left = node.left;
      if (isSuperProperty(left) && this.classThis !== undefined && this.classSuper !== undefined) {
        let setterName: Node | undefined = undefined;
        if (left instanceof ElementAccessExpression) setterName = this.visitNode(left.argumentExpression);
        else if (left instanceof PropertyAccessExpression && left.name instanceof Identifier)
          setterName = factory.createStringLiteralFromNode(left.name);
        if (setterName !== undefined) {
          //   super.x = ...    super.x += ...    super[x] = ...    super[x] += ...
          let expression = this.visitNode(node.right)!;
          if (isCompoundAssignment(node.operatorToken.kind)) {
            let getterName = setterName;
            if (!isSimpleInlineableExpression(setterName)) {
              const temp = factory.createTempVariable(0);
              context.addVariableDeclaration(temp);
              getterName = temp;
              setterName = factory.createAssignment(temp, setterName);
            }
            const superPropertyGet = factory.createReflectGetCall(this.classSuper, getterName, this.classThis);
            context.setOriginal(superPropertyGet, left);
            superPropertyGet.pos = left.pos;
            superPropertyGet.end = left.end;
            expression = factory.createBinaryExpression(
              superPropertyGet,
              getNonAssignmentOperatorForCompoundAssignment(node.operatorToken.kind),
              expression,
            );
            expression.pos = node.pos;
            expression.end = node.end;
          }
          let temp: Identifier | undefined = undefined;
          if (!discarded) {
            temp = factory.createTempVariable(0);
            context.addVariableDeclaration(temp);
            expression = factory.createAssignment(temp, expression);
            expression.pos = node.pos;
            expression.end = node.end;
          }
          expression = factory.createReflectSetCall(this.classSuper, setterName, expression, this.classThis);
          context.setOriginal(expression, node);
          expression.pos = node.pos;
          expression.end = node.end;
          if (temp !== undefined) {
            expression = factory.createCommaExpression(expression, temp);
            expression.pos = node.pos;
            expression.end = node.end;
          }
          return expression;
        }
      }
    }
    if (node.operatorToken.kind === SyntaxKind.CommaToken) {
      const left = this.visitDiscarded(node.left)!;
      const right = discarded ? this.visitDiscarded(node.right)! : this.visitNode(node.right)!;
      return factory.updateBinaryExpression(node, undefined, left, undefined, node.operatorToken, right);
    }
    return this.visitEachChild(node);
  }

  private visitPreOrPostfixUnaryExpression(node: Node, discarded: boolean): Node {
    const factory = this.factory;
    const context = this.context;
    let operator = SyntaxKind.Unknown;
    let operandNode: Node | undefined = undefined;
    if (node instanceof PrefixUnaryExpression) {
      operator = node.operator;
      operandNode = node.operand;
    } else if (node instanceof PostfixUnaryExpression) {
      operator = node.operator;
      operandNode = node.operand;
    }
    if (
      operandNode !== undefined &&
      (operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken)
    ) {
      const operand = skipParentheses(operandNode);
      if (isSuperProperty(operand) && this.classThis !== undefined && this.classSuper !== undefined) {
        let setterName: Node | undefined = undefined;
        if (operand instanceof ElementAccessExpression) setterName = this.visitNode(operand.argumentExpression);
        else if (operand instanceof PropertyAccessExpression && operand.name instanceof Identifier)
          setterName = factory.createStringLiteralFromNode(operand.name);
        if (setterName !== undefined) {
          let getterName = setterName;
          if (!isSimpleInlineableExpression(setterName)) {
            const temp = factory.createTempVariable(0);
            context.addVariableDeclaration(temp);
            getterName = temp;
            setterName = factory.createAssignment(temp, setterName);
          }
          let expression: Node = factory.createReflectGetCall(this.classSuper, getterName, this.classThis);
          context.setOriginal(expression, node);
          expression.pos = node.pos;
          expression.end = node.end;
          // A discarded result needs no temporary for it:
          //   super.x++;      =>  _a = Reflect.get(_super, "x"), _a++, Reflect.set(_super, "x", _a);
          //   y = super.x++;  =>  y = (_a = Reflect.get(_super, "x"), _b = _a++, Reflect.set(_super, "x", _a), _b);
          let temp: Identifier | undefined = undefined;
          if (!discarded) {
            temp = factory.createTempVariable(0);
            context.addVariableDeclaration(temp);
          }
          expression = expandPreOrPostfixIncrementOrDecrementExpression(context, node, expression, temp);
          expression = factory.createReflectSetCall(this.classSuper, setterName, expression, this.classThis);
          context.setOriginal(expression, node);
          expression.pos = node.pos;
          expression.end = node.end;
          if (temp !== undefined) {
            expression = factory.createCommaExpression(expression, temp);
            expression.pos = node.pos;
            expression.end = node.end;
          }
          return expression;
        }
      }
    }
    return this.visitEachChild(node);
  }

  // Property names

  /** Sets the result's referenced name, for the decorator context, and its visited name. */
  private visitReferencedPropertyName(node: Node, result: PartialResult): boolean {
    const factory = this.factory;
    if (isPropertyNameLiteral(node) || node instanceof PrivateIdentifier) {
      result.referencedName = factory.createStringLiteralFromNode(node);
      result.name = this.visitNode(node);
      return true;
    }
    if (!(node instanceof ComputedPropertyName)) return false;
    const expression = node.expression;
    if (isPropertyNameLiteral(expression) && !(expression instanceof Identifier)) {
      result.referencedName = factory.createStringLiteralFromNode(expression);
      result.name = this.visitNode(node);
      return true;
    }
    const referencedName = factory.createGeneratedNameForNode(node, 0, '', '');
    this.context.addVariableDeclaration(referencedName);
    const key = createPropKeyHelper(factory, this.visitNode(expression)!);
    const assignment = factory.createAssignment(referencedName, key);
    result.referencedName = referencedName;
    result.name = factory.updateComputedPropertyName(node, this.injectPendingExpressions(assignment));
    return true;
  }

  private visitPropertyName(node: Node | undefined): Node | undefined {
    if (node instanceof ComputedPropertyName) return this.visitComputedPropertyName(node);
    return this.visitNode(node);
  }

  private visitComputedPropertyName(node: ComputedPropertyName): Node {
    let expression = this.visitNode(node.expression)!;
    if (!isSimpleInlineableExpression(expression)) expression = this.injectPendingExpressions(expression);
    return this.factory.updateComputedPropertyName(node, expression);
  }

  // Destructuring assignments

  private visitDestructuringAssignmentTarget(node: Node): Node {
    if (node instanceof ObjectLiteralExpression || node instanceof ArrayLiteralExpression)
      return this.visitAssignmentPattern(node);
    if (isSuperProperty(node) && this.classThis !== undefined && this.classSuper !== undefined) {
      const factory = this.factory;
      let propertyName: Node | undefined = undefined;
      if (node instanceof ElementAccessExpression) propertyName = this.visitNode(node.argumentExpression);
      else if (node instanceof PropertyAccessExpression && node.name instanceof Identifier)
        propertyName = factory.createStringLiteralFromNode(node.name);
      if (propertyName !== undefined) {
        const paramName = factory.createTempVariable(0);
        const expression = factory.createAssignmentTargetWrapper(
          paramName,
          factory.createReflectSetCall(this.classSuper, propertyName, paramName, this.classThis),
        );
        this.context.setOriginal(expression, node);
        expression.pos = node.pos;
        expression.end = node.end;
        return expression;
      }
    }
    return this.visitEachChild(node);
  }

  private visitAssignmentElement(node: Node): Node {
    if (node instanceof BinaryExpression && isAssignmentExpression(node, true)) {
      let assignment = node as BinaryExpression;
      if (isNamedEvaluation(this.context, assignment, anonymousDecoratedClass))
        assignment = transformNamedEvaluation(
          this.context,
          assignment,
          canIgnoreEmptyStringLiteralInAssignedName(assignment.right),
          '',
        ) as BinaryExpression;
      const target = this.visitDestructuringAssignmentTarget(assignment.left);
      const initializer = this.visitNode(assignment.right)!;
      return this.factory.updateBinaryExpression(
        assignment,
        undefined,
        target,
        undefined,
        assignment.operatorToken,
        initializer,
      );
    }
    return this.visitDestructuringAssignmentTarget(node);
  }

  private visitArrayAssignmentElement(node: Node): Node | undefined {
    if (node instanceof SpreadElement) {
      const spread = node as SpreadElement;
      if (isLeftHandSideExpression(spread.expression))
        return this.factory.updateSpreadElement(spread, this.visitDestructuringAssignmentTarget(spread.expression));
      return this.visitEachChild(node);
    }
    if (node.kind !== SyntaxKind.OmittedExpression) return this.visitAssignmentElement(node);
    return this.visitEachChild(node);
  }

  private visitObjectAssignmentElement(node: Node): Node | undefined {
    const factory = this.factory;
    if (node instanceof SpreadAssignment) {
      const spread = node as SpreadAssignment;
      if (isLeftHandSideExpression(spread.expression))
        return factory.updateSpreadAssignment(spread, this.visitDestructuringAssignmentTarget(spread.expression));
      return this.visitEachChild(node);
    }
    if (node instanceof ShorthandPropertyAssignment) {
      const shorthand = node as ShorthandPropertyAssignment;
      let property: Node = shorthand;
      if (isNamedEvaluation(this.context, shorthand, anonymousDecoratedClass))
        property = transformNamedEvaluation(
          this.context,
          shorthand,
          canIgnoreEmptyStringLiteralInAssignedName(shorthand.objectAssignmentInitializer),
          '',
        );
      return this.visitEachChild(property);
    }
    if (node instanceof PropertyAssignment) {
      const property = node as PropertyAssignment;
      const name = this.visitNode(property.name)!;
      if (isAssignmentExpression(property.initializer, true))
        return factory.updatePropertyAssignment(
          property,
          undefined,
          name,
          undefined,
          undefined,
          this.visitAssignmentElement(property.initializer),
        );
      if (isLeftHandSideExpression(property.initializer))
        return factory.updatePropertyAssignment(
          property,
          undefined,
          name,
          undefined,
          undefined,
          this.visitDestructuringAssignmentTarget(property.initializer),
        );
    }
    return this.visitEachChild(node);
  }

  private visitAssignmentPattern(node: Node): Node {
    if (node instanceof ArrayLiteralExpression) {
      const array = node as ArrayLiteralExpression;
      return this.factory.updateArrayLiteralExpression(
        array,
        this.visitList(array.elements, ListVisit.ArrayAssignmentElements),
        array.multiLine,
      );
    }
    if (node instanceof ObjectLiteralExpression) {
      const object = node as ObjectLiteralExpression;
      return this.factory.updateObjectLiteralExpression(
        object,
        this.visitList(object.properties, ListVisit.ObjectAssignmentElements),
        object.multiLine,
      );
    }
    return node;
  }

  private visitParenthesizedExpression(node: ParenthesizedExpression, discarded: boolean): Node {
    const expression = discarded ? this.visitDiscarded(node.expression)! : this.visitNode(node.expression)!;
    return this.factory.updateParenthesizedExpression(node, expression);
  }

  private visitPartiallyEmittedExpression(node: PartiallyEmittedExpression, discarded: boolean): Node {
    const expression = discarded ? this.visitDiscarded(node.expression)! : this.visitNode(node.expression)!;
    return this.factory.updatePartiallyEmittedExpression(node, expression);
  }

  // Pending expressions

  /** `pending` evaluated before `expression`, inside its parentheses. */
  private prependExpressions(pending: Node[], expression: Node | undefined): Node | undefined {
    const factory = this.factory;
    if (pending.length === 0) return expression;
    if (expression === undefined) return factory.inlineExpressions(pending);
    if (expression instanceof ParenthesizedExpression)
      return factory.updateParenthesizedExpression(
        expression,
        factory.inlineExpressions(pending.concat([expression.expression]))!,
      );
    return factory.inlineExpressions(pending.concat([expression]));
  }

  private injectPendingExpressions(expression: Node): Node {
    const result = this.prependExpressions(this.pendingExpressions, expression)!;
    if (result !== expression) this.pendingExpressions = [];
    return result;
  }

  private injectPendingInitializers(
    info: ClassInfo,
    isStaticMember: boolean,
    expression: Node | undefined,
  ): Node | undefined {
    if (isStaticMember) {
      const result = this.prependExpressions(info.pendingStaticInitializers, expression);
      if (result !== expression) info.pendingStaticInitializers = [];
      return result;
    }
    const result = this.prependExpressions(info.pendingInstanceInitializers, expression);
    if (result !== expression) info.pendingInstanceInitializers = [];
    return result;
  }

  // Decorators

  private transformAllDecoratorsOfDeclaration(decorators: Node[]): Node[] {
    const result: Node[] = [];
    for (let i = 0; i < decorators.length; i++) {
      const decorator = decorators[i];
      if (decorator instanceof Decorator) result.push(this.transformDecorator(decorator as Decorator));
    }
    return result;
  }

  private transformDecorator(decorator: Decorator): Node {
    const expression = this.visitNode(decorator.expression)!;
    this.context.setEmitFlags(expression, EmitFlags.NoComments);
    // An access expression keeps its `this`.
    const inner = skipOuterExpressions(expression, OuterExpressionKinds.All);
    if (inner instanceof PropertyAccessExpression || inner instanceof ElementAccessExpression) {
      const bound = this.createCallBinding(expression);
      return this.context.factory.restoreOuterExpressions(
        expression,
        this.factory.createFunctionBindCall(bound.target, bound.thisArg, []),
        OuterExpressionKinds.All,
      );
    }
    return expression;
  }

  private createCallBinding(expression: Node): CallBinding {
    const factory = this.factory;
    const callee = skipOuterExpressions(expression, OuterExpressionKinds.All);
    if (isSuperProperty(callee) || callee.kind === SyntaxKind.SuperKeyword)
      return new CallBinding(callee, factory.createKeywordExpression(SyntaxKind.ThisKeyword));
    if ((this.context.getEmitFlags(callee) & EmitFlags.HelperName) !== 0)
      return new CallBinding(callee, factory.createVoidZero());
    if (callee instanceof PropertyAccessExpression) {
      if (shouldBeCapturedInTempVariable(callee.expression)) {
        const thisArg = factory.createTempVariable(0);
        this.context.addVariableDeclaration(thisArg);
        const assignment = factory.createAssignment(thisArg, callee.expression);
        assignment.pos = callee.expression.pos;
        assignment.end = callee.expression.end;
        const target = factory.createPropertyAccessExpression(assignment, callee.name);
        target.pos = callee.pos;
        target.end = callee.end;
        return new CallBinding(target, thisArg);
      }
      return new CallBinding(callee, callee.expression);
    }
    if (callee instanceof ElementAccessExpression) {
      if (shouldBeCapturedInTempVariable(callee.expression)) {
        const thisArg = factory.createTempVariable(0);
        this.context.addVariableDeclaration(thisArg);
        const assignment = factory.createAssignment(thisArg, callee.expression);
        assignment.pos = callee.expression.pos;
        assignment.end = callee.expression.end;
        const target = factory.createElementAccessExpression(assignment, callee.argumentExpression);
        target.pos = callee.pos;
        target.end = callee.end;
        return new CallBinding(target, thisArg);
      }
      return new CallBinding(callee, callee.expression);
    }
    return new CallBinding(expression, factory.createVoidZero());
  }

  // Pseudo-descriptors of private elements

  /** A `value`, `get` or `set` method of a pseudo-descriptor: `kind: __setFunctionName(function () {}, "#x")`. */
  private createDescriptorMethod(
    original: Node,
    name: Node,
    modifiers: ModifierList | undefined,
    asteriskToken: Token | undefined,
    kind: string,
    parameters: NodeList,
    body: Node | undefined,
  ): Node {
    const factory = this.factory;
    const context = this.context;
    const fn = factory.created(
      new FunctionExpression(
        modifiers,
        asteriskToken,
        undefined,
        undefined,
        parameters,
        undefined,
        undefined,
        body !== undefined ? body : factory.createBlock([], false),
      ),
    );
    context.setOriginal(fn, original);
    context.setSourceMapRange(fn, moveRangePastDecorators(original).pos, original.end);
    context.setEmitFlags(fn, EmitFlags.NoComments);
    const prefix = kind === 'get' || kind === 'set' ? kind : '';
    const named = createSetFunctionNameHelper(factory, fn, factory.createStringLiteralFromNode(name), prefix);
    const method = factory.createPropertyAssignment(factory.createIdentifier(kind), named);
    context.setOriginal(method, original);
    context.setSourceMapRange(method, moveRangePastDecorators(original).pos, original.end);
    context.setEmitFlags(method, EmitFlags.NoComments);
    return method;
  }

  private createDescriptorObject(kind: DescriptorKind, member: Node, modifiers: ModifierList | undefined): Node {
    const factory = this.factory;
    const name = getName(member)!;
    const methods: Node[] = [];
    switch (kind) {
      case DescriptorKind.Method: {
        const parameters = this.visitNodes(getParameters(member))!;
        const body = this.visitNode(getBody(member));
        const asterisk = member instanceof MethodDeclaration ? (member as MethodDeclaration).asteriskToken : undefined;
        methods.push(this.createDescriptorMethod(member, name, modifiers, asterisk, 'value', parameters, body));
        break;
      }
      case DescriptorKind.GetAccessor: {
        const body = this.visitNode(getBody(member));
        methods.push(
          this.createDescriptorMethod(member, name, modifiers, undefined, 'get', factory.createNodeList([]), body),
        );
        break;
      }
      case DescriptorKind.SetAccessor: {
        const parameters = this.visitNodes(getParameters(member))!;
        const body = this.visitNode(getBody(member));
        methods.push(this.createDescriptorMethod(member, name, modifiers, undefined, 'set', parameters, body));
        break;
      }
      case DescriptorKind.AccessorProperty: {
        //   { get() { return this.#x_accessor_storage; }, set(value) { this.#x_accessor_storage = value; } }
        const storage = factory.createGeneratedPrivateNameForNode(name, '', '_accessor_storage');
        const self = factory.createKeywordExpression(SyntaxKind.ThisKeyword);
        methods.push(
          this.createDescriptorMethod(
            member,
            name,
            undefined,
            undefined,
            'get',
            factory.createNodeList([]),
            factory.createBlock(
              [factory.createReturnStatement(factory.createPropertyAccessExpression(self, storage))],
              false,
            ),
          ),
        );
        methods.push(
          this.createDescriptorMethod(
            member,
            name,
            undefined,
            undefined,
            'set',
            factory.createNodeList([factory.createParameter(factory.createIdentifier('value'))]),
            factory.createBlock(
              [
                factory.createExpressionStatement(
                  factory.createAssignment(
                    factory.createPropertyAccessExpression(
                      factory.createKeywordExpression(SyntaxKind.ThisKeyword),
                      storage,
                    ),
                    factory.createIdentifier('value'),
                  ),
                ),
              ],
              false,
            ),
          ),
        );
        break;
      }
    }
    return factory.createObjectLiteral(methods, false);
  }

  /** `get name() { return _descriptor.value; }` */
  private createMethodDescriptorForwarder(
    modifiers: ModifierList | undefined,
    name: Node,
    descriptorName: Identifier,
  ): Node {
    const factory = this.factory;
    return factory.created(
      new GetAccessorDeclaration(
        this.filterModifiers(modifiers, ModifierFilter.StaticOnly),
        name,
        undefined,
        factory.createNodeList([]),
        undefined,
        undefined,
        factory.createBlock(
          [
            factory.createReturnStatement(
              factory.createPropertyAccessExpression(descriptorName, factory.createIdentifier('value')),
            ),
          ],
          false,
        ),
      ),
    );
  }

  /** `get name() { return _descriptor.get.call(this); }` */
  private createGetAccessorDescriptorForwarder(
    modifiers: ModifierList | undefined,
    name: Node,
    descriptorName: Identifier,
  ): Node {
    const factory = this.factory;
    return factory.created(
      new GetAccessorDeclaration(
        this.filterModifiers(modifiers, ModifierFilter.StaticOnly),
        name,
        undefined,
        factory.createNodeList([]),
        undefined,
        undefined,
        factory.createBlock(
          [
            factory.createReturnStatement(
              factory.createFunctionCallCall(
                factory.createPropertyAccessExpression(descriptorName, factory.createIdentifier('get')),
                factory.createKeywordExpression(SyntaxKind.ThisKeyword),
                [],
              ),
            ),
          ],
          false,
        ),
      ),
    );
  }

  /** `set name(value) { return _descriptor.set.call(this, value); }` */
  private createSetAccessorDescriptorForwarder(
    modifiers: ModifierList | undefined,
    name: Node,
    descriptorName: Identifier,
  ): Node {
    const factory = this.factory;
    return factory.created(
      new SetAccessorDeclaration(
        this.filterModifiers(modifiers, ModifierFilter.StaticOnly),
        name,
        undefined,
        factory.createNodeList([factory.createParameter(factory.createIdentifier('value'))]),
        undefined,
        undefined,
        factory.createBlock(
          [
            factory.createReturnStatement(
              factory.createFunctionCallCall(
                factory.createPropertyAccessExpression(descriptorName, factory.createIdentifier('set')),
                factory.createKeywordExpression(SyntaxKind.ThisKeyword),
                [factory.createIdentifier('value')],
              ),
            ),
          ],
          false,
        ),
      ),
    );
  }

  // Decorator contexts and metadata

  private createClassElementContextObject(
    kind: string,
    nameComputed: boolean,
    name: Node,
    isStaticMember: boolean,
    isPrivate: boolean,
    hasGet: boolean,
    hasSet: boolean,
    metadata: Identifier,
  ): Node {
    const factory = this.factory;
    const nameValue: Node =
      !nameComputed && (name instanceof Identifier || name instanceof PrivateIdentifier)
        ? factory.createStringLiteralFromNode(name)
        : name;
    // `has` checks `name in obj`; `get` and `set` access `obj.name` or `obj[name]`.
    const access: Node[] = [
      factory.createPropertyAssignment(
        factory.createIdentifier('has'),
        factory.createArrowFunction(
          [factory.createParameter(factory.createIdentifier('obj'))],
          factory.createBinaryExpression(
            !nameComputed && name instanceof Identifier ? (factory.createStringLiteralFromNode(name) as Node) : name,
            SyntaxKind.InKeyword,
            factory.createIdentifier('obj'),
          ),
        ),
      ),
    ];
    if (hasGet)
      access.push(
        factory.createPropertyAssignment(
          factory.createIdentifier('get'),
          factory.createArrowFunction(
            [factory.createParameter(factory.createIdentifier('obj'))],
            this.createAccess(nameComputed, name),
          ),
        ),
      );
    if (hasSet)
      access.push(
        factory.createPropertyAssignment(
          factory.createIdentifier('set'),
          factory.createArrowFunction(
            [
              factory.createParameter(factory.createIdentifier('obj')),
              factory.createParameter(factory.createIdentifier('value')),
            ],
            factory.createBlock(
              [
                factory.createExpressionStatement(
                  factory.createAssignment(this.createAccess(nameComputed, name), factory.createIdentifier('value')),
                ),
              ],
              false,
            ),
          ),
        ),
      );
    return factory.createObjectLiteral(
      [
        factory.createPropertyAssignment(
          factory.createIdentifier('kind'),
          factory.createStringLiteral(kind, TokenFlags.None),
        ),
        factory.createPropertyAssignment(factory.createIdentifier('name'), nameValue),
        factory.createPropertyAssignment(
          factory.createIdentifier('static'),
          factory.createKeywordExpression(isStaticMember ? SyntaxKind.TrueKeyword : SyntaxKind.FalseKeyword),
        ),
        factory.createPropertyAssignment(
          factory.createIdentifier('private'),
          factory.createKeywordExpression(isPrivate ? SyntaxKind.TrueKeyword : SyntaxKind.FalseKeyword),
        ),
        factory.createPropertyAssignment(
          factory.createIdentifier('access'),
          factory.createObjectLiteral(access, false),
        ),
        factory.createPropertyAssignment(factory.createIdentifier('metadata'), metadata),
      ],
      false,
    );
  }

  private createAccess(nameComputed: boolean, name: Node): Node {
    const obj = this.factory.createIdentifier('obj');
    return nameComputed
      ? this.factory.createElementAccessExpression(obj, name)
      : this.factory.createPropertyAccessExpression(obj, name);
  }

  /** `const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(superMetadata) : void 0;` */
  private createMetadata(name: Identifier, classSuper: Identifier | undefined): Node {
    const factory = this.factory;
    const superMetadata: Node =
      classSuper !== undefined
        ? factory.createBinaryExpression(
            factory.createElementAccessExpression(classSuper, this.createSymbolMetadataAccess()),
            SyntaxKind.QuestionQuestionToken,
            factory.createToken(SyntaxKind.NullKeyword),
          )
        : factory.createToken(SyntaxKind.NullKeyword);
    const create = factory.createCallExpression(
      factory.createPropertyAccessExpression(factory.createIdentifier('Object'), factory.createIdentifier('create')),
      [superMetadata],
    );
    const symbolCheck = factory.createBinaryExpression(
      factory.createTypeCheck(factory.createIdentifier('Symbol'), 'function'),
      SyntaxKind.AmpersandAmpersandToken,
      this.createSymbolMetadataAccess(),
    );
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([
          factory.createVariableDeclaration(
            name,
            undefined,
            undefined,
            factory.createConditionalExpression(symbolCheck, create, factory.createVoidZero()),
          ),
        ]),
        NodeFlags.Const,
      ),
    );
  }

  private createSymbolMetadataAccess(): Node {
    return this.factory.createPropertyAccessExpression(
      this.factory.createIdentifier('Symbol'),
      this.factory.createIdentifier('metadata'),
    );
  }

  /** `if (metadata) Object.defineProperty(target, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: metadata });` */
  private createSymbolMetadata(target: Node, value: Identifier): Node {
    const factory = this.factory;
    const descriptor = factory.createObjectLiteral(
      [
        factory.createPropertyAssignment(factory.createIdentifier('enumerable'), factory.createTrue()),
        factory.createPropertyAssignment(factory.createIdentifier('configurable'), factory.createTrue()),
        factory.createPropertyAssignment(factory.createIdentifier('writable'), factory.createTrue()),
        factory.createPropertyAssignment(factory.createIdentifier('value'), value),
      ],
      false,
    );
    const defineProperty = factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('Object'),
        factory.createIdentifier('defineProperty'),
      ),
      [target, this.createSymbolMetadataAccess(), descriptor],
    );
    const statement: IfStatement = factory.createIfStatement(
      value,
      factory.createExpressionStatement(defineProperty),
      undefined,
    );
    this.context.setEmitFlags(statement, EmitFlags.SingleLine);
    return statement;
  }
}

/** The callee and `this` argument of a call. */
class CallBinding {
  readonly target: Node;
  readonly thisArg: Node;

  constructor(target: Node, thisArg: Node) {
    this.target = target;
    this.thisArg = thisArg;
  }
}

function shouldBeCapturedInTempVariable(node: Node): boolean {
  switch (skipParentheses(node).kind) {
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
      return false;
  }
  return true;
}

/** `_name`, `_get_name`, `_static_private_name`, `_class` or `_member`, for helper variables of `node`. */
function getHelperVariableName(context: EmitContext, node: Node): string {
  const name = getName(node);
  let declarationName: string;
  if (name instanceof Identifier && !context.hasAutoGenerateInfo(name)) declarationName = name.text;
  else if (name instanceof PrivateIdentifier && !context.hasAutoGenerateInfo(name))
    declarationName = name.text.length > 1 ? name.text.slice(1) : '';
  else if (name instanceof StringLiteral && isIdentifierText(name.text)) declarationName = name.text;
  else if (isClassLike(node)) declarationName = 'class';
  else declarationName = 'member';
  if (node.kind === SyntaxKind.GetAccessor) declarationName = 'get_' + declarationName;
  if (node.kind === SyntaxKind.SetAccessor) declarationName = 'set_' + declarationName;
  if (name instanceof PrivateIdentifier) declarationName = 'private_' + declarationName;
  if (isStatic(node)) declarationName = 'static_' + declarationName;
  return '_' + declarationName;
}

function isStaticPrivateOrAutoAccessor(member: Node): boolean {
  return (
    (isPrivateIdentifierClassElementDeclaration(member) || isAutoAccessorPropertyDeclaration(member)) &&
    hasStaticModifier(member)
  );
}

function keepsModifier(filter: ModifierFilter, kind: SyntaxKind): boolean {
  switch (filter) {
    case ModifierFilter.NoDecorators:
      return kind !== SyntaxKind.Decorator;
    case ModifierFilter.NoExport:
      return kind !== SyntaxKind.Decorator && kind !== SyntaxKind.ExportKeyword;
    case ModifierFilter.StaticOnly:
      return kind === SyntaxKind.StaticKeyword;
    case ModifierFilter.AsyncOnly:
      return kind === SyntaxKind.AsyncKeyword;
    case ModifierFilter.NoAccessor:
      return kind !== SyntaxKind.AccessorKeyword;
  }
  return true;
}

function pushVisited(statements: Node[], visited: Node | undefined): boolean {
  if (visited instanceof SyntaxList) appendAll(statements, visited.children);
  else if (visited !== undefined) statements.push(visited);
  return true;
}

function appendAll(target: Node[], nodes: readonly Node[]): boolean {
  for (let i = 0; i < nodes.length; i++) target.push(nodes[i]);
  return true;
}
