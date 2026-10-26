// Types from type nodes: `getTypeFromTypeNode` and the resolution of type references.
import {
  type ArrayTypeNode,
  ModifierFlags,
  type ExpressionWithTypeArguments,
  type IndexedAccessTypeNode,
  type InferTypeNode,
  type IntersectionTypeNode,
  type LiteralTypeNode,
  type NamedTupleMember,
  type Node,
  NodeFlags,
  type OptionalTypeNode,
  type QualifiedName,
  type RestTypeNode,
  type TemplateLiteralTypeNode,
  type TemplateLiteralTypeSpan,
  type TupleTypeNode,
  type TypeOperatorNode,
  type TypeReferenceNode,
  type UnionTypeNode,
  getExpression,
  getName,
  getText,
  getType,
  getSymbol,
  type ConditionalTypeNode,
  type MappedTypeNode,
  TypePredicateNode,
  getBody,
  getTypeArguments,
} from './ast.js';
import {
  declarationNameToString,
  getSourceFileOfNode,
  getThisContainer,
  isClassLike,
  isStatic,
  isDeclarationStatementKind,
} from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  ElementFlags,
  type InterfaceType,
  type MappedType,
  ObjectFlags,
  TupleElementInfo,
  type TupleType,
  type Type,
  TypeAlias,
  TypeFlags,
  UniqueESSymbolType,
  emptyTypes,
  newTypeMapper,
  TypeParameter,
} from './checker-types.js';
import {
  createArrayType,
  IntersectionFlags,
  UnionReduction,
  aliasKey,
  createDeferredTypeReference,
  createNormalizedTupleType,
  createTypeReferenceEx,
  getIntersectionTypeEx,
  getRegularTypeOfLiteralType,
  getTemplateLiteralType,
  getTupleTargetType,
  getUnionTypeEx,
  getIntersectionType,
  everyType,
  isArrayOrTupleType,
  isPatternLiteralType,
  newObjectType,
  typeListKey,
} from './checker-type-factory.js';
import {
  getMembersOfSymbol,
  getMergedSymbol,
  getSymbolOfDeclaration,
  resolveAlias,
  resolveEntityName,
} from './checker-symbols.js';
import { getTypeFromImportTypeNode } from './checker-modules.js';
import {
  fillMissingTypeArguments,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getDeclaredTypeOfTypeParameter,
  getConstraintOfTypeParameter,
  getLocalTypeParametersOfClassOrInterfaceOrTypeAlias,
  getMinTypeArgumentCount,
  tryGetDeclaredTypeOfSymbol,
} from './checker-declared-types.js';
import { addOptionality, getNullableType, getWidenedType } from './checker-symbol-types.js';
import { instantiateTypeWithAlias } from './instantiation.js';
import { symbolToString, typeToString } from './type-printer.js';
import {
  getIndexType,
  getIndexedAccessTypeEx,
  getNoInferType,
  getStringMappingType,
  getTypeFromConditionalTypeNode,
  getTypeFromMappedTypeNode,
  intrinsicTypeKind,
  IntrinsicTypeKind,
  getSubstitutionType,
  getActualTypeVariable,
  getHomomorphicTypeVariable,
  getTypeParameterFromMappedType,
} from './checker-type-operators.js';
import { checkExpression, checkExpressionCached, getResolvedSymbol } from './checker-expressions.js';
import { checkExpressionWithTypeArguments } from './checker-calls.js';
import { getIntendedTypeFromJSDocTypeReference } from './checker-jsdoc.js';
import { getCombinedNodeFlags, hasSyntacticModifier } from './binder-utilities.js';
import { CheckFlags, getDeclarations, getSymbolId, type Symbol, SymbolFlags } from './symbol.js';
import { isStatement } from './printer/utilities.js';

export function getTypeFromTypeNode(c: Checker, node: Node): Type {
  return getConditionalFlowTypeOfType(c, getTypeFromTypeNodeWorker(c, node), node);
}

/**
 * `t` with the constraints implied by enclosing conditional types, as a substitution type: in
 * `T extends string ? X : Y`, references to T in X are known to be strings.
 */
function getConditionalFlowTypeOfType(c: Checker, t: Type, start: Node): Type {
  let constraints: Type[] | undefined;
  let covariant = true;
  for (let node: Node | undefined = start; node !== undefined && !isStatementLike(node); node = node.parent) {
    const parent: Node | undefined = node.parent;
    if (parent === undefined) break;
    // Only parameter positions flip variance; `keyof` is mostly used invariantly in indexed accesses.
    if (parent.kind === SyntaxKind.Parameter) covariant = !covariant;
    // Type variables always substitute, as even contravariant positions may rely on their constraints.
    if (
      (covariant || (t.flags & TypeFlags.TypeVariable) !== 0) &&
      parent.kind === SyntaxKind.ConditionalType &&
      node === (parent as ConditionalTypeNode).trueType
    ) {
      const conditional = parent as ConditionalTypeNode;
      const constraint = getImpliedConstraint(c, t, conditional.checkType, conditional.extendsType);
      if (constraint !== undefined) (constraints ??= []).push(constraint);
    } else if (
      (t.flags & TypeFlags.TypeParameter) !== 0 &&
      parent.kind === SyntaxKind.MappedType &&
      (parent as MappedTypeNode).nameType === undefined &&
      node === (parent as MappedTypeNode).type
    ) {
      // Homomorphic mapped types over arrays and tuples map numeric keys only.
      const mappedType = getTypeFromTypeNode(c, parent) as MappedType;
      if (getTypeParameterFromMappedType(c, mappedType) === getActualTypeVariable(c, t)) {
        const typeParameter = getHomomorphicTypeVariable(c, mappedType);
        if (typeParameter !== undefined) {
          const constraint = getConstraintOfTypeParameter(c, typeParameter);
          if (constraint !== undefined && everyType(constraint, (u) => isArrayOrTupleType(c, u)))
            (constraints ??= []).push(
              getUnionTypeEx(c, [c.numberType, c.numericStringType], UnionReduction.Literal, undefined, undefined),
            );
        }
      }
    }
  }
  return constraints !== undefined ? getSubstitutionType(c, t, getIntersectionType(c, constraints)) : t;
}

