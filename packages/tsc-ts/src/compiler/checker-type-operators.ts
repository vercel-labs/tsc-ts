// Type operators: `keyof`, indexed access, mapped, conditional, substitution and string mapping
// types, and genericity tests.
import { sideOf } from './side-state.js';
import { getTypeOfPropertyOfContextualType } from './checker-contextual.js';
import { checkDeprecatedIndexedAccess } from './checker-deprecation.js';
import { isSelfTypeAccess, markPropertyAsReferenced } from './checker-unused.js';
import {
  ModifierFlags,
  type Node,
  getName,
  getQuestionToken,
  getType,
  getSymbol,
  ElementAccessExpression,
  type ConditionalTypeNode,
  type MappedTypeNode,
  IndexedAccessTypeNode,
  TypeParameterDeclaration,
  type TypeOperatorNode,
  getDotDotDotToken,
  getElements,
  getExpression,
  getText,
  type InferTypeNode,
  type TypeReferenceNode,
} from './ast.js';
import { Diagnostics, Diagnostic } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  AccessFlags,
  ConditionalRoot,
  ConditionalType,
  ElementFlags,
  IndexFlags,
  IndexInfo,
  type IndexType,
  IndexedAccessType,
  type IntersectionType,
  type LiteralType,
  type MappedType,
  ObjectFlags,
  StringMappingType,
  type SubstitutionType,
  type TemplateLiteralType,
  type Type,
  type TypeAlias,
  TypeFlags,
  type TypeMapper,
  type TypeParameter,
  type TupleType,
  type UnionType,
  appendTypeMapping,
  prependTypeMapping,
  newTypeMapper,
  IntrinsicType,
  type ReverseMappedType,
  ReferenceArgKind,
  ReferenceArgs,
  type TypeReference,
  VarianceFlags,
  getMappedType,
  getNonDistributedTypeParameter,
} from './checker-types.js';
import {
  UnionReduction,
  IntersectionFlags,
  aliasKey,
  createArrayTypeEx,
  createTupleTypeEx,
  everyType,
  filterType,
  getElementTypes,
  getIntersectionType,
  getIntersectionTypeEx,
  getRegularTypeOfLiteralType,
  getStringLiteralType,
  getTemplateLiteralType,
  getTotalFixedElementCount,
  getTypeArguments,
  getUnionType,
  getUnionTypeEx,
  isArrayType,
  isEmptyAnonymousObjectType,
  isErrorType,
  isGenericStringLikeType,
  isGenericTupleType,
  isPatternLiteralType,
  isReadonlyArrayType,
  isTupleType,
  mapType,
  mapTypeEx,
  intersectTypes,
  mapTypeWithAlias,
  newIndexType,
  newIndexedAccessType,
  newObjectType,
  newSubstitutionType,
  setStructuredTypeMembers,
  someType,
  tupleTargetOf,
  typeListKey,
  typesOf,
  typeListHash,
} from './checker-type-factory.js';
import {
  appendIndexInfo,
  getApparentType,
  getApplicableIndexInfo,
  getDeclarationModifierFlagsFromSymbol,
  getIndexInfoOfType,
  getPropertyOfObjectType,
  getIndexInfosOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getReducedApparentType,
  getReducedType,
  getBaseConstraintOfType,
  getIndexTypeOfType,
  hasPropertiesOfType,
  keepPropertiesOnly,
} from './checker-members.js';
import {
  getLateBoundSymbol,
  getSymbolOfDeclaration,
  popTypeResolution,
  pushTypeResolution,
  TypeSystemPropertyName,
  getParentOfSymbol,
  findResolutionCycleStartIndex,
  getFullyQualifiedName,
} from './checker-symbols.js';
import {
  getConstraintOfTypeParameter,
  getDeclaredTypeOfTypeParameter,
  getElementTypeOfArrayType,
  getInferTypeParameters,
  getOuterTypeParameters,
  hasNonCircularBaseConstraint,
} from './checker-declared-types.js';
import {
  addOptionality,
  getOptionalType,
  getTypeOfSymbol,
  getWriteTypeOfSymbol,
  isReadonlySymbol,
  removeMissingOrUndefinedType,
} from './checker-symbol-types.js';
import { getTypeFromTypeNode, getAliasForTypeNode } from './checker-type-nodes.js';
import {
  combineTypeMappers,
  getRestrictiveInstantiation,
  instantiateAnonymousType,
  isRestrictiveInstance,
  instantiateType,
  instantiateTypeAlias,
  isTypeParameterPossiblyReferenced,
  containsTypeParameterReference,
  isNodeDescendantOf,
} from './instantiation.js';
import { getVariances, isMarkerType, isTypeAssignableTo } from './relations.js';
import { symbolToString, typeToString } from './type-printer.js';
import { getSourceFileOfNode, isAssignmentTarget, isEntityNameExpression, nodeText } from './binder-utilities.js';
import { getTextOfNodeFromSourceText } from './ast-utilities.js';
import { getMinArgumentCount, getSingleCallSignature, getTypeAtPosition } from './checker-signatures.js';
import { AssignmentKind, getAssignmentTargetKind, getFlowTypeOfReference } from './checker-narrowing.js';
import {
  getSuggestionForNonexistentProperty,
  isAssignmentToReadonlyEntity,
  isDeleteTarget,
  typeHasStaticProperty,
} from './checker-property-access.js';
import { checkComputedPropertyName, checkExpression } from './checker-expressions.js';
import {
  getPropertyNameFromType,
  isNumericLiteralName,
  isTypeUsableAsPropertyName,
  isValidIndexKeyType,
  maybeTypeOfKind,
  isLateBoundName,
} from './checker-utilities.js';
import {
  inferTypesForConditional,
  inferTypesFromTemplateLiteralType,
  isValidBigIntString,
  isValidNumberString,
  instantiateReverseMappedType as instantiateReverseMappedTypeOfInference,
  resolveReverseMappedTypeMembers as resolveReverseMappedTypeMembersOfInference,
} from './checker-inference.js';
import {
  CheckFlags,
  copyDeclarations,
  declarationCount,
  getSymbolId,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
} from './symbol.js';

// ---- Genericity

export function isGenericType(c: Checker, t: Type): boolean {
  return getGenericObjectFlags(c, t) !== 0;
}

export function isGenericObjectType(c: Checker, t: Type): boolean {
  return (getGenericObjectFlags(c, t) & ObjectFlags.IsGenericObjectType) !== 0;
}

export function isGenericIndexType(c: Checker, t: Type): boolean {
  return (getGenericObjectFlags(c, t) & ObjectFlags.IsGenericIndexType) !== 0;
}

function getGenericObjectFlags(c: Checker, t: Type): ObjectFlags {
  if ((t.flags & (TypeFlags.UnionOrIntersection | TypeFlags.Substitution)) !== 0) {
    if ((t.objectFlags & ObjectFlags.IsGenericTypeComputed) !== 0) return t.objectFlags & ObjectFlags.IsGenericType;
    const side = sideOf(c, t);
    if ((side.objectFlags & ObjectFlags.IsGenericTypeComputed) === 0) {
      let combined = 0;
      if ((t.flags & TypeFlags.UnionOrIntersection) !== 0)
        for (const u of typesOf(t)) combined |= getGenericObjectFlags(c, u);
      else {
        const s = t as SubstitutionType;
        combined = getGenericObjectFlags(c, s.baseType) | getGenericObjectFlags(c, s.constraint);
      }
      side.objectFlags |= ObjectFlags.IsGenericTypeComputed | combined;
    }
    return side.objectFlags & ObjectFlags.IsGenericType;
  }
  let combined = 0;
  if ((t.flags & TypeFlags.InstantiableNonPrimitive) !== 0 || isGenericMappedType(c, t) || isGenericTupleType(t))
    combined |= ObjectFlags.IsGenericObjectType;
  if ((t.flags & (TypeFlags.InstantiableNonPrimitive | TypeFlags.Index)) !== 0 || isGenericStringLikeType(c, t))
    combined |= ObjectFlags.IsGenericIndexType;
  return combined;
}

export function isGenericMappedType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.Mapped) === 0 || (t.flags & TypeFlags.Object) === 0) return false;
  const mapped = t as MappedType;
  const constraint = getConstraintTypeFromMappedType(c, mapped);
  if (isGenericIndexType(c, constraint)) return true;
  // Generic when the `as` clause references generic types other than the iteration type.
  const nameType = getNameTypeFromMappedType(c, mapped);
  return (
    nameType !== undefined &&
    isGenericIndexType(
      c,
      instantiateType(c, nameType, newTypeMapper([getTypeParameterFromMappedType(c, mapped)], [constraint])),
    )
  );
}

/** Unions reducible on instantiation stay generic so the reduction flows through. */
export function isGenericReducibleType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Union) !== 0) {
    if ((t.objectFlags & ObjectFlags.ContainsIntersections) === 0) return false;
    for (const u of typesOf(t)) if (isGenericReducibleType(c, u)) return true;
    return false;
  }
  return (t.flags & TypeFlags.Intersection) !== 0 && isReducibleIntersection(c, t as IntersectionType);
}

function isReducibleIntersection(c: Checker, t: IntersectionType): boolean {
  const side = sideOf(c, t);
  if (side.uniqueLiteralFilledInstantiation === undefined)
    side.uniqueLiteralFilledInstantiation = instantiateType(c, t, c.uniqueLiteralMapper);
  return getReducedType(c, side.uniqueLiteralFilledInstantiation) !== side.uniqueLiteralFilledInstantiation;
}

// ---- keyof

export function getIndexType(c: Checker, t: Type): Type {
  return getIndexTypeEx(c, t, IndexFlags.None);
}

export function getIndexTypeEx(c: Checker, t: Type, indexFlags: IndexFlags): Type {
  t = getReducedType(c, t);
  if (isNoInferType(c, t)) return getNoInferType(c, getIndexTypeEx(c, (t as SubstitutionType).baseType, indexFlags));
  if (shouldDeferIndexType(c, t, indexFlags)) return getIndexTypeForGenericType(c, t, indexFlags);
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) {
    const types: Type[] = [];
    for (const u of typesOf(t)) types.push(getIndexTypeEx(c, u, indexFlags));
    return (t.flags & TypeFlags.Union) !== 0 ? getIntersectionType(c, types) : getUnionType(c, types);
  }
  if ((t.objectFlags & ObjectFlags.Mapped) !== 0 && (t.flags & TypeFlags.Object) !== 0)
    return getIndexForMappedType(c, t as MappedType, indexFlags);
  if (t === c.wildcardType) return c.wildcardType;
  if ((t.flags & TypeFlags.Unknown) !== 0) return c.neverType;
  if ((t.flags & (TypeFlags.Any | TypeFlags.Never)) !== 0) return c.stringNumberSymbolType;
  const include =
    ((indexFlags & IndexFlags.NoIndexSignatures) !== 0 ? TypeFlags.StringLiteral : TypeFlags.StringLike) |
    ((indexFlags & IndexFlags.StringsOnly) !== 0 ? 0 : TypeFlags.NumberLike | TypeFlags.ESSymbolLike);
  return getLiteralTypeFromProperties(c, t, include, indexFlags === IndexFlags.None);
}

export function shouldDeferIndexType(c: Checker, t: Type, indexFlags: IndexFlags): boolean {
  return (
    (t.flags & TypeFlags.InstantiableNonPrimitive) !== 0 ||
    isGenericTupleType(t) ||
    (isGenericMappedType(c, t) && getNameTypeFromMappedType(c, t as MappedType) !== undefined) ||
    ((t.flags & TypeFlags.Union) !== 0 &&
      (indexFlags & IndexFlags.NoReducibleCheck) === 0 &&
      isGenericReducibleType(c, t)) ||
    ((t.flags & TypeFlags.Intersection) !== 0 &&
      maybeTypeOfKind(t, TypeFlags.Instantiable) &&
      someEmptyAnonymousObjectType(c, typesOf(t)))
  );
}

function someEmptyAnonymousObjectType(c: Checker, types: Type[]): boolean {
  for (const t of types) if (isEmptyAnonymousObjectType(c, t)) return true;
  return false;
}

function getIndexTypeForGenericType(c: Checker, t: Type, indexFlags: IndexFlags): Type {
  const key = cachedTypeKey(
    (indexFlags & IndexFlags.StringsOnly) !== 0 ? CachedTypeKind.StringIndexType : CachedTypeKind.IndexType,
    t.id,
  );
  let indexType = c.cachedTypesById.get(key);
  if (indexType === undefined) {
    indexType = newIndexType(c, t, indexFlags & IndexFlags.StringsOnly);
    c.cachedTypesById.set(key, indexType);
  }
  return indexType;
}

export function getLiteralTypeFromProperties(c: Checker, t: Type, include: TypeFlags, includeOrigin: boolean): Type {
  const key = 'props' + t.id + ':' + include + (includeOrigin ? 'o' : '');
  const cached = c.cachedTypes.get(key);
  if (cached !== undefined) return cached;
  const origin =
    (includeOrigin && (t.objectFlags & (ObjectFlags.ClassOrInterface | ObjectFlags.Reference)) !== 0) ||
    t.alias !== undefined
      ? newIndexType(c, t, IndexFlags.None)
      : undefined;
  const types: Type[] = [];
  for (const prop of getPropertiesOfType(c, t)) types.push(getLiteralTypeFromProperty(c, prop, include, false));
  for (const info of getIndexInfosOfType(c, t))
    if (info !== c.enumNumberIndexInfo && isKeyTypeIncluded(info.keyType, include))
      types.push(
        info.keyType === c.stringType && (include & TypeFlags.Number) !== 0 ? c.stringOrNumberType : info.keyType,
      );
  const result = getUnionTypeEx(c, types, UnionReduction.Literal, undefined, origin);
  c.cachedTypes.set(key, result);
  return result;
}

