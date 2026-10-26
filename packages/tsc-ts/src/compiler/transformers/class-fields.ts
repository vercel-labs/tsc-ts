// Lowers class fields, private names, static blocks and `accessor` fields: initializers move to
// the constructor (useDefineForClassFields: false, or targets before ES2022), private members
// become WeakMaps, WeakSets and hoisted functions, and static `this` and `super` refer to the class.
import {
  ArrayLiteralExpression,
  BinaryExpression,
  Block,
  CallExpression,
  ClassDeclaration,
  ClassExpression,
  ClassStaticBlockDeclaration,
  ComputedPropertyName,
  ConstructorDeclaration,
  ElementAccessExpression,
  ExportAssignment,
  ExpressionStatement,
  ExpressionWithTypeArguments,
  ForStatement,
  GetAccessorDeclaration,
  HeritageClause,
  Identifier,
  ModifierFlags,
  type ModifierList,
  type Node,
  NodeFlags,
  NodeList,
  ObjectLiteralExpression,
  ParameterDeclaration,
  ParenthesizedExpression,
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
  TaggedTemplateExpression,
  TryStatement,
  VariableStatement,
  NewExpression,
  ArrowFunction,
  CatchClause,
  FunctionExpression,
  MethodDeclaration,
  NodeVisitor,
  VoidExpression,
  getBody,
  getParameters,
  getInitializer,
  getMembers,
  getModifiers,
  getName,
  callQuestionDotToken,
  callTypeArguments,
  newCallExpression,
} from '../ast.js';
import { isLeftHandSideExpression } from '../ast-utilities.js';
import {
  getNameOfDeclaration,
  hasStaticModifier,
  isAssignmentExpression,
  isAutoAccessorPropertyDeclaration,
  isClassLike,
  isDestructuringAssignment,
  isMethodOrAccessor,
  isPrivateIdentifierClassElementDeclaration,
  isStatic,
  skipParentheses,
} from '../binder-utilities.js';
import { isIdentifierText } from '../scanner.js';
import type { CompilerOptions } from '../options.js';
import { ScriptTarget, getEmitScriptTarget, getUseDefineForClassFields } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { NameOptions } from '../printer/factory.js';
import { isModifier, isPrologueDirective, isStatement, nodeIsSynthesized } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  classHasClassThisAssignment,
  findSuperStatementIndexPath,
  getClassMembers,
  isClassThisAssignmentBlock,
} from './class-utilities.js';
import type { EmitResolver } from './emit-resolver.js';
import {
  AnonymousFunctionFilter,
  classHasExplicitlyAssignedName,
  isClassNamedEvaluationHelperBlock,
  isNamedEvaluation,
  transformNamedEvaluation,
} from './named-evaluation.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import {
  OuterExpressionKinds,
  hasDecorators,
  hasSyntacticModifier,
  isParameterPropertyDeclaration,
  isSameNode,
  skipOuterExpressions,
} from './utilities.js';
import { VisitorBase } from './visitor-base.js';

const enum ClassFacts {
  None = 0,
  ClassWasDecorated = 1 << 0,
  NeedsClassConstructorReference = 1 << 1,
  NeedsClassSuperReference = 1 << 2,
  NeedsSubstitutionForThisInClassStaticField = 1 << 3,
  WillHoistInitializersToConstructor = 1 << 4,
}

const enum PrivateKind {
  Field,
  Method,
  Accessor,
  /** Declared but left as a private name. */
  Untransformed,
}

/** How a private name is transformed. */
class PrivateIdentifierInfo {
  kind: PrivateKind;
  /** The WeakMap of an instance field, the WeakSet of instance methods and accessors, or the class for statics. */
  brandCheckIdentifier: Identifier | undefined;
  isStatic: boolean;
  /** False for reserved names such as `#constructor` and duplicates. */
  isValid: boolean;
  /** The `{ value }` holder of a static field. */
  variableName: Identifier | undefined;
  methodName: Identifier | undefined;
  getterName: Identifier | undefined;
  setterName: Identifier | undefined;

  constructor(kind: PrivateKind, brandCheckIdentifier: Identifier | undefined, isStatic: boolean, isValid: boolean) {
    this.kind = kind;
    this.brandCheckIdentifier = brandCheckIdentifier;
    this.isStatic = isStatic;
    this.isValid = isValid;
    this.variableName = undefined;
    this.methodName = undefined;
    this.getterName = undefined;
    this.setterName = undefined;
  }
}

/** The private names of a class, by text, and generated private names, by the node they're generated for. */
class PrivateEnvironment {
  /** Prefixes generated variable names. */
  className: Identifier | undefined;
  /** Brand checks instances for private methods and accessors. */
  weakSetName: Identifier | undefined;
  readonly members: Map<string, PrivateIdentifierInfo>;
  readonly generated: Map<Node, PrivateIdentifierInfo>;

  constructor() {
    this.className = undefined;
    this.weakSetName = undefined;
    this.members = new Map<string, PrivateIdentifierInfo>();
    this.generated = new Map<Node, PrivateIdentifierInfo>();
  }
}

class ClassData {
  facts: ClassFacts;
  /** Brand checks static members and replaces `this` in static initializers. */
  classConstructor: Identifier | undefined;
  classThis: Identifier | undefined;
  /** Replaces `super` in static initializers. */
  superClassReference: Identifier | undefined;

  constructor() {
    this.facts = ClassFacts.None;
    this.classConstructor = undefined;
    this.classThis = undefined;
    this.superClassReference = undefined;
  }
}

class ClassEnvironment {
  readonly previous: ClassEnvironment | undefined;
  data: ClassData | undefined;
  privateEnv: PrivateEnvironment | undefined;

  constructor(previous: ClassEnvironment | undefined) {
    this.previous = previous;
    this.data = undefined;
    this.privateEnv = undefined;
  }
}

class ClassMembers {
  readonly members: NodeList;
  /** An assignment to evaluate before the class, from computed names using `this` or `super`. */
  readonly prologue: Node | undefined;

  constructor(members: NodeList, prologue: Node | undefined) {
    this.members = members;
    this.prologue = prologue;
  }
}

/** A receiver read twice: `read`, assigned by `initialize` first when it had to be cached. */
class CopiableReceiver {
  readonly read: Node;
  readonly initialize: Node | undefined;

  constructor(read: Node, initialize: Node | undefined) {
    this.read = read;
    this.initialize = initialize;
  }
}

class CallBinding {
  readonly thisArg: Node;
  readonly target: Node;

  constructor(thisArg: Node, target: Node) {
    this.thisArg = thisArg;
    this.target = target;
  }
}

const enum VisitMode {
  Modifier,
  Discarded,
  HeritageClause,
  AssignmentTarget,
  ClassElement,
  AccessorFieldResult,
  ArrayAssignmentElement,
  ObjectAssignmentElement,
  Substitution,
}

/** Visits children in one of the transform's modes. */
class ModeVisitor extends VisitorBase {
  readonly owner: ClassFieldsTransformer;
  readonly mode: VisitMode;

  constructor(owner: ClassFieldsTransformer, mode: VisitMode) {
    super(owner.context);
    this.owner = owner;
    this.mode = mode;
  }

  visit(node: Node): Node | undefined {
    return this.owner.visitInMode(this.mode, node);
  }
}

const accessorStorageSuffix = '_accessor_storage';

export class ClassFieldsTransformer extends Transformer {
  readonly options: CompilerOptions;
  readonly facts: SyntaxFacts;
  readonly resolver: EmitResolver;
  private readonly legacyDecorators: boolean;
  private readonly useDefineForClassFields: boolean;
  private readonly shouldTransformInitializersUsingSet: boolean;
  private readonly shouldTransformInitializersUsingDefine: boolean;
  private readonly shouldTransformInitializers: boolean;
  private readonly shouldTransformPrivateElementsOrClassStaticBlocks: boolean;
  private readonly shouldTransformAutoAccessors: boolean;
  /** Static initializers move out of the class body, so their `this` and `super` must name the class. */
  private readonly shouldTransformThisInStaticInitializers: boolean;
  private shouldTransformPrivateStaticElementsInFile: boolean;
  /** Computed name expressions from elided names, to inline at the next execution site. */
  private pendingExpressions: Node[];
  /** Statements to emit after the current variable statement, for decorated classes. */
  private pendingStatements: Node[];
  private lexicalEnvironment: ClassEnvironment | undefined;
  private currentClassContainer: Node | undefined;
  private currentClassElement: Node | undefined;
  /** Class declarations to aliases replacing references to the class in its static initializers. */
  private readonly classAliases: Map<Node, Identifier>;
  private readonly enclosingClassDeclarations: Set<Node>;
  private inIterationStatement: boolean;
  /** Computed property names evaluate in the scope outside the class. */
  private insideComputedPropertyName: boolean;
  private parentNode: Node | undefined;
  private currentNode: Node | undefined;
  private readonly modifierMode: ModeVisitor;
  private readonly discarded: ModeVisitor;
  private readonly heritageMode: ModeVisitor;
  private readonly assignmentTargetMode: ModeVisitor;
  private readonly classElementMode: ModeVisitor;
  private readonly accessorResultMode: ModeVisitor;
  private readonly arrayElementMode: ModeVisitor;
  private readonly objectElementMode: ModeVisitor;
  private readonly substitutionMode: ModeVisitor;
  /** Anonymous classes that named evaluation must name here. */
  private readonly classesNeedingNames: ClassesNeedingNames;

  constructor(context: EmitContext, options: CompilerOptions, facts: SyntaxFacts, resolver: EmitResolver) {
    super(context);
    this.options = options;
    this.facts = facts;
    this.resolver = resolver;
    const target = getEmitScriptTarget(options);
    const useDefine = getUseDefineForClassFields(options);
    this.legacyDecorators = options.experimentalDecorators === true;
    this.useDefineForClassFields = useDefine;
    this.shouldTransformInitializersUsingSet = !useDefine;
    this.shouldTransformInitializersUsingDefine = useDefine && target < ScriptTarget.ES2022;
    this.shouldTransformInitializers =
      this.shouldTransformInitializersUsingSet || this.shouldTransformInitializersUsingDefine;
    this.shouldTransformPrivateElementsOrClassStaticBlocks = target < ScriptTarget.ES2022;
    this.shouldTransformAutoAccessors = target < ScriptTarget.ESNext;
    this.shouldTransformThisInStaticInitializers = target < ScriptTarget.ES2022;
    this.shouldTransformPrivateStaticElementsInFile = false;
    this.pendingExpressions = [];
    this.pendingStatements = [];
    this.lexicalEnvironment = undefined;
    this.currentClassContainer = undefined;
    this.currentClassElement = undefined;
    this.classAliases = new Map<Node, Identifier>();
    this.enclosingClassDeclarations = new Set<Node>();
    this.inIterationStatement = false;
    this.insideComputedPropertyName = false;
    this.parentNode = undefined;
    this.currentNode = undefined;
    this.modifierMode = new ModeVisitor(this, VisitMode.Modifier);
    this.discarded = new ModeVisitor(this, VisitMode.Discarded);
    this.heritageMode = new ModeVisitor(this, VisitMode.HeritageClause);
    this.assignmentTargetMode = new ModeVisitor(this, VisitMode.AssignmentTarget);
    this.classElementMode = new ModeVisitor(this, VisitMode.ClassElement);
    this.accessorResultMode = new ModeVisitor(this, VisitMode.AccessorFieldResult);
    this.arrayElementMode = new ModeVisitor(this, VisitMode.ArrayAssignmentElement);
    this.objectElementMode = new ModeVisitor(this, VisitMode.ObjectAssignmentElement);
    this.substitutionMode = new ModeVisitor(this, VisitMode.Substitution);
    this.classesNeedingNames = new ClassesNeedingNames(this);
  }

  visitInMode(mode: VisitMode, node: Node): Node | undefined {
    switch (mode) {
      case VisitMode.Modifier:
        return this.visitModifier(node);
      case VisitMode.Discarded:
        return this.visitDiscardedValue(node);
      case VisitMode.HeritageClause:
        return this.visitHeritageClause(node);
      case VisitMode.AssignmentTarget:
        if (node instanceof ObjectLiteralExpression || node instanceof ArrayLiteralExpression)
          return this.visitAssignmentPattern(node);
        return this.visit(node);
      case VisitMode.ClassElement:
        return this.visitClassElement(node);
      case VisitMode.AccessorFieldResult:
        return this.visitAccessorFieldResult(node);
      case VisitMode.ArrayAssignmentElement:
        return this.visitArrayAssignmentElement(node);
      case VisitMode.ObjectAssignmentElement:
        return this.visitObjectAssignmentElement(node);
      case VisitMode.Substitution:
        return this.visitForSubstitution(node);
    }
    return node;
  }

  /** Whether an auto-accessor, a `#x in` check or a private access needs WeakMaps and WeakSets. */
  private requiresBlockScopedVar(): boolean {
    const container = this.currentClassContainer;
    return this.inIterationStatement && container !== undefined && container.kind === SyntaxKind.ClassExpression;
  }