function getImpliedConstraint(c: Checker, t: Type, checkNode: Node, extendsNode: Node): Type | undefined {
  if (isUnaryTupleTypeNode(checkNode) && isUnaryTupleTypeNode(extendsNode))
    return getImpliedConstraint(
      c,
      t,
      (checkNode as TupleTypeNode).elements.nodes[0]!,
      (extendsNode as TupleTypeNode).elements.nodes[0]!,
    );
  if (getActualTypeVariable(c, getTypeFromTypeNode(c, checkNode)) === getActualTypeVariable(c, t))
    return getTypeFromTypeNode(c, extendsNode);
  return undefined;
}

function isUnaryTupleTypeNode(node: Node): boolean {
  return node.kind === SyntaxKind.TupleType && (node as TupleTypeNode).elements.nodes.length === 1;
}

/** A statement, declaration statement or block, which ends the search for enclosing conditional types. */
function isStatementLike(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Block:
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ContinueStatement:
    case SyntaxKind.DebuggerStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.EmptyStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.IfStatement:
    case SyntaxKind.LabeledStatement:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.ThrowStatement:
    case SyntaxKind.TryStatement:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.NotEmittedStatement:
    case SyntaxKind.JSDoc:
      return true;
  }
  return isDeclarationStatementKind(node.kind);
}

function getTypeFromTypeNodeWorker(c: Checker, node: Node): Type {
  switch (node.kind) {
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.JSDocAllType:
      return c.anyType;
    case SyntaxKind.JSDocNonNullableType:
      return getTypeFromTypeNode(c, getType(node)!);
    case SyntaxKind.JSDocNullableType: {
      const t = getTypeFromTypeNode(c, getType(node)!);
      return c.strictNullChecks ? getNullableType(c, t, TypeFlags.Null) : t;
    }
    case SyntaxKind.JSDocVariadicType:
      return createArrayType(c, getTypeFromTypeNode(c, getType(node)!));
    case SyntaxKind.JSDocOptionalType:
      return addOptionality(c, getTypeFromTypeNode(c, getType(node)!), false, true);
    case SyntaxKind.UnknownKeyword:
      return c.unknownType;
    case SyntaxKind.StringKeyword:
      return c.stringType;
    case SyntaxKind.NumberKeyword:
      return c.numberType;
    case SyntaxKind.BigIntKeyword:
      return c.bigintType;
    case SyntaxKind.BooleanKeyword:
      return c.booleanType;
    case SyntaxKind.SymbolKeyword:
      return c.esSymbolType;
    case SyntaxKind.VoidKeyword:
      return c.voidType;
    case SyntaxKind.UndefinedKeyword:
      return c.undefinedType;
    case SyntaxKind.NullKeyword:
      return c.nullType;
    case SyntaxKind.NeverKeyword:
      return c.neverType;
    case SyntaxKind.ObjectKeyword:
      return c.nonPrimitiveType;
    case SyntaxKind.IntrinsicKeyword:
      return c.intrinsicMarkerType;
    case SyntaxKind.ThisType:
    case SyntaxKind.ThisKeyword:
      return getTypeFromThisTypeNode(c, node);
    case SyntaxKind.LiteralType:
      return getTypeFromLiteralTypeNode(c, node as LiteralTypeNode);
    case SyntaxKind.TypeReference:
    case SyntaxKind.ExpressionWithTypeArguments:
      return getTypeFromTypeReference(c, node);
    case SyntaxKind.TypePredicate:
      return (node as TypePredicateNode).assertsModifier !== undefined ? c.voidType : c.booleanType;
    case SyntaxKind.TypeQuery:
      return getTypeFromTypeQueryNode(c, node);
    case SyntaxKind.ArrayType:
    case SyntaxKind.TupleType:
      return getTypeFromArrayOrTupleTypeNode(c, node);
    case SyntaxKind.OptionalType:
      return addOptionality(c, getTypeFromTypeNode(c, (node as OptionalTypeNode).type), true, true);
    case SyntaxKind.UnionType:
      return getTypeFromUnionTypeNode(c, node as UnionTypeNode);
    case SyntaxKind.IntersectionType:
      return getTypeFromIntersectionTypeNode(c, node as IntersectionTypeNode);
    case SyntaxKind.NamedTupleMember:
      return getTypeFromNamedTupleTypeNode(c, node as NamedTupleMember);
    case SyntaxKind.ParenthesizedType:
      return getTypeFromTypeNode(c, getType(node)!);
    case SyntaxKind.RestType:
      return getTypeFromRestTypeNode(c, node);
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
    case SyntaxKind.TypeLiteral:
      return getTypeFromTypeLiteralOrFunctionOrConstructorTypeNode(c, node);
    case SyntaxKind.TypeOperator:
      return getTypeFromTypeOperatorNode(c, node as TypeOperatorNode);
    case SyntaxKind.IndexedAccessType:
      return getTypeFromIndexedAccessTypeNode(c, node as IndexedAccessTypeNode);
    case SyntaxKind.TemplateLiteralType:
      return getTypeFromTemplateTypeNode(c, node as TemplateLiteralTypeNode);
    case SyntaxKind.MappedType:
      return getTypeFromMappedTypeNode(c, node);
    case SyntaxKind.ConditionalType:
      return getTypeFromConditionalTypeNode(c, node);
    case SyntaxKind.InferType: {
      let type = c.resolvedTypes.get(node.id);
      if (type === undefined) {
        type = getDeclaredTypeOfTypeParameter(c, getSymbolOfDeclaration(c, (node as InferTypeNode).typeParameter)!);
        c.resolvedTypes.set(node.id, type);
      }
      return type;
    }
    case SyntaxKind.ImportType:
      return getTypeFromImportTypeNode(c, node);
  }
  return c.errorType;
}

