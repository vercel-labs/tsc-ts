// Results one checker thread computed, as records in its number log that other checker threads translate into their
// own types (TSC_TS_SHARE=1).
//
// A checker exports the result of a declaration-level computation (the value type of a variable or property, or the
// return type of a declared signature) as records: each type the result reaches through its identity (constituents,
// type arguments, alias arguments, instantiation arguments, and the parts of index, indexed access, conditional,
// template, string mapping and substitution types), down to types every checker can get by itself (intrinsic types,
// declared types of symbols, types of declarations and type nodes). Another checker translates the records through
// its own interning caches, so each type still has one object in it.
import { getSymbol, getType, type Node, NodeVisitor, type SourceFile } from './ast.js';
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
import { LinkTable } from './link-tables.js';

// Functions, classes, enums and modules have anonymous types that are cheap to create; their members are not. (A
// function: a top-level constant computed from an enum member of a module in an import cycle doesn't compile natively.)
function sharedValueFlags(): SymbolFlags {
  return SymbolFlags.Variable | SymbolFlags.Property;
}

const enum RecordKind {
  /** A type the checker creates when it starts: its position in `initialTypes`. */
  Initial,
  /** A regular literal type: its flags, then its value as a double or its text. */
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
  /** The tuple target: readonly, then the element flags and label nodes. */
  TupleTarget,
  /**
   * The instantiation of the anonymous, mapped or deferred reference type `refs[0]` with the outer type arguments
   * after it, then the return types its signatures had resolved (built after it); the node declares it.
   */
  Instantiation,
  /** A union of `refs` with the origin record, or -1. */
  Union,
  /** An intersection of `refs`. */
  Intersection,
  /** `keyof refs[0]` with the index flags. */
  Index,
  /** `refs[0][refs[1]]` with the access flags. */
  IndexedAccess,
  /** The instantiation of the conditional type of `node` with outer type arguments `refs`, for constraints when the tag is 1. */
  Conditional,
  /** A template literal type of its texts and `refs`. */
  Template,
  /** The string mapping `symbol` of `refs[0]`. */
  StringMapping,
  /** A substitution type of `refs[0]` constrained by `refs[1]`. */
  Substitution,
  /** `NoInfer<refs[0]>`. */
  NoInfer,
  /**
   * The member for the constituent `refs[last]` of the distribution of the conditional type of `node` instantiated
   * with outer type arguments `refs[0..last)`, for constraints when the tag is 1.
   */
  DistributedConditional,
  /**
   * An anonymous object type of the object literal `symbol` with members resolved when it was created (an object
   * literal type, or its regular, widened or spread form): its object flags, then the record of its members.
   */
  AnonymousObject,
  /** The members of the `AnonymousObject` record whose index is written first: the properties `refs` and index infos. */
  CompleteObject,
  /**
   * A property symbol a checker created: its symbol flags, check flags and name, its declarations, its type
   * `refs[0]`, name type `refs[1]` (or -1), the symbol it was made from `refs[2]` (a property record, or -1 for the
   * symbol of the program written with it) and its parent (its alias).
   */
  Property,
}

/**
 * The bits of a record's header: its kind in the low five, and the fields that follow. A record is its refs (the
 * count in the header, or a count word before them when it is `RefEscape`), then its alias when it has one (its symbol
 * and its refs), then its symbol, its node, and the fields its kind has.
 */
const enum RecordHeader {
  KindMask = 0x1f,
  HasAlias = 1 << 5,
  NamingShift = 6,
  NamingMask = 3 << NamingShift,
  HasNode = 1 << 8,
  /** The record's value declaration is its first declaration, so it is not written again (`Property`). */
  ValueIsFirst = 1 << 9,
  /** The alias symbol is written as the id of a symbol it merged, not as the symbol of a node. */
  AliasMerged = 1 << 10,
  /** The record is the constituent of a distribution's origin, not a type of its own (`Union`, `Intersection`). */
  Constituent = 1 << 11,
  /** The ref count from which the count has a word of its own. */
  RefEscape = 0xffff,
}

/** How a record names a symbol. */
const enum SymbolNaming {
  None,
  /** The symbol of the node written with it. */
  Node,
  /** The export symbol of the symbol of the node written with it. */
  Export,
  /** A symbol the producer merged, by the id of a symbol it merged. */
  Merged,
}

const noRefs: readonly number[] = [];

/**
 * Writes records into a checker's store: int32 words at a cursor, strings into its string log, and each record's
 * offset in its record table. The cursor is the writer's alone until it publishes a result.
 */
export class StoreWriter {
  readonly numbers: Int32Array;
  readonly strings: Uint16Array;
  readonly table: Int32Array;
  readonly fileIndex: Map<SourceFile, number>;
  /** The cursor in the number log, and in the string log. */
  at = 0;
  unitAt = 0;
  /** Set when a record or a field didn't fit the store's configured capacity. */
  full = false;

  constructor(numbers: Int32Array, strings: Uint16Array, table: Int32Array, fileIndex: Map<SourceFile, number>) {
    this.numbers = numbers;
    this.strings = strings;
    this.table = table;
    this.fileIndex = fileIndex;
  }

  /** Returns to the cursors `at` and `unitAt`. */
  reset(at: number, unitAt: number): void {
    this.at = at;
    this.unitAt = unitAt;
    this.full = false;
  }

  /** Starts record `index` at the cursor: its header, and its offset in the record table. */
  beginRecord(index: number, header: number): void {
    if (index < this.table.length) this.table[index] = this.at + 1;
    else this.full = true;
    this.word(header);
  }

  word(value: number): void {
    if (this.at < this.numbers.length) this.numbers[this.at] = value;
    else this.full = true;
    this.at++;
  }

  /** A double as the two int32 halves of its bits. */
  double(value: number): void {
    const words = doubleWords();
    words.f[0] = value;
    this.word(words.i[0]!);
    this.word(words.i[1]!);
  }

  /** A string as its offset and length in the string log. */
  text(value: string): void {
    const length = value.length;
    if (this.unitAt + length <= this.strings.length) {
      this.word(this.unitAt);
      this.word(length);
      for (let j = 0; j < length; j++) this.strings[this.unitAt++] = value.charCodeAt(j);
      return;
    }
    this.full = true;
    this.word(0);
    this.word(0);
  }

  /** A node as its file, range and id, or -1 for none. The file must be one `fileIndex` has. */
  node(node: Node | undefined): void {
    if (node === undefined) {
      this.word(-1);
      return;
    }
    this.word(this.fileIndex.get(getSourceFileOfNode(node))!);
    this.word(node.pos);
    this.word(node.end);
    this.word(node.id);
  }
}

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

/** The reason an export stops at its budget (`Exporter.limit`), which `post` returns: the result is not posted. */
export const budgetFailure = 'export budget';

/** A checker's `Exporter.mergedOrigins`, kept while its merged symbols stay the same. */
export class MergedOrigins {
  origins = new Map<Symbol, number>();
  size = -1;
}

/** An index signature of an `AnonymousObject` record, waiting for the words of its `CompleteObject`. */
class IndexInfoWords {
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

/** Writes a result as records; `failure` names the first part that has no record kind. */
export class Exporter {
  readonly c: Checker;
  readonly writer: StoreWriter;
  /**
   * The index of the first record of the export in progress. A checker's exporter keeps the records of the types it
   * exported before (`ThreadSharing.post`): its store has them already, and a result's records are only the new ones.
   */
  base = 0;
  /** The number of records the export in progress wrote. */
  count = 0;
  /** The record of each type, by type id, and of each property symbol, by symbol id. */
  readonly indexes = new Map<number, number>();
  readonly properties = new Map<number, number>();
  /** The types and properties the export in progress gave indexes, which a failed export forgets again. */
  readonly addedTypes: number[] = [];
  readonly addedProperties: number[] = [];
  /**
   * The most records the export in progress may add (`ThreadSharing.post` prices it with `kappa`); past it the export
   * fails and the result is not posted.
   */
  limit = Number.POSITIVE_INFINITY;
  readonly initial: Map<number, number>;
  failure: string | undefined = undefined;

  /** The ids above which nodes and symbols are the checker thread's own (lazily parsed JSDoc), or Infinity. */
  nodeLimit = Infinity;
  symbolLimit = Infinity;

  /** The ids of the symbols each merged symbol merged (`getMergedSymbol`), built on first use. */
  mergedOrigins: Map<Symbol, number> | undefined = undefined;
  /** Where the checker keeps `mergedOrigins` between exports. */
  originsCache: MergedOrigins | undefined = undefined;

  /** How the record in progress names its symbol and its alias, and the node it carries. */
  private naming = SymbolNaming.None;
  private namingMerged = -1;
  private namingNode: Node | undefined = undefined;
  private aliasNaming = SymbolNaming.None;
  private aliasMerged = -1;
  private aliasNode: Node | undefined = undefined;
  private aliasRefs: readonly number[] = noRefs;
  private node: Node | undefined = undefined;

  constructor(c: Checker, initial: Map<number, number>, writer: StoreWriter) {
    this.c = c;
    this.initial = initial;
    this.writer = writer;
  }

  fail(reason: string): number {
    if (this.failure === undefined) this.failure = reason;
    return -1;
  }

  /** Whether `node` is one every checker shares, and can name; fails if not. */
  sharedNode(node: Node | undefined): boolean {
    if (node === undefined) return true;
    if (node.id > this.nodeLimit) {
      this.fail('node of the thread');
      return false;
    }
    if (!this.writer.fileIndex.has(getSourceFileOfNode(node))) {
      this.fail('node outside the program');
      return false;
    }
    return true;
  }

  /**
   * The index of the next record of the store, or -1 if the result is over its export budget; the store's table must
   * have room for it.
   */
  nextIndex(): number {
    const index = this.base + this.count;
    if (index >= this.limit) return this.fail(budgetFailure);
    this.count++;
    if (index >= this.writer.table.length) this.writer.full = true;
    return index;
  }

  /** Records the type `t` at `index`. */
  private memo(t: Type, index: number): void {
    // A consumer's memo is by record index, so a type has one record: VERIFY runs check that it does.
    if (shareVerifyValue !== undefined && this.indexes.has(t.id))
      process.stderr.write('share-verify: type ' + t.id + ' has a record already\n');
    this.indexes.set(t.id, index);
    this.addedTypes.push(t.id);
  }

  /**
   * Sets how the record in progress names `symbol`: a symbol of the program by the node it is the symbol of, or a
   * symbol the checker merged by the id of a symbol it merged. Fails for a symbol of the thread.
   */
  nameSymbol(symbol: Symbol | undefined, alias: boolean): boolean {
    let naming = SymbolNaming.None;
    let merged = -1;
    let node: Node | undefined = undefined;
    if (symbol !== undefined) {
      if ((symbol.flags & SymbolFlags.Transient) === 0) {
        if (getSymbolId(symbol) > this.symbolLimit) {
          this.fail('symbol of the thread');
          return false;
        }
        const declaration = symbol.declaration;
        if (declaration === undefined) {
          this.fail('symbol without a declaration');
          return false;
        }
        const local = getSymbol(declaration);
        if (local === symbol) naming = SymbolNaming.Node;
        else if (local !== undefined && local.exportSymbol === symbol) naming = SymbolNaming.Export;
        else {
          this.fail('symbol not named by its declaration');
          return false;
        }
        node = declaration;
      } else {
        let origins = this.mergedOrigins;
        if (origins === undefined) origins = this.buildOrigins();
        const origin = origins.get(symbol);
        if (origin === undefined) {
          this.fail('checker symbol ' + symbol.name);
          return false;
        }
        naming = SymbolNaming.Merged;
        merged = origin;
      }
    }
    if (alias) {
      this.aliasNaming = naming;
      this.aliasMerged = merged;
      this.aliasNode = node;
      // The alias's type arguments are recorded after it is named (`aliasBits`). A record that names an alias which
      // has none, such as a property naming its parent, keeps none of the last alias's.
      this.aliasRefs = noRefs;
    } else {
      this.naming = naming;
      this.namingMerged = merged;
      this.namingNode = node;
    }
    return true;
  }