export function getLiteralTypeFromProperty(
  c: Checker,
  prop: Symbol,
  include: TypeFlags,
  includeNonPublic: boolean,
): Type {
  if (
    includeNonPublic ||
    (getDeclarationModifierFlagsFromSymbol(c, prop, false) & ModifierFlags.NonPublicAccessibilityModifier) === 0
  ) {
    let t = c.symbolNameTypes.get(getSymbolId(getLateBoundSymbol(c, prop)));
    if (t === undefined) {
      if (prop.name === InternalSymbolName.Default) t = getStringLiteralType(c, 'default');
      else {
        const name = prop.valueDeclaration !== undefined ? getName(prop.valueDeclaration) : undefined;
        if (name !== undefined) t = getLiteralTypeFromPropertyName(c, name);
        if (t === undefined && !isKnownSymbol(prop)) t = getStringLiteralType(c, symbolNameText(prop));
      }
    }
    if (t !== undefined && (t.flags & include) !== 0) return t;
  }
  return c.neverType;
}

function isKnownSymbol(symbol: Symbol): boolean {
  return symbol.name.startsWith('￾@');
}

function symbolNameText(symbol: Symbol): string {
  return symbol.name;
}

export function getLiteralTypeFromPropertyName(c: Checker, name: Node): Type | undefined {
  if (name.kind === SyntaxKind.PrivateIdentifier) return c.neverType;
  if (name.kind === SyntaxKind.NumericLiteral) return getRegularTypeOfLiteralType(c, checkExpression(c, name));
  if (name.kind === SyntaxKind.ComputedPropertyName)
    return getRegularTypeOfLiteralType(c, checkComputedPropertyName(c, name));
  if (
    name.kind === SyntaxKind.Identifier ||
    name.kind === SyntaxKind.StringLiteral ||
    name.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  )
    return getStringLiteralType(c, getText(name));
  if (name.kind === SyntaxKind.JsxNamespacedName) return getStringLiteralType(c, nodeText(name));
  if (name.kind === SyntaxKind.BigIntLiteral) return getRegularTypeOfLiteralType(c, checkExpression(c, name));
  return c.neverType;
}

function isKeyTypeIncluded(keyType: Type, include: TypeFlags): boolean {
  if ((keyType.flags & include) !== 0) return true;
  if ((keyType.flags & TypeFlags.Intersection) === 0) return false;
  for (const t of typesOf(keyType)) if (isKeyTypeIncluded(t, include)) return true;
  return false;
}

/** The keys of a mapped type, without resolving its properties. */
export function getIndexForMappedType(c: Checker, t: MappedType, indexFlags: IndexFlags = IndexFlags.None): Type {
  const typeParameter = getTypeParameterFromMappedType(c, t);
  const constraintType = getConstraintTypeFromMappedType(c, t);
  const nameType = getNameTypeFromMappedType(c, mappedTypeTarget(t));
  if (nameType === undefined && (indexFlags & IndexFlags.NoIndexSignatures) === 0) return constraintType;
  const keyTypes: Type[] = [];
  const add = (keyType: Type): void => {
    const propNameType =
      nameType !== undefined
        ? instantiateType(c, nameType, appendTypeMapping(t.mapper, typeParameter, keyType))
        : keyType;
    // `keyof` of a string index signature is `string | number`.
    keyTypes.push(propNameType === c.stringType ? c.stringOrNumberType : propNameType);
  };
  if (isGenericIndexType(c, constraintType)) {
    if (isMappedTypeWithKeyofConstraintDeclaration(c, t)) return getIndexTypeForGenericType(c, t, indexFlags);
    forEachType(constraintType, add);
  } else if (isMappedTypeWithKeyofConstraintDeclaration(c, t)) {
    const modifiersType = getApparentType(c, getModifiersTypeFromMappedType(c, t));
    forEachMappedTypePropertyKeyTypeAndIndexSignatureKeyType(
      c,
      modifiersType,
      TypeFlags.StringOrNumberLiteralOrUnique,
      (indexFlags & IndexFlags.StringsOnly) !== 0,
      add,
    );
  } else forEachType(getLowerBoundOfKeyType(c, constraintType), add);
  const result =
    (indexFlags & IndexFlags.NoIndexSignatures) !== 0
      ? filterType(c, getUnionType(c, keyTypes), (u) => (u.flags & (TypeFlags.Any | TypeFlags.String)) === 0)
      : getUnionType(c, keyTypes);
  if (
    (result.flags & TypeFlags.Union) !== 0 &&
    (constraintType.flags & TypeFlags.Union) !== 0 &&
    typeListKey(typesOf(result)) === typeListKey(typesOf(constraintType))
  )
    return constraintType;
  return result;
}

export function forEachType(t: Type, f: (t: Type) => void): void {
  if ((t.flags & TypeFlags.Union) !== 0) for (const u of typesOf(t)) f(u);
  else f(t);
}

function forEachMappedTypePropertyKeyTypeAndIndexSignatureKeyType(
  c: Checker,
  t: Type,
  include: TypeFlags,
  stringsOnly: boolean,
  cb: (keyType: Type) => void,
): void {
  for (const prop of getPropertiesOfType(c, t)) cb(getLiteralTypeFromProperty(c, prop, include, false));
  if ((t.flags & TypeFlags.Any) !== 0) cb(c.stringType);
  else
    for (const info of getIndexInfosOfType(c, t))
      if (!stringsOnly || (info.keyType.flags & (TypeFlags.String | TypeFlags.TemplateLiteral)) !== 0) cb(info.keyType);
}

/** The keys a generic mapped type with an `as` clause maps the apparent keys of its modifiers type to. */
export function getApparentMappedTypeKeys(c: Checker, nameType: Type, targetType: MappedType): Type {
  const modifiersType = getApparentType(c, getModifiersTypeFromMappedType(c, targetType));
  const mappedKeys: Type[] = [];
  forEachMappedTypePropertyKeyTypeAndIndexSignatureKeyType(
    c,
    modifiersType,
    TypeFlags.StringOrNumberLiteralOrUnique,
    false,
    (t) => {
      mappedKeys.push(
        instantiateType(
          c,
          nameType,
          appendTypeMapping(targetType.mapper, getTypeParameterFromMappedType(c, targetType), t),
        ),
      );
    },
  );
  return getUnionType(c, mappedKeys);
}

/** Keys known to always be present, e.g. from constraints of type parameters. */
function getLowerBoundOfKeyType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Index) !== 0) {
    const target = getApparentType(c, (t as IndexType).target);
    return isGenericTupleType(target) ? getKnownKeysOfTupleType(c, target) : getIndexType(c, target);
  }
  if ((t.flags & TypeFlags.Conditional) !== 0) {
    const conditional = t as ConditionalType;
    if (conditional.root.isDistributive) {
      const checkType = conditional.checkType;
      const constraint = getLowerBoundOfKeyType(c, checkType);
      if (constraint !== checkType)
        return getConditionalTypeInstantiation(
          c,
          conditional,
          prependTypeMapping(conditional.root.checkType, constraint, conditional.mapper),
          false,
          undefined,
        );
    }
    return t;
  }
  if ((t.flags & TypeFlags.Union) !== 0) return mapTypeEx(c, t, (u) => getLowerBoundOfKeyType(c, u), true)!;
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    const types = typesOf(t);
    // Keep `string & {}` and friends, which prevent subtype reduction.
    if (
      types.length === 2 &&
      (types[0]!.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.BigInt)) !== 0 &&
      types[1]! === c.emptyTypeLiteralType
    )
      return t;
    const bounds: Type[] = [];
    for (const u of types) bounds.push(getLowerBoundOfKeyType(c, u));
    return getIntersectionType(c, bounds);
  }
  return t;
}

function getKnownKeysOfTupleType(c: Checker, t: Type): Type {
  const target = tupleTargetOf(t);
  const keys: Type[] = [];
  for (let i = 0; i < target.fixedLength; i++) keys.push(getStringLiteralType(c, String(i)));
  keys.push(getIndexType(c, target.readonly ? c.globalReadonlyArrayType : c.globalArrayType));
  return getUnionType(c, keys);
}

// ---- Indexed access

export function getIndexedAccessType(c: Checker, objectType: Type, indexType: Type): Type {
  return getIndexedAccessTypeEx(c, objectType, indexType, AccessFlags.None, undefined, undefined);
}

export function getIndexedAccessTypeEx(
  c: Checker,
  objectType: Type,
  indexType: Type,
  accessFlags: AccessFlags,
  accessNode: Node | undefined,
  alias: TypeAlias | undefined,
): Type {
  return (
    getIndexedAccessTypeOrUndefinedEx(c, objectType, indexType, accessFlags, accessNode, alias) ??
    (accessNode !== undefined ? c.errorType : c.unknownType)
  );
}

export function getIndexedAccessTypeOrUndefined(
  c: Checker,
  objectType: Type,
  indexType: Type,
  accessFlags: AccessFlags,
): Type | undefined {
  return getIndexedAccessTypeOrUndefinedEx(c, objectType, indexType, accessFlags, undefined, undefined);
}

export function getIndexedAccessTypeOrUndefinedEx(
  c: Checker,
  objectType: Type,
  indexType: Type,
  accessFlags: AccessFlags,
  accessNode: Node | undefined,
  alias: TypeAlias | undefined,
): Type | undefined {
  if (objectType === c.wildcardType || indexType === c.wildcardType) return c.wildcardType;
  objectType = getReducedType(c, objectType);
  // A type with only a string index signature always yields that signature's type.
  if (
    isStringIndexSignatureOnlyType(c, objectType) &&
    (indexType.flags & TypeFlags.Nullable) === 0 &&
    isTypeAssignableToKind(c, indexType, TypeFlags.String | TypeFlags.Number)
  )
    indexType = c.stringType;
  if (c.noUncheckedIndexedAccess && (accessFlags & AccessFlags.ExpressionPosition) !== 0)
    accessFlags |= AccessFlags.IncludeUndefined;
  // Generic index or object types defer to an indexed access type.
  if (shouldDeferIndexedAccessType(c, objectType, indexType, accessNode)) {
    if ((objectType.flags & TypeFlags.AnyOrUnknown) !== 0) return objectType;
    const persistent = accessFlags & AccessFlags.Persistent;
    const key = objectType.id + ',' + indexType.id + ',' + accessFlags + aliasKey(alias);
    let t = c.indexedAccessTypes.get(key);
    if (t === undefined) {
      t = newIndexedAccessType(c, objectType, indexType, persistent);
      t.alias = alias;
      c.indexedAccessTypes.set(key, t);
    }
    return t;
  }
  // `boolean` stays whole for better errors.
  const apparentObjectType = getReducedApparentType(c, objectType);
  if ((indexType.flags & TypeFlags.Union) !== 0 && (indexType.flags & TypeFlags.Boolean) === 0) {
    const propTypes: Type[] = [];
    let wasMissingProp = false;
    for (const t of typesOf(indexType)) {
      const propType = getPropertyTypeForIndexType(
        c,
        objectType,
        apparentObjectType,
        t,
        indexType,
        accessNode,
        accessFlags | (wasMissingProp ? AccessFlags.SuppressNoImplicitAnyError : 0),
      );
      if (propType !== undefined) propTypes.push(propType);
      else if (accessNode === undefined) return undefined;
      else wasMissingProp = true;
    }
    if (wasMissingProp) return undefined;
    if ((accessFlags & AccessFlags.Writing) !== 0)
      return getIntersectionTypeEx(c, propTypes, IntersectionFlags.None, alias);
    return getUnionTypeEx(c, propTypes, UnionReduction.Literal, alias, undefined);
  }
  return getPropertyTypeForIndexType(
    c,
    objectType,
    apparentObjectType,
    indexType,
    indexType,
    accessNode,
    accessFlags | AccessFlags.CacheSymbol | AccessFlags.ReportDeprecated,
  );
}

function shouldDeferIndexedAccessType(
  c: Checker,
  objectType: Type,
  indexType: Type,
  accessNode: Node | undefined,
): boolean {
  if (isGenericIndexType(c, indexType)) return true;
  if (accessNode !== undefined && accessNode.kind !== SyntaxKind.IndexedAccessType)
    return (
      isGenericTupleType(objectType) &&
      !indexTypeLessThan(indexType, getTotalFixedElementCount(tupleTargetOf(objectType)))
    );
  return (
    (isGenericObjectType(c, objectType) &&
      !(
        isTupleType(objectType) && indexTypeLessThan(indexType, getTotalFixedElementCount(tupleTargetOf(objectType)))
      )) ||
    isGenericReducibleType(c, objectType)
  );
}

function indexTypeLessThan(indexType: Type, limit: number): boolean {
  return everyType(indexType, (t) => {
    if ((t.flags & TypeFlags.StringOrNumberLiteral) !== 0) {
      const name = getPropertyNameFromType(t);
      if (isNumericLiteralName(name)) {
        const index = Number(name);
        return index >= 0 && index < limit;
      }
    }
    return false;
  });
}

export function isStringIndexSignatureOnlyType(c: Checker, t: Type): boolean {
  return (
    ((t.flags & TypeFlags.Object) !== 0 &&
      !isGenericMappedType(c, t) &&
      !hasPropertiesOfType(c, t) &&
      getIndexInfosOfType(c, t).length === 1 &&
      getIndexInfoOfType(c, t, c.stringType) !== undefined) ||
    ((t.flags & TypeFlags.UnionOrIntersection) !== 0 && everyStringIndexSignatureOnlyType(c, typesOf(t)))
  );
}

function everyStringIndexSignatureOnlyType(c: Checker, types: Type[]): boolean {
  for (const t of types) if (!isStringIndexSignatureOnlyType(c, t)) return false;
  return true;
}

export function isTypeAssignableToKind(c: Checker, source: Type, kind: TypeFlags): boolean {
  return isTypeAssignableToKindEx(c, source, kind, false);
}