export function getTypeFromThisTypeNode(c: Checker, node: Node): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    type = getThisType(c, node);
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

function getThisType(c: Checker, node: Node): Type {
  const container = getThisContainer(node, false, false);
  const parent = container.parent;
  if (parent !== undefined && (isClassLike(parent) || parent.kind === SyntaxKind.InterfaceDeclaration)) {
    if (!isStatic(container) && (container.kind !== SyntaxKind.Constructor || isDescendant(node, getBody(container))))
      return getDeclaredTypeOfClassOrInterface(c, getSymbolOfDeclaration(c, parent)!).thisType ?? c.errorType;
  }
  c.error(node, Diagnostics.A_this_type_is_available_only_in_a_non_static_member_of_a_class_or_interface);
  return c.errorType;
}

function isDescendant(node: Node, ancestor: Node | undefined): boolean {
  if (ancestor === undefined) return false;
  for (let n: Node | undefined = node; n !== undefined; n = n.parent) if (n === ancestor) return true;
  return false;
}

function getTypeFromLiteralTypeNode(c: Checker, node: LiteralTypeNode): Type {
  if (node.literal.kind === SyntaxKind.NullKeyword) return c.nullType;
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    type = getRegularTypeOfLiteralType(c, checkExpression(c, node.literal));
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

function getTypeFromTypeLiteralOrFunctionOrConstructorTypeNode(c: Checker, node: Node): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    // Members resolve lazily.
    const alias = getAliasForTypeNode(c, node);
    const symbol = getSymbol(node);
    if (symbol === undefined || (getMembersOfSymbol(c, symbol).size === 0 && alias === undefined))
      type = c.emptyTypeLiteralType;
    else {
      const t = newObjectType(c, ObjectFlags.Anonymous, symbol);
      t.alias = alias;
      type = t;
    }
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

export function getTypeFromIndexedAccessTypeNode(c: Checker, node: IndexedAccessTypeNode): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    const objectType = getTypeFromTypeNode(c, node.objectType);
    const indexType = getTypeFromTypeNode(c, node.indexType);
    type = getIndexedAccessTypeEx(c, objectType, indexType, 0, node, getAliasForTypeNode(c, node));
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

function getTypeFromTypeOperatorNode(c: Checker, node: TypeOperatorNode): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    const argType = node.type;
    switch (node.operator) {
      case SyntaxKind.KeyOfKeyword:
        type = getIndexType(c, getTypeFromTypeNode(c, argType));
        break;
      case SyntaxKind.UniqueKeyword:
        type =
          argType.kind === SyntaxKind.SymbolKeyword
            ? getESSymbolLikeTypeForNode(c, walkUpParenthesizedTypes(node.parent!))
            : c.errorType;
        break;
      default:
        type = getTypeFromTypeNode(c, argType);
    }
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

function walkUpParenthesizedTypes(node: Node): Node {
  let n = node;
  while (n.kind === SyntaxKind.ParenthesizedType && n.parent !== undefined) n = n.parent;
  return n;
}

/** A const variable of a variable statement, a static readonly property, or a readonly property signature. */
function isValidESSymbolDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration: {
      const list = node.parent!;
      return (
        (getCombinedNodeFlags(node) & NodeFlags.Constant) === NodeFlags.Const &&
        getName(node)!.kind === SyntaxKind.Identifier &&
        list.kind === SyntaxKind.VariableDeclarationList &&
        list.parent!.kind === SyntaxKind.VariableStatement
      );
    }
    case SyntaxKind.PropertyDeclaration:
      return hasSyntacticModifier(node, ModifierFlags.Readonly) && isStatic(node);
    case SyntaxKind.PropertySignature:
      return hasSyntacticModifier(node, ModifierFlags.Readonly);
  }
  return false;
}

export function getESSymbolLikeTypeForNode(c: Checker, node: Node): Type {
  if (isValidESSymbolDeclaration(node)) {
    const symbol = getSymbolOfDeclaration(c, node);
    if (symbol !== undefined) {
      let uniqueType = c.uniqueESSymbolTypes.get(symbol);
      if (uniqueType === undefined) {
        uniqueType = new UniqueESSymbolType(c.nextTypeId(), symbol, '￾@' + symbol.name + '@' + getSymbolId(symbol));
        c.uniqueESSymbolTypes.set(symbol, uniqueType);
      }
      return uniqueType;
    }
  }
  return c.esSymbolType;
}

