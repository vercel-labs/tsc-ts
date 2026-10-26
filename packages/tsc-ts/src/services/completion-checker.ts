// Checker queries for completions, like the language service entry points of tsgo's checker.
import {
  type ArrayLiteralExpression,
  getExpression,
  getName,
  getTagName,
  JsxNamespacedName,
  TaggedTemplateExpression,
  getProperties,
  getTypeArguments,
  type Node,
  type QualifiedName,
} from '../compiler/ast.js';
import { getAccessibleSymbolChain } from '../compiler/symbol-accessibility.js';
import { isLiteralType } from '../compiler/checker-type-factory.js';
import { getTypeAtLocation } from '../compiler/checker-services.js';
import type { Checker } from '../compiler/checker.js';
import { getResolvedSignature } from '../compiler/checker-calls.js';
import {
  ContextFlags,
  getContextualTypeEx,
  getContextualTypeForElementExpression,
} from '../compiler/checker-contextual.js';
import {
  fillMissingTypeArguments,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfSymbol,
  getMinTypeArgumentCount,
} from '../compiler/checker-declared-types.js';
import { checkExpression, getTypeOfExpression } from '../compiler/checker-expressions.js';
import { hasTypeFacts, TypeFacts } from '../compiler/checker-flow.js';
import { isJsxIntrinsicTagName } from '../compiler/checker-jsx.js';
import {
  createUnionOrIntersectionProperty,
  getApparentType,
  getIndexTypeOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getSignaturesOfType,
  getTypeOfPropertyOfType,
} from '../compiler/checker-members.js';
import { resolveExternalModuleSymbol } from '../compiler/checker-modules.js';
import { isPropertyAccessible } from '../compiler/checker-property-access.js';
import { removeOptionalTypeMarker, getTypeOfSymbol, getWidenedType } from '../compiler/checker-symbol-types.js';
import {
  getExportsOfModule,
  getMergedSymbol,
  getNamedMembers,
  isReservedMemberName,
  resolveAlias,
} from '../compiler/checker-symbols.js';
import {
  getIntersectionType,
  getStringLiteralType,
  getUnionType,
  isArrayType,
  isErrorType,
  isTupleType,
  typesOf,
} from '../compiler/checker-type-factory.js';
import { getLiteralTypeFromPropertyName } from '../compiler/checker-type-operators.js';
import { getTypeFromTypeNode, getTypeArgumentsFromNode } from '../compiler/checker-type-nodes.js';
import {
  CheckMode,
  InterfaceType,
  ObjectFlags,
  type Signature,
  SignatureKind,
  type Type,
  TypeFlags,
  type TypeReference,
  type UnionOrIntersectionType,
} from '../compiler/checker-types.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName } from '../compiler/checker-utilities.js';
import { isTypeAssignableTo } from '../compiler/relations.js';
import { instantiateType } from '../compiler/instantiation.js';
import { newTypeMapper } from '../compiler/checker-types.js';
import { type Symbol, SymbolFlags, CheckFlags, type SymbolTable } from '../compiler/symbol.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { isInJSFile } from '../compiler/ast-utilities.js';

export { getAccessibleSymbolChain };

/** The properties of a type and, for callable or constructable types, of `Function`. */
export function getApparentProperties(c: Checker, t: Type): Symbol[] {
  const apparent = getApparentType(c, t);
  const props = new Map<string, Symbol>();
  for (const p of getPropertiesOfType(c, apparent)) props.set(p.name, p);
  let functionType: Type | undefined;
  if (getSignaturesOfType(c, apparent, SignatureKind.Call).length > 0) functionType = c.globalCallableFunctionType;
  else if (getSignaturesOfType(c, apparent, SignatureKind.Construct).length > 0)
    functionType = c.globalNewableFunctionType;
  if (functionType !== undefined)
    for (const p of getPropertiesOfType(c, functionType)) if (!props.has(p.name)) props.set(p.name, p);
  return getNamedMembers(c, props, undefined);
}

/** Every property of any of `types`, as union properties. */
export function getAllPossiblePropertiesOfTypes(c: Checker, types: Type[]): Symbol[] {
  const unionType = getUnionType(c, types);
  if ((unionType.flags & TypeFlags.Union) === 0) return getApparentProperties(c, unionType);
  const props = new Map<string, Symbol>();
  for (const memberType of types) {
    for (const p of getApparentProperties(c, memberType)) {
      if (props.has(p.name)) continue;
      const prop = createUnionOrIntersectionProperty(c, unionType as UnionOrIntersectionType, p.name, false);
      // Undefined for private properties.
      if (prop !== undefined) props.set(p.name, prop);
    }
  }
  return [...props.values()];
}

