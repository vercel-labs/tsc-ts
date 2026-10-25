// Creating and interning types: object types, literals, unions, intersections, references,
// arrays and tuples. Interning keys follow tsgo's, so identity matches.
import { sideOf, sideOfIfAny } from './side-state.js';
import { type Node, getNodeId, getName, getText, SourceFile } from './ast.js';
import { symbolToString } from './type-printer.js';
import { CompositeTypeMapper, instantiateTypes } from './instantiation.js';
import { getAliasForTypeNode, getTypeArgumentsOfDeferredReference } from './checker-type-nodes.js';
import { TypeSystemPropertyName, popTypeResolution, pushTypeResolution } from './checker-symbols.js';
import { isGenericIndexType } from './checker-type-operators.js';
import { compareCodePoints } from './diagnostics.js';
import { Diagnostics } from './diagnostic-messages.js';
import type { Checker } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  ElementFlags,
  EvolvingArrayType,
  IndexInfo,
  type IntrinsicType,
  IndexType,
  IndexedAccessType,
  InstantiationExpressionType,
  InterfaceType,
  IntersectionType,
  LiteralType,
  MappedType,
  ObjectFlags,
  ObjectType,
  ReverseMappedType,
  Signature,
  StructuredType,
  SubstitutionType,
  TemplateLiteralType,
  TupleElementInfo,
  TupleType,
  type Type,
  TypeAlias,
  TypeFlags,
  TypeMapper,
  TypeMapperKind,
  TypeReference,
  UnionType,
  type UnionOrIntersectionType,
  ArrayTypeMapper,
  ArrayToSingleTypeMapper,
  MergedTypeMapper,
  SimpleTypeMapper,
  type ConditionalType,
  type StringMappingType,
  emptyIndexInfos,
  emptySignatures,
  emptySymbols,
  emptyTypes,
  ReferenceCache,
} from './checker-types.js';
import { getNamedMembers, getMembersOfSymbol } from './checker-symbols.js';
import {
  getBaseConstraintOfType,
  getBaseConstraintOrType,
  getIndexTypeOfType,
  getPropertiesOfType,
  getTypeOfPropertyOfType,
  isArrayLikeType,
  resolveStructuredTypeMembers,
  hasResolvedProperties,
  memberResolutionFlags,
  membersHolder,
} from './checker-members.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getDeclaredTypeOfSymbol, getParentOfSymbol } from './checker-declared-types.js';
import { isTypeRelatedTo, isTypeStrictSubtypeOf, isTypeSubtypeOf, isTypeDerivedFrom } from './relations.js';
import {
  getIndexedAccessType,
  isGenericMappedType,
  isTypeMatchedByTemplateLiteralType,
  isMemberOfStringMapping,
} from './checker-type-operators.js';
import { addOptionality } from './checker-symbol-types.js';
import { getSourceFileOfNode } from './binder-utilities.js';
import { isPartOfTypeNode } from './transformers/alias-references.js';
import { CheckFlags, declarationCount, getSymbolId, type Symbol, SymbolFlags, type SymbolTable } from './symbol.js';

export const enum UnionReduction {
  None = 0,
  Literal = 1,
  Subtype = 2,
}

export const enum IntersectionFlags {
  None = 0,
  NoSupertypeReduction = 1 << 0,
  NoConstraintReduction = 1 << 1,
}

// ---- Keys

export function typeListKey(types: readonly Type[]): string {
  let key = '';
  for (let i = 0; i < types.length; i++) key += (i === 0 ? '' : ',') + types[i]!.id;
  return key;
}

export function aliasKey(alias: TypeAlias | undefined): string {
  return alias === undefined ? '' : '@' + getSymbolId(alias.symbol) + ':' + typeListKey(alias.typeArguments);
}

function unionKey(types: Type[], origin: Type | undefined, alias: TypeAlias | undefined): string {
  let key: string;
  if (origin === undefined) key = typeListKey(types);
  else if ((origin.flags & TypeFlags.Union) !== 0) key = '|' + typeListKey((origin as UnionType).types);
  else if ((origin.flags & TypeFlags.Intersection) !== 0) key = '&' + typeListKey((origin as IntersectionType).types);
  else key = '#' + origin.id + '|' + typeListKey(types);
  return key + aliasKey(alias);
}

/** The list `unionKey` spells for `types` and `origin`. */
function unionKeyTypes(types: Type[], origin: Type | undefined): readonly Type[] {
  return origin !== undefined && (origin.flags & TypeFlags.UnionOrIntersection) !== 0
    ? (origin as UnionOrIntersectionType).types
    : types;
}

/** The kind of `unionKey`'s spelling: no origin, a union origin, an intersection origin, another origin. */
function unionKeyKind(origin: Type | undefined): number {
  if (origin === undefined) return 0;
  if ((origin.flags & TypeFlags.Union) !== 0) return 1;
  if ((origin.flags & TypeFlags.Intersection) !== 0) return 2;
  return 3;
}

/**
 * A number for `unionKey(types, origin, alias)` without spelling it: two 32-bit hashes of the same
 * parts, combined below 2^53. Equal keys hash alike; unequal keys rarely do, and a union found by
 * hash is checked against the key (`isUnionOfKey`).
 */
function unionKeyHash(types: Type[], origin: Type | undefined, alias: TypeAlias | undefined): number {
  const kind = unionKeyKind(origin);
  let h1 = 0x811c9dc5 ^ kind;
  let h2 = 0x9e3779b9 + kind;
  if (kind === 3) {
    h1 = Math.imul(h1 ^ origin!.id, 0x01000193);
    h2 = Math.imul(h2 + origin!.id, 0x85ebca6b);
  }
  const list = unionKeyTypes(types, origin);
  for (let i = 0; i < list.length; i++) {
    const id = list[i]!.id;
    h1 = Math.imul(h1 ^ id, 0x01000193);
    h2 = Math.imul(h2 + id, 0x85ebca6b) ^ (h2 >>> 15);
  }
  if (alias !== undefined) {
    h1 = Math.imul(h1 ^ (getSymbolId(alias.symbol) + 0x40000000), 0x01000193);
    for (const t of alias.typeArguments) {
      h1 = Math.imul(h1 ^ t.id, 0x01000193);
      h2 = Math.imul(h2 + t.id, 0x85ebca6b) ^ (h2 >>> 15);
    }
    h2 = Math.imul(h2 ^ alias.typeArguments.length, 0xc2b2ae35);
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x7feb352d);
  h1 ^= h1 >>> 15;
  return (h1 >>> 0) * 0x100000 + ((h2 ^ list.length) & 0xfffff);
}

/**
 * The hash a `TypeListCache` finds `types`, `alias` and `tag` by: two 32-bit hashes of the ids,
 * combined below 2^53. Takes the alias symbol's id as `aliasKey` would.
 */
export function typeListHash(types: readonly Type[], alias: TypeAlias | undefined, tag: number): number {
  let h1 = 0x811c9dc5 ^ tag;
  let h2 = 0x9e3779b9 + tag;
  for (let i = 0; i < types.length; i++) {
    const id = types[i]!.id;
    h1 = Math.imul(h1 ^ id, 0x01000193);
    h2 = Math.imul(h2 + id, 0x85ebca6b) ^ (h2 >>> 15);
  }
  if (alias !== undefined) {
    h1 = Math.imul(h1 ^ (getSymbolId(alias.symbol) + 0x40000000), 0x01000193);
    for (const t of alias.typeArguments) {
      h1 = Math.imul(h1 ^ t.id, 0x01000193);
      h2 = Math.imul(h2 + t.id, 0x85ebca6b) ^ (h2 >>> 15);
    }
    h2 = Math.imul(h2 ^ alias.typeArguments.length, 0xc2b2ae35);
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x7feb352d);
  h1 ^= h1 >>> 15;
  return (h1 >>> 0) * 0x100000 + ((h2 ^ types.length) & 0xfffff);
}

/** Ids below this pack in pairs into exact numbers (`getUnionTypeEx`). */
const UnionPairIdLimit = 1 << 24;

function sameTypeLists(a: readonly Type[], b: readonly Type[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return false;
  return true;
}

/** Whether `union` was created for `unionKey(types, origin, alias)`. */
function isUnionOfKey(
  union: UnionType,
  types: Type[],
  origin: Type | undefined,
  alias: TypeAlias | undefined,
): boolean {
  const kind = unionKeyKind(origin);
  const own = union.origin;
  if (unionKeyKind(own) !== kind) return false;
  if (kind === 3 && own !== origin) return false;
  if (!sameTypeLists(unionKeyTypes(union.types, own), unionKeyTypes(types, origin))) return false;
  const ownAlias = union.alias;
  if (alias === undefined || ownAlias === undefined) return alias === ownAlias;
  return ownAlias.symbol === alias.symbol && sameTypeLists(ownAlias.typeArguments, alias.typeArguments);
}

// ---- Constructors

export function newObjectType(c: Checker, objectFlags: ObjectFlags, symbol: Symbol | undefined): ObjectType {
  const id = c.nextTypeId();
  const flags =
    objectFlags &
    ~(
      ObjectFlags.CouldContainTypeVariablesComputed |
      ObjectFlags.CouldContainTypeVariables |
      ObjectFlags.MembersResolved |
      ObjectFlags.SideState
    );
  if ((objectFlags & ObjectFlags.ClassOrInterface) !== 0) {
    const declared = new InterfaceType(flags, id, symbol);
    declared.checking = c;
    return declared;
  }
  if ((objectFlags & ObjectFlags.Tuple) !== 0) {
    const tuple = new TupleType(flags, id);
    tuple.checking = c;
    return tuple;
  }
  if ((objectFlags & ObjectFlags.Reference) !== 0) return new TypeReference(flags, id, symbol);
  if ((objectFlags & ObjectFlags.Mapped) !== 0) return new MappedType(flags, id, symbol);
  if ((objectFlags & ObjectFlags.ReverseMapped) !== 0) return new ReverseMappedType(flags, id);
  if ((objectFlags & ObjectFlags.EvolvingArray) !== 0) return new EvolvingArrayType(flags, id);
  if ((objectFlags & ObjectFlags.InstantiationExpressionType) !== 0)
    return new InstantiationExpressionType(flags, id, symbol);
  return new ObjectType(flags, id, symbol);
}

export function newAnonymousType(c: Checker, symbol: Symbol | undefined): ObjectType {
  const type = newObjectType(c, ObjectFlags.Anonymous, symbol);
  setStructuredTypeMembers(c, type, undefined, emptySignatures, emptySignatures, emptyIndexInfos);
  return type;
}

export function createAnonymousType(
  c: Checker,
  symbol: Symbol | undefined,
  members: SymbolTable | undefined,
  callSignatures: Signature[],
  constructSignatures: Signature[],
  indexInfos: IndexInfo[],
): ObjectType {
  const type = newObjectType(c, ObjectFlags.Anonymous, symbol);
  setStructuredTypeMembers(c, type, members, callSignatures, constructSignatures, indexInfos);
  return type;
}

export function setStructuredTypeMembers(
  c: Checker,
  t: Type,
  members: SymbolTable | undefined,
  callSignatures: Signature[],
  constructSignatures: Signature[],
  indexInfos: IndexInfo[],
): void {
  const type = membersHolder(c, t);
  type.objectFlags |= ObjectFlags.MembersResolved;
  type.pendingMembers = undefined;
  type.members = members;
  // Resolved member lists are never modified, so every empty one shares one array.
  const properties = getNamedMembers(c, members, type.symbol);
  type.properties = properties.length === 0 ? emptySymbols : properties;
  type.callSignatures = callSignatures.length === 0 ? emptySignatures : callSignatures;
  type.constructSignatures = constructSignatures.length === 0 ? emptySignatures : constructSignatures;
  type.indexInfos = indexInfos.length === 0 ? emptyIndexInfos : indexInfos;
}

export function newUnionType(c: Checker, objectFlags: ObjectFlags, types: Type[]): UnionType {
  return new UnionType(objectFlags, c.nextTypeId(), types);
}

export function newIntersectionType(c: Checker, objectFlags: ObjectFlags, types: Type[]): IntersectionType {
  return new IntersectionType(objectFlags, c.nextTypeId(), types);
}

export function newIndexType(c: Checker, target: Type, indexFlags: number): IndexType {
  return new IndexType(c.nextTypeId(), target, indexFlags);
}

export function newIndexedAccessType(
  c: Checker,
  objectType: Type,
  indexType: Type,
  accessFlags: number,
): IndexedAccessType {
  return new IndexedAccessType(c.nextTypeId(), objectType, indexType, accessFlags);
}

export function newSubstitutionType(c: Checker, baseType: Type, constraint: Type): SubstitutionType {
  return new SubstitutionType(c.nextTypeId(), baseType, constraint);
}

export function newIndexInfo(
  keyType: Type,
  valueType: Type,
  isReadonly: boolean,
  declaration: Node | undefined,
): IndexInfo {
  return new IndexInfo(keyType, valueType, isReadonly, declaration, []);
}

/** Propagates widening, literal and non-inferrable flags from constituents. */
export function getPropagatingFlagsOfTypes(types: readonly Type[], excludeKinds: TypeFlags): ObjectFlags {
  let result = 0;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if ((t.flags & excludeKinds) === 0) result |= t.objectFlags;
  }
  return result & ObjectFlags.PropagatingFlags;
}

// ---- Literals

export function getStringLiteralType(c: Checker, value: string): LiteralType {
  let type = c.stringLiteralTypes.get(value);
  if (type === undefined) {
    type = c.newLiteralType(TypeFlags.StringLiteral, value, 0, undefined);
    c.stringLiteralTypes.set(value, type);
  }
  return type;
}