  /** The ids of the symbols each merged symbol merged, from the checker's `mergedSymbols`. */
  private buildOrigins(): Map<Symbol, number> {
    const cache = this.originsCache;
    let origins: Map<Symbol, number>;
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
    return origins;
  }

  /**
   * Names the alias of the record in progress, after its type arguments are exported, and returns the header bits that
   * name it; -1 if it can't be named.
   */
  private aliasBits(alias: TypeAlias | undefined, refs: readonly number[]): number {
    if (alias === undefined) return 0;
    if (!this.nameSymbol(alias.symbol, true)) return -1;
    this.aliasRefs = refs;
    return RecordHeader.HasAlias | (this.aliasNaming === SymbolNaming.Merged ? RecordHeader.AliasMerged : 0);
  }

  /**
   * Starts the record at `index`: its header, its refs, its alias, its symbol and its node, all decided by `bits` and
   * the fields set just before. A kind's own fields follow.
   */
  begin(kind: RecordKind, index: number, refs: readonly number[], bits: number): void {
    const w = this.writer;
    const n = refs.length;
    w.beginRecord(index, kind | bits | (n < RecordHeader.RefEscape ? n << 16 : RecordHeader.RefEscape << 16));
    if (n >= RecordHeader.RefEscape) w.word(n);
    for (let i = 0; i < n; i++) w.word(refs[i]!);
    if ((bits & RecordHeader.HasAlias) !== 0) {
      if ((bits & RecordHeader.AliasMerged) !== 0) w.word(this.aliasMerged);
      else {
        w.word(this.aliasNaming === SymbolNaming.Export ? 1 : 0);
        w.node(this.aliasNode);
      }
      const aliasRefs = this.aliasRefs;
      w.word(aliasRefs.length);
      for (let i = 0; i < aliasRefs.length; i++) w.word(aliasRefs[i]!);
    }
    const naming = bits & RecordHeader.NamingMask;
    if (naming === SymbolNaming.Merged << RecordHeader.NamingShift) w.word(this.namingMerged);
    else if (naming !== 0) w.node(this.namingNode);
    if ((bits & RecordHeader.HasNode) !== 0) w.node(this.node);
  }

  /** The record of `t` of `kind`, with `refs` and no fields of its own; its index. */
  private plain(kind: RecordKind, t: Type, refs: readonly number[]): number {
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(kind, index, refs, 0);
    return index;
  }

  /** The record of the initial type `t`, which is `num`th in `initialTypes`. */
  private initialType(t: Type, num: number): number {
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(RecordKind.Initial, index, noRefs, 0);
    this.writer.word(num);
    return index;
  }

  /** The record of the type `t` of `kind` named by `symbol`, with `refs`; its index. */
  private symbolType(kind: RecordKind, t: Type, symbol: Symbol, refs: readonly number[]): number {
    if (!this.nameSymbol(symbol, false)) return -1;
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(kind, index, refs, this.naming << RecordHeader.NamingShift);
    return index;
  }

  /** The record of the type `t` of the type node `node`; its index. */
  private nodeType(t: Type, node: Node): number {
    if (!this.sharedNode(node)) return -1;
    this.node = node;
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(RecordKind.NodeType, index, noRefs, RecordHeader.HasNode);
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

  type(t: Type): number {
    if (this.failure !== undefined) return -1;
    const known = this.indexes.get(t.id);
    if (known !== undefined) return known;
    const initial = this.initial.get(t.id);
    if (initial !== undefined) return this.initialType(t, initial);
    const c = this.c;
    const flags = t.flags;
    if ((flags & TypeFlags.Literal) !== 0 && (flags & TypeFlags.Boolean) === 0) return this.literal(t as LiteralType);
    if ((flags & TypeFlags.UniqueESSymbol) !== 0) {
      if (c.uniqueESSymbolTypes.get(t.symbol!) !== t) return this.fail('unique symbol');
      return this.symbolType(RecordKind.UniqueSymbol, t, t.symbol!, noRefs);
    }
    if ((flags & TypeFlags.TypeParameter) !== 0) {
      const symbol = t.symbol;
      if (symbol === undefined) return this.fail('type parameter without a symbol');
      const declared = getDeclaredTypeOfSymbol(c, symbol);
      if (declared === t) return this.symbolType(RecordKind.Declared, t, symbol, noRefs);
      if ((declared.objectFlags & ObjectFlags.ClassOrInterface) !== 0 && (declared as InterfaceType).thisType === t)
        return this.symbolType(RecordKind.ThisType, t, symbol, noRefs);
      return this.fail('fresh type parameter');
    }
    if (t.symbol !== undefined && (flags & (TypeFlags.Union | TypeFlags.Enum)) !== 0) {
      // An enum type: the declared type of its symbol.
      if (getDeclaredTypeOfSymbol(c, t.symbol) !== t) return this.fail('enum type');
      return this.symbolType(RecordKind.Declared, t, t.symbol, noRefs);
    }
    if ((flags & TypeFlags.Union) !== 0) return this.union(t as UnionType);
    if ((flags & TypeFlags.Intersection) !== 0) return this.intersection(t as UnionOrIntersectionType);
    if ((flags & TypeFlags.Object) !== 0) return this.object(t as ObjectType);
    if ((flags & TypeFlags.Index) !== 0) {
      const target = this.type((t as IndexType).target);
      if (this.failure !== undefined) return -1;
      const index = this.nextIndex();
      this.memo(t, index);
      this.begin(RecordKind.Index, index, [target], 0);
      this.writer.word((t as IndexType).indexFlags);
      return index;
    }
    if ((flags & TypeFlags.IndexedAccess) !== 0) {
      const access = t as IndexedAccessType;
      const refs = this.types([access.objectType, access.indexType]);
      if (this.failure !== undefined) return -1;
      const alias = t.alias;
      const aliasRefs = alias === undefined ? noRefs : this.types(alias.typeArguments);
      if (this.failure !== undefined) return -1;
      const bits = this.aliasBits(alias, aliasRefs);
      if (bits < 0) return -1;
      const index = this.nextIndex();
      this.memo(t, index);
      this.begin(RecordKind.IndexedAccess, index, refs, bits);
      this.writer.word(this.c.indexedAccessKeyFlags!.get(t) ?? access.accessFlags);
      return index;
    }
    if ((flags & TypeFlags.Conditional) !== 0) return this.conditional(t as ConditionalType);
    if ((flags & TypeFlags.TemplateLiteral) !== 0) {
      const template = t as TemplateLiteralType;
      const refs = this.types(template.types);
      if (this.failure !== undefined) return -1;
      const index = this.nextIndex();
      this.memo(t, index);
      this.begin(RecordKind.Template, index, refs, 0);
      const texts = template.texts;
      this.writer.word(texts.length);
      for (let i = 0; i < texts.length; i++) this.writer.text(texts[i]!);
      return index;
    }
    if ((flags & TypeFlags.StringMapping) !== 0) {
      const target = this.type((t as StringMappingType).target);
      if (this.failure !== undefined) return -1;
      return this.symbolType(RecordKind.StringMapping, t, t.symbol!, [target]);
    }
    if ((flags & TypeFlags.Substitution) !== 0) {
      const substitution = t as SubstitutionType;
      if (isNoInferType(c, t)) {
        const base = this.type(substitution.baseType);
        if (this.failure !== undefined) return -1;
        return this.plain(RecordKind.NoInfer, t, [base]);
      }
      const refs = this.types([substitution.baseType, substitution.constraint]);
      if (this.failure !== undefined) return -1;
      return this.plain(RecordKind.Substitution, t, refs);
    }
    return this.fail('type flags ' + flags);
  }

  private literal(t: LiteralType): number {
    const regular = t.regularType;
    if (regular !== t) {
      if (regular.freshType !== t) return this.fail('literal');
      const index = this.type(regular);
      if (this.failure !== undefined) return -1;
      return this.plain(RecordKind.FreshLiteral, t, [index]);
    }
    if (t.symbol !== undefined) {
      if (getDeclaredTypeOfSymbol(this.c, t.symbol) !== t) return this.fail('enum literal');
      return this.symbolType(RecordKind.EnumLiteral, t, t.symbol, noRefs);
    }
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(RecordKind.Literal, index, noRefs, 0);
    const w = this.writer;
    w.word(t.flags);
    if ((t.flags & TypeFlags.NumberLiteral) !== 0) w.double(t.numberValue);
    else w.text(t.stringValue);
    return index;
  }

  /** The record of the constituents of a union's or intersection's origin, which is not a type: it has no alias. */
  private originRecord(kind: RecordKind, flags: number, refs: readonly number[]): number {
    const index = this.nextIndex();
    this.begin(kind, index, refs, RecordHeader.Constituent);
    this.writer.word(flags);
    // A union's origin field is -1 here, as it is for a union with no origin: the constituents are refs, and the
    // reader scans the field for records this record depends on.
    if (kind === RecordKind.Union) this.writer.word(-1);
    return index;
  }

  private union(t: UnionType): number {
    const refs = this.types(t.types);
    if (this.failure !== undefined) return -1;
    let origin = -1;
    const o = t.origin;
    if (o !== undefined) {
      if ((o.flags & TypeFlags.UnionOrIntersection) !== 0) {
        // Origins are not interned: a union key spells their constituents.
        const parts = this.types((o as UnionOrIntersectionType).types);
        if (this.failure !== undefined) return -1;
        const kind = (o.flags & TypeFlags.Union) !== 0 ? RecordKind.Union : RecordKind.Intersection;
        origin = this.originRecord(kind, o.objectFlags, parts);
      } else {
        origin = this.type(o);
        if (this.failure !== undefined) return -1;
      }
    }
    const alias = t.alias;
    const aliasRefs = alias === undefined ? noRefs : this.types(alias.typeArguments);
    if (this.failure !== undefined) return -1;
    const bits = this.aliasBits(alias, aliasRefs);
    if (bits < 0) return -1;
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(RecordKind.Union, index, refs, bits);
    this.writer.word(t.objectFlags);
    this.writer.word(origin);
    return index;
  }

  private intersection(t: UnionOrIntersectionType): number {
    const refs = this.types(t.types);
    if (this.failure !== undefined) return -1;
    const alias = t.alias;
    const aliasRefs = alias === undefined ? noRefs : this.types(alias.typeArguments);
    if (this.failure !== undefined) return -1;
    const bits = this.aliasBits(alias, aliasRefs);
    if (bits < 0) return -1;
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(RecordKind.Intersection, index, refs, bits);
    this.writer.word(t.objectFlags);
    return index;
  }

  private object(t: ObjectType): number {
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
        return this.symbolType(RecordKind.Declared, t, symbol, noRefs);
      }
      const refs = [this.type(target), ...this.types(reference.resolvedTypeArguments ?? [])];
      if (this.failure !== undefined) return -1;
      return this.plain(RecordKind.Reference, t, refs);
    }
    if ((objectFlags & ObjectFlags.ClassOrInterface) !== 0) {
      if (symbol === undefined || getDeclaredTypeOfSymbol(c, symbol) !== t) return this.fail('declared type');
      return this.symbolType(RecordKind.Declared, t, symbol, noRefs);
    }
    if ((objectFlags & (ObjectFlags.ReverseMapped | ObjectFlags.EvolvingArray)) !== 0) return this.fail('object kind');
    if ((objectFlags & ObjectFlags.Instantiated) !== 0) return this.instantiation(t);
    if ((objectFlags & (ObjectFlags.Anonymous | ObjectFlags.Mapped)) === 0 || symbol === undefined)
      return this.fail('object without a declaration, object flags ' + objectFlags);
    // The anonymous type of a function, class, enum or module; a variable's own type is what is being shared.
    if ((symbol.flags & sharedValueFlags()) === 0 && c.symbolTypes.get(getSymbolId(symbol)) === t)
      return this.symbolType(RecordKind.SymbolType, t, symbol, noRefs);
    const declaration = (objectFlags & ObjectFlags.Mapped) !== 0 ? (t as MappedType).declaration : symbol.declaration;
    if (declaration !== undefined && c.resolvedTypes.get(declaration.id) === t) return this.nodeType(t, declaration);
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
  private anonymousObject(t: ObjectType): number {
    const c = this.c;
    if ((t.objectFlags & ObjectFlags.SideState) !== 0 || c.patternForType.has(t))
      return this.fail('object literal state');
    const resolved = t as StructuredType;
    if (resolved.callSignatures.length !== 0 || resolved.constructSignatures.length !== 0)
      return this.fail('object literal signatures');
    const shell = this.nextIndex();
    this.memo(t, shell);
    const members: number[] = [];
    for (const prop of resolved.properties) {
      members.push(this.property(prop));
      if (this.failure !== undefined) return -1;
    }
    const infos: IndexInfoWords[] = [];
    for (const info of resolved.indexInfos) {
      const key = this.type(info.keyType);
      const value = this.type(info.valueType);
      if (this.failure !== undefined) return -1;
      if (!this.sharedNode(info.declaration)) return -1;
      for (const node of info.components) if (!this.sharedNode(node)) return -1;
      infos.push(new IndexInfoWords(key, value, info.isReadonly, info.declaration, info.components));
    }
    const complete = this.nextIndex();
    if (!this.nameSymbol(t.symbol!, false)) return -1;
    this.begin(RecordKind.AnonymousObject, shell, noRefs, this.naming << RecordHeader.NamingShift);
    const w = this.writer;
    w.word(t.objectFlags & ~lazyObjectFlags());
    w.word(complete);
    this.begin(RecordKind.CompleteObject, complete, members, 0);
    w.word(shell);
    w.word(infos.length);
    for (const info of infos) {
      w.word(info.keyType);
      w.word(info.valueType);
      w.word(info.isReadonly ? 1 : 0);
      w.node(info.declaration);
      w.word(info.components.length);
      for (const node of info.components) w.node(node);
    }
    return shell;
  }

