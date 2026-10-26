// Destructuring: types of binding elements and the types implied by binding patterns.
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import { checkGrammarRestTrailingComma } from './checker-grammar.js';
import { markDestructuredPropertyAsReferenced } from './checker-unused.js';
import {
  type BinaryExpression,
  type BindingElement,
  type Node,
  type PropertyAssignment,
  type ShorthandPropertyAssignment,
  type SpreadAssignment,
  type SpreadElement,
  ModifierFlags,
  NodeFlags,
  getElements,
  getInitializer,
  getName,
  getProperties,
  getSymbol,
  getType,
  getFlowNode,
  StringLiteral,
  ParenthesizedExpression,
  ElementAccessExpression,
} from './ast.js';
import { isLeftHandSideExpression } from './ast-utilities.js';
import { TokenFlags } from './types.js';
import { getFlowTypeOfReference, getDestructuringPropertyName, getTypeOfInitializer } from './checker-narrowing.js';
import {
  getRootDeclaration,
  isClassLike,
  isPartOfParameterDeclaration,
  isPrivateIdentifierClassElementDeclaration,
} from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  AccessFlags,
  CheckMode,
  ElementFlags,
  type IndexInfo,
  ObjectFlags,
  TupleElementInfo,
  type Type,
  TypeFlags,
  type TypeReference,
} from './checker-types.js';
import {
  cloneTypeReference,
  createAnonymousType,
  createArrayType,
  createTupleTypeEx,
  getElementTypes,
  getTypeReferenceArity,
  tupleTargetOf,
  everyType,
  filterType,
  getNumberLiteralType,
  getUnionType,
  getUnionTypeEx,
  isTupleType,
  mapType,
  newIndexInfo,
  someType,
  typesOf,
  UnionReduction,
} from './checker-type-factory.js';
import {
  getIndexedAccessTypeEx,
  getIndexedAccessTypeOrUndefinedEx,
  getLiteralTypeFromProperty,
  getLiteralTypeFromPropertyName,
  isGenericIndexType,
  isGenericObjectType,
} from './checker-type-operators.js';
import {
  getBaseConstraintOfType,
  getBaseConstraintOrType,
  mapToBaseConstraintOrType,
  getDeclarationModifierFlagsFromSymbol,
  getReducedType,
  getIndexInfosOfType,
  getPropertiesOfObjectType,
  getPropertiesOfType,
  getPropertyOfType,
  isArrayLikeType,
} from './checker-members.js';
import { getGlobalTypeAliasSymbol, getSymbolOfDeclaration } from './checker-symbols.js';
import {
  getTypeForVariableLikeDeclaration,
  getTypeOfSymbol,
  addOptionality,
  getWidenedLiteralTypeForInitializer,
  widenTypeInferredFromInitializer,
  isReadonlySymbol,
  reportImplicitAny,
  declarationBelongsToPrivateAmbientMember,
  isOptionalDeclaration,
} from './checker-symbol-types.js';
import { getTypeAliasInstantiation } from './checker-type-nodes.js';
import { isTypeAssignableTo } from './relations.js';
import {
  checkDeclarationInitializer,
  checkExpression,
  checkExpressionCached,
  checkExpressionEx,
  checkNonNullType,
  checkTypeAssignableToAndOptionallyElaborate,
} from './checker-expressions.js';
import { IterationUse, checkIteratedTypeOrElementType, createIterableType } from './checker-iteration.js';
import { ScriptTarget } from './options.js';
import {
  checkBinaryExpression,
  checkReferenceExpression,
  grammarErrorOnNode,
  removeDefinitelyFalsyTypes,
} from './checker-operators.js';
import { TypeFacts, getNonNullableType, getTypeWithFacts, hasTypeFacts } from './checker-flow.js';
import { sliceTupleType } from './checker-signatures.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName, maybeTypeOfKind } from './checker-utilities.js';
import { checkPropertyAccessibility } from './checker-property-access.js';
import {
  CheckFlags,
  copyDeclarations,
  declarationAt,
  declarationCount,
  getSymbolId,
  type Symbol,
  SymbolFlags,
} from './symbol.js';

function isBindingPatternNode(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern)
  );
}

/** The type of a binding element, from the type of the declaration it destructures. */
export function getTypeForBindingElement(c: Checker, declaration: Node): Type | undefined {
  const pattern = declaration.parent!;
  const checkMode =
    (declaration as BindingElement).dotDotDotToken !== undefined ? CheckMode.RestBindingElement : CheckMode.Normal;
  const parentType = getTypeForBindingElementParent(c, pattern.parent!, checkMode);
  if (parentType === undefined || parentType === c.errorType) return parentType;
  return getBindingElementTypeFromParentType(c, declaration as BindingElement, parentType, false);
}

