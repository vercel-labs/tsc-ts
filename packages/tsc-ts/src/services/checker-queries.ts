// Checker queries the language services need beyond what the checker itself uses.
import {
  BinaryExpression,
  getInitializer,
  getLocals,
  getName,
  getProperties,
  getSymbol,
  getText,
  type Node,
} from '../compiler/ast.js';
import { type Checker } from '../compiler/checker.js';
import { checkDestructuringAssignment } from '../compiler/checker-destructuring.js';
import { getPropertyOfType, getTypeOfPropertyOfType } from '../compiler/checker-members.js';
import { getTypeAtLocation } from '../compiler/checker-services.js';
import { checkRightHandSideOfForOf } from '../compiler/checker-statements.js';
import { getMembersOfSymbol, getSymbolOfMeaning } from '../compiler/checker-symbols.js';
import { getStringLiteralType, isLiteralType } from '../compiler/checker-type-factory.js';
import { getLiteralTypeFromPropertyName } from '../compiler/checker-type-operators.js';
import { CheckMode, type Type, TypeFlags, UnionOrIntersectionType } from '../compiler/checker-types.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName } from '../compiler/checker-utilities.js';
import { getTypeOfExpression } from '../compiler/checker-expressions.js';
import { isTypeAssignableTo } from '../compiler/relations.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { getAllSuperTypeNodes, getTextOfPropertyName } from './utilities.js';
import { CheckFlags, getDeclarations, getSymbolId, type Symbol, SymbolFlags } from '../compiler/symbol.js';

export function isExternalModuleSymbol(symbol: Symbol): boolean {
  return symbol.isExternalModule();
}

/** The declared symbols a union, mapped, spread or instantiated symbol comes from. */
export function getRootSymbols(c: Checker, symbol: Symbol): Symbol[] {
  const roots = getImmediateRootSymbols(c, symbol);
  if (roots.length === 0) return [symbol];
  const result: Symbol[] = [];
  for (const root of roots) for (const s of getRootSymbols(c, root)) result.push(s);
  return result;
}

function getImmediateRootSymbols(c: Checker, symbol: Symbol): Symbol[] {
  if ((symbol.checkFlags & CheckFlags.Synthetic) !== 0) {
    const result: Symbol[] = [];
    const containingType = c.symbolContainingTypes.get(getSymbolId(symbol));
    if (!(containingType instanceof UnionOrIntersectionType)) return result;
    for (const t of containingType.types) {
      const prop = getPropertyOfType(c, t, symbol.name);
      if (prop !== undefined) result.push(prop);
    }
    return result;
  }
  if ((symbol.flags & SymbolFlags.Transient) !== 0) {
    const id = getSymbolId(symbol);
    const left = c.symbolLeftSpreads.get(id);
    const right = c.symbolRightSpreads.get(id);
    if (left !== undefined && right !== undefined) return [left, right];
    const origin = c.symbolSyntheticOrigins.get(id);
    if (origin !== undefined) return [origin];
    let target: Symbol | undefined;
    for (let next = c.symbolTargets.get(id); next !== undefined; next = c.symbolTargets.get(getSymbolId(next)))
      target = next;
    if (target !== undefined) return [target];
  }
  return [];
}

/** The properties of `contextualType` an object literal element at `node` may refer to. */
export function getPropertySymbolsFromContextualType(
  c: Checker,
  node: Node,
  contextualType: Type,
  unionSymbolOk: boolean,
): Symbol[] {
  const nameNode = getName(node);
  const name = nameNode === undefined ? undefined : getTextOfPropertyName(nameNode);
  if (name === undefined || name === '') return [];
  if ((contextualType.flags & TypeFlags.Union) === 0) {
    const symbol = getPropertyOfType(c, contextualType, name);
    return symbol === undefined ? [] : [symbol];
  }
  const types = (contextualType as UnionOrIntersectionType).types;
  let filteredTypes = types;
  const parent = node.parent!;
  if (parent.kind === SyntaxKind.ObjectLiteralExpression || parent.kind === SyntaxKind.JsxAttributes)
    filteredTypes = types.filter((t) => !isTypeInvalidDueToUnionDiscriminant(c, t, parent));
  const discriminated: Symbol[] = [];
  for (const t of filteredTypes) {
    const prop = getPropertyOfType(c, t, name);
    if (prop !== undefined) discriminated.push(prop);
  }
  if (unionSymbolOk && (discriminated.length === 0 || discriminated.length === types.length)) {
    const symbol = getPropertyOfType(c, contextualType, name);
    if (symbol !== undefined) return [symbol];
  }
  if (filteredTypes.length === 0 && discriminated.length === 0) {
    const result: Symbol[] = [];
    for (const t of types) {
      const prop = getPropertyOfType(c, t, name);
      if (prop !== undefined) result.push(prop);
    }
    return result;
  }
  const unique: Symbol[] = [];
  for (const s of discriminated) if (!unique.includes(s)) unique.push(s);
  return unique;
}

