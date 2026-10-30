// Results one checker thread computed, as portable records other checker threads translate into their own types
// (TSC_TS_SHARE=1).
//
// A checker exports the result of a declaration-level computation (the value type of a variable or property, or the
// return type of a declared signature) as records: each type the result reaches through its identity (constituents,
// type arguments, alias arguments, instantiation arguments, and the parts of index, indexed access, conditional,
// template, string mapping and substitution types), down to types every checker can get by itself (intrinsic types,
// declared types of symbols, types of declarations and type nodes). Another checker translates the records through
// its own interning caches, so each type still has one object in it.
import { getSymbol, type Node, NodeVisitor, type SourceFile } from './ast.js';
import { getSourceFileOfNode } from './binder-utilities.js';
import type { Checker } from './checker.js';
import { getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import {
  ConditionalType,
  IndexedAccessType,
  IndexType,
  InterfaceType,
  LiteralType,
  MappedType,
  ObjectFlags,
  ObjectType,
  StringMappingType,
  SubstitutionType,
  TemplateLiteralType,
  TupleElementInfo,
  TupleType,
  Type,
  TypeAlias,
  TypeFlags,
  TypeReference,
  UnionOrIntersectionType,
  UnionType,
  getMappedType,
  IndexInfo,
  newTypeMapper,
  Signature,
  SignatureFlags,
  StructuredType,
} from './checker-types.js';
import {
  createTypeReference,
  getBigIntLiteralType,
  getFreshTypeOfLiteralType,
  getNumberLiteralType,
  getStringLiteralType,
  getTemplateLiteralType,
  getTupleTargetType,
  getUnionTypeFromSortedList,
  newIntersectionType,
  newObjectType,
  newUnionType,
  setStructuredTypeMembers,
  getPropagatingFlagsOfTypes,
  typeListHash,
} from './checker-type-factory.js';
import {
  distributedKey,
  getConditionalTypeInstantiation,
  getIndexTypeEx,
  getIndexedAccessTypeEx,
  getNoInferType,
  getStringMappingType,
  getSubstitutionType,
  isNoInferType,
} from './checker-type-operators.js';
import { getESSymbolLikeTypeForNode, getTypeFromTypeNode } from './checker-type-nodes.js';
import { SyntaxKind } from './syntax-kind.js';
import { instantiateTypeWithAlias } from './instantiation.js';
import { resolvedReturnTypeOf, sideOf } from './side-state.js';
import { CheckFlags, getDeclarations, getSymbolId, setDeclarations, type Symbol, SymbolFlags } from './symbol.js';
import { keepPropertiesOnly, scannedLiteralPropertiesLimit } from './checker-members.js';
import { findResolutionCycleStartIndex, TypeSystemPropertyName } from './checker-symbols.js';
import { typeToString } from './type-printer.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getReturnTypeOfSignature } from './checker-signatures.js';

// Functions, classes, enums and modules have anonymous types that are cheap to create; their members are not. (A
// function: a top-level constant computed from an enum member of a module in an import cycle doesn't compile natively.)
function sharedValueFlags(): SymbolFlags {
  return SymbolFlags.Variable | SymbolFlags.Property;
}

const enum RecordKind {
  /** A type the checker creates when it starts: `num` is its position in `initialTypes`. */
  Initial,
  /** A regular literal type: `flags`, `text` or `num`. */
  Literal,
  /** The fresh type of the literal type `refs[0]`. */
  FreshLiteral,
  /** The literal type of the enum member `symbol`. */
  EnumLiteral,
  /** The unique symbol type of `symbol`. */
  UniqueSymbol,
  /** The declared type of `symbol` (class, interface, enum, type parameter). */
  Declared,
  /** The this-type of the declared class or interface type of `symbol`. */
  ThisType,
  /** The type of the value `symbol` (the anonymous type of a function, class, enum or module). */
  SymbolType,
  /** The type of the type node `node` (a type literal, function or constructor type, mapped or conditional type). */
  NodeType,
  /** A reference to the generic type `refs[0]` with the type arguments `refs[1..]`. */
  Reference,
  /** The tuple target with the element flags `nums`, labeled by `nodes`, readonly when `num` is 1. */
  TupleTarget,
  /**
   * The instantiation of the anonymous, mapped or deferred reference type `refs[0]` with the `num` outer type arguments
   * after it, then the return types its signatures had resolved (built after it).
   */
  Instantiation,
  /** A union of `refs`, with the origin `num` (a record index, or -1). */
  Union,
  /** An intersection of `refs`. */
  Intersection,
  /** `keyof refs[0]` with the index flags `num`. */
  Index,
  /** `refs[0][refs[1]]` with the access flags `num`. */
  IndexedAccess,
  /** The instantiation of the conditional type of `node` with outer type arguments `refs`, for constraints when `num` is 1. */
  Conditional,
  /** A template literal type of `texts` and `refs`. */
  Template,
  /** The string mapping `symbol` of `refs[0]`. */
  StringMapping,
  /** A substitution type of `refs[0]` constrained by `refs[1]`. */
  Substitution,
  /** `NoInfer<refs[0]>`. */
  NoInfer,
  /**
   * The member for the constituent `refs[last]` of the distribution of the conditional type of `node` instantiated
   * with outer type arguments `refs[0..last)`, for constraints when `num` is 1.
   */
  DistributedConditional,
  /**
   * An anonymous object type of the object literal `symbol` with members resolved when it was created (an object
   * literal type, or its regular, widened or spread form), with the object flags `flags`. Its members come with the
   * `CompleteObject` record that follows them.
   */
  AnonymousObject,
  /** The members of the `AnonymousObject` record `num`: the properties `refs` and the index infos `indexInfos`. */
  CompleteObject,
  /**
   * A property symbol a checker created (`text` its name, `flags` its symbol flags, `num` its check flags): its
   * declarations `nodes`, value declaration `node`, type `refs[0]`, name type `refs[1]` (or -1), the symbol it was
   * made from `refs[2]` (a property record, or -1 for `symbol`, a symbol of the program) and its parent `aliasSymbol`.
   */
  Property,
}

/** An index signature of an `AnonymousObject` record. */
export class PortableIndexInfo {
  readonly keyType: number;
  readonly valueType: number;
  readonly isReadonly: boolean;
  readonly declaration: Node | undefined;
  readonly components: readonly Node[];

  constructor(
    keyType: number,
    valueType: number,
    isReadonly: boolean,
    declaration: Node | undefined,
    components: readonly Node[],
  ) {
    this.keyType = keyType;
    this.valueType = valueType;
    this.isReadonly = isReadonly;
    this.declaration = declaration;
    this.components = components;
  }
}

export class PortableRecord {
  readonly kind: RecordKind;
  readonly flags: number;
  readonly num: number;
  readonly text: string;
  symbol: Symbol | undefined;
  readonly node: Node | undefined;
  readonly refs: readonly number[];
  nums: readonly number[];
  nodes: readonly (Node | undefined)[];
  texts: readonly string[];
  /** For a symbol a checker merged: the id of a symbol it merged, which keys every checker's merged symbol. */
  mergedId: number;
  /** The alias: its symbol and the records of its type arguments. */
  aliasSymbol: Symbol | undefined;
  aliasMergedId: number;
  aliasRefs: readonly number[];
  indexInfos: readonly PortableIndexInfo[];
  /** The producer's type id, which keys the consumer's translations of the producer's types. */
  readonly id: number;

  constructor(
    kind: RecordKind,
    id: number,
    flags: number,
    num: number,
    text: string,
    symbol: Symbol | undefined,
    node: Node | undefined,
    refs: readonly number[],
  ) {
    this.kind = kind;
    this.id = id;
    this.flags = flags;
    this.num = num;
    this.text = text;
    this.symbol = symbol;
    this.node = node;
    this.refs = refs;
    this.nums = noNumbers;
    this.nodes = noNodes;
    this.texts = noTexts;
    this.mergedId = -1;
    this.aliasSymbol = undefined;
    this.aliasMergedId = -1;
    this.aliasRefs = noNumbers;
    this.indexInfos = noIndexInfos;
  }
}

const noNumbers: readonly number[] = [];
const noNodes: readonly (Node | undefined)[] = [];
const noTexts: readonly string[] = [];
const noIndexInfos: readonly PortableIndexInfo[] = [];

/** The types every checker creates when it starts, in the same order; marker types are left out. */
export function initialTypes(c: Checker): Type[] {
  return [
    c.anyType,
    c.autoType,
    c.wildcardType,
    c.blockedStringType,
    c.errorType,
    c.unresolvedType,
    c.nonInferrableAnyType,
    c.intrinsicMarkerType,
    c.unknownType,
    c.undefinedType,
    c.undefinedWideningType,
    c.missingType,
    c.undefinedOrMissingType,
    c.optionalType,
    c.nullType,
    c.nullWideningType,
    c.stringType,
    c.numberType,
    c.bigintType,
    c.regularFalseType,
    c.falseType,
    c.regularTrueType,
    c.trueType,
    c.booleanType,
    c.esSymbolType,
    c.voidType,
    c.neverType,
    c.silentNeverType,
    c.implicitNeverType,
    c.unreachableNeverType,
    c.nonPrimitiveType,
    c.stringOrNumberType,
    c.stringNumberSymbolType,
    c.numberOrBigIntType,
    c.numericStringType,
    c.templateConstraintType,
    c.uniqueLiteralType,
    c.emptyObjectType,
    c.emptyJsxObjectType,
    c.emptyFreshJsxObjectType,
    c.emptyTypeLiteralType,
    c.unknownEmptyObjectType,
    c.unknownUnionType,
    c.emptyGenericType,
    c.anyFunctionType,
    c.noConstraintType,
    c.circularConstraintType,
    c.resolvingDefaultType,
    c.emptyStringType,
    c.zeroType,
    c.zeroBigIntType,
    c.typeofType,
  ];
}

/** A checker's `Exporter.mergedOrigins`, kept while its merged symbols stay the same. */
export class MergedOrigins {
  origins = new Map<Symbol, number>();
  size = -1;
}

/** Writes a result as records; `failure` names the first part that has no record kind. */
class Exporter {
  readonly c: Checker;
  records: PortableRecord[] = [];
  readonly indexes = new Map<Type, number>();
  /**
   * The index of `records[0]`. A checker's exporter keeps the indexes of the types it exported before
   * (`ThreadSharing.post`): their records are in its store already, and a result's records are only the new ones.
   */
  base = 0;
  /** The types and properties the export in progress gave indexes, which a failed export forgets again. */
  readonly addedTypes: Type[] = [];
  readonly addedProperties: Symbol[] = [];

  /** Appends `record`; its index. */
  push(record: PortableRecord): number {
    const index = this.base + this.records.length;
    this.records.push(record);
    return index;
  }
  readonly initial: Map<Type, number>;
  failure: string | undefined = undefined;

  /** The ids above which nodes and symbols are the checker thread's own (lazily parsed JSDoc), or Infinity. */
  nodeLimit = Infinity;
  symbolLimit = Infinity;

  constructor(c: Checker, initial: Map<Type, number>) {
    this.c = c;
    this.initial = initial;
  }

  /** Whether `node` is one every checker shares; fails if not. */
  sharedNode(node: Node | undefined): boolean {
    if (node === undefined || node.id <= this.nodeLimit) return true;
    this.fail('node of the thread');
    return false;
  }

  /** The ids of the symbols each merged symbol merged (`getMergedSymbol`), built on first use. */
  mergedOrigins: Map<Symbol, number> | undefined = undefined;
  /** Where the checker keeps `mergedOrigins` between exports. */
  originsCache: MergedOrigins | undefined = undefined;

  /**
   * Sets the symbol of `record`: a symbol of the program, which every checker shares, or a symbol the checker merged,
   * by the id of a symbol it merged. Other symbols are the checker's own.
   */
  symbolOf(record: PortableRecord, symbol: Symbol, alias: boolean): boolean {
    let mergedId = -1;
    let shared: Symbol | undefined = symbol;
    if ((symbol.flags & SymbolFlags.Transient) === 0 && getSymbolId(symbol) > this.symbolLimit) {
      this.fail('symbol of the thread');
      return false;
    }
    if ((symbol.flags & SymbolFlags.Transient) !== 0) {
      let origins = this.mergedOrigins;
      if (origins === undefined) {
        const cache = this.originsCache;
        if (cache !== undefined && cache.size === this.c.mergedSymbols.size) origins = cache.origins;
        else {
          origins = new Map<Symbol, number>();
          for (const [id, target] of this.c.mergedSymbols) if (!origins.has(target)) origins.set(target, id);
          if (cache !== undefined) {
            cache.origins = origins;
            cache.size = this.c.mergedSymbols.size;
          }
        }
        this.mergedOrigins = origins;
      }
      const origin = origins.get(symbol);
      if (origin === undefined) {
        this.fail('checker symbol ' + symbol.name);
        return false;
      }
      mergedId = origin;
      shared = undefined;
    }
    if (alias) {
      record.aliasSymbol = shared;
      record.aliasMergedId = mergedId;
    } else {
      record.symbol = shared;
      record.mergedId = mergedId;
    }
    return true;
  }

  /** `new PortableRecord` with the symbol `symbol` (see `symbolOf`); undefined if it is the checker's own. */
  withSymbol(
    kind: RecordKind,
    t: Type,
    symbol: Symbol,
    num: number,
    refs: readonly number[],
  ): PortableRecord | undefined {
    const record = new PortableRecord(kind, t.id, 0, num, '', undefined, undefined, refs);
    return this.symbolOf(record, symbol, false) ? record : undefined;
  }

  addWithSymbol(kind: RecordKind, t: Type, symbol: Symbol, num: number, refs: readonly number[]): number {
    const record = this.withSymbol(kind, t, symbol, num, refs);
    return record === undefined ? -1 : this.add(t, record);
  }

  fail(reason: string): number {
    if (this.failure === undefined) this.failure = reason;
    return -1;
  }

  add(t: Type, record: PortableRecord): number {
    if (!this.sharedNode(record.node)) return -1;
    for (const node of record.nodes) if (!this.sharedNode(node)) return -1;
    for (const info of record.indexInfos) {
      if (!this.sharedNode(info.declaration)) return -1;
      for (const node of info.components) if (!this.sharedNode(node)) return -1;
    }
    const index = this.push(record);
    this.indexes.set(t, index);
    this.addedTypes.push(t);
    return index;
  }

  types(list: readonly Type[]): number[] {
    const refs: number[] = [];
    for (const t of list) {
      refs.push(this.type(t));
      if (this.failure !== undefined) break;
    }
    return refs;
  }

  aliasOf(record: PortableRecord, alias: TypeAlias | undefined): PortableRecord {
    if (alias === undefined) return record;
    const refs = this.types(alias.typeArguments);
    this.symbolOf(record, alias.symbol, true);
    record.aliasRefs = refs;
    return record;
  }

  type(t: Type): number {
    if (this.failure !== undefined) return -1;
    const known = this.indexes.get(t);
    if (known !== undefined) return known;
    const initial = this.initial.get(t);
    if (initial !== undefined)
      return this.add(t, new PortableRecord(RecordKind.Initial, t.id, 0, initial, '', undefined, undefined, noNumbers));
    const c = this.c;
    const flags = t.flags;
    if ((flags & TypeFlags.Literal) !== 0 && (flags & TypeFlags.Boolean) === 0) return this.literal(t as LiteralType);
    if ((flags & TypeFlags.UniqueESSymbol) !== 0) {
      if (c.uniqueESSymbolTypes.get(t.symbol!) !== t) return this.fail('unique symbol');
      return this.addWithSymbol(RecordKind.UniqueSymbol, t, t.symbol!, 0, noNumbers);
    }
    if ((flags & TypeFlags.TypeParameter) !== 0) {
      const symbol = t.symbol;
      if (symbol === undefined) return this.fail('type parameter without a symbol');
      const declared = getDeclaredTypeOfSymbol(c, symbol);
      if (declared === t) return this.addWithSymbol(RecordKind.Declared, t, symbol, 0, noNumbers);
      if ((declared.objectFlags & ObjectFlags.ClassOrInterface) !== 0 && (declared as InterfaceType).thisType === t)
        return this.addWithSymbol(RecordKind.ThisType, t, symbol, 0, noNumbers);
      return this.fail('fresh type parameter');
    }
    if (t.symbol !== undefined && (flags & (TypeFlags.Union | TypeFlags.Enum)) !== 0) {
      // An enum type: the declared type of its symbol.
      if (getDeclaredTypeOfSymbol(c, t.symbol) !== t) return this.fail('enum type');
      return this.addWithSymbol(RecordKind.Declared, t, t.symbol, 0, noNumbers);
    }
    if ((flags & TypeFlags.Union) !== 0) return this.union(t as UnionType);
    if ((flags & TypeFlags.Intersection) !== 0) {
      const refs = this.types((t as UnionOrIntersectionType).types);
      if (this.failure !== undefined) return -1;
      const record = new PortableRecord(
        RecordKind.Intersection,
        t.id,
        t.objectFlags,
        0,
        '',
        undefined,
        undefined,
        refs,
      );
      return this.add(t, this.aliasOf(record, t.alias));
    }
    if ((flags & TypeFlags.Object) !== 0) return this.object(t as ObjectType);
    if ((flags & TypeFlags.Index) !== 0) {
      const target = this.type((t as IndexType).target);
      if (this.failure !== undefined) return -1;
      return this.add(
        t,
        new PortableRecord(RecordKind.Index, t.id, 0, (t as IndexType).indexFlags, '', undefined, undefined, [target]),
      );
    }
    if ((flags & TypeFlags.IndexedAccess) !== 0) {
      const access = t as IndexedAccessType;
      const refs = this.types([access.objectType, access.indexType]);
      if (this.failure !== undefined) return -1;
      const record = new PortableRecord(
        RecordKind.IndexedAccess,
        t.id,
        0,
        this.c.indexedAccessKeyFlags!.get(t) ?? access.accessFlags,
        '',
        undefined,
        undefined,
        refs,
      );
      return this.add(t, this.aliasOf(record, t.alias));
    }
    if ((flags & TypeFlags.Conditional) !== 0) return this.conditional(t as ConditionalType);
    if ((flags & TypeFlags.TemplateLiteral) !== 0) {
      const template = t as TemplateLiteralType;
      const refs = this.types(template.types);
      if (this.failure !== undefined) return -1;
      const record = new PortableRecord(RecordKind.Template, t.id, 0, 0, '', undefined, undefined, refs);
      record.texts = template.texts.slice();
      return this.add(t, record);
    }
    if ((flags & TypeFlags.StringMapping) !== 0) {
      const target = this.type((t as StringMappingType).target);
      if (this.failure !== undefined) return -1;
      return this.addWithSymbol(RecordKind.StringMapping, t, t.symbol!, 0, [target]);
    }
    if ((flags & TypeFlags.Substitution) !== 0) {
      const substitution = t as SubstitutionType;
      if (isNoInferType(c, t)) {
        const base = this.type(substitution.baseType);
        if (this.failure !== undefined) return -1;
        return this.add(t, new PortableRecord(RecordKind.NoInfer, t.id, 0, 0, '', undefined, undefined, [base]));
      }
      const refs = this.types([substitution.baseType, substitution.constraint]);
      if (this.failure !== undefined) return -1;
      return this.add(t, new PortableRecord(RecordKind.Substitution, t.id, 0, 0, '', undefined, undefined, refs));
    }
    return this.fail('type flags ' + flags);
  }

  literal(t: LiteralType): number {
    const regular = t.regularType;
    if (regular !== t) {
      if (regular.freshType !== t) return this.fail('literal');
      const index = this.type(regular);
      if (this.failure !== undefined) return -1;
      return this.add(t, new PortableRecord(RecordKind.FreshLiteral, t.id, 0, 0, '', undefined, undefined, [index]));
    }
    if (t.symbol !== undefined) {
      if (getDeclaredTypeOfSymbol(this.c, t.symbol) !== t) return this.fail('enum literal');
      return this.addWithSymbol(RecordKind.EnumLiteral, t, t.symbol, 0, noNumbers);
    }
    return this.add(
      t,
      new PortableRecord(
        RecordKind.Literal,
        t.id,
        t.flags,
        t.numberValue,
        t.stringValue,
        undefined,
        undefined,
        noNumbers,
      ),
    );
  }

  union(t: UnionType): number {
    const refs = this.types(t.types);
    let origin = -1;
    if (t.origin !== undefined) {
      const o = t.origin;
      if ((o.flags & TypeFlags.UnionOrIntersection) !== 0) {
        // Origins are not interned: a union key spells their constituents.
        const parts = this.types((o as UnionOrIntersectionType).types);
        if (this.failure !== undefined) return -1;
        const kind = (o.flags & TypeFlags.Union) !== 0 ? RecordKind.Union : RecordKind.Intersection;
        origin = this.push(new PortableRecord(kind, -1, o.objectFlags, -2, '', undefined, undefined, parts));
      } else origin = this.type(o);
    }
    if (this.failure !== undefined) return -1;
    const record = new PortableRecord(RecordKind.Union, t.id, t.objectFlags, origin, '', undefined, undefined, refs);
    return this.add(t, this.aliasOf(record, t.alias));
  }

  object(t: ObjectType): number {
    const c = this.c;
    const objectFlags = t.objectFlags;
    const symbol = t.symbol;
    if ((objectFlags & ObjectFlags.Reference) !== 0) {
      const reference = t as TypeReference;
      if (reference.node !== undefined) return this.instantiation(t);
      const target = reference.target!;
      if (target === t) {
        if ((objectFlags & ObjectFlags.Tuple) !== 0) return this.tupleTarget(t as TupleType);
        if (symbol === undefined || getDeclaredTypeOfSymbol(c, symbol) !== t) return this.fail('generic target');
        return this.addWithSymbol(RecordKind.Declared, t, symbol, 0, noNumbers);
      }
      const refs = [this.type(target), ...this.types(reference.resolvedTypeArguments ?? [])];
      if (this.failure !== undefined) return -1;
      return this.add(t, new PortableRecord(RecordKind.Reference, t.id, 0, 0, '', undefined, undefined, refs));
    }
    if ((objectFlags & ObjectFlags.ClassOrInterface) !== 0) {
      if (symbol === undefined || getDeclaredTypeOfSymbol(c, symbol) !== t) return this.fail('declared type');
      return this.addWithSymbol(RecordKind.Declared, t, symbol, 0, noNumbers);
    }
    if ((objectFlags & (ObjectFlags.ReverseMapped | ObjectFlags.EvolvingArray)) !== 0) return this.fail('object kind');
    if ((objectFlags & ObjectFlags.Instantiated) !== 0) return this.instantiation(t);
    if ((objectFlags & (ObjectFlags.Anonymous | ObjectFlags.Mapped)) === 0 || symbol === undefined)
      return this.fail('object without a declaration, object flags ' + objectFlags);
    // The anonymous type of a function, class, enum or module; a variable's own type is what is being shared.
    if ((symbol.flags & sharedValueFlags()) === 0 && c.symbolTypes.get(getSymbolId(symbol)) === t)
      return this.addWithSymbol(RecordKind.SymbolType, t, symbol, 0, noNumbers);
    const declaration = (objectFlags & ObjectFlags.Mapped) !== 0 ? (t as MappedType).declaration : symbol.declaration;
    if (declaration !== undefined && c.resolvedTypes.get(declaration.id) === t)
      return this.add(t, new PortableRecord(RecordKind.NodeType, t.id, 0, 0, '', undefined, declaration, noNumbers));
    if (
      (symbol.flags & SymbolFlags.ObjectLiteral) !== 0 &&
      (objectFlags & (ObjectFlags.Anonymous | ObjectFlags.MembersResolved)) ===
        (ObjectFlags.Anonymous | ObjectFlags.MembersResolved)
    )
      return this.anonymousObject(t);
    return this.fail(
      'anonymous type ' +
        ((objectFlags & ObjectFlags.ObjectLiteral) !== 0 ? 'object literal ' : '') +
        'symbol flags ' +
        symbol.flags +
        ' declaration kind ' +
        (symbol.declaration?.kind ?? -1) +
        ' object flags ' +
        objectFlags,
    );
  }

  /** An object literal type, or one made from one, with its properties and index infos. */
  anonymousObject(t: ObjectType): number {
    const c = this.c;
    if ((t.objectFlags & ObjectFlags.SideState) !== 0 || c.patternForType.has(t))
      return this.fail('object literal state');
    const resolved = t as StructuredType;
    if (resolved.callSignatures.length !== 0 || resolved.constructSignatures.length !== 0)
      return this.fail('object literal signatures');
    const shell = new PortableRecord(
      RecordKind.AnonymousObject,
      t.id,
      t.objectFlags & ~lazyObjectFlags(),
      0,
      '',
      undefined,
      undefined,
      noNumbers,
    );
    if (!this.symbolOf(shell, t.symbol!, false)) return -1;
    const index = this.add(t, shell);
    const members: number[] = [];
    for (const prop of resolved.properties) {
      members.push(this.property(prop));
      if (this.failure !== undefined) return -1;
    }
    const infos: PortableIndexInfo[] = [];
    for (const info of resolved.indexInfos) {
      const key = this.type(info.keyType);
      const value = this.type(info.valueType);
      if (this.failure !== undefined) return -1;
      infos.push(new PortableIndexInfo(key, value, info.isReadonly, info.declaration, info.components.slice()));
    }
    const complete = new PortableRecord(RecordKind.CompleteObject, -1, 0, index, '', undefined, undefined, members);
    complete.indexInfos = infos;
    this.push(complete);
    return index;
  }

  /** The records of property symbols, by symbol. */
  readonly properties = new Map<Symbol, number>();

  /** A property symbol of an object literal type: a checker's own, made from one of the program or from another. */
  property(prop: Symbol): number {
    const known = this.properties.get(prop);
    if (known !== undefined) return known;
    const c = this.c;
    if ((prop.flags & SymbolFlags.Transient) === 0) return this.fail('property of the program');
    if ((prop.checkFlags & ~(CheckFlags.Readonly | CheckFlags.Late)) !== 0)
      return this.fail('property check flags ' + prop.checkFlags);
    const id = getSymbolId(prop);
    const t = c.symbolTypes.get(id);
    if (t === undefined) return this.fail('property without a type');
    const type = this.type(t);
    const nameType = c.symbolNameTypes.get(id);
    const name = nameType === undefined ? -1 : this.type(nameType);
    if (this.failure !== undefined) return -1;
    const source = c.symbolTargets.get(id);
    let target = -1;
    let program: Symbol | undefined = undefined;
    if (source !== undefined) {
      if ((source.flags & SymbolFlags.Transient) !== 0) {
        target = this.property(source);
        if (this.failure !== undefined) return -1;
      } else program = source;
    }
    const record = new PortableRecord(
      RecordKind.Property,
      -1,
      prop.flags,
      prop.checkFlags,
      prop.name,
      program,
      prop.valueDeclaration,
      [type, name, target],
    );
    record.nodes = getDeclarations(prop).slice();
    if (prop.parent !== undefined && !this.symbolOf(record, prop.parent, true)) return -1;
    if (program !== undefined && getSymbolId(program) > this.symbolLimit) return this.fail('symbol of the thread');
    if (!this.sharedNode(prop.valueDeclaration)) return -1;
    for (const node of record.nodes) if (!this.sharedNode(node)) return -1;
    const index = this.push(record);
    this.properties.set(prop, index);
    this.addedProperties.push(prop);
    return index;
  }

  tupleTarget(t: TupleType): number {
    const record = new PortableRecord(
      RecordKind.TupleTarget,
      t.id,
      0,
      t.readonly ? 1 : 0,
      '',
      undefined,
      undefined,
      noNumbers,
    );
    const nums: number[] = [];
    const nodes: (Node | undefined)[] = [];
    for (const info of t.elementInfos) {
      nums.push(info.flags);
      nodes.push(info.labeledDeclaration);
    }
    record.nums = nums;
    record.nodes = nodes;
    return this.add(t, record);
  }

  /** An instantiated anonymous or mapped type, or a deferred type reference: its target and outer type arguments. */
  instantiation(t: ObjectType): number {
    const c = this.c;
    const objectFlags = t.objectFlags;
    if ((objectFlags & ObjectFlags.SingleSignatureType) !== 0) return this.fail('single signature type');
    let declaration: Node | undefined;
    let target: ObjectType;
    if ((objectFlags & ObjectFlags.Reference) !== 0) {
      declaration = (t as TypeReference).node;
      target = c.resolvedTypes.get(declaration!.id) as ObjectType;
      if (target === undefined) return this.fail('deferred reference');
    } else {
      if ((objectFlags & ObjectFlags.InstantiationExpressionType) !== 0) return this.fail('instantiation expression');
      declaration = t.symbol?.declaration;
      target = t.target as ObjectType;
    }
    if (declaration !== undefined && t.mapper === undefined && c.resolvedTypes.get(declaration.id) === t)
      return this.add(t, new PortableRecord(RecordKind.NodeType, t.id, 0, 0, '', undefined, declaration, noNumbers));
    if (declaration === undefined || target === undefined || t.mapper === undefined)
      return this.fail('instantiation, declaration ' + (declaration?.kind ?? -1) + ' target ' + (target !== undefined));
    const typeParameters = c.nodeLinks(declaration).outerTypeParameters;
    if (typeParameters === undefined) return this.fail('instantiation without type parameters');
    const args: Type[] = [];
    for (const tp of typeParameters) args.push(getMappedType(tp, t.mapper));
    const generic = sideOf(c, target);
    if (generic.instantiations?.get(typeListHash(args, t.alias, 0), args, t.alias, 0) !== t)
      return this.fail('instantiation not found');
    const refs = [this.type(target), ...this.types(args)];
    if (this.failure !== undefined) return -1;
    const record = new PortableRecord(RecordKind.Instantiation, t.id, 0, args.length, '', undefined, declaration, refs);
    const index = this.add(t, this.aliasOf(record, t.alias));
    if (index >= 0) this.resolvedReturnTypes(t, refs);
    return index;
  }

  /**
   * Adds to `refs` the return types the checker resolved for the signatures of the instantiation `t`, exported after
   * it. The consumer then creates them right after `t` and before the types that contain it, as this checker did:
   * inference stops at references whose type ids grow along its stack (`isDeeplyNestedType`), so a consumer that
   * created them later, when it resolved them, could stop an inference this checker made.
   */
  resolvedReturnTypes(t: ObjectType, refs: number[]): void {
    if ((t.objectFlags & ObjectFlags.MembersResolved) === 0) return;
    for (const signatures of [t.callSignatures, t.constructSignatures])
      for (const signature of signatures) {
        const returnType = resolvedReturnTypeOf(this.c, signature);
        if (returnType === undefined) continue;
        const index = this.optionalType(returnType);
        if (index >= 0) refs.push(index);
      }
  }

  /** The record of `t`, or -1 if it can't be exported; that leaves the export in progress as it was. */
  optionalType(t: Type): number {
    const records = this.records.length;
    const types = this.addedTypes.length;
    const properties = this.addedProperties.length;
    const index = this.type(t);
    if (this.failure === undefined) return index;
    for (let i = types; i < this.addedTypes.length; i++) this.indexes.delete(this.addedTypes[i]!);
    for (let i = properties; i < this.addedProperties.length; i++) this.properties.delete(this.addedProperties[i]!);
    this.addedTypes.length = types;
    this.addedProperties.length = properties;
    this.records.length = records;
    this.failure = undefined;
    return -1;
  }

  conditional(t: ConditionalType): number {
    const root = t.root;
    if (t.mapper === undefined) {
      if (this.c.resolvedTypes.get(root.node.id) !== t) return this.fail('conditional type');
      return this.add(t, new PortableRecord(RecordKind.NodeType, t.id, 0, 0, '', undefined, root.node, noNumbers));
    }
    const args: Type[] = [];
    for (const tp of root.outerTypeParameters) args.push(getMappedType(tp, t.mapper));
    let tag = -1;
    for (let k = 0; k < 2 && tag < 0; k++)
      if (root.instantiations.get(typeListHash(args, t.alias, k), args, t.alias, k) === t) tag = k;
    if (tag < 0) {
      const keyed = this.c.conditionalResults?.get(t);
      if (keyed !== undefined) {
        const refs = this.types(keyed.typeArguments);
        if (this.failure !== undefined) return -1;
        const record = new PortableRecord(
          RecordKind.Conditional,
          t.id,
          0,
          keyed.tag,
          '',
          undefined,
          keyed.root.node,
          refs,
        );
        return this.add(t, this.aliasOf(record, keyed.alias));
      }
      const distributed = this.c.distributedConditionals?.get(t);
      if (distributed === undefined) return this.fail('conditional instantiation not found');
      const refs = this.types([...distributed.typeArguments, distributed.constituent]);
      if (this.failure !== undefined) return -1;
      const record = new PortableRecord(
        RecordKind.DistributedConditional,
        t.id,
        0,
        distributed.tag,
        '',
        undefined,
        root.node,
        refs,
      );
      return this.add(t, this.aliasOf(record, distributed.alias));
    }
    const refs = this.types(args);
    if (this.failure !== undefined) return -1;
    const record = new PortableRecord(RecordKind.Conditional, t.id, 0, tag, '', undefined, root.node, refs);
    return this.add(t, this.aliasOf(record, t.alias));
  }
}

/** Object flags that checkers compute after creating a type (a function: see `sharedValueFlags`). */
function lazyObjectFlags(): ObjectFlags {
  return (
    ObjectFlags.CouldContainTypeVariablesComputed |
    ObjectFlags.CouldContainTypeVariables |
    ObjectFlags.MembersResolved |
    ObjectFlags.SideState |
    ObjectFlags.IdenticalBaseTypeCalculated |
    ObjectFlags.IdenticalBaseTypeExists
  );
}

/** Translates records into a checker's own types; one translation per producer type. */
export class Translator {
  readonly c: Checker;
  readonly translated = new Map<number, Type>();
  readonly initial: Type[];
  /** Set when a record has no counterpart here; the translation is then abandoned. */
  failed = false;

  constructor(c: Checker) {
    this.c = c;
    this.initial = initialTypes(c);
  }

  /** A property symbol made as the producer made it. */
  property(r: PortableRecord, types: Type[], symbols: (Symbol | undefined)[]): Symbol {
    const c = this.c;
    const prop = c.newSymbolWithCheckFlags(r.flags & ~SymbolFlags.Transient, r.text, r.num);
    setDeclarations(prop, r.nodes as Node[]);
    prop.valueDeclaration = r.node;
    if (r.aliasSymbol !== undefined || r.aliasMergedId >= 0)
      prop.parent = r.aliasMergedId >= 0 ? c.mergedSymbols.get(r.aliasMergedId)! : r.aliasSymbol;
    const id = getSymbolId(prop);
    c.symbolTypes.set(id, types[r.refs[0]!]!);
    if (r.refs[1]! >= 0) c.symbolNameTypes.set(id, types[r.refs[1]!]!);
    const target = r.refs[2]! >= 0 ? symbols[r.refs[2]!] : r.symbol;
    if (target !== undefined) c.symbolTargets.set(id, target);
    return prop;
  }

  /** Sets the members of the `AnonymousObject` record a `CompleteObject` record completes. */
  complete(r: PortableRecord, types: Type[], symbols: (Symbol | undefined)[]): void {
    const c = this.c;
    const t = types[r.num]!;
    if ((t.objectFlags & ObjectFlags.MembersResolved) !== 0) return;
    const members = new Map<string, Symbol>();
    for (const i of r.refs) {
      const prop = symbols[i]!;
      members.set(prop.name, prop);
    }
    const infos = r.indexInfos.map(
      (info) =>
        new IndexInfo(
          types[info.keyType]!,
          types[info.valueType]!,
          info.isReadonly,
          info.declaration,
          info.components as Node[],
        ),
    );
    setStructuredTypeMembers(c, t, members, [], [], infos);
    keepPropertiesOnly(c, t as StructuredType, members, scannedLiteralPropertiesLimit);
  }

  record(r: PortableRecord, types: Type[]): Type {
    if (r.id >= 0) {
      const known = this.translated.get(r.id);
      if (known !== undefined) return known;
    }
    const t = this.build(r, types);
    if (r.id >= 0 && !this.failed) this.translated.set(r.id, t);
    return t;
  }

  /**
   * Resolves the declared type of the type alias whose declaration contains the type node `node`, as resolving its
   * nodes through the alias does: that records the alias's type parameters, which its variances are measured with.
   * Sets `failed` if the alias's declared type is being resolved here.
   */
  aliasOfNode(node: Node): void {
    const c = this.c;
    for (let n: Node | undefined = node; n !== undefined; n = n.parent) {
      if (n.kind !== SyntaxKind.TypeAliasDeclaration && n.kind !== SyntaxKind.JSTypeAliasDeclaration) continue;
      const symbol = getSymbol(n);
      if (symbol === undefined || c.symbolLinks(symbol).declaredType !== undefined) return;
      if (findResolutionCycleStartIndex(c, symbol, TypeSystemPropertyName.DeclaredType) >= 0) this.failed = true;
      else getDeclaredTypeOfSymbol(c, symbol);
      return;
    }
  }

  alias(r: PortableRecord, types: Type[]): TypeAlias | undefined {
    if (r.aliasSymbol === undefined && r.aliasMergedId < 0) return undefined;
    const symbol = r.aliasMergedId >= 0 ? this.c.mergedSymbols.get(r.aliasMergedId)! : r.aliasSymbol!;
    // An instantiation of an alias follows its declared type, which records the alias's type parameters.
    getDeclaredTypeOfSymbol(this.c, symbol);
    return new TypeAlias(
      symbol,
      r.aliasRefs.map((i) => types[i]!),
    );
  }

  symbol(r: PortableRecord): Symbol {
    return r.mergedId >= 0 ? this.c.mergedSymbols.get(r.mergedId)! : r.symbol!;
  }

  build(r: PortableRecord, types: Type[]): Type {
    const c = this.c;
    // An instantiation's refs end with the return types of its signatures, which are built after it.
    const own = r.kind === RecordKind.Instantiation ? r.refs.slice(0, 1 + r.num) : r.refs;
    const refs = own.map((i) => types[i]!);
    switch (r.kind) {
      case RecordKind.Initial:
        return this.initial[r.num]!;
      case RecordKind.Literal:
        if ((r.flags & TypeFlags.StringLiteral) !== 0) return getStringLiteralType(c, r.text);
        if ((r.flags & TypeFlags.NumberLiteral) !== 0) return getNumberLiteralType(c, r.num);
        return getBigIntLiteralType(c, r.text);
      case RecordKind.FreshLiteral:
        return getFreshTypeOfLiteralType(c, refs[0]!);
      case RecordKind.EnumLiteral:
      case RecordKind.Declared:
        return getDeclaredTypeOfSymbol(c, this.symbol(r));
      case RecordKind.ThisType:
        return (getDeclaredTypeOfSymbol(c, this.symbol(r)) as InterfaceType).thisType!;
      case RecordKind.UniqueSymbol:
        return getESSymbolLikeTypeForNode(c, this.symbol(r).valueDeclaration!);
      case RecordKind.SymbolType:
        return getTypeOfSymbol(c, this.symbol(r));
      case RecordKind.NodeType: {
        const node = r.node!;
        const cached = c.resolvedTypes.get(node.id);
        if (cached !== undefined) return cached;
        this.aliasOfNode(node);
        if (this.failed) return c.errorType;
        const t = getTypeFromTypeNode(c, node);
        return c.resolvedTypes.get(node.id) ?? t;
      }
      case RecordKind.Reference:
        return createTypeReference(c, refs[0]!, refs.slice(1));
      case RecordKind.TupleTarget: {
        const infos: TupleElementInfo[] = [];
        for (let i = 0; i < r.nums.length; i++) infos.push(new TupleElementInfo(r.nums[i]!, r.nodes[i]));
        return getTupleTargetType(c, infos, r.num === 1);
      }
      case RecordKind.Instantiation: {
        const target = refs[0]!;
        const typeParameters = outerTypeParametersOf(c, r.node!, target);
        return instantiateTypeWithAlias(
          c,
          target,
          newTypeMapper(typeParameters, refs.slice(1, 1 + r.num)),
          this.alias(r, types),
        );
      }
      case RecordKind.Union: {
        if (r.num === -2) return newUnionType(c, r.flags & ObjectFlags.None, refs);
        const origin = r.num >= 0 ? types[r.num] : undefined;
        return getUnionTypeFromSortedList(
          c,
          refs,
          r.flags & (ObjectFlags.PrimitiveUnion | ObjectFlags.ContainsIntersections),
          this.alias(r, types),
          origin,
        );
      }
      case RecordKind.Intersection: {
        if (r.num === -2) return newIntersectionType(c, ObjectFlags.None, refs);
        const alias = this.alias(r, types);
        const hash = typeListHash(refs, alias, 0);
        const existing = c.intersectionTypes.get(hash, refs, alias, 0);
        if (existing !== undefined) return existing;
        const result = newIntersectionType(
          c,
          (r.flags & ObjectFlags.IsConstrainedTypeVariable) | getPropagatingFlagsOfTypes(refs, TypeFlags.Nullable),
          refs,
        );
        result.alias = alias;
        c.intersectionTypes.set(hash, refs, alias, 0, result);
        return result;
      }
      case RecordKind.Index:
        return getIndexTypeEx(c, refs[0]!, r.num);
      case RecordKind.IndexedAccess:
        return getIndexedAccessTypeEx(c, refs[0]!, refs[1]!, r.num, undefined, this.alias(r, types));
      case RecordKind.Conditional: {
        this.aliasOfNode(r.node!);
        if (this.failed) return c.errorType;
        const declared = c.resolvedTypes.get(r.node!.id) ?? getTypeFromTypeNode(c, r.node!);
        const root = (declared as ConditionalType).root;
        return getConditionalTypeInstantiation(
          c,
          declared as ConditionalType,
          newTypeMapper(root.outerTypeParameters, refs),
          r.num === 1,
          this.alias(r, types),
        );
      }
      case RecordKind.DistributedConditional: {
        this.aliasOfNode(r.node!);
        if (this.failed) return c.errorType;
        const declared = (c.resolvedTypes.get(r.node!.id) ?? getTypeFromTypeNode(c, r.node!)) as ConditionalType;
        const root = declared.root;
        const args = refs.slice(0, refs.length - 1);
        const alias = this.alias(r, types);
        getConditionalTypeInstantiation(c, declared, newTypeMapper(root.outerTypeParameters, args), r.num === 1, alias);
        const member = c.distributedByKey?.get(
          distributedKey(root.node.id, args, alias, r.num, refs[refs.length - 1]!),
        );
        if (member === undefined) this.failed = true;
        return member ?? c.errorType;
      }
      case RecordKind.Template:
        return getTemplateLiteralType(c, r.texts.slice(), refs);
      case RecordKind.StringMapping:
        return getStringMappingType(c, this.symbol(r), refs[0]!);
      case RecordKind.Substitution:
        return getSubstitutionType(c, refs[0]!, refs[1]!);
      case RecordKind.NoInfer:
        return getNoInferType(c, refs[0]!);
      case RecordKind.AnonymousObject:
        return newObjectType(c, r.flags | ObjectFlags.Anonymous, this.symbol(r));
      case RecordKind.CompleteObject:
      case RecordKind.Property:
        return c.errorType;
    }
  }
}

/** The outer type parameters an instantiation of `target` (declared at `declaration`) maps, as instantiation computes them. */
function outerTypeParametersOf(c: Checker, declaration: Node, target: Type): Type[] {
  const known = c.nodeLinks(declaration).outerTypeParameters;
  if (known !== undefined) return known;
  // The first instantiation records them; an identity instantiation computes them without creating a type.
  const probe = c.nodeLinks(declaration);
  instantiateTypeWithAlias(c, target, newTypeMapper([c.anyType], [c.anyType]), undefined);
  return probe.outerTypeParameters ?? [];
}

/** Whether the type of `symbol` is shared: a variable or property declared in the program, other than parameters. */
export function isSharedValueSymbol(symbol: Symbol): boolean {
  if (symbol.checkFlags !== 0 || (symbol.flags & SymbolFlags.Transient) !== 0) return false;
  if ((symbol.flags & sharedValueFlags()) === 0) return false;
  const declaration = symbol.valueDeclaration;
  return (
    declaration !== undefined &&
    declaration.kind !== SyntaxKind.Parameter &&
    declaration.kind !== SyntaxKind.BindingElement
  );
}

/** Whether the return type of `sig` is shared: the signature of a declaration, as `getSignatureFromDeclaration` makes it. */
export function isSharedReturnSignature(c: Checker, sig: Signature): boolean {
  const declaration = sig.declaration;
  return (
    declaration !== undefined &&
    sig.target === undefined &&
    sig.composite === undefined &&
    (sig.flags & (SignatureFlags.IsInnerCallChain | SignatureFlags.IsOuterCallChain)) === 0 &&
    c.resolvedSignatures.get(declaration.id) === sig
  );
}

// ---- Sharing between checker threads (TSC_TS_SHARE=1)
//
// Checker threads take files from the shared queue as without sharing, and record which checker took each file
// (`ThreadSharingData.takers`). When a checker needs the value type of a variable or property, or the return type of a
// declared signature, declared in a file another checker took, it looks the declaration up in a table all threads
// share (`ResultTable`): a result another checker posted is translated, unless that checker's computation reported
// diagnostics in a file this one checks or may check; otherwise the checker computes the result itself. After
// computing a result that took long enough and met no resolution cycle, a checker exports it into its store (each type
// once) and posts it. A checker that took results for declarations of a file no checker took yet never checks that
// file: it hands the file on to another checker (`forbidden`, `handoff`), which then computes them itself, as the
// checker of a file always does.

/** Whether checker threads share results (TSC_TS_SHARE=1). */
export const shareThreads = process.env.TSC_TS_SHARE === '1';

/**
 * What a checker thread needs to share results with the others; posted in its `workerData` (a plain object: class
 * instances arrive without their class).
 */
export interface ThreadSharingData {
  readonly index: number;
  readonly count: number;
  /**
   * For each file, by file index: -2 if no checker checks it, -1 if checkers check it in statement ranges, 0 until a
   * checker takes it, and 1 + k once checker k took it.
   */
  readonly takers: SharedArrayBuffer;
  /**
   * For each file, by file index, the checkers (one bit each) that took a result for a declaration in it before any
   * checker took the file: they never check it, and hand its positions on (`handoff`).
   */
  readonly forbidden: SharedArrayBuffer;
  /**
   * Positions of the order a checker handed on: a lock, their number, the number of checkers that may still hand
   * positions on, then the positions.
   */
  readonly handoff: SharedArrayBuffer;
  readonly typeTable: SharedArrayBuffer;
  readonly returnTable: SharedArrayBuffer;
  /** The ids above which nodes and symbols are a thread's own. */
  readonly nodeIds: number;
  readonly symbolIds: number;
  /**
   * Each checker's store of the records of the results it shares, by checker index: their numbers, and the code units
   * of their strings. `used` has two counters per checker, how much of each it wrote. (Results go through shared
   * memory: a message a worker receives synchronously makes the native build store the number fields of classes as
   * doubles.)
   */
  readonly numberLogs: SharedArrayBuffer[];
  readonly stringLogs: SharedArrayBuffer[];
  readonly used: SharedArrayBuffer;
  /** For each checker, where each record of its store is in its number log, and each object's completion. */
  readonly recordTables: SharedArrayBuffer[];
}

/**
 * The size of each checker's logs: numbers (int32s) and string code units (2 bytes each), 8 MB and 2 MB. Only the
 * pages a checker writes take memory.
 */
export const numberLogSize = 1 << 21;
export const stringLogSize = 1 << 20;

/** The number of records each checker's store can hold. */
export const recordTableSize = 1 << 20;

/** The number of entries of each result table: a power of two. */
export const resultTableSize = 1 << 20;

/**
 * The most checker threads that share results: a result's state (`postedState`) holds the checker and an offset in
 * its number log, below `numberLogSize` (2^21), in one int32, so the count times 2^21 stays below 2^31 - 2.
 */
export const maxSharingCheckers = 1023;

/** The state of the result checker `producer` of `count` posted at `offset` of its number log. */
export function postedState(count: number, producer: number, offset: number): number {
  return -2 - (producer + count * offset);
}

/** The checker that posted the result of `state`, of `count` checkers. */
export function postedProducer(count: number, state: number): number {
  return (-2 - state) % count;
}

/** The offset in its producer's number log of the result of `state`, of `count` checkers. */
export function postedOffset(count: number, state: number): number {
  return Math.floor((-2 - state) / count);
}

/** The int32 words of each file's forbidden bits (`ThreadSharingData.forbidden`): a bit for each of `count` checkers. */
export function forbiddenWords(count: number): number {
  return (count + 31) >>> 5;
}

/** Whether checker `index` of `count` took results for declarations of file `file` before any checker took it. */
export function isForbidden(forbidden: Int32Array, count: number, file: number, index: number): boolean {
  return (Atomics.load(forbidden, file * forbiddenWords(count) + (index >>> 5)) & (1 << (index & 31))) !== 0;
}

/**
 * An open-addressing table in a SharedArrayBuffer, from a key (a symbol or node id) to a result's state: 0 until a
 * checker posts it, then `postedState`.
 */
export class ResultTable {
  readonly words: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.words = new Int32Array(buffer);
  }

  /** The slot of `key`, inserted if absent; -1 if the table is full. */
  slot(key: number): number {
    const words = this.words;
    const mask = resultTableSize - 1;
    let h = Math.imul(key, 0x9e3779b1) >>> 12;
    for (let probe = 0; probe < 64; probe++) {
      const i = (h + probe) & mask;
      const existing = Atomics.load(words, 2 * i);
      if (existing === key + 1) return i;
      if (existing === 0) {
        const previous = Atomics.compareExchange(words, 2 * i, 0, key + 1);
        if (previous === 0 || previous === key + 1) return i;
      }
    }
    return -1;
  }

  state(slot: number): number {
    return Atomics.load(this.words, 2 * slot + 1);
  }

  /** The slot of `key`, or -1 if it has none. */
  find(key: number): number {
    const words = this.words;
    const mask = resultTableSize - 1;
    let h = Math.imul(key, 0x9e3779b1) >>> 12;
    for (let probe = 0; probe < 64; probe++) {
      const i = (h + probe) & mask;
      const existing = Atomics.load(words, 2 * i);
      if (existing === key + 1) return i;
      if (existing === 0) return -1;
    }
    return -1;
  }

  /** Sets the state of `slot` to a posted result's unless one is there already. */
  publish(slot: number, state: number): void {
    Atomics.compareExchange(this.words, 2 * slot + 1, 0, state);
  }
}