  /** Whether a class expression's temporary is block scoped: it's in a loop and has an instance field with a computed name. */
  private classExpressionNeedsBlockScopedTemp(): boolean {
    if (!this.requiresBlockScopedVar()) return false;
    const members = membersOf(this.currentClassContainer!);
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      if (
        member instanceof PropertyDeclaration &&
        !hasStaticModifier(member) &&
        member.name instanceof ComputedPropertyName
      )
        return true;
    }
    return false;
  }

  private addHoisted(name: Identifier, blockScoped: boolean): Identifier {
    if (blockScoped) this.context.addLexicalDeclaration(name);
    else this.context.addVariableDeclaration(name);
    return name;
  }

  private visitSourceFile(node: SourceFile): Node {
    if (node.isDeclarationFile) return node;
    const context = this.context;
    this.lexicalEnvironment = undefined;
    this.shouldTransformPrivateStaticElementsInFile =
      (context.getEmitFlags(node) & EmitFlags.TransformPrivateStaticElements) !== 0;
    this.classAliases.clear();
    this.enclosingClassDeclarations.clear();
    const visited = this.visitEachChild(node);
    const helpers = context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) context.addEmitHelper(visited, helpers[i]);
    this.classAliases.clear();
    this.enclosingClassDeclarations.clear();
    return visited;
  }

  private visitModifier(node: Node): Node | undefined {
    if (node.kind === SyntaxKind.AccessorKeyword)
      return this.shouldTransformAutoAccessorsInCurrentClass() ? undefined : node;
    return isModifier(node) ? node : undefined;
  }

  /** Substitutes class aliases in subtrees with nothing else to transform, leaving property names alone. */
  private visitForSubstitution(node: Node): Node | undefined {
    if (node instanceof Identifier) return this.visitIdentifier(node as Identifier);
    if (node instanceof PropertyAccessExpression && node.name instanceof Identifier)
      return this.visitPropertyAccessExpressionForSubstitution(node, this.substitutionMode);
    return this.substitutionMode.visitEachChild(node);
  }

  visit(node: Node): Node | undefined {
    const grandparent = this.parentNode;
    this.parentNode = this.currentNode;
    this.currentNode = node;
    const result = this.visitWorker(node);
    this.currentNode = this.parentNode;
    this.parentNode = grandparent;
    return result;
  }

  private visitWorker(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsClassFields | SubtreeFacts.ContainsLexicalThisOrSuper)) {
      if (this.currentClassContainer !== undefined && this.classAliases.size > 0)
        return this.visitForSubstitution(node);
      return node;
    }
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        return this.visitSourceFile(node as SourceFile);
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        return this.visitClassLike(node);
      case SyntaxKind.ClassStaticBlockDeclaration:
      case SyntaxKind.PropertyDeclaration:
        throw new Error('Class elements are visited in class element mode');
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.Parameter:
      case SyntaxKind.BindingElement:
        return this.visitEachChild(this.transformNamedEvaluationIfNeeded(node, ''));
      case SyntaxKind.VariableStatement:
        return this.visitVariableStatement(node as VariableStatement);
      case SyntaxKind.ExportAssignment:
        return this.visitExportAssignment(node as ExportAssignment);
      case SyntaxKind.PrivateIdentifier:
        return this.visitPrivateIdentifier(node);
      case SyntaxKind.PropertyAccessExpression:
        return this.visitPropertyAccessExpression(node as PropertyAccessExpression);
      case SyntaxKind.ElementAccessExpression:
        return this.visitElementAccessExpression(node as ElementAccessExpression);
      case SyntaxKind.PrefixUnaryExpression:
      case SyntaxKind.PostfixUnaryExpression:
        return this.visitPreOrPostfixUnaryExpression(node, false);
      case SyntaxKind.BinaryExpression:
        return this.visitBinaryExpression(node as BinaryExpression, false);
      case SyntaxKind.ParenthesizedExpression:
        return this.factory.updateParenthesizedExpression(
          node as ParenthesizedExpression,
          this.visitNode((node as ParenthesizedExpression).expression)!,
        );
      case SyntaxKind.CallExpression:
        return this.visitCallExpression(node as CallExpression);
      case SyntaxKind.ExpressionStatement:
        return this.visitExpressionStatement(node as ExpressionStatement);
      case SyntaxKind.TaggedTemplateExpression:
        return this.visitTaggedTemplateExpression(node as TaggedTemplateExpression);
      case SyntaxKind.ForStatement:
        return this.visitForStatement(node as ForStatement);
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.WhileStatement:
        return this.visitInIteration(node, true);
      case SyntaxKind.ThisKeyword:
        return this.visitThisExpression(node);
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
        return this.visitFunctionExpressionOrDeclaration(node);
      case SyntaxKind.Constructor:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        return this.visitInClassElement(node);
    }
    return this.visitEachChild(node);
  }

  private visitInIteration(node: Node, inIteration: boolean): Node {
    const saved = this.inIterationStatement;
    this.inIterationStatement = inIteration;
    const result = this.visitEachChild(node);
    this.inIterationStatement = saved;
    return result;
  }

  /** Visits the children of a function-like class member with it as the current class element. */
  private visitInClassElement(node: Node): Node {
    const savedIteration = this.inIterationStatement;
    const savedElement = this.currentClassElement;
    this.inIterationStatement = false;
    this.currentClassElement = node;
    const result = this.visitEachChild(node);
    this.currentClassElement = savedElement;
    this.inIterationStatement = savedIteration;
    return result;
  }

  /**
   * Functions get their own `this`, unless synthesized from a static member of the current class,
   * as the ES decorators transform does for static private auto-accessors.
   */
  private visitFunctionExpressionOrDeclaration(node: Node): Node {
    const savedIteration = this.inIterationStatement;
    this.inIterationStatement = false;
    let keepElement = false;
    const container = this.currentClassContainer;
    if (this.currentClassElement !== undefined && container !== undefined) {
      const original = this.context.mostOriginal(node);
      if (original !== node) {
        const members = membersOf(container);
        for (let i = 0; i < members.length; i++)
          if (this.context.mostOriginal(members[i]) === original && isStatic(members[i])) keepElement = true;
      }
    }
    const savedElement = this.currentClassElement;
    if (!keepElement) this.currentClassElement = undefined;
    const result = this.visitEachChild(node);
    this.currentClassElement = savedElement;
    this.inIterationStatement = savedIteration;
    return result;
  }

  private visitDiscardedValue(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.PrefixUnaryExpression:
      case SyntaxKind.PostfixUnaryExpression:
        return this.visitPreOrPostfixUnaryExpression(node, true);
      case SyntaxKind.BinaryExpression:
        return this.visitBinaryExpression(node as BinaryExpression, true);
      case SyntaxKind.ParenthesizedExpression:
        return this.factory.updateParenthesizedExpression(
          node as ParenthesizedExpression,
          this.discarded.visitNode((node as ParenthesizedExpression).expression)!,
        );
    }
    return this.visit(node);
  }

  private visitHeritageClause(node: Node): Node | undefined {
    if (node instanceof HeritageClause) return this.heritageMode.visitEachChild(node);
    if (node instanceof ExpressionWithTypeArguments)
      return this.visitExpressionWithTypeArgumentsInHeritageClause(node as ExpressionWithTypeArguments);
    return this.visit(node);
  }

  private visitClassElement(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.Constructor: {
        const saved = this.currentClassElement;
        this.currentClassElement = node;
        const container = this.currentClassContainer;
        const result =
          container !== undefined
            ? this.transformConstructor(node as ConstructorDeclaration, container)
            : this.visitEachChild(node);
        this.currentClassElement = saved;
        return result;
      }
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.MethodDeclaration: {
        const saved = this.currentClassElement;
        this.currentClassElement = node;
        const result = this.visitMethodOrAccessorDeclaration(node);
        this.currentClassElement = saved;
        return result;
      }
      case SyntaxKind.PropertyDeclaration: {
        const saved = this.currentClassElement;
        this.currentClassElement = node;
        const result = this.visitPropertyDeclaration(node as PropertyDeclaration);
        this.currentClassElement = saved;
        return result;
      }
      case SyntaxKind.ClassStaticBlockDeclaration: {
        const saved = this.currentClassElement;
        this.currentClassElement = node;
        const result = this.shouldTransformPrivateElementsOrClassStaticBlocks ? undefined : this.visitEachChild(node);
        this.currentClassElement = saved;
        return result;
      }
      case SyntaxKind.ComputedPropertyName:
        return this.visitComputedPropertyName(node as ComputedPropertyName);
      case SyntaxKind.SemicolonClassElement:
        return node;
    }
    if (isModifier(node) || node.kind === SyntaxKind.Decorator) return this.visitModifier(node);
    return this.visit(node);
  }

  private visitPropertyName(name: Node): Node {
    if (name instanceof ComputedPropertyName) return this.visitComputedPropertyName(name);
    return this.visitNode(name)!;
  }

  /** Visits the field and accessors an auto-accessor became. */
  private visitAccessorFieldResult(node: Node): Node | undefined {
    if (node instanceof PropertyDeclaration) return this.transformFieldInitializer(node as PropertyDeclaration);
    if (node instanceof GetAccessorDeclaration || node instanceof SetAccessorDeclaration)
      return this.visitClassElement(node);
    throw new Error('Expected a property declaration or accessor');
  }

  /** A reference to a class from its static initializers, replaced with the class alias. */
  private visitIdentifier(node: Identifier): Node {
    const declaration = this.resolver.getReferencedValueDeclaration(this.mostOriginalIdentifier(node));
    if (declaration === undefined) return node;
    const alias = this.classAliases.get(declaration);
    if (alias === undefined || !this.enclosingClassDeclarations.has(declaration)) return node;
    const clone = this.factory.cloneIdentifier(alias);
    this.context.setSourceMapRange(clone, node.pos, node.end);
    this.context.setCommentRange(clone, node.pos, node.end);
    return clone;
  }

  private mostOriginalIdentifier(node: Identifier): Identifier {
    const original = this.context.mostOriginal(node);
    return original instanceof Identifier ? (original as Identifier) : node;
  }

  /** An undeclared private name becomes an empty identifier, except as a statement such as `#;`. */
  private visitPrivateIdentifier(node: Node): Node {
    if (!this.shouldTransformPrivateElementsOrClassStaticBlocks) return node;
    const parent = this.parentNode;
    if (parent !== undefined && isStatement(parent)) return node;
    const result = this.factory.createIdentifier('');
    this.context.setOriginal(result, node);
    return result;
  }

  /** `#x in obj` */
  private transformPrivateIdentifierInInExpression(node: BinaryExpression): Node {
    const info = this.accessPrivateIdentifier(node.left);
    if (info === undefined) return this.visitEachChild(node);
    const receiver = this.visitNode(node.right)!;
    const result = this.factory.createClassPrivateFieldInHelper(info.brandCheckIdentifier!, receiver);
    this.context.setOriginal(result, node);
    return result;
  }

  /** An anonymous class whose static members move out of its body, so it can't name itself. */
  isAnonymousClassNeedingAssignedName(node: Node): boolean {
    if (!(node instanceof ClassExpression) || node.name !== undefined) return false;
    const statics = staticPropertiesAndClassStaticBlocks(node);
    for (let i = 0; i < statics.length; i++)
      if (isClassNamedEvaluationHelperBlock(this.context, statics[i])) return false;
    return this.hasTransformableStatics(node, statics);
  }

  private hasTransformableStatics(node: Node, statics: Node[]): boolean {
    if (!this.shouldTransformPrivateElementsOrClassStaticBlocks && !this.hasTransformPrivateStaticElementsFlag(node))
      return false;
    for (let i = 0; i < statics.length; i++) {
      const member = statics[i];
      if (
        member.kind === SyntaxKind.ClassStaticBlockDeclaration ||
        isPrivateIdentifierClassElementDeclaration(member) ||
        (this.shouldTransformInitializers && isInitializedProperty(member))
      )
        return true;
    }
    return false;
  }

  /** `node`, naming an anonymous class whose static members move out of its body. */
  private transformNamedEvaluationIfNeeded(node: Node, assignedName: string): Node {
    if (!isNamedEvaluation(this.context, node, this.classesNeedingNames)) return node;
    return transformNamedEvaluation(this.context, node, assignedName !== '', assignedName);
  }

  private visitVariableStatement(node: VariableStatement): Node {
    const saved = this.pendingStatements;
    this.pendingStatements = [];
    const visited = this.visitEachChild(node);
    const pending = this.pendingStatements;
    this.pendingStatements = saved;
    if (pending.length === 0) return visited;
    return this.factory.createSyntaxList([visited].concat(pending));
  }

  private visitExportAssignment(node: ExportAssignment): Node {
    let updated: Node = node;
    if (isNamedEvaluation(this.context, node, this.classesNeedingNames))
      updated = transformNamedEvaluation(this.context, node, true, node.isExportEquals ? '' : 'default');
    return this.visitEachChild(updated);
  }

  private injectPendingExpressions(expression: Node): Node {
    if (this.pendingExpressions.length === 0) return expression;
    const factory = this.factory;
    let result: Node;
    if (expression instanceof ParenthesizedExpression) {
      this.pendingExpressions.push(expression.expression);
      result = factory.updateParenthesizedExpression(
        expression as ParenthesizedExpression,
        factory.inlineExpressions(this.pendingExpressions)!,
      ) as Node;
    } else {
      this.pendingExpressions.push(expression);
      result = factory.inlineExpressions(this.pendingExpressions)!;
    }
    this.pendingExpressions = [];
    return result;
  }

  /** Visits a computed name's expression in the lexical environment outside the class. */
  private visitInOuterEnvironment(expression: Node): Node {
    const savedEnvironment = this.lexicalEnvironment;
    const savedInside = this.insideComputedPropertyName;
    this.insideComputedPropertyName = true;
    if (savedEnvironment !== undefined && savedEnvironment.previous !== undefined)
      this.lexicalEnvironment = savedEnvironment.previous;
    const visited = this.visitNode(expression)!;
    this.lexicalEnvironment = savedEnvironment;
    this.insideComputedPropertyName = savedInside;
    return visited;
  }

  private visitComputedPropertyName(node: ComputedPropertyName): Node {
    const expression = this.visitInOuterEnvironment(node.expression);
    return this.factory.updateComputedPropertyName(node, this.injectPendingExpressions(expression));
  }

  private shouldTransformClassElementToWeakMap(node: Node): boolean {
    return (
      this.shouldTransformPrivateElementsOrClassStaticBlocks || this.shouldAlwaysTransformPrivateStaticElements(node)
    );
  }

  private shouldAlwaysTransformPrivateStaticElements(node: Node): boolean {
    return hasStaticModifier(node) && this.hasTransformPrivateStaticElementsFlag(node);
  }

  private hasTransformPrivateStaticElementsFlag(node: Node): boolean {
    return (this.context.getEmitFlags(node) & EmitFlags.TransformPrivateStaticElements) !== 0;
  }

  /** A private method or accessor becomes a hoisted function; the member is removed. */
  private visitMethodOrAccessorDeclaration(node: Node): Node | undefined {
    if (!isPrivateIdentifierClassElementDeclaration(node) || !this.shouldTransformClassElementToWeakMap(node))
      return this.classElementMode.visitEachChild(node);
    // The member's own class declares it; an untransformed or duplicate name leaves the member as written.
    const info = this.getPrivateIdentifier(this.getPrivateEnvironment(), getName(node)!);
    if (info === undefined) throw new Error('Undeclared private name for property declaration.');
    if (info.kind === PrivateKind.Untransformed || !info.isValid) return node;
    const functionName = this.getHoistedFunctionName(node, info);
    if (functionName !== undefined) {
      const factory = this.factory;
      const modifiers = this.extractModifiers(getModifiers(node), ~(ModifierFlags.Static | ModifierFlags.Accessor));
      this.context.startVariableEnvironment();
      const saved = this.inIterationStatement;
      this.inIterationStatement = false;
      const body = this.visitFunctionBody(getBody(node));
      const parameters = this.visitNodes(parametersOf(node))!;
      this.inIterationStatement = saved;
      const asterisk = node instanceof MethodDeclaration ? node.asteriskToken : undefined;
      const fn = factory.created(
        new FunctionExpression(
          modifiers,
          asterisk,
          functionName,
          undefined,
          parameters,
          undefined,
          undefined,
          body as Block,
        ),
      );
      this.pendingExpressions.push(factory.createAssignment(functionName, fn));
    }
    return undefined;
  }

  private getHoistedFunctionName(node: Node, info: PrivateIdentifierInfo): Identifier | undefined {
    if (info.kind === PrivateKind.Method) return info.methodName;
    if (info.kind === PrivateKind.Accessor) {
      if (node.kind === SyntaxKind.GetAccessor) return info.getterName;
      if (node.kind === SyntaxKind.SetAccessor) return info.setterName;
    }
    return undefined;
  }

  /** `this` in a static initializer of the current class: its classThis or constructor alias. */
  private tryGetClassThis(): Node | undefined {
    const classThis = this.tryGetClassThisNoContainer();
    if (classThis !== undefined) return classThis;
    const container = this.currentClassContainer;
    return container !== undefined ? getName(container) : undefined;
  }

  private tryGetClassThisNoContainer(): Identifier | undefined {
    const data = this.getClassData();
    return data.classThis !== undefined ? data.classThis : data.classConstructor;
  }

  /** `accessor x = 1` becomes `#x_accessor_storage = 1`, `get x()` and `set x(value)`. */
  private transformAutoAccessor(node: PropertyDeclaration): Node {
    const factory = this.factory;
    const context = this.context;
    const commentPos = context.commentPos(node);
    const commentEnd = context.commentEnd(node);
    const sourceMapPos = context.sourceMapPos(node);
    const sourceMapEnd = context.sourceMapEnd(node);
    // The getter and setter share one evaluation of a computed name.
    const name = node.name;
    let getterName: Node = name;
    let setterName: Node = name;
    if (name instanceof ComputedPropertyName && !isSimpleInlineableExpression(name.expression)) {
      const cacheAssignment = findComputedPropertyNameCacheAssignment(name);
      if (cacheAssignment !== undefined) {
        getterName = factory.updateComputedPropertyName(name, this.visitNode(name.expression)!);
        setterName = factory.updateComputedPropertyName(name, cacheAssignment.left);
      } else {
        const temp = factory.createTempVariable(0);
        context.setSourceMapRange(temp, name.expression.pos, name.expression.end);
        context.addVariableDeclaration(temp);
        const assignment = factory.createAssignment(temp, this.visitNode(name.expression)!);
        context.setSourceMapRange(assignment, name.expression.pos, name.expression.end);
        getterName = factory.updateComputedPropertyName(name, assignment);
        setterName = factory.updateComputedPropertyName(name, temp);
      }
    }
    const modifiers = this.modifierMode.visitModifiers(node.modifiers);
    const backingField = factory.updatePropertyDeclaration(
      node,
      modifiers,
      factory.createGeneratedPrivateNameForNode(node.name, '', accessorStorageSuffix),
      undefined,
      undefined,
      node.initializer,
    );
    context.setOriginal(backingField, node);
    context.addEmitFlags(backingField, EmitFlags.NoComments);
    context.setSourceMapRange(backingField, sourceMapPos, sourceMapEnd);
    let receiver: Node | undefined = undefined;
    if (isStatic(node)) receiver = this.tryGetClassThis();
    if (receiver === undefined) receiver = factory.createThisExpression();
    const getter = this.createAccessorPropertyGetRedirector(node, modifiers, getterName, receiver);
    context.setOriginal(getter, node);
    context.setCommentRange(getter, commentPos, commentEnd);
    context.setSourceMapRange(getter, sourceMapPos, sourceMapEnd);
    // Fresh modifiers, so comments aren't duplicated.
    const setterModifiers =
      modifiers !== undefined ? factory.createModifiersFromFlags(modifiers.modifierFlags) : undefined;
    const setter = this.createAccessorPropertySetRedirector(node, setterModifiers, setterName, receiver);
    context.setOriginal(setter, node);
    context.addEmitFlags(setter, EmitFlags.NoComments);
    context.setSourceMapRange(setter, sourceMapPos, sourceMapEnd);
    return factory.createSyntaxList(
      this.accessorResultMode.visitArray([backingField as PropertyDeclaration, getter, setter]),
    );
  }

  private transformPrivateFieldInitializer(node: PropertyDeclaration): Node | undefined {
    const factory = this.factory;
    if (this.shouldTransformClassElementToWeakMap(node)) {
      // Fields become WeakMaps: the declaration goes.
      const info = this.getPrivateIdentifier(this.getPrivateEnvironment(), node.name);
      if (info === undefined) throw new Error('Undeclared private name for property declaration.');
      if (info.kind === PrivateKind.Untransformed || !info.isValid) return node;
      // A static field of a class whose static blocks stay becomes a static block.
      if (info.isStatic && !this.shouldTransformPrivateElementsOrClassStaticBlocks) {
        const statement = this.transformPropertyOrClassStaticBlock(node, factory.createThisExpression());
        if (statement !== undefined)
          return factory.created(new ClassStaticBlockDeclaration(undefined, factory.createBlock([statement], true)));
      }
      return undefined;
    }
    if (
      this.shouldTransformInitializersUsingSet &&
      !hasStaticModifier(node) &&
      (this.currentClassFacts() & ClassFacts.WillHoistInitializersToConstructor) !== 0
    )
      return factory.updatePropertyDeclaration(
        node,
        this.visitModifiers(node.modifiers),
        node.name,
        undefined,
        undefined,
        undefined,
      );
    const named = this.transformNamedEvaluationIfNeeded(node, '') as PropertyDeclaration;
    return factory.updatePropertyDeclaration(
      named,
      this.modifierMode.visitModifiers(named.modifiers),
      this.visitPropertyName(named.name),
      undefined,
      undefined,
      this.visitNode(named.initializer),
    );
  }

  private transformPublicFieldInitializer(node: PropertyDeclaration): Node | undefined {
    const factory = this.factory;
    if (this.shouldTransformInitializers && !isAutoAccessorPropertyDeclaration(node)) {
      // The field goes; its initializer moves to the constructor. A computed name is still evaluated.
      const expression = this.getPropertyNameExpressionIfNeeded(
        node.name,
        node.initializer !== undefined || this.useDefineForClassFields,
      );
      if (expression !== undefined) flattenCommaList(expression, this.pendingExpressions);
      // With static blocks kept, a static initializer runs in a static block, where `this` is the class.
      if (isStatic(node) && !this.shouldTransformPrivateElementsOrClassStaticBlocks) {
        const statement = this.transformPropertyOrClassStaticBlock(node, factory.createThisExpression());
        if (statement !== undefined) {
          const block = factory.created(
            new ClassStaticBlockDeclaration(undefined, factory.createBlock([statement], false)),
          );
          this.context.setOriginal(block, node);
          this.context.setCommentRange(block, node.pos, node.end);
          this.context.addEmitFlags(statement, EmitFlags.NoComments);
          return block;
        }
      }
      return undefined;
    }
    return factory.updatePropertyDeclaration(
      node,
      this.modifierMode.visitModifiers(node.modifiers),
      this.visitPropertyName(node.name),
      undefined,
      undefined,
      this.visitNode(node.initializer),
    );
  }

  private transformFieldInitializer(node: PropertyDeclaration): Node | undefined {
    if (isPrivateIdentifierClassElementDeclaration(node)) return this.transformPrivateFieldInitializer(node);
    return this.transformPublicFieldInitializer(node);
  }

  private shouldTransformAutoAccessorsInCurrentClass(): boolean {
    if (this.shouldTransformAutoAccessors) return true;
    // At ESNext with useDefineForClassFields: false, only when initializers move to the constructor.
    return (this.currentClassFacts() & ClassFacts.WillHoistInitializersToConstructor) !== 0;
  }

  private currentClassFacts(): ClassFacts {
    const environment = this.lexicalEnvironment;
    return environment !== undefined && environment.data !== undefined ? environment.data.facts : ClassFacts.None;
  }

  private visitPropertyDeclaration(node: PropertyDeclaration): Node | undefined {
    if (
      isAutoAccessorPropertyDeclaration(node) &&
      (this.shouldTransformAutoAccessorsInCurrentClass() || this.shouldAlwaysTransformPrivateStaticElements(node))
    )
      return this.transformAutoAccessor(node);
    return this.transformFieldInitializer(node);
  }

  private createPrivateIdentifierAccess(info: PrivateIdentifierInfo, receiver: Node): Node {
    return this.createPrivateIdentifierAccessHelper(info, this.visitNode(receiver)!);
  }

  private createPrivateIdentifierAccessHelper(info: PrivateIdentifierInfo, receiver: Node): Node {
    this.context.setCommentRange(receiver, -1, receiver.end);
    const state = info.brandCheckIdentifier!;
    switch (info.kind) {
      case PrivateKind.Accessor:
        return this.factory.createClassPrivateFieldGetHelper(receiver, state, 'a', info.getterName);
      case PrivateKind.Method:
        return this.factory.createClassPrivateFieldGetHelper(receiver, state, 'm', info.methodName);
      case PrivateKind.Field:
        return this.factory.createClassPrivateFieldGetHelper(
          receiver,
          state,
          'f',
          info.isStatic ? info.variableName : undefined,
        );
    }
    throw new Error('Access helpers should not be created for untransformed private elements');
  }

  /** `super.x` in a static initializer, with the class and its base available. */
  private staticSuperData(node: Node): ClassData | undefined {
    const element = this.currentClassElement;
    const environment = this.lexicalEnvironment;
    if (
      !this.shouldTransformThisInStaticInitializers ||
      element === undefined ||
      !isSuperProperty(node) ||
      !isStaticPropertyDeclarationOrClassStaticBlock(element) ||
      environment === undefined
    )
      return undefined;
    return environment.data;
  }

  private visitPropertyAccessExpression(node: PropertyAccessExpression): Node {
    const factory = this.factory;
    if (node.name instanceof PrivateIdentifier) {
      const info = this.accessPrivateIdentifier(node.name);
      if (info !== undefined) {
        const result = this.createPrivateIdentifierAccess(info, node.expression);
        this.context.setOriginal(result, node);
        result.pos = node.pos;
        result.end = node.end;
        return result;
      }
    }
    const data = node.name instanceof Identifier ? this.staticSuperData(node) : undefined;
    if (data !== undefined) {
      if ((data.facts & ClassFacts.ClassWasDecorated) !== 0) return this.visitInvalidSuperProperty(node);
      if (data.classConstructor !== undefined && data.superClassReference !== undefined) {
        // `super.x` becomes `Reflect.get(_baseTemp, "x", _classTemp)`.
        const superProperty = factory.createReflectGetCall(
          data.superClassReference,
          factory.createStringLiteralFromNode(node.name),
          data.classConstructor,
        );
        this.context.setOriginal(superProperty, node.expression);
        superProperty.pos = node.expression.pos;
        superProperty.end = node.expression.end;
        return superProperty;
      }
    }
    // Property names are not references and are never substituted.
    if (node.name instanceof Identifier) return this.visitPropertyAccessExpressionForSubstitution(node, this);
    return this.visitEachChild(node);
  }

  /** Visits only the expression of a property access, with `visitor`, so that its name is never substituted. */
  private visitPropertyAccessExpressionForSubstitution(node: PropertyAccessExpression, visitor: VisitorBase): Node {
    const expression = visitor.visitNode(node.expression)!;
    if (expression === node.expression) return node;
    return this.factory.updatePropertyAccessExpression(node, expression, node.questionDotToken, node.name, node.flags);
  }

  private visitElementAccessExpression(node: ElementAccessExpression): Node {
    const data = this.staticSuperData(node);
    if (data !== undefined) {
      if ((data.facts & ClassFacts.ClassWasDecorated) !== 0) return this.visitInvalidSuperProperty(node);
      if (data.classConstructor !== undefined && data.superClassReference !== undefined) {
        // `super[x]` becomes `Reflect.get(_baseTemp, x, _classTemp)`.
        const superProperty = this.factory.createReflectGetCall(
          data.superClassReference,
          this.visitNode(node.argumentExpression)!,
          data.classConstructor,
        );
        this.context.setOriginal(superProperty, node.expression);
        superProperty.pos = node.expression.pos;
        superProperty.end = node.expression.end;
        return superProperty;
      }
    }
    return this.visitEachChild(node);
  }

  private visitPreOrPostfixUnaryExpression(node: Node, discarded: boolean): Node {
    const factory = this.factory;
    const context = this.context;
    const prefix = node instanceof PrefixUnaryExpression;
    const operator = prefix ? (node as PrefixUnaryExpression).operator : (node as PostfixUnaryExpression).operator;
    const operand = prefix ? (node as PrefixUnaryExpression).operand : (node as PostfixUnaryExpression).operand;
    if (operator !== SyntaxKind.PlusPlusToken && operator !== SyntaxKind.MinusMinusToken)
      return this.visitEachChild(node);
    const target = skipParentheses(operand);
    if (target instanceof PropertyAccessExpression && target.name instanceof PrivateIdentifier) {
      const info = this.accessPrivateIdentifier(target.name);
      if (info === undefined) return this.visitEachChild(node);
      const receiver = this.createCopiableReceiver(this.visitNode(target.expression)!);
      let expression = this.createPrivateIdentifierAccessHelper(info, receiver.read);
      let temp: Identifier | undefined = undefined;
      if (!prefix && !discarded) temp = context.addVariableDeclaration(factory.createTempVariable(0));
      expression = this.expandIncrementOrDecrement(node, operator, operand, expression, temp);
      expression = this.createPrivateIdentifierAssignment(
        info,
        receiver.initialize !== undefined ? receiver.initialize : receiver.read,
        expression,
        SyntaxKind.EqualsToken,
      );
      context.setOriginal(expression, node);
      expression.pos = node.pos;
      expression.end = node.end;
      if (temp !== undefined) expression = this.withRange(factory.createCommaExpression(expression, temp), node);
      return expression;
    }
    const data = this.staticSuperData(target);
    if (data === undefined) return this.visitEachChild(node);
    if ((data.facts & ClassFacts.ClassWasDecorated) !== 0) {
      const visited = this.visitInvalidSuperProperty(target);
      if (prefix) return factory.updatePrefixUnaryExpression(node as PrefixUnaryExpression, operator, visited);
      return factory.updatePostfixUnaryExpression(node as PostfixUnaryExpression, visited, operator);
    }
    if (data.classConstructor === undefined || data.superClassReference === undefined) return this.visitEachChild(node);
    // `++super.a` becomes `(Reflect.set(_baseTemp, "a", (_a = Reflect.get(_baseTemp, "a", _classTemp), _b = ++_a), _classTemp), _b)`.
    let getterName: Node | undefined = undefined;
    let setterName: Node | undefined = undefined;
    if (target instanceof PropertyAccessExpression) {
      if (target.name instanceof Identifier) {
        getterName = factory.createStringLiteralFromNode(target.name);
        setterName = getterName;
      }
    } else if (target instanceof ElementAccessExpression) {
      if (isSimpleInlineableExpression(target.argumentExpression)) {
        getterName = target.argumentExpression;
        setterName = getterName;
      } else {
        const temp = context.addVariableDeclaration(factory.createTempVariable(0));
        getterName = temp;
        setterName = factory.createAssignment(temp, this.visitNode(target.argumentExpression)!);
      }
    }
    if (getterName === undefined || setterName === undefined) return this.visitEachChild(node);
    let expression: Node = this.withRange(
      factory.createReflectGetCall(data.superClassReference, getterName, data.classConstructor),
      target,
    );
    let temp: Identifier | undefined = undefined;
    if (!discarded) temp = context.addVariableDeclaration(factory.createTempVariable(0));
    expression = this.expandIncrementOrDecrement(node, operator, operand, expression, temp);
    expression = factory.createReflectSetCall(data.superClassReference, setterName, expression, data.classConstructor);
    context.setOriginal(expression, node);
    this.withRange(expression, node);
    if (temp !== undefined) expression = this.withRange(factory.createCommaExpression(expression, temp), node);
    return expression;
  }

  private withRange<T extends Node>(node: T, range: Node): T {
    node.pos = range.pos;
    node.end = range.end;
    return node;
  }

  /** `(_a = expression, ++_a)`, or `(_a = expression, result = _a++, _a)` for postfix operators. */
  private expandIncrementOrDecrement(
    node: Node,
    operator: SyntaxKind,
    operand: Node,
    expression: Node,
    result: Identifier | undefined,
  ): Node {
    const factory = this.factory;
    const temp = this.context.addVariableDeclaration(factory.createTempVariable(0));
    let value: Node = this.withRange(factory.createAssignment(temp, expression), operand);
    let operation: Node =
      node instanceof PrefixUnaryExpression
        ? factory.createPrefixUnaryExpression(operator, temp)
        : factory.created(new PostfixUnaryExpression(temp, operator));
    this.withRange(operation, node);
    if (result !== undefined) operation = this.withRange(factory.createAssignment(result, operation), node);
    value = this.withRange(factory.createCommaExpression(value, operation), node);
    if (node instanceof PostfixUnaryExpression)
      value = this.withRange(factory.createCommaExpression(value, temp), node);
    return value;
  }

  private visitForStatement(node: ForStatement): Node {
    const initializer = this.discarded.visitNode(node.initializer);
    const condition = this.visitNode(node.condition);
    const incrementor = this.discarded.visitNode(node.incrementor);
    const saved = this.inIterationStatement;
    this.inIterationStatement = true;
    const body = this.visitIterationBody(node.statement)!;
    this.inIterationStatement = saved;
    return this.factory.updateForStatement(node, initializer, condition, incrementor, body);
  }

  private visitExpressionStatement(node: ExpressionStatement): Node {
    // A private name as a statement (`#;`) stays so that it fails at runtime.
    if (node.expression instanceof PrivateIdentifier && this.shouldTransformPrivateElementsOrClassStaticBlocks)
      return node;
    return this.factory.updateExpressionStatement(node, this.discarded.visitNode(node.expression)!);
  }

  private createCopiableReceiver(receiver: Node): CopiableReceiver {
    const clone = nodeIsSynthesized(receiver) ? receiver : this.shallowClone(receiver);
    if (isSimpleInlineableExpression(receiver)) return new CopiableReceiver(clone, undefined);
    const read = this.context.addVariableDeclaration(this.factory.createTempVariable(0));
    return new CopiableReceiver(read, this.factory.createAssignment(read, clone));
  }

  /** A copy of `node` sharing its children, which keep generated names. */
  private shallowClone(node: Node): Node {
    const factory = this.factory;
    if (node instanceof Identifier) return factory.cloneIdentifier(node);
    if (node instanceof PropertyAccessExpression)
      return factory.cloneNode(
        node,
        new PropertyAccessExpression(node.expression, node.questionDotToken, node.name, node.flags),
      );
    if (node instanceof ElementAccessExpression)
      return factory.cloneNode(
        node,
        new ElementAccessExpression(node.expression, node.questionDotToken, node.argumentExpression, node.flags),
      );
    if (node instanceof ParenthesizedExpression)
      return factory.cloneNode(node, new ParenthesizedExpression(node.expression));
    if (node instanceof CallExpression)
      return factory.cloneNode(
        node,
        newCallExpression(
          node.expression,
          callQuestionDotToken(node),
          callTypeArguments(node),
          node.arguments,
          node.flags,
          false,
        ),
      );
    return factory.cloneNode(node, node.deepClone());
  }

  private visitCallExpression(node: CallExpression): Node {
    const factory = this.factory;
    const callee = node.expression;
    if (
      callee instanceof PropertyAccessExpression &&
      callee.name instanceof PrivateIdentifier &&
      this.accessPrivateIdentifier(callee.name) !== undefined
    ) {
      // `obj.#x()` binds `this`: `__classPrivateFieldGet(obj, _C_instances, "m", _C_x).call(obj)`.
      const binding = this.createCallBinding(callee);
      const target = this.visitNode(binding.target)!;
      const args: Node[] = [this.visitNode(binding.thisArg)!];
      const visitedArgs = this.visitNodes(node.arguments)!.nodes;
      for (let i = 0; i < visitedArgs.length; i++) args.push(visitedArgs[i]);
      const optional = (node.flags & NodeFlags.OptionalChain) !== 0;
      const call = factory.created(
        new PropertyAccessExpression(
          target,
          optional ? callQuestionDotToken(node) : undefined,
          factory.createIdentifier('call'),
          optional ? NodeFlags.OptionalChain : NodeFlags.None,
        ),
      );
      return factory.updateCallExpression(node, call, undefined, undefined, factory.createNodeList(args), node.flags);
    }
    const data = this.staticSuperData(callee);
    if (data !== undefined && data.classConstructor !== undefined) {
      // `super.f(...)` becomes `Reflect.get(_baseTemp, "f", _classTemp).call(_classTemp, ...)`.
      const invocation = factory.createFunctionCallCall(
        this.visitNode(callee)!,
        data.classConstructor,
        this.visitNodes(node.arguments)!.nodes,
      );
      this.context.setOriginal(invocation, node);
      return this.withRange(invocation, node as CallExpression);
    }
    return this.visitEachChild(node);
  }

  private visitTaggedTemplateExpression(node: TaggedTemplateExpression): Node {
    const factory = this.factory;
    const tag = node.tag;
    if (
      tag instanceof PropertyAccessExpression &&
      tag.name instanceof PrivateIdentifier &&
      this.accessPrivateIdentifier(tag.name) !== undefined
    ) {
      // A private tag binds `this` with `.bind`.
      const binding = this.createCallBinding(tag);
      const bound = factory.createCallExpression(
        factory.createPropertyAccessExpression(this.visitNode(binding.target)!, factory.createIdentifier('bind')),
        [this.visitNode(binding.thisArg)!],
      );
      return factory.updateTaggedTemplateExpression(
        node,
        bound,
        undefined,
        undefined,
        this.visitNode(node.template)!,
        node.flags,
      );
    }
    const data = this.staticSuperData(tag);
    if (data !== undefined && data.classConstructor !== undefined) {
      // `` super.f`x` `` becomes `` Reflect.get(_baseTemp, "f", _classTemp).bind(_classTemp)`x` ``.
      const invocation = factory.createFunctionBindCall(this.visitNode(tag)!, data.classConstructor, []);
      this.context.setOriginal(invocation, node);
      this.withRange(invocation, node as TaggedTemplateExpression);
      return factory.updateTaggedTemplateExpression(
        node,
        invocation,
        undefined,
        undefined,
        this.visitNode(node.template)!,
        node.flags,
      );
    }
    return this.visitEachChild(node);
  }

  /** A static block as an expression to evaluate after the class: an arrow function called in place. */
  private transformClassStaticBlockDeclaration(node: ClassStaticBlockDeclaration): Node | undefined {
    if (!this.shouldTransformPrivateElementsOrClassStaticBlocks) return undefined;
    const context = this.context;
    const factory = this.factory;
    if (isClassThisAssignmentBlock(context, node)) {
      const result = this.visitNode((node.body.statements.nodes[0] as ExpressionStatement).expression)!;
      // `_classThis = _classThis` does nothing.
      if (result instanceof BinaryExpression && isAssignmentExpression(result, true) && result.left === result.right)
        return undefined;
      return result;
    }
    if (isClassNamedEvaluationHelperBlock(context, node))
      return this.visitNode((node.body.statements.nodes[0] as ExpressionStatement).expression);
    context.startVariableEnvironment();
    const saved = this.currentClassElement;
    this.currentClassElement = node;
    let statements = this.visitArray(node.body.statements.nodes);
    this.currentClassElement = saved;
    statements = context.mergeEnvironment(statements, context.endVariableEnvironment());
    const iife = factory.createImmediatelyInvokedArrowFunction(statements);
    const arrow = skipParentheses(iife.expression);
    context.setOriginal(arrow, node);
    context.addEmitFlags(arrow, EmitFlags.NoLexicalArguments);
    // Keep the statements' range for detached comments, as in `static { // do }`.
    if (arrow instanceof ArrowFunction && arrow.body instanceof Block) {
      arrow.body.statements.pos = node.body.statements.pos;
      arrow.body.statements.end = node.body.statements.end;
    }
    context.setOriginal(iife, node);
    context.assignSourceMapRange(iife, node);
    context.addEmitFlags(arrow, EmitFlags.NoLexicalThis);
    return iife;
  }

  private visitBinaryExpression(node: BinaryExpression, discarded: boolean): Node {
    const factory = this.factory;
    const context = this.context;
    if (isDestructuringAssignment(node)) {
      // `({ x: obj.#x } = ...)`, `({ x: super.x } = ...)`
      const saved = this.pendingExpressions;
      this.pendingExpressions = [];
      const updated = factory.updateBinaryExpression(
        node,
        undefined,
        this.assignmentTargetMode.visitNode(node.left)!,
        undefined,
        node.operatorToken,
        this.visitNode(node.right)!,
      );
      const pending = this.pendingExpressions;
      this.pendingExpressions = saved;
      if (pending.length === 0) return updated;
      pending.push(updated as BinaryExpression);
      return factory.inlineExpressions(pending)!;
    }
    let current = node;
    if (isAssignmentExpression(node, false)) {
      const named = this.transformNamedEvaluationIfNeeded(node, '') as BinaryExpression;
      current = named;
      const left = skipOuterExpressions(
        named.left,
        OuterExpressionKinds.PartiallyEmittedExpressions | OuterExpressionKinds.Parentheses,
      );
      if (left instanceof PropertyAccessExpression && left.name instanceof PrivateIdentifier) {
        // `obj.#x = ...`
        const info = this.accessPrivateIdentifier(left.name);
        if (info !== undefined) {
          const result = this.createPrivateIdentifierAssignment(
            info,
            left.expression,
            named.right,
            named.operatorToken.kind,
          );
          context.setOriginal(result, named);
          return this.withRange(result, named);
        }
      } else {
        const data = this.staticSuperData(named.left);
        if (data !== undefined) {
          if ((data.facts & ClassFacts.ClassWasDecorated) !== 0)
            return factory.updateBinaryExpression(
              named,
              undefined,
              this.visitInvalidSuperProperty(named.left),
              undefined,
              named.operatorToken,
              this.visitNode(named.right)!,
            );
          if (data.classConstructor !== undefined && data.superClassReference !== undefined) {
            const assigned = this.transformSuperPropertyAssignment(named, data, discarded);
            if (assigned !== undefined) return assigned;
          }
        }
      }
    }
    if (current.operatorToken.kind === SyntaxKind.InKeyword && current.left instanceof PrivateIdentifier)
      return this.transformPrivateIdentifierInInExpression(current);
    return this.visitEachChild(current);
  }

  /** `super.x = 1` becomes `(Reflect.set(_baseTemp, "x", _a = 1, _classTemp), _a)`. */
  private transformSuperPropertyAssignment(
    node: BinaryExpression,
    data: ClassData,
    discarded: boolean,
  ): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    const left = node.left;
    let setterName: Node | undefined = undefined;
    if (left instanceof ElementAccessExpression) setterName = this.visitNode(left.argumentExpression)!;
    else if (left instanceof PropertyAccessExpression && left.name instanceof Identifier)
      setterName = factory.createStringLiteralFromNode(left.name);
    if (setterName === undefined) return undefined;
    const superClass = data.superClassReference!;
    const classConstructor = data.classConstructor!;
    let expression = this.visitNode(node.right)!;
    const operator = node.operatorToken.kind;
    if (isCompoundAssignment(operator)) {
      let getterName = setterName;
      if (!isSimpleInlineableExpression(setterName)) {
        const temp = context.addVariableDeclaration(factory.createTempVariable(0));
        getterName = temp;
        setterName = factory.createAssignment(temp, setterName);
      }
      const get = factory.createReflectGetCall(superClass, getterName, classConstructor);
      context.setOriginal(get, left);
      this.withRange(get, left);
      expression = this.withRange(
        factory.createBinaryExpression(get, nonAssignmentOperatorForCompoundAssignment(operator), expression),
        node as BinaryExpression,
      );
    }
    let temp: Identifier | undefined = undefined;
    if (!discarded) {
      temp = context.addVariableDeclaration(factory.createTempVariable(0));
      expression = this.withRange(factory.createAssignment(temp, expression), node as BinaryExpression);
    }
    expression = factory.createReflectSetCall(superClass, setterName, expression, classConstructor);
    context.setOriginal(expression, node);
    this.withRange(expression, node as BinaryExpression);
    if (temp !== undefined)
      expression = this.withRange(factory.createCommaExpression(expression, temp), node as BinaryExpression);
    return expression;
  }

  private createPrivateIdentifierAssignment(
    info: PrivateIdentifierInfo,
    receiverExpression: Node,
    rightExpression: Node,
    operator: SyntaxKind,
  ): Node {
    const factory = this.factory;
    let receiver = this.visitNode(receiverExpression)!;
    let right = this.visitNode(rightExpression)!;
    if (isCompoundAssignment(operator)) {
      const copiable = this.createCopiableReceiver(receiver);
      receiver = copiable.initialize !== undefined ? copiable.initialize : copiable.read;
      right = factory.createBinaryExpression(
        this.createPrivateIdentifierAccessHelper(info, copiable.read),
        nonAssignmentOperatorForCompoundAssignment(operator),
        right,
      );
    }
    this.context.setCommentRange(receiver, -1, receiver.end);
    const state = info.brandCheckIdentifier!;
    switch (info.kind) {
      case PrivateKind.Accessor:
        return factory.createClassPrivateFieldSetHelper(receiver, state, right, 'a', info.setterName);
      case PrivateKind.Method:
        return factory.createClassPrivateFieldSetHelper(receiver, state, right, 'm', undefined);
      case PrivateKind.Field:
        return factory.createClassPrivateFieldSetHelper(
          receiver,
          state,
          right,
          'f',
          info.isStatic ? info.variableName : undefined,
        );
    }
    throw new Error('Access helpers should not be created for untransformed private elements');
  }

  /**
   * Whether the body or initializer of `member` refers to the class `classNode` by name, which then
   * needs an alias once the member's code moves out of the class.
   */
  private memberContainsConstructorReference(member: Node, classNode: Node): boolean {
    const finder = new ConstructorReferenceFinder(
      this.resolver,
      this.context.mostOriginal(classNode),
      getNameOfDeclaration(classNode),
    );
    const body = member instanceof ClassStaticBlockDeclaration ? member.body : getBody(member);
    if (body !== undefined && finder.check(body)) return true;
    if (member instanceof PropertyDeclaration && member.initializer !== undefined && finder.check(member.initializer))
      return true;
    return false;
  }

  private classContainsConstructorReference(node: Node): boolean {
    const members = membersOf(node);
    for (let i = 0; i < members.length; i++) if (this.memberContainsConstructorReference(members[i], node)) return true;
    return false;
  }

  private getClassFacts(node: Node): ClassFacts {
    const context = this.context;
    let facts = ClassFacts.None;
    const original = context.mostOriginal(node);
    if (isClassLike(original) && classOrConstructorParameterIsDecorated(this.legacyDecorators, original))
      facts |= ClassFacts.ClassWasDecorated;
    const members = membersOf(node);
    if (
      this.shouldTransformPrivateElementsOrClassStaticBlocks &&
      (classHasClassThisAssignment(context, getClassMembers(node)) || classHasExplicitlyAssignedName(context, node))
    )
      facts |= ClassFacts.NeedsClassConstructorReference;
    let containsPublicInstanceFields = false;
    let containsInitializedPublicInstanceFields = false;
    let containsInstancePrivateElements = false;
    let containsInstanceAutoAccessors = false;
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const name = getName(member);
      if (isStatic(member)) {
        if (
          name !== undefined &&
          (name.kind === SyntaxKind.PrivateIdentifier || isAutoAccessorPropertyDeclaration(member)) &&
          this.shouldTransformPrivateElementsOrClassStaticBlocks
        )
          facts |= ClassFacts.NeedsClassConstructorReference;
        else if (
          isAutoAccessorPropertyDeclaration(member) &&
          this.shouldTransformAutoAccessors &&
          getName(node) === undefined &&
          context.getClassThis(node) === undefined
        )
          facts |= ClassFacts.NeedsClassConstructorReference;
        if (member instanceof PropertyDeclaration || member instanceof ClassStaticBlockDeclaration) {
          if (
            this.shouldTransformThisInStaticInitializers &&
            this.facts.has(member, SubtreeFacts.ContainsLexicalThis)
          ) {
            facts |= ClassFacts.NeedsSubstitutionForThisInClassStaticField;
            if ((facts & ClassFacts.ClassWasDecorated) === 0) facts |= ClassFacts.NeedsClassConstructorReference;
          }
          if (
            this.shouldTransformThisInStaticInitializers &&
            this.facts.has(member, SubtreeFacts.ContainsLexicalSuper) &&
            (facts & ClassFacts.ClassWasDecorated) === 0
          )
            facts |= ClassFacts.NeedsClassConstructorReference | ClassFacts.NeedsClassSuperReference;
        }
      } else if (!hasSyntacticModifier(context.mostOriginal(member), ModifierFlags.Abstract)) {
        if (isAutoAccessorPropertyDeclaration(member)) {
          containsInstanceAutoAccessors = true;
          if (isPrivateIdentifierClassElementDeclaration(member)) containsInstancePrivateElements = true;
        } else if (isPrivateIdentifierClassElementDeclaration(member)) {
          containsInstancePrivateElements = true;
          if (this.memberContainsConstructorReference(member, node)) facts |= ClassFacts.NeedsClassConstructorReference;
        } else if (member instanceof PropertyDeclaration) {
          containsPublicInstanceFields = true;
          if (member.initializer !== undefined) containsInitializedPublicInstanceFields = true;
        }
      }
    }
    const transformPrivate = this.shouldTransformPrivateElementsOrClassStaticBlocks;
    if (
      (this.shouldTransformInitializersUsingDefine && containsPublicInstanceFields) ||
      (this.shouldTransformInitializersUsingSet && containsInitializedPublicInstanceFields) ||
      (transformPrivate && containsInstancePrivateElements) ||
      (transformPrivate && containsInstanceAutoAccessors && this.shouldTransformAutoAccessors)
    )
      facts |= ClassFacts.WillHoistInitializersToConstructor;
    return facts;
  }

  private visitExpressionWithTypeArgumentsInHeritageClause(node: ExpressionWithTypeArguments): Node {
    if ((this.currentClassFacts() & ClassFacts.NeedsClassSuperReference) !== 0) {
      const factory = this.factory;
      const temp = this.context.addVariableDeclaration(
        factory.createTempVariable(GeneratedIdentifierFlags.ReservedInNestedScopes),
      );
      this.getClassData().superClassReference = temp;
      return factory.updateExpressionWithTypeArguments(
        node,
        factory.createAssignment(temp, this.visitNode(node.expression)!),
        undefined,
      );
    }
    return this.heritageMode.visitEachChild(node);
  }

  /** Visits a class in a new class lexical environment. */
  private visitClassLike(node: Node): Node | undefined {
    const savedContainer = this.currentClassContainer;
    const savedPending = this.pendingExpressions;
    const savedEnvironment = this.lexicalEnvironment;
    this.currentClassContainer = node;
    this.pendingExpressions = [];
    this.lexicalEnvironment = new ClassEnvironment(savedEnvironment);
    const context = this.context;
    const original = context.mostOriginal(node);
    this.enclosingClassDeclarations.add(original);
    if (this.shouldTransformPrivateElementsOrClassStaticBlocks || this.hasTransformPrivateStaticElementsFlag(node)) {
      const name = getNameOfDeclaration(node);
      if (name instanceof Identifier) this.getPrivateEnvironment().className = name as Identifier;
      else {
        const assignedName = context.getAssignedName(node);
        if (assignedName instanceof StringLiteral) {
          const textSource = context.getTextSource(assignedName);
          if (textSource instanceof Identifier) this.getPrivateEnvironment().className = textSource as Identifier;
          else if (isIdentifierText(assignedName.text))
            this.getPrivateEnvironment().className = this.factory.createIdentifier(assignedName.text);
        }
      }
    }
    if (this.shouldTransformPrivateElementsOrClassStaticBlocks) {
      const methods = privateInstanceMethodsAndAccessors(node);
      if (methods.length > 0)
        this.getPrivateEnvironment().weakSetName = this.createHoistedVariableForClass(
          'instances',
          getName(methods[0])!,
          '',
        );
    }
    const facts = this.getClassFacts(node);
    if (facts !== ClassFacts.None) this.getClassData().facts = facts;
    const result =
      node instanceof ClassDeclaration
        ? this.visitClassDeclarationInEnvironment(node as ClassDeclaration, facts)
        : this.visitClassExpressionInEnvironment(node as ClassExpression, facts);
    this.enclosingClassDeclarations.delete(original);
    this.currentClassContainer = savedContainer;
    this.pendingExpressions = savedPending;
    this.lexicalEnvironment = savedEnvironment;
    return result;
  }

  private visitClassDeclarationInEnvironment(node: ClassDeclaration, facts: ClassFacts): Node {
    const factory = this.factory;
    const context = this.context;
    // Private statics and static `this` or `super` need a reference to the class.
    let pendingClassReferenceAssignment: Node | undefined = undefined;
    const classThis = classThisOf(context, node);
    if ((facts & ClassFacts.NeedsClassConstructorReference) !== 0) {
      // Reusing `_classThis` is only safe when static blocks are transformed too: the assignment
      // then runs before them, so it doesn't overwrite a replacement constructor from decorators.
      if (this.shouldTransformPrivateElementsOrClassStaticBlocks && classThis !== undefined) {
        this.getClassData().classConstructor = classThis;
        pendingClassReferenceAssignment = factory.createAssignment(
          classThis,
          factory.getLocalName(node, NameOptions.None),
        );
      } else {
        const temp = context.addVariableDeclaration(
          factory.createTempVariable(GeneratedIdentifierFlags.ReservedInNestedScopes),
        );
        this.getClassData().classConstructor = factory.cloneIdentifier(temp);
        pendingClassReferenceAssignment = factory.createAssignment(temp, factory.getLocalName(node, NameOptions.None));
      }
    }
    if (classThis !== undefined) this.getClassData().classThis = classThis;
    // Aliases are registered before visiting members, which substitute eagerly.
    const alias = this.getClassData().classConstructor;
    if (alias !== undefined && this.classContainsConstructorReference(node))
      this.classAliases.set(context.mostOriginal(node), alias);
    let modifiers = this.modifierMode.visitModifiers(node.modifiers);
    const heritageClauses = this.heritageMode.visitNodes(node.heritageClauses);
    const transformed = this.transformClassMembers(node);
    const statements: Node[] = [];
    if (pendingClassReferenceAssignment !== undefined) this.pendingExpressions.unshift(pendingClassReferenceAssignment);
    // Expressions from elided or moved computed property names.
    if (this.pendingExpressions.length > 0)
      statements.push(factory.createExpressionStatement(factory.inlineExpressions(this.pendingExpressions)!));
    let name: Identifier | undefined = node.name;
    if (this.shouldTransformInitializersUsingSet || this.shouldTransformPrivateElementsOrClassStaticBlocks) {
      // Static initializers run after the class, which is safe because the declaration is lexical.
      const statics = staticPropertiesAndClassStaticBlocks(node);
      if (statics.length > 0) {
        if (name === undefined) name = factory.createGeneratedNameForNode(node, 0, '', '');
        this.addPropertyOrClassStaticBlockStatements(statements, statics, factory.getLocalName(node, NameOptions.None));
      }
    }
    if (
      statements.length > 0 &&
      hasSyntacticModifier(node, ModifierFlags.Export) &&
      hasSyntacticModifier(node, ModifierFlags.Default)
    ) {
      modifiers = this.extractModifiers(modifiers, ~(ModifierFlags.Export | ModifierFlags.Default));
      statements.push(
        factory.created(
          new ExportAssignment(undefined, false, undefined, factory.getLocalName(node, NameOptions.None)),
        ),
      );
    }
    const updated = factory.updateClassDeclaration(
      node,
      modifiers,
      name,
      undefined,
      heritageClauses,
      transformed.members,
    );
    const result: Node[] = [];
    if (transformed.prologue !== undefined) result.push(factory.createExpressionStatement(transformed.prologue));
    result.push(updated as ClassDeclaration);
    for (let i = 0; i < statements.length; i++) result.push(statements[i]);
    return factory.createSyntaxList(result);
  }

  private createClassTemp(): Identifier {
    const temp = this.factory.createTempVariable(GeneratedIdentifierFlags.ReservedInNestedScopes);
    return temp;
  }

  private visitClassExpressionInEnvironment(node: ClassExpression, facts: ClassFacts): Node {
    const factory = this.factory;
    const context = this.context;
    // A class expression from a decorated class declaration puts its statics in statements after
    // the variable statement, as the declaration would.
    const isDecoratedClassDeclaration = (facts & ClassFacts.ClassWasDecorated) !== 0;
    const classThis = classThisOf(context, node);
    if (classThis !== undefined) this.getClassData().classThis = classThis;
    let temp: Identifier | undefined = undefined;
    if ((facts & ClassFacts.NeedsClassConstructorReference) !== 0) {
      if (
        (this.shouldTransformPrivateElementsOrClassStaticBlocks || this.hasTransformPrivateStaticElementsFlag(node)) &&
        classThis !== undefined
      ) {
        this.getClassData().classConstructor = classThis;
        temp = classThis;
      } else {
        temp = this.addHoisted(this.createClassTemp(), this.classExpressionNeedsBlockScopedTemp());
        this.getClassData().classConstructor = factory.cloneIdentifier(temp);
      }
    }
    const statics = staticPropertiesAndClassStaticBlocks(node);
    // Aliases must be known before visiting members, so predict whether a temporary will wrap the class.
    const hasTransformableStatics = this.hasTransformableStatics(node, statics);
    let isClassWithConstructorReference = false;
    let deferTempDeclaration = false;
    if (!isDecoratedClassDeclaration) {
      isClassWithConstructorReference = this.classContainsConstructorReference(node);
      let willHavePrivatePendingExpressions = false;
      if (this.shouldTransformPrivateElementsOrClassStaticBlocks) {
        const members = node.members.nodes;
        for (let i = 0; i < members.length; i++) {
          const member = members[i];
          if (
            isPrivateIdentifierClassElementDeclaration(member) &&
            !hasStaticModifier(member) &&
            this.shouldTransformClassElementToWeakMap(member)
          ) {
            willHavePrivatePendingExpressions = true;
            break;
          }
        }
      }
      const willNeedTempWrapper = hasTransformableStatics || willHavePrivatePendingExpressions;
      if (
        isClassWithConstructorReference &&
        willNeedTempWrapper &&
        this.getClassData().classConstructor === undefined
      ) {
        // Declared after the members are visited, to keep tsc's declaration order.
        temp = this.createClassTemp();
        deferTempDeclaration = true;
        this.getClassData().classConstructor = factory.cloneIdentifier(temp);
      }
      const alias = this.getClassData().classConstructor;
      if (isClassWithConstructorReference && willNeedTempWrapper && alias !== undefined)
        this.classAliases.set(context.mostOriginal(node), alias);
    }
    const modifiers = this.modifierMode.visitModifiers(node.modifiers);
    const heritageClauses = this.heritageMode.visitNodes(node.heritageClauses);
    const transformed = this.transformClassMembers(node);
    if (deferTempDeclaration) this.addHoisted(temp!, this.classExpressionNeedsBlockScopedTemp());
    const classExpression = factory.updateClassExpression(
      node,
      modifiers,
      node.name,
      undefined,
      heritageClauses,
      transformed.members,
    );
    const expressions: Node[] = [];
    if (transformed.prologue !== undefined) expressions.push(transformed.prologue);
    if (!isDecoratedClassDeclaration) {
      if (hasTransformableStatics || this.pendingExpressions.length > 0) {
        if (temp === undefined) {
          temp = this.addHoisted(this.createClassTemp(), this.classExpressionNeedsBlockScopedTemp());
          const alias = factory.cloneIdentifier(temp);
          this.getClassData().classConstructor = alias;
          if (isClassWithConstructorReference) this.classAliases.set(context.mostOriginal(node), alias);
        }
        expressions.push(factory.createAssignment(temp, classExpression));
        // Expressions left from elided or moved computed property names.
        for (let i = 0; i < this.pendingExpressions.length; i++) expressions.push(this.pendingExpressions[i]);
        const initializers = this.generateInitializedPropertyExpressionsOrClassStaticBlock(statics, temp);
        for (let i = 0; i < initializers.length; i++) expressions.push(initializers[i]);
        expressions.push(factory.cloneIdentifier(temp));
      } else expressions.push(classExpression as Node);
    } else if (hasTransformableStatics || this.pendingExpressions.length > 0) {
      for (let i = 0; i < this.pendingExpressions.length; i++)
        this.pendingStatements.push(factory.createExpressionStatement(this.pendingExpressions[i]));
      if (statics.length > 0) {
        const receiver = classThis !== undefined ? classThis : factory.getLocalName(node, NameOptions.None);
        this.addPropertyOrClassStaticBlockStatements(this.pendingStatements, statics, receiver);
      }
      if (temp !== undefined) expressions.push(factory.createAssignment(temp, classExpression));
      else if (this.shouldTransformPrivateElementsOrClassStaticBlocks && classThis !== undefined)
        expressions.push(factory.createAssignment(classThis, classExpression));
      else expressions.push(classExpression as Node);
    } else expressions.push(classExpression as Node);
    if (expressions.length > 1) {
      context.addEmitFlags(classExpression, EmitFlags.Indented);
      for (let i = 0; i < expressions.length; i++) context.addEmitFlags(expressions[i], EmitFlags.StartOnNewLine);
    }
    return factory.inlineExpressions(expressions)!;
  }

  /** `this` in a static initializer, or a computed name, of a class whose code moves out of its body. */
  private visitThisExpression(node: Node): Node {
    const environment = this.lexicalEnvironment;
    if (environment === undefined || environment.data === undefined || !this.shouldTransformThisInStaticInitializers)
      return node;
    const data = environment.data;
    // Computed names of ES-decorated classes are already in an arrow function seeing the outer `this`.
    if (
      this.insideComputedPropertyName &&
      ((data.facts & ClassFacts.ClassWasDecorated) === 0 || this.legacyDecorators)
    ) {
      const classThis = this.tryGetClassThisNoContainer();
      if (classThis !== undefined) return classThis;
    }
    const element = this.currentClassElement;
    if (element !== undefined && isStaticPropertyDeclarationOrClassStaticBlock(element)) {
      const classThis = this.tryGetClassThisNoContainer();
      if (classThis !== undefined) return classThis;
      // A legacy decorator may replace the class, so `this` can't name it.
      if ((data.facts & ClassFacts.ClassWasDecorated) !== 0 && this.legacyDecorators)
        return this.factory.createParenthesizedExpression(this.factory.createVoidZero());
    }
    return node;
  }

  private transformClassMembers(node: Node): ClassMembers {
    const factory = this.factory;
    const context = this.context;
    const memberList = getMembers(node)!;
    const memberNodes = memberList.nodes;
    const privateStaticsInClass = this.hasTransformPrivateStaticElementsFlag(node);
    // Declare private names.
    if (this.shouldTransformPrivateElementsOrClassStaticBlocks || this.shouldTransformPrivateStaticElementsInFile) {
      for (let i = 0; i < memberNodes.length; i++) {
        const member = memberNodes[i];
        if (!isPrivateIdentifierClassElementDeclaration(member)) continue;
        if (this.shouldTransformClassElementToWeakMap(member)) this.addPrivateIdentifierToEnvironment(member);
        else
          this.setPrivateIdentifier(
            this.getPrivateEnvironment(),
            getName(member)!,
            new PrivateIdentifierInfo(PrivateKind.Untransformed, undefined, false, false),
          );
      }
      if (this.shouldTransformPrivateElementsOrClassStaticBlocks && privateInstanceMethodsAndAccessors(node).length > 0)
        this.createBrandCheckWeakSetForPrivateMethods(this.getPrivateEnvironment());
      if (this.shouldTransformAutoAccessorsInCurrentClass()) {
        for (let i = 0; i < memberNodes.length; i++) {
          const member = memberNodes[i];
          if (!isAutoAccessorPropertyDeclaration(member)) continue;
          const storageName = factory.createGeneratedPrivateNameForNode(getName(member)!, '', accessorStorageSuffix);
          if (
            this.shouldTransformPrivateElementsOrClassStaticBlocks ||
            (privateStaticsInClass && hasStaticModifier(member))
          )
            this.addPrivateIdentifierPropertyDeclarationToEnvironment(member, storageName);
          else {
            // Unless the first loop declared it, as for a private auto-accessor expanded by ES decorators.
            const environment = this.getPrivateEnvironment();
            if (this.getPrivateIdentifier(environment, storageName) === undefined)
              this.setPrivateIdentifier(
                environment,
                storageName,
                new PrivateIdentifierInfo(PrivateKind.Untransformed, undefined, false, false),
              );
          }
        }
      }
    }
    let members = this.classElementMode.visitNodes(memberList)!;
    let syntheticConstructor: Node | undefined = undefined;
    let hasConstructor = false;
    for (let i = 0; i < members.nodes.length; i++)
      if (members.nodes[i].kind === SyntaxKind.Constructor) hasConstructor = true;
    if (!hasConstructor) syntheticConstructor = this.transformConstructor(undefined, node);
    // Without static blocks transformed, computed name expressions are evaluated in a static block
    // at the top of the class, before other static initializers.
    let syntheticStaticBlock: Node | undefined = undefined;
    let prologue: Node | undefined = undefined;
    if (!this.shouldTransformPrivateElementsOrClassStaticBlocks && this.pendingExpressions.length > 0) {
      let statement: Node = factory.createExpressionStatement(factory.inlineExpressions(this.pendingExpressions)!);
      if (this.facts.has(statement, SubtreeFacts.ContainsLexicalThisOrSuper)) {
        // `this` and `super` in computed names refer to the outer scope: evaluate them in an arrow function.
        const temp = context.addVariableDeclaration(factory.createTempVariable(0));
        const arrow = factory.createArrowFunction([], factory.createBlock([statement], false));
        prologue = factory.createAssignment(temp, arrow);
        statement = factory.createExpressionStatement(factory.createCallExpression(temp, []));
      }
      syntheticStaticBlock = factory.created(
        new ClassStaticBlockDeclaration(undefined, factory.createBlock([statement], false)),
      );
      this.pendingExpressions = [];
    }
    if (syntheticConstructor !== undefined || syntheticStaticBlock !== undefined) {
      // The classThis and named evaluation blocks stay first.
      const nodes = members.nodes;
      let classThisIndex = -1;
      let namedEvaluationIndex = -1;
      for (let i = 0; i < nodes.length; i++)
        if (classThisIndex < 0 && isClassThisAssignmentBlock(context, nodes[i])) classThisIndex = i;
      for (let i = 0; i < nodes.length; i++)
        if (namedEvaluationIndex < 0 && isClassNamedEvaluationHelperBlock(context, nodes[i])) namedEvaluationIndex = i;
      const updated: Node[] = [];
      if (classThisIndex >= 0) updated.push(nodes[classThisIndex]);
      if (namedEvaluationIndex >= 0) updated.push(nodes[namedEvaluationIndex]);
      if (syntheticConstructor !== undefined) updated.push(syntheticConstructor);
      if (syntheticStaticBlock !== undefined) updated.push(syntheticStaticBlock);
      for (let i = 0; i < nodes.length; i++)
        if (i !== classThisIndex && i !== namedEvaluationIndex) updated.push(nodes[i]);
      members = new NodeList(memberList.pos, memberList.end, updated);
    }
    return new ClassMembers(members, prologue);
  }

  private createBrandCheckWeakSetForPrivateMethods(environment: PrivateEnvironment): boolean {
    const factory = this.factory;
    this.pendingExpressions.push(
      factory.createAssignment(
        environment.weakSetName!,
        factory.created(new NewExpression(factory.createIdentifier('WeakSet'), undefined, factory.createNodeList([]))),
      ),
    );
    return true;
  }

  private transformConstructor(constructor: ConstructorDeclaration | undefined, container: Node): Node | undefined {
    // Parameters and body are visited in the scopes of the new body, so hoisted variables come first.
    if ((this.currentClassFacts() & ClassFacts.WillHoistInitializersToConstructor) === 0)
      return constructor !== undefined ? this.visitEachChild(constructor) : undefined;
    const extendsElement = getClassExtendsHeritageElement(container);
    const isDerivedClass =
      extendsElement !== undefined &&
      skipOuterExpressions(extendsElement.expression, OuterExpressionKinds.All).kind !== SyntaxKind.NullKeyword;
    const parameters = constructor !== undefined ? this.visitNodes(constructor.parameters) : undefined;
    const body = this.transformConstructorBody(container, constructor, isDerivedClass);
    if (body === undefined) return constructor !== undefined ? this.visitEachChild(constructor) : undefined;
    const factory = this.factory;
    if (constructor !== undefined)
      return factory.updateConstructorDeclaration(
        constructor,
        undefined,
        undefined,
        parameters!,
        undefined,
        undefined,
        body,
      );
    const result = factory.created(
      new ConstructorDeclaration(undefined, undefined, factory.createNodeList([]), undefined, undefined, body),
    );
    return this.withRange(result, container);
  }

  private transformConstructorBodyWorker(
    statementsOut: Node[],
    statementsIn: Node[],
    start: number,
    superPath: number[],
    depth: number,
    initializerStatements: Node[],
    constructor: ConstructorDeclaration,
  ): Node[] {
    const superIndex = superPath[depth] | 0;
    const superStatement = statementsIn[superIndex];
    appendAll(statementsOut, this.visitArray(statementsIn.slice(start, superIndex)));
    let offset = superIndex + 1;
    if (superStatement instanceof TryStatement) {
      const tryBlock = superStatement.tryBlock;
      const inner = this.transformConstructorBodyWorker(
        [],
        tryBlock.statements.nodes,
        0,
        superPath,
        depth + 1,
        initializerStatements,
        constructor,
      );
      const list = new NodeList(tryBlock.statements.pos, tryBlock.statements.end, inner);
      const catchClause = this.visitNode(superStatement.catchClause);
      const finallyBlock = this.visitNode(superStatement.finallyBlock);
      statementsOut.push(
        this.factory.updateTryStatement(
          superStatement as TryStatement,
          this.factory.updateBlock(tryBlock, list, tryBlock.multiLine),
          catchClause instanceof CatchClause ? (catchClause as CatchClause) : undefined,
          finallyBlock instanceof Block ? (finallyBlock as Block) : undefined,
        )!,
      );
    } else {
      appendAll(statementsOut, this.visitArray([superStatement]));
      // Parameter property assignments directly follow `super()`; initializers go after them.
      offset = this.skipParameterPropertyAssignments(statementsIn, offset, constructor);
      appendAll(statementsOut, initializerStatements);
    }
    appendAll(statementsOut, this.visitArray(statementsIn.slice(offset)));
    return statementsOut;
  }

  private skipParameterPropertyAssignments(
    statements: Node[],
    start: number,
    constructor: ConstructorDeclaration,
  ): number {
    let offset = start;
    while (
      offset < statements.length &&
      isParameterPropertyDeclaration(this.context.mostOriginal(statements[offset]), constructor)
    )
      offset++;
    return offset;
  }

  private transformConstructorBody(
    container: Node,
    constructor: ConstructorDeclaration | undefined,
    isDerivedClass: boolean,
  ): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    const instanceProperties = propertiesOf(container, false);
    let properties = instanceProperties;
    if (!this.useDefineForClassFields) properties = withInitializerOrPrivateName(properties);
    const privateMethodsAndAccessors = privateInstanceMethodsAndAccessors(container);
    const needsConstructorBody = properties.length > 0 || privateMethodsAndAccessors.length > 0;
    if (constructor === undefined && !needsConstructorBody) return this.visitFunctionBody(undefined);
    context.startVariableEnvironment();
    const needsSyntheticConstructor = constructor === undefined && isDerivedClass;
    let statements: Node[] = [];
    const initializerStatements: Node[] = [];
    const receiver = factory.createThisExpression();
    // Private methods can be called in initializers, so their brand comes first.
    this.addInstanceMethodStatements(initializerStatements, privateMethodsAndAccessors, receiver);
    if (constructor !== undefined) {
      const parameterProperties: Node[] = [];
      const others: Node[] = [];
      for (let i = 0; i < instanceProperties.length; i++)
        if (isParameterPropertyDeclaration(context.mostOriginal(instanceProperties[i]), constructor))
          parameterProperties.push(instanceProperties[i]);
      for (let i = 0; i < properties.length; i++)
        if (!isParameterPropertyDeclaration(context.mostOriginal(properties[i]), constructor))
          others.push(properties[i]);
      this.addPropertyOrClassStaticBlockStatements(initializerStatements, parameterProperties, receiver);
      this.addPropertyOrClassStaticBlockStatements(initializerStatements, others, receiver);
    } else this.addPropertyOrClassStaticBlockStatements(initializerStatements, properties, receiver);
    const constructorBody =
      constructor !== undefined && constructor.body instanceof Block ? (constructor.body as Block) : undefined;
    if (constructorBody !== undefined) {
      const nodes = constructorBody.statements.nodes;
      let offset = 0;
      while (offset < nodes.length && isPrologueDirective(nodes[offset])) statements.push(nodes[offset++]);
      const superPath = findSuperStatementIndexPath(nodes.slice(offset), 0);
      if (superPath.length > 0) {
        superPath[0] = (superPath[0] | 0) + offset;
        statements = this.transformConstructorBodyWorker(
          statements,
          nodes,
          offset,
          superPath,
          0,
          initializerStatements,
          constructor!,
        );
      } else {
        offset = this.skipParameterPropertyAssignments(nodes, offset, constructor!);
        appendAll(statements, initializerStatements);
        appendAll(statements, this.visitArray(nodes.slice(offset)));
      }
    } else {
      if (needsSyntheticConstructor)
        // `super(...arguments);`
        statements.push(
          factory.createExpressionStatement(
            factory.createCallExpression(factory.createKeywordExpression(SyntaxKind.SuperKeyword), [
              factory.created(new SpreadElement(factory.createIdentifier('arguments'))),
            ]),
          ),
        );
      appendAll(statements, initializerStatements);
    }
    statements = context.mergeEnvironment(statements, context.endVariableEnvironment());
    if (statements.length === 0 && constructor === undefined) return undefined;
    const multiLine =
      constructorBody !== undefined && constructorBody.statements.nodes.length >= statements.length
        ? constructorBody.multiLine
        : statements.length > 0;
    const members = getMembers(container)!;
    const list =
      constructorBody !== undefined
        ? new NodeList(constructorBody.statements.pos, constructorBody.statements.end, statements)
        : new NodeList(members.pos, members.end, statements);
    const block = factory.created(new Block(list, multiLine));
    if (constructorBody !== undefined) this.withRange(block, constructorBody);
    return block;
  }

  private addPropertyOrClassStaticBlockStatements(statements: Node[], properties: Node[], receiver: Node): boolean {
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      if (isStatic(property) && !this.shouldTransformPrivateElementsOrClassStaticBlocks) continue;
      const statement = this.transformPropertyOrClassStaticBlock(property, receiver);
      if (statement !== undefined) statements.push(statement);
    }
    return true;
  }

  private transformStaticBlockInElement(property: ClassStaticBlockDeclaration): Node | undefined {
    const saved = this.currentClassElement;
    this.currentClassElement = property;
    const expression = this.transformClassStaticBlockDeclaration(property);
    this.currentClassElement = saved;
    return expression;
  }

  private transformPropertyOrClassStaticBlock(property: Node, receiver: Node): Node | undefined {
    const context = this.context;
    const expression =
      property instanceof ClassStaticBlockDeclaration
        ? this.transformStaticBlockInElement(property as ClassStaticBlockDeclaration)
        : this.transformProperty(property as PropertyDeclaration, receiver);
    if (expression === undefined) return undefined;
    const statement = this.factory.createExpressionStatement(expression);
    context.setOriginal(statement, property);
    context.addEmitFlags(statement, context.getEmitFlags(property) & EmitFlags.NoComments);
    context.setCommentRange(statement, property.pos, property.end);
    const original = context.mostOriginal(property);
    if (original instanceof ParameterDeclaration) {
      context.setSourceMapRange(statement, original.pos, original.end);
      context.addEmitFlags(statement, EmitFlags.NoComments);
    } else context.setSourceMapRange(statement, posPastModifiers(property), property.end);
    // The statement got a copy of the synthesized comments; don't print them twice.
    context.setSyntheticLeadingComments(expression, undefined);
    context.setSyntheticTrailingComments(expression, undefined);
    // Comments of an auto-accessor go to its getter.
    if (hasSyntacticModifier(original, ModifierFlags.Accessor)) context.addEmitFlags(statement, EmitFlags.NoComments);
    return statement;
  }

  private generateInitializedPropertyExpressionsOrClassStaticBlock(properties: Node[], receiver: Node): Node[] {
    const expressions: Node[] = [];
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      const expression =
        property instanceof ClassStaticBlockDeclaration
          ? this.transformStaticBlockInElement(property as ClassStaticBlockDeclaration)
          : this.transformProperty(property as PropertyDeclaration, receiver);
      if (expression === undefined) continue;
      this.context.setOriginalEx(expression, property, true);
      this.context.assignCommentAndSourceMapRanges(expression, property);
      expressions.push(expression);
    }
    return expressions;
  }

  private transformProperty(property: PropertyDeclaration, receiver: Node): Node | undefined {
    const saved = this.currentClassElement;
    const transformed = this.transformPropertyWorker(property, receiver);
    if (transformed !== undefined && hasStaticModifier(property)) {
      const context = this.context;
      context.addEmitFlags(transformed, EmitFlags.NoLexicalThis);
      if (this.currentClassFacts() !== ClassFacts.None) {
        context.setOriginal(transformed, property);
        context.setSourceMapRange(
          transformed,
          context.sourceMapPos(property.name),
          context.sourceMapEnd(property.name),
        );
      }
    }
    this.currentClassElement = saved;
    return transformed;
  }

  private transformPropertyWorker(node: PropertyDeclaration, receiver: Node): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    const emitAssignment = !this.useDefineForClassFields;
    const property = this.transformNamedEvaluationIfNeeded(node, '') as PropertyDeclaration;
    // The generated name reuses the value cached by the moved computed name expression.
    let propertyName: Node = property.name;
    if (hasSyntacticModifier(property, ModifierFlags.Accessor))
      propertyName = factory.createGeneratedPrivateNameForNode(property.name, '', accessorStorageSuffix);
    else if (propertyName instanceof ComputedPropertyName && !isSimpleInlineableExpression(propertyName.expression))
      propertyName = factory.updateComputedPropertyName(
        propertyName,
        factory.createGeneratedNameForNode(propertyName, 0, '', ''),
      );
    if (hasStaticModifier(property)) this.currentClassElement = property;
    if (propertyName instanceof PrivateIdentifier && this.shouldTransformClassElementToWeakMap(property)) {
      const info = this.accessPrivateIdentifier(propertyName);
      if (info === undefined) throw new Error('Undeclared private name for property declaration.');
      if (info.kind !== PrivateKind.Field) return undefined;
      const initializer = this.visitNode(property.initializer);
      const value = initializer !== undefined ? initializer : factory.createVoidZero();
      // `_C_x.set(this, value)`, or `_C_x = { value }` for statics.
      if (!info.isStatic) return factory.createMethodCall(info.brandCheckIdentifier!, 'set', [receiver, value]);
      return factory.createAssignment(
        info.variableName!,
        factory.createObjectLiteral(
          [factory.createPropertyAssignment(factory.createIdentifier('value'), value)],
          false,
        ),
      );
    }
    if (
      (propertyName instanceof PrivateIdentifier || hasStaticModifier(property)) &&
      property.initializer === undefined
    )
      return undefined;
    const original = context.mostOriginal(property);
    if (hasSyntacticModifier(original, ModifierFlags.Abstract)) return undefined;
    let initializer = this.visitNode(property.initializer);
    if (isParameterPropertyDeclaration(original, original.parent) && propertyName instanceof Identifier) {
      // A parameter property's value is its parameter; an initializer here only comes from decorators.
      const localName = factory.cloneIdentifier(propertyName);
      if (initializer !== undefined) {
        // Unwrap `(__runInitializers(this, _instanceExtraInitializers), void 0)`.
        if (initializer instanceof ParenthesizedExpression) {
          const inner = initializer.expression;
          if (
            inner instanceof BinaryExpression &&
            inner.operatorToken.kind === SyntaxKind.CommaToken &&
            context.isCallToHelper(inner.left, '__runInitializers') &&
            inner.right instanceof VoidExpression &&
            inner.right.expression.kind === SyntaxKind.NumericLiteral
          )
            initializer = inner.left;
        }
        initializer = factory.inlineExpressions([initializer, localName])!;
      } else initializer = localName;
      context.addEmitFlags(propertyName, EmitFlags.NoComments | EmitFlags.NoSourceMap);
      const originalName = getName(original)!;
      context.setSourceMapRange(localName, originalName.pos, originalName.end);
      context.addEmitFlags(localName, EmitFlags.NoComments);
    } else if (initializer === undefined) initializer = factory.createVoidZero();
    if (emitAssignment || propertyName instanceof PrivateIdentifier) {
      const access = this.createMemberAccessForPropertyName(receiver, propertyName);
      context.addEmitFlags(access, EmitFlags.NoLeadingComments);
      return factory.createAssignment(access, initializer);
    }
    // useDefineForClassFields: `Object.defineProperty(this, "x", { ... })`
    let name: Node = propertyName;
    if (propertyName instanceof ComputedPropertyName) name = propertyName.expression;
    else if (propertyName instanceof Identifier) name = factory.createStringLiteral(propertyName.text, TokenFlags.None);
    const descriptor = factory.createObjectLiteral(
      [
        factory.createPropertyAssignment(factory.createIdentifier('enumerable'), factory.createTrue()),
        factory.createPropertyAssignment(factory.createIdentifier('configurable'), factory.createTrue()),
        factory.createPropertyAssignment(factory.createIdentifier('writable'), factory.createTrue()),
        factory.createPropertyAssignment(factory.createIdentifier('value'), initializer),
      ],
      true,
    );
    return factory.createObjectDefinePropertyCall(receiver, name, descriptor);
  }

  private createMemberAccessForPropertyName(receiver: Node, name: Node): Node {
    const factory = this.factory;
    if (name instanceof ComputedPropertyName)
      return this.withRange(factory.createElementAccessExpression(receiver, name.expression), name);
    const access: Node =
      name instanceof Identifier || name instanceof PrivateIdentifier
        ? factory.createPropertyAccessExpression(receiver, name)
        : factory.createElementAccessExpression(receiver, name);
    this.context.setCommentRange(access, name.pos, name.end);
    this.context.setSourceMapRange(access, name.pos, name.end);
    this.context.addEmitFlags(access, EmitFlags.NoNestedSourceMaps);
    return access;
  }

  /** `_C_instances.add(this)` brands instances for private methods and accessors. */
  private addInstanceMethodStatements(statements: Node[], methods: Node[], receiver: Node): boolean {
    if (!this.shouldTransformPrivateElementsOrClassStaticBlocks || methods.length === 0) return false;
    const weakSetName = this.getPrivateEnvironment().weakSetName!;
    statements.push(
      this.factory.createExpressionStatement(this.factory.createMethodCall(weakSetName, 'add', [receiver])),
    );
    return true;
  }

  private visitInvalidSuperProperty(node: Node): Node {
    const factory = this.factory;
    if (node instanceof PropertyAccessExpression)
      return factory.updatePropertyAccessExpression(
        node as PropertyAccessExpression,
        factory.createVoidZero(),
        undefined,
        node.name,
        node.flags,
      );
    const access = node as ElementAccessExpression;
    return factory.updateElementAccessExpression(
      access,
      factory.createVoidZero(),
      undefined,
      this.visitNode(access.argumentExpression)!,
      access.flags,
    );
  }

  /**
   * A visited computed name: an assignment caching its value when it's needed again (`shouldHoist`),
   * the expression when it has effects, or undefined when it's unused or safe to repeat.
   */
  private getPropertyNameExpressionIfNeeded(name: Node, shouldHoist: boolean): Node | undefined {
    if (!(name instanceof ComputedPropertyName)) return undefined;
    const cacheAssignment = findComputedPropertyNameCacheAssignment(name);
    const expression = this.visitInOuterEnvironment(name.expression);
    const inner = skipOuterExpressions(expression, OuterExpressionKinds.PartiallyEmittedExpressions);
    const inlinable = isSimpleInlineableExpression(inner);
    const alreadyTransformed =
      cacheAssignment !== undefined ||
      (inner instanceof BinaryExpression &&
        isAssignmentExpression(inner, true) &&
        inner.left instanceof Identifier &&
        this.context.hasAutoGenerateInfo(inner.left));
    if (!alreadyTransformed && !inlinable && shouldHoist) {
      const generated = this.addHoisted(
        this.factory.createGeneratedNameForNode(name, 0, '', ''),
        this.requiresBlockScopedVar(),
      );
      return this.factory.createAssignment(generated, expression);
    }
    if (inlinable || inner instanceof Identifier) return undefined;
    return expression;
  }

  private getClassData(): ClassData {
    const environment = this.lexicalEnvironment!;
    if (environment.data === undefined) environment.data = new ClassData();
    return environment.data;
  }

  private getPrivateEnvironment(): PrivateEnvironment {
    const environment = this.lexicalEnvironment!;
    if (environment.privateEnv === undefined) environment.privateEnv = new PrivateEnvironment();
    return environment.privateEnv;
  }

  /** The brand check of a static member: the class, or its classThis. */
  private staticBrandCheck(): Identifier | undefined {
    const data = this.getClassData();
    return data.classThis !== undefined ? data.classThis : data.classConstructor;
  }

  private addPrivateIdentifierPropertyDeclarationToEnvironment(node: Node, name: Node): boolean {
    const environment = this.getPrivateEnvironment();
    const isStaticMember = hasStaticModifier(node);
    const isValid = !this.isReservedPrivateName(name) && this.getPrivateIdentifier(environment, name) === undefined;
    if (isStaticMember) {
      const info = new PrivateIdentifierInfo(PrivateKind.Field, this.staticBrandCheck(), true, isValid);
      info.variableName = this.createHoistedVariableForPrivateName(name, '');
      this.setPrivateIdentifier(environment, name, info);
      return true;
    }
    const weakMapName = this.createHoistedVariableForPrivateName(name, '');
    this.setPrivateIdentifier(
      environment,
      name,
      new PrivateIdentifierInfo(PrivateKind.Field, weakMapName, false, isValid),
    );
    const factory = this.factory;
    this.pendingExpressions.push(
      factory.createAssignment(
        weakMapName,
        factory.created(new NewExpression(factory.createIdentifier('WeakMap'), undefined, factory.createNodeList([]))),
      ),
    );
    return true;
  }

  private addPrivateIdentifierToEnvironment(node: Node): boolean {
    const environment = this.getPrivateEnvironment();
    const name = getName(node)!;
    const isStaticMember = hasStaticModifier(node);
    const previous = this.getPrivateIdentifier(environment, name);
    const isValid = !this.isReservedPrivateName(name) && previous === undefined;
    if (node instanceof PropertyDeclaration && !isAutoAccessorPropertyDeclaration(node))
      return this.addPrivateIdentifierPropertyDeclarationToEnvironment(node, name);
    const brandCheck = isStaticMember ? this.staticBrandCheck() : environment.weakSetName;
    if (brandCheck === undefined)
      throw new Error(isStaticMember ? 'classConstructor should be set' : 'weakSetName should be set');
    if (node instanceof PropertyDeclaration) {
      const info = new PrivateIdentifierInfo(PrivateKind.Accessor, brandCheck, isStaticMember, isValid);
      info.getterName = this.createHoistedVariableForPrivateName(name, '_get');
      info.setterName = this.createHoistedVariableForPrivateName(name, '_set');
      this.setPrivateIdentifier(environment, name, info);
    } else if (node.kind === SyntaxKind.MethodDeclaration) {
      const methodName = this.createHoistedVariableForPrivateName(name, '');
      const info = new PrivateIdentifierInfo(PrivateKind.Method, brandCheck, isStaticMember, isValid);
      info.methodName = methodName;
      this.setPrivateIdentifier(environment, name, info);
    } else {
      const getter = node.kind === SyntaxKind.GetAccessor;
      const accessorName = this.createHoistedVariableForPrivateName(name, getter ? '_get' : '_set');
      // A get and set accessor pair shares one entry.
      if (
        previous !== undefined &&
        previous.kind === PrivateKind.Accessor &&
        previous.isStatic === isStaticMember &&
        (getter ? previous.getterName === undefined : previous.setterName === undefined)
      ) {
        if (getter) previous.getterName = accessorName;
        else previous.setterName = accessorName;
      } else {
        const info = new PrivateIdentifierInfo(PrivateKind.Accessor, brandCheck, isStaticMember, isValid);
        if (getter) info.getterName = accessorName;
        else info.setterName = accessorName;
        this.setPrivateIdentifier(environment, name, info);
      }
    }
    return true;
  }

  private setPrivateIdentifier(environment: PrivateEnvironment, name: Node, info: PrivateIdentifierInfo): boolean {
    if (this.context.hasAutoGenerateInfo(name))
      environment.generated.set(this.context.getNodeForGeneratedName(name), info);
    else environment.members.set(privateNameText(name), info);
    return true;
  }

  private getPrivateIdentifier(environment: PrivateEnvironment, name: Node): PrivateIdentifierInfo | undefined {
    if (this.context.hasAutoGenerateInfo(name))
      return environment.generated.get(this.context.getNodeForGeneratedName(name));
    return environment.members.get(privateNameText(name));
  }

  /** A hoisted variable such as `_C_x`, prefixed with the class name when it has one. */
  private createHoistedVariableForClass(text: string, node: Node, suffix: string): Identifier {
    const className = this.getPrivateEnvironment().className;
    const prefix = className !== undefined ? '_' + className.text + '_' : '_';
    const identifier = this.factory.createUniqueNameWithSuffix(
      prefix + text,
      GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.ReservedInNestedScopes,
      suffix,
    );
    return this.addHoisted(identifier, this.requiresBlockScopedVar());
  }

  private createHoistedVariableForPrivateName(name: Node, suffix: string): Identifier {
    // Generated names, as of auto-accessor storage, are named from their node when printed.
    if (this.context.hasAutoGenerateInfo(name)) {
      const className = this.getPrivateEnvironment().className;
      const prefix = className !== undefined ? '_' + className.text + '_' : '_';
      const identifier = this.factory.createGeneratedNameForNode(
        name,
        GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.ReservedInNestedScopes,
        prefix,
        suffix,
      );
      return this.addHoisted(identifier, this.requiresBlockScopedVar());
    }
    let text = privateNameText(name);
    if (text.length > 0 && text.charCodeAt(0) === 0x23) text = text.slice(1);
    return this.createHoistedVariableForClass(text, name, suffix);
  }

  /** What a private name declared in this or an enclosing class transforms to. */
  private accessPrivateIdentifier(name: Node): PrivateIdentifierInfo | undefined {
    for (let environment = this.lexicalEnvironment; environment !== undefined; environment = environment.previous) {
      const privateEnv = environment.privateEnv;
      if (privateEnv === undefined) continue;
      const info = this.getPrivateIdentifier(privateEnv, name);
      if (info !== undefined) return info.kind === PrivateKind.Untransformed ? undefined : info;
    }
    return undefined;
  }

  private isReservedPrivateName(node: Node): boolean {
    if (node instanceof PrivateIdentifier && this.context.hasAutoGenerateInfo(node)) return false;
    return privateNameText(node) === '#constructor';
  }

  /** `obj.#x` as a destructuring target: `({ set value(_a) { __classPrivateFieldSet(obj, ...); } }).value`. */
  private wrapPrivateIdentifierForDestructuringTarget(node: PropertyAccessExpression): Node {
    const factory = this.factory;
    const parameter = factory.createGeneratedNameForNode(node, 0, '', '');
    const info = this.accessPrivateIdentifier(node.name);
    if (info === undefined) return this.visitEachChild(node);
    let receiver: Node = node.expression;
    // `this` and `super` would bind differently in the setter.
    const kind = node.expression.kind;
    if (kind === SyntaxKind.ThisKeyword || kind === SyntaxKind.SuperKeyword || !isSimpleCopiableExpression(receiver)) {
      const temp = this.context.addVariableDeclaration(
        factory.createTempVariable(GeneratedIdentifierFlags.ReservedInNestedScopes),
      );
      this.pendingExpressions.push(factory.createAssignment(temp, this.visitNode(node.expression)!));
      receiver = temp;
    }
    return factory.createAssignmentTargetWrapper(
      parameter,
      this.createPrivateIdentifierAssignment(info, receiver, parameter, SyntaxKind.EqualsToken),
    );
  }

  private visitDestructuringAssignmentTarget(node: Node): Node {
    if (node instanceof ObjectLiteralExpression || node instanceof ArrayLiteralExpression)
      return this.visitAssignmentPattern(node);
    if (node instanceof PropertyAccessExpression && node.name instanceof PrivateIdentifier)
      return this.wrapPrivateIdentifierForDestructuringTarget(node);
    const data = this.staticSuperData(node);
    if (data !== undefined) {
      if ((data.facts & ClassFacts.ClassWasDecorated) !== 0) return this.visitInvalidSuperProperty(node);
      if (data.classConstructor !== undefined && data.superClassReference !== undefined) {
        let name: Node | undefined = undefined;
        if (node instanceof ElementAccessExpression) name = this.visitNode(node.argumentExpression);
        else if (node instanceof PropertyAccessExpression && node.name instanceof Identifier)
          name = this.factory.createStringLiteralFromNode(node.name);
        if (name !== undefined) {
          const temp = this.factory.createTempVariable(0);
          return this.factory.createAssignmentTargetWrapper(
            temp,
            this.factory.createReflectSetCall(data.superClassReference, name, temp, data.classConstructor),
          );
        }
      }
    }
    return this.visitEachChild(node);
  }

  private visitAssignmentElement(element: Node): Node {
    const node = this.transformNamedEvaluationIfNeeded(element, '');
    if (node instanceof BinaryExpression && isAssignmentExpression(node, true)) {
      const left = this.visitDestructuringAssignmentTarget(node.left);
      const right = this.visitNode(node.right)!;
      return this.factory.updateBinaryExpression(
        node as BinaryExpression,
        undefined,
        left,
        undefined,
        node.operatorToken,
        right,
      );
    }
    return this.visitDestructuringAssignmentTarget(node);
  }

  private visitArrayAssignmentElement(node: Node): Node | undefined {
    if (isArrayBindingOrAssignmentElement(node)) {
      if (node instanceof SpreadElement) {
        if (isLeftHandSideExpression(node.expression))
          return this.factory.updateSpreadElement(
            node as SpreadElement,
            this.visitDestructuringAssignmentTarget(node.expression),
          );
        return this.visitEachChild(node);
      }
      if (node.kind !== SyntaxKind.OmittedExpression) return this.visitAssignmentElement(node);
    }
    return this.visitEachChild(node);
  }

  private visitObjectAssignmentElement(node: Node): Node | undefined {
    const factory = this.factory;
    if (node instanceof SpreadAssignment) {
      if (isLeftHandSideExpression(node.expression))
        return factory.updateSpreadAssignment(
          node as SpreadAssignment,
          this.visitDestructuringAssignmentTarget(node.expression),
        );
      return this.visitEachChild(node);
    }
    if (node instanceof ShorthandPropertyAssignment)
      return this.visitEachChild(this.transformNamedEvaluationIfNeeded(node, ''));
    if (node instanceof PropertyAssignment) {
      const name = this.visitNode(node.name)!;
      const initializer = node.initializer;
      if (initializer instanceof BinaryExpression && isAssignmentExpression(initializer, true))
        return factory.updatePropertyAssignment(
          node as PropertyAssignment,
          undefined,
          name,
          undefined,
          undefined,
          this.visitAssignmentElement(initializer),
        );
      if (isLeftHandSideExpression(initializer))
        return factory.updatePropertyAssignment(
          node as PropertyAssignment,
          undefined,
          name,
          undefined,
          undefined,
          this.visitDestructuringAssignmentTarget(initializer),
        );
      return this.visitEachChild(node);
    }
    return this.visitEachChild(node);
  }

  /** Private names and static `super` in destructuring targets, as `[{ set value(x) { ... } }.value] = ...`. */
  private visitAssignmentPattern(node: Node): Node {
    if (node instanceof ArrayLiteralExpression)
      return this.factory.updateArrayLiteralExpression(
        node as ArrayLiteralExpression,
        this.arrayElementMode.visitNodes(node.elements)!,
        node.multiLine,
      );
    const object = node as ObjectLiteralExpression;
    return this.factory.updateObjectLiteralExpression(
      object,
      this.objectElementMode.visitNodes(object.properties)!,
      object.multiLine,
    );
  }

  private createAccessorPropertyGetRedirector(
    node: PropertyDeclaration,
    modifiers: ModifierList | undefined,
    name: Node,
    receiver: Node,
  ): Node {
    const factory = this.factory;
    const storage = factory.createGeneratedPrivateNameForNode(node.name, '', accessorStorageSuffix);
    const body = factory.createBlock(
      [factory.createReturnStatement(factory.createPropertyAccessExpression(receiver, storage))],
      false,
    );
    return factory.created(
      new GetAccessorDeclaration(modifiers, name, undefined, factory.createNodeList([]), undefined, undefined, body),
    );
  }

  private createAccessorPropertySetRedirector(
    node: PropertyDeclaration,
    modifiers: ModifierList | undefined,
    name: Node,
    receiver: Node,
  ): Node {
    const factory = this.factory;
    const storage = factory.createGeneratedPrivateNameForNode(node.name, '', accessorStorageSuffix);
    const assignment = factory.createAssignment(
      factory.createPropertyAccessExpression(receiver, storage),
      factory.createIdentifier('value'),
    );
    const body = factory.createBlock([factory.createExpressionStatement(assignment)], false);
    const parameters = factory.createNodeList([factory.createParameter(factory.createIdentifier('value'))]);
    return factory.created(
      new SetAccessorDeclaration(modifiers, name, undefined, parameters, undefined, undefined, body),
    );
  }

  private createCallBinding(node: Node): CallBinding {
    const factory = this.factory;
    if (isSuperProperty(node)) return new CallBinding(factory.createThisExpression(), node);
    if (node instanceof PropertyAccessExpression) {
      if (!shouldBeCapturedInTempVariable(node.expression)) return new CallBinding(node.expression, node);
      const thisArg = this.context.addVariableDeclaration(factory.createTempVariable(0));
      const target = factory.createPropertyAccessExpression(
        factory.createParenthesizedExpression(factory.createAssignment(thisArg, node.expression)),
        node.name,
      );
      return new CallBinding(thisArg, target);
    }
    return new CallBinding(factory.createVoidZero(), node);
  }
}

