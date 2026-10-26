// ES2017 async functions: the body becomes a generator run by `__awaiter`, with `await` as
// `yield`, and `this`, `arguments` and `super` accesses captured outside of the generator.
import {
  ArrowFunction,
  BindingPattern,
  Block,
  CatchClause,
  ConstructorDeclaration,
  ForInOrOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  Identifier,
  MethodDeclaration,
  type Node,
  NodeFlags,
  type NodeList,
  ParameterDeclaration,
  SetAccessorDeclaration,
  SourceFile,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  YieldExpression,
  getBody,
  getName,
  getParameters,
  ArrayLiteralExpression,
  SpreadElement,
  AwaitExpression,
  QualifiedName,
  Token,
  getLabel,
  getPropertyName,
} from '../ast.js';
import { createAwaiterHelper, advancedAsyncSuperHelper, asyncSuperHelper } from '../printer/async-helpers.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { SyntaxKind } from '../syntax-kind.js';
import {
  FunctionFlags,
  SuperAccess,
  getFunctionFlags,
  isFunctionLikeDeclaration,
  isSimpleParameterList,
} from './async-utilities.js';
import { convertBindingNameToTarget } from './destructuring.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { VisitorBase } from './visitor-base.js';

const enum ContextFlags {
  None = 0,
  NonTopLevel = 1 << 0,
  HasLexicalThis = 1 << 1,
}

const enum Mode {
  /** Statements of an async body, where `var`s colliding with parameters are hoisted. */
  AsyncBody,
  /** Subtrees without `await`, where only `arguments` and `super` are rewritten. */
  Fallback,
}

class AsyncModeVisitor extends VisitorBase {
  readonly owner: AsyncFunctions;
  readonly mode: Mode;

  constructor(owner: AsyncFunctions, mode: Mode) {
    super(owner.context);
    this.owner = owner;
    this.mode = mode;
  }

  visit(node: Node): Node | undefined {
    return this.mode === Mode.AsyncBody ? this.owner.visitAsyncBodyNode(node) : this.owner.fallback(node);
  }
}

