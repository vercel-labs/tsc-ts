// Members of types: resolving properties, signatures and index infos of object, union and
// intersection types; apparent types, reduced types and base constraints.
import type { Node } from './ast.js';
import { getCombinedModifierFlags, getDeclarationOfKind } from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { ModifierFlags, getSymbol, MappedTypeNode, getName } from './ast.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  CompositeSignature,
  ElementFlags,
  IndexInfo,
  type IndexType,
  type IndexedAccessType,
  type InterfaceType,
  type IntersectionType,
  type MappedType,
  MemberNames,
  ObjectFlags,
  type ObjectType,
  type Signature,
  SignatureFlags,
  SignatureKind,
  type StringMappingType,
  type StructuredType,
  type TemplateLiteralType,
  Ternary,
  type Type,
  TypeFlags,
  type TypeMapper,
  type TypeParameter,
  type TypeReference,
  type UnionOrIntersectionType,
  unionOrIntersectionMembers,
  type UnionType,
  emptyIndexInfos,
  emptySignatures,
  emptySymbols,
  emptyTypes,
  newThisArgumentTypeMapper,
  newTypeMapper,
  prependTypeMapping,
  LiteralType,
  PendingMembers,
  getMappedType,
} from './checker-types.js';
import {
  UnionReduction,
  createArrayTypeEx,
  createTupleTypeEx,
  createTypeReference,
  everyType,
  getElementTypes,
  getIntersectionType,
  getStringLiteralType,
  getTemplateLiteralType,
  getTypeArguments,
  getUnionOrIntersectionType,
  getUnionType,
  getUnionTypeEx,
  isArrayOrTupleType,
  isErrorType,
  isGenericTupleType,
  isLiteralType,
  isPatternLiteralType,
  isReadonlyArrayType,
  isTupleType,
  mapType,
  setStructuredTypeMembers,
  someType,
  tupleTargetOf,
  typesOf,
} from './checker-type-factory.js';
import { getRestTypeOfTupleType, mappedTypeTarget } from './checker-type-operators.js';
import { isAmbientModule } from './ast-utilities.js';
import {
  getExportsOfSymbol,
  getLateBoundSymbol,
  getMembersOfSymbol,
  getMergedSymbol,
  getNamedMembers,
  getSymbolOfDeclaration,
  isReservedMemberName,
  popTypeResolution,
  pushTypeResolution,
  symbolIsValue,
  TypeSystemPropertyName,
} from './checker-symbols.js';
import {
  getBaseConstructorTypeOfClass,
  getBaseTypes,
  getConstraintDeclaration,
  getConstraintFromTypeParameter,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getLocalTypeParametersOfClassOrInterfaceOrTypeAlias,
  isMixinConstructorType,
} from './checker-declared-types.js';
import { getTypeOfSymbol, getWriteTypeOfSymbol, isReadonlySymbol } from './checker-symbol-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  instantiateIndexInfos,
  instantiateSignatures,
  instantiateSymbol,
  instantiateType,
  keepsSymbolUnderInstantiation,
  newInstantiatedSymbol,
  instantiateTypes,
} from './instantiation.js';
import {
  compareProperties,
  compareSignaturesIdentical,
  ComparerKind,
  compareTypesIdentical,
  getRecursionIdentity,
  isTypeAssignableTo,
  type RecursionId,
} from './relations.js';
import { isUnmatchedTemplateLiteralKey } from './checker-inference.js';
import { typeToString } from './type-printer.js';
import {
  cloneSignature,
  createSignatureInstantiation,
  getDefaultConstructSignatures,
  getIndexInfosOfIndexSymbol,
  getMinArgumentCount,
  getParameterCount,
  getParameterNameAtPosition,
  getReturnTypeOfSignature,
  getSignaturesOfSymbol,
  getTypeAtPosition,
  hasEffectiveRestParameter,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import {
  getConstraintFromConditionalType,
  getHomomorphicTypeVariable,
  getIndexForMappedType,
  getIndexedAccessTypeOrUndefined,
  getModifiersTypeFromMappedType,
  getNameTypeFromMappedType,
  getSimplifiedType,
  getStringMappingType,
  getSubstitutionIntersection,
  isGenericMappedType,
  isMappedTypeGenericIndexedAccess,
  isMappedTypeWithKeyofConstraintDeclaration,
  resolveMappedTypeMembers,
  resolveReverseMappedTypeMembers,
  substituteIndexedMappedType,
} from './checker-type-operators.js';
import { getGlobalBigIntType, getGlobalESSymbolType } from './checker-globals.js';
import { isLateBoundName, isNumericLiteralName } from './checker-utilities.js';
import { lazyObjectFlags, sideOf, sideOfIfAny } from './side-state.js';
import {
  CheckFlags,
  copyDeclarations,
  declarationCount,
  getDeclarations,
  getSymbolId,
  InternalSymbolName,
  setDeclarations,
  type Symbol,
  SymbolFlags,
  type SymbolTable,
} from './symbol.js';

// ---- Resolution

/**
 * `t` with its members resolved. The test is small enough to inline into callers, so a resolved
 * type (almost every call) costs no call; the resolution itself is out of line.
 */
export function resolveStructuredTypeMembers(c: Checker, t: Type): StructuredType {
  if ((t.objectFlags & ObjectFlags.MembersResolved) !== 0) return t as StructuredType;
  const resolved = membersHolder(c, t);
  if ((resolved.objectFlags & ObjectFlags.MembersResolved) === 0) resolveMembersOfType(c, t);
  return resolved;
}

/**
 * The object that holds the resolved members of `t`: `t` itself, or for a type with side state
 * (`ObjectFlags.SideState`) the checker's holder of its state (`sideOf`). Resolving the members of
 * `t` writes them there; `t` keeps its identity and is never written.
 */
export function membersHolder(c: Checker, t: Type): StructuredType {
  const side = sideOf(c, t);
  if ((side.flags & TypeFlags.UnionOrIntersection) !== 0)
    return unionOrIntersectionMembers(side as UnionOrIntersectionType);
  return side as StructuredType;
}

/** The `objectFlags` of `t` that resolving its members sets (MembersResolved). */
export function memberResolutionFlags(c: Checker, t: Type): ObjectFlags {
  if ((t.flags & TypeFlags.UnionOrIntersection) === 0) return lazyObjectFlags(c, t);
  const side = sideOfIfAny(c, t) as UnionOrIntersectionType | undefined;
  const members = side !== undefined ? side.membersOf : undefined;
  return members !== undefined ? members.objectFlags : ObjectFlags.None;
}

function resolveMembersOfType(c: Checker, t: Type): void {
  if ((t.flags & TypeFlags.Object) !== 0) {
    const objectFlags = t.objectFlags;
    if ((objectFlags & ObjectFlags.Reference) !== 0) resolveTypeReferenceMembers(c, t as TypeReference);
    else if ((objectFlags & ObjectFlags.ClassOrInterface) !== 0)
      resolveObjectTypeMembers(c, membersHolder(c, t), t as InterfaceType, emptyTypes, emptyTypes, undefined);
    else if ((objectFlags & ObjectFlags.ReverseMapped) !== 0) resolveReverseMappedTypeMembers(c, t);
    else if ((objectFlags & ObjectFlags.Anonymous) !== 0) resolveAnonymousTypeMembers(c, t as ObjectType);
    else if ((objectFlags & ObjectFlags.Mapped) !== 0) resolveMappedTypeMembers(c, t as MappedType);
  } else if ((t.flags & TypeFlags.Union) !== 0) resolveUnionTypeMembers(c, t as UnionType);
  else if ((t.flags & TypeFlags.Intersection) !== 0) resolveIntersectionTypeMembers(c, t as IntersectionType);
}

function resolveTypeReferenceMembers(c: Checker, t: TypeReference): void {
  const source = t.target as InterfaceType;
  const typeParameters = source.allTypeParameters;
  const typeArguments = getTypeArguments(c, t);
  // With one type argument fewer than parameters, the reference itself is the `this` type argument.
  const thisArgument = typeArguments.length === typeParameters.length - 1 ? (t as Type) : undefined;
  resolveObjectTypeMembers(c, membersHolder(c, t), source, typeParameters, typeArguments, thisArgument);
}

/** Whether `b`, followed by `last` where given, is the list `a`. */
function sameTypes(a: readonly Type[], b: readonly Type[], last: Type | undefined): boolean {
  const count = b.length;
  if (a.length !== (last !== undefined ? count + 1 : count)) return false;
  for (let i = 0; i < count; i++) if (a[i]! !== b[i]!) return false;
  return last === undefined || a[count]! === last;
}

/**
 * Resolves the members of an instantiation of `source` into `t`, the holder of its members: with
 * `typeArguments` for its type parameters, followed by `thisArgument` where given.
 */
function resolveObjectTypeMembers(
  c: Checker,
  t: StructuredType,
  source: InterfaceType,
  typeParameters: Type[],
  typeArguments: Type[],
  thisArgument: Type | undefined,
): void {
  const declared = resolveDeclaredMembers(c, source);
  let mapper: TypeMapper | undefined;
  let members: SymbolTable | undefined;
  let callSignatures: Signature[];
  let constructSignatures: Signature[];
  let indexInfos: IndexInfo[];
  let instantiated = false;
  // The member symbols of an instantiation are instantiated on demand (PendingInstantiatedMembers).
  let pending: PendingInstantiatedMembers | undefined;
  if (sameTypes(typeParameters, typeArguments, thisArgument)) {
    members = declared.declaredMembers;
    callSignatures = declared.declaredCallSignatures;
    constructSignatures = declared.declaredConstructSignatures;
    indexInfos = declared.declaredIndexInfos;
  } else {
    instantiated = true;
    mapper =
      thisArgument !== undefined
        ? newThisArgumentTypeMapper(typeParameters, typeArguments, thisArgument)
        : newTypeMapper(typeParameters, typeArguments);
    pending = pendingInstantiatedTable(c, source, mapper);
    members = pending === undefined ? instantiateSymbolTable(c, declared.declaredMembers, mapper) : undefined;
    callSignatures = instantiateSignatures(c, declared.declaredCallSignatures, mapper);
    constructSignatures = instantiateSignatures(c, declared.declaredConstructSignatures, mapper);
    indexInfos = instantiateIndexInfos(c, declared.declaredIndexInfos, mapper);
  }
  const baseTypes = getBaseTypes(c, source);
  // The last type argument, the `this` type argument where the reference has one.
  const lastArgument =
    thisArgument ?? (typeArguments.length !== 0 ? typeArguments[typeArguments.length - 1]! : undefined);
  if (pending !== undefined) {
    resolvePendingObjectTypeMembers(
      c,
      t,
      pending,
      baseTypes,
      mapper!,
      lastArgument,
      callSignatures,
      constructSignatures,
      indexInfos,
    );
    return;
  }
  if (baseTypes.length !== 0) {
    members = !instantiated || members === undefined ? new Map(members ?? []) : members;
    // The members are set once the bases are added: a recursive request for them resolves them again.
    for (const baseType of baseTypes) {
      const instantiatedBaseType =
        lastArgument !== undefined
          ? getTypeWithThisArgument(c, instantiateType(c, baseType, mapper), lastArgument, false)
          : baseType;
      addInheritedMembers(members, getPropertiesOfType(c, instantiatedBaseType));
      // A base without signatures adds none: no copy of the list then.
      const baseCallSignatures = getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Call);
      if (baseCallSignatures.length !== 0) callSignatures = callSignatures.concat(baseCallSignatures);
      const baseConstructSignatures = getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Construct);
      if (baseConstructSignatures.length !== 0)
        constructSignatures = constructSignatures.concat(baseConstructSignatures);
      const inherited =
        instantiatedBaseType !== c.anyType ? getIndexInfosOfType(c, instantiatedBaseType) : [c.anyBaseTypeIndexInfo];
      const added: IndexInfo[] = [];
      for (const info of inherited) if (findIndexInfo(indexInfos, info.keyType) === undefined) added.push(info);
      if (added.length !== 0) indexInfos = indexInfos.concat(added);
    }
  }
  setStructuredTypeMembers(c, t, members, callSignatures, constructSignatures, indexInfos);
}

// ---- Lazily instantiated members
//
// tsgo instantiates every member symbol of a type reference or an anonymous type instantiation when
// it resolves the type's members, and copies the inherited ones into its members table; most of those
// symbols are never used. Here the type gets a PendingInstantiatedMembers instead, which instantiates
// a member when it is looked up by name and builds the table that tsgo would have built when
// `members` or `properties` is read. Everything that can create types (signatures, index infos,
// base types and their members) is still resolved eagerly and in tsgo's order, so type identities and
// ids are unchanged. Member symbols come out identical too: whether `instantiateSymbol` keeps a
// symbol depends on whether its type is resolved yet, so that decision is recorded at resolution.
//
// Most reads are of `properties`; the table serves lookups by name. Where every member of the table
// is a property, materializing keeps only the properties, and lookups by name find a property by
// the position of its name in a `MemberNames` that instantiations with the same names share.
// Reading `members` builds the table.

// Two bits per member, in table order: whether tsgo puts it in the instantiated table, and whether
// `instantiateSymbol` keeps the symbol itself.
const enum MemberState {
  Skipped = 0,
  Instantiated = 1,
  Kept = 3,
}

const noBaseTypes: (StructuredType | undefined)[] = [];
const noBaseProperties: (Symbol[] | undefined)[] = [];

export class PendingInstantiatedMembers extends PendingMembers {
  readonly c: Checker;
  /** References: the declared members of the class or interface, by name. */
  readonly sourceTable: SymbolTable | undefined;
  /** Anonymous type instantiations: the properties of the target, in order. */
  readonly sourceList: Symbol[] | undefined;
  readonly mapper: TypeMapper;
  /** MemberState of each member of the source, in order, 16 to a word. */
  readonly states: number[];
  /** Position of each member of the source by name (shared by all instantiations of the source). */
  readonly positions: Map<string, number>;
  /**
   * What a reference inherits, per base type as far as resolution has come (`baseCount` bases): a
   * base whose own pending table is complete (its properties are read on demand), or else the base's
   * properties as read when tsgo reads them. Most types have one base: the first is kept in
   * `firstBase` or `firstBaseProperties`, the others in `otherBases` or `otherBaseProperties`.
   */
  baseCount: number;
  firstBase: StructuredType | undefined;
  firstBaseProperties: Symbol[] | undefined;
  otherBases: (StructuredType | undefined)[];
  otherBaseProperties: (Symbol[] | undefined)[];
  /** Whether the type has base types (tsgo copies the instantiated table into a new one then). */
  hasBases: boolean;
  /** While the base types are resolved: `properties` holds the own members only, as in tsgo. */
  resolving: boolean;
  /** Members instantiated by name lookups so far. */
  instantiated: Map<string, Symbol> | undefined;
  /** References: the holder of the declared members of the class or interface. */
  owner: InterfaceType | undefined;
  /** Whether the instantiated table has an own member, and one that isn't optional. */
  readonly hasOwnMembers: boolean;
  readonly hasRequiredOwnMembers: boolean;

