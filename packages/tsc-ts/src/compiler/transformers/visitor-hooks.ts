// Child traversal for transforms: visiting nodes and lists, with hoisted declarations tracked
// in the emit context's variable environments as tsgo's emit-context visitors do.
import {
  BindingPattern,
  Block,
  EmptyStatement,
  ModifierList,
  type Node,
  NodeList,
  NotEmittedStatement,
  ParameterDeclaration,
  SyntaxList,
} from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags } from '../printer/emit-flags.js';
import type { NodeFactory } from '../printer/factory.js';

export abstract class VisitorHooks {
  readonly context: EmitContext;
  readonly factory: NodeFactory;

  constructor(context: EmitContext) {
    this.context = context;
    this.factory = context.factory;
  }

  /** Visits one node: return it, a replacement, a `SyntaxList` of several nodes, or undefined to remove it. */
  abstract visit(node: Node): Node | undefined;

  abstract visitEachChild(node: Node): Node;

  visitNode(node: Node | undefined): Node | undefined {
    if (node === undefined) return undefined;
    const visited = this.visit(node);
    if (visited instanceof SyntaxList) {
      if (visited.children.length !== 1) throw new Error('Expected only a single node to be written to output');
      return visited.children[0]!;
    }
    return visited;
  }

  visitToken(node: Node | undefined): Node | undefined {
    return this.visitNode(node);
  }