/** Whether `property` of `t` may be accessed at the property access-like `node`. */
export function isValidPropertyAccessForCompletions(c: Checker, node: Node, t: Type, property: Symbol): boolean {
  return isPropertyAccessible(
    c,
    node,
    node.kind === SyntaxKind.PropertyAccessExpression && getExpression(node)!.kind === SyntaxKind.SuperKeyword,
    false,
    t,
    property,
  );
}

/** Whether the property `name` may be accessed at a property access, qualified name or import type. */
export function isValidPropertyAccess(c: Checker, node: Node, name: string): boolean {
  switch (node.kind) {
    case SyntaxKind.PropertyAccessExpression: {
      const expression = getExpression(node)!;
      return isValidPropertyAccessWithType(
        c,
        node,
        expression.kind === SyntaxKind.SuperKeyword,
        name,
        getWidenedType(c, checkExpression(c, expression)),
      );
    }
    case SyntaxKind.QualifiedName:
      return isValidPropertyAccessWithType(
        c,
        node,
        false,
        name,
        getWidenedType(c, checkExpression(c, (node as QualifiedName).left)),
      );
    case SyntaxKind.ImportType:
      return isValidPropertyAccessWithType(c, node, false, name, getTypeFromTypeNode(c, node));
  }
  throw new Error('Unexpected node kind in isValidPropertyAccess: ' + node.kind);
}

function isValidPropertyAccessWithType(c: Checker, node: Node, isSuper: boolean, name: string, t: Type): boolean {
  if ((t.flags & TypeFlags.Any) !== 0) return true;
  const prop = getPropertyOfType(c, t, name);
  return prop !== undefined && isPropertyAccessible(c, node, isSuper, false, t, prop);
}

export function getStringIndexType(c: Checker, t: Type): Type | undefined {
  return getIndexTypeOfType(c, t, c.stringType);
}

export function getNumberIndexType(c: Checker, t: Type): Type | undefined {
  return getIndexTypeOfType(c, t, c.numberType);
}

export function getNonOptionalType(c: Checker, t: Type): Type {
  return removeOptionalTypeMarker(c, t);
}

export function isNullableType(c: Checker, t: Type): boolean {
  return hasTypeFacts(c, t, TypeFacts.IsUndefinedOrNull);
}

export function getCallSignatures(c: Checker, t: Type): Signature[] {
  return getSignaturesOfType(c, t, SignatureKind.Call);
}

/** The target of an alias, or the symbol itself. */
export function skipAlias(c: Checker, symbol: Symbol): Symbol {
  return (symbol.flags & SymbolFlags.Alias) !== 0 ? resolveAlias(c, symbol) : symbol;
}

export function getExportSymbolOfSymbol(c: Checker, symbol: Symbol): Symbol {
  return getMergedSymbol(c, symbol.exportSymbol ?? symbol);
}

export function isExternalModuleSymbol(symbol: Symbol): boolean {
  return symbol.isExternalModule();
}

/** The exports of a module, sorted like a symbol table's members. */
export function getExportsOfModuleAsArray(c: Checker, moduleSymbol: Symbol): Symbol[] {
  return symbolsToArray(getExportsOfModule(c, moduleSymbol));
}

function symbolsToArray(table: SymbolTable): Symbol[] {
  const result: Symbol[] = [];
  for (const [name, symbol] of table) if (!isReservedMemberName(name)) result.push(symbol);
  return result;
}

function shouldTreatPropertiesOfExternalModuleAsExports(c: Checker, t: Type): boolean {
  return (
    (t.flags & TypeFlags.Primitive) === 0 ||
    (t.objectFlags & ObjectFlags.Class) !== 0 ||
    isArrayType(c, t) ||
    isTupleType(t)
  );
}

/** The exports of a module and, for `export =`, the properties of the exported value. */
export function getExportsAndPropertiesOfModule(c: Checker, moduleSymbol: Symbol): Symbol[] {
  const exports = getExportsOfModuleAsArray(c, moduleSymbol);
  const exportEquals = resolveExternalModuleSymbol(c, moduleSymbol, false);
  if (exportEquals !== undefined && exportEquals !== moduleSymbol) {
    const t = getTypeOfSymbol(c, exportEquals);
    if (shouldTreatPropertiesOfExternalModuleAsExports(c, t)) exports.push(...getPropertiesOfType(c, t));
  }
  return exports;
}

export function tryGetMemberInModuleExportsAndProperties(
  c: Checker,
  memberName: string,
  moduleSymbol: Symbol,
): Symbol | undefined {
  const symbol = getExportsOfModule(c, moduleSymbol).get(memberName);
  if (symbol !== undefined) return symbol;
  const exportEquals = resolveExternalModuleSymbol(c, moduleSymbol, false);
  if (exportEquals === undefined || exportEquals === moduleSymbol) return undefined;
  const t = getTypeOfSymbol(c, exportEquals);
  return shouldTreatPropertiesOfExternalModuleAsExports(c, t) ? getPropertyOfType(c, t, memberName) : undefined;
}

