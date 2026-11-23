// Lowers object spread to `Object.assign` and object rest elements to `__rest`, for targets
// before ES2018.
import {
  ArrowFunction,
  BinaryExpression,
  BindingPattern,
  Block,
  CatchClause,
  ConstructorDeclaration,
  ForInOrOfStatement,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  Identifier,
  MethodDeclaration,
  ModifierFlags,
  type Node,
  NodeFlags,
  NodeList,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PropertyAssignment,
  SourceFile,
  SetAccessorDeclaration,
  SpreadAssignment,
  SyntaxList,
  VariableDeclaration,
  VariableStatement,
  getBody,
  getParameters,
} from '../ast.js';
import { isDestructuringAssignment, skipParentheses } from '../binder-utilities.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags } from '../printer/emit-flags.js';
import { isPrologueDirective } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { flattenDestructuringBinding, flattenObjectRestAssignment } from './destructuring.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { createForOfBindingStatement, hasSyntacticModifier } from './utilities.js';

export class ObjectRestSpreadTransformer extends Transformer {
  readonly facts: SyntaxFacts;
  private inExportedVariableStatement: boolean;
  private expressionResultIsUnused: boolean;
  /** Parameters after the first one with an object rest element, in the current parameter list. */
  private parametersWithPrecedingObjectRestOrSpread: Set<Node> | undefined;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
    this.inExportedVariableStatement = false;
    this.expressionResultIsUnused = false;
    this.parametersWithPrecedingObjectRestOrSpread = undefined;
  }

  visit(node: Node): Node | undefined {
    if (
      !this.facts.has(node, SubtreeFacts.ContainsESObjectRestOrSpread) &&
      this.parametersWithPrecedingObjectRestOrSpread === undefined
    )
      return node;
    // Children see `false` unless a case below says otherwise.
    const expressionResultIsUnused = this.expressionResultIsUnused;
    this.expressionResultIsUnused = false;
    const result = this.visitWorker(node, expressionResultIsUnused);
    this.expressionResultIsUnused = expressionResultIsUnused;
    return result;
  }

  private visitWorker(node: Node, expressionResultIsUnused: boolean): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        return this.visitSourceFile(node as SourceFile);
      case SyntaxKind.ObjectLiteralExpression:
        return this.visitObjectLiteralExpression(node as ObjectLiteralExpression);
      case SyntaxKind.BinaryExpression:
        return this.visitBinaryExpression(node as BinaryExpression, expressionResultIsUnused);
      case SyntaxKind.ExpressionStatement:
        this.expressionResultIsUnused = true;
        return this.visitEachChild(node);
      case SyntaxKind.ParenthesizedExpression:
        this.expressionResultIsUnused = expressionResultIsUnused;
        return this.visitEachChild(node);
      case SyntaxKind.ForOfStatement:
        return this.visitForOfStatement(node as ForInOrOfStatement);
      case SyntaxKind.VariableStatement:
        return this.visitVariableStatement(node as VariableStatement);
      case SyntaxKind.VariableDeclaration:
        return this.visitVariableDeclaration(node as VariableDeclaration);
      case SyntaxKind.CatchClause:
        return this.visitCatchClause(node as CatchClause);
      case SyntaxKind.Parameter:
        return this.visitParameter(node as ParameterDeclaration);
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression:
        return this.visitFunctionLike(node);
    }
    return this.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    const visited = this.visitEachChild(node);
    const helpers = this.context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) this.context.addEmitHelper(visited, helpers[i]);
    return visited;
  }

  private visitParameter(node: ParameterDeclaration): Node {
    const factory = this.factory;
    const preceding = this.parametersWithPrecedingObjectRestOrSpread;
    if (preceding !== undefined && preceding.has(node as Node)) {
      const name =
        node.name instanceof BindingPattern ? factory.createGeneratedNameForNode(node, 0, '', '') : node.name;
      return factory.updateParameterDeclaration(
        node,
        undefined,
        node.dotDotDotToken,
        name,
        undefined,
        undefined,
        undefined,
      );
    }
    // A pattern with an object rest becomes a generated name, destructured in the body.
    if (this.facts.has(node, SubtreeFacts.ContainsObjectRestOrSpread))
      return factory.updateParameterDeclaration(
        node,
        undefined,
        node.dotDotDotToken,
        factory.createGeneratedNameForNode(node, 0, '', ''),
        undefined,
        undefined,
        this.visitNode(node.initializer),
      );
    return this.visitEachChild(node);
  }

  private collectParametersWithPrecedingObjectRestOrSpread(node: Node): Set<Node> | undefined {
    let result: Set<Node> | undefined = undefined;
    const parameters = getParameters(node)!.nodes;
    for (let i = 0; i < parameters.length; i++) {
      if (result !== undefined) result.add(parameters[i]);
      else if (this.facts.has(parameters[i], SubtreeFacts.ContainsObjectRestOrSpread)) result = new Set<Node>();
    }
    return result;
  }

  private visitFunctionLike(node: Node): Node {
    const saved = this.parametersWithPrecedingObjectRestOrSpread;
    this.parametersWithPrecedingObjectRestOrSpread = this.collectParametersWithPrecedingObjectRestOrSpread(node);
    const result = this.updateFunctionLike(node);
    this.parametersWithPrecedingObjectRestOrSpread = saved;
    return result;
  }

  private updateFunctionLike(node: Node): Node {
    const factory = this.factory;
    if (node instanceof ConstructorDeclaration) {
      const parameters = this.visitNodes(node.parameters)!;
      return factory.updateConstructorDeclaration(
        node as ConstructorDeclaration,
        node.modifiers,
        undefined,
        parameters,
        undefined,
        undefined,
        this.transformFunctionBody(node),
      );
    }
    if (node instanceof GetAccessorDeclaration) {
      const name = this.visitNode(node.name)!;
      const parameters = this.visitNodes(node.parameters)!;
      return factory.updateGetAccessorDeclaration(
        node as GetAccessorDeclaration,
        node.modifiers,
        name,
        undefined,
        parameters,
        undefined,
        undefined,
        this.transformFunctionBody(node),
      );
    }
    if (node instanceof SetAccessorDeclaration) {
      const name = this.visitNode(node.name)!;
      const parameters = this.visitNodes(node.parameters)!;
      return factory.updateSetAccessorDeclaration(
        node as SetAccessorDeclaration,
        node.modifiers,
        name,
        undefined,
        parameters,
        undefined,
        undefined,
        this.transformFunctionBody(node),
      );
    }
    if (node instanceof MethodDeclaration) {
      const name = this.visitNode(node.name)!;
      const parameters = this.visitNodes(node.parameters)!;
      return factory.updateMethodDeclaration(
        node as MethodDeclaration,
        node.modifiers,
        node.asteriskToken,
        name,
        node.postfixToken,
        undefined,
        parameters,
        undefined,
        undefined,
        this.transformFunctionBody(node),
      );
    }
    if (node instanceof FunctionDeclaration) {
      const name = node.name === undefined ? undefined : (this.visitNode(node.name) as Identifier);
      const parameters = this.visitNodes(node.parameters)!;
      return factory.updateFunctionDeclaration(
        node as FunctionDeclaration,
        node.modifiers,
        node.asteriskToken,
        name,
        undefined,
        parameters,
        undefined,
        undefined,
        this.transformFunctionBody(node),
      );
    }
    if (node instanceof ArrowFunction) {
      const parameters = this.visitNodes(node.parameters)!;
      return factory.updateArrowFunction(
        node as ArrowFunction,
        node.modifiers,
        undefined,
        parameters,
        undefined,
        undefined,
        node.equalsGreaterThanToken,
        this.transformFunctionBody(node)!,
      );
    }
    if (node instanceof FunctionExpression) {
      const name = node.name === undefined ? undefined : (this.visitNode(node.name) as Identifier);
      const parameters = this.visitNodes(node.parameters)!;
      return factory.updateFunctionExpression(
        node as FunctionExpression,
        node.modifiers,
        node.asteriskToken,
        name,
        undefined,
        parameters,
        undefined,
        undefined,
        this.transformFunctionBody(node) as Block,
      );
    }
    return this.visitEachChild(node);
  }

  /** The visited body, with the destructuring of parameters with object rest elements prepended. */
  private transformFunctionBody(node: Node): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    // Not `visitFunctionBody`: the rest assignments go between the body and the hoisted variables.
    context.startVariableEnvironment();
    let body = this.visitNode(getBody(node));
    let extras: readonly Node[] = context.endVariableEnvironment();
    context.startVariableEnvironment();
    const newStatements = this.collectObjectRestAssignments(node);
    extras = context.mergeEnvironment(extras, context.endVariableEnvironment());
    if (newStatements.length === 0 && extras.length === 0) return body;
    if (body === undefined) body = factory.createBlock([], true);
    const prefix: Node[] = [];
    let suffix: Node[] = [];
    let block: Block;
    if (body instanceof Block) {
      block = body as Block;
      const statements = body.statements.nodes;
      let custom = false;
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];
        if (!custom && isPrologueDirective(statement)) prefix.push(statement);
        else if ((context.getEmitFlags(statement) & EmitFlags.CustomPrologue) !== 0) {
          custom = true;
          prefix.push(statement);
        } else {
          suffix = statements.slice(i);
          break;
        }
      }
    } else {
      const statement = factory.createReturnStatement(body);
      statement.pos = body.pos;
      statement.end = body.end;
      const list = factory.createNodeList([]);
      list.pos = body.pos;
      list.end = body.end;
      block = factory.created(new Block(list, true));
      suffix.push(statement);
    }
    const statements = prefix.concat(extras, newStatements, suffix);
    return factory.updateBlock(
      block,
      new NodeList(block.statements.pos, block.statements.end, statements),
      block.multiLine,
    );
  }

  private collectObjectRestAssignments(node: Node): Node[] {
    const factory = this.factory;
    const context = this.context;
    const results: Node[] = [];
    let containsPrecedingObjectRestOrSpread = false;
    const parameters = getParameters(node)!.nodes;
    for (let i = 0; i < parameters.length; i++) {
      const parameter = parameters[i] as ParameterDeclaration;
      if (containsPrecedingObjectRestOrSpread) {
        if (parameter.name instanceof BindingPattern) {
          // `[]` and `{}` declare nothing, but an initializer may have side effects.
          if (parameter.name.elements.nodes.length > 0) {
            const declarations = flattenDestructuringBinding(
              this,
              undefined,
              parameter,
              factory.createGeneratedNameForNode(parameter, 0, '', ''),
              false,
              false,
            );
            if (declarations !== undefined) results.push(this.createPrologueVariableStatement(declarations));
          } else if (parameter.initializer !== undefined) {
            const name = factory.createGeneratedNameForNode(parameter, 0, '', '');
            const statement = factory.createExpressionStatement(
              factory.createAssignment(name, this.visitNode(parameter.initializer)!),
            );
            context.addEmitFlags(statement, EmitFlags.CustomPrologue);
            results.push(statement);
          }
        } else if (parameter.initializer !== undefined) results.push(this.createDefaultValueStatement(parameter));
      } else if (this.facts.has(parameter, SubtreeFacts.ContainsObjectRestOrSpread)) {
        containsPrecedingObjectRestOrSpread = true;
        const declarations = flattenDestructuringBinding(
          this,
          this.facts,
          parameter,
          factory.createGeneratedNameForNode(parameter, 0, '', ''),
          false,
          true,
        );
        if (declarations !== undefined) results.push(this.createPrologueVariableStatement(declarations));
      }
    }
    return results;
  }

  /** `if (x === void 0) { x = initializer; }` for a parameter after one with an object rest. */
  private createDefaultValueStatement(parameter: ParameterDeclaration): Node {
    const factory = this.factory;
    const context = this.context;
    const original = parameter.name;
    const name = factory.cloneNode(original, original.deepClone());
    name.pos = original.pos;
    name.end = original.end;
    context.addEmitFlags(name, EmitFlags.NoSourceMap);
    const initializer = this.visitNode(parameter.initializer)!;
    context.addEmitFlags(initializer, EmitFlags.NoSourceMap | EmitFlags.NoComments);
    const assignment = factory.createAssignment(name, initializer);
    assignment.pos = parameter.pos;
    assignment.end = parameter.end;
    context.addEmitFlags(assignment, EmitFlags.NoComments);
    const block = factory.createBlock([factory.createExpressionStatement(assignment)], false);
    block.pos = parameter.pos;
    block.end = parameter.end;
    context.addEmitFlags(
      block,
      EmitFlags.SingleLine | EmitFlags.NoTrailingSourceMap | EmitFlags.NoTokenSourceMaps | EmitFlags.NoComments,
    );
    const statement = factory.createIfStatement(
      factory.createTypeCheck(factory.cloneNode(name, name.deepClone()), 'undefined'),
      block,
      undefined,
    );
    statement.pos = parameter.pos;
    statement.end = parameter.end;
    context.addEmitFlags(
      statement,
      EmitFlags.NoTokenSourceMaps |
        EmitFlags.NoTrailingSourceMap |
        EmitFlags.CustomPrologue |
        EmitFlags.NoComments |
        EmitFlags.StartOnNewLine,
    );
    return statement;
  }

  /** `var` of flattened declarations, as a custom prologue. */
  private createPrologueVariableStatement(declarations: Node): Node {
    const factory = this.factory;
    const statement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList(declarationsOf(declarations).slice()),
        NodeFlags.None,
      ),
    );
    this.context.addEmitFlags(statement, EmitFlags.CustomPrologue);
    return statement;
  }

  private visitCatchClause(node: CatchClause): Node {
    const declaration = node.variableDeclaration;
    if (
      declaration === undefined ||
      !(declaration.name instanceof BindingPattern) ||
      !this.facts.has(declaration.name, SubtreeFacts.ContainsObjectRestOrSpread)
    )
      return this.visitEachChild(node);
    const factory = this.factory;
    const name = factory.createGeneratedNameForNode(declaration.name, 0, '', '');
    const updated = factory.updateVariableDeclaration(declaration, declaration.name, undefined, undefined, name);
    const bindings = flattenDestructuringBinding(this, this.facts, updated, undefined, false, false);
    let block = this.visitNode(node.block) as Block;
    if (bindings !== undefined) {
      const statement = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(factory.createNodeList(declarationsOf(bindings).slice()), NodeFlags.None),
      );
      const statements: Node[] = [statement];
      for (let i = 0; i < block.statements.nodes.length; i++) statements.push(block.statements.nodes[i]);
      block = factory.updateBlock(
        block,
        new NodeList(block.statements.pos, block.statements.end, statements),
        block.multiLine,
      );
    }
    return factory.updateCatchClause(
      node,
      factory.updateVariableDeclaration(declaration, name, undefined, undefined, undefined),
      block,
    );
  }

  private visitVariableStatement(node: VariableStatement): Node {
    if (!hasSyntacticModifier(node, ModifierFlags.Export)) return this.visitEachChild(node);
    const saved = this.inExportedVariableStatement;
    this.inExportedVariableStatement = true;
    const result = this.visitEachChild(node);
    this.inExportedVariableStatement = saved;
    return result;
  }

  private visitVariableDeclaration(node: VariableDeclaration): Node | undefined {
    const exported = this.inExportedVariableStatement;
    this.inExportedVariableStatement = false;
    let result: Node | undefined;
    // Only reached for a binding pattern with an object rest somewhere in it.
    if (node.name instanceof BindingPattern && this.facts.has(node, SubtreeFacts.ContainsObjectRestOrSpread))
      result = flattenDestructuringBinding(this, this.facts, node, undefined, exported, false);
    else result = this.visitEachChild(node);
    this.inExportedVariableStatement = exported;
    return result;
  }

  private visitForOfStatement(node: ForInOrOfStatement): Node {
    const factory = this.factory;
    const initializer = node.initializer;
    if (
      !this.facts.has(initializer, SubtreeFacts.ContainsObjectRestOrSpread) &&
      !(isAssignmentPattern(initializer) && this.facts.containsObjectRestOrSpread(initializer))
    )
      return this.visitEachChild(node);
    const head = skipParentheses(initializer);
    if (head.kind !== SyntaxKind.VariableDeclarationList && !isAssignmentPattern(head))
      return this.visitEachChild(node);
    const temp = factory.createTempVariable(0);
    const statements: Node[] = [];
    const binding = this.visitNode(createForOfBindingStatement(factory, head, temp));
    if (binding !== undefined) statements.push(binding);
    let bodyPos = -1;
    let bodyEnd = -1;
    let statementsPos = -1;
    let statementsEnd = -1;
    const body = node.statement;
    if (body instanceof Block) {
      const nodes = body.statements.nodes;
      for (let i = 0; i < nodes.length; i++) statements.push(this.visitEachChild(nodes[i]));
      bodyPos = body.pos;
      bodyEnd = body.end;
      statementsPos = body.statements.pos;
      statementsEnd = body.statements.end;
    } else {
      statements.push(this.visitEachChild(body));
      bodyPos = body.pos;
      bodyEnd = body.end;
      statementsPos = body.pos;
      statementsEnd = body.end;
    }
    const list = factory.createVariableDeclarationList(
      factory.createNodeList([factory.createVariableDeclaration(temp, undefined, undefined, undefined)]),
      NodeFlags.Let,
    );
    list.pos = initializer.pos;
    list.end = initializer.end;
    const expression = this.visitEachChild(node.expression);
    const block = factory.created(new Block(new NodeList(statementsPos, statementsEnd, statements), true));
    block.pos = bodyPos;
    block.end = bodyEnd;
    return factory.updateForInOrOfStatement(node, node.awaitModifier, list, expression, block);
  }

  private visitBinaryExpression(node: BinaryExpression, expressionResultIsUnused: boolean): Node {
    if (isDestructuringAssignment(node) && this.facts.containsObjectRestOrSpread(node.left))
      return flattenObjectRestAssignment(this, this.facts, node, !expressionResultIsUnused);
    if (node.operatorToken.kind === SyntaxKind.CommaToken) {
      this.expressionResultIsUnused = true;
      const left = this.visitNode(node.left)!;
      this.expressionResultIsUnused = expressionResultIsUnused;
      const right = this.visitNode(node.right)!;
      return this.factory.updateBinaryExpression(node, undefined, left, undefined, node.operatorToken, right);
    }
    return this.visitEachChild(node);
  }

  private visitObjectLiteralExpression(node: ObjectLiteralExpression): Node {
    if ((this.facts.of(node) & SubtreeFacts.ContainsObjectRestOrSpread) === 0) return this.visitEachChild(node);
    // Elements between spreads are chunked into object literals, each merged with one more
    // `Object.assign` call so side effects run in order: `{ a, ...o, b }` becomes
    // `Object.assign(Object.assign({ a }, o), { b })`.
    const factory = this.factory;
    const objects = this.chunkObjectLiteralElements(node.properties.nodes);
    if (objects.length > 0 && objects[0].kind !== SyntaxKind.ObjectLiteralExpression)
      objects.unshift(factory.createObjectLiteral([], false));
    let expression = objects[0];
    if (objects.length > 1) {
      for (let i = 1; i < objects.length; i++) expression = this.createAssign([expression, objects[i]]);
      return expression;
    }
    return this.createAssign(objects);
  }

  private createAssign(args: Node[]): Node {
    return this.factory.createGlobalMethodCall('Object', 'assign', args);
  }

  private chunkObjectLiteralElements(elements: readonly Node[]): Node[] {
    const factory = this.factory;
    const objects: Node[] = [];
    let chunk: Node[] = [];
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element instanceof SpreadAssignment) {
        if (chunk.length > 0) {
          objects.push(factory.createObjectLiteral(chunk, false));
          chunk = [];
        }
        objects.push(this.visitNode(element.expression)!);
      } else if (element instanceof PropertyAssignment)
        chunk.push(factory.createPropertyAssignment(element.name, this.visitNode(element.initializer)!));
      else {
        const visited = this.visitNode(element);
        if (visited !== undefined) chunk.push(visited);
      }
    }
    if (chunk.length > 0) objects.push(factory.createObjectLiteral(chunk.slice(), false));
    return objects;
  }
}

function isAssignmentPattern(node: Node): boolean {
  return node.kind === SyntaxKind.ObjectLiteralExpression || node.kind === SyntaxKind.ArrayLiteralExpression;
}

function declarationsOf(node: Node): readonly Node[] {
  return node instanceof SyntaxList ? node.children : [node];
}
