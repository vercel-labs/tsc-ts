// Type relations: identity, subtype, strict subtype, assignability and comparability, with
// tsgo's result caching, recursion limits, variance measurement and error elaboration.
import { lazyObjectFlags, sideOf, sideOfIfAny } from './side-state.js';
import {
  ModifierFlags,
  type Node,
  type ConditionalTypeNode,
  getExpression,
  getName,
  getNodeId,
  getText,
} from './ast.js';
import { getSymbolNameForPrivateIdentifier } from './binder.js';
import { getCombinedModifierFlags } from './binder-utilities.js';
import { Diagnostic, type DiagnosticMessage, Diagnostics, messageElidedInCompatibilityPyramid } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { isContextSensitive } from './checker-functions.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  type ConditionalType,
  ElementFlags,
  IndexFlags,
  type IndexInfo,
  type IndexType,
  type IndexedAccessType,
  type InterfaceType,
  type IntersectionType,
  type LiteralType,
  type MappedType,
  type ReverseMappedType,
  ObjectFlags,
  type Signature,
  SignatureFlags,
  SignatureKind,
  type StringMappingType,
  type SubstitutionType,
  type TemplateLiteralType,
  Ternary,
  type Type,
  TypeFlags,
  type TypePredicate,
  TypePredicateKind,
  type TypeReference,
  type UnionOrIntersectionType,
  type UnionType,
  VarianceFlags,
  emptyTypes,
  newTypeMapper,
  SimpleTypeMapper,
  type TypeMapper,
  isDistributedTypeParameter,
  type TypeParameter,
  type SymbolLinks,
} from './checker-types.js';
import { InferenceFlags, InferencePriority, createInferenceContext, inferTypes } from './checker-inference.js';
import {
  IntersectionFlags,
  unionContainsSortedTypes,
  unionContainsType,
  createArrayTypeEx,
  compareTypes,
  containsMissingType,
  createTypeReference,
  everyType,
  filterType,
  getBaseTypeOfLiteralType,
  getBaseTypeOfEnumLikeType,
  getElementTypes,
  getIntersectionType,
  getIntersectionTypeEx,
  getTargetType,
  getTypeArguments,
  getTypeReferenceArity,
  getUnionType,
  getUnionTypeEx,
  UnionReduction,
  isArrayOrTupleType,
  isArrayType,
  isEmptyAnonymousObjectType,
  isEmptyObjectType,
  isErrorType,
  isFreshLiteralType,
  isGenericTupleType,
  isLiteralType,
  isMutableArrayOrTuple,
  isReadonlyArrayType,
  isTupleType,
  isUnitType,
  someType,
  tupleTargetOf,
  typesOf,
  countTypes,
  getStartElementCount,
  getEndElementCount,
  createNormalizedTypeReference,
  typeListKey,
  getRegularTypeOfLiteralType,
  compareSymbols,
} from './checker-type-factory.js';
import {
  findApplicableIndexInfo,
  getApparentType,
  getApplicableIndexInfo,
  getApplicableIndexInfoForName,
  getBaseConstraintOfType,
  getBaseConstraintOrType,
  getConstraintOfType,
  getDeclarationModifierFlagsFromSymbol,
  getIndexInfoOfType,
  getIndexInfosOfType,
  getIndexTypeOfType,
  getPropertiesOfObjectType,
  getPropertiesOfType,
  getPropertiesOfUnionOrIntersectionType,
  getPropertyOfObjectType,
  getPropertyOfType,
  getPropertyOfUnionOrIntersectionType,
  getReducedType,
  getSignaturesOfStructuredType,
  getSignaturesOfType,
  getTargetSymbol,
  getTypeOfPropertyOfType,
  getTypeWithThisArgument,
  getUnionOrIntersectionProperty,
  isApplicableIndexType,
  isArrayLikeType,
  isObjectLiteralType,
  isDiscriminantWithNeverType,
  isConflictingPrivateProperty,
  resolveStructuredTypeMembers,
  getResolvedMember,
  hasResolvedProperties,
  resolvedPropertiesAreOptional,
  positionsOfNamesFoundInSource,
  firstUnmatchedProperty,
} from './checker-members.js';
import {
  getParentOfSymbol,
  getMergedSymbol,
  getMembersOfSymbol,
  getSpellingSuggestionForName,
} from './checker-symbols.js';
import { CodePoints, distanceToCandidate, utf8Length } from './spelling.js';
import {
  getConstraintFromTypeParameter,
  getDeclaredTypeOfSymbol,
  getDefaultOrUnknownFromTypeParameter,
  fillMissingTypeArguments,
  getMinTypeArgumentCount,
  hasBaseType,
  hasNonCircularBaseConstraint,
  computeEnumMemberValues,
  getBaseTypes,
  getExtendsHeritageClauseElement,
} from './checker-declared-types.js';
import {
  getNonMissingTypeOfSymbol,
  getOptionalType,
  getTypeOfSymbol,
  isReadonlySymbol,
  removeMissingType,
  addOptionality,
} from './checker-symbol-types.js';
import {
  cloneTypeParameter,
  couldContainTypeVariables,
  instantiateSignatureEx,
  instantiateType,
  isTypeParameterPossiblyReferenced,
  getRestrictiveInstantiation,
} from './instantiation.js';
import { getJsxType, getSuggestedSymbolForNonexistentJSXAttribute, isJsxOpeningLikeElement } from './checker-jsx.js';
import { signatureToString, symbolToString, typeToString, typePredicateToString } from './type-printer.js';
import {
  getConstraintOfDistributiveConditionalType,
  getDefaultConstraintOfConditionalType,
  getConstraintTypeFromMappedType,
  getFalseTypeFromConditionalType,
  getIndexType,
  getIndexTypeEx,
  getIndexedAccessType,
  getIndexedAccessTypeOrUndefined,
  getMappedTypeModifiers,
  getCombinedMappedTypeOptionality,
  getModifiersTypeFromMappedType,
  getNameTypeFromMappedType,
  getPermissiveInstantiation,
  getSimplifiedType,
  getSubstitutionIntersection,
  getTemplateTypeFromMappedType,
  getTrueTypeFromConditionalType,
  getTypeParameterFromMappedType,
  isGenericIndexType,
  isGenericMappedType,
  isGenericObjectType,
  isMappedTypeGenericIndexedAccess,
  isTypeMatchedByTemplateLiteralType,
  isMemberOfStringMapping,
  getApparentMappedTypeKeys,
  shouldDeferIndexType,
  isMappedTypeWithKeyofConstraintDeclaration,
  MappedTypeModifiers,
} from './checker-type-operators.js';
import {
  getCanonicalSignature,
  getErasedSignature,
  getMinArgumentCount,
  getNonArrayRestType,
  getNonCircularReturnTypeOfSignature,
  getParameterCount,
  getParameterNameAtPosition,
  getRestOrAnyTypeAtPosition,
  getReturnTypeOfSignature,
  getSingleCallSignature,
  getThisTypeOfSignature,
  getTypeAtPosition,
  getTypePredicateOfSignature,
  hasEffectiveRestParameter,
  instantiateSignatureInContextOf,
  isTopSignature,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import { getNonNullableType, getTypeFacts, TypeFacts } from './checker-flow.js';
import {
  getPropertyNameFromType,
  isLateBoundName,
  isNumericLiteralName,
  maybeTypeOfKind,
} from './checker-utilities.js';
import { CheckFlags, declarationCount, getDeclarations, getSymbolId, type Symbol, SymbolFlags } from './symbol.js';

// ---- Results and caches

export const enum RelationComparisonResult {
  None = 0,
  Succeeded = 1 << 0,
  Failed = 1 << 1,
  ReportsUnmeasurable = 1 << 3,
  ReportsUnreliable = 1 << 4,
  ComplexityOverflow = 1 << 5,
  ReportsMask = ReportsUnmeasurable | ReportsUnreliable,
  Overflow = ComplexityOverflow,
}

/**
 * Cached results of one relation by numeric relation key (see getRelationKey): an open-addressing
 * table of keys and one-byte results. Keys are never 0 (packed keys are positive, interned ones
 * negative), so 0 marks a free slot. At 3/8 to 3/4 full it takes about 16 bytes per result, where a
 * Map takes about 40 (a 24-byte entry, its share of the bucket table and of the spare capacity);
 * relations are most of a checker's tables on programs with many structural comparisons.
 */
export class Relation {
  private keys = new Float64Array(64);
  private results = new Uint8Array(64);
  private count = 0;

  get(key: number): number {
    const keys = this.keys;
    const mask = keys.length - 1;
    for (let i = relationSlot(key) & mask; ; i = (i + 1) & mask) {
      const k = keys[i]!;
      if (k === key) return this.results[i]!;
      if (k === 0) return RelationComparisonResult.None;
    }
  }

  /** Sets the result of `key`, and returns whether the key is new. */
  set(key: number, result: number): boolean {
    const keys = this.keys;
    const mask = keys.length - 1;
    for (let i = relationSlot(key) & mask; ; i = (i + 1) & mask) {
      const k = keys[i]!;
      if (k === key) {
        this.results[i] = result;
        return false;
      }
      if (k === 0) {
        keys[i] = key;
        this.results[i] = result;
        this.count++;
        if (this.count * 4 > keys.length * 3) this.grow();
        return true;
      }
    }
  }

  /** Removes `key`, moving later entries of its probe run back so lookups still find them. */
  delete(key: number): void {
    const keys = this.keys;
    const results = this.results;
    const mask = keys.length - 1;
    let i = relationSlot(key) & mask;
    for (; keys[i] !== key; i = (i + 1) & mask) if (keys[i] === 0) return;
    for (let j = (i + 1) & mask; keys[j] !== 0; j = (j + 1) & mask) {
      // An entry stays where it is when its home slot is cyclically after the freed slot and at or before it.
      const home = relationSlot(keys[j]!) & mask;
      if (i <= j ? i < home && home <= j : i < home || home <= j) continue;
      keys[i] = keys[j]!;
      results[i] = results[j]!;
      i = j;
    }
    keys[i] = 0;
    results[i] = 0;
    this.count--;
  }

  size(): number {
    return this.count;
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldResults = this.results;
    const keys = new Float64Array(oldKeys.length * 2);
    const results = new Uint8Array(oldKeys.length * 2);
    const mask = keys.length - 1;
    for (let j = 0; j < oldKeys.length; j++) {
      const key = oldKeys[j]!;
      if (key === 0) continue;
      let i = relationSlot(key) & mask;
      while (keys[i] !== 0) i = (i + 1) & mask;
      keys[i] = key;
      results[i] = oldResults[j]!;
    }
    this.keys = keys;
    this.results = results;
  }
}

/**
 * The hash of a relation key, an integer of at most 53 bits: its low 24 bits (a type id in packed
 * keys) mixed with the rest, both small enough for int32 arithmetic.
 */
function relationSlot(key: number): number {
  const high = Math.floor(key / 16777216);
  const low = key - high * 16777216;
  const h = Math.imul((high | 0) ^ Math.imul(low | 0, 0x9e3779b1 | 0), 0x85ebca6b | 0);
  return h ^ (h >>> 15);
}

const enum RecursionFlags {
  None = 0,
  Source = 1 << 0,
  Target = 1 << 1,
  Both = Source | Target,
}

const enum ExpandingFlags {
  None = 0,
  Source = 1 << 0,
  Target = 1 << 1,
  Both = Source | Target,
}

export const enum IntersectionState {
  None = 0,
  Source = 1 << 0,
  Target = 1 << 1,
}

export const enum SignatureCheckMode {
  None = 0,
  BivariantCallback = 1 << 0,
  StrictCallback = 1 << 1,
  IgnoreReturnTypes = 1 << 2,
  StrictArity = 1 << 3,
  StrictTopSignature = 1 << 4,
  Callback = BivariantCallback | StrictCallback,
}

/** An object identity shared by instantiations of the same type, for recursion limits. */
/**
 * The recursion identity of a type (`getRecursionIdentity`): a node, a symbol or a type, as a number
 * (its id times 4 plus its kind), compared only for equality. A union of the three classes would be
 * boxed in native builds on every call.
 */
export type RecursionId = number;

// ---- Comparers

/**
 * Compares types for signature and property comparisons, and receives their error reports.
 * Subclasses replace tsgo's comparer and error reporter callbacks.
 */
export abstract class TypeComparer {
  abstract compare(source: Type, target: Type, reportErrors: boolean): Ternary;

  /** Records an elaboration; the default ignores it. */
  report(_message: DiagnosticMessage, _args: string[]): void {}
}

export const enum ComparerKind {
  Identical = 0,
  SubtypeOf = 1,
  Assignable = 2,
  Equal = 3,
}

class RelationComparer extends TypeComparer {
  readonly c: Checker;
  readonly kind: ComparerKind;

  constructor(c: Checker, kind: ComparerKind) {
    super();
    this.c = c;
    this.kind = kind;
  }

  compare(source: Type, target: Type, _reportErrors: boolean): Ternary {
    const c = this.c;
    switch (this.kind) {
      case ComparerKind.Identical:
        return isTypeRelatedTo(c, source, target, c.identityRelation) ? Ternary.True : Ternary.False;
      case ComparerKind.SubtypeOf:
        return isTypeRelatedTo(c, source, target, c.subtypeRelation) ? Ternary.True : Ternary.False;
      case ComparerKind.Assignable:
        return isTypeRelatedTo(c, source, target, c.assignableRelation) ? Ternary.True : Ternary.False;
    }
    return source === target ? Ternary.True : Ternary.False;
  }
}

export function getComparer(c: Checker, kind: ComparerKind): TypeComparer {
  let list = c.relationComparers;
  if (list.length === 0) {
    list = [
      new RelationComparer(c, ComparerKind.Identical),
      new RelationComparer(c, ComparerKind.SubtypeOf),
      new RelationComparer(c, ComparerKind.Assignable),
      new RelationComparer(c, ComparerKind.Equal),
    ];
    c.relationComparers = list;
  }
  return list[kind]!;
}

export function compareTypesIdentical(c: Checker, s: Type, t: Type): Ternary {
  return isTypeRelatedTo(c, s, t, c.identityRelation) ? Ternary.True : Ternary.False;
}

export function compareTypesSubtypeOf(c: Checker, s: Type, t: Type): Ternary {
  return isTypeRelatedTo(c, s, t, c.subtypeRelation) ? Ternary.True : Ternary.False;
}

export function compareTypesAssignable(c: Checker, s: Type, t: Type): Ternary {
  return isTypeRelatedTo(c, s, t, c.assignableRelation) ? Ternary.True : Ternary.False;
}

export function compareTypesEqual(_c: Checker, s: Type, t: Type): Ternary {
  return s === t ? Ternary.True : Ternary.False;
}

// ---- Entry points

export function isTypeIdenticalTo(c: Checker, source: Type, target: Type): boolean {
  return isTypeRelatedTo(c, source, target, c.identityRelation);
}

export function isTypeAssignableTo(c: Checker, source: Type, target: Type): boolean {
  return isTypeRelatedTo(c, source, target, c.assignableRelation);
}

export function isTypeSubtypeOf(c: Checker, source: Type, target: Type): boolean {
  return isTypeRelatedTo(c, source, target, c.subtypeRelation);
}

export function isTypeStrictSubtypeOf(c: Checker, source: Type, target: Type): boolean {
  return isTypeRelatedTo(c, source, target, c.strictSubtypeRelation);
}

export function isTypeComparableTo(c: Checker, source: Type, target: Type): boolean {
  return isTypeRelatedTo(c, source, target, c.comparableRelation);
}

export function areTypesComparable(c: Checker, type1: Type, type2: Type): boolean {
  return isTypeComparableTo(c, type1, type2) || isTypeComparableTo(c, type2, type1);
}

export function isTypeRelatedTo(c: Checker, source: Type, target: Type, relation: Relation): boolean {
  if (isFreshLiteralType(source)) source = (source as LiteralType).regularType;
  if (isFreshLiteralType(target)) target = (target as LiteralType).regularType;
  if (source === target) return true;
  // A template literal target whose start and end texts rule out a match relates to no string
  // literal or template literal source, under any relation. (The full check reports unreliable
  // variance for type variables in a template literal source, so those take it.)
  if ((target.flags & TypeFlags.TemplateLiteral) !== 0) {
    if (
      (source.flags & TypeFlags.StringLiteral) !== 0 &&
      !stringLiteralTextMayMatch((source as LiteralType).stringValue, target as TemplateLiteralType)
    )
      return false;
    if (
      (source.flags & TypeFlags.TemplateLiteral) !== 0 &&
      (relation === c.comparableRelation
        ? templateLiteralTypesDefinitelyUnrelated(source as TemplateLiteralType, target as TemplateLiteralType)
        : !templateLiteralTextsMayMatch(source as TemplateLiteralType, target as TemplateLiteralType)) &&
      !someTypeCouldContainTypeVariables(c, (source as TemplateLiteralType).types)
    )
      return false;
  }
  if (relation !== c.identityRelation) {
    if (
      (relation === c.comparableRelation &&
        (target.flags & TypeFlags.Never) === 0 &&
        isSimpleTypeRelatedTo(c, target, source, relation, undefined)) ||
      isSimpleTypeRelatedTo(c, source, target, relation, undefined)
    )
      return true;
    // A primitive against a union: the relater (in typeRelatedToSomeType) finds it related when the
    // union contains it, and decides a union of primitives without setting up a relater. Unions of
    // four or more primitives that membership doesn't decide take the full check, which caches them.
    if ((target.flags & TypeFlags.Union) !== 0 && (source.flags & TypeFlags.StructuredOrInstantiable) === 0) {
      if (unionContainsType(c, target as UnionType, source)) return true;
      if ((target.objectFlags & ObjectFlags.PrimitiveUnion) !== 0) {
        if (isLiteralRelatedByPrimitiveUnionForms(c, source, target, relation))
          return literalRelatedToPrimitiveUnion(c, source, target as UnionType);
        const types = typesOf(target);
        if (types.length < 4) {
          for (const t of types) {
            const u = isFreshLiteralType(t) ? (t as LiteralType).regularType : t;
            if (
              source === u ||
              (relation === c.comparableRelation &&
                (u.flags & TypeFlags.Never) === 0 &&
                isSimpleTypeRelatedTo(c, u, source, relation, undefined)) ||
              isSimpleTypeRelatedTo(c, source, u, relation, undefined)
            )
              return true;
          }
          return false;
        }
      }
    }
  } else if (
    ((source.flags | target.flags) &
      (TypeFlags.UnionOrIntersection | TypeFlags.IndexedAccess | TypeFlags.Conditional | TypeFlags.Substitution)) ===
    0
  ) {
    // Types that can't simplify must have identical flags.
    if (source.flags !== target.flags) return false;
    if ((source.flags & TypeFlags.Singleton) !== 0) return true;
  } else {
    // What the relater decides first for types that may simplify (Relater.isRelatedToEx): their normal forms are
    // one type, or can be identical only with identical flags.
    const s = getNormalizedType(c, source, false);
    const t = getNormalizedType(c, target, true);
    if (s === t) return true;
    if (s.flags !== t.flags) return false;
  }
  if ((source.flags & TypeFlags.Object) !== 0 && (target.flags & TypeFlags.Object) !== 0) {
    const related = relation.get(
      getRelationKey(c, source, target, IntersectionState.None, relation === c.identityRelation, false).key,
    );
    if (related !== RelationComparisonResult.None) return (related & RelationComparisonResult.Succeeded) !== 0;
  }
  if (
    (source.flags & TypeFlags.StructuredOrInstantiable) !== 0 ||
    (target.flags & TypeFlags.StructuredOrInstantiable) !== 0
  )
    return checkTypeRelatedTo(c, source, target, relation, undefined, undefined, undefined);
  return false;
}

/**
 * Whether `source` is a literal that relates to the primitive union `target` only through its base
 * primitive or its other freshness form (see literalRelatedToPrimitiveUnion).
 */
function isLiteralRelatedByPrimitiveUnionForms(c: Checker, source: Type, target: Type, relation: Relation): boolean {
  return (
    relation !== c.comparableRelation &&
    (target.objectFlags & ObjectFlags.PrimitiveUnion) !== 0 &&
    (source.flags & TypeFlags.EnumLiteral) === 0 &&
    ((source.flags & (TypeFlags.StringLiteral | TypeFlags.BooleanLiteral | TypeFlags.BigIntLiteral)) !== 0 ||
      ((relation === c.subtypeRelation || relation === c.strictSubtypeRelation) &&
        (source.flags & TypeFlags.NumberLiteral) !== 0))
  );
}

function literalRelatedToPrimitiveUnion(c: Checker, source: Type, target: UnionType): boolean {
  const literal = source as LiteralType;
  // Typed: scriptc can't pass the narrowed LiteralType field as a Type.
  const alternateForm: Type | undefined =
    source === literal.regularType ? (literal.freshType ?? sideOfIfAny(c, literal)?.freshType) : literal.regularType;
  let primitive: Type | undefined;
  if ((source.flags & TypeFlags.StringLiteral) !== 0) primitive = c.stringType;
  else if ((source.flags & TypeFlags.NumberLiteral) !== 0) primitive = c.numberType;
  else if ((source.flags & TypeFlags.BigIntLiteral) !== 0) primitive = c.bigintType;
  return (
    (primitive !== undefined && unionContainsType(c, target, primitive)) ||
    (alternateForm !== undefined && unionContainsType(c, target, alternateForm))
  );
}

export function isSimpleTypeRelatedTo(
  c: Checker,
  source: Type,
  target: Type,
  relation: Relation,
  reporter: Relater | undefined,
): boolean {
  // Every rule below that can succeed needs one of these target flags, one of these source flags, or
  // the wildcard source. Most pairs (objects, type parameters, intersections) have none of them; the
  // test is small enough to inline into callers.
  if (
    (target.flags &
      (TypeFlags.Any |
        TypeFlags.Unknown |
        TypeFlags.String |
        TypeFlags.StringLiteral |
        TypeFlags.Number |
        TypeFlags.NumberLiteral |
        TypeFlags.BigInt |
        TypeFlags.Boolean |
        TypeFlags.ESSymbol |
        TypeFlags.Enum |
        TypeFlags.EnumLiteral |
        TypeFlags.NonPrimitive |
        TypeFlags.Union)) ===
      0 &&
    (source.flags & (TypeFlags.Any | TypeFlags.Never | TypeFlags.Undefined | TypeFlags.Null)) === 0 &&
    source !== c.wildcardType
  )
    return false;
  return isSimpleTypeRelatedToWorker(c, source, target, relation, reporter);
}

function isSimpleTypeRelatedToWorker(
  c: Checker,
  source: Type,
  target: Type,
  relation: Relation,
  reporter: Relater | undefined,
): boolean {
  const s = source.flags;
  const t = target.flags;
  if ((t & TypeFlags.Any) !== 0 || (s & TypeFlags.Never) !== 0 || source === c.wildcardType) return true;
  if ((t & TypeFlags.Unknown) !== 0 && !(relation === c.strictSubtypeRelation && (s & TypeFlags.Any) !== 0))
    return true;
  if ((t & TypeFlags.Never) !== 0) return false;
  if ((s & TypeFlags.StringLike) !== 0 && (t & TypeFlags.String) !== 0) return true;
  if (
    (s & TypeFlags.StringLiteral) !== 0 &&
    (s & TypeFlags.EnumLiteral) !== 0 &&
    (t & TypeFlags.StringLiteral) !== 0 &&
    (t & TypeFlags.EnumLiteral) === 0 &&
    (source as LiteralType).stringValue === (target as LiteralType).stringValue
  )
    return true;
  if ((s & TypeFlags.NumberLike) !== 0 && (t & TypeFlags.Number) !== 0) return true;
  if (
    (s & TypeFlags.NumberLiteral) !== 0 &&
    (s & TypeFlags.EnumLiteral) !== 0 &&
    (t & TypeFlags.NumberLiteral) !== 0 &&
    (t & TypeFlags.EnumLiteral) === 0 &&
    sameLiteralValue(source, target)
  )
    return true;
  if ((s & TypeFlags.BigIntLike) !== 0 && (t & TypeFlags.BigInt) !== 0) return true;
  if ((s & TypeFlags.BooleanLike) !== 0 && (t & TypeFlags.Boolean) !== 0) return true;
  if ((s & TypeFlags.ESSymbolLike) !== 0 && (t & TypeFlags.ESSymbol) !== 0) return true;
  if (
    (s & TypeFlags.Enum) !== 0 &&
    (t & TypeFlags.Enum) !== 0 &&
    source.symbol!.name === target.symbol!.name &&
    isEnumTypeRelatedTo(c, source.symbol!, target.symbol!, reporter)
  )
    return true;
  if ((s & TypeFlags.EnumLiteral) !== 0 && (t & TypeFlags.EnumLiteral) !== 0) {
    if (
      (s & TypeFlags.Union) !== 0 &&
      (t & TypeFlags.Union) !== 0 &&
      isEnumTypeRelatedTo(c, source.symbol!, target.symbol!, reporter)
    )
      return true;
    if (
      (s & TypeFlags.Literal) !== 0 &&
      (t & TypeFlags.Literal) !== 0 &&
      sameLiteralValue(source, target) &&
      isEnumTypeRelatedTo(c, source.symbol!, target.symbol!, reporter)
    )
      return true;
  }
  // Without strictNullChecks, undefined and null are assignable to anything but never (and unions/intersections that may reduce to it).
  if (
    (s & TypeFlags.Undefined) !== 0 &&
    ((!c.strictNullChecks && (t & TypeFlags.UnionOrIntersection) === 0) ||
      (t & (TypeFlags.Undefined | TypeFlags.Void)) !== 0)
  )
    return true;
  if (
    (s & TypeFlags.Null) !== 0 &&
    ((!c.strictNullChecks && (t & TypeFlags.UnionOrIntersection) === 0) || (t & TypeFlags.Null) !== 0)
  )
    return true;
  if (
    (s & TypeFlags.Object) !== 0 &&
    (t & TypeFlags.NonPrimitive) !== 0 &&
    !(
      relation === c.strictSubtypeRelation &&
      isEmptyAnonymousObjectType(c, source) &&
      (source.objectFlags & ObjectFlags.FreshLiteral) === 0
    )
  )
    return true;
  if (relation === c.assignableRelation || relation === c.comparableRelation) {
    if ((s & TypeFlags.Any) !== 0) return true;
    // Numbers are assignable to numeric enums, for bit flags.
    if (
      (s & TypeFlags.Number) !== 0 &&
      ((t & TypeFlags.Enum) !== 0 || ((t & TypeFlags.NumberLiteral) !== 0 && (t & TypeFlags.EnumLiteral) !== 0))
    )
      return true;
    if (
      (s & TypeFlags.NumberLiteral) !== 0 &&
      (s & TypeFlags.EnumLiteral) === 0 &&
      ((t & TypeFlags.Enum) !== 0 ||
        ((t & TypeFlags.NumberLiteral) !== 0 && (t & TypeFlags.EnumLiteral) !== 0 && sameLiteralValue(source, target)))
    )
      return true;
    // Anything is assignable to a union of undefined, null and {}.
    if (isUnknownLikeUnionType(c, target)) return true;
  }
  return false;
}

/** Whether two literal types have the same value; literals of different kinds never do. */
function sameLiteralValue(a: Type, b: Type): boolean {
  if (((a.flags ^ b.flags) & TypeFlags.Literal) !== 0) return false;
  const x = a as LiteralType;
  const y = b as LiteralType;
  if ((a.flags & TypeFlags.NumberLiteral) !== 0)
    return x.numberValue === y.numberValue || (x.numberValue !== x.numberValue && y.numberValue !== y.numberValue);
  return x.stringValue === y.stringValue;
}

function someTypeIsEmptyAnonymousObject(c: Checker, types: readonly Type[]): boolean {
  for (const t of types) if (isEmptyAnonymousObjectType(c, t)) return true;
  return false;
}

export function isUnknownLikeUnionType(c: Checker, t: Type): boolean {
  if (!c.strictNullChecks || (t.flags & TypeFlags.Union) === 0) return false;
  const side = sideOf(c, t);
  if ((side.objectFlags & ObjectFlags.IsUnknownLikeUnionComputed) === 0) {
    side.objectFlags |= ObjectFlags.IsUnknownLikeUnionComputed;
    const types = typesOf(t);
    if (
      types.length >= 3 &&
      (types[0]!.flags & TypeFlags.Undefined) !== 0 &&
      (types[1]!.flags & TypeFlags.Null) !== 0 &&
      someTypeIsEmptyAnonymousObject(c, types)
    )
      side.objectFlags |= ObjectFlags.IsUnknownLikeUnion;
  }
  return (side.objectFlags & ObjectFlags.IsUnknownLikeUnion) !== 0;
}

function isEnumTypeRelatedTo(c: Checker, source: Symbol, target: Symbol, reporter: Relater | undefined): boolean {
  const sourceSymbol = (source.flags & SymbolFlags.EnumMember) !== 0 ? getParentOfSymbol(c, source)! : source;
  const targetSymbol = (target.flags & SymbolFlags.EnumMember) !== 0 ? getParentOfSymbol(c, target)! : target;
  if (sourceSymbol === targetSymbol) return true;
  if (
    sourceSymbol.name !== targetSymbol.name ||
    (sourceSymbol.flags & SymbolFlags.RegularEnum) === 0 ||
    (targetSymbol.flags & SymbolFlags.RegularEnum) === 0
  )
    return false;
  const key = getSymbolId(sourceSymbol) + ',' + getSymbolId(targetSymbol);
  const entry = c.enumRelation.get(key) ?? RelationComparisonResult.None;
  if (
    entry !== RelationComparisonResult.None &&
    !((entry & RelationComparisonResult.Failed) !== 0 && reporter !== undefined)
  )
    return (entry & RelationComparisonResult.Succeeded) !== 0;
  const targetEnumType = getTypeOfSymbol(c, targetSymbol);
  for (const sourceProperty of getPropertiesOfType(c, getTypeOfSymbol(c, sourceSymbol))) {
    if ((sourceProperty.flags & SymbolFlags.EnumMember) === 0) continue;
    const targetProperty = getPropertyOfType(c, targetEnumType, sourceProperty.name);
    if (targetProperty === undefined || (targetProperty.flags & SymbolFlags.EnumMember) === 0) {
      if (reporter !== undefined)
        reporter.reportError(Diagnostics.Property_0_is_missing_in_type_1, [
          symbolToString(c, sourceProperty),
          typeToString(c, getDeclaredTypeOfSymbol(c, targetSymbol), undefined, 1 << 6),
        ]);
      c.enumRelation.set(key, RelationComparisonResult.Failed);
      return false;
    }
    const sourceDecl = getDeclarations(sourceProperty).find((d) => d.kind === SyntaxKind.EnumMember);
    const targetDecl = getDeclarations(targetProperty).find((d) => d.kind === SyntaxKind.EnumMember);
    if (sourceDecl === undefined || targetDecl === undefined) continue;
    computeEnumMemberValues(c, sourceDecl.parent!);
    computeEnumMemberValues(c, targetDecl.parent!);
    const s = c.nodeLinks(sourceDecl);
    const t = c.nodeLinks(targetDecl);
    const same =
      s.enumValueKind === t.enumValueKind &&
      (s.enumValueKind === 0 ||
        (s.enumValueKind === 1 ? s.enumNumberValue === t.enumNumberValue : s.enumStringValue === t.enumStringValue));
    if (same) continue;
    if (s.enumValueKind !== 0 && t.enumValueKind !== 0) {
      if (reporter !== undefined)
        reporter.reportError(
          Diagnostics.Each_declaration_of_0_1_differs_in_its_value_where_2_was_expected_but_3_was_given,
          [
            symbolToString(c, targetSymbol),
            symbolToString(c, targetProperty),
            enumValueText(t.enumValueKind, t.enumNumberValue, t.enumStringValue),
            enumValueText(s.enumValueKind, s.enumNumberValue, s.enumStringValue),
          ],
        );
      c.enumRelation.set(key, RelationComparisonResult.Failed);
      return false;
    }
    // One value is unknown, so assumed numeric; a string on the other side mismatches.
    if (s.enumValueKind === 2 || t.enumValueKind === 2) {
      if (reporter !== undefined) {
        const known = s.enumValueKind === 2 ? s : t;
        reporter.reportError(
          Diagnostics.One_value_of_0_1_is_the_string_2_and_the_other_is_assumed_to_be_an_unknown_numeric_value,
          [symbolToString(c, targetSymbol), symbolToString(c, targetProperty), JSON.stringify(known.enumStringValue)],
        );
      }
      c.enumRelation.set(key, RelationComparisonResult.Failed);
      return false;
    }
  }
  c.enumRelation.set(key, RelationComparisonResult.Succeeded);
  return true;
}

function enumValueText(kind: number, n: number, s: string): string {
  return kind === 1 ? String(n) : JSON.stringify(s);
}

// ---- Keys

export class RelationKey {
  key = 0;
  constrained = false;
}

/** Type ids below this bound pack into a numeric relation key with the intersection state. */
const RelationKeyIdLimit = 1 << 24;

/**
 * A key for the string spelling of a relation, numbered per checker. Interned keys are negative, so
 * they never collide with packed keys.
 */
function internRelationKey(c: Checker, text: string): number {
  let key = c.relationKeyIds.get(text);
  if (key === undefined) {
    key = -++c.relationKeyCount;
    c.relationKeyIds.set(text, key);
  }
  return key;
}

/** An interned generic relation key (`writeTypeReference`'s tokens) and the next one with the same hash. */
export class InternedRelationKey {
  readonly tokens: number[];
  readonly key: number;
  next: InternedRelationKey | undefined = undefined;

  constructor(tokens: number[], key: number) {
    this.tokens = tokens;
    this.key = key;
  }
}

/** `internRelationKey` for a generic relation key spelled as tokens, without building its string. */
function internRelationKeyTokens(c: Checker, tokens: number[]): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    h1 = Math.imul(h1 ^ t, 0x01000193);
    h2 = Math.imul(h2 + t, 0x85ebca6b) ^ (h2 >>> 15);
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x7feb352d);
  h1 ^= h1 >>> 15;
  const hash = (h1 >>> 0) * 0x100000 + ((h2 ^ tokens.length) & 0xfffff);
  const head = c.relationKeyTokens.get(hash);
  for (let e = head; e !== undefined; e = e.next) {
    const other = e.tokens;
    if (other.length !== tokens.length) continue;
    let same = true;
    for (let i = 0; i < tokens.length; i++)
      if (other[i]! !== tokens[i]!) {
        same = false;
        break;
      }
    if (same) return e.key;
  }
  const entry = new InternedRelationKey(tokens, -++c.relationKeyCount);
  if (head === undefined) c.relationKeyTokens.set(hash, entry);
  else {
    entry.next = head.next;
    head.next = entry;
  }
  return entry.key;
}