/** TSC_TS_SHARE_MIN_MS: the shortest computation a checker posts, in milliseconds (32 divided by the checkers by default). */
const shareMinValue = process.env.TSC_TS_SHARE_MIN_MS;
// Debugging: TSC_TS_SHARE_BLOCK and TSC_TS_SHARE_ALLOW name parts of file names (comma-separated, each optionally with
// a range of declaration positions, `name@start-end`) whose results are never or only translated, and
// TSC_TS_SHARE_TRACE=1 prints each translation.
const shareBlockValue = process.env.TSC_TS_SHARE_BLOCK;
const shareAllowValue = process.env.TSC_TS_SHARE_ALLOW;
const shareTraceValue = process.env.TSC_TS_SHARE_TRACE;
// Debugging: TSC_TS_SHARE_VERIFY=1 computes each result a checker could translate, translates it after, and prints
// the results whose translation prints differently.
const shareVerifyValue = process.env.TSC_TS_SHARE_VERIFY;

/** Checks a translation against the computation it replaces (TSC_TS_SHARE_VERIFY). */
function verifyTranslation(c: Checker, kind: string, node: Node, own: Type, translated: Type | undefined): void {
  const sharing = c.threadSharing!;
  if (translated === undefined) return;
  sharing.verified++;
  if (translated === own) return;
  const a = typeToString(c, own);
  const b = typeToString(c, translated);
  if (a === b) {
    sharing.verifiedIdentity++;
    return;
  }
  process.stderr.write(
    'share-verify: checker ' +
      sharing.data.index +
      ' ' +
      kind +
      ' of ' +
      getSourceFileOfNode(node).fileName +
      ':' +
      node.pos +
      ' computed ' +
      a +
      ' translated ' +
      b +
      '\n',
  );
}

