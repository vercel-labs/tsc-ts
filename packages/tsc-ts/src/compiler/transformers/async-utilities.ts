// Shared by the async function and async generator transforms: tracking `super` accesses in
// async bodies and rewriting them to `_super`/`_superIndex`, which work inside a generator.
import {
  ArrayLiteralExpression,
  BinaryExpression,
  CallExpression,
  ElementAccessExpression,
  Identifier,
  ModifierFlags,
  type Node,
  NodeFlags,
  ObjectLiteralExpression,
  ParameterDeclaration,
  ParenthesizedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SpreadAssignment,
  SpreadElement,
  getAsteriskToken,
  getBody,
  getModifiers,
} from '../ast.js';
import { isAssignmentOperator } from '../ast-utilities.js';
import type { EmitContext } from '../printer/emit-context.js';
import { GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { SyntaxKind } from '../syntax-kind.js';
import { VisitorBase } from './visitor-base.js';

export const enum FunctionFlags {
  Normal = 0,
  Generator = 1 << 0,
  Async = 1 << 1,
  Invalid = 1 << 2,
  AsyncGenerator = Async | Generator,
}

export function getFunctionFlags(node: Node): FunctionFlags {
  let flags = FunctionFlags.Normal;
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.MethodDeclaration:
      if (getAsteriskToken(node) !== undefined) flags |= FunctionFlags.Generator;
      if (hasAsyncModifier(node)) flags |= FunctionFlags.Async;
      break;
    case SyntaxKind.ArrowFunction:
      if (hasAsyncModifier(node)) flags |= FunctionFlags.Async;
      break;
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      break;
    default:
      return FunctionFlags.Invalid;
  }
  if (getBody(node) === undefined) flags |= FunctionFlags.Invalid;
  return flags;
}

function hasAsyncModifier(node: Node): boolean {
  const modifiers = getModifiers(node);
  return modifiers !== undefined && (modifiers.modifierFlags & ModifierFlags.Async) !== 0;
}

export function isFunctionLikeDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return true;
  }
  return false;
}

/** Whether every parameter is a plain identifier without an initializer. */
export function isSimpleParameterList(parameters: readonly Node[]): boolean {
  for (let i = 0; i < parameters.length; i++) {
    const parameter = parameters[i];
    if (!(parameter instanceof ParameterDeclaration)) continue;
    if (parameter.initializer !== undefined || !(parameter.name instanceof Identifier)) return false;
  }
  return true;
}

/** The super-access tracking of one async body, saved while a nested one is transformed. */
export class SuperAccessScope {
  readonly capturedSuperProperties: string[] | undefined;
  readonly hasSuperElementAccess: boolean;
  readonly hasSuperPropertyAssignment: boolean;
  readonly superBinding: Identifier | undefined;
  readonly superIndexBinding: Identifier | undefined;

  constructor(
    capturedSuperProperties: string[] | undefined,
    hasSuperElementAccess: boolean,
    hasSuperPropertyAssignment: boolean,
    superBinding: Identifier | undefined,
    superIndexBinding: Identifier | undefined,
  ) {
    this.capturedSuperProperties = capturedSuperProperties;
    this.hasSuperElementAccess = hasSuperElementAccess;
    this.hasSuperPropertyAssignment = hasSuperPropertyAssignment;
    this.superBinding = superBinding;
    this.superIndexBinding = superIndexBinding;
  }
}

/** Tracks `super.x`, `super[x]` and assignments to them in an async body, and rewrites them. */
export class SuperAccess extends VisitorBase {
  /** Property names read through `super.x`, in order; undefined outside of a method body. */
  capturedSuperProperties: string[] | undefined;
  hasSuperElementAccess: boolean;
  hasSuperPropertyAssignment: boolean;
  superBinding: Identifier | undefined;
  superIndexBinding: Identifier | undefined;

  constructor(context: EmitContext) {
    super(context);
    this.capturedSuperProperties = undefined;
    this.hasSuperElementAccess = false;
    this.hasSuperPropertyAssignment = false;
    this.superBinding = undefined;
    this.superIndexBinding = undefined;
  }