  constructor(
    c: Checker,
    sourceTable: SymbolTable | undefined,
    sourceList: Symbol[] | undefined,
    mapper: TypeMapper,
    states: number[],
    positions: Map<string, number>,
    hasOwnMembers: boolean,
    hasRequiredOwnMembers: boolean,
  ) {
    super();
    this.hasOwnMembers = hasOwnMembers;
    this.hasRequiredOwnMembers = hasRequiredOwnMembers;
    this.c = c;
    this.sourceTable = sourceTable;
    this.sourceList = sourceList;
    this.mapper = mapper;
    this.states = states;
    this.positions = positions;
    // Most instantiations have no base types, or one: the lists are created by the second one.
    this.baseCount = 0;
    this.firstBase = undefined;
    this.firstBaseProperties = undefined;
    this.otherBases = noBaseTypes;
    this.otherBaseProperties = noBaseProperties;
    this.hasBases = false;
    this.resolving = false;
    this.instantiated = undefined;
    this.owner = undefined;
  }

  /** Records the next base: `base` where its pending table is complete, else its `properties`. */
  addBase(base: StructuredType | undefined, properties: Symbol[] | undefined): void {
    if (this.baseCount === 0) {
      this.firstBase = base;
      this.firstBaseProperties = properties;
    } else {
      if (this.otherBases === noBaseTypes) {
        this.otherBases = [];
        this.otherBaseProperties = [];
      }
      this.otherBases.push(base);
      this.otherBaseProperties.push(properties);
    }
    this.baseCount++;
  }

  /** The base at `index` where its pending table is complete (`addBase`), else undefined. */
  private baseAt(index: number): StructuredType | undefined {
    return index === 0 ? this.firstBase : this.otherBases[index - 1];
  }

  /** The properties the base at `index` adds. */
  private inheritedProperties(index: number): Symbol[] {
    const base = this.baseAt(index);
    if (base !== undefined) return base.properties;
    return index === 0 ? this.firstBaseProperties! : this.otherBaseProperties[index - 1]!;
  }

  state(position: number): MemberState {
    return ((this.states[position >> 4]! >>> ((position & 15) * 2)) & 3) as MemberState;
  }

  /** The member symbol at `position` of the source, instantiated as tsgo would have. */
  memberAt(position: number, source: Symbol): Symbol {
    const name = source.name;
    const instantiated = this.instantiated;
    if (instantiated !== undefined) {
      const known = instantiated.get(name);
      if (known !== undefined) return known;
    }
    return this.state(position) === MemberState.Kept ? source : newInstantiatedSymbol(this.c, source, this.mapper);
  }

  /** The own member `name` as in tsgo's instantiated table, or undefined. */
  ownMember(name: string): Symbol | undefined {
    const position = this.positions.get(name);
    if (position === undefined || this.state(position) === MemberState.Skipped) return undefined;
    let instantiated = this.instantiated;
    if (instantiated !== undefined) {
      const known = instantiated.get(name);
      if (known !== undefined) return known;
    }
    const source = this.sourceTable !== undefined ? this.sourceTable.get(name)! : this.sourceList![position]!;
    const symbol =
      this.state(position) === MemberState.Kept ? source : newInstantiatedSymbol(this.c, source, this.mapper);
    if (instantiated === undefined) this.instantiated = instantiated = new Map<string, Symbol>();
    instantiated.set(name, symbol);
    return symbol;
  }

  get(name: string): Symbol | undefined {
    let existing = this.ownMember(name);
    // Own members have value flags (pendingInstantiatedTable), so no base replaces them.
    const count = this.baseCount;
    if (existing !== undefined || count === 0) return existing;
    // addInheritedMembers: a base property replaces a missing or non-value member.
    for (let i = 0; i < count; i++) {
      if (existing !== undefined && (existing.flags & SymbolFlags.Value) !== 0) break;
      const base = this.baseAt(i);
      const inherited =
        base !== undefined
          ? getInheritedProperty(this.c, base, name)
          : findProperty(this.c, this.inheritedProperties(i), name);
      if (inherited !== undefined && !isStaticPrivateIdentifierProperty(inherited)) existing = inherited;
    }
    return existing;
  }

  /** The table of own members, as instantiateSymbolTable or createInstantiatedSymbolTable builds it. */
  ownTable(): SymbolTable {
    const table = new Map<string, Symbol>();
    const list = this.sourceList;
    if (list !== undefined) {
      for (let i = 0; i < list.length; i++) {
        const source = list[i]!;
        // Of two properties with one name, the table keeps the last (and the lookups use it).
        table.set(
          source.name,
          this.positions.get(source.name) === i
            ? this.memberAt(i, source)
            : this.state(i) === MemberState.Kept
              ? source
              : newInstantiatedSymbol(this.c, source, this.mapper),
        );
      }
      return table;
    }
    let i = 0;
    for (const [id, source] of this.sourceTable!) {
      if (this.state(i) !== MemberState.Skipped) table.set(id, this.memberAt(i, source));
      i++;
    }
    return table;
  }

  materialize(t: StructuredType): void {
    const c = this.c;
    t.pendingMembers = undefined;
    const members = this.ownTable();
    this.instantiated = undefined;
    if (!this.hasBases) {
      t.membersValue = members;
      t.propertiesValue = getNamedMembers(c, members, t.symbol);
      this.keepTableOnDemand(t, members);
      return;
    }
    // While the bases are resolved, tsgo's `properties` holds the own members and its table
    // grows by each base as it is resolved; the rest of resolution continues eagerly.
    const resolving = this.resolving;
    const ownProperties = resolving ? getNamedMembers(c, members, t.symbol) : undefined;
    for (let i = 0; i < this.baseCount; i++) addInheritedMembers(members, this.inheritedProperties(i));
    t.membersValue = members;
    t.propertiesValue = ownProperties ?? getNamedMembers(c, members, t.symbol);
    // Resolving the bases goes on with the table (resolvePendingObjectTypeMembers).
    if (!resolving) this.keepTableOnDemand(t, members);
  }

  /**
   * After `materialize`: drops `members`, the table, where every member of it is a property. The
   * table's names are then the names of the properties, so lookups by name read the properties by
   * the positions of their names, and `materializeTable` builds the table again from them. The
   * names come from the last instantiation of the same source, where they are the same.
   */
  private keepTableOnDemand(t: StructuredType, members: SymbolTable): void {
    const properties = t.propertiesValue;
    if (properties.length !== members.size) return;
    const owner = this.owner;
    const last = owner !== undefined ? owner.lastMemberNames : this.c.memberNamesOfLists.get(this.sourceList!);
    let names = last !== undefined && hasMemberNames(last, properties, members) ? last : undefined;
    if (names === undefined) {
      names = memberNamesOf(properties, members);
      if (owner !== undefined) owner.lastMemberNames = names;
      else this.c.memberNamesOfLists.set(this.sourceList!, names);
    }
    t.membersValue = undefined;
    t.pendingMembers = new PropertyMembers(properties, names);
  }

  materializeTable(t: StructuredType): void {
    this.materialize(t);
    const pending = t.pendingMembers;
    if (pending !== undefined) pending.materializeTable(t);
  }
}

/**
 * The members of a type whose members table holds only its properties, in the order of the
 * properties or of `names.tableOrder`: lookups by name read the properties, by the positions of
 * their names in `names` (`MemberNames`), or by comparing the names of a few properties
 * (`scannedPropertiesLimit`) without `names`. Reading `members` builds the table.
 */
export class PropertyMembers extends PendingMembers {
  readonly names: MemberNames | undefined;

  constructor(properties: Symbol[], names: MemberNames | undefined) {
    super();
    this.materializedProperties = properties;
    this.names = names;
  }

  materialize(_t: StructuredType): void {}

  materializeTable(t: StructuredType): void {
    const properties = this.materializedProperties!;
    const names = this.names;
    const members = new Map<string, Symbol>();
    if (names !== undefined) for (const i of names.tableOrder) members.set(properties[i]!.name, properties[i]!);
    else for (const p of properties) members.set(p.name, p);
    t.pendingMembers = undefined;
    t.membersValue = members;
  }

  get(name: string): Symbol | undefined {
    const properties = this.materializedProperties!;
    const names = this.names;
    if (names === undefined) {
      for (const p of properties) if (p.name === name) return p;
      return undefined;
    }
    const position = names.positions.get(name);
    return position !== undefined ? properties[position] : undefined;
  }
}

/** The most properties of a table that `keepPropertiesOnly` drops: a lookup compares that many names at most. */
const scannedPropertiesLimit = 8;

/** The most properties of an object literal's table that `keepPropertiesOnly` drops: literals are looked up often. */
export const scannedLiteralPropertiesLimit = 4;

/**
 * After `setStructuredTypeMembers(c, t, members, ...)`: drops `members` where it holds only the
 * type's properties, at most `limit` of them (`PropertyMembers`).
 */
export function keepPropertiesOnly(
  c: Checker,
  t: StructuredType,
  members: SymbolTable,
  limit: number = scannedPropertiesLimit,
): void {
  const resolved = membersHolder(c, t);
  const properties = resolved.propertiesValue;
  if (members.size === 0 || members.size > limit || properties.length !== members.size) return;
  resolved.membersValue = undefined;
  resolved.pendingMembers = new PropertyMembers(properties, undefined);
}

/** The names of `properties`, and the order of the names of `members`, a table with the same names. */
function memberNamesOf(properties: Symbol[], members: SymbolTable): MemberNames {
  const names: string[] = [];
  const positions = new Map<string, number>();
  for (let i = 0; i < properties.length; i++) {
    const name = properties[i]!.name;
    names.push(name);
    positions.set(name, i);
  }
  const tableOrder: number[] = [];
  for (const name of members.keys()) tableOrder.push(positions.get(name)!);
  return new MemberNames(names, positions, tableOrder);
}

/** Whether `properties` have the names of `names`, and `members` has them in its table order. */
function hasMemberNames(names: MemberNames, properties: Symbol[], members: SymbolTable): boolean {
  const list = names.names;
  if (list.length !== properties.length) return false;
  for (let i = 0; i < list.length; i++) if (properties[i]!.name !== list[i]) return false;
  const order = names.tableOrder;
  let k = 0;
  for (const name of members.keys()) if (list[order[k++]!] !== name) return false;
  return true;
}

/**
 * The pending table of `table` instantiated with `mapper`, or undefined where it isn't worth it or
 * tsgo's table wouldn't be keyed by symbol names. Records the decisions instantiateSymbolTable makes.
 */
function pendingInstantiatedTable(
  c: Checker,
  source: InterfaceType,
  mapper: TypeMapper,
): PendingInstantiatedMembers | undefined {
  const declared = sideOf(c, source);
  const table = declared.declaredMembers;
  if (table === undefined || table.size === 0) return undefined;
  const states: number[] = [];
  let word = 0;
  let i = 0;
  let hasOwnMembers = false;
  let hasRequiredOwnMembers = false;
  for (const [id, symbol] of table) {
    if (id !== symbol.name) return undefined;
    let state = MemberState.Skipped;
    if (isNamedMember(c, symbol, id)) {
      // A named member without a value flag (an alias) could be replaced by an inherited one; keep
      // such tables eager, so that an own member always stands.
      if ((symbol.flags & SymbolFlags.Value) === 0) return undefined;
      state = keepsSymbolUnderInstantiation(c, symbol, mapper) ? MemberState.Kept : MemberState.Instantiated;
      // Instantiated symbols have the flags of their source.
      hasOwnMembers = true;
      if ((symbol.flags & SymbolFlags.Optional) === 0) hasRequiredOwnMembers = true;
    }
    word |= state << ((i & 15) * 2);
    if ((i & 15) === 15) {
      states.push(word);
      word = 0;
    }
    i++;
  }
  if ((i & 15) !== 0) states.push(word);
  const pending = new PendingInstantiatedMembers(
    c,
    table,
    undefined,
    mapper,
    sharedStates(declared, states),
    declaredMemberPositions(declared, table),
    hasOwnMembers,
    hasRequiredOwnMembers,
  );
  pending.owner = declared;
  return pending;
}

/**
 * `states`, or the equal list the last instantiation of `source` used: most instantiations of a
 * source keep and instantiate the same members, and the lists are never changed.
 */
function sharedStates(source: InterfaceType, states: number[]): number[] {
  const last = source.lastMemberStates;
  if (last !== undefined && last.length === states.length) {
    let i = 0;
    while (i < states.length && last[i] === states[i]) i++;
    if (i === states.length) return last;
  }
  source.lastMemberStates = states;
  return states;
}

/** The pending table of the properties `list` instantiated with `mapper` (createInstantiatedSymbolTable). */
function pendingInstantiatedList(c: Checker, list: Symbol[], mapper: TypeMapper): PendingInstantiatedMembers {
  const states: number[] = [];
  let word = 0;
  let hasRequiredOwnMembers = false;
  for (let i = 0; i < list.length; i++) {
    const state = keepsSymbolUnderInstantiation(c, list[i]!, mapper) ? MemberState.Kept : MemberState.Instantiated;
    if ((list[i]!.flags & SymbolFlags.Optional) === 0) hasRequiredOwnMembers = true;
    word |= state << ((i & 15) * 2);
    if ((i & 15) === 15) {
      states.push(word);
      word = 0;
    }
  }
  if ((list.length & 15) !== 0) states.push(word);
  return new PendingInstantiatedMembers(
    c,
    undefined,
    list,
    mapper,
    states,
    listPositions(c, list),
    true,
    hasRequiredOwnMembers,
  );
}

/**
 * Positions of the declared members of a class or interface by name, shared by all its
 * instantiations; `source` is the holder of its declared members (`resolveDeclaredMembers`).
 */
function declaredMemberPositions(source: InterfaceType, table: SymbolTable): Map<string, number> {
  let positions = source.declaredMemberPositions;
  if (positions === undefined) {
    positions = new Map<string, number>();
    let i = 0;
    for (const id of table.keys()) positions.set(id, i++);
    source.declaredMemberPositions = positions;
  }
  return positions;
}