/** Whether a part of `list` names `fileName`, and `pos` when the part ends in `@start-end`. */
function namesFile(list: string | undefined, fileName: string, pos: number): boolean {
  if (list === undefined) return false;
  for (const part of list.split(',')) {
    if (part === '') continue;
    const at = part.indexOf('@');
    if (at < 0) {
      if (fileName.includes(part)) return true;
      continue;
    }
    const dash = part.indexOf('-', at);
    if (
      fileName.includes(part.slice(0, at)) &&
      pos >= Number(part.slice(at + 1, dash)) &&
      pos < Number(part.slice(dash + 1))
    )
      return true;
  }
  return false;
}

/** Whether the debugging options keep a result for a declaration at `node` from being translated. */
function translationBlocked(node: Node): boolean {
  if (shareBlockValue === undefined && shareAllowValue === undefined) return false;
  const fileName = getSourceFileOfNode(node).fileName;
  if (namesFile(shareBlockValue, fileName, node.pos)) return true;
  return shareAllowValue !== undefined && !namesFile(shareAllowValue, fileName, node.pos);
}

function traceTranslation(c: Checker, kind: string, node: Node, producer: number): void {
  if (shareTraceValue !== '1') return;
  process.stderr.write(
    'share: checker ' +
      c.threadSharing!.data.index +
      ' translated ' +
      kind +
      ' of ' +
      getSourceFileOfNode(node).fileName +
      ':' +
      node.pos +
      ' from ' +
      producer +
      '\n',
  );
}