// ---- Type references

function isConstTypeReference(node: Node): boolean {
  if (node.kind !== SyntaxKind.TypeReference) return false;
  const ref = node as TypeReferenceNode;
  return (
    ref.typeName.kind === SyntaxKind.Identifier && getText(ref.typeName) === 'const' && ref.typeArguments === undefined
  );
}

export function isAssertionExpression(node: Node | undefined): boolean {
  return (
    node !== undefined && (node.kind === SyntaxKind.AsExpression || node.kind === SyntaxKind.TypeAssertionExpression)
  );
}

export function getTypeFromTypeReference(c: Checker, node: Node): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    if (isConstTypeReference(node) && isAssertionExpression(node.parent))
      type = checkExpressionCached(c, getExpression(node.parent!)!);
    else
      type =
        getIntendedTypeFromJSDocTypeReference(c, node) ??
        getDistributedTypeParameter(c, node, getTypeReferenceType(c, node, getSymbolFromTypeReference(c, node)));
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

/**
 * The distributed form of a type parameter `t` that `node` references inside a distributive conditional type on
 * it (one whose check type is a bare reference to the type parameter), up to the enclosing statement; otherwise `t`.
 */
function getDistributedTypeParameter(c: Checker, node: Node, t: Type): Type {
  if ((t.flags & TypeFlags.TypeParameter) === 0 || (t as TypeParameter).isDistributed) return t;
  for (let n = node.parent; n !== undefined && !isStatement(n); n = n.parent) {
    if (n.kind !== SyntaxKind.ConditionalType) continue;
    const checkTypeNode = (n as ConditionalTypeNode).checkType;
    if (isSimpleIdentifierTypeReference(checkTypeNode) && getSymbolFromTypeReference(c, checkTypeNode) === t.symbol)
      return getDistributedTypeFromTypeParameter(c, t as TypeParameter);
  }
  return t;
}

function getDistributedTypeFromTypeParameter(c: Checker, t: TypeParameter): TypeParameter {
  let distributed = t.distributedType;
  if (distributed === undefined) {
    distributed = c.newTypeParameter(t.symbol);
    distributed.isDistributed = true;
    distributed.constraint = t;
    t.distributedType = distributed;
  }
  return distributed;
}

/** A type reference that is a bare identifier without type arguments. */
function isSimpleIdentifierTypeReference(node: Node): boolean {
  return (
    node.kind === SyntaxKind.TypeReference &&
    (node as TypeReferenceNode).typeName.kind === SyntaxKind.Identifier &&
    (node as TypeReferenceNode).typeArguments === undefined
  );
}

export function getSymbolFromTypeReference(c: Checker, node: Node): Symbol {
  let symbol = c.resolvedSymbols.get(node.id);
  if (symbol === undefined) {
    if (isConstTypeReference(node) && isAssertionExpression(node.parent)) symbol = c.unknownSymbol;
    else symbol = resolveTypeReferenceName(c, node, SymbolFlags.Type, false);
    c.resolvedSymbols.set(node.id, symbol);
  }
  return symbol;
}

function getTypeReferenceName(node: Node): Node | undefined {
  if (node.kind === SyntaxKind.TypeReference) return (node as TypeReferenceNode).typeName;
  if (node.kind === SyntaxKind.ExpressionWithTypeArguments) {
    const e = (node as ExpressionWithTypeArguments).expression;
    if (isEntityNameExpression(e)) return e;
  }
  return undefined;
}

function isEntityNameExpression(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    const name = getName(node);
    return name !== undefined && name.kind === SyntaxKind.Identifier && isEntityNameExpression(getExpression(node)!);
  }
  return false;
}

export function resolveTypeReferenceName(
  c: Checker,
  typeReference: Node,
  meaning: SymbolFlags,
  ignoreErrors: boolean,
): Symbol {
  const name = getTypeReferenceName(typeReference);
  if (name === undefined) return c.unknownSymbol;
  const symbol = resolveEntityName(c, name, meaning, ignoreErrors, false, undefined);
  if (symbol !== undefined && symbol !== c.unknownSymbol) return symbol;
  if (ignoreErrors) return c.unknownSymbol;
  return getUnresolvedSymbolForEntityName(c, name);
}

export function getUnresolvedSymbolForEntityName(c: Checker, name: Node): Symbol {
  let identifier: Node;
  if (name.kind === SyntaxKind.QualifiedName) identifier = (name as QualifiedName).right;
  else if (name.kind === SyntaxKind.PropertyAccessExpression) identifier = getName(name)!;
  else identifier = name;
  const text = getText(identifier);
  if (text === '') return c.unknownSymbol;
  let parentSymbol: Symbol | undefined;
  if (name.kind === SyntaxKind.QualifiedName)
    parentSymbol = getUnresolvedSymbolForEntityName(c, (name as QualifiedName).left);
  else if (name.kind === SyntaxKind.PropertyAccessExpression)
    parentSymbol = getUnresolvedSymbolForEntityName(c, getExpression(name)!);
  const path = parentSymbol !== undefined ? getSymbolPath(parentSymbol) + '.' + text : text;
  let result = c.unresolvedSymbols.get(path);
  if (result === undefined) {
    result = c.newSymbolWithCheckFlags(SymbolFlags.TypeAlias, text, CheckFlags.Unresolved);
    c.unresolvedSymbols.set(path, result);
    result.parent = parentSymbol;
    c.symbolLinks(result).declaredType = c.unresolvedType;
  }
  return result;
}