export function getNumberLiteralType(c: Checker, value: number): LiteralType {
  if (value !== value) {
    let type = c.nanLiteralType;
    if (type === undefined) {
      type = c.newLiteralType(TypeFlags.NumberLiteral, 'NaN', value, undefined);
      c.nanLiteralType = type;
    }
    return type;
  }
  // -0 and 0 are the same key in a Map, as in Go.
  let type = c.numberLiteralTypes.get(value);
  if (type === undefined) {
    type = c.newLiteralType(TypeFlags.NumberLiteral, '', value, undefined);
    c.numberLiteralTypes.set(value, type);
  }
  return type;
}

/** `value` is the decimal digits of the bigint, with a leading `-` when negative. */
export function getBigIntLiteralType(c: Checker, value: string): LiteralType {
  let type = c.bigintLiteralTypes.get(value);
  if (type === undefined) {
    type = c.newLiteralType(TypeFlags.BigIntLiteral, value, 0, undefined);
    c.bigintLiteralTypes.set(value, type);
  }
  return type;
}

export function getStringEnumLiteralType(c: Checker, value: string, enumSymbol: Symbol, symbol: Symbol): LiteralType {
  const key = getSymbolId(enumSymbol) + 's' + value;
  let type = c.enumLiteralTypes.get(key);
  if (type === undefined) {
    type = c.newLiteralType(TypeFlags.EnumLiteral | TypeFlags.StringLiteral, value, 0, symbol);
    c.enumLiteralTypes.set(key, type);
  }
  return type;
}

export function getNumberEnumLiteralType(c: Checker, value: number, enumSymbol: Symbol, symbol: Symbol): LiteralType {
  const key = getSymbolId(enumSymbol) + 'n' + (value !== value ? 'NaN' : Object.is(value, -0) ? '0' : String(value));
  let type = c.enumLiteralTypes.get(key);
  if (type === undefined) {
    type = c.newLiteralType(TypeFlags.EnumLiteral | TypeFlags.NumberLiteral, '', value, symbol);
    c.enumLiteralTypes.set(key, type);
  }
  return type;
}

export function isFreshLiteralType(type: Type): boolean {
  if ((type.flags & TypeFlags.Freshable) === 0) return false;
  // An identity test, like tsgo's: comparing ids would load the fresh type as well.
  return (type as LiteralType).freshType === type;
}

export function getFreshTypeOfLiteralType(c: Checker, type: Type): Type {
  if ((type.flags & TypeFlags.Freshable) === 0) return type;
  const literal = type as LiteralType;
  // The fresh twin of a literal created with one is inline; others are created on first use.
  if (literal.freshType !== undefined) return literal.freshType;
  const side = sideOf(c, literal);
  const existing = side.freshType;
  if (existing !== undefined) return existing;
  const fresh = c.newLiteralType(type.flags, literal.stringValue, literal.numberValue, type.symbol);
  fresh.regularType = literal;
  fresh.freshType = fresh;
  side.freshType = fresh;
  return fresh;
}

export function getRegularTypeOfLiteralType(c: Checker, type: Type): Type {
  if ((type.flags & TypeFlags.Freshable) !== 0) return (type as LiteralType).regularType;
  if ((type.flags & TypeFlags.Union) !== 0) {
    const side = sideOf(c, type as UnionType);
    let regular = side.regularType;
    if (regular === undefined) {
      regular = mapType(c, type, (t) => getRegularTypeOfLiteralType(c, t));
      side.regularType = regular;
    }
    return regular;
  }
  return type;
}

export function isUnitType(type: Type): boolean {
  return (type.flags & TypeFlags.Unit) !== 0;
}

export function isLiteralType(type: Type): boolean {
  if ((type.flags & TypeFlags.Boolean) !== 0) return true;
  if ((type.flags & TypeFlags.Union) !== 0) {
    if ((type.flags & TypeFlags.EnumLiteral) !== 0) return true;
    for (const t of (type as UnionType).types) if (!isUnitType(t)) return false;
    return true;
  }
  return isUnitType(type);
}

export function getBaseTypeOfEnumLikeType(c: Checker, type: Type): Type {
  if (
    (type.flags & TypeFlags.EnumLike) !== 0 &&
    type.symbol !== undefined &&
    (type.symbol.flags & SymbolFlags.EnumMember) !== 0
  )
    return getDeclaredTypeOfSymbol(c, getParentOfSymbol(c, type.symbol)!);
  return type;
}