let threadSharingData: ThreadSharingData | undefined = undefined;

/** Sets the sharing data of this checker thread; its first checker shares with the other threads. */
export function setThreadSharingData(data: ThreadSharingData | undefined): void {
  threadSharingData = data;
}

/** Gives `c` the thread's sharing state, if the thread shares and no checker of it has it yet. */
export function startThreadSharing(c: Checker): void {
  const data = threadSharingData;
  if (data === undefined) return;
  threadSharingData = undefined;
  c.threadSharing = new ThreadSharing(c, data);
}

/** A checker's state of sharing with the other checker threads. */
/** A set of ids (symbol or node ids), a bit each. */
export class IdBits {
  private bits = new Uint32Array(1024);

  has(id: number): boolean {
    const word = id >>> 5;
    return word < this.bits.length && (this.bits[word]! & (1 << (id & 31))) !== 0;
  }

  add(id: number): void {
    const word = id >>> 5;
    if (word >= this.bits.length) {
      let length = this.bits.length * 2;
      while (length <= word) length *= 2;
      const bits = new Uint32Array(length);
      bits.set(this.bits);
      this.bits = bits;
    }
    this.bits[word] = this.bits[word]! | (1 << (id & 31));
  }
}

/**
 * The files of the diagnostics of results, by key (a symbol or declaration id), with a bit per key: most results have
 * none, and the bit answers that without a lookup.
 */