export function isTypeAssignableToKindEx(c: Checker, source: Type, kind: TypeFlags, strict: boolean): boolean {
  if ((source.flags & kind) !== 0) return true;
  if (strict && (source.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Void | TypeFlags.Undefined | TypeFlags.Null)) !== 0)
    return false;
  return (
    ((kind & TypeFlags.NumberLike) !== 0 && isTypeAssignableTo(c, source, c.numberType)) ||
    ((kind & TypeFlags.BigIntLike) !== 0 && isTypeAssignableTo(c, source, c.bigintType)) ||
    ((kind & TypeFlags.StringLike) !== 0 && isTypeAssignableTo(c, source, c.stringType)) ||
    ((kind & TypeFlags.BooleanLike) !== 0 && isTypeAssignableTo(c, source, c.booleanType)) ||
    ((kind & TypeFlags.Void) !== 0 && isTypeAssignableTo(c, source, c.voidType)) ||
    ((kind & TypeFlags.Never) !== 0 && isTypeAssignableTo(c, source, c.neverType)) ||
    ((kind & TypeFlags.Null) !== 0 && isTypeAssignableTo(c, source, c.nullType)) ||
    ((kind & TypeFlags.Undefined) !== 0 && isTypeAssignableTo(c, source, c.undefinedType)) ||
    ((kind & TypeFlags.ESSymbol) !== 0 && isTypeAssignableTo(c, source, c.esSymbolType)) ||
    ((kind & TypeFlags.NonPrimitive) !== 0 && isTypeAssignableTo(c, source, c.nonPrimitiveType))
  );
}

export function getPropertyNameFromIndex(indexType: Type): string | undefined {
  return isTypeUsableAsPropertyName(indexType) ? getPropertyNameFromType(indexType) : undefined;
}

/** The type of the property `indexType` selects; reporting of access errors happens in element access checks. */
function getPropertyTypeForIndexType(
  c: Checker,
  originalObjectType: Type,
  objectType: Type,
  indexType: Type,
  fullIndexType: Type,
  accessNode: Node | undefined,
  accessFlags: AccessFlags,
): Type | undefined {
  const accessExpression =
    accessNode !== undefined && accessNode.kind === SyntaxKind.ElementAccessExpression ? accessNode : undefined;
  const propName =
    accessNode !== undefined && accessNode.kind === SyntaxKind.PrivateIdentifier
      ? undefined
      : getPropertyNameFromIndex(indexType);
  if (propName !== undefined) {
    // Contextual accesses read the property without reducing a union of its types.
    if ((accessFlags & AccessFlags.Contextual) !== 0)
      return getTypeOfPropertyOfContextualType(c, objectType, propName) ?? c.anyType;
    const prop = getPropertyOfType(c, objectType, propName);
    if (prop !== undefined) {
      if ((accessFlags & AccessFlags.ReportDeprecated) !== 0 && accessNode !== undefined)
        checkDeprecatedIndexedAccess(c, accessNode, prop, propName);
      if (accessExpression !== undefined) {
        markPropertyAsReferenced(
          c,
          prop,
          accessExpression,
          isSelfTypeAccess(c, getExpression(accessExpression)!, objectType.symbol),
        );
        if (isAssignmentToReadonlyEntity(c, accessExpression, prop, getAssignmentTargetKind(accessExpression))) {
          c.error(
            (accessExpression as ElementAccessExpression).argumentExpression,
            Diagnostics.Cannot_assign_to_0_because_it_is_a_read_only_property,
            isLateBoundName(prop.name) ? symbolToString(c, prop) : prop.name,
          );
          return undefined;
        }
        if ((accessFlags & AccessFlags.CacheSymbol) !== 0) c.resolvedSymbols.set(accessExpression.id, prop);
        if (isThisPropertyAccessInConstructor(c, accessExpression, prop)) return c.autoType;
      }
      const propType =
        (accessFlags & AccessFlags.Writing) !== 0 ? getWriteTypeOfSymbol(c, prop) : getTypeOfSymbol(c, prop);
      // Each property an element access reads is narrowed by itself, as a reference to that property.
      if (accessExpression !== undefined && getAssignmentTargetKind(accessExpression) !== AssignmentKind.Definite)
        return getFlowTypeOfReference(c, accessExpression, propType, propType, undefined);
      if (accessNode !== undefined && accessNode.kind === SyntaxKind.IndexedAccessType && containsMissing(c, propType))
        return getUnionType(c, [propType, c.undefinedType]);
      return propType;
    }
    if (everyType(objectType, isTupleType) && isNumericLiteralName(propName)) {
      const index = Number(propName);
      if (
        accessNode !== undefined &&
        everyType(objectType, (t) => (tupleTargetOf(t).combinedFlags & ElementFlags.Variable) === 0) &&
        (accessFlags & AccessFlags.AllowMissing) === 0
      ) {
        const indexNode = getIndexNodeForAccessExpression(accessNode);
        if (isTupleType(objectType)) {
          if (index < 0) {
            c.error(indexNode, Diagnostics.A_tuple_type_cannot_be_indexed_with_a_negative_value);
            return c.undefinedType;
          }
          c.error(
            indexNode,
            Diagnostics.Tuple_type_0_of_length_1_has_no_element_at_index_2,
            typeToString(c, objectType),
            String(tupleTargetOf(objectType).typeParameterCount()),
            propName,
          );
        } else
          c.error(indexNode, Diagnostics.Property_0_does_not_exist_on_type_1, propName, typeToString(c, objectType));
      }
      if (index >= 0) {
        errorIfWritingToReadonlyIndex(c, getIndexInfoOfType(c, objectType, c.numberType), objectType, accessExpression);
        return getTupleElementTypeOutOfStartCount(
          c,
          objectType,
          index,
          (accessFlags & AccessFlags.IncludeUndefined) !== 0 ? c.missingType : undefined,
        );
      }
    }
  }
  if (
    (indexType.flags & TypeFlags.Nullable) === 0 &&
    isTypeAssignableToKind(c, indexType, TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.ESSymbolLike)
  ) {
    if ((objectType.flags & (TypeFlags.Any | TypeFlags.Never)) !== 0) return objectType;
    // The string index signature applies even to symbol-like keys when nothing else does.
    const indexInfo =
      getApplicableIndexInfo(c, objectType, indexType) ?? getIndexInfoOfType(c, objectType, c.stringType);
    if (indexInfo !== undefined) {
      if ((accessFlags & AccessFlags.NoIndexSignatures) !== 0 && indexInfo.keyType !== c.numberType) {
        if (accessExpression !== undefined) {
          if ((accessFlags & AccessFlags.Writing) !== 0)
            c.error(
              accessExpression,
              Diagnostics.Type_0_is_generic_and_can_only_be_indexed_for_reading,
              typeToString(c, originalObjectType),
            );
          else
            c.error(
              accessExpression,
              Diagnostics.Type_0_cannot_be_used_to_index_type_1,
              typeToString(c, indexType),
              typeToString(c, originalObjectType),
            );
        }
        return undefined;
      }
      if (
        accessNode !== undefined &&
        indexInfo.keyType === c.stringType &&
        !isTypeAssignableToKind(c, indexType, TypeFlags.String | TypeFlags.Number)
      ) {
        c.error(
          getIndexNodeForAccessExpression(accessNode),
          Diagnostics.Type_0_cannot_be_used_as_an_index_type,
          typeToString(c, indexType),
        );
        return (accessFlags & AccessFlags.IncludeUndefined) !== 0
          ? getUnionType(c, [indexInfo.valueType, c.missingType])
          : indexInfo.valueType;
      }
      errorIfWritingToReadonlyIndex(c, indexInfo, objectType, accessExpression);
      // An enum object indexed with its own members, as in `E[E.A]`, can't be out of bounds.
      if (
        (accessFlags & AccessFlags.IncludeUndefined) !== 0 &&
        !(
          objectType.symbol !== undefined &&
          (objectType.symbol.flags & (SymbolFlags.RegularEnum | SymbolFlags.ConstEnum)) !== 0 &&
          indexType.symbol !== undefined &&
          (indexType.flags & TypeFlags.EnumLiteral) !== 0 &&
          getParentOfSymbol(c, indexType.symbol) === objectType.symbol
        )
      )
        return getUnionType(c, [indexInfo.valueType, c.missingType]);
      return indexInfo.valueType;
    }
    if ((indexType.flags & TypeFlags.Never) !== 0) return c.neverType;
    if (isJSLiteralType(c, objectType)) return c.anyType;
    if (accessExpression !== undefined && !isConstEnumObjectType(objectType)) {
      if (isObjectLiteralType(objectType)) {
        if (c.noImplicitAny && (indexType.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) !== 0) {
          c.error(
            accessExpression,
            Diagnostics.Property_0_does_not_exist_on_type_1,
            getPropertyNameFromType(indexType),
            typeToString(c, objectType),
          );
          return c.undefinedType;
        }
        if ((indexType.flags & (TypeFlags.Number | TypeFlags.String)) !== 0) {
          const types: Type[] = [];
          for (const p of getPropertiesOfType(c, objectType)) types.push(getTypeOfSymbol(c, p));
          types.push(c.undefinedType);
          return getUnionType(c, types);
        }
      }
      const globalSymbol =
        objectType.symbol === c.globalThisSymbol && propName !== undefined
          ? c.globalThisSymbol.exports?.get(propName)
          : undefined;
      if (globalSymbol !== undefined && (globalSymbol.flags & SymbolFlags.BlockScoped) !== 0)
        c.error(
          accessExpression,
          Diagnostics.Property_0_does_not_exist_on_type_1,
          propName!,
          typeToString(c, objectType),
        );
      else if (c.noImplicitAny && (accessFlags & AccessFlags.SuppressNoImplicitAnyError) === 0) {
        const argument = (accessExpression as ElementAccessExpression).argumentExpression;
        const objectText = typeToString(c, objectType);
        const suggestion =
          propName !== undefined ? getSuggestionForNonexistentProperty(c, propName, objectType) : undefined;
        if (propName !== undefined && typeHasStaticProperty(c, propName, objectType))
          c.error(
            accessExpression,
            Diagnostics.Property_0_does_not_exist_on_type_1_Did_you_mean_to_access_the_static_member_2_instead,
            propName,
            objectText,
            objectText + '[' + getTextOfNodeFromSourceText(getSourceFileOfNode(argument).text, argument) + ']',
          );
        else if (getIndexTypeOfType(c, objectType, c.numberType) !== undefined)
          c.error(
            argument,
            Diagnostics.Element_implicitly_has_an_any_type_because_index_expression_is_not_of_type_number,
          );
        else if (suggestion !== undefined)
          c.error(
            argument,
            Diagnostics.Property_0_does_not_exist_on_type_1_Did_you_mean_2,
            propName!,
            objectText,
            suggestion.name,
          );
        else {
          const methodSuggestion = getSuggestionForNonexistentIndexSignature(
            c,
            objectType,
            accessExpression,
            indexType,
          );
          if (methodSuggestion !== '') {
            c.error(
              accessExpression,
              Diagnostics.Element_implicitly_has_an_any_type_because_type_0_has_no_index_signature_Did_you_mean_to_call_1,
              objectText,
              methodSuggestion,
            );
            return undefined;
          }
          let head: Diagnostic | undefined = undefined;
          if ((indexType.flags & TypeFlags.EnumLiteral) !== 0)
            head = createDiagnosticForNode(accessExpression, Diagnostics.Property_0_does_not_exist_on_type_1, [
              '[' + typeToString(c, indexType) + ']',
              objectText,
            ]);
          else if ((indexType.flags & TypeFlags.UniqueESSymbol) !== 0)
            head = createDiagnosticForNode(accessExpression, Diagnostics.Property_0_does_not_exist_on_type_1, [
              '[' + getFullyQualifiedName(c, indexType.symbol!, accessExpression) + ']',
              objectText,
            ]);
          else if ((indexType.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) !== 0)
            head = createDiagnosticForNode(accessExpression, Diagnostics.Property_0_does_not_exist_on_type_1, [
              getPropertyNameFromType(indexType),
              objectText,
            ]);
          else if ((indexType.flags & (TypeFlags.Number | TypeFlags.String)) !== 0)
            head = createDiagnosticForNode(
              accessExpression,
              Diagnostics.No_index_signature_with_a_parameter_of_type_0_was_found_on_type_1,
              [typeToString(c, indexType), objectText],
            );
          const diagnostic = createDiagnosticForNode(
            accessExpression,
            Diagnostics.Element_implicitly_has_an_any_type_because_expression_of_type_0_can_t_be_used_to_index_type_1,
            [typeToString(c, fullIndexType), objectText],
          );
          if (head !== undefined) diagnostic.addMessageChain(head);
          c.addDiagnostic(diagnostic);
        }
      }
      return undefined;
    }
  }
  if ((accessFlags & AccessFlags.AllowMissing) !== 0 && isObjectLiteralType(objectType)) return c.undefinedType;
  if (isJSLiteralType(c, objectType)) return c.anyType;
  if (accessNode !== undefined) {
    const indexNode = getIndexNodeForAccessExpression(accessNode);
    if (
      indexNode.kind !== SyntaxKind.BigIntLiteral &&
      (indexType.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) !== 0
    )
      c.error(
        indexNode,
        Diagnostics.Property_0_does_not_exist_on_type_1,
        getPropertyNameFromType(indexType),
        typeToString(c, objectType),
      );
    else if ((indexType.flags & (TypeFlags.String | TypeFlags.Number)) !== 0)
      c.error(
        indexNode,
        Diagnostics.Type_0_has_no_matching_index_signature_for_type_1,
        typeToString(c, objectType),
        typeToString(c, indexType),
      );
    else
      c.error(
        indexNode,
        Diagnostics.Type_0_cannot_be_used_as_an_index_type,
        indexNode.kind === SyntaxKind.BigIntLiteral ? 'bigint' : typeToString(c, indexType),
      );
  }
  if ((indexType.flags & TypeFlags.Any) !== 0) return indexType;
  return undefined;
}