export class AsyncFunctions extends Transformer {
  private readonly facts: SyntaxFacts;
  private readonly superAccess: SuperAccess;
  private readonly asyncBodyVisitor: AsyncModeVisitor;
  private readonly fallbackVisitor: AsyncModeVisitor;
  private contextFlags: ContextFlags;
  private enclosingFunctionParameterNames: string[] | undefined;
  /** The `_arguments` binding of the enclosing async function, if any. */
  private argumentsBinding: Identifier | undefined;
  private argumentsUsed: boolean;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
    this.superAccess = new SuperAccess(context);
    this.asyncBodyVisitor = new AsyncModeVisitor(this, Mode.AsyncBody);
    this.fallbackVisitor = new AsyncModeVisitor(this, Mode.Fallback);
    this.contextFlags = ContextFlags.None;
    this.enclosingFunctionParameterNames = undefined;
    this.argumentsBinding = undefined;
    this.argumentsUsed = false;
  }

  visit(node: Node): Node | undefined {
    if (
      (this.context.getEmitFlags(node) & EmitFlags.NoLexicalThis) !== 0 &&
      (this.contextFlags & ContextFlags.HasLexicalThis) !== 0
    ) {
      this.contextFlags &= ~ContextFlags.HasLexicalThis;
      const result = this.visitWorker(node);
      this.contextFlags |= ContextFlags.HasLexicalThis;
      return result;
    }
    return this.visitWorker(node);
  }

  private visitWorker(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsAnyAwait | SubtreeFacts.ContainsAwait)) return this.fallback(node);
    this.superAccess.track(node);
    switch (node.kind) {
      case SyntaxKind.AsyncKeyword:
        return undefined;
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) return this.visitSourceFile(node);
        break;
      case SyntaxKind.AwaitExpression:
        if (node instanceof AwaitExpression) return this.visitAwaitExpression(node);
        break;
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression: {
        const flags =
          node.kind === SyntaxKind.ArrowFunction
            ? ContextFlags.NonTopLevel
            : ContextFlags.NonTopLevel | ContextFlags.HasLexicalThis;
        const added = flags & ~this.contextFlags;
        this.contextFlags |= added;
        const result = this.visitFunctionOrClass(node);
        this.contextFlags &= ~added;
        return result;
      }
    }
    return this.visitEachChild(node);
  }

  private visitFunctionOrClass(node: Node): Node {
    if (node instanceof MethodDeclaration) return this.visitMethodDeclaration(node as MethodDeclaration);
    if (node instanceof FunctionDeclaration) return this.visitFunctionDeclaration(node as FunctionDeclaration);
    if (node instanceof FunctionExpression) return this.visitFunctionExpression(node as FunctionExpression);
    if (node instanceof ArrowFunction) return this.visitArrowFunction(node as ArrowFunction);
    if (node instanceof GetAccessorDeclaration) return this.visitGetAccessor(node as GetAccessorDeclaration);
    if (node instanceof SetAccessorDeclaration) return this.visitSetAccessor(node as SetAccessorDeclaration);
    if (node instanceof ConstructorDeclaration) return this.visitConstructor(node as ConstructorDeclaration);
    return this.visitEachChild(node);
  }

  /** Rewrites `arguments` and `super` in subtrees without `await`, when inside an async body. */
  fallback(node: Node): Node | undefined {
    if (this.superAccess.capturedSuperProperties === undefined && this.argumentsBinding === undefined) return node;
    this.superAccess.track(node);
    switch (node.kind) {
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
        return node;
      case SyntaxKind.Identifier:
        if (
          this.argumentsBinding !== undefined &&
          node instanceof Identifier &&
          node.text === 'arguments' &&
          !isIdentifierNameOrLabel(node)
        ) {
          this.argumentsUsed = true;
          return this.argumentsBinding;
        }
        break;
    }
    return this.fallbackVisitor.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    if (node.isDeclarationFile) return node;
    this.contextFlags &= ~(ContextFlags.NonTopLevel | ContextFlags.HasLexicalThis);
    const visited = this.visitEachChild(node);
    const helpers = this.context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) this.context.addEmitHelper(visited, helpers[i]);
    return visited;
  }

  // Async bodies

  visitAsyncBodyNode(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.VariableStatement:
        if (node instanceof VariableStatement) return this.visitVariableStatementInAsyncBody(node);
        break;
      case SyntaxKind.ForStatement:
        if (node instanceof ForStatement) return this.visitForStatementInAsyncBody(node);
        break;
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
        if (node instanceof ForInOrOfStatement) return this.visitForInOrOfStatementInAsyncBody(node);
        break;
      case SyntaxKind.CatchClause:
        if (node instanceof CatchClause) return this.visitCatchClauseInAsyncBody(node);
        break;
      case SyntaxKind.Block:
      case SyntaxKind.SwitchStatement:
      case SyntaxKind.CaseBlock:
      case SyntaxKind.CaseClause:
      case SyntaxKind.DefaultClause:
      case SyntaxKind.TryStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.IfStatement:
      case SyntaxKind.WithStatement:
      case SyntaxKind.LabeledStatement:
        return this.asyncBodyVisitor.visitEachChild(node);
    }
    return this.visit(node);
  }

  private visitCatchClauseInAsyncBody(node: CatchClause): Node {
    const names: string[] = [];
    if (node.variableDeclaration !== undefined) recordDeclarationName(node.variableDeclaration, names);
    // Names declared by a catch variable are block scoped.
    let unshadowed: string[] | undefined = undefined;
    const enclosing = this.enclosingFunctionParameterNames;
    for (let i = 0; i < names.length; i++) {
      if (enclosing !== undefined && enclosing.indexOf(names[i]) >= 0) {
        if (unshadowed === undefined) unshadowed = enclosing.slice();
        const at = unshadowed.indexOf(names[i]);
        if (at >= 0) unshadowed.splice(at, 1);
      }
    }
    if (unshadowed === undefined) return this.asyncBodyVisitor.visitEachChild(node);
    this.enclosingFunctionParameterNames = unshadowed;
    const result = this.asyncBodyVisitor.visitEachChild(node);
    this.enclosingFunctionParameterNames = enclosing;
    return result;
  }

  private visitVariableStatementInAsyncBody(node: VariableStatement): Node | undefined {
    const list = node.declarationList;
    if (this.isVariableDeclarationListWithCollidingName(list)) {
      const expression = this.visitVariableDeclarationListWithCollidingNames(list, false);
      return expression !== undefined ? this.factory.createExpressionStatement(expression) : undefined;
    }
    return this.visitEachChild(node);
  }

  private visitForInOrOfStatementInAsyncBody(node: ForInOrOfStatement): Node {
    const initializer = node.initializer;
    const visitedInitializer =
      initializer instanceof VariableDeclarationList &&
      this.isVariableDeclarationListWithCollidingName(initializer as VariableDeclarationList)
        ? this.visitVariableDeclarationListWithCollidingNames(initializer as VariableDeclarationList, true)!
        : this.visitNode(initializer)!;
    return this.factory.updateForInOrOfStatement(
      node,
      node.kind === SyntaxKind.ForOfStatement ? asToken(this.visitNode(node.awaitModifier)) : undefined,
      visitedInitializer,
      this.visitNode(node.expression)!,
      this.asyncBodyVisitor.visitEmbeddedStatement(node.statement)!,
    );
  }

  private visitForStatementInAsyncBody(node: ForStatement): Node {
    const initializer = node.initializer;
    const visitedInitializer =
      initializer instanceof VariableDeclarationList &&
      this.isVariableDeclarationListWithCollidingName(initializer as VariableDeclarationList)
        ? this.visitVariableDeclarationListWithCollidingNames(initializer as VariableDeclarationList, false)
        : this.visitNode(initializer);
    return this.factory.updateForStatement(
      node,
      visitedInitializer,
      this.visitNode(node.condition),
      this.visitNode(node.incrementor),
      this.asyncBodyVisitor.visitEmbeddedStatement(node.statement)!,
    );
  }

  /** `await x` as `yield x`, except at the top level, where it's module syntax. */
  private visitAwaitExpression(node: AwaitExpression): Node {
    if ((this.contextFlags & ContextFlags.NonTopLevel) === 0) return this.visitEachChild(node);
    const result = this.factory.created(new YieldExpression(undefined, this.visitNode(node.expression)));
    result.pos = node.pos;
    result.end = node.end;
    this.context.setOriginal(result, node);
    return result;
  }

  // Functions

  private visitConstructor(node: ConstructorDeclaration): Node {
    const savedBinding = this.argumentsBinding;
    const savedUsed = this.argumentsUsed;
    this.argumentsBinding = undefined;
    this.argumentsUsed = false;
    const updated = this.factory.updateConstructorDeclaration(
      node,
      this.visitModifiers(node.modifiers),
      undefined,
      this.visitParameters(node.parameters)!,
      undefined,
      undefined,
      this.transformMethodBody(node),
    );
    this.argumentsBinding = savedBinding;
    this.argumentsUsed = savedUsed;
    return updated;
  }

  private visitMethodDeclaration(node: MethodDeclaration): Node {
    const savedBinding = this.argumentsBinding;
    const savedUsed = this.argumentsUsed;
    this.argumentsBinding = undefined;
    this.argumentsUsed = false;
    let parameters: NodeList;
    let body: Node;
    if ((getFunctionFlags(node) & FunctionFlags.Async) !== 0) {
      parameters = this.transformAsyncFunctionParameterList(node);
      body = this.transformAsyncFunctionBody(node, parameters);
    } else {
      parameters = this.visitParameters(node.parameters)!;
      body = this.transformMethodBody(node);
    }
    const updated = this.factory.updateMethodDeclaration(
      node,
      this.visitModifiers(node.modifiers),
      node.asteriskToken,
      node.name,
      undefined,
      undefined,
      parameters,
      undefined,
      undefined,
      body,
    );
    this.argumentsBinding = savedBinding;
    this.argumentsUsed = savedUsed;
    return updated;
  }

  private visitGetAccessor(node: GetAccessorDeclaration): Node {
    const savedBinding = this.argumentsBinding;
    const savedUsed = this.argumentsUsed;
    this.argumentsBinding = undefined;
    this.argumentsUsed = false;
    const updated = this.factory.updateGetAccessorDeclaration(
      node,
      this.visitModifiers(node.modifiers),
      node.name,
      undefined,
      this.visitParameters(node.parameters)!,
      undefined,
      undefined,
      this.transformMethodBody(node),
    );
    this.argumentsBinding = savedBinding;
    this.argumentsUsed = savedUsed;
    return updated;
  }

  private visitSetAccessor(node: SetAccessorDeclaration): Node {
    const savedBinding = this.argumentsBinding;
    const savedUsed = this.argumentsUsed;
    this.argumentsBinding = undefined;
    this.argumentsUsed = false;
    const updated = this.factory.updateSetAccessorDeclaration(
      node,
      this.visitModifiers(node.modifiers),
      node.name,
      undefined,
      this.visitParameters(node.parameters)!,
      undefined,
      undefined,
      this.transformMethodBody(node),
    );
    this.argumentsBinding = savedBinding;
    this.argumentsUsed = savedUsed;
    return updated;
  }

  private visitFunctionDeclaration(node: FunctionDeclaration): Node {
    const savedBinding = this.argumentsBinding;
    const savedUsed = this.argumentsUsed;
    this.argumentsBinding = undefined;
    this.argumentsUsed = false;
    let parameters: NodeList;
    let body: Node | undefined;
    if ((getFunctionFlags(node) & FunctionFlags.Async) !== 0) {
      parameters = this.transformAsyncFunctionParameterList(node);
      body = this.transformAsyncFunctionBody(node, parameters);
    } else {
      parameters = this.visitParameters(node.parameters)!;
      body = this.visitFunctionBody(node.body);
    }
    const updated = this.factory.updateFunctionDeclaration(
      node,
      this.visitModifiers(node.modifiers),
      node.asteriskToken,
      asIdentifier(this.visitNode(node.name)),
      undefined,
      parameters,
      undefined,
      undefined,
      body,
    );
    this.argumentsBinding = savedBinding;
    this.argumentsUsed = savedUsed;
    return updated;
  }

  private visitFunctionExpression(node: FunctionExpression): Node {
    const savedBinding = this.argumentsBinding;
    const savedUsed = this.argumentsUsed;
    this.argumentsBinding = undefined;
    this.argumentsUsed = false;
    let parameters: NodeList;
    let body: Node;
    if ((getFunctionFlags(node) & FunctionFlags.Async) !== 0) {
      parameters = this.transformAsyncFunctionParameterList(node);
      body = this.transformAsyncFunctionBody(node, parameters);
    } else {
      parameters = this.visitParameters(node.parameters)!;
      body = this.visitFunctionBody(node.body)!;
    }
    const updated = this.factory.updateFunctionExpression(
      node,
      this.visitModifiers(node.modifiers),
      node.asteriskToken,
      asIdentifier(this.visitNode(node.name)),
      undefined,
      parameters,
      undefined,
      undefined,
      body,
    );
    this.argumentsBinding = savedBinding;
    this.argumentsUsed = savedUsed;
    return updated;
  }

  private visitArrowFunction(node: ArrowFunction): Node {
    // `arguments` in a class static block is an error; tsgo leaves it as is.
    if ((this.context.getEmitFlags(node) & EmitFlags.NoLexicalArguments) !== 0) {
      const savedBinding = this.argumentsBinding;
      const savedUsed = this.argumentsUsed;
      this.argumentsBinding = undefined;
      this.argumentsUsed = false;
      const result = this.visitArrowFunctionWorker(node);
      this.argumentsBinding = savedBinding;
      this.argumentsUsed = savedUsed;
      return result;
    }
    return this.visitArrowFunctionWorker(node);
  }

  private visitArrowFunctionWorker(node: ArrowFunction): Node {
    let parameters: NodeList;
    let body: Node;
    if ((getFunctionFlags(node) & FunctionFlags.Async) !== 0) {
      parameters = this.transformAsyncFunctionParameterList(node);
      body = this.transformAsyncFunctionBody(node, parameters);
    } else {
      parameters = this.visitParameters(node.parameters)!;
      body = this.visitFunctionBody(node.body)!;
    }
    return this.factory.updateArrowFunction(
      node,
      this.visitModifiers(node.modifiers),
      undefined,
      parameters,
      undefined,
      undefined,
      node.equalsGreaterThanToken,
      body,
    );
  }

  // Variables colliding with parameter names

  private isVariableDeclarationListWithCollidingName(node: VariableDeclarationList): boolean {
    if ((node.flags & NodeFlags.BlockScoped) !== 0) return false;
    const declarations = node.declarations.nodes;
    for (let i = 0; i < declarations.length; i++) if (this.collidesWithParameterName(declarations[i])) return true;
    return false;
  }

  private collidesWithParameterName(node: Node): boolean {
    const name = getName(node);
    if (name instanceof Identifier)
      return (
        this.enclosingFunctionParameterNames !== undefined &&
        this.enclosingFunctionParameterNames.indexOf(name.text) >= 0
      );
    if (name instanceof BindingPattern) {
      const elements = name.elements.nodes;
      for (let i = 0; i < elements.length; i++)
        if (elements[i].kind !== SyntaxKind.OmittedExpression && this.collidesWithParameterName(elements[i]))
          return true;
    }
    return false;
  }

  private visitVariableDeclarationListWithCollidingNames(
    node: VariableDeclarationList,
    hasReceiver: boolean,
  ): Node | undefined {
    const declarations = node.declarations.nodes;
    for (let i = 0; i < declarations.length; i++) this.hoistVariable(declarations[i]);
    const expressions: Node[] = [];
    for (let i = 0; i < declarations.length; i++) {
      const declaration = declarations[i];
      if (declaration instanceof VariableDeclaration && declaration.initializer !== undefined)
        expressions.push(this.transformInitializedVariable(declaration));
    }
    if (expressions.length > 0) return this.factory.inlineExpressions(expressions);
    if (!hasReceiver) return undefined;
    const name = getName(declarations[0])!;
    return this.visitNode(convertBindingNameToTarget(this, name));
  }

  private hoistVariable(node: Node): boolean {
    const name = getName(node);
    if (name instanceof Identifier) this.context.addVariableDeclaration(name as Identifier);
    else if (name instanceof BindingPattern) {
      const elements = name.elements.nodes;
      for (let i = 0; i < elements.length; i++)
        if (elements[i].kind !== SyntaxKind.OmittedExpression) this.hoistVariable(elements[i]);
    }
    return true;
  }

  private transformInitializedVariable(node: VariableDeclaration): Node {
    const converted = this.factory.createAssignment(convertBindingNameToTarget(this, node.name), node.initializer!);
    this.context.setSourceMapRange(converted, node.pos, node.end);
    return this.visitNode(converted)!;
  }

  // Bodies

  private transformMethodBody(node: Node): Node {
    const superAccess = this.superAccess;
    const saved = superAccess.enter();
    const context = this.context;
    context.startVariableEnvironment();
    let updated = this.visitFunctionBody(getBody(node)) as Block;
    // Capture `super` accesses for arrows.
    const emitSuperHelpers =
      superAccess.needsHelpers() &&
      (getFunctionFlags(this.getOriginalIfFunctionLike(node)) & FunctionFlags.AsyncGenerator) !==
        FunctionFlags.AsyncGenerator;
    if (emitSuperHelpers && superAccess.capturedSuperProperties!.length > 0)
      context.addInitializationStatement(superAccess.createSuperAccessVariableStatement());
    const merged = context.mergeEnvironmentList(updated.statements, context.endVariableEnvironment());
    if (emitSuperHelpers && superAccess.hasSuperElementAccess && !updated.multiLine) {
      const block = this.factory.created(new Block(merged, true));
      block.pos = updated.pos;
      block.end = updated.end;
      updated = block;
    } else updated = this.factory.updateBlock(updated, merged, updated.multiLine);
    if (emitSuperHelpers && superAccess.hasSuperElementAccess)
      context.addEmitHelper(
        updated,
        superAccess.hasSuperPropertyAssignment ? advancedAsyncSuperHelper : asyncSuperHelper,
      );
    superAccess.exit(saved);
    return updated;
  }

  private createCaptureArgumentsStatement(): Node {
    const factory = this.factory;
    const statement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([
          factory.createVariableDeclaration(
            this.argumentsBinding!,
            undefined,
            undefined,
            factory.createIdentifier('arguments'),
          ),
        ]),
        NodeFlags.None,
      ),
    );
    this.context.addEmitFlags(statement, EmitFlags.StartOnNewLine | EmitFlags.CustomPrologue);
    return statement;
  }

  /**
   * The outer function's parameters: the visited ones if simple, else placeholders up to the
   * first initializer or rest, which keep `length` (and, for arrows, forward the arguments).
   */
  private transformAsyncFunctionParameterList(node: Node): NodeList {
    const list = getParameters(node)!;
    if (isSimpleParameterList(list.nodes)) return this.visitParameters(list)!;
    const factory = this.factory;
    const parameters: Node[] = [];
    for (let i = 0; i < list.nodes.length; i++) {
      const parameter = list.nodes[i] as ParameterDeclaration;
      if (parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined) {
        if (node.kind === SyntaxKind.ArrowFunction)
          parameters.push(
            factory.created(
              new ParameterDeclaration(
                undefined,
                factory.createToken(SyntaxKind.DotDotDotToken),
                factory.createUniqueName('args', GeneratedIdentifierFlags.ReservedInNestedScopes),
                undefined,
                undefined,
                undefined,
              ),
            ),
          );
        break;
      }
      parameters.push(
        factory.createParameter(
          factory.createGeneratedNameForNode(parameter.name, GeneratedIdentifierFlags.ReservedInNestedScopes, '', ''),
        ),
      );
    }
    const result = factory.createNodeList(parameters);
    result.pos = list.pos;
    result.end = list.end;
    return result;
  }

  private transformAsyncFunctionBody(node: Node, outerParameters: NodeList): Node {
    const isArrow = node.kind === SyntaxKind.ArrowFunction;
    const factory = this.factory;
    const context = this.context;
    const superAccess = this.superAccess;
    const savedSuper = isArrow ? undefined : superAccess.enter();
    const parameterList = getParameters(node)!;
    const parameters = parameterList.nodes;
    let innerParameters = isSimpleParameterList(parameters) ? undefined : this.visitParameters(parameterList);

    const savedBinding = this.argumentsBinding;
    const savedUsed = this.argumentsUsed;
    const captureLexicalArguments = this.argumentsBinding === undefined;
    if (captureLexicalArguments) {
      this.argumentsBinding = factory.createUniqueName('arguments', GeneratedIdentifierFlags.None);
      this.argumentsUsed = false;
    }

    let argumentsExpression: Node | undefined = undefined;
    if (innerParameters !== undefined) {
      if (isArrow) {
        // Forward the placeholders of `transformAsyncFunctionParameterList`.
        const bindings: Node[] = [];
        for (let i = 0; i < parameters.length && i < outerParameters.nodes.length; i++) {
          const original = parameters[i] as ParameterDeclaration;
          const outer = outerParameters.nodes[i] as ParameterDeclaration;
          if (original.initializer !== undefined || original.dotDotDotToken !== undefined) {
            bindings.push(factory.created(new SpreadElement(outer.name)));
            break;
          }
          bindings.push(outer.name);
        }
        argumentsExpression = factory.created(new ArrayLiteralExpression(factory.createNodeList(bindings), false));
      } else argumentsExpression = factory.createIdentifier('arguments');
    }

    // The generator runs in the promise callback, so `this` and `arguments` are passed to `__awaiter`.
    const savedParameterNames = this.enclosingFunctionParameterNames;
    const parameterNames: string[] = [];
    for (let i = 0; i < parameters.length; i++) recordDeclarationName(parameters[i], parameterNames);
    this.enclosingFunctionParameterNames = parameterNames;
    const hasLexicalThis = (this.contextFlags & ContextFlags.HasLexicalThis) !== 0;

    let asyncBody = this.transformAsyncFunctionBodyWorker(getBody(node)!);
    asyncBody = factory.updateBlock(
      asyncBody,
      context.mergeEnvironmentList(asyncBody.statements, context.endVariableEnvironment()),
      asyncBody.multiLine,
    );

    const emitSuperHelpers = superAccess.needsHelpers();
    if (emitSuperHelpers) {
      innerParameters = superAccess.visitNodes(innerParameters);
      asyncBody = superAccess.visitNode(asyncBody) as Block;
    }

    let result: Node;
    if (!isArrow) {
      context.startVariableEnvironment();
      if (emitSuperHelpers && superAccess.capturedSuperProperties!.length > 0)
        context.addInitializationStatement(superAccess.createSuperAccessVariableStatement());
      if (captureLexicalArguments && this.argumentsUsed)
        context.addInitializationStatement(this.createCaptureArgumentsStatement());
      const statements: Node[] = [
        factory.createReturnStatement(
          createAwaiterHelper(factory, hasLexicalThis, argumentsExpression, innerParameters, asyncBody),
        ),
      ];
      const block = factory.createBlock(context.mergeEnvironment(statements, context.endVariableEnvironment()), true);
      const body = getBody(node)!;
      block.pos = body.pos;
      block.end = body.end;
      if (emitSuperHelpers && superAccess.hasSuperElementAccess)
        context.addEmitHelper(
          block,
          superAccess.hasSuperPropertyAssignment ? advancedAsyncSuperHelper : asyncSuperHelper,
        );
      result = block;
    } else {
      result = createAwaiterHelper(factory, hasLexicalThis, argumentsExpression, innerParameters, asyncBody);
      if (captureLexicalArguments && this.argumentsUsed) {
        const block = context.convertToFunctionBlock(result, true);
        if (!(result instanceof Block)) context.setOriginal(block.statements.nodes[0]!, result);
        result = factory.updateBlock(
          block,
          context.mergeEnvironmentList(block.statements, [this.createCaptureArgumentsStatement()]),
          block.multiLine,
        ) as Node;
      }
    }

    this.enclosingFunctionParameterNames = savedParameterNames;
    if (savedSuper !== undefined) {
      superAccess.exit(savedSuper);
      this.argumentsBinding = savedBinding;
      this.argumentsUsed = savedUsed;
    } else if (captureLexicalArguments && !this.argumentsUsed) {
      this.argumentsBinding = savedBinding;
      this.argumentsUsed = savedUsed;
    } else if (captureLexicalArguments) {
      // Keep the hoisted binding for sibling arrows, without capturing it again.
      this.argumentsUsed = false;
    }
    return result;
  }

  private transformAsyncFunctionBodyWorker(body: Node): Block {
    const factory = this.factory;
    if (body instanceof Block)
      return factory.updateBlock(body, this.asyncBodyVisitor.visitNodes(body.statements)!, body.multiLine);
    // An expression body becomes `{ return body; }`.
    const visited = this.asyncBodyVisitor.visitNode(body);
    const statement = factory.createReturnStatement(visited);
    statement.pos = body.pos;
    statement.end = body.end;
    const block = factory.createBlock([statement], false);
    block.statements.pos = body.pos;
    block.statements.end = body.end;
    block.pos = body.pos;
    block.end = body.end;
    return block;
  }

  private getOriginalIfFunctionLike(node: Node): Node {
    const original = this.context.mostOriginal(node);
    return isFunctionLikeDeclaration(original) ? original : node;
  }
}

