// `super` expressions and `this` before `super(...)` in derived class constructors.
import { ScriptTarget } from './options.js';
import { markSuperPropertyInStaticInitializer } from './checker-generated-code.js';
import { type Node, getExpression, getFlowNode, getInitializer, getModifiers } from './ast.js';
import { isClassElement, isClassLike, isStatic } from './binder-utilities.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { type FlowNode, FlowFlags, type FlowReduceLabel } from './flow.js';
import { getBranchLabelAntecedents } from './checker-narrowing.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { type InterfaceType, type Type, ObjectFlags, TypeFlags } from './checker-types.js';
import {
  getBaseConstructorTypeOfClass,
  getBaseTypes,
  getDeclaredTypeOfSymbol,
  getExtendsHeritageClauseElement,
} from './checker-declared-types.js';
import { getTypeWithThisArgument } from './checker-members.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';

/** The type of `super` in `super(...)`, `super.x` or `super[x]`, reporting where it can't be used. */
export function checkSuperExpression(c: Checker, node: Node): Type {
  const parent = node.parent!;
  const isCallExpression = parent.kind === SyntaxKind.CallExpression && getExpression(parent) === node;
  const immediateContainer = getSuperContainer(node, true);
  let container = immediateContainer;
  // `super` property accesses in arrow functions belong to the enclosing container.
  if (!isCallExpression)
    while (container !== undefined && container.kind === SyntaxKind.ArrowFunction)
      container = getSuperContainer(container, true);
  if (container === undefined || !isLegalUsageOfSuperExpression(container, isCallExpression)) {
    if (isInComputedPropertyNameBefore(node, container))
      c.error(node, Diagnostics.X_super_cannot_be_referenced_in_a_computed_property_name);
    else if (isCallExpression)
      c.error(
        node,
        Diagnostics.Super_calls_are_not_permitted_outside_constructors_or_in_nested_functions_inside_constructors,
      );
    else if (
      container === undefined ||
      container.parent === undefined ||
      !(isClassLike(container.parent) || container.parent.kind === SyntaxKind.ObjectLiteralExpression)
    )
      c.error(
        node,
        Diagnostics.X_super_can_only_be_referenced_in_members_of_derived_classes_or_object_literal_expressions,
      );
    else
      c.error(
        node,
        Diagnostics.X_super_property_access_is_permitted_only_in_a_constructor_member_function_or_member_accessor_of_a_derived_class,
      );
    return c.errorType;
  }
  if (!isCallExpression && immediateContainer!.kind === SyntaxKind.Constructor)
    checkThisBeforeSuper(
      c,
      node,
      container,
      Diagnostics.X_super_must_be_called_before_accessing_a_property_of_super_in_the_constructor_of_a_derived_class,
    );
  // `super` in an object literal is `any`.
  if (container.parent!.kind === SyntaxKind.ObjectLiteralExpression) return c.anyType;
  const classLikeDeclaration = container.parent!;
  if (getExtendsHeritageClauseElement(classLikeDeclaration) === undefined) {
    c.error(node, Diagnostics.X_super_can_only_be_referenced_in_a_derived_class);
    return c.errorType;
  }
  if (classDeclarationExtendsNull(c, classLikeDeclaration)) return isCallExpression ? c.errorType : c.nullWideningType;
  const symbol = getSymbolOfDeclaration(c, classLikeDeclaration);
  if (symbol === undefined) return c.errorType;
  const classType = getDeclaredTypeOfSymbol(c, symbol);
  const baseTypes = getBaseTypes(c, classType);
  if (baseTypes.length === 0) return c.errorType;
  if (container.kind === SyntaxKind.Constructor && isInConstructorArgumentInitializer(node, container)) {
    c.error(node, Diagnostics.X_super_cannot_be_referenced_in_constructor_arguments);
    return c.errorType;
  }
  if (isStatic(container) || isCallExpression) {
    if (
      !isCallExpression &&
      c.languageVersion <= ScriptTarget.ES2021 &&
      (container.kind === SyntaxKind.PropertyDeclaration || container.kind === SyntaxKind.ClassStaticBlockDeclaration)
    )
      markSuperPropertyInStaticInitializer(c, node);
    return getBaseConstructorTypeOfClass(c, classType as InterfaceType);
  }
  return getTypeWithThisArgument(c, baseTypes[0]!, (classType as InterfaceType).thisType, false);
}

function isLegalUsageOfSuperExpression(container: Node, isCallExpression: boolean): boolean {
  // Super calls are only permitted in constructors of derived classes.
  if (isCallExpression) return container.kind === SyntaxKind.Constructor;
  // Super property accesses are permitted in members directly within a class or object literal.
  const parent = container.parent;
  if (parent === undefined || !(isClassLike(parent) || parent.kind === SyntaxKind.ObjectLiteralExpression))
    return false;
  switch (container.kind) {
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.PropertyDeclaration:
      return true;
    case SyntaxKind.ClassStaticBlockDeclaration:
      return isStatic(container);
    case SyntaxKind.PropertySignature:
    case SyntaxKind.Constructor:
      return !isStatic(container);
  }
  return false;
}

/** Whether `node` is in a computed property name below `container`. */
function isInComputedPropertyNameBefore(node: Node, container: Node | undefined): boolean {
  for (let current = node.parent; current !== undefined && current !== container; current = current.parent)
    if (current.kind === SyntaxKind.ComputedPropertyName) return true;
  return false;
}