export function getBaseTypeOfLiteralType(c: Checker, type: Type): Type {
  const flags = type.flags;
  if ((flags & TypeFlags.EnumLike) !== 0) return getBaseTypeOfEnumLikeType(c, type);
  if ((flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0)
    return c.stringType;
  if ((flags & TypeFlags.NumberLiteral) !== 0) return c.numberType;
  if ((flags & TypeFlags.BigIntLiteral) !== 0) return c.bigintType;
  if ((flags & TypeFlags.BooleanLiteral) !== 0) return c.booleanType;
  if ((flags & TypeFlags.Union) !== 0) {
    const key = cachedTypeKey(CachedTypeKind.LiteralUnionBaseType, type.id);
    let cached = c.cachedTypesById.get(key);
    if (cached === undefined) {
      cached = mapType(c, type, (t) => getBaseTypeOfLiteralType(c, t));
      c.cachedTypesById.set(key, cached);
    }
    return cached;
  }
  return type;
}

export function getBaseTypeOfLiteralTypeForComparison(c: Checker, type: Type): Type {
  const flags = type.flags;
  if ((flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0)
    return c.stringType;
  if ((flags & (TypeFlags.NumberLiteral | TypeFlags.Enum)) !== 0) return c.numberType;
  if ((flags & TypeFlags.BigIntLiteral) !== 0) return c.bigintType;
  if ((flags & TypeFlags.BooleanLiteral) !== 0) return c.booleanType;
  if ((flags & TypeFlags.Union) !== 0) return mapType(c, type, (t) => getBaseTypeOfLiteralTypeForComparison(c, t));
  return type;
}

export function getWidenedLiteralType(c: Checker, type: Type): Type {
  const flags = type.flags;
  if ((flags & TypeFlags.Union) !== 0) return mapType(c, type, (t) => getWidenedLiteralType(c, t));
  if (!isFreshLiteralType(type)) return type;
  if ((flags & TypeFlags.EnumLike) !== 0) return getBaseTypeOfEnumLikeType(c, type);
  if ((flags & TypeFlags.StringLiteral) !== 0) return c.stringType;
  if ((flags & TypeFlags.NumberLiteral) !== 0) return c.numberType;
  if ((flags & TypeFlags.BigIntLiteral) !== 0) return c.bigintType;
  if ((flags & TypeFlags.BooleanLiteral) !== 0) return c.booleanType;
  return type;
}

export function getWidenedUniqueESSymbolType(c: Checker, type: Type): Type {
  if ((type.flags & TypeFlags.UniqueESSymbol) !== 0) return c.esSymbolType;
  if ((type.flags & TypeFlags.Union) !== 0) return mapType(c, type, (t) => getWidenedUniqueESSymbolType(c, t));
  return type;
}

// ---- Ordering (tsgo's CompareTypes)

export function compareNodes(c: Checker, n1: Node | undefined, n2: Node | undefined): number {
  if (n1 === n2) return 0;
  if (n1 === undefined) return 1;
  if (n2 === undefined) return -1;
  const s1 = sourceFileOf(n1);
  const s2 = sourceFileOf(n2);
  if (s1 !== s2) return (c.fileIndex.get(s1) ?? 0) - (c.fileIndex.get(s2) ?? 0);
  return n1.pos - n2.pos;
}

function sourceFileOf(node: Node): SourceFile {
  return getSourceFileOfNode(node);
}

export function compareSymbols(c: Checker, s1: Symbol | undefined, s2: Symbol | undefined): number {
  if (s1 === s2) return 0;
  if (s1 === undefined) return 1;
  if (s2 === undefined) return -1;
  if (declarationCount(s1) !== 0 && declarationCount(s2) !== 0) {
    const r = compareNodes(c, s1.declaration!, s2.declaration!);
    if (r !== 0) return r;
  } else if (declarationCount(s1) !== 0) return -1;
  else if (declarationCount(s2) !== 0) return 1;
  const r = compareCodePoints(s1.name, s2.name);
  if (r !== 0) return r;
  if (structuralTies) return 0;
  usedIds = true;
  return compareIds(getSymbolId(s1), getSymbolId(s2));
}

/**
 * `TSC_TS_ID_ORDER` (a test of output that must not depend on the order in which types and symbols
 * are created): `reverse` reverses, and `scramble` permutes, the order of the ids that
 * `compareTypes` and `compareSymbols` fall back to. Intrinsic types, created in a fixed order, keep
 * theirs.
 */
const idOrder = process.env.TSC_TS_ID_ORDER === 'reverse' ? 1 : process.env.TSC_TS_ID_ORDER === 'scramble' ? 2 : 0;

/** The order of two ids as a last resort: ascending, or as `TSC_TS_ID_ORDER` chooses. */
function compareIds(a: number, b: number): number {
  if (idOrder === 0) return a - b;
  if (idOrder === 1) return b - a;
  // A bijection on 32-bit ids (multiplication by an odd constant), so the order stays total.
  return (Math.imul(a, 0x9e3779b1) >>> 0) - (Math.imul(b, 0x9e3779b1) >>> 0);
}

function getSortOrderFlags(t: Type): number {
  if ((t.flags & (TypeFlags.EnumLiteral | TypeFlags.Enum)) !== 0 && (t.flags & TypeFlags.Union) === 0)
    return TypeFlags.Enum;
  return t.flags >>> 0;
}

function getTypeNameSymbol(t: Type): Symbol | undefined {
  if (t.alias !== undefined) return t.alias.symbol;
  if ((t.flags & (TypeFlags.TypeParameter | TypeFlags.StringMapping)) !== 0) return t.symbol;
  if (
    (t.objectFlags & (ObjectFlags.ClassOrInterface | ObjectFlags.Reference)) !== 0 &&
    (t.flags & TypeFlags.Object) !== 0
  )
    return t.symbol;
  return undefined;
}

function compareTypeNames(c: Checker, t1: Type, t2: Type): number {
  const s1 = getTypeNameSymbol(t1);
  const s2 = getTypeNameSymbol(t2);
  if (s1 === s2)
    return t1.alias !== undefined ? compareTypeLists(c, t1.alias.typeArguments, t2.alias!.typeArguments) : 0;
  if (s1 === undefined) return 1;
  if (s2 === undefined) return -1;
  return compareCodePoints(s1.name, s2.name);
}

function compareTypeLists(c: Checker, s1: readonly Type[] | undefined, s2: readonly Type[] | undefined): number {
  // Index the parameters directly: an alias such as `s1 ?? emptyTypes` would hold its own reference.
  const n1 = s1 === undefined ? 0 : s1.length;
  const n2 = s2 === undefined ? 0 : s2.length;
  if (n1 !== n2) return n1 - n2;
  for (let i = 0; i < n1; i++) {
    const r = compareTypes(c, s1![i]!, s2![i]!);
    if (r !== 0) return r;
  }
  return 0;
}

/** compareTypeLists of the targets of two array mappers. */
function compareMapperTargets(c: Checker, a: ArrayTypeMapper, b: ArrayTypeMapper): number {
  const n1 = a.targetCount();
  const n2 = b.targetCount();
  if (n1 !== n2) return n1 - n2;
  for (let i = 0; i < n1; i++) {
    const r = compareTypes(c, a.targetAt(i), b.targetAt(i));
    if (r !== 0) return r;
  }
  return 0;
}

function compareElementLabels(n1: Node | undefined, n2: Node | undefined): number {
  if (n1 === n2) return 0;
  if (n1 === undefined) return -1;
  if (n2 === undefined) return 1;
  return compareCodePoints(labelText(n1), labelText(n2));
}

function labelText(node: Node): string {
  const name = getName(node)!;
  return getText(name);
}

function compareTupleTypes(t1: TupleType, t2: TupleType): number {
  if (t1 === t2) return 0;
  if (t1.readonly !== t2.readonly) return t1.readonly ? 1 : -1;
  if (t1.elementInfos.length !== t2.elementInfos.length) return t1.elementInfos.length - t2.elementInfos.length;
  for (let i = 0; i < t1.elementInfos.length; i++) {
    const r = t1.elementInfos[i]!.flags - t2.elementInfos[i]!.flags;
    if (r !== 0) return r;
  }
  for (let i = 0; i < t1.elementInfos.length; i++) {
    const r = compareElementLabels(t1.elementInfos[i]!.labeledDeclaration, t2.elementInfos[i]!.labeledDeclaration);
    if (r !== 0) return r;
  }
  return 0;
}

export function compareTypeMappers(c: Checker, m1: TypeMapper | undefined, m2: TypeMapper | undefined): number {
  if (m1 === m2) return 0;
  if (m1 === undefined) return 1;
  if (m2 === undefined) return -1;
  const k1 = m1.kind();
  const k2 = m2.kind();
  if (k1 !== k2) return k1 - k2;
  switch (k1) {
    case TypeMapperKind.Simple: {
      const a = m1 as SimpleTypeMapper;
      const b = m2 as SimpleTypeMapper;
      const r = compareTypes(c, a.source, b.source);
      return r !== 0 ? r : compareTypes(c, a.target, b.target);
    }
    case TypeMapperKind.Array: {
      const a = m1 as ArrayTypeMapper;
      const b = m2 as ArrayTypeMapper;
      const r = compareTypeLists(c, a.sources, b.sources);
      return r !== 0 ? r : compareMapperTargets(c, a, b);
    }
    case TypeMapperKind.Merged: {
      const a = m1 as MergedTypeMapper;
      const b = m2 as MergedTypeMapper;
      const r = compareTypeMappers(c, a.m1, b.m1);
      return r !== 0 ? r : compareTypeMappers(c, a.m2, b.m2);
    }
  }
  return structuralTies ? compareOtherTypeMappers(c, m1, m2) : 0;
}

/**
 * With `structuralTies`: the order of two mappers of the kinds `compareTypeMappers` doesn't compare,
 * by their parts: composite mappers by their two mappers, mappers of several sources to one target by
 * the sources and the target.
 */
function compareOtherTypeMappers(c: Checker, m1: TypeMapper, m2: TypeMapper): number {
  const r = otherMapperRank(m1) - otherMapperRank(m2);
  if (r !== 0) return r;
  if (m1 instanceof CompositeTypeMapper && m2 instanceof CompositeTypeMapper) {
    const r1 = compareTypeMappers(c, m1.m1, m2.m1);
    return r1 !== 0 ? r1 : compareTypeMappers(c, m1.m2, m2.m2);
  }
  if (m1 instanceof ArrayToSingleTypeMapper && m2 instanceof ArrayToSingleTypeMapper) {
    const r1 = compareTypeLists(c, m1.sources, m2.sources);
    return r1 !== 0 ? r1 : compareTypes(c, m1.target, m2.target);
  }
  return 0;
}

function otherMapperRank(m: TypeMapper): number {
  return m instanceof CompositeTypeMapper ? 1 : m instanceof ArrayToSingleTypeMapper ? 2 : 3;
}

/**
 * The places of the declarations that `t`'s identity reaches, breadth first: its symbol and alias, then
 * those of its type arguments, constituents and mapper targets, as numbers ordered by file and
 * position; those in the program's own files first, then those in declaration files. Types that
 * differ only in a part the program wrote, such as the fields of two instantiations of a library
 * generic, first differ where that part was written, which is the order in which checking the source
 * creates them.
 */
function declarationPlaces(c: Checker, t: Type): number[] {
  const places: number[] = [];
  const libraryPlaces: number[] = [];
  const queue: Type[] = [t];
  const seen = new Set<Type>();
  const visit = (symbol: Symbol | undefined): void => {
    if (symbol === undefined || declarationCount(symbol) === 0) return;
    const node = symbol.declaration!;
    const file = sourceFileOf(node);
    (file.isDeclarationFile ? libraryPlaces : places).push((c.fileIndex.get(file) ?? 0) * 0x4000000 + node.pos);
  };
  const mapper = (m: TypeMapper | undefined): void => {
    if (m === undefined) return;
    if (m instanceof SimpleTypeMapper) queue.push(m.target);
    else if (m instanceof ArrayTypeMapper) for (let i = 0; i < m.targetCount(); i++) queue.push(m.targetAt(i));
    else if (m instanceof ArrayToSingleTypeMapper) queue.push(m.target);
    else if (m instanceof MergedTypeMapper || m instanceof CompositeTypeMapper) {
      mapper(m.m1);
      mapper(m.m2);
    }
  };
  for (let k = 0; k < queue.length && places.length < declarationPlaceLimit && k < 64; k++) {
    const u = queue[k]!;
    if (seen.has(u)) continue;
    seen.add(u);
    visit(u.symbol);
    if (u.alias !== undefined) {
      visit(u.alias.symbol);
      for (const v of u.alias.typeArguments) queue.push(v);
    }
    if ((u.flags & TypeFlags.UnionOrIntersection) !== 0)
      for (const v of (u as UnionOrIntersectionType).types) queue.push(v);
    if ((u.flags & TypeFlags.Object) !== 0) {
      if ((u.objectFlags & ObjectFlags.Reference) !== 0 && (u as TypeReference).node === undefined) {
        const args = (u as TypeReference).resolvedTypeArguments;
        if (args !== undefined) for (const v of args) queue.push(v);
      }
      mapper((u as ObjectType).mapper);
    }
  }
  for (const place of libraryPlaces) places.push(place);
  return places;
}

const declarationPlaceLimit = 16;

function comparePlaces(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * While set (`inDeclarationOrder`), `compareTypes`, `compareSymbols` and `compareTypeMappers` don't fall
 * back to ids, which follow the order in which the checker created the types, and compare all mapper
 * kinds by their parts.
 */
let structuralTies = false;
/** Set when a comparison falls back to an id (`inDeclarationOrder`). */
let usedIds = false;

/**
 * The constituents of a union in the order declaration emit writes them: as in the union, except that
 * neighbors the union orders by ids, at any depth of `compareTypes`, are ordered by their structure
 * where that tells them apart. Ids follow the order in which the checker created the types, which
 * with several checkers depends on the files a checker checked first, so declaration files would
 * otherwise differ from run to run.
 */
export function inDeclarationOrder(c: Checker, types: readonly Type[]): readonly Type[] {
  let result: Type[] | undefined;
  let start = 0;
  for (let i = 1; i <= types.length; i++) {
    let tied = false;
    if (i < types.length) {
      usedIds = false;
      compareTypes(c, types[i - 1]!, types[i]!);
      tied = usedIds;
    }
    if (tied) continue;
    // types[start..i) are neighbors ordered by ids.
    if (i - start > 1) {
      const run = types.slice(start, i);
      const order: number[] = [];
      for (let k = 0; k < run.length; k++) order.push(k);
      const places: number[][] = [];
      for (const t of run) places.push(declarationPlaces(c, t));
      structuralTies = true;
      order.sort((a, b) => comparePlaces(places[a]!, places[b]!) || compareTypes(c, run[a]!, run[b]!) || a - b);
      structuralTies = false;
      for (let k = 0; k < order.length; k++)
        if (order[k] !== k) {
          if (result === undefined) result = types.slice();
          result[start + k] = run[order[k]!]!;
        }
    }
    start = i;
  }
  return result ?? types;
}

function compareNumbers(a: number, b: number): number {
  // Go's cmp.Compare: NaN sorts first.
  const an = a !== a;
  const bn = b !== b;
  if (an || bn) return an && bn ? 0 : an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** tsgo's deterministic type order, which orders union constituents. */
export function compareTypes(c: Checker, t1: Type, t2: Type): number {
  if (t1 === t2) return 0;
  let r = getSortOrderFlags(t1) - getSortOrderFlags(t2);
  if (r !== 0) return r;
  r = compareTypeNames(c, t1, t2);
  if (r !== 0) return r;
  const flags = t1.flags;
  if ((flags & TypeFlags.Singleton) !== 0) {
    // Only distinguished by ids.
  } else if ((flags & TypeFlags.Object) !== 0) {
    r = compareSymbols(c, t1.symbol, t2.symbol);
    if (r !== 0) return r;
    if ((t1.objectFlags & ObjectFlags.Reference) !== 0 && (t2.objectFlags & ObjectFlags.Reference) !== 0) {
      const r1 = t1 as TypeReference;
      const r2 = t2 as TypeReference;
      const target1 = r1.target!;
      const target2 = r2.target!;
      if ((target1.objectFlags & ObjectFlags.Tuple) !== 0 && (target2.objectFlags & ObjectFlags.Tuple) !== 0) {
        r = compareTupleTypes(target1 as TupleType, target2 as TupleType);
        if (r !== 0) return r;
      }
      if (r1.node === undefined && r2.node === undefined) {
        r = compareTypeLists(c, r1.resolvedTypeArguments, r2.resolvedTypeArguments);
        if (r !== 0) return r;
      } else {
        r = compareNodes(c, r1.node, r2.node);
        if (r !== 0) return r;
        r = compareTypeMappers(c, r1.mapper, r2.mapper);
        if (r !== 0) return r;
      }
    } else if ((t1.objectFlags & ObjectFlags.Reference) !== 0) return -1;
    else if ((t2.objectFlags & ObjectFlags.Reference) !== 0) return 1;
    else {
      r = (t1.objectFlags & ObjectFlags.ObjectTypeKindMask) - (t2.objectFlags & ObjectFlags.ObjectTypeKindMask);
      if (r !== 0) return r;
      r = compareTypeMappers(c, (t1 as ObjectType).mapper, (t2 as ObjectType).mapper);
      if (r !== 0) return r;
    }
  } else if ((flags & TypeFlags.Union) !== 0) {
    const o1 = (t1 as UnionType).origin;
    const o2 = (t2 as UnionType).origin;
    if (o1 === undefined && o2 === undefined) {
      r = compareTypeLists(c, (t1 as UnionType).types, (t2 as UnionType).types);
      if (r !== 0) return r;
    } else if (o1 === undefined) return 1;
    else if (o2 === undefined) return -1;
    else {
      r = compareTypes(c, o1, o2);
      if (r !== 0) return r;
    }
  } else if ((flags & TypeFlags.Intersection) !== 0) {
    r = compareTypeLists(c, (t1 as IntersectionType).types, (t2 as IntersectionType).types);
    if (r !== 0) return r;
  } else if ((flags & (TypeFlags.Enum | TypeFlags.EnumLiteral | TypeFlags.UniqueESSymbol)) !== 0) {
    r = compareSymbols(c, t1.symbol, t2.symbol);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.StringLiteral) !== 0) {
    r = compareCodePoints((t1 as LiteralType).stringValue, (t2 as LiteralType).stringValue);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.NumberLiteral) !== 0) {
    r = compareNumbers((t1 as LiteralType).numberValue, (t2 as LiteralType).numberValue);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.BooleanLiteral) !== 0) {
    const b1 = (t1 as LiteralType).stringValue === 'true';
    const b2 = (t2 as LiteralType).stringValue === 'true';
    if (b1 !== b2) return b1 ? 1 : -1;
  } else if ((flags & TypeFlags.TypeParameter) !== 0) {
    r = compareSymbols(c, t1.symbol, t2.symbol);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.Index) !== 0) {
    r = compareTypes(c, (t1 as IndexType).target, (t2 as IndexType).target);
    if (r !== 0) return r;
    r = (t1 as IndexType).indexFlags - (t2 as IndexType).indexFlags;
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.IndexedAccess) !== 0) {
    r = compareTypes(c, (t1 as IndexedAccessType).objectType, (t2 as IndexedAccessType).objectType);
    if (r !== 0) return r;
    r = compareTypes(c, (t1 as IndexedAccessType).indexType, (t2 as IndexedAccessType).indexType);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.Conditional) !== 0) {
    r = compareNodes(c, (t1 as ConditionalType).root.node, (t2 as ConditionalType).root.node);
    if (r !== 0) return r;
    r = compareTypeMappers(c, (t1 as ConditionalType).mapper, (t2 as ConditionalType).mapper);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.Substitution) !== 0) {
    r = compareTypes(c, (t1 as SubstitutionType).baseType, (t2 as SubstitutionType).baseType);
    if (r !== 0) return r;
    r = compareTypes(c, (t1 as SubstitutionType).constraint, (t2 as SubstitutionType).constraint);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.TemplateLiteral) !== 0) {
    const a = (t1 as TemplateLiteralType).texts;
    const b = (t2 as TemplateLiteralType).texts;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      r = compareCodePoints(a[i]!, b[i]!);
      if (r !== 0) return r;
    }
    if (a.length !== b.length) return a.length - b.length;
    r = compareTypeLists(c, (t1 as TemplateLiteralType).types, (t2 as TemplateLiteralType).types);
    if (r !== 0) return r;
  } else if ((flags & TypeFlags.StringMapping) !== 0) {
    r = compareTypes(c, (t1 as StringMappingType).target, (t2 as StringMappingType).target);
    if (r !== 0) return r;
  }
  if ((flags & TypeFlags.Singleton) !== 0) return t1.id - t2.id;
  if (structuralTies) return 0;
  usedIds = true;
  return compareIds(t1.id, t2.id);
}

/** Binary search position of `t` in the sorted `types`: index if found, else `-(insertion point) - 1`. */
export function binarySearchTypes(c: Checker, types: readonly Type[], t: Type): number {
  let low = 0;
  let high = types.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const r = compareTypes(c, types[middle]!, t);
    if (r === 0) return middle;
    if (r < 0) low = middle + 1;
    else high = middle - 1;
  }
  return ~low;
}

/**
 * Sorted type lists shorter than this are searched by identity. `compareTypes` is 0 only for
 * identical types (the last criterion is the unique id), so membership needs no ordering.
 */
const linearTypeSearchLimit = 16;

/** The index of `t` in `types` at or after `from`, or -1. */
function indexOfType(types: readonly Type[], t: Type, from: number): number {
  for (let i = from; i < types.length; i++) if (types[i]! === t) return i;
  return -1;
}

export function containsType(c: Checker, types: readonly Type[], t: Type): boolean {
  if (types.length < linearTypeSearchLimit) return indexOfType(types, t, 0) >= 0;
  return binarySearchTypes(c, types, t) >= 0;
}

/**
 * Whether `t` is a constituent of `union`. Equal types are identical, so a large union tested more
 * than once looks `t` up in a set instead of searching its sorted constituents. Most large unions
 * are tested once; a few are tested very often.
 */
export function unionContainsType(c: Checker, union: UnionType, t: Type): boolean {
  const types = union.types;
  if (types.length < linearTypeSearchLimit) return indexOfType(types, t, 0) >= 0;
  const side = sideOf(c, union);
  let table = side.constituentIds;
  if (table === undefined) {
    if (side.membershipTests++ === 0) return binarySearchTypes(c, types, t) >= 0;
    table = constituentTable(types);
    side.constituentIds = table;
  }
  // Type ids are unique within a checker, so a matching id is `t` itself.
  const key = t.id + 1;
  const mask = table.length - 1;
  for (let slot = Math.imul(key, 0x9e3779b1) & mask; ; slot = (slot + 1) & mask) {
    const value = table[slot]!;
    if (value === key) return true;
    if (value === 0) return false;
  }
}

/**
 * An open-addressing table of the ids of `types` (each plus one; zero marks an empty slot), with at
 * least twice as many slots as types so that probes stay short.
 */
function constituentTable(types: readonly Type[]): Int32Array {
  let size = 4;
  while (size < types.length * 2) size *= 2;
  const table = new Int32Array(size);
  const mask = size - 1;
  for (const t of types) {
    const key = t.id + 1;
    let slot = Math.imul(key, 0x9e3779b1) & mask;
    while (table[slot] !== 0) slot = (slot + 1) & mask;
    table[slot] = key;
  }
  return table;
}

/**
 * Whether `union` contains every type of the sorted `types` (the constituents of another union).
 * Both lists follow `compareTypes`, so in a small union each type is found by identity after the
 * previous one; large unions keep `unionContainsType`.
 */
