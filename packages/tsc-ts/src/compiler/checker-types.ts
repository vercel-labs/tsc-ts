// The checker's type model: types, signatures, index infos, mappers and the links the checker
// caches per symbol and node. Flag values match tsgo, because union ordering depends on them.
import type { ProgramLifetime } from '@scriptc/types';
import type { Node } from './ast.js';
import { getSymbolId, type Symbol, type SymbolTable } from './symbol.js';

export const enum TypeFlags {
  None = 0,
  Any = 1 << 0,
  Unknown = 1 << 1,
  Undefined = 1 << 2,
  Null = 1 << 3,
  Void = 1 << 4,
  String = 1 << 5,
  Number = 1 << 6,
  BigInt = 1 << 7,
  Boolean = 1 << 8,
  ESSymbol = 1 << 9,
  StringLiteral = 1 << 10,
  NumberLiteral = 1 << 11,
  BigIntLiteral = 1 << 12,
  BooleanLiteral = 1 << 13,
  UniqueESSymbol = 1 << 14,
  /** Always combined with StringLiteral, NumberLiteral, or Union. */
  EnumLiteral = 1 << 15,
  /** A numeric enum member with a computed value. */
  Enum = 1 << 16,
  NonPrimitive = 1 << 17,
  Never = 1 << 18,
  TypeParameter = 1 << 19,
  Object = 1 << 20,
  Index = 1 << 21,
  TemplateLiteral = 1 << 22,
  StringMapping = 1 << 23,
  Substitution = 1 << 24,
  IndexedAccess = 1 << 25,
  Conditional = 1 << 26,
  Union = 1 << 27,
  Intersection = 1 << 28,
  Reserved1 = 1 << 29,
  Reserved2 = 1 << 30,

  AnyOrUnknown = Any | Unknown,
  Nullable = Undefined | Null,
  Literal = StringLiteral | NumberLiteral | BigIntLiteral | BooleanLiteral,
  Unit = Enum | Literal | UniqueESSymbol | Nullable,
  Freshable = Enum | Literal,
  StringOrNumberLiteral = StringLiteral | NumberLiteral,
  StringOrNumberLiteralOrUnique = StringLiteral | NumberLiteral | UniqueESSymbol,
  DefinitelyFalsy = StringLiteral | NumberLiteral | BigIntLiteral | BooleanLiteral | Void | Undefined | Null,
  PossiblyFalsy = DefinitelyFalsy | String | Number | BigInt | Boolean,
  Intrinsic = Any | Unknown | String | Number | BigInt | ESSymbol | Void | Undefined | Null | Never | NonPrimitive,
  StringLike = String | StringLiteral | TemplateLiteral | StringMapping,
  NumberLike = Number | NumberLiteral | Enum,
  BigIntLike = BigInt | BigIntLiteral,
  BooleanLike = Boolean | BooleanLiteral,
  EnumLike = Enum | EnumLiteral,
  ESSymbolLike = ESSymbol | UniqueESSymbol,
  VoidLike = Void | Undefined,
  Primitive = StringLike | NumberLike | BigIntLike | BooleanLike | EnumLike | ESSymbolLike | VoidLike | Null,
  DefinitelyNonNullable = StringLike |
    NumberLike |
    BigIntLike |
    BooleanLike |
    EnumLike |
    ESSymbolLike |
    Object |
    NonPrimitive,
  DisjointDomains = NonPrimitive | StringLike | NumberLike | BigIntLike | BooleanLike | ESSymbolLike | VoidLike | Null,
  UnionOrIntersection = Union | Intersection,
  StructuredType = Object | Union | Intersection,
  TypeVariable = TypeParameter | IndexedAccess,
  InstantiableNonPrimitive = TypeVariable | Conditional | Substitution,
  InstantiablePrimitive = Index | TemplateLiteral | StringMapping,
  Instantiable = InstantiableNonPrimitive | InstantiablePrimitive,
  StructuredOrInstantiable = StructuredType | Instantiable,
  ObjectFlagsType = Any | Nullable | Never | Object | Union | Intersection,
  Simplifiable = IndexedAccess | Conditional | Index,
  Singleton = Any |
    Unknown |
    String |
    Number |
    Boolean |
    BigInt |
    ESSymbol |
    Void |
    Undefined |
    Null |
    Never |
    NonPrimitive,
  /** Types where narrowing actually narrows. */
  Narrowable = Any |
    Unknown |
    StructuredOrInstantiable |
    StringLike |
    NumberLike |
    BigIntLike |
    BooleanLike |
    ESSymbol |
    UniqueESSymbol |
    NonPrimitive,
  /** Aggregated during union and intersection construction. */
  IncludesMask = Any |
    Unknown |
    Primitive |
    Never |
    Object |
    Union |
    Intersection |
    NonPrimitive |
    TemplateLiteral |
    StringMapping,
  // Reused during union and intersection construction.
  IncludesMissingType = TypeParameter,
  IncludesNonWideningType = Index,
  IncludesWildcard = IndexedAccess,
  IncludesEmptyObject = Conditional,
  IncludesInstantiable = Substitution,
  IncludesConstrainedTypeVariable = Reserved1,
  IncludesError = Reserved2,
  NotPrimitiveUnion = Any | Unknown | Void | Never | Object | Intersection | IncludesInstantiable,
}

/** The sign bit, which TypeScript enums can't hold as a positive flag. */
export const typeFlagsReserved3 = -2147483648;

export const enum ObjectFlags {
  None = 0,
  Class = 1 << 0,
  Interface = 1 << 1,
  /** A generic type reference. */
  Reference = 1 << 2,
  Tuple = 1 << 3,
  Anonymous = 1 << 4,
  Mapped = 1 << 5,
  /** An instantiated anonymous or mapped type. */
  Instantiated = 1 << 6,
  ObjectLiteral = 1 << 7,
  EvolvingArray = 1 << 8,
  ObjectLiteralPatternWithComputedProperties = 1 << 9,
  ReverseMapped = 1 << 10,
  JsxAttributes = 1 << 11,
  /** Declared in JS: reads and writes of missing members are allowed. */
  JSLiteral = 1 << 12,
  FreshLiteral = 1 << 13,
  ArrayLiteral = 1 << 14,
  PrimitiveUnion = 1 << 15,
  ContainsWideningType = 1 << 16,
  ContainsObjectOrArrayLiteral = 1 << 17,
  /** Is or contains anyFunctionType or silentNeverType. */
  NonInferrableType = 1 << 18,
  CouldContainTypeVariablesComputed = 1 << 19,
  CouldContainTypeVariables = 1 << 20,
  MembersResolved = 1 << 21,

  ClassOrInterface = Class | Interface,
  RequiresWidening = ContainsWideningType | ContainsObjectOrArrayLiteral,
  PropagatingFlags = ContainsWideningType | ContainsObjectOrArrayLiteral | NonInferrableType,
  InstantiatedMapped = Mapped | Instantiated,

  // Object types only.
  ContainsSpread = 1 << 22,
  ObjectRestType = 1 << 23,
  InstantiationExpressionType = 1 << 24,
  SingleSignatureType = 1 << 25,
  IsClassInstanceClone = 1 << 26,
  // Type references only.
  IdenticalBaseTypeCalculated = 1 << 27,
  IdenticalBaseTypeExists = 1 << 28,
  FromTypeNode = 1 << 29,
  /**
   * The type keeps the state that is computed lazily in the checker's side tables instead of its
   * own fields, which stay unset (`sideOf`). Every type with `TSC_TS_SIDE_STATE=1`.
   */
  SideState = 1 << 31,
  // Unions, intersections and substitutions only.
  IsGenericTypeComputed = 1 << 22,
  IsGenericObjectType = 1 << 23,
  IsGenericIndexType = 1 << 24,
  IsGenericType = IsGenericObjectType | IsGenericIndexType,
  // Unions only.
  ContainsIntersections = 1 << 25,
  IsUnknownLikeUnionComputed = 1 << 26,
  IsUnknownLikeUnion = 1 << 27,
  // Intersections only.
  IsNeverIntersectionComputed = 1 << 25,
  IsNeverIntersection = 1 << 26,
  IsConstrainedTypeVariable = 1 << 27,

  ObjectTypeKindMask = ClassOrInterface |
    Reference |
    Tuple |
    Anonymous |
    Mapped |
    ReverseMapped |
    EvolvingArray |
    InstantiationExpressionType |
    SingleSignatureType,
}

export const enum ElementFlags {
  None = 0,
  Required = 1 << 0,
  Optional = 1 << 1,
  Rest = 1 << 2,
  Variadic = 1 << 3,
  Fixed = Required | Optional,
  Variable = Rest | Variadic,
  NonRequired = Optional | Rest | Variadic,
  NonRest = Required | Optional | Variadic,
}

export const enum SignatureFlags {
  None = 0,
  HasRestParameter = 1 << 0,
  HasLiteralTypes = 1 << 1,
  Construct = 1 << 2,
  Abstract = 1 << 3,
  IsInnerCallChain = 1 << 4,
  IsOuterCallChain = 1 << 5,
  IsUntypedSignatureInJSFile = 1 << 6,
  IsNonInferrable = 1 << 7,
  IsSignatureCandidateForOverloadFailure = 1 << 8,
  /** The signature keeps its lazily computed state in the checker's side tables (`signatureSideOf`). */
  SideState = 1 << 9,
  PropagatingFlags = HasRestParameter |
    HasLiteralTypes |
    Construct |
    Abstract |
    IsUntypedSignatureInJSFile |
    IsSignatureCandidateForOverloadFailure,
  CallChainFlags = IsInnerCallChain | IsOuterCallChain,
}

export const enum SignatureKind {
  Call = 0,
  Construct = 1,
}

export const enum IndexFlags {
  None = 0,
  StringsOnly = 1 << 0,
  NoIndexSignatures = 1 << 1,
  NoReducibleCheck = 1 << 2,
}

export const enum AccessFlags {
  None = 0,
  IncludeUndefined = 1 << 0,
  NoIndexSignatures = 1 << 1,
  Writing = 1 << 2,
  CacheSymbol = 1 << 3,
  AllowMissing = 1 << 4,
  ExpressionPosition = 1 << 5,
  ReportDeprecated = 1 << 6,
  SuppressNoImplicitAnyError = 1 << 7,
  Contextual = 1 << 8,
  Persistent = IncludeUndefined,
}