function isInConstructorArgumentInitializer(node: Node, constructorDeclaration: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    if (isFunctionLikeDeclarationKind(current.kind)) return false;
    if (current.kind === SyntaxKind.Parameter && current.parent === constructorDeclaration) return true;
  }
  return false;
}

function isFunctionLikeDeclarationKind(kind: SyntaxKind): boolean {
  switch (kind) {
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

/** The member or function `super` at `node` belongs to. */
export function getSuperContainer(node: Node, stopOnFunctions: boolean): Node | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    switch (current.kind) {
      case SyntaxKind.ComputedPropertyName:
        current = current.parent!;
        break;
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
        if (stopOnFunctions) return current;
        break;
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertySignature:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.ClassStaticBlockDeclaration:
        return current;
      case SyntaxKind.Decorator: {
        // Decorators are applied outside the body of their class or method.
        const decorated = current.parent!;
        if (decorated.kind === SyntaxKind.Parameter && isClassElement(decorated.parent!)) current = decorated.parent!;
        else if (isClassElement(decorated)) current = decorated;
        break;
      }
    }
  }
  return undefined;
}

/** Reports `node` in a derived class constructor when it may run before `super(...)`. */
export function checkThisBeforeSuper(c: Checker, node: Node, container: Node, message: DiagnosticMessage): void {
  const containingClassDeclaration = container.parent!;
  // Classes without `extends`, or extending `null`, don't call `super`.
  if (getExtendsHeritageClauseElement(containingClassDeclaration) === undefined) return;
  if (classDeclarationExtendsNull(c, containingClassDeclaration)) return;
  const flow = getFlowNode(node);
  if (flow !== undefined && !isPostSuperFlowNode(c, flow, false)) c.error(node, message);
}

export function classDeclarationExtendsNull(c: Checker, classDeclaration: Node): boolean {
  const symbol = getSymbolOfDeclaration(c, classDeclaration);
  if (symbol === undefined) return false;
  const classType = getDeclaredTypeOfSymbol(c, symbol);
  if ((classType.objectFlags & ObjectFlags.ClassOrInterface) === 0 || (classType.flags & TypeFlags.Object) === 0)
    return false;
  return getBaseConstructorTypeOfClass(c, classType as InterfaceType) === c.nullWideningType;
}

/** Whether every path to `start` passes a `super(...)` call. */
function isPostSuperFlowNode(c: Checker, start: FlowNode, noCacheCheckIn: boolean): boolean {
  let flow = start;
  let noCacheCheck = noCacheCheckIn;
  for (;;) {
    const flags = flow.flags;
    if ((flags & FlowFlags.Shared) !== 0) {
      if (!noCacheCheck) {
        const cached = c.flowNodePostSuper.get(flow);
        if (cached !== undefined) return cached;
        const postSuper = isPostSuperFlowNode(c, flow, true);
        c.flowNodePostSuper.set(flow, postSuper);
        return postSuper;
      }
      noCacheCheck = false;
    }
    if ((flags & (FlowFlags.Assignment | FlowFlags.Condition | FlowFlags.ArrayMutation | FlowFlags.SwitchClause)) !== 0)
      flow = flow.antecedent!;
    else if ((flags & FlowFlags.Call) !== 0) {
      if (getExpression(flow.node!)!.kind === SyntaxKind.SuperKeyword) return true;
      flow = flow.antecedent!;
    } else if ((flags & FlowFlags.BranchLabel) !== 0) {
      for (const antecedent of getBranchLabelAntecedents(c, flow))
        if (!isPostSuperFlowNode(c, antecedent, false)) return false;
      return true;
    } else if ((flags & FlowFlags.LoopLabel) !== 0) {
      // A loop is post-super when the path into its top is.
      flow = flow.antecedents![0]!;
    } else if ((flags & FlowFlags.ReduceLabel) !== 0) {
      c.flowReduceLabels.push(flow as FlowReduceLabel);
      const result = isPostSuperFlowNode(c, flow.antecedent!, false);
      c.flowReduceLabels.pop();
      return result;
    }
    // Unreachable nodes count as post-super to silence errors.
    else return (flags & FlowFlags.Unreachable) !== 0;
  }
}

/** Reports `this` in a static property initializer of a class with legacy decorators. */
export function checkThisInStaticClassFieldInitializerInDecoratedClass(
  c: Checker,
  thisExpression: Node,
  container: Node,
): void {
  if (container.kind !== SyntaxKind.PropertyDeclaration || !isStatic(container) || !c.legacyDecorators) return;
  const initializer = getInitializer(container);
  if (
    initializer !== undefined &&
    initializer.pos <= thisExpression.pos &&
    thisExpression.pos <= initializer.end &&
    hasDecoratorModifier(container.parent!)
  )
    c.error(thisExpression, Diagnostics.Cannot_use_this_in_a_static_property_initializer_of_a_decorated_class);
}

function hasDecoratorModifier(node: Node): boolean {
  const modifiers = getModifiersOf(node);
  if (modifiers === undefined) return false;
  for (const modifier of modifiers) if (modifier.kind === SyntaxKind.Decorator) return true;
  return false;
}

function getModifiersOf(node: Node): readonly Node[] | undefined {
  const list = getModifiers(node);
  return list !== undefined ? list.nodes : undefined;
}