/** The type of a destructured element narrowed like `init["name"]` at the position of its initializer. */
function getFlowTypeOfDestructuring(c: Checker, node: Node, declaredType: Type): Type {
  const reference = getSyntheticElementAccess(c, node);
  return reference !== undefined
    ? getFlowTypeOfReference(c, reference, declaredType, declaredType, undefined)
    : declaredType;
}

function getSyntheticElementAccess(c: Checker, node: Node): Node | undefined {
  const parentAccess = getParentElementAccess(c, node);
  if (parentAccess === undefined) return undefined;
  const flowNode = getFlowNode(parentAccess);
  if (flowNode === undefined) return undefined;
  const propName = getDestructuringPropertyName(c, node);
  if (propName === undefined) return undefined;
  const literal = new StringLiteral(propName, TokenFlags.None);
  literal.pos = node.pos;
  literal.end = node.end;
  let lhs = parentAccess;
  if (!isLeftHandSideExpression(parentAccess)) {
    lhs = new ParenthesizedExpression(parentAccess);
    lhs.pos = node.pos;
    lhs.end = node.end;
  }
  const result = new ElementAccessExpression(lhs, undefined, literal, NodeFlags.None);
  result.pos = node.pos;
  result.end = node.end;
  literal.parent = result;
  result.parent = node;
  if (lhs !== parentAccess) lhs.parent = result;
  result.flowNode = flowNode;
  return result;
}

function getParentElementAccess(c: Checker, node: Node): Node | undefined {
  const ancestor = node.parent!.parent!;
  switch (ancestor.kind) {
    case SyntaxKind.BindingElement:
    case SyntaxKind.PropertyAssignment:
      return getSyntheticElementAccess(c, ancestor);
    case SyntaxKind.ArrayLiteralExpression:
      return getSyntheticElementAccess(c, node.parent!);
    case SyntaxKind.VariableDeclaration:
      return getInitializer(ancestor);
    case SyntaxKind.BinaryExpression:
      return (ancestor as BinaryExpression).right;
  }
  return undefined;
}

export function getTypeForBindingElementParent(c: Checker, node: Node, checkMode: CheckMode): Type | undefined {
  if (checkMode === CheckMode.Normal) {
    // A resolved type can be used when it includes no optionality.
    const symbol = getSymbolOfDeclaration(c, node);
    if (symbol !== undefined) {
      const cached = c.symbolTypes.get(getSymbolId(symbol));
      if (cached !== undefined && !(c.strictNullChecks && isOptionalDeclaration(node))) return cached;
    }
  }
  return getTypeForVariableLikeDeclaration(c, node, false, checkMode);
}