  /** A property symbol of an object literal type: a checker's own, made from one of the program or from another. */
  private property(prop: Symbol): number {
    const id = getSymbolId(prop);
    const known = this.properties.get(id);
    if (known !== undefined) return known;
    const c = this.c;
    if ((prop.flags & SymbolFlags.Transient) === 0) return this.fail('property of the program');
    if ((prop.checkFlags & ~(CheckFlags.Readonly | CheckFlags.Late)) !== 0)
      return this.fail('property check flags ' + prop.checkFlags);
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
    const declarations = getDeclarations(prop);
    if (!this.sharedNode(prop.valueDeclaration)) return -1;
    for (const node of declarations) if (!this.sharedNode(node)) return -1;
    const index = this.nextIndex();
    this.properties.set(id, index);
    this.addedProperties.push(id);
    if (!this.nameSymbol(program, false)) return -1;
    const value = prop.valueDeclaration;
    const valueIsFirst = value !== undefined && declarations.length !== 0 && declarations[0] === value;
    this.node = value;
    let bits =
      (this.naming << RecordHeader.NamingShift) |
      (valueIsFirst ? RecordHeader.ValueIsFirst : value !== undefined ? RecordHeader.HasNode : 0);
    if (prop.parent !== undefined) {
      if (!this.nameSymbol(prop.parent, true)) return -1;
      bits |= RecordHeader.HasAlias | (this.aliasMerged >= 0 ? RecordHeader.AliasMerged : 0);
    }
    this.begin(RecordKind.Property, index, [type, name, target], bits);
    const w = this.writer;
    w.word(prop.flags);
    w.word(prop.checkFlags);
    w.text(prop.name);
    w.word(declarations.length);
    for (const node of declarations) w.node(node);
    return index;
  }

  private tupleTarget(t: TupleType): number {
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(RecordKind.TupleTarget, index, noRefs, 0);
    const w = this.writer;
    w.word(t.readonly ? 1 : 0);
    const infos = t.elementInfos;
    w.word(infos.length);
    for (const info of infos) {
      if (!this.sharedNode(info.labeledDeclaration)) return -1;
      w.word(info.flags);
      w.node(info.labeledDeclaration);
    }
    return index;
  }

  /** An instantiated anonymous or mapped type, or a deferred type reference: its target and outer type arguments. */
  private instantiation(t: ObjectType): number {
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
      return this.nodeType(t, declaration);
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
    // The alias and its type arguments are exported before the record, as the record names them: a consumer builds
    // records in index order, and would find them unbuilt after it.
    const alias = t.alias;
    const aliasRefs = alias === undefined ? noRefs : this.types(alias.typeArguments);
    if (this.failure !== undefined) return -1;
    if (!this.sharedNode(declaration)) return -1;
    // The record is written after the return types of its signatures, which are built right after it: its index is
    // lower than theirs.
    const index = this.nextIndex();
    this.memo(t, index);
    // Only for an export that hasn't failed (its alias may have): optionalType would forget that failure.
    if (this.failure === undefined) this.resolvedReturnTypes(t, refs);
    if (this.failure !== undefined) return -1;
    const bits = this.aliasBits(alias, aliasRefs);
    if (bits < 0) return -1;
    this.node = declaration;
    this.begin(RecordKind.Instantiation, index, refs, bits | RecordHeader.HasNode);
    this.writer.word(args.length);
    return index;
  }

  /**
   * Adds to `refs` the return types the checker resolved for the signatures of the instantiation `t`, exported after
   * it. The consumer then creates them right after `t` and before the types that contain it, as this checker did:
   * inference stops at references whose type ids grow along its stack (`isDeeplyNestedType`), so a consumer that
   * created them later, when it resolved them, could stop an inference this checker made.
   */
  private resolvedReturnTypes(t: ObjectType, refs: number[]): void {
    if ((t.objectFlags & ObjectFlags.MembersResolved) === 0) return;
    for (const signatures of [t.callSignatures, t.constructSignatures])
      for (const signature of signatures) {
        const returnType = resolvedReturnTypeOf(this.c, signature);
        if (returnType === undefined) continue;
        const index = this.optionalType(returnType);
        if (index >= 0) refs.push(index);
      }
  }

  /**
   * The record of `t`, or -1 if it can't be exported; that leaves the export in progress as it was. An export that
   * failed before stays failed.
   */
  optionalType(t: Type): number {
    if (this.failure !== undefined) return -1;
    const w = this.writer;
    const at = w.at;
    const unitAt = w.unitAt;
    const count = this.count;
    const types = this.addedTypes.length;
    const properties = this.addedProperties.length;
    const index = this.type(t);
    if (this.failure === undefined) return index;
    for (let i = types; i < this.addedTypes.length; i++) this.indexes.delete(this.addedTypes[i]!);
    for (let i = properties; i < this.addedProperties.length; i++) this.properties.delete(this.addedProperties[i]!);
    this.addedTypes.length = types;
    this.addedProperties.length = properties;
    this.count = count;
    w.at = at;
    w.unitAt = unitAt;
    // A store that ran out stays out: the export can't be posted.
    this.failure = undefined;
    return -1;
  }

  /**
   * The record of the conditional type `t`: the conditional type of a type node, or the instantiation of one with
   * outer type arguments; -1 if it can't be exported.
   */
  private conditional(t: ConditionalType): number {
    const root = t.root;
    if (t.mapper === undefined) {
      if (this.c.resolvedTypes.get(root.node.id) !== t) return this.fail('conditional type');
      return this.nodeType(t, root.node);
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
        const alias = keyed.alias;
        const aliasRefs = alias === undefined ? noRefs : this.types(alias.typeArguments);
        if (this.failure !== undefined) return -1;
        const bits = this.aliasBits(alias, aliasRefs);
        if (bits < 0) return -1;
        if (!this.sharedNode(keyed.root.node)) return -1;
        this.node = keyed.root.node;
        const index = this.nextIndex();
        this.memo(t, index);
        this.begin(RecordKind.Conditional, index, refs, bits | RecordHeader.HasNode);
        this.writer.word(keyed.tag);
        return index;
      }
      const distributed = this.c.distributedConditionals?.get(t);
      if (distributed === undefined) return this.fail('conditional instantiation not found');
      const refs = this.types([...distributed.typeArguments, distributed.constituent]);
      if (this.failure !== undefined) return -1;
      const alias = distributed.alias;
      const aliasRefs = alias === undefined ? noRefs : this.types(alias.typeArguments);
      if (this.failure !== undefined) return -1;
      const bits = this.aliasBits(alias, aliasRefs);
      if (bits < 0) return -1;
      if (!this.sharedNode(root.node)) return -1;
      this.node = root.node;
      const index = this.nextIndex();
      this.memo(t, index);
      this.begin(RecordKind.DistributedConditional, index, refs, bits | RecordHeader.HasNode);
      this.writer.word(distributed.tag);
      return index;
    }
    const refs = this.types(args);
    if (this.failure !== undefined) return -1;
    const alias = t.alias;
    const aliasRefs = alias === undefined ? noRefs : this.types(alias.typeArguments);
    if (this.failure !== undefined) return -1;
    const bits = this.aliasBits(alias, aliasRefs);
    if (bits < 0) return -1;
    if (!this.sharedNode(root.node)) return -1;
    this.node = root.node;
    const index = this.nextIndex();
    this.memo(t, index);
    this.begin(RecordKind.Conditional, index, refs, bits | RecordHeader.HasNode);
    this.writer.word(tag);
    return index;
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
const noTypes: Type[] = [];

/** A type alias whose symbol and type arguments are read: its declared type first, as instantiating it does. */
function typeAliasOf(c: Checker, symbol: Symbol, refs: Type[]): TypeAlias {
  // An instantiation of an alias follows its declared type, which records the alias's type parameters.
  getDeclaredTypeOfSymbol(c, symbol);
  return new TypeAlias(symbol, refs);
}

/** Translates the records of another checker's store into this checker's types, reading them where they are. */
export class Translator {
  readonly c: Checker;
  readonly store: StoreReader;
  readonly initial: Type[];
  /** Set when a record has no counterpart here; the translation is then abandoned. */
  failed = false;

  constructor(c: Checker, store: StoreReader) {
    this.c = c;
    this.store = store;
    this.initial = initialTypes(c);
  }

  /**
   * The symbol of `node`, named by `how`: the symbol of the node itself, or its export symbol. The record names
   * symbols of the program this way, and a consumer that hasn't the symbol fails the translation.
   */
  private namedSymbol(node: Node, how: number): Symbol | undefined {
    const local = getSymbol(node);
    return how === SymbolNaming.Export ? local?.exportSymbol : local;
  }

  /** Abandons the record being read: the translation fails, and a later one starts afresh. */
  private abandon(): undefined {
    this.failed = true;
    return undefined;
  }