export const enum VarianceFlags {
  Invariant = 0,
  Covariant = 1 << 0,
  Contravariant = 1 << 1,
  Bivariant = Covariant | Contravariant,
  /** An unwitnessed type parameter. */
  Independent = 1 << 2,
  VarianceMask = Invariant | Covariant | Contravariant | Independent,
  /** Relies on structural comparisons not reflected in generic relationships. */
  Unmeasurable = 1 << 3,
  /** May produce false negatives, never false positives. */
  Unreliable = 1 << 4,
  AllowsStructuralFallback = Unmeasurable | Unreliable,
}

/** `x & y` picks the lesser in False < Unknown < Maybe < True; `x | y` the greater. */
export const enum Ternary {
  False = 0,
  Unknown = 1,
  Maybe = 3,
  True = -1,
}

export const enum TypePredicateKind {
  This = 0,
  Identifier = 1,
  AssertsThis = 2,
  AssertsIdentifier = 3,
}

export const enum NodeCheckFlags {
  None = 0,
  TypeChecked = 1 << 0,
  UnusedChecked = 1 << 1,
  ContextChecked = 1 << 6,
  EnumValuesComputed = 1 << 10,
  AssignmentsMarked = 1 << 17,
  ContainsClassWithPrivateIdentifiers = 1 << 20,
  ContainsSuperPropertyInStaticInitializer = 1 << 21,
  InCheckIdentifier = 1 << 22,
  InitializerIsUndefined = 1 << 24,
  InitializerIsUndefinedComputed = 1 << 25,
}

export const enum CheckMode {
  Normal = 0,
  Contextual = 1 << 0,
  Inferential = 1 << 1,
  SkipContextSensitive = 1 << 2,
  SkipGenericFunctions = 1 << 3,
  IsForSignatureHelp = 1 << 4,
  RestBindingElement = 1 << 5,
  TypeOnly = 1 << 6,
  ForceTuple = 1 << 7,
}

export const enum TypeFormatFlags {
  None = 0,
  NoTruncation = 1 << 0,
  WriteArrayAsGenericType = 1 << 1,
  UseStructuralFallback = 1 << 3,
  WriteTypeArgumentsOfSignature = 1 << 5,
  UseFullyQualifiedType = 1 << 6,
  SuppressAnyReturnType = 1 << 8,
  MultilineObjectLiterals = 1 << 10,
  WriteClassExpressionAsTypeLiteral = 1 << 11,
  UseTypeOfFunction = 1 << 12,
  OmitParameterModifiers = 1 << 13,
  UseAliasDefinedOutsideCurrentScope = 1 << 14,
  AllowUniqueESSymbolType = 1 << 20,
  AddUndefined = 1 << 17,
  WriteArrowStyleSignature = 1 << 18,
  InArrayType = 1 << 19,
  InElementType = 1 << 21,
  InFirstTypeArgument = 1 << 22,
  InTypeAlias = 1 << 23,
  OmitThisParameter = 1 << 25,
  WriteCallStyleSignature = 1 << 27,
  UseSingleQuotesForStringLiteralType = 1 << 28,
  NoTypeReduction = 1 << 29,
}

/** Kinds of the checker's `cachedTypesById` entries, which are keyed by kind and type id (tsgo's CachedTypeKey). */
export const enum CachedTypeKind {
  LiteralUnionBaseType,
  IndexType,
  StringIndexType,
  EquivalentBaseType,
  Apparent,
  Awaited,
  EvolvingArray,
  ArrayLiteral,
  PermissiveInstantiation,
  RestrictiveInstantiation,
  RestrictiveTypeParameter,
  IndexedAccessForReading,
  IndexedAccessForWriting,
  Widened,
  RegularObjectLiteral,
  PromisedTypeOfPromise,
  Optional,
  OptionalProperty,
  SimplifiedConditionalForReading,
  SimplifiedConditionalForWriting,
}

export function cachedTypeKey(kind: CachedTypeKind, id: number): number {
  return id * 32 + kind;
}

/** Type ids below this bound pack in pairs into a `cachedTypesByPair` key. */
const CachedTypePairIdLimit = 1 << 24;

/** The `cachedTypesByPair` key of two type ids and four bits, or -1 when an id is too large to pack. */
export function cachedTypePairKey(a: number, b: number, bits: number): number {
  return a < CachedTypePairIdLimit && b < CachedTypePairIdLimit ? (a * CachedTypePairIdLimit + b) * 16 + bits : -1;
}

// ---- Types

/** An alias symbol and its type arguments, for types written through a type alias. */
export class TypeAlias {
  readonly symbol: Symbol;
  readonly typeArguments: Type[];

  constructor(symbol: Symbol, typeArguments: Type[]) {
    this.symbol = symbol;
    this.typeArguments = typeArguments;
  }
}