function errorIfWritingToReadonlyIndex(
  c: Checker,
  indexInfo: IndexInfo | undefined,
  objectType: Type,
  accessExpression: Node | undefined,
): void {
  if (
    indexInfo !== undefined &&
    indexInfo.isReadonly &&
    accessExpression !== undefined &&
    (isAssignmentTarget(accessExpression) || isDeleteTarget(accessExpression))
  )
    c.error(accessExpression, Diagnostics.Index_signature_in_type_0_only_permits_reading, typeToString(c, objectType));
}

/** `obj.get` or `obj.set` for keyed access to a type with such methods instead of an index signature. */
function getSuggestionForNonexistentIndexSignature(c: Checker, objectType: Type, expr: Node, keyedType: Type): string {
  const suggestedMethod = isAssignmentTarget(expr) ? 'set' : 'get';
  const prop = getPropertyOfObjectType(c, objectType, suggestedMethod);
  if (prop === undefined) return '';
  const signature = getSingleCallSignature(c, getTypeOfSymbol(c, prop));
  if (
    signature === undefined ||
    getMinArgumentCount(c, signature) < 1 ||
    !isTypeAssignableTo(c, keyedType, getTypeAtPosition(c, signature, 0))
  )
    return '';
  const target = getExpression(expr)!;
  if (target.kind === SyntaxKind.Identifier) return getText(target) + '.' + suggestedMethod;
  if (target.kind === SyntaxKind.PropertyAccessExpression && isEntityNameExpression(target, false))
    return getTextOfNodeFromSourceText(getSourceFileOfNode(target).text, target) + '.' + suggestedMethod;
  return suggestedMethod;
}

function isObjectLiteralType(t: Type): boolean {
  return (t.objectFlags & ObjectFlags.ObjectLiteral) !== 0;
}

function isConstEnumObjectType(t: Type): boolean {
  return (
    (t.objectFlags & ObjectFlags.Anonymous) !== 0 &&
    t.symbol !== undefined &&
    (t.symbol.flags & SymbolFlags.ConstEnum) !== 0
  );
}

function containsMissing(c: Checker, t: Type): boolean {
  return t === c.missingType || ((t.flags & TypeFlags.Union) !== 0 && typesOf(t)[0]! === c.missingType);
}

function getIndexNodeForAccessExpression(accessNode: Node): Node {
  if (accessNode.kind === SyntaxKind.ElementAccessExpression)
    return (accessNode as ElementAccessExpression).argumentExpression;
  if (accessNode.kind === SyntaxKind.IndexedAccessType) return (accessNode as IndexedAccessTypeNode).indexType;
  if (accessNode.kind === SyntaxKind.ComputedPropertyName) return getExpression(accessNode)!;
  return accessNode;
}

export function getTupleElementTypeOutOfStartCount(
  c: Checker,
  t: Type,
  index: number,
  undefinedLikeType: Type | undefined,
): Type {
  return mapType(c, t, (u) => {
    const restType = getRestTypeOfTupleType(c, u);
    if (restType === undefined) return c.undefinedType;
    if (undefinedLikeType !== undefined && index >= getTotalFixedElementCount(tupleTargetOf(u)))
      return getUnionType(c, [restType, undefinedLikeType]);
    return restType;
  });
}

export function getRestTypeOfTupleType(c: Checker, t: Type): Type | undefined {
  return getElementTypeOfSliceOfTupleType(c, t, tupleTargetOf(t).fixedLength, 0, false, false);
}

export function getElementTypeOfSliceOfTupleType(
  c: Checker,
  t: Type,
  index: number,
  endSkipCount: number,
  writing: boolean,
  noReductions: boolean,
): Type | undefined {
  const length = tupleTargetOf(t).typeParameterCount() - endSkipCount;
  const infos = tupleTargetOf(t).elementInfos;
  if (index >= length) return undefined;
  const typeArguments = getTypeArguments(c, t);
  const elementTypes: Type[] = [];
  for (let i = index; i < length; i++) {
    const e = typeArguments[i]!;
    elementTypes.push((infos[i]!.flags & ElementFlags.Variadic) !== 0 ? getIndexedAccessType(c, e, c.numberType) : e);
  }
  if (writing) return getIntersectionType(c, elementTypes);
  return getUnionTypeEx(
    c,
    elementTypes,
    noReductions ? UnionReduction.None : UnionReduction.Literal,
    undefined,
    undefined,
  );
}

export function getConstraintOfIndexedAccess(c: Checker, t: IndexedAccessType): Type | undefined {
  return hasNonCircularBaseConstraint(c, t) ? getConstraintFromIndexedAccess(c, t) : undefined;
}

function getConstraintFromIndexedAccess(c: Checker, t: IndexedAccessType): Type | undefined {
  if (isMappedTypeGenericIndexedAccess(c, t))
    return substituteIndexedMappedType(c, t.objectType as MappedType, t.indexType);
  const indexConstraint = getSimplifiedTypeOrConstraint(c, t.indexType);
  if (indexConstraint !== undefined && indexConstraint !== t.indexType) {
    const indexed = getIndexedAccessTypeOrUndefined(c, t.objectType, indexConstraint, t.accessFlags);
    if (indexed !== undefined) return indexed;
  }
  const objectConstraint = getSimplifiedTypeOrConstraint(c, t.objectType);
  if (objectConstraint !== undefined && objectConstraint !== t.objectType)
    return getIndexedAccessTypeOrUndefined(c, objectConstraint, t.indexType, t.accessFlags);
  return undefined;
}

function getSimplifiedTypeOrConstraint(c: Checker, t: Type): Type | undefined {
  const simplified = getSimplifiedType(c, t, false);
  return simplified !== t ? simplified : getConstraintOfTypeLocal(c, t);
}

function getConstraintOfTypeLocal(c: Checker, t: Type): Type | undefined {
  if ((t.flags & TypeFlags.TypeParameter) !== 0) return getConstraintOfTypeParameter(c, t);
  if ((t.flags & TypeFlags.IndexedAccess) !== 0) return getConstraintOfIndexedAccess(c, t as IndexedAccessType);
  if ((t.flags & TypeFlags.Conditional) !== 0) return getConstraintOfConditionalType(c, t);
  return getBaseConstraintOfType(c, t);
}

export function isMappedTypeGenericIndexedAccess(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.IndexedAccess) === 0) return false;
  const objectType = (t as IndexedAccessType).objectType;
  return (
    (objectType.objectFlags & ObjectFlags.Mapped) !== 0 &&
    !isGenericMappedType(c, objectType) &&
    isGenericIndexType(c, (t as IndexedAccessType).indexType) &&
    (getMappedTypeModifiers(objectType as MappedType) & MappedTypeModifiers.ExcludeOptional) === 0 &&
    mappedNameTypeNode(objectType as MappedType) === undefined
  );
}

/** For `{ [P in K]: E }[X]`, E with P replaced by X. */
export function substituteIndexedMappedType(c: Checker, objectType: MappedType, index: Type): Type {
  const mapper = newTypeMapper([getTypeParameterFromMappedType(c, objectType)], [index]);
  const templateMapper = combineTypeMappers(c, objectType.mapper, mapper);
  const instantiatedTemplateType = instantiateType(
    c,
    getTemplateTypeFromMappedType(c, mappedTypeTarget(objectType)),
    templateMapper,
  );
  let isOptional = getMappedTypeOptionality(objectType) > 0;
  if (!isOptional)
    isOptional = isGenericType(c, objectType)
      ? getCombinedMappedTypeOptionality(c, getModifiersTypeFromMappedType(c, objectType)) > 0
      : couldAccessOptionalProperty(c, objectType, index);
  return addOptionality(c, instantiatedTemplateType, true, isOptional);
}

/** The optionality modifiers of a mapped type or its modifiers type, or of all the types of an intersection. */
export function getCombinedMappedTypeOptionality(c: Checker, t: Type): number {
  if ((t.objectFlags & ObjectFlags.Mapped) !== 0) {
    const optionality = getMappedTypeOptionality(t as MappedType);
    return optionality !== 0
      ? optionality
      : getCombinedMappedTypeOptionality(c, getModifiersTypeFromMappedType(c, t as MappedType));
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    const types = typesOf(t);
    const optionality = getCombinedMappedTypeOptionality(c, types[0]!);
    for (let i = 1; i < types.length; i++) if (getCombinedMappedTypeOptionality(c, types[i]!) !== optionality) return 0;
    return optionality;
  }
  return 0;
}

/** Whether an indexed access with the given object and index types could access an optional property. */
function couldAccessOptionalProperty(c: Checker, objectType: Type, indexType: Type): boolean {
  const indexConstraint = getBaseConstraintOfType(c, indexType);
  if (indexConstraint === undefined) return false;
  for (const p of getPropertiesOfType(c, objectType))
    if (
      (p.flags & SymbolFlags.Optional) !== 0 &&
      isTypeAssignableTo(
        c,
        getLiteralTypeFromProperty(c, p, TypeFlags.StringOrNumberLiteralOrUnique, false),
        indexConstraint,
      )
    )
      return true;
  return false;
}

// ---- Simplification

export function getSimplifiedType(c: Checker, t: Type, writing: boolean): Type {
  if ((t.flags & TypeFlags.IndexedAccess) !== 0)
    return getSimplifiedIndexedAccessType(c, t as IndexedAccessType, writing);
  if ((t.flags & TypeFlags.Conditional) !== 0) return getSimplifiedConditionalType(c, t as ConditionalType, writing);
  if ((t.flags & TypeFlags.Index) !== 0) return getSimplifiedIndexType(c, t as IndexType);
  return t;
}

/** Simplifies `keyof` a generic mapped type with an `as` clause to the type of the keys it produces. */
function getSimplifiedIndexType(c: Checker, t: IndexType): Type {
  const target = t.target;
  if (
    isGenericMappedType(c, target) &&
    getNameTypeFromMappedType(c, target as MappedType) !== undefined &&
    !isMappedTypeWithKeyofConstraintDeclaration(c, target as MappedType)
  )
    return getIndexForMappedType(c, target as MappedType, IndexFlags.None);
  return t;
}

/** Simplifies `T extends U ? T : never` and `T extends U ? never : T` when the outcome is known. */
function getSimplifiedConditionalType(c: Checker, t: ConditionalType, writing: boolean): Type {
  const key = cachedTypeKey(
    writing ? CachedTypeKind.SimplifiedConditionalForWriting : CachedTypeKind.SimplifiedConditionalForReading,
    t.id,
  );
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return cached;
  const result = getSimplifiedConditionalTypeWorker(c, t, writing);
  c.cachedTypesById.set(key, result);
  return result;
}

function getSimplifiedConditionalTypeWorker(c: Checker, t: ConditionalType, writing: boolean): Type {
  const checkType = t.checkType;
  const extendsType = t.extendsType;
  const trueType = getTrueTypeFromConditionalType(c, t);
  const falseType = getFalseTypeFromConditionalType(c, t);
  if (
    (falseType.flags & TypeFlags.Never) !== 0 &&
    getActualTypeVariable(c, trueType) === getActualTypeVariable(c, checkType)
  ) {
    if (
      (checkType.flags & TypeFlags.Any) !== 0 ||
      isTypeAssignableTo(c, getRestrictiveInstantiation(c, checkType), getRestrictiveInstantiation(c, extendsType))
    )
      return getSimplifiedType(c, trueType, writing);
    if (isIntersectionEmpty(c, checkType, extendsType)) return c.neverType;
  } else if (
    (trueType.flags & TypeFlags.Never) !== 0 &&
    getActualTypeVariable(c, falseType) === getActualTypeVariable(c, checkType)
  ) {
    if (
      (checkType.flags & TypeFlags.Any) === 0 &&
      isTypeAssignableTo(c, getRestrictiveInstantiation(c, checkType), getRestrictiveInstantiation(c, extendsType))
    )
      return c.neverType;
    if ((checkType.flags & TypeFlags.Any) !== 0 || isIntersectionEmpty(c, checkType, extendsType))
      return getSimplifiedType(c, falseType, writing);
  }
  return t;
}

/** Whether the intersection of two types reduces to `never` as a union constituent. */
function isIntersectionEmpty(c: Checker, type1: Type, type2: Type): boolean {
  return (getUnionType(c, [intersectTypes(c, type1, type2)!, c.neverType]).flags & TypeFlags.Never) !== 0;
}

function getSimplifiedIndexedAccessType(c: Checker, t: IndexedAccessType, writing: boolean): Type {
  const key = cachedTypeKey(
    writing ? CachedTypeKind.IndexedAccessForWriting : CachedTypeKind.IndexedAccessForReading,
    t.id,
  );
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return cached === c.circularConstraintType ? t : cached;
  const self: Type = t;
  c.cachedTypesById.set(key, self);
  const objectType = getSimplifiedType(c, t.objectType, writing);
  const indexType = getSimplifiedType(c, t.indexType, writing);
  let result: Type = t;
  if ((indexType.flags & TypeFlags.Union) !== 0) {
    // T[A | B] -> T[A] | T[B] (reading), T[A] & T[B] (writing).
    const types: Type[] = [];
    for (const u of typesOf(indexType))
      types.push(getSimplifiedType(c, getIndexedAccessType(c, objectType, u), writing));
    result = writing ? getIntersectionType(c, types) : getUnionType(c, types);
  } else if (
    // Inner distributions only once the index can't be instantiated to distribute again:
    // (T | U)[K] -> T[K] | U[K] (reading), T[K] & U[K] (writing); (T & U)[K] -> T[K] & U[K].
    (indexType.flags & TypeFlags.Instantiable) === 0 &&
    ((objectType.flags & TypeFlags.Union) !== 0 ||
      ((objectType.flags & TypeFlags.Intersection) !== 0 && !shouldDeferIndexType(c, objectType, IndexFlags.None)))
  ) {
    const types: Type[] = [];
    for (const u of typesOf(objectType))
      types.push(getSimplifiedType(c, getIndexedAccessType(c, u, indexType), writing));
    result =
      (objectType.flags & TypeFlags.Intersection) !== 0 || writing
        ? getIntersectionType(c, types)
        : getUnionType(c, types);
  } else if (isGenericTupleType(objectType) && (indexType.flags & TypeFlags.NumberLike) !== 0) {
    const elementType = getElementTypeOfSliceOfTupleType(
      c,
      objectType,
      (indexType.flags & TypeFlags.Number) !== 0 ? 0 : tupleTargetOf(objectType).fixedLength,
      0,
      writing,
      false,
    );
    if (elementType !== undefined) result = elementType;
  } else if (isGenericMappedType(c, objectType)) {
    // { [P in K]: E }[X] -> E with X for P, unless the mapped type remaps its keys.
    if (getMappedTypeNameTypeKind(c, objectType as MappedType) !== MappedTypeNameTypeKind.Remapping)
      result = mapType(c, substituteIndexedMappedType(c, objectType as MappedType, t.indexType), (u) =>
        getSimplifiedType(c, u, writing),
      );
  }
  if (result.id !== t.id) {
    const self: Type = t;
    result = filterType(c, result, (u) => u.id !== self.id);
    c.cachedTypesById.set(key, result);
  }
  return result;
}

