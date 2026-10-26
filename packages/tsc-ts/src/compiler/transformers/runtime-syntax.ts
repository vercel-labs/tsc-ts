// TypeScript syntax with runtime behavior: parameter properties, enums, namespaces and
// `import x = a.b`.
import {
  Block,
  CatchClause,
  PrivateIdentifier,
  getBody,
  getName,
  getParameters,
  ClassDeclaration,
  ClassExpression,
  ComputedPropertyName,
  ConstructorDeclaration,
  EnumDeclaration,
  EnumMember,
  ExpressionStatement,
  ExternalModuleReference,
  FunctionDeclaration,
  Identifier,
  ImportEqualsDeclaration,
  KeywordExpression,
  ModifierFlags,
  ModifierList,
  ModuleBlock,
  ModuleDeclaration,
  type Node,
  NodeList,
  NumericLiteral,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertyDeclaration,
  ShorthandPropertyAssignment,
  SourceFile,
  StringLiteral,
  TryStatement,
  NodeFlags,
  CallExpression,
  ParenthesizedExpression,
  VariableDeclaration,
  VariableStatement,
  BindingPattern,
  BinaryExpression,
} from '../ast.js';
import { type CompilerOptions, ModuleKind, getEmitModuleKind, shouldPreserveConstEnums } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags } from '../printer/emit-flags.js';
import { NameOptions, type NodeFactory } from '../printer/factory.js';
import { isPrologueDirective } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  AssignmentFactory,
  convertVariableDeclarationToAssignment,
  flattenDestructuringAssignment,
} from './destructuring.js';
import type { EmitResolver } from './emit-resolver.js';
import { ConstantKind, type Evaluation } from './reference-resolver.js';
import { type TypeScriptFacts } from './subtree-facts.js';
import { nodeIsDecorated } from './decorator-utilities.js';
import { Transformer } from './transformer.js';
import {
  getInnermostModuleDeclaration,
  hasDecorators,
  hasSyntacticModifier,
  isIdentifierReference,
  isInstantiatedModule,
  isParameterPropertyDeclaration,
  isSameNode,
  modifierFlagsOf,
} from './utilities.js';

const typeScriptModifiers =
  ModifierFlags.Ambient |
  ModifierFlags.Public |
  ModifierFlags.Private |
  ModifierFlags.Protected |
  ModifierFlags.Readonly |
  ModifierFlags.Abstract |
  ModifierFlags.Const |
  ModifierFlags.Override |
  ModifierFlags.In |
  ModifierFlags.Out;
const exportDefault = ModifierFlags.Export | ModifierFlags.Default;

export class RuntimeSyntax extends Transformer {
  readonly options: CompilerOptions;
  readonly facts: TypeScriptFacts;
  readonly resolver: EmitResolver;
  private parentNode: Node | undefined;
  private currentNode: Node | undefined;
  private currentSourceFile: SourceFile | undefined;
  /** The source file, block, module block or case block declarations are in. */
  private currentScope: Node | undefined;
  /** The first declaration of each name in the current scope. */
  private firstDeclarations: Map<string, Node> | undefined;
  private currentEnum: EnumDeclaration | undefined;
  private currentNamespace: ModuleDeclaration | undefined;
  private readonly namespaceExports: NamespaceExportAssignments;

  constructor(context: EmitContext, options: CompilerOptions, facts: TypeScriptFacts, resolver: EmitResolver) {
    super(context);
    this.options = options;
    this.facts = facts;
    this.resolver = resolver;
    this.parentNode = undefined;
    this.currentNode = undefined;
    this.currentSourceFile = undefined;
    this.currentScope = undefined;
    this.firstDeclarations = undefined;
    this.currentEnum = undefined;
    this.currentNamespace = undefined;
    this.namespaceExports = new NamespaceExportAssignments(this);
  }

  visit(node: Node): Node | undefined {
    const grandparent = this.parentNode;
    this.parentNode = this.currentNode;
    this.currentNode = node;
    const savedScope = this.currentScope;
    const savedDeclarations = this.firstDeclarations;
    this.enterScope(node);
    const result = this.visitWorker(node);
    if (this.currentScope !== savedScope) this.firstDeclarations = savedDeclarations;
    this.currentScope = savedScope;
    this.currentNode = this.parentNode;
    this.parentNode = grandparent;
    return result;
  }