/** The contextual type of an expression; IgnoreNodeInferences (`Completions`) is treated like None. */
export function getContextualTypeWithFlags(c: Checker, node: Node, contextFlags: ContextFlags): Type | undefined {
  return getContextualTypeEx(c, node, contextFlags & ~ContextFlags.Completions);
}

/** The contextual type of the element at `position` of an incomplete array literal. */
export function getContextualTypeForArrayLiteralAtPosition(
  c: Checker,
  contextualArrayType: Type | undefined,
  arrayLiteral: ArrayLiteralExpression,
  position: number,
): Type | undefined {
  if (contextualArrayType === undefined) return undefined;
  let firstSpreadIndex = -1;
  let lastSpreadIndex = -1;
  let elementIndex = 0;
  const elements = arrayLiteral.elements.nodes;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element.pos < position) elementIndex++;
    if (element.kind === SyntaxKind.SpreadElement) {
      if (firstSpreadIndex === -1) firstSpreadIndex = i;
      lastSpreadIndex = i;
    }
  }
  return getContextualTypeForElementExpression(
    c,
    contextualArrayType,
    elementIndex,
    -1,
    firstSpreadIndex,
    lastSpreadIndex,
  );
}

/** Whether an object literal property contradicts a literal discriminant of `contextualType`. */
export function isTypeInvalidDueToUnionDiscriminant(c: Checker, contextualType: Type, obj: Node): boolean {
  const properties = getProperties(obj);
  if (properties === undefined) return false;
  for (const property of properties.nodes) {
    const propertyName = getName(property);
    let nameType: Type | undefined;
    if (propertyName !== undefined) {
      nameType =
        propertyName.kind === SyntaxKind.JsxNamespacedName
          ? getStringLiteralType(c, getJsxNamespacedNameText(propertyName))
          : getLiteralTypeFromPropertyName(c, propertyName);
    }
    const name =
      nameType !== undefined && isTypeUsableAsPropertyName(nameType) ? getPropertyNameFromType(nameType) : '';
    const expected = name !== '' ? getTypeOfPropertyOfType(c, contextualType, name) : undefined;
    if (
      expected !== undefined &&
      isLiteralType(expected) &&
      !isTypeAssignableTo(c, getTypeAtLocation(c, property), expected)
    )
      return true;
  }
  return false;
}

function getJsxNamespacedNameText(node: Node): string {
  return node instanceof JsxNamespacedName ? node.namespace.text + ':' + node.name.text : '';
}

/** The constraint of the type parameter a type argument node is passed for. */
export function getTypeArgumentConstraint(c: Checker, node: Node): Type | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  const typeArguments = getTypeArguments(parent);
  const typeArgumentPosition = typeArguments !== undefined ? typeArguments.nodes.indexOf(node) : -1;
  if (typeArgumentPosition < 0) return undefined;
  if (isCallLikeExpression(parent))
    return getTypeParameterConstraintAcrossSignatures(c, getUninstantiatedSignatures(c, parent), typeArgumentPosition);
  const grandparent = parent.parent;
  if (grandparent !== undefined && grandparent.kind === SyntaxKind.Decorator)
    return getTypeParameterConstraintAcrossSignatures(
      c,
      getUninstantiatedSignatures(c, grandparent),
      typeArgumentPosition,
    );
  if (
    parent.kind === SyntaxKind.ExpressionWithTypeArguments &&
    grandparent !== undefined &&
    grandparent.kind === SyntaxKind.ExpressionStatement
  ) {
    const uninstantiatedType = checkExpression(c, getExpression(parent)!);
    const callConstraint = getTypeParameterConstraintAcrossSignatures(
      c,
      getSignaturesOfType(c, uninstantiatedType, SignatureKind.Call),
      typeArgumentPosition,
    );
    const constructConstraint = getTypeParameterConstraintAcrossSignatures(
      c,
      getSignaturesOfType(c, uninstantiatedType, SignatureKind.Construct),
      typeArgumentPosition,
    );
    // An instantiation expression instantiates both call and construct signatures.
    if ((constructConstraint.flags & TypeFlags.Never) !== 0) return callConstraint;
    if ((callConstraint.flags & TypeFlags.Never) !== 0) return constructConstraint;
    return getIntersectionType(c, [callConstraint, constructConstraint]);
  }
  if (parent.kind === SyntaxKind.TypeReference || parent.kind === SyntaxKind.ExpressionWithTypeArguments) {
    const typeParameters = getTypeParametersForTypeReferenceOrImport(c, parent);
    if (typeParameters === undefined || typeArgumentPosition >= typeParameters.length) return undefined;
    const constraint = getConstraintOfTypeParameter(c, typeParameters[typeArgumentPosition]);
    if (constraint === undefined) return undefined;
    const typeArgumentTypes = fillMissingTypeArguments(
      c,
      getTypeArgumentsFromNode(c, parent),
      typeParameters,
      getMinTypeArgumentCount(c, typeParameters),
      isInJSFile(parent),
    );
    return instantiateType(c, constraint, newTypeMapper(typeParameters.slice(), typeArgumentTypes));
  }
  return undefined;
}