// ---- Substitution and NoInfer

export function isNoInferType(c: Checker, t: Type): boolean {
  // NoInfer<T> is a substitution type with an `unknown` constraint.
  return (
    (t.flags & TypeFlags.Substitution) !== 0 && ((t as SubstitutionType).constraint.flags & TypeFlags.Unknown) !== 0
  );
}

export function getNoInferType(c: Checker, t: Type): Type {
  return isNoInferTargetType(c, t) ? getOrCreateSubstitutionType(c, t, c.unknownType) : t;
}

function isNoInferTargetType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) {
    for (const u of typesOf(t)) if (isNoInferTargetType(c, u)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.Substitution) !== 0)
    return !isNoInferType(c, t) && isNoInferTargetType(c, (t as SubstitutionType).baseType);
  if ((t.flags & TypeFlags.Object) !== 0) return !isEmptyAnonymousObjectType(c, t);
  return (t.flags & (TypeFlags.Instantiable & ~TypeFlags.Substitution)) !== 0 && !isPatternLiteralType(c, t);
}

export function getSubstitutionType(c: Checker, baseType: Type, constraint: Type): Type {
  if (
    (constraint.flags & TypeFlags.AnyOrUnknown) !== 0 ||
    constraint === baseType ||
    (baseType.flags & TypeFlags.Any) !== 0
  )
    return baseType;
  return getOrCreateSubstitutionType(c, baseType, constraint);
}

function getOrCreateSubstitutionType(c: Checker, baseType: Type, constraint: Type): Type {
  const key = baseType.id + '>' + constraint.id;
  let t = c.substitutionTypes.get(key);
  if (t === undefined) {
    t = newSubstitutionType(c, baseType, constraint);
    c.substitutionTypes.set(key, t);
  }
  return t;
}

export function getSubstitutionIntersection(c: Checker, t: Type): Type {
  const s = t as SubstitutionType;
  return isNoInferType(c, t) ? s.baseType : getIntersectionType(c, [s.constraint, s.baseType]);
}

// ---- String mappings

export const enum IntrinsicTypeKind {
  Unknown = 0,
  Uppercase = 1,
  Lowercase = 2,
  Capitalize = 3,
  Uncapitalize = 4,
  NoInfer = 5,
}

export function intrinsicTypeKind(name: string): IntrinsicTypeKind {
  switch (name) {
    case 'Uppercase':
      return IntrinsicTypeKind.Uppercase;
    case 'Lowercase':
      return IntrinsicTypeKind.Lowercase;
    case 'Capitalize':
      return IntrinsicTypeKind.Capitalize;
    case 'Uncapitalize':
      return IntrinsicTypeKind.Uncapitalize;
    case 'NoInfer':
      return IntrinsicTypeKind.NoInfer;
  }
  return IntrinsicTypeKind.Unknown;
}

export function applyStringMapping(symbol: Symbol, s: string): string {
  switch (intrinsicTypeKind(symbol.name)) {
    case IntrinsicTypeKind.Uppercase:
      return s.toUpperCase();
    case IntrinsicTypeKind.Lowercase:
      return s.toLowerCase();
    case IntrinsicTypeKind.Capitalize: {
      const size = s.length > 1 && s.charCodeAt(0) >= 0xd800 && s.charCodeAt(0) <= 0xdbff ? 2 : 1;
      return s.substring(0, size).toUpperCase() + s.substring(size);
    }
    case IntrinsicTypeKind.Uncapitalize: {
      const size = s.length > 1 && s.charCodeAt(0) >= 0xd800 && s.charCodeAt(0) <= 0xdbff ? 2 : 1;
      return s.substring(0, size).toLowerCase() + s.substring(size);
    }
  }
  return s;
}

export function getStringMappingType(c: Checker, symbol: Symbol, t: Type): Type {
  if ((t.flags & (TypeFlags.Union | TypeFlags.Never)) !== 0)
    return mapType(c, t, (u) => getStringMappingType(c, symbol, u));
  if ((t.flags & TypeFlags.StringLiteral) !== 0)
    return getStringLiteralType(c, applyStringMapping(symbol, (t as LiteralType).stringValue));
  if ((t.flags & TypeFlags.TemplateLiteral) !== 0) {
    const template = t as TemplateLiteralType;
    const [texts, types] = applyTemplateStringMapping(c, symbol, template.texts, template.types);
    return getTemplateLiteralType(c, texts, types);
  }
  if ((t.flags & TypeFlags.StringMapping) !== 0 && symbol === t.symbol) return t;
  if ((t.flags & (TypeFlags.Any | TypeFlags.String | TypeFlags.StringMapping)) !== 0 || isGenericIndexType(c, t))
    return getStringMappingTypeForGenericType(c, symbol, t);
  if (isPatternLiteralPlaceholder(c, t))
    return getStringMappingTypeForGenericType(c, symbol, getTemplateLiteralType(c, ['', ''], [t]));
  return t;
}

function isPatternLiteralPlaceholder(c: Checker, t: Type): boolean {
  return (
    (t.flags & (TypeFlags.Any | TypeFlags.String | TypeFlags.Number | TypeFlags.BigInt)) !== 0 ||
    isPatternLiteralType(c, t)
  );
}

function applyTemplateStringMapping(c: Checker, symbol: Symbol, texts: string[], types: Type[]): [string[], Type[]] {
  const kind = intrinsicTypeKind(symbol.name);
  if (kind === IntrinsicTypeKind.Uppercase || kind === IntrinsicTypeKind.Lowercase) {
    const mappedTexts: string[] = [];
    for (const t of texts) mappedTexts.push(applyStringMapping(symbol, t));
    const mappedTypes: Type[] = [];
    for (const t of types) mappedTypes.push(getStringMappingType(c, symbol, t));
    return [mappedTexts, mappedTypes];
  }
  if (kind === IntrinsicTypeKind.Capitalize || kind === IntrinsicTypeKind.Uncapitalize) {
    if (texts[0]! === '') return [texts, [getStringMappingType(c, symbol, types[0]!)].concat(types.slice(1))];
    return [[applyStringMapping(symbol, texts[0]!)].concat(texts.slice(1)), types];
  }
  return [texts, types];
}

function getStringMappingTypeForGenericType(c: Checker, symbol: Symbol, t: Type): Type {
  const key = getSymbolId(symbol) + ',' + t.id;
  let result = c.stringMappingTypes.get(key);
  if (result === undefined) {
    result = new StringMappingType(c.nextTypeId(), symbol, t);
    c.stringMappingTypes.set(key, result);
  }
  return result;
}

// ---- Mapped types

export const enum MappedTypeModifiers {
  IncludeReadonly = 1 << 0,
  ExcludeReadonly = 1 << 1,
  IncludeOptional = 1 << 2,
  ExcludeOptional = 1 << 3,
}

function mappedDeclaration(t: MappedType): MappedTypeNode {
  return t.declaration as MappedTypeNode;
}

function mappedNameTypeNode(t: MappedType): Node | undefined {
  return mappedDeclaration(t).nameType;
}

export function getMappedTypeModifiers(t: MappedType): MappedTypeModifiers {
  const declaration = mappedDeclaration(t);
  let modifiers = 0;
  if (declaration.readonlyToken !== undefined)
    modifiers |=
      declaration.readonlyToken.kind === SyntaxKind.MinusToken
        ? MappedTypeModifiers.ExcludeReadonly
        : MappedTypeModifiers.IncludeReadonly;
  if (declaration.questionToken !== undefined)
    modifiers |=
      declaration.questionToken.kind === SyntaxKind.MinusToken
        ? MappedTypeModifiers.ExcludeOptional
        : MappedTypeModifiers.IncludeOptional;
  return modifiers;
}

export function getMappedTypeOptionality(t: MappedType): number {
  const modifiers = getMappedTypeModifiers(t);
  if ((modifiers & MappedTypeModifiers.ExcludeOptional) !== 0) return -1;
  if ((modifiers & MappedTypeModifiers.IncludeOptional) !== 0) return 1;
  return 0;
}

export function getTypeFromMappedTypeNode(c: Checker, node: Node): Type {
  if (c.resolvedTypes.get(node.id) === undefined) {
    const t = newObjectType(c, ObjectFlags.Mapped, getSymbol(node)) as MappedType;
    t.declaration = node;
    t.alias = getAliasForTypeNode(c, node);
    c.resolvedTypes.set(node.id, t);
    // Resolve the constraint eagerly to report circular aliases.
    getConstraintTypeFromMappedType(c, t);
  }
  return c.resolvedTypes.get(node.id)!;
}

export function getTypeParameterFromMappedType(c: Checker, t: MappedType): TypeParameter {
  // Instantiations have it from creation; a declared mapped type gets it on first use.
  if (t.typeParameter !== undefined) return t.typeParameter as TypeParameter;
  const side = sideOf(c, t);
  if (side.typeParameter === undefined)
    side.typeParameter = getDeclaredTypeOfTypeParameter(
      c,
      getSymbolOfDeclaration(c, mappedDeclaration(t).typeParameter)!,
    );
  return side.typeParameter as TypeParameter;
}

export function getConstraintTypeFromMappedType(c: Checker, t: MappedType): Type {
  const side = sideOf(c, t);
  if (side.constraintType === undefined)
    side.constraintType = getConstraintOfTypeParameter(c, getTypeParameterFromMappedType(c, t)) ?? c.errorType;
  return side.constraintType;
}

export function getNameTypeFromMappedType(c: Checker, t: MappedType): Type | undefined {
  const side = sideOf(c, t);
  const node = mappedNameTypeNode(t);
  if (node === undefined) return undefined;
  if (side.nameType === undefined) side.nameType = instantiateType(c, getTypeFromTypeNode(c, node), t.mapper);
  return side.nameType;
}

export function getTemplateTypeFromMappedType(c: Checker, t: MappedType): Type {
  const side = sideOf(c, t);
  if (side.templateType === undefined) {
    const typeNode = mappedDeclaration(t).type;
    side.templateType =
      typeNode !== undefined
        ? instantiateType(
            c,
            addOptionality(
              c,
              getTypeFromTypeNode(c, typeNode),
              true,
              (getMappedTypeModifiers(t) & MappedTypeModifiers.IncludeOptional) !== 0,
            ),
            t.mapper,
          )
        : c.errorType;
  }
  return side.templateType;
}

function getConstraintDeclarationForMappedType(t: MappedType): Node | undefined {
  return (mappedDeclaration(t).typeParameter as TypeParameterDeclaration).constraint;
}

export function isMappedTypeWithKeyofConstraintDeclaration(c: Checker, t: MappedType): boolean {
  const constraint = getConstraintDeclarationForMappedType(t);
  return (
    constraint !== undefined &&
    constraint.kind === SyntaxKind.TypeOperator &&
    (constraint as TypeOperatorNode).operator === SyntaxKind.KeyOfKeyword
  );
}

export function getModifiersTypeFromMappedType(c: Checker, t: MappedType): Type {
  const side = sideOf(c, t);
  if (side.modifiersType === undefined) {
    if (isMappedTypeWithKeyofConstraintDeclaration(c, t)) {
      // For `keyof T`, the modifiers type is T, read from the node since `keyof` of a concrete T resolves eagerly.
      side.modifiersType = instantiateType(
        c,
        getTypeFromTypeNode(c, getType(getConstraintDeclarationForMappedType(t)!)!),
        t.mapper,
      );
    } else {
      const declaredType = getTypeFromMappedTypeNode(c, t.declaration!) as MappedType;
      const constraint = getConstraintTypeFromMappedType(c, declaredType);
      const extended =
        (constraint.flags & TypeFlags.TypeParameter) !== 0
          ? getConstraintOfTypeParameter(c, getNonDistributedTypeParameter(constraint))
          : constraint;
      side.modifiersType =
        extended !== undefined && (extended.flags & TypeFlags.Index) !== 0
          ? instantiateType(c, (extended as IndexType).target, t.mapper)
          : c.unknownType;
    }
  }
  return side.modifiersType;
}

export function getHomomorphicTypeVariable(c: Checker, t: MappedType): TypeParameter | undefined {
  const constraintType = getConstraintTypeFromMappedType(c, t);
  if ((constraintType.flags & TypeFlags.Index) !== 0) {
    const typeVariable = getActualTypeVariable(c, (constraintType as IndexType).target);
    if ((typeVariable.flags & TypeFlags.TypeParameter) !== 0) return typeVariable as TypeParameter;
  }
  return undefined;
}