  private enterScope(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        this.currentScope = node;
        if (node instanceof SourceFile) this.currentSourceFile = node;
        this.firstDeclarations = undefined;
        break;
      case SyntaxKind.CaseBlock:
      case SyntaxKind.ModuleBlock:
      case SyntaxKind.Block:
        this.currentScope = node;
        this.firstDeclarations = undefined;
        break;
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.VariableStatement:
        this.recordDeclarationInScope(node);
        break;
    }
    return true;
  }

  private visitWorker(node: Node): Node | undefined {
    if (!this.facts.containsTypeScript(node) && this.currentNamespace === undefined && this.currentEnum === undefined)
      return node;
    switch (node.kind) {
      case SyntaxKind.PublicKeyword:
      case SyntaxKind.PrivateKeyword:
      case SyntaxKind.ProtectedKeyword:
      case SyntaxKind.ReadonlyKeyword:
      case SyntaxKind.OverrideKeyword:
        return undefined;
      case SyntaxKind.EnumDeclaration:
        if (node instanceof EnumDeclaration) return this.visitEnumDeclaration(node);
        break;
      case SyntaxKind.ModuleDeclaration:
        if (node instanceof ModuleDeclaration) return this.visitModuleDeclaration(node);
        break;
      case SyntaxKind.ClassDeclaration:
        if (node instanceof ClassDeclaration) return this.visitClassDeclaration(node);
        break;
      case SyntaxKind.ClassExpression:
        if (node instanceof ClassExpression)
          return this.factory.updateClassExpression(
            node,
            this.visitModifiers(this.extractModifiers(node.modifiers, ~exportDefault)),
            node.name,
            undefined,
            this.visitNodes(node.heritageClauses),
            this.classMembers(node.members),
          );
        break;
      case SyntaxKind.Constructor:
        if (node instanceof ConstructorDeclaration) return this.visitConstructor(node);
        break;
      case SyntaxKind.FunctionDeclaration:
        if (node instanceof FunctionDeclaration) return this.visitFunctionDeclaration(node);
        break;
      case SyntaxKind.VariableStatement:
        if (node instanceof VariableStatement) return this.visitVariableStatement(node);
        break;
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.ImportClause:
        // ES imports and exports are illegal in a namespace.
        if (this.inNamespaceBody()) return undefined;
        return this.visitEachChild(node);
      case SyntaxKind.ImportEqualsDeclaration:
        if (node instanceof ImportEqualsDeclaration) {
          const external = node.moduleReference instanceof ExternalModuleReference;
          if (this.currentNamespace !== undefined && this.currentScope !== undefined) {
            const inBlock = this.currentScope.kind === SyntaxKind.Block;
            if (external !== inBlock) return undefined;
          }
          return this.visitImportEqualsDeclaration(node);
        }
        break;
      case SyntaxKind.Identifier:
        if (node instanceof Identifier && isIdentifierReference(node, this.parentNode))
          return this.visitExpressionIdentifier(node);
        return node;
      case SyntaxKind.ShorthandPropertyAssignment:
        if (node instanceof ShorthandPropertyAssignment) return this.visitShorthandPropertyAssignment(node);
        break;
    }
    return this.visitEachChild(node);
  }

  private inNamespaceBody(): boolean {
    return (
      this.currentNamespace !== undefined &&
      this.currentScope !== undefined &&
      this.currentScope.kind !== SyntaxKind.Block
    );
  }

  // Scopes

  private recordDeclarationInScope(node: Node): boolean {
    if (node instanceof VariableStatement) {
      const declarations = node.declarationList.declarations.nodes;
      for (let i = 0; i < declarations.length; i++) this.recordDeclarationInScope(declarations[i]);
      return true;
    }
    if (node instanceof BindingPattern) {
      const elements = node.elements.nodes;
      for (let i = 0; i < elements.length; i++) this.recordDeclarationInScope(elements[i]);
      return true;
    }
    const name = getName(node);
    if (name instanceof Identifier) {
      if (this.firstDeclarations === undefined) this.firstDeclarations = new Map<string, Node>();
      if (!this.firstDeclarations.has(name.text)) this.firstDeclarations.set(name.text, node);
    } else if (name instanceof BindingPattern) this.recordDeclarationInScope(name);
    return true;
  }

  private isFirstDeclarationInScope(node: Node): boolean {
    const name = getName(node);
    if (!(name instanceof Identifier) || this.firstDeclarations === undefined) return false;
    return this.firstDeclarations.get(name.text) === node;
  }

  private isExportOfNamespace(node: Node): boolean {
    return (
      this.currentNamespace !== undefined &&
      (this.currentScope === undefined || this.currentScope.kind !== SyntaxKind.Block) &&
      hasSyntacticModifier(node, ModifierFlags.Export)
    );
  }

  // Names

  /** The name a namespace or enum is referred to by inside its body. */
  private getNamespaceContainerName(node: Node): Identifier {
    return this.factory.createGeneratedNameForNode(node, 0, '', '');
  }

  private getCurrentNamespaceName(): Identifier | undefined {
    const namespace = this.currentNamespace;
    return namespace === undefined ? undefined : this.getNamespaceContainerName(namespace);
  }

  /** `ns.x` for an export of the current namespace, else the declaration's name. */
  private getExportQualifiedReferenceToDeclaration(node: Node): Node {
    if (this.isExportOfNamespace(node))
      return this.factory.getExternalModuleOrNamespaceExportName(
        this.getCurrentNamespaceName(),
        node,
        NameOptions.AllowSourceMaps,
      );
    return this.factory.getDeclarationName(node, NameOptions.AllowSourceMaps);
  }

  /** `"A"` for the member `A`. */
  private getExpressionForPropertyName(member: EnumMember): Node {
    const factory = this.factory;
    const name = member.name;
    if (name instanceof PrivateIdentifier) return factory.createIdentifier('');
    if (name instanceof ComputedPropertyName) return this.visitNode(name.expression)!;
    if (name instanceof Identifier) return factory.createStringLiteral(name.text, TokenFlags.None);
    if (name instanceof StringLiteral) return factory.createStringLiteral(name.text, TokenFlags.None);
    if (name instanceof NumericLiteral) return factory.createNumericLiteral(name.text);
    return name;
  }

  /** `E["A"]` */
  private getEnumQualifiedElement(enumDeclaration: EnumDeclaration, member: EnumMember): Node {
    const name = this.getExpressionForPropertyName(member);
    const element = this.factory.createElementAccessExpression(this.getNamespaceContainerName(enumDeclaration), name);
    this.context.assignCommentAndSourceMapRanges(element, name);
    this.context.addEmitFlags(
      element,
      EmitFlags.NoComments | EmitFlags.NoNestedComments | EmitFlags.NoSourceMap | EmitFlags.NoNestedSourceMaps,
    );
    return element;
  }

  // Enums and namespaces

  /** Adds `var name;` before the first declaration of a name in its scope; true if added. */
  private addVarForDeclaration(statements: Node[], node: Node): boolean {
    this.recordDeclarationInScope(node);
    if (!this.isFirstDeclarationInScope(node)) return false;
    const factory = this.factory;
    const context = this.context;
    const declaration = factory.createVariableDeclaration(
      factory.getLocalName(node, NameOptions.AllowSourceMaps),
      undefined,
      undefined,
      undefined,
    );
    const list = factory.createVariableDeclarationList(
      factory.createNodeList([declaration]),
      isSameNode(this.currentScope, this.currentSourceFile) ? NodeFlags.None : NodeFlags.Let,
    );
    let mask = ~(typeScriptModifiers | ModifierFlags.Decorator);
    if (this.currentNamespace !== undefined) mask &= ~ModifierFlags.Export;
    const statement = factory.createVariableStatement(this.extractModifiers(modifiersOf(node), mask), list);
    context.setOriginal(declaration, node);
    context.setOriginal(statement, node);
    if (node instanceof EnumDeclaration) context.setSourceMapRange(list, node.pos, node.end);
    else context.setSourceMapRange(statement, node.pos, node.end);
    // Trailing comments of the declaration go after the function closure instead.
    context.setCommentRange(statement, node.pos, node.end);
    context.addEmitFlags(statement, EmitFlags.NoTrailingComments);
    statements.push(statement);
    return true;
  }

  /** `(function (name) { body })(name || (name = {}))`, with `ns.name` for namespace exports. */
  private createContainerStatement(node: Node, nameNode: Node, body: Block, varAdded: boolean): Node {
    const factory = this.factory;
    const context = this.context;
    let argument: Node = factory.createLogicalOr(
      this.getExportQualifiedReferenceToDeclaration(node),
      factory.createAssignment(
        this.getExportQualifiedReferenceToDeclaration(node),
        factory.createObjectLiteral([], false),
      ),
    );
    if (this.isExportOfNamespace(node))
      argument = factory.createAssignment(factory.getLocalName(node, NameOptions.AllowSourceMaps), argument);
    const parameterName = factory.createGeneratedNameForNode(node, 0, '', '');
    context.setSourceMapRange(parameterName, nameNode.pos, nameNode.end);
    const fn = factory.createFunctionExpression([factory.createParameter(parameterName)], body);
    const call = factory.createCallExpression(factory.createParenthesizedExpression(fn), [argument]);
    const statement = factory.createExpressionStatement(call);
    context.setOriginal(statement, node);
    context.assignCommentAndSourceMapRanges(statement, node);
    // The leading comments went to `var name;`; System modules keep them at the top level.
    if (
      varAdded &&
      (getEmitModuleKind(this.options) !== ModuleKind.System || !isSameNode(this.currentScope, this.currentSourceFile))
    )
      context.addEmitFlags(statement, EmitFlags.NoLeadingComments);
    return statement;
  }

  private visitEnumDeclaration(node: EnumDeclaration): Node {
    if (hasSyntacticModifier(node, ModifierFlags.Const) && !shouldPreserveConstEnums(this.options))
      return this.notEmitted(node);
    const statements: Node[] = [];
    const varAdded = this.addVarForDeclaration(statements, node);
    statements.push(this.createContainerStatement(node, node.name, this.transformEnumBody(node), varAdded));
    return this.factory.createSyntaxList(statements);
  }

  private transformEnumBody(node: EnumDeclaration): Block {
    const saved = this.currentEnum;
    this.currentEnum = node;
    // References to other members become `E.A`.
    const visited = this.visitEachChild(node);
    const enumDeclaration = visited instanceof EnumDeclaration ? (visited as EnumDeclaration) : node;
    const statements: Node[] = [];
    const members = enumDeclaration.members.nodes;
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      if (member instanceof EnumMember)
        statements.push(this.transformEnumMember(enumDeclaration, member as EnumMember));
    }
    this.currentEnum = saved;
    return this.factory.created(
      new Block(new NodeList(enumDeclaration.members.pos, enumDeclaration.members.end, statements), true),
    );
  }

  /** `E[E["A"] = 0] = "A";` or `E["A"] = "a";` */
  private transformEnumMember(enumDeclaration: EnumDeclaration, member: EnumMember): Node {
    const factory = this.factory;
    const context = this.context;
    const savedParent = this.parentNode;
    this.parentNode = this.currentNode;
    this.currentNode = member;
    let expression = member.initializer;
    let reverseMapping: boolean;
    const parseNode = context.parseNode(member);
    const value = parseNode !== undefined ? this.resolver.getEnumMemberValue(parseNode) : undefined;
    if (value !== undefined && value.kind === ConstantKind.Number) {
      expression = constantExpression(factory, value);
      reverseMapping = true;
    } else if (value !== undefined && value.kind === ConstantKind.String) {
      expression = constantExpression(factory, value);
      reverseMapping = false;
    } else {
      if (expression === undefined) expression = factory.createVoidZero();
      reverseMapping = value === undefined || !value.isSyntacticallyString;
    }
    let assignment: Node = factory.createAssignment(this.getEnumQualifiedElement(enumDeclaration, member), expression);
    if (reverseMapping)
      assignment = factory.createAssignment(
        factory.createElementAccessExpression(this.getNamespaceContainerName(enumDeclaration), assignment),
        this.getExpressionForPropertyName(member),
      );
    const statement = factory.createExpressionStatement(assignment);
    context.assignCommentAndSourceMapRanges(assignment, member);
    context.assignCommentAndSourceMapRanges(statement, member);
    this.currentNode = this.parentNode;
    this.parentNode = savedParent;
    return statement;
  }

  private visitModuleDeclaration(node: ModuleDeclaration): Node {
    const parseNode = this.context.parseNode(node);
    if (
      parseNode instanceof ModuleDeclaration &&
      !isInstantiatedModule(parseNode as ModuleDeclaration, shouldPreserveConstEnums(this.options))
    )
      return this.notEmitted(node);
    const statements: Node[] = [];
    const varAdded = this.addVarForDeclaration(statements, node);
    statements.push(this.createContainerStatement(node, node.name, this.transformModuleBody(node), varAdded));
    return this.factory.createSyntaxList(statements);
  }

  private transformModuleBody(node: ModuleDeclaration): Block {
    const context = this.context;
    const savedNamespace = this.currentNamespace;
    const savedScope = this.currentScope;
    const savedDeclarations = this.firstDeclarations;
    this.currentNamespace = node;
    this.firstDeclarations = undefined;
    context.startVariableEnvironment();
    let statements: Node[] = [];
    let statementsPos = 0;
    let statementsEnd = 0;
    let blockPos = -1;
    let blockEnd = -1;
    const body = node.body;
    if (body instanceof ModuleBlock) {
      // Visited first, so that references to namespace members become `ns.x`.
      const visited = this.visitEachChild(node);
      const visitedBody = visited instanceof ModuleDeclaration ? visited.body : undefined;
      if (visitedBody instanceof ModuleBlock) {
        statements = visitedBody.statements.nodes;
        statementsPos = visitedBody.statements.pos;
        statementsEnd = visitedBody.statements.end;
        blockPos = visitedBody.pos;
        blockEnd = visitedBody.end;
      }
    } else if (body !== undefined) {
      statements = this.visitArray([body]);
      const innermost = getInnermostModuleDeclaration(node).body;
      if (innermost instanceof ModuleBlock) {
        statementsPos = -1;
        statementsEnd = innermost.statements.end;
      }
    }
    this.currentNamespace = savedNamespace;
    this.currentScope = savedScope;
    this.firstDeclarations = savedDeclarations;
    const merged = context.mergeEnvironment(statements, context.endVariableEnvironment());
    const block = this.factory.created(new Block(new NodeList(statementsPos, statementsEnd, merged), true));
    block.pos = blockPos;
    block.end = blockEnd;
    // `namespace a.b {}`: comments belong to the innermost namespace only.
    if (!(body instanceof ModuleBlock)) context.addEmitFlags(block, EmitFlags.NoComments);
    return block;
  }

  /** `var x = a.b;`, or `ns.x = a.b;` for a namespace export. */
  private visitImportEqualsDeclaration(node: ImportEqualsDeclaration): Node | undefined {
    if (node.moduleReference instanceof ExternalModuleReference) return this.visitEachChild(node);
    const factory = this.factory;
    const context = this.context;
    const reference = factory.createExpressionFromEntityName(node.moduleReference);
    context.setEmitFlags(reference, EmitFlags.NoComments | EmitFlags.NoNestedComments);
    if (this.isExportOfNamespace(node)) {
      const statement = this.createExportStatement(node.name, reference, node.pos, node.end, node.pos, node.end, node);
      statement.pos = node.pos;
      statement.end = node.end;
      return statement;
    }
    const declaration = factory.createVariableDeclaration(node.name, undefined, undefined, reference);
    context.setOriginal(declaration, node);
    const statement = factory.createVariableStatement(
      this.extractModifiers(node.modifiers, ModifierFlags.Export),
      factory.createVariableDeclarationList(factory.createNodeList([declaration]), NodeFlags.None),
    );
    context.setOriginal(statement, node);
    context.assignCommentAndSourceMapRanges(statement, node);
    return statement;
  }

  /** In a namespace, `export var x = 1` becomes `ns.x = 1`. */
  private visitVariableStatement(node: VariableStatement): Node | undefined {
    if (!this.isExportOfNamespace(node)) return this.visitEachChild(node);
    const expressions: Node[] = [];
    const declarations = node.declarationList.declarations.nodes;
    for (let i = 0; i < declarations.length; i++) {
      const declaration = declarations[i];
      if (!(declaration instanceof VariableDeclaration) || declaration.initializer === undefined) continue;
      if (declaration.name instanceof BindingPattern)
        expressions.push(
          flattenDestructuringAssignment(this, this.visitNode(declaration)!, false, this.namespaceExports),
        );
      else {
        const assignment = convertVariableDeclarationToAssignment(this, declaration);
        if (assignment !== undefined) expressions.push(assignment);
      }
    }
    if (expressions.length === 0) return undefined;
    const statement = this.factory.createExpressionStatement(this.factory.inlineExpressions(expressions)!);
    this.context.setOriginal(statement, node);
    this.context.assignCommentAndSourceMapRanges(statement, node);
    // Visited as the new node, so that the assigned names become `ns.x`.
    const saved = this.currentNode;
    this.currentNode = statement;
    const visited = this.visitEachChild(statement);
    this.currentNode = saved;
    return visited;
  }

  /** `ns.x = value` for a flattened destructuring of a namespace export. */
  createNamespaceExportExpression(name: Identifier, value: Node, pos: number, end: number): Node {
    const member = this.factory.getNamespaceMemberName(
      this.getCurrentNamespaceName()!,
      name,
      NameOptions.AllowSourceMaps,
    );
    const expression = this.factory.createAssignment(member, value);
    expression.pos = pos | 0;
    expression.end = end | 0;
    return expression;
  }

  private visitFunctionDeclaration(node: FunctionDeclaration): Node | undefined {
    if (!this.isExportOfNamespace(node)) return this.visitEachChild(node);
    const name = this.visitNode(node.name);
    const updated: Node = this.factory.updateFunctionDeclaration(
      node,
      this.visitModifiers(this.extractModifiers(node.modifiers, ~ModifierFlags.Export)),
      node.asteriskToken,
      name instanceof Identifier ? (name as Identifier) : undefined,
      undefined,
      this.visitNodes(node.parameters)!,
      undefined,
      undefined,
      this.visitNode(node.body),
    );
    return this.factory.createSyntaxList([updated, this.createExportStatementForDeclaration(node)]);
  }

  private visitClassDeclaration(node: ClassDeclaration): Node {
    const exported = this.isExportOfNamespace(node);
    const modifiers = exported
      ? this.visitModifiers(this.extractModifiers(node.modifiers, ~exportDefault))
      : this.visitModifiers(node.modifiers);
    const visitedName = this.visitNode(node.name);
    let name = visitedName instanceof Identifier ? (visitedName as Identifier) : undefined;
    if (
      name === undefined &&
      (exported ||
        childIsDecorated(this.options.experimentalDecorators === true, node.members) ||
        ((modifierFlagsOf(node) & exportDefault) !== exportDefault &&
          nodeIsDecorated(this.options.experimentalDecorators === true, node, undefined, undefined)))
    )
      name = this.factory.createGeneratedNameForNode(node, 0, '', '');
    const updated: Node = this.factory.updateClassDeclaration(
      node,
      modifiers,
      name,
      undefined,
      this.visitNodes(node.heritageClauses),
      this.classMembers(node.members),
    );
    if (!exported) return updated;
    return this.factory.createSyntaxList([updated, this.createExportStatementForDeclaration(node)]);
  }

  /** `ns.f = f;` after an exported function or class of a namespace. */
  private createExportStatementForDeclaration(node: Node): Node {
    const factory = this.factory;
    const context = this.context;
    const expression = factory.createAssignment(
      factory.getExternalModuleOrNamespaceExportName(this.getCurrentNamespaceName(), node, NameOptions.AllowSourceMaps),
      factory.getLocalName(node, NameOptions.None),
    );
    const name = getName(node);
    context.setSourceMapRange(expression, name !== undefined ? name.pos : node.pos, node.end);
    const statement = factory.createExpressionStatement(expression);
    context.setSourceMapRange(statement, -1, node.end);
    return statement;
  }

  private createExportStatement(
    name: Identifier,
    value: Node,
    assignmentPos: number,
    assignmentEnd: number,
    statementPos: number,
    statementEnd: number,
    original: Node,
  ): Node {
    const factory = this.factory;
    const context = this.context;
    const assignment = factory.createAssignment(
      factory.getNamespaceMemberName(this.getCurrentNamespaceName()!, name, NameOptions.AllowSourceMaps),
      value,
    );
    context.setOriginal(assignment, original);
    context.setSourceMapRange(assignment, assignmentPos, assignmentEnd);
    const statement = factory.createExpressionStatement(assignment);
    context.setOriginal(statement, original);
    context.setSourceMapRange(statement, statementPos, statementEnd);
    return statement;
  }

  // References

  private visitShorthandPropertyAssignment(node: ShorthandPropertyAssignment): Node {
    const factory = this.factory;
    const name = node.name;
    const reference = name instanceof Identifier ? this.visitExpressionIdentifier(name) : name;
    if (reference !== name) {
      let expression = reference;
      if (node.objectAssignmentInitializer !== undefined) {
        const equals = node.equalsToken !== undefined ? node.equalsToken : factory.createToken(SyntaxKind.EqualsToken);
        expression = factory.created(
          new BinaryExpression(
            undefined,
            expression,
            undefined,
            equals,
            this.visitNode(node.objectAssignmentInitializer)!,
          ),
        );
      }
      const updated = factory.createPropertyAssignment(name, expression);
      updated.pos = node.pos;
      updated.end = node.end;
      this.context.setOriginal(updated, node);
      this.context.assignCommentAndSourceMapRanges(updated, node);
      return updated;
    }
    return factory.updateShorthandPropertyAssignment(
      node,
      undefined,
      name,
      undefined,
      undefined,
      node.equalsToken,
      this.visitNode(node.objectAssignmentInitializer),
    );
  }

  /** `ns.x` for a reference to an export of an enclosing namespace or enum. */
  private visitExpressionIdentifier(node: Identifier): Node {
    if (this.currentEnum === undefined && this.currentNamespace === undefined) return node;
    const context = this.context;
    if (context.hasAutoGenerateInfo(node) || (context.getEmitFlags(node) & EmitFlags.LocalName) !== 0) return node;
    const location = context.mostOriginal(node);
    if (!(location instanceof Identifier) || (location.flags & NodeFlags.Synthesized) !== 0) return node;
    const container = this.resolver.getReferencedExportContainer(location as Identifier, false);
    if (!(container instanceof EnumDeclaration || container instanceof ModuleDeclaration)) return node;
    const member = this.factory.cloneIdentifier(node);
    context.setEmitFlags(member, EmitFlags.NoComments | EmitFlags.NoSourceMap);
    const expression = this.factory.getNamespaceMemberName(
      this.getNamespaceContainerName(container),
      member,
      NameOptions.AllowSourceMaps,
    );
    context.assignCommentAndSourceMapRanges(expression, node);
    return expression;
  }

  // Parameter properties

  /** The visited members, with a field declaration for each parameter property first. */
  private classMembers(members: NodeList): NodeList {
    const visited = this.visitNodes(members)!;
    const properties = parameterProperties(members);
    if (properties.length === 0) return visited;
    const fields: Node[] = [];
    for (let i = 0; i < properties.length; i++) {
      const name = properties[i].name;
      if (!(name instanceof Identifier)) continue;
      const field = this.factory.created(
        new PropertyDeclaration(undefined, this.factory.cloneIdentifier(name), undefined, undefined, undefined),
      );
      this.context.setOriginal(field, properties[i]);
      fields.push(field);
    }
    if (fields.length === 0) return visited;
    return new NodeList(members.pos, members.end, fields.concat(visited.nodes));
  }

  private visitConstructor(node: ConstructorDeclaration): Node {
    const modifiers = this.visitModifiers(node.modifiers);
    const parameters = this.visitParameters(node.parameters)!;
    const body = node.body;
    const visitedBody =
      body instanceof Block && parameterPropertiesOf(node).length > 0
        ? this.visitConstructorBody(body as Block, node)
        : this.visitFunctionBody(body);
    return this.factory.updateConstructorDeclaration(
      node,
      modifiers,
      undefined,
      parameters,
      undefined,
      undefined,
      visitedBody,
    );
  }

  private visitConstructorBody(body: Block, constructor: ConstructorDeclaration): Node {
    const factory = this.factory;
    const context = this.context;
    context.startVariableEnvironment();
    const nodes = body.statements.nodes;
    let prologueEnd = 0;
    while (prologueEnd < nodes.length && isPrologueDirective(nodes[prologueEnd])) prologueEnd++;
    const statements: Node[] = nodes.slice(0, prologueEnd);
    const rest = nodes.slice(prologueEnd);
    const assignments: Node[] = [];
    const properties = parameterPropertiesOf(constructor);
    for (let i = 0; i < properties.length; i++) {
      const name = properties[i].name;
      if (!(name instanceof Identifier)) continue;
      const propertyName = factory.cloneIdentifier(name);
      propertyName.parent = name.parent;
      context.addEmitFlags(propertyName, EmitFlags.NoComments | EmitFlags.NoSourceMap);
      const localName = factory.cloneIdentifier(name);
      localName.parent = name.parent;
      context.addEmitFlags(localName, EmitFlags.NoComments);
      const assignment = factory.createExpressionStatement(
        factory.createAssignment(
          factory.created(
            new PropertyAccessExpression(
              factory.created(new KeywordExpression(SyntaxKind.ThisKeyword)),
              undefined,
              propertyName,
              NodeFlags.None,
            ),
          ),
          localName,
        ),
      );
      context.setOriginal(assignment, properties[i]);
      context.addEmitFlags(assignment, EmitFlags.StartOnNewLine);
      assignments.push(assignment);
    }
    const superPath = findSuperStatementIndexPath(rest);
    if (superPath.length > 0) appendAll(statements, this.withInitializersAfterSuper(rest, superPath, 0, assignments));
    else {
      appendAll(statements, assignments);
      appendAll(statements, this.visitArray(rest));
    }
    const merged = context.mergeEnvironment(statements, context.endVariableEnvironment());
    const updated = factory.created(new Block(new NodeList(body.statements.pos, body.statements.end, merged), true));
    context.setOriginal(updated, body);
    updated.pos = body.pos;
    updated.end = body.end;
    return updated;
  }

  private withInitializersAfterSuper(
    statements: Node[],
    superPath: number[],
    depth: number,
    initializers: Node[],
  ): Node[] {
    const index = superPath[depth] | 0;
    const result = this.visitArray(statements.slice(0, index));
    const superStatement: Node | undefined = statements[index];
    if (superStatement === undefined) return result;
    if (superStatement instanceof TryStatement) {
      const tryStatement = superStatement;
      const tryBlock = tryStatement.tryBlock;
      const inner = this.withInitializersAfterSuper(tryBlock.statements.nodes, superPath, depth + 1, initializers);
      const visitedCatch = this.visitNode(tryStatement.catchClause);
      const visitedFinally = this.visitNode(tryStatement.finallyBlock);
      const updated: Node | undefined = this.factory.updateTryStatement(
        tryStatement,
        this.factory.updateBlock(
          tryBlock,
          new NodeList(tryBlock.statements.pos, tryBlock.statements.end, inner),
          tryBlock.multiLine,
        ),
        visitedCatch instanceof CatchClause ? (visitedCatch as CatchClause) : undefined,
        visitedFinally instanceof Block ? (visitedFinally as Block) : undefined,
      );
      if (updated !== undefined) result.push(updated);
    } else {
      appendAll(result, this.visitArray([superStatement]));
      appendAll(result, initializers);
    }
    appendAll(result, this.visitArray(statements.slice(index + 1)));
    return result;
  }
}