  /** Starts tracking a new method body; returns the enclosing body's state. */
  enter(): SuperAccessScope {
    const saved = new SuperAccessScope(
      this.capturedSuperProperties,
      this.hasSuperElementAccess,
      this.hasSuperPropertyAssignment,
      this.superBinding,
      this.superIndexBinding,
    );
    const flags = GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.FileLevel;
    this.capturedSuperProperties = [];
    this.hasSuperElementAccess = false;
    this.hasSuperPropertyAssignment = false;
    this.superBinding = this.factory.createUniqueName('_super', flags);
    this.superIndexBinding = this.factory.createUniqueName('_superIndex', flags);
    return saved;
  }

  exit(saved: SuperAccessScope): boolean {
    this.capturedSuperProperties = saved.capturedSuperProperties;
    this.hasSuperElementAccess = saved.hasSuperElementAccess;
    this.hasSuperPropertyAssignment = saved.hasSuperPropertyAssignment;
    this.superBinding = saved.superBinding;
    this.superIndexBinding = saved.superIndexBinding;
    return true;
  }

  /** Whether the body accesses `super`, so it needs `_super` or `_superIndex`. */
  needsHelpers(): boolean {
    return (
      this.capturedSuperProperties !== undefined &&
      (this.capturedSuperProperties.length > 0 || this.hasSuperElementAccess)
    );
  }

  /** Records a super access or assignment for the enclosing method body. */
  track(node: Node): boolean {
    const captured = this.capturedSuperProperties;
    if (captured === undefined) return false;
    if (node instanceof PropertyAccessExpression) {
      if (node.expression.kind === SyntaxKind.SuperKeyword && node.name instanceof Identifier)
        if (captured.indexOf(node.name.text) < 0) captured.push(node.name.text);
    } else if (node instanceof ElementAccessExpression) {
      if (node.expression.kind === SyntaxKind.SuperKeyword) this.hasSuperElementAccess = true;
    } else if (node instanceof BinaryExpression) {
      if (isAssignmentOperator(node.operatorToken.kind) && assignmentTargetContainsSuperProperty(node.left))
        this.hasSuperPropertyAssignment = true;
    } else if (node instanceof PrefixUnaryExpression) {
      if (isUpdateOperator(node.operator) && assignmentTargetContainsSuperProperty(node.operand))
        this.hasSuperPropertyAssignment = true;
    } else if (node instanceof PostfixUnaryExpression) {
      if (isUpdateOperator(node.operator) && assignmentTargetContainsSuperProperty(node.operand))
        this.hasSuperPropertyAssignment = true;
    }
    return true;
  }

