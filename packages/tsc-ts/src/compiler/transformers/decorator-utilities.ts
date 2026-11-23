// Which declarations decorators apply to, and the accessor pairs and ranges decorator
// transforms need.
import {
  ArrayTypeNode,
  ComputedPropertyName,
  ParenthesizedTypeNode,
  TypeReferenceNode,
  Decorator,
  ModifierFlags,
  type Node,
  PrefixUnaryExpression,
  getBody,
  getMembers,
  getModifiers,
  getName,
  getParameters,
  getText,
} from '../ast.js';
import { nodeIsPresent } from '../ast-utilities.js';
import {
  TextRange,
  hasDynamicName,
  isClassLike,
  isSignedNumericLiteral,
  isStatic,
  isStringOrNumericLiteralLike,
} from '../binder-utilities.js';
import { positionIsSynthesized } from '../printer/utilities.js';
import { InternalSymbolName } from '../symbol.js';
import { SyntaxKind } from '../syntax-kind.js';
import { isSimpleCopiableExpression } from './destructuring.js';
import { hasDecorators, hasSyntacticModifier, isThisParameter } from './utilities.js';

/** The decorators among the modifiers of `node`. */
export function getDecorators(node: Node): Node[] {
  const modifiers = getModifiers(node);
  const decorators: Node[] = [];
  if (modifiers === undefined) return decorators;
  for (let i = 0; i < modifiers.nodes.length; i++)
    if (modifiers.nodes[i] instanceof Decorator) decorators.push(modifiers.nodes[i]!);
  return decorators;
}

export function isAccessor(node: Node): boolean {
  return node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor;
}

export function getFirstConstructorWithBody(node: Node): Node | undefined {
  const members = getMembers(node);
  if (members === undefined) return undefined;
  for (let i = 0; i < members.nodes.length; i++) {
    const member = members.nodes[i]!;
    if (member.kind === SyntaxKind.Constructor && nodeIsPresent(getBody(member))) return member;
  }
  return undefined;
}

/** Whether decorators on `node` take effect, as opposed to being a grammar error. */
export function nodeCanBeDecorated(
  legacy: boolean,
  node: Node,
  parent: Node | undefined,
  grandparent: Node | undefined,
): boolean {
  const name = getName(node);
  // Private names can't be decorated with legacy decorators.
  if (legacy && name !== undefined && name.kind === SyntaxKind.PrivateIdentifier) return false;
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
      return true;
    case SyntaxKind.ClassExpression:
      return !legacy;
    case SyntaxKind.PropertyDeclaration:
      return (
        parent !== undefined &&
        (legacy
          ? parent.kind === SyntaxKind.ClassDeclaration
          : isClassLike(parent) && !hasSyntacticModifier(node, ModifierFlags.Abstract | ModifierFlags.Ambient))
      );
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodDeclaration:
      return (
        parent !== undefined &&
        getBody(node) !== undefined &&
        (legacy ? parent.kind === SyntaxKind.ClassDeclaration : isClassLike(parent))
      );
    case SyntaxKind.Parameter: {
      // Parameter decorators aren't standard yet.
      if (!legacy || parent === undefined || getBody(parent) === undefined) return false;
      if (
        parent.kind !== SyntaxKind.Constructor &&
        parent.kind !== SyntaxKind.MethodDeclaration &&
        parent.kind !== SyntaxKind.SetAccessor
      )
        return false;
      const parameters = getParameters(parent);
      const thisParameter =
        parameters !== undefined && parameters.nodes.length > 0 && isThisParameter(parameters.nodes[0]!)
          ? parameters.nodes[0]
          : undefined;
      return thisParameter !== node && grandparent !== undefined && grandparent.kind === SyntaxKind.ClassDeclaration;
    }
  }
  return false;
}

export function nodeIsDecorated(
  legacy: boolean,
  node: Node,
  parent: Node | undefined,
  grandparent: Node | undefined,
): boolean {
  return hasDecorators(node) && nodeCanBeDecorated(legacy, node, parent, grandparent);
}

export function nodeOrChildIsDecorated(
  legacy: boolean,
  node: Node,
  parent: Node | undefined,
  grandparent: Node | undefined,
): boolean {
  return nodeIsDecorated(legacy, node, parent, grandparent) || childIsDecorated(legacy, node, parent);
}

/** Whether a member of a class, or a parameter of a method, setter or constructor, is decorated. */
export function childIsDecorated(legacy: boolean, node: Node, parent: Node | undefined): boolean {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression: {
      const members = getMembers(node)!.nodes;
      for (let i = 0; i < members.length; i++)
        if (nodeOrChildIsDecorated(legacy, members[i]!, node, parent)) return true;
      return false;
    }
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.Constructor: {
      const parameters = getParameters(node)!.nodes;
      for (let i = 0; i < parameters.length; i++)
        if (nodeIsDecorated(legacy, parameters[i]!, node, parent)) return true;
      return false;
    }
  }
  return false;
}

export function classOrConstructorParameterIsDecorated(legacy: boolean, node: Node): boolean {
  if (nodeIsDecorated(legacy, node, undefined, undefined)) return true;
  const constructor = getFirstConstructorWithBody(node);
  return constructor !== undefined && childIsDecorated(legacy, constructor, node);
}