function sameTypeListParts(a: readonly Type[], b: readonly Type[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return false;
  return true;
}

function sameAliasParts(a: TypeAlias | undefined, b: TypeAlias | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.symbol === b.symbol && sameTypeListParts(a.typeArguments, b.typeArguments);
}

/**
 * Values keyed by a list of types, an optional alias and a small tag: the keys `typeListKey(types) +
 * aliasKey(alias)` plus a suffix spelled, without building them. A lookup takes a number hashing the
 * parts (`typeListHash`); entries keep their parts, so a match is exact and keys sharing a hash chain.
 * Like tsgo's hashed type list keys. A list must not change after it keys an entry.
 *
 * Entries are numbered in the order they are added: `heads` maps a hash to its first entry, and the
 * lists and values of the entries are kept in arrays by number. Aliases, tags and the chains of
 * entries that share a hash get arrays once an entry needs them.
 */
export class TypeListCache<V> {
  private heads: Map<number, number>;
  private lists: (readonly Type[])[];
  private values: V[];
  private aliases: (TypeAlias | undefined)[] | undefined;
  private tags: number[] | undefined;
  /** The next entry with the same hash, or -1. */
  private nexts: number[] | undefined;

  constructor() {
    this.heads = new Map<number, number>();
    this.lists = [];
    this.values = [];
    this.aliases = undefined;
    this.tags = undefined;
    this.nexts = undefined;
  }

  get(hash: number, types: readonly Type[], alias: TypeAlias | undefined, tag: number): V | undefined {
    const entry = this.find(hash, types, alias, tag);
    return entry >= 0 ? this.values[entry] : undefined;
  }

  set(hash: number, types: readonly Type[], alias: TypeAlias | undefined, tag: number, value: V): void {
    const head = this.heads.get(hash);
    if (head !== undefined) {
      const entry = this.findFrom(head, types, alias, tag);
      if (entry >= 0) {
        this.values[entry] = value;
        return;
      }
    }
    const entry = this.lists.length;
    this.lists.push(types);
    this.values.push(value);
    const aliases = this.aliases;
    if (aliases !== undefined) aliases.push(alias);
    else if (alias !== undefined) {
      const created: (TypeAlias | undefined)[] = [];
      for (let i = 0; i < entry; i++) created.push(undefined);
      created.push(alias);
      this.aliases = created;
    }
    const tags = this.tags;
    if (tags !== undefined) tags.push(tag);
    else if (tag !== 0) {
      const created: number[] = [];
      for (let i = 0; i < entry; i++) created.push(0);
      created.push(tag);
      this.tags = created;
    }
    let nexts = this.nexts;
    if (nexts !== undefined) nexts.push(-1);
    if (head === undefined) {
      this.heads.set(hash, entry);
      return;
    }
    // A second entry with this hash: chain it after the first.
    if (nexts === undefined) {
      nexts = [];
      for (let i = 0; i <= entry; i++) nexts.push(-1);
      this.nexts = nexts;
    }
    nexts[entry] = nexts[head]!;
    nexts[head] = entry;
  }

  clear(): void {
    this.heads = new Map<number, number>();
    this.lists = [];
    this.values = [];
    this.aliases = undefined;
    this.tags = undefined;
    this.nexts = undefined;
  }

  /** The number of the entry with these parts, or -1. */
  private find(hash: number, types: readonly Type[], alias: TypeAlias | undefined, tag: number): number {
    const head = this.heads.get(hash);
    return head !== undefined ? this.findFrom(head, types, alias, tag) : -1;
  }

  private findFrom(head: number, types: readonly Type[], alias: TypeAlias | undefined, tag: number): number {
    const tags = this.tags;
    const aliases = this.aliases;
    const nexts = this.nexts;
    for (let entry = head; entry >= 0; entry = nexts !== undefined ? nexts[entry]! : -1)
      if (
        (tags !== undefined ? tags[entry]! : 0) === tag &&
        sameTypeListParts(this.lists[entry]!, types) &&
        sameAliasParts(aliases !== undefined ? aliases[entry] : undefined, alias)
      )
        return entry;
    return -1;
  }
}

/**
 * One list for each sequence of types that a checker keeps (`Checker.typeLists`): references and
 * instantiation caches hold the same type arguments in many places, mostly lists of one or two types,
 * and share one list for them. A list must not change once it is in the table.
 */
export class TypeListTable {
  private readonly heads = new Map<number, number>();
  private readonly lists: Type[][] = [];
  /** The next list with the same hash, or -1, once two lists share one. */
  private nexts: number[] | undefined = undefined;

  /**
   * The list in the table with the types of `types`, in order, or `types` itself, which joins the
   * table. `hash` is `typeListHash(types, undefined, 0)`.
   */
  intern(hash: number, types: Type[]): Type[] {
    if (types.length === 0) return types;
    const head = this.heads.get(hash);
    const nexts = this.nexts;
    if (head !== undefined)
      for (let entry = head; entry >= 0; entry = nexts !== undefined ? nexts[entry]! : -1) {
        const list = this.lists[entry]!;
        if (sameTypeListParts(list, types)) return list;
      }
    const entry = this.lists.length;
    this.lists.push(types);
    if (nexts !== undefined) nexts.push(-1);
    if (head === undefined) {
      this.heads.set(hash, entry);
      return types;
    }
    // A second list with this hash: chain it after the first.
    let chain = nexts;
    if (chain === undefined) {
      chain = [];
      for (let i = 0; i <= entry; i++) chain.push(-1);
      this.nexts = chain;
    }
    chain[entry] = chain[head]!;
    chain[head] = entry;
    return types;
  }
}

/**
 * The references to a generic class, interface or tuple type, by the hash of their type arguments
 * (`createTypeReference`). A reference is its own entry: a lookup compares its type arguments. A
 * reference whose hash another reference has is kept in `collisions`.
 */
export class ReferenceCache {
  private readonly references = new Map<number, TypeReference>();
  private collisions: TypeListCache<TypeReference> | undefined = undefined;

  get(hash: number, typeArguments: readonly Type[]): TypeReference | undefined {
    const reference = this.references.get(hash);
    if (reference === undefined) return undefined;
    if (sameTypeListParts(reference.resolvedTypeArguments!, typeArguments)) return reference;
    const collisions = this.collisions;
    return collisions !== undefined ? collisions.get(hash, typeArguments, undefined, 0) : undefined;
  }

  /** Adds `reference`, whose type arguments `get` did not find. */
  add(hash: number, reference: TypeReference): void {
    if (this.references.get(hash) === undefined) {
      this.references.set(hash, reference);
      return;
    }
    let collisions = this.collisions;
    if (collisions === undefined) {
      collisions = new TypeListCache<TypeReference>();
      this.collisions = collisions;
    }
    collisions.set(hash, reference.resolvedTypeArguments!, undefined, 0, reference);
  }
}

/**
 * Fields that few types set, kept out of line in `Type.extra`, which is created on the first write
 * of a value other than the field's default. A type then costs one slot for all of them. Each field
 * is read and written through an accessor of the type class it belongs to, which returns the
 * default while the type has no extra fields. Rare fields that hot paths read stay inline (the
 * alias, construct signatures): a native accessor returns an owned reference, which costs reference
 * counting on every read of a counted value.
 */
export class TypeExtra implements ProgramLifetime {
  // StructuredType
  objectTypeWithoutAbstractConstructSignatures: Type | undefined;
  // ObjectType
  instantiations: TypeListCache<Type> | undefined;
  // TypeReference
  node: Node | undefined;
  // UnionType
  resolvedReducedType: Type | undefined;
  regularType: Type | undefined;
  origin: Type | undefined;
  keyPropertyName: string;
  constituentMap: Map<Type, Type> | undefined;
  constituentIds: Int32Array | undefined;
  membershipTests: number;
  // IntersectionType
  uniqueLiteralFilledInstantiation: Type | undefined;

  constructor() {
    this.objectTypeWithoutAbstractConstructSignatures = undefined;
    this.instantiations = undefined;
    this.node = undefined;
    this.resolvedReducedType = undefined;
    this.regularType = undefined;
    this.origin = undefined;
    this.keyPropertyName = '';
    this.constituentMap = undefined;
    this.constituentIds = undefined;
    this.membershipTests = 0;
    this.uniqueLiteralFilledInstantiation = undefined;
  }
}

/** The extra fields of `t`, created if it has none yet. */
export function typeExtra(t: Type): TypeExtra {
  let extra = t.extra;
  if (extra === undefined) {
    extra = new TypeExtra();
    t.extra = extra;
  }
  return extra;
}

/**
 * The base of every type. Narrow by `flags` (and `objectFlags` for object types), then cast to
 * the subclass, as tsgo does with `AsUnionType()` etc.
 */
/**
 * `TSC_TS_SIDE_STATE=1` (a test of the side tables): every type and signature keeps its lazily
 * computed state in the checker's side tables (`ObjectFlags.SideState`, `SignatureFlags.SideState`).
 */
export const sideStateForAll: boolean = process.env.TSC_TS_SIDE_STATE === '1';

/** `symbol`, with its id assigned (`getSymbolId`): every symbol tsc-ts's public API hands out has one. */
function withId(symbol: Symbol | undefined): Symbol | undefined {
  if (symbol !== undefined) getSymbolId(symbol);
  return symbol;
}

/**
 * What the methods of types that tsc-ts's public API calls need from the checker that created the type
 * (`InterfaceType.checking`, `ConditionalType.checking`); the Checker implements it.
 */
export interface TypeChecking {
  baseTypesOf(t: InterfaceType): readonly Type[];
  trueTypeOf(t: ConditionalType): Type;
  falseTypeOf(t: ConditionalType): Type;
}

export class Type implements ProgramLifetime {
  flags: TypeFlags;
  objectFlags: ObjectFlags;
  readonly id: number;
  symbol: Symbol | undefined;
  alias: TypeAlias | undefined;
  /** For types with a computed base constraint (type variables, structured types, …). */
  resolvedBaseConstraint: Type | undefined;
  /** Rarely set fields; undefined while all of them have their defaults. */
  extra: TypeExtra | undefined;

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    this.flags = flags;
    this.objectFlags = sideStateForAll ? objectFlags | ObjectFlags.SideState : objectFlags;
    this.id = id | 0;
    this.symbol = symbol;
    this.alias = undefined;
    this.resolvedBaseConstraint = undefined;
    this.extra = undefined;
  }

  // TypeScript 7's API (tsc-ts/api): the parts of a type, undefined or empty where its kind has none.

  getSymbol(): Symbol | undefined {
    return withId(this.symbol);
  }

  getAliasSymbol(): Symbol | undefined {
    return withId(this.alias?.symbol);
  }

  getAliasTypeArguments(): readonly Type[] {
    const alias = this.alias;
    return alias === undefined ? emptyTypes : alias.typeArguments.slice();
  }

  /** The target of a type reference, index type or string mapping type. */
  getTarget(): Type | undefined {
    if ((this.flags & TypeFlags.Index) !== 0) return (this as unknown as IndexType).target;
    if ((this.flags & TypeFlags.StringMapping) !== 0) return (this as unknown as StringMappingType).target;
    if (this.isTypeReference()) return (this as unknown as TypeReference).target;
    return undefined;
  }

  /** The members of a union or intersection type, or the types of a template literal type. */
  getTypes(): readonly Type[] {
    if ((this.flags & TypeFlags.TemplateLiteral) !== 0) return (this as unknown as TemplateLiteralType).types.slice();
    if ((this.flags & TypeFlags.UnionOrIntersection) !== 0)
      return (this as unknown as UnionOrIntersectionType).types.slice();
    return emptyTypes;
  }

  getFreshType(): Type | undefined {
    return this instanceof LiteralType ? this.freshType : undefined;
  }

  getRegularType(): Type | undefined {
    return this instanceof LiteralType ? this.regularType : undefined;
  }

  getObjectType(): Type | undefined {
    return (this.flags & TypeFlags.IndexedAccess) !== 0 ? (this as unknown as IndexedAccessType).objectType : undefined;
  }

  getIndexType(): Type | undefined {
    return (this.flags & TypeFlags.IndexedAccess) !== 0 ? (this as unknown as IndexedAccessType).indexType : undefined;
  }

  getCheckType(): Type | undefined {
    return (this.flags & TypeFlags.Conditional) !== 0 ? (this as unknown as ConditionalType).checkType : undefined;
  }

  getExtendsType(): Type | undefined {
    return (this.flags & TypeFlags.Conditional) !== 0 ? (this as unknown as ConditionalType).extendsType : undefined;
  }

  getTrueType(): Type | undefined {
    if ((this.flags & TypeFlags.Conditional) === 0) return undefined;
    const conditional = this as unknown as ConditionalType;
    return conditional.checking?.trueTypeOf(conditional);
  }

  getFalseType(): Type | undefined {
    if ((this.flags & TypeFlags.Conditional) === 0) return undefined;
    const conditional = this as unknown as ConditionalType;
    return conditional.checking?.falseTypeOf(conditional);
  }

  /** The base type of a substitution type. */
  getBaseType(): Type | undefined {
    return (this.flags & TypeFlags.Substitution) !== 0 ? (this as unknown as SubstitutionType).baseType : undefined;
  }

  /** The constraint of a substitution type. */
  getConstraint(): Type | undefined {
    return (this.flags & TypeFlags.Substitution) !== 0 ? (this as unknown as SubstitutionType).constraint : undefined;
  }

  /** The type parameters of a class or interface type, outer and local, without its `this` type. */
  getTypeParameters(): readonly Type[] {
    return this.isClassOrInterface() ? (this as unknown as InterfaceType).typeParameters() : emptyTypes;
  }

  getOuterTypeParameters(): readonly Type[] {
    return this.isClassOrInterface() ? (this as unknown as InterfaceType).outerTypeParameters() : emptyTypes;
  }

  getLocalTypeParameters(): readonly Type[] {
    return this.isClassOrInterface() ? (this as unknown as InterfaceType).localTypeParameters() : emptyTypes;
  }

  /** The base types of a class or interface type, or undefined for any other type. */
  getBaseTypes(): readonly Type[] | undefined {
    if (!this.isClassOrInterface()) return undefined;
    const declared = this as unknown as InterfaceType;
    return declared.checking === undefined ? emptyTypes : declared.checking.baseTypesOf(declared).slice();
  }

  isClassOrInterface(): boolean {
    return (this.flags & TypeFlags.Object) !== 0 && (this.objectFlags & ObjectFlags.ClassOrInterface) !== 0;
  }

  isUnionType(): boolean {
    return (this.flags & TypeFlags.Union) !== 0;
  }

  isIntersectionType(): boolean {
    return (this.flags & TypeFlags.Intersection) !== 0;
  }

  isObjectType(): boolean {
    return (this.flags & TypeFlags.Object) !== 0;
  }

  isIntrinsicType(): boolean {
    return (this.flags & TypeFlags.Intrinsic) !== 0;
  }

  /** Whether this is the error type: an intrinsic type named `error`. */
  isErrorType(): boolean {
    return this instanceof IntrinsicType && this.intrinsicName === 'error';
  }

  isLiteralType(): boolean {
    return (this.flags & TypeFlags.Literal) !== 0;
  }

  isStringLiteralType(): boolean {
    return (this.flags & TypeFlags.StringLiteral) !== 0;
  }

  isNumberLiteralType(): boolean {
    return (this.flags & TypeFlags.NumberLiteral) !== 0;
  }

  isBigIntLiteralType(): boolean {
    return (this.flags & TypeFlags.BigIntLiteral) !== 0;
  }

  isBooleanLiteralType(): boolean {
    return (this.flags & TypeFlags.BooleanLiteral) !== 0;
  }

  isTypeReference(): boolean {
    return (this.flags & TypeFlags.Object) !== 0 && (this.objectFlags & ObjectFlags.Reference) !== 0;
  }

  isTupleType(): boolean {
    return (this.flags & TypeFlags.Object) !== 0 && (this.objectFlags & ObjectFlags.Tuple) !== 0;
  }

  isIndexType(): boolean {
    return (this.flags & TypeFlags.Index) !== 0;
  }

  isIndexedAccessType(): boolean {
    return (this.flags & TypeFlags.IndexedAccess) !== 0;
  }

  isConditionalType(): boolean {
    return (this.flags & TypeFlags.Conditional) !== 0;
  }

  isSubstitutionType(): boolean {
    return (this.flags & TypeFlags.Substitution) !== 0;
  }

  isTemplateLiteralType(): boolean {
    return (this.flags & TypeFlags.TemplateLiteral) !== 0;
  }

  isStringMappingType(): boolean {
    return (this.flags & TypeFlags.StringMapping) !== 0;
  }

  isTypeParameter(): boolean {
    return (this.flags & TypeFlags.TypeParameter) !== 0;
  }
}