/** Finds identifiers in member code that resolve to a class, skipping property names. */
class ConstructorReferenceFinder extends NodeVisitor {
  readonly resolver: EmitResolver;
  readonly classOriginal: Node;
  readonly className: Node | undefined;

  constructor(resolver: EmitResolver, classOriginal: Node, className: Node | undefined) {
    super();
    this.resolver = resolver;
    this.classOriginal = classOriginal;
    this.className = className;
  }

  check(node: Node): boolean {
    if (node instanceof Identifier && !isSameNode(node, this.className)) {
      const declaration = this.resolver.getReferencedValueDeclaration(node as Identifier);
      if (declaration !== undefined && declaration === this.classOriginal) return true;
    }
    if (node instanceof PropertyAccessExpression) return this.check(node.expression);
    return node.forEachChild(this);
  }

  visitNode(node: Node): boolean {
    return this.check(node);
  }
}

function membersOf(node: Node): Node[] {
  const members = getMembers(node);
  return members === undefined ? [] : members.nodes;
}

function parametersOf(node: Node): NodeList {
  const parameters = getParameters(node);
  return parameters !== undefined ? parameters : new NodeList(-1, -1, []);
}

function appendAll(target: Node[], source: readonly Node[]): boolean {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
  return true;
}

function classThisOf(context: EmitContext, node: Node): Identifier | undefined {
  const classThis = context.getClassThis(node);
  return classThis instanceof Identifier ? (classThis as Identifier) : undefined;
}