function isCallLikeExpression(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.Decorator:
      return true;
  }
  return false;
}

function getUninstantiatedSignatures(c: Checker, node: Node): Signature[] {
  switch (node.kind) {
    case SyntaxKind.CallExpression:
    case SyntaxKind.Decorator:
      return getSignaturesOfType(c, getTypeOfExpression(c, getExpression(node)!), SignatureKind.Call);
    case SyntaxKind.NewExpression:
      return getSignaturesOfType(c, getTypeOfExpression(c, getExpression(node)!), SignatureKind.Construct);
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxOpeningElement: {
      const tagName = getJsxTagName(node);
      if (isJsxIntrinsicTagName(tagName)) return [];
      return getSignaturesOfType(c, getTypeOfExpression(c, tagName), SignatureKind.Call);
    }
    case SyntaxKind.TaggedTemplateExpression:
      return getSignaturesOfType(c, getTypeOfExpression(c, getTaggedTemplateTag(node)), SignatureKind.Call);
  }
  return [];
}

function getTypeParameterConstraintAcrossSignatures(c: Checker, signatures: Signature[], position: number): Type {
  const constraints: Type[] = [];
  for (const signature of signatures) {
    if (position >= signature.typeParameters.length) continue;
    const constraint = getConstraintOfTypeParameter(c, signature.typeParameters[position]);
    if (constraint !== undefined) constraints.push(constraint);
  }
  return getUnionType(c, constraints);
}

function getTypeParametersForTypeReferenceOrImport(c: Checker, node: Node): readonly Type[] | undefined {
  const t = getTypeFromTypeNode(c, node);
  if (isErrorType(c, t)) return undefined;
  const symbol = c.resolvedSymbols.get(node.id);
  if (symbol === undefined || symbol === c.unknownSymbol) return undefined;
  if ((symbol.flags & SymbolFlags.TypeAlias) !== 0) {
    getDeclaredTypeOfSymbol(c, symbol);
    const typeParameters = c.symbolLinks(symbol).typeParameters;
    if (typeParameters !== undefined && typeParameters.length !== 0) return typeParameters;
  }
  if ((t.objectFlags & ObjectFlags.Reference) !== 0) {
    const target = (t as TypeReference).target;
    if (target instanceof InterfaceType) return target.localTypeParameters();
  }
  return undefined;
}

/** The symbols a transient symbol was made from, recursively; the symbol itself if none. */
export function getRootSymbols(c: Checker, symbol: Symbol): Symbol[] {
  const roots = getImmediateRootSymbols(c, symbol);
  if (roots.length === 0) return [symbol];
  const result: Symbol[] = [];
  for (const root of roots) result.push(...getRootSymbols(c, root));
  return result;
}

function getImmediateRootSymbols(c: Checker, symbol: Symbol): Symbol[] {
  const id = symbol.id;
  if ((symbol.checkFlags & CheckFlags.Synthetic) !== 0) {
    const containingType = c.symbolContainingTypes.get(id);
    const result: Symbol[] = [];
    if (containingType !== undefined)
      for (const t of typesOf(containingType)) {
        const prop = getPropertyOfType(c, t, symbol.name);
        if (prop !== undefined) result.push(prop);
      }
    return result;
  }
  if ((symbol.flags & SymbolFlags.Transient) !== 0) {
    const left = c.symbolLeftSpreads.get(id);
    const right = c.symbolRightSpreads.get(id);
    if (left !== undefined && right !== undefined) return [left, right];
    const origin = c.symbolSyntheticOrigins.get(id);
    if (origin !== undefined) return [origin];
    let target: Symbol | undefined;
    for (let next = c.symbolTargets.get(id); next !== undefined;) {
      target = next;
      next = c.symbolTargets.get(next.id);
    }
    if (target !== undefined) return [target];
  }
  return [];
}

/** The resolved signature of a call-like expression. */
export function getResolvedSignatureOf(c: Checker, node: Node): Signature {
  return getResolvedSignature(c, node, CheckMode.Normal);
}

function getJsxTagName(node: Node): Node {
  return getTagName(node)!;
}

function getTaggedTemplateTag(node: Node): Node {
  if (node instanceof TaggedTemplateExpression) return node.tag;
  throw new Error('Expected a tagged template expression');
}