export class FilesByKey {
  private readonly files = new Map<number, readonly string[]>();
  private readonly keys = new IdBits();

  get(key: number): readonly string[] | undefined {
    return this.keys.has(key) ? this.files.get(key) : undefined;
  }

  set(key: number, files: readonly string[]): void {
    this.keys.add(key);
    this.files.set(key, files);
  }
}

export class ThreadSharing {
  readonly c: Checker;
  readonly data: ThreadSharingData;
  readonly types: ResultTable;
  readonly returns: ResultTable;
  /** TSC_TS_SHARE_MIN_MS: the shortest computation this checker posts. */
  readonly minMs: number;
  readonly initialIndexes = new Map<Type, number>();
  readonly initial: Type[];
  readonly numberLogs: Int32Array[] = [];
  readonly recordTables: Int32Array[] = [];
  readonly stringLogs: Uint16Array[] = [];
  readonly used: Int32Array;
  readonly takers: Int32Array;
  readonly forbidden: Int32Array;
  /** The number of results this checker posted. */
  posted = 0;
  translated = 0;
  /** Outermost shared-kind computations: nesting depth, the kind of the current one, and the time by kind. */
  depth = 0;
  kind = 0;
  readonly kindMs: number[] = [0, 0, 0, 0];

  /** Kinds: 0 owned, 1 computed here for a file another checker took, 2 translated, 3 other. */
  addOutermost(ms: number): void {
    this.kindMs[this.kind]! += ms;
    this.kind = 3;
  }