function appendAll(target: Node[], source: readonly Node[]): Node[] {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
  return target;
}

function parameterProperties(members: NodeList): ParameterDeclaration[] {
  const nodes = members.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const member = nodes[i];
    if (member instanceof ConstructorDeclaration) return parameterPropertiesOf(member as ConstructorDeclaration);
  }
  return [];
}

function parameterPropertiesOf(constructor: ConstructorDeclaration): ParameterDeclaration[] {
  const result: ParameterDeclaration[] = [];
  const parameters = constructor.parameters.nodes;
  for (let i = 0; i < parameters.length; i++) {
    const parameter = parameters[i];
    if (parameter instanceof ParameterDeclaration && isParameterPropertyDeclaration(parameter, constructor))
      result.push(parameter as ParameterDeclaration);
  }
  return result;
}

/** Indexes of the `super()` statement, descending into `try` blocks; empty if there is none. */
function findSuperStatementIndexPath(statements: readonly Node[]): number[] {
  const path: number[] = [];
  return findSuperStatement(statements, path) ? path : [];
}

function findSuperStatement(statements: readonly Node[], path: number[]): boolean {
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (isSuperCallStatement(statement)) {
      path.push(i);
      return true;
    }
    if (statement instanceof TryStatement) {
      path.push(i);
      if (findSuperStatement(statement.tryBlock.statements.nodes, path)) return true;
      path.pop();
    }
  }
  return false;
}