export class IntrinsicType extends Type {
  readonly intrinsicName: string;

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, intrinsicName: string) {
    super(flags, objectFlags, id, undefined);
    this.intrinsicName = intrinsicName;
  }
}

/**
 * A literal or enum member type. `value` is the string of string literals, the number of number
 * literals, `true`/`false` for booleans, the decimal digits (with a leading `-`) of bigints, and
 * unset for computed enum members.
 */
export class LiteralType extends Type {
  readonly stringValue: string;
  readonly numberValue: number;
  /** Created on first use, except for `true` and `false`. */
  freshType: LiteralType | undefined;
  regularType: LiteralType;

  constructor(flags: TypeFlags, id: number, symbol: Symbol | undefined, stringValue: string, numberValue: number) {
    super(flags, ObjectFlags.None, id, symbol);
    this.stringValue = stringValue;
    this.numberValue = numberValue;
    this.freshType = undefined;
    this.regularType = this;
  }

  /** The value, as TypeScript 7's API gives it: a string, number, bigint or boolean. */
  get value(): string | number | bigint | boolean {
    if ((this.flags & TypeFlags.StringLiteral) !== 0) return this.stringValue;
    if ((this.flags & TypeFlags.BigIntLiteral) !== 0) return BigInt(this.stringValue);
    if ((this.flags & TypeFlags.BooleanLiteral) !== 0) return this.stringValue === 'true';
    return this.numberValue;
  }
}

export class UniqueESSymbolType extends Type {
  readonly name: string;

  constructor(id: number, symbol: Symbol, name: string) {
    super(TypeFlags.UniqueESSymbol, ObjectFlags.None, id, symbol);
    this.name = name;
  }
}

/**
 * The members table of a type, built when `members` is read (checker-members.ts): of an instantiated
 * type whose member symbols are instantiated on demand (`PendingInstantiatedMembers`), where reading
 * `properties` builds the properties too, as tsgo builds them when it resolves the members, and
 * lookups by name instantiate only the member asked for; or of a type whose members are all
 * properties (`PropertyMembers`), where lookups by name read the properties.
 */
export abstract class PendingMembers {
  /**
   * Set when `properties` is built and the members table is not (`PropertyMembers`): the type's
   * properties, which lookups by name then read.
   */
  materializedProperties: Symbol[] | undefined = undefined;

  /**
   * Sets `t.propertiesValue`. Where lookups can read the properties, it replaces `t.pendingMembers`
   * with a `PropertyMembers`; otherwise it sets `t.membersValue` too and clears `t.pendingMembers`.
   */
  abstract materialize(t: StructuredType): void;

  /** Sets `t.membersValue` and `t.propertiesValue` and clears `t.pendingMembers`. */
  abstract materializeTable(t: StructuredType): void;

  /** `members.get(name)` of the table tsgo would have built by now. */
  abstract get(name: string): Symbol | undefined;
}

/**
 * The property names of instantiated types whose members tables are built on demand, shared by the
 * instantiations of one source that have the same names in the same order: most instantiations of
 * a class or interface have the members of their source and of the same bases.
 */
export class MemberNames {
  /** The names of the properties, in order. */
  readonly names: string[];
  /** The index of each name in `names`. */
  readonly positions: Map<string, number>;
  /** The indexes in `names` of the members table's names, in table order. */
  readonly tableOrder: number[];

  constructor(names: string[], positions: Map<string, number>, tableOrder: number[]) {
    this.names = names;
    this.positions = positions;
    this.tableOrder = tableOrder;
  }
}

/** A type with members: object types, unions and intersections. */
export class StructuredType extends Type {
  membersValue: SymbolTable | undefined;
  propertiesValue: Symbol[];
  /** Set while the member symbols of an instantiated type are not instantiated yet. */
  pendingMembers: PendingMembers | undefined;
  callSignatures: Signature[];
  constructSignatures: Signature[];
  indexInfos: IndexInfo[];

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(flags, objectFlags, id, symbol);
    this.membersValue = undefined;
    this.propertiesValue = emptySymbols;
    this.pendingMembers = undefined;
    this.callSignatures = emptySignatures;
    this.constructSignatures = emptySignatures;
    this.indexInfos = emptyIndexInfos;
  }

  get objectTypeWithoutAbstractConstructSignatures(): Type | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.objectTypeWithoutAbstractConstructSignatures : undefined;
  }

  set objectTypeWithoutAbstractConstructSignatures(t: Type | undefined) {
    if (t !== undefined || this.extra !== undefined) typeExtra(this).objectTypeWithoutAbstractConstructSignatures = t;
  }

  get members(): SymbolTable | undefined {
    const pending = this.pendingMembers;
    if (pending !== undefined) pending.materializeTable(this);
    return this.membersValue;
  }

  set members(members: SymbolTable | undefined) {
    this.membersValue = members;
  }

  get properties(): Symbol[] {
    const pending = this.pendingMembers;
    if (pending !== undefined && pending.materializedProperties === undefined) pending.materialize(this);
    return this.propertiesValue;
  }

  set properties(properties: Symbol[]) {
    this.propertiesValue = properties;
  }
}

export class ObjectType extends StructuredType {
  /** The generic type this one instantiates. */
  target: Type | undefined;
  mapper: TypeMapper | undefined;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(TypeFlags.Object, objectFlags, id, symbol);
    this.target = undefined;
    this.mapper = undefined;
  }

  get instantiations(): TypeListCache<Type> | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.instantiations : undefined;
  }

  set instantiations(instantiations: TypeListCache<Type> | undefined) {
    if (instantiations !== undefined || this.extra !== undefined) typeExtra(this).instantiations = instantiations;
  }
}

/** An instantiation of a generic class, interface or tuple type. */
export class TypeReference extends ObjectType {
  resolvedTypeArguments: Type[] | undefined;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.resolvedTypeArguments = undefined;
  }

  /** The type node of a deferred reference, else undefined. */
  get node(): Node | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.node : undefined;
  }

  set node(node: Node | undefined) {
    if (node !== undefined || this.extra !== undefined) typeExtra(this).node = node;
  }
}

/** A class or interface; when generic, also the reference to itself instantiated with its own type parameters. */
export class InterfaceType extends TypeReference {
  /** Outer, then local type parameters, then the `this` type. */
  allTypeParameters: Type[];
  outerTypeParameterCount: number;
  thisType: Type | undefined;
  baseTypesResolved: boolean;
  declaredMembersResolved: boolean;
  resolvedBaseConstructorType: Type | undefined;
  resolvedBaseTypes: Type[];
  declaredMembers: SymbolTable | undefined;
  declaredCallSignatures: Signature[];
  declaredConstructSignatures: Signature[];
  declaredIndexInfos: IndexInfo[];
  /** Positions of the declared members by name, for lazily instantiated members of instantiations. */
  declaredMemberPositions: Map<string, number> | undefined;
  /** The member states of the last pending instantiation of the type's members (`sharedStates`). */
  lastMemberStates: number[] | undefined;
  /** The property names of the last instantiation whose members table is built on demand. */
  lastMemberNames: MemberNames | undefined;
  /** The references to a generic class, interface or tuple type, by their type arguments. */
  references: ReferenceCache | undefined;
  /** The checker that created the type, for `getBaseTypes()`. */
  checking: TypeChecking | undefined;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.references = undefined;
    this.checking = undefined;
    this.declaredMemberPositions = undefined;
    this.lastMemberStates = undefined;
    this.lastMemberNames = undefined;
    this.allTypeParameters = emptyTypes;
    this.outerTypeParameterCount = 0;
    this.thisType = undefined;
    this.baseTypesResolved = false;
    this.declaredMembersResolved = false;
    this.resolvedBaseConstructorType = undefined;
    this.resolvedBaseTypes = emptyTypes;
    this.declaredMembers = undefined;
    this.declaredCallSignatures = emptySignatures;
    this.declaredConstructSignatures = emptySignatures;
    this.declaredIndexInfos = emptyIndexInfos;
  }

  outerTypeParameters(): Type[] {
    return this.allTypeParameters.length === 0
      ? emptyTypes
      : this.allTypeParameters.slice(0, this.outerTypeParameterCount);
  }

  localTypeParameters(): Type[] {
    const all = this.allTypeParameters;
    return all.length === 0 ? emptyTypes : all.slice(this.outerTypeParameterCount, all.length - 1);
  }

  typeParameters(): Type[] {
    const all = this.allTypeParameters;
    return all.length === 0 ? emptyTypes : all.slice(0, all.length - 1);
  }

  /** `typeParameters().length`, without copying them. */
  typeParameterCount(): number {
    const count = this.allTypeParameters.length;
    return count === 0 ? 0 : count - 1;
  }
}