  /** A property symbol made as the producer made it; undefined if its record can't be read here. */
  property(index: number): Symbol | undefined {
    const c = this.c;
    const store = this.store;
    const reader = store.reader;
    if (!reader.begin(index)) return this.abandon();
    const f = reader.numbers;
    const type = store.types.get(f[reader.refAt]!);
    if (type === undefined) return this.abandon();
    const nameAt = f[reader.refAt + 1]!;
    const targetAt = f[reader.refAt + 2]!;
    let parent: Symbol | undefined = undefined;
    if (reader.aliasNaming >= 0) {
      if (reader.aliasNaming === SymbolNaming.Merged) parent = c.mergedSymbols.get(reader.aliasMergedId);
      else {
        const node = reader.readNode(reader.aliasNodeStart);
        if (node === undefined) return this.abandon();
        parent = this.namedSymbol(node, reader.aliasNaming);
      }
      if (parent === undefined) return this.abandon();
    }
    let source: Symbol | undefined = undefined;
    if (reader.symbolNaming === SymbolNaming.Merged) source = c.mergedSymbols.get(reader.symbolMergedId);
    else if (reader.symbolNaming !== SymbolNaming.None) {
      const node = reader.readNode(reader.symbolNodeStart);
      if (node === undefined) return this.abandon();
      source = this.namedSymbol(node, reader.symbolNaming);
    }
    if (reader.symbolNaming !== SymbolNaming.None && source === undefined) return this.abandon();
    let value: Node | undefined = undefined;
    if (reader.nodeStart >= 0) {
      value = reader.readNode(reader.nodeStart);
      if (value === undefined) return this.abandon();
    }
    let p = reader.fields;
    const flags = f[p++]!;
    const checkFlags = f[p++]!;
    const text = reader.textAt(p);
    p += 2;
    const count = f[p++]!;
    const declarations: Node[] = [];
    for (let i = 0; i < count; i++) {
      const node = reader.readNode(p);
      p += reader.nodeWords(p);
      if (node === undefined) return this.abandon();
      declarations.push(node);
    }
    if ((reader.header & RecordHeader.ValueIsFirst) !== 0) value = declarations[0];
    const prop = c.newSymbolWithCheckFlags(flags & ~SymbolFlags.Transient, text, checkFlags);
    setDeclarations(prop, declarations);
    prop.valueDeclaration = value;
    if (parent !== undefined) prop.parent = parent;
    const id = getSymbolId(prop);
    c.symbolTypes.set(id, type);
    if (nameAt >= 0) {
      const nameType = store.types.get(nameAt);
      if (nameType === undefined) return this.abandon();
      c.symbolNameTypes.set(id, nameType);
    }
    const target = targetAt >= 0 ? store.symbols.get(targetAt) : source;
    if (target !== undefined) c.symbolTargets.set(id, target);
    return prop;
  }

  /** Sets the members of the `AnonymousObject` record a `CompleteObject` record completes; false if it can't read it. */
  complete(index: number): boolean {
    const c = this.c;
    const store = this.store;
    const reader = store.reader;
    if (!reader.begin(index)) return false;
    const f = reader.numbers;
    const refAt = reader.refAt;
    let p = reader.fields;
    const shell = store.types.get(f[p++]!);
    if (shell === undefined) return false;
    if ((shell.objectFlags & ObjectFlags.MembersResolved) !== 0) return true;
    const members = new Map<string, Symbol>();
    for (let i = 0; i < reader.refCount; i++) {
      const prop = store.symbols.get(f[refAt + i]!);
      if (prop === undefined) return false;
      members.set(prop.name, prop);
    }
    const count = f[p++]!;
    const infos: IndexInfo[] = [];
    for (let i = 0; i < count; i++) {
      const keyType = store.types.get(f[p]!);
      const valueType = store.types.get(f[p + 1]!);
      const isReadonly = f[p + 2]! === 1;
      p += 3;
      const declaration = reader.readNode(p);
      p += reader.nodeWords(p);
      const components: Node[] = [];
      const componentCount = f[p++]!;
      for (let j = 0; j < componentCount; j++) {
        const node = reader.readNode(p);
        p += reader.nodeWords(p);
        if (node === undefined) return false;
        components.push(node);
      }
      if (keyType === undefined || valueType === undefined) return false;
      infos.push(new IndexInfo(keyType, valueType, isReadonly, declaration, components));
    }
    setStructuredTypeMembers(c, shell, members, [], [], infos);
    keepPropertiesOnly(c, shell as StructuredType, members, scannedLiteralPropertiesLimit);
    return true;
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

  /** The type record `index`; undefined if it or a record it needs can't be translated here. */
  record(index: number): Type | undefined {
    const c = this.c;
    const store = this.store;
    const reader = store.reader;
    if (!reader.begin(index)) return this.abandon();
    const f = reader.numbers;
    const header = reader.header;
    const kind = reader.kind;
    const n = reader.refCount;
    // An instantiation's refs end with the return types of its signatures, which are built after it.
    const count = kind === RecordKind.Instantiation ? Math.min(n, 1 + f[reader.fields]!) : n;
    const refs = new Array<Type>(count);
    for (let i = 0; i < count; i++) {
      const t = store.types.get(f[reader.refAt + i]!);
      if (t === undefined) return this.abandon();
      refs[i] = t;
    }
    let aliasSymbol: Symbol | undefined = undefined;
    let aliasRefs: Type[] = noTypes;
    if (reader.aliasNaming >= 0) {
      if (reader.aliasNaming === SymbolNaming.Merged) {
        aliasSymbol = c.mergedSymbols.get(reader.aliasMergedId);
        if (aliasSymbol === undefined) return this.abandon();
      } else {
        const aliasNode = reader.readNode(reader.aliasNodeStart);
        if (aliasNode === undefined) return this.abandon();
        aliasSymbol = this.namedSymbol(aliasNode, reader.aliasNaming);
        if (aliasSymbol === undefined) return this.abandon();
      }
      const aliasCount = reader.aliasRefCount;
      const types = new Array<Type>(aliasCount);
      for (let i = 0; i < aliasCount; i++) {
        const t = store.types.get(f[reader.aliasRefAt + i]!);
        if (t === undefined) return this.abandon();
        types[i] = t;
      }
      aliasRefs = types;
    }
    let symbol: Symbol | undefined = undefined;
    if (reader.symbolNaming === SymbolNaming.Merged) {
      symbol = c.mergedSymbols.get(reader.symbolMergedId);
      if (symbol === undefined) return this.abandon();
    } else if (reader.symbolNaming !== SymbolNaming.None) {
      const symbolNode = reader.readNode(reader.symbolNodeStart);
      if (symbolNode === undefined) return this.abandon();
      symbol = this.namedSymbol(symbolNode, reader.symbolNaming);
      if (symbol === undefined) return this.abandon();
    }
    let node: Node | undefined = undefined;
    if (reader.nodeStart >= 0) {
      node = reader.readNode(reader.nodeStart);
      if (node === undefined) return this.abandon();
    }
    let p = reader.fields;
    switch (kind) {
      case RecordKind.Initial:
        return this.initial[f[p]!];
      case RecordKind.Literal: {
        const flags = f[p++]!;
        if ((flags & TypeFlags.NumberLiteral) !== 0) return getNumberLiteralType(c, reader.doubleAt(p));
        const text = reader.textAt(p);
        return (flags & TypeFlags.StringLiteral) !== 0 ? getStringLiteralType(c, text) : getBigIntLiteralType(c, text);
      }
      case RecordKind.FreshLiteral:
        return getFreshTypeOfLiteralType(c, refs[0]!);
      case RecordKind.EnumLiteral:
      case RecordKind.Declared:
        return getDeclaredTypeOfSymbol(c, symbol!);
      case RecordKind.ThisType:
        return (getDeclaredTypeOfSymbol(c, symbol!) as InterfaceType).thisType!;
      case RecordKind.UniqueSymbol:
        return getESSymbolLikeTypeForNode(c, symbol!.valueDeclaration!);
      case RecordKind.SymbolType:
        return getTypeOfSymbol(c, symbol!);
      case RecordKind.NodeType: {
        const cached = c.resolvedTypes.get(node!.id);
        if (cached !== undefined) return cached;
        this.aliasOfNode(node!);
        if (this.failed) return undefined;
        const t = getTypeFromTypeNode(c, node!);
        return c.resolvedTypes.get(node!.id) ?? t;
      }
      case RecordKind.Reference:
        return createTypeReference(c, refs[0]!, refs.slice(1));
      case RecordKind.TupleTarget: {
        const readonly = f[p++]! === 1;
        const infosCount = f[p++]!;
        const infos: TupleElementInfo[] = [];
        for (let i = 0; i < infosCount; i++) {
          const flags = f[p++]!;
          const label = reader.readNode(p);
          p += reader.nodeWords(p);
          infos.push(new TupleElementInfo(flags, label));
        }
        return getTupleTargetType(c, infos, readonly);
      }
      case RecordKind.Instantiation: {
        const args = f[p++]!;
        const target = refs[0]!;
        const typeParameters = outerTypeParametersOf(c, node!, target);
        return instantiateTypeWithAlias(
          c,
          target,
          newTypeMapper(typeParameters, refs.slice(1, 1 + args)),
          aliasSymbol === undefined ? undefined : typeAliasOf(c, aliasSymbol, aliasRefs),
        );
      }
      case RecordKind.Union: {
        const flags = f[p++]!;
        const originAt = f[p++]!;
        if ((header & RecordHeader.Constituent) !== 0) return newUnionType(c, flags & ObjectFlags.None, refs);
        return getUnionTypeFromSortedList(
          c,
          refs,
          flags & (ObjectFlags.PrimitiveUnion | ObjectFlags.ContainsIntersections),
          aliasSymbol === undefined ? undefined : typeAliasOf(c, aliasSymbol, aliasRefs),
          originAt >= 0 ? store.types.get(originAt) : undefined,
        );
      }
      case RecordKind.Intersection: {
        const flags = f[p++]!;
        if ((header & RecordHeader.Constituent) !== 0) return newIntersectionType(c, ObjectFlags.None, refs);
        const alias = aliasSymbol === undefined ? undefined : typeAliasOf(c, aliasSymbol, aliasRefs);
        const hash = typeListHash(refs, alias, 0);
        const existing = c.intersectionTypes.get(hash, refs, alias, 0);
        if (existing !== undefined) return existing;
        const result = newIntersectionType(
          c,
          (flags & ObjectFlags.IsConstrainedTypeVariable) | getPropagatingFlagsOfTypes(refs, TypeFlags.Nullable),
          refs,
        );
        result.alias = alias;
        c.intersectionTypes.set(hash, refs, alias, 0, result);
        return result;
      }
      case RecordKind.Index:
        return getIndexTypeEx(c, refs[0]!, f[p]!);
      case RecordKind.IndexedAccess:
        return getIndexedAccessTypeEx(
          c,
          refs[0]!,
          refs[1]!,
          f[p]!,
          undefined,
          aliasSymbol === undefined ? undefined : typeAliasOf(c, aliasSymbol, aliasRefs),
        );
      case RecordKind.Conditional: {
        const tag = f[p++]!;
        this.aliasOfNode(node!);
        if (this.failed) return undefined;
        const declared = c.resolvedTypes.get(node!.id) ?? getTypeFromTypeNode(c, node!);
        const root = (declared as ConditionalType).root;
        return getConditionalTypeInstantiation(
          c,
          declared as ConditionalType,
          newTypeMapper(root.outerTypeParameters, refs),
          tag === 1,
          aliasSymbol === undefined ? undefined : typeAliasOf(c, aliasSymbol, aliasRefs),
        );
      }
      case RecordKind.DistributedConditional: {
        const tag = f[p++]!;
        this.aliasOfNode(node!);
        if (this.failed) return undefined;
        const declared = (c.resolvedTypes.get(node!.id) ?? getTypeFromTypeNode(c, node!)) as ConditionalType;
        const root = declared.root;
        const args = refs.slice(0, refs.length - 1);
        const alias = aliasSymbol === undefined ? undefined : typeAliasOf(c, aliasSymbol, aliasRefs);
        getConditionalTypeInstantiation(c, declared, newTypeMapper(root.outerTypeParameters, args), tag === 1, alias);
        const member = c.distributedByKey?.get(distributedKey(root.node.id, args, alias, tag, refs[refs.length - 1]!));
        if (member === undefined) return this.abandon();
        return member;
      }
      case RecordKind.Template: {
        const textsCount = f[p++]!;
        const texts: string[] = [];
        for (let i = 0; i < textsCount; i++) {
          texts.push(reader.textAt(p));
          p += 2;
        }
        return getTemplateLiteralType(c, texts, refs);
      }
      case RecordKind.StringMapping:
        return getStringMappingType(c, symbol!, refs[0]!);
      case RecordKind.Substitution:
        return getSubstitutionType(c, refs[0]!, refs[1]!);
      case RecordKind.NoInfer:
        return getNoInferType(c, refs[0]!);
      case RecordKind.AnonymousObject: {
        // A translation that failed after this record opened the type still made it, and a record built then may name
        // it: the completion must fill that type, not a new one beside it.
        const known = store.types.get(index);
        if (known !== undefined) return known;
        return newObjectType(c, f[p]! | ObjectFlags.Anonymous, symbol);
      }
      case RecordKind.CompleteObject:
      case RecordKind.Property:
        return this.abandon();
    }
  }
}
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

/**
 * What a checker thread needs to share results with the others; posted in its `workerData` (a plain object: class
 * instances arrive without their class).
 */
export interface ThreadSharingData {
  readonly index: number;
  readonly count: number;
  /**
   * Whether this run's posts are cost-bounded (`RunConfig.bounded`): it posts only results another checker demanded
   * and its takes build a bounded number of records. A run with it off keeps Phase 1's rule.
   */
  readonly bounded: boolean;
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
   * For each file, by file index, the checkers (one bit each, the same shape as `forbidden`) that looked for a result
   * for one of its declarations and found none. A checker posts a result only for a declaration whose file one of
   * them reads (`ThreadSharing.demanded`).
   */
  readonly wanted: SharedArrayBuffer;
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
   * of their strings. `used` has two counters per checker, `usedStride` int32s apart, how much of each it wrote; a
   * checker keeps its cursors in its own writer and writes them there only for the summary. (Results go through
   * shared memory: a message a worker receives synchronously makes the native build store the number fields of
   * classes as doubles.)
   */
  readonly numberLogs: SharedArrayBuffer[];
  readonly stringLogs: SharedArrayBuffer[];
  readonly used: SharedArrayBuffer;
  /** For each checker, where each record of its store is in its number log: a word per record. */
  readonly recordTables: SharedArrayBuffer[];
  /**
   * One int32, read by every checker before it posts or translates a result: 0 runs, 1 stops posting, 2
   * stops posting and translating. The main thread sets it (`startParallelCheck`'s window) when the
   * results are not worth what they cost; every switch keeps the diagnostics the same, because a
   * checker that does not take a posted result computes it itself.
   */
  readonly control: SharedArrayBuffer;
  /**
   * One row of `shareStatColumns` doubles per checker, for the counters the main thread reads while
   * checking runs (`ThreadSharing.writeStats`).
   */
  readonly stats: SharedArrayBuffer;
}

/**
 * The columns of a checker's row of `ThreadSharingData.stats`: the milliseconds of its outermost
 * computations by kind (0 owned, 1 computed here for a file another checker took, 2 translated, 3
 * other), of exporting, translating and unpacking results, the results it posted and translated, and
 * the milliseconds it saved by translating a result instead of computing it.
 */
export const shareStatColumns = 10;
export const shareStatKinds = 4;
export const shareStatExport = 4;
export const shareStatTranslation = 5;
export const shareStatUnpack = 6;
export const shareStatPosted = 7;
export const shareStatTranslated = 8;
export const shareStatSaved = 9;

/**
 * The size of each checker's logs: numbers (int32s) and string code units (2 bytes each), 8 MB and 2 MB. Only the
 * pages a checker writes take memory.
 */
export const numberLogSize = 1 << 21;
export const stringLogSize = 1 << 20;

/** The number of records each checker's store can hold. */
export const recordTableSize = 1 << 20;

/** The int32s each checker gets in `ThreadSharingData.used`, a cache line each, for two counters. */
export const usedStride = 16;

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

/** Whether checker `index` of `count` looked for a result for a declaration of file `file` and found none (`wanted`). */
export function isWanted(wanted: Int32Array, count: number, file: number, index: number): boolean {
  return (Atomics.load(wanted, file * forbiddenWords(count) + (index >>> 5)) & (1 << (index & 31))) !== 0;
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

/** TSC_TS_SHARE_MIN_MS: the shortest computation a checker posts, in milliseconds (`shareFloorTotalMs` split by the checkers by default). */
const shareMinValue = process.env.TSC_TS_SHARE_MIN_MS;

/**
 * The floor, in milliseconds of checker time split over the checkers that share: 1 ms with 4 checkers, 0.25 ms with
 * 16.
 */
const shareFloorTotalMs = 4;

/** `TSC_TS_SHARE_<name>` as a number, or `fallback`. */
function shareNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The posting rule's cost model: a post appends at most `(kappa*T - p0)/e` records (`T` the computation's time), a
 * take builds at most `lambda*T/c`, `p0` is what a post costs itself, `e` each record a post adds and `c` each record
 * a take builds, all in microseconds. The price instrumentation's replay (`TSC_TS_SHARE_PRICE`) fits them; the
 * `TSC_TS_SHARE_*` variables override them for measurement.
 *
 * Read where they are used, not once at module evaluation: this module is in an import cycle (it imports
 * `checker-symbols.js`, which imports `checker.js`, which imports this module), and scriptc rejects code that runs at
 * module evaluation there (SC1016: a class the cycle reaches can be accessed before its declaration runs), so a
 * `const kappa = shareNumber(...)` at the top level does not build.
 */
function shareKappa(): number {
  return shareNumber('TSC_TS_SHARE_KAPPA', 0.25);
}
function shareLambda(): number {
  return shareNumber('TSC_TS_SHARE_LAMBDA', 0.3);
}
function sharePostUs(): number {
  return shareNumber('TSC_TS_SHARE_P0_US', 0.3);
}
function shareExportRecordUs(): number {
  return shareNumber('TSC_TS_SHARE_E_US', 1.2);
}
function shareBuildRecordUs(): number {
  return shareNumber('TSC_TS_SHARE_C_US', 6.59);
}
/**
 * Whether a run posts cost-bounded is its configuration's choice (`RunConfig.bounded`), not a rule here: off by
 * default, because a bounded post costs a run that gains nothing by it (T3 server's c16 check was 8-9% slower),
 * and turned on where the project's own runs measured it faster (`run-config.ts`). A bounded run keeps the 2-8 ms
 * floor's sharing gate, posts only results another checker demanded, and budgets both the records a post adds and
 * the records a take builds; an unbounded run keeps Phase 1's rule and posts every result over the floor.
 */

/** The floor's total in milliseconds before the cost-bounded rule (`shareFloorTotalMs`): 2 ms at 16, 8 ms at 4. */
const shareFloorTotalMsPhase1 = 32;

/**
 * The rule that decides whether a checker posts a result it computed, and how much a consumer may build to take one.
 * The conditions that keep a take exact (the result's diagnostics, `forbidsLast`, the resolution stack) are checked
 * by the callers, as are the stop switch and the demand bits.
 */
export interface PostingRule {
  /**
   * Whether a checker that just computed the result keyed `key` of a declaration in file `fileIndex` may post it, in
   * `ms`, with `diagnosticFiles` the files its diagnostics are in. The caller checks first that the computation met
   * no resolution cycle, that the stop switch is off, that (when the run is cost-bounded) another checker demanded the
   * file (`demanded`) and that no result for the key is posted.
   */
  posts(
    sharing: ThreadSharing,
    key: number,
    ms: number,
    diagnosticFiles: readonly number[],
    fileIndex: number,
  ): boolean;