function getSymbolPath(symbol: Symbol): string {
  return symbol.parent !== undefined ? getSymbolPath(symbol.parent) + '.' + symbol.name : symbol.name;
}

export function getTypeReferenceType(c: Checker, node: Node, symbol: Symbol): Type {
  if (symbol === c.unknownSymbol) return c.errorType;
  if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0)
    return getTypeFromClassOrInterfaceReference(c, node, symbol);
  if ((symbol.flags & SymbolFlags.TypeAlias) !== 0) return getTypeFromTypeAliasReference(c, node, symbol);
  // Enums and type parameters can't be generic.
  const res = tryGetDeclaredTypeOfSymbol(c, symbol);
  if (res !== undefined && checkNoTypeArguments(c, node, symbol)) return getRegularTypeOfLiteralType(c, res);
  return c.errorType;
}

function typeArgumentNodesOf(node: Node): Node[] {
  const list = getTypeArguments(node);
  return list !== undefined ? list.nodes : emptyNodes;
}

const emptyNodes: Node[] = [];

export function getTypeArgumentsFromNode(c: Checker, node: Node): Type[] {
  return getTypesFromTypeNodes(c, typeArgumentNodesOf(node));
}

export function getTypesFromTypeNodes(c: Checker, nodes: readonly Node[]): Type[] {
  const result: Type[] = [];
  for (const n of nodes) result.push(getTypeFromTypeNode(c, n));
  return result;
}

export function getTypeFromClassOrInterfaceReference(c: Checker, node: Node, symbol: Symbol): Type {
  const t = getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, symbol));
  const typeParameters = t.localTypeParameters();
  if (typeParameters.length === 0) return checkNoTypeArguments(c, node, symbol) ? t : c.errorType;
  const numTypeArguments = typeArgumentNodesOf(node).length;
  const minTypeArgumentCount = getMinTypeArgumentCount(c, typeParameters);
  const isJs = (node.flags & NodeFlags.JavaScriptFile) !== 0;
  const isJsImplicitAny = !c.noImplicitAny && isJs;
  if (!isJsImplicitAny && (numTypeArguments < minTypeArgumentCount || numTypeArguments > typeParameters.length)) {
    const message =
      minTypeArgumentCount < typeParameters.length
        ? Diagnostics.Generic_type_0_requires_between_1_and_2_type_arguments
        : Diagnostics.Generic_type_0_requires_1_type_argument_s;
    c.error(
      node,
      message,
      typeToString(c, t, undefined, 1 << 1),
      String(minTypeArgumentCount),
      String(typeParameters.length),
    );
    if (!isJs) return c.errorType;
  }
  if (
    node.kind === SyntaxKind.TypeReference &&
    isDeferredTypeReferenceNode(c, node, numTypeArguments !== typeParameters.length)
  )
    return createDeferredTypeReference(c, t, node, undefined, getAliasForTypeNode(c, node));
  // Outer type parameters are supplied automatically; the reference gives the local ones.
  const localTypeArguments = fillMissingTypeArguments(
    c,
    getTypeArgumentsFromNode(c, node),
    typeParameters,
    minTypeArgumentCount,
    isJs,
  );
  // localTypeArguments is a new list, so without outer type parameters it is the reference's own.
  const outerCount = t.outerTypeParameterCount;
  if (outerCount === 0) return createTypeReferenceEx(c, t, localTypeArguments, ObjectFlags.FromTypeNode);
  const typeArguments: Type[] = [];
  for (let i = 0; i < outerCount; i++) typeArguments.push(t.allTypeParameters[i]!);
  for (const typeArgument of localTypeArguments) typeArguments.push(typeArgument);
  return createTypeReferenceEx(c, t, typeArguments, ObjectFlags.FromTypeNode);
}

export function checkNoTypeArguments(c: Checker, node: Node, symbol: Symbol | undefined): boolean {
  if (typeArgumentNodesOf(node).length === 0) return true;
  const typeName =
    symbol !== undefined
      ? symbolToString(c, symbol)
      : declarationNameToString(getSourceFileOfNode(node), (node as TypeReferenceNode).typeName);
  c.error(node, Diagnostics.Type_0_is_not_generic, typeName);
  return false;
}

/** Directly aliased references, and those possibly in circular chains of eagerly resolved types, are deferred. */
function isDeferredTypeReferenceNode(c: Checker, node: Node, hasDefaultTypeArguments: boolean): boolean {
  if (getAliasSymbolForTypeNode(c, node) !== undefined) return true;
  if (!isResolvedByTypeAlias(node)) return false;
  switch (node.kind) {
    case SyntaxKind.ArrayType:
      return mayResolveTypeAlias(c, (node as ArrayTypeNode).elementType);
    case SyntaxKind.TupleType:
      return someMayResolveTypeAlias(c, (node as TupleTypeNode).elements.nodes);
    case SyntaxKind.TypeReference:
      return hasDefaultTypeArguments || someMayResolveTypeAlias(c, typeArgumentNodesOf(node));
  }
  return false;
}