export class TupleElementInfo {
  readonly flags: ElementFlags;
  /** A NamedTupleMember or ParameterDeclaration, if labeled. */
  readonly labeledDeclaration: Node | undefined;

  constructor(flags: ElementFlags, labeledDeclaration: Node | undefined) {
    this.flags = flags;
    this.labeledDeclaration = labeledDeclaration;
  }
}

export class TupleType extends InterfaceType {
  elementInfos: TupleElementInfo[];
  /** Required or variadic elements. */
  minLength: number;
  /** Leading required or optional elements. */
  fixedLength: number;
  combinedFlags: ElementFlags;
  readonly: boolean;

  constructor(objectFlags: ObjectFlags, id: number) {
    super(objectFlags, id, undefined);
    this.elementInfos = [];
    this.minLength = 0;
    this.fixedLength = 0;
    this.combinedFlags = ElementFlags.None;
    this.readonly = false;
  }

  /** The flags of each element (TypeScript 7's API). */
  get elementFlags(): ElementFlags[] {
    return this.elementInfos.map((info) => info.flags);
  }
}

export class InstantiationExpressionType extends ObjectType {
  node: Node | undefined;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.node = undefined;
  }
}

export class MappedType extends ObjectType {
  declaration: Node | undefined;
  typeParameter: Type | undefined;
  constraintType: Type | undefined;
  nameType: Type | undefined;
  templateType: Type | undefined;
  modifiersType: Type | undefined;
  resolvedApparentType: Type | undefined;
  containsError: boolean;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.declaration = undefined;
    this.typeParameter = undefined;
    this.constraintType = undefined;
    this.nameType = undefined;
    this.templateType = undefined;
    this.modifiersType = undefined;
    this.resolvedApparentType = undefined;
    this.containsError = false;
  }
}

export class ReverseMappedType extends ObjectType {
  source: Type | undefined;
  mappedType: Type | undefined;
  constraintType: Type | undefined;

  constructor(objectFlags: ObjectFlags, id: number) {
    super(objectFlags, id, undefined);
    this.source = undefined;
    this.mappedType = undefined;
    this.constraintType = undefined;
  }
}

export class EvolvingArrayType extends ObjectType {
  elementType: Type | undefined;
  finalArrayType: Type | undefined;

  constructor(objectFlags: ObjectFlags, id: number) {
    super(objectFlags, id, undefined);
    this.elementType = undefined;
    this.finalArrayType = undefined;
  }
}

/**
 * A union or intersection. Few have their members resolved or their properties cached, so those
 * live in `membersOf` (`UnionOrIntersectionMembers`), which is created when they are first written.
 */
export class UnionOrIntersectionType extends Type {
  readonly types: Type[];
  membersOf: UnionOrIntersectionMembers | undefined;

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, types: Type[]) {
    super(flags, objectFlags, id, undefined);
    this.types = types;
    this.membersOf = undefined;
  }
}

/**
 * The resolved members of a union or intersection (`membersHolder`) and the caches of its
 * properties, created on first use.
 */
export class UnionOrIntersectionMembers extends StructuredType {
  propertyCache: SymbolTable | undefined;
  propertyCacheWithoutFunctionPropertyAugment: SymbolTable | undefined;
  resolvedProperties: Symbol[] | undefined;

  constructor(flags: TypeFlags, id: number) {
    super(flags, ObjectFlags.None, id, undefined);
    this.propertyCache = undefined;
    this.propertyCacheWithoutFunctionPropertyAugment = undefined;
    this.resolvedProperties = undefined;
  }
}

/** The members holder of a union or intersection, created if it has none yet. */
export function unionOrIntersectionMembers(t: UnionOrIntersectionType): UnionOrIntersectionMembers {
  let members = t.membersOf;
  if (members === undefined) {
    members = new UnionOrIntersectionMembers(t.flags, t.id);
    t.membersOf = members;
  }
  return members;
}

/** A union; all of its own fields are rarely set and live in `extra`. */
export class UnionType extends UnionOrIntersectionType {
  constructor(objectFlags: ObjectFlags, id: number, types: Type[]) {
    super(TypeFlags.Union, objectFlags, id, types);
  }

  get resolvedReducedType(): Type | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.resolvedReducedType : undefined;
  }

  set resolvedReducedType(t: Type | undefined) {
    if (t !== undefined || this.extra !== undefined) typeExtra(this).resolvedReducedType = t;
  }

  get regularType(): Type | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.regularType : undefined;
  }

  set regularType(t: Type | undefined) {
    if (t !== undefined || this.extra !== undefined) typeExtra(this).regularType = t;
  }

  /** The denormalized union, intersection or index type the union came from. */
  get origin(): Type | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.origin : undefined;
  }

  set origin(t: Type | undefined) {
    if (t !== undefined || this.extra !== undefined) typeExtra(this).origin = t;
  }

  /** A property with a unique unit type in every object of the union; '' if not computed, '\0' if none. */
  get keyPropertyName(): string {
    const extra = this.extra;
    return extra !== undefined ? extra.keyPropertyName : '';
  }

  set keyPropertyName(name: string) {
    if (name !== '' || this.extra !== undefined) typeExtra(this).keyPropertyName = name;
  }

  get constituentMap(): Map<Type, Type> | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.constituentMap : undefined;
  }

  set constituentMap(map: Map<Type, Type> | undefined) {
    if (map !== undefined || this.extra !== undefined) typeExtra(this).constituentMap = map;
  }

  /**
   * A hash table of the ids of a large union's constituents, for membership tests; created on the
   * second test (`constituentTable`). About eight bytes a constituent, where a set of them took
   * about five times that.
   */
  get constituentIds(): Int32Array | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.constituentIds : undefined;
  }

  set constituentIds(ids: Int32Array | undefined) {
    if (ids !== undefined || this.extra !== undefined) typeExtra(this).constituentIds = ids;
  }

  get membershipTests(): number {
    const extra = this.extra;
    return extra !== undefined ? extra.membershipTests : 0;
  }

  set membershipTests(tests: number) {
    if (tests !== 0 || this.extra !== undefined) typeExtra(this).membershipTests = tests;
  }
}

export class IntersectionType extends UnionOrIntersectionType {
  resolvedApparentType: Type | undefined;

  constructor(objectFlags: ObjectFlags, id: number, types: Type[]) {
    super(TypeFlags.Intersection, objectFlags, id, types);
    this.resolvedApparentType = undefined;
  }

  get uniqueLiteralFilledInstantiation(): Type | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.uniqueLiteralFilledInstantiation : undefined;
  }

  set uniqueLiteralFilledInstantiation(t: Type | undefined) {
    if (t !== undefined || this.extra !== undefined) typeExtra(this).uniqueLiteralFilledInstantiation = t;
  }
}

export class TypeParameter extends Type {
  constraint: Type | undefined;
  target: Type | undefined;
  mapper: TypeMapper | undefined;
  isThisType: boolean;
  /**
   * A type parameter as referenced inside a distributive conditional type on it, which stands for each
   * constituent in turn; its constraint is the type parameter it was made from (`getDistributedTypeParameter`).
   */
  isDistributed: boolean;
  resolvedDefaultType: Type | undefined;
  /** The distributed form of this type parameter, made on first use. */
  distributedType: TypeParameter | undefined;

  constructor(id: number, symbol: Symbol | undefined) {
    super(TypeFlags.TypeParameter, ObjectFlags.None, id, symbol);
    this.constraint = undefined;
    this.target = undefined;
    this.mapper = undefined;
    this.isThisType = false;
    this.isDistributed = false;
    this.resolvedDefaultType = undefined;
    this.distributedType = undefined;
  }
}

/** Whether `t` is the distributed form of a type parameter. */
export function isDistributedTypeParameter(t: Type): boolean {
  return (t.flags & TypeFlags.TypeParameter) !== 0 && (t as TypeParameter).isDistributed;
}

/** The type parameter a distributed type parameter was made from; other types as they are. */
export function getNonDistributedTypeParameter(t: Type): Type {
  return (t.flags & TypeFlags.TypeParameter) !== 0 && (t as TypeParameter).isDistributed
    ? (t as TypeParameter).constraint!
    : t;
}

/** What `mapper` maps `t` to, a distributed type parameter as the type parameter it was made from. */
export function getMappedType(t: Type, mapper: TypeMapper): Type {
  return mapper.map(getNonDistributedTypeParameter(t));
}

/** `keyof T`. */
export class IndexType extends Type {
  readonly target: Type;
  readonly indexFlags: IndexFlags;

  constructor(id: number, target: Type, indexFlags: IndexFlags) {
    super(TypeFlags.Index, ObjectFlags.None, id, undefined);
    this.target = target;
    this.indexFlags = indexFlags;
  }
}

/** `T[K]`. */
export class IndexedAccessType extends Type {
  readonly objectType: Type;
  readonly indexType: Type;
  /** Only AccessFlags.Persistent. */
  readonly accessFlags: AccessFlags;

  constructor(id: number, objectType: Type, indexType: Type, accessFlags: AccessFlags) {
    super(TypeFlags.IndexedAccess, ObjectFlags.None, id, undefined);
    this.objectType = objectType;
    this.indexType = indexType;
    this.accessFlags = accessFlags;
  }
}

export class TemplateLiteralType extends Type {
  /** One longer than `types`. */
  readonly texts: string[];
  readonly types: Type[];

  constructor(id: number, texts: string[], types: Type[]) {
    super(TypeFlags.TemplateLiteral, ObjectFlags.None, id, undefined);
    this.texts = texts;
    this.types = types;
  }
}

/** `Uppercase<T>` and friends. */
export class StringMappingType extends Type {
  readonly target: Type;

  constructor(id: number, symbol: Symbol, target: Type) {
    super(TypeFlags.StringMapping, ObjectFlags.None, id, symbol);
    this.target = target;
  }
}

export class SubstitutionType extends Type {
  readonly baseType: Type;
  /** What the base type is known to satisfy. */
  readonly constraint: Type;

  constructor(id: number, baseType: Type, constraint: Type) {
    super(TypeFlags.Substitution, ObjectFlags.None, id, undefined);
    this.baseType = baseType;
    this.constraint = constraint;
  }
}

