// Lowers `using` and `await using` declarations, for targets before ESNext. The statements after
// the first declaration run in a `try` whose `finally` disposes the resources, and in a source
// file the declarations they need at the top level are hoisted out of it.
import {
  AwaitExpression,
  Block,
  BindingElement,
  BindingPattern,
  ClassDeclaration,
  ClassExpression,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ForInOrOfStatement,
  ForStatement,
  Identifier,
  ModifierFlags,
  NamedExports,
  type Node,
  NodeFlags,
  NodeList,
  SourceFile,
  SyntaxList,
  TryStatement,
  CatchClause,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  ArrayLiteralExpression,
} from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { NameOptions } from '../printer/factory.js';
import { isPrologueDirective } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { convertBindingNameToTarget } from './destructuring.js';
import { isNamedEvaluation, transformNamedEvaluation } from './named-evaluation.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { OuterExpressionKinds, hasSyntacticModifier, skipOuterExpressions } from './utilities.js';

const enum UsingKind {
  None = 0,
  Sync = 1,
  Async = 2,
}

export class UsingTransformer extends Transformer {
  readonly facts: SyntaxFacts;
  /** `export { x }` specifiers for hoisted exports, by local name in first-export order. */
  private exportBindings: Map<string, ExportSpecifier>;
  private exportVars: Node[];
  private defaultExportBinding: Identifier | undefined;
  private exportEqualsBinding: Identifier | undefined;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
    this.exportBindings = new Map<string, ExportSpecifier>();
    this.exportVars = [];
    this.defaultExportBinding = undefined;
    this.exportEqualsBinding = undefined;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsUsing)) return node;
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        return this.visitSourceFile(node as SourceFile);
      case SyntaxKind.Block:
        return this.visitBlock(node as Block);
      case SyntaxKind.ForStatement:
        return this.visitForStatement(node as ForStatement);
      case SyntaxKind.ForOfStatement:
        return this.visitForOfStatement(node as ForInOrOfStatement);
    }
    return this.visitEachChild(node);
  }

  /**
   * Hoists imports, exports, functions and the bindings of other top-level declarations out of
   * the `try`, keeping the statements before the first `using` in place:
   *
   *   import { w } from "mod";      import { w } from "mod";
   *   const x = expr1;              const x = expr1;
   *   using y = expr2;         ->   var y, z;
   *   const z = expr3;              const env_1 = { stack: [], error: void 0, hasError: false };
   *                                 try { y = __addDisposableResource(env_1, expr2, false); z = expr3; } ...
   */
  private visitSourceFile(node: SourceFile): Node {
    if (node.isDeclarationFile) return node;
    const factory = this.factory;
    const context = this.context;
    let visited: Node;
    const statements = node.statements.nodes;
    const usingKind = getUsingKindOfStatements(statements);
    if (usingKind !== UsingKind.None) {
      context.startVariableEnvironment();
      this.exportBindings = new Map<string, ExportSpecifier>();
      this.exportVars = [];
      const prologueEnd = getPrologueEnd(statements);
      const topLevel: Node[] = [];
      for (let i = 0; i < prologueEnd; i++) this.pushVisited(statements[i], topLevel);
      let start = prologueEnd;
      while (start < statements.length && getUsingKind(statements[start]) === UsingKind.None) start++;
      if (start >= statements.length) throw new Error("Should have encountered at least one 'using' statement.");
      for (let i = prologueEnd; i < start; i++) this.pushVisited(statements[i], topLevel);
      const env = this.createEnvBinding();
      const body = this.transformUsingDeclarations(statements.slice(start), env, topLevel);
      if (this.exportBindings.size > 0) {
        const specifiers: Node[] = [];
        for (const specifier of this.exportBindings.values()) specifiers.push(specifier);
        topLevel.push(
          factory.created(
            new ExportDeclaration(
              undefined,
              false,
              factory.created(new NamedExports(factory.createNodeList(specifiers))),
              undefined,
              undefined,
            ),
          ),
        );
      }
      const hoisted = context.endVariableEnvironment();
      for (let i = 0; i < hoisted.length; i++) topLevel.push(hoisted[i]);
      if (this.exportVars.length > 0)
        topLevel.push(
          factory.createVariableStatement(
            factory.createModifierList([factory.createToken(SyntaxKind.ExportKeyword)]),
            factory.createVariableDeclarationList(factory.createNodeList(this.exportVars.slice()), NodeFlags.Let),
          ),
        );
      const lowered = this.createDownlevelUsingStatements(body, env, usingKind === UsingKind.Async);
      for (let i = 0; i < lowered.length; i++) topLevel.push(lowered[i]);
      if (this.exportEqualsBinding !== undefined)
        topLevel.push(factory.created(new ExportAssignment(undefined, true, undefined, this.exportEqualsBinding)));
      visited = factory.updateSourceFile(node, factory.createNodeList(topLevel), node.endOfFileToken) as Node;
    } else visited = this.visitEachChild(node);
    const helpers = context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) context.addEmitHelper(visited, helpers[i]);
    this.exportVars = [];
    this.exportBindings = new Map<string, ExportSpecifier>();
    this.defaultExportBinding = undefined;
    this.exportEqualsBinding = undefined;
    return visited;
  }

  private pushVisited(statement: Node, statements: Node[]): boolean {
    const visited = this.visit(statement);
    if (visited instanceof SyntaxList)
      for (let i = 0; i < visited.children.length; i++) statements.push(visited.children[i]);
    else if (visited !== undefined) statements.push(visited);
    return true;
  }

  private visitBlock(node: Block): Node {
    const statements = node.statements.nodes;
    const usingKind = getUsingKindOfStatements(statements);
    if (usingKind === UsingKind.None) return this.visitEachChild(node);
    const prologueEnd = getPrologueEnd(statements);
    const env = this.createEnvBinding();
    const result: Node[] = [];
    for (let i = 0; i < prologueEnd; i++) this.pushVisited(statements[i], result);
    const lowered = this.createDownlevelUsingStatements(
      this.transformUsingDeclarations(statements.slice(prologueEnd), env, undefined),
      env,
      usingKind === UsingKind.Async,
    );
    for (let i = 0; i < lowered.length; i++) result.push(lowered[i]);
    return this.factory.updateBlock(
      node,
      new NodeList(node.statements.pos, node.statements.end, result),
      node.multiLine,
    );
  }

  /** `for (using x = e; c; i) s` -> `{ using x = e; for (; c; i) s }`, then lowered. */
  private visitForStatement(node: ForStatement): Node | undefined {
    const initializer = node.initializer;
    if (initializer === undefined || !isUsingVariableDeclarationList(initializer)) return this.visitEachChild(node);
    const factory = this.factory;
    return this.visitNode(
      factory.createBlock(
        [
          factory.createVariableStatement(undefined, initializer as VariableDeclarationList),
          factory.updateForStatement(node, undefined, node.condition, node.incrementor, node.statement) as Node,
        ],
        false,
      ),
    );
  }

  /** `for (using x of y) s` -> `for (const x_1 of y) { using x = x_1; s }`, then lowered. */
  private visitForOfStatement(node: ForInOrOfStatement): Node | undefined {
    if (!isUsingVariableDeclarationList(node.initializer)) return this.visitEachChild(node);
    const factory = this.factory;
    const list = node.initializer as VariableDeclarationList;
    const declarations = list.declarations.nodes;
    const declaration =
      declarations.length > 0
        ? (declarations[0] as VariableDeclaration)
        : factory.createVariableDeclaration(factory.createTempVariable(0), undefined, undefined, undefined);
    const isAwaitUsing = getUsingKindOfVariableDeclarationList(list) === UsingKind.Async;
    const temp = factory.createGeneratedNameForNode(declaration.name, 0, '', '');
    const usingStatement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([
          factory.updateVariableDeclaration(declaration, declaration.name, undefined, undefined, temp) as Node,
        ]),
        isAwaitUsing ? NodeFlags.AwaitUsing : NodeFlags.Using,
      ),
    );
    let statement: Node;
    const body = node.statement;
    if (body instanceof Block) {
      const statements: Node[] = [usingStatement];
      for (let i = 0; i < body.statements.nodes.length; i++) statements.push(body.statements.nodes[i]);
      statement = factory.updateBlock(body as Block, factory.createNodeList(statements), body.multiLine) as Node;
    } else statement = factory.createBlock([usingStatement, body], true);
    return this.visitNode(
      factory.updateForInOrOfStatement(
        node,
        node.awaitModifier,
        factory.createVariableDeclarationList(
          factory.createNodeList([factory.createVariableDeclaration(temp, undefined, undefined, undefined)]),
          NodeFlags.Const,
        ),
        node.expression,
        statement,
      ),
    );
  }

  /** The statements with each `using` declaration's values passed to `__addDisposableResource`. */
  private transformUsingDeclarations(statements: Node[], env: Identifier, topLevel: Node[] | undefined): Node[] {
    const factory = this.factory;
    const result: Node[] = [];
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const usingKind = getUsingKind(statement);
      if (usingKind !== UsingKind.None) {
        const variableStatement = statement as VariableStatement;
        const list = variableStatement.declarationList;
        let declarations: Node[] = [];
        const nodes = list.declarations.nodes;
        for (let j = 0; j < nodes.length; j++) {
          let declaration = nodes[j] as VariableDeclaration;
          // Binding patterns are a grammar error: leave the statement as it is.
          if (!(declaration.name instanceof Identifier)) {
            declarations = [];
            break;
          }
          if (isNamedEvaluation(this.context, declaration, undefined))
            declaration = transformNamedEvaluation(this.context, declaration, false, '') as VariableDeclaration;
          let initializer = this.visitNode(declaration.initializer);
          if (initializer === undefined) initializer = factory.createVoidZero();
          declarations.push(
            factory.updateVariableDeclaration(
              declaration,
              declaration.name,
              undefined,
              undefined,
              factory.createAddDisposableResourceHelper(env, initializer, usingKind === UsingKind.Async),
            ) as Node,
          );
        }
        if (declarations.length > 0) {
          const updatedList = factory.createVariableDeclarationList(
            factory.createNodeList(declarations),
            NodeFlags.Const,
          );
          this.context.setOriginal(updatedList, list);
          updatedList.pos = list.pos;
          updatedList.end = list.end;
          this.hoistOrAppend(
            factory.updateVariableStatement(variableStatement, undefined, updatedList),
            result,
            topLevel,
          );
          continue;
        }
      }
      const visited = this.visit(statement);
      if (visited instanceof SyntaxList)
        for (let j = 0; j < visited.children.length; j++) this.hoistOrAppend(visited.children[j], result, topLevel);
      else if (visited !== undefined) this.hoistOrAppend(visited, result, topLevel);
    }
    return result;
  }

  private hoistOrAppend(node: Node, statements: Node[], topLevel: Node[] | undefined): boolean {
    const hoisted = this.hoist(node, topLevel);
    if (hoisted !== undefined) statements.push(hoisted);
    return true;
  }

  /** What stays in the `try` of a visited top-level statement, once its bindings are hoisted. */
  private hoist(node: Node, topLevel: Node[] | undefined): Node | undefined {
    if (topLevel === undefined) return node;
    switch (node.kind) {
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.ImportEqualsDeclaration:
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.FunctionDeclaration:
        topLevel.push(node);
        return undefined;
      case SyntaxKind.ExportAssignment:
        return this.hoistExportAssignment(node as ExportAssignment);
      case SyntaxKind.ClassDeclaration:
        return this.hoistClassDeclaration(node as ClassDeclaration);
      case SyntaxKind.VariableStatement:
        return this.hoistVariableStatement(node as VariableStatement);
    }
    return node;
  }

  private createDefaultBinding(): Identifier {
    return this.factory.createUniqueName(
      '_default',
      GeneratedIdentifierFlags.ReservedInNestedScopes |
        GeneratedIdentifierFlags.FileLevel |
        GeneratedIdentifierFlags.Optimistic,
    );
  }

  private hoistExportAssignment(node: ExportAssignment): Node {
    const factory = this.factory;
    if (node.isExportEquals) {
      // export = expr; -> var _default; try { _default = expr; } ... export = _default;
      if (this.exportEqualsBinding !== undefined) return node;
      const binding = this.createDefaultBinding();
      this.exportEqualsBinding = binding;
      this.context.addVariableDeclaration(binding);
      return factory.createExpressionStatement(factory.createAssignment(binding, node.expression));
    }
    // export default expr; -> var _default; export { _default as default }; try { _default = expr; } ...
    if (this.defaultExportBinding !== undefined) return node;
    const binding = this.createDefaultBinding();
    this.defaultExportBinding = binding;
    this.hoistBindingIdentifier(binding, true, factory.createIdentifier('default'), node);
    // Give an anonymous class or function the name `default`.
    let expression = node.expression;
    const inner = skipOuterExpressions(expression, OuterExpressionKinds.All);
    if (isNamedEvaluation(this.context, inner, undefined))
      expression = factory.restoreOuterExpressions(
        expression,
        transformNamedEvaluation(this.context, inner, false, 'default'),
        OuterExpressionKinds.All,
      );
    return factory.createExpressionStatement(factory.createAssignment(binding, expression));
  }

  /** `class C {}` -> `C = class C {}` in the `try`, with `C` hoisted (and exported if it was). */
  private hoistClassDeclaration(node: ClassDeclaration): Node {
    const factory = this.factory;
    const context = this.context;
    if (node.name === undefined && this.defaultExportBinding !== undefined) return node;
    const isExported = hasSyntacticModifier(node, ModifierFlags.Export);
    const isDefault = hasSyntacticModifier(node, ModifierFlags.Default);
    let expression: Node = this.convertClassDeclarationToClassExpression(node);
    if (node.name !== undefined) {
      this.hoistBindingIdentifier(
        factory.getLocalName(node, NameOptions.None),
        isExported && !isDefault,
        undefined,
        node,
      );
      expression = factory.createAssignment(factory.getDeclarationName(node, NameOptions.None), expression);
      context.setOriginal(expression, node);
      context.setSourceMapRange(expression, node.pos, node.end);
      context.setCommentRange(expression, node.pos, node.end);
      if (isNamedEvaluation(context, expression, undefined))
        expression = transformNamedEvaluation(context, expression, false, '');
    }
    if (isDefault && this.defaultExportBinding === undefined) {
      // export default class C {} -> _default = C = class C {}, exported as `default`.
      const binding = this.createDefaultBinding();
      this.defaultExportBinding = binding;
      this.hoistBindingIdentifier(binding, true, factory.createIdentifier('default'), node);
      expression = factory.createAssignment(binding, expression);
      context.setOriginal(expression, node);
      if (isNamedEvaluation(context, expression, undefined))
        expression = transformNamedEvaluation(context, expression, false, 'default');
    }
    return factory.createExpressionStatement(expression);
  }

  private convertClassDeclarationToClassExpression(node: ClassDeclaration): Node {
    const updated = this.factory.created(
      new ClassExpression(
        this.extractModifiers(node.modifiers, ~ModifierFlags.ExportDefault),
        node.name,
        node.typeParameters,
        node.heritageClauses,
        node.members,
      ),
    );
    this.context.setOriginal(updated, node);
    updated.pos = node.pos;
    updated.end = node.end;
    return updated;
  }

  private hoistVariableStatement(node: VariableStatement): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    const expressions: Node[] = [];
    const isExported = hasSyntacticModifier(node, ModifierFlags.Export);
    const declarations = node.declarationList.declarations.nodes;
    for (let i = 0; i < declarations.length; i++) {
      const variable = declarations[i] as VariableDeclaration;
      this.hoistBindingElement(variable, isExported, variable);
      if (variable.initializer !== undefined) expressions.push(this.hoistInitializedVariable(variable));
    }
    if (expressions.length === 0) return undefined;
    const statement = factory.createExpressionStatement(factory.inlineExpressions(expressions)!);
    context.setOriginal(statement, node);
    context.setCommentRange(statement, node.pos, node.end);
    context.setSourceMapRange(statement, node.pos, node.end);
    return statement;
  }

  private hoistInitializedVariable(node: VariableDeclaration): Node {
    const factory = this.factory;
    const context = this.context;
    let target: Node;
    if (node.name instanceof Identifier) {
      target = factory.cloneIdentifier(node.name);
      context.setEmitFlags(target, context.getEmitFlags(target) & ~(EmitFlags.LocalName | EmitFlags.ExportName));
    } else target = convertBindingNameToTarget(this, node.name);
    const assignment = factory.createAssignment(target, node.initializer!);
    context.setOriginal(assignment, node);
    context.setCommentRange(assignment, node.pos, node.end);
    context.setSourceMapRange(assignment, node.pos, node.end);
    return assignment;
  }

  private hoistBindingElement(node: Node, isExported: boolean, original: Node): boolean {
    const name = getBindingName(node);
    if (name instanceof BindingPattern) {
      const elements = name.elements.nodes;
      for (let i = 0; i < elements.length; i++)
        if (getBindingName(elements[i]) !== undefined) this.hoistBindingElement(elements[i], isExported, original);
    } else if (name instanceof Identifier)
      this.hoistBindingIdentifier(name as Identifier, isExported, undefined, original);
    return true;
  }

  private hoistBindingIdentifier(
    node: Identifier,
    isExport: boolean,
    exportAlias: Identifier | undefined,
    original: Node | undefined,
  ): boolean {
    const factory = this.factory;
    const context = this.context;
    const name = context.hasAutoGenerateInfo(node) ? node : factory.cloneIdentifier(node);
    if (isExport) {
      if (exportAlias === undefined && (context.getEmitFlags(name) & EmitFlags.LocalName) === 0) {
        const declaration = factory.createVariableDeclaration(name, undefined, undefined, undefined);
        if (original !== undefined) context.setOriginal(declaration, original);
        this.exportVars.push(declaration);
        return true;
      }
      const specifier =
        exportAlias !== undefined
          ? factory.created(new ExportSpecifier(false, name, exportAlias))
          : factory.created(new ExportSpecifier(false, undefined, name));
      if (original !== undefined) context.setOriginal(specifier, original);
      this.exportBindings.set(name.text, specifier);
    }
    context.addVariableDeclaration(name);
    return true;
  }

  private createEnvBinding(): Identifier {
    return this.factory.createUniqueName('env', 0);
  }

  /**
   *   const env_1 = { stack: [], error: void 0, hasError: false };
   *   try { body }
   *   catch (e_1) { env_1.error = e_1; env_1.hasError = true; }
   *   finally { __disposeResources(env_1); }
   *
   * With `async`, the `finally` awaits the result: `const result_1 = __disposeResources(env_1); if (result_1) await result_1;`.
   * Two properties record the error since `throw undefined` is legal.
   */
  private createDownlevelUsingStatements(body: Node[], env: Identifier, async: boolean): Node[] {
    const factory = this.factory;
    const envObject = factory.createObjectLiteral(
      [
        factory.createPropertyAssignment(
          factory.createIdentifier('stack'),
          factory.created(new ArrayLiteralExpression(factory.createNodeList([]), false)),
        ),
        factory.createPropertyAssignment(factory.createIdentifier('error'), factory.createVoidZero()),
        factory.createPropertyAssignment(
          factory.createIdentifier('hasError'),
          factory.createKeywordExpression(SyntaxKind.FalseKeyword),
        ),
      ],
      false,
    );
    const envStatement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([factory.createVariableDeclaration(env, undefined, undefined, envObject)]),
        NodeFlags.Const,
      ),
    );
    const tryBlock = factory.createBlock(body, true);
    const error = factory.createUniqueName('e', 0);
    const catchClause = factory.created(
      new CatchClause(
        factory.createVariableDeclaration(error, undefined, undefined, undefined),
        factory.createBlock(
          [
            factory.createExpressionStatement(
              factory.createAssignment(
                factory.createPropertyAccessExpression(env, factory.createIdentifier('error')),
                error,
              ),
            ),
            factory.createExpressionStatement(
              factory.createAssignment(
                factory.createPropertyAccessExpression(env, factory.createIdentifier('hasError')),
                factory.createTrue(),
              ),
            ),
          ],
          true,
        ),
      ),
    );
    let finallyBlock: Block;
    if (async) {
      const result = factory.createUniqueName('result', 0);
      finallyBlock = factory.createBlock(
        [
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              factory.createNodeList([
                factory.createVariableDeclaration(
                  result,
                  undefined,
                  undefined,
                  factory.createDisposeResourcesHelper(env),
                ),
              ]),
              NodeFlags.Const,
            ),
          ),
          factory.createIfStatement(
            result,
            factory.createExpressionStatement(factory.created(new AwaitExpression(result))),
            undefined,
          ),
        ],
        true,
      );
    } else
      finallyBlock = factory.createBlock(
        [factory.createExpressionStatement(factory.createDisposeResourcesHelper(env))],
        true,
      );
    return [envStatement, factory.created(new TryStatement(tryBlock, catchClause, finallyBlock))];
  }
}