// The tokens of a generic relation key: what the key string would spell, as numbers. Ids and type
// parameter positions carry their kind in the low two bits; the markers end in 3.
const enum RelationKeyToken {
  TargetId = 0,
  ArgumentId = 1,
  TypeParameterIndex = 2,
  Open = 3,
  Close = 7,
  Separator = 11,
  /** Plus 4 x the intersection state. */
  End = 15,
}

export function getRelationKey(
  c: Checker,
  source: Type,
  target: Type,
  intersectionState: IntersectionState,
  isIdentity: boolean,
  ignoreConstraints: boolean,
): RelationKey {
  if (isIdentity && source.id > target.id) {
    const t = source;
    source = target;
    target = t;
  }
  const result = c.relationScratchKey;
  result.constrained = false;
  if (isTypeReferenceWithGenericArguments(c, source) && isTypeReferenceWithGenericArguments(c, target)) {
    const typeParameters: Type[] = [];
    const tokens: number[] = [];
    writeTypeReference(c, source, 0, typeParameters, tokens, ignoreConstraints, result);
    tokens.push(RelationKeyToken.Separator);
    writeTypeReference(c, target, 0, typeParameters, tokens, ignoreConstraints, result);
    tokens.push(RelationKeyToken.End + 4 * intersectionState);
    result.key = internRelationKeyTokens(c, tokens);
  } else {
    // The common case packs both ids and the intersection state (two bits) into one exact number,
    // so the relation caches need no key strings.
    const s = source.id;
    const t = target.id;
    result.key =
      s < RelationKeyIdLimit && t < RelationKeyIdLimit
        ? (s * RelationKeyIdLimit + t) * 4 + intersectionState
        : internRelationKey(c, 's' + s + ',' + t + ':' + intersectionState);
  }
  return result;
}

function writeTypeReference(
  c: Checker,
  ref: Type,
  depth: number,
  typeParameters: Type[],
  tokens: number[],
  ignoreConstraints: boolean,
  result: RelationKey,
): void {
  tokens.push((ref as TypeReference).target!.id * 4 + RelationKeyToken.TargetId);
  for (const t of (ref as TypeReference).resolvedTypeArguments ?? getTypeArguments(c, ref)) {
    if ((t.flags & TypeFlags.TypeParameter) !== 0) {
      if (ignoreConstraints || getConstraintFromTypeParameter(c, t) === undefined) {
        let index = typeParameters.indexOf(t);
        if (index < 0) {
          index = typeParameters.length;
          typeParameters.push(t);
        }
        tokens.push(index * 4 + RelationKeyToken.TypeParameterIndex);
        continue;
      }
      result.constrained = true;
    } else if (depth < 4 && isTypeReferenceWithGenericArguments(c, t)) {
      tokens.push(RelationKeyToken.Open);
      writeTypeReference(c, t, depth + 1, typeParameters, tokens, ignoreConstraints, result);
      tokens.push(RelationKeyToken.Close);
      continue;
    }
    tokens.push(t.id * 4 + RelationKeyToken.ArgumentId);
  }
}

function isTypeReferenceWithGenericArguments(c: Checker, t: Type): boolean {
  if (
    (t.objectFlags & ObjectFlags.Reference) === 0 ||
    (t.flags & TypeFlags.Object) === 0 ||
    (t as TypeReference).node !== undefined
  )
    return false;
  for (const a of getTypeArguments(c, t))
    if ((a.flags & TypeFlags.TypeParameter) !== 0 || isTypeReferenceWithGenericArguments(c, a)) return true;
  return false;
}

// ---- checkTypeRelatedTo

export function checkTypeAssignableTo(
  c: Checker,
  source: Type,
  target: Type,
  errorNode: Node | undefined,
  headMessage: DiagnosticMessage | undefined,
): boolean {
  return checkTypeRelatedTo(c, source, target, c.assignableRelation, errorNode, headMessage, undefined);
}

export function checkTypeComparableTo(
  c: Checker,
  source: Type,
  target: Type,
  errorNode: Node | undefined,
  headMessage: DiagnosticMessage | undefined,
): boolean {
  return checkTypeRelatedTo(c, source, target, c.comparableRelation, errorNode, headMessage, undefined);
}

/**
 * Whether `source` is related to `target`. With an `errorNode`, reports at most one error, to
 * `diagnosticOutput` when given.
 */
export function checkTypeRelatedTo(
  c: Checker,
  source: Type,
  target: Type,
  relation: Relation,
  errorNode: Node | undefined,
  headMessage: DiagnosticMessage | undefined,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  // Nested checks (from resolving types during the relation) find no spare and allocate their own.
  const r = c.spareRelater ?? new Relater(c, relation, errorNode);
  c.spareRelater = undefined;
  const relationCount = Math.trunc((16000000 - relation.size()) / 8);
  if (errorNode !== undefined) {
    // Relate without reporting first: reporting builds a message for every comparison that fails on the way,
    // even when the relation holds. When the relation fails, the results this pass added are removed, since
    // the comparisons it assumed related while comparing would change which failure the report elaborates.
    r.reset(relation, undefined);
    r.relationCount = relationCount;
    const addedKeys: number[] = [];
    r.addedKeys = addedKeys;
    const quiet = r.isRelatedToEx(source, target, RecursionFlags.Both, false, undefined, IntersectionState.None);
    r.addedKeys = undefined;
    if (quiet !== Ternary.False && !r.overflow) {
      c.spareRelater = r;
      return true;
    }
    for (const key of addedKeys) relation.delete(key);
  }
  r.reset(relation, errorNode);
  r.relationCount = relationCount;
  const result = r.isRelatedToEx(
    source,
    target,
    RecursionFlags.Both,
    errorNode !== undefined,
    headMessage,
    IntersectionState.None,
  );
  if (r.overflow) {
    // Remember the overflow so it isn't attempted again.
    const key = getRelationKey(c, source, target, IntersectionState.None, relation === c.identityRelation, false).key;
    relation.set(key, RelationComparisonResult.Failed | RelationComparisonResult.ComplexityOverflow);
    reportDiagnostic(
      c,
      createDiagnosticForNode(errorNode ?? c.currentNode, Diagnostics.Excessive_complexity_comparing_types_0_and_1, [
        typeToString(c, source),
        typeToString(c, target),
      ]),
      diagnosticOutput,
    );
  } else if (r.errorChain !== undefined) {
    const diagnostic = createDiagnosticFromErrorChain(r.errorChain, r.errorNode, r.relatedInfo);
    if (diagnostic !== undefined) reportDiagnostic(c, diagnostic, diagnosticOutput);
  }
  c.spareRelater = r;
  return result !== Ternary.False;
}

function reportDiagnostic(c: Checker, diagnostic: Diagnostic, output: Diagnostic[] | undefined): void {
  if (output !== undefined) output.push(diagnostic);
  else c.addDiagnostic(diagnostic);
}

/**
 * The diagnostic for an error chain, skipping elided messages; nested messages become its chain. As in tsgo, every
 * message of the chain has the location and related information of the error, which build info records.
 */
function createDiagnosticFromErrorChain(
  chain: ErrorChain | undefined,
  errorNode: Node | undefined,
  relatedInfo: Diagnostic[],
): Diagnostic | undefined {
  while (chain !== undefined && messageElidedInCompatibilityPyramid(chain.message)) chain = chain.next;
  if (chain === undefined) return undefined;
  const diagnostic = createDiagnosticForNode(errorNode, chain.message, chain.args);
  for (const info of relatedInfo) diagnostic.addRelatedInfo(info);
  let next = chain.next;
  let parent = diagnostic;
  while (next !== undefined) {
    if (!messageElidedInCompatibilityPyramid(next.message)) {
      const child = new Diagnostic(diagnostic.file, diagnostic.pos, diagnostic.end, next.message, next.args);
      for (const info of relatedInfo) child.addRelatedInfo(info);
      parent.addMessageChain(child);
      parent = child;
    }
    next = next.next;
  }
  return diagnostic;
}

class ErrorChain {
  readonly next: ErrorChain | undefined;
  readonly message: DiagnosticMessage;
  readonly args: string[];

  constructor(next: ErrorChain | undefined, message: DiagnosticMessage, args: string[]) {
    this.next = next;
    this.message = message;
    this.args = args;
  }
}

function chainDepth(chain: ErrorChain | undefined): number {
  let depth = 0;
  for (let e = chain; e !== undefined; e = e.next) depth++;
  return depth;
}

function getPropertyNameArg(arg: string): string {
  if (arg.length !== 0) {
    const ch = arg.charCodeAt(0);
    if (ch === 0x22 || ch === 0x27 || ch === 0x60) return '[' + arg + ']';
  }
  return arg;
}

function addToDottedName(head: string, tail: string): string {
  if (head.startsWith('new ')) head = '(' + head + ')';
  let pos = 0;
  for (;;) {
    if (tail.startsWith('(', pos)) pos++;
    else if (tail.startsWith('new ', pos)) pos += 4;
    else break;
  }
  const prefix = tail.substring(0, pos);
  const suffix = tail.substring(pos);
  return suffix.startsWith('[') ? prefix + head + suffix : prefix + head + '.' + suffix;
}

function isConversionOrInterfaceImplementationMessage(message: DiagnosticMessage | undefined): boolean {
  return (
    message === Diagnostics.Class_0_incorrectly_implements_interface_1 ||
    message ===
      Diagnostics.Class_0_incorrectly_implements_class_1_Did_you_mean_to_extend_1_and_inherit_its_members_as_a_subclass ||
    message ===
      Diagnostics.Conversion_of_type_0_to_type_1_may_be_a_mistake_because_neither_type_sufficiently_overlaps_with_the_other_If_this_was_intentional_convert_the_expression_to_unknown_first ||
    message === Diagnostics.Its_instance_type_0_is_not_a_valid_JSX_element ||
    message === Diagnostics.Its_return_type_0_is_not_a_valid_JSX_element ||
    message === Diagnostics.Its_element_type_0_is_not_a_valid_JSX_element
  );
}

// ---- The relater

/** The state of a relation check: its error chain, maybe-stack and recursion stacks. */
export class Relater extends TypeComparer {
  readonly c: Checker;
  relation: Relation;
  errorNode: Node | undefined;
  errorChain: ErrorChain | undefined = undefined;
  relatedInfo: Diagnostic[] = [];
  readonly maybeKeys: number[] = [];
  readonly maybeKeysSet = new Set<number>();
  /** Recursion stacks: the first `sourceDepth` and `targetDepth` entries are live. */
  readonly sourceStack: Type[] = [];
  readonly targetStack: Type[] = [];
  sourceDepth = 0;
  targetDepth = 0;
  expandingFlags: ExpandingFlags = ExpandingFlags.None;
  overflow = false;
  relationCount = 0;
  /** The keys this check added to the relation, while relating without reporting first. */
  addedKeys: number[] | undefined = undefined;
  /** The intersection state passed to `compare` during signature comparisons. */
  signatureIntersectionState: IntersectionState = IntersectionState.None;
  // What `relateVariances` changes in its caller's state when it falls back to structure.
  varianceSetsCheckFailed = false;
  varianceCheckFailed = false;
  varianceSetsErrorChain = false;
  varianceErrorChain: ErrorChain | undefined = undefined;

  constructor(c: Checker, relation: Relation, errorNode: Node | undefined) {
    super();
    this.c = c;
    this.relation = relation;
    this.errorNode = errorNode;
  }

  /** Prepares this relater for a new check, as if newly constructed. */
  reset(relation: Relation, errorNode: Node | undefined): void {
    this.relation = relation;
    this.errorNode = errorNode;
    this.errorChain = undefined;
    if (this.relatedInfo.length !== 0) this.relatedInfo = [];
    this.maybeKeys.length = 0;
    this.maybeKeysSet.clear();
    this.sourceDepth = 0;
    this.targetDepth = 0;
    this.expandingFlags = ExpandingFlags.None;
    this.overflow = false;
    this.relationCount = 0;
    this.signatureIntersectionState = IntersectionState.None;
  }

  compare(source: Type, target: Type, reportErrors: boolean): Ternary {
    return this.isRelatedToEx(
      source,
      target,
      RecursionFlags.Both,
      reportErrors,
      undefined,
      this.signatureIntersectionState,
    );
  }

  report(message: DiagnosticMessage, args: string[]): void {
    this.reportError(message, args);
  }

  isRelatedToSimple(source: Type, target: Type): Ternary {
    return this.isRelatedToEx(source, target, RecursionFlags.Both, false, undefined, IntersectionState.None);
  }

  isRelatedTo(source: Type, target: Type, recursionFlags: RecursionFlags, reportErrors: boolean): Ternary {
    return this.isRelatedToEx(source, target, recursionFlags, reportErrors, undefined, IntersectionState.None);
  }

  isRelatedToEx(
    originalSource: Type,
    originalTarget: Type,
    recursionFlags: RecursionFlags,
    reportErrors: boolean,
    headMessage: DiagnosticMessage | undefined,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    if (originalSource === originalTarget) return Ternary.True;
    // An object source and primitive target only need the simple check.
    if ((originalSource.flags & TypeFlags.Object) !== 0 && (originalTarget.flags & TypeFlags.Primitive) !== 0) {
      if (
        (this.relation === c.comparableRelation &&
          (originalTarget.flags & TypeFlags.Never) === 0 &&
          isSimpleTypeRelatedTo(c, originalTarget, originalSource, this.relation, undefined)) ||
        isSimpleTypeRelatedTo(c, originalSource, originalTarget, this.relation, reportErrors ? this : undefined)
      )
        return Ternary.True;
      if (reportErrors)
        this.reportErrorResults(originalSource, originalTarget, originalSource, originalTarget, headMessage);
      return Ternary.False;
    }
    // Normalize: regular literals, non-deferred references, simplified types, resolved substitutions.
    const source = getNormalizedType(c, originalSource, false);
    let target = getNormalizedType(c, originalTarget, true);
    if (source === target) return Ternary.True;
    if (this.relation === c.identityRelation) {
      if (source.flags !== target.flags) return Ternary.False;
      if ((source.flags & TypeFlags.Singleton) !== 0) return Ternary.True;
      return this.recursiveTypeRelatedTo(source, target, false, IntersectionState.None, recursionFlags);
    }
    // Fast path: a type parameter related to exactly its constraint.
    if ((source.flags & TypeFlags.TypeParameter) !== 0 && getConstraintOfType(c, source) === target)
      return Ternary.True;
    // A definitely non-nullable source against `T | null | undefined` only needs T.
    if ((source.flags & TypeFlags.DefinitelyNonNullable) !== 0 && (target.flags & TypeFlags.Union) !== 0) {
      const types = typesOf(target);
      let candidate: Type | undefined;
      if (types.length === 2 && (types[0]!.flags & TypeFlags.Nullable) !== 0) candidate = types[1]!;
      else if (
        types.length === 3 &&
        (types[0]!.flags & TypeFlags.Nullable) !== 0 &&
        (types[1]!.flags & TypeFlags.Nullable) !== 0
      )
        candidate = types[2]!;
      if (candidate !== undefined && (candidate.flags & TypeFlags.Nullable) === 0) {
        target = getNormalizedType(c, candidate, true);
        if (source === target) return Ternary.True;
      }
    }
    if (
      (this.relation === c.comparableRelation &&
        (target.flags & TypeFlags.Never) === 0 &&
        isSimpleTypeRelatedTo(c, target, source, this.relation, undefined)) ||
      isSimpleTypeRelatedTo(c, source, target, this.relation, reportErrors ? this : undefined)
    )
      return Ternary.True;
    if (
      (source.flags & TypeFlags.StructuredOrInstantiable) !== 0 ||
      (target.flags & TypeFlags.StructuredOrInstantiable) !== 0
    ) {
      const isPerformingExcessPropertyChecks =
        (intersectionState & IntersectionState.Target) === 0 &&
        isObjectLiteralType(source) &&
        (source.objectFlags & ObjectFlags.FreshLiteral) !== 0;
      if (isPerformingExcessPropertyChecks && this.hasExcessProperties(source, target, reportErrors)) {
        if (reportErrors)
          this.reportRelationError(headMessage, source, originalTarget.alias !== undefined ? originalTarget : target);
        return Ternary.False;
      }
      const isPerformingCommonPropertyChecks =
        (this.relation !== c.comparableRelation || isUnitType(source)) &&
        (intersectionState & IntersectionState.Target) === 0 &&
        (source.flags & (TypeFlags.Primitive | TypeFlags.Object | TypeFlags.Intersection)) !== 0 &&
        source !== c.globalObjectType &&
        (target.flags & (TypeFlags.Object | TypeFlags.Intersection)) !== 0 &&
        isWeakType(c, target) &&
        (getPropertiesOfType(c, source).length > 0 || typeHasCallOrConstructSignatures(c, source));
      const isComparingJsxAttributes = (source.objectFlags & ObjectFlags.JsxAttributes) !== 0;
      if (isPerformingCommonPropertyChecks && !hasCommonProperties(c, source, target, isComparingJsxAttributes)) {
        if (reportErrors) {
          const sourceString = typeToString(c, originalSource.alias !== undefined ? originalSource : source);
          const targetString = typeToString(c, originalTarget.alias !== undefined ? originalTarget : target);
          const calls = getSignaturesOfType(c, source, SignatureKind.Call);
          const constructs = getSignaturesOfType(c, source, SignatureKind.Construct);
          if (
            (calls.length > 0 &&
              this.isRelatedTo(getReturnTypeOfSignature(c, calls[0]!), target, RecursionFlags.Source, false) !==
                Ternary.False) ||
            (constructs.length > 0 &&
              this.isRelatedTo(getReturnTypeOfSignature(c, constructs[0]!), target, RecursionFlags.Source, false) !==
                Ternary.False)
          )
            this.reportError(
              Diagnostics.Value_of_type_0_has_no_properties_in_common_with_type_1_Did_you_mean_to_call_it,
              [sourceString, targetString],
            );
          else
            this.reportError(Diagnostics.Type_0_has_no_properties_in_common_with_type_1, [sourceString, targetString]);
        }
        return Ternary.False;
      }
      const skipCaching =
        ((source.flags & TypeFlags.Union) !== 0 &&
          typesOf(source).length < 4 &&
          (target.flags & TypeFlags.Union) === 0) ||
        ((target.flags & TypeFlags.Union) !== 0 &&
          typesOf(target).length < 4 &&
          (source.flags & TypeFlags.StructuredOrInstantiable) === 0);
      const result = skipCaching
        ? this.unionOrIntersectionRelatedTo(source, target, reportErrors, intersectionState)
        : this.recursiveTypeRelatedTo(source, target, reportErrors, intersectionState, recursionFlags);
      if (result !== Ternary.False) return result;
    }
    if (reportErrors) this.reportErrorResults(originalSource, originalTarget, source, target, headMessage);
    return Ternary.False;
  }