function isTypeInvalidDueToUnionDiscriminant(c: Checker, contextualType: Type, obj: Node): boolean {
  const properties = getProperties(obj)?.nodes ?? [];
  return properties.some((property) => {
    const propertyName = getName(property);
    let nameType: Type | undefined;
    if (propertyName !== undefined)
      nameType =
        propertyName.kind === SyntaxKind.JsxNamespacedName
          ? getStringLiteralType(c, getTextOfPropertyName(propertyName) ?? '')
          : getLiteralTypeFromPropertyName(c, propertyName);
    const name =
      nameType !== undefined && isTypeUsableAsPropertyName(nameType) ? getPropertyNameFromType(nameType) : '';
    const expected = name !== '' ? getTypeOfPropertyOfType(c, contextualType, name) : undefined;
    return (
      expected !== undefined &&
      isLiteralType(expected) &&
      !isTypeAssignableTo(c, getTypeAtLocation(c, property), expected)
    );
  });
}

/** The property of the assigned value that a name in a destructuring assignment refers to. */
export function getPropertySymbolOfDestructuringAssignment(c: Checker, location: Node): Symbol | undefined {
  const pattern = location.parent!.parent!;
  if (!isArrayLiteralOrObjectLiteralDestructuringPattern(pattern)) return undefined;
  const type = getTypeOfAssignmentPattern(c, pattern);
  return type === undefined ? undefined : getPropertyOfType(c, type, getText(location));
}

function getTypeOfAssignmentPattern(c: Checker, expr: Node): Type | undefined {
  const parent = expr.parent!;
  if (parent.kind === SyntaxKind.ForOfStatement)
    return checkDestructuringAssignment(c, expr, checkRightHandSideOfForOf(c, parent), CheckMode.Normal, false);
  if (parent instanceof BinaryExpression)
    return checkDestructuringAssignment(c, expr, getTypeOfExpression(c, parent.right), CheckMode.Normal, false);
  // Nested patterns are not resolved.
  return undefined;
}

function isArrayLiteralOrObjectLiteralDestructuringPattern(node: Node): boolean {
  if (node.kind !== SyntaxKind.ArrayLiteralExpression && node.kind !== SyntaxKind.ObjectLiteralExpression) return false;
  const parent = node.parent!;
  // [a, b] = ... or { a } = ...
  if (
    parent instanceof BinaryExpression &&
    parent.left === node &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken
  )
    return true;
  if (parent.kind === SyntaxKind.ForOfStatement && getInitializerOfForOf(parent) === node) return true;
  return isArrayLiteralOrObjectLiteralDestructuringPattern(
    parent.kind === SyntaxKind.PropertyAssignment ? parent.parent! : parent,
  );
}

function getInitializerOfForOf(node: Node): Node | undefined {
  return getInitializer(node);
}

/** The parameter and the property a parameter property declares. */
export function getSymbolsOfParameterPropertyDeclaration(
  c: Checker,
  parameter: Node,
  parameterName: string,
): [Symbol, Symbol] {
  const constructorDeclaration = parameter.parent!;
  const classDeclaration = constructorDeclaration.parent!;
  const parameterSymbol = getSymbolOfMeaning(
    c,
    getLocals(constructorDeclaration) ?? new Map(),
    parameterName,
    SymbolFlags.Value,
  );
  const propertySymbol = getSymbolOfMeaning(
    c,
    getMembersOfSymbol(c, getSymbol(classDeclaration)!),
    parameterName,
    SymbolFlags.Value,
  );
  if (parameterSymbol === undefined || propertySymbol === undefined)
    throw new Error('There should exist two symbols, one as property declaration and one as parameter declaration');
  return [parameterSymbol, propertySymbol];
}

/** Calls `cb` with the property named `propertyName` of each base type of a class or interface. */
export function getPropertySymbolsFromBaseTypes(
  c: Checker,
  symbol: Symbol,
  propertyName: string,
  cb: (base: Symbol) => Symbol | undefined,
): Symbol | undefined {
  const seen = new Set<Symbol>();
  const recur = (symbol: Symbol): Symbol | undefined => {
    if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) === 0 || seen.has(symbol)) return undefined;
    seen.add(symbol);
    for (const declaration of getDeclarations(symbol)) {
      for (const typeReference of getAllSuperTypeNodes(declaration)) {
        const propertyType = getTypeAtLocation(c, typeReference);
        if (propertyType.symbol === undefined) continue;
        const propertySymbol = getPropertyOfType(c, propertyType, propertyName);
        if (propertySymbol !== undefined)
          for (const rootSymbol of getRootSymbols(c, propertySymbol)) {
            const result = cb(rootSymbol);
            if (result !== undefined) return result;
          }
        const result = recur(propertyType.symbol);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  };
  return recur(symbol);
}