  /**
   * The most records a consumer may build to take a posted result whose producer computed it in `ms` milliseconds: 0
   * admits only takes that build nothing, because every record they need is in the consumer's caches already.
   */
  buildBudget(ms: number): number;
}

/**
 * The rule of the design's Phase 2: a result is posted when it took at least the floor (`ThreadSharing.minMs`), and a
 * consumer builds at most `lambda*T/c` records to take one, where `T` is the producer's time for it.
 */
export class CostBoundedRule implements PostingRule {
  /** `bounded` false is Phase 1's rule: the same floor, and a take that may build any number of records. */
  constructor(readonly bounded: boolean) {}

  posts(
    sharing: ThreadSharing,
    _key: number,
    ms: number,
    _diagnosticFiles: readonly number[],
    _fileIndex: number,
  ): boolean {
    return ms >= sharing.minMs;
  }

  buildBudget(ms: number): number {
    return this.bounded ? Math.floor((shareLambda() * ms * 1000) / shareBuildRecordUs()) : Number.POSITIVE_INFINITY;
  }
}

// Debugging: TSC_TS_SHARE_BLOCK and TSC_TS_SHARE_ALLOW name parts of file names (comma-separated, each optionally with
// a range of declaration positions, `name@start-end`) whose results are never or only translated, and
// TSC_TS_SHARE_TRACE=1 prints each translation.
const shareBlockValue = process.env.TSC_TS_SHARE_BLOCK;
const shareAllowValue = process.env.TSC_TS_SHARE_ALLOW;
const shareTraceValue = process.env.TSC_TS_SHARE_TRACE;
// Debugging: TSC_TS_SHARE_VERIFY=1 computes each result a checker could translate, translates it after, and prints
// the results whose translation prints differently; =2 checks that a translation creates types record by record, in
// the order the producer created them.
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
 * none, and the bit answers that without a lookup. A file is its index in the program (`Checker.fileIndex`), and -1
 * a diagnostic without a file.
 */
export class FilesByKey {
  private readonly files = new Map<number, readonly number[]>();
  private readonly keys = new IdBits();

  get(key: number): readonly number[] | undefined {
    return this.keys.has(key) ? this.files.get(key) : undefined;
  }