export function getBindingElementTypeFromParentType(
  c: Checker,
  declaration: BindingElement,
  parentTypeIn: Type,
  noTupleBoundsCheck: boolean,
): Type {
  if ((parentTypeIn.flags & TypeFlags.Any) !== 0) return parentTypeIn;
  let parentType = parentTypeIn;
  const pattern = declaration.parent!;
  const parentInitializer = getInitializer(pattern.parent!);
  // Ambient destructuring parameters are documentation only, so nullability isn't checked.
  if (c.strictNullChecks && (declaration.flags & NodeFlags.Ambient) !== 0 && isPartOfParameterDeclaration(declaration))
    parentType = getNonNullableType(c, parentType);
  else if (
    c.strictNullChecks &&
    parentInitializer !== undefined &&
    !hasTypeFacts(c, getTypeOfInitializer(c, parentInitializer), TypeFacts.EQUndefined)
  )
    parentType = getTypeWithFacts(c, parentType, TypeFacts.NEUndefined);
  const accessFlags =
    AccessFlags.ExpressionPosition |
    (noTupleBoundsCheck || declaration.initializer !== undefined ? AccessFlags.AllowMissing : 0);
  let t: Type;
  if (pattern.kind === SyntaxKind.ObjectBindingPattern) {
    if (declaration.dotDotDotToken !== undefined) {
      parentType = getReducedType(c, parentType);
      if ((parentType.flags & TypeFlags.Unknown) !== 0 || !isValidSpreadType(c, parentType)) {
        c.error(declaration, Diagnostics.Rest_types_may_only_be_created_from_object_types);
        return c.errorType;
      }
      const literalMembers: Node[] = [];
      for (const e of getElements(pattern)!.nodes) {
        const element = e as BindingElement;
        if (element.dotDotDotToken === undefined) literalMembers.push(element.propertyName ?? element.name!);
      }
      t = getRestType(c, parentType, literalMembers, getSymbol(declaration));
    } else {
      const name = declaration.propertyName ?? declaration.name!;
      const declaredType = getIndexedAccessTypeEx(
        c,
        parentType,
        getLiteralTypeFromPropertyName(c, name) ?? c.errorType,
        accessFlags,
        name,
        undefined,
      );
      t = getFlowTypeOfDestructuring(c, declaration, declaredType);
    }
  } else {
    // Used when the tuple element for the index is missing; also checks that the parent is iterable.
    const elementType = checkIteratedTypeOrElementType(
      c,
      IterationUse.Destructuring | (declaration.dotDotDotToken !== undefined ? 0 : IterationUse.PossiblyOutOfBounds),
      parentType,
      c.undefinedType,
      pattern,
    );
    const index = getElements(pattern)!.nodes.indexOf(declaration);
    if (declaration.dotDotDotToken !== undefined) {
      // A rest element of a tuple gets the remaining elements; of an array, the same array type.
      const baseConstraint = mapType(c, parentType, (u) =>
        (u.flags & TypeFlags.InstantiableNonPrimitive) !== 0 ? getBaseConstraintOrType(c, u) : u,
      );
      t = everyType(baseConstraint, isTupleType)
        ? mapType(c, baseConstraint, (u) => sliceTupleType(c, u, index, 0))
        : createArrayType(c, elementType);
    } else if (isArrayLikeType(c, parentType)) {
      const declaredType =
        getIndexedAccessTypeOrUndefinedEx(
          c,
          parentType,
          getNumberLiteralType(c, index),
          accessFlags,
          declaration.name,
          undefined,
        ) ?? c.errorType;
      t = getFlowTypeOfDestructuring(c, declaration, declaredType);
    } else t = elementType;
  }
  if (declaration.initializer === undefined) return t;
  if (getType(walkUpBindingElementsAndPatterns(declaration)) !== undefined) {
    // A default without undefined removes undefined from an annotated type.
    if (c.strictNullChecks && !hasTypeFacts(c, checkDeclarationInitializer(c, declaration), TypeFacts.IsUndefined))
      return getNonUndefinedType(c, t);
    return t;
  }
  return widenTypeInferredFromInitializer(
    c,
    declaration,
    getUnionTypeEx(
      c,
      [getNonUndefinedType(c, t), checkDeclarationInitializer(c, declaration)],
      UnionReduction.Subtype,
      undefined,
      undefined,
    ),
  );
}

/** The binding pattern's root declaration: the variable or parameter it destructures. */
function walkUpBindingElementsAndPatterns(node: Node): Node {
  let current = node.parent!;
  while (current.kind === SyntaxKind.BindingElement || isBindingPatternNode(current)) current = current.parent!;
  return current;
}

/** `t` without undefined, also when it's a generic type whose constraint includes undefined. */
export function getNonUndefinedType(c: Checker, t: Type): Type {
  const typeOrConstraint = someType(t, (u) => isGenericTypeWithUndefinedConstraint(c, u))
    ? mapType(c, t, (u) => ((u.flags & TypeFlags.Instantiable) !== 0 ? getBaseConstraintOrType(c, u) : u))
    : t;
  return getTypeWithFacts(c, typeOrConstraint, TypeFacts.NEUndefined);
}

function isGenericTypeWithUndefinedConstraint(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Instantiable) === 0) return false;
  const constraint = getBaseConstraintOfType(c, t);
  return constraint !== undefined && maybeTypeOfKind(constraint, TypeFlags.Undefined);
}

/** The type implied by a binding pattern, for declarations without annotations or initializers. */
export function getTypeFromBindingPattern(
  c: Checker,
  pattern: Node,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  // References to the pattern's own elements in its initializers are `any` while its type is a contextual type.
  if (includePatternInType) c.contextualBindingPatterns.push(pattern);
  const result =
    pattern.kind === SyntaxKind.ObjectBindingPattern
      ? getTypeFromObjectBindingPattern(c, pattern, includePatternInType, reportErrors)
      : getTypeFromArrayBindingPattern(c, pattern, includePatternInType, reportErrors);
  if (includePatternInType) c.contextualBindingPatterns.pop();
  return result;
}