function privateNameText(node: Node): string {
  if (node instanceof PrivateIdentifier) return node.text;
  if (node instanceof Identifier) return node.text;
  return '';
}

function isInitializedProperty(node: Node): boolean {
  return node instanceof PropertyDeclaration && node.initializer !== undefined;
}

function isSuperProperty(node: Node): boolean {
  if (node instanceof PropertyAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  if (node instanceof ElementAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  return false;
}

function isStaticPropertyDeclarationOrClassStaticBlock(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ClassStaticBlockDeclaration ||
    (node.kind === SyntaxKind.PropertyDeclaration && hasStaticModifier(node))
  );
}

function isCompoundAssignment(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstCompoundAssignment && kind <= SyntaxKind.LastCompoundAssignment;
}

function nonAssignmentOperatorForCompoundAssignment(kind: SyntaxKind): SyntaxKind {
  switch (kind) {
    case SyntaxKind.PlusEqualsToken:
      return SyntaxKind.PlusToken;
    case SyntaxKind.MinusEqualsToken:
      return SyntaxKind.MinusToken;
    case SyntaxKind.AsteriskEqualsToken:
      return SyntaxKind.AsteriskToken;
    case SyntaxKind.AsteriskAsteriskEqualsToken:
      return SyntaxKind.AsteriskAsteriskToken;
    case SyntaxKind.SlashEqualsToken:
      return SyntaxKind.SlashToken;
    case SyntaxKind.PercentEqualsToken:
      return SyntaxKind.PercentToken;
    case SyntaxKind.LessThanLessThanEqualsToken:
      return SyntaxKind.LessThanLessThanToken;
    case SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return SyntaxKind.GreaterThanGreaterThanToken;
    case SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    case SyntaxKind.AmpersandEqualsToken:
      return SyntaxKind.AmpersandToken;
    case SyntaxKind.BarEqualsToken:
      return SyntaxKind.BarToken;
    case SyntaxKind.CaretEqualsToken:
      return SyntaxKind.CaretToken;
    case SyntaxKind.BarBarEqualsToken:
      return SyntaxKind.BarBarToken;
    case SyntaxKind.AmpersandAmpersandEqualsToken:
      return SyntaxKind.AmpersandAmpersandToken;
    case SyntaxKind.QuestionQuestionEqualsToken:
      return SyntaxKind.QuestionQuestionToken;
  }
  return SyntaxKind.Unknown;
}

function isSimpleCopiableExpression(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.Identifier:
      return true;
  }
  return node.kind >= SyntaxKind.FirstKeyword && node.kind <= SyntaxKind.LastKeyword;
}