export function classElementOrClassElementParameterIsDecorated(legacy: boolean, node: Node, parent: Node): boolean {
  let parameters: readonly Node[] | undefined = undefined;
  if (isAccessor(node)) {
    const accessors = getAllAccessorDeclarations(getMembers(parent)!.nodes, node);
    const first = accessors.firstWithDecorators();
    if (first === undefined || node !== first) return false;
    if (accessors.setAccessor !== undefined) parameters = getParameters(accessors.setAccessor)!.nodes;
  } else if (node.kind === SyntaxKind.MethodDeclaration) parameters = getParameters(node)!.nodes;
  if (nodeIsDecorated(legacy, node, parent, undefined)) return true;
  if (parameters !== undefined)
    for (let i = 0; i < parameters.length; i++) {
      const parameter = parameters[i]!;
      if (!isThisParameter(parameter) && nodeIsDecorated(legacy, parameter, node, parent)) return true;
    }
  return false;
}

/** The get and set accessors declaring one property, in source order. */
export class AllAccessorDeclarations {
  readonly firstAccessor: Node;
  readonly secondAccessor: Node | undefined;
  readonly getAccessor: Node | undefined;
  readonly setAccessor: Node | undefined;

  constructor(
    firstAccessor: Node,
    secondAccessor: Node | undefined,
    getAccessor: Node | undefined,
    setAccessor: Node | undefined,
  ) {
    this.firstAccessor = firstAccessor;
    this.secondAccessor = secondAccessor;
    this.getAccessor = getAccessor;
    this.setAccessor = setAccessor;
  }

  /** The first of the pair with decorators: legacy decorators apply to both. */
  firstWithDecorators(): Node | undefined {
    if (hasDecorators(this.firstAccessor)) return this.firstAccessor;
    if (this.secondAccessor !== undefined && hasDecorators(this.secondAccessor)) return this.secondAccessor;
    return undefined;
  }
}

/** `accessor` and the other accessor among `members` with the same name and staticness. */
export function getAllAccessorDeclarations(members: readonly Node[], accessor: Node): AllAccessorDeclarations {
  const otherKind = accessor.kind === SyntaxKind.SetAccessor ? SyntaxKind.GetAccessor : SyntaxKind.SetAccessor;
  let other: Node | undefined = undefined;
  // Dynamic names only match through the checker's symbols.
  if (!hasDynamicName(accessor)) {
    const name = getPropertyNameForPropertyNameNode(getName(accessor)!);
    const accessorStatic = isStatic(accessor);
    for (let i = 0; i < members.length && other === undefined; i++) {
      const member = members[i]!;
      if (member.kind !== otherKind || isStatic(member) !== accessorStatic) continue;
      if (getPropertyNameForPropertyNameNode(getName(member)!) === name) other = member;
    }
  }
  const otherFirst = other !== undefined && other.pos < accessor.pos;
  const first = otherFirst ? other! : accessor;
  const second = otherFirst ? accessor : other;
  return accessor.kind === SyntaxKind.SetAccessor
    ? new AllAccessorDeclarations(first, second, other, accessor)
    : new AllAccessorDeclarations(first, second, accessor, other);
}

/** The property name a name node declares; computed names other than literals are missing. */
export function getPropertyNameForPropertyNameNode(name: Node): string {
  if (name instanceof ComputedPropertyName) {
    const expression = name.expression;
    if (isStringOrNumericLiteralLike(expression)) return getText(expression);
    if (isSignedNumericLiteral(expression) && expression instanceof PrefixUnaryExpression) {
      const text = getText(expression.operand);
      return expression.operator === SyntaxKind.MinusToken ? '-' + text : text;
    }
    return InternalSymbolName.Missing;
  }
  return getText(name);
}

/** The range of `node` after its modifiers, for source maps of what replaces it. */
export function moveRangePastModifiers(node: Node): TextRange {
  if (node.kind === SyntaxKind.PropertyDeclaration || node.kind === SyntaxKind.MethodDeclaration)
    return new TextRange(getName(node)!.pos, node.end);
  const modifiers = getModifiers(node);
  if (modifiers !== undefined && modifiers.nodes.length > 0) {
    const last = modifiers.nodes[modifiers.nodes.length - 1]!;
    if (!positionIsSynthesized(last.end)) return new TextRange(last.end, node.end);
  }
  return moveRangePastDecorators(node);
}

/** The range of `node` after its decorators. */
export function moveRangePastDecorators(node: Node): TextRange {
  const modifiers = getModifiers(node);
  if (modifiers !== undefined)
    for (let i = modifiers.nodes.length - 1; i >= 0; i--) {
      const modifier = modifiers.nodes[i]!;
      if (modifier instanceof Decorator) {
        if (!positionIsSynthesized(modifier.end)) return new TextRange(modifier.end, node.end);
        break;
      }
    }
  return new TextRange(node.pos, node.end);
}

/** A literal or keyword: evaluated in place rather than cached. */
export function isSimpleInlineableExpression(node: Node): boolean {
  return node.kind !== SyntaxKind.Identifier && isSimpleCopiableExpression(node);
}

export function getSetAccessorValueParameter(node: Node): Node | undefined {
  const parameters = getParameters(node)!.nodes;
  if (parameters.length === 0) return undefined;
  if (parameters.length >= 2 && isThisParameter(parameters[0]!)) return parameters[1]!;
  return parameters[0]!;
}

/** `T` of a rest parameter's `T[]` or `Array<T>`. */
export function getRestParameterElementType(node: Node | undefined): Node | undefined {
  if (node instanceof ArrayTypeNode) return node.elementType;
  if (node instanceof TypeReferenceNode && node.typeArguments !== undefined && node.typeArguments.nodes.length > 0)
    return node.typeArguments.nodes[0]!;
  return undefined;
}

export function skipTypeParentheses(node: Node): Node {
  while (node instanceof ParenthesizedTypeNode) node = node.type;
  return node;
}