  hasExcessProperties(source: Type, target: Type, reportErrors: boolean): boolean {
    const c = this.c;
    if (
      !isExcessPropertyCheckTarget(target) ||
      (!c.noImplicitAny && (target.objectFlags & ObjectFlags.JSLiteral) !== 0)
    )
      return false;
    const isComparingJsxAttributes = (source.objectFlags & ObjectFlags.JsxAttributes) !== 0;
    if (
      (this.relation === c.assignableRelation || this.relation === c.comparableRelation) &&
      (isTypeSubsetOf(c, c.globalObjectType, target) || (!isComparingJsxAttributes && isEmptyObjectType(c, target)))
    )
      return false;
    let reducedTarget = target;
    let checkTypes: Type[] | undefined;
    if ((target.flags & TypeFlags.Union) !== 0) {
      reducedTarget =
        findMatchingDiscriminantType(c, source, target, this) ?? filterPrimitivesIfContainsNonPrimitive(c, target);
      checkTypes =
        (reducedTarget.flags & TypeFlags.Union) !== 0
          ? typesOf(reducedTarget)
          : (reducedTarget.flags & TypeFlags.Never) !== 0
            ? emptyTypes
            : [reducedTarget];
    }
    for (const prop of getPropertiesOfType(c, source)) {
      if (!shouldCheckAsExcessProperty(prop, source.symbol) || isIgnoredJsxProperty(source, prop)) continue;
      if (!isKnownProperty(c, reducedTarget, prop.name, isComparingJsxAttributes)) {
        if (reportErrors) {
          // Report in terms of the object types we check in isKnownProperty, at the property.
          const errorTarget = filterType(c, reducedTarget, isExcessPropertyCheckTarget);
          const errorNode = this.errorNode!;
          if (
            errorNode.kind === SyntaxKind.JsxAttributes ||
            isJsxOpeningLikeElement(errorNode) ||
            (errorNode.parent !== undefined && isJsxOpeningLikeElement(errorNode.parent))
          ) {
            // Attributes are checked like object literals but reported as attributes, at the attribute.
            const valueDeclaration = prop.valueDeclaration;
            if (
              valueDeclaration !== undefined &&
              valueDeclaration.kind === SyntaxKind.JsxAttribute &&
              sameFile(valueDeclaration, errorNode)
            )
              this.errorNode = getName(valueDeclaration)!;
            const propName = symbolToString(c, prop);
            const suggestion = getSuggestedSymbolForNonexistentJSXAttribute(c, propName, errorTarget);
            if (suggestion !== undefined)
              this.reportError(Diagnostics.Property_0_does_not_exist_on_type_1_Did_you_mean_2, [
                propName,
                typeToString(c, errorTarget),
                symbolToString(c, suggestion),
              ]);
            else
              this.reportError(Diagnostics.Property_0_does_not_exist_on_type_1, [
                propName,
                typeToString(c, errorTarget),
              ]);
            return true;
          }
          const objectLiteralDeclaration =
            source.symbol !== undefined && declarationCount(source.symbol) !== 0
              ? source.symbol.declaration!
              : undefined;
          const valueDeclaration = prop.valueDeclaration;
          let suggestion: Symbol | undefined = undefined;
          if (
            valueDeclaration !== undefined &&
            isObjectLiteralElement(valueDeclaration) &&
            objectLiteralDeclaration !== undefined &&
            isAncestor(valueDeclaration, objectLiteralDeclaration) &&
            sameFile(objectLiteralDeclaration, this.errorNode)
          ) {
            const name = getName(valueDeclaration)!;
            this.errorNode = name;
            if (name.kind === SyntaxKind.Identifier)
              suggestion = getSpellingSuggestionForName(
                c,
                getText(name),
                getPropertiesOfType(c, errorTarget),
                SymbolFlags.Value,
              );
          }
          if (suggestion !== undefined)
            this.reportError(
              Diagnostics.Object_literal_may_only_specify_known_properties_but_0_does_not_exist_in_type_1_Did_you_mean_to_write_2,
              [symbolToString(c, prop), typeToString(c, errorTarget), suggestion.name],
            );
          else
            this.reportError(
              Diagnostics.Object_literal_may_only_specify_known_properties_and_0_does_not_exist_in_type_1,
              [symbolToString(c, prop), typeToString(c, errorTarget)],
            );
        }
        return true;
      }
      if (
        checkTypes !== undefined &&
        this.isRelatedTo(
          getTypeOfSymbol(c, prop),
          getTypeOfPropertyInTypes(c, checkTypes, prop.name),
          RecursionFlags.Both,
          reportErrors,
        ) === Ternary.False
      ) {
        if (reportErrors) this.reportError(Diagnostics.Types_of_property_0_are_incompatible, [symbolToString(c, prop)]);
        return true;
      }
    }
    return false;
  }

  unionOrIntersectionRelatedTo(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    // Unions are deconstructed before intersections, and "each" before "some".
    if ((source.flags & TypeFlags.Union) !== 0) {
      if ((target.flags & TypeFlags.Union) !== 0) {
        // A union from an intersection containing the target is related to it.
        const sourceOrigin = (source as UnionType).origin;
        if (
          sourceOrigin !== undefined &&
          (sourceOrigin.flags & TypeFlags.Intersection) !== 0 &&
          target.alias !== undefined &&
          typesOf(sourceOrigin).includes(target)
        )
          return Ternary.True;
        const targetOrigin = (target as UnionType).origin;
        if (
          targetOrigin !== undefined &&
          (targetOrigin.flags & TypeFlags.Union) !== 0 &&
          source.alias !== undefined &&
          typesOf(targetOrigin).includes(source)
        )
          return Ternary.True;
      }
      if (this.relation === c.comparableRelation)
        return this.someTypeRelatedToType(
          source,
          target,
          reportErrors && (source.flags & TypeFlags.Primitive) === 0,
          intersectionState,
        );
      return this.eachTypeRelatedToType(
        source,
        target,
        reportErrors && (source.flags & TypeFlags.Primitive) === 0,
        intersectionState,
      );
    }
    if ((target.flags & TypeFlags.Union) !== 0)
      return this.typeRelatedToSomeType(
        getRegularTypeOfObjectLiteral(c, source),
        target,
        reportErrors && (source.flags & TypeFlags.Primitive) === 0 && (target.flags & TypeFlags.Primitive) === 0,
        intersectionState,
      );
    if ((target.flags & TypeFlags.Intersection) !== 0)
      return this.typeRelatedToEachType(source, target, reportErrors, IntersectionState.Target);
    // For comparability with a primitive, hoist the constraints of instantiable constituents.
    if (this.relation === c.comparableRelation && (target.flags & TypeFlags.Primitive) !== 0) {
      const types = typesOf(source);
      let changed = false;
      const constraints: Type[] = [];
      for (const t of types) {
        const u = (t.flags & TypeFlags.Instantiable) !== 0 ? (getBaseConstraintOfType(c, t) ?? c.unknownType) : t;
        if (u !== t) changed = true;
        constraints.push(u);
      }
      if (changed) {
        const reduced = getIntersectionType(c, constraints);
        if ((reduced.flags & TypeFlags.Never) !== 0) return Ternary.False;
        if ((reduced.flags & TypeFlags.Intersection) === 0) {
          const result = this.isRelatedTo(reduced, target, RecursionFlags.Source, false);
          if (result !== Ternary.False) return result;
          return this.isRelatedTo(target, reduced, RecursionFlags.Source, false);
        }
        source = reduced;
      }
    }
    // Constituents related to the target, without elaboration.
    return this.someTypeRelatedToType(source, target, false, IntersectionState.Source);
  }

  someTypeRelatedToType(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const sourceTypes = typesOf(source);
    if ((source.flags & TypeFlags.Union) !== 0 && unionContainsType(this.c, source as UnionType, target))
      return Ternary.True;
    for (let i = 0; i < sourceTypes.length; i++) {
      const related = this.isRelatedToEx(
        sourceTypes[i]!,
        target,
        RecursionFlags.Source,
        reportErrors && i === sourceTypes.length - 1,
        undefined,
        intersectionState,
      );
      if (related !== Ternary.False) return related;
    }
    return Ternary.False;
  }

  eachTypeRelatedToType(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    let result = Ternary.True;
    const sourceTypes = typesOf(source);
    // Strip undefined from the target when the source can't contain it, for the correspondence fast path.
    const strippedTarget = this.getUndefinedStrippedTargetIfNeeded(source, target);
    const strippedTypes = (strippedTarget.flags & TypeFlags.Union) !== 0 ? typesOf(strippedTarget) : emptyTypes;
    for (let i = 0; i < sourceTypes.length; i++) {
      const sourceType = sourceTypes[i]!;
      if (
        (strippedTarget.flags & TypeFlags.Union) !== 0 &&
        sourceTypes.length >= strippedTypes.length &&
        sourceTypes.length % strippedTypes.length === 0
      ) {
        // Unions that map one another relate element-wise.
        const related = this.isRelatedToEx(
          sourceType,
          strippedTypes[i % strippedTypes.length]!,
          RecursionFlags.Both,
          false,
          undefined,
          intersectionState,
        );
        if (related !== Ternary.False) {
          result &= related;
          continue;
        }
      }
      const related = this.isRelatedToEx(
        sourceType,
        target,
        RecursionFlags.Source,
        reportErrors,
        undefined,
        intersectionState,
      );
      if (related === Ternary.False) return Ternary.False;
      result &= related;
    }
    return result;
  }

  getUndefinedStrippedTargetIfNeeded(source: Type, target: Type): Type {
    if (
      (source.flags & TypeFlags.Union) !== 0 &&
      (target.flags & TypeFlags.Union) !== 0 &&
      (typesOf(source)[0]!.flags & TypeFlags.Undefined) === 0 &&
      (typesOf(target)[0]!.flags & TypeFlags.Undefined) !== 0
    )
      return filterType(this.c, target, (t) => (t.flags & TypeFlags.Undefined) === 0);
    return target;
  }

  typeRelatedToSomeType(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    const targetTypes = typesOf(target);
    if ((target.flags & TypeFlags.Union) !== 0) {
      if (unionContainsType(c, target as UnionType, source)) return Ternary.True;
      if (isLiteralRelatedByPrimitiveUnionForms(c, source, target, this.relation))
        return literalRelatedToPrimitiveUnion(c, source, target as UnionType) ? Ternary.True : Ternary.False;
      const match = getMatchingUnionConstituentForType(c, target as UnionType, source);
      if (match !== undefined) {
        const related = this.isRelatedToEx(source, match, RecursionFlags.Target, false, undefined, intersectionState);
        if (related !== Ternary.False) return related;
      }
    }
    for (const t of targetTypes) {
      const related = this.isRelatedToEx(source, t, RecursionFlags.Target, false, undefined, intersectionState);
      if (related !== Ternary.False) return related;
    }
    if (reportErrors) {
      // Elaborate only against a best matching constituent.
      const best = getBestMatchingType(c, source, target, this);
      if (best !== undefined)
        this.isRelatedToEx(source, best, RecursionFlags.Target, true, undefined, intersectionState);
    }
    return Ternary.False;
  }

  typeRelatedToEachType(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    let result = Ternary.True;
    for (const targetType of typesOf(target)) {
      const related = this.isRelatedToEx(
        source,
        targetType,
        RecursionFlags.Target,
        reportErrors,
        undefined,
        intersectionState,
      );
      if (related === Ternary.False) return Ternary.False;
      result &= related;
    }
    return result;
  }

  eachTypeRelatedToSomeType(source: Type, target: Type): Ternary {
    let result = Ternary.True;
    for (const sourceType of typesOf(source)) {
      const related = this.typeRelatedToSomeType(sourceType, target, false, IntersectionState.None);
      if (related === Ternary.False) return Ternary.False;
      result &= related;
    }
    return result;
  }

  /**
   * Relates possibly recursive types: uses the global cache, assumes related when already
   * comparing the pair, assumes related for deeply nested expansions, and overflows at depth 100.
   */
  recursiveTypeRelatedTo(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
    recursionFlags: RecursionFlags,
  ): Ternary {
    const c = this.c;
    if (this.overflow) return Ternary.False;
    const keyInfo = getRelationKey(c, source, target, intersectionState, this.relation === c.identityRelation, false);
    const id = keyInfo.key;
    const constrained = keyInfo.constrained;
    const entry = this.relation.get(id);
    if (entry !== RelationComparisonResult.None) {
      if (
        reportErrors &&
        (entry & RelationComparisonResult.Failed) !== 0 &&
        (entry & RelationComparisonResult.Overflow) === 0
      ) {
        // Redo the failed comparison to elaborate.
      } else {
        c.reliabilityFlags |=
          entry & (RelationComparisonResult.ReportsUnmeasurable | RelationComparisonResult.ReportsUnreliable);
        if (reportErrors && (entry & RelationComparisonResult.Overflow) !== 0)
          this.reportError(Diagnostics.Excessive_complexity_comparing_types_0_and_1, [
            typeToString(c, source),
            typeToString(c, target),
          ]);
        return (entry & RelationComparisonResult.Succeeded) !== 0 ? Ternary.True : Ternary.False;
      }
    }
    if (this.relationCount <= 0) {
      this.overflow = true;
      return Ternary.False;
    }
    if (this.maybeKeysSet.has(id)) return Ternary.Maybe;
    // Constrained keys also check the key with all type parameters unconstrained.
    if (constrained) {
      const broadest = getRelationKey(
        c,
        source,
        target,
        intersectionState,
        this.relation === c.identityRelation,
        true,
      ).key;
      if (this.maybeKeysSet.has(broadest)) return Ternary.Maybe;
    }
    const sourceDepth = this.sourceDepth;
    const targetDepth = this.targetDepth;
    // A backstop for infinite recursion that isDeeplyNestedType misses, which also stops relating the exceedingly
    // rare types that are truly more than 100 levels deep.
    if (sourceDepth === 100 || targetDepth === 100) return Ternary.Maybe;
    const maybeStart = this.maybeKeys.length;
    this.maybeKeys.push(id);
    this.maybeKeysSet.add(id);
    const saveExpandingFlags = this.expandingFlags;
    if ((recursionFlags & RecursionFlags.Source) !== 0) {
      setStackEntry(this.sourceStack, sourceDepth, source);
      this.sourceDepth = sourceDepth + 1;
      if (
        (this.expandingFlags & ExpandingFlags.Source) === 0 &&
        isDeeplyNestedType(c, source, this.sourceStack, sourceDepth + 1, 3)
      )
        this.expandingFlags |= ExpandingFlags.Source;
    }
    if ((recursionFlags & RecursionFlags.Target) !== 0) {
      setStackEntry(this.targetStack, targetDepth, target);
      this.targetDepth = targetDepth + 1;
      if (
        (this.expandingFlags & ExpandingFlags.Target) === 0 &&
        isDeeplyNestedType(c, target, this.targetStack, targetDepth + 1, 3)
      )
        this.expandingFlags |= ExpandingFlags.Target;
    }
    const saveReliabilityFlags = c.reliabilityFlags;
    c.reliabilityFlags = 0;
    const result =
      this.expandingFlags === ExpandingFlags.Both
        ? Ternary.Maybe
        : this.structuredTypeRelatedTo(source, target, reportErrors, intersectionState);
    const propagatingVarianceFlags = c.reliabilityFlags;
    c.reliabilityFlags |= saveReliabilityFlags;
    this.sourceDepth = sourceDepth;
    this.targetDepth = targetDepth;
    this.expandingFlags = saveExpandingFlags;
    if (result !== Ternary.False) {
      if (result === Ternary.True || (sourceDepth === 0 && targetDepth === 0)) {
        // True results, and Maybe results at depth 0, succeed; Unknown is never recorded.
        this.resetMaybeStack(maybeStart, propagatingVarianceFlags, result === Ternary.True || result === Ternary.Maybe);
      }
    } else {
      // False under assumptions is false without them.
      this.record(id, RelationComparisonResult.Failed | propagatingVarianceFlags);
      this.relationCount--;
      this.resetMaybeStack(maybeStart, propagatingVarianceFlags, false);
    }
    return result;
  }

  record(key: number, result: number): void {
    if (this.relation.set(key, result) && this.addedKeys !== undefined) this.addedKeys.push(key);
  }

  resetMaybeStack(maybeStart: number, propagatingVarianceFlags: number, markAllAsSucceeded: boolean): void {
    for (let i = maybeStart; i < this.maybeKeys.length; i++) {
      this.maybeKeysSet.delete(this.maybeKeys[i]!);
      if (markAllAsSucceeded) {
        this.record(this.maybeKeys[i]!, RelationComparisonResult.Succeeded | propagatingVarianceFlags);
        this.relationCount--;
      }
    }
    this.maybeKeys.length = maybeStart;
  }

  structuredTypeRelatedTo(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    const saveChain = this.errorChain;
    const saveRelated = this.relatedInfo;
    let result = this.structuredTypeRelatedToWorker(
      source,
      target,
      reportErrors,
      intersectionState,
      saveChain,
      saveRelated,
    );
    if (this.relation !== c.identityRelation) {
      // The combined constraint of an intersection (or a type parameter against a union) may relate.
      if (
        result === Ternary.False &&
        ((source.flags & TypeFlags.Intersection) !== 0 ||
          ((source.flags & TypeFlags.TypeParameter) !== 0 && (target.flags & TypeFlags.Union) !== 0))
      ) {
        const sourceTypes = (source.flags & TypeFlags.Intersection) !== 0 ? typesOf(source) : [source];
        const constraint = getEffectiveConstraintOfIntersection(c, sourceTypes, (target.flags & TypeFlags.Union) !== 0);
        if (constraint !== undefined && everyType(constraint, (u) => u !== source))
          result = this.isRelatedToEx(constraint, target, RecursionFlags.Source, false, undefined, intersectionState);
      }
      // Intersection targets need an extra property check for nested excess properties and weak types.
      if (
        result !== Ternary.False &&
        (intersectionState & IntersectionState.Target) === 0 &&
        (target.flags & TypeFlags.Intersection) !== 0 &&
        !isGenericObjectType(c, target) &&
        (source.flags & (TypeFlags.Object | TypeFlags.Intersection)) !== 0
      ) {
        result &= this.propertiesRelatedTo(source, target, reportErrors, undefined, false, IntersectionState.None);
        if (
          result !== Ternary.False &&
          isObjectLiteralType(source) &&
          (source.objectFlags & ObjectFlags.FreshLiteral) !== 0
        )
          result &= this.indexSignaturesRelatedTo(source, target, false, reportErrors, IntersectionState.None);
      } else if (
        result !== Ternary.False &&
        isNonGenericObjectType(c, target) &&
        !isArrayOrTupleType(c, target) &&
        isSourceIntersectionNeedingExtraCheck(c, source, target)
      )
        // Source intersections check optional target properties for mismatched types.
        result &= this.propertiesRelatedTo(source, target, reportErrors, undefined, true, intersectionState);
    }
    if (result !== Ternary.False) {
      this.errorChain = saveChain;
      this.relatedInfo = saveRelated;
    }
    return result;
  }

  /**
   * Relates the type arguments of `structuredTypeRelatedToWorker`'s source and target by variance:
   * a result when variance decides, else undefined to fall back to structure, with the caller's
   * `varianceCheckFailed` and original error chain to update in the fields above. (A method rather
   * than a closure over the caller's locals, which native builds would allocate on every call.)
   */
  relateVariances(
    sourceArgs: Type[],
    targetArgs: Type[],
    variances: VarianceFlags[],
    reportErrors: boolean,
    intersectionState: IntersectionState,
    saveChain: ErrorChain | undefined,
    saveRelated: Diagnostic[],
  ): Ternary | undefined {
    const result = this.typeArgumentsRelatedTo(sourceArgs, targetArgs, variances, reportErrors, intersectionState);
    if (result !== Ternary.False) return result;
    if (someVarianceHasFlags(variances, VarianceFlags.AllowsStructuralFallback)) {
      // Unmeasurable or unreliable variance: elide variance errors and compare structurally.
      this.varianceSetsCheckFailed = false;
      this.varianceSetsErrorChain = true;
      this.varianceErrorChain = undefined;
      this.errorChain = saveChain;
      this.relatedInfo = saveRelated;
      return undefined;
    }
    const allowStructuralFallback = hasCovariantVoidArgument(targetArgs, variances);
    this.varianceSetsCheckFailed = true;
    this.varianceCheckFailed = !allowStructuralFallback;
    this.varianceSetsErrorChain = false;
    if (variances.length !== 0 && !allowStructuralFallback) {
      // With invariant parameters, compare structurally to explain why.
      if (!(reportErrors && someVarianceIsInvariant(variances))) return Ternary.False;
      this.varianceSetsErrorChain = true;
      this.varianceErrorChain = this.errorChain;
      this.errorChain = saveChain;
      this.relatedInfo = saveRelated;
    }
    return undefined;
  }