/** A literal or keyword that can be repeated; identifiers may be reassigned in between. */
function isSimpleInlineableExpression(node: Node): boolean {
  return node.kind !== SyntaxKind.Identifier && isSimpleCopiableExpression(node);
}

function shouldBeCapturedInTempVariable(node: Node): boolean {
  switch (skipParentheses(node).kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
      return false;
  }
  return true;
}

function isArrayBindingOrAssignmentElement(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.BindingElement:
    case SyntaxKind.OmittedExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.Identifier:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
      return true;
  }
  return isAssignmentExpression(node, true);
}

function staticPropertiesAndClassStaticBlocks(node: Node): Node[] {
  const result: Node[] = [];
  const members = membersOf(node);
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (
      member.kind === SyntaxKind.ClassStaticBlockDeclaration ||
      (member.kind === SyntaxKind.PropertyDeclaration && hasStaticModifier(member))
    )
      result.push(member);
  }
  return result;
}

function propertiesOf(node: Node, isStaticProperty: boolean): Node[] {
  const result: Node[] = [];
  const members = membersOf(node);
  for (let i = 0; i < members.length; i++)
    if (members[i] instanceof PropertyDeclaration && hasStaticModifier(members[i]) === isStaticProperty)
      result.push(members[i]);
  return result;
}