function getTypeFromObjectBindingPattern(
  c: Checker,
  pattern: Node,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  const members = new Map<string, Symbol>();
  const indexInfos: IndexInfo[] = [];
  let objectFlags = ObjectFlags.ObjectLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
  for (const node of getElements(pattern)!.nodes) {
    const e = node as BindingElement;
    if (e.dotDotDotToken !== undefined) {
      indexInfos.push(newIndexInfo(c.stringType, c.anyType, false, undefined));
      continue;
    }
    const exprType = getLiteralTypeFromPropertyName(c, e.propertyName ?? e.name!) ?? c.errorType;
    if (!isTypeUsableAsPropertyName(exprType)) {
      objectFlags |= ObjectFlags.ObjectLiteralPatternWithComputedProperties;
      continue;
    }
    const flags = SymbolFlags.Property | (e.initializer !== undefined ? SymbolFlags.Optional : 0);
    const symbol = c.newSymbol(flags, getPropertyNameFromType(exprType));
    c.symbolTypes.set(getSymbolId(symbol), getTypeFromBindingElement(c, e, includePatternInType, reportErrors));
    members.set(symbol.name, symbol);
  }
  const result = createAnonymousType(c, undefined, members, [], [], indexInfos);
  result.objectFlags |= objectFlags;
  if (includePatternInType) {
    c.patternForType.set(result, pattern);
    result.objectFlags |= ObjectFlags.ContainsObjectOrArrayLiteral;
  }
  return result;
}

function getTypeFromArrayBindingPattern(
  c: Checker,
  pattern: Node,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  const elements = getElements(pattern)!.nodes;
  const last = elements.length > 0 ? elements[elements.length - 1]! : undefined;
  const restElement =
    last !== undefined &&
    last.kind === SyntaxKind.BindingElement &&
    (last as BindingElement).dotDotDotToken !== undefined
      ? last
      : undefined;
  if (elements.length === 0 || (elements.length === 1 && restElement !== undefined))
    return c.languageVersion >= ScriptTarget.ES2015 ? createIterableType(c, c.anyType) : c.anyArrayType;
  let minLength = 0;
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i]!;
    if (!(e === restElement || getName(e) === undefined || getInitializer(e) !== undefined)) {
      minLength = i + 1;
      break;
    }
  }
  const types: Type[] = [];
  const infos: TupleElementInfo[] = [];
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i]!;
    types.push(
      // Omitted elements are binding elements without a name.
      getName(e) === undefined
        ? c.anyType
        : getTypeFromBindingElement(c, e as BindingElement, includePatternInType, reportErrors),
    );
    const flags =
      e === restElement ? ElementFlags.Rest : i >= minLength ? ElementFlags.Optional : ElementFlags.Required;
    infos.push(new TupleElementInfo(flags, undefined));
  }
  const result = createTupleTypeEx(c, types, infos, false);
  if (!includePatternInType) return result;
  const clone = cloneTypeReference(c, result as TypeReference);
  c.patternForType.set(clone, pattern);
  clone.objectFlags |= ObjectFlags.ContainsObjectOrArrayLiteral;
  return clone;
}

function getTypeFromBindingElement(
  c: Checker,
  element: BindingElement,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  if (element.initializer !== undefined) {
    // The implied type doesn't depend on context: the initializer is checked without a contextual
    // type, or with the type implied by the element's own pattern.
    const contextualType = isBindingPatternNode(element.name)
      ? getTypeFromBindingPattern(c, element.name!, true, false)
      : c.unknownType;
    const t = checkDeclarationInitializer(c, element, CheckMode.Normal, contextualType);
    return addOptionality(c, getWidenedLiteralTypeForInitializer(c, element, t), false, true);
  }
  if (isBindingPatternNode(element.name))
    return getTypeFromBindingPattern(c, element.name!, includePatternInType, reportErrors);
  if (reportErrors && c.noImplicitAny && !declarationBelongsToPrivateAmbientMember(element))
    reportImplicitAny(c, element, c.anyType);
  return includePatternInType ? c.nonInferrableAnyType : c.anyType;
}

/**
 * The initializer type of a parameter or its binding element, padded with the members its binding
 * pattern defaults or binds past the end of a tuple.
 */
export function padParameterInitializerType(c: Checker, declaration: Node, t: Type): Type {
  if (getRootDeclaration(declaration).kind !== SyntaxKind.Parameter) return t;
  const name = getName(declaration);
  if (name === undefined) return t;
  if (name.kind === SyntaxKind.ObjectBindingPattern && (t.objectFlags & ObjectFlags.ObjectLiteral) !== 0)
    return padObjectLiteralType(c, t, name);
  if (name.kind === SyntaxKind.ArrayBindingPattern && isTupleType(t)) return padTupleType(c, t, name);
  return t;
}