export function unionContainsSortedTypes(c: Checker, union: UnionType, types: readonly Type[]): boolean {
  const targets = union.types;
  if (targets.length >= linearTypeSearchLimit) {
    for (const t of types) if (!unionContainsType(c, union, t)) return false;
    return true;
  }
  let next = 0;
  for (const t of types) {
    const index = indexOfType(targets, t, next);
    if (index < 0) return false;
    next = index + 1;
  }
  return true;
}

/** Inserts `t` into the sorted `types`; returns false if already present. */
export function insertType(c: Checker, types: Type[], t: Type): boolean {
  const index = binarySearchTypes(c, types, t);
  if (index >= 0) return false;
  if (~index === types.length) types.push(t);
  else types.splice(~index, 0, t);
  return true;
}

// ---- Iterating unions

export function someType(type: Type, f: (t: Type) => boolean): boolean {
  if ((type.flags & TypeFlags.Union) !== 0) {
    for (const t of (type as UnionType).types) if (f(t)) return true;
    return false;
  }
  return f(type);
}

export function everyType(type: Type, f: (t: Type) => boolean): boolean {
  if ((type.flags & TypeFlags.Union) !== 0) {
    for (const t of (type as UnionType).types) if (!f(t)) return false;
    return true;
  }
  return f(type);
}

export function everyContainedType(type: Type, f: (t: Type) => boolean): boolean {
  if ((type.flags & TypeFlags.UnionOrIntersection) !== 0) {
    for (const t of (type as UnionOrIntersectionType).types) if (!f(t)) return false;
    return true;
  }
  return f(type);
}

export function typesOf(type: Type): Type[] {
  return (type as UnionOrIntersectionType).types;
}

export function mapType(c: Checker, type: Type, f: (t: Type) => Type | undefined): Type {
  return mapTypeEx(c, type, f, false) ?? c.neverType;
}

/** Maps union constituents; undefined when every constituent maps to undefined. */
export function mapTypeEx(
  c: Checker,
  type: Type,
  f: (t: Type) => Type | undefined,
  noReductions: boolean,
): Type | undefined {
  if ((type.flags & TypeFlags.Never) !== 0) return type;
  if ((type.flags & TypeFlags.Union) === 0) return f(type);
  const union = type as UnionType;
  const origin = union.origin;
  const types =
    origin !== undefined && (origin.flags & TypeFlags.Union) !== 0 ? (origin as UnionType).types : union.types;
  const mapped: Type[] = [];
  let changed = false;
  for (const s of types) {
    const m = (s.flags & TypeFlags.Union) !== 0 ? mapTypeEx(c, s, f, noReductions) : f(s);
    if (m !== s) changed = true;
    if (m !== undefined) mapped.push(m);
  }
  if (!changed) return type;
  if (mapped.length === 0) return undefined;
  return getUnionTypeEx(c, mapped, noReductions ? UnionReduction.None : UnionReduction.Literal, undefined, undefined);
}

export function mapTypeWithAlias(c: Checker, type: Type, f: (t: Type) => Type, alias: TypeAlias | undefined): Type {
  if ((type.flags & TypeFlags.Union) !== 0 && alias !== undefined) {
    const mapped: Type[] = [];
    for (const t of (type as UnionType).types) mapped.push(f(t));
    return getUnionTypeEx(c, mapped, UnionReduction.Literal, alias, undefined);
  }
  return mapType(c, type, f);
}

export function filterType(c: Checker, type: Type, f: (t: Type) => boolean): Type {
  if ((type.flags & TypeFlags.Union) !== 0) {
    const union = type as UnionType;
    const types = union.types;
    // The list is copied from the first constituent removed; most filters keep every one.
    let removed = 0;
    while (removed < types.length && f(types[removed]!)) removed++;
    if (removed === types.length) return type;
    const filtered: Type[] = [];
    for (let i = 0; i < removed; i++) filtered.push(types[i]!);
    for (let i = removed + 1; i < types.length; i++) {
      const t = types[i]!;
      if (f(t)) filtered.push(t);
    }
    const origin = union.origin;
    let newOrigin: Type | undefined;
    if (origin !== undefined && (origin.flags & TypeFlags.Union) !== 0) {
      const originTypes = (origin as UnionType).types;
      const originFiltered: Type[] = [];
      for (const u of originTypes) if ((u.flags & TypeFlags.Union) !== 0 || f(u)) originFiltered.push(u);
      if (originTypes.length - originFiltered.length === types.length - filtered.length) {
        if (originFiltered.length === 1) return originFiltered[0]!;
        newOrigin = newUnionType(c, ObjectFlags.None, originFiltered);
      }
    }
    return getUnionTypeFromSortedList(
      c,
      filtered,
      union.objectFlags & (ObjectFlags.PrimitiveUnion | ObjectFlags.ContainsIntersections),
      undefined,
      newOrigin,
    );
  }
  return (type.flags & TypeFlags.Never) !== 0 || f(type) ? type : c.neverType;
}

export function removeType(c: Checker, type: Type, target: Type): Type {
  return filterType(c, type, (t) => t !== target);
}

export function countTypes(type: Type): number {
  if ((type.flags & TypeFlags.Union) !== 0) return (type as UnionType).types.length;
  return (type.flags & TypeFlags.Never) !== 0 ? 0 : 1;
}

// ---- Unions

export function isErrorType(c: Checker, type: Type): boolean {
  // Only `any` types with alias symbols are those from getTypeFromTypeAliasReference for failed lookups.
  return type === c.errorType || ((type.flags & TypeFlags.Any) !== 0 && type.alias !== undefined);
}

export function getUnionType(c: Checker, types: Type[]): Type {
  return getUnionTypeEx(c, types, UnionReduction.Literal, undefined, undefined);
}

export function getUnionTypeEx(
  c: Checker,
  types: Type[],
  unionReduction: UnionReduction,
  alias: TypeAlias | undefined,
  origin: Type | undefined,
): Type {
  if (types.length === 0) return c.neverType;
  if (types.length === 1) return types[0]!;
  // Optimize the common case of unioning a union with some other type, like `undefined`.
  if (
    types.length === 2 &&
    origin === undefined &&
    ((types[0]!.flags & TypeFlags.Union) !== 0 || (types[1]!.flags & TypeFlags.Union) !== 0)
  ) {
    let id1 = types[0]!.id;
    let id2 = types[1]!.id;
    if (id1 > id2) {
      const t = id1;
      id1 = id2;
      id2 = t;
    }
    // Without an alias, both ids and the reduction pack into one exact number.
    if (alias === undefined && id2 < UnionPairIdLimit) {
      const id = (id1 * UnionPairIdLimit + id2) * 4 + unionReduction;
      let result = c.unionOfUnionTypesById.get(id);
      if (result === undefined) {
        result = getUnionTypeWorker(c, types, unionReduction, alias, undefined);
        c.unionOfUnionTypesById.set(id, result);
      }
      return result;
    }
    const key = id1 + ',' + id2 + ',' + unionReduction + aliasKey(alias);
    let result = c.unionOfUnionTypes.get(key);
    if (result === undefined) {
      result = getUnionTypeWorker(c, types, unionReduction, alias, undefined);
      c.unionOfUnionTypes.set(key, result);
    }
    return result;
  }
  return getUnionTypeWorker(c, types, unionReduction, alias, origin);
}

class TypeSet {
  types: Type[] = [];
  includes = 0;
  /** Index of the type added or found last, or -1. */
  last = -1;
}

/**
 * Inserts `t` into the sorted `set.types` unless present, starting next to the previous type.
 * Constituents arrive in sorted runs (nested unions, union members mapped in order), so most
 * inserts land at or just after the previous position; otherwise the search covers only the side
 * of the previous position that holds `t`. The set equals binary-search insertion's: the types
 * stay sorted under the total order `compareTypes`.
 */
function insertTypeNearLast(c: Checker, set: TypeSet, t: Type): void {
  const types = set.types;
  let low = 0;
  let high = types.length - 1;
  const last = set.last;
  if (last >= 0) {
    const r = compareTypes(c, types[last]!, t);
    if (r === 0) return;
    if (r < 0) {
      low = last + 1;
      if (low <= high) {
        const next = compareTypes(c, types[low]!, t);
        if (next === 0) {
          set.last = low;
          return;
        }
        if (next > 0) high = low - 1;
        else low++;
      }
    } else high = last - 1;
  }
  while (low <= high) {
    const middle = (low + high) >> 1;
    const r = compareTypes(c, types[middle]!, t);
    if (r === 0) {
      set.last = middle;
      return;
    }
    if (r < 0) low = middle + 1;
    else high = middle - 1;
  }
  if (low === types.length) types.push(t);
  else types.splice(low, 0, t);
  set.last = low;
}