function privateInstanceMethodsAndAccessors(node: Node): Node[] {
  const result: Node[] = [];
  const members = membersOf(node);
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (
      !isStatic(member) &&
      (isMethodOrAccessor(member) || isAutoAccessorPropertyDeclaration(member)) &&
      getName(member)!.kind === SyntaxKind.PrivateIdentifier
    )
      result.push(member);
  }
  return result;
}

function getClassExtendsHeritageElement(node: Node): ExpressionWithTypeArguments | undefined {
  let clauses: NodeList | undefined = undefined;
  if (node instanceof ClassDeclaration) clauses = node.heritageClauses;
  else if (node instanceof ClassExpression) clauses = node.heritageClauses;
  if (clauses === undefined) return undefined;
  for (let i = 0; i < clauses.nodes.length; i++) {
    const clause = clauses.nodes[i];
    if (clause instanceof HeritageClause && clause.token === SyntaxKind.ExtendsKeyword) {
      const first = clause.types.nodes[0];
      return first instanceof ExpressionWithTypeArguments ? (first as ExpressionWithTypeArguments) : undefined;
    }
  }
  return undefined;
}

/** Whether a class or its constructor's parameters have decorators that apply. */
function classOrConstructorParameterIsDecorated(legacy: boolean, node: Node): boolean {
  if (hasDecorators(node) && (node.kind === SyntaxKind.ClassDeclaration || !legacy)) return true;
  if (!legacy) return false;
  const members = membersOf(node);
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (!(member instanceof ConstructorDeclaration) || member.body === undefined) continue;
    const parameters = member.parameters.nodes;
    for (let j = 0; j < parameters.length; j++) if (hasDecorators(parameters[j])) return true;
    return false;
  }
  return false;
}