/** Positions by name in a target's properties, shared by its instantiations. The last of equal names wins. */
function listPositions(c: Checker, list: Symbol[]): Map<string, number> {
  let positions = c.memberPositionsInLists.get(list);
  if (positions === undefined) {
    positions = new Map<string, number>();
    let i = 0;
    for (const symbol of list) positions.set(symbol.name, i++);
    c.memberPositionsInLists.set(list, positions);
  }
  return positions;
}

/** The property `name` of a base whose pending table is complete, without building that table. */
function getInheritedProperty(c: Checker, base: StructuredType, name: string): Symbol | undefined {
  // getNamedMembers: properties are the value members whose names aren't reserved.
  if (isReservedMemberName(name)) return undefined;
  const symbol = getResolvedMember(base, name);
  return symbol !== undefined && symbolIsValue(c, symbol) ? symbol : undefined;
}

/** The symbol named `name` in a list of properties. Long lists are indexed once. */
function findProperty(c: Checker, properties: Symbol[], name: string): Symbol | undefined {
  if (properties.length < 16) {
    for (const p of properties) if (p.name === name) return p;
    return undefined;
  }
  let byName = c.propertiesByName.get(properties);
  if (byName === undefined) {
    byName = new Map<string, Symbol>();
    for (const p of properties) if (!byName.has(p.name)) byName.set(p.name, p);
    c.propertiesByName.set(properties, byName);
  }
  return byName.get(name);
}

/** `t.members?.get(name)` of a type whose members are resolved, without building a pending table. */
export function getResolvedMember(t: StructuredType, name: string): Symbol | undefined {
  const pending = t.pendingMembers;
  if (pending !== undefined) return pending.get(name);
  return t.membersValue?.get(name);
}

/** `t.properties.length !== 0` of a type whose members are resolved, without building a pending table. */
export function hasResolvedProperties(t: StructuredType): boolean {
  const pending = t.pendingMembers;
  // Own members are all properties; with none, what the bases add decides.
  if (pending !== undefined && pending.materializedProperties === undefined) {
    const instantiated = pending as PendingInstantiatedMembers;
    if (!instantiated.resolving && instantiated.hasOwnMembers) return true;
  }
  return t.properties.length !== 0;
}

/** `getPropertiesOfType(c, t).length !== 0`, without building a pending table. */
export function hasPropertiesOfType(c: Checker, t: Type): boolean {
  if (!isOwnReducedApparentType(t)) t = getReducedApparentTypeWorker(c, t);
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0)
    return getPropertiesOfUnionOrIntersectionType(c, t as UnionOrIntersectionType).length !== 0;
  return (t.flags & TypeFlags.Object) !== 0 && hasResolvedProperties(resolveStructuredTypeMembers(c, t));
}

/**
 * `t.properties.every(p => p is optional)` of a type whose members are resolved and that has
 * properties, without building a pending table where its own members decide.
 */
export function resolvedPropertiesAreOptional(t: StructuredType): boolean {
  const pending = t.pendingMembers;
  if (pending !== undefined && pending.materializedProperties === undefined) {
    const instantiated = pending as PendingInstantiatedMembers;
    if (!instantiated.resolving) {
      // A required own member is in the table whatever the bases add.
      if (instantiated.hasRequiredOwnMembers) return false;
      if (!instantiated.hasBases) return true;
    }
  }
  for (const p of t.properties) if ((p.flags & SymbolFlags.Optional) === 0) return false;
  return true;
}

/** resolveObjectTypeMembers for an instantiation whose member symbols are instantiated on demand. */
function resolvePendingObjectTypeMembers(
  c: Checker,
  t: StructuredType,
  pending: PendingInstantiatedMembers,
  baseTypes: Type[],
  mapper: TypeMapper,
  thisArgument: Type | undefined,
  callSignatures: Signature[],
  constructSignatures: Signature[],
  indexInfos: IndexInfo[],
): void {
  if (baseTypes.length === 0) {
    setPendingStructuredTypeMembers(c, t, pending, callSignatures, constructSignatures, indexInfos);
    return;
  }
  // The members are set once the bases are added: a recursive request for them resolves them again.
  pending.hasBases = true;
  pending.resolving = true;
  for (const baseType of baseTypes) {
    const instantiatedBaseType =
      thisArgument !== undefined
        ? getTypeWithThisArgument(c, instantiateType(c, baseType, mapper), thisArgument, false)
        : baseType;
    // getPropertiesOfType, except that a base whose pending table is complete keeps it pending:
    // resolving its members has created every type already, and its table won't change. The
    // reduced apparent type of an object type is itself except for mapped types, whose apparent
    // type getPropertiesOfType computes first.
    let lazyBase: StructuredType | undefined;
    if (
      (instantiatedBaseType.flags & TypeFlags.Object) !== 0 &&
      (instantiatedBaseType.objectFlags & ObjectFlags.Mapped) === 0
    ) {
      const resolved = resolveStructuredTypeMembers(c, instantiatedBaseType);
      const basePending = resolved.pendingMembers;
      if (
        basePending !== undefined &&
        basePending.materializedProperties === undefined &&
        !(basePending as PendingInstantiatedMembers).resolving
      )
        lazyBase = resolved;
    }
    const baseProperties = lazyBase === undefined ? getPropertiesOfType(c, instantiatedBaseType) : undefined;
    pending.addBase(lazyBase, baseProperties);
    const baseCallSignatures = getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Call);
    if (baseCallSignatures.length !== 0) callSignatures = callSignatures.concat(baseCallSignatures);
    const baseConstructSignatures = getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Construct);
    if (baseConstructSignatures.length !== 0) constructSignatures = constructSignatures.concat(baseConstructSignatures);
    const inherited =
      instantiatedBaseType !== c.anyType ? getIndexInfosOfType(c, instantiatedBaseType) : [c.anyBaseTypeIndexInfo];
    const added: IndexInfo[] = [];
    for (const info of inherited) if (findIndexInfo(indexInfos, info.keyType) === undefined) added.push(info);
    if (added.length !== 0) indexInfos = indexInfos.concat(added);
  }
  pending.resolving = false;
  setPendingStructuredTypeMembers(c, t, pending, callSignatures, constructSignatures, indexInfos);
}

function setPendingStructuredTypeMembers(
  c: Checker,
  type: StructuredType,
  pending: PendingInstantiatedMembers,
  callSignatures: Signature[],
  constructSignatures: Signature[],
  indexInfos: IndexInfo[],
): void {
  const t = membersHolder(c, type);
  t.objectFlags |= ObjectFlags.MembersResolved;
  t.membersValue = undefined;
  t.propertiesValue = emptySymbols;
  t.pendingMembers = pending;
  t.callSignatures = callSignatures;
  t.constructSignatures = constructSignatures;
  t.indexInfos = indexInfos;
}

export function findIndexInfo(indexInfos: readonly IndexInfo[], keyType: Type): IndexInfo | undefined {
  for (const info of indexInfos) if (info.keyType === keyType) return info;
  return undefined;
}

/** Resolves the declared members of `t`; returns the object that holds them (`sideOf`). */
export function resolveDeclaredMembers(c: Checker, t: InterfaceType): InterfaceType {
  const declared = sideOf(c, t);
  if (!declared.declaredMembersResolved) {
    const members = getMembersOfSymbol(c, t.symbol!);
    declared.declaredMembersResolved = true;
    declared.declaredMembers = members;
    // Most interfaces declare neither, and share one empty list.
    const call = members.get(InternalSymbolName.Call);
    const construct = members.get(InternalSymbolName.New);
    declared.declaredCallSignatures = call !== undefined ? getSignaturesOfSymbol(c, call) : emptySignatures;
    declared.declaredConstructSignatures =
      construct !== undefined ? getSignaturesOfSymbol(c, construct) : emptySignatures;
    declared.declaredIndexInfos = getIndexInfosOfSymbol(c, t.symbol!);
  }
  return declared;
}

export function getIndexSymbol(c: Checker, symbol: Symbol): Symbol | undefined {
  return getMembersOfSymbol(c, symbol).get(InternalSymbolName.Index);
}

export function getIndexInfosOfSymbol(c: Checker, symbol: Symbol): IndexInfo[] {
  const indexSymbol = getIndexSymbol(c, symbol);
  if (indexSymbol === undefined) return emptyIndexInfos;
  return getIndexInfosOfIndexSymbol(c, indexSymbol, [...getMembersOfSymbol(c, symbol).values()]);
}

function isStaticPrivateIdentifierProperty(symbol: Symbol): boolean {
  const d = symbol.valueDeclaration;
  if (d === undefined) return false;
  const name = getName(d);
  return (
    name !== undefined &&
    name.kind === SyntaxKind.PrivateIdentifier &&
    (getCombinedModifierFlags(d) & ModifierFlags.Static) !== 0
  );
}

export function addInheritedMembers(symbols: SymbolTable, baseSymbols: readonly Symbol[]): void {
  for (const base of baseSymbols) {
    if (isStaticPrivateIdentifierProperty(base)) continue;
    const existing = symbols.get(base.name);
    if (existing === undefined || (existing.flags & SymbolFlags.Value) === 0) symbols.set(base.name, base);
  }
}

export function instantiateSymbolTable(
  c: Checker,
  symbols: SymbolTable | undefined,
  mapper: TypeMapper,
): SymbolTable | undefined {
  if (symbols === undefined || symbols.size === 0) return undefined;
  const result = new Map<string, Symbol>();
  for (const [id, symbol] of symbols)
    if (isNamedMember(c, symbol, id)) result.set(id, instantiateSymbol(c, symbol, mapper));
  return result;
}

export function isNamedMember(c: Checker, symbol: Symbol, id: string): boolean {
  if (id.length >= 2 && id.charCodeAt(0) === 0xfffe) {
    const second = id.charCodeAt(1);
    if (second !== 0x40 && second !== 0x23) return false;
  }
  return symbolIsValue(c, symbol);
}

function createInstantiatedSymbolTable(
  c: Checker,
  symbols: readonly Symbol[],
  mapper: TypeMapper | undefined,
): SymbolTable | undefined {
  if (symbols.length === 0) return undefined;
  const result = new Map<string, Symbol>();
  for (const symbol of symbols)
    result.set(symbol.name, mapper !== undefined ? instantiateSymbol(c, symbol, mapper) : symbol);
  return result;
}

function resolveAnonymousTypeMembers(c: Checker, t: ObjectType): void {
  const resolved = membersHolder(c, t);
  if (t.target !== undefined) {
    setStructuredTypeMembers(c, t, undefined, emptySignatures, emptySignatures, emptyIndexInfos);
    const target = t.target;
    // createInstantiatedSymbolTable, on demand (PendingInstantiatedMembers).
    const targetProperties = getPropertiesOfObjectType(c, target);
    const pending =
      targetProperties.length !== 0 && t.mapper !== undefined
        ? pendingInstantiatedList(c, targetProperties, t.mapper)
        : undefined;
    const members = pending === undefined ? createInstantiatedSymbolTable(c, targetProperties, t.mapper) : undefined;
    const callSignatures = instantiateSignatures(c, getSignaturesOfType(c, target, SignatureKind.Call), t.mapper!);
    const constructSignatures = instantiateSignatures(
      c,
      getSignaturesOfType(c, target, SignatureKind.Construct),
      t.mapper!,
    );
    const indexInfos = instantiateIndexInfos(c, getIndexInfosOfType(c, target), t.mapper!);
    if (pending !== undefined)
      setPendingStructuredTypeMembers(c, t, pending, callSignatures, constructSignatures, indexInfos);
    else setStructuredTypeMembers(c, t, members, callSignatures, constructSignatures, indexInfos);
    return;
  }
  const symbol = getMergedSymbol(c, t.symbol!);
  if ((symbol.flags & SymbolFlags.TypeLiteral) !== 0) {
    setStructuredTypeMembers(c, t, undefined, emptySignatures, emptySignatures, emptyIndexInfos);
    const members = getMembersOfSymbol(c, symbol);
    const callSignatures = getSignaturesOfSymbol(c, members.get(InternalSymbolName.Call));
    const constructSignatures = getSignaturesOfSymbol(c, members.get(InternalSymbolName.New));
    const indexInfos = getIndexInfosOfSymbol(c, symbol);
    setStructuredTypeMembers(c, t, members, callSignatures, constructSignatures, indexInfos);
    return;
  }
  // Combinations of function, class, enum and module.
  let members = getExportsOfSymbol(c, symbol);
  if (symbol === c.globalThisSymbol) {
    const varsOnly = new Map<string, Symbol>();
    for (const p of members.values()) {
      if ((p.flags & SymbolFlags.BlockScoped) !== 0) continue;
      if ((p.flags & SymbolFlags.ValueModule) !== 0 && isOnlyAmbientModuleDeclarations(getDeclarations(p))) continue;
      varsOnly.set(p.name, p);
    }
    members = varsOnly;
  }
  let baseConstructorIndexInfo: IndexInfo | undefined;
  setStructuredTypeMembers(c, t, members, emptySignatures, emptySignatures, emptyIndexInfos);
  if ((symbol.flags & SymbolFlags.Class) !== 0) {
    const classType = getDeclaredTypeOfClassOrInterface(c, symbol);
    const baseConstructorType = getBaseConstructorTypeOfClass(c, classType);
    if ((baseConstructorType.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.TypeVariable)) !== 0) {
      members = new Map(members);
      addInheritedMembers(members, getPropertiesOfType(c, baseConstructorType));
      setStructuredTypeMembers(c, t, members, emptySignatures, emptySignatures, emptyIndexInfos);
    } else if (baseConstructorType === c.anyType) baseConstructorIndexInfo = c.anyBaseTypeIndexInfo;
  }
  let indexInfos: IndexInfo[] = [];
  const indexSymbol = members.get(InternalSymbolName.Index);
  if (indexSymbol !== undefined) indexInfos = getIndexInfosOfIndexSymbol(c, indexSymbol, [...members.values()]);
  else {
    if (baseConstructorIndexInfo !== undefined) indexInfos.push(baseConstructorIndexInfo);
    if ((symbol.flags & SymbolFlags.Enum) !== 0) {
      let numberLike = (getDeclaredTypeOfSymbol(c, symbol).flags & TypeFlags.Enum) !== 0;
      if (!numberLike)
        for (const prop of resolved.properties)
          if ((getTypeOfSymbol(c, prop).flags & TypeFlags.NumberLike) !== 0) {
            numberLike = true;
            break;
          }
      if (numberLike) indexInfos.push(c.enumNumberIndexInfo);
    }
  }
  resolved.indexInfos = indexInfos.length === 0 ? emptyIndexInfos : indexInfos;
  // Members are resolved before signatures, which may use `typeof` on this type (#6072).
  if ((symbol.flags & (SymbolFlags.Function | SymbolFlags.Method)) !== 0)
    resolved.callSignatures = getSignaturesOfSymbol(c, symbol);
  if ((symbol.flags & SymbolFlags.Class) !== 0) {
    const classType = getDeclaredTypeOfClassOrInterface(c, symbol);
    let constructSignatures = getSignaturesOfSymbol(c, symbol.members?.get(InternalSymbolName.Constructor));
    if (constructSignatures.length === 0) constructSignatures = getDefaultConstructSignatures(c, classType);
    resolved.constructSignatures = constructSignatures;
  }
}