  set(key: number, files: readonly number[]): void {
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
  /**
   * Whether this run is cost-bounded, which the run's configuration chose (`RunConfig.bounded`, off by default and
   * learned from the project's records). Without it the run keeps Phase 1's behavior: no demand bits, no export or
   * take budget, the 2-8 ms floor.
   */
  readonly bounded: boolean;
  /**
   * The rule that decides which of this checker's results are posted, and how much a take may build. A small-result
   * tier stacks on it by constructing its own rule here. Built per checker, not once at module evaluation, for the
   * reason the cost model's functions give (`shareKappa`).
   */
  readonly rule: PostingRule;
  readonly initialIndexes = new Map<number, number>();
  readonly initial: Type[];
  readonly numberLogs: Int32Array[] = [];
  readonly recordTables: Int32Array[] = [];
  readonly stringLogs: Uint16Array[] = [];
  readonly used: Int32Array;
  readonly takers: Int32Array;
  readonly forbidden: Int32Array;
  /** The checkers that missed on a key in each file (`ThreadSharingData.wanted`). */
  readonly wanted: Int32Array;
  /** The files this checker noted a miss on, so that each is marked in `wanted` once. */
  private readonly wantedFiles = new IdBits();
  /** The stop switch of every checker (`ThreadSharingData.control`). */
  readonly control: Int32Array;
  /** This checker's row of the counters the main thread reads (`ThreadSharingData.stats`). */
  readonly stats: Float64Array;
  readonly row: number;
  /** The number of results this checker posted. */
  posted = 0;
  translated = 0;
  /**
   * Set while this checker exports a result into its store. A computation nested in the export walk can reach
   * another shared result: posting it would write its records in the middle of the record being exported, and an
   * export that failed would rewind over the posted result's words.
   */
  exporting = false;
  /** Shared results a nested computation left to the checkers that compute them. */
  nested = 0;
  /** Outermost shared-kind computations: nesting depth, the kind of the current one, and the time by kind. */
  depth = 0;
  kind = 0;
  readonly kindMs: number[] = [0, 0, 0, 0];

  /** Kinds: 0 owned, 1 computed here for a file another checker took, 2 translated, 3 other. */
  addOutermost(ms: number): void {
    this.kindMs[this.kind]! += ms;
    this.kind = 3;
    this.writeStats();
  }

  /**
   * Copies this checker's counters into its row of `stats`, the memory the main thread reads them from
   * while checking runs. Called where a counter changes, a few times per result at most.
   */
  writeStats(): void {
    const s = this.stats;
    const row = this.row;
    for (let k = 0; k < shareStatKinds; k++) s[row + k] = this.kindMs[k]!;
    s[row + shareStatExport] = this.exportMs;
    s[row + shareStatTranslation] = this.translationMs;
    // A translation reads its records in place, so there is no separate unpacking time: shareStatUnpack stays 0.
    s[row + shareStatPosted] = this.posted;
    s[row + shareStatTranslated] = this.translated;
  }

  /** Adds to the milliseconds this checker saved by translating results instead of computing them. */
  addSaved(ms: number): void {
    const at = this.row + shareStatSaved;
    this.stats[at] = this.stats[at]! + ms;
  }

  /** Whether the main thread stopped translating posted results (control 2): this checker computes them. */
  stoppedTranslating(): boolean {
    return Atomics.load(this.control, 0) === 2;
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
  /** Results whose export passed the budget `kappa*T`, and translations that stopped at `lambda*T/c`. */
  overBudget = 0;
  overBudgetMs = 0;
  stoppedTranslations = 0;
  /** Results not posted because no checker that may take one missed on a key in the declaration's file. */
  notDemanded = 0;
  exportFailed = 0;
  exportFailedMs = 0;
  readonly exportFailures = new Map<string, number>();
  /** TSC_TS_SHARE_VERIFY=2: records whose translation created types before an earlier record's. */
  orderViolations = 0;
  storeFailed = 0;
  /** Of `storeFailed`, the results that didn't fit in this checker's logs. */
  logFull = 0;
  computedPrivately = 0;
  /** Results this checker computed and kept because the main thread stopped sharing (control 1 or 2). */
  stopped = 0;
  /** How often a posted result couldn't be taken here; and results for declarations of the checker's own files. */
  sawDoneUnusable = 0;
  owned = 0;
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
  readonly fileStack: (Set<number> | undefined)[] = [];

  /** Adds `files` to those of the computation in progress. */
  noteFiles(files: readonly number[] | undefined): void {
    const stack = this.fileStack;
    if (files === undefined || stack.length === 0) return;
    let top = stack[stack.length - 1];
    if (top === undefined) {
      top = new Set<number>();
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
        if (own === undefined) own = new Set<number>();
        const file = diagnostics[i]!.file;
        own.add(file === undefined ? -1 : this.fileIndexOfName(file.fileName));
      }
      for (let i = suggestionsBefore; i < suggestions.length; i++) {
        if (own === undefined) own = new Set<number>();
        const file = suggestions[i]!.file;
        own.add(file === undefined ? -1 : this.fileIndexOfName(file.fileName));
      }
      // A deferred diagnostic is reported where its file is checked, as the diagnostics it reported are.
      for (let i = deferredBefore; i < deferred.length; i++) {
        if (own === undefined) own = new Set<number>();
        own.add(deferred[i]!);
      }
      if (own !== undefined) {
        const list = [...own];
        files.set(key, list);
        this.noteFiles(list);
      }
    }
  }

  /**
   * The index of the program file named `fileName`, or -1: a diagnostic in a file this checker hasn't is one every
   * checker would report, like a diagnostic without a file.
   */
  fileIndexOfName(fileName: string): number {
    let files = this.filesByIndex;
    if (files === undefined) {
      files = new Map<string, number>();
      for (const [file, index] of this.c.fileIndex) files.set(file.fileName, index);
      this.filesByIndex = files;
    }
    return files.get(fileName) ?? -1;
  }

  /** The index of each file by name, built on first use. */
  private filesByIndex: Map<string, number> | undefined = undefined;

  constructor(c: Checker, data: ThreadSharingData) {
    this.c = c;
    // `tracked` reads the diagnostics a computation added, and deferred, from these lists.
    c.diagnostics.added = [];
    c.suggestionDiagnostics.added = [];
    c.deferredDiagnosticFiles = [];
    this.data = data;
    this.bounded = data.bounded;
    this.rule = new CostBoundedRule(this.bounded);
    this.used = new Int32Array(data.used);
    this.takers = new Int32Array(data.takers);
    this.forbidden = new Int32Array(data.forbidden);
    this.wanted = new Int32Array(data.wanted);
    this.control = new Int32Array(data.control);
    this.stats = new Float64Array(data.stats);
    this.row = data.index * shareStatColumns;
    this.types = new ResultTable(data.typeTable);
    this.returns = new ResultTable(data.returnTable);
    // The floor, lowered with the rest of the 2-8 ms threshold band when posting is cost-bounded: a posted result pays
    // when enough checkers need it, so it falls as checkers are added, to 0.25 ms with 16. Below the bounded count the
    // run keeps the 2-8 ms band, where the posts the extra floor would add are what the c4 gate measured as a cost.
    this.minMs =
      shareMinValue === undefined
        ? (this.bounded ? shareFloorTotalMs : shareFloorTotalMsPhase1) / data.count
        : Number(shareMinValue);
    this.initial = initialTypes(c);
    for (let i = 0; i < this.initial.length; i++) this.initialIndexes.set(this.initial[i]!.id, i);
    for (let k = 0; k < data.count; k++) {
      this.numberLogs.push(new Int32Array(data.numberLogs[k]!));
      this.recordTables.push(new Int32Array(data.recordTables[k]!));
      this.stringLogs.push(new Uint16Array(data.stringLogs[k]!));
    }
    if (process.env.TSC_TS_SHARE_SUMMARY !== undefined)
      process.on('exit', () => process.stderr.write(this.summary() + '\n'));
  }

  summary(): string {
    // The stores are written through a local cursor; the shared counters are only for this summary.
    const writer = this.storeExporter?.writer;
    const me = this.data.index;
    if (writer !== undefined) {
      this.used[usedStride * me] = writer.at;
      this.used[usedStride * me + 1] = writer.unitAt;
    }
    return (
      'checker ' +
      me +
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
      ' ms), export ' +
      this.exportMs.toFixed(0) +
      ' ms, computed here ' +
      this.computedPrivately +
      ' (' +
      this.sawDoneUnusable +
      ' posted but not taken, ' +
      this.stopped +
      ' after the stop switch), owned ' +
      this.owned +
      '; not posted: cycles ' +
      this.notShareable +
      ' (' +
      this.notShareableMs.toFixed(0) +
      ' ms), quick ' +
      this.belowMin +
      ' (' +
      this.belowMinMs.toFixed(0) +
      ' ms), not demanded ' +
      this.notDemanded +
      ', over the export budget ' +
      this.overBudget +
      ' (' +
      this.overBudgetMs.toFixed(0) +
      ' ms), takes stopped at their budget ' +
      this.stoppedTranslations +
      ', not exported ' +
      this.exportFailed +
      ' (' +
      this.exportFailedMs.toFixed(0) +
      ' ms: ' +
      [...this.exportFailures]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => k + ' ' + v.toFixed(0))
        .join('; ') +
      '), in an export ' +
      this.nested +
      ', not stored ' +
      this.storeFailed +
      ' (logs full ' +
      this.logFull +
      ', used ' +
      this.used[usedStride * me] +
      ' numbers, ' +
      this.used[usedStride * me + 1] +
      ' code units)' +
      (shareVerifyValue === '1'
        ? '; verified ' + this.verified + ' (' + this.verifiedIdentity + ' equal as text)'
        : '') +
      (shareVerifyValue === '2' ? '; order violations ' + this.orderViolations : '')
    );
  }

  /**
   * Whether this checker checks `file`, or may: a result computed for a declaration in it is never taken here. That is
   * a file it took, and one checked in statement ranges; a file no checker took yet it never checks once it took a
   * result for it (`forbid`).
   */
  owns(file: SourceFile): boolean {
    const index = this.c.fileIndex.get(file);
    return index === undefined || this.ownsIndex(index);
  }

  /** Whether this checker checks file `index`, or may; -1 names a diagnostic without a file, which it has. */
  ownsIndex(index: number): boolean {
    if (index < 0) return true;
    const taker = Atomics.load(this.takers, index);
    if (taker === 0) return false;
    return taker !== -2 && (taker < 0 || taker === this.data.index + 1);
  }

  /**
   * Notes that this checker looked for a result for a declaration in `file` and found none: a checker posts results
   * for that file only then (`demanded`). One `Atomics.or` per file and checker.
   */
  want(file: SourceFile): void {
    if (!this.bounded) return;
    const index = this.c.fileIndex.get(file);
    if (index === undefined || this.wantedFiles.has(index)) return;
    this.wantedFiles.add(index);
    const me = this.data.index;
    Atomics.or(this.wanted, index * forbiddenWords(this.data.count) + (me >>> 5), 1 << (me & 31));
  }

  /**
   * Whether a checker other than this one and the file's taker missed on a key in file `index`: someone other than
   * the checkers that already compute its declarations would take a result for one of them.
   */
  demanded(index: number): boolean {
    const count = this.data.count;
    const me = this.data.index;
    const words = forbiddenWords(count);
    const taker = Atomics.load(this.takers, index);
    const base = index * words;
    for (let w = 0; w < words; w++) {
      let bits = Atomics.load(this.wanted, base + w);
      if (w === me >>> 5) bits &= ~(1 << (me & 31));
      if (taker > 0 && w === (taker - 1) >>> 5) bits &= ~(1 << ((taker - 1) & 31));
      if (bits !== 0) return true;
    }
    return false;
  }

  /** After taking a result for a declaration in `file`: if no checker took the file yet, this one never will. */
  forbid(file: SourceFile): void {
    const index = this.c.fileIndex.get(file);
    if (index !== undefined) this.forbidIndex(index);
  }