  structuredTypeRelatedToWorker(
    source: Type,
    target: Type,
    reportErrors: boolean,
    intersectionState: IntersectionState,
    saveChain: ErrorChain | undefined,
    saveRelated: Diagnostic[],
  ): Ternary {
    const c = this.c;
    let result: Ternary = Ternary.False;
    let varianceCheckFailed = false;
    let originalErrorChain: ErrorChain | undefined;
    if (this.relation === c.identityRelation) {
      // Flags are known to be identical.
      if ((source.flags & TypeFlags.UnionOrIntersection) !== 0) {
        let r = this.eachTypeRelatedToSomeType(source, target);
        if (r !== Ternary.False) r &= this.eachTypeRelatedToSomeType(target, source);
        return r;
      }
      if ((source.flags & TypeFlags.Index) !== 0)
        return this.isRelatedTo((source as IndexType).target, (target as IndexType).target, RecursionFlags.Both, false);
      if ((source.flags & TypeFlags.IndexedAccess) !== 0) {
        const s = source as IndexedAccessType;
        const t = target as IndexedAccessType;
        result = this.isRelatedTo(s.objectType, t.objectType, RecursionFlags.Both, false);
        if (result !== Ternary.False) {
          result &= this.isRelatedTo(s.indexType, t.indexType, RecursionFlags.Both, false);
          if (result !== Ternary.False) return result;
        }
      } else if ((source.flags & TypeFlags.Conditional) !== 0) {
        const s = source as ConditionalType;
        const t = target as ConditionalType;
        if (s.root.isDistributive === t.root.isDistributive) {
          result = this.isRelatedTo(s.checkType, t.checkType, RecursionFlags.Both, false);
          if (result !== Ternary.False)
            result &= this.isRelatedTo(s.extendsType, t.extendsType, RecursionFlags.Both, false);
          if (result !== Ternary.False)
            result &= this.isRelatedTo(
              getTrueTypeFromConditionalType(c, s),
              getTrueTypeFromConditionalType(c, t),
              RecursionFlags.Both,
              false,
            );
          if (result !== Ternary.False)
            result &= this.isRelatedTo(
              getFalseTypeFromConditionalType(c, s),
              getFalseTypeFromConditionalType(c, t),
              RecursionFlags.Both,
              false,
            );
          if (result !== Ternary.False) return result;
        }
      } else if ((source.flags & TypeFlags.Substitution) !== 0) {
        const s = source as SubstitutionType;
        const t = target as SubstitutionType;
        result = this.isRelatedTo(s.baseType, t.baseType, RecursionFlags.Both, false);
        if (result !== Ternary.False) {
          result &= this.isRelatedTo(s.constraint, t.constraint, RecursionFlags.Both, false);
          if (result !== Ternary.False) return result;
        }
      } else if ((source.flags & TypeFlags.TemplateLiteral) !== 0) {
        const s = source as TemplateLiteralType;
        const t = target as TemplateLiteralType;
        if (s.texts.length === t.texts.length && s.texts.every((x, i) => x === t.texts[i]!)) {
          result = Ternary.True;
          for (let i = 0; i < s.types.length; i++) {
            result &= this.isRelatedTo(s.types[i]!, t.types[i]!, RecursionFlags.Both, false);
            if (result === Ternary.False) return result;
          }
          return result;
        }
      } else if ((source.flags & TypeFlags.StringMapping) !== 0) {
        if (source.symbol === target.symbol)
          return this.isRelatedTo(
            (source as StringMappingType).target,
            (target as StringMappingType).target,
            RecursionFlags.Both,
            false,
          );
      }
      if ((source.flags & TypeFlags.Object) === 0) return Ternary.False;
    } else if (
      (source.flags & TypeFlags.UnionOrIntersection) !== 0 ||
      (target.flags & TypeFlags.UnionOrIntersection) !== 0
    ) {
      result = this.unionOrIntersectionRelatedTo(source, target, reportErrors, intersectionState);
      if (result !== Ternary.False) return result;
      // Remaining cases: instantiable source, object against union, intersection against object, union or instantiable.
      if (
        !(
          (source.flags & TypeFlags.Instantiable) !== 0 ||
          ((source.flags & TypeFlags.Object) !== 0 && (target.flags & TypeFlags.Union) !== 0) ||
          ((source.flags & TypeFlags.Intersection) !== 0 &&
            (target.flags & (TypeFlags.Object | TypeFlags.Union | TypeFlags.Instantiable)) !== 0)
        )
      )
        return Ternary.False;
    }
    // Alias variance probing, for object and conditional types only.
    if (
      (source.flags & (TypeFlags.Object | TypeFlags.Conditional)) !== 0 &&
      source.alias !== undefined &&
      source.alias.typeArguments.length !== 0 &&
      target.alias !== undefined &&
      source.alias.symbol === target.alias.symbol &&
      !(isMarkerType(c, source) || isMarkerType(c, target))
    ) {
      const variances = getAliasVariances(c, source.alias.symbol);
      if (variances.length === 0) return Ternary.Unknown;
      const params = c.symbolLinks(source.alias.symbol).typeParameters ?? emptyTypes;
      const minParams = getMinTypeArgumentCount(c, params);
      const inJS =
        source.alias.symbol.valueDeclaration !== undefined &&
        (source.alias.symbol.valueDeclaration.flags & (1 << 16)) !== 0;
      const sourceTypes = fillMissingTypeArguments(c, source.alias.typeArguments, params, minParams, inJS);
      const targetTypes = fillMissingTypeArguments(c, target.alias.typeArguments, params, minParams, inJS);
      const varianceResult = this.relateVariances(
        sourceTypes,
        targetTypes,
        variances,
        reportErrors,
        intersectionState,
        saveChain,
        saveRelated,
      );
      if (varianceResult !== undefined) return varianceResult;
      result = Ternary.False;
      if (this.varianceSetsCheckFailed) varianceCheckFailed = this.varianceCheckFailed;
      if (this.varianceSetsErrorChain) originalErrorChain = this.varianceErrorChain;
    }
    // [...U] relates where U does, and U to readonly [...T] or to [...T] for mutable array constraints.
    if (isSingleElementGenericTupleType(source) && !tupleTargetOf(source).readonly) {
      result = this.isRelatedTo(getTypeArguments(c, source)[0]!, target, RecursionFlags.Source, false);
      if (result !== Ternary.False) return result;
    }
    if (
      isSingleElementGenericTupleType(target) &&
      (tupleTargetOf(target).readonly || isMutableArrayOrTuple(c, getBaseConstraintOrType(c, source)))
    ) {
      result = this.isRelatedTo(source, getTypeArguments(c, target)[0]!, RecursionFlags.Target, false);
      if (result !== Ternary.False) return result;
    }
    if ((target.flags & TypeFlags.TypeParameter) !== 0) {
      // `{ [P in Q]: X }` relates to T when keyof T relates to Q and X to T[Q].
      if (
        (source.objectFlags & ObjectFlags.Mapped) !== 0 &&
        (source.flags & TypeFlags.Object) !== 0 &&
        getNameTypeFromMappedType(c, source as MappedType) === undefined &&
        this.isRelatedTo(
          getIndexType(c, target),
          getConstraintTypeFromMappedType(c, source as MappedType),
          RecursionFlags.Both,
          false,
        ) !== Ternary.False
      ) {
        if ((getMappedTypeModifiers(source as MappedType) & MappedTypeModifiers.IncludeOptional) === 0) {
          const templateType = getTemplateTypeFromMappedType(c, source as MappedType);
          const indexedAccessType = getIndexedAccessType(
            c,
            target,
            getTypeParameterFromMappedType(c, source as MappedType),
          );
          result = this.isRelatedTo(templateType, indexedAccessType, RecursionFlags.Both, reportErrors);
          if (result !== Ternary.False) return result;
        }
      }
      if (this.relation === c.comparableRelation && (source.flags & TypeFlags.TypeParameter) !== 0) {
        // Type parameters are comparable only when one extends the other.
        const constraint = getConstraintFromTypeParameterChecked(c, source);
        if (constraint !== undefined && someType(constraint, (u) => (u.flags & TypeFlags.TypeParameter) !== 0))
          return this.isRelatedTo(constraint, target, RecursionFlags.Source, false);
        return Ternary.False;
      }
    } else if ((target.flags & TypeFlags.IndexedAccess) !== 0) {
      if ((source.flags & TypeFlags.IndexedAccess) !== 0) {
        // S[K] relates to T[J] when S relates to T and K to J.
        const s = source as IndexedAccessType;
        const t = target as IndexedAccessType;
        result = this.isRelatedTo(s.objectType, t.objectType, RecursionFlags.Both, reportErrors);
        if (result !== Ternary.False)
          result &= this.isRelatedTo(s.indexType, t.indexType, RecursionFlags.Both, reportErrors);
        if (result !== Ternary.False) return result;
        if (reportErrors) originalErrorChain = this.errorChain;
      }
      // S relates to T[K] when it relates to the base constraint of T[K] for writing.
      if (this.relation === c.assignableRelation || this.relation === c.comparableRelation) {
        const t = target as IndexedAccessType;
        const baseObjectType = getBaseConstraintOrType(c, t.objectType);
        const baseIndexType = getBaseConstraintOrType(c, t.indexType);
        if (!isGenericObjectType(c, baseObjectType) && !isGenericIndexType(c, baseIndexType)) {
          const accessFlags = (1 << 2) | (baseObjectType !== t.objectType ? 1 << 1 : 0);
          const constraint = getIndexedAccessTypeOrUndefined(c, baseObjectType, baseIndexType, accessFlags);
          if (constraint !== undefined) {
            if (reportErrors && originalErrorChain !== undefined) {
              this.errorChain = saveChain;
              this.relatedInfo = saveRelated;
            }
            result = this.isRelatedToEx(
              source,
              constraint,
              RecursionFlags.Target,
              reportErrors,
              undefined,
              intersectionState,
            );
            if (result !== Ternary.False) return result;
            // Prefer the shorter of the two chains.
            if (
              reportErrors &&
              originalErrorChain !== undefined &&
              this.errorChain !== undefined &&
              chainDepth(originalErrorChain) <= chainDepth(this.errorChain)
            )
              this.errorChain = originalErrorChain;
          }
        }
      }
      if (reportErrors) originalErrorChain = undefined;
    } else if ((target.flags & TypeFlags.Index) !== 0) {
      const targetType = (target as IndexType).target;
      // keyof S relates to keyof T when T relates to S.
      if ((source.flags & TypeFlags.Index) !== 0) {
        result = this.isRelatedTo(targetType, (source as IndexType).target, RecursionFlags.Both, false);
        if (result !== Ternary.False) return result;
      }
      if (isTupleType(targetType)) {
        result = this.isRelatedTo(source, getKnownKeysOfTupleType(c, targetType), RecursionFlags.Target, reportErrors);
        if (result !== Ternary.False) return result;
      } else {
        const constraint = getSimplifiedTypeOrConstraint(c, targetType);
        if (constraint !== undefined) {
          // Require True so circular constraints don't produce false positives.
          if (
            this.isRelatedTo(
              source,
              getIndexTypeEx(c, constraint, (target as IndexType).indexFlags | IndexFlags.NoReducibleCheck),
              RecursionFlags.Target,
              reportErrors,
            ) === Ternary.True
          )
            return Ternary.True;
        } else if (isGenericMappedType(c, targetType)) {
          const nameType = getNameTypeFromMappedType(c, targetType as MappedType);
          const constraintType = getConstraintTypeFromMappedType(c, targetType as MappedType);
          // Keys missing from the constraint may still be mapped from the apparent keys of the
          // modifiers type; the still generic name type is kept too.
          const targetKeys =
            nameType !== undefined && isMappedTypeWithKeyofConstraintDeclaration(c, targetType as MappedType)
              ? getUnionType(c, [getApparentMappedTypeKeys(c, nameType, targetType as MappedType), nameType])
              : (nameType ?? constraintType);
          if (this.isRelatedTo(source, targetKeys, RecursionFlags.Target, reportErrors) === Ternary.True)
            return Ternary.True;
        }
      }
    } else if ((target.flags & TypeFlags.Conditional) !== 0) {
      // Ten nested levels of one conditional type are assumed infinitely expanding.
      if (isDeeplyNestedType(c, target, this.targetStack, this.targetDepth, 10)) return Ternary.Maybe;
      const t = target as ConditionalType;
      if (
        t.root.inferTypeParameters.length === 0 &&
        !isDistributionDependent(c, t) &&
        !((source.flags & TypeFlags.Conditional) !== 0 && (source as ConditionalType).root === t.root)
      ) {
        const skipTrue = !isTypeAssignableTo(
          c,
          getPermissiveInstantiation(c, t.checkType),
          getPermissiveInstantiation(c, t.extendsType),
        );
        const skipFalse =
          !skipTrue &&
          isTypeAssignableTo(
            c,
            getRestrictiveInstantiation(c, t.checkType),
            getRestrictiveInstantiation(c, t.extendsType),
          );
        result = skipTrue
          ? Ternary.True
          : this.isRelatedToEx(
              source,
              getTrueTypeFromConditionalType(c, t),
              RecursionFlags.Target,
              false,
              undefined,
              intersectionState,
            );
        if (result !== Ternary.False) {
          result &= skipFalse
            ? Ternary.True
            : this.isRelatedToEx(
                source,
                getFalseTypeFromConditionalType(c, t),
                RecursionFlags.Target,
                false,
                undefined,
                intersectionState,
              );
          if (result !== Ternary.False) return result;
        }
      }
    } else if ((target.flags & TypeFlags.TemplateLiteral) !== 0) {
      if ((source.flags & TypeFlags.TemplateLiteral) !== 0) {
        if (this.relation === c.comparableRelation)
          return templateLiteralTypesDefinitelyUnrelated(source as TemplateLiteralType, target as TemplateLiteralType)
            ? Ternary.False
            : Ternary.True;
        instantiateType(c, source, c.reportUnreliableMapper);
      }
      if (
        isTypeMatchedByTemplateLiteralType(
          c,
          source,
          target as TemplateLiteralType,
          (s, t) => this.isRelatedTo(s, t, RecursionFlags.Both, false) !== Ternary.False,
        )
      )
        return Ternary.True;
    } else if ((target.flags & TypeFlags.StringMapping) !== 0) {
      if ((source.flags & TypeFlags.StringMapping) === 0 && isMemberOfStringMapping(c, source, target))
        return Ternary.True;
    } else if (isGenericMappedType(c, target) && this.relation !== c.identityRelation) {
      const r = this.relateToGenericMappedType(source, target as MappedType, reportErrors);
      if (r !== Ternary.False) return r;
      originalErrorChain = this.errorChain;
      this.errorChain = saveChain;
      this.relatedInfo = saveRelated;
    }
    if ((source.flags & TypeFlags.TypeVariable) !== 0) {
      // Indexed access against indexed access is handled above.
      if ((source.flags & TypeFlags.IndexedAccess) === 0 || (target.flags & TypeFlags.IndexedAccess) === 0) {
        const constraint = getConstraintOfType(c, source) ?? c.unknownType;
        // Try without `this` instantiation first.
        result = this.isRelatedToEx(constraint, target, RecursionFlags.Source, false, undefined, intersectionState);
        if (result !== Ternary.False) return result;
        const constraintWithThis = getTypeWithThisArgument(c, constraint, source, false);
        result = this.isRelatedToEx(
          constraintWithThis,
          target,
          RecursionFlags.Source,
          reportErrors && constraint !== c.unknownType && (target.flags & source.flags & TypeFlags.TypeParameter) === 0,
          undefined,
          intersectionState,
        );
        if (result !== Ternary.False) return result;
        if (isMappedTypeGenericIndexedAccess(c, source)) {
          const indexConstraint = getConstraintOfType(c, (source as IndexedAccessType).indexType);
          if (indexConstraint !== undefined) {
            result = this.isRelatedTo(
              getIndexedAccessType(c, (source as IndexedAccessType).objectType, indexConstraint),
              target,
              RecursionFlags.Source,
              reportErrors,
            );
            if (result !== Ternary.False) return result;
          }
        }
      }
    } else if ((source.flags & TypeFlags.Index) !== 0) {
      const sourceIndex = source as IndexType;
      const isDeferredMappedIndex =
        shouldDeferIndexType(c, sourceIndex.target, sourceIndex.indexFlags) &&
        (sourceIndex.target.objectFlags & ObjectFlags.Mapped) !== 0;
      result = this.isRelatedTo(
        c.stringNumberSymbolType,
        target,
        RecursionFlags.Source,
        reportErrors && !isDeferredMappedIndex,
      );
      if (result !== Ternary.False) return result;
      if (isDeferredMappedIndex) {
        // The source keys come from the name type alone; its generic part could be anything.
        const mappedType = sourceIndex.target as MappedType;
        const nameType = getNameTypeFromMappedType(c, mappedType);
        const sourceMappedKeys =
          nameType !== undefined && isMappedTypeWithKeyofConstraintDeclaration(c, mappedType)
            ? getApparentMappedTypeKeys(c, nameType, mappedType)
            : (nameType ?? getConstraintTypeFromMappedType(c, mappedType));
        result = this.isRelatedTo(sourceMappedKeys, target, RecursionFlags.Source, reportErrors);
        if (result !== Ternary.False) return result;
      }
    } else if ((source.flags & TypeFlags.Conditional) !== 0) {
      if (isDeeplyNestedType(c, source, this.sourceStack, this.sourceDepth, 10)) return Ternary.Maybe;
      const s = source as ConditionalType;
      const saveErrorChain = this.errorChain;
      if ((target.flags & TypeFlags.Conditional) !== 0) {
        const t = target as ConditionalType;
        // Related when check types relate either way, extends types are identical, and branches relate.
        // The source's `infer` type parameters are inferred from the target's extends type.
        let sourceExtends = s.extendsType;
        let mapper: TypeMapper | undefined = undefined;
        if (s.root.inferTypeParameters.length !== 0) {
          const context = createInferenceContext(c, s.root.inferTypeParameters, undefined, InferenceFlags.None, this);
          inferTypes(
            c,
            context.inferences,
            t.extendsType,
            sourceExtends,
            InferencePriority.NoConstraints | InferencePriority.AlwaysStrict,
            false,
          );
          sourceExtends = instantiateType(c, sourceExtends, context.mapper);
          mapper = context.mapper;
        }
        if (
          isTypeIdenticalTo(c, sourceExtends, t.extendsType) &&
          (this.isRelatedTo(s.checkType, t.checkType, RecursionFlags.Both, false) !== Ternary.False ||
            this.isRelatedTo(t.checkType, s.checkType, RecursionFlags.Both, false) !== Ternary.False)
        ) {
          result = this.isRelatedTo(
            instantiateType(c, getTrueTypeFromConditionalType(c, s), mapper),
            getTrueTypeFromConditionalType(c, t),
            RecursionFlags.Both,
            reportErrors,
          );
          if (result !== Ternary.False)
            result &= this.isRelatedTo(
              getFalseTypeFromConditionalType(c, s),
              getFalseTypeFromConditionalType(c, t),
              RecursionFlags.Both,
              reportErrors,
            );
          if (result !== Ternary.False) return result;
        }
      }
      // A conditional relates through its default constraint, the union of its branches.
      const defaultConstraint = getDefaultConstraintOfConditionalType(c, s);
      result = this.isRelatedTo(defaultConstraint, target, RecursionFlags.Source, reportErrors);
      if (result !== Ternary.False) return result;
      // Its distributive constraint is too inaccurate to relate conditionals to each other.
      if ((target.flags & TypeFlags.Conditional) === 0 && hasNonCircularBaseConstraint(c, s)) {
        const distributiveConstraint = getConstraintOfDistributiveConditionalType(c, s);
        if (distributiveConstraint !== undefined) {
          this.errorChain = saveErrorChain;
          result = this.isRelatedTo(distributiveConstraint, target, RecursionFlags.Source, reportErrors);
          if (result !== Ternary.False) return result;
        }
      }
    } else if ((source.flags & TypeFlags.TemplateLiteral) !== 0 && (target.flags & TypeFlags.Object) === 0) {
      if ((target.flags & TypeFlags.TemplateLiteral) === 0) {
        const constraint = getBaseConstraintOfType(c, source);
        if (constraint !== undefined && constraint !== source) {
          result = this.isRelatedTo(constraint, target, RecursionFlags.Source, reportErrors);
          if (result !== Ternary.False) return result;
        }
      }
    } else if ((source.flags & TypeFlags.StringMapping) !== 0) {
      if ((target.flags & TypeFlags.StringMapping) !== 0) {
        if (source.symbol !== target.symbol) return Ternary.False;
        result = this.isRelatedTo(
          (source as StringMappingType).target,
          (target as StringMappingType).target,
          RecursionFlags.Both,
          reportErrors,
        );
        if (result !== Ternary.False) return result;
      } else {
        const constraint = getBaseConstraintOfType(c, source);
        if (constraint !== undefined) {
          result = this.isRelatedTo(constraint, target, RecursionFlags.Source, reportErrors);
          if (result !== Ternary.False) return result;
        }
      }
    } else {
      // An empty object relates to any mapped type with `?`.
      if (
        this.relation !== c.subtypeRelation &&
        this.relation !== c.strictSubtypeRelation &&
        isPartialMappedType(target) &&
        isEmptyObjectType(c, source)
      )
        return Ternary.True;
      if (isGenericMappedType(c, target)) {
        if (isGenericMappedType(c, source)) {
          result = this.mappedTypeRelatedTo(source as MappedType, target as MappedType, reportErrors);
          if (result !== Ternary.False) return result;
        }
        return Ternary.False;
      }
      const sourceIsPrimitive = (source.flags & TypeFlags.Primitive) !== 0;
      if (this.relation !== c.identityRelation) source = getApparentType(c, source);
      else if (isGenericMappedType(c, source)) return Ternary.False;
      if (
        (source.objectFlags & ObjectFlags.Reference) !== 0 &&
        (target.objectFlags & ObjectFlags.Reference) !== 0 &&
        (source.flags & TypeFlags.Object) !== 0 &&
        (target.flags & TypeFlags.Object) !== 0 &&
        (source as TypeReference).target === (target as TypeReference).target &&
        !isTupleType(source) &&
        !isMarkerType(c, source) &&
        !isMarkerType(c, target)
      ) {
        if (isEmptyArrayLiteralType(c, source)) return Ternary.True;
        // References to the same generic type relate by variance.
        const variances = getVariances(c, (source as TypeReference).target!);
        if (variances.length === 0) return Ternary.Unknown;
        const varianceResult = this.relateVariances(
          getTypeArguments(c, source),
          getTypeArguments(c, target),
          variances,
          reportErrors,
          intersectionState,
          saveChain,
          saveRelated,
        );
        if (varianceResult !== undefined) return varianceResult;
        result = Ternary.False;
        if (this.varianceSetsCheckFailed) varianceCheckFailed = this.varianceCheckFailed;
        if (this.varianceSetsErrorChain) originalErrorChain = this.varianceErrorChain;
      } else if (
        isArrayType(c, target) &&
        ((isReadonlyArrayType(c, target) && everyType(source, (u) => isArrayOrTupleType(c, u))) ||
          everyType(source, isMutableTupleType))
      ) {
        if (this.relation !== c.identityRelation)
          return this.isRelatedTo(
            getIndexTypeOfType(c, source, c.numberType) ?? c.anyType,
            getIndexTypeOfType(c, target, c.numberType) ?? c.anyType,
            RecursionFlags.Both,
            reportErrors,
          );
        return Ternary.False;
      } else if (isGenericTupleType(source) && isTupleType(target) && !isGenericTupleType(target)) {
        const constraint = getBaseConstraintOrType(c, source);
        if (constraint !== source) return this.isRelatedTo(constraint, target, RecursionFlags.Source, reportErrors);
      } else if (
        (this.relation === c.subtypeRelation || this.relation === c.strictSubtypeRelation) &&
        isEmptyObjectType(c, target) &&
        (target.objectFlags & ObjectFlags.FreshLiteral) !== 0 &&
        !isEmptyObjectType(c, source)
      )
        return Ternary.False;
      // Structural comparison, including intersection sources aggregated as objects.
      if (
        (source.flags & (TypeFlags.Object | TypeFlags.Intersection)) !== 0 &&
        (target.flags & TypeFlags.Object) !== 0
      ) {
        const reportStructuralErrors = reportErrors && this.errorChain === saveChain && !sourceIsPrimitive;
        result = this.propertiesRelatedTo(source, target, reportStructuralErrors, undefined, false, intersectionState);
        if (result !== Ternary.False) {
          result &= this.signaturesRelatedTo(
            source,
            target,
            SignatureKind.Call,
            reportStructuralErrors,
            intersectionState,
          );
          if (result !== Ternary.False) {
            result &= this.signaturesRelatedTo(
              source,
              target,
              SignatureKind.Construct,
              reportStructuralErrors,
              intersectionState,
            );
            if (result !== Ternary.False)
              result &= this.indexSignaturesRelatedTo(
                source,
                target,
                sourceIsPrimitive,
                reportStructuralErrors,
                intersectionState,
              );
          }
        }
        if (result !== Ternary.False) {
          if (!varianceCheckFailed) return result;
          if (originalErrorChain !== undefined) this.errorChain = originalErrorChain;
          else if (this.errorChain === undefined) this.errorChain = saveChain;
        }
      }
      // An object source relates to a discriminated union target when every combination of its
      // discriminant types matches some constituent. Errors come from checking each constituent.
      if (
        (source.flags & (TypeFlags.Object | TypeFlags.Intersection)) !== 0 &&
        (target.flags & TypeFlags.Union) !== 0
      ) {
        const objectOnlyTarget = filterType(
          c,
          target,
          (u) => (u.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.Substitution)) !== 0,
        );
        if ((objectOnlyTarget.flags & TypeFlags.Union) !== 0) {
          const related = this.typeRelatedToDiscriminatedType(source, objectOnlyTarget as UnionType);
          if (related !== Ternary.False) return related;
        }
      }
    }
    return Ternary.False;
  }

  typeRelatedToDiscriminatedType(source: Type, target: UnionType): Ternary {
    const c = this.c;
    const discriminants: Symbol[] = [];
    for (const p of getPropertiesOfType(c, source))
      if (isDiscriminantProperty(c, target, p.name)) discriminants.push(p);
    if (discriminants.length === 0) return Ternary.False;
    // Check the number of combinations before building them.
    let combinations = 1;
    for (const prop of discriminants) {
      combinations *= countTypes(getNonMissingTypeOfSymbol(c, prop));
      if (combinations > 25 || combinations === 0) return Ternary.False;
    }
    const discriminantTypes: Type[][] = [];
    const excludedProperties = new Set<string>();
    for (const prop of discriminants) {
      const t = getNonMissingTypeOfSymbol(c, prop);
      discriminantTypes.push((t.flags & TypeFlags.Union) !== 0 ? typesOf(t) : [t]);
      excludedProperties.add(prop.name);
    }
    // Each combination of discriminant types must match one or more constituents of the target.
    const skipOptional = c.strictNullChecks || this.relation === c.comparableRelation;
    const matchingTypes: Type[] = [];
    const combination: Type[] = discriminantTypes.map((types) => types[0]!);
    for (let i = 0; i < combinations; i++) {
      let n = i;
      for (let j = discriminantTypes.length - 1; j >= 0; j--) {
        const types = discriminantTypes[j]!;
        combination[j] = types[n % types.length]!;
        n = Math.floor(n / types.length);
      }
      let hasMatch = false;
      for (const t of target.types) {
        let matches = true;
        for (let k = 0; k < discriminants.length; k++) {
          const sourceProp = discriminants[k]!;
          const targetProp = getPropertyOfType(c, t, sourceProp.name);
          if (targetProp === undefined) {
            matches = false;
            break;
          }
          if (sourceProp === targetProp) continue;
          // The source property is compared in the context of a single discriminant type.
          const related = this.propertyRelatedToEx(
            source,
            target,
            sourceProp,
            targetProp,
            combination[k]!,
            false,
            IntersectionState.None,
            skipOptional,
          );
          if (related === Ternary.False) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
        if (!matchingTypes.includes(t)) matchingTypes.push(t);
        hasMatch = true;
      }
      if (!hasMatch) return Ternary.False;
    }
    // The remaining non-discriminant properties of each match must relate.
    let result = Ternary.True;
    for (const t of matchingTypes) {
      result &= this.propertiesRelatedTo(source, t, false, excludedProperties, false, IntersectionState.None);
      if (result !== Ternary.False) {
        result &= this.signaturesRelatedTo(source, t, SignatureKind.Call, false, IntersectionState.None);
        if (result !== Ternary.False) {
          result &= this.signaturesRelatedTo(source, t, SignatureKind.Construct, false, IntersectionState.None);
          // Tuple element types are covered by their properties.
          if (result !== Ternary.False && !(isTupleType(source) && isTupleType(t)))
            result &= this.indexSignaturesRelatedTo(source, t, false, false, IntersectionState.None);
        }
      }
      if (result === Ternary.False) return result;
    }
    return result;
  }

  relateToGenericMappedType(source: Type, target: MappedType, reportErrors: boolean): Ternary {
    const c = this.c;
    const keysRemapped = getNameTypeFromMappedType(c, target) !== undefined;
    const templateType = getTemplateTypeFromMappedType(c, target);
    const modifiers = getMappedTypeModifiers(target);
    if ((modifiers & MappedTypeModifiers.ExcludeOptional) !== 0) return Ternary.False;
    // `{ [P in Q]: S[P] }` with source S.
    if (
      !keysRemapped &&
      (templateType.flags & TypeFlags.IndexedAccess) !== 0 &&
      (templateType as IndexedAccessType).objectType === source &&
      (templateType as IndexedAccessType).indexType === getTypeParameterFromMappedType(c, target)
    )
      return Ternary.True;
    if (isGenericMappedType(c, source)) return Ternary.False;
    const targetKeys = keysRemapped
      ? getNameTypeFromMappedType(c, target)!
      : getConstraintTypeFromMappedType(c, target);
    const sourceKeys = getIndexTypeEx(c, source, IndexFlags.NoIndexSignatures);
    const includeOptional = (modifiers & MappedTypeModifiers.IncludeOptional) !== 0;
    const filteredByApplicability = includeOptional ? getIntersectionType(c, [targetKeys, sourceKeys]) : undefined;
    if (
      (includeOptional && (filteredByApplicability!.flags & TypeFlags.Never) === 0) ||
      (!includeOptional && this.isRelatedTo(targetKeys, sourceKeys, RecursionFlags.Both, false) !== Ternary.False)
    ) {
      const typeParameter = getTypeParameterFromMappedType(c, target);
      const nonNullComponent = filterType(c, templateType, (u) => (u.flags & TypeFlags.Nullable) === 0);
      if (
        !keysRemapped &&
        (nonNullComponent.flags & TypeFlags.IndexedAccess) !== 0 &&
        (nonNullComponent as IndexedAccessType).indexType === typeParameter
      ) {
        const r = this.isRelatedTo(
          source,
          (nonNullComponent as IndexedAccessType).objectType,
          RecursionFlags.Target,
          reportErrors,
        );
        if (r !== Ternary.False) return r;
      } else {
        let indexingType: Type = typeParameter;
        if (keysRemapped) indexingType = filteredByApplicability ?? targetKeys;
        else if (filteredByApplicability !== undefined)
          indexingType = getIntersectionType(c, [filteredByApplicability, typeParameter]);
        const r = this.isRelatedTo(
          getIndexedAccessType(c, source, indexingType),
          templateType,
          RecursionFlags.Both,
          reportErrors,
        );
        if (r !== Ternary.False) return r;
      }
    }
    return Ternary.False;
  }

  typeArgumentsRelatedTo(
    sources: Type[],
    targets: Type[],
    variances: VarianceFlags[],
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    if (sources.length !== targets.length && this.relation === c.identityRelation) return Ternary.False;
    const length = Math.min(sources.length, targets.length);
    let result = Ternary.True;
    for (let i = 0; i < length; i++) {
      // Without variance information, default to covariance.
      const varianceFlags = i < variances.length ? variances[i]! : VarianceFlags.Covariant;
      const variance = varianceFlags & VarianceFlags.VarianceMask;
      if (variance === VarianceFlags.Independent) continue;
      const s = sources[i]!;
      const t = targets[i]!;
      let related: Ternary;
      if ((varianceFlags & VarianceFlags.Unmeasurable) !== 0)
        related =
          this.relation === c.identityRelation
            ? this.isRelatedTo(s, t, RecursionFlags.Both, false)
            : compareTypesIdentical(c, s, t);
      else {
        if (c.varianceStack.length !== 0 && (varianceFlags & VarianceFlags.Unreliable) !== 0)
          instantiateType(c, s, c.reportUnreliableMapper);
        if (variance === VarianceFlags.Covariant)
          related = this.isRelatedToEx(s, t, RecursionFlags.Both, reportErrors, undefined, intersectionState);
        else if (variance === VarianceFlags.Contravariant)
          related = this.isRelatedToEx(t, s, RecursionFlags.Both, reportErrors, undefined, intersectionState);
        else if (variance === VarianceFlags.Bivariant) {
          // Contravariant without errors, then covariant with errors.
          related = this.isRelatedTo(t, s, RecursionFlags.Both, false);
          if (related === Ternary.False)
            related = this.isRelatedToEx(s, t, RecursionFlags.Both, reportErrors, undefined, intersectionState);
        } else {
          // Invariant: covariant first, then contravariant.
          related = this.isRelatedToEx(s, t, RecursionFlags.Both, reportErrors, undefined, intersectionState);
          if (related !== Ternary.False)
            related &= this.isRelatedToEx(t, s, RecursionFlags.Both, reportErrors, undefined, intersectionState);
        }
      }
      if (related === Ternary.False) return Ternary.False;
      result &= related;
    }
    return result;
  }

  mappedTypeRelatedTo(source: MappedType, target: MappedType, reportErrors: boolean): Ternary {
    const c = this.c;
    const modifiersRelated =
      this.relation === c.comparableRelation ||
      (this.relation === c.identityRelation && getMappedTypeModifiers(source) === getMappedTypeModifiers(target)) ||
      (this.relation !== c.identityRelation &&
        getCombinedMappedTypeOptionality(c, source) <= getCombinedMappedTypeOptionality(c, target));
    if (!modifiersRelated) return Ternary.False;
    const targetConstraint = getConstraintTypeFromMappedType(c, target);
    const sourceConstraint = instantiateType(
      c,
      getConstraintTypeFromMappedType(c, source),
      getCombinedMappedTypeOptionality(c, source) < 0 ? c.reportUnmeasurableMapper : c.reportUnreliableMapper,
    );
    const result = this.isRelatedTo(targetConstraint, sourceConstraint, RecursionFlags.Both, reportErrors);
    if (result === Ternary.False) return Ternary.False;
    const mapper = new SimpleTypeMapper(
      getTypeParameterFromMappedType(c, source),
      getTypeParameterFromMappedType(c, target),
    );
    const sourceName = getNameTypeFromMappedType(c, source);
    const targetName = getNameTypeFromMappedType(c, target);
    if (
      (sourceName === undefined ? undefined : instantiateType(c, sourceName, mapper)) !==
      (targetName === undefined ? undefined : instantiateType(c, targetName, mapper))
    )
      return Ternary.False;
    return (
      result &
      this.isRelatedTo(
        instantiateType(c, getTemplateTypeFromMappedType(c, source), mapper),
        getTemplateTypeFromMappedType(c, target),
        RecursionFlags.Both,
        reportErrors,
      )
    );
  }

  propertiesRelatedTo(
    source: Type,
    target: Type,
    reportErrors: boolean,
    excludedProperties: Set<string> | undefined,
    optionalsOnly: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    if (this.relation === c.identityRelation) return this.propertiesIdenticalTo(source, target, excludedProperties);
    let result = Ternary.True;
    if (isTupleType(target)) {
      const targetTuple = tupleTargetOf(target);
      if (isArrayOrTupleType(c, source)) {
        if (
          !targetTuple.readonly &&
          (isReadonlyArrayType(c, source) || (isTupleType(source) && tupleTargetOf(source).readonly))
        )
          return Ternary.False;
        const sourceArity = getTypeReferenceArity(source);
        const targetArity = getTypeReferenceArity(target);
        const sourceRest = isTupleType(source) ? (tupleTargetOf(source).combinedFlags & ElementFlags.Rest) !== 0 : true;
        const targetHasRestElement = (targetTuple.combinedFlags & ElementFlags.Rest) !== 0;
        const targetHasVariableElement = (targetTuple.combinedFlags & ElementFlags.Variable) !== 0;
        const sourceMinLength = isTupleType(source) ? tupleTargetOf(source).minLength : 0;
        const targetMinLength = targetTuple.minLength;
        if (!sourceRest && sourceArity < targetMinLength) {
          if (reportErrors)
            this.reportError(Diagnostics.Source_has_0_element_s_but_target_requires_1, [
              String(sourceArity),
              String(targetMinLength),
            ]);
          return Ternary.False;
        }
        if (!targetHasVariableElement && targetArity < sourceMinLength) {
          if (reportErrors)
            this.reportError(Diagnostics.Source_has_0_element_s_but_target_allows_only_1, [
              String(sourceMinLength),
              String(targetArity),
            ]);
          return Ternary.False;
        }
        if (!targetHasVariableElement && (sourceRest || targetArity < sourceArity)) {
          if (reportErrors) {
            if (sourceMinLength < targetMinLength)
              this.reportError(Diagnostics.Target_requires_0_element_s_but_source_may_have_fewer, [
                String(targetMinLength),
              ]);
            else
              this.reportError(Diagnostics.Target_allows_only_0_element_s_but_source_may_have_more, [
                String(targetArity),
              ]);
          }
          return Ternary.False;
        }
        const sourceTypeArguments = getTypeArguments(c, source);
        const targetTypeArguments = getTypeArguments(c, target);
        const targetStartCount = getStartElementCount(targetTuple, ElementFlags.NonRest);
        const targetEndCount = getEndElementCount(targetTuple, ElementFlags.NonRest);
        let canExcludeDiscriminants = excludedProperties !== undefined && excludedProperties.size !== 0;
        for (let sourcePosition = 0; sourcePosition < sourceArity; sourcePosition++) {
          const sourceFlags = isTupleType(source)
            ? tupleTargetOf(source).elementInfos[sourcePosition]!.flags
            : ElementFlags.Rest;
          const sourcePositionFromEnd = sourceArity - 1 - sourcePosition;
          const restMapped = targetHasRestElement && sourcePosition >= targetStartCount;
          // A source element past the target's last element (a target with variadic but no rest elements).
          if (!restMapped && sourcePosition >= targetArity) {
            if (reportErrors)
              this.reportError(Diagnostics.Target_allows_only_0_element_s_but_source_may_have_more, [
                String(targetArity),
              ]);
            return Ternary.False;
          }
          const targetPosition = restMapped
            ? targetArity - 1 - Math.min(sourcePositionFromEnd, targetEndCount)
            : sourcePosition;
          const targetFlags = targetPosition >= 0 ? targetTuple.elementInfos[targetPosition]!.flags : ElementFlags.None;
          if ((targetFlags & ElementFlags.Variadic) !== 0 && (sourceFlags & ElementFlags.Variadic) === 0) {
            if (reportErrors)
              this.reportError(Diagnostics.Source_provides_no_match_for_variadic_element_at_position_0_in_target, [
                String(targetPosition),
              ]);
            return Ternary.False;
          }
          if ((sourceFlags & ElementFlags.Variadic) !== 0 && (targetFlags & ElementFlags.Variable) === 0) {
            if (reportErrors)
              this.reportError(
                Diagnostics.Variadic_element_at_position_0_in_source_does_not_match_element_at_position_1_in_target,
                [String(sourcePosition), String(targetPosition)],
              );
            return Ternary.False;
          }
          if ((targetFlags & ElementFlags.Required) !== 0 && (sourceFlags & ElementFlags.Required) === 0) {
            if (reportErrors)
              this.reportError(Diagnostics.Source_provides_no_match_for_required_element_at_position_0_in_target, [
                String(targetPosition),
              ]);
            return Ternary.False;
          }
          if (canExcludeDiscriminants) {
            if ((sourceFlags & ElementFlags.Variable) !== 0 || (targetFlags & ElementFlags.Variable) !== 0)
              canExcludeDiscriminants = false;
            if (canExcludeDiscriminants && excludedProperties!.has(String(sourcePosition))) continue;
          }
          const sourceType = removeMissingType(
            c,
            sourceTypeArguments[sourcePosition]!,
            (sourceFlags & targetFlags & ElementFlags.Optional) !== 0,
          );
          const targetType = targetTypeArguments[targetPosition]!;
          const targetCheckType =
            (sourceFlags & ElementFlags.Variadic) !== 0 && (targetFlags & ElementFlags.Rest) !== 0
              ? createArrayTypeEx(c, targetType, false)
              : removeMissingType(c, targetType, (targetFlags & ElementFlags.Optional) !== 0);
          const related = this.isRelatedToEx(
            sourceType,
            targetCheckType,
            RecursionFlags.Both,
            reportErrors,
            undefined,
            intersectionState,
          );
          if (related === Ternary.False) {
            if (reportErrors && (targetArity > 1 || sourceArity > 1)) {
              if (
                targetHasRestElement &&
                sourcePosition >= targetStartCount &&
                sourcePositionFromEnd >= targetEndCount &&
                targetStartCount !== sourceArity - targetEndCount - 1
              )
                this.reportError(
                  Diagnostics.Type_at_positions_0_through_1_in_source_is_not_compatible_with_type_at_position_2_in_target,
                  [String(targetStartCount), String(sourceArity - targetEndCount - 1), String(targetPosition)],
                );
              else
                this.reportError(
                  Diagnostics.Type_at_position_0_in_source_is_not_compatible_with_type_at_position_1_in_target,
                  [String(sourcePosition), String(targetPosition)],
                );
            }
            return Ternary.False;
          }
          result &= related;
        }
        return result;
      }
      if ((targetTuple.combinedFlags & ElementFlags.Variable) !== 0) return Ternary.False;
    }
    const requireOptionalProperties =
      (this.relation === c.subtypeRelation || this.relation === c.strictSubtypeRelation) &&
      !isObjectLiteralType(source) &&
      !isEmptyArrayLiteralType(c, source) &&
      !isTupleType(source);
    const targetProperties = getPropertiesOfType(c, target);
    // Where it is known which target names the source has, nothing else is looked up by name.
    const found = positionsOfNamesFoundInSource(c, source, target, targetProperties);
    const unmatchedProperty =
      found !== undefined
        ? firstUnmatchedProperty(c, targetProperties, found, requireOptionalProperties)
        : getUnmatchedProperty(c, source, target, requireOptionalProperties, false);
    if (unmatchedProperty !== undefined) {
      if (reportErrors && shouldReportUnmatchedPropertyError(c, source, target))
        this.reportUnmatchedProperty(source, target, unmatchedProperty, requireOptionalProperties);
      return Ternary.False;
    }
    if (isObjectLiteralType(target)) {
      for (const sourceProp of getPropertiesOfType(c, source)) {
        if (excludedProperties !== undefined && excludedProperties.has(sourceProp.name)) continue;
        if (getPropertyOfObjectType(c, target, sourceProp.name) === undefined) {
          if (reportErrors)
            this.reportError(Diagnostics.Property_0_does_not_exist_on_type_1, [
              symbolToString(c, sourceProp),
              typeToString(c, target),
            ]);
          return Ternary.False;
        }
      }
    }
    const numericNamesOnly = isTupleType(source) && isTupleType(target);
    for (const targetProp of found !== undefined ? found.map((i) => targetProperties[i]!) : targetProperties) {
      if (excludedProperties !== undefined && excludedProperties.has(targetProp.name)) continue;
      const name = targetProp.name;
      if (
        (targetProp.flags & SymbolFlags.Prototype) === 0 &&
        (!numericNamesOnly || isNumericLiteralName(name) || name === 'length') &&
        (!optionalsOnly || (targetProp.flags & SymbolFlags.Optional) !== 0)
      ) {
        const sourceProp = getPropertyOfType(c, source, name);
        if (sourceProp !== undefined && sourceProp !== targetProp) {
          const related = this.propertyRelatedTo(
            source,
            target,
            sourceProp,
            targetProp,
            reportErrors,
            intersectionState,
            this.relation === c.comparableRelation,
          );
          if (related === Ternary.False) return Ternary.False;
          result &= related;
        }
      }
    }
    return result;
  }

  propertyRelatedTo(
    source: Type,
    target: Type,
    sourceProp: Symbol,
    targetProp: Symbol,
    reportErrors: boolean,
    intersectionState: IntersectionState,
    skipOptional: boolean,
  ): Ternary {
    return this.propertyRelatedToEx(
      source,
      target,
      sourceProp,
      targetProp,
      undefined,
      reportErrors,
      intersectionState,
      skipOptional,
    );
  }

  /** `propertyRelatedTo` with `sourcePropType` in place of the source property's type when given. */
  propertyRelatedToEx(
    source: Type,
    target: Type,
    sourceProp: Symbol,
    targetProp: Symbol,
    sourcePropType: Type | undefined,
    reportErrors: boolean,
    intersectionState: IntersectionState,
    skipOptional: boolean,
  ): Ternary {
    const c = this.c;
    const sourcePropFlags = getDeclarationModifierFlagsFromSymbol(c, sourceProp, false);
    const targetPropFlags = getDeclarationModifierFlagsFromSymbol(c, targetProp, false);
    if ((sourcePropFlags & ModifierFlags.Private) !== 0 || (targetPropFlags & ModifierFlags.Private) !== 0) {
      if (sourceProp.valueDeclaration !== targetProp.valueDeclaration) {
        if (reportErrors) {
          if ((sourcePropFlags & ModifierFlags.Private) !== 0 && (targetPropFlags & ModifierFlags.Private) !== 0)
            this.reportError(Diagnostics.Types_have_separate_declarations_of_a_private_property_0, [
              symbolToString(c, targetProp),
            ]);
          else {
            const sourceIsPrivate = (sourcePropFlags & ModifierFlags.Private) !== 0;
            this.reportError(Diagnostics.Property_0_is_private_in_type_1_but_not_in_type_2, [
              symbolToString(c, targetProp),
              typeToString(c, sourceIsPrivate ? source : target),
              typeToString(c, sourceIsPrivate ? target : source),
            ]);
          }
        }
        return Ternary.False;
      }
    } else if ((targetPropFlags & ModifierFlags.Protected) !== 0) {
      if (!isValidOverrideOf(c, sourceProp, targetProp)) {
        if (reportErrors)
          this.reportError(Diagnostics.Property_0_is_protected_but_type_1_is_not_a_class_derived_from_2, [
            symbolToString(c, targetProp),
            typeToString(c, getDeclaringClass(c, sourceProp) ?? source),
            typeToString(c, getDeclaringClass(c, targetProp) ?? target),
          ]);
        return Ternary.False;
      }
    } else if ((sourcePropFlags & ModifierFlags.Protected) !== 0) {
      if (reportErrors)
        this.reportError(Diagnostics.Property_0_is_protected_in_type_1_but_public_in_type_2, [
          symbolToString(c, targetProp),
          typeToString(c, source),
          typeToString(c, target),
        ]);
      return Ternary.False;
    }
    // Under strict subtype, readonly properties aren't subtypes of mutable ones.
    if (
      this.relation === c.strictSubtypeRelation &&
      isReadonlySymbol(c, sourceProp) &&
      !isReadonlySymbol(c, targetProp)
    )
      return Ternary.False;
    const related = this.isPropertySymbolTypeRelated(
      sourceProp,
      targetProp,
      sourcePropType,
      reportErrors,
      intersectionState,
    );
    if (related === Ternary.False) {
      if (reportErrors)
        this.reportError(Diagnostics.Types_of_property_0_are_incompatible, [symbolToString(c, targetProp)]);
      return Ternary.False;
    }
    if (
      !skipOptional &&
      (sourceProp.flags & SymbolFlags.Optional) !== 0 &&
      (targetProp.flags & SymbolFlags.ClassMember) !== 0 &&
      (targetProp.flags & SymbolFlags.Optional) === 0
    ) {
      if (reportErrors)
        this.reportError(Diagnostics.Property_0_is_optional_in_type_1_but_required_in_type_2, [
          symbolToString(c, targetProp),
          typeToString(c, source),
          typeToString(c, target),
        ]);
      return Ternary.False;
    }
    return related;
  }

  isPropertySymbolTypeRelated(
    sourceProp: Symbol,
    targetProp: Symbol,
    sourcePropType: Type | undefined,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    const targetIsOptional = c.strictNullChecks && (targetProp.checkFlags & CheckFlags.Partial) !== 0;
    const effectiveTarget = addOptionality(c, getNonMissingTypeOfSymbol(c, targetProp), false, targetIsOptional);
    if (
      (effectiveTarget.flags & (this.relation === c.strictSubtypeRelation ? TypeFlags.Any : TypeFlags.AnyOrUnknown)) !==
      0
    )
      return Ternary.True;
    const effectiveSource = sourcePropType ?? getNonMissingTypeOfSymbol(c, sourceProp);
    return this.isRelatedToEx(
      effectiveSource,
      effectiveTarget,
      RecursionFlags.Both,
      reportErrors,
      undefined,
      intersectionState,
    );
  }

  reportUnmatchedProperty(
    source: Type,
    target: Type,
    unmatchedProperty: Symbol,
    requireOptionalProperties: boolean,
  ): void {
    const c = this.c;
    // A private name of the same description in the source class is a different member.
    const declarationName =
      unmatchedProperty.valueDeclaration !== undefined ? getName(unmatchedProperty.valueDeclaration) : undefined;
    if (
      declarationName !== undefined &&
      declarationName.kind === SyntaxKind.PrivateIdentifier &&
      source.symbol !== undefined &&
      (source.symbol.flags & SymbolFlags.Class) !== 0
    ) {
      const description = getText(declarationName);
      if (getPropertyOfType(c, source, getSymbolNameForPrivateIdentifier(source.symbol, description)) !== undefined) {
        this.reportError(
          Diagnostics.Property_0_in_type_1_refers_to_a_different_member_that_cannot_be_accessed_from_within_type_2,
          [description, symbolToString(c, source.symbol), symbolToString(c, target.symbol!)],
        );
        return;
      }
    }
    const props = getUnmatchedProperties(c, source, target, requireOptionalProperties);
    if (props.length === 1) {
      const names = getTypeNamesForErrorDisplay(c, source, target);
      const propName = symbolToString(c, unmatchedProperty);
      this.reportError(Diagnostics.Property_0_is_missing_in_type_1_but_required_in_type_2, [
        propName,
        names[0],
        names[1],
      ]);
      if (declarationCount(unmatchedProperty) !== 0)
        this.relatedInfo.push(
          createDiagnosticForNode(unmatchedProperty.declaration!, Diagnostics.X_0_is_declared_here, [propName]),
        );
    } else if (this.tryElaborateArrayLikeErrors(source, target, false)) {
      const names = getTypeNamesForErrorDisplay(c, source, target);
      if (props.length > 5)
        this.reportError(Diagnostics.Type_0_is_missing_the_following_properties_from_type_1_Colon_2_and_3_more, [
          names[0],
          names[1],
          symbolNames(c, props.slice(0, 4)),
          String(props.length - 4),
        ]);
      else
        this.reportError(Diagnostics.Type_0_is_missing_the_following_properties_from_type_1_Colon_2, [
          names[0],
          names[1],
          symbolNames(c, props),
        ]);
    }
  }

  /** Mutability elaborations; false when property elaborations should be skipped. */
  tryElaborateArrayLikeErrors(source: Type, target: Type, reportErrors: boolean): boolean {
    const c = this.c;
    if (isTupleType(source)) {
      if (tupleTargetOf(source).readonly && isMutableArrayOrTuple(c, target)) {
        if (reportErrors)
          this.reportError(Diagnostics.The_type_0_is_readonly_and_cannot_be_assigned_to_the_mutable_type_1, [
            typeToString(c, source),
            typeToString(c, target),
          ]);
        return false;
      }
      return isArrayOrTupleType(c, target);
    }
    if (isReadonlyArrayType(c, source) && isMutableArrayOrTuple(c, target)) {
      if (reportErrors)
        this.reportError(Diagnostics.The_type_0_is_readonly_and_cannot_be_assigned_to_the_mutable_type_1, [
          typeToString(c, source),
          typeToString(c, target),
        ]);
      return false;
    }
    if (isTupleType(target)) return isArrayType(c, source);
    return true;
  }

  propertiesIdenticalTo(source: Type, target: Type, excludedProperties: Set<string> | undefined): Ternary {
    const c = this.c;
    if ((source.flags & TypeFlags.Object) === 0 || (target.flags & TypeFlags.Object) === 0) return Ternary.False;
    const exclude = (props: Symbol[]): Symbol[] =>
      excludedProperties === undefined || excludedProperties.size === 0
        ? props
        : props.filter((p) => !excludedProperties.has(p.name));
    const sourceProperties = exclude(getPropertiesOfObjectType(c, source));
    const targetProperties = exclude(getPropertiesOfObjectType(c, target));
    if (sourceProperties.length !== targetProperties.length) return Ternary.False;
    let result = Ternary.True;
    for (const sourceProp of sourceProperties) {
      const targetProp = getPropertyOfObjectType(c, target, sourceProp.name);
      if (targetProp === undefined) return Ternary.False;
      const related = comparePropertiesWith(c, sourceProp, targetProp, this);
      if (related === Ternary.False) return Ternary.False;
      result &= related;
    }
    return result;
  }

  signaturesRelatedTo(
    source: Type,
    target: Type,
    kind: SignatureKind,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    if (this.relation === c.identityRelation) return this.signaturesIdenticalTo(source, target, kind);
    // anyFunctionType is a subtype of every function type.
    if (source === c.anyFunctionType) return Ternary.True;
    if (target === c.anyFunctionType) return Ternary.False;
    const sourceSignatures = getSignaturesOfType(c, source, kind);
    const targetSignatures = getSignaturesOfType(c, target, kind);
    if (kind === SignatureKind.Construct && sourceSignatures.length !== 0 && targetSignatures.length !== 0) {
      const sourceIsAbstract = (sourceSignatures[0]!.flags & SignatureFlags.Abstract) !== 0;
      const targetIsAbstract = (targetSignatures[0]!.flags & SignatureFlags.Abstract) !== 0;
      if (sourceIsAbstract && !targetIsAbstract) {
        if (reportErrors)
          this.reportError(
            Diagnostics.Cannot_assign_an_abstract_constructor_type_to_a_non_abstract_constructor_type,
            [],
          );
        return Ternary.False;
      }
      if (!this.constructorVisibilitiesAreCompatible(sourceSignatures[0]!, targetSignatures[0]!, reportErrors))
        return Ternary.False;
    }
    let result = Ternary.True;
    if (
      ((source.objectFlags & ObjectFlags.Instantiated) !== 0 &&
        (target.objectFlags & ObjectFlags.Instantiated) !== 0 &&
        source.symbol === target.symbol) ||
      ((source.objectFlags & ObjectFlags.Reference) !== 0 &&
        (target.objectFlags & ObjectFlags.Reference) !== 0 &&
        (source as TypeReference).target === (target as TypeReference).target)
    ) {
      // Instantiations of the same type compare pairwise with erased type parameters.
      for (let i = 0; i < targetSignatures.length && i < sourceSignatures.length; i++) {
        const related = this.signatureRelatedTo(
          sourceSignatures[i]!,
          targetSignatures[i]!,
          true,
          reportErrors,
          intersectionState,
        );
        if (related === Ternary.False) return Ternary.False;
        result &= related;
      }
    } else if (sourceSignatures.length === 1 && targetSignatures.length === 1) {
      // Single signatures erase generics only for comparability.
      const eraseGenerics = this.relation === c.comparableRelation;
      result = this.signatureRelatedTo(
        sourceSignatures[0]!,
        targetSignatures[0]!,
        eraseGenerics,
        reportErrors,
        intersectionState,
      );
    } else {
      outer: for (const t of targetSignatures) {
        const saveChain = this.errorChain;
        const saveRelated = this.relatedInfo;
        // Elaborate only the first failure.
        let shouldElaborateErrors = reportErrors;
        for (const s of sourceSignatures) {
          const related = this.signatureRelatedTo(s, t, true, shouldElaborateErrors, intersectionState);
          if (related !== Ternary.False) {
            result &= related;
            this.errorChain = saveChain;
            this.relatedInfo = saveRelated;
            continue outer;
          }
          shouldElaborateErrors = false;
        }
        if (shouldElaborateErrors)
          this.reportError(Diagnostics.Type_0_provides_no_match_for_the_signature_1, [
            typeToString(c, source),
            signatureToString(c, t),
          ]);
        return Ternary.False;
      }
    }
    return result;
  }

  constructorVisibilitiesAreCompatible(
    sourceSignature: Signature,
    targetSignature: Signature,
    reportErrors: boolean,
  ): boolean {
    if (sourceSignature.declaration === undefined || targetSignature.declaration === undefined) return true;
    const sourceAccessibility =
      getCombinedModifierFlags(sourceSignature.declaration) & ModifierFlags.NonPublicAccessibilityModifier;
    const targetAccessibility =
      getCombinedModifierFlags(targetSignature.declaration) & ModifierFlags.NonPublicAccessibilityModifier;
    if (targetAccessibility === ModifierFlags.Private) return true;
    if (targetAccessibility === ModifierFlags.Protected && sourceAccessibility !== ModifierFlags.Private) return true;
    if (targetAccessibility !== ModifierFlags.Protected && sourceAccessibility === 0) return true;
    if (reportErrors)
      this.reportError(Diagnostics.Cannot_assign_a_0_constructor_type_to_a_1_constructor_type, [
        visibilityToString(sourceAccessibility),
        visibilityToString(targetAccessibility),
      ]);
    return false;
  }

  signatureRelatedTo(
    source: Signature,
    target: Signature,
    erase: boolean,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    let checkMode = SignatureCheckMode.None;
    if (this.relation === c.subtypeRelation) checkMode = SignatureCheckMode.StrictTopSignature;
    else if (this.relation === c.strictSubtypeRelation)
      checkMode = SignatureCheckMode.StrictTopSignature | SignatureCheckMode.StrictArity;
    if (erase) {
      source = getErasedSignature(c, source);
      target = getErasedSignature(c, target);
    }
    const saveState = this.signatureIntersectionState;
    this.signatureIntersectionState = intersectionState;
    const result = compareSignaturesRelated(c, source, target, checkMode, reportErrors, this, c.reportUnreliableMapper);
    this.signatureIntersectionState = saveState;
    return result;
  }

  signaturesIdenticalTo(source: Type, target: Type, kind: SignatureKind): Ternary {
    const c = this.c;
    const sourceSignatures = getSignaturesOfType(c, source, kind);
    const targetSignatures = getSignaturesOfType(c, target, kind);
    if (sourceSignatures.length !== targetSignatures.length) return Ternary.False;
    let result = Ternary.True;
    for (let i = 0; i < sourceSignatures.length; i++) {
      const related = compareSignaturesIdenticalWith(
        c,
        sourceSignatures[i]!,
        targetSignatures[i]!,
        false,
        false,
        false,
        this,
      );
      if (related === Ternary.False) return Ternary.False;
      result &= related;
    }
    return result;
  }

  indexSignaturesRelatedTo(
    source: Type,
    target: Type,
    sourceIsPrimitive: boolean,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    if (this.relation === c.identityRelation) return this.indexSignaturesIdenticalTo(source, target);
    const indexInfos = getIndexInfosOfType(c, target);
    const targetHasStringIndex = indexInfos.some((info) => info.keyType === c.stringType);
    let result = Ternary.True;
    for (const targetInfo of indexInfos) {
      let related: Ternary;
      if (
        this.relation !== c.strictSubtypeRelation &&
        !sourceIsPrimitive &&
        targetHasStringIndex &&
        (targetInfo.valueType.flags & TypeFlags.Any) !== 0
      )
        related = Ternary.True;
      else if (isGenericMappedType(c, source) && targetHasStringIndex)
        related = this.isRelatedTo(
          getTemplateTypeFromMappedType(c, source as MappedType),
          targetInfo.valueType,
          RecursionFlags.Both,
          reportErrors,
        );
      else related = this.typeRelatedToIndexInfo(source, targetInfo, reportErrors, intersectionState);
      if (related === Ternary.False) return Ternary.False;
      result &= related;
    }
    return result;
  }

  typeRelatedToIndexInfo(
    source: Type,
    targetInfo: IndexInfo,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    const sourceInfo = getApplicableIndexInfo(c, source, targetInfo.keyType);
    if (sourceInfo !== undefined)
      return this.indexInfoRelatedTo(sourceInfo, targetInfo, reportErrors, intersectionState);
    // Intersection constituents never have inferred index signatures; under strict subtype only fresh literals do.
    if (
      (intersectionState & IntersectionState.Source) === 0 &&
      (this.relation !== c.strictSubtypeRelation || (source.objectFlags & ObjectFlags.FreshLiteral) !== 0) &&
      isObjectTypeWithInferableIndex(c, source)
    )
      return this.membersRelatedToIndexInfo(source, targetInfo, reportErrors, intersectionState);
    if (reportErrors)
      this.reportError(Diagnostics.Index_signature_for_type_0_is_missing_in_type_1, [
        typeToString(c, targetInfo.keyType),
        typeToString(c, source),
      ]);
    return Ternary.False;
  }

  membersRelatedToIndexInfo(
    source: Type,
    targetInfo: IndexInfo,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    let result = Ternary.True;
    const keyType = targetInfo.keyType;
    const props =
      (source.flags & TypeFlags.Intersection) !== 0
        ? getPropertiesOfUnionOrIntersectionType(c, source as IntersectionType)
        : getPropertiesOfObjectType(c, source);
    for (const prop of props) {
      if (isIgnoredJsxProperty(source, prop)) continue;
      if (
        !isApplicableIndexType(
          c,
          getLiteralTypeFromPropertyLazy(c, prop, TypeFlags.StringOrNumberLiteralOrUnique, false),
          keyType,
        )
      )
        continue;
      const propType = getNonMissingTypeOfSymbol(c, prop);
      const t =
        c.exactOptionalPropertyTypes ||
        (propType.flags & TypeFlags.Undefined) !== 0 ||
        keyType === c.numberType ||
        (prop.flags & SymbolFlags.Optional) === 0
          ? propType
          : filterType(c, propType, (u) => (u.flags & TypeFlags.Undefined) === 0);
      const related = this.isRelatedToEx(
        t,
        targetInfo.valueType,
        RecursionFlags.Both,
        reportErrors,
        undefined,
        intersectionState,
      );
      if (related === Ternary.False) {
        if (reportErrors)
          this.reportError(Diagnostics.Property_0_is_incompatible_with_index_signature, [symbolToString(c, prop)]);
        return Ternary.False;
      }
      result &= related;
    }
    for (const info of getIndexInfosOfType(c, source)) {
      if (isApplicableIndexType(c, info.keyType, keyType)) {
        const related = this.indexInfoRelatedTo(info, targetInfo, reportErrors, intersectionState);
        if (related === Ternary.False) return Ternary.False;
        result &= related;
      }
    }
    return result;
  }

  indexInfoRelatedTo(
    sourceInfo: IndexInfo,
    targetInfo: IndexInfo,
    reportErrors: boolean,
    intersectionState: IntersectionState,
  ): Ternary {
    const c = this.c;
    const related = this.isRelatedToEx(
      sourceInfo.valueType,
      targetInfo.valueType,
      RecursionFlags.Both,
      reportErrors,
      undefined,
      intersectionState,
    );
    if (related === Ternary.False && reportErrors) {
      if (sourceInfo.keyType === targetInfo.keyType)
        this.reportError(Diagnostics.X_0_index_signatures_are_incompatible, [typeToString(c, sourceInfo.keyType)]);
      else
        this.reportError(Diagnostics.X_0_and_1_index_signatures_are_incompatible, [
          typeToString(c, sourceInfo.keyType),
          typeToString(c, targetInfo.keyType),
        ]);
    }
    return related;
  }

  indexSignaturesIdenticalTo(source: Type, target: Type): Ternary {
    const c = this.c;
    const sourceInfos = getIndexInfosOfType(c, source);
    const targetInfos = getIndexInfosOfType(c, target);
    if (sourceInfos.length !== targetInfos.length) return Ternary.False;
    for (const targetInfo of targetInfos) {
      const sourceInfo = getIndexInfoOfType(c, source, targetInfo.keyType);
      if (
        !(
          sourceInfo !== undefined &&
          this.isRelatedTo(sourceInfo.valueType, targetInfo.valueType, RecursionFlags.Both, false) !== Ternary.False &&
          sourceInfo.isReadonly === targetInfo.isReadonly
        )
      )
        return Ternary.False;
    }
    return Ternary.True;
  }

  // ---- Error reporting

  reportErrorResults(
    originalSource: Type,
    originalTarget: Type,
    source: Type,
    target: Type,
    headMessage: DiagnosticMessage | undefined,
  ): void {
    const c = this.c;
    if (originalSource.alias !== undefined || getSingleBaseForNonAugmentingSubtype(c, originalSource) !== undefined)
      source = originalSource;
    if (originalTarget.alias !== undefined || getSingleBaseForNonAugmentingSubtype(c, originalTarget) !== undefined)
      target = originalTarget;
    if ((source.flags & TypeFlags.Object) !== 0 && (target.flags & TypeFlags.Object) !== 0)
      this.tryElaborateArrayLikeErrors(source, target, true);
    if ((source.flags & TypeFlags.Object) !== 0 && (target.flags & TypeFlags.Primitive) !== 0)
      this.tryElaborateErrorsForPrimitivesAndObjects(source, target);
    else if (source.symbol !== undefined && (source.flags & TypeFlags.Object) !== 0 && c.globalObjectType === source)
      this.reportError(
        Diagnostics.The_Object_type_is_assignable_to_very_few_other_types_Did_you_mean_to_use_the_any_type_instead,
        [],
      );
    else if ((source.objectFlags & ObjectFlags.JsxAttributes) !== 0 && (target.flags & TypeFlags.Intersection) !== 0) {
      // Attributes failing JSX.IntrinsicAttributes or JSX.IntrinsicClassAttributes report that member's error alone.
      const targetTypes = typesOf(target);
      const errorNode = this.errorNode!;
      const intrinsicAttributes = getJsxType(c, 'IntrinsicAttributes', errorNode);
      const intrinsicClassAttributes = getJsxType(c, 'IntrinsicClassAttributes', errorNode);
      if (
        !isErrorType(c, intrinsicAttributes) &&
        !isErrorType(c, intrinsicClassAttributes) &&
        (targetTypes.includes(intrinsicAttributes) || targetTypes.includes(intrinsicClassAttributes))
      )
        return;
    } else if (
      (originalTarget.flags & TypeFlags.Intersection) !== 0 &&
      (lazyObjectFlags(c, originalTarget) & ObjectFlags.IsNeverIntersection) !== 0
    ) {
      const props = getPropertiesOfUnionOrIntersectionType(c, originalTarget as IntersectionType);
      let message =
        Diagnostics.The_intersection_0_was_reduced_to_never_because_property_1_has_conflicting_types_in_some_constituents;
      let prop: Symbol | undefined;
      for (const p of props) {
        if (isDiscriminantWithNeverType(c, p)) {
          prop = p;
          break;
        }
      }
      if (prop === undefined) {
        message =
          Diagnostics.The_intersection_0_was_reduced_to_never_because_property_1_exists_in_multiple_constituents_and_is_private_in_some;
        for (const p of props) {
          if (isConflictingPrivateProperty(p)) {
            prop = p;
            break;
          }
        }
      }
      if (prop !== undefined)
        this.reportError(message, [typeToString(c, originalTarget, undefined, 1 << 29), symbolToString(c, prop)]);
    }
    this.reportRelationError(headMessage, source, target);
    if (
      (source.flags & TypeFlags.TypeParameter) !== 0 &&
      source.symbol !== undefined &&
      declarationCount(source.symbol) !== 0 &&
      getConstraintOfType(c, source) === undefined
    ) {
      const syntheticParam = cloneTypeParameter(c, source);
      syntheticParam.constraint = instantiateType(c, target, new SimpleTypeMapper(source, syntheticParam));
      if (hasNonCircularBaseConstraint(c, syntheticParam)) {
        this.relatedInfo.push(
          createDiagnosticForNode(
            source.symbol.declaration!,
            Diagnostics.This_type_parameter_might_need_an_extends_0_constraint,
            [typeToString(c, target)],
          ),
        );
      }
    }
  }

  tryElaborateErrorsForPrimitivesAndObjects(source: Type, target: Type): void {
    const c = this.c;
    if (
      (source === c.globalStringType && target === c.stringType) ||
      (source === c.globalNumberType && target === c.numberType) ||
      (source === c.globalBooleanType && target === c.booleanType)
    )
      this.reportError(Diagnostics.X_0_is_a_primitive_but_1_is_a_wrapper_object_Prefer_using_0_when_possible, [
        typeToString(c, target),
        typeToString(c, source),
      ]);
  }

  reportRelationError(message: DiagnosticMessage | undefined, source: Type, target: Type): void {
    const c = this.c;
    const names = getTypeNamesForErrorDisplay(c, source, target);
    const sourceType = names[0];
    const targetType = names[1];
    let generalizedSourceType = sourceType;
    let generalizedSource = source;
    // `never` targets keep the literal, for assertNever.
    if (
      (target.flags & TypeFlags.Never) === 0 &&
      isLiteralType(source) &&
      !typeCouldHaveTopLevelSingletonTypes(c, target)
    ) {
      generalizedSource = getBaseTypeOfLiteralType(c, source);
      generalizedSourceType = typeToString(c, generalizedSource, undefined, 1 << 6);
    }
    const targetFlags =
      (target.flags & TypeFlags.IndexedAccess) !== 0 && (source.flags & TypeFlags.IndexedAccess) === 0
        ? (target as IndexedAccessType).objectType.flags
        : target.flags;
    if (
      (targetFlags & TypeFlags.TypeParameter) !== 0 &&
      target !== c.markerSuperTypeForCheck &&
      target !== c.markerSubTypeForCheck
    ) {
      const constraint = getBaseConstraintOfType(c, target);
      if (
        isDistributedTypeParameter(target) &&
        isTypeAssignableTo(c, generalizedSource, (target as TypeParameter).constraint!)
      )
        this.reportError(Diagnostics.X_0_is_only_assignable_to_the_non_distributed_1_but_1_has_been_distributed_here, [
          generalizedSourceType,
          targetType,
        ]);
      else if (constraint !== undefined && isTypeAssignableTo(c, generalizedSource, constraint))
        this.reportError(
          Diagnostics.X_0_is_assignable_to_the_constraint_of_type_1_but_1_could_be_instantiated_with_a_different_subtype_of_constraint_2,
          [generalizedSourceType, targetType, typeToString(c, constraint)],
        );
      else if (constraint !== undefined && isTypeAssignableTo(c, source, constraint))
        this.reportError(
          Diagnostics.X_0_is_assignable_to_the_constraint_of_type_1_but_1_could_be_instantiated_with_a_different_subtype_of_constraint_2,
          [sourceType, targetType, typeToString(c, constraint)],
        );
      else {
        // Reported once.
        this.errorChain = undefined;
        this.reportError(Diagnostics.X_0_could_be_instantiated_with_an_arbitrary_type_which_could_be_unrelated_to_1, [
          targetType,
          generalizedSourceType,
        ]);
      }
    }
    if (message === undefined) {
      if (this.relation === c.comparableRelation) message = Diagnostics.Type_0_is_not_comparable_to_type_1;
      else if (sourceType === targetType)
        message =
          Diagnostics.Type_0_is_not_assignable_to_type_1_Two_different_types_with_this_name_exist_but_they_are_unrelated;
      else if (c.exactOptionalPropertyTypes && getExactOptionalUnassignableProperties(c, source, target).length !== 0)
        message =
          Diagnostics.Type_0_is_not_assignable_to_type_1_with_exactOptionalPropertyTypes_Colon_true_Consider_adding_undefined_to_the_types_of_the_target_s_properties;
      else {
        if ((source.flags & TypeFlags.StringLiteral) !== 0 && (target.flags & TypeFlags.Union) !== 0) {
          const suggested = getSuggestedTypeForNonexistentStringLiteralType(c, source, target);
          if (suggested !== undefined) {
            this.reportError(Diagnostics.Type_0_is_not_assignable_to_type_1_Did_you_mean_2, [
              generalizedSourceType,
              targetType,
              typeToString(c, suggested),
            ]);
            return;
          }
        }
        message = Diagnostics.Type_0_is_not_assignable_to_type_1;
      }
    } else if (
      message === Diagnostics.Argument_of_type_0_is_not_assignable_to_parameter_of_type_1 &&
      c.exactOptionalPropertyTypes &&
      getExactOptionalUnassignableProperties(c, source, target).length !== 0
    )
      message =
        Diagnostics.Argument_of_type_0_is_not_assignable_to_parameter_of_type_1_with_exactOptionalPropertyTypes_Colon_true_Consider_adding_undefined_to_the_types_of_the_target_s_properties;
    switch (this.getChainMessage(0)) {
      // Suppressed after an excess property error.
      case Diagnostics.Object_literal_may_only_specify_known_properties_and_0_does_not_exist_in_type_1:
      case Diagnostics.Object_literal_may_only_specify_known_properties_but_0_does_not_exist_in_type_1_Did_you_mean_to_write_2:
        return;
      case Diagnostics.Excessive_complexity_comparing_types_0_and_1:
      case Diagnostics.The_type_0_is_readonly_and_cannot_be_assigned_to_the_mutable_type_1:
        if (this.chainArgsMatch(generalizedSourceType, targetType, undefined)) return;
        break;
      case Diagnostics.Property_0_is_missing_in_type_1_but_required_in_type_2:
        if (
          !isConversionOrInterfaceImplementationMessage(message) &&
          this.chainArgsMatch(undefined, generalizedSourceType, targetType)
        )
          return;
        break;
      case Diagnostics.Type_0_is_missing_the_following_properties_from_type_1_Colon_2_and_3_more:
      case Diagnostics.Type_0_is_missing_the_following_properties_from_type_1_Colon_2:
        if (
          !isConversionOrInterfaceImplementationMessage(message) &&
          this.chainArgsMatch(generalizedSourceType, targetType, undefined)
        )
          return;
        break;
    }
    this.reportError(message, [generalizedSourceType, targetType]);
  }

  reportError(message: DiagnosticMessage, args: string[]): void {
    if (message === Diagnostics.Types_of_property_0_are_incompatible) {
      switch (this.getChainMessage(0)) {
        case Diagnostics.Object_literal_may_only_specify_known_properties_and_0_does_not_exist_in_type_1:
        case Diagnostics.Object_literal_may_only_specify_known_properties_but_0_does_not_exist_in_type_1_Did_you_mean_to_write_2:
          return;
      }
      // A property followed by a return type incompatibility becomes one message for `x()`.
      let arg = '';
      switch (this.getChainMessage(1)) {
        case Diagnostics.Call_signatures_with_no_arguments_have_incompatible_return_types_0_and_1:
          arg = getPropertyNameArg(args[0]!) + '()';
          break;
        case Diagnostics.Construct_signatures_with_no_arguments_have_incompatible_return_types_0_and_1:
          arg = 'new ' + getPropertyNameArg(args[0]!) + '()';
          break;
        case Diagnostics.Call_signature_return_types_0_and_1_are_incompatible:
          arg = getPropertyNameArg(args[0]!) + '(...)';
          break;
        case Diagnostics.Construct_signature_return_types_0_and_1_are_incompatible:
          arg = 'new ' + getPropertyNameArg(args[0]!) + '(...)';
          break;
      }
      if (arg !== '') {
        message = Diagnostics.The_types_returned_by_0_are_incompatible_between_these_types;
        args = [arg];
        this.errorChain = this.errorChain!.next!.next;
      }
      // Nested property incompatibilities become one message for `x.y`.
      switch (this.getChainMessage(1)) {
        case Diagnostics.Types_of_property_0_are_incompatible:
        case Diagnostics.The_types_of_0_are_incompatible_between_these_types:
        case Diagnostics.The_types_returned_by_0_are_incompatible_between_these_types: {
          const head = getPropertyNameArg(args[0]!);
          const tail = getPropertyNameArg(this.errorChain!.next!.args[0]!);
          const dotted = addToDottedName(head, tail);
          this.errorChain = this.errorChain!.next!.next;
          if (message === Diagnostics.Types_of_property_0_are_incompatible)
            message = Diagnostics.The_types_of_0_are_incompatible_between_these_types;
          this.reportError(message, [dotted]);
          return;
        }
      }
    }
    this.errorChain = new ErrorChain(this.errorChain, message, args);
  }

  getChainMessage(index: number): DiagnosticMessage | undefined {
    let e = this.errorChain;
    while (e !== undefined) {
      if (index === 0) return e.message;
      e = e.next;
      index--;
    }
    return undefined;
  }

  /** Whether the head's arguments match, with undefined as a wildcard. */
  chainArgsMatch(a0: string | undefined, a1: string | undefined, a2: string | undefined): boolean {
    const args = this.errorChain!.args;
    return (
      (a0 === undefined || args[0]! === a0) &&
      (a1 === undefined || args[1]! === a1) &&
      (a2 === undefined || args[2]! === a2)
    );
  }
}