  notShareable = 0;
  notShareableMs = 0;
  /** Whether the outermost computations are timed by kind (TSC_TS_SHARE_SUMMARY). */
  readonly timing = process.env.TSC_TS_SHARE_SUMMARY !== undefined;
  /** TSC_TS_SHARE_VERIFY: translations checked, and those equal only as text. */
  verified = 0;
  verifiedIdentity = 0;
  belowMin = 0;
  belowMinMs = 0;
  exportFailed = 0;
  exportFailedMs = 0;
  readonly exportFailures = new Map<string, number>();
  packFailed = 0;
  /** Of `packFailed`, the results that didn't fit in this checker's logs. */
  logFull = 0;
  computedPrivately = 0;
  /** How often a posted result couldn't be taken here; and results for declarations of the checker's own files. */
  sawDoneUnusable = 0;
  owned = 0;
  unpackMs = 0;
  /** The program's nodes results named, by id. */
  readonly nodesById = new Map<number, Node>();
  readonly origins = new MergedOrigins();
  translationMs = 0;
  exportMs = 0;
  /** The symbol and signature whose next `getTypeOfSymbol` or `getReturnTypeOfSignature` computes here. */
  computing: Symbol | undefined = undefined;
  computingSignature: Signature | undefined = undefined;

  /** The value type of `symbol`, or else the return type of `sig`, computed here. */
  computeHere(symbol: Symbol | undefined, sig: Signature | undefined): Type {
    if (symbol !== undefined) {
      this.computing = symbol;
      return getTypeOfSymbol(this.c, symbol);
    }
    this.computingSignature = sig;
    return getReturnTypeOfSignature(this.c, sig!);
  }

  /**
   * The files of the diagnostics each value type (by symbol id) and return type (by declaration id) reported, with
   * those of the results it used, cached and translated ones too; only for results with diagnostics. A checker that
   * takes a result checks none of these files, since it would have reported the diagnostics in them.
   */
  readonly typeFiles = new FilesByKey();
  readonly returnFiles = new FilesByKey();
  /** The files of the computations in progress, innermost last. */
  readonly fileStack: (Set<string> | undefined)[] = [];

  /** Adds `files` to those of the computation in progress. */
  noteFiles(files: readonly string[] | undefined): void {
    const stack = this.fileStack;
    if (files === undefined || stack.length === 0) return;
    let top = stack[stack.length - 1];
    if (top === undefined) {
      top = new Set<string>();
      stack[stack.length - 1] = top;
    }
    for (const f of files) top.add(f);
  }

  /** The last `computeShared`: whether its result can be shared, and how long it took. */
  lastShareable = false;
  lastMs = 0;

  /** `tracked`, recording whether the result can be shared, which it can't when the computation met a resolution cycle. */
  computeShared(files: FilesByKey, key: number, symbol: Symbol | undefined, sig: Signature | undefined): Type {
    const c = this.c;
    const cycles = c.resolutionCycleCount;
    const start = performance.now();
    const t = this.tracked(files, key, symbol, sig);
    this.lastMs = performance.now() - start;
    this.lastShareable = cycles === c.resolutionCycleCount;
    return t;
  }

  /** Runs `compute`, keeping in `files` under `key` the files of its diagnostics and of the results it used. */
  tracked(files: FilesByKey, key: number, symbol: Symbol | undefined, sig: Signature | undefined): Type {
    const c = this.c;
    const diagnostics = c.diagnostics.added!;
    const suggestions = c.suggestionDiagnostics.added!;
    const deferred = c.deferredDiagnosticFiles!;
    const diagnosticsBefore = diagnostics.length;
    const suggestionsBefore = suggestions.length;
    const deferredBefore = deferred.length;
    this.fileStack.push(undefined);
    try {
      return this.computeHere(symbol, sig);
    } finally {
      let own = this.fileStack.pop();
      for (let i = diagnosticsBefore; i < diagnostics.length; i++) {
        if (own === undefined) own = new Set<string>();
        const file = diagnostics[i]!.file;
        own.add(file === undefined ? '' : file.fileName);
      }
      for (let i = suggestionsBefore; i < suggestions.length; i++) {
        if (own === undefined) own = new Set<string>();
        const file = suggestions[i]!.file;
        own.add(file === undefined ? '' : file.fileName);
      }
      // A deferred diagnostic is reported where its file is checked, as the diagnostics it reported are.
      for (let i = deferredBefore; i < deferred.length; i++) {
        if (own === undefined) own = new Set<string>();
        own.add(deferred[i]!);
      }
      if (own !== undefined) {
        const list = [...own];
        files.set(key, list);
        this.noteFiles(list);
      }
    }
  }

  constructor(c: Checker, data: ThreadSharingData) {
    this.c = c;
    // `tracked` reads the diagnostics a computation added, and deferred, from these lists.
    c.diagnostics.added = [];
    c.suggestionDiagnostics.added = [];
    c.deferredDiagnosticFiles = [];
    this.data = data;
    this.used = new Int32Array(data.used);
    this.takers = new Int32Array(data.takers);
    this.forbidden = new Int32Array(data.forbidden);
    this.types = new ResultTable(data.typeTable);
    this.returns = new ResultTable(data.returnTable);
    // A posted result pays when enough checkers need it, so the threshold falls as checkers are added: 8 ms with 4
    // checkers, 2 ms with 16.
    this.minMs = shareMinValue === undefined ? 32 / data.count : Number(shareMinValue);
    this.initial = initialTypes(c);
    for (let i = 0; i < this.initial.length; i++) this.initialIndexes.set(this.initial[i]!, i);
    for (let k = 0; k < data.count; k++) {
      this.numberLogs.push(new Int32Array(data.numberLogs[k]!));
      this.recordTables.push(new Int32Array(data.recordTables[k]!));
      this.stringLogs.push(new Uint16Array(data.stringLogs[k]!));
    }
    if (process.env.TSC_TS_SHARE_SUMMARY !== undefined)
      process.on('exit', () => process.stderr.write(this.summary() + '\n'));
  }

  summary(): string {
    return (
      'checker ' +
      this.data.index +
      ': outermost ms owned/computed here/translated/other ' +
      this.kindMs.map((v) => v.toFixed(0)).join('/') +
      '; posted ' +
      this.posted +
      ' (' +
      this.storedRecords +
      ' records), translated ' +
      this.translated +
      ' (' +
      this.translationMs.toFixed(0) +
      ' ms, unpacking ' +
      this.unpackMs.toFixed(0) +
      ' ms), export ' +
      this.exportMs.toFixed(0) +
      ' ms, computed here ' +
      this.computedPrivately +
      ' (' +
      this.sawDoneUnusable +
      ' posted but not taken), owned ' +
      this.owned +
      '; not posted: cycles ' +
      this.notShareable +
      ' (' +
      this.notShareableMs.toFixed(0) +
      ' ms), quick ' +
      this.belowMin +
      ' (' +
      this.belowMinMs.toFixed(0) +
      ' ms), not exported ' +
      this.exportFailed +
      ' (' +
      this.exportFailedMs.toFixed(0) +
      ' ms: ' +
      [...this.exportFailures]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => k + ' ' + v.toFixed(0))
        .join('; ') +
      '), not packed ' +
      this.packFailed +
      ' (logs full ' +
      this.logFull +
      ', used ' +
      this.used[2 * this.data.index] +
      ' numbers, ' +
      this.used[2 * this.data.index + 1] +
      ' code units)' +
      (shareVerifyValue === '1' ? '; verified ' + this.verified + ' (' + this.verifiedIdentity + ' equal as text)' : '')
    );
  }

  /**
   * Whether this checker checks `file`, or may: a result computed for a declaration in it is never taken here. That is
   * a file it took, and one checked in statement ranges; a file no checker took yet it never checks once it took a
   * result for it (`forbid`).
   */
  owns(file: SourceFile): boolean {
    const index = this.c.fileIndex.get(file);
    if (index === undefined) return true;
    const taker = Atomics.load(this.takers, index);
    if (taker === 0) return false;
    return taker !== -2 && (taker < 0 || taker === this.data.index + 1);
  }

  /** After taking a result for a declaration in `file`: if no checker took the file yet, this one never will. */
  forbid(file: SourceFile): void {
    const index = this.c.fileIndex.get(file);
    if (index === undefined) return;
    const me = this.data.index;
    if (Atomics.load(this.takers, index) === 0)
      Atomics.or(this.forbidden, index * forbiddenWords(this.data.count) + (me >>> 5), 1 << (me & 31));
  }

  /**
   * Whether taking a result would leave file `index` to no checker: no checker took it, and every other checker
   * took results for its declarations already. The main thread would check it, alone.
   */
  forbidsLast(index: number): boolean {
    if (Atomics.load(this.takers, index) !== 0) return false;
    const count = this.data.count;
    const me = this.data.index;
    const words = forbiddenWords(count);
    for (let w = 0; w < words; w++) {
      // The bits of the checkers this word holds, and this checker's.
      const n = Math.min(32, count - 32 * w);
      const all = n === 32 ? -1 : (1 << n) - 1;
      const mine = me >>> 5 === w ? 1 << (me & 31) : 0;
      if ((Atomics.load(this.forbidden, index * words + w) | mine) !== all) return false;
    }
    return true;
  }

  forbidsLastNamed(fileName: string): boolean {
    this.ownsFileNamed(fileName);
    const file = this.filesByName!.get(fileName);
    const index = file === undefined ? undefined : this.c.fileIndex.get(file);
    return index !== undefined && this.forbidsLast(index);
  }

  forbidNamed(fileName: string): void {
    this.ownsFileNamed(fileName);
    const file = this.filesByName!.get(fileName);
    if (file !== undefined) this.forbid(file);
  }

  filesByName: Map<string, SourceFile> | undefined = undefined;

  ownsFileNamed(fileName: string): boolean {
    let files = this.filesByName;
    if (files === undefined) {
      files = new Map<string, SourceFile>();
      for (const file of this.c.files) files.set(file.fileName, file);
      this.filesByName = files;
    }
    const file = files.get(fileName);
    return file === undefined || this.owns(file);
  }

  /** The result checker `k` posted at `offset` in its number log. */
  result(k: number, offset: number): StoredResult {
    const numbers = this.numberLogs[k]!;
    const strings = this.stringLogs[k]!;
    const root = numbers[offset]!;
    const count = numbers[offset + 1]!;
    const files: string[] = [];
    for (let i = 0; i < count; i++)
      files.push(readText(strings, numbers[offset + 2 + 2 * i]!, numbers[offset + 3 + 2 * i]!));
    return new StoredResult(root, files);
  }

  /** The exporter of this checker's store: it exports each type once. */
  storeExporter: Exporter | undefined = undefined;

  /**
   * Exports `t` into this checker's store and logs a result with it as the root; returns its state for the result
   * tables, -1 if it doesn't fit in the logs or a node or symbol in it can't be named across threads, or why it can't
   * be exported.
   */
  post(t: Type, diagnosticFiles: readonly string[]): number | string {
    const c = this.c;
    let exporter = this.storeExporter;
    if (exporter === undefined) {
      exporter = new Exporter(c, this.initialIndexes);
      exporter.nodeLimit = this.data.nodeIds;
      exporter.symbolLimit = this.data.symbolIds;
      exporter.originsCache = this.origins;
      this.storeExporter = exporter;
    }
    exporter.failure = undefined;
    exporter.mergedOrigins = undefined;
    const root = exporter.type(t);
    if (exporter.failure !== undefined) {
      const failure = exporter.failure;
      forgetExport(exporter);
      return failure;
    }
    const me = this.data.index;
    const numbers = this.numberLogs[me]!;
    const strings = this.stringLogs[me]!;
    const table = this.recordTables[me]!;
    const offset = this.used[2 * me]!;
    const p = new RecordPacker(c.fileIndex, strings, this.used[2 * me + 1]!);
    const starts: number[] = [];
    for (const r of exporter.records) {
      starts.push(p.f.length);
      if (!packRecord(p, r)) {
        forgetExport(exporter);
        return -1;
      }
    }
    const header = p.f.length;
    p.f.push(root, diagnosticFiles.length);
    for (const fileName of diagnosticFiles) p.text(fileName);
    const count = exporter.records.length;
    let fits = !p.full && offset + p.f.length <= numbers.length && exporter.base + count <= recordTableSize;
    for (const v of p.f) if ((v | 0) !== v) fits = false;
    if (!fits) {
      this.logFull++;
      forgetExport(exporter);
      return -1;
    }
    for (let i = 0; i < p.f.length; i++) numbers[offset + i] = p.f[i]!;
    for (let i = 0; i < count; i++) {
      const index = exporter.base + i;
      table[2 * index] = offset + starts[i]! + 1;
      const r = exporter.records[i]!;
      if (r.kind === RecordKind.CompleteObject) table[2 * r.num + 1] = index + 1;
    }
    // Only this checker writes its logs and store; the result table's state publishes what it wrote.
    this.used[2 * me] = offset + p.f.length;
    this.used[2 * me + 1] = p.unitAt;
    exporter.base += count;
    exporter.records = [];
    exporter.addedTypes.length = 0;
    exporter.addedProperties.length = 0;
    this.posted++;
    this.storedRecords += count;
    return postedState(this.data.count, me, offset + header);
  }

  /** The records this checker stored. */
  storedRecords = 0;

  /** The readers of the other checkers' stores. */
  readonly readers: (StoreReader | undefined)[] = [];

  /** The translation of `posted` into this checker, or undefined if it can't be taken here. */
  translatePosted(
    producer: number,
    posted: StoredResult,
    files: FilesByKey,
    key: number,
    declarationFile: SourceFile,
  ): Type | undefined {
    for (const fileName of posted.files)
      if (fileName === '' || this.ownsFileNamed(fileName) || this.forbidsLastNamed(fileName)) return undefined;
    const declarationIndex = this.c.fileIndex.get(declarationFile);
    if (declarationIndex !== undefined && this.forbidsLast(declarationIndex)) return undefined;
    const start = performance.now();
    let reader = this.readers[producer];
    if (reader === undefined) {
      reader = new StoreReader(this, producer);
      this.readers[producer] = reader;
    }
    const t = reader.translate(posted.root);
    this.translationMs += performance.now() - start;
    if (t !== undefined) {
      this.translated++;
      for (const fileName of posted.files) this.forbidNamed(fileName);
      if (posted.files.length > 0) {
        files.set(key, posted.files);
        this.noteFiles(posted.files);
      }
    }
    return t;
  }
}