function isSuperCallStatement(statement: Node): boolean {
  if (!(statement instanceof ExpressionStatement)) return false;
  let expression = statement.expression;
  while (expression instanceof ParenthesizedExpression) expression = expression.expression;
  return expression instanceof CallExpression && expression.expression.kind === SyntaxKind.SuperKeyword;
}

/** Whether a class member, or a parameter of one, has decorators that apply, as tsgo's `ChildIsDecorated`. */
function childIsDecorated(legacy: boolean, members: NodeList): boolean {
  const nodes = members.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const member = nodes[i];
    if (hasDecorators(member) && memberCanBeDecorated(legacy, member)) return true;
    if (legacy && hasDecoratedParameter(member)) return true;
  }
  return false;
}

function hasDecoratedParameter(member: Node): boolean {
  if (
    member.kind !== SyntaxKind.MethodDeclaration &&
    member.kind !== SyntaxKind.SetAccessor &&
    member.kind !== SyntaxKind.Constructor
  )
    return false;
  const parameters = getParameters(member);
  if (parameters === undefined || getBody(member) === undefined) return false;
  for (let j = 0; j < parameters.nodes.length; j++) if (hasDecorators(parameters.nodes[j])) return true;
  return false;
}

function memberCanBeDecorated(legacy: boolean, member: Node): boolean {
  if (legacy && getName(member) instanceof PrivateIdentifier) return false;
  switch (member.kind) {
    case SyntaxKind.PropertyDeclaration:
      return legacy || !hasSyntacticModifier(member, ModifierFlags.Abstract | ModifierFlags.Ambient);
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodDeclaration:
      return getBody(member) !== undefined;
  }
  return false;
}