function getPrologueEnd(statements: readonly Node[]): number {
  let i = 0;
  while (i < statements.length && isPrologueDirective(statements[i])) i++;
  return i;
}

function getUsingKindOfVariableDeclarationList(node: VariableDeclarationList): UsingKind {
  const flags = node.flags & NodeFlags.BlockScoped;
  if (flags === NodeFlags.AwaitUsing) return UsingKind.Async;
  if (flags === NodeFlags.Using) return UsingKind.Sync;
  return UsingKind.None;
}

function isUsingVariableDeclarationList(node: Node): boolean {
  return (
    node instanceof VariableDeclarationList &&
    getUsingKindOfVariableDeclarationList(node as VariableDeclarationList) !== UsingKind.None
  );
}

function getUsingKind(statement: Node): UsingKind {
  if (!(statement instanceof VariableStatement)) return UsingKind.None;
  return getUsingKindOfVariableDeclarationList(statement.declarationList);
}

function getUsingKindOfStatements(statements: readonly Node[]): UsingKind {
  let result = UsingKind.None;
  for (let i = 0; i < statements.length; i++) {
    const kind = getUsingKind(statements[i]);
    if (kind === UsingKind.Async) return UsingKind.Async;
    if (kind > result) result = kind;
  }
  return result;
}

function getBindingName(node: Node): Node | undefined {
  if (node instanceof VariableDeclaration) return node.name;
  if (node.kind === SyntaxKind.BindingElement) return (node as BindingElement).name;
  return undefined;
}