export function getActualTypeVariable(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Substitution) !== 0) return getActualTypeVariable(c, (t as SubstitutionType).baseType);
  if ((t.flags & TypeFlags.IndexedAccess) !== 0) {
    const access = t as IndexedAccessType;
    const objectType = getActualTypeVariable(c, access.objectType);
    const indexType = getActualTypeVariable(c, access.indexType);
    if (objectType !== access.objectType || indexType !== access.indexType)
      return getIndexedAccessType(c, objectType, indexType);
  }
  return getNonDistributedTypeParameter(t);
}

export const enum MappedTypeNameTypeKind {
  None = 0,
  Filtering = 1,
  Remapping = 2,
}

export function getMappedTypeNameTypeKind(c: Checker, t: MappedType): MappedTypeNameTypeKind {
  const nameType = getNameTypeFromMappedType(c, t);
  if (nameType === undefined) return MappedTypeNameTypeKind.None;
  return isTypeAssignableTo(c, nameType, getTypeParameterFromMappedType(c, t))
    ? MappedTypeNameTypeKind.Filtering
    : MappedTypeNameTypeKind.Remapping;
}

export function resolveMappedTypeMembers(c: Checker, t: MappedType): void {
  const members = new Map<string, Symbol>();
  let indexInfos: IndexInfo[] = [];
  // Recursive references see an empty object type.
  setStructuredTypeMembers(c, t, undefined, [], [], []);
  const typeParameter = getTypeParameterFromMappedType(c, t);
  const constraintType = getConstraintTypeFromMappedType(c, t);
  const mappedType = mappedTypeTarget(t);
  const nameType = getNameTypeFromMappedType(c, mappedType);
  const shouldLinkPropDeclarations = getMappedTypeNameTypeKind(c, mappedType) !== MappedTypeNameTypeKind.Remapping;
  const templateType = getTemplateTypeFromMappedType(c, mappedType);
  const modifiersType = getApparentType(c, getModifiersTypeFromMappedType(c, t));
  const templateModifiers = getMappedTypeModifiers(t);
  const addForPropName = (keyType: Type, propNameType: Type): void => {
    if (isTypeUsableAsPropertyName(propNameType)) {
      const propName = getPropertyNameFromType(propNameType);
      const existing = members.get(propName);
      if (existing !== undefined) {
        // Same-valued string enum members from different enums share a property.
        const id = getSymbolId(existing);
        c.symbolNameTypes.set(id, getUnionType(c, [c.symbolNameTypes.get(id)!, propNameType]));
        c.symbolKeyTypes.set(id, getUnionType(c, [c.symbolKeyTypes.get(id)!, keyType]));
        return;
      }
      const modifiersProp = isTypeUsableAsPropertyName(keyType)
        ? getPropertyOfType(c, modifiersType, getPropertyNameFromType(keyType))
        : undefined;
      const isOptional =
        (templateModifiers & MappedTypeModifiers.IncludeOptional) !== 0 ||
        ((templateModifiers & MappedTypeModifiers.ExcludeOptional) === 0 &&
          modifiersProp !== undefined &&
          (modifiersProp.flags & SymbolFlags.Optional) !== 0);
      const isReadonly =
        (templateModifiers & MappedTypeModifiers.IncludeReadonly) !== 0 ||
        ((templateModifiers & MappedTypeModifiers.ExcludeReadonly) === 0 &&
          modifiersProp !== undefined &&
          isReadonlySymbol(c, modifiersProp));
      const stripOptional =
        c.strictNullChecks &&
        !isOptional &&
        modifiersProp !== undefined &&
        (modifiersProp.flags & SymbolFlags.Optional) !== 0;
      const lateFlag = modifiersProp !== undefined ? modifiersProp.checkFlags & CheckFlags.Late : 0;
      const prop = c.newSymbol(SymbolFlags.Property | (isOptional ? SymbolFlags.Optional : 0), propName);
      prop.checkFlags =
        lateFlag |
        CheckFlags.Mapped |
        (isReadonly ? CheckFlags.Readonly : 0) |
        (stripOptional ? CheckFlags.StripOptional : 0);
      const symbolId = getSymbolId(prop);
      c.symbolContainingTypes.set(symbolId, t);
      c.symbolNameTypes.set(symbolId, propNameType);
      c.symbolKeyTypes.set(symbolId, keyType);
      if (modifiersProp !== undefined) {
        c.symbolSyntheticOrigins.set(symbolId, modifiersProp);
        if (shouldLinkPropDeclarations) copyDeclarations(prop, modifiersProp);
      }
      members.set(propName, prop);
    } else if (isValidIndexKeyType(c, propNameType) || (propNameType.flags & (TypeFlags.Any | TypeFlags.Enum)) !== 0) {
      const indexKeyType =
        (propNameType.flags & (TypeFlags.Any | TypeFlags.String)) !== 0
          ? c.stringType
          : (propNameType.flags & (TypeFlags.Number | TypeFlags.Enum)) !== 0
            ? c.numberType
            : propNameType;
      const propType = instantiateType(c, templateType, appendTypeMapping(t.mapper, typeParameter, keyType));
      const modifiersIndexInfo = getApplicableIndexInfo(c, modifiersType, propNameType);
      const isReadonly =
        (templateModifiers & MappedTypeModifiers.IncludeReadonly) !== 0 ||
        ((templateModifiers & MappedTypeModifiers.ExcludeReadonly) === 0 &&
          modifiersIndexInfo !== undefined &&
          modifiersIndexInfo.isReadonly);
      indexInfos = appendIndexInfo(
        c,
        indexInfos,
        new IndexInfo(indexKeyType, propType, isReadonly, undefined, []),
        true,
      );
    }
  };
  const add = (keyType: Type): void => {
    const propNameType =
      nameType !== undefined
        ? instantiateType(c, nameType, appendTypeMapping(t.mapper, typeParameter, keyType))
        : keyType;
    forEachType(propNameType, (u) => addForPropName(keyType, u));
  };
  if (isMappedTypeWithKeyofConstraintDeclaration(c, t))
    forEachMappedTypePropertyKeyTypeAndIndexSignatureKeyType(
      c,
      modifiersType,
      TypeFlags.StringOrNumberLiteralOrUnique,
      false,
      add,
    );
  else forEachType(getLowerBoundOfKeyType(c, constraintType), add);
  setStructuredTypeMembers(c, t, members, [], [], indexInfos);
  keepPropertiesOnly(c, t, members);
}

export function getTypeOfMappedSymbol(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  const cached = c.symbolTypes.get(id);
  if (cached !== undefined) return cached;
  const mappedType = c.symbolContainingTypes.get(id) as MappedType;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) {
    sideOf(c, mappedType).containsError = true;
    return c.errorType;
  }
  const templateType = getTemplateTypeFromMappedType(c, mappedTypeTarget(mappedType));
  const mapper = appendTypeMapping(
    mappedType.mapper,
    getTypeParameterFromMappedType(c, mappedType),
    c.symbolKeyTypes.get(id)!,
  );
  let propType = instantiateType(c, templateType, mapper);
  // Optional properties get `undefined`; stripped optionality removes it.
  if (
    c.strictNullChecks &&
    (symbol.flags & SymbolFlags.Optional) !== 0 &&
    !maybeTypeOfKind(propType, TypeFlags.Undefined | TypeFlags.Void)
  )
    propType = getOptionalType(c, propType, true);
  else if ((symbol.checkFlags & CheckFlags.StripOptional) !== 0) propType = removeMissingOrUndefinedType(c, propType);
  if (popTypeResolution(c)) {
    if (c.symbolTypes.get(id) === undefined) c.symbolTypes.set(id, propType);
  } else {
    if (c.symbolTypes.get(id) === undefined) c.symbolTypes.set(id, c.errorType);
    c.error(
      c.currentNode,
      Diagnostics.Type_of_property_0_circularly_references_itself_in_mapped_type_1,
      symbolToString(c, symbol),
      typeToString(c, mappedType),
    );
  }
  return c.symbolTypes.get(id)!;
}

function everyArrayOrTupleType(c: Checker, types: Type[]): boolean {
  for (const t of types) if (!isArrayType(c, t) && !isTupleType(t)) return false;
  return true;
}

/** Instantiates homomorphic mapped type `t` for each constituent its type variable becomes. */
function homomorphicMappedTypeInstantiator(
  c: Checker,
  t: MappedType,
  typeVariable: Type,
  mapper: TypeMapper,
): (s: Type) => Type {
  const instantiateConstituent = (s: Type): Type => {
    if (
      (s.flags &
        (TypeFlags.AnyOrUnknown | TypeFlags.InstantiableNonPrimitive | TypeFlags.Object | TypeFlags.Intersection)) ===
        0 ||
      s === c.wildcardType ||
      isErrorType(c, s)
    )
      return s;
    if (mappedNameTypeNode(t) === undefined) {
      if (
        isArrayType(c, s) ||
        ((s.flags & TypeFlags.Any) !== 0 &&
          findResolutionCycleStartIndex(c, typeVariable, TypeSystemPropertyName.ResolvedBaseConstraint) < 0 &&
          hasArrayOrTupleConstraint(c, typeVariable))
      )
        return instantiateMappedArrayType(c, s, t, prependTypeMapping(typeVariable, s, mapper));
      if (isTupleType(s)) return instantiateMappedTupleType(c, s, t, typeVariable, mapper);
      if ((s.flags & TypeFlags.Intersection) !== 0 && everyArrayOrTupleType(c, typesOf(s))) {
        const types: Type[] = [];
        for (const u of typesOf(s)) types.push(instantiateConstituent(u));
        return getIntersectionType(c, types);
      }
    }
    return instantiateAnonymousType(c, t, prependTypeMapping(typeVariable, s, mapper), undefined);
  };
  return instantiateConstituent;
}

export function instantiateMappedType(
  c: Checker,
  t: MappedType,
  mapper: TypeMapper,
  alias: TypeAlias | undefined,
): Type {
  // For homomorphic `{ [P in keyof T]: X }`, the mapping depends on what T becomes.
  const typeVariable = getHomomorphicTypeVariable(c, t);
  if (typeVariable !== undefined) {
    const mappedTypeVariable = instantiateType(c, typeVariable, mapper);
    if (typeVariable.id !== mappedTypeVariable.id)
      return mapTypeWithAlias(
        c,
        getReducedType(c, mappedTypeVariable),
        homomorphicMappedTypeInstantiator(c, t, typeVariable, mapper),
        alias,
      );
  }
  if (instantiateType(c, getConstraintTypeFromMappedType(c, t), mapper) === c.wildcardType) return c.wildcardType;
  return instantiateAnonymousType(c, t, mapper, alias);
}

function hasArrayOrTupleConstraint(c: Checker, typeVariable: Type): boolean {
  const constraint = getConstraintOfTypeParameter(c, typeVariable);
  return constraint !== undefined && everyType(constraint, (u) => isArrayType(c, u) || isTupleType(u));
}

function getModifiedReadonlyState(state: boolean, modifiers: MappedTypeModifiers): boolean {
  if ((modifiers & MappedTypeModifiers.IncludeReadonly) !== 0) return true;
  if ((modifiers & MappedTypeModifiers.ExcludeReadonly) !== 0) return false;
  return state;
}

function instantiateMappedArrayType(c: Checker, arrayType: Type, mappedType: MappedType, mapper: TypeMapper): Type {
  const elementType = instantiateMappedTypeTemplate(c, mappedType, c.numberType, true, mapper);
  if (isErrorType(c, elementType)) return c.errorType;
  return createArrayTypeEx(
    c,
    elementType,
    getModifiedReadonlyState(isReadonlyArrayType(c, arrayType), getMappedTypeModifiers(mappedType)),
  );
}

function instantiateMappedTupleType(
  c: Checker,
  tupleType: Type,
  mappedType: MappedType,
  typeVariable: Type,
  mapper: TypeMapper,
): Type {
  const target = tupleTargetOf(tupleType);
  const infos = target.elementInfos;
  const fixedLength = target.fixedLength;
  const fixedMapper = fixedLength !== 0 ? prependTypeMapping(typeVariable, tupleType, mapper) : mapper;
  const modifiers = getMappedTypeModifiers(mappedType);
  const elementTypes = getElementTypes(c, tupleType);
  const newElementTypes: Type[] = [];
  const newInfos = infos.slice();
  for (let i = 0; i < elementTypes.length; i++) {
    const flags = infos[i]!.flags;
    let mapped: Type;
    if (i < fixedLength)
      mapped = instantiateMappedTypeTemplate(
        c,
        mappedType,
        getStringLiteralType(c, String(i)),
        (flags & ElementFlags.Optional) !== 0,
        fixedMapper,
      );
    else if ((flags & ElementFlags.Variadic) !== 0)
      mapped = instantiateType(c, mappedType, prependTypeMapping(typeVariable, elementTypes[i]!, mapper));
    else
      mapped =
        getElementTypeOfArrayType(
          c,
          instantiateType(
            c,
            mappedType,
            prependTypeMapping(typeVariable, createArrayTypeEx(c, elementTypes[i]!, false), mapper),
          ),
        ) ?? c.unknownType;
    if ((modifiers & MappedTypeModifiers.IncludeOptional) !== 0) {
      if ((flags & ElementFlags.Required) !== 0) newInfos[i] = withFlags(newInfos[i]!, ElementFlags.Optional);
    } else if ((modifiers & MappedTypeModifiers.ExcludeOptional) !== 0) {
      if ((flags & ElementFlags.Optional) !== 0) newInfos[i] = withFlags(newInfos[i]!, ElementFlags.Required);
    }
    newElementTypes.push(mapped);
  }
  if (newElementTypes.includes(c.errorType)) return c.errorType;
  return createTupleTypeEx(c, newElementTypes, newInfos, getModifiedReadonlyState(target.readonly, modifiers));
}

import { TupleElementInfo } from './checker-types.js';
import { createDiagnosticForNode } from './checker.js';
import { isJSLiteralType, isThisPropertyAccessInConstructor } from './checker-javascript.js';