/** Assigns flattened namespace exports as `ns.x = value`. */
class NamespaceExportAssignments extends AssignmentFactory {
  readonly transformer: RuntimeSyntax;

  constructor(transformer: RuntimeSyntax) {
    super();
    this.transformer = transformer;
  }

  createAssignment(name: Identifier, value: Node, pos: number, end: number): Node {
    return this.transformer.createNamespaceExportExpression(name, value, pos, end);
  }
}

/** The literal for a constant: `1`, `-1`, `"a"`, `Infinity` or `NaN`. */
export function constantExpression(factory: NodeFactory, value: Evaluation): Node {
  if (value.kind === ConstantKind.String) return factory.createStringLiteral(value.string, TokenFlags.None);
  return numberExpression(factory, value.number);
}

function numberExpression(factory: NodeFactory, value: number): Node {
  if (value === Infinity) return factory.createIdentifier('Infinity');
  if (value === -Infinity)
    return factory.createPrefixUnaryExpression(SyntaxKind.MinusToken, factory.createIdentifier('Infinity'));
  if (value !== value) return factory.createIdentifier('NaN');
  if (value < 0) return factory.createPrefixUnaryExpression(SyntaxKind.MinusToken, numberExpression(factory, -value));
  return factory.createNumericLiteral(String(value));
}

function modifiersOf(node: Node): ModifierList | undefined {
  if (node instanceof EnumDeclaration) return node.modifiers;
  if (node instanceof ModuleDeclaration) return node.modifiers;
  return undefined;
}