  forbidIndex(index: number): void {
    if (index < 0) return;
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

  /** The result checker `k` posted at `offset` in its number log: the record of its type, and the files it named. */
  result(k: number, offset: number): StoredResult {
    const numbers = this.numberLogs[k]!;
    const root = numbers[offset]!;
    const computeMs = numbers[offset + 1]! / 1000;
    const count = numbers[offset + 2]!;
    const files: number[] = [];
    for (let i = 0; i < count; i++) files.push(numbers[offset + 3 + i]!);
    return new StoredResult(root, files, computeMs);
  }

  /** The exporter of this checker's store: it exports each type once. */
  storeExporter: Exporter | undefined = undefined;

  /**
   * Exports `t` into this checker's store and logs a result with it as the root; returns its state for the result
   * tables, -1 if it doesn't fit in the logs or a node or symbol in it can't be named across threads, or why it can't
   * be exported.
   */
  post(t: Type, diagnosticFiles: readonly number[], computeMs: number): number | string {
    const c = this.c;
    const me = this.data.index;
    let exporter = this.storeExporter;
    if (exporter === undefined) {
      const writer = new StoreWriter(this.numberLogs[me]!, this.stringLogs[me]!, this.recordTables[me]!, c.fileIndex);
      exporter = new Exporter(c, this.initialIndexes, writer);
      exporter.nodeLimit = this.data.nodeIds;
      exporter.symbolLimit = this.data.symbolIds;
      exporter.originsCache = this.origins;
      this.storeExporter = exporter;
    }
    // The export budget: a post appends at most `(kappa*T - p0)/e` records, so it costs at most `kappa*T` even when
    // the result is over it, and an over-budget result is not posted.
    if (this.bounded) {
      const maxRecords = Math.floor((shareKappa() * computeMs * 1000 - sharePostUs()) / shareExportRecordUs());
      if (maxRecords < 0) return budgetFailure;
      exporter.limit = exporter.base + maxRecords;
    } else exporter.limit = Number.POSITIVE_INFINITY;
    const writer = exporter.writer;
    exporter.failure = undefined;
    exporter.mergedOrigins = undefined;
    exporter.base = this.storedRecords;
    exporter.count = 0;
    const at = writer.at;
    const unitAt = writer.unitAt;
    this.exporting = true;
    try {
      const root = exporter.type(t);
      if (exporter.failure !== undefined) {
        const failure = exporter.failure;
        forgetExport(exporter, at, unitAt);
        return failure;
      }
      // The result's own words, at the cursor after the records it added: its root record, how long the result
      // took to compute (microseconds: a checker that translates it saved that much), and the files its
      // diagnostics are in.
      const header = writer.at;
      writer.word(root);
      writer.word(Math.round(computeMs * 1000));
      writer.word(diagnosticFiles.length);
      for (const index of diagnosticFiles) writer.word(index);
      if (writer.full) {
        this.logFull++;
        forgetExport(exporter, at, unitAt);
        return -1;
      }
      const count = exporter.count;
      exporter.base += count;
      exporter.count = 0;
      exporter.addedTypes.length = 0;
      exporter.addedProperties.length = 0;
      this.posted++;
      this.storedRecords += count;
      this.writeStats();
      // Only this checker writes its logs and store; the result table's state publishes what it wrote.
      return postedState(this.data.count, me, header);
    } finally {
      this.exporting = false;
    }
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
    for (const index of posted.files) if (this.ownsIndex(index) || this.forbidsLast(index)) return undefined;
    const declarationIndex = this.c.fileIndex.get(declarationFile);
    if (declarationIndex !== undefined && this.forbidsLast(declarationIndex)) return undefined;
    const start = performance.now();
    let reader = this.readers[producer];
    if (reader === undefined) {
      reader = new StoreReader(this, producer);
      this.readers[producer] = reader;
    }
    // The translation budget: building more records than the rule allows costs more than computing the result again,
    // where `T` is the time the producer's computation took (`StoredResult.computeMs`). The walk stops at the bound
    // before anything is built.
    const t = reader.translate(posted.root, this.rule.buildBudget(posted.computeMs));
    if (t === undefined && reader.stopped) this.stoppedTranslations++;
    this.translationMs += performance.now() - start;
    if (t !== undefined) {
      this.translated++;
      // Translating the result saved the time its producer's computation took (`post`'s header).
      this.addSaved(posted.computeMs);
      for (const index of posted.files) this.forbidIndex(index);
      if (posted.files.length > 0) {
        files.set(key, posted.files);
        this.noteFiles(posted.files);
      }
    }
    this.writeStats();
    return t;
  }
}

/** A result in a checker's store: the record of its type, and the files of its diagnostics. */
export class StoredResult {
  readonly root: number;
  readonly files: number[];
  /** How long computing the result took its producer, in milliseconds. */
  readonly computeMs: number;

  constructor(root: number, files: number[], computeMs: number = 0) {
    this.root = root;
    this.files = files;
    this.computeMs = computeMs;
  }
}

function readText(strings: Uint16Array, start: number, length: number): string {
  let text = '';
  for (let j = 0; j < length; j++) text += String.fromCharCode(strings[start + j]!);
  return text;
}

/** Forgets the types and properties a failed export of a store gave indexes, and its words. */
function forgetExport(exporter: Exporter, at: number, unitAt: number): void {
  for (const t of exporter.addedTypes) exporter.indexes.delete(t);
  for (const prop of exporter.addedProperties) exporter.properties.delete(prop);
  exporter.addedTypes.length = 0;
  exporter.addedProperties.length = 0;
  exporter.count = 0;
  exporter.failure = undefined;
  exporter.writer.at = at;
  exporter.writer.unitAt = unitAt;
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
  declarationFile: SourceFile,
): Type {
  const t = sharing.computeShared(files, key, symbol, sig);
  const ms = sharing.lastMs;
  if (!sharing.lastShareable) {
    sharing.notShareable++;
    sharing.notShareableMs += ms;
    return t;
  }
  let diagnosticFiles: readonly number[] | undefined;
  if (sharing.bounded) {
    // The main thread stopped sharing at its window (control 1 or 2): this result is the checker's own,
    // and the others compute theirs, as they do when they find none posted.
    if (Atomics.load(sharing.control, 0) !== 0) {
      sharing.stopped++;
      return t;
    }
    const index = sharing.c.fileIndex.get(declarationFile);
    if (index === undefined) return t;
    // The rule priced this result: a quick computation is cheaper to repeat than to export, post and translate.
    diagnosticFiles = files.get(key) ?? [];
    if (!sharing.rule.posts(sharing, key, ms, diagnosticFiles, index)) {
      sharing.belowMin++;
      sharing.belowMinMs += ms;
      return t;
    }
    // A result is posted only for a declaration whose file another checker that may take it missed on: a file only
    // its own checkers read has nobody to take it.
    if (!sharing.demanded(index)) {
      sharing.notDemanded++;
      return t;
    }
  } else {
    // Below the bounded count the run is Phase 1's, and takes the same path: the floor first, then the stop switch,
    // and none of the bounded path's lookups (the file index and the diagnostics) is made.
    if (ms < sharing.minMs) {
      sharing.belowMin++;
      sharing.belowMinMs += ms;
      return t;
    }
    if (Atomics.load(sharing.control, 0) !== 0) {
      sharing.stopped++;
      return t;
    }
  }
  // A result computed inside this checker's export walk doesn't have the store to itself: the walk would write over
  // its records, so it stays with the checkers that compute it.
  if (sharing.exporting) {
    sharing.nested++;
    return t;
  }
  const slot = table.slot(key);
  if (slot < 0 || table.state(slot) !== 0) return t;
  const start = performance.now();
  // Diagnostics stay with this checker; the others only learn which files they are in.
  const state = sharing.post(t, diagnosticFiles ?? files.get(key) ?? [], ms);
  if (state === budgetFailure) {
    sharing.overBudget++;
    sharing.overBudgetMs += ms;
  } else if (typeof state === 'string') {
    sharing.exportFailed++;
    sharing.exportFailedMs += ms;
    sharing.exportFailures.set(state, (sharing.exportFailures.get(state) ?? 0) + ms);
  } else if (state === -1) sharing.storeFailed++;
  else table.publish(slot, state);
  sharing.exportMs += performance.now() - start;
  sharing.writeStats();
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
  const declaration = symbol.valueDeclaration!;
  const file = getSourceFileOfNode(declaration);
  // A declaration with a type annotation: computing its type resolves the annotation, and translating the records
  // does too (`NodeType` resolves the node), so sharing saves nothing on it and costs a lookup. Below the bounded
  // count the exclusion is off, as it is in Phase 1.
  if (sharing.bounded && getType(declaration) !== undefined)
    return sharing.tracked(sharing.typeFiles, id, symbol, undefined);
  const table = sharing.types;
  if (!sharing.owns(file)) {
    // The stop switch is read before the table: a checker that stops translating computes the result itself.
    const slot = sharing.stoppedTranslating() ? -1 : table.find(id);
    const state = slot < 0 ? 0 : table.state(slot);
    if (
      state <= -2 &&
      findResolutionCycleStartIndex(c, symbol, TypeSystemPropertyName.Type) < 0 &&
      !translationBlocked(declaration)
    ) {
      const producer = postedProducer(sharing.data.count, state);
      const posted = sharing.result(producer, postedOffset(sharing.data.count, state));
      if (shareVerifyValue === '1') {
        const own = sharing.tracked(sharing.typeFiles, id, symbol, undefined);
        verifyTranslation(
          c,
          'types',
          declaration,
          own,
          sharing.translatePosted(producer, posted, sharing.typeFiles, id, file),
        );
        return own;
      }
      const t = sharing.translatePosted(producer, posted, sharing.typeFiles, id, file);
      if (t !== undefined) {
        traceTranslation(c, 'types', declaration, producer);
        if (sharing.depth === 1) sharing.kind = 2;
        sharing.forbid(file);
        const again = c.symbolTypes.get(id);
        if (again !== undefined) return again;
        c.symbolTypes.set(id, t);
        return t;
      }
      sharing.sawDoneUnusable++;
    }
    // This checker needed a result for one of the file's declarations and has none: the others post its results only
    // then.
    sharing.want(file);
    sharing.computedPrivately++;
    if (sharing.depth === 1) sharing.kind = 1;
  } else {
    sharing.owned++;
    if (sharing.depth === 1) sharing.kind = 0;
  }
  return computeAndPost(sharing, table, sharing.typeFiles, id, symbol, undefined, file);
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
  const file = getSourceFileOfNode(declaration);
  // A declaration with a return type annotation: computing the return type resolves the annotation, and translating
  // the records does too, so sharing saves nothing on it and costs a lookup. Below the bounded count the exclusion is
  // off, as it is in Phase 1.
  if (sharing.bounded && getType(declaration) !== undefined)
    return sharing.tracked(sharing.returnFiles, key, undefined, sig);
  const table = sharing.returns;
  if (!sharing.owns(file)) {
    const slot = sharing.stoppedTranslating() ? -1 : table.find(key);
    const state = slot < 0 ? 0 : table.state(slot);
    if (
      state <= -2 &&
      findResolutionCycleStartIndex(c, sig, TypeSystemPropertyName.ResolvedReturnType) < 0 &&
      !translationBlocked(declaration)
    ) {
      const producer = postedProducer(sharing.data.count, state);
      const posted = sharing.result(producer, postedOffset(sharing.data.count, state));
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
        sharing.forbid(file);
        return t;
      }
      sharing.sawDoneUnusable++;
    }
    sharing.want(file);
    sharing.computedPrivately++;
    if (sharing.depth === 1) sharing.kind = 1;
  } else {
    sharing.owned++;
    if (sharing.depth === 1) sharing.kind = 0;
  }
  return computeAndPost(sharing, table, sharing.returnFiles, key, undefined, sig, file);
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

/** Collects the children of a node (`forEachChild`). */
class ChildVisitor extends NodeVisitor {
  readonly children: Node[] = [];

  visitNode(node: Node): boolean {
    this.children.push(node);
    return false;
  }
}

/** The nodes of the program records name, by id, found by descending from their file through the nodes that contain them. */
export class NodeFinder {
  readonly files: readonly SourceFile[];
  readonly nodesById: Map<number, Node>;
  private visitor: ChildVisitor | undefined = undefined;

  constructor(files: readonly SourceFile[], nodesById: Map<number, Node>) {
    this.files = files;
    this.nodesById = nodesById;
  }