function isOnlyAmbientModuleDeclarations(declarations: readonly Node[]): boolean {
  if (declarations.length === 0) return false;
  for (const d of declarations) if (d.kind !== SyntaxKind.ModuleDeclaration || !isAmbientModule(d)) return false;
  return true;
}

function resolveUnionTypeMembers(c: Checker, t: UnionType): void {
  // Members and properties are empty for unions; getPropertiesOfType computes them.
  const callLists: Signature[][] = [];
  const constructLists: Signature[][] = [];
  for (const u of t.types) {
    callLists.push(u === c.globalFunctionType ? [c.unknownSignature] : getSignaturesOfType(c, u, SignatureKind.Call));
    constructLists.push(getSignaturesOfType(c, u, SignatureKind.Construct));
  }
  let callSignatures = getUnionSignatures(c, callLists);
  if (callSignatures.length === 0) callSignatures = getArrayMemberCallSignatures(c, t);
  const constructSignatures = getUnionSignatures(c, constructLists);
  const indexInfos = getUnionIndexInfos(c, t.types);
  setStructuredTypeMembers(c, t, undefined, callSignatures, constructSignatures, indexInfos);
}

function getArrayMemberCallSignatures(c: Checker, t: UnionType): Signature[] {
  // A union of instantiations of one Array or ReadonlyArray member: `(A[] | B[])["m"]` is `(A | B)[]["m"]`.
  let memberName = '';
  for (let i = 0; i < t.types.length; i++) {
    const u = t.types[i]!;
    if (
      (u.objectFlags & ObjectFlags.Instantiated) === 0 ||
      u.symbol === undefined ||
      u.symbol.parent === undefined ||
      !isArrayOrTupleSymbol(c, u.symbol.parent)
    )
      return emptySignatures;
    if (i === 0) memberName = u.symbol.name;
    else if (memberName !== u.symbol.name) return emptySignatures;
  }
  const arrayArg = mapType(c, t, (u) => {
    const generic = isReadonlyArraySymbol(c, u.symbol!.parent!) ? c.globalReadonlyArrayType : c.globalArrayType;
    return getMappedType((generic as InterfaceType).typeParameters()[0]!, (u as ObjectType).mapper!);
  });
  const arrayType = createArrayTypeEx(
    c,
    arrayArg,
    someType(t, (u) => isReadonlyArraySymbol(c, u.symbol!.parent!)),
  );
  const memberType = getTypeOfPropertyOfType(c, arrayType, memberName);
  return memberType !== undefined ? getSignaturesOfType(c, memberType, SignatureKind.Call) : emptySignatures;
}

function isArrayOrTupleSymbol(c: Checker, symbol: Symbol): boolean {
  if (c.globalArrayType.symbol === undefined || c.globalReadonlyArrayType.symbol === undefined) return false;
  return (
    sameReference(c, symbol, c.globalArrayType.symbol) || sameReference(c, symbol, c.globalReadonlyArrayType.symbol)
  );
}

function isReadonlyArraySymbol(c: Checker, symbol: Symbol): boolean {
  return c.globalReadonlyArrayType.symbol !== undefined && sameReference(c, symbol, c.globalReadonlyArrayType.symbol);
}

function sameReference(c: Checker, s1: Symbol, s2: Symbol): boolean {
  return getMergedSymbol(c, s1) === getMergedSymbol(c, s2);
}

/**
 * The signatures present in every constituent: generic ones must match exactly; others may have
 * extra optional parameters and differing return types, which are unioned.
 */
export function getUnionSignatures(c: Checker, signatureLists: Signature[][]): Signature[] {
  let result: Signature[] | undefined;
  let indexWithLengthOverOne = 0;
  let countLengthOverOne = 0;
  for (let i = 0; i < signatureLists.length; i++) {
    const list = signatureLists[i]!;
    if (list.length === 0) return emptySignatures;
    if (list.length > 1) {
      indexWithLengthOverOne = i;
      countLengthOverOne++;
    }
    for (const signature of list) {
      if (result !== undefined && findMatchingSignature(c, result, signature, false, false, true) !== undefined)
        continue;
      const unionSignatures = findMatchingSignatures(c, signatureLists, signature, i);
      if (unionSignatures === undefined) continue;
      let s = signature;
      if (unionSignatures.length > 1) {
        let thisParameter = signature.thisParameter;
        let firstThisParameter: Symbol | undefined;
        for (const sig of unionSignatures)
          if (sig.thisParameter !== undefined) {
            firstThisParameter = sig.thisParameter;
            break;
          }
        if (firstThisParameter !== undefined) {
          const thisTypes: Type[] = [];
          for (const sig of unionSignatures)
            if (sig.thisParameter !== undefined) thisTypes.push(getTypeOfSymbol(c, sig.thisParameter));
          thisParameter = createSymbolWithType(c, firstThisParameter, getIntersectionType(c, thisTypes));
        }
        s = createUnionSignature(c, signature, unionSignatures);
        s.thisParameter = thisParameter;
      }
      if (result === undefined) result = [];
      result.push(s);
    }
  }
  if ((result === undefined || result.length === 0) && countLengthOverOne <= 1) {
    // One constituent has overloads: try a single signature that handles all of them.
    const masterList = signatureLists[indexWithLengthOverOne]!;
    let results: Signature[] | undefined = masterList.slice();
    for (const signatures of signatureLists) {
      if (signatures === masterList) continue;
      const signature = signatures[0]!;
      if (signature.typeParameters.length !== 0 && hasNonIdenticalTypeParameters(c, results, signature)) {
        results = undefined;
        break;
      }
      const combined: Signature[] = [];
      for (const sig of results) combined.push(combineUnionOrIntersectionMemberSignatures(c, sig, signature, true));
      results = combined;
    }
    result = results;
  }
  return result ?? emptySignatures;
}

function findMatchingSignatures(
  c: Checker,
  signatureLists: Signature[][],
  signature: Signature,
  listIndex: number,
): Signature[] | undefined {
  if (signature.typeParameters.length !== 0) {
    // Generic signatures need exact matches in the other lists.
    if (listIndex > 0) return undefined;
    for (let i = 1; i < signatureLists.length; i++)
      if (findMatchingSignature(c, signatureLists[i]!, signature, false, false, false) === undefined) return undefined;
    return [signature];
  }
  const result: Signature[] = [];
  for (let i = 0; i < signatureLists.length; i++) {
    const match =
      i === listIndex
        ? signature
        : (findMatchingSignature(c, signatureLists[i]!, signature, false, false, true) ??
          findMatchingSignature(c, signatureLists[i]!, signature, true, false, true));
    if (match === undefined) return undefined;
    if (!result.includes(match)) result.push(match);
  }
  return result;
}

export function findMatchingSignature(
  c: Checker,
  signatureList: readonly Signature[],
  signature: Signature,
  partialMatch: boolean,
  ignoreThisTypes: boolean,
  ignoreReturnTypes: boolean,
): Signature | undefined {
  for (const s of signatureList)
    if (
      compareSignaturesIdentical(
        c,
        s,
        signature,
        partialMatch,
        ignoreThisTypes,
        ignoreReturnTypes,
        partialMatch ? ComparerKind.SubtypeOf : ComparerKind.Identical,
      ) !== Ternary.False
    )
      return s;
  return undefined;
}

function hasNonIdenticalTypeParameters(c: Checker, signatures: readonly Signature[], signature: Signature): boolean {
  for (const s of signatures)
    if (s.typeParameters.length !== 0 && !compareTypeParametersIdentical(c, signature.typeParameters, s.typeParameters))
      return true;
  return false;
}

export function compareTypeParametersIdentical(c: Checker, sourceParams: Type[], targetParams: Type[]): boolean {
  if (sourceParams.length !== targetParams.length) return false;
  const mapper = newTypeMapper(targetParams, sourceParams);
  for (let i = 0; i < sourceParams.length; i++) {
    const source = sourceParams[i]!;
    const target = targetParams[i]!;
    if (source === target) continue;
    // A type parameter matches another one with an identical (instantiated) constraint.
    const sourceConstraint = getConstraintFromTypeParameter(c, source) ?? c.unknownType;
    const targetConstraint = getConstraintFromTypeParameter(c, target);
    if (
      !compareTypesIdenticalBool(
        c,
        sourceConstraint,
        targetConstraint !== undefined ? instantiateType(c, targetConstraint, mapper) : c.unknownType,
      )
    )
      return false;
  }
  return true;
}

function compareTypesIdenticalBool(c: Checker, s: Type, t: Type): boolean {
  return compareTypesIdentical(c, s, t) !== Ternary.False;
}

function createUnionSignature(c: Checker, sig: Signature, unionSignatures: Signature[]): Signature {
  const result = cloneSignature(c, sig);
  result.composite = new CompositeSignature(true, unionSignatures);
  result.target = undefined;
  result.mapper = undefined;
  return result;
}

export function combineUnionOrIntersectionMemberSignatures(
  c: Checker,
  left: Signature,
  right: Signature,
  isUnion: boolean,
): Signature {
  const typeParams = left.typeParameters.length !== 0 ? left.typeParameters : right.typeParameters;
  // Use the type parameter defaults from the first signature.
  const paramMapper =
    left.typeParameters.length !== 0 && right.typeParameters.length !== 0
      ? newTypeMapper(right.typeParameters, left.typeParameters)
      : undefined;
  let flags = (left.flags | right.flags) & (SignatureFlags.PropagatingFlags & ~SignatureFlags.HasRestParameter);
  const params = combineUnionOrIntersectionParameters(c, left, right, paramMapper, isUnion);
  const lastParam = params.length !== 0 ? params[params.length - 1]! : undefined;
  if (lastParam !== undefined && (lastParam.checkFlags & CheckFlags.RestParameter) !== 0)
    flags |= SignatureFlags.HasRestParameter;
  const thisParam = combineUnionOrIntersectionThisParam(
    c,
    left.thisParameter,
    right.thisParameter,
    paramMapper,
    isUnion,
  );
  const minArgCount = Math.max(left.minArgumentCount, right.minArgumentCount);
  const result = c.newSignature(flags, left.declaration, typeParams, thisParam, params, undefined, minArgCount);
  const leftSignatures = left.composite !== undefined && left.composite.isUnion ? left.composite.signatures : [left];
  result.composite = new CompositeSignature(isUnion, leftSignatures.concat([right]));
  if (paramMapper !== undefined) {
    result.mapper =
      left.composite !== undefined && left.composite.isUnion === isUnion && left.mapper !== undefined
        ? combineMappers(c, left.mapper, paramMapper)
        : paramMapper;
  } else if (left.composite !== undefined && left.composite.isUnion === isUnion) result.mapper = left.mapper;
  return result;
}

import { combineTypeMappers as combineMappers } from './instantiation.js';

function combineUnionOrIntersectionParameters(
  c: Checker,
  left: Signature,
  right: Signature,
  mapper: TypeMapper | undefined,
  isUnion: boolean,
): Symbol[] {
  const leftCount = getParameterCount(c, left);
  const rightCount = getParameterCount(c, right);
  const longest = leftCount >= rightCount ? left : right;
  const shorter = longest === left ? right : left;
  const longestCount = longest === left ? leftCount : rightCount;
  const eitherHasEffectiveRest = hasEffectiveRestParameter(c, left) || hasEffectiveRestParameter(c, right);
  const needsExtraRestElement = eitherHasEffectiveRest && !hasEffectiveRestParameter(c, longest);
  const params: Symbol[] = [];
  for (let i = 0; i < longestCount; i++) {
    let longestParamType = tryGetTypeAtPosition(c, longest, i)!;
    if (longest === right) longestParamType = instantiateType(c, longestParamType, mapper);
    let shorterParamType = tryGetTypeAtPosition(c, shorter, i) ?? c.unknownType;
    if (shorter === right) shorterParamType = instantiateType(c, shorterParamType, mapper);
    const combinedParamType = getUnionOrIntersectionType(
      c,
      [longestParamType, shorterParamType],
      !isUnion,
      UnionReduction.Literal,
    );
    const isRestParam = eitherHasEffectiveRest && !needsExtraRestElement && i === longestCount - 1;
    const isOptional = i >= getMinArgumentCount(c, longest) && i >= getMinArgumentCount(c, shorter);
    const leftName = i < leftCount ? getParameterNameAtPosition(c, left, i) : '';
    const rightName = i < rightCount ? getParameterNameAtPosition(c, right, i) : '';
    let paramName = leftName === rightName ? leftName : leftName === '' ? rightName : rightName === '' ? leftName : '';
    if (paramName === '') paramName = 'arg' + i;
    const paramSymbol = c.newSymbolWithCheckFlags(
      SymbolFlags.FunctionScopedVariable | (isOptional && !isRestParam ? SymbolFlags.Optional : 0),
      paramName,
      isRestParam ? CheckFlags.RestParameter : isOptional ? CheckFlags.OptionalParameter : CheckFlags.None,
    );
    c.symbolTypes.set(
      getSymbolId(paramSymbol),
      isRestParam ? createArrayTypeEx(c, combinedParamType, false) : combinedParamType,
    );
    params.push(paramSymbol);
  }
  if (needsExtraRestElement) {
    const restParamSymbol = c.newSymbolWithCheckFlags(
      SymbolFlags.FunctionScopedVariable,
      'args',
      CheckFlags.RestParameter,
    );
    let restType = createArrayTypeEx(c, getTypeAtPosition(c, shorter, longestCount), false);
    if (shorter === right) restType = instantiateType(c, restType, mapper);
    c.symbolTypes.set(getSymbolId(restParamSymbol), restType);
    params.push(restParamSymbol);
  }
  return params;
}

function combineUnionOrIntersectionThisParam(
  c: Checker,
  left: Symbol | undefined,
  right: Symbol | undefined,
  mapper: TypeMapper | undefined,
  isUnion: boolean,
): Symbol | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  // Intersected like parameter types, to be permissive when calling.
  const thisType = getUnionOrIntersectionType(
    c,
    [getTypeOfSymbol(c, left), instantiateType(c, getTypeOfSymbol(c, right), mapper)],
    !isUnion,
    UnionReduction.Literal,
  );
  return createSymbolWithType(c, left, thisType);
}