/** A result in a checker's store: the record of its type, and the files of its diagnostics. */
export class StoredResult {
  readonly root: number;
  readonly files: string[];

  constructor(root: number, files: string[]) {
    this.root = root;
    this.files = files;
  }
}

function readText(strings: Uint16Array, start: number, length: number): string {
  let text = '';
  for (let j = 0; j < length; j++) text += String.fromCharCode(strings[start + j]!);
  return text;
}

/** Forgets the types and properties a failed export of a store gave indexes. */
function forgetExport(exporter: Exporter): void {
  for (const t of exporter.addedTypes) exporter.indexes.delete(t);
  for (const prop of exporter.addedProperties) exporter.properties.delete(prop);
  exporter.addedTypes.length = 0;
  exporter.addedProperties.length = 0;
  exporter.records = [];
  exporter.failure = undefined;
}

/**
 * Runs `compute` for the result keyed `key` in `table`, then exports and posts it if it can be shared and took long
 * enough, unless another checker posted it meanwhile. Nothing is written for the others before: a checker that finds
 * no result computes its own.
 */
function computeAndPost(
  sharing: ThreadSharing,
  table: ResultTable,
  files: FilesByKey,
  key: number,
  symbol: Symbol | undefined,
  sig: Signature | undefined,
): Type {
  const t = sharing.computeShared(files, key, symbol, sig);
  const ms = sharing.lastMs;
  if (!sharing.lastShareable) {
    sharing.notShareable++;
    sharing.notShareableMs += ms;
    return t;
  }
  // A quick computation is cheaper to repeat than to export, post and translate.
  if (ms < sharing.minMs) {
    sharing.belowMin++;
    sharing.belowMinMs += ms;
    return t;
  }
  const slot = table.slot(key);
  if (slot < 0 || table.state(slot) !== 0) return t;
  const start = performance.now();
  // Diagnostics stay with this checker; the others only learn which files they are in.
  const state = sharing.post(t, files.get(key) ?? []);
  if (typeof state === 'string') {
    sharing.exportFailed++;
    sharing.exportFailedMs += ms;
    sharing.exportFailures.set(state, (sharing.exportFailures.get(state) ?? 0) + ms);
  } else if (state === -1) sharing.packFailed++;
  else table.publish(slot, state);
  sharing.exportMs += performance.now() - start;
  return t;
}

/** Shares the value type of `symbol` with the other checker threads, computing it with `compute` where needed. */
export function threadTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  const sharing = c.threadSharing!;
  if (!sharing.timing || sharing.depth > 0 || c.symbolTypes.get(getSymbolId(symbol)) !== undefined)
    return threadTypeOfSymbolWorker(c, symbol);
  const start = performance.now();
  sharing.kind = 3;
  sharing.depth++;
  try {
    return threadTypeOfSymbolWorker(c, symbol);
  } finally {
    sharing.depth--;
    sharing.addOutermost(performance.now() - start);
  }
}

function threadTypeOfSymbolWorker(c: Checker, symbol: Symbol): Type {
  const sharing = c.threadSharing!;
  const id = getSymbolId(symbol);
  const cached = c.symbolTypes.get(id);
  if (cached !== undefined) {
    // Most results have no diagnostics: then there is nothing to look up.
    if (sharing.fileStack.length > 0) sharing.noteFiles(sharing.typeFiles.get(id));
    return cached;
  }
  if (id > sharing.data.symbolIds) return sharing.tracked(sharing.typeFiles, id, symbol, undefined);
  const table = sharing.types;
  if (!sharing.owns(getSourceFileOfNode(symbol.valueDeclaration!))) {
    const slot = table.find(id);
    const state = slot < 0 ? 0 : table.state(slot);
    if (
      state <= -2 &&
      findResolutionCycleStartIndex(c, symbol, TypeSystemPropertyName.Type) < 0 &&
      !translationBlocked(symbol.valueDeclaration!)
    ) {
      const producer = postedProducer(sharing.data.count, state);
      const posted = sharing.result(producer, postedOffset(sharing.data.count, state));
      const file = getSourceFileOfNode(symbol.valueDeclaration!);
      if (shareVerifyValue === '1') {
        const own = sharing.tracked(sharing.typeFiles, id, symbol, undefined);
        verifyTranslation(
          c,
          'types',
          symbol.valueDeclaration!,
          own,
          sharing.translatePosted(producer, posted, sharing.typeFiles, id, file),
        );
        return own;
      }
      const t = sharing.translatePosted(producer, posted, sharing.typeFiles, id, file);
      if (t !== undefined) {
        traceTranslation(c, 'types', symbol.valueDeclaration!, producer);
        if (sharing.depth === 1) sharing.kind = 2;
        sharing.forbid(getSourceFileOfNode(symbol.valueDeclaration!));
        const again = c.symbolTypes.get(id);
        if (again !== undefined) return again;
        c.symbolTypes.set(id, t);
        return t;
      }
      sharing.sawDoneUnusable++;
    }
    sharing.computedPrivately++;
    if (sharing.depth === 1) sharing.kind = 1;
  } else {
    sharing.owned++;
    if (sharing.depth === 1) sharing.kind = 0;
  }
  return computeAndPost(sharing, table, sharing.typeFiles, id, symbol, undefined);
}

/** Notes that the computation in progress used the cached return type of `sig` (see `ThreadSharing.typeFiles`). */
export function noteReturnTypeUse(c: Checker, sig: Signature): void {
  const sharing = c.threadSharing!;
  if (sharing.fileStack.length === 0 || sig.declaration === undefined) return;
  sharing.noteFiles(sharing.returnFiles.get(sig.declaration.id));
}

export function threadReturnType(c: Checker, sig: Signature): Type {
  const sharing = c.threadSharing!;
  if (!sharing.timing || sharing.depth > 0) return threadReturnTypeWorker(c, sig);
  const start = performance.now();
  sharing.kind = 3;
  sharing.depth++;
  try {
    return threadReturnTypeWorker(c, sig);
  } finally {
    sharing.depth--;
    sharing.addOutermost(performance.now() - start);
  }
}

function threadReturnTypeWorker(c: Checker, sig: Signature): Type {
  const sharing = c.threadSharing!;
  const declaration = sig.declaration!;
  const key = declaration.id;
  if (key > sharing.data.nodeIds) return sharing.tracked(sharing.returnFiles, key, undefined, sig);
  const table = sharing.returns;
  if (!sharing.owns(getSourceFileOfNode(declaration))) {
    const slot = table.find(key);
    const state = slot < 0 ? 0 : table.state(slot);
    if (
      state <= -2 &&
      findResolutionCycleStartIndex(c, sig, TypeSystemPropertyName.ResolvedReturnType) < 0 &&
      !translationBlocked(declaration)
    ) {
      const producer = postedProducer(sharing.data.count, state);
      const posted = sharing.result(producer, postedOffset(sharing.data.count, state));
      const file = getSourceFileOfNode(declaration);
      if (shareVerifyValue === '1') {
        const own = sharing.tracked(sharing.returnFiles, key, undefined, sig);
        verifyTranslation(
          c,
          'returns',
          declaration,
          own,
          sharing.translatePosted(producer, posted, sharing.returnFiles, key, file),
        );
        return own;
      }
      const t = sharing.translatePosted(producer, posted, sharing.returnFiles, key, file);
      if (t !== undefined) {
        traceTranslation(c, 'returns', declaration, producer);
        if (sharing.depth === 1) sharing.kind = 2;
        sharing.forbid(getSourceFileOfNode(declaration));
        return t;
      }
      sharing.sawDoneUnusable++;
    }
    sharing.computedPrivately++;
    if (sharing.depth === 1) sharing.kind = 1;
  } else {
    sharing.owned++;
    if (sharing.depth === 1) sharing.kind = 0;
  }
  return computeAndPost(sharing, table, sharing.returnFiles, key, undefined, sig);
}

// ---- Records in a checker's store
//
// Records travel between threads as numbers and strings only: a class instance received in a worker makes the native
// build store the number fields of every class it can reach as doubles. A node is written as its file, range, kind
// and id, and found again by descending from the file's root; a symbol of the program as the node it is the symbol
// of; a merged symbol by the id of a symbol it merged; a string as its range in the store's string log.

/** A double and its two int32 halves, sharing their bytes. */
class DoubleWords {
  readonly f = new Float64Array(1);
  readonly i: Int32Array;

  constructor() {
    this.i = new Int32Array(this.f.buffer);
  }
}

let doubleWordsValue: DoubleWords | undefined = undefined;

function doubleWords(): DoubleWords {
  if (doubleWordsValue === undefined) doubleWordsValue = new DoubleWords();
  return doubleWordsValue;
}

/** Packs records into a checker's store: their numbers into `f`, their strings into its string log from `unitAt`. */
class RecordPacker {
  readonly f: number[] = [];
  readonly fileIndex: Map<SourceFile, number>;
  readonly strings: Uint16Array;
  unitAt: number;
  /** Set when the string log is full. */
  full = false;