export class ConditionalRoot {
  readonly node: Node;
  readonly checkType: Type;
  readonly extendsType: Type;
  readonly isDistributive: boolean;
  readonly inferTypeParameters: Type[];
  readonly outerTypeParameters: Type[];
  readonly instantiations: TypeListCache<Type>;
  readonly alias: TypeAlias | undefined;
  /**
   * The type arguments of an extends type that is a reference to a class or interface; null for
   * other extends types, undefined until computed.
   */
  referenceArgs: ReferenceArgs | null | undefined;

  constructor(
    node: Node,
    checkType: Type,
    extendsType: Type,
    isDistributive: boolean,
    inferTypeParameters: Type[],
    outerTypeParameters: Type[],
    alias: TypeAlias | undefined,
  ) {
    this.node = node;
    this.checkType = checkType;
    this.extendsType = extendsType;
    this.isDistributive = isDistributive;
    this.inferTypeParameters = inferTypeParameters;
    this.outerTypeParameters = outerTypeParameters;
    this.instantiations = new TypeListCache<Type>();
    this.alias = alias;
    this.referenceArgs = undefined;
  }
}

/** What each type argument of a conditional type's extends type is, for `isFalseForEveryInference`. */
export class ReferenceArgs {
  readonly kinds: ReferenceArgKind[];
  /** The `infer` type parameter of each `ReferenceArgKind.Infer` type argument. */
  readonly inferTypeParameters: (Type | undefined)[];

  constructor(kinds: ReferenceArgKind[], inferTypeParameters: (Type | undefined)[]) {
    this.kinds = kinds;
    this.inferTypeParameters = inferTypeParameters;
  }
}

export const enum ReferenceArgKind {
  /** Has no `infer` type parameters, so inference doesn't change it. */
  Fixed,
  /** Just an `infer` type parameter that occurs nowhere else in the extends type. */
  Infer,
  /** An object type with `infer` type parameters: an instantiation of it is an object type. */
  Object,
  Other,
}

export class ConditionalType extends Type {
  readonly root: ConditionalRoot;
  readonly checkType: Type;
  readonly extendsType: Type;
  resolvedTrueType: Type | undefined;
  resolvedFalseType: Type | undefined;
  /** The true and false types, as one list (getBranchTypesFromConditionalType). */
  resolvedBranchTypes: Type[] | undefined;
  resolvedInferredTrueType: Type | undefined;
  resolvedDefaultConstraint: Type | undefined;
  resolvedConstraintOfDistributive: Type | undefined;
  readonly mapper: TypeMapper | undefined;
  readonly combinedMapper: TypeMapper | undefined;
  /** The checker that created the type, for `getTrueType()` and `getFalseType()`. */
  checking: TypeChecking | undefined;

  constructor(
    id: number,
    root: ConditionalRoot,
    checkType: Type,
    extendsType: Type,
    mapper: TypeMapper | undefined,
    combinedMapper: TypeMapper | undefined,
  ) {
    super(TypeFlags.Conditional, ObjectFlags.None, id, undefined);
    this.root = root;
    this.checkType = checkType;
    this.extendsType = extendsType;
    this.resolvedTrueType = undefined;
    this.resolvedFalseType = undefined;
    this.resolvedBranchTypes = undefined;
    this.resolvedInferredTrueType = undefined;
    this.resolvedDefaultConstraint = undefined;
    this.resolvedConstraintOfDistributive = undefined;
    this.mapper = mapper;
    this.combinedMapper = combinedMapper;
    this.checking = undefined;
  }
}

// ---- Signatures and index infos

export class TypePredicate {
  readonly kind: TypePredicateKind;
  readonly parameterIndex: number;
  readonly parameterName: string;
  readonly type: Type | undefined;

  constructor(kind: TypePredicateKind, parameterName: string, parameterIndex: number, type: Type | undefined) {
    this.kind = kind;
    this.parameterIndex = parameterIndex;
    this.parameterName = parameterName;
    this.type = type;
  }
}

export class CompositeSignature {
  /** False for an intersection. */
  readonly isUnion: boolean;
  readonly signatures: Signature[];

  constructor(isUnion: boolean, signatures: Signature[]) {
    this.isUnion = isUnion;
    this.signatures = signatures;
  }
}

/**
 * Fields that few signatures set, kept out of line in `Signature.extra` (see TypeExtra): the `this`
 * parameter, composite signatures and the caches of derived signatures.
 */
export class SignatureExtra implements ProgramLifetime {
  thisParameter: Symbol | undefined;
  isolatedSignatureType: Type | undefined;
  composite: CompositeSignature | undefined;
  erasedSignatureCache: Signature | undefined;
  canonicalSignatureCache: Signature | undefined;
  baseSignatureCache: Signature | undefined;
  optionalCallSignatureCache: Signature | undefined;
  instantiations: TypeListCache<Signature> | undefined;

  constructor() {
    this.thisParameter = undefined;
    this.isolatedSignatureType = undefined;
    this.composite = undefined;
    this.erasedSignatureCache = undefined;
    this.canonicalSignatureCache = undefined;
    this.baseSignatureCache = undefined;
    this.optionalCallSignatureCache = undefined;
    this.instantiations = undefined;
  }
}

/** The extra fields of `s`, created if it has none yet. */
export function signatureExtra(s: Signature): SignatureExtra {
  let extra = s.extra;
  if (extra === undefined) {
    extra = new SignatureExtra();
    s.extra = extra;
  }
  return extra;
}

export class Signature implements ProgramLifetime {
  readonly id: number;
  flags: SignatureFlags;
  minArgumentCount: number;
  /** -1 until computed. */
  resolvedMinArgumentCount: number;
  declaration: Node | undefined;
  typeParameters: Type[];
  parameters: Symbol[];
  resolvedReturnType: Type | undefined;
  resolvedTypePredicate: TypePredicate | undefined;
  target: Signature | undefined;
  mapper: TypeMapper | undefined;
  /** Rarely set fields; undefined while all of them have their defaults. */
  extra: SignatureExtra | undefined;

  constructor(
    id: number,
    flags: SignatureFlags,
    declaration: Node | undefined,
    typeParameters: Type[],
    thisParameter: Symbol | undefined,
    parameters: Symbol[],
    resolvedReturnType: Type | undefined,
    resolvedTypePredicate: TypePredicate | undefined,
    minArgumentCount: number,
  ) {
    this.id = id | 0;
    this.flags = sideStateForAll ? flags | SignatureFlags.SideState : flags;
    this.minArgumentCount = minArgumentCount | 0;
    this.resolvedMinArgumentCount = -1;
    this.declaration = declaration;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.resolvedReturnType = resolvedReturnType;
    this.resolvedTypePredicate = resolvedTypePredicate;
    this.target = undefined;
    this.mapper = undefined;
    this.extra = undefined;
    if (thisParameter !== undefined) signatureExtra(this).thisParameter = thisParameter;
  }

  get thisParameter(): Symbol | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.thisParameter : undefined;
  }

  set thisParameter(symbol: Symbol | undefined) {
    if (symbol !== undefined || this.extra !== undefined) signatureExtra(this).thisParameter = symbol;
  }

  // TypeScript 7's API (tsc-ts/api).

  getTypeParameters(): readonly Type[] {
    return this.typeParameters.slice();
  }

  getParameters(): readonly Symbol[] {
    for (const parameter of this.parameters) getSymbolId(parameter);
    return this.parameters.slice();
  }

  getThisParameter(): Symbol | undefined {
    return withId(this.thisParameter);
  }

  /** The signature this one was instantiated from. */
  getTarget(): Signature | undefined {
    return this.target;
  }

  get isolatedSignatureType(): Type | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.isolatedSignatureType : undefined;
  }

  set isolatedSignatureType(t: Type | undefined) {
    if (t !== undefined || this.extra !== undefined) signatureExtra(this).isolatedSignatureType = t;
  }

  get composite(): CompositeSignature | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.composite : undefined;
  }

  set composite(composite: CompositeSignature | undefined) {
    if (composite !== undefined || this.extra !== undefined) signatureExtra(this).composite = composite;
  }

  /** Caches of derived signatures. */
  get erasedSignatureCache(): Signature | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.erasedSignatureCache : undefined;
  }

  set erasedSignatureCache(s: Signature | undefined) {
    if (s !== undefined || this.extra !== undefined) signatureExtra(this).erasedSignatureCache = s;
  }

  get canonicalSignatureCache(): Signature | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.canonicalSignatureCache : undefined;
  }

  set canonicalSignatureCache(s: Signature | undefined) {
    if (s !== undefined || this.extra !== undefined) signatureExtra(this).canonicalSignatureCache = s;
  }

  get baseSignatureCache(): Signature | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.baseSignatureCache : undefined;
  }

  set baseSignatureCache(s: Signature | undefined) {
    if (s !== undefined || this.extra !== undefined) signatureExtra(this).baseSignatureCache = s;
  }

  get optionalCallSignatureCache(): Signature | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.optionalCallSignatureCache : undefined;
  }

  set optionalCallSignatureCache(s: Signature | undefined) {
    if (s !== undefined || this.extra !== undefined) signatureExtra(this).optionalCallSignatureCache = s;
  }

  get instantiations(): TypeListCache<Signature> | undefined {
    const extra = this.extra;
    return extra !== undefined ? extra.instantiations : undefined;
  }

  set instantiations(instantiations: TypeListCache<Signature> | undefined) {
    if (instantiations !== undefined || this.extra !== undefined) signatureExtra(this).instantiations = instantiations;
  }

  hasRestParameter(): boolean {
    return (this.flags & SignatureFlags.HasRestParameter) !== 0;
  }
}

export class IndexInfo implements ProgramLifetime {
  readonly keyType: Type;
  readonly valueType: Type;
  readonly isReadonly: boolean;
  /** The IndexSignatureDeclaration. */
  readonly declaration: Node | undefined;
  /** Elements with computed property names that make up the index signature. */
  readonly components: Node[];
  indexSymbol: Symbol | undefined;

  constructor(keyType: Type, valueType: Type, isReadonly: boolean, declaration: Node | undefined, components: Node[]) {
    this.keyType = keyType;
    this.valueType = valueType;
    this.isReadonly = isReadonly;
    this.declaration = declaration;
    this.components = components;
    this.indexSymbol = undefined;
  }