export function getUnionIndexInfos(c: Checker, types: readonly Type[]): IndexInfo[] {
  const sourceInfos = getIndexInfosOfType(c, types[0]!);
  const result: IndexInfo[] = [];
  for (const info of sourceInfos) {
    const indexType = info.keyType;
    let everyHas = true;
    for (const t of types)
      if (getIndexInfoOfType(c, t, indexType) === undefined) {
        everyHas = false;
        break;
      }
    if (!everyHas) continue;
    const valueTypes: Type[] = [];
    let isReadonly = false;
    for (const t of types) {
      const i = getIndexInfoOfType(c, t, indexType)!;
      valueTypes.push(i.valueType);
      if (i.isReadonly) isReadonly = true;
    }
    result.push(new IndexInfo(indexType, getUnionType(c, valueTypes), isReadonly, undefined, []));
  }
  return result;
}

function resolveIntersectionTypeMembers(c: Checker, t: IntersectionType): void {
  let callSignatures: Signature[] = [];
  let constructSignatures: Signature[] = [];
  let indexInfos: IndexInfo[] = [];
  const types = t.types;
  const mixinFlags: boolean[] = [];
  for (const u of types) mixinFlags.push(isMixinConstructorType(c, u));
  let constructorTypeCount = 0;
  let mixinCount = 0;
  let firstMixinIndex = -1;
  for (let i = 0; i < types.length; i++) {
    if (getSignaturesOfType(c, types[i]!, SignatureKind.Construct).length > 0) constructorTypeCount++;
    if (mixinFlags[i]!) {
      if (firstMixinIndex < 0) firstMixinIndex = i;
      mixinCount++;
    }
  }
  if (constructorTypeCount > 0 && constructorTypeCount === mixinCount) {
    mixinFlags[firstMixinIndex] = false;
    mixinCount--;
  }
  for (let i = 0; i < types.length; i++) {
    const u = types[i]!;
    // Mixin construct signatures are dropped; their return types mix into the others.
    if (!mixinFlags[i]!) {
      let signatures = getSignaturesOfType(c, u, SignatureKind.Construct);
      if (signatures.length !== 0 && mixinCount > 0) {
        const clones: Signature[] = [];
        for (const s of signatures) {
          const clone = cloneSignature(c, s);
          clone.resolvedReturnType = includeMixinType(c, getReturnTypeOfSignature(c, s), types, mixinFlags, i);
          clones.push(clone);
        }
        signatures = clones;
      }
      constructSignatures = appendSignatures(c, constructSignatures, signatures);
    }
    callSignatures = appendSignatures(c, callSignatures, getSignaturesOfType(c, u, SignatureKind.Call));
    for (const info of getIndexInfosOfType(c, u)) indexInfos = appendIndexInfo(c, indexInfos, info, false);
  }
  setStructuredTypeMembers(c, t, undefined, callSignatures, constructSignatures, indexInfos);
}

function includeMixinType(c: Checker, t: Type, types: readonly Type[], mixinFlags: boolean[], index: number): Type {
  const mixed: Type[] = [];
  for (let i = 0; i < types.length; i++) {
    if (i === index) mixed.push(t);
    else if (mixinFlags[i]!)
      mixed.push(getReturnTypeOfSignature(c, getSignaturesOfType(c, types[i]!, SignatureKind.Construct)[0]!));
  }
  return getIntersectionType(c, mixed);
}

function appendSignatures(c: Checker, signatures: Signature[], newSignatures: readonly Signature[]): Signature[] {
  for (const sig of newSignatures) {
    let unique = true;
    for (const s of signatures)
      if (compareSignaturesIdentical(c, s, sig, false, false, false, ComparerKind.Identical) !== Ternary.False) {
        unique = false;
        break;
      }
    if (signatures.length === 0 || unique) signatures.push(sig);
  }
  return signatures;
}

export function appendIndexInfo(c: Checker, indexInfos: IndexInfo[], newInfo: IndexInfo, union: boolean): IndexInfo[] {
  for (let i = 0; i < indexInfos.length; i++) {
    const info = indexInfos[i]!;
    if (info.keyType !== newInfo.keyType) continue;
    const valueType = union
      ? getUnionType(c, [info.valueType, newInfo.valueType])
      : getIntersectionType(c, [info.valueType, newInfo.valueType]);
    const isReadonly = union ? info.isReadonly || newInfo.isReadonly : info.isReadonly && newInfo.isReadonly;
    indexInfos[i] = new IndexInfo(info.keyType, valueType, isReadonly, undefined, []);
    return indexInfos;
  }
  indexInfos.push(newInfo);
  return indexInfos;
}

// ---- Properties

export function getPropertiesOfType(c: Checker, t: Type): Symbol[] {
  if (!isOwnReducedApparentType(t)) t = getReducedApparentTypeWorker(c, t);
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0)
    return getPropertiesOfUnionOrIntersectionType(c, t as UnionOrIntersectionType);
  return getPropertiesOfObjectType(c, t);
}

export function getPropertiesOfObjectType(c: Checker, t: Type): Symbol[] {
  return (t.flags & TypeFlags.Object) !== 0 ? resolveStructuredTypeMembers(c, t).properties : emptySymbols;
}

export function getPropertiesOfUnionOrIntersectionType(c: Checker, t: UnionOrIntersectionType): Symbol[] {
  const known = sideOf(c, t).membersOf;
  if (known !== undefined && known.resolvedProperties !== undefined) return known.resolvedProperties;
  {
    const checked = new Set<string>();
    const props: Symbol[] = [];
    for (const current of t.types) {
      for (const prop of getPropertiesOfType(c, current)) {
        if (checked.has(prop.name)) continue;
        checked.add(prop.name);
        const combined = getPropertyOfUnionOrIntersectionType(
          c,
          t,
          prop.name,
          (t.flags & TypeFlags.Intersection) !== 0,
        );
        if (combined !== undefined) props.push(combined);
      }
      // Union properties are in every constituent: the first without index signatures suffices.
      if ((t.flags & TypeFlags.Union) !== 0 && getIndexInfosOfType(c, current).length === 0) break;
    }
    // Resolving the properties may have created the holder.
    const side = unionOrIntersectionMembers(sideOf(c, t));
    side.resolvedProperties = props;
    return props;
  }
}

export function getPropertyOfType(c: Checker, t: Type, name: string): Symbol | undefined {
  return getPropertyOfTypeEx(c, t, name, false, false);
}

/**
 * The property `name` of `t`: synthesizes union and intersection properties, uses apparent types of
 * primitives and type parameters, and falls back to Object and Function members.
 */
export function getPropertyOfTypeEx(
  c: Checker,
  t: Type,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
  includeTypeOnlyMembers: boolean,
): Symbol | undefined {
  if (!isOwnReducedApparentType(t)) t = getReducedApparentTypeWorker(c, t);
  if ((t.flags & TypeFlags.Object) !== 0) {
    // The first test of resolveStructuredTypeMembers, here where most lookups find the members resolved.
    const resolved =
      (t.objectFlags & ObjectFlags.MembersResolved) !== 0 ? (t as StructuredType) : resolveStructuredTypeMembers(c, t);
    const symbol = getResolvedMember(resolved, name);
    if (symbol !== undefined && includeTypeOnlyMembers) return symbol;
    if (symbol !== undefined) {
      // A module's member that only an `export type *` declaration exports is not a value.
      if (
        t.symbol !== undefined &&
        (t.symbol.flags & SymbolFlags.ValueModule) !== 0 &&
        c.symbolLinks(t.symbol).typeOnlyExportStarMap?.has(name) === true
      )
        return undefined;
      if (symbolIsValue(c, symbol)) return symbol;
    }
    if (skipObjectFunctionPropertyAugment) return undefined;
    let functionType: Type | undefined;
    if (t === c.anyFunctionType) functionType = c.globalFunctionType;
    else if (resolved.callSignatures.length !== 0) functionType = c.globalCallableFunctionType;
    else if (resolved.constructSignatures.length !== 0) functionType = c.globalNewableFunctionType;
    if (functionType !== undefined) {
      const found = getPropertyOfObjectType(c, functionType, name);
      if (found !== undefined) return found;
    }
    return getPropertyOfObjectType(c, c.globalObjectType, name);
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    const prop = getPropertyOfUnionOrIntersectionType(c, t as UnionOrIntersectionType, name, true);
    if (prop !== undefined) return prop;
    if (!skipObjectFunctionPropertyAugment)
      return getPropertyOfUnionOrIntersectionType(c, t as UnionOrIntersectionType, name, false);
    return undefined;
  }
  if ((t.flags & TypeFlags.Union) !== 0)
    return getPropertyOfUnionOrIntersectionType(
      c,
      t as UnionOrIntersectionType,
      name,
      skipObjectFunctionPropertyAugment,
    );
  return undefined;
}

/**
 * A long property list that `propertiesRelatedTo` walks: the position of each name, and the positions of
 * the static private properties, which `getUnmatchedProperty` never reports, and of the required ones.
 */
export class PropertyListIndex {
  readonly positions: Map<string, number>;
  readonly staticPrivate: number[];
  readonly required: number[];

  constructor(positions: Map<string, number>, staticPrivate: number[], required: number[]) {
    this.positions = positions;
    this.staticPrivate = staticPrivate;
    this.required = required;
  }
}

/** The uses of a long property list after which `propertyListIndex` indexes it by a table of its own. */
const propertyListUsesBeforeIndex = 3;

/**
 * The index of `properties`, the properties of `target`. Where the members of `target` are properties
 * with shared names (`PropertyMembers` with `MemberNames`), the index reads the positions of those names.
 * Other lists get a positions table of their own on the use after the first `propertyListUsesBeforeIndex`:
 * most long lists are related only a few times, and the lists related many times hold most of the lookups
 * the index saves. Undefined before that, and where the list repeats a name.
 */
function propertyListIndex(c: Checker, target: Type, properties: Symbol[]): PropertyListIndex | undefined {
  const known = c.propertyListIndexes.get(properties);
  if (known instanceof PropertyListIndex) return known;
  if (known === null) return undefined;
  let positions: Map<string, number> | undefined;
  const pending = (target.flags & TypeFlags.Object) !== 0 ? membersHolder(c, target).pendingMembers : undefined;
  if (
    pending instanceof PropertyMembers &&
    pending.materializedProperties === properties &&
    pending.names !== undefined
  ) {
    // The names are the names of the properties, in order (hasMemberNames).
    positions = pending.names.positions;
    if (positions.size !== properties.length) {
      c.propertyListIndexes.set(properties, null);
      return undefined;
    }
  } else {
    const uses = known ?? 0;
    if (uses < propertyListUsesBeforeIndex) {
      c.propertyListIndexes.set(properties, uses + 1);
      return undefined;
    }
  }
  const own = positions === undefined ? new Map<string, number>() : undefined;
  const staticPrivate: number[] = [];
  const required: number[] = [];
  for (let i = 0; i < properties.length; i++) {
    const p = properties[i]!;
    if (own !== undefined) {
      if (own.has(p.name)) {
        c.propertyListIndexes.set(properties, null);
        return undefined;
      }
      own.set(p.name, i);
    }
    if (isStaticPrivateIdentifierProperty(p)) staticPrivate.push(i);
    else if ((p.flags & SymbolFlags.Optional) === 0 && (p.checkFlags & CheckFlags.Partial) === 0) required.push(i);
  }
  const index = new PropertyListIndex((positions ?? own)!, staticPrivate, required);
  c.propertyListIndexes.set(properties, index);
  return index;
}

/**
 * `getUnmatchedProperty(c, source, target, requireOptionalProperties, false)` where `targetProperties` are
 * the target's properties and `found` the positions of the names the source has
 * (`positionsOfNamesFoundInSource`): the first property that is not static private, and is required unless
 * `requireOptionalProperties`, at a position not in `found`.
 */
export function firstUnmatchedProperty(
  c: Checker,
  targetProperties: Symbol[],
  found: number[],
  requireOptionalProperties: boolean,
): Symbol | undefined {
  const index = c.propertyListIndexes.get(targetProperties) as PropertyListIndex;
  let next = 0;
  if (!requireOptionalProperties) {
    for (const position of index.required) {
      while (next < found.length && found[next]! < position) next++;
      if (next === found.length || found[next] !== position) return targetProperties[position];
    }
    return undefined;
  }
  const staticPrivate = index.staticPrivate;
  let nextPrivate = 0;
  for (let position = 0; position < targetProperties.length; position++) {
    // A position can be both found and static private: both lists move past it.
    const isFound = next < found.length && found[next] === position;
    if (isFound) next++;
    const isStaticPrivate = nextPrivate < staticPrivate.length && staticPrivate[nextPrivate] === position;
    if (isStaticPrivate) nextPrivate++;
    if (!isFound && !isStaticPrivate) return targetProperties[position];
  }
  return undefined;
}

/** The shortest target property list that `positionsOfNamesFoundInSource` indexes. */
const indexedTargetPropertiesMinimum = 32;

/** The properties of `t` where its members are resolved and instantiated, else undefined. */
function resolvedPropertiesIfAny(c: Checker, t: Type): Symbol[] | undefined {
  const holder = (t.objectFlags & ObjectFlags.MembersResolved) !== 0 ? (t as StructuredType) : membersHolder(c, t);
  if ((holder.objectFlags & ObjectFlags.MembersResolved) === 0) return undefined;
  const pending = holder.pendingMembers;
  return pending === undefined || pending.materializedProperties !== undefined ? holder.properties : undefined;
}

/**
 * The positions in `targetProperties`, the properties of `target`, ascending, of the names
 * `getPropertyOfType(c, source, name)` finds: the names of the source's properties and of the Function and
 * Object members its lookups fall back to. `getPropertyOfType` answers undefined for the names at every
 * other position. Undefined where the answer cannot be read from resolved property lists without resolving
 * anything (not an object type, an apparent type, members not resolved or not instantiated yet, a module),
 * where the target list is too short or the source list too long to save lookups, and where the target
 * list has no index (yet: `propertyListIndex`).
 */