  /** The node of file `fileIndex` with the range `pos`-`end` and id `id`; undefined if the program hasn't it. */
  find(fileIndex: number, pos: number, end: number, id: number): Node | undefined {
    const known = this.nodesById.get(id);
    if (known !== undefined) return known;
    const file = this.files[fileIndex];
    if (file === undefined) return undefined;
    let visitor = this.visitor;
    if (visitor === undefined) visitor = this.visitor = new ChildVisitor();
    let node: Node = file;
    for (;;) {
      if (node.id === id) {
        if (node.pos !== pos || node.end !== end) return undefined;
        this.nodesById.set(id, node);
        return node;
      }
      visitor.children.length = 0;
      node.forEachChild(visitor);
      let next: Node | undefined = undefined;
      for (const child of visitor.children)
        if (child.pos <= pos && end <= child.end) {
          // The innermost of nested nodes with one range is found by its id further down.
          if (child.id === id) {
            if (child.pos !== pos || child.end !== end) return undefined;
            this.nodesById.set(id, child);
            return child;
          }
          if (next === undefined) next = child;
        }
      if (next === undefined) return undefined;
      node = next;
    }
  }
}

/**
 * Reads the records of a checker's store where it wrote them. `begin` starts a record at its offset in the number log
 * and finds its parts without decoding its kind's fields: its refs, its alias, its symbol, its node, then the fields
 * at `fields`.
 */
export class RecordReader {
  readonly numbers: Int32Array;
  readonly strings: Uint16Array;
  readonly table: Int32Array;
  readonly finder: NodeFinder;
  /** The record in progress: its header and kind, and where its refs are. */
  header = 0;
  kind = 0;
  refAt = 0;
  refCount = 0;
  /** Where its alias refs are, if it has an alias; -1 if none. */
  aliasRefAt = -1;
  aliasRefCount = 0;
  /** How its alias is named: `SymbolNaming` and a merged symbol id, or a node at `aliasNodeStart`. */
  aliasNaming = -1;
  aliasMergedId = -1;
  aliasNodeStart = -1;
  /** How its symbol is named: the kind of naming, a merged symbol id, or a node at `symbolNodeStart`. */
  symbolNaming = 0;
  symbolMergedId = -1;
  symbolNodeStart = -1;
  /** Where its node is, if it has one; -1 if none. */
  nodeStart = -1;
  /** The offset of its kind's own fields. */
  fields = 0;
  /** The records a record names, filled by `scan`. */
  readonly deps: number[] = [];

  constructor(
    numbers: Int32Array,
    strings: Uint16Array,
    table: Int32Array,
    files: readonly SourceFile[],
    nodesById: Map<number, Node>,
  ) {
    this.numbers = numbers;
    this.strings = strings;
    this.table = table;
    this.finder = new NodeFinder(files, nodesById);
  }

  /** Starts the record at `index`; false if the store hasn't it. */
  begin(index: number): boolean {
    if (index < 0 || index >= this.table.length) return false;
    const start = this.table[index]!;
    if (start <= 0) return false;
    const numbers = this.numbers;
    const at = start - 1;
    const header = numbers[at]!;
    this.header = header;
    this.kind = header & RecordHeader.KindMask;
    let count = (header >>> 16) & RefCountMask;
    this.refAt = at + 1;
    if (count === RecordHeader.RefEscape) {
      count = numbers[this.refAt]!;
      this.refAt++;
    }
    this.refCount = count;
    this.locate();
    return true;
  }

  /** Finds the record's alias refs, its symbol and its node, and the fields that follow them. */
  private locate(): void {
    const numbers = this.numbers;
    const header = this.header;
    let p = this.refAt + this.refCount;
    this.aliasNaming = -1;
    this.aliasMergedId = -1;
    this.aliasNodeStart = -1;
    this.aliasRefAt = -1;
    this.aliasRefCount = 0;
    if ((header & RecordHeader.HasAlias) !== 0) {
      if ((header & RecordHeader.AliasMerged) !== 0) {
        this.aliasNaming = SymbolNaming.Merged;
        this.aliasMergedId = numbers[p++]!;
      } else {
        this.aliasNaming = numbers[p]! === 1 ? SymbolNaming.Export : SymbolNaming.Node;
        this.aliasNodeStart = p + 1;
        p = this.aliasNodeStart + this.nodeWords(this.aliasNodeStart);
      }
      this.aliasRefCount = numbers[p]!;
      this.aliasRefAt = p + 1;
      p = this.aliasRefAt + this.aliasRefCount;
    }
    const naming = (header & RecordHeader.NamingMask) >>> RecordHeader.NamingShift;
    this.symbolNaming = naming;
    this.symbolMergedId = -1;
    this.symbolNodeStart = -1;
    if (naming === SymbolNaming.Merged) this.symbolMergedId = numbers[p++]!;
    else if (naming !== SymbolNaming.None) {
      this.symbolNodeStart = p;
      p += this.nodeWords(p);
    }
    this.nodeStart = -1;
    if ((header & RecordHeader.HasNode) !== 0) {
      this.nodeStart = p;
      p += this.nodeWords(p);
    }
    this.fields = p;
  }

  /** The words a node at `p` takes: its file index, range and id, or one word for no node. */
  nodeWords(p: number): number {
    return this.numbers[p]! < 0 ? 1 : 4;
  }

  /** The node at `p`; undefined if it is none or the program hasn't it. */
  readNode(p: number): Node | undefined {
    if (p < 0 || this.numbers[p]! < 0) return undefined;
    const numbers = this.numbers;
    return this.finder.find(numbers[p]!, numbers[p + 1]!, numbers[p + 2]!, numbers[p + 3]!);
  }

  /** The record's own node; undefined if it has none or the program hasn't it. */
  node(): Node | undefined {
    return this.readNode(this.nodeStart);
  }

  doubleAt(p: number): number {
    const words = doubleWords();
    words.i[0] = this.numbers[p]!;
    words.i[1] = this.numbers[p + 1]!;
    return words.f[0]!;
  }

  textAt(p: number): string {
    return readText(this.strings, this.numbers[p]!, this.numbers[p + 1]!);
  }

  /**
   * Collects in `deps` the indexes of the records the record in progress needs: its refs, its alias refs, and the
   * types of its own fields that are records (a union's origin, an object literal's completion, a completed object's
   * members' types). A record is written before the records it needs.
   */
  scan(): void {
    const numbers = this.numbers;
    const deps = this.deps;
    deps.length = 0;
    for (let i = 0; i < this.refCount; i++) deps.push(numbers[this.refAt + i]!);
    for (let i = 0; i < this.aliasRefCount; i++) deps.push(numbers[this.aliasRefAt + i]!);
    let p = this.fields;
    switch (this.kind) {
      case RecordKind.Union:
      case RecordKind.AnonymousObject:
        // The origin of a union, and the completion of an object literal.
        deps.push(numbers[p + 1]!);
        break;
      case RecordKind.CompleteObject: {
        // The object literal completed, then each index signature's key and value types.
        deps.push(numbers[p]!);
        const count = numbers[p + 1]!;
        let q = p + 2;
        for (let i = 0; i < count; i++) {
          deps.push(numbers[q]!, numbers[q + 1]!);
          q += 3;
          q += this.nodeWords(q);
          const components = numbers[q++]!;
          for (let j = 0; j < components; j++) q += this.nodeWords(q);
        }
        break;
      }
    }
  }
}

/** The bits of a record header that hold the number of refs, or `RefEscape` if the number is a word of its own. */
const RefCountMask = 0xffff;

/**
 * A consumer's translations of another checker's store: each record is read where it is, and translated once, when a
 * result first needs it, in the order of the store, which is the order the producer exported them in.
 */
class StoreReader {
  readonly sharing: ThreadSharing;
  readonly producer: number;
  readonly translator: Translator;
  readonly reader: RecordReader;
  /** Whether the last `translate` stopped at its budget, having built nothing. */
  stopped = false;
  /** By record: the type it translated to, the symbol a property record makes, and whether a completion is done. */
  readonly types = new LinkTable<Type>();
  readonly symbols = new LinkTable<Symbol>();
  readonly completed = new LinkTable<boolean>();

  constructor(sharing: ThreadSharing, producer: number) {
    this.sharing = sharing;
    this.producer = producer;
    this.translator = new Translator(sharing.c, this);
    this.reader = new RecordReader(
      sharing.numberLogs[producer]!,
      sharing.stringLogs[producer]!,
      sharing.recordTables[producer]!,
      sharing.c.files,
      sharing.nodesById,
    );
  }

  /**
   * Whether record `index` is translated: a property record made its symbol, an object literal got its members, a
   * shell whose members come later only counts with them. A translation that fails after it built a shell leaves
   * the empty type behind, and a later translation of the shell alone would take it for the object.
   */
  private isBuilt(index: number): boolean {
    if (!this.reader.begin(index)) return false;
    const kind = this.reader.kind;
    if (kind === RecordKind.Property) return this.symbols.get(index) !== undefined;
    if (kind === RecordKind.CompleteObject) return this.completed.get(index) !== undefined;
    if (this.types.get(index) === undefined) return false;
    if (kind !== RecordKind.AnonymousObject) return true;
    const completion = this.reader.numbers[this.reader.fields + 1]!;
    return completion < 0 || this.completed.get(completion) !== undefined;
  }

  /** Whether the record in progress names only merged symbols this program has. */
  private present(reader: RecordReader): boolean {
    const merged = this.sharing.c.mergedSymbols;
    if (reader.aliasNaming === SymbolNaming.Merged && !merged.has(reader.aliasMergedId)) return false;
    return reader.symbolNaming !== SymbolNaming.Merged || merged.has(reader.symbolMergedId);
  }

  /**
   * The translation of record `root` and the records it needs; undefined if one can't be translated here, or if the
   * records it would build pass `budget`.
   */
  translate(root: number, budget: number = Number.POSITIVE_INFINITY): Type | undefined {
    const c = this.sharing.c;
    const translator = this.translator;
    const reader = this.reader;
    translator.failed = false;
    const needed = new Set<number>();
    const stack = [root];
    this.stopped = false;
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (needed.has(i) || this.isBuilt(i)) continue;
      if (needed.size >= budget) {
        this.stopped = true;
        return undefined;
      }
      if (!reader.begin(i) || !this.present(reader)) return undefined;
      needed.add(i);
      reader.scan();
      const deps = reader.deps;
      for (let k = 0; k < deps.length; k++) {
        const j = deps[k]!;
        if (j >= 0) stack.push(j);
      }
    }
    const order = [...needed].sort((a, b) => a - b);
    // Translating a type node resolves its type alias first, which fails where that is in progress: before any
    // record is translated. A translation can start translations of this store again (resolving a type alias, or
    // a type of a symbol), which translate some of these records first.
    for (const i of order) {
      if (this.isBuilt(i)) continue;
      reader.begin(i);
      const kind = reader.kind;
      if (kind !== RecordKind.NodeType && kind !== RecordKind.Conditional && kind !== RecordKind.DistributedConditional)
        continue;
      const node = reader.node();
      if (node === undefined) return undefined;
      translator.aliasOfNode(node);
    }
    if (translator.failed) {
      translator.failed = false;
      return undefined;
    }
    const verifyOrder = shareVerifyValue === '2';
    let lastNew = -1;
    for (const i of order) {
      if (this.isBuilt(i)) continue;
      reader.begin(i);
      const before = verifyOrder ? c.typeCount : 0;
      switch (reader.kind) {
        case RecordKind.Property: {
          const symbol = translator.property(i);
          if (symbol === undefined) {
            translator.failed = false;
            return undefined;
          }
          this.symbols.set(i, symbol);
          continue;
        }
        case RecordKind.CompleteObject:
          if (!translator.complete(i)) {
            translator.failed = false;
            return undefined;
          }
          this.completed.set(i, true);
          continue;
        default: {
          const t = translator.record(i);
          if (t === undefined) {
            translator.failed = false;
            return undefined;
          }
          this.types.set(i, t);
          // The types a translation creates, record by record, are created in the order the producer created them.
          if (verifyOrder && c.typeCount > before) {
            if (before < lastNew) {
              const violations = ++this.sharing.orderViolations;
              if (violations <= 20)
                process.stderr.write(
                  'share-verify: checker ' +
                    this.sharing.data.index +
                    ' record ' +
                    i +
                    ' created type ' +
                    c.typeCount +
                    ' after ' +
                    lastNew +
                    '\n',
                );
            }
            lastNew = c.typeCount;
          }
        }
      }
    }
    return this.types.get(root);
  }
}