function visibilityToString(flags: ModifierFlags): string {
  if (flags === ModifierFlags.Private) return 'private';
  if (flags === ModifierFlags.Protected) return 'protected';
  return 'public';
}

// ---- Helpers

export function getNormalizedType(c: Checker, t: Type, writing: boolean): Type {
  for (;;) {
    let n: Type;
    if (isFreshLiteralType(t)) n = (t as LiteralType).regularType;
    else if (isGenericTupleType(t)) n = getNormalizedTupleType(c, t, writing);
    else if ((t.objectFlags & ObjectFlags.Reference) !== 0 && (t.flags & TypeFlags.Object) !== 0)
      n =
        (t as TypeReference).node !== undefined
          ? createTypeReference(c, (t as TypeReference).target!, getTypeArguments(c, t))
          : (getSingleBaseForNonAugmentingSubtype(c, t) ?? t);
    else if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) n = getNormalizedUnionOrIntersectionType(c, t, writing);
    else if ((t.flags & TypeFlags.Substitution) !== 0)
      n = writing ? (t as SubstitutionType).baseType : getSubstitutionIntersection(c, t);
    else if ((t.flags & TypeFlags.Simplifiable) !== 0) n = getSimplifiedType(c, t, writing);
    else return t;
    if (n === t) return n;
    t = n;
  }
}