  /** Replaces super accesses in an async body, which ends up in a generator where `super` is invalid. */
  visit(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.CallExpression:
        if (node instanceof CallExpression && isSuperProperty(node.expression))
          return this.substituteCallExpression(node);
        break;
      case SyntaxKind.PropertyAccessExpression:
        if (node instanceof PropertyAccessExpression && node.expression.kind === SyntaxKind.SuperKeyword)
          return this.factory.createPropertyAccessExpression(this.superBinding!, node.name);
        break;
      case SyntaxKind.ElementAccessExpression:
        if (node instanceof ElementAccessExpression && node.expression.kind === SyntaxKind.SuperKeyword)
          return this.createSuperElementAccess(node.argumentExpression);
        break;
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        return node;
    }
    return this.visitEachChild(node);
  }

  /** `super.x(args)` as `_super.x.call(this, args)`, `super[x](args)` as `_superIndex(x).call(this, args)`. */
  private substituteCallExpression(call: CallExpression): Node {
    const expression = call.expression;
    const factory = this.factory;
    let target: Node;
    if (expression instanceof PropertyAccessExpression)
      target = factory.createPropertyAccessExpression(this.superBinding!, expression.name);
    else if (expression instanceof ElementAccessExpression)
      target = this.createSuperElementAccess(expression.argumentExpression);
    else return this.visitEachChild(call);
    const args: Node[] = [factory.createKeywordExpression(SyntaxKind.ThisKeyword)];
    const visited = this.visitNodes(call.arguments);
    if (visited !== undefined) for (let i = 0; i < visited.nodes.length; i++) args.push(visited.nodes[i]);
    const result = factory.createCallExpression(
      factory.createPropertyAccessExpression(target, factory.createIdentifier('call')),
      args,
    );
    result.pos = call.pos;
    result.end = call.end;
    return result;
  }

  /** `_superIndex(x)`, or `_superIndex(x).value` when super properties are assigned. */
  private createSuperElementAccess(argument: Node): Node {
    const factory = this.factory;
    const call = factory.createCallExpression(this.superIndexBinding!, [argument]);
    if (this.hasSuperPropertyAssignment)
      return factory.createPropertyAccessExpression(call, factory.createIdentifier('value'));
    return call;
  }

  /**
   * `const _super = Object.create(null, { x: { get: () => super.x, set: v => super.x = v } });`,
   * with setters only when super properties are assigned.
   */
  createSuperAccessVariableStatement(): Node {
    const factory = this.factory;
    const accessors: Node[] = [];
    const names = this.capturedSuperProperties!;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const descriptor: Node[] = [];
      const getter = factory.createArrowFunction(
        [],
        factory.createPropertyAccessExpression(
          factory.createKeywordExpression(SyntaxKind.SuperKeyword),
          factory.createIdentifier(name),
        ),
      );
      descriptor.push(factory.createPropertyAssignment(factory.createIdentifier('get'), getter));
      if (this.hasSuperPropertyAssignment) {
        const setter = factory.createArrowFunction(
          [factory.createParameter(factory.createIdentifier('v'))],
          factory.createAssignment(
            factory.createPropertyAccessExpression(
              factory.createKeywordExpression(SyntaxKind.SuperKeyword),
              factory.createIdentifier(name),
            ),
            factory.createIdentifier('v'),
          ),
        );
        descriptor.push(factory.createPropertyAssignment(factory.createIdentifier('set'), setter));
      }
      accessors.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(name),
          factory.createObjectLiteral(descriptor, false),
        ),
      );
    }
    const create = factory.createCallExpression(
      factory.createPropertyAccessExpression(factory.createIdentifier('Object'), factory.createIdentifier('create')),
      [factory.createKeywordExpression(SyntaxKind.NullKeyword), factory.createObjectLiteral(accessors, true)],
    );
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([factory.createVariableDeclaration(this.superBinding!, undefined, undefined, create)]),
        NodeFlags.Const,
      ),
    );
  }
}

function isSuperProperty(node: Node): boolean {
  if (node instanceof PropertyAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  if (node instanceof ElementAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  return false;
}

function isUpdateOperator(operator: SyntaxKind): boolean {
  return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
}

/** Whether an assignment target contains `super.x` or `super[x]`, checked top-down. */
function assignmentTargetContainsSuperProperty(node: Node): boolean {
  if (node instanceof PropertyAccessExpression || node instanceof ElementAccessExpression) return isSuperProperty(node);
  if (node instanceof ParenthesizedExpression) return assignmentTargetContainsSuperProperty(node.expression);
  if (node instanceof SpreadElement) return assignmentTargetContainsSuperProperty(node.expression);
  if (node instanceof ArrayLiteralExpression) {
    const elements = node.elements.nodes;
    for (let i = 0; i < elements.length; i++) if (assignmentTargetContainsSuperProperty(elements[i])) return true;
    return false;
  }
  if (node instanceof ObjectLiteralExpression) {
    const properties = node.properties.nodes;
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      if (property instanceof PropertyAssignment && assignmentTargetContainsSuperProperty(property.initializer))
        return true;
      if (property instanceof ShorthandPropertyAssignment && assignmentTargetContainsSuperProperty(property.name))
        return true;
      if (property instanceof SpreadAssignment && assignmentTargetContainsSuperProperty(property.expression))
        return true;
    }
  }
  return false;
}