/** An object literal type with optional properties added for the pattern's defaulted elements it lacks. */
function padObjectLiteralType(c: Checker, t: Type, pattern: Node): Type {
  const missingElements: BindingElement[] = [];
  for (const node of getElements(pattern)!.nodes) {
    const e = node as BindingElement;
    if (e.dotDotDotToken !== undefined) continue;
    const name = getPropertyNameFromBindingElement(c, e);
    if (name !== undefined && getPropertyOfType(c, t, name) === undefined) missingElements.push(e);
  }
  if (missingElements.length === 0) return t;
  const members = new Map<string, Symbol>();
  for (const prop of getPropertiesOfObjectType(c, t)) members.set(prop.name, prop);
  for (const e of missingElements) {
    const symbol = c.newSymbol(SymbolFlags.Property | SymbolFlags.Optional, getPropertyNameFromBindingElement(c, e)!);
    c.symbolTypes.set(getSymbolId(symbol), getTypeFromBindingElement(c, e, false, true));
    members.set(symbol.name, symbol);
  }
  const result = createAnonymousType(c, t.symbol, members, [], [], getIndexInfosOfType(c, t));
  result.objectFlags = (t.objectFlags & ~ObjectFlags.SideState) | (result.objectFlags & ObjectFlags.SideState);
  return result;
}

function getPropertyNameFromBindingElement(c: Checker, e: BindingElement): string | undefined {
  const exprType = getLiteralTypeFromPropertyName(c, e.propertyName ?? e.name!);
  return exprType !== undefined && isTypeUsableAsPropertyName(exprType) ? getPropertyNameFromType(exprType) : undefined;
}

/**
 * A parameter's tuple initializer type, padded with optional elements for the pattern's elements
 * past its end, so `([x, y] = [1])` gets `[number, any?]`.
 */
export function padTupleType(c: Checker, t: Type, pattern: Node): Type {
  const patternElements = getElements(pattern)!.nodes;
  const target = tupleTargetOf(t);
  const arity = getTypeReferenceArity(t);
  if ((target.combinedFlags & ElementFlags.Variable) !== 0 || arity >= patternElements.length) return t;
  const elementTypes = getElementTypes(c, t).slice();
  const elementInfos = target.elementInfos.slice();
  for (let i = arity; i < patternElements.length; i++) {
    const e = patternElements[i]!;
    if (
      i < patternElements.length - 1 ||
      !(e.kind === SyntaxKind.BindingElement && (e as BindingElement).dotDotDotToken !== undefined)
    ) {
      const omitted = e.kind === SyntaxKind.OmittedExpression;
      elementTypes.push(
        !omitted && hasDefaultValue(e) ? getTypeFromBindingElement(c, e as BindingElement, false, false) : c.anyType,
      );
      elementInfos.push(new TupleElementInfo(ElementFlags.Optional, undefined));
      if (!omitted && !hasDefaultValue(e)) reportImplicitAny(c, e, c.anyType);
    }
  }
  return createTupleTypeEx(c, elementTypes, elementInfos, target.readonly);
}

// ---- Destructuring assignments