/** The one base of a class or interface reference that declares no members of its own, which it relates as. */
export function getSingleBaseForNonAugmentingSubtype(c: Checker, t: Type): Type | undefined {
  if ((t.objectFlags & ObjectFlags.Reference) === 0 || (t.flags & TypeFlags.Object) === 0) return undefined;
  const reference = t as TypeReference;
  if ((reference.target!.objectFlags & ObjectFlags.ClassOrInterface) === 0) return undefined;
  const target = reference.target as InterfaceType;
  const key = cachedTypeKey(CachedTypeKind.EquivalentBaseType, t.id);
  const side = sideOf(c, t);
  if ((side.objectFlags & ObjectFlags.IdenticalBaseTypeCalculated) !== 0) return c.cachedTypesById.get(key);
  side.objectFlags |= ObjectFlags.IdenticalBaseTypeCalculated;
  if ((target.objectFlags & ObjectFlags.Class) !== 0) {
    // Only base types named by simple qualified names; others may refer back to the class.
    const declaration = target.symbol?.valueDeclaration;
    const baseTypeNode = declaration !== undefined ? getExtendsHeritageClauseElement(declaration) : undefined;
    if (baseTypeNode !== undefined) {
      const expression = getExpression(baseTypeNode)!;
      if (expression.kind !== SyntaxKind.Identifier && expression.kind !== SyntaxKind.PropertyAccessExpression)
        return undefined;
    }
  }
  const bases = getBaseTypes(c, target);
  if (bases.length !== 1) return undefined;
  // Members of its own may subtype members of the base, which needs a structural comparison.
  if (t.symbol !== undefined && getMembersOfSymbol(c, t.symbol).size !== 0) return undefined;
  const typeParameters = target.typeParameters();
  const typeArguments = getTypeArguments(c, t);
  let instantiatedBase =
    typeParameters.length === 0
      ? bases[0]!
      : instantiateType(
          c,
          bases[0]!,
          newTypeMapper(typeParameters.slice(), typeArguments.slice(0, typeParameters.length)),
        );
  if (typeArguments.length > typeParameters.length)
    instantiatedBase = getTypeWithThisArgument(c, instantiatedBase, typeArguments[typeArguments.length - 1]!, false);
  c.cachedTypesById.set(key, instantiatedBase);
  return instantiatedBase;
}

function getNormalizedUnionOrIntersectionType(c: Checker, t: Type, writing: boolean): Type {
  const reduced = getReducedType(c, t);
  if (reduced !== t) return reduced;
  if ((t.flags & TypeFlags.Intersection) !== 0 && shouldNormalizeIntersection(c, t)) {
    // Distributes `Partial<T>[K] & ({} | null)` and the like.
    const types = typesOf(t);
    let changed = false;
    const normalized: Type[] = [];
    for (const u of types) {
      const n = getNormalizedType(c, u, writing);
      if (n !== u) changed = true;
      normalized.push(n);
    }
    if (changed) return getIntersectionType(c, normalized);
  }
  return t;
}

function shouldNormalizeIntersection(c: Checker, t: Type): boolean {
  let hasInstantiable = false;
  let hasNullableOrEmpty = false;
  for (const u of typesOf(t)) {
    hasInstantiable = hasInstantiable || (u.flags & TypeFlags.Instantiable) !== 0;
    hasNullableOrEmpty = hasNullableOrEmpty || (u.flags & TypeFlags.Nullable) !== 0 || isEmptyAnonymousObjectType(c, u);
    if (hasInstantiable && hasNullableOrEmpty) return true;
  }
  return false;
}

function getNormalizedTupleType(c: Checker, t: Type, writing: boolean): Type {
  const elements = getElementTypes(c, t);
  let changed = false;
  const normalized: Type[] = [];
  for (const e of elements) {
    const n = (e.flags & TypeFlags.Simplifiable) !== 0 ? getSimplifiedType(c, e, writing) : e;
    if (n !== e) changed = true;
    normalized.push(n);
  }
  return changed ? createNormalizedTypeReference(c, (t as TypeReference).target!, normalized) : t;
}

export function isWeakType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Object) !== 0) {
    const resolved = resolveStructuredTypeMembers(c, t);
    return (
      resolved.callSignatures.length === 0 &&
      resolved.constructSignatures.length === 0 &&
      resolved.indexInfos.length === 0 &&
      hasResolvedProperties(resolved) &&
      resolvedPropertiesAreOptional(resolved)
    );
  }
  if ((t.flags & TypeFlags.Substitution) !== 0) return isWeakType(c, (t as SubstitutionType).baseType);
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (!isWeakType(c, u)) return false;
    return true;
  }
  return false;
}

function hasCommonProperties(c: Checker, source: Type, target: Type, isComparingJsxAttributes: boolean): boolean {
  for (const prop of getPropertiesOfType(c, source))
    if (isKnownProperty(c, target, prop.name, isComparingJsxAttributes)) return true;
  return false;
}

/** Whether `name` is known anywhere in `targetType`: declared, covered by an index signature, or in some constituent. */
export function isKnownProperty(
  c: Checker,
  targetType: Type,
  name: string,
  isComparingJsxAttributes: boolean,
): boolean {
  if ((targetType.flags & TypeFlags.Object) !== 0) {
    if (
      getPropertyOfObjectType(c, targetType, name) !== undefined ||
      getApplicableIndexInfoForName(c, targetType, name) !== undefined ||
      (isLateBoundName(name) && getIndexInfoOfType(c, targetType, c.stringType) !== undefined) ||
      (isComparingJsxAttributes && name.includes('-'))
    )
      return true;
  }
  if ((targetType.flags & TypeFlags.Substitution) !== 0)
    return isKnownProperty(c, (targetType as SubstitutionType).baseType, name, isComparingJsxAttributes);
  if ((targetType.flags & TypeFlags.UnionOrIntersection) !== 0 && isExcessPropertyCheckTarget(targetType))
    for (const t of typesOf(targetType)) if (isKnownProperty(c, t, name, isComparingJsxAttributes)) return true;
  return false;
}

function isExcessPropertyCheckTarget(t: Type): boolean {
  if ((t.flags & TypeFlags.Object) !== 0)
    return (t.objectFlags & ObjectFlags.ObjectLiteralPatternWithComputedProperties) === 0;
  if ((t.flags & TypeFlags.NonPrimitive) !== 0) return true;
  if ((t.flags & TypeFlags.Substitution) !== 0) return isExcessPropertyCheckTarget((t as SubstitutionType).baseType);
  if ((t.flags & TypeFlags.Union) !== 0) {
    for (const u of typesOf(t)) if (isExcessPropertyCheckTarget(u)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (!isExcessPropertyCheckTarget(u)) return false;
    return true;
  }
  return false;
}

function shouldCheckAsExcessProperty(prop: Symbol, container: Symbol | undefined): boolean {
  return (
    prop.valueDeclaration !== undefined &&
    container !== undefined &&
    container.valueDeclaration !== undefined &&
    prop.valueDeclaration.parent === container.valueDeclaration
  );
}

function isIgnoredJsxProperty(source: Type, prop: Symbol): boolean {
  return (source.objectFlags & ObjectFlags.JsxAttributes) !== 0 && prop.name.includes('-');
}

function isObjectLiteralElement(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.SpreadAssignment:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return true;
  }
  return false;
}

function isAncestor(node: Node, ancestor: Node): boolean {
  for (let n: Node | undefined = node; n !== undefined; n = n.parent) if (n === ancestor) return true;
  return false;
}

function rootOf(node: Node): Node {
  let n = node;
  while (n.parent !== undefined) n = n.parent;
  return n;
}

function sameFile(a: Node, b: Node | undefined): boolean {
  return b !== undefined && rootOf(a) === rootOf(b);
}

export function isTypeSubsetOf(c: Checker, source: Type, target: Type): boolean {
  return (
    source === target ||
    (source.flags & TypeFlags.Never) !== 0 ||
    ((target.flags & TypeFlags.Union) !== 0 && isTypeSubsetOfUnion(c, source, target))
  );
}

function isTypeSubsetOfUnion(c: Checker, source: Type, target: Type): boolean {
  const union = target as UnionType;
  if ((source.flags & TypeFlags.Union) !== 0) return unionContainsSortedTypes(c, union, typesOf(source));
  if ((source.flags & TypeFlags.EnumLike) !== 0 && getBaseTypeOfEnumLikeType(c, source) === target) return true;
  return unionContainsType(c, union, source);
}

function getTypeOfPropertyInTypes(c: Checker, types: readonly Type[], name: string): Type {
  const propTypes: Type[] = [];
  for (const t of types) propTypes.push(getTypeOfPropertyInType(c, t, name));
  return getUnionType(c, propTypes);
}

function getTypeOfPropertyInType(c: Checker, t: Type, name: string): Type {
  t = getApparentType(c, t);
  const prop =
    (t.flags & TypeFlags.UnionOrIntersection) !== 0
      ? getPropertyOfUnionOrIntersectionType(c, t as UnionOrIntersectionType, name, false)
      : getPropertyOfObjectType(c, t, name);
  if (prop !== undefined) return getTypeOfSymbol(c, prop);
  const indexInfo = getApplicableIndexInfoForName(c, t, name);
  return indexInfo !== undefined ? indexInfo.valueType : c.undefinedType;
}

export function getRegularTypeOfObjectLiteral(c: Checker, t: Type): Type {
  return getRegularTypeOfObjectLiteralLazy(c, t);
}

import {
  getRegularTypeOfObjectLiteral as getRegularTypeOfObjectLiteralLazy,
  getLiteralTypeFromPropertyForRelations as getLiteralTypeFromPropertyLazy,
} from './checker-literals.js';

function filterPrimitivesIfContainsNonPrimitive(c: Checker, t: Type): Type {
  if (typesOf(t).some((u) => (u.flags & TypeFlags.NonPrimitive) !== 0)) {
    const result = filterType(c, t, (u) => (u.flags & TypeFlags.Primitive) === 0);
    if ((result.flags & TypeFlags.Never) === 0) return result;
  }
  return t;
}

function findMatchingDiscriminantType(c: Checker, source: Type, target: Type, relater: Relater): Type | undefined {
  if ((target.flags & TypeFlags.Union) === 0 || (source.flags & (TypeFlags.Intersection | TypeFlags.Object)) === 0)
    return undefined;
  const match = getMatchingUnionConstituentForType(c, target as UnionType, source);
  if (match !== undefined) return match;
  const discriminants: Symbol[] = [];
  for (const p of getPropertiesOfType(c, source)) if (isDiscriminantProperty(c, target, p.name)) discriminants.push(p);
  if (discriminants.length === 0) return undefined;
  const discriminated = discriminateTypeByDiscriminants(c, target, discriminants, relater);
  return discriminated !== target ? discriminated : undefined;
}

/**
 * The constituents of the union `target` whose types of each discriminant property the source's
 * values relate to (discriminateTypeByDiscriminableItems). Primitive and never constituents are left
 * out. A discriminant that no remaining constituent matches is ignored, so the result is never empty.
 */