  constructor(fileIndex: Map<SourceFile, number>, strings: Uint16Array, unitAt: number) {
    this.fileIndex = fileIndex;
    this.strings = strings;
    this.unitAt = unitAt;
  }

  text(t: string): void {
    if (this.unitAt + t.length > this.strings.length) {
      this.full = true;
      this.f.push(0, 0);
      return;
    }
    this.f.push(this.unitAt, t.length);
    for (let j = 0; j < t.length; j++) this.strings[this.unitAt++] = t.charCodeAt(j);
  }

  list(values: readonly number[]): void {
    this.f.push(values.length);
    for (const v of values) this.f.push(v);
  }

  /** A double as the two int32 halves of its bits. */
  double(v: number): void {
    const words = doubleWords();
    words.f[0] = v;
    this.f.push(words.i[0]!, words.i[1]!);
  }

  node(node: Node | undefined): boolean {
    if (node === undefined) {
      this.f.push(-1);
      return true;
    }
    const file = getSourceFileOfNode(node);
    const index = this.fileIndex.get(file);
    if (index === undefined) return false;
    this.f.push(index, node.pos, node.end, node.kind, node.id);
    return true;
  }

  nodes(list: readonly (Node | undefined)[]): boolean {
    this.f.push(list.length);
    for (const node of list) if (!this.node(node)) return false;
    return true;
  }

  /** A symbol of the program (by the node it is the symbol of, or the export symbol of), or none. */
  symbol(symbol: Symbol | undefined): boolean {
    if (symbol === undefined) {
      this.f.push(-1);
      return true;
    }
    const declaration = symbol.declaration;
    if (declaration === undefined) return false;
    const local = getSymbol(declaration);
    if (local === symbol) this.f.push(0);
    else if (local !== undefined && local.exportSymbol === symbol) this.f.push(1);
    else return false;
    return this.node(declaration);
  }
}

/** Writes `r`; false if a node or symbol in it can't be named across threads. */
function packRecord(p: RecordPacker, r: PortableRecord): boolean {
  p.f.push(r.kind, r.id, r.flags);
  // A number literal's value is any double, written as its two halves.
  if (r.kind === RecordKind.Literal) p.double(r.num);
  else p.f.push(r.num);
  p.f.push(r.mergedId, r.aliasMergedId);
  p.text(r.text);
  if (!p.symbol(r.symbol) || !p.node(r.node) || !p.symbol(r.aliasSymbol)) return false;
  p.list(r.refs);
  p.list(r.nums);
  if (!p.nodes(r.nodes)) return false;
  p.f.push(r.texts.length);
  for (const t of r.texts) p.text(t);
  p.list(r.aliasRefs);
  p.f.push(r.indexInfos.length);
  for (const info of r.indexInfos) {
    p.f.push(info.keyType, info.valueType, info.isReadonly ? 1 : 0);
    if (!p.node(info.declaration) || !p.nodes(info.components)) return false;
  }
  return true;
}

/** Reads records from a checker's store. */
class RecordUnpacker {
  readonly c: Checker;
  readonly f: Int32Array;
  readonly strings: Uint16Array;
  at = 0;
  failed = false;

  /** The nodes found so far, by id. */
  readonly nodesById: Map<number, Node>;

  constructor(c: Checker, numbers: Int32Array, strings: Uint16Array, nodesById: Map<number, Node>) {
    this.c = c;
    this.f = numbers;
    this.strings = strings;
    this.nodesById = nodesById;
  }

  next(): number {
    return this.f[this.at++]!;
  }

  double(): number {
    const words = doubleWords();
    words.i[0] = this.next();
    words.i[1] = this.next();
    return words.f[0]!;
  }

  text(): string {
    const start = this.next();
    const length = this.next();
    return readText(this.strings, start, length);
  }

  list(): number[] {
    const n = this.next();
    const values: number[] = [];
    for (let i = 0; i < n; i++) values.push(this.next());
    return values;
  }

  node(): Node | undefined {
    const fileIndex = this.next();
    if (fileIndex < 0) return undefined;
    const pos = this.next();
    const end = this.next();
    const kind = this.next();
    const id = this.next();
    let node = this.nodesById.get(id);
    if (node === undefined) {
      const file = this.c.files[fileIndex];
      node = file === undefined ? undefined : findNode(file, pos, end, kind, id);
      if (node === undefined) {
        this.failed = true;
        return undefined;
      }
      this.nodesById.set(id, node);
    }
    return node;
  }

  nodes(): (Node | undefined)[] {
    const n = this.next();
    const list: (Node | undefined)[] = [];
    for (let i = 0; i < n; i++) list.push(this.node());
    return list;
  }

  symbol(): Symbol | undefined {
    const how = this.next();
    if (how < 0) return undefined;
    const node = this.node();
    if (node === undefined) return undefined;
    const local = getSymbol(node);
    const symbol = how === 0 ? local : local?.exportSymbol;
    if (symbol === undefined) this.failed = true;
    return symbol;
  }
}

/** Reads a record; undefined if a node or symbol in it isn't in `u`'s program. */
function unpackRecord(u: RecordUnpacker): PortableRecord | undefined {
  const kind = u.next() as RecordKind;
  const id = u.next();
  const flags = u.next();
  const num = kind === RecordKind.Literal ? u.double() : u.next();
  const mergedId = u.next();
  const aliasMergedId = u.next();
  const text = u.text();
  const symbol = u.symbol();
  const node = u.node();
  const aliasSymbol = u.symbol();
  const refs = u.list();
  const record = new PortableRecord(kind, id, flags, num, text, symbol, node, refs);
  record.mergedId = mergedId;
  record.aliasMergedId = aliasMergedId;
  record.aliasSymbol = aliasSymbol;
  record.nums = u.list();
  record.nodes = u.nodes();
  const textCount = u.next();
  const texts: string[] = [];
  for (let k = 0; k < textCount; k++) texts.push(u.text());
  record.texts = texts;
  record.aliasRefs = u.list();
  const infoCount = u.next();
  const infos: PortableIndexInfo[] = [];
  for (let k = 0; k < infoCount; k++) {
    const keyType = u.next();
    const valueType = u.next();
    const isReadonly = u.next() === 1;
    const declaration = u.node();
    const components = u.nodes() as Node[];
    infos.push(new PortableIndexInfo(keyType, valueType, isReadonly, declaration, components));
  }
  record.indexInfos = infos;
  return u.failed ? undefined : record;
}

/** Collects the children of a node (`forEachChild`). */
class ChildCollector extends NodeVisitor {
  readonly children: Node[] = [];

  visitNode(node: Node): boolean {
    this.children.push(node);
    return false;
  }
}

/** The node of `file` with the range, kind and id given, found by descending through the nodes that contain it. */
function findNode(file: SourceFile, pos: number, end: number, kind: number, id: number): Node | undefined {
  let node: Node = file;
  for (;;) {
    if (node.id === id) return node.kind === kind && node.pos === pos && node.end === end ? node : undefined;
    const collector = new ChildCollector();
    node.forEachChild(collector);
    let next: Node | undefined = undefined;
    for (const child of collector.children)
      if (child.pos <= pos && end <= child.end) {
        // The innermost of nested nodes with one range is found by its id further down.
        if (child.id === id) return child.kind === kind && child.pos === pos && child.end === end ? child : undefined;
        if (next === undefined) next = child;
      }
    if (next === undefined) return undefined;
    node = next;
  }
}

/**
 * A consumer's translations of another checker's store: each record is read and translated once, when a result
 * first needs it, in the order of the store, which is the order the producer exported them in.
 */
class StoreReader {
  readonly sharing: ThreadSharing;
  readonly producer: number;
  readonly translator: Translator;
  readonly table: Int32Array;
  readonly unpacker: RecordUnpacker;
  /** By record: the record, its translation and whether it is translated. */
  readonly records: (PortableRecord | undefined)[] = [];
  readonly types: Type[] = [];
  readonly symbols: (Symbol | undefined)[] = [];
  readonly built: number[] = [];

  constructor(sharing: ThreadSharing, producer: number) {
    this.sharing = sharing;
    this.producer = producer;
    this.translator = new Translator(sharing.c);
    this.table = sharing.recordTables[producer]!;
    this.unpacker = new RecordUnpacker(
      sharing.c,
      sharing.numberLogs[producer]!,
      sharing.stringLogs[producer]!,
      sharing.nodesById,
    );
  }

  private ensure(index: number): void {
    const placeholder = this.sharing.c.errorType;
    while (this.types.length <= index) {
      this.types.push(placeholder);
      this.symbols.push(undefined);
      this.records.push(undefined);
      this.built.push(0);
    }
  }

  /** Record `index`, read on first use; undefined if a node or symbol in it isn't in this program. */
  private record(index: number): PortableRecord | undefined {
    this.ensure(index);
    const known = this.records[index];
    if (known !== undefined) return known;
    const u = this.unpacker;
    u.at = this.table[2 * index]! - 1;
    u.failed = false;
    const start = performance.now();
    const record = unpackRecord(u);
    this.sharing.unpackMs += performance.now() - start;
    if (record !== undefined) this.records[index] = record;
    return record;
  }

  /** The translation of record `root` and the records it needs; undefined if one can't be translated here. */
  translate(root: number): Type | undefined {
    const c = this.sharing.c;
    const translator = this.translator;
    const needed = new Set<number>();
    const stack = [root];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (needed.has(i)) continue;
      this.ensure(i);
      if (this.built[i] === 1) continue;
      const r = this.record(i);
      if (r === undefined) return undefined;
      if (
        (r.mergedId >= 0 && !c.mergedSymbols.has(r.mergedId)) ||
        (r.aliasMergedId >= 0 && !c.mergedSymbols.has(r.aliasMergedId))
      )
        return undefined;
      needed.add(i);
      for (const j of r.refs) if (j >= 0) stack.push(j);
      for (const j of r.aliasRefs) stack.push(j);
      if (r.kind === RecordKind.CompleteObject || (r.kind === RecordKind.Union && r.num >= 0)) stack.push(r.num);
      for (const info of r.indexInfos) {
        stack.push(info.keyType);
        stack.push(info.valueType);
      }
      if (r.kind === RecordKind.AnonymousObject) {
        const completion = this.table[2 * i + 1]! - 1;
        if (completion >= 0) stack.push(completion);
      }
    }
    const order = [...needed].sort((a, b) => a - b);
    // Translating a type node resolves its type alias first, which fails where that is in progress: before any
    // record is translated. A translation can start translations of this store again (resolving a type alias, or
    // a type of a symbol), which translate some of these records first.
    for (const i of order) {
      if (this.built[i] === 1) continue;
      const r = this.records[i]!;
      if (
        r.kind === RecordKind.NodeType ||
        r.kind === RecordKind.Conditional ||
        r.kind === RecordKind.DistributedConditional
      )
        translator.aliasOfNode(r.node!);
    }
    if (translator.failed) {
      translator.failed = false;
      return undefined;
    }
    for (const i of order) {
      if (this.built[i] === 1) continue;
      const r = this.records[i]!;
      if (r.kind === RecordKind.Property) this.symbols[i] = translator.property(r, this.types, this.symbols);
      else if (r.kind === RecordKind.CompleteObject) translator.complete(r, this.types, this.symbols);
      else this.types[i] = translator.record(r, this.types);
      if (translator.failed) {
        translator.failed = false;
        return undefined;
      }
      this.built[i] = 1;
      // A translated record is not read again.
      this.records[i] = undefined;
    }
    return this.types[root]!;
  }
}
