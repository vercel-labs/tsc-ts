// Expression and class-element utilities shared by the class transforms: outer expressions,
// `super` accesses, constructor bodies, `_classThis` blocks and auto-accessor backing fields.
import {
  BinaryExpression,
  Block,
  ClassDeclaration,
  ClassExpression,
  ClassStaticBlockDeclaration,
  ElementAccessExpression,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  HeritageClause,
  Identifier,
  type ModifierList,
  NamedExports,
  type Node,
  NodeList,
  ParenthesizedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  PropertyDeclaration,
  TryStatement,
  CallExpression,
  ComputedPropertyName,
} from '../ast.js';
import { isAssignmentExpression, isClassLike } from '../binder-utilities.js';
import type { EmitContext } from '../printer/emit-context.js';
import type { NodeFactory } from '../printer/factory.js';
import { isPrologueDirective } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { OuterExpressionKinds, skipOuterExpressions } from './utilities.js';

/** `super.x` or `super[x]` */
export function isSuperProperty(node: Node): boolean {
  if (node instanceof PropertyAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  if (node instanceof ElementAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  return false;
}

export function isCompoundAssignment(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstCompoundAssignment && kind <= SyntaxKind.LastCompoundAssignment;
}

/** `+` for `+=`, and so on. */
export function getNonAssignmentOperatorForCompoundAssignment(kind: SyntaxKind): SyntaxKind {
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
  return kind;
}

/** The number of leading prologue directives. */
export function countPrologueDirectives(statements: readonly Node[]): number {
  for (let i = 0; i < statements.length; i++) if (!isPrologueDirective(statements[i])) return i;
  return statements.length;
}

/** The `super()` call of an expression statement, if it is one. */
export function getSuperCallFromStatement(statement: Node): Node | undefined {
  if (!(statement instanceof ExpressionStatement)) return undefined;
  let expression = statement.expression;
  while (expression instanceof ParenthesizedExpression) expression = expression.expression;
  return expression instanceof CallExpression && expression.expression.kind === SyntaxKind.SuperKeyword
    ? expression
    : undefined;
}

/** Indices leading to the statement with the `super()` call, descending into `try` blocks; empty if none. */
export function findSuperStatementIndexPath(statements: Node[], start: number): number[] {
  const path: number[] = [];
  if (!findSuperStatementIndexPathWorker(statements, start, path)) return [];
  return path.reverse();
}

function findSuperStatementIndexPathWorker(statements: readonly Node[], start: number, path: number[]): boolean {
  for (let i = start; i < statements.length; i++) {
    const statement = statements[i];
    if (getSuperCallFromStatement(statement) !== undefined) {
      path.push(i);
      return true;
    }
    if (
      statement instanceof TryStatement &&
      findSuperStatementIndexPathWorker(statement.tryBlock.statements.nodes, 0, path)
    ) {
      path.push(i);
      return true;
    }
  }
  return false;
}

/** The `extends` or `implements` clause of a class. */
export function getHeritageClause(clauses: NodeList | undefined, kind: SyntaxKind): HeritageClause | undefined {
  if (clauses === undefined) return undefined;
  for (let i = 0; i < clauses.nodes.length; i++) {
    const clause = clauses.nodes[i];
    if (clause instanceof HeritageClause && clause.token === kind) return clause;
  }
  return undefined;
}

/** The single `_classThis = this` assignment block recorded with `setClassThis`. */
export function isClassThisAssignmentBlock(context: EmitContext, node: Node): boolean {
  if (!(node instanceof ClassStaticBlockDeclaration)) return false;
  const statements = node.body.statements.nodes;
  if (statements.length !== 1) return false;
  const statement = statements[0];
  if (!(statement instanceof ExpressionStatement)) return false;
  const expression = statement.expression;
  if (!(expression instanceof BinaryExpression) || !isAssignmentExpression(expression, true)) return false;
  return (
    expression.left instanceof Identifier &&
    context.getClassThis(node) === expression.left &&
    expression.right.kind === SyntaxKind.ThisKeyword
  );
}

/** Whether a class has a `_classThis = this` block. */
export function classHasClassThisAssignment(context: EmitContext, members: NodeList): boolean {
  for (let i = 0; i < members.nodes.length; i++) if (isClassThisAssignmentBlock(context, members.nodes[i])) return true;
  return false;
}

/** The members of a class declaration or expression. */
export function getClassMembers(node: Node): NodeList {
  if (node instanceof ClassDeclaration) return (node as ClassDeclaration).members;
  if (node instanceof ClassExpression) return (node as ClassExpression).members;
  throw new Error('Expected a class');
}

/** The heritage clauses of a class declaration or expression. */
export function getClassHeritageClauses(node: Node): NodeList | undefined {
  if (node instanceof ClassDeclaration) return (node as ClassDeclaration).heritageClauses;
  if (node instanceof ClassExpression) return (node as ClassExpression).heritageClauses;
  return undefined;
}

/** The name of a class declaration or expression. */
export function getClassName(node: Node): Identifier | undefined {
  if (node instanceof ClassDeclaration) return (node as ClassDeclaration).name;
  if (node instanceof ClassExpression) return (node as ClassExpression).name;
  return undefined;
}

/** A class declaration or expression with other members. */
export function updateClassMembers(factory: NodeFactory, node: Node, members: NodeList): Node {
  if (node instanceof ClassDeclaration) {
    const declaration = node as ClassDeclaration;
    return factory.updateClassDeclaration(
      declaration,
      declaration.modifiers,
      declaration.name,
      declaration.typeParameters,
      declaration.heritageClauses,
      members,
    );
  }
  if (node instanceof ClassExpression) {
    const expression = node as ClassExpression;
    return factory.updateClassExpression(
      expression,
      expression.modifiers,
      expression.name,
      expression.typeParameters,
      expression.heritageClauses,
      members,
    );
  }
  return node;
}

/** Prepends `static { _classThis = this; }` to a class unless it has one. */
export function injectClassThisAssignmentIfMissing(context: EmitContext, node: Node, classThis: Identifier): Node {
  if (!isClassLike(node)) return node;
  const existing = getClassMembers(node);
  if (classHasClassThisAssignment(context, existing)) return node;
  const factory = context.factory;
  const statement = factory.createExpressionStatement(
    factory.createAssignment(classThis, factory.createKeywordExpression(SyntaxKind.ThisKeyword)),
  );
  const staticBlock = factory.created(
    new ClassStaticBlockDeclaration(undefined, factory.createBlock([statement], false)),
  );
  context.setClassThis(staticBlock, classThis);
  const name = getClassName(node);
  if (name !== undefined) context.setSourceMapRange(statement, name.pos, name.end);
  const members = new NodeList(existing.pos, existing.end, [staticBlock as Node].concat(existing.nodes));
  const updated = updateClassMembers(factory, node, members);
  context.setClassThis(updated, classThis);
  return updated;
}

/** The private backing field `#x_accessor_storage` of an `accessor x` field. */
export function createAccessorPropertyBackingField(
  factory: NodeFactory,
  node: PropertyDeclaration,
  modifiers: ModifierList | undefined,
  initializer: Node | undefined,
): PropertyDeclaration {
  return factory.updatePropertyDeclaration(
    node,
    modifiers,
    factory.createGeneratedPrivateNameForNode(node.name, '', '_accessor_storage'),
    undefined,
    undefined,
    initializer,
  );
}

/** The cached `_a = expr` assignment a computed property name was transformed into, if any. */
export function findComputedPropertyNameCacheAssignment(name: ComputedPropertyName): BinaryExpression | undefined {
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

/**
 * `(_a = expression, ++_a)` for `++x`, or `(_a = expression, _a++, _a)` for `x++`, assigning the
 * operation to `resultVariable` when given.
 */
export function expandPreOrPostfixIncrementOrDecrementExpression(
  context: EmitContext,
  node: Node,
  expression: Node,
  resultVariable: Identifier | undefined,
): Node {
  const factory = context.factory;
  const prefix = node instanceof PrefixUnaryExpression;
  let operator = SyntaxKind.Unknown;
  let operand: Node = node;
  if (node instanceof PrefixUnaryExpression) {
    operator = node.operator;
    operand = node.operand;
  } else if (node instanceof PostfixUnaryExpression) {
    operator = node.operator;
    operand = node.operand;
  }
  const temp = factory.createTempVariable(0);
  context.addVariableDeclaration(temp);
  expression = factory.createAssignment(temp, expression);
  expression.pos = operand.pos;
  expression.end = operand.end;
  let operation: Node = prefix
    ? factory.createPrefixUnaryExpression(operator, temp)
    : factory.created(new PostfixUnaryExpression(temp, operator));
  operation.pos = node.pos;
  operation.end = node.end;
  if (resultVariable !== undefined) {
    operation = factory.createAssignment(resultVariable, operation);
    operation.pos = node.pos;
    operation.end = node.end;
  }
  expression = factory.createCommaExpression(expression, operation);
  expression.pos = node.pos;
  expression.end = node.end;
  if (!prefix) {
    expression = factory.createCommaExpression(expression, temp);
    expression.pos = node.pos;
    expression.end = node.end;
  }
  return expression;
}

/** `export default expression;` */
export function createExportDefault(factory: NodeFactory, expression: Node): ExportAssignment {
  return factory.created(new ExportAssignment(undefined, false, undefined, expression));
}

/** `export { name };` */
export function createExternalModuleExport(factory: NodeFactory, name: Identifier): ExportDeclaration {
  const specifier = factory.created(new ExportSpecifier(false, undefined, name));
  const exports = factory.created(new NamedExports(factory.createNodeList([specifier])));
  return factory.created(new ExportDeclaration(undefined, false, exports, undefined, undefined));
}

/** A block of statements, keeping `block`'s range and original. */
export function updateBlockStatements(context: EmitContext, block: Block, statements: Node[]): Block {
  const updated = context.factory.createBlock(statements, block.multiLine);
  context.setOriginal(updated, block);
  updated.pos = block.pos;
  updated.end = block.end;
  return updated;
}