  /** The value type (TypeScript 7's API). */
  get type(): Type {
    return this.valueType;
  }
}

// Shared empty lists; never mutated.
export const emptyTypes: Type[] = [];
export const emptySymbols: Symbol[] = [];
export const emptySignatures: Signature[] = [];
export const emptyIndexInfos: IndexInfo[] = [];

// ---- Mappers

export const enum TypeMapperKind {
  Unknown = 0,
  Simple = 1,
  Array = 2,
  Merged = 3,
}

/** Maps type parameters to types. Subclasses replace tsgo's function mappers. */
export abstract class TypeMapper {
  abstract map(type: Type): Type;

  kind(): TypeMapperKind {
    return TypeMapperKind.Unknown;
  }

  /** Whether the mapper only maps a `this` type parameter. */
  mapsThisOnly(): boolean {
    return false;
  }
}

function isThisTypeParameter(type: Type): boolean {
  return (type.flags & TypeFlags.TypeParameter) !== 0 && (type as TypeParameter).isThisType;
}

export class SimpleTypeMapper extends TypeMapper {
  readonly source: Type;
  readonly target: Type;

  constructor(source: Type, target: Type) {
    super();
    this.source = source;
    this.target = target;
  }

  map(type: Type): Type {
    return type === this.source ? this.target : type;
  }

  kind(): TypeMapperKind {
    return TypeMapperKind.Simple;
  }

  mapsThisOnly(): boolean {
    return isThisTypeParameter(this.source);
  }
}

export class ArrayTypeMapper extends TypeMapper {
  readonly sources: Type[];
  readonly targets: Type[];

  constructor(sources: Type[], targets: Type[]) {
    super();
    this.sources = sources;
    this.targets = targets;
  }

  map(type: Type): Type {
    const sources = this.sources;
    for (let i = 0; i < sources.length; i++) if (type === sources[i]!) return this.targets[i]!;
    return type;
  }

  kind(): TypeMapperKind {
    return TypeMapperKind.Array;
  }

  mapsThisOnly(): boolean {
    return this.sources.length === 1 && isThisTypeParameter(this.sources[0]!);
  }

  /** The number of targets, one per source. */
  targetCount(): number {
    return this.targets.length;
  }

  /** The target of the source at `index`. */
  targetAt(index: number): Type {
    return this.targets[index]!;
  }
}

/**
 * The mapper of a type reference's members: its type arguments, then the reference itself for the
 * last source, the class or interface's `this` type. `targets` holds the type arguments only, so the
 * reference's own list serves without a copy that adds the reference.
 */
export class ThisArgumentTypeMapper extends ArrayTypeMapper {
  readonly thisTarget: Type;

  constructor(sources: Type[], typeArguments: Type[], thisTarget: Type) {
    super(sources, typeArguments);
    this.thisTarget = thisTarget;
  }

  map(type: Type): Type {
    const sources = this.sources;
    const last = sources.length - 1;
    for (let i = 0; i < last; i++) if (type === sources[i]!) return this.targets[i]!;
    return type === sources[last]! ? this.thisTarget : type;
  }

  targetCount(): number {
    return this.targets.length + 1;
  }

  targetAt(index: number): Type {
    return index < this.targets.length ? this.targets[index]! : this.thisTarget;
  }
}

/**
 * The number of sources from which a mapper looks types up in an index. A tuple reference with thousands of
 * elements maps one type parameter per element, and searching them all for each element was quadratic in the
 * tuple's length.
 */
const indexedTypeMapperThreshold = 64;

/** An ArrayTypeMapper that looks its sources up in an index, built on its first lookup. */
export class IndexedArrayTypeMapper extends ArrayTypeMapper {
  /** The index of each source's first occurrence. */
  index: Map<Type, number> | undefined = undefined;
  /** The number of sources `index` was built from. */
  indexedLength = 0;

  map(type: Type): Type {
    const sources = this.sources;
    let index = this.index;
    if (index === undefined || this.indexedLength !== sources.length) {
      index = new Map<Type, number>();
      for (let i = 0; i < sources.length; i++) if (!index.has(sources[i]!)) index.set(sources[i]!, i);
      this.index = index;
      this.indexedLength = sources.length;
    }
    const i = index.get(type);
    return i !== undefined ? this.targets[i]! : type;
  }
}

/** Maps each of `sources` to one target. */
export class ArrayToSingleTypeMapper extends TypeMapper {
  readonly sources: Type[];
  readonly target: Type;

  constructor(sources: Type[], target: Type) {
    super();
    this.sources = sources;
    this.target = target;
  }

  map(type: Type): Type {
    return this.sources.includes(type) ? this.target : type;
  }

  mapsThisOnly(): boolean {
    return this.sources.length === 1 && isThisTypeParameter(this.sources[0]!);
  }
}

/** Applies `m1`, then `m2`. */
export class MergedTypeMapper extends TypeMapper {
  readonly m1: TypeMapper;
  readonly m2: TypeMapper;

  constructor(m1: TypeMapper, m2: TypeMapper) {
    super();
    this.m1 = m1;
    this.m2 = m2;
  }

  map(type: Type): Type {
    return this.m2.map(this.m1.map(type));
  }

  kind(): TypeMapperKind {
    return TypeMapperKind.Merged;
  }
}

export function newTypeMapper(sources: Type[], targets: Type[]): TypeMapper {
  if (sources.length === 1) return new SimpleTypeMapper(sources[0]!, targets[0]!);
  return sources.length >= indexedTypeMapperThreshold
    ? new IndexedArrayTypeMapper(sources, targets)
    : new ArrayTypeMapper(sources, targets);
}

/** `newTypeMapper(sources, [...typeArguments, thisTarget])`, without building that list where it can. */
export function newThisArgumentTypeMapper(sources: Type[], typeArguments: Type[], thisTarget: Type): TypeMapper {
  if (sources.length === 1) return new SimpleTypeMapper(sources[0]!, thisTarget);
  if (sources.length >= indexedTypeMapperThreshold) {
    const targets: Type[] = [];
    for (const t of typeArguments) targets.push(t);
    targets.push(thisTarget);
    return new IndexedArrayTypeMapper(sources, targets);
  }
  return new ThisArgumentTypeMapper(sources, typeArguments, thisTarget);
}

export function mergeTypeMappers(m1: TypeMapper | undefined, m2: TypeMapper): TypeMapper {
  return m1 !== undefined ? new MergedTypeMapper(m1, m2) : m2;
}

export function prependTypeMapping(source: Type, target: Type, mapper: TypeMapper | undefined): TypeMapper {
  const simple = new SimpleTypeMapper(getNonDistributedTypeParameter(source), target);
  return mapper === undefined ? simple : new MergedTypeMapper(simple, mapper);
}

export function appendTypeMapping(mapper: TypeMapper | undefined, source: Type, target: Type): TypeMapper {
  const simple = new SimpleTypeMapper(getNonDistributedTypeParameter(source), target);
  return mapper === undefined ? simple : new MergedTypeMapper(mapper, simple);
}

// ---- Links

/**
 * What the checker caches per symbol and rarely sets. Common values (the type, target, mapper, name type
 * and others) are columns of `Checker` instead; see link-tables.ts. The fields most links objects have
 * are fields of this class; the others are in a RareSymbolLinks object, created on the first write of
 * one of them, behind accessors.
 */
export class SymbolLinks implements ProgramLifetime {
  /** Constituents of a deferred union/intersection property type. */
  deferralParent: Type | undefined;
  deferralConstituents: Type[] | undefined;
  immediateTarget: Symbol | undefined;
  aliasTarget: Symbol | undefined;
  resolvedExports: SymbolTable | undefined;
  resolvedMembers: SymbolTable | undefined;
  declaredType: Type | undefined;
  /** The other links, created on first write. */
  private rareLinks: RareSymbolLinks | undefined;
  functionOrConstructorChecked: boolean;
  aliasReferenced: boolean;

  constructor() {
    this.deferralParent = undefined;
    this.deferralConstituents = undefined;
    this.functionOrConstructorChecked = false;
    this.immediateTarget = undefined;
    this.aliasTarget = undefined;
    this.aliasReferenced = false;
    this.resolvedExports = undefined;
    this.resolvedMembers = undefined;
    this.declaredType = undefined;
    this.rareLinks = undefined;
  }

  private rare(): RareSymbolLinks {
    let rare = this.rareLinks;
    if (rare === undefined) {
      rare = new RareSymbolLinks();
      this.rareLinks = rare;
    }
    return rare;
  }