function getUnionTypeWorker(
  c: Checker,
  types: Type[],
  unionReduction: UnionReduction,
  alias: TypeAlias | undefined,
  origin: Type | undefined,
): Type {
  const set = new TypeSet();
  addTypesToUnion(c, set, types);
  let typeSet = set.types;
  const includes = set.includes;
  if (unionReduction !== UnionReduction.None) {
    if ((includes & TypeFlags.AnyOrUnknown) !== 0) {
      if ((includes & TypeFlags.Any) !== 0) {
        if ((includes & TypeFlags.IncludesWildcard) !== 0) return c.wildcardType;
        if ((includes & TypeFlags.IncludesError) !== 0) return c.errorType;
        return c.anyType;
      }
      return c.unknownType;
    }
    if ((includes & TypeFlags.Undefined) !== 0) {
      if (typeSet.length >= 2 && typeSet[0]! === c.undefinedType && typeSet[1]! === c.missingType) typeSet.splice(1, 1);
    }
    if (
      (includes &
        (TypeFlags.Enum |
          TypeFlags.Literal |
          TypeFlags.UniqueESSymbol |
          TypeFlags.TemplateLiteral |
          TypeFlags.StringMapping)) !==
        0 ||
      ((includes & TypeFlags.Void) !== 0 && (includes & TypeFlags.Undefined) !== 0)
    )
      removeRedundantLiteralTypes(c, typeSet, includes, (unionReduction & UnionReduction.Subtype) !== 0);
    if (
      (includes & TypeFlags.StringLiteral) !== 0 &&
      (includes & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0
    )
      removeStringLiteralsMatchedByTemplateLiterals(c, typeSet);
    if ((includes & TypeFlags.IncludesConstrainedTypeVariable) !== 0) removeConstrainedTypeVariables(c, typeSet);
    if (unionReduction === UnionReduction.Subtype) {
      const reduced = removeSubtypes(c, typeSet, (includes & TypeFlags.Object) !== 0);
      if (reduced === undefined) return c.errorType;
      typeSet = reduced;
    }
    if (typeSet.length === 0) {
      if ((includes & TypeFlags.Null) !== 0)
        return (includes & TypeFlags.IncludesNonWideningType) !== 0 ? c.nullType : c.nullWideningType;
      if ((includes & TypeFlags.Undefined) !== 0)
        return (includes & TypeFlags.IncludesNonWideningType) !== 0 ? c.undefinedType : c.undefinedWideningType;
      return c.neverType;
    }
  }
  if (origin === undefined && (includes & TypeFlags.Union) !== 0) {
    const namedUnions: Type[] = [];
    addNamedUnions(namedUnions, types);
    const reducedTypes: Type[] = [];
    for (const t of typeSet) {
      let inNamed = false;
      for (const u of namedUnions)
        if (unionContainsType(c, u as UnionType, t)) {
          inNamed = true;
          break;
        }
      if (!inNamed) reducedTypes.push(t);
    }
    if (alias === undefined && namedUnions.length === 1 && reducedTypes.length === 0) return namedUnions[0]!;
    // A denormalized origin only when the union came from named unions with no overlap.
    let namedTypesCount = 0;
    for (const u of namedUnions) namedTypesCount += (u as UnionType).types.length;
    if (namedTypesCount + reducedTypes.length === typeSet.length) {
      for (const t of namedUnions) insertType(c, reducedTypes, t);
      origin = newUnionType(c, ObjectFlags.None, reducedTypes);
    }
  }
  const objectFlags =
    ((includes & TypeFlags.NotPrimitiveUnion) !== 0 ? 0 : ObjectFlags.PrimitiveUnion) |
    ((includes & TypeFlags.Intersection) !== 0 ? ObjectFlags.ContainsIntersections : 0);
  return getUnionTypeFromSortedList(c, typeSet, objectFlags, alias, origin);
}

/** Assumes `types` is sorted and deduplicated. */
export function getUnionTypeFromSortedList(
  c: Checker,
  types: Type[],
  precomputedObjectFlags: ObjectFlags,
  alias: TypeAlias | undefined,
  origin: Type | undefined,
): Type {
  if (types.length === 0) return c.neverType;
  if (types.length === 1) return types[0]!;
  // Unions are found by a hash of their key; the spelled key is only needed when two keys share a
  // hash, for the second one.
  const hash = unionKeyHash(types, origin, alias);
  let result = c.unionTypesByHash.get(hash);
  let key: string | undefined;
  if (result !== undefined && !isUnionOfKey(result as UnionType, types, origin, alias)) {
    key = unionKey(types, origin, alias);
    result = c.unionTypes.get(key);
  }
  if (result === undefined) {
    const union = newUnionType(
      c,
      precomputedObjectFlags | getPropagatingFlagsOfTypes(types, TypeFlags.Nullable),
      types,
    );
    union.origin = origin;
    union.alias = alias;
    if (
      types.length === 2 &&
      (types[0]!.flags & TypeFlags.BooleanLiteral) !== 0 &&
      (types[1]!.flags & TypeFlags.BooleanLiteral) !== 0
    )
      union.flags |= TypeFlags.Boolean;
    if (key === undefined) c.unionTypesByHash.set(hash, union);
    else c.unionTypes.set(key, union);
    result = union;
  }
  return result;
}

function addTypesToUnion(c: Checker, set: TypeSet, types: readonly Type[]): void {
  let lastType: Type | undefined;
  for (const t of types) {
    if (t === lastType) continue;
    if ((t.flags & TypeFlags.Union) !== 0) {
      const u = t as UnionType;
      if (t.alias !== undefined || u.origin !== undefined) set.includes |= TypeFlags.Union;
      addTypesToUnion(c, set, u.types);
    } else addTypeToUnion(c, set, t);
    lastType = t;
  }
}

function addTypeToUnion(c: Checker, set: TypeSet, t: Type): void {
  const flags = t.flags;
  if ((flags & TypeFlags.Never) !== 0) return;
  let includes = set.includes | (flags & TypeFlags.IncludesMask);
  if ((flags & TypeFlags.Instantiable) !== 0) includes |= TypeFlags.IncludesInstantiable;
  if ((flags & TypeFlags.Intersection) !== 0 && (t.objectFlags & ObjectFlags.IsConstrainedTypeVariable) !== 0)
    includes |= TypeFlags.IncludesConstrainedTypeVariable;
  if (t === c.wildcardType) includes |= TypeFlags.IncludesWildcard;
  if (isErrorType(c, t)) includes |= TypeFlags.IncludesError;
  if (!c.strictNullChecks && (flags & TypeFlags.Nullable) !== 0) {
    if ((t.objectFlags & ObjectFlags.ContainsWideningType) === 0) includes |= TypeFlags.IncludesNonWideningType;
  } else insertTypeNearLast(c, set, t);
  set.includes = includes;
}

function addNamedUnions(namedUnions: Type[], types: readonly Type[]): void {
  for (const t of types) {
    if ((t.flags & TypeFlags.Union) === 0) continue;
    const u = t as UnionType;
    if (t.alias !== undefined || (u.origin !== undefined && (u.origin.flags & TypeFlags.Union) === 0)) {
      if (!namedUnions.includes(t)) namedUnions.push(t);
    } else if (u.origin !== undefined && (u.origin.flags & TypeFlags.Union) !== 0)
      addNamedUnions(namedUnions, (u.origin as UnionType).types);
  }
}

function removeRedundantLiteralTypes(
  c: Checker,
  types: Type[],
  includes: TypeFlags,
  reduceVoidUndefined: boolean,
): void {
  let i = types.length;
  while (i > 0) {
    i--;
    const t = types[i]!;
    const flags = t.flags;
    const remove =
      ((flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0 &&
        (includes & TypeFlags.String) !== 0) ||
      ((flags & TypeFlags.NumberLiteral) !== 0 && (includes & TypeFlags.Number) !== 0) ||
      ((flags & TypeFlags.BigIntLiteral) !== 0 && (includes & TypeFlags.BigInt) !== 0) ||
      ((flags & TypeFlags.UniqueESSymbol) !== 0 && (includes & TypeFlags.ESSymbol) !== 0) ||
      (reduceVoidUndefined && (flags & TypeFlags.Undefined) !== 0 && (includes & TypeFlags.Void) !== 0) ||
      (isFreshLiteralType(t) && containsType(c, types, (t as LiteralType).regularType));
    if (remove) types.splice(i, 1);
  }
}

function removeStringLiteralsMatchedByTemplateLiterals(c: Checker, types: Type[]): void {
  const templates: Type[] = [];
  for (const t of types) if (isPatternLiteralType(c, t)) templates.push(t);
  if (templates.length === 0) return;
  // Every string literal is tested against every template, and most fail the first test of
  // inferTypesFromTemplateLiteralType: the literal starts with the template's first text, ends with
  // its last, and is long enough for both. Apply that test here with the texts read once per
  // template; only literals that pass it take the full match. (String mapping templates keep the
  // full test: their start and end are empty.)
  const starts: string[] = [];
  const ends: string[] = [];
  const minLengths: number[] = [];
  for (const template of templates) {
    if ((template.flags & TypeFlags.TemplateLiteral) !== 0) {
      const texts = (template as TemplateLiteralType).texts;
      const start = texts[0]!;
      const end = texts[texts.length - 1]!;
      starts.push(start);
      ends.push(end);
      minLengths.push(start.length + end.length);
    } else {
      starts.push('');
      ends.push('');
      minLengths.push(0);
    }
  }
  let i = types.length;
  while (i > 0) {
    i--;
    const t = types[i]!;
    if ((t.flags & TypeFlags.StringLiteral) === 0) continue;
    const text = (t as LiteralType).stringValue;
    const length = text.length;
    for (let j = 0; j < templates.length; j++) {
      if (length < minLengths[j]!) continue;
      const start = starts[j]!;
      if (start.length !== 0 && !text.startsWith(start)) continue;
      const end = ends[j]!;
      if (end.length !== 0 && !text.endsWith(end)) continue;
      if (isTypeMatchedByTemplateLiteralOrStringMapping(c, t, templates[j]!)) {
        types.splice(i, 1);
        break;
      }
    }
  }
}

function isTypeMatchedByTemplateLiteralOrStringMapping(c: Checker, t: Type, template: Type): boolean {
  if ((template.flags & TypeFlags.TemplateLiteral) !== 0)
    return isTypeMatchedByTemplateLiteralType(c, t, template as TemplateLiteralType);
  return isMemberOfStringMapping(c, t, template);
}

function constrainedTypeVariableIndex(t: Type): number {
  return ((t as IntersectionType).types[0]!.flags & TypeFlags.TypeVariable) === 0 ? 1 : 0;
}

function removeConstrainedTypeVariables(c: Checker, types: Type[]): void {
  const typeVariables: Type[] = [];
  for (const t of types) {
    if ((t.flags & TypeFlags.Intersection) !== 0 && (t.objectFlags & ObjectFlags.IsConstrainedTypeVariable) !== 0) {
      const v = (t as IntersectionType).types[constrainedTypeVariableIndex(t)]!;
      if (!typeVariables.includes(v)) typeVariables.push(v);
    }
  }
  for (const typeVariable of typeVariables) {
    const primitives: Type[] = [];
    for (const t of types) {
      if ((t.flags & TypeFlags.Intersection) !== 0 && (t.objectFlags & ObjectFlags.IsConstrainedTypeVariable) !== 0) {
        const index = constrainedTypeVariableIndex(t);
        if ((t as IntersectionType).types[index]! === typeVariable)
          insertType(c, primitives, (t as IntersectionType).types[1 - index]!);
      }
    }
    const constraint = getBaseConstraintOfType(c, typeVariable);
    if (constraint !== undefined && everyType(constraint, (t) => containsType(c, primitives, t))) {
      let i = types.length;
      while (i > 0) {
        i--;
        const t = types[i]!;
        if ((t.flags & TypeFlags.Intersection) !== 0 && (t.objectFlags & ObjectFlags.IsConstrainedTypeVariable) !== 0) {
          const index = constrainedTypeVariableIndex(t);
          const parts = (t as IntersectionType).types;
          if (parts[index]! === typeVariable && containsType(c, primitives, parts[1 - index]!)) types.splice(i, 1);
        }
      }
      insertType(c, types, typeVariable);
    }
  }
}

function removeSubtypes(c: Checker, types: Type[], hasObjectTypes: boolean): Type[] | undefined {
  if (types.length < 2) return types;
  const hash = typeListHash(types, undefined, 0);
  const cached = c.subtypeReductionCache.get(hash, types, undefined, 0);
  if (cached !== undefined) return cached;
  // The reduction removes from `types`; the key is the list before.
  const keyTypes = types.slice();
  let hasEmptyObject = false;
  if (hasObjectTypes)
    for (const t of types)
      if (
        (t.flags & TypeFlags.Object) !== 0 &&
        !isGenericMappedType(c, t) &&
        isEmptyResolvedType(c, t, resolveStructuredTypeMembers(c, t))
      ) {
        hasEmptyObject = true;
        break;
      }
  const length = types.length;
  let i = length;
  let count = 0;
  while (i > 0) {
    i--;
    const source = types[i]!;
    if (!hasEmptyObject && (source.flags & TypeFlags.StructuredOrInstantiable) === 0) continue;
    // `T extends A | B` is a subtype of `A | B` but not of `A` or `B` alone.
    if (
      (source.flags & TypeFlags.TypeParameter) !== 0 &&
      (getBaseConstraintOrType(c, source).flags & TypeFlags.Union) !== 0
    ) {
      const others: Type[] = [];
      for (const t of types) others.push(t === source ? c.neverType : t);
      if (isTypeRelatedTo(c, source, getUnionType(c, others), c.strictSubtypeRelation)) types.splice(i, 1);
      continue;
    }
    // A property with a unit type quickly disqualifies constituents with a different unit type.
    let keyProperty: Symbol | undefined;
    let keyPropertyType: Type | undefined;
    if ((source.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.InstantiableNonPrimitive)) !== 0) {
      for (const p of getPropertiesOfType(c, source))
        if (isUnitType(getTypeOfSymbol(c, p))) {
          keyProperty = p;
          break;
        }
    }
    if (keyProperty !== undefined) keyPropertyType = getRegularTypeOfLiteralType(c, getTypeOfSymbol(c, keyProperty));
    for (const target of types) {
      if (source === target) continue;
      if (count === 100000) {
        const estimatedCount = Math.trunc(count / (length - i)) * length;
        if (estimatedCount > 1000000) {
          c.error(c.currentNode, Diagnostics.Expression_produces_a_union_type_that_is_too_complex_to_represent);
          return undefined;
        }
      }
      count++;
      if (
        keyProperty !== undefined &&
        (target.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.InstantiableNonPrimitive)) !== 0
      ) {
        const t = getTypeOfPropertyOfType(c, target, keyProperty.name);
        if (t !== undefined && isUnitType(t) && getRegularTypeOfLiteralType(c, t) !== keyPropertyType) continue;
      }
      if (
        (source === c.emptyObjectType || source === c.unknownEmptyObjectType) &&
        target.symbol !== undefined &&
        isEmptyAnonymousObjectType(c, target)
      )
        continue;
      if (
        isTypeRelatedTo(c, source, target, c.strictSubtypeRelation) &&
        ((getTargetType(source).objectFlags & ObjectFlags.Class) === 0 ||
          (getTargetType(target).objectFlags & ObjectFlags.Class) === 0 ||
          isTypeDerivedFrom(c, source, target))
      ) {
        types.splice(i, 1);
        break;
      }
    }
  }
  c.subtypeReductionCache.set(hash, keyTypes, undefined, 0, types);
  return types;
}

export function getTargetType(type: Type): Type {
  return (type.objectFlags & ObjectFlags.Reference) !== 0 && (type.flags & TypeFlags.Object) !== 0
    ? (type as TypeReference).target!
    : type;
}

/** Whether `t`, whose members are `resolved`, has no members. */
export function isEmptyResolvedType(c: Checker, t: Type, resolved: StructuredType): boolean {
  return (
    t !== c.anyFunctionType &&
    !hasResolvedProperties(resolved) &&
    resolved.callSignatures.length === 0 &&
    resolved.constructSignatures.length === 0 &&
    resolved.indexInfos.length === 0
  );
}

export function isEmptyAnonymousObjectType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.Anonymous) === 0 || (t.flags & TypeFlags.Object) === 0) return false;
  if (
    (memberResolutionFlags(c, t) & ObjectFlags.MembersResolved) !== 0 &&
    isEmptyResolvedType(c, t, membersHolder(c, t))
  )
    return true;
  return (
    t.symbol !== undefined &&
    (t.symbol.flags & SymbolFlags.TypeLiteral) !== 0 &&
    getMembersOfSymbol(c, t.symbol).size === 0
  );
}

export function isEmptyObjectType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Object) !== 0)
    return !isGenericMappedType(c, t) && isEmptyResolvedType(c, t, resolveStructuredTypeMembers(c, t));
  if ((t.flags & TypeFlags.NonPrimitive) !== 0) return true;
  if ((t.flags & TypeFlags.Union) !== 0) {
    for (const u of typesOf(t)) if (isEmptyObjectType(c, u)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (!isEmptyObjectType(c, u)) return false;
    return true;
  }
  return false;
}

export function isPatternLiteralPlaceholderType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    let seenPlaceholder = false;
    for (const s of typesOf(t)) {
      if ((s.flags & (TypeFlags.Literal | TypeFlags.Nullable)) !== 0 || isPatternLiteralPlaceholderType(c, s))
        seenPlaceholder = true;
      else if ((s.flags & TypeFlags.Object) === 0) return false;
    }
    return seenPlaceholder;
  }
  return (
    (t.flags & (TypeFlags.Any | TypeFlags.String | TypeFlags.Number | TypeFlags.BigInt)) !== 0 ||
    isPatternLiteralType(c, t)
  );
}

export function isPatternLiteralType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.TemplateLiteral) !== 0) {
    for (const u of (t as TemplateLiteralType).types) if (!isPatternLiteralPlaceholderType(c, u)) return false;
    return true;
  }
  return (
    (t.flags & TypeFlags.StringMapping) !== 0 && isPatternLiteralPlaceholderType(c, (t as StringMappingType).target)
  );
}