export function positionsOfNamesFoundInSource(
  c: Checker,
  source: Type,
  target: Type,
  targetProperties: Symbol[],
): number[] | undefined {
  if (targetProperties.length < indexedTargetPropertiesMinimum) return undefined;
  if ((source.flags & TypeFlags.Object) === 0 || !isOwnReducedApparentType(source)) return undefined;
  // A module's member that only an `export type *` declaration exports is not found.
  if (source.symbol !== undefined && (source.symbol.flags & SymbolFlags.ValueModule) !== 0) return undefined;
  const sourceProperties = resolvedPropertiesIfAny(c, source);
  if (sourceProperties === undefined) return undefined;
  const resolved = membersHolder(c, source);
  let functionType: Type | undefined;
  if (source === c.anyFunctionType) functionType = c.globalFunctionType;
  else if (resolved.callSignatures.length !== 0) functionType = c.globalCallableFunctionType;
  else if (resolved.constructSignatures.length !== 0) functionType = c.globalNewableFunctionType;
  let functionProperties = emptySymbols;
  if (functionType !== undefined && (functionType.flags & TypeFlags.Object) !== 0) {
    const properties = resolvedPropertiesIfAny(c, functionType);
    if (properties === undefined) return undefined;
    functionProperties = properties;
  }
  const objectProperties =
    (c.globalObjectType.flags & TypeFlags.Object) !== 0 ? resolvedPropertiesIfAny(c, c.globalObjectType) : emptySymbols;
  if (objectProperties === undefined) return undefined;
  if ((sourceProperties.length + functionProperties.length + objectProperties.length) * 4 > targetProperties.length)
    return undefined;
  const index = propertyListIndex(c, target, targetProperties);
  if (index === undefined) return undefined;
  const positions = index.positions;
  const found: number[] = [];
  for (const list of [sourceProperties, functionProperties, objectProperties])
    for (const p of list) {
      const position = positions.get(p.name);
      if (position !== undefined && !found.includes(position)) found.push(position);
    }
  return found.sort((a, b) => a - b);
}

export function getPropertyOfObjectType(c: Checker, t: Type, name: string): Symbol | undefined {
  if ((t.flags & TypeFlags.Object) === 0) return undefined;
  const symbol = getResolvedMember(resolveStructuredTypeMembers(c, t), name);
  return symbol !== undefined && symbolIsValue(c, symbol) ? symbol : undefined;
}

export function getTypeOfPropertyOfType(c: Checker, t: Type, name: string): Type | undefined {
  const prop = getPropertyOfType(c, t, name);
  return prop !== undefined ? getTypeOfSymbol(c, prop) : undefined;
}

export function getPropertyOfUnionOrIntersectionType(
  c: Checker,
  t: UnionOrIntersectionType,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
): Symbol | undefined {
  const prop = getUnionOrIntersectionProperty(c, t, name, skipObjectFunctionPropertyAugment);
  // Partial union properties are filtered out.
  return prop !== undefined && (prop.checkFlags & CheckFlags.ReadPartial) !== 0 ? undefined : prop;
}

/**
 * The (possibly partial) property `name` of a union or intersection, cached on the type.
 *
 * Non-partial results without the Object/Function augment also serve lookups with it (tsgo copies
 * them into the augmented cache unless it already has the name). The augmented cache keeps only
 * its own results and a miss there falls back to the other cache, which answers exactly what the
 * copy would have: a name is in the augmented cache whenever a non-partial copy was skipped. This
 * keeps intersections, which resolve every property without the augment, from holding each
 * property twice.
 */
export function getUnionOrIntersectionProperty(
  c: Checker,
  t: UnionOrIntersectionType,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
): Symbol | undefined {
  const known = sideOf(c, t).membersOf;
  if (known !== undefined) {
    const cached = (
      skipObjectFunctionPropertyAugment ? known.propertyCacheWithoutFunctionPropertyAugment : known.propertyCache
    )?.get(name);
    if (cached !== undefined) return cached;
    if (!skipObjectFunctionPropertyAugment) {
      const withoutAugment = known.propertyCacheWithoutFunctionPropertyAugment?.get(name);
      if (withoutAugment !== undefined && (withoutAugment.checkFlags & CheckFlags.Partial) === 0) return withoutAugment;
    }
  }
  const prop = createUnionOrIntersectionProperty(c, t, name, skipObjectFunctionPropertyAugment);
  if (prop !== undefined) {
    // Creating the property may have created the holder and its caches.
    const side = unionOrIntersectionMembers(sideOf(c, t));
    let cache = skipObjectFunctionPropertyAugment
      ? side.propertyCacheWithoutFunctionPropertyAugment
      : side.propertyCache;
    if (cache === undefined) {
      cache = new Map<string, Symbol>();
      if (skipObjectFunctionPropertyAugment) side.propertyCacheWithoutFunctionPropertyAugment = cache;
      else side.propertyCache = cache;
    }
    cache.set(name, prop);
  }
  return prop;
}

export function getDeclarationModifierFlagsFromSymbol(c: Checker, s: Symbol, isWrite: boolean): ModifierFlags {
  const checkFlags = s.checkFlags;
  if ((checkFlags & CheckFlags.Synthetic) !== 0) {
    // The least restricted access of the constituents, for reading or for writing.
    let access = ModifierFlags.None;
    if ((checkFlags & (isWrite ? CheckFlags.ContainsWritePublic : CheckFlags.ContainsPublic)) !== 0)
      access = ModifierFlags.Public;
    else if ((checkFlags & (isWrite ? CheckFlags.ContainsWriteProtected : CheckFlags.ContainsProtected)) !== 0)
      access = ModifierFlags.Protected;
    else if ((checkFlags & (isWrite ? CheckFlags.ContainsWritePrivate : CheckFlags.ContainsPrivate)) !== 0)
      access = ModifierFlags.Private;
    return (checkFlags & CheckFlags.ContainsStatic) !== 0 ? access | ModifierFlags.Static : access;
  }
  if (s.valueDeclaration !== undefined) {
    let declaration: Node | undefined;
    if (isWrite) declaration = getDeclarationOfKind(s, SyntaxKind.SetAccessor);
    if (declaration === undefined && (s.flags & SymbolFlags.GetAccessor) !== 0)
      declaration = getDeclarationOfKind(s, SyntaxKind.GetAccessor);
    if (declaration === undefined) declaration = s.valueDeclaration;
    const flags = getCombinedModifierFlags(declaration);
    return s.parent !== undefined && (s.parent.flags & SymbolFlags.Class) !== 0
      ? flags
      : flags & ~ModifierFlags.AccessibilityModifier;
  }
  if ((s.flags & SymbolFlags.Prototype) !== 0) return ModifierFlags.Public | ModifierFlags.Static;
  return 0;
}

export function createUnionOrIntersectionProperty(
  c: Checker,
  containingType: UnionOrIntersectionType,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
): Symbol | undefined {
  let propFlags = SymbolFlags.None;
  let singleProp: Symbol | undefined;
  let propSet: Symbol[] | undefined;
  const indexTypes: Type[] = [];
  const isUnion = (containingType.flags & TypeFlags.Union) !== 0;
  // Flags propagated when present in every constituent.
  let checkFlags = isUnion ? CheckFlags.None : CheckFlags.Readonly;
  let optionalFlag = isUnion ? SymbolFlags.None : SymbolFlags.Optional;
  let syntheticFlag = CheckFlags.SyntheticMethod;
  let mergedInstantiations = false;
  for (const current of containingType.types) {
    const t = getApparentType(c, current);
    if (isErrorType(c, t) || (t.flags & TypeFlags.Never) !== 0) continue;
    const prop = getPropertyOfTypeEx(c, t, name, skipObjectFunctionPropertyAugment, false);
    if (prop !== undefined) {
      const modifiers = getDeclarationModifierFlagsFromSymbol(c, prop, false);
      const writeModifiers = getDeclarationModifierFlagsFromSymbol(c, prop, true);
      if ((prop.flags & SymbolFlags.ClassMember) !== 0) {
        if (isUnion) optionalFlag |= prop.flags & SymbolFlags.Optional;
        else optionalFlag &= prop.flags;
      }
      if (singleProp === undefined) {
        singleProp = prop;
        propFlags = prop.flags & SymbolFlags.Accessor || SymbolFlags.Property;
      } else if (prop !== singleProp) {
        const isInstantiation = getTargetSymbol(c, prop) === getTargetSymbol(c, singleProp);
        // Instantiations with identical types are equivalent; keep the first.
        if (isInstantiation && compareProperties(c, singleProp, prop, ComparerKind.Equal) === Ternary.True) {
          mergedInstantiations =
            singleProp.parent !== undefined &&
            getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, singleProp.parent).length !== 0;
        } else {
          if (propSet === undefined) propSet = [singleProp];
          if (!propSet.includes(prop)) propSet.push(prop);
        }
        // Accessor flags survive only when the same in all constituents.
        if (
          (propFlags & SymbolFlags.Accessor) !== 0 &&
          (prop.flags & SymbolFlags.Accessor) !== (propFlags & SymbolFlags.Accessor)
        )
          propFlags = (propFlags & ~SymbolFlags.Accessor) | SymbolFlags.Property;
      }
      if (isUnion && isReadonlySymbol(c, prop)) checkFlags |= CheckFlags.Readonly;
      else if (!isUnion && !isReadonlySymbol(c, prop)) checkFlags &= ~CheckFlags.Readonly;
      if ((modifiers & (ModifierFlags.Protected | ModifierFlags.Public)) === ModifierFlags.Protected)
        checkFlags |= CheckFlags.ContainsProtected;
      else if ((modifiers & (ModifierFlags.Private | ModifierFlags.Public)) === ModifierFlags.Private)
        checkFlags |= CheckFlags.ContainsPrivate;
      else checkFlags |= CheckFlags.ContainsPublic;
      if ((writeModifiers & (ModifierFlags.Protected | ModifierFlags.Public)) === ModifierFlags.Protected)
        checkFlags |= CheckFlags.ContainsWriteProtected;
      else if ((writeModifiers & (ModifierFlags.Private | ModifierFlags.Public)) === ModifierFlags.Private)
        checkFlags |= CheckFlags.ContainsWritePrivate;
      else checkFlags |= CheckFlags.ContainsWritePublic;
      if ((modifiers & ModifierFlags.Static) !== 0) checkFlags |= CheckFlags.ContainsStatic;
      if (!isPrototypeProperty(prop)) syntheticFlag = CheckFlags.SyntheticProperty;
    } else if (isUnion) {
      const indexInfo = !isLateBoundName(name) ? getApplicableIndexInfoForName(c, t, name) : undefined;
      if (indexInfo !== undefined) {
        propFlags = (propFlags & ~SymbolFlags.Accessor) | SymbolFlags.Property;
        checkFlags |= CheckFlags.WritePartial | (indexInfo.isReadonly ? CheckFlags.Readonly : 0);
        indexTypes.push(isTupleType(t) ? (getRestTypeOfTupleType(c, t) ?? c.undefinedType) : indexInfo.valueType);
      } else if (isObjectLiteralType(t) && (t.objectFlags & ObjectFlags.ContainsSpread) === 0) {
        checkFlags |= CheckFlags.WritePartial;
        indexTypes.push(c.undefinedType);
      } else checkFlags |= CheckFlags.ReadPartial;
    }
  }
  if (singleProp === undefined) return undefined;
  if (
    isUnion &&
    (propSet !== undefined || (checkFlags & CheckFlags.Partial) !== 0) &&
    (checkFlags &
      (CheckFlags.ContainsPrivate |
        CheckFlags.ContainsProtected |
        CheckFlags.ContainsWritePrivate |
        CheckFlags.ContainsWriteProtected)) !==
      0 &&
    !(propSet !== undefined && hasCommonDeclaration(propSet))
  ) {
    // The property is private or protected in one constituent but missing or different in another.
    // Private or protected reading leaves no property; private or protected writing restricts write
    // access to that of the most restricted constituent.
    if ((checkFlags & (CheckFlags.ContainsPrivate | CheckFlags.ContainsProtected)) !== 0) return undefined;
    if ((checkFlags & CheckFlags.ContainsWritePrivate) !== 0)
      checkFlags &= ~(CheckFlags.ContainsWritePublic | CheckFlags.ContainsWriteProtected);
    else if ((checkFlags & CheckFlags.ContainsWriteProtected) !== 0) checkFlags &= ~CheckFlags.ContainsWritePublic;
  }
  if (propSet === undefined && (checkFlags & CheckFlags.ReadPartial) === 0 && indexTypes.length === 0) {
    if (!mergedInstantiations) return singleProp;
    // Merged instantiations get a clone without a union parent, so `Array<T>.length` prints as such.
    let singlePropType: Type | undefined;
    let singlePropMapper: TypeMapper | undefined;
    if ((singleProp.flags & SymbolFlags.Transient) !== 0) {
      const id = getSymbolId(singleProp);
      singlePropType = c.symbolTypes.get(id);
      singlePropMapper = c.symbolMappers.get(id);
    }
    const clone = createSymbolWithType(c, singleProp, singlePropType);
    if (singleProp.valueDeclaration !== undefined) clone.parent = getSymbol(singleProp.valueDeclaration)?.parent;
    const links = c.symbolLinks(clone);
    c.symbolContainingTypes.set(clone.id, containingType);
    c.symbolMappers.set(clone.id, singlePropMapper);
    links.writeType = getWriteTypeOfSymbol(c, singleProp);
    return clone;
  }
  const props = propSet ?? [singleProp];
  const declarations: Node[] = [];
  let firstType: Type | undefined;
  let nameType: Type | undefined;
  const propTypes: Type[] = [];
  let writeTypes: Type[] | undefined;
  let firstValueDeclaration: Node | undefined;
  let hasNonUniformValueDeclaration = false;
  for (const prop of props) {
    if (firstValueDeclaration === undefined) firstValueDeclaration = prop.valueDeclaration;
    else if (prop.valueDeclaration !== undefined && prop.valueDeclaration !== firstValueDeclaration)
      hasNonUniformValueDeclaration = true;
    for (const d of getDeclarations(prop)) if (!declarations.includes(d)) declarations.push(d);
    const t = getTypeOfSymbol(c, prop);
    if (firstType === undefined) {
      firstType = t;
      nameType = c.symbolNameTypes.get(getSymbolId(prop));
    }
    const writeType = getWriteTypeOfSymbol(c, prop);
    if (writeTypes !== undefined || writeType !== t) {
      if (writeTypes === undefined) writeTypes = propTypes.slice();
      writeTypes.push(writeType);
    }
    if (t !== firstType) checkFlags |= CheckFlags.HasNonUniformType;
    if (isLiteralType(t) || isPatternLiteralType(c, t)) checkFlags |= CheckFlags.HasLiteralType;
    if ((t.flags & TypeFlags.Never) !== 0 && t !== c.uniqueLiteralType) checkFlags |= CheckFlags.HasNeverType;
    propTypes.push(t);
  }
  for (const t of indexTypes) propTypes.push(t);
  const result = c.newSymbolWithCheckFlags(propFlags | optionalFlag, name, checkFlags | syntheticFlag);
  setDeclarations(result, declarations);
  if (!hasNonUniformValueDeclaration && firstValueDeclaration !== undefined) {
    result.valueDeclaration = firstValueDeclaration;
    result.parent = getSymbol(firstValueDeclaration)?.parent;
  }
  const id = getSymbolId(result);
  c.symbolContainingTypes.set(id, containingType);
  c.symbolNameTypes.set(id, nameType);
  if (propTypes.length > 2) {
    // Defer normalization of possibly large constituent lists.
    result.checkFlags |= CheckFlags.DeferredType;
    const links = c.symbolLinks(result);
    links.deferralParent = containingType;
    links.deferralConstituents = propTypes;
    links.deferralWriteConstituents = writeTypes;
    return result;
  }
  c.symbolTypes.set(id, isUnion ? getUnionType(c, propTypes) : getIntersectionType(c, propTypes));
  if (writeTypes !== undefined)
    c.symbolLinks(result).writeType = isUnion ? getUnionType(c, writeTypes) : getIntersectionType(c, writeTypes);
  return result;
}