function discriminateTypeByDiscriminants(c: Checker, target: Type, discriminants: Symbol[], relater: Relater): Type {
  const types = typesOf(target);
  const include: Ternary[] = [];
  for (const t of types)
    include.push(
      (t.flags & TypeFlags.Primitive) === 0 && (getReducedType(c, t).flags & TypeFlags.Never) === 0
        ? Ternary.True
        : Ternary.False,
    );
  for (const prop of discriminants) {
    let matched = false;
    for (let i = 0; i < types.length; i++) {
      if (include[i] === Ternary.False) continue;
      const targetType = getTypeOfPropertyOrIndexSignatureOfType(c, types[i]!, prop.name);
      if (targetType === undefined) continue;
      if (someType(getTypeOfSymbol(c, prop), (s) => relater.isRelatedToSimple(s, targetType) !== Ternary.False))
        matched = true;
      else include[i] = Ternary.Maybe;
    }
    // Without a match the discriminant is ignored.
    for (let i = 0; i < types.length; i++)
      if (include[i] === Ternary.Maybe) include[i] = matched ? Ternary.False : Ternary.True;
  }
  if (!include.includes(Ternary.False)) return target;
  const filtered: Type[] = [];
  for (let i = 0; i < types.length; i++) if (include[i] === Ternary.True) filtered.push(types[i]!);
  const result = getUnionTypeEx(c, filtered, UnionReduction.None, undefined, undefined);
  return (result.flags & TypeFlags.Never) === 0 ? result : target;
}

function getTypeOfPropertyOrIndexSignatureOfType(c: Checker, t: Type, name: string): Type | undefined {
  const propType = getTypeOfPropertyOfType(c, t, name);
  if (propType !== undefined) return propType;
  const info = getApplicableIndexInfoForName(c, t, name);
  return info !== undefined ? getOptionalType(c, info.valueType, true) : undefined;
}

export function isDiscriminantProperty(c: Checker, t: Type, name: string): boolean {
  if ((t.flags & TypeFlags.Union) === 0) return false;
  const prop = getUnionOrIntersectionProperty(c, t as UnionType, name, false);
  if (prop === undefined || (prop.checkFlags & CheckFlags.SyntheticProperty) === 0) return false;
  if ((prop.checkFlags & CheckFlags.IsDiscriminantComputed) === 0) {
    prop.checkFlags |= CheckFlags.IsDiscriminantComputed;
    if (
      (prop.checkFlags & CheckFlags.NonUniformAndLiteral) === CheckFlags.NonUniformAndLiteral &&
      !isGenericTypeLocal(c, getTypeOfSymbol(c, prop))
    )
      prop.checkFlags |= CheckFlags.IsDiscriminant;
  }
  return (prop.checkFlags & CheckFlags.IsDiscriminant) !== 0;
}

import { isGenericType as isGenericTypeLocal } from './checker-type-operators.js';

/** The constituent selected by a key property's unit type; not computed yet. */
export function getMatchingUnionConstituentForType(_c: Checker, _unionType: UnionType, _t: Type): Type | undefined {
  return undefined;
}

/** The constituent of the union `target` that `source` most likely meant, for error elaboration. */
export function getBestMatchingTypeForElaboration(c: Checker, source: Type, target: Type): Type | undefined {
  return getBestMatchingType(c, source, target, new Relater(c, c.assignableRelation, undefined));
}

function getBestMatchingType(c: Checker, source: Type, target: Type, relater: Relater): Type | undefined {
  return (
    findMatchingDiscriminantType(c, source, target, relater) ??
    findMatchingTypeReferenceOrTypeAliasReference(source, target) ??
    findBestTypeForObjectLiteral(c, source, target) ??
    findBestTypeForInvokable(c, source, target, SignatureKind.Call) ??
    findBestTypeForInvokable(c, source, target, SignatureKind.Construct) ??
    findMostOverlappyType(c, source, target)
  );
}

function findMatchingTypeReferenceOrTypeAliasReference(source: Type, unionTarget: Type): Type | undefined {
  const sourceObjectFlags = source.objectFlags;
  if (
    (sourceObjectFlags & (ObjectFlags.Reference | ObjectFlags.Anonymous)) === 0 ||
    (source.flags & TypeFlags.Object) === 0 ||
    (unionTarget.flags & TypeFlags.Union) === 0
  )
    return undefined;
  for (const target of typesOf(unionTarget)) {
    if ((target.flags & TypeFlags.Object) === 0) continue;
    const overlap = sourceObjectFlags & target.objectFlags;
    if (
      (overlap & ObjectFlags.Reference) !== 0 &&
      (source as TypeReference).target === (target as TypeReference).target
    )
      return target;
    if (
      (overlap & ObjectFlags.Anonymous) !== 0 &&
      source.alias !== undefined &&
      target.alias !== undefined &&
      source.alias.symbol === target.alias.symbol
    )
      return target;
  }
  return undefined;
}

function findBestTypeForInvokable(c: Checker, source: Type, unionTarget: Type, kind: SignatureKind): Type | undefined {
  if (getSignaturesOfType(c, source, kind).length === 0) return undefined;
  for (const t of typesOf(unionTarget)) if (getSignaturesOfType(c, t, kind).length !== 0) return t;
  return undefined;
}

function findMostOverlappyType(c: Checker, source: Type, unionTarget: Type): Type | undefined {
  if ((source.flags & (TypeFlags.Primitive | TypeFlags.InstantiablePrimitive)) !== 0) return undefined;
  let bestMatch: Type | undefined;
  let matchingCount = 0;
  for (const target of typesOf(unionTarget)) {
    if ((target.flags & (TypeFlags.Primitive | TypeFlags.InstantiablePrimitive)) !== 0) continue;
    const overlap = getIntersectionType(c, [getIndexType(c, source), getIndexType(c, target)]);
    if ((overlap.flags & TypeFlags.Index) !== 0) return target;
    if (isUnitType(overlap) || (overlap.flags & TypeFlags.Union) !== 0) {
      const length = (overlap.flags & TypeFlags.Union) !== 0 ? countUnitTypes(typesOf(overlap)) : 1;
      if (length >= matchingCount) {
        bestMatch = target;
        matchingCount = length;
      }
    }
  }
  return bestMatch;
}

function symbolNames(c: Checker, symbols: Symbol[]): string {
  const names: string[] = [];
  for (const s of symbols) names.push(symbolToString(c, s));
  return names.join(', ');
}

function countUnitTypes(types: Type[]): number {
  let count = 0;
  for (const t of types) if (isUnitType(t)) count++;
  return count;
}

function findBestTypeForObjectLiteral(c: Checker, source: Type, unionTarget: Type): Type | undefined {
  if ((source.objectFlags & ObjectFlags.ObjectLiteral) !== 0 && someType(unionTarget, (t) => isArrayLikeType(c, t)))
    for (const t of typesOf(unionTarget)) if (!isArrayLikeType(c, t)) return t;
  return undefined;
}

function shouldReportUnmatchedPropertyError(c: Checker, source: Type, target: Type): boolean {
  const calls = getSignaturesOfStructuredType(c, source, SignatureKind.Call);
  const constructs = getSignaturesOfStructuredType(c, source, SignatureKind.Construct);
  const properties = getPropertiesOfObjectType(c, source);
  if ((calls.length !== 0 || constructs.length !== 0) && properties.length === 0)
    return (
      (getSignaturesOfType(c, target, SignatureKind.Call).length !== 0 && calls.length !== 0) ||
      (getSignaturesOfType(c, target, SignatureKind.Construct).length !== 0 && constructs.length !== 0)
    );
  return true;
}

function isStaticPrivateIdentifierProperty(prop: Symbol): boolean {
  const d = prop.valueDeclaration;
  if (d === undefined) return false;
  const name = getName(d);
  return (
    name !== undefined &&
    name.kind === SyntaxKind.PrivateIdentifier &&
    (getCombinedModifierFlags(d) & ModifierFlags.Static) !== 0
  );
}

export function getUnmatchedProperty(
  c: Checker,
  source: Type,
  target: Type,
  requireOptionalProperties: boolean,
  matchDiscriminantProperties: boolean,
): Symbol | undefined {
  for (const targetProp of getPropertiesOfType(c, target))
    if (isUnmatchedProperty(c, source, targetProp, requireOptionalProperties, matchDiscriminantProperties))
      return targetProp;
  return undefined;
}

/** Whether `getUnmatchedProperty` reports `targetProp`, a property of the target. */
export function isUnmatchedProperty(
  c: Checker,
  source: Type,
  targetProp: Symbol,
  requireOptionalProperties: boolean,
  matchDiscriminantProperties: boolean,
): boolean {
  if (isStaticPrivateIdentifierProperty(targetProp)) return false;
  if (
    !requireOptionalProperties &&
    ((targetProp.flags & SymbolFlags.Optional) !== 0 || (targetProp.checkFlags & CheckFlags.Partial) !== 0)
  )
    return false;
  const sourceProp = getPropertyOfType(c, source, targetProp.name);
  if (sourceProp === undefined) return true;
  if (!matchDiscriminantProperties) return false;
  // A unit-typed (discriminant) property whose literal differs in the source is unmatched.
  const targetType = getTypeOfSymbol(c, targetProp);
  if ((targetType.flags & TypeFlags.Unit) === 0) return false;
  const sourceType = getTypeOfSymbol(c, sourceProp);
  return !(
    (sourceType.flags & TypeFlags.Any) !== 0 ||
    getRegularTypeOfLiteralType(c, sourceType) === getRegularTypeOfLiteralType(c, targetType)
  );
}

export function getUnmatchedProperties(
  c: Checker,
  source: Type,
  target: Type,
  requireOptionalProperties: boolean,
): Symbol[] {
  const result: Symbol[] = [];
  for (const targetProp of getPropertiesOfType(c, target)) {
    if (isStaticPrivateIdentifierProperty(targetProp)) continue;
    if (
      requireOptionalProperties ||
      ((targetProp.flags & SymbolFlags.Optional) === 0 && (targetProp.checkFlags & CheckFlags.Partial) === 0)
    )
      if (getPropertyOfType(c, source, targetProp.name) === undefined) result.push(targetProp);
  }
  return result;
}

function getDeclaringClass(c: Checker, prop: Symbol): Type | undefined {
  return prop.parent !== undefined && (prop.parent.flags & SymbolFlags.Class) !== 0
    ? getDeclaredTypeOfSymbol(c, getParentOfSymbol(c, prop)!)
    : undefined;
}

/** Whether `sourceProp`'s class derives from `targetProp`'s, for protected members. */
/** Whether every protected constituent of `targetProp` is declared in a base of a class declaring `sourceProp`. */
function isValidOverrideOf(c: Checker, sourceProp: Symbol, targetProp: Symbol): boolean {
  return !forEachProperty(
    c,
    targetProp,
    (tp) =>
      (getDeclarationModifierFlagsFromSymbol(c, tp, false) & ModifierFlags.Protected) !== 0 &&
      !isPropertyInClassDerivedFrom(c, sourceProp, getDeclaringClass(c, tp)),
  );
}

/** Whether some underlying property of `prop` is declared in a class deriving from `baseClass`. */
function isPropertyInClassDerivedFrom(c: Checker, prop: Symbol, baseClass: Type | undefined): boolean {
  return forEachProperty(c, prop, (sp) => {
    const sourceClass = getDeclaringClass(c, sp);
    return sourceClass !== undefined && baseClass !== undefined && hasBaseType(c, sourceClass, baseClass);
  });
}

/** Calls `callback` with a property, or with the underlying properties of a synthetic one, until it returns true. */
function forEachProperty(c: Checker, prop: Symbol, callback: (p: Symbol) => boolean): boolean {
  if ((prop.checkFlags & CheckFlags.Synthetic) === 0) return callback(prop);
  const containingType = c.symbolContainingTypes.get(getSymbolId(prop));
  if (containingType === undefined) return false;
  for (const t of typesOf(containingType)) {
    const p = getPropertyOfType(c, t, prop.name);
    if (p !== undefined && forEachProperty(c, p, callback)) return true;
  }
  return false;
}

export function isObjectTypeWithInferableIndex(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (!isObjectTypeWithInferableIndex(c, u)) return false;
    return true;
  }
  return (
    (t.symbol !== undefined &&
      (t.symbol.flags &
        (SymbolFlags.ObjectLiteral | SymbolFlags.TypeLiteral | SymbolFlags.Enum | SymbolFlags.ValueModule)) !==
        0 &&
      (t.symbol.flags & SymbolFlags.Class) === 0 &&
      !typeHasCallOrConstructSignatures(c, t)) ||
    (t.objectFlags & (ObjectFlags.JSLiteral | ObjectFlags.ObjectRestType)) !== 0 ||
    // A reverse mapped type has an inferable index when its source does.
    ((t.objectFlags & ObjectFlags.ReverseMapped) !== 0 &&
      (t as ReverseMappedType).source !== undefined &&
      isObjectTypeWithInferableIndex(c, (t as ReverseMappedType).source!))
  );
}

export function typeHasCallOrConstructSignatures(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.StructuredType) === 0) return false;
  const resolved = resolveStructuredTypeMembers(c, t);
  return resolved.callSignatures.length !== 0 || resolved.constructSignatures.length !== 0;
}

/** Both names of the pair, fully qualified when they print the same. */
export function getTypeNamesForErrorDisplay(c: Checker, left: Type, right: Type): [string, string] {
  // The type of an expression that isn't context sensitive prints as written there.
  let leftStr = typeToString(c, left, contextFreeExpressionDeclaration(c, left));
  let rightStr = typeToString(c, right, contextFreeExpressionDeclaration(c, right));
  if (leftStr === rightStr) {
    leftStr = typeToString(c, left, undefined, 1 << 6);
    rightStr = typeToString(c, right, undefined, 1 << 6);
  }
  return [leftStr, rightStr];
}

function contextFreeExpressionDeclaration(c: Checker, t: Type): Node | undefined {
  const declaration = t.symbol?.valueDeclaration;
  if (declaration === undefined) return undefined;
  switch (declaration.kind) {
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.CallExpression:
      return isContextSensitive(c, declaration) ? undefined : declaration;
  }
  return undefined;
}

function typeCouldHaveTopLevelSingletonTypes(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Boolean) !== 0) return false;
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) {
    for (const u of typesOf(t)) if (typeCouldHaveTopLevelSingletonTypes(c, u)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.Instantiable) !== 0) {
    const constraint = getConstraintOfType(c, t);
    if (constraint !== undefined && constraint !== t) return typeCouldHaveTopLevelSingletonTypes(c, constraint);
  }
  return isUnitType(t) || (t.flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0;
}

/**
 * Puts `t` at `stack[depth]`. Recursion stacks keep their entries from `depth` on as stale slots,
 * which avoids releasing an entry on every pop.
 */
export function setStackEntry(stack: Type[], depth: number, t: Type): void {
  if (depth < stack.length) stack[depth] = t;
  else stack.push(t);
}

/**
 * Deeply nested: `maxDepth` or more same-identity types in `stack[0..depth)`, each newer than the
 * last.
 */
export function isDeeplyNestedType(
  c: Checker,
  t: Type,
  stack: readonly Type[],
  depth: number,
  maxDepth: number,
): boolean {
  if (depth < maxDepth) return false;
  const target = getRecursionIdentityTarget(c, t);
  if ((target.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(target)) if (isDeeplyNestedType(c, u, stack, depth, maxDepth)) return true;
    return false;
  }
  const identity = getRecursionIdentityFromTarget(target);
  let count = 0;
  let lastTypeId = 0;
  for (let i = 0; i < depth; i++) {
    const s = stack[i]!;
    if (hasMatchingRecursionIdentity(c, s, identity)) {
      if (s.id >= lastTypeId) {
        count++;
        if (count >= maxDepth) return true;
      }
      lastTypeId = s.id;
    }
  }
  return false;
}

/**
 * isDeeplyNestedType for the newest entry of `stack[start..end)`, counting only the entries in that range.
 * `identities` holds the recursion identity of each entry of the range once a check has computed it: 0 before
 * that, and -1 for an entry whose recursion identity target is an intersection, which is matched by its
 * constituents each time. Later checks compare the kept identities. The identities are computed when and in the
 * order isDeeplyNestedType computes them, so the types and symbol ids they create come in the same order.
 */
export function isDeeplyNestedStackEntry(
  c: Checker,
  stack: readonly Type[],
  identities: RecursionId[],
  start: number,
  end: number,
  maxDepth: number,
): boolean {
  if (end - start < maxDepth) return false;
  return isDeeplyNestedInRange(c, stack[end - 1]!, true, stack, identities, start, end, maxDepth);
}

function isDeeplyNestedInRange(
  c: Checker,
  t: Type,
  isEntry: boolean,
  stack: readonly Type[],
  identities: RecursionId[],
  start: number,
  end: number,
  maxDepth: number,
): boolean {
  const target = getRecursionIdentityTarget(c, t);
  if ((target.flags & TypeFlags.Intersection) !== 0) {
    if (isEntry) identities[end - 1] = -1;
    for (const u of typesOf(target))
      if (isDeeplyNestedInRange(c, u, false, stack, identities, start, end, maxDepth)) return true;
    return false;
  }
  const identity = getRecursionIdentityFromTarget(target);
  if (isEntry) identities[end - 1] = identity;
  let count = 0;
  let lastTypeId = 0;
  for (let i = start; i < end; i++) {
    const s = stack[i]!;
    let known = identities[i]!;
    if (known === 0) {
      const sourceTarget = getRecursionIdentityTarget(c, s);
      known = (sourceTarget.flags & TypeFlags.Intersection) !== 0 ? -1 : getRecursionIdentityFromTarget(sourceTarget);
      identities[i] = known;
    }
    if (known >= 0 ? known === identity : hasMatchingRecursionIdentity(c, s, identity)) {
      if (s.id >= lastTypeId) {
        count++;
        if (count >= maxDepth) return true;
      }
      lastTypeId = s.id;
    }
  }
  return false;
}

/**
 * The type whose recursion identity `t` has: the object type of an indexed access (T in T[K]), and for a
 * homomorphic mapped type the deepest target type that has a symbol. Unwrapping mapped types keeps the identities of
 * mapped types applied to written object literals unique: in `Mapped<{ x: Mapped<{ x: Mapped<{ x: string }>}>}>`,
 * each application has the identity of its object literal and does not appear deeply nested.
 */
function getRecursionIdentityTarget(c: Checker, t: Type): Type {
  for (;;) {
    if ((t.flags & TypeFlags.IndexedAccess) !== 0) {
      t = (t as IndexedAccessType).objectType;
      continue;
    }
    if (
      (t.objectFlags & ObjectFlags.InstantiatedMapped) === ObjectFlags.InstantiatedMapped &&
      (t.flags & TypeFlags.Object) !== 0
    ) {
      const target = getModifiersTypeFromMappedType(c, t as MappedType);
      if (
        target.symbol !== undefined ||
        ((target.flags & TypeFlags.Intersection) !== 0 && typesOf(target).some((u) => u.symbol !== undefined))
      ) {
        t = target;
        continue;
      }
    }
    return t;
  }
}

function hasMatchingRecursionIdentity(c: Checker, t: Type, identity: RecursionId): boolean {
  const target = getRecursionIdentityTarget(c, t);
  if ((target.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(target)) if (hasMatchingRecursionIdentity(c, u, identity)) return true;
    return false;
  }
  return getRecursionIdentityFromTarget(target) === identity;
}

/** An identity shared by instantiations of a type, so infinitely expanding instantiations can be detected. */
export function getRecursionIdentity(c: Checker, t: Type): RecursionId {
  return getRecursionIdentityFromTarget(getRecursionIdentityTarget(c, t));
}

function getRecursionIdentityFromTarget(t: Type): RecursionId {
  if (
    (t.flags & TypeFlags.Object) !== 0 &&
    (t.objectFlags & (ObjectFlags.ObjectLiteral | ObjectFlags.ArrayLiteral)) === 0
  ) {
    if ((t.objectFlags & ObjectFlags.Reference) !== 0 && (t as TypeReference).node !== undefined)
      return nodeRecursionId((t as TypeReference).node!);
    if (
      t.symbol !== undefined &&
      !((t.objectFlags & ObjectFlags.Anonymous) !== 0 && (t.symbol.flags & SymbolFlags.Class) !== 0) &&
      (t.objectFlags & ObjectFlags.FromTypeNode) === 0
    )
      return symbolRecursionId(t.symbol);
    if (isTupleType(t) && (t.objectFlags & ObjectFlags.FromTypeNode) === 0)
      return typeRecursionId((t as TypeReference).target!);
  }
  if ((t.flags & TypeFlags.TypeParameter) !== 0 && t.symbol !== undefined) return symbolRecursionId(t.symbol);
  if ((t.flags & TypeFlags.Conditional) !== 0) return nodeRecursionId((t as ConditionalType).root.node);
  return typeRecursionId(t);
}

function nodeRecursionId(node: Node): RecursionId {
  return getNodeId(node) * 4 + 1;
}

function symbolRecursionId(symbol: Symbol): RecursionId {
  return getSymbolId(symbol) * 4 + 2;
}

function typeRecursionId(t: Type): RecursionId {
  return t.id * 4 + 3;
}

// ---- Variance

export function isMarkerType(c: Checker, t: Type): boolean {
  return c.markerTypes.has(t);
}

export function getVariances(c: Checker, t: Type): VarianceFlags[] {
  // Arrays and tuples are covariant.
  if (t === c.globalArrayType || t === c.globalReadonlyArrayType || (t.objectFlags & ObjectFlags.Tuple) !== 0)
    return c.arrayVariances;
  return getVariancesWorker(c, t.symbol!, (t as InterfaceType).typeParameters());
}

export function getAliasVariances(c: Checker, symbol: Symbol): VarianceFlags[] {
  return getVariancesWorker(c, symbol, c.symbolLinks(symbol).typeParameters ?? emptyTypes);
}

/**
 * The measured variance of each type parameter, from relating marker instantiations; empty when
 * requested recursively.
 */
/** A generic type whose variances are being computed. */
export class VarianceStackEntry {
  constructor(
    readonly symbol: Symbol,
    readonly typeParameters: readonly Type[],
  ) {}
}

function getVariancesWorker(c: Checker, symbol: Symbol, typeParameters: readonly Type[]): VarianceFlags[] {
  const links = c.symbolLinks(symbol);
  if (links.variances !== undefined) return links.variances;
  let stackIndex = -1;
  for (let i = 0; i < c.varianceStack.length; i++)
    if (c.varianceStack[i]!.symbol === symbol) {
      stackIndex = i;
      break;
    }
  if (stackIndex >= 0) {
    // A circularity. The variances computed can depend on where the circular region is entered, so the
    // computation restarts from the generic type with the smallest symbol in the region if that is not this one,
    // which keeps the results of circular generic types stable.
    let minIndex = stackIndex;
    for (let i = stackIndex + 1; i < c.varianceStack.length; i++)
      if (compareSymbols(c, c.varianceStack[i]!.symbol, c.varianceStack[minIndex]!.symbol) < 0) minIndex = i;
    if (minIndex > stackIndex) {
      const saveVarianceStack = c.varianceStack;
      c.varianceStack = [];
      getVariancesWorker(c, saveVarianceStack[minIndex]!.symbol, saveVarianceStack[minIndex]!.typeParameters);
      c.varianceStack = saveVarianceStack;
    }
    // Variances that cannot be computed: the type parameters are treated as covariant. The computation in
    // progress stores its results over this.
    const stored = storedVariances(links);
    if (stored === undefined || stored.length === 0) links.variances = [];
    return links.variances!;
  }
  const saveResolutionStart = c.resolutionStart;
  if (c.varianceStack.length === 0) c.resolutionStart = c.resolutionDepth;
  c.varianceStack.push(new VarianceStackEntry(symbol, typeParameters));
  const variances: VarianceFlags[] = [];
  for (const tp of typeParameters) {
    const modifiers = getTypeParameterModifiers(tp);
    let variance: VarianceFlags;
    if ((modifiers & ModifierFlags.Out) !== 0)
      variance = (modifiers & ModifierFlags.In) !== 0 ? VarianceFlags.Invariant : VarianceFlags.Covariant;
    else if ((modifiers & ModifierFlags.In) !== 0) variance = VarianceFlags.Contravariant;
    else {
      const saveReliabilityFlags = c.reliabilityFlags;
      c.reliabilityFlags = 0;
      const typeWithSuper = createMarkerType(c, symbol, tp, c.markerSuperType);
      const typeWithSub = createMarkerType(c, symbol, tp, c.markerSubType);
      variance =
        (isTypeAssignableTo(c, typeWithSub, typeWithSuper) ? VarianceFlags.Covariant : 0) |
        (isTypeAssignableTo(c, typeWithSuper, typeWithSub) ? VarianceFlags.Contravariant : 0);
      // Bivariance may mean the parameter is unwitnessed.
      if (
        variance === VarianceFlags.Bivariant &&
        isTypeAssignableTo(c, createMarkerType(c, symbol, tp, c.markerOtherType), typeWithSuper)
      )
        variance = VarianceFlags.Independent;
      if ((c.reliabilityFlags & RelationComparisonResult.ReportsUnmeasurable) !== 0)
        variance |= VarianceFlags.Unmeasurable;
      if ((c.reliabilityFlags & RelationComparisonResult.ReportsUnreliable) !== 0) variance |= VarianceFlags.Unreliable;
      c.reliabilityFlags = saveReliabilityFlags;
    }
    // A computation restarted because of a circularity may have stored the variances already.
    const restarted = storedVariances(links);
    if (restarted !== undefined && restarted.length !== 0) break;
    variances.push(variance);
  }
  // Unless a restarted computation stored them.
  const stored = storedVariances(links);
  if (stored === undefined || stored.length === 0) links.variances = variances;
  c.varianceStack.pop();
  if (c.varianceStack.length === 0) c.resolutionStart = saveResolutionStart;
  return links.variances!;
}

/** The variances stored in `links`, read again after computations that may have stored them. */
function storedVariances(links: SymbolLinks): VarianceFlags[] | undefined {
  return links.variances;
}

export function createMarkerType(c: Checker, symbol: Symbol, source: Type, target: Type): Type {
  const mapper = new SimpleTypeMapper(source, target);
  const t = getDeclaredTypeOfSymbol(c, symbol);
  if (isErrorType(c, t)) return t;
  const typeArguments: Type[] = [];
  const typeParameters =
    (symbol.flags & SymbolFlags.TypeAlias) !== 0
      ? (c.symbolLinks(symbol).typeParameters ?? emptyTypes)
      : (t as InterfaceType).typeParameters();
  for (const p of typeParameters) typeArguments.push(instantiateType(c, p, mapper));
  const result =
    (symbol.flags & SymbolFlags.TypeAlias) !== 0
      ? getTypeAliasInstantiation(c, symbol, typeArguments, undefined)
      : createTypeReference(c, t, typeArguments);
  c.markerTypes.add(result);
  return result;
}

import { getTypeAliasInstantiation } from './checker-type-nodes.js';

export function getTypeParameterModifiers(tp: Type): ModifierFlags {
  let flags = 0;
  if (tp.symbol !== undefined) for (const d of getDeclarations(tp.symbol)) flags |= getCombinedModifierFlags(d);
  return flags & (ModifierFlags.In | ModifierFlags.Out | ModifierFlags.Const);
}

function someVarianceHasFlags(variances: readonly VarianceFlags[], flags: VarianceFlags): boolean {
  for (const v of variances) if ((v & flags) !== 0) return true;
  return false;
}