export function isGenericStringLikeType(c: Checker, t: Type): boolean {
  return (t.flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0 && !isPatternLiteralType(c, t);
}

// ---- Intersections

export function intersectTypes(c: Checker, type1: Type | undefined, type2: Type | undefined): Type | undefined {
  if (type1 === undefined) return type2;
  if (type2 === undefined) return type1;
  return getIntersectionType(c, [type1, type2]);
}

export function getIntersectionType(c: Checker, types: Type[]): Type {
  return getIntersectionTypeEx(c, types, IntersectionFlags.None, undefined);
}

class OrderedTypeSet {
  readonly values: Type[] = [];
  private readonly seen = new Set<Type>();
  includes = 0;

  has(t: Type): boolean {
    return this.seen.has(t);
  }

  add(t: Type): void {
    if (!this.seen.has(t)) {
      this.seen.add(t);
      this.values.push(t);
    }
  }
}

function addTypesToIntersection(c: Checker, set: OrderedTypeSet, types: readonly Type[]): void {
  for (const t of types) addTypeToIntersection(c, set, getRegularTypeOfLiteralType(c, t));
}

function addTypeToIntersection(c: Checker, set: OrderedTypeSet, t: Type): void {
  const flags = t.flags;
  if ((flags & TypeFlags.Intersection) !== 0) {
    addTypesToIntersection(c, set, (t as IntersectionType).types);
    return;
  }
  if (isEmptyAnonymousObjectType(c, t)) {
    if ((set.includes & TypeFlags.IncludesEmptyObject) === 0) {
      set.includes |= TypeFlags.IncludesEmptyObject;
      set.add(t);
    }
    return;
  }
  if ((flags & TypeFlags.AnyOrUnknown) !== 0) {
    if (t === c.wildcardType) set.includes |= TypeFlags.IncludesWildcard;
    if (isErrorType(c, t)) set.includes |= TypeFlags.IncludesError;
  } else if (c.strictNullChecks || (flags & TypeFlags.Nullable) === 0) {
    if (t === c.missingType) {
      set.includes |= TypeFlags.IncludesMissingType;
      t = c.undefinedType;
    }
    if (!set.has(t)) {
      // Two distinct unit types reduce to never; NonPrimitive triggers that.
      if ((t.flags & TypeFlags.Unit) !== 0 && (set.includes & TypeFlags.Unit) !== 0)
        set.includes |= TypeFlags.NonPrimitive;
      set.add(t);
    }
  }
  set.includes |= flags & TypeFlags.IncludesMask;
}

function disjoint(includes: number, kind: TypeFlags): boolean {
  return (includes & kind) !== 0 && (includes & (TypeFlags.DisjointDomains & ~kind)) !== 0;
}

export function getIntersectionTypeEx(
  c: Checker,
  types: Type[],
  flags: IntersectionFlags,
  alias: TypeAlias | undefined,
): Type {
  const set = new OrderedTypeSet();
  addTypesToIntersection(c, set, types);
  const typeSet = set.values;
  const includes = set.includes;
  let objectFlags = ObjectFlags.None;
  if ((includes & TypeFlags.Never) !== 0) return typeSet.includes(c.silentNeverType) ? c.silentNeverType : c.neverType;
  if (
    (c.strictNullChecks &&
      (includes & TypeFlags.Nullable) !== 0 &&
      (includes & (TypeFlags.Object | TypeFlags.NonPrimitive | TypeFlags.IncludesEmptyObject)) !== 0) ||
    disjoint(includes, TypeFlags.NonPrimitive) ||
    disjoint(includes, TypeFlags.StringLike) ||
    disjoint(includes, TypeFlags.NumberLike) ||
    disjoint(includes, TypeFlags.BigIntLike) ||
    disjoint(includes, TypeFlags.ESSymbolLike) ||
    disjoint(includes, TypeFlags.VoidLike)
  )
    return c.neverType;
  if (
    (includes & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0 &&
    (includes & TypeFlags.StringLiteral) !== 0
  ) {
    if (extractRedundantTemplateLiterals(c, typeSet)) return c.neverType;
  }
  if ((includes & TypeFlags.Any) !== 0) {
    if ((includes & TypeFlags.IncludesWildcard) !== 0) return c.wildcardType;
    if ((includes & TypeFlags.IncludesError) !== 0) return c.errorType;
    return c.anyType;
  }
  if (!c.strictNullChecks && (includes & TypeFlags.Nullable) !== 0) {
    if ((includes & TypeFlags.IncludesEmptyObject) !== 0) return c.neverType;
    if ((includes & TypeFlags.Undefined) !== 0) return c.undefinedType;
    return c.nullType;
  }
  if (
    ((includes & TypeFlags.String) !== 0 &&
      (includes & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0) ||
    ((includes & TypeFlags.Number) !== 0 && (includes & TypeFlags.NumberLiteral) !== 0) ||
    ((includes & TypeFlags.BigInt) !== 0 && (includes & TypeFlags.BigIntLiteral) !== 0) ||
    ((includes & TypeFlags.ESSymbol) !== 0 && (includes & TypeFlags.UniqueESSymbol) !== 0) ||
    ((includes & TypeFlags.Void) !== 0 && (includes & TypeFlags.Undefined) !== 0) ||
    ((includes & TypeFlags.IncludesEmptyObject) !== 0 && (includes & TypeFlags.DefinitelyNonNullable) !== 0)
  ) {
    if ((flags & IntersectionFlags.NoSupertypeReduction) === 0) removeRedundantSupertypes(c, typeSet, includes);
  }
  if ((includes & TypeFlags.IncludesMissingType) !== 0) typeSet[typeSet.indexOf(c.undefinedType)] = c.missingType;
  if (typeSet.length === 0) return c.unknownType;
  if (typeSet.length === 1) return typeSet[0]!;
  if (typeSet.length === 2 && (flags & IntersectionFlags.NoConstraintReduction) === 0) {
    const typeVarIndex = (typeSet[0]!.flags & TypeFlags.TypeVariable) === 0 ? 1 : 0;
    const typeVariable = typeSet[typeVarIndex]!;
    const primitiveType = typeSet[1 - typeVarIndex]!;
    if (
      (typeVariable.flags & TypeFlags.TypeVariable) !== 0 &&
      (((primitiveType.flags & (TypeFlags.Primitive | TypeFlags.NonPrimitive)) !== 0 &&
        !isGenericStringLikeType(c, primitiveType)) ||
        (includes & TypeFlags.IncludesEmptyObject) !== 0)
    ) {
      // T & P where P is a primitive, `object` or {}.
      const constraint = getBaseConstraintOfType(c, typeVariable);
      if (constraint !== undefined && everyType(constraint, (t) => isPrimitiveOrObjectOrEmptyType(c, t))) {
        if (isTypeStrictSubtypeOf(c, constraint, primitiveType)) return typeVariable;
        if (
          !(
            (constraint.flags & TypeFlags.Union) !== 0 &&
            someType(constraint, (n) => isTypeStrictSubtypeOf(c, n, primitiveType))
          )
        ) {
          if (!isTypeStrictSubtypeOf(c, primitiveType, constraint)) return c.neverType;
        }
        objectFlags = ObjectFlags.IsConstrainedTypeVariable;
      }
    }
  }
  // Keys without constraint reduction ignore the alias.
  const keyAlias = (flags & IntersectionFlags.NoConstraintReduction) === 0 ? alias : undefined;
  const keyTag = (flags & IntersectionFlags.NoConstraintReduction) === 0 ? 0 : 1;
  const hash = typeListHash(typeSet, keyAlias, keyTag);
  let result = c.intersectionTypes.get(hash, typeSet, keyAlias, keyTag);
  let keyTypes = typeSet;
  if (result === undefined) {
    if ((includes & TypeFlags.Union) !== 0) {
      // The distributions below change `typeSet`; the key is the list before.
      keyTypes = typeSet.slice();
      if (intersectUnionsOfPrimitiveTypes(c, typeSet)) {
        // Restart with fresh flags; reduction happens at most once.
        result = getIntersectionTypeEx(c, typeSet, flags, alias);
      } else if (everyIsUnionWithUndefined(typeSet)) {
        let containedUndefinedType: Type = c.undefinedType;
        for (const t of typeSet) if (containsMissingType(c, t)) containedUndefinedType = c.missingType;
        for (let i = 0; i < typeSet.length; i++)
          typeSet[i] = filterType(c, typeSet[i]!, (t) => (t.flags & TypeFlags.Undefined) === 0);
        result = getUnionTypeEx(
          c,
          [getIntersectionTypeEx(c, typeSet, flags, undefined), containedUndefinedType],
          UnionReduction.Literal,
          alias,
          undefined,
        );
      } else if (everyIsUnionWithNull(typeSet)) {
        for (let i = 0; i < typeSet.length; i++)
          typeSet[i] = filterType(c, typeSet[i]!, (t) => (t.flags & TypeFlags.Null) === 0);
        result = getUnionTypeEx(
          c,
          [getIntersectionTypeEx(c, typeSet, flags, undefined), c.nullType],
          UnionReduction.Literal,
          alias,
          undefined,
        );
      } else if (typeSet.length >= 3 && types.length > 2) {
        // Divide and conquer: (A & B) & (C & D).
        const middle = typeSet.length >> 1;
        result = getIntersectionTypeEx(
          c,
          [
            getIntersectionTypeEx(c, typeSet.slice(0, middle), flags, undefined),
            getIntersectionTypeEx(c, typeSet.slice(middle), flags, undefined),
          ],
          flags,
          alias,
        );
      } else {
        if (!checkCrossProductUnion(c, typeSet)) return c.errorType;
        const constituents = getCrossProductIntersections(c, typeSet, flags);
        let origin: Type | undefined;
        if (
          someHasFlags(constituents, TypeFlags.Intersection) &&
          getConstituentCountOfTypes(constituents) > getConstituentCountOfTypes(typeSet)
        )
          origin = newIntersectionType(c, ObjectFlags.None, typeSet);
        result = getUnionTypeEx(c, constituents, UnionReduction.Literal, alias, origin);
      }
    } else {
      result = newIntersectionType(c, objectFlags | getPropagatingFlagsOfTypes(types, TypeFlags.Nullable), typeSet);
      result.alias = alias;
    }
    c.intersectionTypes.set(hash, keyTypes, keyAlias, keyTag, result);
  }
  return result;
}

export function isPrimitiveOrObjectOrEmptyType(c: Checker, t: Type): boolean {
  return (t.flags & (TypeFlags.Primitive | TypeFlags.NonPrimitive)) !== 0 || isEmptyAnonymousObjectType(c, t);
}

export function containsMissingType(c: Checker, t: Type): boolean {
  return t === c.missingType || ((t.flags & TypeFlags.Union) !== 0 && typesOf(t)[0]! === c.missingType);
}

function someHasFlags(types: readonly Type[], flags: TypeFlags): boolean {
  for (const t of types) if ((t.flags & flags) !== 0) return true;
  return false;
}

function everyIsUnionWithUndefined(types: readonly Type[]): boolean {
  for (const t of types) if (!isUnionWithUndefined(t)) return false;
  return true;
}

function everyIsUnionWithNull(types: readonly Type[]): boolean {
  for (const t of types) if (!isUnionWithNull(t)) return false;
  return true;
}

function isUnionWithUndefined(t: Type): boolean {
  return (t.flags & TypeFlags.Union) !== 0 && (typesOf(t)[0]!.flags & TypeFlags.Undefined) !== 0;
}

function isUnionWithNull(t: Type): boolean {
  if ((t.flags & TypeFlags.Union) === 0) return false;
  const types = typesOf(t);
  return (types[0]!.flags & TypeFlags.Null) !== 0 || (types[1]!.flags & TypeFlags.Null) !== 0;
}

function removeRedundantSupertypes(c: Checker, types: Type[], includes: TypeFlags): void {
  let i = types.length;
  while (i > 0) {
    i--;
    const t = types[i]!;
    const remove =
      ((t.flags & TypeFlags.String) !== 0 &&
        (includes & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !== 0) ||
      ((t.flags & TypeFlags.Number) !== 0 && (includes & TypeFlags.NumberLiteral) !== 0) ||
      ((t.flags & TypeFlags.BigInt) !== 0 && (includes & TypeFlags.BigIntLiteral) !== 0) ||
      ((t.flags & TypeFlags.ESSymbol) !== 0 && (includes & TypeFlags.UniqueESSymbol) !== 0) ||
      ((t.flags & TypeFlags.Void) !== 0 && (includes & TypeFlags.Undefined) !== 0) ||
      (isEmptyAnonymousObjectType(c, t) && (includes & TypeFlags.DefinitelyNonNullable) !== 0);
    if (remove) types.splice(i, 1);
  }
}

/** Removes template literals that string literals satisfy; true if the intersection is empty. */
function extractRedundantTemplateLiterals(c: Checker, types: Type[]): boolean {
  const literals: Type[] = [];
  for (const t of types) if ((t.flags & TypeFlags.StringLiteral) !== 0) literals.push(t);
  let i = types.length;
  while (i > 0) {
    i--;
    const t = types[i]!;
    if ((t.flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) === 0) continue;
    for (const t2 of literals) {
      if (isTypeSubtypeOf(c, t2, t)) {
        types.splice(i, 1);
        break;
      }
      if (isPatternLiteralType(c, t)) return true;
    }
  }
  return false;
}

function intersectUnionsOfPrimitiveTypes(c: Checker, types: Type[]): boolean {
  let index = 0;
  while (index < types.length && (types[index]!.objectFlags & ObjectFlags.PrimitiveUnion) === 0) index++;
  if (index === types.length) return false;
  const unionTypes: Type[] = [types[index]!];
  let i = index + 1;
  while (i < types.length) {
    const t = types[i]!;
    if ((t.objectFlags & ObjectFlags.PrimitiveUnion) !== 0) {
      unionTypes.push(t);
      types.splice(i, 1);
    } else i++;
  }
  if (unionTypes.length === 1) return false;
  const checked: Type[] = [];
  const result: Type[] = [];
  for (const u of unionTypes) {
    for (const t of typesOf(u)) {
      if (!insertType(c, checked, t)) continue;
      if (!eachUnionContains(c, unionTypes, t)) continue;
      // undefinedType and missingType sort first.
      if (t === c.undefinedType && result.length !== 0 && result[0]! === c.missingType) continue;
      if (t === c.missingType && result.length !== 0 && result[0]! === c.undefinedType) {
        result[0] = c.missingType;
        continue;
      }
      insertType(c, result, t);
    }
  }
  types[index] = getUnionTypeFromSortedList(c, result, ObjectFlags.PrimitiveUnion, undefined, undefined);
  return true;
}

function eachUnionContains(c: Checker, unionTypes: Type[], t: Type): boolean {
  for (const type of unionTypes) {
    const u = type as UnionType;
    if (unionContainsType(c, u, t)) continue;
    if (t === c.missingType) return unionContainsType(c, u, c.undefinedType);
    if (t === c.undefinedType) return unionContainsType(c, u, c.missingType);
    let primitive: Type | undefined;
    if ((t.flags & TypeFlags.StringLiteral) !== 0) primitive = c.stringType;
    else if ((t.flags & (TypeFlags.Enum | TypeFlags.NumberLiteral)) !== 0) primitive = c.numberType;
    else if ((t.flags & TypeFlags.BigIntLiteral) !== 0) primitive = c.bigintType;
    else if ((t.flags & TypeFlags.UniqueESSymbol) !== 0) primitive = c.esSymbolType;
    if (primitive === undefined || !unionContainsType(c, u, primitive)) return false;
  }
  return true;
}

export function getCrossProductUnionSize(types: readonly Type[]): number {
  let size = 1;
  for (const t of types) {
    if ((t.flags & TypeFlags.Union) !== 0) size *= typesOf(t).length;
    else if ((t.flags & TypeFlags.Never) !== 0) return 0;
  }
  return size;
}

export function checkCrossProductUnion(c: Checker, types: readonly Type[]): boolean {
  const size = getCrossProductUnionSize(types);
  if (size >= 100000) {
    c.error(c.currentNode, Diagnostics.Expression_produces_a_union_type_that_is_too_complex_to_represent);
    return false;
  }
  return true;
}

function getCrossProductIntersections(c: Checker, types: Type[], flags: IntersectionFlags): Type[] {
  if (allWithoutMembersToResolve(c, types)) {
    const intersections: Type[] = [];
    addCrossProductIntersections(c, types, flags, types.slice(), 0, undefined, intersections);
    return intersections;
  }
  const count = getCrossProductUnionSize(types);
  const intersections: Type[] = [];
  for (let i = 0; i < count; i++) {
    const constituents = types.slice();
    let n = i;
    for (let j = types.length - 1; j >= 0; j--) {
      if ((types[j]!.flags & TypeFlags.Union) !== 0) {
        const sourceTypes = typesOf(types[j]!);
        const length = sourceTypes.length;
        constituents[j] = sourceTypes[n % length]!;
        n = Math.trunc(n / length);
      }
    }
    const t = getIntersectionTypeEx(c, constituents, flags, undefined);
    if ((t.flags & TypeFlags.Never) === 0) intersections.push(t);
  }
  return intersections;
}

/**
 * Adds the intersections of `constituents` with each combination of the constituents of `types` from
 * position `index` on, in the order of `getCrossProductIntersections`, except the never ones. A
 * combination with two distinct unit types (`unit` is the one taken before `index`) is never:
 * `addTypeToIntersection` marks it NonPrimitive, which is disjoint from the domain of the first unit
 * type, so `getIntersectionTypeEx` returns never before it creates or caches anything. Such
 * combinations, and every combination extending them, are skipped without calling it.
 */
function addCrossProductIntersections(
  c: Checker,
  types: readonly Type[],
  flags: IntersectionFlags,
  constituents: Type[],
  index: number,
  unit: Type | undefined,
  intersections: Type[],
): void {
  if (index === types.length) {
    const t = getIntersectionTypeEx(c, constituents.slice(), flags, undefined);
    if ((t.flags & TypeFlags.Never) === 0) intersections.push(t);
    return;
  }
  const t = types[index]!;
  const candidates = (t.flags & TypeFlags.Union) !== 0 ? typesOf(t) : [t];
  for (const candidate of candidates) {
    const candidateUnit = getIntersectionUnitType(c, candidate);
    if (candidateUnit !== undefined && unit !== undefined && candidateUnit !== unit) continue;
    constituents[index] = candidate;
    addCrossProductIntersections(c, types, flags, constituents, index + 1, unit ?? candidateUnit, intersections);
  }
}

/**
 * The unit type `t` adds to an intersection (`addTypeToIntersection`), or `undefined` when it adds
 * none: regular literal types for fresh ones, undefined for the missing type, and no nullable type
 * without strictNullChecks.
 */
function getIntersectionUnitType(c: Checker, t: Type): Type | undefined {
  if ((t.flags & TypeFlags.Unit) === 0) return undefined;
  if (!c.strictNullChecks && (t.flags & TypeFlags.Nullable) !== 0) return undefined;
  const regular = getRegularTypeOfLiteralType(c, t);
  return regular === c.missingType ? c.undefinedType : regular;
}

/**
 * Whether adding `t`, or any constituent of the union `t`, to an intersection resolves nothing:
 * `isEmptyAnonymousObjectType` reads the members of a type literal's symbol, which binds its late
 * bound members the first time, unless the type's members are resolved already.
 */
function isIntersectionConstituentWithoutMembersToResolve(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) return allWithoutMembersToResolve(c, typesOf(t));
  return (
    (t.objectFlags & ObjectFlags.Anonymous) === 0 ||
    (t.flags & TypeFlags.Object) === 0 ||
    (memberResolutionFlags(c, t) & ObjectFlags.MembersResolved) !== 0 ||
    t.symbol === undefined ||
    (t.symbol.flags & SymbolFlags.TypeLiteral) === 0
  );
}

function allWithoutMembersToResolve(c: Checker, types: readonly Type[]): boolean {
  for (const t of types) if (!isIntersectionConstituentWithoutMembersToResolve(c, t)) return false;
  return true;
}

function getConstituentCount(t: Type): number {
  if ((t.flags & TypeFlags.UnionOrIntersection) === 0 || t.alias !== undefined) return 1;
  if ((t.flags & TypeFlags.Union) !== 0 && (t as UnionType).origin !== undefined)
    return getConstituentCount((t as UnionType).origin!);
  return getConstituentCountOfTypes(typesOf(t));
}

function getConstituentCountOfTypes(types: readonly Type[]): number {
  let n = 0;
  for (const t of types) n += getConstituentCount(t);
  return n;
}

export function getUnionOrIntersectionType(
  c: Checker,
  types: Type[],
  isUnion: boolean,
  reduction: UnionReduction,
): Type {
  return isUnion ? getUnionTypeEx(c, types, reduction, undefined, undefined) : getIntersectionType(c, types);
}

// ---- Type references, arrays and tuples

export function createTypeReference(c: Checker, target: Type, typeArguments: Type[]): Type {
  return createTypeReferenceEx(c, target, typeArguments, ObjectFlags.None);
}

export function createTypeReferenceEx(c: Checker, target: Type, typeArguments: Type[], objectFlags: ObjectFlags): Type {
  const hash = typeListHash(typeArguments, undefined, 0);
  const generic = sideOf(c, target as InterfaceType);
  let references = generic.references;
  if (references === undefined) {
    references = new ReferenceCache();
    generic.references = references;
  }
  const existing = references.get(hash, typeArguments);
  if (existing !== undefined) return existing;
  const type = newObjectType(
    c,
    ObjectFlags.Reference | objectFlags | getPropagatingFlagsOfTypes(typeArguments, TypeFlags.None),
    target.symbol,
  ) as TypeReference;
  type.target = target;
  type.resolvedTypeArguments = c.typeLists.intern(hash, typeArguments);
  references.add(hash, type);
  return type;
}

export function tryCreateTypeReference(c: Checker, target: Type, typeArguments: Type[]): Type {
  if (typeArguments.length !== 0 && target === c.emptyGenericType) return c.unknownType;
  return createTypeReference(c, target, typeArguments);
}

export function createDeferredTypeReference(
  c: Checker,
  target: Type,
  node: Node,
  mapper: TypeMapper | undefined,
  alias: TypeAlias | undefined,
): TypeReference {
  if (alias === undefined) {
    // A reference written as a type alias's whole type goes by the alias.
    alias = getAliasForTypeNode(c, node);
    if (alias !== undefined && mapper !== undefined)
      alias = new TypeAlias(alias.symbol, instantiateTypes(c, alias.typeArguments, mapper));
  }
  const type = newObjectType(c, ObjectFlags.Reference, target.symbol) as TypeReference;
  type.alias = alias;
  type.target = target;
  type.mapper = mapper;
  type.node = node;
  return type;
}

export function cloneTypeReference(c: Checker, source: TypeReference): TypeReference {
  const type = newObjectType(c, ObjectFlags.Reference, source.symbol) as TypeReference;
  // The clone keeps its own side state: a source's lazily computed state is not the clone's.
  type.objectFlags =
    (source.objectFlags & ~(ObjectFlags.MembersResolved | ObjectFlags.SideState)) |
    (type.objectFlags & ObjectFlags.SideState);
  type.target = source.target;
  type.resolvedTypeArguments = source.resolvedTypeArguments ?? sideOfIfAny(c, source)?.resolvedTypeArguments;
  return type;
}

export function createTypeFromGenericGlobalType(c: Checker, genericGlobalType: Type, typeArguments: Type[]): Type {
  return genericGlobalType !== c.emptyGenericType
    ? createTypeReference(c, genericGlobalType, typeArguments)
    : c.emptyObjectType;
}

export function createArrayType(c: Checker, elementType: Type): Type {
  return createTypeFromGenericGlobalType(c, c.globalArrayType, [elementType]);
}

export function createArrayTypeEx(c: Checker, elementType: Type, readonly: boolean): Type {
  return createTypeFromGenericGlobalType(c, readonly ? c.globalReadonlyArrayType : c.globalArrayType, [elementType]);
}

export function isTupleType(t: Type): boolean {
  return (
    (t.objectFlags & ObjectFlags.Reference) !== 0 &&
    ((t as TypeReference).target!.objectFlags & ObjectFlags.Tuple) !== 0
  );
}

export function tupleTargetOf(t: Type): TupleType {
  return (t as TypeReference).target as TupleType;
}

export function isGenericTupleType(t: Type): boolean {
  return isTupleType(t) && (tupleTargetOf(t).combinedFlags & ElementFlags.Variadic) !== 0;
}

export function isArrayType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return false;
  const target = (t as TypeReference).target;
  return target === c.globalArrayType || target === c.globalReadonlyArrayType;
}

export function isReadonlyArrayType(c: Checker, t: Type): boolean {
  return (t.objectFlags & ObjectFlags.Reference) !== 0 && (t as TypeReference).target === c.globalReadonlyArrayType;
}

export function isArrayOrTupleType(c: Checker, t: Type): boolean {
  return isArrayType(c, t) || isTupleType(t);
}

export function isMutableArrayOrTuple(c: Checker, t: Type): boolean {
  return (isArrayType(c, t) && !isReadonlyArrayType(c, t)) || (isTupleType(t) && !tupleTargetOf(t).readonly);
}

export function getTypeReferenceArity(t: Type): number {
  return ((t as TypeReference).target as InterfaceType).typeParameterCount();
}

export function getElementTypes(c: Checker, t: Type): Type[] {
  const typeArguments = getTypeArguments(c, t);
  const arity = getTypeReferenceArity(t);
  return typeArguments.length === arity ? typeArguments : typeArguments.slice(0, arity);
}

export function getStartElementCount(t: TupleType, flags: ElementFlags): number {
  for (let i = 0; i < t.elementInfos.length; i++) if ((t.elementInfos[i]!.flags & flags) === 0) return i;
  return t.elementInfos.length;
}

export function getEndElementCount(t: TupleType, flags: ElementFlags): number {
  for (let i = t.elementInfos.length; i > 0; i--)
    if ((t.elementInfos[i - 1]!.flags & flags) === 0) return t.elementInfos.length - i;
  return t.elementInfos.length;
}

export function getTotalFixedElementCount(t: TupleType): number {
  return t.fixedLength + getEndElementCount(t, ElementFlags.Fixed);
}

export function createTupleType(c: Checker, elementTypes: Type[]): Type {
  const infos: TupleElementInfo[] = [];
  for (let i = 0; i < elementTypes.length; i++) infos.push(new TupleElementInfo(ElementFlags.Required, undefined));
  return createTupleTypeEx(c, elementTypes, infos, false);
}

export function createTupleTypeEx(
  c: Checker,
  elementTypes: Type[],
  elementInfos: TupleElementInfo[],
  readonly: boolean,
): Type {
  const tupleTarget = getTupleTargetType(c, elementInfos, readonly);
  if (tupleTarget === c.emptyGenericType) return c.emptyObjectType;
  if (elementTypes.length !== 0) return createNormalizedTypeReference(c, tupleTarget, elementTypes);
  return tupleTarget;
}

function tupleKey(elementInfos: TupleElementInfo[], readonly: boolean): string {
  let key = '';
  for (const e of elementInfos) {
    if ((e.flags & ElementFlags.Required) !== 0) key += '#';
    else if ((e.flags & ElementFlags.Optional) !== 0) key += '?';
    else if ((e.flags & ElementFlags.Rest) !== 0) key += '.';
    else key += '*';
    if (e.labeledDeclaration !== undefined) key += getNodeId(e.labeledDeclaration);
  }
  return readonly ? key + '!' : key;
}

export function getTupleTargetType(c: Checker, elementInfos: TupleElementInfo[], readonly: boolean): Type {
  if (elementInfos.length === 1 && (elementInfos[0]!.flags & ElementFlags.Rest) !== 0)
    return readonly ? c.globalReadonlyArrayType : c.globalArrayType;
  const key = tupleKey(elementInfos, readonly);
  let type = c.tupleTypes.get(key);
  if (type === undefined) {
    type = createTupleTargetType(c, elementInfos, readonly);
    c.tupleTypes.set(key, type);
  }
  return type;
}

/** `interface Tuple<T0, T1, …> extends Array<T0 | T1 | …> { 0: T0, 1: T1, … }`, without a symbol. */
function createTupleTargetType(c: Checker, elementInfos: TupleElementInfo[], readonly: boolean): Type {
  const arity = elementInfos.length;
  let minLength = 0;
  for (const e of elementInfos) if ((e.flags & (ElementFlags.Required | ElementFlags.Variadic)) !== 0) minLength++;
  const typeParameters: Type[] = [];
  const members: SymbolTable = new Map<string, Symbol>();
  let combinedFlags = ElementFlags.None;
  for (let i = 0; i < arity; i++) {
    const typeParameter = c.newTypeParameter(undefined);
    typeParameters.push(typeParameter);
    const flags = elementInfos[i]!.flags;
    combinedFlags |= flags;
    if ((combinedFlags & ElementFlags.Variable) === 0) {
      const property = c.newSymbolWithCheckFlags(
        SymbolFlags.Property | ((flags & ElementFlags.Optional) !== 0 ? SymbolFlags.Optional : 0),
        String(i),
        readonly ? CheckFlags.Readonly : CheckFlags.None,
      );
      c.symbolTypes.set(getSymbolId(property), typeParameter);
      members.set(property.name, property);
    }
  }
  const fixedLength = members.size;
  const lengthSymbol = c.newSymbolWithCheckFlags(
    SymbolFlags.Property,
    'length',
    readonly ? CheckFlags.Readonly : CheckFlags.None,
  );
  if ((combinedFlags & ElementFlags.Variable) !== 0) c.symbolTypes.set(getSymbolId(lengthSymbol), c.numberType);
  else {
    const literalTypes: Type[] = [];
    for (let i = minLength; i <= arity; i++) literalTypes.push(getNumberLiteralType(c, i));
    c.symbolTypes.set(getSymbolId(lengthSymbol), getUnionType(c, literalTypes));
  }
  members.set(lengthSymbol.name, lengthSymbol);
  const type = newObjectType(c, ObjectFlags.Tuple | ObjectFlags.Reference, undefined) as TupleType;
  const thisType = c.newTypeParameter(undefined);
  thisType.isThisType = true;
  thisType.constraint = type;
  type.thisType = thisType;
  typeParameters.push(thisType);
  type.allTypeParameters = typeParameters;
  const ownParameters = type.typeParameters();
  type.target = type;
  type.resolvedTypeArguments = ownParameters;
  const references = new ReferenceCache();
  sideOf(c, type).references = references;
  references.add(typeListHash(ownParameters, undefined, 0), type);
  const declared = sideOf(c, type);
  declared.declaredMembersResolved = true;
  declared.declaredMembers = members;
  type.elementInfos = elementInfos;
  type.minLength = minLength;
  type.fixedLength = fixedLength;
  type.combinedFlags = combinedFlags;
  type.readonly = readonly;
  return type;
}

export function createNormalizedTypeReference(c: Checker, target: Type, typeArguments: Type[]): Type {
  if ((target.objectFlags & ObjectFlags.Tuple) !== 0)
    return createNormalizedTupleType(c, target as TupleType, typeArguments, ObjectFlags.None);
  return createTypeReference(c, target, typeArguments);
}

export function createNormalizedTupleType(
  c: Checker,
  target: TupleType,
  elementTypes: Type[],
  objectFlags: ObjectFlags,
): Type {
  if ((target.combinedFlags & ElementFlags.NonRequired) === 0)
    return createTypeReferenceEx(c, target, elementTypes, objectFlags);
  const infos = target.elementInfos;
  if ((target.combinedFlags & ElementFlags.Variadic) !== 0) {
    for (let i = 0; i < elementTypes.length; i++) {
      const e = elementTypes[i]!;
      if (
        i < infos.length &&
        (infos[i]!.flags & ElementFlags.Variadic) !== 0 &&
        (e.flags & (TypeFlags.Never | TypeFlags.Union)) !== 0
      ) {
        // [A, ...(X | Y)] becomes [A, ...X] | [A, ...Y].
        const checkTypes: Type[] = [];
        for (let j = 0; j < elementTypes.length; j++)
          checkTypes.push(
            j < infos.length && (infos[j]!.flags & ElementFlags.Variadic) !== 0 ? elementTypes[j]! : c.unknownType,
          );
        if (checkCrossProductUnion(c, checkTypes)) {
          return mapType(c, e, (t) => {
            const replaced = elementTypes.slice();
            replaced[i] = t;
            return createNormalizedTupleType(c, target, replaced, objectFlags);
          });
        }
      }
    }
  }
  const n = new TupleNormalizer(c);
  if (!n.normalize(elementTypes.slice(0, infos.length), infos)) return c.errorType;
  if (elementTypes.length > infos.length) n.types.push(elementTypes[infos.length]!);
  const tupleTarget = getTupleTargetType(c, n.infos, target.readonly);
  if (tupleTarget === c.emptyGenericType) return c.emptyObjectType;
  if (n.types.length !== 0) return createTypeReferenceEx(c, tupleTarget, n.types, objectFlags);
  return tupleTarget;
}

/**
 * Normalizes tuple elements to required, then optional, then one rest element, or required,
 * rest, required; generic variadic elements may appear anywhere.
 */
class TupleNormalizer {
  readonly c: Checker;
  types: Type[] = [];
  infos: TupleElementInfo[] = [];
  lastRequiredIndex = -1;
  firstRestIndex = -1;
  lastOptionalOrRestIndex = -1;

  constructor(c: Checker) {
    this.c = c;
  }

  normalize(elementTypes: Type[], elementInfos: TupleElementInfo[]): boolean {
    const c = this.c;
    for (let i = 0; i < elementTypes.length; i++) {
      const t = elementTypes[i]!;
      const info = elementInfos[i]!;
      if ((info.flags & ElementFlags.Variadic) === 0) {
        this.add(t, info);
        continue;
      }
      if ((t.flags & TypeFlags.Any) !== 0)
        this.add(t, new TupleElementInfo(ElementFlags.Rest, info.labeledDeclaration));
      else if ((t.flags & TypeFlags.InstantiableNonPrimitive) !== 0 || isGenericMappedType(c, t)) this.add(t, info);
      else if (isTupleType(t)) {
        const spreadTypes = getElementTypes(c, t);
        if (spreadTypes.length + this.types.length >= 10000) {
          c.error(
            c.currentNode,
            c.currentNode !== undefined && isPartOfTypeNode(c.currentNode)
              ? Diagnostics.Type_produces_a_tuple_type_that_is_too_large_to_represent
              : Diagnostics.Expression_produces_a_tuple_type_that_is_too_large_to_represent,
          );
          return false;
        }
        const spreadInfos = tupleTargetOf(t).elementInfos;
        for (let j = 0; j < spreadTypes.length; j++) this.add(spreadTypes[j]!, spreadInfos[j]!);
      } else {
        const s = (isArrayLikeType(c, t) ? getIndexTypeOfType(c, t, c.numberType) : undefined) ?? c.errorType;
        this.add(s, new TupleElementInfo(ElementFlags.Rest, info.labeledDeclaration));
      }
    }
    // Optional elements before the last required one become required.
    for (let i = 0; i < this.lastRequiredIndex; i++) {
      const info = this.infos[i]!;
      if ((info.flags & ElementFlags.Optional) !== 0)
        this.infos[i] = new TupleElementInfo(ElementFlags.Required, info.labeledDeclaration);
    }
    if (this.firstRestIndex >= 0 && this.firstRestIndex < this.lastOptionalOrRestIndex) {
      // Elements from the first rest to the last optional or rest become one rest element.
      const types: Type[] = [];
      for (let i = this.firstRestIndex; i <= this.lastOptionalOrRestIndex; i++) {
        let t = this.types[i]!;
        if ((this.infos[i]!.flags & ElementFlags.Variadic) !== 0) t = getIndexedAccessType(c, t, c.numberType);
        types.push(t);
      }
      this.types[this.firstRestIndex] = getUnionType(c, types);
      const count = this.lastOptionalOrRestIndex - this.firstRestIndex;
      this.types.splice(this.firstRestIndex + 1, count);
      this.infos.splice(this.firstRestIndex + 1, count);
    }
    return true;
  }

  add(t: Type, info: TupleElementInfo): void {
    if ((info.flags & ElementFlags.Required) !== 0) this.lastRequiredIndex = this.types.length;
    if ((info.flags & ElementFlags.Rest) !== 0 && this.firstRestIndex < 0) this.firstRestIndex = this.types.length;
    if ((info.flags & (ElementFlags.Optional | ElementFlags.Rest)) !== 0)
      this.lastOptionalOrRestIndex = this.types.length;
    this.types.push(addOptionality(this.c, t, true, (info.flags & ElementFlags.Optional) !== 0));
    this.infos.push(info);
  }
}

/** Type arguments of a reference, resolving deferred ones from their type node. */
export function getTypeArguments(c: Checker, t: Type): Type[] {
  const ref = t as TypeReference;
  let resolved = ref.resolvedTypeArguments;
  if (resolved !== undefined) return resolved;
  // A deferred reference resolves its type arguments on first use.
  const side = sideOf(c, ref);
  resolved = side.resolvedTypeArguments;
  if (resolved !== undefined) return resolved;
  const target = ref.target as InterfaceType;
  const errors = (): Type[] => {
    const result: Type[] = [];
    for (let i = 0; i < target.typeParameterCount(); i++) result.push(c.errorType);
    return result;
  };
  if (!pushTypeResolution(c, t, TypeSystemPropertyName.ResolvedTypeArguments)) return errors();
  const node = ref.node;
  let typeArguments: Type[] = emptyTypes;
  if (node !== undefined) typeArguments = getTypeArgumentsOfDeferredReference(c, node, target);
  if (popTypeResolution(c)) {
    resolved = side.resolvedTypeArguments;
    if (resolved === undefined) {
      resolved = instantiateTypes(c, typeArguments, ref.mapper);
      side.resolvedTypeArguments = resolved;
    }
  } else {
    resolved = side.resolvedTypeArguments;
    if (resolved === undefined) {
      resolved = errors();
      side.resolvedTypeArguments = resolved;
    }
    const errorNode = node ?? c.currentNode;
    if (target.symbol !== undefined)
      c.error(
        errorNode,
        Diagnostics.Type_arguments_for_0_circularly_reference_themselves,
        symbolToString(c, target.symbol),
      );
    else c.error(errorNode, Diagnostics.Tuple_type_arguments_circularly_reference_themselves);
  }
  return resolved;
}

// ---- Template literals

function everyHasFlags(types: readonly Type[], flags: TypeFlags): boolean {
  for (const t of types) if ((t.flags & flags) === 0) return false;
  return true;
}

export function getTemplateLiteralType(c: Checker, texts: string[], types: Type[]): Type {
  let unionIndex = 0;
  while (unionIndex < types.length && (types[unionIndex]!.flags & (TypeFlags.Never | TypeFlags.Union)) === 0)
    unionIndex++;
  if (unionIndex < types.length) {
    // The distribution over a union depends only on the texts and types, so it is cached; results
    // that reported a too complex union are not, so each such use reports it.
    const key = 'templateLiteral:' + typeListKey(types) + '|' + texts.join('\u0000');
    const cached = c.cachedTypes.get(key);
    if (cached !== undefined) return cached;
    if (!checkCrossProductUnion(c, types)) return c.errorType;
    const result = mapType(c, types[unionIndex]!, (t) => {
      const replaced = types.slice();
      replaced[unionIndex] = t;
      return getTemplateLiteralType(c, texts, replaced);
    });
    c.cachedTypes.set(key, result);
    return result;
  }
  if (types.includes(c.wildcardType)) return c.wildcardType;
  const builder = new TemplateBuilder(c, texts[0]!);
  if (!builder.addSpans(texts, types)) return c.stringType;
  if (builder.newTypes.length === 0) return getStringLiteralType(c, builder.text);
  builder.newTexts.push(builder.text);
  const newTexts = builder.newTexts;
  const newTypes = builder.newTypes;
  if (newTexts.every((t) => t === '')) {
    if (everyHasFlags(newTypes, TypeFlags.String)) return c.stringType;
    // `${Mapping<xxx>}` is Mapping<xxx>.
    if (newTypes.length === 1 && isPatternLiteralType(c, newTypes[0]!)) return newTypes[0]!;
  }
  const key = newTexts.join('\u0000') + '|' + typeListKey(newTypes);
  let type = c.templateLiteralTypes.get(key);
  if (type === undefined) {
    type = new TemplateLiteralType(c.nextTypeId(), newTexts, newTypes);
    c.templateLiteralTypes.set(key, type);
  }
  return type;
}

class TemplateBuilder {
  readonly c: Checker;
  text: string;
  readonly newTypes: Type[] = [];
  readonly newTexts: string[] = [];

  constructor(c: Checker, text: string) {
    this.c = c;
    this.text = text;
  }

  addSpans(texts: string[], types: Type[]): boolean {
    const c = this.c;
    for (let i = 0; i < types.length; i++) {
      const t = types[i]!;
      if ((t.flags & (TypeFlags.Literal | TypeFlags.Null | TypeFlags.Undefined)) !== 0) {
        this.text += getTemplateStringForType(c, t) + texts[i + 1]!;
      } else if ((t.flags & TypeFlags.TemplateLiteral) !== 0) {
        const template = t as TemplateLiteralType;
        this.text += template.texts[0]!;
        if (!this.addSpans(template.texts, template.types)) return false;
        this.text += texts[i + 1]!;
      } else if (isGenericIndexType(c, t) || isPatternLiteralPlaceholderType(c, t)) {
        this.newTypes.push(t);
        this.newTexts.push(this.text);
        this.text = texts[i + 1]!;
      } else return false;
    }
    return true;
  }
}

export function getTemplateStringForType(c: Checker, t: Type): string {
  if ((t.flags & TypeFlags.StringLiteral) !== 0) return (t as LiteralType).stringValue;
  if ((t.flags & TypeFlags.NumberLiteral) !== 0) return numberToString((t as LiteralType).numberValue);
  if ((t.flags & (TypeFlags.BooleanLiteral | TypeFlags.BigIntLiteral)) !== 0) return (t as LiteralType).stringValue;
  if ((t.flags & TypeFlags.Nullable) !== 0) return (t as IntrinsicType).intrinsicName;
  return '';
}

/** JavaScript's Number::toString. */
export function numberToString(value: number): string {
  return String(value);
}