  /** The visited nodes, or `nodes` itself if nothing changed. */
  visitArray(nodes: Node[]): Node[] {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      let visited = this.visit(node);
      if (visited === node) continue;
      const updated = nodes.slice(0, i);
      for (;;) {
        if (visited instanceof SyntaxList)
          for (let j = 0; j < visited.children.length; j++) updated.push(visited.children[j]!);
        else if (visited !== undefined) updated.push(visited);
        if (++i >= nodes.length) break;
        visited = this.visit(nodes[i]!);
      }
      return updated;
    }
    return nodes;
  }

  visitNodes(list: NodeList | undefined): NodeList | undefined {
    if (list === undefined) return undefined;
    const nodes = this.visitArray(list.nodes);
    return nodes === list.nodes ? list : new NodeList(list.pos, list.end, nodes);
  }

  visitModifiers(list: ModifierList | undefined): ModifierList | undefined {
    if (list === undefined) return undefined;
    const nodes = this.visitArray(list.nodes);
    if (nodes === list.nodes) return list;
    const updated = this.factory.createModifierList(nodes);
    updated.pos = list.pos;
    updated.end = list.end;
    return updated;
  }

  liftToBlock(node: Node | undefined): Node {
    if (node instanceof SyntaxList) {
      if (node.children.length === 1) return node.children[0]!;
      return this.factory.createBlock(node.children, true);
    }
    if (node === undefined) return this.factory.createBlock([], true);
    return node;
  }

  /** A visited statement, as a block if it became several, or undefined if removed. */
  visitStatement(node: Node | undefined): Node | undefined {
    if (node === undefined) return undefined;
    const visited = this.visit(node);
    return visited === undefined ? undefined : this.liftToBlock(visited);
  }

  /** The body of an `if`, `with` or labeled statement; an elided statement becomes `;`. */
  visitEmbeddedStatement(node: Node | undefined): Node | undefined {
    if (node === undefined) return undefined;
    const visited = this.visit(node);
    const statement = visited === undefined ? undefined : this.liftToBlock(visited);
    if (statement === undefined || statement instanceof NotEmittedStatement) {
      const empty = this.factory.created(new EmptyStatement());
      empty.pos = node.pos;
      empty.end = node.end;
      this.context.setOriginal(empty, node);
      this.context.assignCommentRange(empty, node);
      return empty;
    }
    return statement;
  }

  visitIterationBody(node: Node | undefined): Node | undefined {
    if (node === undefined) return undefined;
    const context = this.context;
    context.startLexicalEnvironment();
    const updated = this.visitEmbeddedStatement(node)!;
    const declarations = context.endLexicalEnvironment();
    if (declarations.length === 0) return updated;
    if (updated instanceof Block) {
      const statements = declarations.concat(updated.statements.nodes);
      return this.factory.updateBlock(
        updated,
        new NodeList(updated.statements.pos, updated.statements.end, statements),
        updated.multiLine,
      );
    }
    declarations.push(updated);
    return this.factory.createBlock(declarations, true);
  }

  visitParameters(list: NodeList | undefined): NodeList | undefined {
    const context = this.context;
    context.startVariableEnvironment();
    const flags = context.enterParameters();
    let result = this.visitNodes(list);
    if (context.exitParameters(flags) && result !== undefined) result = this.addDefaultValueAssignments(result);
    return result;
  }

  visitFunctionBody(node: Node | undefined): Node | undefined {
    const updated = this.visitNode(node);
    const declarations = this.context.endVariableEnvironment();
    if (declarations.length === 0) return updated;
    const factory = this.factory;
    if (updated === undefined) return factory.createBlock(declarations, true);
    if (!(updated instanceof Block)) {
      // The return statement takes the expression's range, so its comments are emitted once, before `return`.
      this.context.addEmitFlags(updated, EmitFlags.NoComments);
      const block = this.context.convertToFunctionBlock(updated, false);
      return factory.updateBlock(
        block,
        this.context.mergeEnvironmentList(block.statements, declarations),
        block.multiLine,
      );
    }
    return factory.updateBlock(
      updated,
      this.context.mergeEnvironmentList(updated.statements, declarations),
      updated.multiLine,
    );
  }

  visitTopLevelStatements(list: NodeList | undefined): NodeList | undefined {
    const context = this.context;
    context.startVariableEnvironment();
    const visited = this.visitNodes(list);
    if (visited === undefined) return undefined;
    return context.mergeEnvironmentList(visited, context.endVariableEnvironment());
  }

  /** Moves initializers and binding patterns of parameters into the body when temporaries were hoisted. */
  private addDefaultValueAssignments(list: NodeList): NodeList {
    let result: Node[] | undefined = undefined;
    for (let i = 0; i < list.nodes.length; i++) {
      const parameter = list.nodes[i]!;
      if (!(parameter instanceof ParameterDeclaration)) continue;
      const updated = this.addDefaultValueAssignment(parameter as ParameterDeclaration);
      if (updated !== parameter) {
        if (result === undefined) result = list.nodes.slice();
        result[i] = updated;
      }
    }
    return result === undefined ? list : new NodeList(list.pos, list.end, result);
  }

  private addDefaultValueAssignment(parameter: ParameterDeclaration): Node {
    if (parameter.dotDotDotToken !== undefined) return parameter;
    const factory = this.factory;
    const context = this.context;
    const name = parameter.name;
    if (name instanceof BindingPattern) {
      const temp = factory.createGeneratedNameForNode(parameter, 0, '', '');
      const initializer =
        parameter.initializer === undefined
          ? factory.createGeneratedNameForNode(parameter, 0, '', '')
          : factory.createConditionalExpression(
              factory.createStrictEquality(
                factory.createGeneratedNameForNode(parameter, 0, '', ''),
                factory.createVoidZero(),
              ),
              parameter.initializer,
              factory.createGeneratedNameForNode(parameter, 0, '', ''),
            );
      context.addInitializationStatement(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            factory.createNodeList([factory.createVariableDeclaration(name, undefined, parameter.type, initializer)]),
            0,
          ),
        ),
      );
      return factory.updateParameterDeclaration(
        parameter,
        parameter.modifiers,
        parameter.dotDotDotToken,
        temp,
        parameter.questionToken,
        parameter.type,
        undefined,
      );
    }
    const initializer = parameter.initializer;
    if (initializer === undefined) return parameter;
    context.addEmitFlags(initializer, EmitFlags.NoSourceMap | EmitFlags.NoComments);
    const nameClone = factory.cloneNode(name, name.deepClone());
    context.addEmitFlags(nameClone, EmitFlags.NoSourceMap);
    const assignment = factory.createAssignment(nameClone, initializer);
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
    context.addInitializationStatement(
      factory.createIfStatement(
        factory.createTypeCheck(factory.cloneNode(name, name.deepClone()), 'undefined'),
        block,
        undefined,
      ),
    );
    return factory.updateParameterDeclaration(
      parameter,
      parameter.modifiers,
      parameter.dotDotDotToken,
      name,
      parameter.questionToken,
      parameter.type,
      undefined,
    );
  }
}