function isResolvedByTypeAlias(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.ParenthesizedType:
    case SyntaxKind.NamedTupleMember:
    case SyntaxKind.TypeReference:
    case SyntaxKind.UnionType:
    case SyntaxKind.IntersectionType:
    case SyntaxKind.IndexedAccessType:
    case SyntaxKind.ConditionalType:
    case SyntaxKind.TypeOperator:
    case SyntaxKind.ArrayType:
    case SyntaxKind.TupleType:
      return isResolvedByTypeAlias(parent);
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      return true;
  }
  return false;
}

function mayResolveTypeAlias(c: Checker, node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.TypeReference:
      return (resolveTypeReferenceName(c, node, SymbolFlags.Type, false).flags & SymbolFlags.TypeAlias) !== 0;
    case SyntaxKind.TypeQuery:
      return true;
    case SyntaxKind.TypeOperator:
      return (
        (node as TypeOperatorNode).operator !== SyntaxKind.UniqueKeyword &&
        mayResolveTypeAlias(c, (node as TypeOperatorNode).type)
      );
    case SyntaxKind.ParenthesizedType:
    case SyntaxKind.OptionalType:
    case SyntaxKind.NamedTupleMember:
      return mayResolveTypeAlias(c, getType(node)!);
    case SyntaxKind.RestType: {
      const t = (node as RestTypeNode).type;
      return t.kind !== SyntaxKind.ArrayType || mayResolveTypeAlias(c, (t as ArrayTypeNode).elementType);
    }
    case SyntaxKind.UnionType:
      return someMayResolveTypeAlias(c, (node as UnionTypeNode).types.nodes);
    case SyntaxKind.IntersectionType:
      return someMayResolveTypeAlias(c, (node as IntersectionTypeNode).types.nodes);
    case SyntaxKind.IndexedAccessType:
      return (
        mayResolveTypeAlias(c, (node as IndexedAccessTypeNode).objectType) ||
        mayResolveTypeAlias(c, (node as IndexedAccessTypeNode).indexType)
      );
    case SyntaxKind.ConditionalType: {
      const n = node as ConditionalTypeNode;
      return (
        mayResolveTypeAlias(c, n.checkType) ||
        mayResolveTypeAlias(c, n.extendsType) ||
        mayResolveTypeAlias(c, n.trueType) ||
        mayResolveTypeAlias(c, n.falseType)
      );
    }
  }
  return false;
}

function someMayResolveTypeAlias(c: Checker, nodes: readonly Node[]): boolean {
  for (const n of nodes) if (mayResolveTypeAlias(c, n)) return true;
  return false;
}

// ---- Type aliases

export function isTypeAlias(node: Node): boolean {
  return node.kind === SyntaxKind.TypeAliasDeclaration || node.kind === SyntaxKind.JSTypeAliasDeclaration;
}

export function getAliasForTypeNode(c: Checker, node: Node): TypeAlias | undefined {
  const symbol = getAliasSymbolForTypeNode(c, node);
  return symbol !== undefined
    ? new TypeAlias(symbol, getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, symbol))
    : undefined;
}

export function getAliasSymbolForTypeNode(c: Checker, node: Node): Symbol | undefined {
  let host = node.parent!;
  while (
    host.kind === SyntaxKind.ParenthesizedType ||
    (host.kind === SyntaxKind.TypeOperator && (host as TypeOperatorNode).operator === SyntaxKind.ReadonlyKeyword)
  )
    host = host.parent!;
  return isTypeAlias(host) ? getSymbolOfDeclaration(c, host) : undefined;
}

function isLocalTypeAlias(symbol: Symbol): boolean {
  let declaration: Node | undefined;
  for (const d of getDeclarations(symbol)) {
    if (isTypeAlias(d)) {
      declaration = d;
      break;
    }
  }
  if (declaration === undefined) return false;
  for (let n = declaration.parent; n !== undefined; n = n.parent) {
    switch (n.kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        return true;
    }
  }
  return false;
}

function getTypeFromTypeAliasReference(c: Checker, node: Node, symbol: Symbol): Type {
  const typeArgumentNodes = typeArgumentNodesOf(node);
  if ((symbol.checkFlags & CheckFlags.Unresolved) !== 0) {
    const alias = new TypeAlias(symbol, getTypesFromTypeNodes(c, typeArgumentNodes));
    const key = aliasKey(alias);
    let errorType = c.errorTypes.get(key);
    if (errorType === undefined) {
      errorType = c.newIntrinsicType(TypeFlags.Any, 'error', ObjectFlags.None);
      errorType.alias = alias;
      c.errorTypes.set(key, errorType);
    }
    return errorType;
  }
  const t = getDeclaredTypeOfSymbol(c, symbol);
  const typeParameters = c.symbolLinks(symbol).typeParameters;
  if (typeParameters !== undefined && typeParameters.length !== 0) {
    const numTypeArguments = typeArgumentNodes.length;
    const minTypeArgumentCount = getMinTypeArgumentCount(c, typeParameters);
    if (numTypeArguments < minTypeArgumentCount || numTypeArguments > typeParameters.length) {
      const message =
        minTypeArgumentCount === typeParameters.length
          ? Diagnostics.Generic_type_0_requires_1_type_argument_s
          : Diagnostics.Generic_type_0_requires_between_1_and_2_type_arguments;
      c.error(node, message, symbolToString(c, symbol), String(minTypeArgumentCount), String(typeParameters.length));
      return c.errorType;
    }
    // A local alias doesn't name an instantiation of a top-level one.
    const aliasSymbol = getAliasSymbolForTypeNode(c, node);
    let newAliasSymbol =
      aliasSymbol !== undefined && (isLocalTypeAlias(symbol) || !isLocalTypeAlias(aliasSymbol))
        ? aliasSymbol
        : undefined;
    let aliasTypeArguments: Type[] | undefined;
    if (newAliasSymbol !== undefined)
      aliasTypeArguments = getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, newAliasSymbol);
    else if (node.kind === SyntaxKind.TypeReference) {
      const aliased = resolveTypeReferenceName(c, node, SymbolFlags.Alias, true);
      if (aliased !== c.unknownSymbol) {
        const resolved = resolveAlias(c, aliased);
        if ((resolved.flags & SymbolFlags.TypeAlias) !== 0) {
          newAliasSymbol = resolved;
          aliasTypeArguments = getTypeArgumentsFromNode(c, node);
        }
      }
    }
    const newAlias =
      newAliasSymbol !== undefined ? new TypeAlias(newAliasSymbol, aliasTypeArguments ?? emptyTypes) : undefined;
    return getTypeAliasInstantiation(c, symbol, getTypeArgumentsFromNode(c, node), newAlias);
  }
  return checkNoTypeArguments(c, node, symbol) ? t : c.errorType;
}