/** Checks an assignment of `sourceType` to a target, which may be an object or array literal pattern. */
export function checkDestructuringAssignment(
  c: Checker,
  node: Node,
  sourceTypeIn: Type,
  checkMode: CheckMode,
  rightIsThis: boolean,
): Type {
  let sourceType = sourceTypeIn;
  let target = node;
  if (node.kind === SyntaxKind.ShorthandPropertyAssignment) {
    const shorthand = node as ShorthandPropertyAssignment;
    const initializer = shorthand.objectAssignmentInitializer;
    if (initializer !== undefined) {
      // A default of a type without undefined removes undefined from the assigned type.
      if (c.strictNullChecks && !hasTypeFacts(c, checkExpression(c, initializer), TypeFacts.IsUndefined))
        sourceType = getTypeWithFacts(c, sourceType, TypeFacts.NEUndefined);
      checkShorthandDefault(c, shorthand, initializer, checkMode);
    }
    target = shorthand.name;
  }
  if (
    target.kind === SyntaxKind.BinaryExpression &&
    (target as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken
  ) {
    checkBinaryExpression(c, target as BinaryExpression, checkMode);
    target = (target as BinaryExpression).left;
    if (c.strictNullChecks) sourceType = getTypeWithFacts(c, sourceType, TypeFacts.NEUndefined);
  }
  if (target.kind === SyntaxKind.ObjectLiteralExpression)
    return checkObjectLiteralAssignment(c, target, sourceType, rightIsThis);
  if (target.kind === SyntaxKind.ArrayLiteralExpression)
    return checkArrayLiteralAssignment(c, target, sourceType, checkMode);
  return checkReferenceAssignment(c, target, sourceType, checkMode);
}

/** Checks `name = initializer` in a shorthand property of an assignment pattern. */
function checkShorthandDefault(
  c: Checker,
  node: ShorthandPropertyAssignment,
  initializer: Node,
  checkMode: CheckMode,
): void {
  const leftType = checkExpressionCached(c, node.name);
  const rightType = checkExpressionEx(c, initializer, checkMode);
  if (
    checkReferenceExpression(
      c,
      node.name,
      Diagnostics.The_left_hand_side_of_an_assignment_expression_must_be_a_variable_or_a_property_access,
      Diagnostics.The_left_hand_side_of_an_assignment_expression_may_not_be_an_optional_property_access,
    )
  )
    checkTypeAssignableToAndOptionallyElaborate(c, rightType, leftType, node.name, initializer);
}

function checkObjectLiteralAssignment(c: Checker, node: Node, sourceType: Type, rightIsThis: boolean): Type {
  const properties = getProperties(node)!.nodes;
  if (c.strictNullChecks && properties.length === 0) return checkNonNullType(c, sourceType, node);
  for (let i = 0; i < properties.length; i++)
    checkObjectLiteralDestructuringPropertyAssignment(c, properties, sourceType, i, rightIsThis);
  return sourceType;
}

function checkObjectLiteralDestructuringPropertyAssignment(
  c: Checker,
  properties: readonly Node[],
  objectLiteralType: Type,
  propertyIndex: number,
  rightIsThis: boolean,
): void {
  const property = properties[propertyIndex]!;
  if (property.kind === SyntaxKind.PropertyAssignment || property.kind === SyntaxKind.ShorthandPropertyAssignment) {
    const name = getName(property)!;
    if (name.kind === SyntaxKind.PrivateIdentifier)
      grammarErrorOnNode(c, name, Diagnostics.Private_identifiers_cannot_be_used_in_destructuring_patterns);
    markDestructuredPropertyAsReferenced(c, objectLiteralType, name, property, rightIsThis);
    const exprType = getLiteralTypeFromPropertyName(c, name) ?? c.errorType;
    if (isTypeUsableAsPropertyName(exprType)) {
      const prop = getPropertyOfType(c, objectLiteralType, getPropertyNameFromType(exprType));
      if (prop !== undefined) checkPropertyAccessibility(c, property, false, true, objectLiteralType, prop);
    }
    const elementType = getIndexedAccessTypeEx(
      c,
      objectLiteralType,
      exprType,
      AccessFlags.ExpressionPosition | (hasDefaultValue(property) ? AccessFlags.AllowMissing : 0),
      name,
      undefined,
    );
    const expr =
      property.kind === SyntaxKind.PropertyAssignment ? (property as PropertyAssignment).initializer : property;
    checkDestructuringAssignment(
      c,
      expr,
      getFlowTypeOfDestructuring(c, property, elementType),
      CheckMode.Normal,
      false,
    );
    return;
  }
  if (property.kind === SyntaxKind.SpreadAssignment) {
    if (propertyIndex < properties.length - 1) {
      c.error(property, Diagnostics.A_rest_element_must_be_last_in_a_destructuring_pattern);
      return;
    }
    if (c.languageVersion < ScriptTarget.ES2018) checkExternalEmitHelpers(c, property, ExternalEmitHelpers.Rest);
    const nonRestNames: Node[] = [];
    for (const other of properties) if (other.kind !== SyntaxKind.SpreadAssignment) nonRestNames.push(getName(other)!);
    const t = getRestType(c, objectLiteralType, nonRestNames, objectLiteralType.symbol);
    checkGrammarRestTrailingComma(c, property.parent!, getProperties(property.parent!)!);
    checkDestructuringAssignment(c, (property as SpreadAssignment).expression, t, CheckMode.Normal, false);
    return;
  }
  c.error(property, Diagnostics.Property_assignment_expected);
}

function checkArrayLiteralAssignment(c: Checker, node: Node, sourceType: Type, checkMode: CheckMode): Type {
  const elements = getElements(node)!.nodes;
  // Used when the tuple element for an index is missing; also checks that the source is iterable.
  const possiblyOutOfBoundsType = checkIteratedTypeOrElementType(
    c,
    IterationUse.Destructuring | IterationUse.PossiblyOutOfBounds,
    sourceType,
    c.undefinedType,
    node,
  );
  let inBoundsType = c.noUncheckedIndexedAccess ? undefined : possiblyOutOfBoundsType;
  for (let i = 0; i < elements.length; i++) {
    let t = possiblyOutOfBoundsType;
    if (elements[i]!.kind === SyntaxKind.SpreadElement) {
      if (inBoundsType === undefined)
        inBoundsType = checkIteratedTypeOrElementType(c, IterationUse.Destructuring, sourceType, c.undefinedType, node);
      t = inBoundsType;
    }
    checkArrayLiteralDestructuringElementAssignment(c, elements, sourceType, i, t, checkMode);
  }
  return sourceType;
}

function checkArrayLiteralDestructuringElementAssignment(
  c: Checker,
  elements: readonly Node[],
  sourceType: Type,
  elementIndex: number,
  elementType: Type,
  checkMode: CheckMode,
): void {
  const element = elements[elementIndex]!;
  if (element.kind === SyntaxKind.OmittedExpression) return;
  if (element.kind !== SyntaxKind.SpreadElement) {
    if (isArrayLikeType(c, sourceType)) {
      const indexType = getNumberLiteralType(c, elementIndex);
      const accessFlags = AccessFlags.ExpressionPosition | (hasDefaultValue(element) ? AccessFlags.AllowMissing : 0);
      // Element access targets would be mistaken for the access itself.
      const accessNode = element.kind === SyntaxKind.ElementAccessExpression ? undefined : element;
      const t =
        getIndexedAccessTypeOrUndefinedEx(c, sourceType, indexType, accessFlags, accessNode, undefined) ?? c.errorType;
      const assigned = hasDefaultValue(element) ? getTypeWithFacts(c, t, TypeFacts.NEUndefined) : t;
      checkDestructuringAssignment(c, element, getFlowTypeOfDestructuring(c, element, assigned), checkMode, false);
      return;
    }
    checkDestructuringAssignment(c, element, elementType, checkMode, false);
    return;
  }
  if (elementIndex < elements.length - 1) {
    c.error(element, Diagnostics.A_rest_element_must_be_last_in_a_destructuring_pattern);
    return;
  }
  const restExpression = (element as SpreadElement).expression;
  if (
    restExpression.kind === SyntaxKind.BinaryExpression &&
    (restExpression as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken
  ) {
    c.error((restExpression as BinaryExpression).operatorToken, Diagnostics.A_rest_element_cannot_have_an_initializer);
    return;
  }
  checkGrammarRestTrailingComma(c, element, getElements(element.parent!)!);
  const t = everyType(sourceType, isTupleType)
    ? mapType(c, sourceType, (u) => sliceTupleType(c, u, elementIndex, 0))
    : createArrayType(c, elementType);
  checkDestructuringAssignment(c, restExpression, t, checkMode, false);
}

function checkReferenceAssignment(c: Checker, target: Node, sourceType: Type, checkMode: CheckMode): Type {
  const targetType = checkExpressionEx(c, target, checkMode);
  const inRest = target.parent!.kind === SyntaxKind.SpreadAssignment;
  if (
    checkReferenceExpression(
      c,
      target,
      inRest
        ? Diagnostics.The_target_of_an_object_rest_assignment_must_be_a_variable_or_a_property_access
        : Diagnostics.The_left_hand_side_of_an_assignment_expression_must_be_a_variable_or_a_property_access,
      inRest
        ? Diagnostics.The_target_of_an_object_rest_assignment_may_not_be_an_optional_property_access
        : Diagnostics.The_left_hand_side_of_an_assignment_expression_may_not_be_an_optional_property_access,
    )
  )
    checkTypeAssignableToAndOptionallyElaborate(c, sourceType, targetType, target, target);
  return sourceType;
}

/** Whether a destructuring element has a default value. */
export function hasDefaultValue(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.BindingElement:
      return (node as BindingElement).initializer !== undefined;
    case SyntaxKind.PropertyAssignment:
      return hasDefaultValue((node as PropertyAssignment).initializer);
    case SyntaxKind.ShorthandPropertyAssignment:
      return (node as ShorthandPropertyAssignment).objectAssignmentInitializer !== undefined;
    case SyntaxKind.BinaryExpression:
      return (node as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken;
  }
  return false;
}

// ---- Rest types

/** The type of an object rest element: `source` without the named properties. */
export function getRestType(c: Checker, sourceIn: Type, properties: readonly Node[], symbol: Symbol | undefined): Type {
  const source = filterType(c, sourceIn, (t) => (t.flags & TypeFlags.Nullable) === 0);
  if ((source.flags & TypeFlags.Never) !== 0) return c.emptyObjectType;
  if ((source.flags & TypeFlags.Union) !== 0) return mapType(c, source, (t) => getRestType(c, t, properties, symbol));
  const omitKeys: Type[] = [];
  for (const p of properties) omitKeys.push(getLiteralTypeFromPropertyName(c, p) ?? c.errorType);
  let omitKeyType = getUnionType(c, omitKeys);
  const spreadable: Symbol[] = [];
  const unspreadableKeys: Type[] = [];
  for (const prop of getPropertiesOfType(c, source)) {
    const literal = getLiteralTypeFromProperty(c, prop, TypeFlags.StringOrNumberLiteralOrUnique, false);
    if (
      !isTypeAssignableTo(c, literal, omitKeyType) &&
      (getDeclarationModifierFlagsFromSymbol(c, prop, false) & (ModifierFlags.Private | ModifierFlags.Protected)) ===
        0 &&
      isSpreadableProperty(prop)
    )
      spreadable.push(prop);
    else unspreadableKeys.push(literal);
  }
  if (isGenericObjectType(c, source) || isGenericIndexType(c, omitKeyType)) {
    // Members a rest element never receives, like methods, are omitted explicitly as well.
    if (unspreadableKeys.length !== 0) omitKeyType = getUnionType(c, [omitKeyType, ...unspreadableKeys]);
    if ((omitKeyType.flags & TypeFlags.Never) !== 0) return source;
    const omit = getGlobalTypeAliasSymbol(c, 'Omit', 2, true);
    if (omit === undefined) return c.errorType;
    return getTypeAliasInstantiation(c, omit, [source, omitKeyType], undefined);
  }
  const members = new Map<string, Symbol>();
  for (const prop of spreadable) members.set(prop.name, getSpreadSymbol(c, prop, false));
  const result = createAnonymousType(c, symbol, members, [], [], getIndexInfosOfType(c, source));
  result.objectFlags |= ObjectFlags.ObjectRestType;
  return result;
}

/** Approximates own properties: non-methods, plus methods declared outside classes. */
export function isSpreadableProperty(prop: Symbol): boolean {
  const notMethodOrAccessor =
    (prop.flags & (SymbolFlags.Method | SymbolFlags.GetAccessor | SymbolFlags.SetAccessor)) === 0;
  let hasPrivateName = false;
  let inClass = false;
  for (let i = 0; i < declarationCount(prop); i++) {
    const d = declarationAt(prop, i);
    if (isPrivateIdentifierClassElementDeclaration(d)) hasPrivateName = true;
    if (d.parent !== undefined && isClassLike(d.parent)) inClass = true;
  }
  return (!hasPrivateName && notMethodOrAccessor) || !inClass;
}

/** `prop` as a member of a spread or rest type, with the given readonlyness. */
export function getSpreadSymbol(c: Checker, prop: Symbol, readonly: boolean): Symbol {
  const isSetonlyAccessor =
    (prop.flags & SymbolFlags.SetAccessor) !== 0 && (prop.flags & SymbolFlags.GetAccessor) === 0;
  if (!isSetonlyAccessor && readonly === isReadonlySymbol(c, prop)) return prop;
  const result = c.newSymbolWithCheckFlags(
    SymbolFlags.Property | (prop.flags & SymbolFlags.Optional),
    prop.name,
    (prop.checkFlags & CheckFlags.Late) | (readonly ? CheckFlags.Readonly : 0),
  );
  const id = getSymbolId(result);
  c.symbolTypes.set(id, isSetonlyAccessor ? c.undefinedType : getTypeOfSymbol(c, prop));
  copyDeclarations(result, prop);
  c.symbolNameTypes.set(id, c.symbolNameTypes.get(getSymbolId(prop)));
  c.symbolSyntheticOrigins.set(id, prop);
  return result;
}

/** Whether a type may be spread into an object or destructured by an object rest element. */
export function isValidSpreadType(c: Checker, t: Type): boolean {
  const s = removeDefinitelyFalsyTypes(c, mapToBaseConstraintOrType(c, t));
  if (
    (s.flags & (TypeFlags.Any | TypeFlags.NonPrimitive | TypeFlags.Object | TypeFlags.InstantiableNonPrimitive)) !==
    0
  )
    return true;
  if ((s.flags & TypeFlags.UnionOrIntersection) === 0) return false;
  for (const u of typesOf(s)) if (!isValidSpreadType(c, u)) return false;
  return true;
}