  get writeType(): Type | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.writeType;
  }

  set writeType(value: Type | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().writeType = value;
  }

  get deferralWriteConstituents(): Type[] | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.deferralWriteConstituents;
  }

  set deferralWriteConstituents(value: Type[] | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().deferralWriteConstituents = value;
  }

  get typeOnlyDeclaration(): Node | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.typeOnlyDeclaration;
  }

  set typeOnlyDeclaration(value: Node | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().typeOnlyDeclaration = value;
  }

  get typeOnlyExportStarMap(): Map<string, Node> | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.typeOnlyExportStarMap;
  }

  set typeOnlyExportStarMap(value: Map<string, Node> | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().typeOnlyExportStarMap = value;
  }

  get exportsChecked(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.exportsChecked;
  }

  set exportsChecked(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().exportsChecked = value;
  }

  get lateSymbol(): Symbol | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.lateSymbol;
  }

  set lateSymbol(value: Symbol | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().lateSymbol = value;
  }

  get typeParameters(): Type[] | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.typeParameters;
  }

  set typeParameters(value: Type[] | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().typeParameters = value;
  }

  get instantiations(): Map<string, Type> | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.instantiations;
  }

  set instantiations(value: Map<string, Type> | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().instantiations = value;
  }

  get interfaceChecked(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.interfaceChecked;
  }

  set interfaceChecked(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().interfaceChecked = value;
  }

  get indexSignaturesChecked(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.indexSignaturesChecked;
  }

  set indexSignaturesChecked(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().indexSignaturesChecked = value;
  }

  get typeParametersChecked(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.typeParametersChecked;
  }

  set typeParametersChecked(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().typeParametersChecked = value;
  }

  get enumChecked(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.enumChecked;
  }

  set enumChecked(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().enumChecked = value;
  }

  get mergedExportsChecked(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.mergedExportsChecked;
  }

  set mergedExportsChecked(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().mergedExportsChecked = value;
  }

  get variances(): VarianceFlags[] | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.variances;
  }

  set variances(value: VarianceFlags[] | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().variances = value;
  }

  get lastAssignmentPos(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.lastAssignmentPos;
  }

  set lastAssignmentPos(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().lastAssignmentPos = value;
  }

  get hasDefiniteAssignment(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.hasDefiniteAssignment;
  }

  set hasDefiniteAssignment(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().hasDefiniteAssignment = value;
  }

  get isConstructorDeclaredProperty(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.isConstructorDeclaredProperty;
  }

  set isConstructorDeclaredProperty(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().isConstructorDeclaredProperty = value;
  }

  get thisAssignmentKind(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.thisAssignmentKind;
  }

  set thisAssignmentKind(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().thisAssignmentKind = value;
  }

  get thisAssignmentLocation(): Node | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.thisAssignmentLocation;
  }

  set thisAssignmentLocation(value: Node | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().thisAssignmentLocation = value;
  }

  get reverseMappedPropertyType(): Type | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.reverseMappedPropertyType;
  }

  set reverseMappedPropertyType(value: Type | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().reverseMappedPropertyType = value;
  }

  get reverseMappedMappedType(): Type | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.reverseMappedMappedType;
  }

  set reverseMappedMappedType(value: Type | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().reverseMappedMappedType = value;
  }

  get reverseMappedConstraintType(): Type | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.reverseMappedConstraintType;
  }

  set reverseMappedConstraintType(value: Type | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().reverseMappedConstraintType = value;
  }
}

/** The links of a symbol that few symbols have (SymbolLinks). */
export class RareSymbolLinks implements ProgramLifetime {
  // Values
  writeType: Type | undefined;
  deferralWriteConstituents: Type[] | undefined;
  typeOnlyDeclaration: Node | undefined;
  /** Exports reached only through `export type *`, by name. */
  typeOnlyExportStarMap: Map<string, Node> | undefined;
  exportsChecked: boolean;
  lateSymbol: Symbol | undefined;
  /** Type parameters of a type alias. */
  typeParameters: Type[] | undefined;
  /** Instantiations of a generic type alias. */
  instantiations: Map<string, Type> | undefined;
  interfaceChecked: boolean;
  indexSignaturesChecked: boolean;
  typeParametersChecked: boolean;
  enumChecked: boolean;
  mergedExportsChecked: boolean;
  variances: VarianceFlags[] | undefined;
  // Assignment tracking
  lastAssignmentPos: number;
  hasDefiniteAssignment: boolean;
  isConstructorDeclaredProperty: boolean;
  // JavaScript `this.x` assignment declarations
  /** A `ThisAssignmentKind` plus one; zero until computed. */
  thisAssignmentKind: number;
  thisAssignmentLocation: Node | undefined;
  // Reverse mapped properties
  reverseMappedPropertyType: Type | undefined;
  reverseMappedMappedType: Type | undefined;
  reverseMappedConstraintType: Type | undefined;

  constructor() {
    this.writeType = undefined;
    this.deferralWriteConstituents = undefined;
    this.typeOnlyDeclaration = undefined;
    this.typeOnlyExportStarMap = undefined;
    this.exportsChecked = false;
    this.lateSymbol = undefined;
    this.typeParameters = undefined;
    this.instantiations = undefined;
    this.interfaceChecked = false;
    this.indexSignaturesChecked = false;
    this.typeParametersChecked = false;
    this.enumChecked = false;
    this.mergedExportsChecked = false;
    this.variances = undefined;
    this.lastAssignmentPos = 0;
    this.hasDefiniteAssignment = false;
    this.isConstructorDeclaredProperty = false;
    this.thisAssignmentKind = 0;
    this.thisAssignmentLocation = undefined;
    this.reverseMappedPropertyType = undefined;
    this.reverseMappedMappedType = undefined;
    this.reverseMappedConstraintType = undefined;
  }
}

/**
 * What the checker caches per node and rarely sets. The resolved symbol, type and signature are columns of
 * `Checker` instead; see link-tables.ts. As in SymbolLinks, the fields few links objects have are in a
 * RareNodeLinks object behind accessors.
 */
export class NodeLinks implements ProgramLifetime {
  /** Outer type parameters of an anonymous object type node. */
  outerTypeParameters: Type[] | undefined;
  effectsSignature: Signature | undefined;
  /** Type of an assertion's operand. */
  assertionExpressionType: Type | undefined;
  /** The other links, created on first write. */
  private rareLinks: RareNodeLinks | undefined;
  flags: NodeCheckFlags;

  constructor() {
    this.flags = NodeCheckFlags.None;
    this.outerTypeParameters = undefined;
    this.effectsSignature = undefined;
    this.assertionExpressionType = undefined;
    this.rareLinks = undefined;
  }

  private rare(): RareNodeLinks {
    let rare = this.rareLinks;
    if (rare === undefined) {
      rare = new RareNodeLinks();
      this.rareLinks = rare;
    }
    return rare;
  }

  get contextFreeType(): Type | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.contextFreeType;
  }

  set contextFreeType(value: Type | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().contextFreeType = value;
  }

  get enumStringValue(): string {
    const rare = this.rareLinks;
    return rare === undefined ? '' : rare.enumStringValue;
  }

  set enumStringValue(value: string) {
    if (value === '' && this.rareLinks === undefined) return;
    this.rare().enumStringValue = value;
  }

  get enumNumberValue(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.enumNumberValue;
  }

  set enumNumberValue(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().enumNumberValue = value;
  }

  get enumValueKind(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.enumValueKind;
  }

  set enumValueKind(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().enumValueKind = value;
  }

  get enumValueFlags(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.enumValueFlags;
  }

  set enumValueFlags(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().enumValueFlags = value;
  }

  get hasReportedStatementInAmbientContext(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.hasReportedStatementInAmbientContext;
  }

  set hasReportedStatementInAmbientContext(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().hasReportedStatementInAmbientContext = value;
  }

  get declarationRequiresScopeChange(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.declarationRequiresScopeChange;
  }

  set declarationRequiresScopeChange(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().declarationRequiresScopeChange = value;
  }

  get typeChecked(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.typeChecked;
  }

  set typeChecked(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().typeChecked = value;
  }

  get deferredNodes(): Node[] | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.deferredNodes;
  }

  set deferredNodes(value: Node[] | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().deferredNodes = value;
  }

  get switchTypes(): Type[] | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.switchTypes;
  }

  set switchTypes(value: Type[] | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().switchTypes = value;
  }

  get switchWitnesses(): string[] | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.switchWitnesses;
  }

  set switchWitnesses(value: string[] | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().switchWitnesses = value;
  }

  get switchWitnessesValid(): boolean {
    const rare = this.rareLinks;
    return rare === undefined ? false : rare.switchWitnessesValid;
  }

  set switchWitnessesValid(value: boolean) {
    if (value === false && this.rareLinks === undefined) return;
    this.rare().switchWitnessesValid = value;
  }

  get exhaustiveState(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.exhaustiveState;
  }

  set exhaustiveState(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().exhaustiveState = value;
  }

  get decoratorSignature(): Signature | undefined {
    const rare = this.rareLinks;
    return rare === undefined ? undefined : rare.decoratorSignature;
  }

  set decoratorSignature(value: Signature | undefined) {
    if (value === undefined && this.rareLinks === undefined) return;
    this.rare().decoratorSignature = value;
  }

  get containsArgumentsReference(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.containsArgumentsReference;
  }

  set containsArgumentsReference(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().containsArgumentsReference = value;
  }

  get mentionsArguments(): number {
    const rare = this.rareLinks;
    return rare === undefined ? 0 : rare.mentionsArguments;
  }

  set mentionsArguments(value: number) {
    if (value === 0 && this.rareLinks === undefined) return;
    this.rare().mentionsArguments = value;
  }
}

/** The links of a node that few nodes have (NodeLinks). */
export class RareNodeLinks implements ProgramLifetime {
  /** Context-free type of an expression. */
  contextFreeType: Type | undefined;
  /** Enum member value: a string, or a number when `enumValueIsNumber`. */
  enumStringValue: string;
  enumNumberValue: number;
  enumValueKind: number;
  /** EvaluatedFlags of the enum member value. */
  enumValueFlags: number;
  hasReportedStatementInAmbientContext: boolean;
  declarationRequiresScopeChange: number;
  /** For source files: whether the file has been checked, and its nodes waiting for a deferred check. */
  typeChecked: boolean;
  deferredNodes: Node[] | undefined;
  /** Case clause types of a switch statement. */
  switchTypes: Type[] | undefined;
  /** `typeof` case texts of a switch statement; '' for default and duplicates. */
  switchWitnesses: string[] | undefined;
  switchWitnessesValid: boolean;
  /** 0 unknown, 1 computing, 2 not exhaustive, 3 exhaustive. */
  exhaustiveState: number;
  /** The signature the runtime calls a decorator of this declaration with. */
  decoratorSignature: Signature | undefined;
  /** Whether a function body references `arguments`: 0 until computed, 1 for no, 2 for yes. */
  containsArgumentsReference: number;
  /** For source files: whether the file has an identifier `arguments`: 0 until computed, 1 for no, 2 for yes. */
  mentionsArguments: number;

  constructor() {
    this.contextFreeType = undefined;
    this.enumStringValue = '';
    this.enumNumberValue = 0;
    this.enumValueKind = 0;
    this.enumValueFlags = 0;
    this.hasReportedStatementInAmbientContext = false;
    this.declarationRequiresScopeChange = 0;
    this.typeChecked = false;
    this.deferredNodes = undefined;
    this.switchTypes = undefined;
    this.switchWitnesses = undefined;
    this.switchWitnessesValid = false;
    this.exhaustiveState = 0;
    this.decoratorSignature = undefined;
    this.containsArgumentsReference = 0;
    this.mentionsArguments = 0;
  }
}