export function isObjectLiteralType(t: Type): boolean {
  return (t.objectFlags & ObjectFlags.ObjectLiteral) !== 0;
}

export function getTargetSymbol(c: Checker, s: Symbol): Symbol {
  return (s.checkFlags & CheckFlags.Instantiated) !== 0 ? c.symbolTargets.get(getSymbolId(s))! : s;
}

export function isPrototypeProperty(symbol: Symbol): boolean {
  return (symbol.flags & SymbolFlags.Method) !== 0 || (symbol.checkFlags & CheckFlags.SyntheticMethod) !== 0;
}

function hasCommonDeclaration(symbols: Symbol[]): boolean {
  let common: Set<Node> | undefined;
  for (const symbol of symbols) {
    if (declarationCount(symbol) === 0) return false;
    if (common === undefined) {
      common = new Set(getDeclarations(symbol));
      continue;
    }
    const next = new Set<Node>();
    for (const d of getDeclarations(symbol)) if (common.has(d)) next.add(d);
    if (next.size === 0) return false;
    common = next;
  }
  return common !== undefined && common.size !== 0;
}

export function createSymbolWithType(c: Checker, source: Symbol, t: Type | undefined): Symbol {
  const symbol = c.newSymbolWithCheckFlags(source.flags, source.name, source.checkFlags & CheckFlags.Readonly);
  copyDeclarations(symbol, source);
  symbol.parent = source.parent;
  symbol.valueDeclaration = source.valueDeclaration;
  const id = getSymbolId(symbol);
  c.symbolTypes.set(id, t);
  c.symbolTargets.set(id, source);
  c.symbolNameTypes.set(id, c.symbolNameTypes.get(getSymbolId(source)));
  return symbol;
}

// ---- Signatures and index infos

export function getSignaturesOfType(c: Checker, t: Type, kind: SignatureKind): Signature[] {
  return getSignaturesOfStructuredType(c, isOwnReducedApparentType(t) ? t : getReducedApparentTypeWorker(c, t), kind);
}

export function getSignaturesOfStructuredType(c: Checker, t: Type, kind: SignatureKind): Signature[] {
  if ((t.flags & TypeFlags.StructuredType) === 0) return emptySignatures;
  const resolved = resolveStructuredTypeMembers(c, t);
  return kind === SignatureKind.Call ? resolved.callSignatures : resolved.constructSignatures;
}

export function getIndexInfosOfType(c: Checker, t: Type): IndexInfo[] {
  return getIndexInfosOfStructuredType(c, isOwnReducedApparentType(t) ? t : getReducedApparentTypeWorker(c, t));
}

export function getIndexInfosOfStructuredType(c: Checker, t: Type): IndexInfo[] {
  return (t.flags & TypeFlags.StructuredType) !== 0 ? resolveStructuredTypeMembers(c, t).indexInfos : emptyIndexInfos;
}

export function getIndexInfoOfType(c: Checker, t: Type, keyType: Type): IndexInfo | undefined {
  return findIndexInfo(getIndexInfosOfType(c, t), keyType);
}

export function getIndexTypeOfType(c: Checker, t: Type, keyType: Type): Type | undefined {
  const info = getIndexInfoOfType(c, t, keyType);
  return info !== undefined ? info.valueType : undefined;
}

export function getApplicableIndexInfo(c: Checker, t: Type, keyType: Type): IndexInfo | undefined {
  return findApplicableIndexInfo(c, getIndexInfosOfType(c, t), keyType);
}

export function getApplicableIndexInfoForName(c: Checker, t: Type, name: string): IndexInfo | undefined {
  return getApplicableIndexInfo(c, t, isLateBoundName(name) ? c.esSymbolType : getStringLiteralType(c, name));
}

export function findApplicableIndexInfo(
  c: Checker,
  indexInfos: readonly IndexInfo[],
  keyType: Type,
): IndexInfo | undefined {
  // `string` index signatures apply only when no other one does.
  let stringIndexInfo: IndexInfo | undefined;
  // The list of applicable infos is built only when more than one applies.
  let first: IndexInfo | undefined;
  let applicable: IndexInfo[] | undefined;
  for (const info of indexInfos) {
    if (info.keyType === c.stringType) stringIndexInfo = info;
    else if (isApplicableIndexType(c, keyType, info.keyType)) {
      if (first === undefined) first = info;
      else if (applicable === undefined) applicable = [first, info];
      else applicable.push(info);
    }
  }
  if (first === undefined)
    return stringIndexInfo !== undefined && isApplicableIndexType(c, keyType, c.stringType)
      ? stringIndexInfo
      : undefined;
  if (applicable === undefined) return first;
  // Several apply: a synthetic info; its key type is unused.
  let isReadonly = true;
  const types: Type[] = [];
  for (const info of applicable) {
    types.push(info.valueType);
    if (!info.isReadonly) isReadonly = false;
  }
  return new IndexInfo(c.unknownType, getIntersectionType(c, types), isReadonly, undefined, []);
}

export function isApplicableIndexType(c: Checker, source: Type, target: Type): boolean {
  // Types with many template literal index signatures would relate most pairs of their keys only
  // to find that the start or end texts differ.
  if (
    (target.flags & TypeFlags.TemplateLiteral) !== 0 &&
    isUnmatchedTemplateLiteralKey(source, target as TemplateLiteralType)
  )
    return false;
  // `string` applies to keys assignable to string or number; `number` to numeric strings too.
  return (
    isTypeAssignableTo(c, source, target) ||
    (target === c.stringType && isTypeAssignableTo(c, source, c.numberType)) ||
    (target === c.numberType &&
      (source === c.numericStringType ||
        ((source.flags & TypeFlags.StringLiteral) !== 0 && isNumericLiteralName((source as LiteralType).stringValue))))
  );
}

export function isArrayLikeType(c: Checker, t: Type): boolean {
  // Readonly arrays are array-like: anything assignable to `readonly any[]`.
  return (
    isArrayType(c, t) || ((t.flags & TypeFlags.Nullable) === 0 && isTypeAssignableTo(c, t, c.anyReadonlyArrayType))
  );
}

function isArrayType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return false;
  const target = (t as TypeReference).target;
  return target === c.globalArrayType || target === c.globalReadonlyArrayType;
}

// ---- Apparent and reduced types

/**
 * Type parameters' base constraints; primitives' wrapper object types; otherwise the type itself.
 * Most types are the last case: that test is small enough to inline into callers.
 */
export function getApparentType(c: Checker, t: Type): Type {
  return isOwnApparentType(t) ? t : getApparentTypeWorker(c, t);
}

/**
 * Whether getApparentType returns `t` itself because no rule applies to it: no constraint, wrapper
 * type, mapped type or intersection, and not `unknown` (whose apparent type depends on the options).
 */
function isOwnApparentType(t: Type): boolean {
  const flags = t.flags;
  return (
    (flags &
      (TypeFlags.Instantiable |
        TypeFlags.Intersection |
        TypeFlags.StringLike |
        TypeFlags.NumberLike |
        TypeFlags.BigIntLike |
        TypeFlags.BooleanLike |
        TypeFlags.ESSymbolLike |
        TypeFlags.NonPrimitive |
        TypeFlags.Index |
        TypeFlags.Unknown)) ===
      0 &&
    ((flags & TypeFlags.Object) === 0 || (t.objectFlags & ObjectFlags.Mapped) === 0)
  );
}

function getApparentTypeWorker(c: Checker, t: Type): Type {
  const originalType = t;
  if ((t.flags & TypeFlags.Instantiable) !== 0) t = getBaseConstraintOfType(c, t) ?? c.unknownType;
  const flags = t.flags;
  if ((t.objectFlags & ObjectFlags.Mapped) !== 0 && (flags & TypeFlags.Object) !== 0)
    return getApparentTypeOfMappedType(c, t as MappedType);
  if ((t.objectFlags & ObjectFlags.Reference) !== 0 && (flags & TypeFlags.Object) !== 0 && t !== originalType)
    return getTypeWithThisArgument(c, t, originalType, false);
  if ((flags & TypeFlags.Intersection) !== 0)
    return getApparentTypeOfIntersectionType(c, t as IntersectionType, originalType);
  if ((flags & TypeFlags.StringLike) !== 0) return c.globalStringType;
  if ((flags & TypeFlags.NumberLike) !== 0) return c.globalNumberType;
  if ((flags & TypeFlags.BigIntLike) !== 0) return getGlobalBigIntType(c);
  if ((flags & TypeFlags.BooleanLike) !== 0) return c.globalBooleanType;
  if ((flags & TypeFlags.ESSymbolLike) !== 0) return getGlobalESSymbolType(c);
  if ((flags & TypeFlags.NonPrimitive) !== 0) return c.emptyObjectType;
  if ((flags & TypeFlags.Index) !== 0) return c.stringNumberSymbolType;
  if ((flags & TypeFlags.Unknown) !== 0 && !c.strictNullChecks) return c.emptyObjectType;
  return t;
}

function getApparentTypeOfMappedType(c: Checker, t: MappedType): Type {
  const side = sideOf(c, t);
  if (side.resolvedApparentType === undefined) side.resolvedApparentType = getResolvedApparentTypeOfMappedType(c, t);
  return side.resolvedApparentType;
}

function getResolvedApparentTypeOfMappedType(c: Checker, t: MappedType): Type {
  const target = mappedTypeTarget(t);
  const typeVariable = getHomomorphicTypeVariable(c, target);
  if (typeVariable !== undefined && (target.declaration as MappedTypeNode).nameType === undefined) {
    // A homomorphic mapped type over an array or tuple constraint maps the constraint.
    const modifiersType = getModifiersTypeFromMappedType(c, t);
    const baseConstraint = isGenericMappedType(c, modifiersType)
      ? getApparentTypeOfMappedType(c, modifiersType as MappedType)
      : getBaseConstraintOfType(c, modifiersType);
    if (
      baseConstraint !== undefined &&
      everyType(baseConstraint, (u) => isArrayOrTupleType(c, u) || isArrayOrTupleOrIntersection(c, u))
    )
      return instantiateType(c, target, prependTypeMapping(typeVariable, baseConstraint, t.mapper));
  }
  return t;
}

export function isArrayOrTupleOrIntersection(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) === 0) return false;
  for (const u of typesOf(t)) if (!isArrayOrTupleType(c, u)) return false;
  return true;
}

function getApparentTypeOfIntersectionType(c: Checker, t: IntersectionType, thisArgument: Type): Type {
  if (t.id === thisArgument.id) {
    const side = sideOf(c, t);
    if (side.resolvedApparentType === undefined)
      side.resolvedApparentType = getTypeWithThisArgument(c, t, thisArgument, true);
    return side.resolvedApparentType;
  }
  const key = cachedTypeKey(CachedTypeKind.Apparent, thisArgument.id);
  let result = c.cachedTypesById.get(key);
  if (result === undefined) {
    result = getTypeWithThisArgument(c, t, thisArgument, true);
    c.cachedTypesById.set(key, result);
  }
  return result;
}

export function getTypeWithThisArgument(
  c: Checker,
  t: Type,
  thisArgument: Type | undefined,
  needApparentType: boolean,
): Type {
  if ((t.objectFlags & ObjectFlags.Reference) !== 0 && (t.flags & TypeFlags.Object) !== 0) {
    const target = (t as TypeReference).target as InterfaceType;
    const typeArguments = getTypeArguments(c, t);
    const count = typeArguments.length;
    if (target.typeParameterCount() !== count) return t;
    const withThis: Type[] = [];
    for (let i = 0; i < count; i++) withThis.push(typeArguments[i]!);
    withThis.push(thisArgument ?? target.thisType!);
    return createTypeReference(c, target, withThis);
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    const types = typesOf(t);
    let changed = false;
    const newTypes: Type[] = [];
    for (const u of types) {
      const n = getTypeWithThisArgument(c, u, thisArgument, needApparentType);
      if (n !== u) changed = true;
      newTypes.push(n);
    }
    return changed ? getIntersectionType(c, newTypes) : t;
  }
  return needApparentType ? getApparentType(c, t) : t;
}

/**
 * Unions with reducible intersections are reduced; intersections with mutually exclusive
 * discriminants are `never`.
 */
export function getReducedType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Union) !== 0) {
    if ((t.objectFlags & ObjectFlags.ContainsIntersections) !== 0) {
      const side = sideOf(c, t as UnionType);
      if (side.resolvedReducedType !== undefined) return side.resolvedReducedType;
      const reduced = getReducedUnionType(c, t as UnionType);
      side.resolvedReducedType = reduced;
      return reduced;
    }
  } else if ((t.flags & TypeFlags.Intersection) !== 0) {
    const side = sideOf(c, t);
    if ((side.objectFlags & ObjectFlags.IsNeverIntersectionComputed) === 0) {
      side.objectFlags |= ObjectFlags.IsNeverIntersectionComputed;
      if (!isMappingOfSameObjectType(c, typesOf(t)) && hasNeverReducedProperty(c, t as IntersectionType))
        side.objectFlags |= ObjectFlags.IsNeverIntersection;
    }
    if ((side.objectFlags & ObjectFlags.IsNeverIntersection) !== 0) return c.neverType;
  }
  return t;
}

/** Whether `types` are mapped types that all map the same object type. */
function isMappingOfSameObjectType(c: Checker, types: readonly Type[]): boolean {
  if (types.length === 0 || (types[0]!.objectFlags & ObjectFlags.Mapped) === 0) return false;
  const first = getModifiersTypeFromMappedType(c, types[0] as MappedType);
  if ((first.flags & TypeFlags.Object) === 0) return false;
  for (let i = 1; i < types.length; i++) {
    const t = types[i]!;
    if ((t.objectFlags & ObjectFlags.Mapped) === 0 || getModifiersTypeFromMappedType(c, t as MappedType) !== first)
      return false;
  }
  return true;
}