function recordDeclarationName(node: Node, names: string[]): boolean {
  const name = getName(node);
  if (name instanceof Identifier) {
    if (names.indexOf(name.text) < 0) names.push(name.text);
  } else if (name instanceof BindingPattern) {
    const elements = name.elements.nodes;
    for (let i = 0; i < elements.length; i++)
      if (elements[i].kind !== SyntaxKind.OmittedExpression) recordDeclarationName(elements[i], names);
  }
  return true;
}

/** Whether an identifier is a property name or a label rather than a reference. */
function isIdentifierNameOrLabel(node: Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  switch (parent.kind) {
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.EnumMember:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyAccessExpression:
      return getName(parent) === (node as Node);
    case SyntaxKind.QualifiedName:
      return parent instanceof QualifiedName && parent.right === node;
    case SyntaxKind.BindingElement:
    case SyntaxKind.ImportSpecifier:
      return getPropertyName(parent) === (node as Node);
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.JsxAttribute:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxClosingElement:
      return true;
    case SyntaxKind.LabeledStatement:
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ContinueStatement:
      return getLabel(parent) === (node as Node);
  }
  return false;
}

function asToken(node: Node | undefined): Token | undefined {
  return node instanceof Token ? node : undefined;
}

function asIdentifier(node: Node | undefined): Identifier | undefined {
  return node instanceof Identifier ? node : undefined;
}