export function getTypeAliasInstantiation(
  c: Checker,
  symbol: Symbol,
  typeArguments: Type[],
  alias: TypeAlias | undefined,
): Type {
  const t = getDeclaredTypeOfSymbol(c, symbol);
  if (t === c.intrinsicMarkerType && typeArguments.length === 1) {
    const kind = intrinsicTypeKind(symbol.name);
    if (kind === IntrinsicTypeKind.NoInfer) return getNoInferType(c, typeArguments[0]!);
    if (kind !== IntrinsicTypeKind.Unknown) return getStringMappingType(c, symbol, typeArguments[0]!);
  }
  const links = c.symbolLinks(symbol);
  const typeParameters = links.typeParameters ?? emptyTypes;
  let instantiations = links.instantiations;
  if (instantiations === undefined) {
    instantiations = new Map<string, Type>();
    links.instantiations = instantiations;
  }
  const key = typeListKey(typeArguments) + aliasKey(alias);
  let instantiation = instantiations.get(key);
  if (instantiation === undefined) {
    const inJs =
      symbol.valueDeclaration !== undefined && (symbol.valueDeclaration.flags & NodeFlags.JavaScriptFile) !== 0;
    const mapper = newTypeMapper(
      typeParameters,
      fillMissingTypeArguments(c, typeArguments, typeParameters, getMinTypeArgumentCount(c, typeParameters), inJs),
    );
    instantiation = instantiateTypeWithAlias(c, t, mapper, alias);
    instantiations.set(key, instantiation);
  }
  return instantiation;
}

// ---- Other type nodes

function getTypeFromTypeQueryNode(c: Checker, node: Node): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    type = getRegularTypeOfLiteralType(c, getWidenedType(c, checkExpressionWithTypeArguments(c, node)));
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

export function getTupleElementFlags(c: Checker, node: Node): ElementFlags {
  switch (node.kind) {
    case SyntaxKind.OptionalType:
      return ElementFlags.Optional;
    case SyntaxKind.RestType:
      return getArrayElementTypeNode((node as RestTypeNode).type) !== undefined
        ? ElementFlags.Rest
        : ElementFlags.Variadic;
    case SyntaxKind.NamedTupleMember: {
      const named = node as NamedTupleMember;
      if (named.questionToken !== undefined) return ElementFlags.Optional;
      if (named.dotDotDotToken !== undefined)
        return getArrayElementTypeNode(named.type) !== undefined ? ElementFlags.Rest : ElementFlags.Variadic;
      return ElementFlags.Required;
    }
  }
  return ElementFlags.Required;
}

function getTupleElementInfo(c: Checker, node: Node): TupleElementInfo {
  return new TupleElementInfo(
    getTupleElementFlags(c, node),
    node.kind === SyntaxKind.NamedTupleMember || node.kind === SyntaxKind.Parameter ? node : undefined,
  );
}

function getArrayElementTypeNode(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ParenthesizedType:
      return getArrayElementTypeNode(getType(node)!);
    case SyntaxKind.TupleType: {
      const elements = (node as TupleTypeNode).elements.nodes;
      if (elements.length === 1) {
        const e = elements[0]!;
        if (e.kind === SyntaxKind.RestType) return getArrayElementTypeNode((e as RestTypeNode).type);
        if (e.kind === SyntaxKind.NamedTupleMember && (e as NamedTupleMember).dotDotDotToken !== undefined)
          return getArrayElementTypeNode((e as NamedTupleMember).type);
      }
      return undefined;
    }
    case SyntaxKind.ArrayType:
      return (node as ArrayTypeNode).elementType;
  }
  return undefined;
}

function getArrayOrTupleTargetType(c: Checker, node: Node): Type {
  const parent = node.parent!;
  const readonly =
    parent.kind === SyntaxKind.TypeOperator && (parent as TypeOperatorNode).operator === SyntaxKind.ReadonlyKeyword;
  if (getArrayElementTypeNode(node) !== undefined) return readonly ? c.globalReadonlyArrayType : c.globalArrayType;
  const elementInfos: TupleElementInfo[] = [];
  for (const e of (node as TupleTypeNode).elements.nodes) elementInfos.push(getTupleElementInfo(c, e));
  return getTupleTargetType(c, elementInfos, readonly);
}