/**
 * Whether a property of the intersection `t` reduces it to never, without resolving all of its
 * properties. Such a property is one that createUnionOrIntersectionProperty combines from different
 * properties of two or more constituents, with a literal type among them (a discriminant whose
 * types intersect to never) or a private one (conflicting private properties); a property read from
 * a type is never one itself, since an intersection with one reduces to never and has no
 * properties. So only names with different properties in two constituents, one of them literal or
 * private, are combined, and the costliest constituent's properties are only looked up by name.
 */
function hasNeverReducedProperty(c: Checker, t: IntersectionType): boolean {
  const members = sideOf(c, t).membersOf;
  const resolved = members !== undefined ? members.resolvedProperties : undefined;
  if (resolved !== undefined) {
    for (const p of resolved) if (isNeverReducedProperty(c, p)) return true;
    return false;
  }
  const skipped = getCostliestConstituent(c, t);
  // The other constituents' properties by name, without repeating a symbol.
  const byName = new Map<string, Symbol[]>();
  for (const current of t.types) {
    if (current === skipped) continue;
    for (const prop of getPropertiesOfType(c, current)) {
      const props = byName.get(prop.name);
      if (props === undefined) byName.set(prop.name, [prop]);
      else if (!props.includes(prop)) props.push(prop);
    }
  }
  let skippedType: Type | undefined;
  if (skipped !== undefined) {
    skippedType = getApparentType(c, skipped);
    if (isErrorType(c, skippedType) || (skippedType.flags & TypeFlags.Never) !== 0) skippedType = undefined;
  }
  for (const [name, props] of byName) {
    if (skippedType !== undefined) {
      const prop = getPropertyOfTypeEx(c, skippedType, name, true, false);
      if (prop !== undefined && !props.includes(prop)) props.push(prop);
    }
    if (props.length < 2 || !someLiteralOrPrivateProperty(c, props)) continue;
    const combined = getPropertyOfUnionOrIntersectionType(c, t, name, true);
    if (combined !== undefined && isNeverReducedProperty(c, combined)) return true;
  }
  return false;
}

/** Whether a property of `props` has a literal type or is private, as createUnionOrIntersectionProperty tests them. */
function someLiteralOrPrivateProperty(c: Checker, props: Symbol[]): boolean {
  for (const prop of props) {
    if ((getDeclarationModifierFlagsFromSymbol(c, prop, false) & ModifierFlags.Private) !== 0) return true;
    const t = getTypeOfSymbol(c, prop);
    if (isLiteralType(t) || isPatternLiteralType(c, t)) return true;
  }
  return false;
}

/**
 * The object constituent of `t` whose properties cost the most to read: the one with the most members
 * not instantiated yet, or else the one with the most properties.
 */
function getCostliestConstituent(c: Checker, t: IntersectionType): Type | undefined {
  let costliest: Type | undefined;
  let costliestPending = 0;
  let costliestProperties = 0;
  for (const current of t.types) {
    const apparent = getReducedApparentType(c, current);
    if ((apparent.flags & TypeFlags.Object) === 0) continue;
    const resolved = resolveStructuredTypeMembers(c, apparent);
    const pending = resolved.pendingMembers;
    if (pending !== undefined && pending.materializedProperties === undefined) {
      const size = (pending as PendingInstantiatedMembers).positions.size;
      if (size > costliestPending) {
        costliest = current;
        costliestPending = size;
      }
    } else if (costliestPending === 0 && resolved.propertiesValue.length > costliestProperties) {
      costliest = current;
      costliestProperties = resolved.propertiesValue.length;
    }
  }
  return costliest;
}

function getReducedUnionType(c: Checker, union: UnionType): Type {
  let changed = false;
  const reducedTypes: Type[] = [];
  for (const u of union.types) {
    const r = getReducedType(c, u);
    if (r !== u) changed = true;
    reducedTypes.push(r);
  }
  if (!changed) return union;
  const reduced = getUnionType(c, reducedTypes);
  if ((reduced.flags & TypeFlags.Union) !== 0) sideOf(c, reduced as UnionType).resolvedReducedType = reduced;
  return reduced;
}

function isNeverReducedProperty(c: Checker, prop: Symbol): boolean {
  return isDiscriminantWithNeverType(c, prop) || isConflictingPrivateProperty(prop);
}

export function isDiscriminantWithNeverType(c: Checker, prop: Symbol): boolean {
  // A synthetic required property with non-uniform literal types, none never, reducing to never.
  return (
    (prop.flags & SymbolFlags.Optional) === 0 &&
    (prop.checkFlags & (CheckFlags.NonUniformAndLiteral | CheckFlags.HasNeverType)) ===
      CheckFlags.NonUniformAndLiteral &&
    (getTypeOfSymbol(c, prop).flags & TypeFlags.Never) !== 0
  );
}

export function isConflictingPrivateProperty(prop: Symbol): boolean {
  return prop.valueDeclaration === undefined && (prop.checkFlags & CheckFlags.ContainsPrivate) !== 0;
}

export function getReducedApparentType(c: Checker, t: Type): Type {
  return isOwnReducedApparentType(t) ? t : getReducedApparentTypeWorker(c, t);
}

/**
 * Whether getReducedApparentType returns `t` itself: it is its own apparent type, and no reduction
 * applies to it (getReducedType changes only intersections and unions with intersections). The hot
 * member lookups below test this inline before calling getReducedApparentTypeWorker.
 */
function isOwnReducedApparentType(t: Type): boolean {
  return (
    isOwnApparentType(t) &&
    ((t.flags & TypeFlags.Union) === 0 || (t.objectFlags & ObjectFlags.ContainsIntersections) === 0)
  );
}

function getReducedApparentTypeWorker(c: Checker, t: Type): Type {
  // Apparent types may be unreduced, so reduce before and after. Reducing is idempotent, so an
  // apparent type that is the reduced type itself needs no second pass.
  const reduced = getReducedType(c, t);
  const apparent = getApparentType(c, reduced);
  return apparent === reduced ? reduced : getReducedType(c, apparent);
}

// ---- Base constraints

export function getBaseConstraintOfType(c: Checker, t: Type): Type | undefined {
  if (
    (t.flags &
      (TypeFlags.InstantiableNonPrimitive |
        TypeFlags.UnionOrIntersection |
        TypeFlags.TemplateLiteral |
        TypeFlags.StringMapping |
        TypeFlags.Index)) !==
      0 ||
    isGenericTupleType(t)
  ) {
    const constraint = getResolvedBaseConstraint(c, t);
    return constraint !== c.noConstraintType && constraint !== c.circularConstraintType ? constraint : undefined;
  }
  return undefined;
}

export function getBaseConstraintOrType(c: Checker, t: Type): Type {
  return getBaseConstraintOfType(c, t) ?? t;
}

/** `t` with each constituent replaced by its base constraint. */
export function mapToBaseConstraintOrType(c: Checker, t: Type): Type {
  return mapType(c, t, (u) => getBaseConstraintOrType(c, u));
}

function hasConstrainedTypeData(t: Type): boolean {
  return (
    (t.flags & (TypeFlags.Intrinsic | TypeFlags.Literal | TypeFlags.UniqueESSymbol | TypeFlags.Enum)) === 0 ||
    (t.flags & TypeFlags.StructuredOrInstantiable) !== 0
  );
}

export function getResolvedBaseConstraint(c: Checker, t: Type, stack?: RecursionId[]): Type {
  if (!hasConstrainedTypeData(t)) return t;
  if (t.resolvedBaseConstraint !== undefined) return t.resolvedBaseConstraint;
  const side = sideOf(c, t);
  if (side.resolvedBaseConstraint !== undefined) return side.resolvedBaseConstraint;
  if (!pushTypeResolution(c, t, TypeSystemPropertyName.ResolvedBaseConstraint)) return c.circularConstraintType;
  let constraint: Type | undefined;
  // At least 10 levels; up to 50 without deeply nested types on the stack.
  const identity = getRecursionIdentity(c, t);
  const current = stack ?? [];
  if (current.length < 10 || (current.length < 50 && !current.includes(identity)))
    constraint = computeBaseConstraint(c, getSimplifiedType(c, t, false), current.concat([identity]));
  if (!popTypeResolution(c)) {
    if ((t.flags & TypeFlags.TypeParameter) !== 0) {
      const errorNode = getConstraintDeclaration(t);
      if (errorNode !== undefined)
        c.error(errorNode, Diagnostics.Type_parameter_0_has_a_circular_constraint, typeToString(c, t));
    }
    constraint = c.circularConstraintType;
  }
  if (constraint === undefined) constraint = c.noConstraintType;
  if (side.resolvedBaseConstraint === undefined) side.resolvedBaseConstraint = constraint;
  return constraint;
}

function computeBaseConstraint(c: Checker, t: Type, stack: RecursionId[]): Type | undefined {
  const flags = t.flags;
  if ((flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = getConstraintFromTypeParameter(c, t);
    return (t as TypeParameter).isThisType ? constraint : getNextBaseConstraint(c, constraint, stack);
  }
  if ((flags & TypeFlags.UnionOrIntersection) !== 0) {
    const types = typesOf(t);
    const constraints: Type[] = [];
    let different = false;
    for (const s of types) {
      const constraint = getNextBaseConstraint(c, s, stack);
      if (constraint !== undefined) {
        if (constraint !== s) different = true;
        constraints.push(constraint);
      } else different = true;
    }
    if (!different) return t;
    if ((flags & TypeFlags.Union) !== 0 && constraints.length === types.length) return getUnionType(c, constraints);
    if ((flags & TypeFlags.Intersection) !== 0 && constraints.length !== 0) return getIntersectionType(c, constraints);
    return undefined;
  }
  if ((flags & TypeFlags.Index) !== 0) {
    const target = (t as IndexType).target;
    if (isGenericMappedType(c, target)) {
      if (
        getNameTypeFromMappedType(c, target as MappedType) !== undefined &&
        !isMappedTypeWithKeyofConstraintDeclaration(c, target as MappedType)
      )
        return getNextBaseConstraint(c, getIndexForMappedType(c, target as MappedType), stack);
    }
    return c.stringNumberSymbolType;
  }
  if ((flags & TypeFlags.TemplateLiteral) !== 0) {
    const template = t as TemplateLiteralType;
    const constraints: Type[] = [];
    for (const s of template.types) {
      const constraint = getNextBaseConstraint(c, s, stack);
      if (constraint !== undefined) constraints.push(constraint);
    }
    return constraints.length === template.types.length
      ? getTemplateLiteralType(c, template.texts, constraints)
      : c.stringType;
  }
  if ((flags & TypeFlags.StringMapping) !== 0) {
    const target = (t as StringMappingType).target;
    const constraint = getNextBaseConstraint(c, target, stack);
    return constraint !== undefined && constraint !== target
      ? getStringMappingType(c, t.symbol!, constraint)
      : c.stringType;
  }
  if ((flags & TypeFlags.IndexedAccess) !== 0) {
    const access = t as IndexedAccessType;
    if (isMappedTypeGenericIndexedAccess(c, t))
      return getNextBaseConstraint(
        c,
        substituteIndexedMappedType(c, access.objectType as MappedType, access.indexType),
        stack,
      );
    const baseObjectType = getNextBaseConstraint(c, access.objectType, stack);
    const baseIndexType = getNextBaseConstraint(c, access.indexType, stack);
    if (baseObjectType === undefined || baseIndexType === undefined) return undefined;
    return getNextBaseConstraint(
      c,
      getIndexedAccessTypeOrUndefined(c, baseObjectType, baseIndexType, access.accessFlags),
      stack,
    );
  }
  if ((flags & TypeFlags.Conditional) !== 0) {
    if (c.conditionalConstraintDepth >= 100) return undefined;
    c.conditionalConstraintDepth++;
    const constraint = getConstraintFromConditionalType(c, t);
    c.conditionalConstraintDepth--;
    return getNextBaseConstraint(c, constraint, stack);
  }
  if ((flags & TypeFlags.Substitution) !== 0) return getNextBaseConstraint(c, getSubstitutionIntersection(c, t), stack);
  if (isGenericTupleType(t)) {
    // Substitute constraints of variadic elements only when they're arrays or non-variadic tuples.
    const elementTypes = getElementTypes(c, t);
    const infos = tupleTargetOf(t).elementInfos;
    const newElements: Type[] = [];
    for (let i = 0; i < elementTypes.length; i++) {
      const v = elementTypes[i]!;
      let element = v;
      if ((v.flags & TypeFlags.TypeParameter) !== 0 && (infos[i]!.flags & ElementFlags.Variadic) !== 0) {
        const constraint = getNextBaseConstraint(c, v, stack);
        if (
          constraint !== undefined &&
          constraint !== v &&
          everyType(constraint, (n) => isArrayOrTupleType(c, n) && !isGenericTupleType(n))
        )
          element = constraint;
      }
      newElements.push(element);
    }
    return createTupleTypeEx(c, newElements, infos, tupleTargetOf(t).readonly);
  }
  return t;
}

function getNextBaseConstraint(c: Checker, t: Type | undefined, stack: RecursionId[]): Type | undefined {
  if (t === undefined) return undefined;
  const constraint = getResolvedBaseConstraint(c, t, stack);
  return constraint === c.noConstraintType || constraint === c.circularConstraintType ? undefined : constraint;
}

export function getConstraintOfType(c: Checker, t: Type): Type | undefined {
  if ((t.flags & TypeFlags.TypeParameter) !== 0) return getConstraintOfTypeParameterGuarded(c, t);
  if ((t.flags & TypeFlags.IndexedAccess) !== 0) return getConstraintOfIndexedAccess(c, t as IndexedAccessType);
  if ((t.flags & TypeFlags.Conditional) !== 0) return getConstraintOfConditionalTypeLazy(c, t);
  return getBaseConstraintOfType(c, t);
}

import { getConstraintOfTypeParameter as getConstraintOfTypeParameterGuarded } from './checker-declared-types.js';
import {
  getConstraintOfIndexedAccess,
  getConstraintOfConditionalType as getConstraintOfConditionalTypeLazy,
} from './checker-type-operators.js';

export function isReadonlyArray(c: Checker, t: Type): boolean {
  return isReadonlyArrayType(c, t);
}

export function getTypeFromNodeOrUndefined(c: Checker, node: Node | undefined): Type | undefined {
  return node !== undefined ? getTypeFromTypeNode(c, node) : undefined;
}

export {
  getReturnTypeOfSignature,
  getSymbolOfDeclaration,
  getLateBoundSymbol,
  instantiateTypes,
  createSignatureInstantiation,
  getUnionTypeEx,
  mapType,
};
export type { Symbol };