function withFlags(info: TupleElementInfo, flags: ElementFlags): TupleElementInfo {
  return new TupleElementInfo(flags, info.labeledDeclaration);
}

function instantiateMappedTypeTemplate(
  c: Checker,
  t: MappedType,
  key: Type,
  isOptional: boolean,
  mapper: TypeMapper,
): Type {
  const templateMapper = appendTypeMapping(mapper, getTypeParameterFromMappedType(c, t), key);
  const propType = instantiateType(c, getTemplateTypeFromMappedType(c, mappedTypeTarget(t)), templateMapper);
  const modifiers = getMappedTypeModifiers(t);
  if (
    c.strictNullChecks &&
    (modifiers & MappedTypeModifiers.IncludeOptional) !== 0 &&
    !maybeTypeOfKind(propType, TypeFlags.Undefined | TypeFlags.Void)
  )
    return getOptionalType(c, propType, true);
  if (c.strictNullChecks && (modifiers & MappedTypeModifiers.ExcludeOptional) !== 0 && isOptional)
    return removeMissingOrUndefinedType(c, propType);
  return propType;
}

export function instantiateReverseMappedType(c: Checker, t: Type, mapper: TypeMapper): Type {
  return instantiateReverseMappedTypeOfInference(c, t as ReverseMappedType, mapper);
}

export function resolveReverseMappedTypeMembers(c: Checker, t: Type): void {
  resolveReverseMappedTypeMembersOfInference(c, t as ReverseMappedType);
}

// ---- Conditional types

export function getTypeFromConditionalTypeNode(c: Checker, node: Node): Type {
  if (c.resolvedTypes.get(node.id) === undefined) {
    const shape = node as ConditionalTypeNode;
    const checkType = getTypeFromTypeNode(c, shape.checkType);
    const alias = getAliasForTypeNode(c, node);
    const all = getOuterTypeParameters(c, node, true);
    let outerTypeParameters = all;
    if (alias === undefined || alias.typeArguments.length === 0) {
      outerTypeParameters = [];
      for (const tp of all) if (isTypeParameterPossiblyReferenced(c, tp, node)) outerTypeParameters.push(tp);
    }
    const root = new ConditionalRoot(
      node,
      checkType,
      getTypeFromTypeNode(c, shape.extendsType),
      (checkType.flags & TypeFlags.TypeParameter) !== 0,
      getInferTypeParameters(c, node),
      outerTypeParameters,
      alias,
    );
    const resolved = getConditionalType(c, root, undefined, false, undefined);
    c.resolvedTypes.set(node.id, resolved);
    root.instantiations.set(
      typeListHash(outerTypeParameters, undefined, 0),
      outerTypeParameters,
      undefined,
      0,
      resolved,
    );
  }
  return c.resolvedTypes.get(node.id)!;
}

function conditionalNode(root: ConditionalRoot): ConditionalTypeNode {
  return root.node as ConditionalTypeNode;
}

export function getConditionalTypeInstantiation(
  c: Checker,
  t: ConditionalType,
  mapper: TypeMapper,
  forConstraint: boolean,
  alias: TypeAlias | undefined,
): Type {
  const root = t.root;
  if (root.outerTypeParameters.length === 0) return t;
  const typeArguments: Type[] = [];
  for (const tp of root.outerTypeParameters) typeArguments.push(mapper.map(tp));
  const tag = forConstraint ? 1 : 0;
  const hash = typeListHash(typeArguments, alias, tag);
  let result = root.instantiations.get(hash, typeArguments, alias, tag);
  if (result === undefined) {
    const newMapper = newTypeMapper(root.outerTypeParameters, typeArguments);
    const checkType = root.checkType;
    const distributionType = root.isDistributive ? getReducedType(c, getMappedType(checkType, newMapper)) : undefined;
    // Distributive conditional types distribute over unions.
    if (
      distributionType !== undefined &&
      checkType !== distributionType &&
      (distributionType.flags & (TypeFlags.Union | TypeFlags.Never)) !== 0
    )
      result = mapTypeWithAlias(
        c,
        distributionType,
        (u) => getConditionalType(c, root, prependTypeMapping(checkType, u, newMapper), forConstraint, undefined),
        alias,
      );
    else result = getConditionalType(c, root, newMapper, forConstraint, alias);
    root.instantiations.set(hash, typeArguments, alias, tag, result);
  }
  return result;
}

function skipTypeParentheses(node: Node): Node {
  while (node.kind === SyntaxKind.ParenthesizedType) node = getType(node)!;
  return node;
}

function isSimpleTupleType(node: Node): boolean {
  if (node.kind !== SyntaxKind.TupleType) return false;
  const elements = getElements(node)!.nodes;
  if (elements.length === 0) return false;
  for (const e of elements) {
    if (e.kind === SyntaxKind.OptionalType || e.kind === SyntaxKind.RestType) return false;
    if (
      e.kind === SyntaxKind.NamedTupleMember &&
      (getQuestionToken(e) !== undefined || getDotDotDotToken(e) !== undefined)
    )
      return false;
  }
  return true;
}

function isDeferredType(c: Checker, t: Type, checkTuples: boolean): boolean {
  if (isGenericType(c, t)) return true;
  if (checkTuples && isTupleType(t)) for (const u of getElementTypes(c, t)) if (isGenericType(c, u)) return true;
  return false;
}

export function getPermissiveInstantiation(c: Checker, t: Type): Type {
  if ((t.flags & (TypeFlags.Primitive | TypeFlags.AnyOrUnknown | TypeFlags.Never)) !== 0) return t;
  const key = cachedTypeKey(CachedTypeKind.PermissiveInstantiation, t.id);
  let result = c.cachedTypesById.get(key);
  if (result === undefined) {
    result = instantiateType(c, t, c.permissiveMapper);
    c.cachedTypesById.set(key, result);
  }
  return result;
}

export function getConditionalType(
  c: Checker,
  root: ConditionalRoot,
  mapper: TypeMapper | undefined,
  forConstraint: boolean,
  alias: TypeAlias | undefined,
): Type {
  let result: Type | undefined;
  let extraTypes: Type[] | undefined;
  let tailCount = 0;
  // Loops over nested conditional types in the false branch and tail-recursive resolutions.
  for (;;) {
    if (tailCount === 1000) {
      c.error(c.currentNode, Diagnostics.Type_instantiation_is_excessively_deep_and_possibly_infinite);
      return c.errorType;
    }
    const checkType = instantiateType(c, getActualTypeVariable(c, root.checkType), mapper);
    const extendsType = instantiateType(c, root.extendsType, mapper);
    if (checkType === c.errorType || extendsType === c.errorType) return c.errorType;
    if (checkType === c.wildcardType || extendsType === c.wildcardType) return c.wildcardType;
    const nodes = conditionalNode(root);
    const checkTypeNode = skipTypeParentheses(nodes.checkType);
    const extendsTypeNode = skipTypeParentheses(nodes.extendsType);
    const checkTuples =
      isSimpleTupleType(checkTypeNode) &&
      isSimpleTupleType(extendsTypeNode) &&
      getElements(checkTypeNode)!.nodes.length === getElements(extendsTypeNode)!.nodes.length;
    const checkTypeDeferred = isDeferredType(c, checkType, checkTuples);
    const falseForEveryInference =
      root.inferTypeParameters.length !== 0 &&
      !checkTypeDeferred &&
      !forConstraint &&
      isFalseForEveryInference(c, root, checkType, extendsType);
    let combinedMapper: TypeMapper | undefined;
    if (root.inferTypeParameters.length !== 0 && !falseForEveryInference) {
      const inferenceMapper = inferTypesForConditional(c, root, checkType, extendsType, mapper, checkTypeDeferred);
      if (inferenceMapper === undefined) return c.errorType;
      combinedMapper = mapper !== undefined ? combineTypeMappers(c, inferenceMapper, mapper) : inferenceMapper;
    }
    const inferredExtendsType =
      combinedMapper !== undefined ? instantiateType(c, root.extendsType, combinedMapper) : extendsType;
    if (falseForEveryInference || (!checkTypeDeferred && !isDeferredType(c, inferredExtendsType, checkTuples))) {
      // Definitely false when even permissive instantiations aren't related.
      if (
        falseForEveryInference ||
        ((inferredExtendsType.flags & TypeFlags.AnyOrUnknown) === 0 &&
          ((checkType.flags & TypeFlags.Any) !== 0 ||
            !isTypeAssignableTo(
              c,
              getPermissiveInstantiation(c, checkType),
              getPermissiveInstantiation(c, inferredExtendsType),
            )))
      ) {
        if (
          (checkType.flags & TypeFlags.Any) !== 0 ||
          (forConstraint &&
            (inferredExtendsType.flags & TypeFlags.Never) === 0 &&
            someType(getPermissiveInstantiation(c, inferredExtendsType), (u) =>
              isTypeAssignableTo(c, u, getPermissiveInstantiation(c, checkType)),
            ))
        ) {
          if (extraTypes === undefined) extraTypes = [];
          extraTypes.push(instantiateType(c, getTypeFromTypeNode(c, nodes.trueType), combinedMapper ?? mapper));
        }
        const falseType = getTypeFromTypeNode(c, nodes.falseType);
        if ((falseType.flags & TypeFlags.Conditional) !== 0) {
          const newRoot = (falseType as ConditionalType).root;
          if (newRoot.node.parent === root.node && (!newRoot.isDistributive || newRoot.checkType === root.checkType)) {
            root = newRoot;
            continue;
          }
          const tail = getTailRecursionRoot(c, falseType, mapper);
          if (tail !== undefined) {
            root = tail.root;
            mapper = tail.mapper;
            alias = undefined;
            if (tail.root.alias !== undefined) tailCount++;
            continue;
          }
        }
        result = instantiateType(c, falseType, mapper);
        break;
      }
      // Definitely true when restrictive instantiations are related.
      if (
        (inferredExtendsType.flags & TypeFlags.AnyOrUnknown) !== 0 ||
        isTypeAssignableTo(
          c,
          getRestrictiveInstantiation(c, checkType),
          getRestrictiveInstantiation(c, inferredExtendsType),
        )
      ) {
        const trueType = getTypeFromTypeNode(c, nodes.trueType);
        const trueMapper = combinedMapper ?? mapper;
        const tail = getTailRecursionRoot(c, trueType, trueMapper);
        if (tail !== undefined) {
          root = tail.root;
          mapper = tail.mapper;
          alias = undefined;
          if (tail.root.alias !== undefined) tailCount++;
          continue;
        }
        result = instantiateType(c, trueType, trueMapper);
        break;
      }
    }
    // Neither definitely true nor false: defer.
    const deferred = new ConditionalType(
      c.nextTypeId(),
      root,
      instantiateType(c, root.checkType, mapper),
      instantiateType(c, root.extendsType, mapper),
      mapper,
      combinedMapper,
    );
    deferred.alias = alias ?? (mapper !== undefined ? instantiateTypeAlias(c, root.alias, mapper) : root.alias);
    deferred.checking = c;
    result = deferred;
    break;
  }
  return extraTypes !== undefined ? getUnionType(c, extraTypes.concat([result])) : result;
}

/**
 * Whether the extends check of a conditional type with `infer` type parameters is false for every
 * inference, so that inference can be skipped and the false branch taken as it would be. This is so
 * when the check and extends types are references to the same class or interface, which are related
 * by the variances of its type parameters, and a type argument without `infer` type parameters is a
 * primitive or literal type that doesn't relate to the check type's: relating the type arguments
 * then fails whatever is inferred for the others. The relation doesn't fall back to comparing
 * structure: no variance is unmeasurable or unreliable, and no covariant type argument can be
 * `void` after inference.
 */
function isFalseForEveryInference(c: Checker, root: ConditionalRoot, checkType: Type, extendsType: Type): boolean {
  if (
    (checkType.flags & TypeFlags.Object) === 0 ||
    (extendsType.flags & TypeFlags.Object) === 0 ||
    (checkType.objectFlags & ObjectFlags.Reference) === 0 ||
    (extendsType.objectFlags & ObjectFlags.Reference) === 0
  )
    return false;
  const target = (checkType as TypeReference).target!;
  if (target !== (extendsType as TypeReference).target) return false;
  const args = getReferenceArgs(c, root);
  if (args === null || isMarkerType(c, checkType) || isMarkerType(c, extendsType)) return false;
  const variances = getVariances(c, target);
  if (variances.length === 0) return false;
  for (const v of variances) if ((v & VarianceFlags.AllowsStructuralFallback) !== 0) return false;
  const sourceArgs = getTypeArguments(c, checkType);
  const targetArgs = getTypeArguments(c, extendsType);
  let unrelated = false;
  for (let i = 0; i < args.kinds.length; i++) {
    const kind = args.kinds[i]!;
    const variance = i < variances.length ? variances[i]! & VarianceFlags.VarianceMask : VarianceFlags.Covariant;
    if (variance === VarianceFlags.Covariant) {
      if (kind === ReferenceArgKind.Other) return false;
      if (kind === ReferenceArgKind.Fixed && (targetArgs[i]!.flags & TypeFlags.Void) !== 0) return false;
      // An `infer` type parameter that occurs once infers the check type's type argument, or its
      // constraint if that isn't assignable to it.
      if (kind === ReferenceArgKind.Infer) {
        if (someType(sourceArgs[i]!, (t) => (t.flags & TypeFlags.Void) !== 0)) return false;
        const constraint = getConstraintOfTypeParameter(c, args.inferTypeParameters[i]!);
        if (constraint !== undefined && (constraint.flags & (TypeFlags.Void | TypeFlags.Instantiable)) !== 0)
          return false;
      }
    }
    if (
      !unrelated &&
      kind === ReferenceArgKind.Fixed &&
      variance !== VarianceFlags.Independent &&
      isPrimitiveOrLiteralTypeArgument(sourceArgs[i]!) &&
      isPrimitiveOrLiteralTypeArgument(targetArgs[i]!)
    )
      unrelated = !isTypeArgumentRelated(c, sourceArgs[i]!, targetArgs[i]!, variance);
  }
  return unrelated;
}