function getTypeFromArrayOrTupleTypeNode(c: Checker, node: Node): Type {
  const type = c.resolvedTypes.get(node.id);
  if (type !== undefined) return type;
  const target = getArrayOrTupleTargetType(c, node);
  if (target === c.emptyGenericType) c.resolvedTypes.set(node.id, c.emptyObjectType);
  else if (
    !(node.kind === SyntaxKind.TupleType && hasVariadicTupleElement(c, node as TupleTypeNode)) &&
    isDeferredTypeReferenceNode(c, node, false)
  )
    c.resolvedTypes.set(
      node.id,
      node.kind === SyntaxKind.TupleType && (node as TupleTypeNode).elements.nodes.length === 0
        ? target
        : createDeferredTypeReference(c, target, node, undefined, getAliasForTypeNode(c, node)),
    );
  else {
    const elementTypes =
      node.kind === SyntaxKind.ArrayType
        ? [getTypeFromTypeNode(c, (node as ArrayTypeNode).elementType)]
        : getTypesFromTypeNodes(c, (node as TupleTypeNode).elements.nodes);
    c.resolvedTypes.set(
      node.id,
      (target.objectFlags & ObjectFlags.Tuple) !== 0
        ? createNormalizedTupleType(c, target as TupleType, elementTypes, ObjectFlags.FromTypeNode)
        : createTypeReferenceEx(c, target, elementTypes, ObjectFlags.FromTypeNode),
    );
  }
  return c.resolvedTypes.get(node.id)!;
}

function hasVariadicTupleElement(c: Checker, node: TupleTypeNode): boolean {
  for (const e of node.elements.nodes) if ((getTupleElementFlags(c, e) & ElementFlags.Variadic) !== 0) return true;
  return false;
}

/** Type arguments of a deferred reference from its node. */
export function getTypeArgumentsOfDeferredReference(c: Checker, node: Node, target: InterfaceType): Type[] {
  switch (node.kind) {
    case SyntaxKind.TypeReference:
      return target
        .outerTypeParameters()
        .concat(
          fillMissingTypeArguments(
            c,
            getTypeArgumentsFromNode(c, node),
            target.localTypeParameters(),
            getMinTypeArgumentCount(c, target.localTypeParameters()),
            (node.flags & NodeFlags.JavaScriptFile) !== 0,
          ),
        );
    case SyntaxKind.ArrayType:
      return [getTypeFromTypeNode(c, (node as ArrayTypeNode).elementType)];
    case SyntaxKind.TupleType:
      return getTypesFromTypeNodes(c, (node as TupleTypeNode).elements.nodes);
  }
  return [];
}

function getTypeFromNamedTupleTypeNode(c: Checker, node: NamedTupleMember): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    type =
      node.dotDotDotToken !== undefined
        ? getTypeFromRestTypeNode(c, node)
        : addOptionality(c, getTypeFromTypeNode(c, node.type), true, node.questionToken !== undefined);
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

function getTypeFromRestTypeNode(c: Checker, node: Node): Type {
  const typeNode = getType(node)!;
  return getTypeFromTypeNode(c, getArrayElementTypeNode(typeNode) ?? typeNode);
}

function getTypeFromUnionTypeNode(c: Checker, node: UnionTypeNode): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    type = getUnionTypeEx(
      c,
      getTypesFromTypeNodes(c, node.types.nodes),
      UnionReduction.Literal,
      getAliasForTypeNode(c, node),
      undefined,
    );
    c.resolvedTypes.set(node.id, type);
  }
  return type;
}

function getTypeFromIntersectionTypeNode(c: Checker, node: IntersectionTypeNode): Type {
  if (c.resolvedTypes.get(node.id) === undefined) {
    const alias = getAliasForTypeNode(c, node);
    const types = getTypesFromTypeNodes(c, node.types.nodes);
    // `string & {}` and friends keep literal completions in unions.
    let noSupertypeReduction = false;
    if (types.length === 2) {
      const emptyIndex = types.indexOf(c.emptyTypeLiteralType);
      if (emptyIndex >= 0) {
        const t = types[1 - emptyIndex]!;
        noSupertypeReduction =
          (t.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.BigInt)) !== 0 ||
          ((t.flags & TypeFlags.TemplateLiteral) !== 0 && isPatternLiteralType(c, t));
      }
    }
    c.resolvedTypes.set(
      node.id,
      getIntersectionTypeEx(
        c,
        types,
        noSupertypeReduction ? IntersectionFlags.NoSupertypeReduction : IntersectionFlags.None,
        alias,
      ),
    );
  }
  return c.resolvedTypes.get(node.id)!;
}

function getTypeFromTemplateTypeNode(c: Checker, node: TemplateLiteralTypeNode): Type {
  if (c.resolvedTypes.get(node.id) === undefined) {
    const spans = node.templateSpans.nodes;
    const texts: string[] = [getText(node.head)];
    const types: Type[] = [];
    for (const span of spans) {
      texts.push(getText((span as TemplateLiteralTypeSpan).literal));
      types.push(getTypeFromTypeNode(c, (span as TemplateLiteralTypeSpan).type));
    }
    c.resolvedTypes.set(node.id, getTemplateLiteralType(c, texts, types));
  }
  return c.resolvedTypes.get(node.id)!;
}

/** The symbol an identifier resolves to, cached on the identifier. */
export function getResolvedSymbolOfIdentifier(c: Checker, node: Node): Symbol {
  return getResolvedSymbol(c, node);
}