function someVarianceIsInvariant(variances: readonly VarianceFlags[]): boolean {
  for (const v of variances) if ((v & VarianceFlags.VarianceMask) === VarianceFlags.Invariant) return true;
  return false;
}

function hasCovariantVoidArgument(typeArguments: readonly Type[], variances: readonly VarianceFlags[]): boolean {
  for (let i = 0; i < variances.length; i++)
    if (
      (variances[i] & VarianceFlags.VarianceMask) === VarianceFlags.Covariant &&
      (typeArguments[i]!.flags & TypeFlags.Void) !== 0
    )
      return true;
  return false;
}

// ---- Misc structural helpers

function getEffectiveConstraintOfIntersection(
  c: Checker,
  types: readonly Type[],
  targetIsUnion: boolean,
): Type | undefined {
  let constraints: Type[] | undefined;
  let hasDisjointDomainType = false;
  for (const t of types) {
    if ((t.flags & TypeFlags.Instantiable) !== 0) {
      // Follow constraints known not to be circular.
      let constraint = getConstraintOfType(c, t);
      while (
        constraint !== undefined &&
        (constraint.flags & (TypeFlags.TypeParameter | TypeFlags.Index | TypeFlags.Conditional)) !== 0
      )
        constraint = getConstraintOfType(c, constraint);
      if (constraint !== undefined) {
        if (constraints === undefined) constraints = [];
        constraints.push(constraint);
        if (targetIsUnion) constraints.push(t);
      }
    } else if ((t.flags & TypeFlags.DisjointDomains) !== 0 || isEmptyAnonymousObjectType(c, t))
      hasDisjointDomainType = true;
  }
  if (constraints !== undefined && (targetIsUnion || hasDisjointDomainType)) {
    if (hasDisjointDomainType)
      for (const t of types)
        if ((t.flags & TypeFlags.DisjointDomains) !== 0 || isEmptyAnonymousObjectType(c, t)) constraints.push(t);
    return getNormalizedType(
      c,
      getIntersectionTypeEx(c, constraints, IntersectionFlags.NoConstraintReduction, undefined),
      false,
    );
  }
  return undefined;
}

function isSourceIntersectionNeedingExtraCheck(c: Checker, source: Type, target: Type): boolean {
  return (
    (source.flags & TypeFlags.Intersection) !== 0 &&
    (getApparentType(c, source).flags & TypeFlags.StructuredType) !== 0 &&
    !typesOf(source).some((t) => t === target || (t.objectFlags & ObjectFlags.NonInferrableType) !== 0)
  );
}

function isNonGenericObjectType(c: Checker, t: Type): boolean {
  return (t.flags & TypeFlags.Object) !== 0 && !isGenericMappedType(c, t);
}

function isSingleElementGenericTupleType(t: Type): boolean {
  return isGenericTupleType(t) && tupleTargetOf(t).elementInfos.length === 1;
}

function isMutableTupleType(t: Type): boolean {
  return isTupleType(t) && !tupleTargetOf(t).readonly;
}

function getConstraintFromTypeParameterChecked(c: Checker, t: Type): Type | undefined {
  return getConstraintOfType(c, t);
}

function getKnownKeysOfTupleType(c: Checker, t: Type): Type {
  const target = tupleTargetOf(t);
  const keys: Type[] = [];
  for (let i = 0; i < target.fixedLength; i++) keys.push(getStringLiteralTypeLocal(c, String(i)));
  keys.push(getIndexType(c, target.readonly ? c.globalReadonlyArrayType : c.globalArrayType));
  return getUnionType(c, keys);
}

import { getStringLiteralType as getStringLiteralTypeLocal } from './checker-type-factory.js';

function getSimplifiedTypeOrConstraint(c: Checker, t: Type): Type | undefined {
  const simplified = getSimplifiedType(c, t, false);
  return simplified !== t ? simplified : getConstraintOfType(c, t);
}

function isDistributionDependent(c: Checker, t: ConditionalType): boolean {
  const root = t.root;
  const node = root.node as ConditionalTypeNode;
  return (
    root.isDistributive &&
    (isTypeParameterPossiblyReferenced(c, root.checkType, node.trueType) ||
      isTypeParameterPossiblyReferenced(c, root.checkType, node.falseType))
  );
}

function templateLiteralTypesDefinitelyUnrelated(source: TemplateLiteralType, target: TemplateLiteralType): boolean {
  const sourceStart = source.texts[0]!;
  const targetStart = target.texts[0]!;
  const sourceEnd = source.texts[source.texts.length - 1]!;
  const targetEnd = target.texts[target.texts.length - 1]!;
  return (
    !(sourceStart.length <= targetStart.length
      ? targetStart.startsWith(sourceStart)
      : sourceStart.startsWith(targetStart)) ||
    !(sourceEnd.length <= targetEnd.length ? targetEnd.endsWith(sourceEnd) : sourceEnd.endsWith(targetEnd))
  );
}

/**
 * Whether `source` starts and ends with the start and end texts of `target`, which a template literal
 * source needs to match `target` (see inferFromLiteralPartsToTemplateLiteral) or to be identical to it.
 */
function templateLiteralTextsMayMatch(source: TemplateLiteralType, target: TemplateLiteralType): boolean {
  return (
    source.texts[0]!.startsWith(target.texts[0]!) &&
    source.texts[source.texts.length - 1]!.endsWith(target.texts[target.texts.length - 1]!)
  );
}

/**
 * Whether string literal `text` passes inferTypesFromTemplateLiteralType's start and end text test
 * against `target`, which it needs to match `target`.
 */
function stringLiteralTextMayMatch(text: string, target: TemplateLiteralType): boolean {
  const start = target.texts[0]!;
  const end = target.texts[target.texts.length - 1]!;
  return text.length >= start.length + end.length && text.startsWith(start) && text.endsWith(end);
}

function someTypeCouldContainTypeVariables(c: Checker, types: readonly Type[]): boolean {
  for (const t of types) if (couldContainTypeVariables(c, t)) return true;
  return false;
}

function isPartialMappedType(t: Type): boolean {
  return (
    (t.objectFlags & ObjectFlags.Mapped) !== 0 &&
    (t.flags & TypeFlags.Object) !== 0 &&
    (getMappedTypeModifiers(t as MappedType) & MappedTypeModifiers.IncludeOptional) !== 0
  );
}

export function isEmptyArrayLiteralType(c: Checker, t: Type): boolean {
  if (!isArrayType(c, t)) return false;
  const elementType = getTypeArguments(c, t)[0]!;
  return c.strictNullChecks ? elementType === c.implicitNeverType : elementType === c.undefinedWideningType;
}

export function compareProperties(c: Checker, sourceProp: Symbol, targetProp: Symbol, compare: ComparerKind): Ternary {
  return comparePropertiesWith(c, sourceProp, targetProp, getComparer(c, compare));
}

/** Public properties match on name, optionality and type; non-public ones must share a declaration. */
function comparePropertiesWith(c: Checker, sourceProp: Symbol, targetProp: Symbol, comparer: TypeComparer): Ternary {
  if (sourceProp === targetProp) return Ternary.True;
  const sourceAccessibility =
    getDeclarationModifierFlagsFromSymbol(c, sourceProp, false) & ModifierFlags.NonPublicAccessibilityModifier;
  const targetAccessibility =
    getDeclarationModifierFlagsFromSymbol(c, targetProp, false) & ModifierFlags.NonPublicAccessibilityModifier;
  if (sourceAccessibility !== targetAccessibility) return Ternary.False;
  if (sourceAccessibility !== 0) {
    if (getTargetSymbol(c, sourceProp) !== getTargetSymbol(c, targetProp)) return Ternary.False;
  } else if ((sourceProp.flags & SymbolFlags.Optional) !== (targetProp.flags & SymbolFlags.Optional))
    return Ternary.False;
  if (isReadonlySymbol(c, sourceProp) !== isReadonlySymbol(c, targetProp)) return Ternary.False;
  return comparer.compare(getNonMissingTypeOfSymbol(c, sourceProp), getNonMissingTypeOfSymbol(c, targetProp), false);
}

// ---- Signatures

export function isSignatureAssignableTo(
  c: Checker,
  source: Signature,
  target: Signature,
  ignoreReturnTypes: boolean,
): boolean {
  return (
    compareSignaturesRelated(
      c,
      source,
      target,
      ignoreReturnTypes ? SignatureCheckMode.IgnoreReturnTypes : SignatureCheckMode.None,
      false,
      getComparer(c, ComparerKind.Assignable),
      undefined,
    ) !== Ternary.False
  );
}

export function compareSignaturesRelated(
  c: Checker,
  source: Signature,
  target: Signature,
  checkMode: SignatureCheckMode,
  reportErrors: boolean,
  comparer: TypeComparer,
  reportUnreliableMarkers: import('./checker-types.js').TypeMapper | undefined,
): Ternary {
  if (source === target) return Ternary.True;
  if (
    !((checkMode & SignatureCheckMode.StrictTopSignature) !== 0 && isTopSignature(c, source)) &&
    isTopSignature(c, target)
  )
    return Ternary.True;
  if (
    (checkMode & SignatureCheckMode.StrictTopSignature) !== 0 &&
    isTopSignature(c, source) &&
    !isTopSignature(c, target)
  )
    return Ternary.False;
  const targetCount = getParameterCount(c, target);
  const sourceHasMoreParameters =
    !hasEffectiveRestParameter(c, target) &&
    ((checkMode & SignatureCheckMode.StrictArity) !== 0
      ? hasEffectiveRestParameter(c, source) || getParameterCount(c, source) > targetCount
      : getMinArgumentCount(c, source) > targetCount);
  if (sourceHasMoreParameters) {
    if (reportErrors && (checkMode & SignatureCheckMode.StrictArity) === 0)
      comparer.report(Diagnostics.Target_signature_provides_too_few_arguments_Expected_0_or_more_but_got_1, [
        String(getMinArgumentCount(c, source)),
        String(targetCount),
      ]);
    return Ternary.False;
  }
  if (source.typeParameters.length !== 0 && source.typeParameters !== target.typeParameters) {
    target = getCanonicalSignature(c, target);
    source = instantiateSignatureInContextOf(c, source, target, comparer);
  }
  const sourceCount = getParameterCount(c, source);
  const sourceRestType = getNonArrayRestType(c, source);
  const targetRestType = getNonArrayRestType(c, target);
  if ((sourceRestType !== undefined || targetRestType !== undefined) && reportUnreliableMarkers !== undefined)
    instantiateType(c, sourceRestType ?? targetRestType!, reportUnreliableMarkers);
  const kind = target.declaration !== undefined ? target.declaration.kind : SyntaxKind.Unknown;
  const strictVariance =
    (checkMode & SignatureCheckMode.Callback) === 0 &&
    c.strictFunctionTypes &&
    kind !== SyntaxKind.MethodDeclaration &&
    kind !== SyntaxKind.MethodSignature &&
    kind !== SyntaxKind.Constructor;
  let result = Ternary.True;
  const sourceThisType = getThisTypeOfSignature(c, source);
  if (sourceThisType !== undefined && sourceThisType !== c.voidType) {
    const targetThisType = getThisTypeOfSignature(c, target);
    if (targetThisType !== undefined) {
      // void sources are assignable to anything.
      let related = !strictVariance ? comparer.compare(sourceThisType, targetThisType, false) : Ternary.False;
      if (related === Ternary.False) related = comparer.compare(targetThisType, sourceThisType, reportErrors);
      if (related === Ternary.False) {
        if (reportErrors) comparer.report(Diagnostics.The_this_types_of_each_signature_are_incompatible, []);
        return Ternary.False;
      }
      result &= related;
    }
  }
  const hasRest = sourceRestType !== undefined || targetRestType !== undefined;
  const paramCount = hasRest ? Math.min(sourceCount, targetCount) : Math.max(sourceCount, targetCount);
  const restIndex = hasRest ? paramCount - 1 : -1;
  for (let i = 0; i < paramCount; i++) {
    const sourceType = i === restIndex ? getRestOrAnyTypeAtPosition(c, source, i) : tryGetTypeAtPosition(c, source, i);
    const targetType = i === restIndex ? getRestOrAnyTypeAtPosition(c, target, i) : tryGetTypeAtPosition(c, target, i);
    if (
      sourceType === undefined ||
      targetType === undefined ||
      (sourceType === targetType && (checkMode & SignatureCheckMode.StrictArity) === 0)
    )
      continue;
    // Callback parameters relate covariantly; other parameters bivariantly unless strict.
    const sourceSig =
      (checkMode & SignatureCheckMode.Callback) === 0 && !isInstantiatedGenericParameter(c, source, i)
        ? getSingleCallSignature(c, getNonNullableType(c, sourceType))
        : undefined;
    const targetSig =
      (checkMode & SignatureCheckMode.Callback) === 0 && !isInstantiatedGenericParameter(c, target, i)
        ? getSingleCallSignature(c, getNonNullableType(c, targetType))
        : undefined;
    const callbacks =
      sourceSig !== undefined &&
      targetSig !== undefined &&
      getTypePredicateOfSignature(c, sourceSig) === undefined &&
      getTypePredicateOfSignature(c, targetSig) === undefined &&
      getTypeFacts(c, sourceType, TypeFacts.IsUndefinedOrNull) ===
        getTypeFacts(c, targetType, TypeFacts.IsUndefinedOrNull);
    let related: Ternary;
    if (callbacks)
      related = compareSignaturesRelated(
        c,
        targetSig!,
        sourceSig!,
        (checkMode & SignatureCheckMode.StrictArity) |
          (strictVariance ? SignatureCheckMode.StrictCallback : SignatureCheckMode.BivariantCallback),
        reportErrors,
        comparer,
        reportUnreliableMarkers,
      );
    else {
      related =
        (checkMode & SignatureCheckMode.Callback) === 0 && !strictVariance
          ? comparer.compare(sourceType, targetType, false)
          : Ternary.False;
      if (related === Ternary.False) related = comparer.compare(targetType, sourceType, reportErrors);
    }
    // With strict arity, `(x: number | undefined) => void` is a subtype of `(x?: number | undefined) => void`.
    if (
      related !== Ternary.False &&
      (checkMode & SignatureCheckMode.StrictArity) !== 0 &&
      i >= getMinArgumentCount(c, source) &&
      i < getMinArgumentCount(c, target) &&
      comparer.compare(sourceType, targetType, false) !== Ternary.False
    )
      related = Ternary.False;
    if (related === Ternary.False) {
      if (reportErrors)
        comparer.report(Diagnostics.Types_of_parameters_0_and_1_are_incompatible, [
          getParameterNameAtPosition(c, source, i),
          getParameterNameAtPosition(c, target, i),
        ]);
      return Ternary.False;
    }
    result &= related;
  }
  if ((checkMode & SignatureCheckMode.IgnoreReturnTypes) === 0) {
    // In-flight return type resolutions use `any`.
    const targetReturnType = getNonCircularReturnTypeOfSignature(c, target);
    if (targetReturnType === c.voidType || targetReturnType === c.anyType) return result;
    const sourceReturnType = getNonCircularReturnTypeOfSignature(c, source);
    const targetTypePredicate = getTypePredicateOfSignature(c, target);
    if (targetTypePredicate !== undefined) {
      const sourceTypePredicate = getTypePredicateOfSignature(c, source);
      if (sourceTypePredicate !== undefined)
        result &= compareTypePredicateRelatedTo(c, sourceTypePredicate, targetTypePredicate, reportErrors, comparer);
      else if (
        targetTypePredicate.kind === TypePredicateKind.Identifier ||
        targetTypePredicate.kind === TypePredicateKind.This
      ) {
        if (reportErrors)
          comparer.report(Diagnostics.Signature_0_must_be_a_type_predicate, [signatureToString(c, source)]);
        return Ternary.False;
      }
    } else {
      // Callback return types relate bivariantly to keep containing types covariant.
      let related =
        (checkMode & SignatureCheckMode.BivariantCallback) !== 0
          ? comparer.compare(targetReturnType, sourceReturnType, false)
          : Ternary.False;
      if (related === Ternary.False) related = comparer.compare(sourceReturnType, targetReturnType, reportErrors);
      result &= related;
      if (result === Ternary.False && reportErrors) {
        // Markers for chain reduction in reportError; elided from output.
        const construct = (source.flags & SignatureFlags.Construct) !== 0;
        const message =
          source.parameters.length === 0 && target.parameters.length === 0
            ? construct
              ? Diagnostics.Construct_signatures_with_no_arguments_have_incompatible_return_types_0_and_1
              : Diagnostics.Call_signatures_with_no_arguments_have_incompatible_return_types_0_and_1
            : construct
              ? Diagnostics.Construct_signature_return_types_0_and_1_are_incompatible
              : Diagnostics.Call_signature_return_types_0_and_1_are_incompatible;
        comparer.report(message, [typeToString(c, sourceReturnType), typeToString(c, targetReturnType)]);
      }
    }
  }
  return result;
}

function isInstantiatedGenericParameter(c: Checker, signature: Signature, pos: number): boolean {
  if (signature.target === undefined) return false;
  const t = tryGetTypeAtPosition(c, signature.target, pos);
  return t !== undefined && isGenericTypeLocal(c, t);
}

function compareTypePredicateRelatedTo(
  c: Checker,
  source: TypePredicate,
  target: TypePredicate,
  reportErrors: boolean,
  comparer: TypeComparer,
): Ternary {
  if (source.kind !== target.kind) {
    if (reportErrors) {
      comparer.report(Diagnostics.A_this_based_type_guard_is_not_compatible_with_a_parameter_based_type_guard, []);
      comparer.report(Diagnostics.Type_predicate_0_is_not_assignable_to_1, [
        typePredicateToString(c, source),
        typePredicateToString(c, target),
      ]);
    }
    return Ternary.False;
  }
  if (
    (source.kind === TypePredicateKind.Identifier || source.kind === TypePredicateKind.AssertsIdentifier) &&
    source.parameterIndex !== target.parameterIndex
  ) {
    if (reportErrors) {
      comparer.report(Diagnostics.Parameter_0_is_not_in_the_same_position_as_parameter_1, [
        source.parameterName,
        target.parameterName,
      ]);
      comparer.report(Diagnostics.Type_predicate_0_is_not_assignable_to_1, [
        typePredicateToString(c, source),
        typePredicateToString(c, target),
      ]);
    }
    return Ternary.False;
  }
  let related: Ternary;
  if (source.type === target.type) related = Ternary.True;
  else if (source.type !== undefined && target.type !== undefined)
    related = comparer.compare(source.type, target.type, reportErrors);
  else related = Ternary.False;
  if (related === Ternary.False && reportErrors)
    comparer.report(Diagnostics.Type_predicate_0_is_not_assignable_to_1, [
      typePredicateToString(c, source),
      typePredicateToString(c, target),
    ]);
  return related;
}

export function compareSignaturesIdentical(
  c: Checker,
  source: Signature,
  target: Signature,
  partialMatch: boolean,
  ignoreThisTypes: boolean,
  ignoreReturnTypes: boolean,
  compare: ComparerKind,
): Ternary {
  return compareSignaturesIdenticalWith(
    c,
    source,
    target,
    partialMatch,
    ignoreThisTypes,
    ignoreReturnTypes,
    getComparer(c, compare),
  );
}

function compareSignaturesIdenticalWith(
  c: Checker,
  source: Signature,
  target: Signature,
  partialMatch: boolean,
  ignoreThisTypes: boolean,
  ignoreReturnTypes: boolean,
  comparer: TypeComparer,
): Ternary {
  if (source === target) return Ternary.True;
  if (!isMatchingSignature(c, source, target, partialMatch)) return Ternary.False;
  if (source.typeParameters.length !== target.typeParameters.length) return Ternary.False;
  // Matching constraints and defaults let us instantiate the source with the target's type parameters.
  if (target.typeParameters.length !== 0) {
    const mapper = newTypeMapper(source.typeParameters, target.typeParameters);
    for (let i = 0; i < target.typeParameters.length; i++) {
      const s = source.typeParameters[i]!;
      const t = target.typeParameters[i]!;
      if (s === t) continue;
      if (
        comparer.compare(
          instantiateType(c, getConstraintFromTypeParameter(c, s) ?? c.unknownType, mapper),
          getConstraintFromTypeParameter(c, t) ?? c.unknownType,
          false,
        ) === Ternary.False ||
        comparer.compare(
          instantiateType(c, getDefaultOrUnknownFromTypeParameter(c, s), mapper),
          getDefaultOrUnknownFromTypeParameter(c, t),
          false,
        ) === Ternary.False
      )
        return Ternary.False;
    }
    source = instantiateSignatureEx(c, source, mapper, true);
  }
  let result = Ternary.True;
  if (!ignoreThisTypes) {
    const sourceThisType = getThisTypeOfSignature(c, source);
    if (sourceThisType !== undefined) {
      const targetThisType = getThisTypeOfSignature(c, target);
      if (targetThisType !== undefined) {
        const related = comparer.compare(sourceThisType, targetThisType, false);
        if (related === Ternary.False) return Ternary.False;
        result &= related;
      }
    }
  }
  const count = getParameterCount(c, target);
  for (let i = 0; i < count; i++) {
    const related = comparer.compare(getTypeAtPosition(c, target, i), getTypeAtPosition(c, source, i), false);
    if (related === Ternary.False) return Ternary.False;
    result &= related;
  }
  if (!ignoreReturnTypes) {
    const sourceTypePredicate = getTypePredicateOfSignature(c, source);
    const targetTypePredicate = getTypePredicateOfSignature(c, target);
    if (sourceTypePredicate !== undefined || targetTypePredicate !== undefined) {
      if (
        sourceTypePredicate === undefined ||
        targetTypePredicate === undefined ||
        sourceTypePredicate.kind !== targetTypePredicate.kind ||
        sourceTypePredicate.parameterIndex !== targetTypePredicate.parameterIndex
      )
        return Ternary.False;
      if (sourceTypePredicate.type !== targetTypePredicate.type) {
        if (sourceTypePredicate.type === undefined || targetTypePredicate.type === undefined) return Ternary.False;
        result &= comparer.compare(sourceTypePredicate.type, targetTypePredicate.type, false);
      }
    } else result &= comparer.compare(getReturnTypeOfSignature(c, source), getReturnTypeOfSignature(c, target), false);
  }
  return result;
}

function isMatchingSignature(c: Checker, source: Signature, target: Signature, partialMatch: boolean): boolean {
  const sourceParameterCount = getParameterCount(c, source);
  const targetParameterCount = getParameterCount(c, target);
  const sourceMinArgumentCount = getMinArgumentCount(c, source);
  const targetMinArgumentCount = getMinArgumentCount(c, target);
  if (
    sourceParameterCount === targetParameterCount &&
    sourceMinArgumentCount === targetMinArgumentCount &&
    hasEffectiveRestParameter(c, source) === hasEffectiveRestParameter(c, target)
  )
    return true;
  return partialMatch && sourceMinArgumentCount <= targetMinArgumentCount;
}

/**
 * Whether `source` derives from `target` in the inheritance hierarchy, ignoring type parameters;
 * `{}`, Object and Function are less derived than object-like types.
 */
export function isTypeDerivedFrom(c: Checker, source: Type, target: Type): boolean {
  if ((source.flags & TypeFlags.Union) !== 0) {
    for (const t of typesOf(source)) if (!isTypeDerivedFrom(c, t, target)) return false;
    return true;
  }
  if ((target.flags & TypeFlags.Union) !== 0) {
    for (const t of typesOf(target)) if (isTypeDerivedFrom(c, source, t)) return true;
    return false;
  }
  if ((source.flags & TypeFlags.Intersection) !== 0) {
    for (const t of typesOf(source)) if (isTypeDerivedFrom(c, t, target)) return true;
    return false;
  }
  if ((source.flags & TypeFlags.InstantiableNonPrimitive) !== 0)
    return isTypeDerivedFrom(c, getBaseConstraintOfType(c, source) ?? c.unknownType, target);
  if (isEmptyAnonymousObjectType(c, target)) return (source.flags & (TypeFlags.Object | TypeFlags.NonPrimitive)) !== 0;
  if (target === c.globalObjectType)
    return (source.flags & (TypeFlags.Object | TypeFlags.NonPrimitive)) !== 0 && !isEmptyAnonymousObjectType(c, source);
  if (target === c.globalFunctionType)
    return (source.flags & TypeFlags.Object) !== 0 && isFunctionObjectType(c, source);
  return (
    hasBaseType(c, source, getTargetType(target)) ||
    (isArrayType(c, target) &&
      !isReadonlyArrayType(c, target) &&
      isTypeDerivedFrom(c, source, c.globalReadonlyArrayType))
  );
}

function isFunctionObjectType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.EvolvingArray) !== 0) return false;
  const resolved = resolveStructuredTypeMembers(c, t);
  return (
    resolved.callSignatures.length !== 0 ||
    resolved.constructSignatures.length !== 0 ||
    (getResolvedMember(resolved, 'bind') !== undefined && isTypeSubtypeOf(c, t, c.globalFunctionType))
  );
}

export { findApplicableIndexInfo, getMergedSymbol, typeListKey, getPropertyNameFromType };

/** The target properties that accept `undefined` only through `?`, under exactOptionalPropertyTypes. */
export function getExactOptionalUnassignableProperties(c: Checker, source: Type, target: Type): Symbol[] {
  if (isTupleType(source) && isTupleType(target)) return [];
  const result: Symbol[] = [];
  for (const targetProp of getPropertiesOfType(c, target))
    if (
      isExactOptionalPropertyMismatch(
        c,
        getTypeOfPropertyOfType(c, source, targetProp.name),
        getTypeOfSymbol(c, targetProp),
      )
    )
      result.push(targetProp);
  return result;
}

/**
 * Whether `source` may be `undefined` where the optional property type `target` takes it only by being
 * missing, under exactOptionalPropertyTypes.
 */
export function isExactOptionalPropertyMismatch(
  c: Checker,
  source: Type | undefined,
  target: Type | undefined,
): boolean {
  return (
    source !== undefined &&
    target !== undefined &&
    maybeTypeOfKind(source, TypeFlags.Undefined) &&
    containsMissingType(c, target)
  );
}

/** The string literal member of `target` closest to the string literal `source`. */
const maxStringLiteralSuggestionCandidates = 1000;

function getSuggestedTypeForNonexistentStringLiteralType(c: Checker, source: Type, target: Type): Type | undefined {
  const value = (source as LiteralType).stringValue;
  const valueCodePoints = new CodePoints();
  valueCodePoints.set(value);
  const maximumLengthDifference = Math.max(2, Math.floor(valueCodePoints.length * 0.34));
  let bestDistance = Math.floor(valueCodePoints.length * 0.4) + 0.9;
  let best: Type | undefined = undefined;
  const lowerValue = value.toLowerCase();
  // A target with more string literal candidates than this gets no suggestion.
  let candidates = 0;
  for (const t of typesOf(target)) {
    if ((t.flags & TypeFlags.StringLiteral) === 0) continue;
    if (++candidates > maxStringLiteralSuggestionCandidates) return undefined;
    const name = (t as LiteralType).stringValue;
    const nameLength = utf8Length(name);
    if (name === '' || Math.abs(nameLength - valueCodePoints.length) > maximumLengthDifference || name === value)
      continue;
    if (nameLength < 3 && name.toLowerCase() !== lowerValue) continue;
    const distance = distanceToCandidate(valueCodePoints, name, bestDistance);
    if (distance < 0) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = t;
    } else if (best === undefined || compareTypes(c, t, best) < 0) best = t;
  }
  return best;
}