/** A primitive or literal type, or a union of them: relating them doesn't relate any structure. */
function isPrimitiveOrLiteralTypeArgument(t: Type): boolean {
  if ((t.flags & TypeFlags.Union) === 0) return (t.flags & TypeFlags.StructuredOrInstantiable) === 0;
  for (const u of typesOf(t)) if ((u.flags & TypeFlags.StructuredOrInstantiable) !== 0) return false;
  return true;
}

/** Whether type arguments relate by `variance`, as when relating references to the same type. */
function isTypeArgumentRelated(c: Checker, s: Type, t: Type, variance: VarianceFlags): boolean {
  switch (variance) {
    case VarianceFlags.Covariant:
      return isTypeAssignableTo(c, s, t);
    case VarianceFlags.Contravariant:
      return isTypeAssignableTo(c, t, s);
    case VarianceFlags.Bivariant:
      return isTypeAssignableTo(c, t, s) || isTypeAssignableTo(c, s, t);
    default:
      return isTypeAssignableTo(c, s, t) && isTypeAssignableTo(c, t, s);
  }
}

function getReferenceArgs(c: Checker, root: ConditionalRoot): ReferenceArgs | null {
  if (root.referenceArgs === undefined) root.referenceArgs = computeReferenceArgs(c, root);
  return root.referenceArgs;
}

function computeReferenceArgs(c: Checker, root: ConditionalRoot): ReferenceArgs | null {
  const declared = root.extendsType;
  if ((declared.objectFlags & ObjectFlags.Reference) === 0 || declared.alias !== undefined || isTupleType(declared))
    return null;
  const target = (declared as TypeReference).target!;
  if (
    target === c.globalArrayType ||
    target === c.globalReadonlyArrayType ||
    target.symbol === undefined ||
    (target.symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) === 0
  )
    return null;
  const node = skipTypeParentheses(conditionalNode(root).extendsType);
  if (node.kind !== SyntaxKind.TypeReference) return null;
  const argNodes = (node as TypeReferenceNode).typeArguments?.nodes ?? [];
  const typeArgs = getTypeArguments(c, declared);
  if (typeArgs.length !== argNodes.length) return null;
  const kinds: ReferenceArgKind[] = [];
  const inferTypeParameters: (Type | undefined)[] = [];
  for (let i = 0; i < argNodes.length; i++) {
    const argNode = argNodes[i]!;
    let kind = ReferenceArgKind.Fixed;
    let inferTypeParameter: Type | undefined;
    for (const tp of root.inferTypeParameters) {
      const declaration = tp.symbol?.declaration;
      if (
        declaration === undefined ||
        isNodeDescendantOf(declaration, argNode) ||
        containsTypeParameterReference(c, tp, argNode)
      ) {
        kind = ReferenceArgKind.Other;
        break;
      }
    }
    if (kind === ReferenceArgKind.Other) {
      const inner = skipTypeParentheses(argNode);
      if (inner.kind === SyntaxKind.InferType) {
        const tp = root.inferTypeParameters.find(
          (t) => t.symbol!.declaration === (inner as InferTypeNode).typeParameter,
        );
        if (tp !== undefined && declarationCount(tp.symbol!) === 1 && !isReferencedInOtherArg(c, tp, argNodes, i)) {
          kind = ReferenceArgKind.Infer;
          inferTypeParameter = tp;
        }
      } else if (isObjectTypeWithObjectInstantiations(typeArgs[i]!)) kind = ReferenceArgKind.Object;
    }
    kinds.push(kind);
    inferTypeParameters.push(inferTypeParameter);
  }
  return new ReferenceArgs(kinds, inferTypeParameters);
}

function isReferencedInOtherArg(c: Checker, tp: Type, argNodes: readonly Node[], index: number): boolean {
  for (let j = 0; j < argNodes.length; j++)
    if (j !== index && containsTypeParameterReference(c, tp, argNodes[j]!)) return true;
  return false;
}

/** References other than tuples and anonymous object types other than mapped types instantiate to object types. */
function isObjectTypeWithObjectInstantiations(t: Type): boolean {
  return (
    (t.flags & TypeFlags.Object) !== 0 &&
    (t.objectFlags & (ObjectFlags.Reference | ObjectFlags.Anonymous)) !== 0 &&
    (t.objectFlags & (ObjectFlags.Mapped | ObjectFlags.ReverseMapped)) === 0 &&
    !isTupleType(t)
  );
}

class TailRoot {
  readonly root: ConditionalRoot;
  readonly mapper: TypeMapper;

  constructor(root: ConditionalRoot, mapper: TypeMapper) {
    this.root = root;
    this.mapper = mapper;
  }
}

function getTailRecursionRoot(c: Checker, newType: Type, newMapper: TypeMapper | undefined): TailRoot | undefined {
  if ((newType.flags & TypeFlags.Conditional) === 0 || newMapper === undefined) return undefined;
  const conditional = newType as ConditionalType;
  const newRoot = conditional.root;
  if (newRoot.outerTypeParameters.length === 0) return undefined;
  const typeParamMapper = combineTypeMappers(c, conditional.mapper, newMapper);
  const typeArguments: Type[] = [];
  for (const t of newRoot.outerTypeParameters) typeArguments.push(typeParamMapper.map(t));
  const newRootMapper = newTypeMapper(newRoot.outerTypeParameters, typeArguments);
  const newCheckType = newRoot.isDistributive ? getMappedType(newRoot.checkType, newRootMapper) : undefined;
  if (
    newCheckType === undefined ||
    newCheckType === newRoot.checkType ||
    (newCheckType.flags & (TypeFlags.Union | TypeFlags.Never)) === 0
  )
    return new TailRoot(newRoot, newRootMapper);
  return undefined;
}

export function getTrueTypeFromConditionalType(c: Checker, t: ConditionalType): Type {
  const side = sideOf(c, t);
  if (side.resolvedTrueType === undefined)
    side.resolvedTrueType = instantiateType(c, getTypeFromTypeNode(c, conditionalNode(t.root).trueType), t.mapper);
  return side.resolvedTrueType;
}

export function getFalseTypeFromConditionalType(c: Checker, t: ConditionalType): Type {
  const side = sideOf(c, t);
  if (side.resolvedFalseType === undefined)
    side.resolvedFalseType = instantiateType(c, getTypeFromTypeNode(c, conditionalNode(t.root).falseType), t.mapper);
  return side.resolvedFalseType;
}

/** `[getTrueTypeFromConditionalType(t), getFalseTypeFromConditionalType(t)]`, created once. */
export function getBranchTypesFromConditionalType(c: Checker, t: ConditionalType): Type[] {
  const side = sideOf(c, t);
  let types = side.resolvedBranchTypes;
  if (types === undefined) {
    types = [getTrueTypeFromConditionalType(c, t), getFalseTypeFromConditionalType(c, t)];
    side.resolvedBranchTypes = types;
  }
  return types;
}

export function getInferredTrueTypeFromConditionalType(c: Checker, t: ConditionalType): Type {
  const side = sideOf(c, t);
  if (side.resolvedInferredTrueType === undefined)
    side.resolvedInferredTrueType =
      t.combinedMapper !== undefined
        ? instantiateType(c, getTypeFromTypeNode(c, conditionalNode(t.root).trueType), t.combinedMapper)
        : getTrueTypeFromConditionalType(c, t);
  return side.resolvedInferredTrueType;
}

export function getDefaultConstraintOfConditionalType(c: Checker, t: ConditionalType): Type {
  const side = sideOf(c, t);
  if (side.resolvedDefaultConstraint === undefined) {
    // The default constraint is the union of the branches, ignoring `never` branches from the check.
    const trueConstraint = getInferredTrueTypeFromConditionalType(c, t);
    const falseConstraint = getFalseTypeFromConditionalType(c, t);
    side.resolvedDefaultConstraint =
      (trueConstraint.flags & TypeFlags.Any) !== 0
        ? falseConstraint
        : (falseConstraint.flags & TypeFlags.Any) !== 0
          ? trueConstraint
          : getUnionType(c, [trueConstraint, falseConstraint]);
  }
  return side.resolvedDefaultConstraint;
}

export function getConstraintOfConditionalType(c: Checker, t: Type): Type | undefined {
  return hasNonCircularBaseConstraint(c, t) ? getConstraintFromConditionalType(c, t) : undefined;
}

export function getConstraintFromConditionalType(c: Checker, t: Type): Type {
  return (
    getConstraintOfDistributiveConditionalType(c, t as ConditionalType) ??
    getDefaultConstraintOfConditionalType(c, t as ConditionalType)
  );
}

/**
 * For `T extends U ? X : Y` with a constrained check type T, the instantiation with T replaced by its
 * constraint, which distributes over a union constraint and may reduce; `T extends undefined ? never : T`
 * removes `undefined` from T. Restrictive instantiations have none: their type parameters are `unknown`.
 */
export function getConstraintOfDistributiveConditionalType(c: Checker, t: ConditionalType): Type | undefined {
  const side = sideOf(c, t);
  if (side.resolvedConstraintOfDistributive === undefined) {
    side.resolvedConstraintOfDistributive = c.noConstraintType;
    if (t.root.isDistributive && !isRestrictiveInstance(c, t)) {
      let constraint: Type | undefined = getSimplifiedType(c, t.checkType, false);
      if (constraint === t.checkType) constraint = getConstraintOfTypeLocal(c, constraint);
      if (constraint !== undefined && constraint !== t.checkType) {
        const instantiated = getConditionalTypeInstantiation(
          c,
          t,
          prependTypeMapping(t.root.checkType, constraint, t.mapper),
          true,
          undefined,
        );
        if ((instantiated.flags & TypeFlags.Never) === 0) side.resolvedConstraintOfDistributive = instantiated;
      }
    }
  }
  return side.resolvedConstraintOfDistributive !== c.noConstraintType
    ? side.resolvedConstraintOfDistributive
    : undefined;
}

// ---- Template literal matching

/** Relates a template placeholder's inferred type to the placeholder type. */
export type TemplateTypeComparer = (source: Type, target: Type) => boolean;

/** Whether `source` matches the pattern of `target`, with placeholders related by `compareTypes`. */
export function isTypeMatchedByTemplateLiteralType(
  c: Checker,
  source: Type,
  target: TemplateLiteralType,
  compareTypes?: TemplateTypeComparer,
): boolean {
  const inferences = inferTypesFromTemplateLiteralType(c, source, target, compareTypes);
  if (inferences === undefined) return false;
  const compare = compareTypes ?? ((s: Type, t: Type) => isTypeAssignableTo(c, s, t));
  for (let i = 0; i < inferences.length; i++)
    if (!isValidTypeForTemplateLiteralPlaceholder(c, inferences[i]!, target.types[i]!, compare)) return false;
  return true;
}

function isValidTypeForTemplateLiteralPlaceholder(
  c: Checker,
  source: Type,
  target: Type,
  compare: TemplateTypeComparer,
): boolean {
  if ((target.flags & TypeFlags.Intersection) !== 0) {
    for (const t of typesOf(target))
      if (t !== c.emptyTypeLiteralType && !isValidTypeForTemplateLiteralPlaceholder(c, source, t, compare))
        return false;
    return true;
  }
  if ((target.flags & TypeFlags.String) !== 0 || compare(source, target)) return true;
  if ((source.flags & TypeFlags.StringLiteral) !== 0) {
    const value = (source as LiteralType).stringValue;
    return (
      ((target.flags & TypeFlags.Number) !== 0 && isValidNumberString(value, false)) ||
      ((target.flags & TypeFlags.BigInt) !== 0 && isValidBigIntString(value, false)) ||
      ((target.flags & (TypeFlags.BooleanLiteral | TypeFlags.Nullable)) !== 0 &&
        value === (target as IntrinsicType).intrinsicName) ||
      ((target.flags & TypeFlags.StringMapping) !== 0 && isMemberOfStringMapping(c, source, target)) ||
      ((target.flags & TypeFlags.TemplateLiteral) !== 0 &&
        isTypeMatchedByTemplateLiteralType(c, source, target as TemplateLiteralType, compare))
    );
  }
  if ((source.flags & TypeFlags.TemplateLiteral) !== 0) {
    const texts = (source as TemplateLiteralType).texts;
    return (
      texts.length === 2 &&
      texts[0]! === '' &&
      texts[1]! === '' &&
      compare((source as TemplateLiteralType).types[0]!, target)
    );
  }
  return false;
}

/** Whether `source` is a member of a string mapping type such as `Uppercase<string>`. */
export function isMemberOfStringMapping(c: Checker, source: Type, target: Type): boolean {
  if ((target.flags & TypeFlags.Any) !== 0) return true;
  if ((target.flags & (TypeFlags.String | TypeFlags.TemplateLiteral)) !== 0)
    return isTypeAssignableTo(c, source, target);
  if ((target.flags & TypeFlags.StringMapping) !== 0) {
    // Applying the target's mappings must leave the source unchanged, and the source must belong
    // to the innermost unmapped type.
    const mappings: Symbol[] = [];
    let inner = target;
    while ((inner.flags & TypeFlags.StringMapping) !== 0) {
      mappings.push(inner.symbol!);
      inner = (inner as StringMappingType).target;
    }
    let mapped = source;
    for (let i = mappings.length - 1; i >= 0; i--) mapped = getStringMappingType(c, mappings[i]!, mapped);
    return mapped === source && isMemberOfStringMapping(c, source, inner);
  }
  return false;
}

export type { TupleType, UnionType };

/** The generic mapped type an instantiated mapped type came from, or the type itself. */
export function mappedTypeTarget(t: MappedType): MappedType {
  const target = t.target;
  return target !== undefined ? (target as MappedType) : t;
}