/** The `_a = ...` assignment caching a computed name's value, at the end of its comma list. */
function findComputedPropertyNameCacheAssignment(name: ComputedPropertyName): BinaryExpression | undefined {
  let node = name.expression;
  for (;;) {
    node = skipOuterExpressions(node, OuterExpressionKinds.None);
    if (node instanceof BinaryExpression && node.operatorToken.kind === SyntaxKind.CommaToken) {
      node = node.right;
      continue;
    }
    if (node instanceof BinaryExpression && isAssignmentExpression(node, true) && node.left instanceof Identifier)
      return node;
    return undefined;
  }
}

/** The expressions of a comma list, appended to `out`. */
function flattenCommaList(node: Node, out: Node[]): boolean {
  if (node instanceof ParenthesizedExpression && nodeIsSynthesized(node)) return flattenCommaList(node.expression, out);
  if (node instanceof BinaryExpression && node.operatorToken.kind === SyntaxKind.CommaToken) {
    flattenCommaList(node.left, out);
    return flattenCommaList(node.right, out);
  }
  out.push(node);
  return true;
}

/** The start of a member after its modifiers, or its decorators, for source maps. */
function posPastModifiers(node: Node): number {
  if (node instanceof PropertyDeclaration) return node.name.pos;
  if (node instanceof MethodDeclaration) return node.name.pos;
  if (node.kind === SyntaxKind.ClassStaticBlockDeclaration) return node.pos;
  const modifiers = getModifiers(node);
  if (modifiers === undefined || modifiers.nodes.length === 0) return node.pos;
  const last = modifiers.nodes[modifiers.nodes.length - 1];
  if (last.end >= 0) return last.end;
  for (let i = modifiers.nodes.length - 1; i >= 0; i--)
    if (modifiers.nodes[i].kind === SyntaxKind.Decorator)
      return modifiers.nodes[i].end >= 0 ? modifiers.nodes[i].end : node.pos;
  return node.pos;
}

/** Properties assigned in the constructor with useDefineForClassFields: false. */
function withInitializerOrPrivateName(properties: Node[]): Node[] {
  const result: Node[] = [];
  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];
    if (
      getInitializer(property) !== undefined ||
      getName(property)!.kind === SyntaxKind.PrivateIdentifier ||
      hasSyntacticModifier(property, ModifierFlags.Accessor)
    )
      result.push(property);
  }
  return result;
}

class ClassesNeedingNames extends AnonymousFunctionFilter {
  readonly transformer: ClassFieldsTransformer;

  constructor(transformer: ClassFieldsTransformer) {
    super();
    this.transformer = transformer;
  }

  accepts(node: Node): boolean {
    return this.transformer.isAnonymousClassNeedingAssignedName(node);
  }
}
